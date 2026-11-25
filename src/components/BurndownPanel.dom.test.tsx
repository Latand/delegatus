import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import type { BurndownPayload, BurndownSeries, EngineLimits } from "@/lib/types";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  localStorage: dom.localStorage,
});

const { BurndownPanel } = await import("./BurndownPanel");

const NOW = Math.round(Date.now() / 1000);

let payload: BurndownPayload;
let fetchUrls: string[] = [];
let fetchFails = false;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetchUrls.push(String(input));
  if (fetchFails) return new Response("{}", { status: 500 });
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

/** A weekly series with real history, as the Codex backfill produces it. */
function weeklySeries(): BurndownSeries {
  return {
    windowStart: NOW - 5 * 86_400,
    resetsAt: NOW + 2 * 86_400,
    windowSeconds: 7 * 24 * 3600,
    samples: [
      { t: NOW - 7_200, remaining: 70 },
      { t: NOW - 3_600, remaining: 55 },
      { t: NOW, remaining: 48 },
    ],
  };
}

/** The horizon the plan does not report at all: nothing to chart, ever. */
function unreportedSeries(windowSeconds: number): BurndownSeries {
  return { windowStart: null, resetsAt: null, windowSeconds, samples: [], windowUnreported: true };
}

let root: Root | null = null;
afterEach(async () => {
  fetchUrls = [];
  fetchFails = false;
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
});

async function render(props: { accountId?: string; accountLabel?: string; reading?: EngineLimits | null; engine?: "claude" | "codex" } = {}): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const engine = props.engine ?? "codex";
  await act(async () => {
    root = createRoot(host);
    root.render(<BurndownPanel engine={engine} label={engine === "codex" ? "Codex" : "Claude"} plan="pro" accountId={props.accountId ?? "account-a"} accountLabel={props.accountLabel ?? "Account A"} reading={props.reading ?? null} onClose={() => {}} />);
  });
  return host;
}

/** Paths drawn inside the plot itself; the panel's close icon is an svg too. */
function chartPaths(host: HTMLElement): number {
  const chart = host.querySelector('svg[role="img"]');
  return chart ? chart.querySelectorAll("path").length : 0;
}

function drawn(host: HTMLElement, kind: "known" | "estimated"): number {
  return host.querySelectorAll(`svg[role="img"] [data-burndown-${kind}]`).length;
}

function payloadFor(engine: "claude" | "codex", accountId: string, weekly: BurndownSeries, session: BurndownSeries = unreportedSeries(5 * 3600)): BurndownPayload {
  const series = { session, weekly };
  return {
    claude: engine === "claude" ? series : null,
    codex: engine === "codex" ? series : null,
    claudeAccountId: engine === "claude" ? accountId : null,
    codexAccountId: engine === "codex" ? accountId : null,
    historySince: null,
  };
}

/** A dense, fresh weekly series that opens at the window start. */
function denseSeries(): BurndownSeries {
  const windowStart = NOW - 2 * 3600;
  return {
    windowStart,
    resetsAt: windowStart + 7 * 86_400,
    windowSeconds: 7 * 86_400,
    // One reading every ten minutes: every gap is inside the solid threshold.
    samples: Array.from({ length: 13 }, (_, i) => ({ t: windowStart + i * 600, remaining: 100 - i })).concat([{ t: NOW, remaining: 84 }]),
  };
}

function tab(host: HTMLElement, name: string): HTMLElement {
  const found = [...host.querySelectorAll('[role="tab"]')].find((node) => (node.textContent ?? "").trim() === name);
  if (!found) throw new Error(`no tab labelled ${name} among ${[...host.querySelectorAll('[role="tab"]')].map((n) => n.textContent).join(", ")}`);
  return found as unknown as HTMLElement;
}

