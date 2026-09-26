import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";
import { readStructuredUserProvenance } from "@/lib/selection/structuredUserMetadata";
import { setLocale } from "@/lib/i18n";
import { FeedItem } from "./FeedItem";
import { MessageProvenanceProvider, NO_PROVENANCE } from "./messageProvenance";
import { createFeedSession, type FeedEntry } from "./parse";
import { structuredProvenanceForItem } from "./structuredUserProvenance";

let directory: string;
let previous: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "compact-feed-"));
  previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  setLocale("en");
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  rmSync(directory, { recursive: true, force: true });
});

function parse(wire: string, echo?: string): FeedEntry[] {
  const timestamp = "2026-09-22T00:00:01.000Z";
  const lines = [JSON.stringify({ timestamp, type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: wire }] } })];
  if (echo !== undefined) lines.push(JSON.stringify({ timestamp, type: "event_msg", payload: { type: "user_message", message: echo } }));
  return createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" }).feed(lines, 0, false).items;
}

function render(entries: FeedEntry[]): string {
  const refs = entries.flatMap(({ item }) => item.structuredUserRef ? [item.structuredUserRef] : []);
  const records = readStructuredUserProvenance(refs);
  return renderToStaticMarkup(<MessageProvenanceProvider value={{ ...NO_PROVENANCE,
    forItem: (item) => structuredProvenanceForItem(item, records),
  }}>{entries.map(({ item, key }) => <FeedItem key={key} item={item} />)}</MessageProvenanceProvider>);
}

test("compact operator records render the admitted selected card after canonical echoes", () => {
  const wire = encodeCodexStructuredUserText("Look at the fixture", undefined, {
    version: 1, state: "selected", conversationId: "conversation_fixture_card",
    capturedAt: "2026-09-22T00:00:00.000Z", label: "Fixture selected card",
  }, { kind: "operator" }, "a".repeat(64));
  for (const echo of [undefined, wire, "Look at the fixture"]) {
    const entries = parse(wire, echo);
    expect(entries.filter(({ item }) => item.kind === "user")).toHaveLength(1);
    expect(entries.find(({ item }) => item.kind === "user")?.submissionDedup).toBe("a".repeat(64));
    const html = render(entries);
    expect(html).toContain("Fixture selected card");
    expect(html).not.toContain("llv:structured-user");
  }
});

test("agent records preserve their sender through marked and unmarked echoes", () => {
  const wire = encodeCodexStructuredUserText("Review the fixture", undefined, null,
    { kind: "agent", role: "orchestrator", project: "wardrobe-agent", conversationId: "conversation_sender" }, "b".repeat(64));
  for (const echo of [undefined, wire, "Review the fixture"]) {
    const entries = parse(wire, echo);
    expect(entries.filter(({ item }) => item.kind === "tmsg")).toHaveLength(1);
    const html = render(entries);
    expect(html).toContain("Orchestrator");
    expect(html).toContain("Agent · Orchestrator · wardrobe-agent");
    expect(html).toContain("#c=conversation_sender");
    expect(html).not.toContain("llv:structured-user");
  }
});

test("two identical messages resolve only their own references; reads have a batch ceiling", () => {
  const first = parse(encodeCodexStructuredUserText("same words", undefined, null, { kind: "agent", role: "builder" }, "a".repeat(64)))[0]!.item;
  const second = parse(encodeCodexStructuredUserText("same words", undefined, null, { kind: "agent", role: "reviewer" }, "b".repeat(64)))[0]!.item;
  const records = readStructuredUserProvenance([first.structuredUserRef!]);
  expect(structuredProvenanceForItem(first, records)?.senderRole).toBe("builder");
  expect(structuredProvenanceForItem(second, records)).toBeNull();
  expect(() => readStructuredUserProvenance(Array(101).fill(first.structuredUserRef))).toThrow("batch");
  expect(() => readStructuredUserProvenance(["../../fixture"])).toThrow("batch");
});
