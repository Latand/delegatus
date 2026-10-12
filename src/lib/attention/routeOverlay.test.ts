import { expect, test } from "bun:test";

import type { readOrchestratorSeatFileOrNull } from "@/lib/orchestrator/seats";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { AttentionDismissalV1 } from "./dismissals";
import { questionRouteReader, storedWaitingRoundIds, type RoutingSources } from "./routeOverlay";
import type { AttentionEscalationMark } from "./routeTypes";

/*
 * docs/design/attention-auto-resolve.md: the push controller asks the same
 * routing the board stamps. A worker's question the seat escalated to a
 * decision form that still waits is the form's, so it pushes nothing even
 * when the seat is gone or its tick is off; a question nobody escalated, with
 * no seat to wake, still reaches the operator.
 */

type OrchestratorSeatFile = NonNullable<ReturnType<typeof readOrchestratorSeatFileOrNull>>;
const now = Date.parse("2026-10-11T12:00:00Z") / 1000;
const at = new Date((now - 600) * 1000).toISOString();

const delegated = { kind: "spawn", role: "deployer", depth: 1, parentConversationId: "conversation_seat", reviewsConversationId: null, memberships: [] } as NonNullable<FileEntry["durableLineage"]>;
const worker = {
  root: "claude-projects", name: "worker", path: "/t/worker.jsonl", project: "project-a", title: "worker", kind: "session", engine: "claude", fmt: "claude",
  parent: null, mtime: now - 600, size: 1, activity: "idle", proc: null, pid: null, model: null, waitingInput: null, conversationId: "conversation_worker",
  durableLineage: delegated,
  pendingQuestion: { kind: "question", toolUseId: "toolu_worker", askedAt: at, questions: [{ question: "Retry on the bigger runner?", header: "Runner", multiSelect: false,
    options: [{ label: "Retry", description: "", recommended: true }, { label: "Close the lane", description: "", recommended: false }] }] },
} as unknown as FileEntry;

const escalation: AttentionEscalationMark = { key: "reason:toolu_worker", at, seat: "conversation_seat", taskId: "task-form", reviewId: "round-a" };
const round = (id: string, decided = false) => ({ id, title: "Retry on the bigger runner?", createdAt: at, variants: [],
  questions: [{ id: "q1", text: "Retry?", options: [{ label: "Retry", recommended: true }, { label: "Close" }] }],
  ...(decided ? { decision: { chosen: [], comment: "", at, delivery: { state: "sent" } } } : {}) });
const formTask = (...rounds: ReturnType<typeof round>[]): BoardTask => ({
  id: "task-form", project: "project-a", text: "Retry the runner", status: "assigned", assignments: [], createdAt: at, updatedAt: at, prototypeReviews: rounds,
}) as unknown as BoardTask;

const activeSeat = { seats: { "project-a": { state: "active", conversationId: "conversation_seat" } }, pending: {}, revocations: [], history: [] } as unknown as OrchestratorSeatFile;

function sources(options: { seats?: OrchestratorSeatFile | null; tick?: boolean; escalations?: AttentionEscalationMark[] } = {}): RoutingSources {
  return {
    seats: () => options.seats ?? null,
    tickEnabled: () => options.tick ?? true,
    escalations: () => new Map((options.escalations ?? []).map((entry) => [entry.key, entry])),
    canonicalConversationId: (id) => id,
  };
}
const noDismissals = new Map<string, AttentionDismissalV1>();

test("a question escalated to a form that still waits pushes nothing with the seat gone or its tick off", () => {
  const waiting = () => storedWaitingRoundIds([formTask(round("round-a"))], noDismissals);
  expect(questionRouteReader(sources({ escalations: [escalation] }), now, waiting)(worker)).toBe(true);
  expect(questionRouteReader(sources({ seats: activeSeat, tick: false, escalations: [escalation] }), now, waiting)(worker)).toBe(true);
});

test("the form's round decided, dismissed or replaced hands the question back: to the operator with no seat, else to the seat", () => {
  const decided = () => storedWaitingRoundIds([formTask(round("round-a", true))], noDismissals);
  expect(questionRouteReader(sources({ escalations: [escalation] }), now, decided)(worker)).toBe(false);
  expect(questionRouteReader(sources({ seats: activeSeat, escalations: [escalation] }), now, decided)(worker)).toBe(true);

  const dismissal = { kind: "prototype", taskId: "task-form", subject: "prototype:round-a", conversationId: null, path: null, at, by: { kind: "operator" }, reason: null, reasonId: null } as unknown as AttentionDismissalV1;
  const dismissed = () => storedWaitingRoundIds([formTask(round("round-a"))], new Map([["prototype:round-a", dismissal]]));
  expect(questionRouteReader(sources({ escalations: [escalation] }), now, dismissed)(worker)).toBe(false);

  /* A later round was decided, so the escalated one waits on nobody. */
  const replaced = () => storedWaitingRoundIds([formTask(round("round-a"), round("round-b", true))], noDismissals);
  expect(questionRouteReader(sources({ escalations: [escalation] }), now, replaced)(worker)).toBe(false);
});

test("a question nobody escalated reaches the operator with no seat, and the seat when one can be woken", () => {
  const waiting = () => storedWaitingRoundIds([formTask(round("round-a"))], noDismissals);
  expect(questionRouteReader(sources(), now, waiting)(worker)).toBe(false);
  expect(questionRouteReader(sources({ seats: activeSeat, tick: false }), now, waiting)(worker)).toBe(false);
  expect(questionRouteReader(sources({ seats: activeSeat }), now, waiting)(worker)).toBe(true);
  /* An unreadable task store keeps nothing on a form. */
  expect(questionRouteReader(sources({ escalations: [escalation] }), now, () => { throw new Error("busy"); })(worker)).toBe(false);
});
