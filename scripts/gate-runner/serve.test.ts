// destructive-code: fixed typed seam, fake trees, head-only.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterInstallAction } from "./serve";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
test("after-install actions append within their tree and refuse traversal, absolute paths, symlinks and shell text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-action-test-")); roots.push(root);
  const tree = path.join(root, "tree"); fs.mkdirSync(tree);
  fs.writeFileSync(tree + "/README.md", "before");
  afterInstallAction(root, tree, JSON.stringify({ append: { file: "README.md", text: "after" } }));
  expect(fs.readFileSync(tree + "/README.md", "utf8")).toBe("beforeafter");
  const marker = root + "/must-not-exist";
  const old = process.env.LLV_GATE_RUNNER_TEST_AFTER_INSTALL;
  process.env.LLV_GATE_RUNNER_TEST_AFTER_INSTALL = `touch '${marker}'`;
  try { afterInstallAction(root, tree, undefined); } finally { if (old === undefined) delete process.env.LLV_GATE_RUNNER_TEST_AFTER_INSTALL; else process.env.LLV_GATE_RUNNER_TEST_AFTER_INSTALL = old; }
  expect(fs.existsSync(marker)).toBeFalse();
  fs.symlinkSync(root, tree + "/link");
  for (const file of ["../must-not-exist", marker, "link/must-not-exist", "missing/file"]) expect(() => afterInstallAction(root, tree, JSON.stringify({ append: { file, text: "bad" } }))).toThrow("invalid after-install");
  for (const value of [JSON.stringify("touch " + marker), JSON.stringify({ shell: "touch " + marker }), JSON.stringify({ append: { file: "README.md", text: "bad", shell: "extra" } })]) expect(() => afterInstallAction(root, tree, value)).toThrow("invalid after-install");
  expect(fs.existsSync(marker)).toBeFalse();
});
