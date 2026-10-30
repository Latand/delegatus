import { expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { seatAgendaAsks } from "./seatAgenda";

/*
 * docs/design/attention-auto-resolve.md, acceptance 3: the seat is told what
 * each routed wait asks, in the asker's words, and the tool that answers it
 * where it asked, so the answer goes back to the asking conversation or lane.
 */

const now = Date.parse("2026-10-11T12:00:00Z") / 1000;
const at = new Date((now - 600) * 1000).toISOString();

const worker = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  root: "claude-projects", name, path: `/t/${name}.jsonl`, project: "project-a", title: `${name} work`, kind: "session", engine: "claude", fmt: "claude",
  parent: null, mtime: now - 600, size: 1, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
  conversationId: `conversation_${name}`,
  durableLineage: { kind: "spawn", role: "deployer", depth: 1, parentConversationId: "conversation_seat", reviewsConversationId: null, memberships: [] },
  ...extra,
}) as FileEntry;

test("a routed prose ask names the question, the conversation to answer and how to escalate", () => {
  const asking = worker("deployer", {
    operatorAsk: { id: "ask-1", messageAt: (now - 600) * 1000, gist: "Roll out to production now?", state: "open" } as FileEntry["operatorAsk"],
    attentionRoute: { key: "reason:ask-1", owner: "seat", seat: "conversation_seat" },
  });
  const unrouted = worker("other", { operatorAsk: { id: "ask-2", messageAt: (now - 600) * 1000, gist: "Anything?", state: "open" } as FileEntry["operatorAsk"] });
  const elsewhere = worker("elsewhere", { project: "project-b", operatorAsk: { id: "ask-3", messageAt: (now - 600) * 1000, gist: "Else?", state: "open" } as FileEntry["operatorAsk"],
    attentionRoute: { key: "reason:ask-3", owner: "seat", seat: "conversation_other_seat" } });
  const [line, ...rest] = seatAgendaAsks({ files: [asking, unrouted, elsewhere], pipelines: [] }, now, "project-a");
  expect(rest).toEqual([]);
  expect(line).toMatchObject({ key: "reason:ask-1", id: "conversation_deployer" });
  expect(line!.label).toContain("deployer asks: «Roll out to production now?»");
  expect(line!.label).toContain("send_message to conversation_deployer");
  expect(line!.label).toContain('dismiss_attention escalate {reviewId} with target {kind:"conversation", conversationId:"conversation_deployer", reasonId:"ask-1"}');
});

test("a routed lane names the stage's own question, the decision answer path and the form to escalate through", () => {
  const lane = {
    id: "lane", task: "Fix the panel", project: "project-a", state: "needs_decision", createdAt: at, stateDetail: "stage verdict: needs_decision",
    stages: [{ id: "diagnose", kind: "run" }], cursor: { stageId: "diagnose" },
    runs: [{ stageId: "diagnose", attempts: [{ n: 1, state: "needs_decision", report: { verdict: { status: "needs_decision" }, summary: "Keep the current behaviour or switch? I recommend switching." } }] }],
    attentionRoute: { key: "lane:lane:lane-decision:none", owner: "seat", seat: "conversation_seat" },
  } as unknown as Pipeline;
  const [line] = seatAgendaAsks({ files: [], pipelines: [lane] }, now, "project-a");
  expect(line).toMatchObject({ key: "lane:lane:lane-decision:none", id: "lane" });
  expect(line!.label).toContain("stage diagnose asks «Keep the current behaviour or switch? I recommend switching.»");
});

/* docs/design/calm-task-cards-build.md §7.2: a stopped merge's step follows
   its class, since a retry of a closed or missing PR stops again at once. */
const mergeLane = (id: string, reason: string): Pipeline => ({
  id, task: `Merge ${id}`, project: "project-a", state: "completed", createdAt: at, stateDetail: null, stages: [], cursor: null, runs: [],
  merge: { state: "blocked", reason, blockedAt: at, updatedAt: at },
  attentionRoute: { key: `lane:${id}:merge:${at}`, owner: "seat", seat: "conversation_seat" },
}) as unknown as Pipeline;

