import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

/* The lane review sheet, rendered by React over the real route handlers
   (docs/design/lane-diff-comments.md §6, §10): every read and the send go
   through `laneChangesGET` and `laneReviewPOST` against a real git
   repository, with only the delivery to a conversation stubbed. State is
   sandboxed before anything that reads it loads. */

/* Each case drives real git several times; a loaded runner needs more than 5 s. */
setDefaultTimeout(30_000);

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-lane-review-sheet-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLTextAreaElement: dom.HTMLTextAreaElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });

const { NextRequest } = await import("next/server");
const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { laneChangesGET, laneReviewPOST } = await import("@/lib/laneReview/http");
const { createLaneRepo, LANE_BRANCH } = await import("@/lib/laneReview/gitFixture");
const { laneReviewDraftKey } = await import("@/lib/laneReview/model");
const { realExec } = await import("@/lib/workflows/provision");
const { setLocale } = await import("@/lib/i18n");
const { LaneReviewSheet } = await import("./LaneReviewSheet");
const { LaneReviewPhoneSheet } = await import("./LaneReviewPhoneSheet");

import type { LaneRepo } from "@/lib/laneReview/gitFixture";
import type { LaneReviewDelivery } from "@/lib/laneReview/http";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";

const WRITER = "conversation-writer";
const NOW = new Date("2026-10-23T09:30:00.000Z");

let lane: LaneRepo;
let pipeline: Pipeline;
let deliveries: LaneReviewDelivery[];
let deliverStatus: number;
let summaryStatus: number | null;
let operationReceipt: { status: string; resend?: string };
let operationCalls: Array<{ url: string; method: string; body?: string }>;
let ids: number;
let root: Root | null = null;
let host: HTMLElement;
let closed: number;

const writer = (n: number, conversationId: string, startedAt: string): PipelineStageAttempt => ({
  n, startedAt, conversationId, effectiveRole: { access: "read-write", engine: "claude" },
}) as PipelineStageAttempt;

const deps = () => ({
  pipeline: (id: string) => (id === pipeline.id ? pipeline : null),
  exec: realExec,
  deliver: async (delivery: LaneReviewDelivery) => {
    deliveries.push(delivery);
    return deliverStatus === 200
      ? Response.json({ ok: true, operationId: "op-1", receipt: { status: "queued" } })
      : Response.json({ error: "runtime host is unavailable" }, { status: deliverStatus });
  },
});

async function serve(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, "http://localhost");
  const method = init?.method ?? "GET";
  if (url.pathname.startsWith("/api/runtime/operations/")) {
    operationCalls.push({ url: url.pathname, method, ...(init?.body ? { body: String(init.body) } : {}) });
    return Response.json({ operationId: "op-1", receipt: method === "POST" ? { status: "queued" } : operationReceipt });
  }
  if (url.pathname.endsWith("/changes") && summaryStatus !== null && !url.search) return Response.json({ error: "git could not list the lane's changes" }, { status: summaryStatus });
  const request = new NextRequest(url, { method, headers: { host: "localhost", "sec-fetch-site": "same-origin", ...(init?.body ? { "content-type": "application/json" } : {}) }, ...(init?.body ? { body: init.body as string } : {}) });
  return url.pathname.endsWith("/review") ? laneReviewPOST(request, pipeline.id, deps()) : laneChangesGET(request, pipeline.id, deps());
}

const ports = () => ({ fetch: serve, storage: dom.localStorage as unknown as Storage, now: () => NOW, newId: () => `draft-${++ids}` });

beforeEach(() => {
  lane = createLaneRepo(SANDBOX);
  pipeline = lane.pipeline({ runs: [{ stageId: "build", attempts: [writer(1, WRITER, "2026-10-23T08:00:00.000Z")] }] });
  deliveries = [];
  deliverStatus = 200;
  summaryStatus = null;
  operationReceipt = { status: "queued" };
  operationCalls = [];
  ids = 0;
  closed = 0;
  dom.localStorage.clear();
  setLocale("en");
  host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
});

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  host.remove();
  lane.cleanup();
});

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
});

function mount() {
  root = createRoot(host);
  flushSync(() => root!.render(<LaneReviewSheet pipelineId={pipeline.id} title="Lane fixture" onClose={() => { closed += 1; }} ports={ports()} />));
}
function remount() {
  flushSync(() => root!.unmount());
  mount();
}

