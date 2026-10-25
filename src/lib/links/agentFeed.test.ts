import { expect, test } from "bun:test";
import { AgentFeed, acceptAgents, decodeAgentRow, encodeCursor, receivedAgentRows, remoteAgents, type AgentRow } from "./agentFeed";
import type { FileEntry } from "@/lib/types";

const a = `repo-${"a".repeat(32)}`;
const b = `repo-${"b".repeat(32)}`;
const other = `repo-${"c".repeat(32)}`;
const projects = new Set([a, b]);
const timestamp = Date.now();
const file = (n: number, project = a, state: "running" | "done" = "running") => ({
  conversationId: `conversation_${n}`, project, path: `/sandbox/conversation-${n}.jsonl`, title: `PROMPT-CANARY-${n}`,
  engine: "claude", model: "claude-opus-5", proc: state, activity: state === "running" ? "live" : "idle",
  mtime: Math.floor(timestamp / 1000), lastAgentWorkAt: timestamp, pendingQuestion: null, waitingInput: null,
}) as unknown as FileEntry;

test("agent summaries are bounded per project and globally, hide scanned prompts and paths, and change one row", () => {
  let snapshot: FileEntry[] = [file(1), file(2, b), file(3, other)];
  const feed = new AgentFeed("fixture", () => snapshot, () => []);
  const first = feed.page(null, projects);
  expect(first.reset).toBe(true);
  expect(first.rows).toHaveLength(2);
  for (const row of first.rows as AgentRow[]) expect(row.t).toBe("claude agent");
  const encoded = JSON.stringify(first);
  expect(encoded).not.toContain("PROMPT-CANARY");
  expect(encoded).not.toContain("/sandbox/");
  expect(encoded).not.toContain("conversation_");
  expect((first.rows as AgentRow[]).map((row) => row.p).sort()).toEqual([a, b]);
  snapshot = [file(1, a, "done"), file(2, b), file(3, other)];
  const changed = feed.page(first.cursor, projects);
  expect(changed.rows).toHaveLength(1);
  expect((changed.rows![0] as AgentRow).st).toBe("done");
  snapshot = [file(2, b)];
  const ended = feed.page(changed.cursor, projects);
  expect(ended.rows).toEqual([{ k: (first.rows as AgentRow[]).find((row) => row.p === a)!.k, gone: true }]);
  snapshot = Array.from({ length: 500 }, (_, n) => file(n + 100, n < 300 ? a : b));
  const reset = feed.page(null, projects);
  expect(reset.rows).toHaveLength(50);
  let rows = reset.rows!.length;
  let page = reset;
  while (page.more) { page = feed.page(null, projects, rows); rows += page.rows?.length ?? 0; }
  expect(rows).toBe(100);
  expect(feed.page(page.cursor, projects).rows).toBeUndefined();
  const twenty = new Set(Array.from({ length: 20 }, (_, n) => `repo-${(n + 1).toString(16).padStart(32, "0")}`));
  const many = Array.from({ length: 500 }, (_, n) => file(n + 1_000, [...twenty][n % 20]!));
  const global = new AgentFeed("global-bound", () => many, () => []);
  global.refresh(twenty);
  expect(global.sizes()).toEqual({ rows: 200, markers: 0 });
});

test("receiver drops a row for a project outside this link", () => {
  const row: AgentRow = { k: `a:${"f".repeat(16)}`, p: a, t: "claude agent", e: "claude", m: "claude-opus-5", st: "working", at: Date.now() };
  expect(decodeAgentRow({ ...row, p: other }, projects)).toBeNull();
  expect(decodeAgentRow(row, projects)).toEqual(row);
  expect(decodeAgentRow({ ...row, transcriptPath: "/private/transcript.jsonl", account: "fixture-account" }, projects)).toEqual(row);
  expect(acceptAgents("fixture-receiver", { cursor: "0000000000000000:1", reset: true, rows: [row, { ...row, k: `a:${"e".repeat(16)}`, p: other }] }, projects)).toBe(true);
  // A receiver's project view is additionally fenced by its live link, so an
  // unpaired fixture has no visible remote row.
  expect(remoteAgents(a)).toEqual([]);
});

