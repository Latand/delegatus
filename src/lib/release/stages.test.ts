import { expect, test } from "bun:test";
import { releaseStages } from "./stages";
import { normalizeStages } from "@/lib/pipelines/engine";
import { pipelineRoleLookup, resolvePipelineRole } from "@/lib/pipelines/roles";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_STAGE_PROMPT_LENGTH } from "@/lib/pipelines/limits";
test.each([true, false])("release template validates with askBeforePublish=%s; reviews precede publishing", askBeforePublish => {
  const stages = releaseStages({ cut: "one", lastTag: "v1.0.0", changes: [], askBeforePublish, approval: "recorded approval" });
  const normalized = normalizeStages(stages, pipelineRoleLookup);
  expect(normalized.error).toBeUndefined();
  expect(stages.map(s => s.id)).toEqual(["prepare", "capture", "shots", "shots-fix", "review", "fix", "publish"]);
  expect(stages.find(s => s.id === "shots")?.onFail).toEqual({ to: "shots-fix", maxRounds: 1, onExhausted: "advance" });
  expect(stages.find(s => s.id === "review")?.onFail).toEqual({ to: "fix", maxRounds: 1, onExhausted: "advance" });
  expect(stages.at(-1)?.role?.roleId).toBe("deployer");
  expect(resolvePipelineRole({ role: { roleId: "deployer" } }, "run").error).toContain("not allowed");
});
test("a large release validates and its structured Git reference retains every PR and changed path at the exact cut", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-range-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    const changes = Array.from({ length: 112 }, (_, index) => ({
      subject: `Improve retained release history and recovery (#${3000 + index})`,
      files: Array.from({ length: 12 }, (_, part) => `${index < 86 ? "src" : "docs"}/features/retained-history-${index}/release-component-${part}.ts`),
    }));
    const commits = [{ subject: "Base", files: ["base.txt"] }, ...changes,
      { subject: "Future change (#9999)", files: ["future.ts"] }];
    let stream = "blob\nmark :1\ndata 1\nx\n";
    commits.forEach((change, index) => {
      stream += `commit refs/heads/main\nmark :${index + 10}\ncommitter Fixture <fixture> ${1_700_000_000 + index} +0000\ndata ${Buffer.byteLength(change.subject)}\n${change.subject}\n`;
      if (index) stream += `from :${index + 9}\n`;
      if (index === 3) stream += "merge :10\n";
      stream += change.files.map(file => `M 100644 :1 ${file}\n`).join("") + "\n";
    });
    const imported = spawnSync("git", ["fast-import", "--quiet"], { cwd: directory, input: stream, encoding: "utf8", timeout: 15_000 });
    expect(imported.status, imported.stderr).toBe(0);
    const cut = git("rev-parse", "HEAD^");
    git("tag", "v1.16.0", git("rev-list", "--max-parents=0", "HEAD"));
    expect(git("rev-list", "--count", "--merges", `v1.16.0..${cut}`)).toBe("1");
    const stages = releaseStages({ cut, lastTag: "v1.16.0", changes, askBeforePublish: true });
    expect(normalizeStages(stages, pipelineRoleLookup).error).toBeUndefined();
    expect(stages.every(stage => stage.prompt!.length <= MAX_STAGE_PROMPT_LENGTH)).toBe(true);
    const { range } = JSON.parse(stages[0].prompt!.split("\n").at(-1)!);
    expect({ from: range.from, cut: range.cut }).toEqual({ from: "v1.16.0", cut });
    const [command, ...args] = range.command;
    const fullRange = execFileSync(command, args, { cwd: directory, encoding: "utf8" });
    const lines = fullRange.split("\n"), paths = new Set(lines);
    expect(lines.filter(line => /^[a-f0-9]{40} /.test(line)).map(line => line.slice(41))).toEqual([...changes].reverse().map(change => change.subject));
    for (const change of changes) {
      for (const file of change.files) expect(paths.has(file)).toBe(true);
    }
    expect(paths.has("future.ts")).toBe(false);
    const larger = releaseStages({ cut, lastTag: "v1.16.0", changes: Array.from({ length: 10_000 }, () => changes[0]), askBeforePublish: true });
    expect(normalizeStages(larger, pipelineRoleLookup).error).toBeUndefined();
    expect(larger[0].prompt!.length).toBe(stages[0].prompt!.length);
    git("tag", "-d", "v1.16.0");
    expect(spawnSync(command, args, { cwd: directory, encoding: "utf8" }).status).not.toBe(0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
