import { afterEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { resetEngineAccountsStoresForTests } from "@/hooks/useEngineAccounts";
import { installActEnv } from "@/test-helpers/actEnv";
import type { LimitsPayload } from "@/lib/types";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.Event,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  localStorage: dom.localStorage,
});

const NOW = Math.round(Date.now() / 1000);

let limits: LimitsPayload;
let limitsUnavailable = false;
let copilotAccountsResponse: Record<string, unknown> = { cli: { present: false, reason: null }, active: "", accounts: [] };
const copilotActions: Record<string, unknown>[] = [];
const baseAccount = {
  id: "account-a",
  label: "Account A",
  kind: "managed",
  authPresent: true,
  auth: { state: "authenticated" },
  loginPending: false,
  loginState: "authenticated",
  deviceAuth: null,
  effective: { percent: 79, window: "weekly", freshness: "fresh" },
  limits: {
    state: "fresh",
    session: null,
    weekly: { usedPercent: 21, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 },
    checkedAt: new Date((NOW - 60) * 1000).toISOString(),
  },
};
const accounts = {
  codex: { active: "account-a", accounts: [baseAccount] },
  claude: { active: "claude-a", accounts: [] },
};

// The singleton account stores resolve the active global fetch at request time,
// so this lifecycle-owned stub remains valid regardless of import order.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === "/api/limits") return limitsUnavailable ? new Response(null, { status: 503 }) : Response.json(limits);
  if (url === "/api/accounts") return Response.json(accounts);
  if (url === "/api/accounts/copilot") {
    if (init?.method === "POST") copilotActions.push(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
    return Response.json(copilotAccountsResponse);
  }
  return new Response(null, { status: 404 });
}) as unknown as typeof fetch;

const { LimitsFooter, fmtQuotaStaleHint } = await import("./LimitsFooter");

let root: Root | null = null;

function engineBlock(host: HTMLElement, engine: "claude" | "codex" | "copilot"): HTMLElement {
  return host.querySelector(`[data-engine-limits="${engine}"]`) as HTMLElement;
}

/** The line every mode draws: the active account, then what is left of its tightest window. */
function meterLine(block: HTMLElement) {
  const line = block.querySelector("[data-meter-line]");
  return {
    name: line?.querySelector("[data-meter-name]")?.textContent ?? null,
    value: line?.querySelector("[data-meter-value]")?.textContent ?? null,
    /** The tooltip that names every window, on the control that opens the chart. */
    windows: line?.querySelector("[data-meter-value]")?.closest("button")?.getAttribute("title") ?? "",
  };
}
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
  accounts.codex.accounts = [baseAccount];
  accounts.codex.active = "account-a";
  accounts.claude.accounts = [];
  accounts.claude.active = "claude-a";
  // The account stores read /api/accounts once per process; the next case starts from its own roster.
  resetEngineAccountsStoresForTests();
  limitsUnavailable = false;
  copilotAccountsResponse = { cli: { present: false, reason: null }, active: "", accounts: [] };
  copilotActions.length = 0;
  setSystemTime();
});

/* The sidebar mounts this block as `line`, and as `detail` behind "All windows":
   the same lines, and under each account every window with its reset. */
type Density = "line" | "detail";
const DENSITIES: Density[] = ["line", "detail"];

async function render(density: Density = "detail"): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<LimitsFooter density={density} />);
  });
  // One more turn for the limits and accounts responses to land.
  await act(async () => { await Promise.resolve(); });
  return host;
}

