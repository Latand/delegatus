import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createPublicationFixtures } from "./publicationHook.fixture";
import { executedPaths } from "./ci-platform-scope";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const nativeTest = test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch));
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const { fixture, commitFixtureInputs } = createPublicationFixtures(root, roots);

for (const setting of ["LLV_PRIVACY_KNOWN_VALUES_FILE", "LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE"] as const) {
  test.each(["missing", "unreadable", "directory"])("a configured " + setting + " that is %s refuses before scanning", kind => {
    const f = fixture();
    const source = path.join(f.dir, ".git", "catalog");
    f.env[setting] = source;
    if (kind === "directory") fs.mkdirSync(source);
    if (kind === "unreadable") fs.writeFileSync(source, "synthetic catalog\n", { mode: 0o000 });
    const prepared = f.run(true);
    expect(prepared.status, prepared.stderr).not.toBe(0);
    expect(prepared.stderr).toContain(`${kind === "missing" ? "configured source is missing" : "cannot read configured source"}: ${setting}`);
    expect(fs.existsSync(f.env.HOOK_LOG!)).toBeFalse();
    expect(fs.existsSync(f.receipt)).toBeFalse();
    if (kind === "missing") fs.writeFileSync(source, "synthetic catalog\n");
    expect(f.run(false).status).not.toBe(0);
    expect(fs.existsSync(f.env.HOOK_LOG!)).toBeFalse();
  }, 60_000);
}

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

test("the real scanner starts from the sealed checkout with its decoder dependency", () => {
  const f = fixture();
  for (const file of executedPaths(root, ["scripts/privacy-publication-gate.ts"])) {
    const source = path.join(root, file);
    if (!fs.lstatSync(source, { throwIfNoEntry: false })?.isFile()) continue;
    const destination = path.join(f.dir, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  const shim = path.join(f.dir, "shims", "bun");
  fs.writeFileSync(shim, fs.readFileSync(shim, "utf8").replace("#!/bin/bash\n",
    '#!/bin/bash\nif [[ "$1" == scripts/privacy-publication-gate.ts ]]; then exec "$HOOK_BUN" "$@"; fi\n'));
  commitFixtureInputs(f);
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  fs.writeFileSync(path.join(f.dir, "release.md"), "Sealed publication fixture.\n");
  commitFixtureInputs(f);
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).toBe(0);
  expect(prepared.stderr).toContain("PRIVACY GATE: PASS");
  expect(f.run(false).status).toBe(0);
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
    expect(transported.stderr).toContain("publication inputs changed during transport; changed components: privacy files");
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
  expect(staleHook.stderr).toContain("publication inputs changed during transport; changed components: privacy files");
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
  expect(transported.stderr).toContain("publication inputs changed during transport; changed components: privacy files (LLV_PRIVACY_KNOWN_VALUES_FILE)");
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
  expect(transported.stderr).toContain("publication inputs changed during transport; changed components: privacy files (LLV_PRIVACY_KNOWN_VALUES_FILE)");
  expect(f.calls()).toHaveLength(before);
  expect(fs.existsSync(f.receipt)).toBeFalse();
}, 60_000);

test.each(["normal write", "metadata change"])("a scanner-side %s cannot certify changed snapshot bytes", kind => {
  const f = fixture();
  const known = path.join(f.dir, ".git", "known-values.txt");
  f.env.LLV_PRIVACY_KNOWN_VALUES_FILE = known;
  fs.writeFileSync(known, "first synthetic catalog entry\n");
  fs.appendFileSync(path.join(f.dir, "record.ts"), `
    if (process.argv[2] === "scripts/privacy-publication-gate.ts") {
      const fs = require("node:fs");
      const file = process.env.LLV_PRIVACY_KNOWN_VALUES_FILE!;
      const observed = path.join(path.dirname(process.env.HOOK_LOG!), "snapshot-observation");
      const original = fs.readFileSync(file);
      let result = "writable";
      try { fs.writeFileSync(file, original); } catch (error) { result = error.code; }
      const directoryMode = fs.statSync(path.dirname(file)).mode & 0o777;
      fs.writeFileSync(observed, result + " " + directoryMode.toString(8));
      if (${JSON.stringify(kind)} === "metadata change") {
        fs.chmodSync(file, 0o600);
        fs.writeFileSync(file, original);
        fs.chmodSync(file, 0o400);
      }
      console.log("PRIVACY GATE: PASS");
    }
  `);
  commitFixtureInputs(f);
  const prepared = f.run(true);
  expect(fs.readFileSync(path.join(f.dir, ".git", "snapshot-observation"), "utf8")).toBe("EACCES 500");
  expect(prepared.stderr).toContain("PRIVACY GATE: PASS");
  if (kind === "normal write") {
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(f.run(false).status).toBe(0);
  } else {
    expect(prepared.status, prepared.stderr).not.toBe(0);
    expect(prepared.stderr).toContain("publication inputs changed during checks; changed components: privacy scan");
    expect(fs.existsSync(f.receipt)).toBeFalse();
    expect(f.run(false).status).not.toBe(0);
  }
  expect(fs.readFileSync(known, "utf8")).toBe("first synthetic catalog entry\n");
}, 60_000);

test.each(["overlay", "configured user attributes"])("the scanner reads captured %s and transport refuses a later change", kind => {
  const f = fixture();
  const attributes = kind === "overlay" ? path.join(f.dir, ".git", "info", "attributes") : path.join(f.dir, ".git", "user-attributes");
  f.git("config", "core.ignoreCase", "true");
  fs.writeFileSync(attributes, "EXAMPLE.ts diff=fixture\n");
  if (kind !== "overlay") f.git("config", "core.attributesFile", attributes);
  fs.appendFileSync(path.join(f.dir, "record.ts"), `
    if (process.argv[2] === "scripts/privacy-publication-gate.ts") {
      const fs = require("node:fs");
      const actual = execFileSync("git", ["check-attr", "diff", "--", "example.ts"], { encoding: "utf8" });
      fs.writeFileSync(path.join(path.dirname(process.env.HOOK_LOG!), "attribute-observation"), actual);
    }
  `);
  commitFixtureInputs(f);
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).toBe(0);
  expect(fs.readFileSync(path.join(f.dir, ".git", "attribute-observation"), "utf8")).toBe("example.ts: diff: fixture\n");
  fs.writeFileSync(attributes, "EXAMPLE.ts diff=updated\n");
  const before = f.calls().length;
  const transported = f.run(false);
  expect(transported.status, transported.stderr).not.toBe(0);
  expect(transported.stderr).toContain("publication inputs changed during transport; changed components: privacy " + (kind === "overlay" ? "attribute overlay" : "user attributes"));
  expect(f.calls()).toHaveLength(before);
  expect(fs.existsSync(f.receipt)).toBeFalse();
}, 60_000);
