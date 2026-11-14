import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sourceNuls } from "./source-nuls";

test("tracked sources contain no literal NUL bytes", () => {
  expect(sourceNuls(resolve(import.meta.dir, ".."))).toEqual([]);
});

test("the guard rejects a tracked NUL source and accepts its source escape", () => {
  const root = mkdtempSync(join(tmpdir(), "source-nuls-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    writeFileSync(join(root, "fixture.ts"), 'export const value = "\0";\n');
    writeFileSync(join(root, "image.png"), Buffer.from([0]));
    writeFileSync(join(root, "untracked.ts"), Buffer.from([0]));
    execFileSync("git", ["add", "fixture.ts", "image.png"], { cwd: root });
    expect(sourceNuls(root)).toEqual(["fixture.ts"]);
    const command = [process.execPath, join(import.meta.dir, "source-nuls.ts")];
    const red = Bun.spawnSync(command, { cwd: root });
    expect(red.exitCode).toBe(1);
    expect(red.stderr.toString()).toContain("fixture.ts");
    writeFileSync(join(root, "fixture.ts"), 'export const value = "\\x00";\n');
    expect(sourceNuls(root)).toEqual([]);
    expect(Bun.spawnSync(command, { cwd: root }).exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
