import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compareErrors, diagnosticMessage, lintChanges, type LintSite } from "./eslint-changes";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync("/var/tmp/eslint-changes-"); roots.push(root);
  const env = { ...process.env, LLV_SKIP_HOOKS: "1", GIT_AUTHOR_NAME: "Tool", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "Tool", GIT_COMMITTER_EMAIL: "noreply@example.invalid" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !key.startsWith("GIT_AUTHOR_") && !key.startsWith("GIT_COMMITTER_")) delete env[key as keyof typeof env];
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "core.hooksPath", "/dev/null");
  writeFileSync(path.join(root, "eslint.config.mjs"), 'export default [{ rules: { "no-unused-vars": "error", "no-undef": "error", "no-debugger": "warn" } }];\n');
  writeFileSync(path.join(root, "old.js"), "function example() { const old = 1; } example();\n");
  git("add", "."); git("commit", "-qm", "Baseline");
  return { root, base: git("rev-parse", "HEAD"), write: (file: string, contents: string) => writeFileSync(path.join(root, file), contents) };
}

test("unchanged old errors pass", async () => {
  const f = fixture(); const result = await lintChanges(f.root, f.base, ["old.js"]);
  expect(result.baseErrors).toBe(1); expect(result.introduced).toEqual([]);
});
test("one more occurrence of the same rule/message fails", async () => {
  const f = fixture(); f.write("old.js", "function example() { const old = 1; } example();\nfunction other() { const old = 2; } other();\n");
  const result = await lintChanges(f.root, f.base, ["old.js"]);
  expect(result.introduced.map(site => [site.ruleId, site.line])).toEqual([["no-unused-vars", 2]]);
});
test("a new rule in an old file fails", async () => {
  const f = fixture(); f.write("old.js", "function example() { const old = 1; } example();\nmissing();\n");
  expect((await lintChanges(f.root, f.base, ["old.js"])).introduced[0]?.ruleId).toBe("no-undef");
});
test("a new file has no baseline allowance and cannot borrow another file's errors", async () => {
  const f = fixture(); f.write("new.js", "function example() { const old = 1; } example();\n");
  const result = await lintChanges(f.root, f.base, ["old.js", "new.js"]);
  expect(result.introduced.map(site => site.file)).toEqual(["new.js"]);
});
test("errors that only moved lines pass, and warnings do not block", async () => {
  const f = fixture(); f.write("old.js", "\n\nfunction example() { const old = 1; } example(); debugger;\n");
  const result = await lintChanges(f.root, f.base, ["old.js"]);
  expect(result.baseErrors).toBe(1); expect(result.introduced).toEqual([]);
});
test("a deleted file is ignored without linting the checkout", async () => {
  const f = fixture(); rmSync(path.join(f.root, "old.js")); f.write("unselected.js", "missing();\n");
  expect(await lintChanges(f.root, f.base, ["old.js"])).toEqual({ introduced: [], baseErrors: 0 });
});
test("missing base and ESLint config crashes fail closed", async () => {
  const f = fixture();
  await expect(lintChanges(f.root, "missing-base", ["old.js"])).rejects.toThrow();
  f.write("eslint.config.mjs", 'throw new Error("broken config");\n');
  await expect(lintChanges(f.root, f.base, ["old.js"])).rejects.toThrow("broken config");
});
test("React compiler codeframes do not key on source lines or surrounding edits", () => {
  const message = (line: number, context: string) => `Error: Cannot access refs during render\n\nExplanation.\n\n/source/board.tsx:${line}:3\n  ${line - 1} | ${context}\n> ${line} | ref.current = value;\n      |   ^^^^^^^^^^^ Cannot update ref during render\n  ${line + 1} | next();`;
  const site = (text: string, line: number): LintSite => ({ file: "board.tsx", severity: 2, ruleId: "react-hooks/refs", message: text, line, column: 3 });
  expect(diagnosticMessage(message(10, "before();"))).toBe(diagnosticMessage(message(20, "changed();")));
  expect(compareErrors([site(message(10, "before();"), 10)], [site(message(20, "changed();"), 20)]).introduced).toEqual([]);
  expect(compareErrors([site(message(10, "before();"), 10)], [site(message(20, "changed();"), 20), site(message(30, "another();"), 30)]).introduced).toHaveLength(1);
});
test("an elided codeframe keys the same when its span crosses line 1000", () => {
  const gutter = (n: number, width: number) => String(n).padStart(width);
  const message = (start: number) => {
    const end = start + 40; const width = String(end).length; const pad = " ".repeat(width);
    return `Error: Cannot access variable before it is declared\n\n\`move\` is accessed before it is declared.\n\n/source/board.tsx:${start}:3\n> ${gutter(start, width)} | const move = useCallback(() => {\n  ${pad} | ^^^^^^^^^^^^^^^^\n  ${pad} …\n  ${pad} | ^^^^ \`move\` is declared here\n> ${gutter(end, width)} | }, []);`;
  };
  const site = (start: number): LintSite => ({ file: "board.tsx", severity: 2, ruleId: "react-hooks/immutability", message: message(start), line: start, column: 3 });
  expect(message(949)).toContain("\n      …");
  expect(message(963)).toContain("\n       …");
  expect(compareErrors([site(949)], [site(963)]).introduced).toEqual([]);
});