const $ = <T extends Element = HTMLElement>(selector: string) => host.querySelector(selector) as T | null;
const text = () => host.textContent ?? "";

async function until(check: () => boolean, label: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; the sheet reads: ${text().slice(0, 600)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function click(selector: string) {
  const element = $(selector);
  if (!element) throw new Error(`no ${selector}`);
  flushSync(() => element.click());
}

function type(selector: string, value: string) {
  const element = $<HTMLTextAreaElement>(selector)!;
  Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
  flushSync(() => element.dispatchEvent(new dom.Event("input", { bubbles: true }) as never));
}

const state = () => $("[data-lane-review]")?.getAttribute("data-lane-review-state");
const send = () => $<HTMLButtonElement>("[data-lane-review-send]")!;

async function ready() {
  mount();
  await until(() => state() === "ready", "ready");
  await until(() => Boolean($("[data-lane-review-file]")), "the file list");
}

async function commentOnNewLine5(body = "Keep the old name.") {
  click('[data-lane-review-file="src/app.ts"]');
  await until(() => Boolean($('[data-lane-review-line="new:5"]')), "src/app.ts rows");
  click('[data-lane-review-line="new:5"]');
  type("[data-lane-review-editor] textarea", body);
  click("[data-lane-review-save]");
}

async function moveBranch() {
  lane.git("checkout", "-q", LANE_BRANCH);
  lane.write("src/app.ts", `line 0a\nline 0b\n${fs.readFileSync(path.join(lane.dir, "src/app.ts"), "utf8")}`);
  lane.commit("two lines on top");
  lane.git("checkout", "-q", "--detach");
  dom.dispatchEvent(new dom.Event("focus") as never);
}

describe("the desktop sheet", () => {
  test("loading, then ready: the pinned pair, the totals, every file and the target", async () => {
    mount();
    expect(state()).toBe("loading");
    expect(text()).toContain("Reading changes…");
    /* Nothing is said about the target before it is known. */
    expect($("[data-lane-review-status]")!.textContent).toBe("");
    await until(() => state() === "ready", "ready");
    const files = [...host.querySelectorAll("[data-lane-review-file]")].map((row) => row.getAttribute("data-lane-review-file"));
    expect(files).toEqual(["assets/logo.bin", "src/added.ts", "src/app.ts", "src/gone.ts"]);
    expect($("[data-lane-review-pair]")!.textContent).toBe(`${lane.git("rev-parse", "main").slice(0, 10)} → ${lane.git("rev-parse", LANE_BRANCH).slice(0, 10)}`);
    expect($("[data-lane-review-totals]")!.textContent).toBe("4 files · +3 −2");
    expect($("[data-lane-review-status]")!.textContent).toBe("To build · Claude");
    expect(send().disabled).toBe(true);
    await until(() => text().includes("Binary file"), "the binary file's note");
  });

  test("a comment survives a remount; Esc in the editor keeps the sheet, Esc elsewhere closes it", async () => {
    await ready();
    await commentOnNewLine5();
    expect($("[data-lane-review-comment]")!.textContent).toContain("Keep the old name.");
    expect($("[data-lane-review-status]")!.textContent).toBe("1 comment to build · Claude");
    /* Edit and Delete each carry a 24 px target box (the board resets a button's padding). */
    const actions = [...host.querySelectorAll("[data-lane-review-comment-actions] button > span")];
    expect(actions.map((span) => span.textContent)).toEqual(["Edit", "Delete"]);
    for (const span of actions) expect(span.className).toContain("min-h-6");
    const stored = JSON.parse(dom.localStorage.getItem(laneReviewDraftKey(pipeline.id))!);
    expect(stored.comments).toMatchObject([{ path: "src/app.ts", side: "new", line: 5, quote: "line five", body: "Keep the old name.", state: "anchored" }]);
    remount();
    await until(() => Boolean($("[data-lane-review-comment]")), "the kept comment");
    expect(send().disabled).toBe(false);

    click('[data-lane-review-line="new:6"]');
    const editor = $("[data-lane-review-editor] textarea")!;
    flushSync(() => editor.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never));
    expect(closed).toBe(0);
    flushSync(() => $("[data-lane-review-send]")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never));
    expect(closed).toBe(1);
  });

  test("stale head: the comments are kept, Send waits for Re-anchor, and Re-anchor moves them", async () => {
    await ready();
    await commentOnNewLine5();
    await moveBranch();
    await until(() => state() === "stale", "stale");
    expect($("[data-lane-review-stale]")!.textContent).toContain("Your 1 comment is kept.");
    expect(send().disabled).toBe(true);
    expect(send().title).toBe("Re-anchor first: the comments point at an older commit");
    expect($("[data-lane-review-comment]")!.textContent).toContain("Keep the old name.");
    click("[data-lane-review-reanchor]");
    await until(() => Boolean($("[data-lane-review-reanchored]")), "re-anchored");
    expect($("[data-lane-review-reanchored]")!.textContent).toBe("1 moved, 0 need a line");
    const stored = JSON.parse(dom.localStorage.getItem(laneReviewDraftKey(pipeline.id))!);
    expect(stored.head).toBe(lane.git("rev-parse", LANE_BRANCH));
    expect(stored.comments[0]).toMatchObject({ line: 7, state: "moved" });
    expect(send().disabled).toBe(false);
  });

  test("a send the server refuses as head_moved delivers nothing and shows the stale state", async () => {
    await ready();
    await commentOnNewLine5();
    lane.git("checkout", "-q", LANE_BRANCH);
    lane.write("src/added.ts", "export const added = 2;\n");
    lane.commit("moves after the read");
    lane.git("checkout", "-q", "--detach");
    click("[data-lane-review-send]");
    await until(() => state() === "stale", "stale after the refused send");
    expect(deliveries.length).toBe(0);
  });

  test("a base-only move is stale too: the banner and Re-anchor appear, and Send then delivers once", async () => {
    lane.git("checkout", "-q", LANE_BRANCH);
    const tipA = lane.git("rev-parse", "HEAD");
    lane.write("src/app.ts", `${fs.readFileSync(path.join(lane.dir, "src/app.ts"), "utf8")}tail line\n`);
    lane.commit("second lane commit");
    lane.git("checkout", "-q", "--detach");
    await ready();
    click('[data-lane-review-file="src/app.ts"]');
    await until(() => Boolean($('[data-lane-review-line="new:32"]')), "the tail row");
    click('[data-lane-review-line="new:32"]');
    type("[data-lane-review-editor] textarea", "Name the tail.");
    click("[data-lane-review-save]");
    /* origin/main now holds the first lane commit; the branch tip stays put. */
    lane.git("update-ref", "refs/remotes/origin/main", tipA);
    click("[data-lane-review-send]");
    await until(() => state() === "stale", "stale after a base-only move");
    expect(deliveries.length).toBe(0);
    expect($("[data-lane-review-stale]")!.textContent).toContain("Your 1 comment is kept.");
    expect(send().disabled).toBe(true);
    click("[data-lane-review-reanchor]");
    await until(() => Boolean($("[data-lane-review-reanchored]")), "re-anchored");
    expect(state()).toBe("ready");
    click("[data-lane-review-send]");
    await until(() => deliveries.length === 1, "one delivery");
    expect(deliveries[0]!.text).toContain("Name the tail.");
  });

  test("sent: one delivery, the receipt word, and a renewed draft; a failed receipt retries through the runtime", async () => {
    await ready();
    await commentOnNewLine5();
    const before = JSON.parse(dom.localStorage.getItem(laneReviewDraftKey(pipeline.id))!).draftId;
    click("[data-lane-review-send]");
    await until(() => Boolean($("[data-lane-review-sent]")), "sent");
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.conversationId).toBe(WRITER);
    expect(deliveries[0]!.text).toContain("1. src/app.ts:5 (new)\n   > line five\n   Keep the old name.");
    expect($("[data-lane-review-sent]")!.textContent).toMatch(/^Sent to build at .+ · queued$/);
    const stored = JSON.parse(dom.localStorage.getItem(laneReviewDraftKey(pipeline.id))!);
    expect(stored).toMatchObject({ comments: [], sent: { operationId: "op-1", stageName: "build", clientMessageId: deliveries[0]!.clientMessageId } });
    expect(stored.draftId).not.toBe(before);
    await until(() => operationCalls.length > 0, "the receipt read");
    expect(operationCalls).toContainEqual({ url: "/api/runtime/operations/op-1", method: "GET" });

    operationReceipt = { status: "failed", resend: "safe" };
    dom.dispatchEvent(new dom.Event("focus") as never);
    await until(() => Boolean($("[data-lane-review-retry]")), "Retry delivery");
    expect($("[data-lane-review-sent]")!.textContent).toMatch(/^Not delivered to build \(sent .+\)$/);
    click("[data-lane-review-retry]");
    await until(() => operationCalls.some((call) => call.method === "POST"), "the runtime retry");
    expect(operationCalls.filter((call) => call.method === "POST")).toEqual([{ url: "/api/runtime/operations/op-1", method: "POST" }]);
  });

  async function sendAndReceive(receipt: { status: string; resend?: string }) {
    await ready();
    await commentOnNewLine5();
    click("[data-lane-review-send]");
    await until(() => Boolean($("[data-lane-review-sent]")), "sent");
    await until(() => operationCalls.length > 0, "the receipt read");
    operationReceipt = receipt;
    dom.dispatchEvent(new dom.Event("focus") as never);
  }

  test("a rejected receipt reads not delivered and Retry delivery posts the runtime retry once", async () => {
    await sendAndReceive({ status: "rejected", resend: "safe" });
    await until(() => Boolean($("[data-lane-review-retry]")), "Retry delivery");
    const line = $("[data-lane-review-sent]")!;
    expect(line.textContent).toMatch(/^Not delivered to build \(sent .+\)$/);
    /* The outcome leads and carries the danger tone; the delivered line stays muted. */
    expect(line.getAttribute("data-receipt")).toBe("failed");
    expect(line.className).toContain("text-danger");
    click("[data-lane-review-retry]");
    await until(() => operationCalls.some((call) => call.method === "POST"), "the runtime retry");
    expect(operationCalls.filter((call) => call.method === "POST")).toEqual([{ url: "/api/runtime/operations/op-1", method: "POST" }]);
  });

  test("an uncertain receipt says delivery is unconfirmed and re-checks verify-first, never a plain retry", async () => {
    await sendAndReceive({ status: "uncertain", resend: "verify-first" });
    await until(() => Boolean($("[data-lane-review-recheck]")), "Re-check delivery");
    const line = $("[data-lane-review-sent]")!;
    expect(line.textContent).toMatch(/^Delivery to build unconfirmed \(sent .+\)$/);
    expect(line.getAttribute("data-receipt")).toBe("unconfirmed");
    expect(line.className).toContain("text-warning");
    expect($("[data-lane-review-retry]")).toBeNull();
    click("[data-lane-review-recheck]");
    await until(() => operationCalls.some((call) => call.method === "POST"), "the verify-first retry");
    expect(operationCalls.filter((call) => call.method === "POST")).toEqual([
      { url: "/api/runtime/operations/op-1", method: "POST", body: JSON.stringify({ action: "retry-uncertain" }) },
    ]);
  });

  test("a steered receipt reads delivered and offers no retry", async () => {
    await sendAndReceive({ status: "steered" });
    await until(() => $("[data-lane-review-sent]")!.textContent!.includes("delivered"), "delivered word");
    expect($("[data-lane-review-sent]")!.textContent).toMatch(/^Sent to build at .+ · delivered$/);
    expect($("[data-lane-review-sent]")!.className).not.toMatch(/text-(danger|warning)/);
    expect($("[data-lane-review-retry]")).toBeNull();
    expect($("[data-lane-review-recheck]")).toBeNull();
  });

  test("failed: the comments are kept and Send again repeats the same key", async () => {
    await ready();
    await commentOnNewLine5();
    deliverStatus = 503;
    click("[data-lane-review-send]");
    await until(() => Boolean($("[data-lane-review-failed]")), "failed");
    expect($("[data-lane-review-failed]")!.textContent).toBe("Not sent: the server did not answer. Your comments are kept.");
    expect(send().textContent).toBe("Send again");
    expect($("[data-lane-review-comment]")).not.toBeNull();
    deliverStatus = 200;
    click("[data-lane-review-send]");
    await until(() => Boolean($("[data-lane-review-sent]")), "sent");
    expect(deliveries.map((delivery) => delivery.clientMessageId)).toEqual([deliveries[0]!.clientMessageId, deliveries[0]!.clientMessageId]);
  });

  test("target changed: the new writer is named and the next Send goes to it", async () => {
    await ready();
    await commentOnNewLine5();
    pipeline = { ...pipeline, runs: [...pipeline.runs, { stageId: "fix", attempts: [writer(1, "conversation-fix", "2026-10-23T09:00:00.000Z")] }] };
    click("[data-lane-review-send]");
    await until(() => text().includes("The lane's writer is now fix. Check and send again."), "target changed");
    expect(deliveries.length).toBe(0);
    click("[data-lane-review-send]");
    await until(() => Boolean($("[data-lane-review-sent]")), "sent");
    expect(deliveries[0]!.conversationId).toBe("conversation-fix");
  });

  test("no target, empty and error states", async () => {
    pipeline = { ...pipeline, runs: [] };
    await ready();
    expect($("[data-lane-review-no-target]")!.textContent).toBe("No stage has written to this lane yet");
    await commentOnNewLine5();
    expect(send().disabled).toBe(true);
    flushSync(() => root!.unmount());
    root = null;

    lane.git("update-ref", `refs/heads/${LANE_BRANCH}`, lane.git("rev-parse", "main"));
    dom.localStorage.clear();
    mount();
    await until(() => state() === "empty", "empty");
    expect($("[data-lane-review-empty]")!.textContent).toBe("No changes on this branch yet.");
    /* The pair is named once, in the header, and no empty file column remains. */
    expect($("[data-lane-review-files]")).toBeNull();
    expect(text().match(new RegExp(lane.git("rev-parse", "main").slice(0, 10), "g"))?.length).toBe(2);
    expect(send().disabled).toBe(true);
    flushSync(() => root!.unmount());
    root = null;

    summaryStatus = 500;
    mount();
    await until(() => state() === "error", "error");
    expect($("[data-lane-review-error]")!.textContent).toContain("Could not read the changes: the server did not answer");
    summaryStatus = null;
    click("[data-lane-review-error] button");
    await until(() => state() === "empty", "the retried read");
  });

  test("a refused storage write says the draft is not saved here", async () => {
    root = createRoot(host);
    flushSync(() => root!.render(<LaneReviewSheet pipelineId={pipeline.id} title="Lane fixture" onClose={() => undefined}
      ports={{ ...ports(), storage: { getItem: () => null, setItem: () => { throw new Error("quota"); } } }} />));
    await until(() => Boolean($("[data-lane-review-file]")), "the file list");
    await commentOnNewLine5();
    expect($("[data-lane-review-not-saved]")!.textContent).toBe("The draft is not saved on this device.");
    expect($("[data-lane-review-comment]")).not.toBeNull();
  });
});

