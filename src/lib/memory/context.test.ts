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
import { memoryIndex } from "./service";
import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";

for (const engine of ["claude", "codex"] as const) for (const [locale, dictionary] of [["en", en], ["uk", uk]] as const) for (const key of ["draft.readPrompt", "link.handoffContext"] as const) test(`${engine} ${locale} ${key} retains UI context through native transcript reading`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-ui-context-"));
  const filename = path.join(root, "synthetic.jsonl"), ask = "Update widget parser";
  const template = dictionary[key];
  if (typeof template !== "string") throw Error("Expected a string UI template");
  const text = template.replaceAll("{src}", "fixture").replaceAll("{title}", "Widget parser")
    .replaceAll("{path}", "workspace/widget.jsonl").replaceAll("{ask}", ask) + (key === "draft.readPrompt" ? ask : "");
  const line = (text: string) => JSON.stringify(engine === "claude" ? { type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: text } }
    : { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  try {
    for (const first of [true, false]) {
      fs.writeFileSync(filename, (first ? "" : line("Earlier operator task") + "\n") + line(text) + "\n");
      const context = memoryTurnContext(filename, engine, "Proceed");
      const state = groundedRequest({ engine, prompt: "Proceed", candidates: [], context }).state;
      expect(state.openingRequest).toBe(first ? ask : "Earlier operator task");
      expect(state.precedingTurns).toContain(key === "draft.readPrompt" ? "fixture" : "workspace/widget.jsonl");
      expect(state.precedingTurns).toContain("context: ");
      expect(state.precedingTurns).toContain(`user: ${ask}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const index = new MemoryIndex();
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
      if (suffix.includes("7-8")) expect(index.offers(entries[0].id)[0].outcome).toBe("cited");
      else expect(index.offers(entries[0].id)[0].outcome).toBeNull();
      expect(reply.text.length).toBeLessThanOrEqual(4000);
      expect(JSON.stringify(groundedRequest({ engine: "codex", prompt: "Continue", candidates: [], context }))).not.toContain("citationText");
    }
  } finally {
    index.close(); fs.rmSync(root, { recursive: true, force: true });
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
  }
});


for (const engine of ["claude", "codex"] as const) test(`${engine} native terminal machine launch is machine context and never the opening operator request`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-native-context-")), previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const filename = path.join(root, "synthetic.jsonl"), machine = "Machine opening: widget parsing", operator = "Operator opening: parser task";
  const line = (id: string, text: string) => JSON.stringify(engine === "claude" ? { type: "user", uuid: id, message: { role: "user", content: text } }
    : { type: "response_item", payload: { type: "message", turn_id: id, role: "user", content: [{ type: "input_text", text }] } });
  try {
    fs.writeFileSync(filename, "");
    memoryIndex().recordTerminalDelivery("synthetic-machine", "synthetic-conversation", machine, "agent", filename);
    fs.appendFileSync(filename, line("synthetic-queued", machine) + "\n" + line("synthetic-machine", machine) + "\n");
    expect(memoryIndex().terminalOrigin("synthetic-conversation", "native:synthetic-machine", machine, filename, engine)).toBe("unknown");
    fs.appendFileSync(filename, line("synthetic-operator", operator) + "\n");
    memoryIndex().close();
    const context = memoryTurnContext(filename, engine, "Continue");
    expect(groundedRequest({ engine, prompt: "Continue", candidates: [], context }).state.openingRequest).toBe(operator);
    expect(context.filter(turn => turn.text === machine).map(turn => turn.role)).toEqual(["machine", "machine"]);
  } finally {
    memoryIndex().close(); if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