test("a peer refresh reads task assignments once across all scanned agents", () => {
  const count = 240;
  let assignmentReads = 0;
  const tasks = Array.from({ length: count }, (_, n) => ({
    id: `task-${n}`, project: a, chosen: false,
    get assignments() { assignmentReads++; return [{ path: `/unrelated/${n}.jsonl` }]; },
  }));
  const files = Array.from({ length: count }, (_, n) => file(n));
  const feed = new AgentFeed("assignment-budget", () => files, () => tasks as never, () => [], () => () => false,
    { snapshot: () => ({ conversations: {}, memberships: {}, lineageEdges: {} }), seats: () => [], canonical: p => p });
  const page = feed.page(null, projects);
  expect(page.rows).toHaveLength(50);
  console.info("peer task assignment reads", assignmentReads);
  expect(assignmentReads).toBeLessThanOrEqual(count * 2);
});

test("a peer with no shared projects reads no agent assignments or registry", () => {
  const tasks = [{ project: a, get assignments(): never[] { throw new Error("unshared task assignments must stay unread"); } }];
  const feed = new AgentFeed("no-shared-projects", () => [file(1)], () => tasks as never, () => [], () => () => false,
    { snapshot: () => { throw new Error("unshared registry must stay unread"); }, seats: () => [] });
  expect(feed.page(null, new Set()).rows).toEqual([]);
});

test("expired non-seat agents need no task assignments", () => {
  const old = { ...file(1, a, "done"), lastAgentWorkAt: timestamp - 172_800_000 };
  const tasks = [{ project: a, get assignments(): never[] { throw new Error("expired agents need no task lookup"); } }];
  const feed = new AgentFeed("expired", () => [old], () => tasks as never, () => [], () => () => false,
    { snapshot: () => ({ conversations: {}, memberships: {}, lineageEdges: {} }), seats: () => [] });
  expect(feed.page(null, projects).rows).toEqual([]);
});

test("task attribution preserves first task order across id/path ties and pipeline bindings", () => {
  const first = file(501);
  const second = file(502);
  const tasks = [
    { id: "path-first", project: a, assignments: [{ path: first.path }] },
    { id: "id-second", project: b, assignments: [{ conversationId: first.conversationId }] },
    { id: "pipeline-first", project: a, assignments: [] },
    { id: "pipeline-second", project: b, assignments: [] },
  ];
  const pipeline = { id: "pipeline", taskIds: ["pipeline-second", "pipeline-first"], stages: [], runs: [] };
  const feed = new AgentFeed("task-order", () => [first, second], () => tasks as never, () => [pipeline] as never, () => () => false,
    { snapshot: () => ({ conversations: {}, lineageEdges: {}, memberships: {
      [second.conversationId!]: [{ kind: "pipeline", containerId: "pipeline", stageId: "build" }],
    } }) as never, seats: () => [], canonical: p => p });
  const rows = feed.page(null, projects).rows as AgentRow[];
  expect(rows.map(row => row.task).sort()).toEqual(["path-first", "pipeline-first"]);
  expect(rows.every(row => row.p === a)).toBe(true);
});

test("last path owner and any owner's current-generation priority survive overlapping paths", () => {
  const shared = { ...file(601), path: "/shared.jsonl", model: "shared", lastAgentWorkAt: timestamp + 1 };
  const current = { ...file(602), path: "/current.jsonl", model: "current", lastAgentWorkAt: timestamp };
  const snapshot = { conversations: {
    earlier: { id: "earlier", generations: [{ path: shared.path }] },
    later: { id: "later", generations: [{ path: shared.path }, { path: current.path }] },
  }, memberships: {}, lineageEdges: {} };
  const feed = new AgentFeed("overlap", () => [shared, current], () => [], () => [], () => () => false,
    { snapshot: () => snapshot as never, seats: () => [], canonical: p => p });
  const rows = feed.page(null, projects).rows as AgentRow[];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.m).toBe("shared");
});

