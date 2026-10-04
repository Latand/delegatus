import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
