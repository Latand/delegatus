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
const { awaitsReport, CompanionTranscript, transcriptRows, TRANSCRIPT_CSS } = await import("./CompanionTranscript");
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

test("each report the orchestrator brought back has a copy control of its own that copies exactly that report", async () => {
  const { view, record } = await open();
  const answers = [...view.querySelectorAll<HTMLElement>("[data-transcript-answer]")];
  const reports = record.entries.filter((entry) => entry.kind === "report").map((entry) => String(entry.data.text));
  expect(answers.length).toBeGreaterThanOrEqual(2);
  const before = written.length;
  for (const [index, answer] of answers.entries()) {
    const button = answer.querySelector<HTMLButtonElement>("button")!;
    expect(button, `report ${index} has a copy control`).toBeTruthy();
    expect(button.getAttribute("aria-label")).toBe("Copy message");
    await click(button);
    expect(written.at(-1)).toBe(reports[index]!);
  }
  expect(written).toHaveLength(before + answers.length);
});

test("standalone reports retain their full text, project, status and copy control, including after hangup", async () => {
  const { record } = await open();
  const text = "The orchestrator checked every requested case. ".repeat(15);
  const entries = [...record.entries,
    { id: "standalone-before", kind: "report" as const, atMs: 70_000, order: 100, data: { project: "Atlas", status: "progress", text } },
    { id: "end", kind: "session_end" as const, atMs: 75_000, order: 101, data: {} },
    { id: "standalone-after", kind: "report" as const, atMs: 80_000, order: 102, data: { project: "Beta", status: "result", text: `${text} All checks passed.` } },
  ];
  await act(async () => mounted!.root.render(<CompanionTranscript record={{ entries, truncated: false }} left={0} top={0} width={360} height={560} onClose={() => {}} />));
  await act(async () => settle());
  const reports = [...mounted!.host.querySelectorAll<HTMLElement>('[data-kind="report"]')];
  expect(reports).toHaveLength(2);
  expect(reports.map(report => report.querySelector(".vc-answer")!.textContent)).toEqual([text, `${text} All checks passed.`]);
  expect(reports[0]!.textContent).toContain("Atlas");
  expect(reports[0]!.textContent).toContain("Progress");
  expect(reports[0]!.textContent).toContain("1:10");
  expect(reports[1]!.textContent).toContain("Beta");
  expect(reports[1]!.textContent).toContain("Result");
  for (const report of reports) await click(report.querySelector("button"));
  expect(written).toEqual([text, `${text} All checks passed.`]);
});

test("a collapsed call row keeps its chevron inside its card, so the row is as wide as the cards under it", () => {
  const css = TRANSCRIPT_CSS;
  expect(css).toMatch(/\.vc-tr-chev\s*\{[^}]*position:\s*absolute/);
  expect(css).not.toMatch(/\.vc-tr-call > \.vc-tr-toggle\s*\{[^}]*display:\s*flex;\s*align-items:\s*center;\s*gap/);
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

test("every report a request brought back stays in the view, in order, with its status and time, and its text is selectable", async () => {
  const { view, record } = await open();
  const answers = [...view.querySelectorAll<HTMLElement>("[data-transcript-answer]")];
  const reports = record.entries.filter((entry) => entry.kind === "report");
  expect(reports.length).toBeGreaterThanOrEqual(2);
  expect(answers.map((answer) => answer.querySelector(".vc-answer")!.textContent)).toEqual(reports.map((entry) => String(entry.data.text)));
  expect(answers.map((answer) => answer.dataset.reportStatus)).toEqual(["progress", "result"]);
  expect(answers[0]!.textContent).toContain("Progress");
  expect(answers[1]!.textContent).toContain("Result");

  /* Reports that arrive later append to the ones already shown, whatever their status. */
  const callId = reports[0]!.data.delivery as { callId: string };
  const later = [
    { id: "report-question", kind: "report" as const, atMs: 160_000, order: 900, data: { status: "question", text: "Which export format first?", delivery: callId } },
    { id: "report-blocked", kind: "report" as const, atMs: 170_000, order: 901, data: { status: "blocked", text: "Waiting for the audit.", delivery: callId } },
  ];
  const root = mounted!.root;
  await act(async () => root.render(<CompanionTranscript record={{ entries: [...record.entries, ...later], truncated: false }} left={0} top={0} width={360} height={560} onClose={() => {}} />));
  await act(async () => settle());
  const all = [...mounted!.host.querySelectorAll<HTMLElement>("[data-transcript-answer]")];
  expect(all.map((answer) => answer.querySelector(".vc-answer")!.textContent)).toEqual([...reports, ...later].map((entry) => String(entry.data.text)));
  expect(all.map((answer) => answer.querySelector(".vc-tr-time")!.textContent)).toEqual(["2:06", "2:31", "2:40", "2:50"]);
});

test("a record that reached its size limit says some content was not retained, in both languages, with no claim about which part", async () => {
  const { transcriptLabels } = await import("./CompanionTranscript");
  for (const locale of ["en", "uk"] as const) expect(transcriptLabels(locale).truncated, locale).not.toMatch(/earliest|first part|beginning|найраніш|початок|початк/iu);
  expect(transcriptLabels("en").truncated).toContain("Part of the conversation is not kept");
  expect(transcriptLabels("uk").truncated).toContain("Частина розмови не збереглася");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<CompanionTranscript record={{ ...sampleTranscript("en"), truncated: true }} left={0} top={0} width={360} height={560} onClose={() => {}} />));
  await act(async () => settle());
  expect(host.querySelector("[data-transcript-body]")!.textContent).toContain(transcriptLabels("en").truncated);
});

