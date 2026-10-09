import { expect, test } from "bun:test";
import { buildNeedsYouQueue } from "@/components/attention/attentionQueue";
import { needsYouSections } from "@/components/attention/needsYouPanel";
import type { FileEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import { needsYouEntries, needsYouAnswer, needsYouEvidence, type NeedsYouEvidencePorts } from "./needsYouRead";

const now = Date.parse("2026-10-09T00:00:00Z") / 1000;
const at = new Date((now - 100) * 1000).toISOString();
const file = (id: string, extra: object = {}, project = "project-a") => ({ root: "claude-projects", name: id, path: id, project, title: id, kind: "session", engine: "claude", fmt: "claude",
  parent: null, mtime: now - 100, size: 1, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null, conversationId: `conversation_${id}`, ...extra }) as FileEntry;
const lane = (id: string, state: string) => ({ id, task: id, taskIds: ["task-a"], project: "project-a", state, createdAt: at, stages: [], runs: [], cursor: { stageId: null }, stateDetail: null }) as unknown as Pipeline;
export const fixture = () => ({ files: [
  file("seat", { bridgeAsks: [{ id: "ask-1", at, seq: 1, body: "Choose one" }, { id: "ask-2", at, seq: 2, body: "Choose two" }] }),
  file("question", { pendingQuestion: { kind: "question", toolUseId: "question-1", askedAt: at, questions: [{ header: "Which?" }] } }),
  file("plan", { pendingQuestion: { kind: "plan", toolUseId: "plan-1", askedAt: at } }),
  file("permission", { pendingPermission: { id: "permission-1", since: at, tool: "shell", command: "build" } }),
  file("scraped", { waitingInput: { since: now - 100, screenTail: "Allow?", menu: null } }),
  file("delivery", { stuckDelivery: { state: "delivery-uncertain", since: at } }),
  file("spawn:launch-a", { spawn: { state: "failed", admittedAt: (now - 100) * 1000, error: "launch failed" } }),
  file("memory", { memoryKill: { at } }),
  file("ask", { operatorAsk: { id: "operator-ask", messageAt: (now - 100) * 1000, gist: "Choose a variant", state: "open" } }),
  file("other", { waitingInput: { since: now - 100 } }, "project-b"),
], pipelines: [lane("decision", "needs_decision"), lane("review", "needs_review")], tasks: [
  { id: "task-a", project: "project-a", text: "Layout", status: "assigned", assignments: [], prototypeReview: { latestReviewId: "round-a", waitingReviewId: "round-a", rounds: 1, title: "Layout", createdAt: at } } as unknown as BoardTask,
] });
const decision = { id: "update-a", project: "project-a", at, blockers: null };
const ports = (body = fixture()): NeedsYouEvidencePorts => ({ tasks: body.tasks, pipelines: body.pipelines, dismissals: [], reports: null, admissions: [], unavailable: [] });

test("the project read equals the panel projection in order, covering every row kind", () => {
  const body = fixture();
  const expected = needsYouSections(buildNeedsYouQueue(body.files, body.pipelines, now, [], decision, body.tasks), "project-a").find(s => s.project === "project-a")!.entries;
  const actual = needsYouEntries(body, decision, now, "project-a");
  expect(actual.map(r => r.id)).toEqual(expected.map(r => r.id));
  const answer = needsYouAnswer(body, decision, now, "project-a", ports(body));
  expect(new Set(answer.rows.map(r => r.kind))).toEqual(new Set(["decision", "question", "plan", "permission", "delivery", "launch", "memory", "ask", "lane-decision", "lane-review", "prototype", "update"]));
  expect(answer.rows.find(r => r.kind === "update")).toMatchObject({ target: null, stale: false });
  expect(answer.rows.filter(r => r.kind === "decision").map(r => r.target)).toEqual([{ kind: "report", seq: 1 }, { kind: "report", seq: 2 }]);
});


test("later messages, turns, settled hosts, task and lane evidence are facts; missing sources imply nothing", () => {
  const body = fixture();
  const question = body.files.find(f => f.name === "question")!;
  question.proc = "done";
  question.lastTurn = { startedAt: (now - 50) * 1000, endedAt: (now - 40) * 1000 } as FileEntry["lastTurn"];
  question.durableLineage = { memberships: [{ kind: "pipeline", containerId: "decision" }] } as FileEntry["durableLineage"];
  const lane = body.pipelines[0]!;
  lane.state = "completed";
  const task = body.tasks[0]!;
  task.status = "done";
  task.assignments = [{ path: question.path, conversationId: question.conversationId, at }] as BoardTask["assignments"];
  const facts = { ...ports(body), admissions: [{ conversationId: question.conversationId!, at: new Date((now - 40) * 1000).toISOString() }], unavailable: ["forge"] };
  const answer = needsYouAnswer(body, decision, now, "project-a", facts, { full: true });
  const row = answer.rows.find(r => r.kind === "question")!;
  expect(row.stale).toBe(true);
  expect(row.evidence.map(e => typeof e === "string" ? e : e.code)).toEqual(expect.arrayContaining(["operator-wrote", "later-turn", "ended", "task-done", "lane-moved"]));
  expect(answer.unavailable).toEqual(["forge"]);
  const fresh = needsYouAnswer(fixture(), decision, now, "project-a", { ...ports(), unavailable: ["liveness", "forge"] });
  expect(fresh.rows.filter(r => r.kind !== "update").every(r => !r.stale)).toBe(true);
});

test("a launch task is found by its launch identity and a later assignment is evidence of relaunch", () => {
  const body = fixture();
  body.tasks[0]!.assignments = [{ launchId: "launch-a", path: null, at }, { launchId: "launch-b", path: "later", at: new Date((now - 20) * 1000).toISOString() }] as BoardTask["assignments"];
  const answer = needsYouAnswer(body, null, now, "project-a", ports(body));
  const row = answer.rows.find(r => r.kind === "launch")!;
  expect(row.taskId).toBe("task-a");
  expect(row.evidence).toContain("relaunched: The task gained a later assignment");
});

test("a lane asks while one of its tasks is open, and known PR and merge states suggest it no longer asks", () => {
  const body = fixture();
  body.tasks[0]!.status = "done";
  body.tasks.push({ ...body.tasks[0]!, id: "task-b", status: "assigned" });
  body.pipelines[0]!.taskIds = ["task-a", "task-b"];
  const entry = needsYouEntries(body, null, now, "project-a").find(e => e.kind === "pipeline" && e.row.pipeline.id === "decision")!;
  expect(needsYouEvidence(entry, ports(body)).some(e => e.code === "task-done")).toBe(false);
});

test("pagination returns every row once, at most forty and twenty-four KB, with kind filters intact", () => {
  const base = fixture();
  const body = { ...base, files: Array.from({ length: 95 }, (_, n) => file(`question-${n}`, { title: "Питання ".repeat(120), pendingQuestion: { kind: "question", toolUseId: `q-${n}`, askedAt: at, questions: [{ header: "Обирайте ".repeat(40) }] } })), pipelines: [], tasks: [] };
  const facts = { ...ports(), tasks: [], pipelines: [] };
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const page = needsYouAnswer(body, null, now, "project-a", facts, { cursor, kinds: ["question"] });
    expect(page.rows.length).toBeLessThanOrEqual(40);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(24_000);
    ids.push(...page.rows.map(r => r.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toHaveLength(95);
  expect(new Set(ids).size).toBe(95);
});


test("forge, merge and newer work are stale hints; lane detail and update blockers remain context", () => {
  const body = fixture();
  const entry = needsYouEntries(body, null, now, "project-a").find(e => e.kind === "pipeline")!;
  if (entry.kind !== "pipeline") throw new Error("fixture has no lane");
  const lane = entry.row.pipeline;
  lane.stateDetail = "An operator decision is still requested";
  const held = ports(body);
  expect(needsYouEvidence(entry, held)).toMatchObject([{ code: "detail", stale: false }]);
  for (const state of ["merged", "closed"] as const) {
    const evidence = needsYouEvidence(entry, { ...held, workLinks: { pipelines: { [lane.id]: { links: [{ state, checkedAt: at }] } }, tasks: {} } as never });
    expect(evidence).toEqual(expect.arrayContaining([expect.objectContaining({ code: `pr-${state}`, stale: true, at })]));
  }
  lane.merge = { state: "waiting-checks", updatedAt: at } as Pipeline["merge"];
  expect(needsYouEvidence(entry, held).some(e => e.code === "merge-queued" && e.stale)).toBe(true);
  body.pipelines.push({ ...lane, id: "new-lane", createdAt: new Date((now - 5) * 1000).toISOString() });
  expect(needsYouEvidence(entry, ports(body)).some(e => e.code === "newer-work" && e.stale)).toBe(true);
});

test("prototype evidence names later decisions and stages without making a choice", () => {
  const body = fixture();
  const entry = needsYouEntries(body, null, now, "project-a").find(e => e.kind === "prototype")!;
  body.tasks[0]!.prototypeReviews = [
    { id: "round-a", source: { pipelineId: "decision", stageId: "design" } },
    { id: "round-b", source: {}, decision: { at, chosen: [1] } },
  ] as BoardTask["prototypeReviews"];
  body.pipelines[0]!.state = "completed";
  const facts = needsYouEvidence(entry, ports(body));
  expect(facts).toEqual(expect.arrayContaining([expect.objectContaining({ code: "later-round-decided", stale: true }), expect.objectContaining({ code: "lane-moved-past", stale: true })]));
});


test("the report's bounded read finds stale rows beyond the first panel page", () => {
  const base = fixture();
  const body = { ...base, files: Array.from({ length: 60 }, (_, n) => file(`question-${n}`, { pendingQuestion: { kind: "question", toolUseId: `q-${n}`, askedAt: at, questions: [{ header: "Choose" }] }, ...(n === 59 ? { proc: "done" } : {}) })), pipelines: [], tasks: [] };
  const facts = { ...ports(), tasks: [], pipelines: [] };
  expect(needsYouAnswer(body, null, now, "project-a", facts).rows.some(r => r.stale)).toBe(false);
  const report = needsYouAnswer(body, null, now, "project-a", facts, {}, "stale-first");
  expect(report.rows[0]).toMatchObject({ id: "q-59", stale: true });
  expect(report.count).toBe(60);
  expect(report.staleCount).toBe(1);
});
