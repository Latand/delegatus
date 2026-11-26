import { expect, test } from "bun:test";

import { needsDecisionPipelineRows } from "@/components/mobile/mobileBoardModel";
import { stampAttentionRoutes, type AttentionRoutingInputs } from "@/lib/attention/routing";
import type { Pipeline } from "@/lib/pipelines/types";
import type { PrototypeReviewNotice } from "@/lib/prototypeReview/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { advanceAttentionCycle, buildAttentionQueue } from "../attention";
import { attentionEntryProject, buildMobileAttentionQueue, buildNeedsYouQueue, laneFocusId, laneFocusPath, needsYouHolds, type MobileAttentionEntry } from "./attentionQueue";
import { needsYouCounts, needsYouDismissal, needsYouDismissibleCount, needsYouEntrySince } from "./needsYouPanel";

/*
 * One list for the phone (README §4.1, §4.6): conversations waiting on the
 * operator and pipelines in `needs_decision`, joined in the board's order.
 */

const NOW = 1_800_000_000;
const PROJECT = "atlas";

function waiting(path: string, since: number): FileEntry {
  return {
    root: "claude-projects", name: path, path, project: PROJECT, title: path, engine: "claude", kind: "session", fmt: "claude",
    parent: null, mtime: NOW - 60, size: 10, activity: "idle", proc: null, pid: null, model: "opus", pendingQuestion: null,
    waitingInput: { since, screenTail: "❯ 1. Yes", target: "llv:0.0", menu: null },
  } as FileEntry;
}

function pipeline(id: string, state: Pipeline["state"], completedAt: number): Pipeline {
  return {
    id, task: `Lane ${id}`, taskIds: [], project: PROJECT, repoDir: "/repo", worktreeDir: "/repo-lane", branch: "lane/1", baseBranch: "main", baseRef: "main",
    lastPassedCommit: "", stages: [{ id: "implement", kind: "run" }, { id: "review", kind: "review-loop" }],
    runs: [{ stageId: "review", attempts: [{ n: 1, state: "failed", verdict: { status: "fail", findings: ["one"] }, completedAt: new Date(completedAt * 1_000).toISOString() }] }],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    state, pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: new Date((NOW - 7_200) * 1_000).toISOString(), closedAt: null,
  } as unknown as Pipeline;
}

const conversations = buildAttentionQueue([waiting("/p/new.jsonl", NOW - 100), waiting("/p/old.jsonl", NOW - 900)], NOW, PROJECT);
const pipelines = needsDecisionPipelineRows([pipeline("p-decide", "needs_decision", NOW - 3_600), pipeline("p-run", "running", NOW - 60)], PROJECT, NOW);

test("conversations and needs_decision pipelines are ONE list, conversations in queue order first, then the pipelines", () => {
  const entries = buildMobileAttentionQueue(conversations, pipelines);
  expect(entries.map((entry) => `${entry.kind}:${entry.kind === "conversation" ? entry.item.file.path : entry.kind === "pipeline" ? entry.row.id : entry.id}`)).toEqual([
    "conversation:/p/old.jsonl",
    "conversation:/p/new.jsonl",
    "pipeline:p-decide",
  ]);
  /* A running pipeline is not a decision, so it is not in the list — and the
     badge that counts this list agrees with the board's Needs-you section. */
  expect(entries).toHaveLength(3);
  expect(entries.every((entry) => entry.id.length > 0)).toBe(true);
});

/* The desktop island and the phone badge read one list (#2129). */

const iso = (seconds: number) => new Date(seconds * 1_000).toISOString();
const parked = pipeline("p-decide", "needs_decision", NOW - 3_600);
/** The same lane, dismissed on its card after it parked on this decision. */
const dismissed = { ...parked, dismissedAt: iso(NOW - 60), dismissedBy: { kind: "operator", surface: "desktop" } } as Pipeline;
const elsewhere = { ...pipeline("p-atlas", "needs_review", NOW - 1_800), project: "harbor" } as Pipeline;

