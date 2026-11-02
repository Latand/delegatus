import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHookFixture } from "./local-gate.fixture";
import { PUBLICATION_TRANSPORT_MS, publicationCheckBinding, readPublicationCheckReceipt, writePublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";
import { publishPipelineBranch } from "../src/lib/pipelines/git";
import { pipelineCorpus } from "../src/lib/pipelines/fixtures/corpus";
import { findPipelineRecord, loadPipelines, savePipelines } from "../src/lib/pipelines/store";
import { realExec, type ExecPort } from "../src/lib/workflows/provision";
import { PUBLICATION_PACK_MARGIN_MS } from "../src/lib/pipelines/gateBudget";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const nativeTest = test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch));
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const parent = fs.mkdtempSync(path.join(tmpdir(), "publication-http-")); roots.push(parent);
  const f = createHookFixture(root, roots, false, false, path.join(parent, "source-pipeline-p0000001"));
  f.git("branch", "-m", "pipeline/task-1-p0000001");
  // Hook-fixture helpers are tracked before the changed source is committed.
  f.git("config", "core.hooksPath", "/dev/null");
  fs.writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  f.git("add", "example.ts"); f.git("commit", "-m", "checked work");
  f.git("config", "core.hooksPath", ".githooks");
  const head = f.git("rev-parse", "HEAD").toString().trim();
  const receipt = path.join(f.dir, ".git", "publication.json");
  const env: NodeJS.ProcessEnv = { ...f.env, LLV_GATE_PUBLICATION_RECEIPT: receipt, LLV_GATE_PUBLICATION_ID: "operation-one",
    LLV_GATE_PUBLICATION_EPOCH: "1", LLV_GATE_PUBLICATION_FENCE: "custody-one", LLV_GATE_PUSH_HEAD: head,
    LLV_GATE_PUBLICATION_REF: "refs/heads/main", LLV_GATE_PUBLICATION_REMOTE_HEAD: "0".repeat(40) };
  const run = (prepare: boolean, extra: Partial<NodeJS.ProcessEnv> = {}) => spawnSync(prepare ? "bun" : "bash", prepare
    ? ["scripts/local-gate.ts", "pre-push", "--publication-prepare"] : [".githooks/pre-push"], {
    cwd: f.dir, env: { ...env, ...(!prepare ? { PATH: `${f.git("--exec-path").toString().trim()}${path.delimiter}${env.PATH}` } : {}), ...extra }, encoding: "utf8", timeout: 45_000,
    input: prepare ? undefined : `HEAD ${env.LLV_GATE_PUSH_HEAD} refs/heads/main ${"0".repeat(40)}\n`,
  });
  return { ...f, head, receipt, env, run };
}