test("a Codex account with weekly history draws the weekly curve instead of claiming no history", async () => {
  payload = {
    claude: null,
    codex: { session: unreportedSeries(5 * 3600), weekly: weeklySeries() },
    claudeAccountId: null,
    codexAccountId: "account-a",
    historySince: new Date((NOW - 8 * 86_400) * 1000).toISOString(),
  };
  const host = await render();
  // The readings an hour apart are separate solid points joined by dashed gaps, with a dashed lead from the window's opening.
  expect(drawn(host, "known")).toBe(3);
  expect(drawn(host, "estimated")).toBe(3);
  expect(host.textContent ?? "").not.toContain("No history yet");
});

test("the 5h tab names the missing window instead of showing a generic empty state", async () => {
  payload = {
    claude: null,
    codex: { session: unreportedSeries(5 * 3600), weekly: weeklySeries() },
    claudeAccountId: null,
    codexAccountId: "account-a",
    historySince: new Date((NOW - 8 * 86_400) * 1000).toISOString(),
  };
  const host = await render();
  await act(async () => { tab(host, "5h").click(); });
  const text = host.textContent ?? "";
  expect(text).toContain("reports no 5h window");
  expect(text).not.toContain("No history yet");
  expect(chartPaths(host)).toBe(0);
});

test("each tab is named by the horizon its own series carries", async () => {
  // A series whose window is a week long is labelled "Week" wherever it sits,
  // so a weekly-horizon value is never presented as a 5-hour figure (#606).
  payload = {
    claude: null,
    codex: { session: { ...weeklySeries(), windowSeconds: 7 * 24 * 3600 }, weekly: weeklySeries() },
    claudeAccountId: null,
    codexAccountId: "account-a",
    historySince: null,
  };
  const host = await render();
  const labels = [...host.querySelectorAll('[role="tab"]')].map((node) => (node.textContent ?? "").trim());
  expect(labels).toEqual(["Week", "Week"]);
});

test("a history response for another account is not charted under this one", async () => {
  payload = {
    claude: null,
    codex: { session: unreportedSeries(5 * 3600), weekly: weeklySeries() },
    claudeAccountId: null,
    codexAccountId: "account-b",
    historySince: null,
  };
  const host = await render();
  expect(host.textContent ?? "").toContain("Loading history…");
  expect(chartPaths(host)).toBe(0);
});

test("a non-active account is fetched by engine and id, named in the header and charted", async () => {
  payload = payloadFor("claude", "acct-b", denseSeries());
  const host = await render({ engine: "claude", accountId: "acct-b", accountLabel: "Account B" });
  expect(fetchUrls).toEqual(["/api/limits/history?engine=claude&account=acct-b"]);
  expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Open Claude · Account B burndown chart");
  expect(host.textContent ?? "").toContain("Claude · Account B");
  expect(drawn(host, "known")).toBe(1);
  expect(drawn(host, "estimated")).toBe(0);
  expect(host.textContent ?? "").toContain("84% left");
});

test("a mid-week gap and a late first sample draw dashed segments beside the solid ones", async () => {
  const windowStart = NOW - 3 * 86_400;
  payload = payloadFor("codex", "account-a", {
    windowStart,
    resetsAt: windowStart + 7 * 86_400,
    windowSeconds: 7 * 86_400,
    samples: [
      { t: windowStart + 86_400, remaining: 80 },
      { t: windowStart + 86_400 + 600, remaining: 78 },
      { t: NOW - 600, remaining: 40 },
      { t: NOW, remaining: 39 },
    ],
  });
  const host = await render();
  // Two solid runs around the gap; the lead from the window's opening and the gap itself are dashed.
  expect(drawn(host, "known")).toBe(2);
  expect(drawn(host, "estimated")).toBe(2);
  expect(host.textContent ?? "").toContain("39% left");
  expect(host.textContent ?? "").toContain("estimated");
});

test("a stale observation continues as a dashed line to now with an approximate readout and no pace claim", async () => {
  const windowStart = NOW - 3 * 86_400;
  payload = payloadFor("codex", "account-a", {
    windowStart,
    resetsAt: windowStart + 7 * 86_400,
    windowSeconds: 7 * 86_400,
    samples: [
      { t: NOW - 6 * 3600 - 600, remaining: 62 },
      { t: NOW - 6 * 3600, remaining: 60 },
    ],
  });
  const host = await render();
  const text = host.textContent ?? "";
  expect(drawn(host, "estimated")).toBeGreaterThanOrEqual(1);
  expect(text).toContain("≈60% left");
  expect(text).not.toContain("burning fast");
  expect(text).not.toContain("room to spare");
  expect(text).not.toContain("on even pace");
  expect(text).not.toContain("at this rate");
});