describe("the phone sheet", () => {
  test("lists the files and one file's diff, with no gutter, no editor and no Send", async () => {
    root = createRoot(host);
    flushSync(() => root!.render(<LaneReviewPhoneSheet pipelineId={pipeline.id} onClose={() => undefined} fetchPort={serve} />));
    await until(() => Boolean(dom.document.querySelector("[data-lane-review-phone-file]")), "the phone list");
    const scope = dom.document.querySelector("[data-mobile2-lane-review]")!;
    expect(scope.textContent).toContain("Line comments are written on a computer.");
    flushSync(() => (dom.document.querySelector('[data-lane-review-phone-file="src/app.ts"]') as unknown as HTMLElement).click());
    await until(() => (scope.textContent ?? "").includes("line five"), "the phone diff");
    /* The opened row is marked and the card does not repeat its path and counts. */
    const row = scope.querySelector('[data-lane-review-phone-file="src/app.ts"]')!;
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.className).toContain("bg-sunken");
    expect((scope.textContent ?? "").match(/src\/app\.ts/g)?.length).toBe(1);
    expect(scope.querySelector("[data-lane-review-line]")).toBeNull();
    expect(scope.querySelector("[data-lane-review-send], [data-lane-review-editor], textarea")).toBeNull();
    expect(dom.localStorage.getItem(laneReviewDraftKey(pipeline.id))).toBeNull();
  });
});