function nativeFixture(coldBun = false) {
  const f = fixture();
  const write = (file: string, source: string) => {
    const target = path.join(f.dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  };
  const smoke = 'import { test, expect } from "bun:test"; test("runtime fixture", () => expect(1).toBe(1));\n';
  write("scripts/runtime-smoke.test.ts", smoke);
  write("src/lib/mcp/answerSizes.test.ts", smoke);
  for (const name of ["audit-with-retry", "supply-chain-check"]) write(`scripts/${name}.test.ts`, smoke);
  for (const name of ["verify-viewer-runtime", "verify-runtime-host", "verify-bun-runtime-controls", "verify-native-codex-runtime"]) {
    write(`scripts/${name}.ts`, 'import fs from "node:fs"; fs.appendFileSync(process.env.HOOK_LOG!, JSON.stringify({ args: process.argv.slice(1), names: [] }) + "\\n");\n');
  }
  const bun = coldBun ? "0.0.2" : Bun.version;
  write("Dockerfile", `RUN npm install -g bun@${bun}\n`);
  write("package.json", JSON.stringify({ scripts: { build: "true" } }));
  write(".github/workflows/bun-runtime.yml", `jobs:
  bun-runtime:
    steps:
      - run: bun test ./scripts/runtime-smoke.test.ts
  native-codex-runtime:
    strategy:
      matrix:
        codex: ["0.0.1"]
`);
  f.env.XDG_CACHE_HOME = path.join(f.dir, ".git", "cold-cache");
  const target = `node_modules/@openai/codex-linux-${process.arch}/vendor/${process.arch === "x64" ? "x86_64" : "aarch64"}-unknown-linux-musl/bin/codex`;
  const codex = path.join(f.env.XDG_CACHE_HOME, "delegatus-gate/codex-0.0.1", target);
  const installer = path.join(f.dir, ".git", "install-native.ts");
  fs.writeFileSync(installer, `import fs from "node:fs"; import path from "node:path";
    if (process.env.HOOK_FAIL === "native-install") process.exit(1);
    const args = process.argv.slice(2), prefix = args[args.indexOf("--prefix") + 1]!;
    const bun = args.at(-1)!.startsWith("bun@");
    const binary = path.join(prefix, bun ? "node_modules/.bin/bun" : ${JSON.stringify(target)});
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, bun ? ${JSON.stringify(`#!/bin/sh\nif [ "$1" = --version ]; then\n  "${process.execPath}" -e 'if (Object.keys(process.env).some(name => name.startsWith("LLV_GATE_PUBLICATION_"))) process.exit(23)' || exit 23\n  echo ${bun}; exit 0\nfi\nexec "${process.execPath}" "$@"\n`)} : "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
    fs.appendFileSync(process.env.HOOK_LOG!, JSON.stringify({ args: ["native-install", bun ? "bun" : "codex"], names: [] }) + "\\n");`);
  write("shims/npm", `#!/bin/sh\nexec "${process.execPath}" "${installer}" "$@"\n`);
  fs.chmodSync(path.join(f.dir, "shims/npm"), 0o755);
  f.git("-c", "core.hooksPath=/dev/null", "add", ".");
  f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "selected native tools fixture");
  f.head = f.git("rev-parse", "HEAD").toString().trim(); f.env.LLV_GATE_PUSH_HEAD = f.head;
  return { ...f, codex, calls: () => fs.existsSync(f.env.HOOK_LOG!) ? f.calls() : [] };
}

const touchedChecks = (f: ReturnType<typeof nativeFixture>) => f.calls().filter(call =>
  call.args[0] === "scripts/local-gate-tests.ts" && call.args.includes("./example.test.ts"));

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

function commitFixtureInputs(f: ReturnType<typeof fixture>) {
  f.git("-c", "core.hooksPath=/dev/null", "add", ".");
  f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "publication input fixture");
  f.head = f.git("rev-parse", "HEAD").toString().trim();
  f.env.LLV_GATE_PUSH_HEAD = f.head;
}

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

/** Real smart HTTP Git, driven by a logical credential clock. Advancing that
 * clock in an expensive check reproduces an hour's admission without a sleep.
 * No credential value is stored or included in the evidence events. */
