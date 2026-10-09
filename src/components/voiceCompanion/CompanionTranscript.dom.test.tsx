import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, settle } from "@/test-helpers/onboardingDom";

/*
 * The conversation view (item 6 of docs/design/voice-delegatus-live-feedback.md), the operator's pick "Glass panel":
 * every tool call and every request to the orchestrator is one collapsed line that opens to its arguments and result,
 * and each message of either side has a copy control of its own that copies exactly that message.
 */

installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { CompanionTranscript, transcriptRows } = await import("./CompanionTranscript");
const { sampleTranscript } = await import("./transcriptSample.fixture");

let mounted: { root: Root; host: HTMLDivElement } | null = null;
let written: string[] = [];
Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { written.push(text); } }, configurable: true });
afterEach(async () => {
  if (mounted) { const { root, host } = mounted; await act(async () => root.unmount()); host.remove(); mounted = null; }
  written = [];
});
async function open(onClose = () => {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  const record = sampleTranscript("en");
  await act(async () => root.render(<CompanionTranscript record={record} left={0} top={0} width={360} height={560} onClose={onClose} />));
  await act(async () => settle());
  return { view: host.querySelector<HTMLElement>("[data-companion-transcript-view]")!, record };
}
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await act(async () => settle());
};

test("every tool call and every request shows collapsed by default, one line with the tool and its outcome, and no argument or result is on the page", async () => {
  const { view } = await open();
  const calls = [...view.querySelectorAll<HTMLElement>("[data-transcript-call]")];
  expect(calls.map((call) => call.dataset.transcriptCall)).toEqual(["list_tasks", "get_task", "request_orchestrator_delegation"]);
  for (const call of calls) {
    const toggle = call.querySelector<HTMLElement>("[data-transcript-toggle]")!;
    expect(toggle.getAttribute("aria-expanded"), call.dataset.transcriptCall).toBe("false");
    expect(call.querySelector("[data-transcript-detail], pre"), call.dataset.transcriptCall).toBeNull();
  }
  const lines = calls.map((call) => call.querySelector("[data-transcript-toggle]")!.textContent);
  expect(lines[0]).toContain("list_tasks");
  expect(lines[0]).toContain("done");
  expect(lines[1]).toContain("get_task");
  expect(lines[1]).toContain("failed");
  expect(lines[2]).toContain("Delivered");
  /* What the calls were asked and answered, and the delivery steps, stay out of the text until opened. */
  const text = view.textContent!;
  for (const hidden of ["task_retry_banner", "PROJECT_REFUSED", "Fold the export toggles", "Delivery steps", "Arguments", "Instruction"]) expect(text, hidden).not.toContain(hidden);
  /* What was said stays on the page. */
  expect(text).toContain("What's on the board right now?");
});

test("a line opens to its arguments and result on a click and closes on the next", async () => {
  const { view } = await open();
  const call = view.querySelector<HTMLElement>('[data-transcript-call="get_task"]')!;
  const toggle = call.querySelector<HTMLElement>("[data-transcript-toggle]")!;
  await click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const detail = call.querySelector<HTMLElement>("[data-transcript-detail]")!;
  expect(detail.textContent).toContain("Arguments");
  expect(detail.textContent).toContain("task_retry_banner");
  expect(detail.textContent).toContain("Result");
  expect(detail.textContent).toContain("PROJECT_REFUSED");
  /* The other lines stay closed. */
  expect(view.querySelectorAll("[data-transcript-detail]")).toHaveLength(1);
  await click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(call.querySelector("[data-transcript-detail]")).toBeNull();

  /* The delivery steps collapse the same way. */
  const request = view.querySelector<HTMLElement>('[data-transcript-call="request_orchestrator_delegation"]')!;
  expect(request.querySelector("[data-transcript-detail]")).toBeNull();
  await click(request.querySelector("[data-transcript-toggle]"));
  const steps = request.querySelector<HTMLElement>("[data-transcript-detail]")!.textContent!;
  expect(steps).toContain("Delivery steps");
  expect(steps).toContain("Sending");
  expect(steps).toContain("Delivered");
  await click(request.querySelector("[data-transcript-toggle]"));
  expect(request.querySelector("[data-transcript-detail]")).toBeNull();
});

