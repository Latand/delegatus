import { expect, test } from "bun:test";
import { fixtureInboxBatch } from "./fixtures/inboxBatch";
import { FileClaudeDeliveryLedger } from "./claudeStreamBrokerHost";


test("seat inbox conversation records keep per-part authors and no whole-row operator attribution", async () => {
  const subject = await import("./agentRecordAuthors");
  expect(subject.agentRecordPartAuthors).toBeFunction();
  const { agentRecordAuthors, agentRecordPartAuthors } = subject;
  const batch = fixtureInboxBatch([{ id: "author-one", text: "operator instruction", operator: true }, { id: "author-two", text: "reviewer result" }]);
  const ledger = new FileClaudeDeliveryLedger();
  ledger.recordQueued("inbox-author-session", batch, "turn-started");
  ledger.confirmDelivered("inbox-author-session", batch.id, "inbox-author-uuid");
  const records = [{ seq: 1, role: "user", ts: "2026-10-17T06:00:00Z", text: batch.content!.text, sourceId: "inbox-author-uuid" }];
  expect(agentRecordAuthors("/fixtures/inbox-author-session.jsonl", "claude", records).size).toBe(0);
  expect(agentRecordPartAuthors("/fixtures/inbox-author-session.jsonl", records).get(0)?.map(p => p.author))
    .toEqual([{ kind: "operator" }, { kind: "agent", role: "reviewer" }]);
});


test("seat inbox conversation_messages keeps one row and returns bounded part author ranges", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-records-"));
  const transcript = path.join(root, "inbox-tool-session.jsonl");
  const batch = fixtureInboxBatch([{ id: "tool-one", text: "operator words", operator: true }, { id: "tool-two", text: `agent reviewer ${"x".repeat(20000)}` }]);
  const ledger = new FileClaudeDeliveryLedger();
  ledger.recordQueued("inbox-tool-session", batch, "turn-started");
  ledger.confirmDelivered("inbox-tool-session", batch.id, "inbox-tool-uuid");
  const [first, second] = batch.parts!;
  const content = [
    batch.content!.text.slice(0, first!.textStart),
    batch.content!.text.slice(first!.textStart, first!.textEnd),
    batch.content!.text.slice(first!.textEnd, second!.textStart),
    batch.content!.text.slice(second!.textStart, second!.textEnd),
  ].map(text => ({ type: "text", text }));
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "inbox-tool-uuid", promptSource: "sdk", timestamp: "2026-10-17T06:00:00.000Z", message: { role: "user", content } }) + "\n");
  try {
    const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
    const bindings = viewerMcpBindings(undefined, undefined, {
      registrySnapshot: () => ({ entries: {}, conversations: {}, conversationAliases: {}, deliveryOperationOwners: {} }),
      selectedContext: { selectedConversation: () => ({ resolve: (id: string) => id === "conversation_inbox_tool"
        ? { conversationId: id, engine: "claude", path: transcript, project: "inbox-fixture" } : null }), pathAllowed: (candidate: string) => candidate === transcript },
      pinnedTranscript: (candidate: string) => {
        if (candidate !== transcript) return undefined;
        const descriptor = fs.openSync(candidate, "r");
        return { descriptor, stat: fs.fstatSync(descriptor), rootName: "claude-projects", root, sameIdentity: () => true };
      },
    } as never);
    const response = await bindings.conversation_messages({ conversationId: "conversation_inbox_tool", roles: ["user"], maxChars: 16000 }, {
      redactText: value => value.replace("operator words", "operator [redacted]"),
    }) as { records: Array<{ text: string; truncated?: boolean; author?: unknown; parts?: Array<{ operationId: string; author: { kind: string }; textStart: number; textEnd: number }> }> };
    expect(response.records).toHaveLength(1);
    expect(response.records[0]!.parts?.map(p => p.author.kind)).toEqual(["operator", "agent"]);
    expect(response.records[0]!.author).toBeUndefined();
    const row = response.records[0]!;
    expect(row.truncated).toBe(true);
    expect(row.parts?.map(p => row.text.slice(p.textStart, p.textEnd))).toEqual([
      "operator [redacted]", "agent reviewer " + "x".repeat(16000 - row.parts![1]!.textStart - "agent reviewer ".length),
    ]);
    expect(row.parts?.[0]?.operationId).toBe("tool-one");
    expect(row.parts?.[1]?.operationId).toBe("tool-two");
    expect(row.parts?.[1]?.textEnd).toBe(row.text.length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
