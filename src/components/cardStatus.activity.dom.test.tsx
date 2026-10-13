import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { FileEntry } from "@/lib/types";
import { CardStatusBadge } from "./CardStatusBadge";

test("an unchanged running row turns idle on the shared board clock", () => {
  const dom = new Window();
  Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event });
  let now = 1_800_000_000_000;
  const date = spyOn(Date, "now").mockImplementation(() => now);
  const intervals = spyOn(globalThis, "setInterval");
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const file = { path: "/fixture/one.jsonl", engine: "codex", proc: "running", activity: "live", mtime: (now - 540_000) / 1000, lastTurn: { startedAt: now - 720_000, endedAt: null }, agentActivity: { lastRecordAt: now - 540_000 } } as FileEntry;
  try {
    flushSync(() => root.render(<CardStatusBadge file={file} />));
    expect(host.querySelector("[data-agent-activity]")?.getAttribute("data-agent-activity")).toBe("working");
    const tick = intervals.mock.calls.find(call => call[1] === 30_000)?.[0];
    expect(typeof tick).toBe("function");
    now += 60_000;
    flushSync(() => (tick as () => void)());
    expect(host.querySelector("[data-agent-activity]")?.getAttribute("data-agent-activity")).toBe("idle");
    expect(host.querySelector("[data-agent-activity]")?.getAttribute("aria-label")).toContain("10");
  } finally { flushSync(() => root.unmount()); date.mockRestore(); intervals.mockRestore(); dom.document.body.replaceChildren(); }
});