for (const density of DENSITIES) test(`the Copilot ${density} renders its monthly transcript allowance`, async () => {
  copilotAccountsResponse = {
    cli: { present: true, reason: null },
    active: "copilot-a",
    accounts: [{ id: "copilot-a", label: "Copilot", kind: "managed", active: true, loginCommand: null }],
  };
  limits = {
    claude: null,
    codex: null,
    copilot: { session: null, weekly: { usedPercent: 0.2, resetsAt: NOW + 10 * 86_400, windowMinutes: 30 * 1440, observedAt: NOW }, tiers: [], plan: null, capturedAt: NOW },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    copilotAccountId: "copilot-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "unavailable", reason: null, staleSince: null },
      copilot: { source: "transcript", reason: null, staleSince: null },
    },
  };
  const block = engineBlock(await render(density), "copilot");
  expect(meterLine(block)).toMatchObject({ name: "Copilot", value: "left 100%" });
  expect(block.querySelector("button")?.getAttribute("title")).toContain("Month left 100%");
  // The window by its own name, with its reset, stands behind "All windows" only.
  const windows = block.querySelector("[data-limits-windows]");
  expect(Boolean(windows)).toBe(density === "detail");
  if (density === "detail") {
    expect(windows?.textContent).toContain("Month");
    expect(windows?.textContent).toContain("100%");
    expect(windows?.textContent).toContain("reset");
  }
});

for (const density of DENSITIES) test(`a weekly-horizon Codex window is labelled Week in the ${density} footer, never 5h`, async () => {
  // The production shape of #606: the only window the plan reports is a weekly
  // one, and it arrives in the session field. The footer row must be named by
  // the horizon the number carries.
  limits = {
    claude: null,
    codex: { session: { usedPercent: 15, resetsAt: NOW + 437_631, windowMinutes: 10_080 }, weekly: null, plan: "pro", capturedAt: NOW },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "live", reason: null, staleSince: null },
    },
    staleSince: null,
  };
  const block = engineBlock(await render(density), "codex");
  // 100 − 15 remaining, under the weekly label, in the tooltip that names every window.
  expect(meterLine(block).windows).toContain("Week left 85%");
  expect(meterLine(block).windows).not.toContain("5h");
  if (density === "detail") {
    const windows = block.querySelector("[data-limits-windows]")?.textContent ?? "";
    expect(windows).toContain("Week");
    expect(windows).not.toContain("5h");
    expect(windows).toContain("85%");
  }
  expect(block.textContent).not.toContain("5h");
});

for (const density of DENSITIES) test(`the ${density} Copilot switcher requires explicit consent for plaintext token storage`, async () => {
  copilotAccountsResponse = {
    cli: { present: true, reason: null },
    active: "copilot-fixture",
    accounts: [{
      id: "copilot-fixture", label: "Copilot Fixture", kind: "managed", active: true,
      auth: "signed_out", user: null, loginCommand: "copilot login --device-code",
      login: { operationId: "copilot-login-fixture", phase: "awaiting_storage_choice", loginUrl: null, userCode: null, deadlineAt: "soon" },
    }],
  };
  const host = await render(density);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const copilot = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.includes("Copilot"));
  expect(copilot).toBeDefined();
  await act(async () => { copilot?.click(); });
  const dialog = host.querySelector('[role="dialog"][aria-label="GitHub Copilot accounts"]');
  expect(dialog?.textContent).toContain("The system keychain is unavailable");
  expect(dialog?.textContent).toContain("Store in plain text");
  expect(dialog?.textContent).toContain("Cancel sign-in");
  expect(copilotActions).toEqual([]);

  const accept = [...(dialog?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Store in plain text");
  await act(async () => { accept?.click(); });
  expect(copilotActions).toEqual([{
    action: "choose-plaintext-storage", operationId: "copilot-login-fixture", acceptPlaintext: true,
  }]);
});

test("a genuine 5-hour window keeps the 5h label", async () => {
  limits = {
    claude: null,
    codex: { session: { usedPercent: 40, resetsAt: NOW + 3_600, windowMinutes: 300 }, weekly: { usedPercent: 10, resetsAt: NOW + 172_800, windowMinutes: 10_080 }, plan: "pro", capturedAt: NOW },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "live", reason: null, staleSince: null },
    },
    staleSince: null,
  };
  const line = meterLine(engineBlock(await render("line"), "codex"));
  expect(line.value).toBe("left 60%"); // the session is the tighter of the two
  expect(line.windows).toBe("5h left 60% · Week left 90%");
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();

  const windows = engineBlock(await render("detail"), "codex").querySelector("[data-limits-windows]")?.textContent ?? "";
  expect(windows).toContain("Codex · pro");
  expect(windows).toContain("5h");
  expect(windows).toContain("Week");
});

