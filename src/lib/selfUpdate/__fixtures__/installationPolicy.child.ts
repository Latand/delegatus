import { SelfUpdateService, type ServiceDeps } from "../service";

let checks = 0;
let deployments = 0;
const service = new SelfUpdateService({
  dir: process.env.POLICY_DIR!, env: process.env,
  now: () => Date.parse("2030-01-01T00:00:00Z"),
  remote: "https://github.com/example/fixture.git", branch: "main", pollMinutes: 60,
  mode: async () => ({ mode: "unsupported", reason: "no-launcher", record: null }),
  install: { action: () => null, run: () => {}, entry: () => null },
  hostHealth: async () => null,
  web: { pid: process.pid, port: null, startedAt: "2030-01-01T00:00:00Z" },
  check: async () => { checks++; throw new Error("unexpected check"); },
  requestDeployment: async () => { deployments++; throw new Error("unexpected deployment"); },
} as ServiceDeps);
try {
  await service.autoTick();
  const snapshot = await service.snapshot();
  const update = await service.startUpdate("process-policy");
  process.stdout.write(JSON.stringify({ disabled: snapshot.selfUpdateDisabled, enabled: snapshot.auto?.enabled,
    availability: snapshot.auto?.availability, update, admission: await service.admitAutoRestart("forged-request", "forged-gate"), checks, deployments }));
} finally { service.stop(); }