test("a lane parked on a decision is on the list with no conversation waiting, and counts 1", () => {
  const entries = buildNeedsYouQueue([], [parked, pipeline("p-run", "running", NOW - 60)], NOW, []);
  expect(entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(["pipeline:p-decide"]);
});

test("a lane dismissed for the decision it waits on, or closing, is off the list", () => {
  expect(buildNeedsYouQueue([], [dismissed], NOW, [])).toEqual([]);
  expect(buildNeedsYouQueue([], [parked], NOW, ["p-decide"])).toEqual([]);
  /* A dismissal made before the lane last moved covers an older decision. */
  const stale = { ...parked, dismissedAt: iso(NOW - 7_000) } as Pipeline;
  expect(buildNeedsYouQueue([], [stale], NOW, []).map((entry) => entry.id)).toEqual(["p-decide"]);
});

test("the list spans every project, conversations first; a project's slice is exactly what the phone badge counts there", () => {
  const files = [waiting("/p/new.jsonl", NOW - 100), waiting("/p/old.jsonl", NOW - 900)];
  const entries = buildNeedsYouQueue(files, [parked, elsewhere], NOW, []);
  expect(entries.map((entry) => `${attentionEntryProject(entry)}:${entry.id.startsWith("p-") ? entry.id : entry.kind}`)).toEqual([
    `${PROJECT}:conversation`,
    `${PROJECT}:conversation`,
    `${PROJECT}:p-decide`,
    "harbor:p-atlas",
  ]);
  const slice = entries.filter((entry) => attentionEntryProject(entry) === PROJECT);
  expect(slice).toEqual(buildMobileAttentionQueue(buildAttentionQueue(files, NOW, PROJECT), needsDecisionPipelineRows([parked, elsewhere], PROJECT, NOW)));
});

test("the N key walks conversations and lanes on one pointer, and reaches the lane", () => {
  const entries = buildNeedsYouQueue([waiting("/p/old.jsonl", NOW - 900)], [parked], NOW, []);
  const pointer = { current: null as string | null };
  expect(advanceAttentionCycle(pointer, entries, 1)?.kind).toBe("conversation");
  const lane = advanceAttentionCycle(pointer, entries, 1);
  expect(lane?.kind === "pipeline" ? lane.row.pipeline.id : null).toBe("p-decide");
  expect(pointer.current).toBe("p-decide");
  expect(advanceAttentionCycle(pointer, entries, 1)?.kind).toBe("conversation");
});

test("a lane is focused by the key its card answers to", () => {
  expect(laneFocusPath("p-decide")).toBe("group::pipeline::p-decide");
  expect(laneFocusId(laneFocusPath("p-decide"))).toBe("p-decide");
  expect(laneFocusId("/p/old.jsonl")).toBeNull();
  expect(laneFocusId("group::pipeline::")).toBeNull();
});

test("a six-hour update decision joins Needs-you and uses its own choices", () => {
  const decision = { id: "drain-1", at: "2026-01-01T06:00:00Z", project: PROJECT, blockers: null };
  const entries = buildNeedsYouQueue([], [], NOW, [], decision);
  expect(entries).toEqual([{ kind: "update", id: "auto-update:drain-1", decision }]);
});

/* A task's prototype review that waits for a choice is counted where
   everything else that needs the operator is counted: one entry per task
   beside the conversations and the lanes, cleared by the choice and brought
   back by a newer round. */
test("a waiting prototype review joins the one queue, leaves on its decision and returns with a newer round", () => {
  const review = (id: string, waitingReviewId: string | null) => ({ latestReviewId: id, waitingReviewId, title: `Layout ${id}`, rounds: 1, createdAt: new Date((NOW - 300) * 1_000).toISOString() });
  const boardTask = (id: string, project: string, prototypeReview?: ReturnType<typeof review>) => ({
    id, project, status: "inbox", placement: "unplaced", text: `Task ${id}`, assignments: [], createdAt: "", updatedAt: "", ...(prototypeReview ? { prototypeReview } : {}),
  }) as unknown as BoardTask;
  const files = [waiting("/p/old.jsonl", NOW - 900)];
  const parked = pipeline("p-decide", "needs_decision", NOW - 3_600);
  const ready = [boardTask("t-ready", PROJECT, review("pr_1", "pr_1")), boardTask("t-other", "borealis", review("pr_2", "pr_2")), boardTask("t-plain", PROJECT)];
  const entries = buildNeedsYouQueue(files, [parked], NOW, [], undefined, ready);
  /* The neighbours keep their own entries: nothing is lost and nothing is counted twice. */
  const names = (queue: readonly MobileAttentionEntry[]) => queue.map((entry) => (entry.kind === "conversation" ? `conversation:${entry.item.file.path}` : `${entry.kind}:${entry.id}`));
  expect(names(entries)).toEqual(["conversation:/p/old.jsonl", "pipeline:p-decide", "prototype:prototype:pr_1", "prototype:prototype:pr_2"]);
  expect(entries.map(attentionEntryProject)).toEqual([PROJECT, PROJECT, PROJECT, "borealis"]);
  expect(needsYouCounts(entries)).toEqual(new Map([[PROJECT, 3], ["borealis", 1]]));
  const waitingEntry = entries.find((entry) => entry.kind === "prototype")!;
  expect(needsYouEntrySince(waitingEntry)).toBe(NOW - 300);
  /* The choice is what clears it, so «Dismiss all» never names it. */
  expect(needsYouDismissibleCount(entries)).toBe(2);
  expect(needsYouDismissal(entries).subjects.map((subject) => subject.kind)).toEqual(["conversation", "pipeline"]);
  expect(buildNeedsYouQueue(files, [parked], NOW, [])).toHaveLength(2);

  const decided = [boardTask("t-ready", PROJECT, review("pr_1", null)), ready[1]!, ready[2]!];
  expect(names(buildNeedsYouQueue(files, [parked], NOW, [], undefined, decided))).toEqual(["conversation:/p/old.jsonl", "pipeline:p-decide", "prototype:prototype:pr_2"]);
  const newer = [boardTask("t-ready", PROJECT, review("pr_3", "pr_3")), ready[1]!, ready[2]!];
  expect(names(buildNeedsYouQueue(files, [parked], NOW, [], undefined, newer))).toEqual(["conversation:/p/old.jsonl", "pipeline:p-decide", "prototype:prototype:pr_3", "prototype:prototype:pr_2"]);
});

/*
 * «Needs you» counts the forms that wait (docs/design/legatus/build-plan.md,
 * slice 1). On the day the operator gave up on it, 631 of its 646 entries
 * were finished work and 9 were forms. Finished work is the done feed, which
 * no queue reads any more; here the queue's own sources are cut: every form
 * and the update decision stay, a seated project's worker waits are the
 * seat's (stamped by the real router, as `/api/files` stamps them), and the
 * waits that live on their cards leave.
 */

const SEATED = "harbor";
const SEATLESS = "atlas";
const SEAT = "conversation_harbor_seat";
/** The router `/api/files` runs, with one project holding a seat. */
const routes: AttentionRoutingInputs = {
  seatFor: (project) => (project === SEATED ? SEAT : null),
  canonicalProject: (project) => project,
  isSeatConversation: (id) => id === SEAT,
  escalation: () => null,
  formWaiting: () => false,
};
const asked = (seconds: number) => new Date((NOW - seconds) * 1_000).toISOString();
function session(name: string, project: string, over: Partial<FileEntry>): FileEntry {
  return {
    root: "claude-projects", name, path: `/s/${name}.jsonl`, project, title: name, engine: "claude", kind: "session", fmt: "claude",
    parent: null, mtime: NOW - 600, size: 10, activity: "idle", proc: null, pid: null, model: "opus", pendingQuestion: null, waitingInput: null,
    conversationId: `conversation_${name}`, ...over,
  } as FileEntry;
}
const question = (name: string, seconds: number) => ({
  kind: "question", toolUseId: `toolu-${name}`, transcriptPath: "", pid: null, askedAt: asked(seconds),
  questions: [{ header: name, question: `${name}?`, multiSelect: false, options: [] }],
}) as unknown as FileEntry["pendingQuestion"];
/** A worker a seat or a lane started: delegation depth one. */
const worker = { durableLineage: { kind: "spawn", role: "builder", depth: 1, parentConversationId: null, reviewsConversationId: null, memberships: [] } } as unknown as Partial<FileEntry>;
const seatLineage = { durableLineage: { kind: "spawn", role: "orchestrator", depth: 0, parentConversationId: null, reviewsConversationId: null, memberships: [{ kind: "orchestrator", containerId: SEATED, role: "orchestrator", slot: "seat", stageId: null, stageOrder: null, round: null, parentConversationId: null }] } } as unknown as Partial<FileEntry>;

function world() {
  const files = [
    /* A seated project's worker question: the seat answers it first. */
    session("harbor-builder", SEATED, { ...worker, pendingQuestion: question("harbor-builder", 500) }),
    /* A seatless project's worker question: nobody else answers it yet. */
    session("atlas-builder", SEATLESS, { ...worker, pendingQuestion: question("atlas-builder", 450) }),
    /* The operator's own session asks: the operator is already in it. */
    session("atlas-mine", SEATLESS, { pendingQuestion: question("atlas-mine", 400) }),
    /* A message that has not landed for an hour, and a launch that failed. */
    session("atlas-owed", SEATLESS, { stuckDelivery: { since: asked(3_600), state: "delivery-uncertain" } } as Partial<FileEntry>),
    session("atlas-launch", SEATLESS, { path: "spawn:launch-1", spawn: { state: "failed", admittedAt: (NOW - 300) * 1_000, error: "Account B is signed out" } } as unknown as Partial<FileEntry>),
    /* The orchestrator's own open question: a report, kept in «Reports». */
    session("harbor-seat", SEATED, { ...seatLineage, conversationId: SEAT, bridgeAsk: { id: "ask-harbor", at: asked(200), seq: 4, body: "Keep the nightly digest?" } } as Partial<FileEntry>),
  ];
  const lanes = [
    { ...pipeline("lane-atlas", "needs_decision", NOW - 1_000), project: SEATLESS } as Pipeline,
    { ...pipeline("lane-harbor", "needs_decision", NOW - 1_000), project: SEATED, srcConversationId: SEAT } as Pipeline,
  ];
  stampAttentionRoutes(files, lanes, NOW, routes);
  /* Nine forms: four task rounds and five of the orchestrators' own. */
  const round = (id: string) => ({ latestReviewId: id, waitingReviewId: id, title: `Round ${id}`, rounds: 1, createdAt: asked(900) });
  const tasks = [1, 2, 3, 4].map((n) => ({
    id: `t-${n}`, project: n % 2 ? SEATED : SEATLESS, status: "inbox", placement: "unplaced", text: `Task ${n}`, assignments: [], createdAt: "", updatedAt: "", prototypeReview: round(`pr_task_${n}`),
  }) as unknown as BoardTask);
  const seatForms: PrototypeReviewNotice[] = [1, 2, 3, 4, 5].map((n) => ({
    id: `prototype:pr_seat_${n}`, project: SEATED, taskId: null, reviewId: `pr_seat_${n}`, title: `Seat question ${n}`, createdAt: asked(800 - n),
    target: { kind: "seat-decision", project: SEATED, reviewId: `pr_seat_${n}` },
  }));
  return { files, lanes, tasks, seatForms };
}
const label = (entry: MobileAttentionEntry) => (entry.kind === "conversation" ? `conversation:${entry.item.file.name}` : `${entry.kind}:${entry.id}`);

test("«Needs you» holds the nine forms and the seatless project's waits; the seat's waits, the operator's own session, deliveries, launches and reports stay off it", () => {
  const { files, lanes, tasks, seatForms } = world();
  const queue = buildNeedsYouQueue(files, lanes, NOW, [], undefined, tasks, seatForms).filter(needsYouHolds);
  expect(queue.map(label)).toEqual([
    "conversation:atlas-builder",
    "pipeline:lane-atlas",
    ...[1, 2, 3, 4].map((n) => `prototype:prototype:pr_task_${n}`),
    ...[1, 2, 3, 4, 5].map((n) => `prototype:prototype:pr_seat_${n}`),
  ]);
  expect(queue.filter((entry) => entry.kind === "prototype")).toHaveLength(9);
  /* The seated project's worker and lane carry their seat's route, so the
     whole queue already leaves them out; the rest is what this cut removes. */
  expect(files[0]!.attentionRoute).toMatchObject({ owner: "seat", seat: SEAT });
  expect(lanes[1]!.attentionRoute).toMatchObject({ owner: "seat", seat: SEAT });
  const whole = buildNeedsYouQueue(files, lanes, NOW, [], undefined, tasks, seatForms);
  expect(whole.filter((entry) => !needsYouHolds(entry)).map(label).sort()).toEqual([
    "conversation:atlas-launch", "conversation:atlas-mine", "conversation:atlas-owed", "conversation:harbor-seat",
  ]);
  /* The rail's ⏸ reads the same rows: harbor's five seat forms and two task
     rounds, atlas's worker, lane and two task rounds. */
  expect(needsYouCounts(queue)).toEqual(new Map([[SEATLESS, 4], [SEATED, 7]]));
});

test("once the seatless project designates a seat its worker's question is the seat's and leaves «Needs you»; a form stays", () => {
  const { files, lanes, tasks, seatForms } = world();
  stampAttentionRoutes(files, lanes, NOW, { ...routes, seatFor: (project) => (project === SEATED ? SEAT : "conversation_atlas_seat") });
  const queue = buildNeedsYouQueue(files, lanes, NOW, [], undefined, tasks, seatForms).filter(needsYouHolds);
  expect(queue.map(label).filter((name) => !name.startsWith("prototype:"))).toEqual([]);
  expect(queue).toHaveLength(9);
});

test("a stage's memory kill and a worker's prose ask in a seatless project still count; the update decision stays", () => {
  const stage = { durableLineage: { kind: "spawn", role: "builder", depth: 0, parentConversationId: null, reviewsConversationId: null, memberships: [{ kind: "pipeline", containerId: "lane-atlas", role: "builder", slot: "implement", stageId: "implement", stageOrder: 0, round: 1, parentConversationId: null }] } } as unknown as Partial<FileEntry>;
  const files = [
    session("atlas-killed", SEATLESS, { ...stage, memoryKill: { at: asked(120), limitBytes: 4 * 1024 ** 3, limit: "agent", fatal: true } } as unknown as Partial<FileEntry>),
    session("atlas-asks", SEATLESS, { ...worker, operatorAsk: { id: "ask:atlas", messageAt: (NOW - 90) * 1_000, gist: "Ship the export today?" } } as Partial<FileEntry>),
    /* The same prose ask from the operator's own session stays on its card. */
    session("atlas-own-ask", SEATLESS, { operatorAsk: { id: "ask:own", messageAt: (NOW - 80) * 1_000, gist: "Rename the column?" } } as Partial<FileEntry>),
  ];
  stampAttentionRoutes(files, [], NOW, routes);
  const decision = { id: "drain-2", at: asked(60), project: SEATLESS, blockers: null };
  expect(buildNeedsYouQueue(files, [], NOW, [], decision).filter(needsYouHolds).map(label)).toEqual([
    "conversation:atlas-killed", "conversation:atlas-asks", "update:auto-update:drain-2",
  ]);
});