for (const density of DENSITIES) test(`provider exhaustion reconciles the ${density} reading, its window and the panel to zero`, async () => {
  accounts.codex.accounts = [{
    ...baseAccount,
    effective: { percent: 79, window: "weekly", freshness: "fresh" },
    limits: {
      state: "fresh",
      session: null,
      weekly: { usedPercent: 21, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 },
      checkedAt: new Date((NOW - 60) * 1000).toISOString(),
    },
  }];
  limits = {
    claude: null,
    codex: { session: null, weekly: { usedPercent: 100, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 }, plan: "prolite", capturedAt: NOW - 600 },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "transcript", reason: "transcript-reconciled", staleSince: null },
    },
  };

  const host = await render(density);
  const text = host.textContent ?? "";
  expect(text).not.toContain("79%");
  const line = meterLine(engineBlock(host, "codex"));
  expect(line.value).toBe("left 0%");
  expect(line.windows).toBe("Week left 0%");
  // Behind "All windows" the weekly window says the same zero under the line.
  expect(text.match(/0%/g)?.length ?? 0).toBe(density === "detail" ? 2 : 1);

  const trigger = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.includes("Codex"));
  expect(trigger).toBeDefined();
  await act(async () => { trigger?.click(); });
  const dialog = host.querySelector('[role="dialog"][aria-label*="Codex"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.textContent).not.toContain("79%");
  expect(dialog?.textContent).toContain("0%");
});

test("a stale reconciled number renders a visible as-of hint", async () => {
  limits = {
    claude: null,
    codex: { session: null, weekly: { usedPercent: 100, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 }, plan: "prolite", capturedAt: NOW - 30 * 60 },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "transcript", reason: "transcript-reconciled", staleSince: null },
    },
  };

  // The line carries the reason on its amber dot and dims; the hour is spelled out on the window.
  const line = engineBlock(await render("line"), "codex");
  expect(line.querySelector("[data-limits-stale-dot]")?.getAttribute("title")).toContain("as of");
  expect(line.querySelector("[data-meter-line]")?.className).toContain("opacity-60");
  expect(line.textContent).not.toContain("as of");
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();

  const detail = engineBlock(await render("detail"), "codex");
  expect(detail.querySelector("[data-limits-stale-dot]")?.getAttribute("title")).toContain("as of");
  expect(detail.querySelector("[data-limits-windows]")?.textContent).toContain("as of");
});

test("timestamp-less stale footer rows retain a visible last-known label", () => {
  expect(fmtQuotaStaleHint(true, null, "en")).toBe("Last known values");
  expect(fmtQuotaStaleHint(false, null, "en")).toBeNull();
});

test("failed polls still advance stale age and expired-exhaustion selection", async () => {
  const realSetInterval = globalThis.setInterval;
  let poll: (() => Promise<void>) | null = null;
  globalThis.setInterval = ((handler: TimerHandler) => {
    poll = handler as () => Promise<void>;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  setSystemTime(new Date(NOW * 1000));
  limits = {
    claude: null,
    codex: {
      session: { usedPercent: 50, resetsAt: NOW + 3_600, windowMinutes: 300, observedAt: NOW - 19 * 60 },
      weekly: { usedPercent: 100, resetsAt: NOW + 30, windowMinutes: 10_080, observedAt: NOW - 19 * 60 },
      plan: "prolite",
      capturedAt: NOW - 19 * 60,
    },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "transcript", reason: "transcript-reconciled", staleSince: null },
    },
  };

  try {
    const host = await render();
    expect(host.textContent).toContain("0%");
    expect(host.textContent).not.toContain("as of");

    limitsUnavailable = true;
    setSystemTime(new Date((NOW + 120) * 1000));
    await act(async () => { await poll?.(); });

    expect(host.textContent).toContain("79%");
    expect(host.textContent).toContain("as of");
  } finally {
    globalThis.setInterval = realSetInterval;
  }
});

