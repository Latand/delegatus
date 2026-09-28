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
