import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isolatedCpuAdmissionDir } from "./cpuAdmissionScope";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

const scope = path.join(import.meta.dir, "cpuAdmissionScope.ts");
const admission = path.join(import.meta.dir, "cpuAdmission.ts");
const engine = path.join(import.meta.dir, "..", "pipelines", "engine.ts");
const PRINT_INSTANCE = `const { instanceCpuAdmissionFile } = await import(${JSON.stringify(scope)}); process.stdout.write(instanceCpuAdmissionFile());`;

/** The environment a builder's own launch leaves behind: nothing that names a
    test, no private gate directory, and the temp root it was handed. */
function launchEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^(LLV_|DELEGATUS_|NODE_ENV$|NEXT_PHASE$|XDG_CONFIG_HOME$)/.test(name)) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

function sandbox(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpu-scope-"));
  directories.push(directory);
  return directory;
}

function run(argv: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync([process.execPath, ...argv], { env, stdout: "pipe", stderr: "pipe" });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

test("only the operator's own state directory shares the machine queue", () => {
  const operator: NodeJS.ProcessEnv = { NODE_ENV: "production", HOME: "/srv/operator", XDG_CONFIG_HOME: "/srv/operator/.config" };
  const live = "/srv/operator/.config/delegatus/state";
  expect(isolatedCpuAdmissionDir(live, operator, false)).toBeNull();
  expect(isolatedCpuAdmissionDir("/srv/operator/.config/agent-log-viewer/state", operator, false)).toBeNull();
  // A test or a build never shares it, whatever directory it inherited.
  expect(isolatedCpuAdmissionDir(live, operator, true)).toBe(live);
  expect(isolatedCpuAdmissionDir(live, { ...operator, NODE_ENV: "test" })).toBe(live);
  const elsewhere: [string, NodeJS.ProcessEnv][] = [
    ["/tmp/llv-spawn-sandbox/account/config/agent-log-viewer/state", operator],
    ["/var/tmp/check-abc/state", operator],
    ["/srv/work/repo/.artifacts/state", operator],
    ["/tmp/driver/config/delegatus/state", { ...operator, HOME: "/tmp/driver/home", XDG_CONFIG_HOME: "/tmp/driver/config" }],
    [`${live}/scratch/llv-stage-a/tmp/run/state`, { ...operator, TMPDIR: `${live}/scratch/llv-stage-a/tmp` }],
  ];
  for (const [directory, env] of elsewhere) expect(isolatedCpuAdmissionDir(directory, env, false)).toBe(directory);
});

const launches: { path: string; argv: string[] | null; owner: string | null }[] = [
  { path: "a bun -e child, as the pipeline engine suite starts its controllers", argv: ["-e", PRINT_INSTANCE], owner: null },
  { path: "a script file, as a fixture or a capture driver runs", argv: null, owner: null },
  { path: "a Viewer a driver starts, which carries the owner token", argv: ["-e", PRINT_INSTANCE], owner: "viewer" },
];
test.each(launches)("$path keeps its queue inside an isolated LLV_STATE_DIR", ({ argv, owner }) => {
  const root = sandbox(), state = path.join(root, "state");
  const script = path.join(root, "launch.ts");
  fs.writeFileSync(script, PRINT_INSTANCE);
  const result = run(argv ?? [script], launchEnv({ LLV_STATE_DIR: state, ...(owner ? { LLV_STATE_OWNER: owner } : {}) }));
  expect(result).toEqual({ code: 0, stdout: path.join(state, "cpu-gate", "admission.sqlite"), stderr: "" });
});

test("an instance isolated by a sandboxed home alone keeps its queue there", () => {
  const root = sandbox(), home = path.join(root, "home"), config = path.join(root, "config");
  fs.mkdirSync(home); fs.mkdirSync(config);
  const result = run(["-e", PRINT_INSTANCE], launchEnv({ HOME: home, XDG_CONFIG_HOME: config, LLV_STATE_OWNER: "viewer" }));
  expect(result.stderr).toBe("");
  expect(result.stdout.startsWith(config + path.sep)).toBe(true);
  expect(result.stdout.endsWith(path.join("state", "cpu-gate", "admission.sqlite"))).toBe(true);
});

test("the production pipeline ports of an isolated instance write their stage ticket to its own queue", () => {
  const root = sandbox(), state = path.join(root, "state"), key = `stage:${"a".repeat(64)}:fixture:plan:1`;
  const file = path.join(state, "cpu-gate", "admission.sqlite");
  // The child refuses before it opens anything that is not inside its own state.
  const source = `
    const { instanceCpuAdmissionFile } = await import(${JSON.stringify(scope)});
    const file = instanceCpuAdmissionFile();
    if (!file.startsWith(${JSON.stringify(state + path.sep)})) { process.stderr.write("refusing a queue outside the isolated state: " + file); process.exit(3); }
    const { defaultPipelinePorts } = await import(${JSON.stringify(engine)});
    const ports = defaultPipelinePorts();
    ports.cpuPressureHold(${JSON.stringify(key)});
    ports.cpuAdmissionSuspend(${JSON.stringify(key)});
    process.exit(0);
  `;
  const result = run(["-e", source], launchEnv({ LLV_STATE_DIR: state, LLV_CPU_PRESSURE: "off" }));
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  const db = new Database(file, { readonly: true });
  try { expect(db.query<{ key: string }, []>("SELECT key FROM tickets").all()).toEqual([{ key }]); } finally { db.close(); }
});

test("an explicit gate directory still decides, and the gate helper stays on the machine queue", () => {
  const root = sandbox(), state = path.join(root, "state"), locks = path.join(root, "locks");
  expect(run(["-e", PRINT_INSTANCE], launchEnv({ LLV_STATE_DIR: state, LLV_GATE_LOCK_DIR: locks })).stdout)
    .toBe(path.join(locks, "admission.sqlite"));
  // scripts/cpu-admission.ts resolves the file this way. Only the path is read.
  const helper = run(["-e", `const { cpuAdmissionFile } = await import(${JSON.stringify(admission)}); process.stdout.write(cpuAdmissionFile());`],
    launchEnv({ LLV_STATE_DIR: state }));
  expect(helper.stderr).toBe("");
  expect(helper.stdout.startsWith(root + path.sep)).toBe(false);
  expect(helper.stdout.endsWith(path.join(".cache", "delegatus-cpu", "admission.sqlite"))).toBe(true);
});
