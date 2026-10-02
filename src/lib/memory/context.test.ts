import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";
import { FileClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import { memoryTurnContext } from "./context";
import { groundedRequest } from "./selection";

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
