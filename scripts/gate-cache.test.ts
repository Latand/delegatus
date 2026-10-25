import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkEnvironment, checkInputEnvironment, environmentFingerprint, GateCache, gateToolFiles, fileFingerprint, installedFingerprint, workingInputsFingerprint } from "./gate-cache";
import { agentEnvironments } from "./local-gate.fixture";
import { pipelinePublicationHookEnv } from "../src/lib/pipelines/git";
import { systemBootEpoch } from "../src/lib/processIdentity";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => { const root = mkdtempSync(path.join(tmpdir(), "gate-cache-")); roots.push(root); return root; };
const valid = (value: unknown): value is { passed: true } => !!value && typeof value === "object" && "passed" in value && value.passed === true;

test("portable input capture retains values and explicit absences without placement or authority", () => {
  const inputs = checkInputEnvironment(checkEnvironment({
    PATH: "/usr/bin", HOME: "/fixture/home", LANG: "C.UTF-8", NODE_OPTIONS: "--max-old-space-size=1024",
    LLV_GATE_CHECK_ENV: "PROBE,ABSENT,constructor", PROBE: "value", LLV_GATE_PUSH_DEADLINE: "1000", LLV_TOKEN: "private",
  }));
  expect(inputs).toEqual({ LANG: "C.UTF-8", NODE_OPTIONS: "--max-old-space-size=1024", LLV_GATE_CHECK_ENV: "PROBE,ABSENT,constructor", PROBE: "value", ABSENT: null, constructor: null });
});

test("a raw environment keys every variable that would reach a check", () => {
  const base = { NODE_ENV: "test" as const };
  for (const name of ["LLV_SPAWN_CAPABILITY", "LLV_STRUCTURED_HOST", "LLV_VIEWER_PORT", "GH_CONFIG_DIR", "CODEX_THREAD_ID"]) {
    expect(environmentFingerprint({ ...base, [name]: "first" }), name).not.toBe(environmentFingerprint({ ...base, [name]: "second" }));
    expect(environmentFingerprint({ ...base, [name]: "first" }), name).not.toBe(environmentFingerprint(base));
  }
});