test("supported agent engines publish only neutral bounded summaries", () => {
  const snapshot = (["claude", "codex", "copilot", "openclaw", "shell"] as const).map((engine, index) => ({ ...file(index + 900), engine, model: `model-${engine}` })) as FileEntry[];
  const rows = new AgentFeed("engines", () => snapshot, () => []).page(null, projects).rows as AgentRow[];
  expect(rows.map((row) => row.e).sort()).toEqual(["claude", "codex", "copilot", "openclaw"]);
  for (const row of rows) {
    expect(row.t).toBe(`${row.e} agent`);
    expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThanOrEqual(1536);
    expect(Object.keys(row).sort()).toEqual(["at", "e", "k", "m", "p", "st", "t"]);
  }
  expect(JSON.stringify(rows)).not.toContain("PROMPT-CANARY");
  expect(JSON.stringify(rows)).not.toContain("/sandbox/");
});

test("ten thousand start and stop cycles retain at most 200 markers", () => {
  let snapshot: FileEntry[] = [];
  const feed = new AgentFeed("churn", () => snapshot, () => []);
  for (let n = 0; n < 10_000; n++) {
    snapshot = [file(n)]; feed.refresh(projects);
    snapshot = []; feed.refresh(projects);
  }
  expect(feed.sizes()).toEqual({ rows: 0, markers: 200 });
  expect(feed.page({ epoch: "0000000000000000", version: 0 }, projects).reset).toBe(true);
});

test("200 summaries reset in four 50-row pages, and the receiver swaps only on the last page", () => {
  const keys = Array.from({ length: 4 }, (_, n) => `repo-${(n + 1).toString(16).repeat(32)}`);
  const linked = new Set(keys);
  const snapshot = Array.from({ length: 500 }, (_, n) => file(n + 20_000, keys[Math.floor(n / 125)]));
  const feed = new AgentFeed("four-pages", () => snapshot, () => []);
  const first = feed.page(null, linked);
  expect(first.reset).toBe(true);
  expect(feed.page(null, linked)).toEqual(first);
  const id = "four-pages-receiver";
  for (let page = first, count = 1; ; page = feed.page(null, linked, count * 50), count++) {
    expect(page.rows).toHaveLength(50);
    expect(page.rows!.every((row) => Buffer.byteLength(JSON.stringify(row)) <= 1536)).toBe(true);
    expect(acceptAgents(id, { ...page, cursor: encodeCursor(page.cursor) }, linked)).toBe(true);
    if (count === 1) expect(acceptAgents(id, { rows: page.rows, cursor: "ffffffffffffffff:1", more: true }, linked)).toBe(false);
    if (page.more) expect(receivedAgentRows(id)).toHaveLength(0);
    else { expect(count).toBe(4); break; }
  }
  expect(receivedAgentRows(id)).toHaveLength(200);
  // A lost final response starts a fresh reset after its page array is freed.
  const retriedFinal = feed.page(null, linked, 150);
  expect(retriedFinal.reset).toBe(true);
  expect(retriedFinal.rows).toHaveLength(50);
  let current = snapshot;
  const changing = new AgentFeed("delta-two-pages", () => current, () => []);
  const original = changing.page(null, linked);
  // A new array identity is the scanner's completed-generation boundary.
  current = current.map((entry) => ({ ...entry, proc: "done", activity: "idle" })) as FileEntry[];
  const firstDelta = changing.page(original.cursor, linked);
  expect(firstDelta.rows).toHaveLength(50);
  expect(firstDelta.more).toBe(true);
  expect(changing.page(firstDelta.cursor, linked).rows).toHaveLength(50);
});