test("an account nobody has read still shows the axes and an estimated level at 100%", async () => {
  const windowStart = NOW - 3 * 86_400;
  payload = payloadFor("codex", "account-a", { windowStart: null, resetsAt: null, windowSeconds: 7 * 86_400, samples: [], lastReading: null });
  void windowStart;
  const host = await render();
  expect(host.querySelector('svg[role="img"]')).not.toBeNull();
  expect(drawn(host, "known")).toBe(0);
  expect(drawn(host, "estimated")).toBe(1);
  const text = host.textContent ?? "";
  expect(text).toContain("No reading for this account yet");
  expect(text).not.toContain("No history yet");
});

test("a window that reset after the last reading is drawn as an assumed-full estimate", async () => {
  const windowStart = NOW - 3_600;
  payload = payloadFor("codex", "account-a", {
    windowStart,
    resetsAt: windowStart + 7 * 86_400,
    windowSeconds: 7 * 86_400,
    samples: [],
    lastReading: { t: NOW - 2 * 86_400, remaining: 12 },
  });
  const host = await render();
  expect(drawn(host, "estimated")).toBe(1);
  expect(host.textContent ?? "").toContain("The window reset after the last reading");
});

test("a failed history request still draws the chart from the row's own reading", async () => {
  fetchFails = true;
  const reading: EngineLimits = {
    session: null,
    weekly: { usedPercent: 35, resetsAt: NOW + 4 * 86_400, observedAt: NOW - 120, windowMinutes: 10_080 },
    plan: "pro",
    capturedAt: NOW - 120,
  };
  const host = await render({ reading });
  expect(host.querySelector('svg[role="img"]')).not.toBeNull();
  expect(drawn(host, "known")).toBe(1);
  expect(host.textContent ?? "").toContain("65% left");
  expect(host.textContent ?? "").toContain("Couldn't load history.");
});

test("a failed history request with no reading still draws an estimated chart", async () => {
  fetchFails = true;
  const host = await render();
  expect(host.querySelector('svg[role="img"]')).not.toBeNull();
  expect(drawn(host, "estimated")).toBe(1);
  expect(host.textContent ?? "").not.toContain("No history yet");
});

test("a plan with no weekly window opens on the 5h tab", async () => {
  payload = payloadFor("codex", "account-a", unreportedSeries(7 * 86_400), { ...denseSeries(), windowSeconds: 5 * 3600, resetsAt: NOW + 3 * 3600, windowStart: NOW - 2 * 3600 });
  const host = await render();
  const selected = [...host.querySelectorAll('[role="tab"]')].find((node) => node.getAttribute("aria-selected") === "true");
  expect((selected?.textContent ?? "").trim()).toBe("5h");
  expect(drawn(host, "known")).toBe(1);
});

test("the legend keys draw the chart's own dashes: estimated and even pace dashed, remaining solid", async () => {
  payload = {
    claude: null,
    codex: { session: unreportedSeries(5 * 3600), weekly: weeklySeries() },
    claudeAccountId: null,
    codexAccountId: "account-a",
    historySince: null,
  };
  const host = await render();
  const dash = (kind: string) => host.querySelector(`[data-burndown-key="${kind}"] line`)?.getAttribute("stroke-dasharray") ?? null;
  expect(drawn(host, "estimated")).toBeGreaterThan(0);
  expect(dash("estimated")).toBe("2 3");
  expect(dash("ideal")).toBe("4 3");
  expect(dash("actual")).toBeNull();
  // The estimated key shows exactly the dash the chart's estimated segment carries.
  expect(host.querySelector("svg[role=img] [data-burndown-estimated]")?.getAttribute("stroke-dasharray")).toBe(dash("estimated"));
});
