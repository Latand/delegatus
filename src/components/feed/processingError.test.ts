import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createFeedSession } from "./parse";
import { resetLocaleForTests } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
afterEach(() => {
  for (const [key, descriptor] of [["window", originalWindow], ["document", originalDocument]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  resetLocaleForTests();
});
const line = JSON.stringify({ type: "assistant", timestamp: "2026-10-02T10:00:00Z", message: {
  content: [{ type: "tool_use", id: "fixture-tool", name: "Bash", input: { command: "pwd" } }],
} });
const parse = (lines = [line]) => createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" }).feed(lines, 0, false).items;

test("tool cards parse with no DOM and with only a window global", () => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  resetLocaleForTests();
  expect(parse()[0].item.kind).toBe("tool");
  Object.defineProperty(globalThis, "window", { configurable: true, value: new Window() });
  resetLocaleForTests();
  expect(parse()[0].item.kind).toBe("tool");
});

test("processing errors keep record attribution and a bounded diagnostic; malformed JSON stays distinct", () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: new Window() });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: {
    set lang(_value: string) { throw new Error("fixture tool-card failure"); },
  } } });
  resetLocaleForTests();
  const items = parse([line, "{broken", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Following answer" }] } })]);
  expect(items[0]).toMatchObject({ anchorKey: "row:0:0", item: {
    kind: "raw", err: true, processingError: { recordType: "assistant", message: "fixture tool-card failure" },
  } });
  expect(items[1].item).toMatchObject({ kind: "record", recordType: "malformed_record" });
  expect(items.at(-1)?.item).toMatchObject({ kind: "prose", text: "Following answer" });
});

test.each([
  ["Authorization:", "Bearer", "fixture-credential-value"].join(" "),
  JSON.stringify({ ["api_" + "key"]: "fixture-credential-value" }),
])("processing diagnostics redact credentials in exception messages (%s)", (message) => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: new Window() });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: {
    set lang(_value: string) { throw new Error(message); },
  } } });
  resetLocaleForTests();
  const item = parse()[0].item;
  expect(item.kind).toBe("raw");
  if (item.kind !== "raw") throw new Error("expected processing diagnostic");
  expect(item.processingError?.message).not.toContain("fixture-credential-value");
  expect(item.text).not.toContain("fixture-credential-value");
});

test.each([-40, 0, 2500])("a processing error names the record type and no window index (window starts at %s)", (linesStart) => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: new Window() });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: {
    set lang(_value: string) { throw new Error("fixture tool-card failure"); },
  } } });
  resetLocaleForTests();
  const item = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" }).feed([line], linesStart, false).items[0].item;
  if (item.kind !== "raw") throw new Error("expected processing diagnostic");
  expect(item.processingError).toEqual({ recordType: "assistant", message: "fixture tool-card failure" });
  expect(item.text).toBe("Record processing failed (assistant): fixture tool-card failure");
  expect(JSON.stringify(item)).not.toMatch(/\d{2,}/);
  expect(en["feed.processingFailedRecord"]).not.toContain("{line}");
  expect(uk["feed.processingFailedRecord"]).not.toContain("{line}");
});