test("raw scan paths join registry continuity, role, task and pipeline without undefined-id matches", () => {
  const raw = { ...file(77), conversationId: undefined } as FileEntry;
  const snapshot = { conversations: { worker: { id: "worker", engine: "claude", agentRole: "deployer", generations: [], continuityPaths: [raw.path] } }, lineageEdges: {}, memberships: { worker: [{ kind: "pipeline", containerId: "lane", stageId: "deploy" }] } };
  const pipeline = { id: "lane", state: "running", taskIds: ["release"], stages: [{ id: "deploy" }], runs: [{ stageId: "deploy", attempts: [{ conversationId: "worker", state: "running" }] }] };
  const tasks = [{ id: "wrong", project: b, assignments: [{ path: "/unrelated" }] }, { id: "release", project: other, assignments: [], chosen: false }];
  let reads = 0;
  const feed = new AgentFeed("raw", () => [raw], () => tasks as never, () => [pipeline] as never, () => () => false,
    { snapshot: () => { reads++; return snapshot as never; }, seats: () => [], canonical: (p: string) => p === other ? a : p });
  const row = feed.page(null, projects).rows![0] as AgentRow;
  expect(row).toMatchObject({ p: a, task: "release", ro: "deployer", t: "deploy stage", pl: { id: "lane", stage: "deploy", stageState: "running" } });
  expect(reads).toBe(1);
});

test.each(["conversation", "path", "both"])("raw scan snapshot rows recover pipeline and task from the persisted attempt by %s", (match) => {
  const raw = file(78);
  const pipeline = {
    id: "lane", state: "running", taskIds: ["release"], stages: [{ id: "build" }],
    runs: [{ stageId: "build", attempts: [{
      ...(match !== "path" ? { conversationId: raw.conversationId } : {}),
      ...(match !== "conversation" ? { agentPath: raw.path } : {}), state: "running",
    }] }],
  };
  const tasks = [{ id: "release", project: a, assignments: [], chosen: false }];
  const feed = new AgentFeed("raw-pipeline-attempt", () => [raw], () => tasks as never, () => [pipeline] as never, () => () => false,
    { snapshot: () => ({ conversations: {}, memberships: {}, lineageEdges: {} }), seats: () => [] });

  expect(feed.page(null, projects).rows![0]).toMatchObject({
    task: "release", t: "build stage", pl: { id: "lane", stage: "build", stageState: "running" },
  });
  const unrelated = new AgentFeed("unrelated-pipeline-attempt", () => [file(79)], () => tasks as never, () => [pipeline] as never, () => () => false,
    { snapshot: () => ({ conversations: {}, memberships: {}, lineageEdges: {} }), seats: () => [] });
  const row = unrelated.page(null, projects).rows![0];
  expect(row).toMatchObject({ t: "claude agent" });
  expect(row).not.toHaveProperty("task");
  expect(row).not.toHaveProperty("pl");
});

test("designated old seat survives age and fifty-row priority and idle refresh reads no snapshot", () => {
  const old = { ...file(88, a, "done"), conversationId: undefined, lastAgentWorkAt: timestamp - 172_800_000 } as FileEntry;
  const files = [old, ...Array.from({ length: 60 }, (_, n) => file(n + 100))];
  let reads = 0;
  let seatReads = 0;
  const snapshot = { conversations: { seat: { id: "seat", agentRole: "orchestrator", generations: [{ path: old.path }], continuityPaths: [] } }, lineageEdges: {}, memberships: {} };
  const tasks: never[] = [];
  const pipelines: never[] = [];
  const feed = new AgentFeed("old-seat", () => files, () => tasks, () => pipelines, () => () => false,
    { snapshot: () => { reads++; return snapshot as never; }, seats: () => { seatReads++; return [{ project: a, conversationId: "seat" }]; } });
  const first = feed.page(null, projects);
  expect(first.rows).toHaveLength(50);
  expect(first.rows!.some((row) => "seat" in row && row.seat === 1 && "t" in row && row.t === "orchestrator")).toBe(true);
  expect(feed.page(first.cursor, projects).rows).toBeUndefined();
  expect(reads).toBe(1);
  expect(seatReads).toBe(1);
});

test("receiver validates and retains optional role and designated seat", () => {
  const row = { k: `a:${"d".repeat(16)}`, p: a, t: "orchestrator", e: "claude", m: "unknown", st: "waiting", at: timestamp, ro: "orchestrator", seat: 1 };
  expect(decodeAgentRow(row, projects)).toEqual(row as never);
  for (const extra of [{ ro: "bad role" }, { ro: "x".repeat(65) }, { seat: 0 }, { seat: true }]) expect(decodeAgentRow({ ...row, ...extra }, projects)).toBeNull();
});


