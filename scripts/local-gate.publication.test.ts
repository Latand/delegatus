import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createPublicationFixtures } from "./publicationHook.fixture";
import { PUBLICATION_TRANSPORT_MS, publicationCheckBinding, readPublicationCheckReceipt, writePublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const nativeTest = test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch));
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const { fixture, nativeFixture, touchedChecks, commitFixtureInputs } = createPublicationFixtures(root, roots);

nativeTest.each(["Codex", "Bun and Codex"])("cold %s cache produces evidence once and warm preparation reuses it", tools => {
  const coldBun = tools === "Bun and Codex";
  const f = nativeFixture(coldBun);
  expect(fs.existsSync(f.codex)).toBeFalse();
  const cold = f.run(true);
  expect(cold.status, cold.stderr).toBe(0);
  expect(readPublicationCheckReceipt(f.receipt, publicationCheckBinding(f.env)).inputs).toMatch(/^[a-f0-9]{64}$/);
  expect(touchedChecks(f)).toHaveLength(1);
  const installations = () => f.calls().filter(call => call.args[0] === "native-install").map(call => call.args[1]);
  expect(installations()).toEqual(coldBun ? ["bun", "codex"] : ["codex"]);
  expect(f.run(false).status).toBe(0);
  f.env.LLV_GATE_PUBLICATION_ID = "warm-native-cache";
  const warm = f.run(true);
  expect(warm.status, warm.stderr).toBe(0);
  expect(touchedChecks(f)).toHaveLength(1);
  expect(installations()).toEqual(coldBun ? ["bun", "codex"] : ["codex"]);
  const before = f.calls().length;
  expect(f.run(false).status).toBe(0);
  expect(f.calls().slice(before).map(call => call.args[0])).toEqual(["scripts/privacy-publication-gate.ts"]);
}, 120_000);

nativeTest.each(["install failure", "deadline", "custody", "during checks", "after checks"])("native preparation retains refusal on %s", change => {
  const f = nativeFixture();
  if (change === "install failure") f.env.HOOK_FAIL = "native-install";
  if (change === "deadline") f.env.LLV_GATE_PUSH_DEADLINE = "1";
  if (change === "custody") delete f.env.LLV_GATE_PUBLICATION_FENCE;
  if (change === "during checks") {
    fs.appendFileSync(path.join(f.dir, "record.ts"), `\nif (process.argv[2] === "scripts/local-gate-tests.ts") require("node:fs").appendFileSync(${JSON.stringify(f.codex)}, "# changed tool\\n");\n`);
    f.git("-c", "core.hooksPath=/dev/null", "add", "record.ts");
    f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "tool drift fixture");
    f.head = f.git("rev-parse", "HEAD").toString().trim(); f.env.LLV_GATE_PUSH_HEAD = f.head;
  }
  const prepared = f.run(true);
  if (change === "after checks") {
    expect(prepared.status, prepared.stderr).toBe(0);
    fs.appendFileSync(f.codex, "# changed tool\n");
    const before = f.calls().length;
    const refused = f.run(false);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("publication check inputs changed");
    expect(f.calls()).toHaveLength(before);
  } else {
    expect(prepared.status).not.toBe(0);
    if (change === "during checks") expect(prepared.stderr).toContain("publication inputs changed during checks");
    else expect(f.calls().filter(call => call.args[0] === "scripts/local-gate-tests.ts")).toHaveLength(0);
    if (change === "custody") expect(f.calls().filter(call => call.args[0] === "native-install")).toHaveLength(0);
    if (change === "deadline") expect(prepared.status).toBe(75);
    expect(fs.existsSync(f.receipt)).toBeFalse();
  }
}, 90_000);