test("a record waits for a report only while a queued or delivered request has no report beyond progress", () => {
  const request = (status: string) => ({ id: "request-1", kind: "request" as const, atMs: 1_000, order: 1, data: { callId: "call-1", status, instruction: "Review the plan" } });
  const report = (status: string, order: number) => ({ id: `report-${order}`, kind: "report" as const, atMs: 2_000, order, data: { status, text: "Checked", delivery: { callId: "call-1" } } });
  const wait = (...entries: Parameters<typeof awaitsReport>[0]["entries"]) => awaitsReport({ entries, truncated: false });
  expect([wait(request("queued")), wait(request("delivered")), wait(request("queued"), report("progress", 2))]).toEqual([true, true, true]);
  expect([wait(request("queued"), report("result", 2)), wait(request("failed")), wait(request("refused")), wait(request("cancelled")), wait()]).toEqual([false, false, false, false, false]);
});

test("an opened failed call states its refusal once outside the raw result, and what was passed to the voice appears only when it differs from the result's speech", async () => {
  const { view } = await open();
  const call = view.querySelector<HTMLElement>('[data-transcript-call="get_task"]')!;
  await click(call.querySelector("[data-transcript-toggle]"));
  const detail = call.querySelector<HTMLElement>("[data-transcript-detail]")!;
  /* The arguments and the result stay. */
  expect(detail.textContent).toContain("Arguments");
  expect(detail.querySelectorAll("pre")).toHaveLength(2);
  /* Outside the result block there is no second statement of the refusal, loose or as a voice hand-off. */
  const outside = [...detail.children].filter((child) => child.tagName !== "PRE").map((child) => child.textContent).join(" ");
  expect(outside).not.toContain("project refused");
  expect(detail.querySelector(".vc-tr-reason, .vc-tr-handoff")).toBeNull();
  expect(detail.textContent).not.toContain("Passed to the voice");

  /* A hand-off that says something the result does not stays, once. */
  const entries = sampleTranscript("en").entries.map((entry) => (entry.id === "handoff-open" ? { ...entry, data: { ...entry.data, text: "Tell them the other project owns it." } } : entry));
  await act(async () => mounted!.root.render(<CompanionTranscript record={{ entries, truncated: false }} left={0} top={0} width={360} height={560} onClose={() => {}} />));
  await act(async () => settle());
  const again = mounted!.host.querySelector<HTMLElement>('[data-transcript-call="get_task"]')!;
  /* The line keeps the open state it had across the new record. */
  expect(again.querySelector("[data-transcript-detail]")).toBeTruthy();
  const handoffs = again.querySelectorAll(".vc-tr-handoff");
  expect(handoffs).toHaveLength(1);
  expect(handoffs[0]!.textContent).toContain("Passed to the voice");
  expect(handoffs[0]!.textContent).toContain("Tell them the other project owns it.");
});

test("a failed call whose result is missing keeps its reason, so the refusal is never absent", async () => {
  const entries = [{ id: "tool-x", kind: "tool" as const, atMs: 1_000, order: 0, data: { name: "get_task", callId: "x", arguments: "{}", status: "failed", reason: "project refused" } }];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<CompanionTranscript record={{ entries, truncated: false }} left={0} top={0} width={360} height={560} onClose={() => {}} />));
  await act(async () => settle());
  await click(host.querySelector("[data-transcript-toggle]"));
  expect(host.querySelector("[data-transcript-detail]")!.textContent!.match(/project refused/g)).toHaveLength(1);
});