test("raw generation paths match explicit assignment ids and lineage roles without exposing registry text", () => {
  const raw = { ...file(99), conversationId: undefined } as FileEntry;
  const snapshot = { conversations: { worker: { id: "worker", generations: [{ path: raw.path }], continuityPaths: [], agentRole: null } }, lineageEdges: { worker: { role: "reviewer" } }, memberships: {} };
  const tasks = [{ id: "wrong", project: b, assignments: [{ path: "/unrelated" }] }, { id: "review", project: a, assignments: [{ conversationId: "worker" }], chosen: false }];
  const row = new AgentFeed("direct-id", () => [raw], () => tasks as never, () => [], () => () => false,
    { snapshot: () => snapshot as never, seats: () => [] }).page(null, projects).rows![0];
  expect(row).toMatchObject({ task: "review", ro: "reviewer", t: "reviewer agent", p: a });
  expect(JSON.stringify(row)).not.toContain(raw.path);
  expect(JSON.stringify(row)).not.toContain("worker");
});

test("receiver keeps an older designated seat when trimming a project to fifty", () => {
  const rows = Array.from({ length: 50 }, (_, n) => ({ k: `a:${n.toString(16).padStart(16, "0")}`, p: a, t: "agent", e: "codex", m: "unknown", st: "done", at: timestamp }));
  const id = "priority-receiver";
  expect(acceptAgents(id, { reset: true, more: true, cursor: "0000000000000000:1", rows }, projects)).toBe(true);
  const seat = { ...rows[0], k: `a:${"e".repeat(16)}`, t: "orchestrator", at: timestamp - 172_800_000, ro: "orchestrator", seat: 1 };
  expect(acceptAgents(id, { cursor: "0000000000000000:1", rows: [seat] }, projects)).toBe(true);
  expect(receivedAgentRows(id)).toHaveLength(50);
  expect(receivedAgentRows(id).find((row) => row.seat === 1)).toEqual(seat as never);
});


test("one conversation publishes the newest generation when multiple transcript paths are scanned", () => {
  const project = `repo-${"a".repeat(32)}`;
  const id = "conversation_multi";
  const snapshot = { conversations: { [id]: { id, agentRole: "deployer", generations: [{ path: "/fixture/old.jsonl" }, { path: "/fixture/new.jsonl" }] } }, memberships: {}, lineageEdges: {} };
  const files = [
    { engine: "codex", path: "/fixture/new.jsonl", project, mtime: Date.now() / 1000, model: "current-model", proc: "running", activity: "live" },
    { engine: "codex", path: "/fixture/old.jsonl", project, mtime: (Date.now() - 60_000) / 1000, model: "older-model", proc: "stopped", activity: "idle" },
  ];
  const feed = new AgentFeed("multi", () => files as never, () => [], () => [], () => () => true, { snapshot: () => snapshot as never, seats: () => [] });
  const rows = feed.page(null, new Set([project])).rows as AgentRow[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ m: "current-model", st: "working" });
});


test("a designated seat is present before its transcript reaches the scan cache", () => {
  const snapshot = { conversations: { seat: { id: "seat", engine: "codex", agentRole: "orchestrator", generations: [{ path: "/fixture/pending.jsonl", createdAt: new Date(timestamp).toISOString(), launchProfile: { model: "fixture-model" } }], turn: { state: "unknown" } } }, memberships: {}, lineageEdges: {} };
  const files: FileEntry[] = [];
  const tasks: never[] = [];
  const feed = new AgentFeed("unscanned-seat", () => files, () => tasks, () => [], () => () => false,
    { snapshot: () => snapshot as never, seats: () => [{ project: a, conversationId: "seat" }] });
  const rows = feed.page(null, projects).rows as AgentRow[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ p: a, seat: 1, ro: "orchestrator", t: "orchestrator", e: "codex" });
  expect(JSON.stringify(rows)).not.toContain("pending.jsonl");
});