test("checks never receive a producer's session, authority or endpoint, and producer and publication share one key", () => {
  const forge = path.join(fixture(), "agent-forge", "lane");
  const { producer, viewer } = agentEnvironments({ PATH: "/usr/local/bin:/usr/bin", LANG: "C.UTF-8", USER: "builder", SHELL: "/bin/bash" }, forge);
  const publication = { ...viewer, ...pipelinePublicationHookEnv(viewer), LLV_PRIVACY_KNOWN_VALUES_FILE: "lessons.json",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "forge-helper", LLV_GATE_PUSH_DEADLINE: "1000" };
  const checks = checkEnvironment(producer);
  for (const name of ["LLV_SPAWN_CAPABILITY", "LLV_STRUCTURED_HOST", "LLV_VIEWER_PORT", "LLV_AGENT_FORGE_DIR", "GH_CONFIG_DIR", "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_TOKEN", "AI_AGENT", "CODEX_THREAD_ID", "GIT_CONFIG_COUNT", "GIT_EDITOR", "LLV_STAGE_GIT_RECEIPT", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL"]) expect(checks[name], name).toBeUndefined();
  expect(checks.PATH).toBe("/usr/local/bin:/usr/bin");
  for (const name of ["LLV_STATE_OWNER", "LLV_LANG", "LLV_TOKEN", "PORT", "TELEGRAM_BOT_TOKEN", "GIT_CONFIG_COUNT", "LLV_PRIVACY_KNOWN_VALUES_FILE"]) expect(checkEnvironment(publication)[name], name).toBeUndefined();
  expect(environmentFingerprint(checkEnvironment(producer))).toBe(environmentFingerprint(checkEnvironment(publication)));
  expect(checkEnvironment(checks)).toEqual(checks);
  // A changed input that does reach the checks still separates them.
  for (const change of [{ PATH: "/opt/other/bin:/usr/bin" }, { NODE_OPTIONS: "--stack-trace-limit=25" }, { LANG: "uk_UA.UTF-8" }, { CHROME_BIN: "/opt/chrome" }])
    expect(environmentFingerprint(checkEnvironment({ ...producer, ...change })), JSON.stringify(change)).not.toBe(environmentFingerprint(checks));
  // A raw environment that reaches tests directly keys an identity by presence only.
  expect(environmentFingerprint({ PATH: "/usr/bin", GIT_AUTHOR_NAME: "first" })).toBe(environmentFingerprint({ PATH: "/usr/bin", GIT_AUTHOR_NAME: "second" }));
  expect(environmentFingerprint({ PATH: "/usr/bin", GIT_AUTHOR_NAME: "first" })).not.toBe(environmentFingerprint({ PATH: "/usr/bin" }));
  const declared = { ...producer, LLV_GATE_CHECK_ENV: "PROBE", PROBE: "first" };
  expect(checkEnvironment(declared).PROBE).toBe("first");
  expect(environmentFingerprint(checkEnvironment(declared))).not.toBe(environmentFingerprint(checkEnvironment({ ...declared, PROBE: "second" })));
});

test("the signal boundary binds its host epoch, never the gate service that admitted a run", () => {
  const epoch = systemBootEpoch() ?? "linux:fixture-boot:pidns:pid:[1]";
  const boundary = (fields: Record<string, unknown>) => JSON.stringify({ policyVersion: 1, hostEpoch: epoch, scope: "/agent.scope", gate: { cgroup: "/a/delegatus-gate-1.service", entry: "10:1" }, ...fields });
  const base = { PATH: "/usr/bin", LLV_SIGNAL_SANDBOX: boundary({}) };
  const key = (env: Partial<NodeJS.ProcessEnv>) => environmentFingerprint(checkEnvironment(env));
  expect(checkEnvironment(base).LLV_SIGNAL_SANDBOX).toBe(base.LLV_SIGNAL_SANDBOX);
  expect(key({ ...base, LLV_SIGNAL_SANDBOX: boundary({ gate: { cgroup: "/b/delegatus-gate-2.service", entry: "20:2" } }) })).toBe(key(base));
  expect(key({ ...base, LLV_SIGNAL_SANDBOX: boundary({ gate: undefined, scope: "/another-agent.scope" }) })).toBe(key(base));
  expect(key({ ...base, LLV_SIGNAL_SANDBOX: boundary({ hostEpoch: "linux:another-boot:pidns:pid:[1]" }) })).not.toBe(key(base));
  for (const forged of [boundary({ policyVersion: 2 }), boundary({ hostEpoch: 7 }), "not json"]) {
    expect(key({ ...base, LLV_SIGNAL_SANDBOX: forged }), forged).not.toBe(key(base));
    expect(key({ ...base, LLV_SIGNAL_SANDBOX: forged }), forged).not.toBe(key({ ...base, LLV_SIGNAL_SANDBOX: forged }));
  }
  if (systemBootEpoch()) expect(key({ PATH: "/usr/bin" })).toBe(key(base));
});

test("effective Git configuration binds receipts while invocation metadata does not", () => {
  const first = { NODE_ENV: "test" as const, GIT_CONFIG_GLOBAL: "first-config" };
  const key = (env: Partial<NodeJS.ProcessEnv>) => environmentFingerprint(checkEnvironment(env));
  expect(key(first)).not.toBe(key({ ...first, GIT_CONFIG_GLOBAL: "second-config" }));
  expect(key(first)).toBe(key({ ...first, LLV_GATE_PUSH_DEADLINE: "1000", CODEX_THREAD_ID: "second-thread" }));
  const config = path.join(fixture(), "gitconfig");
  writeFileSync(config, "[core]\n autocrlf = false\n");
  const env = { ...first, GIT_CONFIG_GLOBAL: config }, before = key(env);
  writeFileSync(config, "[core]\n autocrlf = true\n");
  expect(key(env)).not.toBe(before);
});

test("receipts survive a process restart; corruption, expiry and oversized records are misses", () => {
  const root = fixture(), cacheModule = path.join(import.meta.dir, "gate-cache.ts");
  const run = (source: string) => {
    const result = Bun.spawnSync([process.execPath, "-e", `import { GateCache } from ${JSON.stringify(cacheModule)}; const cache = new GateCache(${JSON.stringify(root)}, value => value?.passed === true); ${source}`]);
    expect(result.exitCode, result.stderr.toString()).toBe(0); return result.stdout.toString().trim();
  };
  run('cache.write("same-input", { passed: true });');
  expect(run('console.log(cache.read("same-input")?.passed);')).toBe("true");
  expect(run('console.log(cache.read("different-input"));')).toBe("undefined");
  const file = path.join(root, readdirSync(root)[0]!);
  const original = readFileSync(file);
  writeFileSync(file, "partial write"); expect(run('console.log(cache.read("same-input"));')).toBe("undefined");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(original.toString()), value: { passed: true, changed: true } }));
  expect(run('console.log(cache.read("same-input"));')).toBe("undefined");
  writeFileSync(file, original); utimesSync(file, new Date(0), new Date(0));
  expect(run('console.log(cache.read("same-input"));')).toBe("undefined");
  writeFileSync(file, "x".repeat(1024 * 1024 + 1));
  expect(run('console.log(cache.read("same-input"));')).toBe("undefined");
});

