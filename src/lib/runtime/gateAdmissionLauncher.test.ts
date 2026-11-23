import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloudCheckInputs } from "../../../scripts/cloud-checks";
import { checkEnvironment, checkInputEnvironment, environmentFingerprint } from "../../../scripts/gate-cache";
import { createHookFixture } from "../../../scripts/local-gate.fixture";
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
  expect(routed.LLV_GATE_BUN?.startsWith(path.join(os.homedir(), ".cache/delegatus/gate-admission") + path.sep)).toBe(true);
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