test("a Cloud verdict does not require unused local native installations", () => {
  const f = nativeFixture();
  f.env.LLV_GATE_EXECUTION = "cloud";
  f.env.HOOK_FAIL = "native-install";
  // Cloud receives scalar fixture inputs; the local recorder stays private.
  f.env.LLV_GATE_CHECK_ENV = "HOOK_FAIL";
  delete f.env.LLV_GATE_BUN;
  delete f.env.CHROME_BIN;
  delete f.env.PLAYWRIGHT_BROWSERS_PATH;
  f.env.NODE_OPTIONS = "--max-old-space-size=1024";
  f.env.SHELL = "/bin/sh";
  for (const name of Object.keys(f.env)) if (/^(?:BUN_|GIT_CONFIG_)/.test(name)) delete f.env[name];
  // Only the account/transport seams are controlled in this fresh CLI process.
  // The production Cloud verifier still binds its returned verdict to the job.
  const preload = path.join(f.dir, ".git", "cloud-verdict.ts");
  fs.writeFileSync(preload, `import { mock } from "bun:test";
    const cloud = await import(${JSON.stringify(path.join(root, "scripts/cloud-checks.ts"))});
    mock.module(${JSON.stringify(path.join(root, "scripts/cloud-check-config.ts"))}, () => ({ cloudCheckConfig: async () => ({}) }));
    mock.module(${JSON.stringify(path.join(root, "scripts/cloud-checks.ts"))}, () => ({ ...cloud, AppServerCloudTransport: class {
      async run(job) { return { kind: "verdict", head: job.head, tree: job.tree, base: job.base, inputs: cloud.cloudInputDigest(job.inputs), code: 0 }; }
    } }));`);
  const result = spawnSync(process.execPath, ["--preload", preload, "scripts/local-gate.ts", "pre-push", "--publication-prepare"], {
    cwd: f.dir, env: f.env, encoding: "utf8", timeout: 45_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("pre-push: Cloud checks");
  expect(readPublicationCheckReceipt(f.receipt, publicationCheckBinding(f.env)).inputs).toMatch(/^[a-f0-9]{64}$/);
  expect(fs.existsSync(f.codex)).toBeFalse();
  expect(touchedChecks(f)).toHaveLength(0);
  const hook = f.run(false);
  expect(hook.status, hook.stderr).toBe(0);
}, 60_000);

test("prepared checks are consumed once by a fresh native hook, with fresh privacy and no second admission", () => {
  const f = fixture();
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).toBe(0);
  const before = f.calls().length;
  const hook = f.run(false);
  expect(hook.status, hook.stderr).toBe(0);
  expect(f.calls().slice(before).map(call => call.args[0])).toEqual(["scripts/privacy-publication-gate.ts"]);
  expect(hook.stderr).not.toContain("CPU admission");
  expect(fs.existsSync(f.receipt)).toBeFalse();
  expect(f.run(false).status).not.toBe(0);
}, 60_000);

test.each(["during checks", "before transport", "during transport"])("another writer refreshing privacy known values %s retains checked work", when => {
  const f = fixture();
  const known = path.join(f.dir, ".git", "known-values.txt");
  f.env.LLV_PRIVACY_KNOWN_VALUES_FILE = known;
  fs.writeFileSync(known, "initial private phrase\n");
  const refresh = `require("node:fs").writeFileSync(${JSON.stringify(known)}, "another private phrase\\n");`;
  if (when !== "before transport") {
    const condition = when === "during checks" ? 'process.argv[2] === "tsc"'
      : 'process.argv[2] === "scripts/privacy-publication-gate.ts" && process.env.LLV_GATE_PUBLICATION_OBSERVED';
    fs.appendFileSync(path.join(f.dir, "record.ts"), `\nif (${condition}) require("node:child_process").execFileSync(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(refresh)}]);\n`);
    commitFixtureInputs(f);
  }
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).toBe(0);
  if (when === "before transport") {
    const writer = spawnSync(process.execPath, ["-e", refresh], { env: f.env, encoding: "utf8" });
    expect(writer.status, writer.stderr).toBe(0);
  }
  const before = f.calls().length;
  const transported = f.run(false);
  expect(transported.status, transported.stderr).toBe(0);
  expect(fs.readFileSync(known, "utf8")).toBe("another private phrase\n");
  expect(f.calls().slice(before).map(call => call.args[0])).toEqual(["scripts/privacy-publication-gate.ts"]);
  expect(fs.existsSync(f.receipt)).toBeFalse();
}, 60_000);

test("a privacy-only refresh retains all reused heavy checks", () => {
  const f = fixture();
  f.env.LLV_PRIVACY_KNOWN_VALUES_FILE = path.join(f.dir, ".git", "known-values.txt");
  fs.writeFileSync(f.env.LLV_PRIVACY_KNOWN_VALUES_FILE, "initial private phrase\n");
  const refresh = 'require("node:fs").writeFileSync(process.env.LLV_PRIVACY_KNOWN_VALUES_FILE, "another private phrase\\n");';
  fs.appendFileSync(path.join(f.dir, "record.ts"), `\nif (process.argv[2] === "scripts/privacy-publication-gate.ts" && process.env.LLV_GATE_PUBLICATION_ID === "warm-refresh") require("node:child_process").execFileSync(process.env.HOOK_BUN!, ["-e", ${JSON.stringify(refresh)}]);\n`);
  commitFixtureInputs(f);
  const first = f.run(true);
  expect(first.status, first.stderr).toBe(0);
  expect(f.calls().some(call => call.args[0] === "tsc")).toBeTrue();
  expect(f.run(false).status).toBe(0);
  f.env.LLV_GATE_PUBLICATION_ID = "warm-refresh";
  const before = f.calls().length;
  const warm = f.run(true);
  expect(warm.status, warm.stderr).toBe(0);
  for (const step of ["types", "eslint", "touched tests"]) expect(warm.stderr).toContain(`${step}: reused pass`);
  expect(f.calls().slice(before).map(call => call.args[0])).toEqual(["scripts/privacy-publication-gate.ts"]);
  expect(fs.readFileSync(f.env.LLV_PRIVACY_KNOWN_VALUES_FILE, "utf8")).toBe("another private phrase\n");
  expect(f.run(false).status).toBe(0);
}, 60_000);

