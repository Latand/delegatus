import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkExecutionSettings, setCheckExecution } from "./cloud-check-settings";

test("project defaults to Cloud, lane overrides and inheritance persist", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-settings-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    expect(await checkExecutionSettings(root, "lane")).toEqual({ project: "cloud", override: null, effective: "cloud" });
    await setCheckExecution(root, "local");
    expect((await checkExecutionSettings(root, "lane")).effective).toBe("local");
    await setCheckExecution(root, "cloud", "lane");
    expect((await checkExecutionSettings(root, "lane")).effective).toBe("cloud");
    expect((await checkExecutionSettings(root, "other")).effective).toBe("local");
    await setCheckExecution(root, null, "lane");
    expect((await checkExecutionSettings(root, "lane")).effective).toBe("local");
    await expect(setCheckExecution(root, "invalid" as "cloud")).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stage choices survive a new process and inherit lane and project defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-stage-settings-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    await setCheckExecution(root, "local");
    await setCheckExecution(root, "cloud", "lane");
    await setCheckExecution(root, "local", "lane", "verify");
    const restarted = JSON.parse(execFileSync(process.execPath, ["-e",
      'import { checkExecutionSettings } from "./scripts/cloud-check-settings"; console.log(JSON.stringify(await checkExecutionSettings(process.argv[1], "lane", "verify")))', root], { cwd: process.cwd(), encoding: "utf8" }));
    expect(restarted).toEqual({ project: "local", override: "cloud", stageOverride: "local", effective: "local" });
    expect((await checkExecutionSettings(root, "other", "verify")).effective).toBe("local");
    expect((await checkExecutionSettings(root, "lane", "build")).effective).toBe("cloud");
    await setCheckExecution(root, null, "lane", "verify");
    expect((await checkExecutionSettings(root, "lane", "verify")).effective).toBe("cloud");
    await setCheckExecution(root, null, "lane");
    expect((await checkExecutionSettings(root, "lane", "verify")).effective).toBe("local");
    await expect(setCheckExecution(root, "cloud", undefined, "verify")).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid stored choices and refused writes never become defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-settings-errors-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["config", "--local", "delegatus.checks", "constructor"], { cwd: root });
    await expect(checkExecutionSettings(root)).rejects.toThrow("Invalid check execution setting");
    await setCheckExecution(root, "cloud");
    const lock = join(root, ".git/config.lock");
    writeFileSync(lock, "owned test lock");
    await expect(setCheckExecution(root, "local")).rejects.toThrow("Cannot access check execution setting");
    unlinkSync(lock);
    expect((await checkExecutionSettings(root)).effective).toBe("cloud");
    await expect(checkExecutionSettings(join(root, "missing"))).rejects.toThrow("Cannot access check execution setting");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