async function httpFixture(f: ReturnType<typeof fixture>, expireDuringChecks = true) {
  const bare = path.join(f.dir, ".git", "remote.git");
  f.git("init", "--bare", bare);
  const events = path.join(f.dir, ".git", "events.jsonl"), clock = path.join(f.dir, ".git", "clock");
  fs.writeFileSync(clock, "0"); fs.writeFileSync(events, "");
  const record = path.join(f.dir, "record.ts");
  fs.appendFileSync(record, `\nif (process.argv[2] === "tsc") { appendFileSync(process.env.CREDENTIAL_EVENTS!, JSON.stringify({kind:"checks",at:0}) + "\\n"); require("node:fs").writeFileSync(process.env.CREDENTIAL_CLOCK!, ${JSON.stringify(expireDuringChecks ? "7200000" : "0")}); }\n`);
  const helper = path.join(f.dir, "credential.ts");
  fs.writeFileSync(helper, `import fs from "node:fs"; if (process.argv[2] === "get") { const at = Number(fs.readFileSync(process.env.CREDENTIAL_CLOCK!, "utf8")); fs.appendFileSync(process.env.CREDENTIAL_EVENTS!, JSON.stringify({ kind: "mint", at }) + "\\n"); process.stdout.write("username=fixture\\n" + ["password", "fixture-" + at].join("=") + "\\n\\n"); }`);
  f.git("config", "core.hooksPath", "/dev/null"); f.git("add", "record.ts", "credential.ts"); f.git("commit", "-m", "HTTP fixture");
  f.git("config", "core.hooksPath", ".githooks");
  f.head = f.git("rev-parse", "HEAD").toString().trim(); f.env.LLV_GATE_PUSH_HEAD = f.head;
  Object.assign(f.env, { CREDENTIAL_CLOCK: clock, CREDENTIAL_EVENTS: events,
    LLV_GATE_CHECK_ENV: f.env.LLV_GATE_CHECK_ENV + ",CREDENTIAL_CLOCK,CREDENTIAL_EVENTS" });
  f.git("config", "http.receivepack", "true");
  const bareConfig = spawnSync("git", ["--git-dir", bare, "config", "http.receivepack", "true"], { env: f.env });
  expect(bareConfig.status).toBe(0);
  f.git("config", "credential.helper", `!${process.execPath} ${helper}`);
  let rpc = 0, rejected = 0, refuseRpc = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const at = Number(fs.readFileSync(clock, "utf8"));
    const writing = url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack");
    if (writing) {
      const auth = request.headers.get("authorization");
      if (!auth) return new Response("authenticate", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="fixture"' } });
      const value = Buffer.from(auth.slice(6), "base64").toString();
      const mintedAt = Number(value.slice(value.lastIndexOf("-") + 1));
      if (!value.startsWith("fixture:fixture-") || at - mintedAt >= 3_600_000) {
        rejected++; return new Response("expired", { status: 401 });
      }
    }
    if (writing && request.method === "POST" && refuseRpc) { rejected++; return new Response("refused", { status: 401 }); }
    if (writing && request.method === "POST") {
      rpc++; fs.appendFileSync(events, JSON.stringify({ kind: "rpc", at }) + "\n");
    }
    const child = Bun.spawn(["git", "http-backend"], { env: { ...f.env, GIT_PROJECT_ROOT: path.dirname(bare), GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers.get("content-type") ?? "", REMOTE_USER: "fixture", SERVER_PROTOCOL: "HTTP/1.1" },
      stdin: request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : undefined, stdout: "pipe", stderr: "pipe" });
    const [bytes, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(stderr);
    const output = Buffer.from(bytes), split = output.indexOf("\r\n\r\n");
    const headers = new Headers(); let status = 200;
    for (const line of output.subarray(0, split).toString().split("\r\n")) {
      const colon = line.indexOf(":");
      if (line.slice(0, colon).toLowerCase() === "status") status = Number(line.slice(colon + 1).trim().split(" ")[0]);
      else headers.set(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    return new Response(output.subarray(split + 4), { status, headers });
  } });
  const remote = `http://127.0.0.1:${server.port}/remote.git`;
  f.git("remote", "add", "origin", remote);
  return { remote, bare, events: () => fs.readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as {kind:string;at:number}),
    rpc: () => rpc, rejected: () => rejected, refuseRpc: () => { refuseRpc = true; }, close: () => server.stop(true) };
}

nativeTest("a first cold native publication completes one check phase before one gated push", async () => {
  const f = nativeFixture(), http = await httpFixture(f, false), previous = loadPipelines();
  try {
    const subject = pipelineCorpus(2, 1)[1]!;
    Object.assign(subject, { project: "fixture", repoDir: path.join(path.dirname(f.dir), "source"), worktreeDir: f.dir, lastPassedCommit: f.head });
    subject.delivery = { target: { repository: "repo-fixture", remote: http.remote, branch: "refs/heads/main" },
      disposition: "owner", publish: "enabled", active: true, ownerId: subject.id, epoch: 1, journal: [] };
    savePipelines([subject]);
    let pushes = 0;
    const exec: ExecPort = (command, args, cwd, overrides, options) => {
      if (command === "git" && args[0] === "push") {
        pushes++;
        expect(readPublicationCheckReceipt(overrides!.LLV_GATE_PUBLICATION_RECEIPT!, publicationCheckBinding(overrides!)).inputs).toMatch(/^[a-f0-9]{64}$/);
        expect(touchedChecks(f)).toHaveLength(1);
      }
      return realExec(command, args, cwd, { ...f.env, ...overrides }, options);
    };
    expect(await publishPipelineBranch(subject, exec, { acceptedSha: f.head })).toMatchObject({ ok: true, sha: f.head, remote: "published" });
    expect(pushes).toBe(1); expect(http.rpc()).toBe(1); expect(http.rejected()).toBe(0);
    expect(f.calls().filter(call => call.args[0] === "native-install")).toHaveLength(1);
    expect(touchedChecks(f)).toHaveLength(1);
    expect(spawnSync("git", ["--git-dir", http.bare, "rev-parse", "refs/heads/main"], { env: f.env, encoding: "utf8" }).stdout.trim()).toBe(f.head);
  } finally { savePipelines(previous); http.close(); }
}, 120_000);

