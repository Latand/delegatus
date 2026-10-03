import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";
import { FileClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import { memoryTurnContext } from "./context";
import { groundedRequest } from "./selection";
import { MemoryIndex } from "./index";

test("grounded opening request is the first operator turn on both engines, after a machine launch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-context-"));
  try {
    for (const engine of ["claude", "codex"] as const) {
      const session = crypto.randomUUID(), filename = path.join(root, session + ".jsonl");
      const ledger = new FileClaudeDeliveryLedger();
      const turns = [{ id: "machine", kind: "agent" as const, text: "Machine opening: widget parsing" }, { id: "operator", kind: "operator" as const, text: "Operator opening: parser task" }];
      fs.writeFileSync(filename, turns.map(turn => {
        if (engine === "claude") {
          ledger.recordQueued(session, { id: turn.id, text: turn.text, origin: { kind: turn.kind } }, "turn-started");
          ledger.confirmDelivered(session, turn.id, turn.id);
          return JSON.stringify({ type: "user", uuid: turn.id, message: { role: "user", content: [{ type: "text", text: turn.text }] } });
        }
        return JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: encodeCodexStructuredUserText(turn.text, undefined, null, { kind: turn.kind }, crypto.createHash("sha256").update(turn.id).digest("hex")) }] } });
      }).join("\n") + "\n");
      const context = memoryTurnContext(filename, engine, "Continue the parser task");
      expect(groundedRequest({ engine, prompt: "Continue the parser task", candidates: [], context }).state.openingRequest).toBe(turns[1].text);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const length of [100, 4200]) test(`citation accounting retains the tail of a ${length}-character real reply separately from Jev`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-citation-tail-"));
  const index = new MemoryIndex(path.join(root, "index.sqlite"));
  try {
    const source = path.join(root, "cross.md");
    fs.writeFileSync(source, "---\nname: Widget cache\ndescription: Widget cache requires invalidation.\nmetadata:\n  type: project\n---\nInvalidate the widget cache.\n");
    await index.refresh([{ path: source, engine: "claude", sourceKind: "claude_memory", project: "project-fixture" }]);
    const entries = index.injectionCandidates("widget", "project-fixture", "codex", "conversation-fixture");
    index.recordInjection(entries.map(c => ({ ...c, score: .8 })), "turn-fixture", "conversation-fixture");
    const filename = path.join(root, "reply.jsonl");
    for (const suffix of ["Ordinary text", "<oai-mem-citation>\ncross.md:90-91|note=[unrelated]\n</oai-mem-citation>", "<oai-mem-citation>\ncross.md:7-8|note=[cache]\n</oai-mem-citation>"]) {
      fs.writeFileSync(filename, JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(length) + suffix }] } }) + "\n");
      const context = memoryTurnContext(filename, "codex", "Continue");
      const reply = context.findLast(t => t.role === "assistant")!;
      index.recordCitations("conversation-fixture", (reply as typeof reply & { citationText?: string }).citationText ?? reply.text);
      expect(index.offers(entries[0].id)[0].outcome).toBe(suffix.includes("7-8") ? "cited" : null);
      expect(reply.text.length).toBeLessThanOrEqual(4000);
      expect(JSON.stringify(groundedRequest({ engine: "codex", prompt: "Continue", candidates: [], context }))).not.toContain("citationText");
    }
  } finally { index.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
