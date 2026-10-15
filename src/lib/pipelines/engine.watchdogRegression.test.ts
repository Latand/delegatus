import { expect, test, harness, create, BUILD_ONLY, loadPipelines, savePipelines, tickPipelines } from "./engine.fixture";
import { settlePendingStageGit } from "./engine";
import { spyOn } from "bun:test";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { pipelineIdentity } from "./store";

async function watchdogTurns(): Promise<void> {
  let timer: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let turns = 0;
      timer = setInterval(() => { if (++turns === 4) resolve(); }, 50);
      deadline = setTimeout(() => reject(new Error("watchdog scheduler did not make progress")), 5_000);
    });
  } finally { if (timer) clearInterval(timer); if (deadline) clearTimeout(deadline); }
}

test.each([0, 267])("an outstanding stage Git command copies no retained history with %s peer lanes", async (historySize) => {
  const h = harness();
  await create(h.ports, BUILD_ONLY as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const owner = loadPipelines()[0]!;
  owner.cursor!.state = "committing";
  owner.runs[0]!.attempts[0]!.state = "committing";
  owner.runs[0]!.attempts[0]!.verdict = { status: "pass" };
  const history = Array.from({ length: historySize }, (_, n) => {
    const peer = structuredClone(owner);
    peer.id = `retained-${n}`;
    Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
    peer.state = "closed"; peer.closedAt = "2026-10-14T00:00:00.000Z"; peer.cursor = null;
    peer.delivery = undefined; peer.publication = "internal";
    peer.runs.forEach(run => { run.attempts = Array.from({ length: 8 }, (_, i) => ({ ...structuredClone(run.attempts[0]!),
      n: i + 1, state: "passed", output: "retained evidence ".repeat(256) })); });
    return peer;
  });
  savePipelines([owner, ...history]);
  const before = JSON.stringify(loadPipelines().slice(1));

  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const reply = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  const originalExec = h.ports.exec;
  h.ports.exec = async (command, args, ...rest) => {
    if (!held && command === "git") {
      held = true;
      entered();
      await reply;
    }
    return originalExec(command, args, ...rest);
  };
  const settlement = settlePendingStageGit(h.ports);
  const failures: unknown[] = [];
  void settlement.catch(error => { failures.push(error); });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let snapshots: ReturnType<typeof spyOn> | undefined;
  let copyCount = -1;
  try {
    await Promise.race([waiting, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("stage Git command did not start")), 2000);
    })]);
    snapshots = spyOn(SqliteStateCollection.prototype, "snapshot");
    await watchdogTurns();
    copyCount = snapshots.mock.calls.length;
  } finally {
    if (deadline) clearTimeout(deadline);
    snapshots?.mockRestore();
    release();
    await settlement;
  }
  expect(held).toBe(true);
  expect(copyCount).toBe(0);
  expect(failures).toEqual([]);
  expect(JSON.stringify(loadPipelines().filter(row => row.id !== owner.id))).toBe(before);
});

test.each(["authority", "progress", "removed"] as const)("a peer %s change during Git preserves ownership cancellation", async (change) => {
  const h = harness();
  await create(h.ports, BUILD_ONLY as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const owner = loadPipelines()[0]!;
  owner.cursor!.state = "committing";
  owner.runs[0]!.attempts[0]!.state = "committing";
  owner.runs[0]!.attempts[0]!.verdict = { status: "pass" };
  const peer = structuredClone(owner);
  peer.id = "retained-peer";
  Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
  peer.state = "closed";
  peer.closedAt = "2026-10-14T00:00:00.000Z";
  peer.cursor = null;
  peer.delivery = undefined;
  peer.publication = "internal";
  peer.runs = peer.runs.map(run => ({ ...run, attempts: [] }));
  savePipelines([owner, peer]);

  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const reply = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  let signal: AbortSignal | undefined;
  const originalExec = h.ports.exec;
  h.ports.exec = async (command, args, cwd, env, options) => {
    if (!held && command === "git") {
      held = true;
      signal = options?.signal;
      entered();
      await reply;
    }
    return originalExec(command, args, cwd, env, options);
  };
  const settlement = settlePendingStageGit(h.ports);
  const failures: unknown[] = [];
  void settlement.catch(error => { failures.push(error); });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let aborted: boolean | undefined;
  try {
    await Promise.race([waiting, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("stage Git command did not start")), 2000);
    })]);
    const current = loadPipelines();
    const sibling = current.find(row => row.id === peer.id)!;
    if (change === "authority") {
      sibling.task += " changed";
      Object.assign(sibling, pipelineIdentity(sibling.id, sibling.task, sibling.repoDir));
    }
    if (change === "progress") sibling.stateDetail = "new progress detail";
    savePipelines(change === "removed" ? current.filter(row => row.id !== peer.id) : current);
    await watchdogTurns();
    aborted = signal?.aborted;
  } finally {
    if (deadline) clearTimeout(deadline);
    release();
    await settlement;
  }
  expect(held).toBe(true);
  expect(aborted).toBe(change !== "progress");
  expect(failures).toEqual([]);
});