test.each(["head", "tree", "base", "dependencies", "toolchain", "git config", "working inputs"])("a real %s change during checks names its component and refuses", component => {
  const f = fixture();
  const dependency = path.join(f.dir, "node_modules", "fixture", "index.js");
  fs.mkdirSync(path.dirname(dependency), { recursive: true });
  fs.writeFileSync(dependency, "export const value = 1;\n");
  fs.mkdirSync(path.join(f.dir, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(f.dir, ".git", "info", "exclude"), "node_modules/\ngenerated.d.ts\n");
  const generated = path.join(f.dir, "generated.d.ts");
  fs.writeFileSync(generated, "declare const value: 1;\n");
  const tool = path.join(f.dir, ".git", "toolchain", "bunx");
  if (component === "toolchain") {
    fs.mkdirSync(path.dirname(tool));
    fs.copyFileSync(path.join(f.dir, "shims", "bunx"), tool);
    fs.chmodSync(tool, 0o755);
    f.env.PATH = `${path.dirname(tool)}${path.delimiter}${f.env.PATH}`;
  }
  const identity = Object.fromEntries(["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"].map(name => [name, f.env[name]]));
  const git = (args: string[]) => `require("node:child_process").execFileSync("git", ${JSON.stringify(args)}, {cwd:${JSON.stringify(f.dir)},env:{...process.env,...${JSON.stringify(identity)}},stdio:"pipe"});`;
  const mutation = component === "head" ? git(["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "moved head"])
    : component === "base" ? git(["update-ref", "refs/remotes/origin/main", "HEAD"])
    : component === "git config" ? git(["config", "delegatus.checks", "changed"])
    : component === "tree" ? `require("node:fs").writeFileSync(${JSON.stringify(path.join(f.dir, "example.ts"))}, "export const value = 3;\\n");`
      + git(["-c", "core.hooksPath=/dev/null", "add", "example.ts"]) + git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "changed tree"])
    : component === "dependencies" ? `if ((await import(${JSON.stringify(dependency)})).value !== 1) throw new Error("dependency control failed"); require("node:fs").writeFileSync(${JSON.stringify(dependency)}, "export const value = 2;\\n");`
    : `require("node:fs").appendFileSync(${JSON.stringify(component === "toolchain" ? tool : generated)}, ${JSON.stringify(component === "toolchain" ? "# changed tool\n" : "// changed input\n")});`;
  fs.appendFileSync(path.join(f.dir, "record.ts"), `\nif (process.argv[2] === "tsc") { ${mutation} }\n`);
  commitFixtureInputs(f);
  const refused = f.run(true);
  expect(refused.status, refused.stderr).not.toBe(0);
  expect(refused.stderr).toContain("publication inputs changed during checks");
  const changed = /changed components: ([^\n;]+)/.exec(refused.stderr)?.[1]?.split(", ");
  expect(changed, refused.stderr).toContain(component);
  expect(fs.existsSync(f.receipt)).toBeFalse();
}, 60_000);

test.each(["unrelated", "newly private", "missing"])("fresh transport privacy checks use the %s known-values refresh", change => {
  const f = fixture();
  const known = path.join(f.dir, ".git", "known-values.txt");
  fs.writeFileSync(known, "initial private phrase\n");
  Object.assign(f.env, { LLV_PRIVACY_KNOWN_VALUES_FILE: known, HOOK_PRIVACY: path.join(root, "scripts/privacy-publication-gate.ts") });
  fs.copyFileSync(path.join(root, "scripts/privacy-known-value-fingerprints.json"), path.join(f.dir, "scripts/privacy-known-value-fingerprints.json"));
  const shim = path.join(f.dir, "shims", "bun");
  fs.writeFileSync(shim, fs.readFileSync(shim, "utf8").replace("#!/bin/bash\n", '#!/bin/bash\nif [[ "$1" == scripts/privacy-publication-gate.ts ]]; then shift; exec "$HOOK_BUN" "$HOOK_PRIVACY" "$@"; fi\n'));
  fs.writeFileSync(path.join(f.dir, "release.md"), "A retained publication sample phrase.\n");
  commitFixtureInputs(f);
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).toBe(0);
  if (change === "missing") fs.unlinkSync(known);
  else fs.writeFileSync(known, change === "newly private" ? "A retained publication sample phrase.\n" : "another private phrase\n");
  const before = f.calls().length;
  const transported = f.run(false);
  expect(transported.stderr).toContain("pre-push: privacy");
  if (change === "unrelated") expect(transported.status, transported.stderr).toBe(0);
  else {
    expect(transported.status, transported.stderr).not.toBe(0);
    expect(transported.stderr).toContain(change === "newly private" ? "known_value" : "configuration_error");
  }
  expect(f.calls()).toHaveLength(before);
  expect(fs.existsSync(f.receipt)).toBeFalse();
}, 60_000);