test("receipt generations are bounded; unavailable storage only loses acceleration", () => {
  const root = fixture(), cache = new GateCache(root, valid);
  for (let index = 0; index < 260; index++) cache.write(String(index), { passed: true });
  expect(readdirSync(root)).toHaveLength(256);
  writeFileSync(path.join(root, "blocked"), "regular file");
  const blocked = new GateCache(path.join(root, "blocked", "child"), valid);
  expect(() => blocked.write("key", { passed: true })).not.toThrow();
  expect(blocked.read("key")).toBeUndefined();
  const largeRoot = fixture(), large = new GateCache(largeRoot, valid);
  const value = { passed: true as const, payload: "x".repeat(900_000) };
  for (let index = 0; index < 40; index++) large.write(String(index), value);
  expect(readdirSync(largeRoot).reduce((bytes, file) => bytes + statSync(path.join(largeRoot, file)).size, 0)).toBeLessThanOrEqual(32 * 1024 * 1024);
});

test("an installed tool edit invalidates the fingerprint without a version or lockfile change", () => {
  const root = fixture(), directory = path.join(root, "node_modules", "compiler"); mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "package.json"), '{"version":"1.0.0"}');
  const script = path.join(directory, "compiler.js"); writeFileSync(script, "export const result = true;");
  const before = installedFingerprint(root);
  writeFileSync(script, "export const result = false;");
  expect(installedFingerprint(root)).not.toBe(before);
});

