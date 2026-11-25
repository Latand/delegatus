import { once } from "node:events";
import { afterEach, beforeEach, setDefaultTimeout } from "bun:test";
import { expect, test, fs, path, spawn, stopFixtureProcess, loadPipelines, realWorktreeLane, finishReported, tickPipelines } from "./engine.fixture";
import { pipelineArtifactsDir } from "./store";
import { recoverLaneIndexLock, withLaneIndexLockRecovery } from "./indexLock";
import { fixtureIndexLockCensus } from "./indexLock.fixture";
import { realExec } from "@/lib/workflows/provision";
import type { ExecPort } from "@/lib/workflows/provision";

setDefaultTimeout(15_000);
const linuxTest = process.platform === "linux" ? test : test.skip;
const stages = [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }];
const journalPath = (id: string) => path.join(pipelineArtifactsDir(id), "git-recovery.ndjson");
const fixturePids = new Set<number>();
let opaquePid: number | undefined;
let readdir: ReturnType<typeof fixtureIndexLockCensus>;
beforeEach(() => {
  fixturePids.add(process.pid);
  readdir = fixtureIndexLockCensus(fixturePids, () => opaquePid);
});
afterEach(() => { readdir.mockRestore(); fixturePids.clear(); opaquePid = undefined; });

async function holdOpen(file: string) {
  const child = spawn(process.execPath, ["-e", `
    const fd = require("node:fs").openSync(process.argv[1], "r");
    process.stdout.write("ready\\n");
    process.stdin.resume();
    process.stdin.once("end", () => require("node:fs").closeSync(fd));
  `, file], { stdio: ["pipe", "pipe", "inherit"] });
  try {
    await once(child.stdout, "data", { signal: AbortSignal.timeout(5_000) });
    fixturePids.add(child.pid!);
    return child;
  } catch (error) {
    await stopFixtureProcess(child);
    throw error;
  }
}