nativeTest.each(["leaf", "ancestor"])("fresh transport refuses a known-values %s symlink", kind => {
  const f = fixture();
  const privacyDirectory = path.join(f.dir, ".git", "privacy-inputs");
  const known = path.join(privacyDirectory, "known-values.txt");
  const replacementDirectory = path.join(f.dir, ".git", "replacement-privacy-inputs");
  const replacement = path.join(replacementDirectory, "known-values.txt");
  const content = "initial private phrase\n";
  fs.mkdirSync(privacyDirectory, { recursive: true });
  fs.writeFileSync(known, content);
  Object.assign(f.env, { LLV_PRIVACY_KNOWN_VALUES_FILE: known, HOOK_PRIVACY: path.join(root, "scripts/privacy-publication-gate.ts") });
  fs.copyFileSync(path.join(root, "scripts/privacy-known-value-fingerprints.json"), path.join(f.dir, "scripts/privacy-known-value-fingerprints.json"));
  const shim = path.join(f.dir, "shims", "bun");
  fs.writeFileSync(shim, fs.readFileSync(shim, "utf8").replace("#!/bin/bash\n", '#!/bin/bash\nif [[ "$1" == scripts/privacy-publication-gate.ts ]]; then shift; exec "$HOOK_BUN" "$HOOK_PRIVACY" "$@"; fi\n'));
  fs.writeFileSync(path.join(f.dir, "release.md"), "A retained publication sample phrase.\n");
  commitFixtureInputs(f);
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).toBe(0);

  fs.mkdirSync(replacementDirectory, { recursive: true });
  fs.writeFileSync(replacement, content);
  if (kind === "leaf") {
    fs.unlinkSync(known);
    fs.symlinkSync(replacement, known);
  } else {
    fs.renameSync(privacyDirectory, `${privacyDirectory}-original`);
    fs.symlinkSync(replacementDirectory, privacyDirectory, "dir");
  }

  const before = f.calls().length;
  const transported = f.run(false);
  expect(transported.status, transported.stderr).not.toBe(0);
  expect(transported.stderr).toContain("publication privacy inputs cannot be certified");
  expect(f.calls()).toHaveLength(before);
  expect(fs.existsSync(f.receipt)).toBeFalse();
}, 60_000);

test("a known-values change inside the fresh privacy scan refuses with its component", () => {
  const f = fixture();
  f.env.LLV_PRIVACY_KNOWN_VALUES_FILE = path.join(f.dir, ".git", "known-values.txt");
  fs.writeFileSync(f.env.LLV_PRIVACY_KNOWN_VALUES_FILE, "initial private phrase\n");
  fs.appendFileSync(path.join(f.dir, "record.ts"), '\nif (process.argv[2] === "scripts/privacy-publication-gate.ts" && process.env.LLV_GATE_PUBLICATION_OBSERVED) require("node:fs").writeFileSync(process.env.LLV_PRIVACY_KNOWN_VALUES_FILE!, "another private phrase\\n");\n');
  commitFixtureInputs(f);
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).toBe(0);
  const transported = f.run(false);
  expect(transported.status, transported.stderr).not.toBe(0);
  expect(transported.stderr).toContain("publication inputs changed during privacy checks; changed components: privacy files (LLV_PRIVACY_KNOWN_VALUES_FILE)");
  expect(fs.existsSync(f.receipt)).toBeFalse();
}, 60_000);