test("failed polls retain the original receipt time for timestamp-less Claude windows", async () => {
  const realSetInterval = globalThis.setInterval;
  let poll: (() => Promise<void>) | null = null;
  globalThis.setInterval = ((handler: TimerHandler) => {
    poll = handler as () => Promise<void>;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  setSystemTime(new Date(NOW * 1000));
  limits = {
    claude: {
      session: { usedPercent: 50, resetsAt: NOW + 3_600, windowMinutes: 300 },
      weekly: null,
      plan: "max",
      capturedAt: null,
    },
    codex: null,
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "live", reason: null, staleSince: null },
      codex: { source: "unavailable", reason: null, staleSince: null },
    },
  };

  try {
    const block = claudeBlock(await render());
    expect(block.querySelector("[data-limits-stale-dot]")).toBeNull();
    expect(block?.textContent).not.toContain("as of");

    limitsUnavailable = true;
    setSystemTime(new Date((NOW + 21 * 60) * 1000));
    await act(async () => { await poll?.(); });

    expect(block?.textContent).toContain("as of");
    expect(block.querySelector("[data-limits-stale-dot]")?.getAttribute("title")).toContain("as of");
  } finally {
    globalThis.setInterval = realSetInterval;
  }
});

for (const density of DENSITIES) test(`an account B limits payload cannot override account A at the ${density} rendering seam`, async () => {
  limits = {
    claude: null,
    codex: { session: null, weekly: { usedPercent: 100, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 }, plan: "prolite", capturedAt: NOW - 60 },
    claudeAccountId: "claude-a",
    codexAccountId: "account-b",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "transcript", reason: "transcript-reconciled", staleSince: null },
    },
  };

  const host = await render(density);
  const text = host.textContent ?? "";
  expect(text).toContain("79%");
  expect(text).not.toContain("0%");
  const line = meterLine(engineBlock(host, "codex"));
  expect(line).toMatchObject({ name: "Account A", value: "left 79%", windows: "Week left 79%" });
});

// ── Issues #1358 / #1796 — each metered tier's weekly as its own footer row ──

const claudePayload = (tiers: { tier: string; usedPercent: number }[]): LimitsPayload => ({
  claude: {
    session: { usedPercent: 12, resetsAt: NOW + 3_600, windowMinutes: 300 },
    weekly: { usedPercent: 40, resetsAt: NOW + 4 * 86_400, windowMinutes: 10_080 },
    tiers: tiers.map((entry) => ({ usedPercent: entry.usedPercent, resetsAt: NOW + 4 * 86_400, windowMinutes: 10_080, tier: entry.tier })),
    plan: "max",
    capturedAt: NOW,
  },
  codex: null,
  claudeAccountId: "claude-a",
  codexAccountId: "account-a",
  provenance: {
    claude: { source: "live", reason: null, staleSince: null },
    codex: { source: "unavailable", reason: null, staleSince: null },
  },
  staleSince: null,
});

function claudeBlock(host: HTMLElement): HTMLElement {
  return engineBlock(host, "claude");
}

test("no tier bucket: the Claude block keeps its two rows and no placeholder", async () => {
  limits = claudePayload([]);
  const block = claudeBlock(await render());
  expect(block.textContent).toContain("5h");
  expect(block.textContent).toContain("Week");
  expect(block.textContent).not.toContain("Opus · Week");
  expect(meterLine(block).value).toBe("left 60%"); // the general week binds the line
  expect(block.querySelectorAll("[data-limits-windows] [data-meter-window]").length).toBe(2);
});

