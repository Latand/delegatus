import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BridgeReportV1 } from "@/lib/bridge/types";
import type { ForgeCacheFile } from "@/lib/forge/cache";
import type { Pipeline } from "@/lib/pipelines/types";
import type { PrototypeRoundRead } from "@/lib/prototypeReview/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { LimitSample } from "@/lib/types";

import type { DoneDeployment } from "./candidates";
import { lookupDoneFrame } from "./frames";
import { DONE_PROJECTION_THROTTLE_MS, projectDoneItems, resetDoneProjectionThrottleForTests, type DoneWorld } from "./project";
import { acknowledgeDoneItems, DONE_ACKNOWLEDGED_RETENTION_MS, DONE_MAX_ROWS, DONE_SETTLED_RETENTION_MS, doneRevision, readDoneMemory, readDoneRows, resetDoneCollectionsForTests, unacknowledgedDoneItems, writeDoneProjection } from "./store";
import { DONE_SWEEP_INTERVAL_MS, runDoneSweepOnce, startDoneSweep, stopDoneSweep } from "./sweep";
import type { DoneFrame } from "./types";

/*
 * «Готово» (docs/design/done-section.md §2, §3, §7): one item per finished
 * unit of work, from the records Delegatus keeps, in a private state
 * directory. Repositories, branches, tasks and accounts are invented.
 */

const REPO = "acme/widgets";
const PROJECT = "repo-widgets";
const HOUR = 3_600_000;
/* The store is first written at T0; every event below is after it unless a
   case says otherwise. */
