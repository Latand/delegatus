import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloudCheckInputs } from "../../../scripts/cloud-checks";
import { checkEnvironment, checkInputEnvironment, environmentFingerprint } from "../../../scripts/gate-cache";
import { createHookFixture } from "../../../scripts/local-gate.fixture";
import { fixture } from "../../../scripts/gate-slot.queue.fixture";
import { withoutInheritedGate } from "../testing/inheritedGateEnv";
import { realExec } from "../workflows/provision";
import { installedGateAdmissionEnv } from "./agentSignalSandbox";
import { gateAdmissionInterpreter } from "./gateAdmissionLauncher";
import { gateToolingFiles } from "./gateTooling";

// Bun reads the home directory once; the runner supplies a private HOME.
const repository = process.cwd();
const roots: string[] = [];
const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const temporary = (prefix: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(dir); return dir; };
const setEnv = (name: string, value: string | undefined) => {
  const previous = process.env[name];
  restore.push(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
};
const chdir = (directory: string) => { const previous = process.cwd(); restore.push(() => process.chdir(previous)); process.chdir(directory); };

/** An installed release: the helper copies sit at a path of their own, as
 * each self-update release does. */
function installedRelease(layout: "scripts" | "dist/gate") {
  const dir = temporary("gate-admission-release-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "delegatus-cli" }));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin/cli.mjs"), "");
  fs.writeFileSync(path.join(dir, "bin/agent-signal-sandbox.py"), "");
  fs.mkdirSync(path.join(dir, layout), { recursive: true });
  for (const name of gateToolingFiles) fs.copyFileSync(path.join(repository, "scripts", name), path.join(dir, layout, name));
  return dir;
}

/** PATH whose only Bun is a copy outside the test runner's own directory. */
function pathWithBunCopy() {
  const bin = temporary("gate-admission-bin-");
  fs.copyFileSync(process.execPath, path.join(bin, "bun"), fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(path.join(bin, "bun"), 0o755);
  const rest = (process.env.PATH ?? "").split(path.delimiter).filter(entry => entry && !fs.existsSync(path.join(entry, "bun")));
  return { bun: path.join(bin, "bun"), PATH: [bin, ...rest].join(path.delimiter) };
}

function routedFrom(release: string, source: Partial<NodeJS.ProcessEnv>) {
  const previous = process.cwd();
  process.chdir(release);
  try { return installedGateAdmissionEnv(source); } finally { process.chdir(previous); }
}

test.skipIf(process.platform !== "linux")("a bridged agent's routed launcher runs Bun from its own PATH, never the Viewer's interpreter", () => {
  setEnv("LLV_DOCKER_NSENTER_SHIMS", "1");
  chdir(installedRelease("dist/gate"));
  const { bun, PATH } = pathWithBunCopy();
  const routed = installedGateAdmissionEnv({ PATH });
  const home = process.env.HOME || os.homedir();
  expect(routed.LLV_GATE_BUN?.startsWith(path.join(home, ".cache/delegatus/gate-admission") + path.sep)).toBe(true);
  // The image's Viewer runs under a container-only interpreter.
  expect(fs.readFileSync(routed.LLV_GATE_BUN!, "utf8")).not.toContain(process.execPath);
  expect(gateAdmissionInterpreter(routed.LLV_GATE_BUN)).toBeNull();
  expect(installedGateAdmissionEnv({ PATH, ...routed })).toEqual(routed);
  const probe = 'const fs = require("node:fs"); console.log(JSON.stringify({ argv0: fs.readFileSync("/proc/self/cmdline", "utf8").split("\\0")[0], exe: fs.readlinkSync("/proc/self/exe") }))';
  const result = Bun.spawnSync([routed.LLV_GATE_BUN!, "-e", probe], { env: { PATH, HOME: os.homedir(), ...routed } });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ argv0: "bun", exe: fs.realpathSync(bun) });
});

test.skipIf(process.platform !== "linux")("routing keys the recorded interpreter, so releases at different paths share one check key", () => {
  setEnv("LLV_DOCKER_NSENTER_SHIMS", undefined);
  const first = installedRelease("scripts"), second = installedRelease("scripts");
  const base: Partial<NodeJS.ProcessEnv> = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
  for (const interpreter of [undefined, process.execPath]) {
    const source: Partial<NodeJS.ProcessEnv> = { ...base, ...(interpreter ? { LLV_GATE_BUN: interpreter } : {}) };
    const a = routedFrom(first, source), b = routedFrom(second, source);
    expect(a.LLV_GATE_BUN).toBeDefined();
    expect(b.LLV_GATE_BUN).toBeDefined();
    expect(a.LLV_GATE_BUN).not.toBe(b.LLV_GATE_BUN);
    // Rebinding a routed value keeps the original interpreter, or its absence.
    expect(gateAdmissionInterpreter(routedFrom(second, { ...source, ...a }).LLV_GATE_BUN)).toBe(interpreter ?? null);
    const unrouted = environmentFingerprint(checkEnvironment(source));
    expect(environmentFingerprint(checkEnvironment({ ...source, ...a }))).toBe(unrouted);
    expect(environmentFingerprint(checkEnvironment({ ...source, ...b }))).toBe(unrouted);
    expect(checkInputEnvironment(checkEnvironment({ ...source, ...a }))).toEqual(checkInputEnvironment(checkEnvironment(source)));
    // The running check still reaches the installed helper through the launcher.
    expect(checkEnvironment({ ...source, ...a }).LLV_GATE_BUN).toBe(a.LLV_GATE_BUN);
  }
  // A different interpreter is still a different check.
  expect(environmentFingerprint(checkEnvironment(routedFrom(first, { ...base, LLV_GATE_BUN: "/usr/bin/bun" }))))
    .not.toBe(environmentFingerprint(checkEnvironment(routedFrom(first, { ...base, LLV_GATE_BUN: process.execPath }))));
});