test("a clean head skips every base read, even when the base is unavailable", async () => {
  const f = fixture(); f.write("old.js", "export const used = 1;\n");
  expect(await lintChanges(f.root, "unavailable-base", ["old.js"])).toEqual({ introduced: [], baseErrors: 0 });
});
test("only files with head errors borrow their own baseline diagnostics", async () => {
  const f = fixture();
  f.write("clean.js", "const old = 1;\n");
  execFileSync("git", ["add", "clean.js"], { cwd: f.root });
  execFileSync("git", ["-c", "user.name=Tool", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "Second baseline"], { cwd: f.root });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.root, encoding: "utf8" }).trim();
  f.write("clean.js", "export const used = 1;\n");
  const result = await lintChanges(f.root, base, ["old.js", "clean.js"]);
  expect(result.introduced).toEqual([]); expect(result.baseErrors).toBe(1);
});


test("native content cache survives processes and invalidates edits, configuration and dependency inputs", () => {
  const f = fixture();
  const marker = path.join(f.root, "calls.log");
  const config = (extra = "") => `import { appendFileSync } from "node:fs";
    export default [{ plugins: { probe: { rules: { visit: { create() { return { Program() { appendFileSync(${JSON.stringify(marker)}, "visit\\n"); } }; } } } } }, rules: { "probe/visit": "error" } }]; ${extra}`;
  f.write("eslint.config.mjs", config());
  const run = () => {
    const result = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "eslint-changes.ts"), "--base", f.base, "old.js"], { cwd: f.root, env: process.env });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  const calls = () => readFileSync(marker, "utf8").trim().split("\n").length;
  run(); expect(calls()).toBe(1);
  run(); expect(calls()).toBe(1);
  f.write("old.js", "export const changed = 2;\n"); run(); expect(calls()).toBe(2);
  f.write("eslint.config.mjs", config("// changed configuration")); run(); expect(calls()).toBe(3);
  f.write("bun.lock", "changed dependency graph"); run(); expect(calls()).toBe(4);
});

test("an unavailable native cache still lints head and refuses new diagnostics", async () => {
  const f = fixture();
  mkdirSync(path.join(f.root, ".git/delegatus-gate"));
  writeFileSync(path.join(f.root, ".git/delegatus-gate/eslint"), "not a directory");
  f.write("old.js", "export const used = 1;\n");
  expect((await lintChanges(f.root, f.base, ["old.js"])).introduced).toEqual([]);
  f.write("old.js", "missing();\n");
  expect((await lintChanges(f.root, f.base, ["old.js"])).introduced.map(site => site.ruleId)).toEqual(["no-undef"]);
});
