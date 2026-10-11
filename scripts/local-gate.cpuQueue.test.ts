import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "./local-gate";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("isolated heavy checks resolve the same machine CPU queue as their caller", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cpu-routing-")); directories.push(dir);
  const inherited = { ...process.env };
  delete inherited.LLV_GATE_LOCK_DIR;
  const isolated = isolatedEnvironment(dir, inherited);
  // Compare only digests: the machine home never belongs in test output.
  const script = 'import { createHash } from "node:crypto"; import { cpuAdmissionFile } from "./src/lib/runtime/cpuAdmission"; console.log(createHash("sha256").update(cpuAdmissionFile()).digest("hex"));';
  const queue = (env: NodeJS.ProcessEnv) => execFileSync(process.execPath, ["-e", script], { cwd: path.resolve(import.meta.dir, ".."), env, encoding: "utf8" }).trim();
  expect(queue(isolated)).toBe(queue(inherited));
  expect(isolated.LLV_GATE_LOCK_DIR).toBeUndefined();
  const privateEnv = { ...inherited, LLV_GATE_LOCK_DIR: dir };
  expect(queue(isolatedEnvironment(dir, privateEnv))).toBe(queue(privateEnv));
});