test("a healthy tier bucket renders as a third row named by the tier, and the general week still binds the line", async () => {
  limits = claudePayload([{ tier: "opus", usedPercent: 10 }]);
  const block = claudeBlock(await render());
  expect(block.textContent).toContain("Opus · Week");
  expect(block.textContent).toContain("90%");
  expect(meterLine(block).value).toBe("left 60%");
  expect(block.querySelectorAll("[data-limits-windows] [data-meter-window]").length).toBe(3);
  expect(block.textContent?.match(/reset/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
});

test("a tier bucket tighter than the general week binds the line in both modes", async () => {
  limits = claudePayload([{ tier: "opus", usedPercent: 80 }]);
  for (const density of DENSITIES) {
    const block = claudeBlock(await render(density));
    const line = meterLine(block);
    expect(line.value).toBe("left 20%");
    expect(line.windows).toBe("5h left 88% · Week left 60% · Opus · Week left 20%");
    expect(Boolean(block.querySelector("[data-limits-windows]"))).toBe(density === "detail");
    if (density === "detail") expect(block.querySelector("[data-limits-windows]")?.textContent).toContain("Opus · Week");
    await act(async () => { root?.unmount(); });
    root = null;
    document.body.replaceChildren();
  }
});

test("every tier the provider meters gets its own footer line, Fable included (#1796)", async () => {
  limits = claudePayload([{ tier: "fable", usedPercent: 88 }, { tier: "opus", usedPercent: 63 }]);
  const block = claudeBlock(await render());
  expect(block.textContent).toContain("Fable · Week");
  expect(block.textContent).toContain("Opus · Week");
  expect(meterLine(block).value).toBe("left 12%"); // Fable is the tightest, so it binds the line
  expect(block.textContent).toContain("37%");
  expect(meterLine(block).windows).toBe("5h left 88% · Week left 60% · Fable · Week left 12% · Opus · Week left 37%");
});

// ── Compact footer: one line per account, every Claude and Codex account ──

/** An account row as `GET /api/accounts` answers it; `used` null means no reading exists. */
const roster = (id: string, label: string, used: number | null, extra: Record<string, unknown> = {}) => ({
  ...baseAccount,
  id,
  label,
  effective: undefined,
  limits: used === null ? null : {
    state: "fresh",
    session: { usedPercent: used, resetsAt: NOW + 3_600, windowMinutes: 300 },
    weekly: null,
    checkedAt: new Date((NOW - 60) * 1000).toISOString(),
  },
  ...extra,
});

const rosterLimits = (): LimitsPayload => ({
  claude: { session: { usedPercent: 10, resetsAt: NOW + 3_600, windowMinutes: 300 }, weekly: null, plan: "max", capturedAt: NOW },
  codex: { session: { usedPercent: 25, resetsAt: NOW + 3_600, windowMinutes: 300 }, weekly: null, plan: "pro", capturedAt: NOW },
  claudeAccountId: "claude-a",
  codexAccountId: "codex-a",
  provenance: {
    claude: { source: "live", reason: null, staleSince: null },
    codex: { source: "live", reason: null, staleSince: null },
  },
  staleSince: null,
});

function seedRoster() {
  limits = rosterLimits();
  accounts.claude.active = "claude-a";
  accounts.claude.accounts = [roster("claude-a", "Claude A", 10), roster("claude-b", "Claude B", 70)] as never;
  accounts.codex.active = "codex-a";
  accounts.codex.accounts = [roster("codex-a", "Codex A", 25), roster("codex-b", "Codex B", 40), roster("codex-c", "Codex C", null)] as never;
}

const accountRows = (block: HTMLElement) => [...block.querySelectorAll<HTMLElement>("[data-footer-account]")];
const rowReading = (row: HTMLElement) => ({
  id: row.dataset.footerAccount,
  name: row.querySelector("[data-meter-name]")?.textContent ?? null,
  value: row.querySelector("[data-meter-value]")?.textContent ?? row.querySelector("[data-limits-reason]")?.textContent ?? null,
  active: row.dataset.footerAccountActive === "true",
});

test("the compact footer draws one line for every account of each engine, the active one marked", async () => {
  seedRoster();
  const host = await render("line");
  const claude = accountRows(engineBlock(host, "claude")).map(rowReading);
  const codex = accountRows(engineBlock(host, "codex")).map(rowReading);
  expect(claude).toEqual([
    { id: "claude-a", name: "Claude A", value: "left 90%", active: true },
    { id: "claude-b", name: "Claude B", value: "left 30%", active: false },
  ]);
  expect(codex).toEqual([
    { id: "codex-a", name: "Codex A", value: "left 75%", active: true },
    { id: "codex-b", name: "Codex B", value: "left 60%", active: false },
    // No reading at all: the existing "no data yet" treatment.
    { id: "codex-c", name: "Codex C", value: "no data yet", active: false },
  ]);
  // Claude first, then Codex, as before.
  const order = [...host.querySelectorAll("[data-engine-limits]")].map((block) => block.getAttribute("data-engine-limits"));
  expect(order.slice(0, 2)).toEqual(["claude", "codex"]);
  // Each line with a reading draws the bar of the share it names.
  const bars = accountRows(engineBlock(host, "codex")).map((row) => row.querySelector("[data-meter-bar]")?.getAttribute("data-meter-bar") ?? null);
  expect(bars).toEqual(["75", "60", null]);
});

test("a non-active account line reads its own windows, never the active account's", async () => {
  seedRoster();
  const host = await render("line");
  const row = accountRows(engineBlock(host, "codex"))[1]!;
  expect(row.querySelector("button")?.getAttribute("title")).toContain("5h left 60%");
  expect(row.textContent).not.toContain("75%");
});

test("a line with an old reading dims and carries the amber dot", async () => {
  seedRoster();
  accounts.codex.accounts = [
    roster("codex-a", "Codex A", 25),
    roster("codex-b", "Codex B", 40, { limits: { state: "stale", session: { usedPercent: 40, resetsAt: NOW + 3_600, windowMinutes: 300 }, weekly: null, checkedAt: new Date((NOW - 3 * 3_600) * 1000).toISOString() } }),
  ] as never;
  const rows = accountRows(engineBlock(await render("line"), "codex"));
  expect(rows[0]!.querySelector("[data-limits-stale-dot]")).toBeNull();
  expect(rows[1]!.querySelector("[data-limits-stale-dot]")?.getAttribute("title")).toContain("as of");
  expect(rows[1]!.className).toContain("opacity-60");
});

test("a click on an account line opens the accounts panel focused on that account", async () => {
  seedRoster();
  const host = await render("line");
  const row = accountRows(engineBlock(host, "codex"))[1]!;
  await act(async () => { row.querySelector<HTMLButtonElement>("button")?.click(); });
  const dialog = host.querySelector('[role="dialog"][aria-label*="Codex"]');
  expect(dialog).not.toBeNull();
  const focused = [...(dialog?.querySelectorAll<HTMLElement>("*") ?? [])].filter((node) => node.classList.contains("ring-accent/50"));
  expect(focused.length).toBe(1);
  expect(focused[0]!.textContent).toContain("Codex B");
});

test("the active line opens the panel as it did, and its reading still opens the burndown chart", async () => {
  seedRoster();
  const host = await render("line");
  const block = engineBlock(host, "codex");
  const active = accountRows(block)[0]!;
  const buttons = active.querySelectorAll("button");
  expect(buttons.length).toBe(2);
  await act(async () => { buttons[0]!.click(); });
  expect(host.querySelector('[role="dialog"][aria-label*="Codex"]')).not.toBeNull();
  expect([...host.querySelectorAll("*")].filter((node) => node.classList.contains("ring-accent/50")).length).toBe(0);
  // Only the active account has a burndown history: its reading is a second control, the others have one.
  expect(buttons[1]!.getAttribute("aria-label")).toBe("Open Codex burndown chart");
  expect(accountRows(block).slice(1).every((row) => row.querySelectorAll("button").length === 1)).toBe(true);
});

test("a single account keeps the one line it always had", async () => {
  limits = rosterLimits();
  const block = engineBlock(await render("line"), "codex");
  expect(accountRows(block).length).toBe(1);
  expect(block.querySelectorAll("[data-meter-name]").length).toBe(1);
});

test("All windows stays one account per engine with every window", async () => {
  seedRoster();
  const host = await render("detail");
  for (const engine of ["claude", "codex"] as const) {
    const block = engineBlock(host, engine);
    expect(accountRows(block).length).toBe(1);
    expect(block.querySelectorAll("[data-meter-name]").length).toBe(1);
    expect(block.querySelector("[data-limits-windows]")).not.toBeNull();
  }
  expect(meterLine(engineBlock(host, "codex"))).toMatchObject({ name: "Codex A", value: "left 75%" });
  expect(host.textContent).not.toContain("Codex B");
  expect(host.textContent).not.toContain("Claude B");
});