const T0 = Date.parse("2026-10-10T20:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

let sandbox = "";
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-done-items-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetDoneCollectionsForTests();
  resetDoneProjectionThrottleForTests();
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  resetDoneCollectionsForTests();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

type PrRow = { number: number; head: string; state: "open" | "merged" | "closed"; title?: string; mergedAt?: string };
function forge(rows: PrRow[]): ForgeCacheFile {
  return { schemaVersion: 1, repositories: { [REPO]: {
    canonical: REPO, completeSince: iso(T0 - 48 * HOUR), lastSweepAt: iso(T0), lastAttemptAt: iso(T0), lastError: null, issues: {}, headRefOids: true,
    prs: Object.fromEntries(rows.map((row) => [String(row.number), {
      url: `https://github.com/${REPO}/pull/${row.number}`, headRefName: row.head, createdAt: iso(T0 - HOUR), state: row.state, closes: [], checkedAt: iso(T0),
      ...(row.title ? { title: row.title } : {}), ...(row.mergedAt ? { mergedAt: row.mergedAt } : {}),
    }])),
  } } };
}

function lane(id: string, over: Partial<Pipeline> = {}): Pipeline {
  return {
    id, task: `Lane ${id}`, taskIds: [], project: PROJECT, repoDir: "/repo", worktreeDir: `/repo-${id}`, branch: `pipeline/${id}`, baseBranch: "main", baseRef: "main",
    lastPassedCommit: "", stages: [{ id: "build", kind: "run", effectiveRole: { roleId: "builder" } }], cursor: null,
    runs: [{ stageId: "build", attempts: [{ n: 1, state: "passed", completedAt: iso(T0 + HOUR) }] }],
    state: "completed", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: iso(T0 - 4 * HOUR), closedAt: iso(T0 + HOUR),
    ...over,
  } as unknown as Pipeline;
}

function task(id: string, text: string, over: Partial<BoardTask> = {}): BoardTask {
  return { id, project: PROJECT, status: "assigned", text, assignments: [], createdAt: iso(T0 - 24 * HOUR), updatedAt: iso(T0), ...over } as unknown as BoardTask;
}

interface World {
  now: number;
  forge: ForgeCacheFile;
  pipelines: Pipeline[];
  tasks: BoardTask[];
  deployments: DoneDeployment[];
  reports: BridgeReportV1[];
  limits: Record<string, LimitSample[]>;
  rounds: Record<string, PrototypeRoundRead[]>;
  album: (taskId: string, pipeline: Pipeline) => Promise<{ frame: DoneFrame | null; settled: boolean }>;
}

function world(over: Partial<World> = {}): World {
  return {
    now: T0 + 10 * HOUR, forge: forge([]), pipelines: [], tasks: [], deployments: [], reports: [], limits: {}, rounds: {},
    album: async () => ({ frame: null, settled: true }),
    ...over,
  };
}

function ports(state: World): DoneWorld {
  return {
    now: () => state.now,
    forge: () => state.forge,
    pipelines: () => state.pipelines,
    tasks: () => state.tasks,
    deployments: () => state.deployments,
    reports: () => state.reports,
    limits: () => state.limits,
    pipelineRepository: () => REPO,
    repositoryProject: (repository) => (repository === REPO ? PROJECT : null),
    accountLabel: (engine, accountId) => (accountId === "acct-b" ? `${engine === "codex" ? "Codex" : "Claude"} B` : null),
    rounds: (taskId) => state.rounds[taskId] ?? [],
    album: (taskId, pipeline) => state.album(taskId, pipeline),
  };
}

/* The store's activation is its first write; open it before the events. */
async function activate(): Promise<void> {
  await projectDoneItems(ports(world({ now: T0 })), { force: true });
}

const keys = () => unacknowledgedDoneItems().map((item) => item.key).sort();

test("one item per unit of work: a direct merge, a batch member at the batch's time, never the batch, a PR-less lane, a task with no lane", async () => {
  await activate();
  const state = world({
    forge: forge([
      { number: 10, head: "pipeline/direct", state: "merged", title: "Direct", mergedAt: iso(T0 + HOUR) },
      { number: 11, head: "pipeline/batched", state: "closed", title: "Batched" },
      { number: 12, head: "feature/closed-unmerged", state: "closed", title: "Abandoned" },
      { number: 13, head: "merge-batch/one", state: "merged", title: "Merge batch: #11", mergedAt: iso(T0 + 2 * HOUR) },
      { number: 14, head: "pipeline/open", state: "open", title: "Still open" },
    ]),
    pipelines: [
      lane("direct", { taskIds: ["t-direct"], finishesTaskIds: ["t-direct"] }),
      lane("batched", { taskIds: ["t-batched"] }),
      lane("internal", { taskIds: ["t-internal"], closedAt: iso(T0 + 3 * HOUR) }),
      lane("open", { taskIds: ["t-open"] }),
      /* A discarded lane and a failed one finish nothing. */
      lane("discarded", { state: "closed", hiddenAt: iso(T0 + HOUR), runs: [], taskIds: ["t-discarded"] }),
      lane("failed", { state: "closed", taskIds: ["t-failed"], runs: [{ stageId: "build", attempts: [{ n: 1, state: "failed", completedAt: iso(T0 + HOUR) }] }] } as Partial<Pipeline>),
    ],
    tasks: [
      task("t-direct", "Пряме злиття\nДеталі", { status: "done", doneAt: iso(T0 + HOUR), icon: "git-merge" }),
      task("t-batched", "Злито пакетом", { status: "done", doneAt: iso(T0 + 2 * HOUR) }),
      task("t-internal", "Внутрішня лінія без PR", { status: "done", doneAt: iso(T0 + 3 * HOUR) }),
      task("t-open", "PR ще відкритий"),
      task("t-discarded", "Скасована", { status: "done", doneAt: iso(T0 + HOUR) }),
      task("t-failed", "Провалена", { status: "done", doneAt: iso(T0 + HOUR) }),
      task("t-alone", "Задача без лінії", { status: "done", doneAt: iso(T0 + 4 * HOUR) }),
      task("t-inbox", "Ще не зроблена"),
    ],
  });
  await projectDoneItems(ports(state), { force: true });
  expect(keys()).toEqual([`pipeline:internal:done`, `pr:${REPO}#10`, `pr:${REPO}#11`, "task:t-alone"]);
  const byKey = new Map(unacknowledgedDoneItems().map((item) => [item.key, item]));
  expect(byKey.get(`pr:${REPO}#10`)).toMatchObject({ kind: "pr", look: "technical", project: PROJECT, at: iso(T0 + HOUR), title: "Пряме злиття", icon: "git-merge",
    refs: { pipelineId: "direct", pr: { repository: REPO, number: 10, url: `https://github.com/${REPO}/pull/10` }, taskIds: ["t-direct"] } });
  /* The batch member lands when the batch merged, and speaks for its task. */
  expect(byKey.get(`pr:${REPO}#11`)).toMatchObject({ at: iso(T0 + 2 * HOUR), title: "Злито пакетом", refs: { pipelineId: "batched", taskIds: ["t-batched"] } });
  expect(byKey.get("pipeline:internal:done")).toMatchObject({ kind: "pipeline", look: "closed", title: "Внутрішня лінія без PR", refs: { pipelineId: "internal", taskIds: ["t-internal"] } });
  expect(byKey.get("task:t-alone")).toMatchObject({ kind: "task", look: "closed", title: "Задача без лінії", project: PROJECT });
  /* Newest event first. */
  expect(unacknowledgedDoneItems().map((item) => item.key)).toEqual(["task:t-alone", "pipeline:internal:done", `pr:${REPO}#11`, `pr:${REPO}#10`]);
});

test("a second projection writes nothing, and an acknowledged key stays acknowledged while its source repeats", async () => {
  await activate();
  const state = world({
    forge: forge([{ number: 10, head: "pipeline/direct", state: "merged", title: "Direct", mergedAt: iso(T0 + HOUR) }]),
    pipelines: [lane("direct", { taskIds: ["t-direct"] })],
    tasks: [task("t-direct", "Пряме злиття", { status: "done", doneAt: iso(T0 + HOUR) })],
  });
  const first = await projectDoneItems(ports(state), { force: true });
  expect(first).toMatchObject({ projected: true, inserted: 1 });
  const revision = doneRevision();
  expect(await projectDoneItems(ports(state), { force: true })).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
  expect(doneRevision()).toBe(revision);

  const [changed] = acknowledgeDoneItems([`pr:${REPO}#10`], { undo: false, surface: "phone", now: T0 + 11 * HOUR });
  expect(changed).toMatchObject({ acknowledgedAt: iso(T0 + 11 * HOUR), acknowledgedBy: { kind: "operator", surface: "phone" } });
  expect(unacknowledgedDoneItems()).toEqual([]);
  /* The sweep reads the PR again, its task's title changes: nothing comes back. */
  state.tasks[0]!.text = "Пряме злиття, нова назва";
  await projectDoneItems(ports({ ...state, now: T0 + 12 * HOUR }), { force: true });
  expect(unacknowledgedDoneItems()).toEqual([]);
  expect(readDoneRows()[0]).toMatchObject({ title: "Пряме злиття", acknowledgedAt: iso(T0 + 11 * HOUR) });
  /* Undo brings it back, and the next projection may refresh it. */
  acknowledgeDoneItems([`pr:${REPO}#10`], { undo: true, surface: "desktop", now: T0 + 12 * HOUR });
  await projectDoneItems(ports({ ...state, now: T0 + 13 * HOUR }), { force: true });
  expect(unacknowledgedDoneItems().map((item) => item.title)).toEqual(["Пряме злиття, нова назва"]);
});

test("nothing from before the store was first written", async () => {
  await activate();
  const state = world({
    tasks: [
      task("t-before", "До активації", { status: "done", doneAt: iso(T0 - HOUR) }),
      task("t-after", "Після активації", { status: "done", doneAt: iso(T0 + HOUR) }),
    ],
    deployments: [
      { deploymentId: "dep-before", revision: "a".repeat(40), phase: "succeeded", terminal: true, updatedAt: iso(T0 - 2 * HOUR) },
      { deploymentId: "dep-after", revision: "b".repeat(40), phase: "succeeded", terminal: true, updatedAt: iso(T0 + 2 * HOUR) },
      { deploymentId: "dep-running", revision: "c".repeat(40), phase: "building", terminal: false, updatedAt: iso(T0 + 3 * HOUR) },
      { deploymentId: "dep-failed", revision: "d".repeat(40), phase: "rolled-back", terminal: true, updatedAt: iso(T0 + 3 * HOUR) },
    ],
  });
  await projectDoneItems(ports(state), { force: true });
  expect(keys()).toEqual(["deploy:dep-after", "deploy:dep-failed", "task:t-after"]);
  const failed = unacknowledgedDoneItems().find((item) => item.key === "deploy:dep-failed")!;
  expect(failed).toMatchObject({ look: "incident", project: null, refs: { sha: "d".repeat(40), phase: "rolled-back" } });
});

test("an outcome no read ever saw still arrives days later: there is no window, only the activation", async () => {
  await activate();
  /* Done a second after activation, then nothing reads the store for eight days. */
  await projectDoneItems(ports(world({ now: T0 + 8 * 24 * HOUR, tasks: [
    task("t-quiet", "Тиха", { status: "done", doneAt: iso(T0 + 1_000) }),
    task("t-before", "До активації", { status: "done", doneAt: iso(T0 - 1_000) }),
  ] })), { force: true });
  expect(keys()).toEqual(["task:t-quiet"]);
});

test("the Viewer's own sweep keeps outcomes no browser read, after their source has rotated away", async () => {
  await activate();
  const report: BridgeReportV1 = { seq: 1, id: "r-sweep", at: iso(T0 + HOUR), class: "status", origin: { kind: "manager", conversationId: "conversation_manager", role: "orchestrator" },
    project: PROJECT, body: "body", outcome: { kind: "incident", summary: "Лінію перезапущено" } };
  const deployment: DoneDeployment = { deploymentId: "dep-sweep", revision: "e".repeat(40), phase: "succeeded", terminal: true, updatedAt: iso(T0 + HOUR) };
  const state = world({ now: T0 + HOUR + 60_000, reports: [report], deployments: [deployment] });
  /* A release that does not own traffic leaves the store alone. */
  expect(await runDoneSweepOnce({ world: () => ports(state), ownsTraffic: async () => false })).toBe(false);
  expect(keys()).toEqual([]);
  expect(await runDoneSweepOnce({ world: () => ports(state), ownsTraffic: async () => true })).toBe(true);
  /* The report log and the deploy ledger roll over, days pass, nobody read. */
  resetDoneProjectionThrottleForTests();
  await projectDoneItems(ports(world({ now: T0 + 10 * 24 * HOUR })), { force: true });
  expect(keys()).toEqual(["deploy:dep-sweep", "report:r-sweep"]);
});

test("the sweep arms one process-wide clock that re-arms after each run", async () => {
  const armed: Array<{ run: () => void; delay: number }> = [];
  let runs = 0;
  const schedule = (run: () => void, delay: number) => {
    armed.push({ run, delay });
    return setTimeout(() => {}, 0);
  };
  try {
    startDoneSweep({ schedule, sweep: async () => { runs += 1; } });
    startDoneSweep({ schedule, sweep: async () => { runs += 100; } });
    expect(armed.length).toBe(1);
    armed[0]!.run();
    await Bun.sleep(0);
    expect(runs).toBe(1);
    expect(armed.length).toBe(2);
    expect(armed[1]!.delay).toBe(DONE_SWEEP_INTERVAL_MS);
  } finally {
    stopDoneSweep();
  }
});

test("an outcome marker makes an item only on the orchestrator's own report", async () => {
  await activate();
  const row = (id: string, kind: "manager" | "agent", outcome?: BridgeReportV1["outcome"]): BridgeReportV1 => ({
    seq: Number(id.slice(-1)), id, at: iso(T0 + HOUR), class: "status", origin: { kind, conversationId: `conversation_${kind}`, role: kind === "manager" ? "orchestrator" : "builder" },
    project: PROJECT, body: "body", ...(outcome ? { outcome } : {}),
  });
  await projectDoneItems(ports(world({ reports: [
    row("r1", "manager", { kind: "incident", summary: "Сім ліній перезапущено" }),
    row("r2", "manager", { kind: "publication", summary: "Лендінг опубліковано" }),
    row("r3", "agent", { kind: "incident", summary: "Не від оркестратора" }),
    row("r4", "manager"),
  ] })), { force: true });
  expect(unacknowledgedDoneItems().map((item) => [item.key, item.look, item.title]).sort()).toEqual([
    ["report:r1", "incident", "Сім ліній перезапущено"],
    ["report:r2", "publication", "Лендінг опубліковано"],
  ]);
});

test("a limit episode keeps its key as its reset arrives, and says how many lanes waited", async () => {
  await activate();
  const t = (hours: number) => Math.round((T0 + hours * HOUR) / 1000);
  const limits: Record<string, LimitSample[]> = {
    "codex|acct-b|session": [{ t: t(1), remaining: 12 }, { t: t(2), remaining: 0 }, { t: t(3), remaining: 0 }],
    "claude|acct-a|weekly": [{ t: t(1), remaining: 40 }],
  };
  const waiting = lane("waiting", { state: "running", closedAt: null, runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", usageLimitedAccounts: [{ accountId: "acct-b", engine: "codex", resetsAt: null, limitedAt: T0 + 2.5 * HOUR }] }] }] } as Partial<Pipeline>);
  const state = world({ now: T0 + 4 * HOUR, limits, pipelines: [waiting] });
  await projectDoneItems(ports(state), { force: true });
  const key = `limit:codex:acct-b:session:${t(2)}`;
  expect(keys()).toEqual([key]);
  expect(unacknowledgedDoneItems()[0]).toMatchObject({ look: "limit", project: null, refs: { account: { engine: "codex", accountId: "acct-b", window: "session", label: "Codex B" }, limit: { from: iso(t(2) * 1000), to: null, lanes: 1 } } });
  limits["codex|acct-b|session"]!.push({ t: t(5), remaining: 100 });
  await projectDoneItems(ports({ ...state, now: T0 + 6 * HOUR }), { force: true });
  expect(keys()).toEqual([key]);
  expect(unacknowledgedDoneItems()[0]!.refs.limit).toEqual({ from: iso(t(2) * 1000), to: iso(t(5) * 1000), lanes: 1 });
  /* Acknowledged early, it holds when the text fills in. */
  acknowledgeDoneItems([key], { undo: false, surface: "desktop", now: T0 + 6 * HOUR });
  limits["codex|acct-b|session"]!.push({ t: t(7), remaining: 0 });
  await projectDoneItems(ports({ ...state, now: T0 + 8 * HOUR }), { force: true });
  expect(keys()).toEqual([`limit:codex:acct-b:session:${t(7)}`]);
});

test("the thumbnail: the lane's own undecided round first, then its visual critic's album, then the chosen design frame", async () => {
  await activate();
  const media = (id: string) => ({ id, mime: "image/png" as const, bytes: 1, available: true, url: `/api/image?taskId=t&prototype=r&media=${id}` });
  const round = (id: string, over: Partial<PrototypeRoundRead>): PrototypeRoundRead => ({
    id, title: `Round ${id}`, taskId: "t-ui", project: PROJECT, createdAt: iso(T0), source: { conversationId: null },
    variants: [1, 2].map((number) => ({ number, name: `V${number}`, description: "", videos: [], frames: [{ image: media(`${id}-v${number}`), original: media(`${id}-v${number}-before`), caption: `${id} v${number}` }] })),
    ...over,
  } as PrototypeRoundRead);
  const design = round("design", { createdAt: iso(T0 - HOUR), decision: { chosen: [2], comment: "", at: iso(T0), delivery: { state: "sent", retryable: false } } });
  const own = round("own", { createdAt: iso(T0 + HOUR), source: { conversationId: null, pipelineId: "ui", stageId: "build" } });
  const critic = lane("ui", { taskIds: ["t-ui"], stages: [{ id: "build", kind: "run", effectiveRole: { roleId: "builder" } }, { id: "look", kind: "run", effectiveRole: { roleId: "visual-critic" } }] } as unknown as Partial<Pipeline>);
  const base = { forge: forge([{ number: 20, head: "pipeline/ui", state: "merged", mergedAt: iso(T0 + 2 * HOUR) }]), pipelines: [critic], tasks: [task("t-ui", "Видима зміна", { status: "done", doneAt: iso(T0 + 2 * HOUR) })] };

  await projectDoneItems(ports(world({ ...base, rounds: { "t-ui": [design, own] } })), { force: true });
  expect(unacknowledgedDoneItems()[0]).toMatchObject({ look: "visible", frame: { src: media("own-v1").url, before: media("own-v1-before").url, caption: "own v1" } });

  resetDoneCollectionsForTests();
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox);
  await activate();
  let indexing = true;
  const album = async () => ({ frame: indexing ? null : { src: "/api/artifact?path=%2Fvar%2Ftmp%2Flane%2Fcritic.png", caption: "critic.png" }, settled: !indexing });
  await projectDoneItems(ports(world({ ...base, rounds: { "t-ui": [design] }, album })), { force: true });
  /* While the album indexes, the design frame stands in and the lookup stays open. */
  expect(unacknowledgedDoneItems()[0]).toMatchObject({ look: "visible", frame: { src: media("design-v2").url, before: media("design-v2-before").url }, frameCheckedAt: null });
  indexing = false;
  await projectDoneItems(ports(world({ ...base, rounds: { "t-ui": [design] }, album, now: T0 + 11 * HOUR })), { force: true });
  expect(unacknowledgedDoneItems()[0]).toMatchObject({ look: "visible", frame: { src: "/api/artifact?path=%2Fvar%2Ftmp%2Flane%2Fcritic.png" } });
  expect(unacknowledgedDoneItems()[0]!.frameCheckedAt).not.toBeNull();
});

test("a lane with no frame anywhere is a technical item, settled at once and never read again", async () => {
  await activate();
  let albumReads = 0;
  const state = world({
    forge: forge([{ number: 30, head: "pipeline/tech", state: "merged", mergedAt: iso(T0 + HOUR) }]),
    pipelines: [lane("tech", { taskIds: ["t-tech"] })],
    tasks: [task("t-tech", "Технічне", { status: "done", doneAt: iso(T0 + HOUR) })],
    album: async () => { albumReads += 1; return { frame: null, settled: true }; },
  });
  await projectDoneItems(ports(state), { force: true });
  expect(unacknowledgedDoneItems()[0]).toMatchObject({ look: "technical", frame: null });
  expect(unacknowledgedDoneItems()[0]!.frameCheckedAt).not.toBeNull();
  expect(albumReads).toBe(1);
  /* Settled: the next projection does not index the album again. */
  await projectDoneItems(ports({ ...state, now: T0 + 11 * HOUR }), { force: true });
  expect(albumReads).toBe(1);
});

test("a builder-only lane's rendered evidence is its thumbnail; no visual critic is needed", async () => {
  await activate();
  const evidence = { src: "/api/artifact?path=%2Fvar%2Ftmp%2Fevidence%2Fdesktop.png", caption: "desktop.png" };
  const asked: string[] = [];
  const state = world({
    forge: forge([{ number: 31, head: "pipeline/builder", state: "merged", mergedAt: iso(T0 + HOUR) }]),
    pipelines: [lane("builder", { taskIds: ["t-builder"] })],
    tasks: [task("t-builder", "Зміна з доказом", { status: "done", doneAt: iso(T0 + HOUR) })],
    album: async (taskId) => { asked.push(taskId); return { frame: evidence, settled: true }; },
  });
  await projectDoneItems(ports(state), { force: true });
  expect(asked).toEqual(["t-builder"]);
  expect(unacknowledgedDoneItems()[0]).toMatchObject({ key: `pr:${REPO}#31`, look: "visible", frame: evidence });
});

test("the frame lookup asks the album for a lane with no visual critic, and an indexing album keeps it open", async () => {
  const builderOnly = lane("solo", { taskIds: ["t-solo"] });
  let calls = 0;
  const indexing = await lookupDoneFrame({ pipeline: builderOnly, taskIds: ["t-solo"] }, {
    rounds: () => [],
    album: async () => { calls += 1; return { frame: null, settled: false }; },
  });
  expect(calls).toBe(1);
  expect(indexing).toEqual({ frame: null, settled: false });
});

test("a read projects at most once per throttle window", async () => {
  await activate();
  const state = world({ now: T0 + HOUR, tasks: [task("t-a", "Перша", { status: "done", doneAt: iso(T0 + HOUR) })] });
  expect((await projectDoneItems(ports(state))).projected).toBe(true);
  state.tasks.push(task("t-b", "Друга", { status: "done", doneAt: iso(T0 + HOUR) }));
  expect((await projectDoneItems(ports({ ...state, now: T0 + HOUR + 1_000 }))).projected).toBe(false);
  expect(keys()).toEqual(["task:t-a"]);
  expect((await projectDoneItems(ports({ ...state, now: T0 + HOUR + DONE_PROJECTION_THROTTLE_MS }))).projected).toBe(true);
  expect(keys()).toEqual(["task:t-a", "task:t-b"]);
});

test("retention: an acknowledged row leaves 30 days after its acknowledgement; an unacknowledged one stays", async () => {
  await activate();
  const state = world({ now: T0 + HOUR, tasks: [task("t-a", "Перша", { status: "done", doneAt: iso(T0 + HOUR) }), task("t-b", "Друга", { status: "done", doneAt: iso(T0 + HOUR) })] });
  await projectDoneItems(ports(state), { force: true });
  acknowledgeDoneItems(["task:t-a"], { undo: false, surface: "desktop", now: T0 + 2 * HOUR });
  const later = T0 + 2 * HOUR + DONE_ACKNOWLEDGED_RETENTION_MS + HOUR;
  await projectDoneItems(ports(world({ now: later })), { force: true });
  expect(readDoneRows().map((row) => row.key)).toEqual(["task:t-b"]);
  /* Its source still holds the task: the pruned key does not come back,
     through this reader or a fresh one. */
  await projectDoneItems(ports({ ...state, now: later + HOUR }), { force: true });
  resetDoneCollectionsForTests();
  await projectDoneItems(ports({ ...state, now: later + 2 * HOUR }), { force: true });
  expect(keys()).toEqual(["task:t-b"]);
});

test("crossing the row cap never brings an accepted item back, and every unaccepted one stays", async () => {
  await activate();
  const done = (index: number) => task(`t${index}`, `Задача ${index}`, { status: "done", doneAt: iso(T0 + HOUR + index * 1_000) });
  const tasks = Array.from({ length: DONE_MAX_ROWS }, (_, index) => done(index));
  const state = world({ now: T0 + 2 * HOUR, tasks });
  await projectDoneItems(ports(state), { force: true });
  acknowledgeDoneItems(["task:t0"], { undo: false, surface: "desktop", now: T0 + 3 * HOUR });
  const replay = readDoneRows().find((row) => row.key === "task:t0")!;
  /* A 2 001st item the same day, then the initial candidates again. */
  state.tasks = [...tasks, done(DONE_MAX_ROWS)];
  await projectDoneItems(ports({ ...state, now: T0 + 3 * HOUR }), { force: true });
  writeDoneProjection({ upserts: [{ ...replay, acknowledgedAt: null, acknowledgedBy: null }] }, T0 + 3 * HOUR);
  expect(unacknowledgedDoneItems().some((item) => item.key === "task:t0")).toBe(false);
  /* Days later the cap removes the accepted row; neither a replay nor a
     fresh reader finds a way back for it. */
  await projectDoneItems(ports({ ...state, now: T0 + 3 * 24 * HOUR }), { force: true });
  expect(readDoneRows().some((row) => row.key === "task:t0")).toBe(false);
  writeDoneProjection({ upserts: [{ ...replay, acknowledgedAt: null, acknowledgedBy: null }] }, T0 + 3 * 24 * HOUR);
  resetDoneCollectionsForTests();
  await projectDoneItems(ports({ ...state, now: T0 + 3 * 24 * HOUR + HOUR }), { force: true });
  const waiting = unacknowledgedDoneItems();
  expect(waiting.some((item) => item.key === "task:t0")).toBe(false);
  expect(waiting.length).toBe(DONE_MAX_ROWS);
});

test("an outcome first seen after age retention removed a newer accepted one still arrives, and the accepted one stays away", async () => {
  await activate();
  const DAY = 24 * HOUR;
  const newer = task("t-newer", "Новіша", { status: "done", doneAt: iso(T0 + 2 * DAY) });
  const state = world({ now: T0 + 2 * DAY, tasks: [newer] });
  await projectDoneItems(ports(state), { force: true });
  acknowledgeDoneItems(["task:t-newer"], { undo: false, surface: "desktop", now: T0 + 2 * DAY });
  const later = T0 + 2 * DAY + DONE_ACKNOWLEDGED_RETENTION_MS + HOUR;
  await projectDoneItems(ports({ ...state, now: later }), { force: true });
  expect(readDoneRows().some((row) => row.key === "task:t-newer")).toBe(false);
  /* A source that was out until now reports an older outcome for the first time. */
  state.tasks = [newer, task("t-first", "Вперше побачена", { status: "done", doneAt: iso(T0 + DAY) })];
  await projectDoneItems(ports({ ...state, now: later + HOUR }), { force: true });
  expect(keys()).toEqual(["task:t-first"]);
  resetDoneCollectionsForTests();
  await projectDoneItems(ports({ ...state, now: later + 2 * HOUR }), { force: true });
  expect(keys()).toEqual(["task:t-first"]);
});

test("an outcome first seen after the row cap removed an accepted one still arrives, through a fresh reader too", async () => {
  await activate();
  const DAY = 24 * HOUR;
  const done = (index: number) => task(`t${index}`, `Задача ${index}`, { status: "done", doneAt: iso(T0 + 2 * DAY + index * 1_000) });
  const tasks = Array.from({ length: DONE_MAX_ROWS }, (_, index) => done(index));
  const state = world({ now: T0 + 2 * DAY + HOUR, tasks });
  await projectDoneItems(ports(state), { force: true });
  acknowledgeDoneItems(["task:t0"], { undo: false, surface: "desktop", now: T0 + 2 * DAY + HOUR });
  state.tasks = [...tasks, done(DONE_MAX_ROWS)];
  await projectDoneItems(ports({ ...state, now: T0 + 4 * DAY }), { force: true });
  expect(readDoneRows().some((row) => row.key === "task:t0")).toBe(false);
  state.tasks = [...state.tasks, task("t-early", "Подія першої доби", { status: "done", doneAt: iso(T0 + DAY) })];
  await projectDoneItems(ports({ ...state, now: T0 + 4 * DAY + HOUR }), { force: true });
  expect(unacknowledgedDoneItems().some((item) => item.key === "task:t-early")).toBe(true);
  resetDoneCollectionsForTests();
  await projectDoneItems(ports({ ...state, now: T0 + 4 * DAY + 2 * HOUR }), { force: true });
  const waiting = unacknowledgedDoneItems();
  expect(waiting.some((item) => item.key === "task:t-early")).toBe(true);
  expect(waiting.some((item) => item.key === "task:t0")).toBe(false);
});

test("a limit episode keeps its key while the history trims its first samples, and the next one after a reset is one new item", async () => {
  await activate();
  const DAY = 24 * HOUR;
  const t = (days: number) => Math.round((T0 + days * DAY) / 1000);
  const series = "claude|acct-b|weekly";
  const zeros = (from: number, through: number) => Array.from({ length: through - from + 1 }, (_, index) => ({ t: t(from + index), remaining: 0 }));
  const state = world({ now: T0 + 2 * DAY + HOUR, limits: { [series]: zeros(1, 2) } });
  await projectDoneItems(ports(state), { force: true });
  const key = `limit:claude:acct-b:weekly:${t(1)}`;
  expect(keys()).toEqual([key]);
  acknowledgeDoneItems([key], { undo: false, surface: "desktop", now: T0 + 2 * DAY + HOUR });
  /* Eight days on the history no longer holds the first sample. */
  state.limits = { [series]: zeros(2, 10) };
  await projectDoneItems(ports({ ...state, now: T0 + 10 * DAY + HOUR }), { force: true });
  expect(keys()).toEqual([]);
  resetDoneCollectionsForTests();
  state.limits = { [series]: zeros(3, 11) };
  await projectDoneItems(ports({ ...state, now: T0 + 11 * DAY + HOUR }), { force: true });
  expect(keys()).toEqual([]);
  /* A reset, then the window runs out again: exactly one new item, which
     keeps its own key as the history trims it in turn. */
  state.limits = { [series]: [...zeros(4, 11), { t: t(12), remaining: 60 }, ...zeros(13, 14)] };
  await projectDoneItems(ports({ ...state, now: T0 + 14 * DAY + HOUR }), { force: true });
  const next = `limit:claude:acct-b:weekly:${t(13)}`;
  expect(keys()).toEqual([next]);
  state.limits = { [series]: zeros(14, 22) };
  await projectDoneItems(ports({ ...state, now: T0 + 22 * DAY + HOUR }), { force: true });
  expect(keys()).toEqual([next]);
  expect(unacknowledgedDoneItems()[0]!.refs.limit!.from).toBe(iso(t(13) * 1000));
});

test("an unaccepted limit episode stays one item while its first samples trim away", async () => {
  await activate();
  const DAY = 24 * HOUR;
  const t = (days: number) => Math.round((T0 + days * DAY) / 1000);
  const series = "codex|acct-b|weekly";
  const state = world({ now: T0 + 2 * DAY, limits: { [series]: [{ t: t(1), remaining: 0 }, { t: t(2), remaining: 0 }] } });
  await projectDoneItems(ports(state), { force: true });
  state.limits = { [series]: [{ t: t(2), remaining: 0 }, { t: t(9), remaining: 0 }, { t: t(10), remaining: 30 }] };
  await projectDoneItems(ports({ ...state, now: T0 + 10 * DAY }), { force: true });
  expect(keys()).toEqual([`limit:codex:acct-b:weekly:${t(1)}`]);
  expect(unacknowledgedDoneItems()[0]!.refs.limit).toMatchObject({ from: iso(t(1) * 1000), to: iso(t(10) * 1000) });
  /* Its closing reset trims away as well: still the same single item. */
  state.limits = { [series]: [{ t: t(9), remaining: 0 }, { t: t(10), remaining: 30 }] };
  resetDoneCollectionsForTests();
  await projectDoneItems(ports({ ...state, now: T0 + 16 * DAY }), { force: true });
  expect(keys()).toEqual([`limit:codex:acct-b:weekly:${t(1)}`]);
});

test("a settled key retires only after 400 days and still cannot come back", async () => {
  await activate();
  const accepted = task("t-a", "Прийнята", { status: "done", doneAt: iso(T0 + HOUR) });
  const state = world({ now: T0 + HOUR, tasks: [accepted] });
  await projectDoneItems(ports(state), { force: true });
  acknowledgeDoneItems(["task:t-a"], { undo: false, surface: "desktop", now: T0 + HOUR });
  await projectDoneItems(ports({ ...state, now: T0 + HOUR + DONE_ACKNOWLEDGED_RETENTION_MS + HOUR }), { force: true });
  expect(readDoneMemory().settled.has("task:t-a")).toBe(true);
  const retire = T0 + HOUR + DONE_SETTLED_RETENTION_MS + HOUR;
  await projectDoneItems(ports({ ...state, now: retire }), { force: true });
  expect(readDoneMemory().settled.has("task:t-a")).toBe(false);
  resetDoneCollectionsForTests();
  await projectDoneItems(ports({ ...state, now: retire + HOUR }), { force: true });
  expect(keys()).toEqual([]);
  /* A later outcome is still a new item. */
  state.tasks = [accepted, task("t-b", "Пізніша", { status: "done", doneAt: iso(T0 + 2 * HOUR) })];
  await projectDoneItems(ports({ ...state, now: retire + 2 * HOUR }), { force: true });
  expect(keys()).toEqual(["task:t-b"]);
});

test("an accepted limit episode still open stays accepted when the Viewer was away longer than the history keeps", async () => {
  await activate();
  const DAY = 24 * HOUR;
  const t = (days: number) => Math.round((T0 + days * DAY) / 1000);
  const series = "claude|acct-b|weekly";
  const state = world({ now: T0 + DAY + HOUR, limits: { [series]: [{ t: t(0.5), remaining: 20 }, { t: t(1), remaining: 0 }] } });
  await projectDoneItems(ports(state), { force: true });
  acknowledgeDoneItems([`limit:claude:acct-b:weekly:${t(1)}`], { undo: false, surface: "desktop", now: T0 + DAY + HOUR });
  /* Back after twelve days: every sample left is newer than the last one seen, none shows room. */
  state.limits = { [series]: [{ t: t(5), remaining: 0 }, { t: t(12), remaining: 0 }] };
  await projectDoneItems(ports({ ...state, now: T0 + 12 * DAY }), { force: true });
  expect(keys()).toEqual([]);
});
