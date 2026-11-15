import { SelfUpdateService, type ServiceDeps } from "../service";
import { readLauncherRecord } from "../launcher";
import { detectMode } from "../mode";
import { readRevision } from "../git";
import { sameProcess } from "../pid";
import { procBackend } from "@/lib/proc";
import { idleUpdate } from "../types";
import { activeDrain } from "../drain";
import { join } from "node:path";
import { readFileSync } from "node:fs";

let checks = 0;
let deployments = 0;
const unexpected = (): never => { throw new Error("unexpected fixture effect"); };
const deps: ServiceDeps = {
  dir: process.env.POLICY_DIR!, env: process.env,
  now: () => Date.parse("2030-01-01T00:00:00Z"),
  remote: "https://github.com/example/fixture.git", branch: "main", pollMinutes: 60,
  bun: process.execPath,
  describe: async () => unexpected(),
  createRunner: unexpected,
  requestRestart: unexpected,
  processAlive: () => false,
  processIdentity: () => null,
  readDeployment: async () => null,
  findDeploymentByIdempotencyKey: async () => null,
  releaseTarget: () => null,
  prepareCheckRepo: async () => unexpected(),
  buildEnv: unexpected,
  mode: async () => ({ mode: "unsupported", reason: "no-launcher", record: null }),
  install: { action: () => null, run: () => {}, entry: () => null },
  hostHealth: async () => null,
  web: { pid: process.pid, port: null, startedAt: "2030-01-01T00:00:00Z" },
  check: async () => { checks++; throw new Error("unexpected check"); },
  requestDeployment: async () => { deployments++; throw new Error("unexpected deployment"); },
};
const record = process.env.POLICY_RECORD ? readLauncherRecord(process.env.POLICY_RECORD) : null;
if (record) {
  const checkoutDeps: Partial<ServiceDeps> = {
    now: () => Date.parse(process.env.POLICY_NOW!),
    mode: () => detectMode({ env: { LLV_SELF_UPDATE_RECORD: process.env.POLICY_RECORD }, readRecord: readLauncherRecord,
      alive: () => true, deploymentsEnabled: async () => false }),
    describe: readRevision,
    buildEnv: () => ({}),
    prune: async () => {},
    createRunner: () => ({ state: idleUpdate(["fetch", "install", "build", "ready"]), restore() {}, logPath: () => "",
      start: async () => unexpected(), retry: async () => unexpected() }),
    processAlive: (pid: number, startIdentity: string) => sameProcess({ pid, startIdentity }),
    processIdentity: (pid: number) => procBackend.processIdentity(pid),
    hostHealth: async () => process.env.POLICY_HOST_HEALTH === "0" ? null
      : { pid: record.runtimeHost.pid!, startIdentity: procBackend.processIdentity(record.runtimeHost.pid!)!, hostEpoch: 1 },
  };
  Object.assign(deps, checkoutDeps);
}
const service = new SelfUpdateService(deps);
try {
  await service.autoTick();
  const drainAfterTick = record ? activeDrain(join(deps.dir, "auto-drain.json"), deps.now()) : null;
  const snapshot = await service.snapshot();
  const update = await service.startUpdate("process-policy");
  process.stdout.write(JSON.stringify({ disabled: snapshot.selfUpdateDisabled, enabled: snapshot.auto?.enabled,
    availability: snapshot.auto?.availability, update, admission: await service.admitAutoRestart("forged-request", "forged-gate"), checks, deployments,
    ...(record ? { drainAfterTick, drain: activeDrain(join(deps.dir, "auto-drain.json"), deps.now()),
      apply: JSON.parse(readFileSync(join(deps.dir, "apply.json"), "utf8")) } : {}) }));
} finally { service.stop(); }