test.skipIf(process.platform !== "linux")("Cloud publication inputs under routing equal the unrouted inputs", () => {
  setEnv("LLV_DOCKER_NSENTER_SHIMS", undefined);
  const release = installedRelease("scripts");
  const publication = createHookFixture(repository, roots);
  const env: Partial<NodeJS.ProcessEnv> = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
  const routed = { ...env, ...routedFrom(release, env) };
  expect(routed.LLV_GATE_BUN).toBeDefined();
  expect(cloudCheckInputs(publication.dir, routed)).toEqual(cloudCheckInputs(publication.dir, env));
  expect(cloudCheckInputs(publication.dir, routed)).not.toHaveProperty("LLV_GATE_BUN");
  // A tracked interpreter stays a tracked Cloud input; a host interpreter is
  // refused exactly as it is without routing.
  const tracked = { ...env, LLV_GATE_BUN: path.join(publication.dir, "scripts/gate-slot.sh") };
  expect(cloudCheckInputs(publication.dir, { ...tracked, ...routedFrom(release, tracked) })).toEqual(cloudCheckInputs(publication.dir, tracked));
  expect(cloudCheckInputs(publication.dir, tracked).LLV_GATE_BUN).toEqual({ file: "scripts/gate-slot.sh" });
  const host = { ...env, LLV_GATE_BUN: process.execPath };
  expect(() => cloudCheckInputs(publication.dir, host)).toThrow("outside tracked files");
  expect(() => cloudCheckInputs(publication.dir, { ...host, ...routedFrom(release, host) })).toThrow("outside tracked files");
});

test.skipIf(process.platform !== "linux")("a fixture gate started under a routed parent runs the checkout's own cpu-admission.ts", async () => {
  setEnv("LLV_DOCKER_NSENTER_SHIMS", undefined);
  // The installed release's helper answers every routed call with a refusal.
  const release = installedRelease("scripts");
  fs.writeFileSync(path.join(release, "scripts/cpu-admission.ts"), 'console.error("installed helper answered"); process.exit(2);\n');
  const routed = routedFrom(release, { LLV_GATE_BUN: process.execPath });
  const unrouted = routedFrom(release, {});
  expect(gateAdmissionInterpreter(routed.LLV_GATE_BUN)).toBe(process.execPath);
  expect(gateAdmissionInterpreter(unrouted.LLV_GATE_BUN)).toBeNull();
  const quiet = (env: NodeJS.ProcessEnv) => {
    fs.writeFileSync(env.LLV_GATE_PSI_FILE!, "some avg10=0.00 total=1\n");
    return { ...env, LLV_GATE_RUNNER: "off", LLV_GATE_SLOTS: "1" };
  };
  const control = fixture();
  try {
    // Control: the routed value itself reaches the installed helper.
    const reached = await realExec("bash", control.command("routed").slice(1), repository, { ...quiet(control.env), ...routed }, { signal: AbortSignal.timeout(20_000) });
    expect(reached.code, reached.stderr).toBe(2);
    expect(reached.stderr).toContain("installed helper answered");
  } finally { control.close(); }
  setEnv("LLV_GATE_BUN", routed.LLV_GATE_BUN);
  const f = fixture();
  try {
    expect((f.env as NodeJS.ProcessEnv).LLV_GATE_BUN).toBe(process.execPath);
    const result = await realExec("bash", f.command("own").slice(1), repository, quiet(f.env), { signal: AbortSignal.timeout(20_000) });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("installed helper answered");
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("own\n");
  } finally { f.close(); }
  // A launcher that recorded no interpreter leaves the fixture on PATH's Bun;
  // any other value is the caller's own choice and stays.
  expect(withoutInheritedGate({ ...process.env, LLV_GATE_BUN: unrouted.LLV_GATE_BUN }).LLV_GATE_BUN).toBeUndefined();
  expect(withoutInheritedGate({ ...process.env, LLV_GATE_BUN: "/opt/bun-1.4.0" }).LLV_GATE_BUN).toBe("/opt/bun-1.4.0");
}, 60_000);

test("only an admission launcher with its recorded interpreter is normalised", () => {
  const home = temporary("gate-admission-home-");
  const directory = path.join(home, ".cache/delegatus/gate-admission", "a".repeat(64));
  fs.mkdirSync(directory, { recursive: true });
  const launcher = path.join(directory, "bun");
  fs.writeFileSync(launcher, "#!/bin/bash\n");
  expect(gateAdmissionInterpreter(launcher)).toBeUndefined(); // no recorded interpreter
  fs.writeFileSync(path.join(directory, "interpreter"), "");
  expect(gateAdmissionInterpreter(launcher)).toBeNull();
  fs.writeFileSync(path.join(directory, "interpreter"), "/opt/bun-1.4.0");
  expect(gateAdmissionInterpreter(launcher)).toBe("/opt/bun-1.4.0");
  for (const other of [undefined, "", process.execPath, path.join(home, ".cache/delegatus/gate-admission/short/bun"),
    path.join(home, ".cache/delegatus/signal-tooling", "a".repeat(64), "bun")]) {
    expect(gateAdmissionInterpreter(other)).toBeUndefined();
  }
});
