import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { projectEngineHostEvent } from "@/lib/runtime/engineHostEvents";
import { codexRequestDigest, type CodexRequestReceipt } from "@/lib/runtime/codexRequestReceipt";
import { RuntimeJournal } from "./journal";

const response = { decision: "accept" };
const initial: CodexRequestReceipt = {
  identity: { generation: "process-one", threadId: "thread", turnId: "turn", itemId: "item", method: "item/commandExecution/requestApproval", requestId: 7, approvalId: "approval" },
  receivedAt: "2026-10-15T00:00:00Z", requestDigest: codexRequestDigest({}),
};
const at = "2026-10-15T00:00:01Z";

function opened(filename: string): RuntimeJournal {
  return new RuntimeJournal(filename, { structuredHosts: true });
}

function request(journal: RuntimeJournal, codexReceipt = initial, seq = 1): void {
  journal.append(projectEngineHostEvent("conversation", "codex:thread", {
    kind: "attention", id: "callback", method: initial.identity.method, attention: {}, codexReceipt, seq,
  })!);
}

function answer(journal: RuntimeJournal, key: string, resolution: unknown = response) {
  return journal.executeOperation({ kind: "answer", operationId: key, idempotencyKey: key, conversationId: "conversation", attentionId: "callback", resolution });
}

test("pending callback and answer-dispatch receipt survive a journal restart mid-answer", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-callback-journal-"));
  const filename = path.join(directory, "runtime.sqlite");
  let journal = opened(filename);
  try {
    journal.append({ scope: { type: "session", id: "conversation" }, kind: "session-status", payload: {
      host: "hosted", hostKind: "codex-app-server", sessionKey: { engine: "codex", sessionId: "thread" }, turn: "running", activeTurnId: "turn",
    } });
    request(journal);
    journal.close();
    journal = opened(filename);
    expect(answer(journal, "answer").receipt.status).toBe("pending");
    journal.transitionOperation("answer", "delivering");
    const dispatched = { ...initial, dispatch: { at, digest: codexRequestDigest(response) } };
    request(journal, dispatched, 2);
    journal.close();
    journal = opened(filename);
    expect(journal.snapshot().attentions[0]?.codexReceipt).toEqual(dispatched);
    expect(answer(journal, "second-answer").receipt).toMatchObject({ status: "rejected", reason: "attention-resolving" });
    const terminal = projectEngineHostEvent("conversation", "codex:thread", {
      kind: "attention-resolved", id: "callback", resolution: "answered", seq: 3,
      codexReceipt: { ...dispatched, serverResolution: { at, outcome: "answered" } },
    })!;
    const first = journal.append(terminal);
    expect(journal.append(terminal).seq).toBe(first.seq);
    journal.transitionOperation("answer", "answered");
    expect(journal.snapshot().snapshotSeq).toBeGreaterThan(first.seq);
    journal.close();
    journal = opened(filename);
    // A later producer replay must never reopen this durable terminal.
    request(journal, initial, 4);
    expect(answer(journal, "same-answer").receipt.status).toBe("answered");
    expect(answer(journal, "changed-answer", { decision: "decline" }).receipt.status).toBe("rejected");
    expect(journal.snapshot().attentions[0]).toMatchObject({ state: "resolved", codexReceipt: { serverResolution: { outcome: "answered" } } });
  } finally { journal.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test.each(["cancelled", "expired-confirmed", "resolution-unknown", "resolved"] as const)("%s cannot manufacture successful answer delivery", state => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-callback-terminal-"));
  let journal = opened(path.join(directory, "runtime.sqlite"));
  try {
    request(journal);
    journal.append({ scope: { type: "session", id: "conversation" }, kind: "attention-resolved", payload: {
      attentionId: "callback", state, codexReceipt: { ...initial, serverResolution: { at, outcome: "server-resolved" } },
    } });
    journal.close();
    journal = opened(path.join(directory, "runtime.sqlite"));
    expect(answer(journal, "after-terminal").receipt).toMatchObject({ status: "rejected", reason: "attention-no-longer-answerable" });
  } finally { journal.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test.each(["callback-unavailable", "delivery-uncertain"] as const)("%s remains visible and refuses an answer after reopen", outcome => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-callback-recovery-"));
  let journal = opened(path.join(directory, "runtime.sqlite"));
  try {
    request(journal, { ...initial, recovery: { at, outcome, reason: "resumed-without-callback" } });
    journal.close();
    journal = opened(path.join(directory, "runtime.sqlite"));
    expect(answer(journal, "after-loss").receipt).toMatchObject({ status: "rejected", reason: outcome });
    expect(journal.snapshot().attentions[0]).toMatchObject({ unowned: true, request: { detail: expect.any(String) }, codexReceipt: { recovery: { outcome } } });
  } finally { journal.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