test.each(["head", "base", "source", "config", "environment", "tool", "operation", "epoch", "authority", "privacy", "privacy-path", "destination"])("a changed %s refuses a prepared operation", kind => {
  const f = fixture();
  if (kind === "environment") f.env.LANG = "en_US.UTF-8";
  if (kind === "privacy-path") {
    f.env.LLV_PRIVACY_KNOWN_VALUES_FILE = path.join(f.dir, ".git", "known.json");
    fs.writeFileSync(f.env.LLV_PRIVACY_KNOWN_VALUES_FILE, "[]");
  }
  const prepared = f.run(true); expect(prepared.status, prepared.stderr).toBe(0);
  const extra: Partial<NodeJS.ProcessEnv> = {};
  if (kind === "head") { f.git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "moved head"); }
  if (kind === "base") f.git("update-ref", "refs/remotes/origin/main", f.head);
  if (kind === "source") fs.writeFileSync(path.join(f.dir, "example.ts"), "export const value = 3;\n");
  if (kind === "config") f.git("config", "delegatus.checks", "local");
  if (kind === "environment") extra.LANG = "C";
  if (kind === "tool") fs.appendFileSync(path.join(f.dir, "shims", "bunx"), "# changed executable\n");
  if (kind === "operation") extra.LLV_GATE_PUBLICATION_ID = "operation-two";
  if (kind === "epoch") extra.LLV_GATE_PUBLICATION_EPOCH = "2";
  if (kind === "authority") extra.LLV_GATE_PUBLICATION_FENCE = "custody-two";
  if (kind === "privacy") extra.LLV_PRIVACY_OCR_LANGUAGES = "eng";
  if (kind === "privacy-path") {
    extra.LLV_PRIVACY_KNOWN_VALUES_FILE = path.join(f.dir, ".git", "other-known.json");
    fs.writeFileSync(extra.LLV_PRIVACY_KNOWN_VALUES_FILE, "[]");
  }
  if (kind === "destination") extra.LLV_GATE_PUBLICATION_REF = "refs/heads/other";
  const before = f.calls().length;
  const refused = f.run(false, extra);
  expect(refused.status, refused.stderr).not.toBe(0);
  expect(f.calls().slice(before)).toHaveLength(0);
}, 60_000);

test("receipt deadlines, malformed records and missing custody fail closed", () => {
  const f = fixture();
  const binding = publicationCheckBinding(f.env);
  writePublicationCheckReceipt(f.receipt, binding, "a".repeat(64));
  const record = readPublicationCheckReceipt(f.receipt, binding);
  expect(() => readPublicationCheckReceipt(f.receipt, binding, record.completedAt + PUBLICATION_TRANSPORT_MS)).toThrow("stale");
  expect(() => readPublicationCheckReceipt(f.receipt, binding, record.completedAt - 1)).toThrow("stale");
  fs.writeFileSync(f.receipt, "{}");
  expect(() => readPublicationCheckReceipt(f.receipt, binding)).toThrow();
  expect(() => publicationCheckBinding({ ...f.env, LLV_GATE_PUBLICATION_EPOCH: undefined })).toThrow("incomplete");
});

test("receipt component hashes round trip and malformed component records refuse", () => {
  const f = fixture();
  const binding = publicationCheckBinding(f.env);
  const components = { head: "b".repeat(64), "privacy configuration": "c".repeat(64) };
  writePublicationCheckReceipt(f.receipt, binding, "a".repeat(64), components);
  const record = readPublicationCheckReceipt(f.receipt, binding);
  expect(record.components).toEqual(components);
  for (const invalid of [null, [], { head: "unhashed value" }, { HEAD: "b".repeat(64) }]) {
    fs.writeFileSync(f.receipt, JSON.stringify({ ...record, components: invalid }));
    expect(() => readPublicationCheckReceipt(f.receipt, binding, record.completedAt)).toThrow("components are invalid");
  }
  const refused = path.join(f.dir, ".git", "invalid-receipt.json");
  expect(() => writePublicationCheckReceipt(refused, binding, "a".repeat(64), { head: "unhashed value" })).toThrow("components are invalid");
  const large = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`component ${String.fromCharCode(97 + Math.floor(index / 26), 97 + index % 26)}`, "b".repeat(64)]));
  expect(() => writePublicationCheckReceipt(refused, binding, "a".repeat(64), large)).toThrow("size limit");
  expect(fs.existsSync(refused)).toBeFalse();
});

test("transport input validation retains a named deadline refusal", () => {
  const f = fixture();
  expect(f.run(true).status).toBe(0);
  const result = f.run(false, { LLV_GATE_PUSH_DEADLINE: String(Date.now() - 1) });
  expect(result.status).toBe(75);
  expect(result.stderr).toContain('no verdict within the push budget');
  expect(result.stderr).toContain('"publication input validation"');
});