test("JSON and interpreter lines stay bound without being parsed as module code", () => {
  const root = fixture();
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(path.join(root, "scripts", "local-gate.ts"), 'import "./child";');
  const child = path.join(root, "scripts", "child.ts");
  const contents = 'import "../policy.json"; export const value = true;';
  writeFileSync(child, `#!/usr/bin/env bun\n${contents}`);
  const policy = path.join(root, "policy.json");
  writeFileSync(policy, '{"enabled":true,"limits":[1,2]}');
  const inputs = gateToolFiles(root);
  expect(inputs).toContain("policy.json");
  expect(inputs).toContain(path.join("scripts", "child.ts"));
  expect(inputs.map(file => path.win32.normalize(file))).toContain(path.win32.join("scripts", "child.ts"));
  const modulePath = path.join(import.meta.dir, "gate-cache.ts");
  const run = (body: string) => {
    const source = `import path from "node:path";
      import { GateCache, gateToolFiles, fileFingerprint, fingerprint } from ${JSON.stringify(modulePath)};
      const root = ${JSON.stringify(root)};
      const key = fingerprint(gateToolFiles(root).map(file => [file, fileFingerprint(path.join(root, file))]));
      const cache = new GateCache(path.join(root, "receipts"), value => value?.passed === true);
      ${body}`;
    const result = Bun.spawnSync([process.execPath, "-e", source], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  expect(run('cache.write(key, { passed: true }); console.log(cache.read(key)?.passed);')).toBe("true");
  writeFileSync(policy, '{"enabled":false,"limits":[1,2]}');
  expect(run("console.log(cache.read(key));")).toBe("undefined");
  expect(run('cache.write(key, { passed: true }); console.log(cache.read(key)?.passed);')).toBe("true");
  writeFileSync(child, `#!/usr/bin/env node\n${contents}`);
  expect(run("console.log(cache.read(key));")).toBe("undefined");
  writeFileSync(child, "export const broken = ;");
  expect(() => gateToolFiles(root)).toThrow();
});

test("a shared install flipping group or other bits keeps the fingerprint; the owner's execute bit changes it", () => {
  const root = fixture(), directory = path.join(root, "node_modules", "cli"); mkdirSync(directory, { recursive: true });
  const script = path.join(directory, "cli.mjs"); writeFileSync(script, "export {};"); chmodSync(script, 0o775);
  const before = installedFingerprint(root);
  chmodSync(script, 0o777); expect(installedFingerprint(root)).toBe(before);
  chmodSync(script, 0o664); expect(installedFingerprint(root)).not.toBe(before);
});

test("a symlink retarget invalidates working inputs even when its target files have identical bytes", () => {
  const root = fixture();
  for (const [name, value] of [["first", true], ["second", false]] as const) {
    const directory = path.join(root, name); mkdirSync(directory);
    writeFileSync(path.join(directory, "entry.ts"), 'export { default } from "./value";');
    writeFileSync(path.join(directory, "value.ts"), `export default ${value};`);
  }
  const link = path.join(root, "selected.ts");
  symlinkSync(path.join(root, "first/entry.ts"), link);
  const before = workingInputsFingerprint(root);
  rmSync(link); symlinkSync(path.join(root, "second/entry.ts"), link);
  expect(workingInputsFingerprint(root)).not.toBe(before);
});

test("orphaned atomic writes share the receipt storage bound after a restart", () => {
  const root = fixture();
  const interrupted = Bun.spawnSync([process.execPath, "-e", `import { writeFileSync } from "node:fs"; import path from "node:path";
    for (let index = 0; index < 260; index++) {
      const id = [index.toString(16).padStart(8, "0"), "0000", "4000", "8000", "000000000000"].join("-");
      writeFileSync(path.join(${JSON.stringify(root)}, ".write-" + id), "interrupted write");
    }`]);
  expect(interrupted.exitCode).toBe(0);
  const restarted = Bun.spawnSync([process.execPath, "-e", `import { GateCache } from ${JSON.stringify(path.join(import.meta.dir, "gate-cache.ts"))};
    new GateCache(${JSON.stringify(root)}, value => value?.passed === true).write("complete", { passed: true });`]);
  expect(restarted.exitCode, restarted.stderr.toString()).toBe(0);
  expect(readdirSync(root)).toHaveLength(256);
});


test("gate receipts fingerprint imported data without parsing it as source", () => {
  const root = fixture();
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "scripts/local-gate.ts"), 'import "../package.json"; import "../src/check";\n');
  writeFileSync(path.join(root, "src/check.ts"), 'import "../checks.json"; export const check = true;\n');
  writeFileSync(path.join(root, "package.json"), '{"version":"1"}');
  writeFileSync(path.join(root, "checks.json"), '{"enabled":true}');
  const files = gateToolFiles(root);
  expect(files).toContain("package.json");
  expect(files).toContain("checks.json");
  expect(files).toContain("src/check.ts");
  const fingerprint = () => files.map(file => fileFingerprint(path.join(root, file)));
  const before = fingerprint();
  writeFileSync(path.join(root, "checks.json"), '{"enabled":false}');
  expect(fingerprint()).not.toEqual(before);
  writeFileSync(path.join(root, "src/check.ts"), "export const broken = ;");
  expect(() => gateToolFiles(root)).toThrow();
});


test("gate receipts follow imports from executable scripts with a shebang", () => {
  const root = fixture();
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "bin"));
  writeFileSync(path.join(root, "scripts/local-gate.ts"), 'import "../bin/check.mjs";\n');
  writeFileSync(path.join(root, "bin/check.mjs"), '#!/usr/bin/env bun\nimport "../scripts/child";\n');
  writeFileSync(path.join(root, "scripts/child.ts"), 'export const check = true;\n');
  expect(gateToolFiles(root)).toContain("scripts/child.ts");
});
