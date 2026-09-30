import { expect, test } from "bun:test";

import { summarizePipeline } from "@/components/kanban/pipelineSummary";
import { buildPipeline } from "@/lib/pipelines/store";
import type { Pipeline, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { AgentFeed, acceptAgents, encodeCursor, receivedAgentRows, receivedLaneRows, type AgentRow } from "./agentFeed";
import { decodeLaneRow, laneRowsFor, MAX_LANE_ROW_BYTES, type LaneRow } from "./laneFeed";

const project = `repo-${"a".repeat(32)}`;
const projects = new Set([project]);
const SENTINEL = "LANE-SECRET-SENTINEL";
const taskId = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const task = (n: number, extra: Partial<BoardTask> = {}) => ({ id: taskId(n), project, text: `${SENTINEL} task ${n}`, status: "assigned", assignments: [], ...extra }) as unknown as BoardTask;

type StageSpec = { id: string; role?: "builder" | "reviewer"; kind?: "run" | "review-loop"; next?: string | null; onFail?: { to: string; maxRounds: number }; attempt?: PipelineStageAttempt["state"]; findings?: string[]; attempts?: number };
function lane(id: string, taskIds: string[], state: Pipeline["state"], specs: StageSpec[], at = Date.now()): Pipeline {
  const stages = specs.map((spec) => ({
    id: spec.id, kind: spec.kind ?? "run", role: spec.role ? { roleId: spec.role } : undefined, prompt: `${SENTINEL} prompt`, next: spec.next ?? null, onFail: spec.onFail ?? null,
    effectiveRole: { roleId: spec.role ?? null, engine: "codex", model: "gpt-6.1-sol", effort: "medium", access: "read-write", promptScaffold: `${SENTINEL} scaffold` },
  })) as unknown as PipelineStage[];
  const pipeline = buildPipeline({ id, task: `${SENTINEL} task`, taskIds, project: "p", repoDir: "/repo", stages, srcPath: null, srcConversationId: null, now: new Date(at).toISOString() });
  pipeline.spec = `${SENTINEL} spec`;
  pipeline.state = state;
  pipeline.runs = specs.map((spec) => ({ stageId: spec.id, attempts: spec.attempt ? Array.from({ length: spec.attempts ?? 1 }, (_v, index) => ({
    n: index + 1, state: index + 1 === (spec.attempts ?? 1) ? spec.attempt! : "passed", effectiveRole: pipeline.stages.find((stage) => stage.id === spec.id)!.effectiveRole,
    launchId: null, conversationId: `${SENTINEL}-conversation`, sessionId: null, agentPath: `/${SENTINEL}/t.jsonl`, paneId: null, flowId: null,
    startedAt: new Date(at).toISOString(), completedAt: null, input: `${SENTINEL} input`, activatedBy: null, output: `${SENTINEL} output`,
    verdict: spec.findings ? { status: "fail", findings: spec.findings.map((text) => `${SENTINEL} ${text}`) } : null, error: null,
  })) : [] })) as unknown as Pipeline["runs"];
  return pipeline;
}
const three = (id: string, taskIds: string[], state: Pipeline["state"] = "running", at = Date.now()) => lane(id, taskIds, state, [
  { id: "build", role: "builder", next: "review", attempt: "passed" },
  { id: "review", role: "reviewer", next: null, onFail: { to: "fix", maxRounds: 2 }, attempt: "failed", attempts: 2, findings: ["one", "two"] },
  { id: "fix", role: "builder", next: null, attempt: "running" },
], at);
const hex = (n: number) => n.toString(16).padStart(8, "0");
const owns = () => true;

test("a lane row carries the chips the owner's own board draws, and nothing a prompt or a finding wrote", () => {
  const pipeline = three("5e0a41c2", [taskId(1)], "needs_decision");
  const [row] = laneRowsFor(() => [pipeline], [task(1)], projects, owns);
  expect(row).toBeDefined();
  expect(row!.k).toBe("l:5e0a41c2");
  expect(row!.tk).toEqual([taskId(1)]);
  const chips = summarizePipeline(pipeline).chips;
  expect(row!.g.map((stage) => [stage.id, stage.st, Boolean(stage.b)])).toEqual(chips.map((chip) => [chip.stage.id, chip.state, chip.branch]));
  expect(row!.g.find((stage) => stage.id === "review")).toMatchObject({ n: 2, fc: 2, f: { to: "fix", max: 2 } });
  expect(row!.g.find((stage) => stage.id === "build")).toMatchObject({ e: "codex", m: "gpt-6.1-sol", ro: "builder" });
  expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(700);
  expect(JSON.stringify(row)).not.toContain(SENTINEL);
  expect(decodeLaneRow(JSON.parse(JSON.stringify(row)), projects)).toEqual(row!);
});

test("drafts, archived-shaped rows, other machines' tasks and unlinked projects publish nothing; a lane serving two tasks lists both", () => {
  const draft = three("0000aaaa", [taskId(1)], "draft");
  const both = three("0000bbbb", [taskId(1), taskId(2), taskId(9)]);
  const foreign = three("0000cccc", [taskId(3)]);
  const other = { ...task(4), project: `repo-${"b".repeat(32)}` } as BoardTask;
  const rows = laneRowsFor(() => [draft, both, foreign, three("0000dddd", [taskId(4)])], [task(1), task(2), task(3, { machine: "elsewhere" } as never), other], projects, (item) => item.machine === undefined);
  expect(rows.map((row) => row.k)).toEqual(["l:0000bbbb"]);
  expect(rows[0]!.tk).toEqual([taskId(1), taskId(2)]);
});

test("300 eligible lanes publish 200, open before ended, at most three a task", () => {
  const tasks = Array.from({ length: 100 }, (_v, n) => task(n + 1));
  const pipelines: Pipeline[] = [];
  for (let n = 0; n < 300; n++) pipelines.push(three(hex(n + 1), [taskId((n % 100) + 1)], n < 150 ? "completed" : "running", 1_700_000_000_000 + n));
  const rows = laneRowsFor(() => pipelines, tasks, projects, owns);
  expect(rows).toHaveLength(200);
  const perTask = new Map<string, number>();
  for (const row of rows) for (const id of row.tk) perTask.set(id, (perTask.get(id) ?? 0) + 1);
  expect(Math.max(...perTask.values())).toBe(2);
  expect(rows.slice(0, 150).every((row) => row.s === "running")).toBe(true);
  expect(rows.slice(150).every((row) => row.s === "completed")).toBe(true);
  const crowded = laneRowsFor(() => Array.from({ length: 7 }, (_v, n) => three(hex(n + 1), [taskId(1)], "running", 1_700_000_000_000 + n)), [task(1)], projects, owns);
  expect(crowded.map((row) => row.k)).toEqual(["l:00000007", "l:00000006", "l:00000005"]);
});

test("a row past the bounds is dropped alone: nine stages, 4 097 bytes, a fail edge to nowhere, an unknown state, a foreign project", () => {
  const good = laneRowsFor(() => [three("5e0a41c2", [taskId(1)])], [task(1)], projects, owns)[0]!;
  expect(decodeLaneRow(good, projects)).toEqual(good);
  const nine = { ...good, g: Array.from({ length: 9 }, (_v, n) => ({ id: `s${n}`, st: "pending" })) };
  expect(decodeLaneRow(nine, projects)).toBeNull();
  expect(decodeLaneRow({ ...good, padding: "x".repeat(MAX_LANE_ROW_BYTES) }, projects)).toBeNull();
  expect(decodeLaneRow({ ...good, g: [{ ...good.g[0], f: { to: "nowhere", max: 2, u: 0 } }] }, projects)).toBeNull();
  expect(decodeLaneRow({ ...good, g: [{ ...good.g[0], st: "exploded" }] }, projects)).toBeNull();
  expect(decodeLaneRow({ ...good, s: "draft" }, projects)).toBeNull();
  expect(decodeLaneRow({ ...good, p: `repo-${"c".repeat(32)}` }, projects)).toBeNull();
  expect(decodeLaneRow({ ...good, g: [{ id: "a", st: "passed" }, { id: "a", st: "passed" }] }, projects)).toBeNull();
  expect(decodeLaneRow({ ...good, tk: [] }, projects)).toBeNull();
  const widest: LaneRow = { k: "l:ffffffff", p: project, tk: [taskId(1), taskId(2), taskId(3), taskId(4)], s: "needs_review", at: Number.MAX_SAFE_INTEGER,
    g: Array.from({ length: 8 }, (_v, n) => ({ id: `${"i".repeat(62)}${n}${n}`, ro: "r".repeat(64), lp: 1 as const, st: "needs_decision" as const, n: 999, r: 999, b: 1 as const,
      f: { to: `${"i".repeat(62)}00`, max: 99, u: 99 }, fc: 50, e: "e".repeat(64), m: "m".repeat(64) })) };
  expect(Buffer.byteLength(JSON.stringify(widest))).toBeLessThanOrEqual(MAX_LANE_ROW_BYTES);
  expect(decodeLaneRow(widest, projects)).toEqual(widest);
  // Unknown optional keys are projected away: a later version may add some.
  expect(decodeLaneRow({ ...good, future: { deep: 1 } }, projects)).toEqual(good);
});

const file = (n: number) => ({ conversationId: `conversation_${n}`, project, path: `/sandbox/${n}.jsonl`, title: "PROMPT", engine: "claude", model: "claude-opus-5", proc: "running", activity: "live",
  mtime: Math.floor(Date.now() / 1000), lastAgentWorkAt: Date.now(), pendingQuestion: null, waitingInput: null }) as unknown as FileEntry;

test("lanes share the agents part: one changed stage is one row, a lane that leaves is one marker, and a quiet pipeline write sends nothing", () => {
  let pipelines = [three("5e0a41c2", [taskId(1)])];
  let tasks = [task(1)];
  const feed = new AgentFeed("lanes-delta", () => [], () => tasks, () => pipelines, () => owns);
  const first = feed.page(null, projects);
  expect(first.reset).toBe(true);
  expect(first.rows).toHaveLength(1);
  // The same record in a new array (a heartbeat rewrite) changes no row.
  pipelines = [...pipelines];
  expect(feed.page(first.cursor, projects).rows).toBeUndefined();
  // The running stage passes: the lane's row is the only change.
  pipelines = [lane("5e0a41c2", [taskId(1)], "completed", [
    { id: "build", role: "builder", next: "review", attempt: "passed" },
    { id: "review", role: "reviewer", next: null, onFail: { to: "fix", maxRounds: 2 }, attempt: "failed", attempts: 2, findings: ["one", "two"] },
    { id: "fix", role: "builder", next: null, attempt: "passed" },
  ])];
  const moved = feed.page(first.cursor, projects);
  expect(moved.rows).toHaveLength(1);
  expect((moved.rows![0] as LaneRow).g.find((stage) => stage.id === "fix")!.st).toBe("passed");
  // The task is handed to the peer: this machine stops publishing its lane.
  tasks = [task(1, { machine: "elsewhere" } as never)];
  const handed = new AgentFeed("lanes-delta-2", () => [], () => tasks, () => pipelines, () => (item) => item.machine === undefined);
  expect(handed.page(null, projects).rows).toEqual([]);
  pipelines = [];
  tasks = [task(1), task(2)];
  expect(feed.page(moved.cursor, projects).rows).toEqual([{ k: "l:5e0a41c2", gone: true }]);
});

test("200 agents and 200 lanes reset in pages of at most 50 entries and 80 KB, and a receiver keeps both kinds apart", () => {
  const keys = Array.from({ length: 4 }, (_v, n) => `repo-${(n + 1).toString(16).repeat(32)}`);
  const linked = new Set(keys);
  const tasks = Array.from({ length: 100 }, (_v, n) => task(n + 1, { project: keys[n % 4] } as never));
  const pipelines = Array.from({ length: 300 }, (_v, n) => three(hex(n + 1), [taskId((n % 100) + 1)], "running", 1_700_000_000_000 + n));
  const files = Array.from({ length: 500 }, (_v, n) => ({ ...file(n + 1), project: keys[n % 4] })) as FileEntry[];
  const feed = new AgentFeed("lane-pages", () => files, () => tasks, () => pipelines.map((row) => ({ ...row, project: "p" })), () => owns);
  const id = "lane-pages-receiver";
  let count = 0, pages = 0;
  for (let page = feed.page(null, linked);; page = feed.page(null, linked, count)) {
    pages++;
    expect(page.rows!.length).toBeLessThanOrEqual(50);
    expect(Buffer.byteLength(JSON.stringify(page.rows))).toBeLessThanOrEqual(80_000);
    count += page.rows!.length;
    expect(acceptAgents(id, { ...page, cursor: encodeCursor(page.cursor) }, linked)).toBe(true);
    if (!page.more) break;
    expect(receivedLaneRows(id)).toHaveLength(0);
  }
  expect(count).toBe(400);
  expect(pages).toBe(8);
  expect(receivedAgentRows(id)).toHaveLength(200);
  expect(receivedLaneRows(id)).toHaveLength(200);
});

test("a receiver holds at most 200 lane rows a link, the newest, through a reset of 250 and then churn", () => {
  const base = laneRowsFor(() => [three("5e0a41c2", [taskId(1)])], [task(1)], projects, owns)[0]!;
  const row = (n: number): LaneRow => ({ ...base, k: `l:${hex(n)}`, at: 1_700_000_000_000 + n });
  const id = "lane-cap-receiver";
  const send = (rows: unknown[], extra: { reset?: boolean; more?: boolean; version: number }) =>
    acceptAgents(id, { cursor: encodeCursor({ epoch: "00000000000000cc", version: extra.version }), rows, ...(extra.reset ? { reset: true } : {}), ...(extra.more ? { more: true } : {}) }, projects);
  for (let page = 0; page < 5; page++) {
    expect(send(Array.from({ length: 50 }, (_v, n) => row(page * 50 + n + 1)), { reset: page === 0, more: page < 4, version: 1 })).toBe(true);
  }
  expect(receivedLaneRows(id)).toHaveLength(200);
  expect(new Set(receivedLaneRows(id).map((lane) => lane.k)).has(`l:${hex(1)}`)).toBe(false);
  expect(new Set(receivedLaneRows(id).map((lane) => lane.k)).has(`l:${hex(250)}`)).toBe(true);
  // Churn: fifty lanes leave, then fifty arrive; the held set returns to the cap and never passes it.
  const gone = Array.from({ length: 50 }, (_v, n) => ({ k: `l:${hex(n + 51)}`, gone: true }));
  expect(send(gone, { version: 2 })).toBe(true);
  expect(receivedLaneRows(id)).toHaveLength(150);
  expect(send(Array.from({ length: 50 }, (_v, n) => row(n + 251)), { version: 3 })).toBe(true);
  expect(receivedLaneRows(id)).toHaveLength(200);
  expect(Buffer.byteLength(JSON.stringify(receivedLaneRows(id)))).toBeLessThanOrEqual(200 * MAX_LANE_ROW_BYTES);
});

test("a page stops before the entry that would pass 80 KB, and every entry still arrives", () => {
  const big = (n: number): AgentRow => ({ k: `a:${n.toString(16).padStart(16, "0")}`, p: project, t: "x".repeat(120), e: "claude", m: "m", st: "done", at: n });
  const rows = Array.from({ length: 50 }, (_v, n) => big(n + 1));
  const cut = (AgentFeed as unknown as { cut: <T>(items: readonly T[], start: number) => T[] }).cut;
  expect(cut(rows, 0)).toHaveLength(50);
  const fat = Array.from({ length: 50 }, (_v, n) => ({ ...big(n + 1), t: "x".repeat(2_000) }));
  const first = cut(fat, 0);
  expect(first.length).toBeLessThan(50);
  expect(first.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(80_000);
  expect(cut(fat, first.length)[0]).toEqual(fat[first.length]);
});

test("the receiver ignores a lane marker for an agent key, and an old peer's agent rows pass untouched beside lane rows", () => {
  const agent: AgentRow = { k: `a:${"f".repeat(16)}`, p: project, t: "claude agent", e: "claude", m: "m", st: "working", at: Date.now() };
  const laneRow = laneRowsFor(() => [three("5e0a41c2", [taskId(1)])], [task(1)], projects, owns)[0]!;
  const id = "mixed-receiver";
  expect(acceptAgents(id, { cursor: "0000000000000000:1", reset: true, rows: [agent, laneRow, { k: "l:zzzzzzzz", p: project }, { k: "l:0badc0de", gone: true }] }, projects)).toBe(true);
  expect(receivedAgentRows(id)).toEqual([agent]);
  expect(receivedLaneRows(id)).toEqual([laneRow]);
  expect(acceptAgents(id, { cursor: "0000000000000000:2", rows: [{ k: laneRow.k, gone: true }] }, projects)).toBe(true);
  expect(receivedLaneRows(id)).toEqual([]);
  expect(receivedAgentRows(id)).toEqual([agent]);
});