test("each message, the operator's and the companion's, has its own copy control that puts exactly that message on the clipboard and confirms", async () => {
  const { view, record } = await open();
  const said = transcriptRows(record.entries).filter((row) => row.kind === "speech");
  const items = [...view.querySelectorAll<HTMLElement>('[data-kind="speech"]')];
  expect(items).toHaveLength(said.length);
  expect(new Set(items.map((item) => item.dataset.speaker))).toEqual(new Set(["operator", "companion"]));
  for (const [index, item] of items.entries()) {
    const button = item.querySelector<HTMLButtonElement>("button")!;
    expect(button, `message ${index} has a copy control`).toBeTruthy();
    expect(button.getAttribute("aria-label")).toBe("Copy message");
    await click(button);
    expect(written.at(-1), `message ${index} copies its own text`).toBe((said[index] as { text: string }).text);
    expect(button.getAttribute("aria-label"), "a short confirmation").toBe("copied");
  }
  expect(written).toHaveLength(items.length);
  /* Only messages carry the control: a call line has none. */
  expect(view.querySelectorAll("[data-transcript-call] button:not([data-transcript-toggle])")).toHaveLength(0);
  /* A long message is copied whole, not as shown. */
  const long = said.find((row) => row.kind === "speech" && row.text.length > 300)!;
  expect(written).toContain((long as { text: string }).text);
});

test("Escape and the close control close it", async () => {
  let closed = 0;
  const { view } = await open(() => { closed += 1; });
  await act(async () => { view.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(closed).toBe(1);
  await click(view.querySelector("[data-transcript-close]"));
  expect(closed).toBe(2);
});

test("a spoken confirmation and a retried request are lines of their own that open to their own arguments and result", async () => {
  const { transcriptRows: rowsOf } = await import("./CompanionTranscript");
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const recipient = { project: "atlas", conversationId: "conversation_orchestrator", seatEpoch: 1, engine: "claude" as const };
  const entries = [
    { id: "tool-ask", kind: "tool" as const, atMs: 1_000, order: 0, data: { name: "request_orchestrator_delegation", callId: "ask", arguments: json({ instruction: "Delete the old presets", confirmation_reason: "Deleting cannot be undone." }), status: "done", result: json({ status: "awaiting_confirmation" }) } },
    { id: "request-ask", kind: "request" as const, atMs: 1_100, order: 1, data: { callId: "ask", proposalId: "p1", instruction: "Delete the old presets", recipient, status: "sent", states: [{ atMs: 1_100, status: "proposed" }, { atMs: 5_000, status: "sent" }] } },
    { id: "tool-yes", kind: "tool" as const, atMs: 5_000, order: 2, data: { name: "resolve_orchestrator_confirmation", callId: "yes", arguments: json({ decision: "send" }), status: "done", result: json({ status: "sent", delivery: "queued" }) } },
    { id: "tool-retry", kind: "tool" as const, atMs: 7_000, order: 3, data: { name: "request_orchestrator_delegation", callId: "retry", arguments: json({ instruction: "Delete the old presets" }), status: "failed", result: json({ status: "refused", code: "already_requested" }) } },
  ];
  expect(rowsOf(entries).map((row) => row.kind)).toEqual(["request", "call", "call"]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<CompanionTranscript record={{ entries, truncated: false }} left={0} top={0} width={360} height={560} onClose={() => {}} />));
  await act(async () => settle());
  const calls = [...host.querySelectorAll<HTMLElement>("[data-transcript-call]")];
  expect(calls.map((call) => call.dataset.transcriptCall)).toEqual(["request_orchestrator_delegation", "resolve_orchestrator_confirmation", "request_orchestrator_delegation"]);
  await click(calls[1]!.querySelector("[data-transcript-toggle]"));
  expect(calls[1]!.querySelector("[data-transcript-detail]")!.textContent).toContain('"decision": "send"');
  expect(calls[1]!.querySelector("[data-transcript-detail]")!.textContent).toContain('"delivery": "queued"');
  await click(calls[2]!.querySelector("[data-transcript-toggle]"));
  expect(calls[2]!.querySelector("[data-transcript-detail]")!.textContent).toContain("already_requested");
});

test("the sample replies state the project restriction directly", () => {
  for (const locale of ["en", "uk"] as const) {
    const replies = sampleTranscript(locale).entries.filter((entry) => entry.kind === "reply").map((entry) => String(entry.data.text));
    for (const reply of replies) expect(reply, `${locale}: ${reply}`).not.toMatch(/,\s+(?:not|не)\s/u);
  }
});