linuxTest("settlement removes a stale linked-worktree lock, unstages artifacts and publishes", async () => {
  const box = await realWorktreeLane("stale-index", stages, "remote-branch");
  try {
    const { id, h, worktree, git, origin } = box;
    const lane = loadPipelines().find(row => row.id === id)!;
    const lock = path.join(await git(worktree, "rev-parse", "--absolute-git-dir"), "index.lock");
    const artifact = ".artifacts/pipeline-stage-inputs/fixture.md";
    fs.mkdirSync(path.dirname(path.join(worktree, artifact)), { recursive: true });
    fs.writeFileSync(path.join(worktree, artifact), "controller handoff\n");
    await git(worktree, "add", "-f", "--", artifact);
    fs.writeFileSync(path.join(worktree, "report.md"), "stage output\n");
    fs.writeFileSync(lock, "", { flag: "wx" });
    const stale = new Date("2024-01-01T00:00:00Z");
    fs.utimesSync(lock, stale, stale);
    const original = fs.statSync(lock, { bigint: true });
    await tickPipelines([finishReported(h, "/codex/stage-1.jsonl", "pass", "Finished")], h.ports);
    const settled = loadPipelines().find(row => row.id === id)!;
    expect(settled.state, settled.stateDetail ?? undefined).toBe("completed");
    expect(await git(origin, "show", `${settled.lastPassedCommit}:report.md`)).toBe("stage output");
    expect(await git(worktree, "ls-files", "--", artifact)).toBe("");
    expect(fs.readFileSync(path.join(worktree, artifact), "utf8")).toBe("controller handoff\n");
    expect(fs.existsSync(lock)).toBe(false);
    const [entry, extra] = fs.readFileSync(journalPath(id), "utf8").trim().split("\n");
    expect(extra).toBeUndefined();
    const proof = JSON.parse(entry!);
    expect(proof).toMatchObject({ operation: "add", path: lock, inode: String(original.ino),
      size: String(original.size), mtimeNs: String(original.mtimeNs) });
    expect(proof.processes).toBeGreaterThan(0);
    expect(proof.descriptors).toBeGreaterThan(0);
    expect(await git(worktree, "branch", "--show-current")).toBe(lane.branch);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

linuxTest("settlement names a live non-Git descriptor holder and preserves the lock inode", async () => {
  const box = await realWorktreeLane("held-index", stages);
  let child: Awaited<ReturnType<typeof holdOpen>> | undefined;
  try {
    const lock = path.join(await box.git(box.worktree, "rev-parse", "--absolute-git-dir"), "index.lock");
    fs.writeFileSync(lock, "held\n", { flag: "wx" });
    const original = fs.statSync(lock, { bigint: true });
    child = await holdOpen(lock);
    await tickPipelines([finishReported(box.h, "/codex/stage-1.jsonl", "pass", "Finished")], box.h.ports);
    const parked = loadPipelines().find(row => row.id === box.id)!;
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain(`PID ${child.pid} (${path.basename(process.execPath)}) holds an open descriptor on index.lock`);
    expect(fs.statSync(lock, { bigint: true })).toMatchObject({ ino: original.ino, dev: original.dev, mtimeNs: original.mtimeNs });
    expect(fs.readFileSync(lock, "utf8")).toBe("held\n");
    expect(fs.existsSync(journalPath(box.id))).toBe(false);
  } finally {
    if (child) await stopFixtureProcess(child);
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

linuxTest("refuses a live Git command whose explicit Git directory is the lane", async () => {
  const box = await realWorktreeLane("git-owner", stages);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const lane = loadPipelines().find(row => row.id === box.id)!;
    const admin = await box.git(box.worktree, "rev-parse", "--absolute-git-dir");
    const lock = path.join(admin, "index.lock");
    fs.writeFileSync(lock, "", { flag: "wx" });
    child = spawn("git", ["--git-dir", admin, "hash-object", "--stdin"], { cwd: box.repo, stdio: "pipe" });
    await once(child, "spawn", { signal: AbortSignal.timeout(5_000) });
    fixturePids.add(child.pid!);
    const result = await recoverLaneIndexLock(lane, box.worktree, realExec, "merge");
    expect(result).toMatchObject({ error: expect.stringContaining(`PID ${child.pid} (git) is running Git against this checkout`) });
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.existsSync(journalPath(box.id))).toBe(false);
  } finally {
    if (child) await stopFixtureProcess(child);
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

linuxTest("refuses a child whose descriptor evidence is inaccessible", async () => {
  const box = await realWorktreeLane("opaque-index", stages);
  let child: Awaited<ReturnType<typeof holdOpen>> | undefined;
  try {
    const lane = loadPipelines().find(row => row.id === box.id)!;
    const lock = path.join(await box.git(box.worktree, "rev-parse", "--absolute-git-dir"), "index.lock");
    fs.writeFileSync(lock, "opaque holder\n", { flag: "wx" });
    child = await holdOpen(lock);
    opaquePid = child.pid;
    const result = await recoverLaneIndexLock(lane, box.worktree, realExec, "reset");
    expect(result).toMatchObject({
      error: expect.stringContaining(`open-file or Git evidence for PID ${child.pid} (${path.basename(process.execPath)}) is unavailable`),
    });
    expect(fs.readFileSync(lock, "utf8")).toBe("opaque holder\n");
    expect(fs.existsSync(journalPath(box.id))).toBe(false);
  } finally {
    if (child) await stopFixtureProcess(child);
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

linuxTest.each(["replacement", "late holder", "lost authority"] as const)("rechecks %s before unlink", async mode => {
  const box = await realWorktreeLane("changed-index", stages);
  let child: Awaited<ReturnType<typeof holdOpen>> | undefined;
  try {
    const lane = loadPipelines().find(row => row.id === box.id)!;
    const lock = path.join(await box.git(box.worktree, "rev-parse", "--absolute-git-dir"), "index.lock");
    fs.writeFileSync(lock, "original\n", { flag: "wx" });
    const execute: ExecPort = (...args) => realExec(...args);
    execute.revalidateIndexLockRecovery = async () => {
      if (mode === "late holder") { child = await holdOpen(lock); return true; }
      if (!fs.existsSync(journalPath(box.id))) return true;
      expect(JSON.parse(fs.readFileSync(journalPath(box.id), "utf8"))).toHaveProperty("path", lock);
      if (mode === "replacement") {
        fs.writeFileSync(`${lock}.next`, "replacement\n", { flag: "wx" });
        fs.renameSync(`${lock}.next`, lock);
      }
      return mode !== "lost authority";
    };
    const result = await recoverLaneIndexLock(lane, box.worktree, execute, "reset");
    expect(result).toMatchObject({ error: expect.stringContaining(mode === "replacement" ? "index.lock changed during recovery"
      : mode === "late holder" ? `PID ${child?.pid} (${path.basename(process.execPath)}) holds an open descriptor` : "controller authority") });
    expect(fs.readFileSync(lock, "utf8")).toBe(mode === "replacement" ? "replacement\n" : "original\n");
  } finally {
    if (child) await stopFixtureProcess(child);
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

linuxTest("continues merge --abort once in the main checkout and preserves other locks", async () => {
  const box = await realWorktreeLane("main-index", stages);
  try {
    const { repo, worktree, git, id } = box;
    const lane = loadPipelines().find(row => row.id === id)!;
    const gitDir = await git(repo, "rev-parse", "--absolute-git-dir");
    const lock = path.join(gitDir, "index.lock");
    const other = path.join(gitDir, "packed-refs.lock");
    const stageLock = path.join(await git(worktree, "rev-parse", "--absolute-git-dir"), "index.lock");
    await git(repo, "branch", "fixture-topic");
    await git(repo, "switch", "fixture-topic");
    fs.writeFileSync(path.join(repo, "topic"), "topic\n");
    await git(repo, "add", "topic");
    await git(repo, "commit", "-m", "topic");
    await git(repo, "switch", "main");
    await git(repo, "merge", "--no-commit", "--no-ff", "fixture-topic");
    fs.writeFileSync(lock, "", { flag: "wx" });
    fs.writeFileSync(other, "packed references\n", { flag: "wx" });
    fs.writeFileSync(stageLock, "linked checkout\n", { flag: "wx" });
    let calls = 0;
    const execute: ExecPort = (command, args, ...rest) => {
      if (args[0] === "merge") calls++;
      return realExec(command, args, ...rest);
    };
    const abort = await withLaneIndexLockRecovery(lane, execute)("git", ["merge", "--abort"], repo);
    expect(abort.code, abort.stderr).toBe(0);
    expect(calls).toBe(1);
    expect(await git(repo, "rev-parse", "HEAD")).toBe(box.base);
    expect(fs.existsSync(path.join(gitDir, "MERGE_HEAD"))).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readFileSync(other, "utf8")).toBe("packed references\n");
    expect(fs.readFileSync(stageLock, "utf8")).toBe("linked checkout\n");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

linuxTest("retries a controller Git command once when its first call reports index.lock", async () => {
  const box = await realWorktreeLane("retry-index", stages);
  try {
    const lane = loadPipelines().find(row => row.id === box.id)!;
    const lock = path.join(await box.git(box.worktree, "rev-parse", "--absolute-git-dir"), "index.lock");
    let calls = 0;
    const execute: ExecPort = (command, args, ...rest) => {
      if (args[0] === "reset") fs.writeFileSync(lock, `lock ${++calls}\n`, { flag: "wx" });
      return realExec(command, args, ...rest);
    };
    const result = await withLaneIndexLockRecovery(lane, execute)("git", ["reset", "--quiet", "HEAD", "--", "."], box.worktree);
    expect(result).toMatchObject({ code: expect.any(Number), stderr: "index.lock appeared again; retry with fresh evidence" });
    expect(result.code).not.toBe(0);
    expect(calls).toBe(2);
    expect(fs.readFileSync(lock, "utf8")).toBe("lock 2\n");
    expect(fs.readFileSync(journalPath(box.id), "utf8").trim().split("\n")).toHaveLength(1);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

linuxTest("recovers the lane lock after a stage reports a failed Git command", async () => {
  const box = await realWorktreeLane("reported-index", stages);
  try {
    const lock = path.join(await box.git(box.worktree, "rev-parse", "--absolute-git-dir"), "index.lock");
    fs.writeFileSync(lock, "", { flag: "wx" });
    const failed = await realExec("git", ["reset", "--quiet", "HEAD", "--", "."], box.worktree);
    expect(failed.code).not.toBe(0);
    const execute = box.h.ports.exec;
    let observedIntent = false;
    box.h.ports.exec = (...args) => {
      if (args[1].includes("--git-path") && args[1].includes("--show-toplevel")) {
        const pending = loadPipelines().find(row => row.id === box.id)!;
        expect(pending.runs[0]?.attempts[0]).toMatchObject({
          state: "running", verdict: null, indexLockRecoveryPending: { verdict: { status: "fail" } },
        });
        expect(fs.existsSync(lock)).toBe(true);
        observedIntent = true;
      }
      return execute(...args);
    };
    await tickPipelines([finishReported(box.h, "/codex/stage-1.jsonl", "fail", failed.stderr)], box.h.ports);
    expect(observedIntent).toBe(true);
    const settled = loadPipelines().find(row => row.id === box.id)!;
    expect(settled.state).toBe("running");
    expect(settled.runs[0]?.attempts[0]).toMatchObject({ state: "failed", verdict: { status: "fail" }, indexLockContinuationQueued: true });
    expect(fs.existsSync(lock)).toBe(false);
    expect(JSON.parse(fs.readFileSync(journalPath(box.id), "utf8"))).toMatchObject({ operation: "stage-reported Git failure", path: lock });
    expect((await realExec("git", ["reset", "--quiet", "HEAD", "--", "."], box.worktree)).code).toBe(0);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});
