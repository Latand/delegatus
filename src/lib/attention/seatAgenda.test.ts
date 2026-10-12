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
  expect(line!.label).toContain("pipeline_action resolve-decision");
  expect(line!.label).toContain('publish_prototype_review, then dismiss_attention escalate {reviewId} with target {kind:"pipeline", pipelineId:"lane"}');
});
