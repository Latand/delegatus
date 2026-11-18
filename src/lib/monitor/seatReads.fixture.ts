import type { HeldDelivery } from "@/lib/accounts/migration/contracts";
import { normalizeRegistry, type RegistryFile } from "@/lib/agent/registry";
import type { BoardTask } from "@/lib/tasks/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import type { NeedsYouBody } from "@/lib/attention/needsYouProjection";

export const SEAT_READ_AT = "2026-11-17T12:00:00.000Z";
export const SEAT_READ_NOW = Date.parse(SEAT_READ_AT) / 1000;

/** Fixed insertion order, retained terminal history, legacy authorship and
 * mixed scopes for read equivalence tests and repeatable local profiles. */
export function seatReadRegistry(total = 34_623, failed = 752): RegistryFile {
  const file = normalizeRegistry({ version: 2, entries: {}, receipts: {} });
  for (let index = 0; index < total; index++) {
    const id = `delivery-${String(index).padStart(6, "0")}`;
    const command: HeldDelivery["command"] = { operationId: `operation-${index}`, kind: "send", policy: "queue",
      ...(index % 7 === 0 ? {} : { origin: index % 7 === 1 ? { kind: "operator" as const }
        : { kind: "agent" as const, project: index % 7 === 2 ? "foreign" : "old", conversationId: "conversation_sender" } }) };
    const delivery: HeldDelivery = { id, conversationId: "conversation_recipient", runtimeConversationId: "conversation_recipient",
      text: "Synthetic delivery history. ".repeat(40), createdAt: SEAT_READ_AT, clientMessageId: id,
      payloadKind: "text", runtimeImages: [], contentDigest: null, artifactPaths: [], command, requestDigest: `request-${index}`,
      state: index < failed ? "failed" : "delivered", generationId: null, attempts: 1, assignedAt: null,
      deliveredAt: index < failed ? null : SEAT_READ_AT, error: index < failed ? "Recipient retired" : null };
    file.heldDeliveries[id] = delivery;
    if (index < failed && index % 7 !== 3) file.deliveryOperationOwners[command.operationId] = {
      conversationId: delivery.conversationId, runtimeConversationId: delivery.runtimeConversationId,
      clientMessageId: id, deliveryId: id, command, requestDigest: delivery.requestDigest!, contentDigest: null,
      createdAt: SEAT_READ_AT, retryOfOperationId: null, terminalState: "failed",
      terminalDisposition: index % 7 === 4 ? "unverified" : "lost", terminalReason: delivery.error, settledAt: SEAT_READ_AT,
    };
  }
  return file;
}

export function seatReadBoard(total = 5_109): { tasks: BoardTask[]; pipelines: Pipeline[]; files: FileEntry[] } & Pick<NeedsYouBody, "seatDecisions"> {
  const tasks: BoardTask[] = Array.from({ length: total }, (_, index) => ({
    id: `task-${index}`, project: index % 3 === 0 ? "foreign" : "old", text: `Synthetic task ${index}`,
    status: "inbox", createdAt: SEAT_READ_AT, updatedAt: SEAT_READ_AT, assignments: [],
    placement: "unplaced",
  }));
  const pipelines = Array.from({ length: 257 }, (_, index) => ({
    id: `lane-${index}`, project: index % 3 === 0 ? "foreign" : "old", task: `Synthetic lane ${index}`, taskIds: [],
    state: "completed", createdAt: SEAT_READ_AT, stages: [], cursor: null, runs: [],
    merge: { state: "blocked", reason: "no pull request is linked to this lane; open or attach its PR, then try the merge again", blockedAt: SEAT_READ_AT, updatedAt: SEAT_READ_AT },
    dismissedAt: SEAT_READ_AT, dismissedBy: { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" },
    attentionRoute: { key: `lane:${index}`, owner: "seat", seat: "conversation_seat" },
  } as unknown as Pipeline));
  const files = Array.from({ length: 1_299 }, (_, index) => ({
    root: "claude-projects", name: `worker-${index}`, path: `/fixtures/worker-${index}.jsonl`,
    project: index % 3 === 0 ? "foreign" : "old", title: `Synthetic worker ${index}`, kind: "session", engine: "claude", fmt: "claude",
    parent: null, mtime: SEAT_READ_NOW, size: 1, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
    conversationId: `conversation_worker_${index}`,
    durableLineage: { kind: "spawn", role: "deployer", depth: 1, parentConversationId: "conversation_seat", reviewsConversationId: null, memberships: [] },
    operatorAsk: { id: `ask-${index}`, messageAt: SEAT_READ_NOW * 1000, gist: "Proceed with the fixture?", state: "open" },
    attentionRoute: { key: `reason:ask-${index}`, owner: "seat", seat: "conversation_seat" },
  } as FileEntry));
  const seatDecisions = Array.from({ length: 9 }, (_, index) => ({
    id: `prototype:round-${index}`, reviewId: `round-${index}`, project: index % 3 === 0 ? "foreign" : "old", taskId: null,
    title: `Synthetic choice ${index}`, createdAt: SEAT_READ_AT, source: { conversationId: "conversation_earlier_seat" },
    target: { kind: "seat-decision" as const, project: index % 3 === 0 ? "foreign" : "old", reviewId: `round-${index}` },
  }));
  return { tasks, pipelines, files, seatDecisions };
}
