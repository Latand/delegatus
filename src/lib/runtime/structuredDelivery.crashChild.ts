import fs from "node:fs";

import { RuntimeJournal } from "../../runtime-host/journal";
import type { DeliveryReceipt, EngineHost, HostState, QueueEntry, RuntimeEvent } from "./engineHost";
import { StructuredDeliveryQueue } from "./structuredDeliveryQueue";

/**
 * A real executor process, for the crash this whole fence exists for (#1131).
 *
 * The stub-level regression beside it fakes the death by throwing inside a
 * transition, which proves the recovery logic and nothing about the boundary
 * where the incident happened: a Viewer process that had already handed the
 * message to the engine and was killed before the journal learned of it. This
 * runs the production queue against the production journal in a process of its
 * own, records the engine write where the parent can count it, and then holds
 * the send open forever so the parent can end the process exactly in that gap.
 */
const [journalPath, ledgerPath, claim, mode] = process.argv.slice(2);
if (!journalPath || !ledgerPath || !claim) {
  throw new Error("structured delivery crash child arguments are incomplete");
}

const journal = new RuntimeJournal(journalPath, { structuredHosts: true });

const host: EngineHost = {
  attach: () => ({ async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {} }),
  send: async (entry: QueueEntry): Promise<DeliveryReceipt> => {
    fs.appendFileSync(ledgerPath, `${entry.id}\n`);
    /* Handed over and never answered for. The timer keeps this process alive
       and the promise never settles, so the parent's kill lands in the gap the
       incident happened in rather than in a race with a settled receipt. */
    await new Promise<void>((resolve) => { setTimeout(resolve, 10 * 60_000); });
    throw new Error("structured delivery crash child was not terminated");
  },
  interrupt: async () => {},
  answer: async () => {},
  health: async (): Promise<HostState> => ({
    status: mode === "context" ? "active" : "idle",
    sessionKey: mode === "context" ? "thread-context" : "crash-session",
    endpoint: "crash:host",
    pid: process.pid,
    processStartIdentity: String(process.pid),
    eventCursor: 0,
    protocolVersion: "crash-v1",
    activeTurnRef: mode === "context" ? "turn-context" : null,
    pendingAttention: [],
    activeFlags: mode === "context" ? ["native-inject"] : [],
    account: null,
  }),
  release: async () => {},
};

if (mode === "context") Object.assign(host, {
  inject: async (request: { operationId: string }) => {
    fs.appendFileSync(ledgerPath, `${request.operationId}\n`);
    return { placement: "pending-input", turnId: "turn-context", observe: () =>
      new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 10 * 60_000); }) };
  },
});

const queue = new StructuredDeliveryQueue({
  effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
  transition: async (operationId, status, details) => {
    journal.transitionOperation(operationId, status, details);
  },
  status: async (operationId) => journal.operationResult(operationId)?.receipt ?? null,
  hostClaim: () => claim,
  injectionBinding: () => ({ threadId: "thread-context", accountId: null, writerClaim: claim }),
}, () => host);

await queue.drain();