test("the request row's human label is set in the UI sans font, not the tool-name monospace, and does not wrap", async () => {
  const { view } = await open();
  const label = view.querySelector<HTMLElement>("[data-transcript-request] .vc-call-name")!;
  expect(label.hasAttribute("data-human-label")).toBe(true);
  const real = view.querySelector<HTMLElement>('[data-tool="get_task"] .vc-call-name')!;
  expect(real.hasAttribute("data-human-label")).toBe(false);
  expect(TRANSCRIPT_CSS).toMatch(/\.vc-call-name\[data-human-label\]\s*\{[^}]*font-family:\s*inherit/);
  expect(TRANSCRIPT_CSS).toMatch(/\.vc-call-name\[data-human-label\]\s*\{[^}]*white-space:\s*nowrap/);
});


test("the transcript header shows live, settled and incomplete spend in both languages", async () => {
  const { setLocale } = await import("@/lib/i18n");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  try {
    for (const locale of ["en", "uk"] as const) {
      await act(async () => setLocale(locale));
      const usage = { callUsd: 0.19, callFinal: false, callIncomplete: false, month: "2026-10", monthUsd: 0.51, monthCapUsd: 20 };
      const render = async (value: typeof usage) => act(async () => root.render(<CompanionTranscript record={{ ...sampleTranscript(locale), usage: value }} left={0} top={0} width={360} height={560} onClose={() => {}} />));
      await render(usage);
      const line = () => host.querySelector<HTMLElement>("[data-companion-spend]")!;
      expect(line().textContent).toBe(locale === "en" ? "This call $0.19 · October $0.51 of $20.00" : "Ця розмова $0.19 · жовтень $0.51 із $20.00");
      expect(line().getAttribute("aria-label")).toContain("$20.00");
      expect(line().hasAttribute("title")).toBe(false);
      await render({ ...usage, callFinal: true, callUsd: 0.4, monthUsd: 16 });
      expect(line().dataset.final).toBe("true");
      expect(line().textContent).toContain("$0.40");
      expect(line().querySelector('[data-tone="warning"]')).toBeTruthy();
      await render({ ...usage, callIncomplete: true, callUsd: 0.004, monthUsd: 20 });
      expect(line().textContent).toContain("<$0.01");
      expect(line().textContent).toContain(locale === "en" ? "estimated" : "орієнтовно");
      expect(line().title).toContain("OpenAI");
      expect(line().querySelector('[data-tone="danger"]')).toBeTruthy();
    }
  } finally { await act(async () => setLocale("en")); }
});

test("a short call without final usage shows its retained reservation as an estimate", async () => {
  const { CompanionStorage } = await import("@/lib/voiceCompanion/storage");
  const { CompanionAdmission } = await import("@/lib/voiceCompanion/admission");
  const { setLocale } = await import("@/lib/i18n");
  const now = Date.UTC(2026, 9, 10);
  const storage = new CompanionStorage(() => now);
  const admission = new CompanionAdmission(storage, { recipient: () => null, reports: () => [], send: async () => { throw new Error("unused"); } }, () => now);
  const session = admission.create({ project: "estimate", locale: "en", startedBy: { operator: true } });
  storage.reserve(session.id, 0.27);
  storage.observe(session.id, 0.002);
  storage.settle(session.id, null);
  const usage = storage.usageFor(session.id);
  expect(usage).toMatchObject({ callUsd: 0.27, callFinal: false, callIncomplete: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  try {
    for (const locale of ["en", "uk"] as const) {
      await act(async () => setLocale(locale));
      await act(async () => root.render(<CompanionTranscript record={{ ...sampleTranscript(locale), usage }} left={0} top={0} width={360} height={560} onClose={() => {}} />));
      const line = host.querySelector<HTMLElement>("[data-companion-spend]")!;
      const qualifier = locale === "en" ? "estimated" : "орієнтовно";
      expect(line.textContent).toContain(qualifier);
      expect(line.textContent).toContain("$0.27");
      expect(line.getAttribute("aria-label")!.toLowerCase()).toContain(qualifier);
      expect(line.textContent).not.toMatch(/at least|щонайменше/iu);
      expect(line.dataset.final).toBe("false");
    }
  } finally { await act(async () => setLocale("en")); }
});