test("each stopped merge's class gets its own step, and the line names the class first", () => {
  const lanes = [
    mergeLane("closed", "the PR was closed"),
    mergeLane("nopr", "no pull request is linked to this lane; open or attach its PR, then try the merge again"),
    mergeLane("off", "the project's merge setting was turned off"),
    mergeLane("conflict", "conflict with the base branch"),
    mergeLane("moving", "main keeps moving"),
    mergeLane("red", 'check "build" failed'),
    mergeLane("slow", "checks did not finish in 90 min"),
    mergeLane("draft", "the PR is a draft"),
  ];
  const labels = new Map(seatAgendaAsks({ files: [], pipelines: lanes }, now, "project-a").map((item) => [item.id, item.label] as const));
  for (const id of ["closed", "nopr", "off"]) {
    expect(labels.get(id)).toStartWith("[merge] ");
    expect(labels.get(id)).toContain(`dismiss_attention target {kind:"pipeline", pipelineId:"${id}"} and a one-line reason`);
    expect(labels.get(id)).not.toContain("retry-merge");
  }
  for (const id of ["conflict", "moving"]) expect(labels.get(id)).toContain("merges current main into this branch, resolves the conflict and has one review of the resolution, then pipeline_action retry-merge");
  for (const id of ["red", "slow"]) expect(labels.get(id)).toContain("pipeline_action retry-merge once the PR's checks are green");
  expect(labels.get("draft")).toContain("repair it and pipeline_action retry-merge");
});

test("a parked lane's line names its stop class before the stage's words", () => {
  const lane = {
    id: "commit", task: "Ship the panel", project: "project-a", state: "needs_decision", createdAt: at, stateDetail: "stage failed",
    stages: [{ id: "build", kind: "run" }], cursor: { stageId: "build" },
    runs: [{ stageId: "build", attempts: [{ n: 1, state: "failed", error: "committing the passed stage: fatal: unable to write new index file" }] }],
    attentionRoute: { key: "lane:commit:lane-decision:none", owner: "seat", seat: "conversation_seat" },
  } as unknown as Pipeline;
  const [line] = seatAgendaAsks({ files: [], pipelines: [lane] }, now, "project-a");
  expect(line!.label).toStartWith("[commit] Ship the panel — stage build asks stopped: stage failed");
});

test("only the successor delivery owner asks for a shared PR merge", () => {
  const old = mergeLane("old", "conflict with the base branch");
  const olderWithoutMerge = mergeLane("older-without-merge", "conflict with the base branch");
  const owner = mergeLane("owner", "conflict with the base branch");
  const target = { repository: "repo-fixture", remote: "", branch: "review", pr: 7 };
  old.delivery = { target, disposition: "owner", active: false, publish: "disabled", ownerId: old.id, epoch: 1, journal: [] };
  olderWithoutMerge.merge = undefined;
  olderWithoutMerge.delivery = { target, disposition: "owner", active: false, publish: "disabled", ownerId: olderWithoutMerge.id, epoch: 0, journal: [] };
  owner.delivery = { target, disposition: "owner", active: false, publish: "disabled", ownerId: owner.id, epoch: 2, journal: [] };
  expect(seatAgendaAsks({ files: [], pipelines: [old, olderWithoutMerge, owner] }, now, "project-a").map(ask => ask.id)).toEqual([owner.id]);
  owner.dismissedAt = new Date(now * 1000).toISOString();
  expect(seatAgendaAsks({ files: [], pipelines: [old, olderWithoutMerge, owner] }, now + 60, "project-a")).toEqual([]);
  const later = new Date((now + 120) * 1000).toISOString();
  owner.merge!.blockedAt = later;
  owner.attentionRoute!.key = `lane:owner:merge:${later}`;
  expect(seatAgendaAsks({ files: [], pipelines: [old, olderWithoutMerge, owner] }, now + 180, "project-a").map(ask => ask.id)).toEqual([owner.id]);
});
