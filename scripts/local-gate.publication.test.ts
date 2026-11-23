import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createPublicationFixtures } from "./publicationHook.fixture";
import { snapshotPublicationPrivacyFiles } from "./local-gate";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const nativeTest = test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch));
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const { fixture, commitFixtureInputs } = createPublicationFixtures(root, roots);

test("publication scans keep the safely read privacy bytes when the source changes mid-scan", () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "privacy-snapshot-")); roots.push(directory);
  const source = path.join(directory, "known-values.json");
  const scanDirectory = path.join(directory, "scan"); fs.mkdirSync(scanDirectory);
  const original = Buffer.from('{"fingerprints":["synthetic-private-marker"]}\n');
  fs.writeFileSync(source, original);
  const captured = snapshotPublicationPrivacyFiles({ ...process.env, LLV_PRIVACY_KNOWN_VALUES_FILE: source }, scanDirectory);
  fs.writeFileSync(source, '{"fingerprints":[]}\n');
  expect(fs.readFileSync(captured.env.LLV_PRIVACY_KNOWN_VALUES_FILE!, "utf8")).toBe(original.toString("utf8"));
  expect(captured.hashes.LLV_PRIVACY_KNOWN_VALUES_FILE).toBe(createHash("sha256").update(original).digest("hex"));
});

test("a configured privacy source missing at snapshot time is refused before scanning or transport", () => {
  const f = fixture();
  const known = path.join(f.dir, ".git", "late-known-values.txt");
  f.env.LLV_PRIVACY_KNOWN_VALUES_FILE = known;
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).not.toBe(0);
  expect(prepared.stderr).toContain("configured source is missing: LLV_PRIVACY_KNOWN_VALUES_FILE");
  expect(fs.existsSync(path.join(f.dir, ".git", "commands.jsonl"))).toBeFalse();
  expect(fs.existsSync(f.receipt)).toBeFalse();
  fs.writeFileSync(known, "late synthetic privacy source\n");
  const transport = f.run(false);
  expect(transport.status, transport.stderr).not.toBe(0);
  expect(fs.existsSync(f.receipt)).toBeFalse();
});

test("prepared checks are consumed once by the native hook without a second privacy scan or admission", () => {
  const f = fixture();
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).toBe(0);
  const before = f.calls().length;
  const hook = f.run(false);
  expect(hook.status, hook.stderr).toBe(0);
  expect(f.calls().slice(before).map(call => call.args[0])).toEqual([]);
  expect(hook.stderr).not.toContain("CPU admission");
  expect(fs.existsSync(f.receipt)).toBeFalse();
  expect(f.run(false).status).not.toBe(0);
}, 60_000);

test("prepared checks reach native transport when the caller already has Git's exec path", () => {
  const f = fixture();
  const execPath = f.git("--exec-path").toString().trim();
  f.env.PATH = `${execPath}${path.delimiter}${f.env.PATH ?? ""}`;
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).toBe(0);
  const hook = f.run(false);
  expect(hook.status, hook.stderr).toBe(0);
  expect(fs.existsSync(f.receipt)).toBeFalse();
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
  if (when === "during checks") {
    expect(prepared.status, prepared.stderr).not.toBe(0);
    expect(prepared.stderr).toContain("privacy files (LLV_PRIVACY_KNOWN_VALUES_FILE)");
    expect(fs.existsSync(f.receipt)).toBeFalse();
    return;
  }
  expect(prepared.status, prepared.stderr).toBe(0);
  if (when === "before transport") {
    const writer = spawnSync(process.execPath, ["-e", refresh], { env: f.env, encoding: "utf8" });
    expect(writer.status, writer.stderr).toBe(0);
  }
  const before = f.calls().length;
  const transported = f.run(false);
  if (when === "before transport") {
    expect(transported.status, transported.stderr).not.toBe(0);
    expect(transported.stderr).toContain("publication check inputs changed; changed components: privacy files");
    expect(f.calls().slice(before)).toHaveLength(0);
  } else {
    expect(transported.status, transported.stderr).toBe(0);
    expect(fs.readFileSync(known, "utf8")).toBe("initial private phrase\n");
    expect(f.calls().slice(before).map(call => call.args[0])).toEqual([]);
  }
  expect(fs.existsSync(f.receipt)).toBeFalse();
}, 60_000);

test("privacy drift refuses its receipt while a fresh preparation reuses heavy checks", () => {
  const f = fixture();
  f.env.LLV_PRIVACY_KNOWN_VALUES_FILE = path.join(f.dir, ".git", "known-values.txt");
  fs.writeFileSync(f.env.LLV_PRIVACY_KNOWN_VALUES_FILE, "initial private phrase\n");
  const first = f.run(true);
  expect(first.status, first.stderr).toBe(0);
  expect(f.calls().some(call => call.args[0] === "tsc")).toBeTrue();
  fs.writeFileSync(f.env.LLV_PRIVACY_KNOWN_VALUES_FILE, "another private phrase\n");
  const staleHook = f.run(false);
  expect(staleHook.status).not.toBe(0);
  expect(staleHook.stderr).toContain("publication check inputs changed; changed components: privacy files");
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
  expect(transported.status, transported.stderr).not.toBe(0);
  expect(transported.stderr).toContain(change === "missing"
    ? "configured source is missing: LLV_PRIVACY_KNOWN_VALUES_FILE"
    : "publication check inputs changed; changed components: privacy files");
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

test("a known-values replacement during preparation cannot change the bytes scanned", () => {
  const f = fixture();
  const known = path.join(f.dir, ".git", "known-values.txt");
  const synthetic = "snapshot race synthetic value";
  f.env.LLV_PRIVACY_KNOWN_VALUES_FILE = known;
  f.env.HOOK_PRIVACY = path.join(root, "scripts/privacy-publication-gate.ts");
  fs.copyFileSync(path.join(root, "scripts/privacy-known-value-fingerprints.json"), path.join(f.dir, "scripts/privacy-known-value-fingerprints.json"));
  fs.writeFileSync(known, `${synthetic}\n`);
  fs.writeFileSync(path.join(f.dir, "release.md"), `${synthetic}\n`);
  const shim = path.join(f.dir, "shims", "bun");
  const source = fs.readFileSync(shim, "utf8");
  fs.writeFileSync(shim, source.replace("#!/bin/bash\n", `#!/bin/bash\nif [[ "$1" == scripts/privacy-publication-gate.ts ]]; then
    cp "$LLV_PRIVACY_KNOWN_VALUES_FILE" "$LLV_PRIVACY_KNOWN_VALUES_FILE.saved"
    printf 'catalog without the matching value\\n' > "$LLV_PRIVACY_KNOWN_VALUES_FILE"
    shift
    "$HOOK_BUN" "$HOOK_PRIVACY" "$@"
    status=$?
    mv "$LLV_PRIVACY_KNOWN_VALUES_FILE.saved" "$LLV_PRIVACY_KNOWN_VALUES_FILE"
    exit "$status"
  fi\n`));
  commitFixtureInputs(f);
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).not.toBe(0);
  expect(prepared.stderr).toContain("known_value");
  expect(fs.readFileSync(known, "utf8")).toBe(`${synthetic}\n`);
  expect(fs.existsSync(f.receipt)).toBeFalse();
}, 60_000);