test.each(["active", "expired"] as const)("native Git expires its discovered password across checks; the fenced publisher checks before mint and publishes once (%s enclosing deadline)", async (enclosing) => {
  // Red control exercises exactly the old native ordering.
  const red = fixture(), redHttp = await httpFixture(red);
  const enclosingDeadline = process.env.LLV_GATE_PUSH_DEADLINE;
  process.env.LLV_GATE_PUSH_DEADLINE = enclosing === "active" ? String(Date.UTC(2100, 0, 1)) : "1";
  try {
    // realExec merges its overrides over process.env. Explicitly clear the
    // enclosing publication's deadline so this fixture owns its own budget,
    // including when that caller spent longer than its deadline in admission.
    const env = { ...red.env, LLV_GATE_PUBLICATION_RECEIPT: undefined, LLV_GATE_PUSH_DEADLINE: undefined };
    const result = await realExec("git", ["push", redHttp.remote, `${red.head}:refs/heads/main`], red.dir, env, { timeoutMs: 60_000 });
    expect(result.code, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("401");
    expect(redHttp.events().filter(e => ["mint", "checks"].includes(e.kind)).map(e => e.kind)).toEqual(["mint", "checks"]);
    expect(redHttp.rejected()).toBeGreaterThan(0); expect(redHttp.rpc()).toBe(0);
    expect(spawnSync("git", ["--git-dir", redHttp.bare, "rev-parse", "--verify", "refs/heads/main"], { env: red.env }).status).not.toBe(0);
  } finally {
    if (enclosingDeadline === undefined) delete process.env.LLV_GATE_PUSH_DEADLINE;
    else process.env.LLV_GATE_PUSH_DEADLINE = enclosingDeadline;
    redHttp.close();
  }
  const f = fixture(), http = await httpFixture(f);
  const previous = loadPipelines();
  try {
    const subject = pipelineCorpus(2, 1)[1]!;
    Object.assign(subject, { project: "fixture", repoDir: path.join(path.dirname(f.dir), "source"), worktreeDir: f.dir, lastPassedCommit: f.head });
    subject.delivery = { target: { repository: "repo-fixture", remote: http.remote, branch: "refs/heads/main" },
      disposition: "owner", publish: "enabled", active: true, ownerId: subject.id, epoch: 1, journal: [] };
    savePipelines([subject]);
    const commands: string[] = [];
    const exec: ExecPort = (command, args, cwd, overrides, options) => {
      commands.push([command, ...args].join(" "));
      return realExec(command, args, cwd, { ...f.env, ...overrides }, options);
    };
    const result = await publishPipelineBranch(subject, exec, { acceptedSha: f.head });
    expect(result).toMatchObject({ ok: true, sha: f.head, remote: "published" });
    expect(http.events().map(event => event.kind)).toEqual(["checks", "mint", "rpc"]);
    expect(http.events().filter(event => event.kind === "checks")).toHaveLength(1);
    expect(http.rpc()).toBe(1); expect(http.rejected()).toBe(0);
    expect(commands.filter(command => command.startsWith("git push "))).toHaveLength(1);
    expect(findPipelineRecord(subject.id)!.delivery!.operation!.state).toBe("settled");
    expect(await publishPipelineBranch(findPipelineRecord(subject.id)!, exec, { acceptedSha: f.head })).toMatchObject({ ok: true, remote: "published" });
    expect(http.rpc()).toBe(1);
  } finally { savePipelines(previous); http.close(); }
}, 150_000);

for (const capability of ["absent", "unsupported", "malformed"] as const) {
  test(`a gate with ${capability} preparation capability keeps one ordinary gated push`, async () => {
    const f = fixture();
    delete f.env.LLV_GATE_PUBLICATION_RECEIPT;
    const marker = path.join(f.dir, "scripts/local-gate-capabilities.json");
    if (capability === "absent") fs.rmSync(marker);
    else fs.writeFileSync(marker, capability === "unsupported" ? '{"publicationPrepare":2}' : '{');
    // The native entry point retains the ordinary pre-push protocol. In
    // particular, nothing may try its unknown --publication-prepare argument.
    f.git("-c", "core.hooksPath=/dev/null", "add", "scripts/local-gate-capabilities.json", "scripts/local-gate.ts");
    f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "legacy gate capability");
    const http = await httpFixture(f, false), previous = loadPipelines();
    try {
      const subject = pipelineCorpus(2, 1)[1]!;
      Object.assign(subject, { project: "fixture", repoDir: path.join(path.dirname(f.dir), "source"), worktreeDir: f.dir, lastPassedCommit: f.head });
      subject.delivery = { target: { repository: "repo-fixture", remote: http.remote, branch: "refs/heads/main" },
        disposition: "owner", publish: "enabled", active: true, ownerId: subject.id, epoch: 1, journal: [] };
      savePipelines([subject]);
      let preparations = 0, pushes = 0;
      const exec: ExecPort = (command, args, cwd, env, options) => {
        if (command === "bun" && args.includes("--publication-prepare")) preparations++;
        if (command === "git" && args[0] === "push") {
          pushes++;
          expect(env?.LLV_GATE_PUBLICATION_RECEIPT).toBeUndefined();
        }
        return realExec(command, args, cwd, { ...f.env, ...env }, options);
      };
      expect(await publishPipelineBranch(subject, exec, { acceptedSha: f.head })).toMatchObject({ ok: true, remote: "published" });
      expect(preparations).toBe(0); expect(pushes).toBe(1); expect(http.rpc()).toBe(1);
      expect(http.events().map(event => event.kind)).toEqual(["mint", "checks", "rpc"]);
      expect(spawnSync("git", ["--git-dir", http.bare, "rev-parse", "refs/heads/main"], { env: f.env, encoding: "utf8" }).stdout.trim()).toBe(f.head);
    } finally { savePipelines(previous); http.close(); }
  }, 90_000);
}

