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

test("test startup drops the admitting gate's task database binding before fixtures run", async () => {
  const root = sandbox(), file = path.join(root, "binding.test.ts");
  fs.writeFileSync(file, 'import { test, expect } from "bun:test"; test("private binding", () => expect(process.env.LLV_GATE_CPU_PRIORITY_SOURCE).toBeUndefined());');
  const child = Bun.spawn([process.execPath, "test", file], {
    cwd: path.join(import.meta.dir, "../../.."),
    env: { ...process.env, LLV_GATE_CPU_PRIORITY_SOURCE: JSON.stringify({ database: path.join(root, "outside-fixture.sqlite"), taskIds: ["source-task"] }) },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0);
  expect(out + error).toContain("1 pass");
});

test("only the live installation's state directory shares the machine queue", () => {
  const live = { home: () => "/srv/operator", staging: false, guarded: false };
  const state = "/srv/operator/.config/delegatus/state";
  expect(isolatedCpuAdmissionDir(state, live)).toBeNull();
  expect(isolatedCpuAdmissionDir("/srv/operator/.config/agent-log-viewer/state", live)).toBeNull();
  // A test, a build or a staging instance never shares it, whatever directory it resolved.
  expect(isolatedCpuAdmissionDir(state, { ...live, guarded: true })).toBe(state);
  expect(isolatedCpuAdmissionDir(state, { ...live, staging: true })).toBe(state);
  // Neither does anything else under the operator's config root, or anywhere else.
  for (const directory of [
    "/srv/operator/.config/delegatus/state-staging",
    `${state}/fixture`,
    `${state}/scratch/llv-stage-a/tmp/run/state`,
    "/srv/operator/.config/delegatus",
    "/srv/operator/.config/live-log-viewer/state",
    "/srv/operator/captures/config/delegatus/state",
    "/tmp/llv-spawn-sandbox/account/config/agent-log-viewer/state",
    "/srv/work/repo/.artifacts/state",
  ]) expect(isolatedCpuAdmissionDir(directory, live)).toBe(directory);
});

test("the live state directory is recognised through the app dir link, and a link elsewhere is not", () => {
  const root = sandbox(), home = path.join(root, "home"), config = path.join(home, ".config");
  fs.mkdirSync(path.join(config, "agent-log-viewer", "state"), { recursive: true });
  fs.symlinkSync("agent-log-viewer", path.join(config, "delegatus"), "dir");
  fs.mkdirSync(path.join(root, "driver", "delegatus", "state"), { recursive: true });
  fs.symlinkSync(path.join(config, "agent-log-viewer", "state"), path.join(root, "alias"), "dir");
  const live = { home: () => home, staging: false, guarded: false };
  expect(isolatedCpuAdmissionDir(path.join(config, "delegatus", "state"), live)).toBeNull();
  expect(isolatedCpuAdmissionDir(path.join(root, "alias"), live)).toBeNull();
  const driver = path.join(root, "driver", "delegatus", "state");
  expect(isolatedCpuAdmissionDir(driver, live)).toBe(driver);
});

/* A Viewer as production starts it: no test marker, no private gate directory,
   an owner token. The sandbox sits outside every temp root, as a staging state
   or a driver's kept home does, and the child is told that its home is the
   operating-system user's. Only the path is resolved; no queue is opened. */
function persistentSandbox(): { home: string; config: string; root: string } {
  const parent = path.join(import.meta.dir, "..", "..", "..", ".artifacts");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "cpu-scope-"));
  directories.push(root);
  const home = path.join(root, "home"), config = path.join(home, ".config");
  fs.mkdirSync(config, { recursive: true });
  return { home, config, root };
}
function viewerQueue(home: string, extra: Record<string, string>, owner: string | null = "viewer"): string {
  const source = `globalThis[Symbol.for("delegatus.cpuAdmission.home")] = ${JSON.stringify(home)}; ${PRINT_INSTANCE}`;
  const result = run(["-e", source], launchEnv({
    NODE_ENV: "production", HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), ...(owner ? { LLV_STATE_OWNER: owner } : {}), ...extra,
  }));
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  return result.stdout;
}

test("the live Viewer shares the machine queue gate-slot uses", () => {
  const { home } = persistentSandbox();
  expect(viewerQueue(home, {})).toBe(path.join(home, ".cache", "delegatus-cpu", "admission.sqlite"));
});

test.each(["viewer", null])("a staging instance on its standard state directory keeps its own queue (owner %p)", owner => {
  const { home, config } = persistentSandbox();
  expect(viewerQueue(home, { LLV_STAGING: "1" }, owner)).toBe(path.join(config, "delegatus", "state-staging", "cpu-gate", "admission.sqlite"));
});

test.each(["viewer", null])("a fixture state nested in the live state directory keeps its own queue (owner %p)", owner => {
  const { home, config } = persistentSandbox(), fixture = path.join(config, "delegatus", "state", "fixture");
  expect(viewerQueue(home, { LLV_STATE_DIR: fixture }, owner)).toBe(path.join(fixture, "cpu-gate", "admission.sqlite"));
});

test("a driver's Viewer on a kept home and config root of its own keeps its queue there", () => {
  const { home, root } = persistentSandbox(), driver = path.join(root, "driver");
  fs.mkdirSync(path.join(driver, "home"), { recursive: true });
  const queue = viewerQueue(home, { HOME: path.join(driver, "home"), XDG_CONFIG_HOME: path.join(driver, "config") });
  expect(queue).toBe(path.join(driver, "config", "delegatus", "state", "cpu-gate", "admission.sqlite"));
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
