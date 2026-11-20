import { once } from "node:events";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { expect, test, fs, path, spawn, stopFixtureProcess, loadPipelines, realWorktreeLane, finishReported, tickPipelines } from "./engine.fixture";
import { pipelineArtifactsDir } from "./store";
import { commitPipelineStage } from "./git";

const linuxTest = process.platform === "linux" ? test : test.skip;
const stages = [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }];

async function holdOpen(file: string, flag: "wx" | "r") {
  const child = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const fd = fs.openSync(process.argv[1], process.argv[2]);
    process.stdout.write(String(process.pid) + "\\n");
    process.stdin.resume();
    process.stdin.once("end", () => fs.closeSync(fd));
  `, file, flag], { stdio: ["pipe", "pipe", "inherit"] });
  try {
    const [ready] = await once(child.stdout, "data", { signal: AbortSignal.timeout(5_000) });
    const identity = captureProcessIdentity(Number(ready.toString().trim()));
    expect(identity.pid).toBe(child.pid!);
    expect(processIdentityStatus(identity)).toBe("alive");
    return { child, identity };
  } catch (error) {
    await stopFixtureProcess(child);
    throw error;
  }
}

linuxTest.each(["reset", "commit", "switch"] as const)("recovers a stale lane index lock during git %s and publishes", async operation => {
  const box = await realWorktreeLane(`index-lock-${operation}`, stages, "remote-branch");
  try {
    const { h, git, worktree, origin, id } = box;
    const lane = loadPipelines().find(row => row.id === id)!;
    const gitDir = await git(worktree, "rev-parse", "--absolute-git-dir");
    const lock = path.join(gitDir, "index.lock");
    if (operation === "switch") await git(worktree, "switch", "-c", "fix/stage-topic");
    if (operation !== "reset") fs.writeFileSync(path.join(worktree, "stage.txt"), "stage work\n");
    const execute = h.ports.exec;
    const exits: Array<number | null> = [];
    let injected = false;
    h.ports.exec = async (command, args, cwd, env, options) => {
      const target = command === "git" && cwd === worktree && args[0] === operation;
      if (target && !injected) {
        injected = true;
        const { child, identity } = await holdOpen(lock, "wx");
        const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
        try { child.stdin.end(); expect(await exited).toEqual([0, null]); }
        finally { await stopFixtureProcess(child); }
        expect(processIdentityStatus(identity)).toBe("dead");
        expect(fs.existsSync(lock)).toBe(true);
      }
      const result = await execute(command, args, cwd, env, options);
      if (target) exits.push(result.code);
      return result;
    };
    await tickPipelines([finishReported(h, "/codex/stage-1.jsonl", "pass", "Finished")], h.ports);
    const settled = loadPipelines().find(row => row.id === id)!;
    expect(settled.state).toBe("completed");
    expect(exits.slice(0, 2)).toEqual([128, 0]);
    expect(exits.filter(code => code !== 0)).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(false);
    expect(await git(worktree, "branch", "--show-current")).toBe(lane.branch);
    expect(await git(origin, "rev-parse", `refs/heads/${lane.branch}`)).toBe(settled.lastPassedCommit);
    if (operation !== "reset") expect(await git(origin, "show", `${settled.lastPassedCommit}:stage.txt`)).toBe("stage work");
    const journal = fs.readFileSync(path.join(pipelineArtifactsDir(id), "git-recovery.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(journal).toEqual([{ at: expect.any(String), operation, detail: "removed stale index.lock" }]);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

linuxTest.each([
  ["reset", "index.lock", "unstaging controller pipeline artifacts"],
  ["reset", "worktree Git directory", "unstaging controller pipeline artifacts"],
  ["commit", "index.lock", "committing the passed stage"],
  ["switch", "index.lock", "returning to the pipeline branch"],
] as const)("git %s reports the live child holding %s and preserves the lock", async (operation, held, step) => {
  const box = await realWorktreeLane(`index-lock-held-${operation}`, stages, "remote-branch");
  let holder: Awaited<ReturnType<typeof holdOpen>> | undefined;
  try {
    const { h, worktree, git, id } = box;
    const gitDir = await git(worktree, "rev-parse", "--absolute-git-dir");
    const lock = path.join(gitDir, "index.lock");
    if (operation === "switch") await git(worktree, "switch", "-c", "fix/stage-topic");
    if (operation !== "reset") fs.writeFileSync(path.join(worktree, "stage.txt"), "stage work\n");
    let index: fs.BigIntStats | undefined;
    let calls = 0;
    const execute = h.ports.exec;
    h.ports.exec = async (command, args, cwd, env, options) => {
      if (command === "git" && cwd === worktree && args[0] === operation && ++calls === 1) {
        if (held === "worktree Git directory") fs.writeFileSync(lock, "held index\n", { flag: "wx" });
        holder = await holdOpen(held === "index.lock" ? lock : gitDir, held === "index.lock" ? "wx" : "r");
        index = fs.statSync(lock, { bigint: true });
      }
      return execute(command, args, cwd, env, options);
    };
    await tickPipelines([finishReported(h, "/codex/stage-1.jsonl", "pass", "Finished")], h.ports);
    const parked = loadPipelines().find(row => row.id === id)!;
    expect(holder).toBeDefined();
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain(`${step}: index.lock recovery blocked: PID ${holder!.identity.pid} holds ${held === "index.lock" ? held : `the ${held}`}`);
    expect(calls).toBe(1);
    expect(processIdentityStatus(holder!.identity)).toBe("alive");
    expect(fs.statSync(lock, { bigint: true })).toMatchObject({ ino: index!.ino, dev: index!.dev, ctimeNs: index!.ctimeNs });
    expect(fs.existsSync(path.join(pipelineArtifactsDir(id), "git-recovery.ndjson"))).toBe(false);
  } finally {
    if (holder) await stopFixtureProcess(holder.child);
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

linuxTest.each(["foreign", "replaced", "retry"] as const)("preserves a %s lock during artifact cleanup", async mode => {
  const box = await realWorktreeLane(`index-lock-${mode}`, stages);
  try {
    const { h, worktree, git, id } = box;
    const lane = loadPipelines().find(row => row.id === id)!;
    const lock = path.join(await git(worktree, "rev-parse", "--absolute-git-dir"), "index.lock");
    fs.writeFileSync(lock, "initial lock\n", { flag: "wx" });
    let resets = 0;
    const result = await commitPipelineStage(mode === "foreign" ? { ...lane, id: "another-lane" } : lane,
      "build", true, async (command, args, cwd, env, options) => {
        if (command === "git" && cwd === worktree && args[0] === "reset") {
          resets++;
          if (mode === "retry" && resets === 2) fs.writeFileSync(lock, "second lock\n", { flag: "wx" });
        }
        if (mode === "replaced" && args.includes("--git-path") && args.at(-1) === "index" && resets === 1) {
          fs.writeFileSync(`${lock}.next`, "second lock\n", { flag: "wx" });
          fs.renameSync(`${lock}.next`, lock);
        }
        return h.ports.exec(command, args, cwd, env, options);
      });
    const errors = { foreign: "worktree ownership could not be verified", replaced: "index.lock changed during recovery",
      retry: "index.lock blocked the Git retry" };
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(errors[mode]) });
    expect(resets).toBe(mode === "retry" ? 2 : 1);
    expect(fs.readFileSync(lock, "utf8")).toBe(mode === "foreign" ? "initial lock\n" : "second lock\n");
    const journal = path.join(pipelineArtifactsDir(id), "git-recovery.ndjson");
    const entries = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").trim().split("\n").filter(Boolean) : [];
    expect(entries).toHaveLength(mode === "retry" ? 1 : 0);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});