test("an overrun in the transport hook ends with its deadline verdict before Git's pack timeout", async () => {
  const f = fixture();
  const clock = path.join(f.dir, ".git", "transport-clock");
  const preload = path.join(f.dir, ".git", "transport-clock.ts");
  fs.writeFileSync(clock, String(Date.now()));
  fs.writeFileSync(preload, `import fs from "node:fs"; Date.now = () => Number(fs.readFileSync(${JSON.stringify(clock)}, "utf8"));`);
  f.env.HOOK_CLOCK = preload;
  // Advance the hook's clock past its deadline during the fresh privacy
  // observation. No elapsed-time sleeps or transport-kill races are needed.
  fs.appendFileSync(path.join(f.dir, "record.ts"), `\nif (process.argv[2] === "scripts/privacy-publication-gate.ts" && process.env.LLV_GATE_PUBLICATION_OBSERVED) require("node:fs").writeFileSync(${JSON.stringify(clock)}, String(Number(process.env.LLV_GATE_PUSH_DEADLINE) + 1));\n`);
  const http = await httpFixture(f), previous = loadPipelines();
  try {
    const subject = pipelineCorpus(2, 1)[1]!;
    Object.assign(subject, { project: "fixture", repoDir: path.join(path.dirname(f.dir), "source"), worktreeDir: f.dir, lastPassedCommit: f.head });
    subject.delivery = { target: { repository: "repo-fixture", remote: http.remote, branch: "refs/heads/main" },
      disposition: "owner", publish: "enabled", active: true, ownerId: subject.id, epoch: 1, journal: [] };
    savePipelines([subject]);
    let pushes = 0;
    const exec: ExecPort = (command, args, cwd, env, options) => {
      if (command === "git" && args[0] === "push") {
        pushes++;
        expect(options?.timeoutMs).toBe(PUBLICATION_TRANSPORT_MS + PUBLICATION_PACK_MARGIN_MS);
        expect(Number(env?.LLV_GATE_PUSH_DEADLINE)).toBeLessThanOrEqual(Date.now() + PUBLICATION_TRANSPORT_MS);
      }
      return realExec(command, args, cwd, { ...f.env, ...env }, options);
    };
    const result = await publishPipelineBranch(subject, exec, { acceptedSha: f.head });
    expect(result).toMatchObject({ ok: false, failure: { code: 1, retryableDeadline: true, hookStoppedCheck: "publication input validation" } });
    expect(result).not.toHaveProperty("uncertain");
    expect(findPipelineRecord(subject.id)!.delivery!.operation!.state).toBe("settled");
    expect(http.events().map(event => event.kind)).toEqual(["checks", "mint"]);
    expect(pushes).toBe(1); expect(http.rpc()).toBe(0);
  } finally { savePipelines(previous); http.close(); }
}, 90_000);

for (const change of ["pause", "epoch", "owner", "head", "authentication", "lost-reply"] as const) {
  test(`prepared publication preserves custody and reconciliation on ${change}`, async () => {
    const f = fixture(), http = await httpFixture(f);
    const previous = loadPipelines();
    try {
      const subject = pipelineCorpus(2, 1)[1]!;
      Object.assign(subject, { project: "fixture", repoDir: path.join(path.dirname(f.dir), "source"), worktreeDir: f.dir, lastPassedCommit: f.head });
      subject.delivery = { target: { repository: "repo-fixture", remote: http.remote, branch: "refs/heads/main" },
        disposition: "owner", publish: "enabled", active: true, ownerId: subject.id, epoch: 1, journal: [] };
      savePipelines([subject]);
      if (change === "authentication") http.refuseRpc();
      let pushes = 0;
      const exec: ExecPort = async (command, args, cwd, overrides, options) => {
        if (command === "git" && args[0] === "push") pushes++;
        const result = await realExec(command, args, cwd, { ...f.env, ...overrides }, options);
        if (command === "bun" && args[2] === "--publication-prepare" && result.code === 0) {
          const current = findPipelineRecord(subject.id)!;
          if (change === "pause") current.state = "paused";
          if (change === "epoch") { current.delivery!.epoch++; current.delivery!.operation!.epoch++; }
          if (change === "owner") { current.delivery!.ownerId = "other-owner"; current.delivery!.active = false; current.delivery!.disposition = "comparison"; current.delivery!.publish = "disabled"; }
          if (change === "head") f.git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "moved head");
          if (["pause", "epoch", "owner"].includes(change)) savePipelines([current]);
        }
        if (change === "lost-reply" && command === "git" && args[0] === "push" && result.code === 0) return { code: null, stdout: "", stderr: "reply lost" };
        return result;
      };
      const result = await publishPipelineBranch(subject, exec, { acceptedSha: f.head });
      if (change === "lost-reply") {
        expect(result).toMatchObject({ ok: true, remote: "unreachable", uncertain: true });
        expect(http.rpc()).toBe(1);
        // A fresh controller process reads the durable operation and reconciles
        // the already-written remote without another transport or credential.
        const childSource = path.join(f.dir, ".git", "recover.ts");
        fs.writeFileSync(childSource, `import { reconcilePipelinePublication } from ${JSON.stringify(path.join(root, "src/lib/pipelines/git.ts"))};
          import { realExec } from ${JSON.stringify(path.join(root, "src/lib/workflows/provision.ts"))};
          const result = await reconcilePipelinePublication(${JSON.stringify(subject.id)}, 1, realExec);
          if (result !== null) throw new Error(String(result));`);
        const child = await realExec(process.execPath, [childSource], root, { ...f.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR }, { timeoutMs: 30_000 });
        expect(child.code, child.stderr).toBe(0);
        expect(findPipelineRecord(subject.id)!.publishedCommit).toBe(f.head);
      } else {
        expect(result.ok).toBeFalse();
        expect(http.rpc()).toBe(0);
        if (change === "authentication") {
          expect(result.ok ? undefined : result.failure?.retryableApp403).not.toBeTrue();
          expect(http.rejected()).toBeGreaterThan(0); expect(pushes).toBe(1);
          expect(findPipelineRecord(subject.id)!.publishedCommit).not.toBe(f.head);
        } else expect(pushes).toBe(0);
      }
      expect(http.events().filter(event => event.kind === "checks")).toHaveLength(1);
    } finally { savePipelines(previous); http.close(); }
  }, 90_000);
}
