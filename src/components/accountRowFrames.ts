import fs from "node:fs";
import path from "node:path";
import type { Browser, Page } from "playwright-core";

import { openFixture } from "@/components/kanban/issue1695BrowserHarness";
import { translate } from "@/lib/i18n";

/*
 * Rendered frames of the account row, for the existing browser drivers
 * (`kanbanBoard.browser.test.tsx` for the dialog at 900 and 1440 px and the
 * widths between, `issue1671Evidence.browser.test.tsx` for the phone at 390).
 * The scene is `scenario=account-row` in the evidence fixture: the real
 * `AccountsPanel` or the real phone screen over the real store, answered by
 * the routes below, which send the shapes `GET /api/accounts` and its siblings
 * send. Account names are invented.
 *
 * Every state names the element that defines it. A frame fails when text
 * leaves its surface or overlaps other text, contrast falls under 4.5:1, a
 * target falls under the floor (44 px on the phone, 24 px on the desktop), a
 * row repeats its name, carries a decimal balance or a credits line outside
 * the 5% rule, a bar's tone disagrees with its number, a status popover leaves
 * the viewport or cuts a line, or the defining element is not whole.
 */

export type RowEngine = "claude" | "codex";
export type RowSet = "core" | "edge";
type Raw = Record<string, unknown> & { id: string; label: string };
type Model = Record<RowEngine, { active: string; accounts: Raw[] }>;

const HOUR = 3_600;
const DAY = 24 * HOUR;
const clock = () => Math.floor(Date.now() / 1000);

/** The accounts of one set, as `GET /api/accounts` sends them. */
export function accountRowModel(set: RowSet): Model {
  const NOW = clock();
  const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1000).toISOString();
  const week = (left: number, resetsIn: number) => ({ usedPercent: 100 - left, resetsAt: NOW + resetsIn, windowMinutes: 10_080, observedAt: NOW - 8 * 60, source: "account" });
  const session = (left: number, resetsIn: number) => ({ usedPercent: 100 - left, resetsAt: NOW + resetsIn, windowMinutes: 300, observedAt: NOW - 8 * 60, source: "account" });
  const tier = (name: string, label: string, left: number, resetsIn: number) => ({ ...week(left, resetsIn), tier: name, label });
  const fresh = (windows: Record<string, unknown>) => ({ state: "fresh", session: null, weekly: null, checkedAt: iso(8 * 60), ...windows });
  const signedIn = (plan: string) => ({ authPresent: true, authHealth: "authenticated", auth: { state: "authenticated", plan }, plan, kind: "managed", loginPending: false, loginState: "authenticated", deviceAuth: null });
  const signedOut = { authPresent: false, authHealth: "signed_out", auth: { state: "signed_out", plan: null }, kind: "managed", loginPending: false, loginState: "idle", deviceAuth: null, limits: null };
  const longLabel = "Спільний акаунт нічної зміни для довгих міграцій і перевірок релізів";
  if (set === "core") {
    return {
      codex: { active: "night-shift", accounts: [
        // Past most of its window and spending paid credits: the balance is a six-decimal reading.
        { id: "night-shift", label: "night-shift", ...signedIn("pro"), spendCredits: true, paidCredits: { balance: "48215.719750", checkedAt: iso(8 * 60) },
          limits: fresh({ weekly: week(3, 2 * DAY) }), resetCredits: { availableCount: 0, expiresAt: null } },
        // Idle, with room to spare.
        { id: "studio", label: "studio", ...signedIn("plus"), spendCredits: false, paidCredits: { balance: "0", checkedAt: iso(8 * 60) },
          limits: fresh({ weekly: week(62, 3 * DAY) }), resetCredits: { availableCount: 0, expiresAt: null } },
        // Spent, credits off, a balance it could use.
        { id: "reserve", label: "reserve", ...signedIn("pro"), spendCredits: false, paidCredits: { balance: "320.400000", checkedAt: iso(HOUR) },
          limits: fresh({ weekly: week(0, 5 * DAY) }), resetCredits: { availableCount: 0, expiresAt: null } },
        // A reset to use, two windows.
        { id: "team-seat", label: "team-seat", ...signedIn("team"), spendCredits: false, paidCredits: null,
          limits: fresh({ session: session(40, 3 * HOUR), weekly: week(8, 4 * DAY) }), resetCredits: { availableCount: 2, expiresAt: NOW + 17 * DAY } },
        { id: "old-laptop", label: "old-laptop", ...signedOut },
      ] },
      claude: { active: "opus-main", accounts: [
        { id: "opus-main", label: "opus-main", ...signedIn("max"),
          limits: fresh({ session: session(71, 2 * HOUR), weekly: week(44, 3 * DAY), tiers: [tier("opus", "Opus", 52, 3 * DAY), tier("fable", "Fable", 23, 3 * DAY)] }) },
        { id: "backup", label: "backup", ...signedIn("pro"), limits: fresh({ session: session(100, 5 * HOUR), weekly: week(96, 6 * DAY) }) },
        { id: "zen-go", label: "zen-go", ...signedIn("pro"), plan: null, auth: { state: "authenticated", plan: null }, limits: null,
          provider: { baseUrl: "https://opencode.ai/zen/go", model: "qwen3.8-max", smallFastModel: "qwen3.8-flash" } },
        { id: "guest", label: "guest", ...signedOut },
      ] },
    };
  }
  return {
    codex: { active: "long-name", accounts: [
      // The id differs from the label, so the status popover names it.
      { id: "long-name", label: longLabel, ...signedIn("pro"), spendCredits: true, paidCredits: { balance: "0.400000", checkedAt: iso(30 * HOUR) },
        limits: fresh({ session: session(0, 2 * HOUR), weekly: week(0, 6 * DAY) }), resetCredits: { availableCount: 1, expiresAt: NOW + 2 * DAY } },
      // The switch on with room left: the second arm of the credits rule.
      { id: "spending-early", label: "spending-early", ...signedIn("pro"), spendCredits: true, paidCredits: { balance: "1250.000000", checkedAt: iso(8 * 60) },
        limits: fresh({ weekly: week(42, 4 * DAY) }), resetCredits: { availableCount: 0, expiresAt: null } },
      { id: "stale-read", label: "stale-read", ...signedIn("pro"), authHealth: "unknown", auth: { state: "unknown", plan: "pro" }, spendCredits: false, paidCredits: null,
        limits: { state: "stale", session: null, weekly: { ...week(37, 2 * DAY), observedAt: NOW - 30 * HOUR }, checkedAt: iso(30 * HOUR) }, resetCredits: null },
      { id: "no-reading", label: "no-reading", ...signedIn("plus"), limits: null, resetCredits: null, spendCredits: false, paidCredits: null },
      { id: "dev-signing-in", label: "dev-signing-in", ...signedOut, loginPending: true, loginState: "pending", deviceAuth: { url: "https://auth.openai.com/codex/device", code: "QXWT-7KPL" } },
      { id: "last-known", label: "last-known", ...signedOut, limits: { state: "stale", session: null, weekly: { ...week(55, DAY), observedAt: NOW - 3 * DAY }, checkedAt: iso(3 * DAY) } },
    ] },
    claude: { active: "long-claude", accounts: [
      { id: "long-claude", label: longLabel, ...signedIn("max"), limits: fresh({ session: session(12, HOUR), weekly: week(9, DAY), tiers: [tier("fable", "Fable", 3, DAY)] }) },
      { id: "bad-provider", label: "bad-provider", ...signedOut, authHealth: "error", auth: { state: "error", plan: null },
        provider: { baseUrl: "https://example.invalid/v1", model: "model-a", smallFastModel: null } },
      { id: "browser-signing-in", label: "browser-signing-in", ...signedOut, loginPending: true, loginState: "pending",
        login: { operationId: "op-browser", phase: "awaiting_browser", loginUrl: "https://claude.ai/login", acceptsCode: true, deadlineAt: iso(-600), result: null } },
    ] },
  };
}

type Handler = (request: Request) => Response | Promise<Response>;
type Call = { method: string; path: string; body: unknown };

/** The routes one case serves, over a model it can reset and make refuse. */
export function accountRowRoutes() {
  const control = {
    set: "core" as RowSet,
    next: null as string | null,
    refuse: { spend: false, remove: false },
    calls: [] as Call[],
    model: accountRowModel("core"),
    reset(set: RowSet, next: string | null = null) {
      control.set = set; control.next = next; control.model = accountRowModel(set);
      control.refuse = { spend: false, remove: false }; control.calls = [];
    },
  };
  const find = (engine: RowEngine, id: unknown) => control.model[engine].accounts.find((account) => account.id === id);
  const record = async (request: Request, engine: RowEngine | null, suffix: string): Promise<Record<string, unknown> | null> => {
    const body = request.method === "GET" ? null : await request.json().catch(() => null) as Record<string, unknown> | null;
    if (request.method !== "GET") control.calls.push({ method: request.method, path: `${engine ? `/api/accounts/${engine}` : "/api/accounts"}${suffix}`, body });
    return body;
  };
  const checkedNow = () => new Date().toISOString();
  const routes: Record<string, Handler> = {
    "/api/accounts": () => Response.json(control.model),
    "/api/transfer/accounts": () => Response.json({ ok: true, result: [] }),
    "/api/account-project-bindings": () => Response.json({ engines: {
      claude: { nextChosenAccountId: control.next },
      codex: { nextChosenAccountId: control.next },
    } }),
    "/api/accounts/codex/spend-credits": async (request) => {
      const body = await record(request, "codex", "/spend-credits");
      if (control.refuse.spend) return Response.json({ error: "refused" }, { status: 503 });
      const account = find("codex", body?.accountId)!;
      account.spendCredits = body?.spendCredits;
      return Response.json({ accountId: account.id, spendCredits: account.spendCredits });
    },
    "/api/accounts/codex/reset-credits": async (request) => {
      const body = await record(request, "codex", "/reset-credits");
      const account = find("codex", body?.id)!;
      const resets = account.resetCredits as { availableCount: number; expiresAt: number | null };
      account.resetCredits = { ...resets, availableCount: resets.availableCount - 1 };
      return Response.json({ account });
    },
  };
  for (const engine of ["claude", "codex"] as const) {
    routes[`/api/accounts/${engine}/active`] = async (request) => {
      const body = await record(request, engine, "/active");
      control.model[engine].active = String(body?.id);
      return Response.json({ ok: true });
    };
    routes[`/api/accounts/${engine}/limits`] = async (request) => {
      const body = await record(request, engine, "/limits");
      const account = find(engine, body?.id)!;
      account.limits = { ...(account.limits as object), checkedAt: checkedNow() };
      return Response.json({ account });
    };
    routes[`/api/accounts/${engine}/terminal`] = async (request) => {
      const body = await record(request, engine, "/terminal");
      return Response.json({ command: `delegatus agent --account ${String(body?.id)}` });
    };
    routes[`/api/accounts/${engine}`] = async (request) => {
      const body = await record(request, engine, "");
      if (request.method === "DELETE") {
        if (control.refuse.remove) {
          return Response.json({ code: "account_removal_blocked", blockers: ["live_sessions"], sessions: [{ conversationId: "c-1", path: null, title: "Міграція бази" }], sessionCount: 3 }, { status: 409 });
        }
        const accounts = control.model[engine].accounts;
        accounts.splice(accounts.findIndex((row) => row.id === body?.id), 1);
        return Response.json({ moved: { files: 12, bytes: 40_960 } });
      }
      if (request.method === "POST" && body?.action === "retry") {
        const account = find(engine, body.id)!;
        if (engine === "claude") {
          const login = { operationId: `op-${String(account.id)}`, phase: "awaiting_browser", loginUrl: "https://claude.ai/login", acceptsCode: true, deadlineAt: new Date(Date.now() + 600_000).toISOString(), result: null };
          Object.assign(account, { login, loginPending: true, loginState: "pending" });
          return Response.json({ account: { id: account.id }, login }, { status: 202 });
        }
        const deviceAuth = { url: "https://auth.openai.com/codex/device", code: "QXWT-7KPL" };
        Object.assign(account, { deviceAuth, loginPending: true, loginState: "pending" });
        return Response.json({ deviceAuth });
      }
      if (request.method === "POST" && body?.action === "cancel") {
        Object.assign(find(engine, body.id)!, { deviceAuth: null, loginPending: false, loginState: "idle" });
        return Response.json({ ok: true });
      }
      return Response.json({});
    };
  }
  routes["/api/accounts/claude/login/op-browser"] = async (request) => {
    await record(request, "claude", "/login/op-browser");
    Object.assign(find("claude", "browser-signing-in")!, { login: null, loginPending: false, loginState: "idle" });
    return Response.json({ ok: true });
  };
  return { routes, control };
}

/* ---------- what a state does, and the element that defines it ---------- */

export type RowSurface = "dialog" | "phone";
export type RowState = {
  id: string;
  set: RowSet;
  engine: RowEngine;
  /** The project's next pick the scene marks, for the next-for-unpinned note. */
  next?: string;
  refuse?: Partial<{ spend: boolean; remove: boolean }>;
  /** The frame holds a height change half way, so it is not waited out. */
  inMotion?: boolean;
  /** Drives the page into the state and returns the selector of the element that defines it. */
  run: (page: Page, surface: RowSurface, locale: "en" | "uk", control: ReturnType<typeof accountRowRoutes>["control"]) => Promise<string>;
};

/** Where the Codex rows are: the dialog shows one engine, the phone's screen both. */
const codexScope = (surface: RowSurface) => (surface === "phone" ? '[data-mobile2-accounts-engine="codex"]' : "body");
const rowOf = (id: string) => `[data-account-row="${id}"]`;
const toggleOf = (id: string) => `${rowOf(id)} [data-account-toggle]`;
async function openRow(page: Page, id: string) {
  await page.locator(toggleOf(id)).click();
  await settle(page);
}
/** The height change of an opening or a closing has run out. */
async function settle(page: Page) {
  // A spinner runs forever by design; the height changes are the transitions.
  await page.waitForFunction(() => document.querySelectorAll('[data-account-opening="closing"]').length === 0
    && document.getAnimations().every((animation) => !("transitionProperty" in animation) || animation.playState !== "running"), undefined, { timeout: 5_000 });
}
async function pressTool(page: Page, id: string, tool: string) {
  await openRow(page, id);
  await page.locator(`${rowOf(id)} ${tool}`).click();
}

/** States that only open, close or read: they send nothing. */
const QUIET_STATES = new Set(["rest", "opened", "details", "details-reset", "free", "claude-row", "status", "long-id", "next-for-unpinned", "open-no-data", "open-stale-read", "one-closes-as-another-opens", "long-names-codex", "long-names-claude", "provider-error", "signing-in-codex", "signing-in-claude"]);

export const ROW_STATES: RowState[] = [
  { id: "rest", set: "core", engine: "codex", run: async () => `${rowOf("night-shift")} [data-account-default-mark]` },
  { id: "opened", set: "core", engine: "codex", run: async (page) => { await openRow(page, "reserve"); return `[data-account-make-default="reserve"]`; } },
  { id: "details", set: "core", engine: "codex", run: async (page) => { await openRow(page, "night-shift"); return `${rowOf("night-shift")} [data-account-refresh-limits]`; } },
  { id: "details-reset", set: "core", engine: "codex", run: async (page) => { await openRow(page, "team-seat"); return `${rowOf("team-seat")} [data-account-use-reset]`; } },
  { id: "free", set: "core", engine: "codex", run: async (page) => { await openRow(page, "studio"); return `[data-account-make-default="studio"]`; } },
  { id: "claude-row", set: "core", engine: "claude", run: async () => `${rowOf("opus-main")} [data-limit-row="tier:opus"]` },
  { id: "credits-early", set: "edge", engine: "codex", run: async () => `[data-account-spend-credits="spending-early"]` },
  { id: "credit-save-failed", set: "core", engine: "codex", refuse: { spend: true }, run: async (page) => {
    await page.locator(`[data-account-spend-credits="night-shift"] [role="switch"]`).click();
    await page.locator(`[data-account-spend-credits="night-shift"] [role="alert"]`).waitFor();
    return `[data-account-spend-credits="night-shift"] [role="alert"]`;
  } },
  { id: "status", set: "core", engine: "codex", run: async (page) => { await page.locator(`${rowOf("studio")} [data-account-status]`).click(); await settlePopover(page); return `[data-account-status-popover="studio"]`; } },
  { id: "signed-out", set: "core", engine: "codex", run: async () => `[data-account-signin-start="old-laptop"]` },
  { id: "long-id", set: "edge", engine: "codex", run: async (page) => { await page.locator(`${rowOf("long-name")} [data-account-status]`).click(); await settlePopover(page); return `[data-account-status-popover="long-name"] [data-account-id]`; } },
  { id: "next-for-unpinned", set: "core", engine: "codex", next: "studio", run: async (page) => { await page.locator(`${rowOf("studio")} [data-account-status]`).click(); await settlePopover(page); return `[data-account-status-popover="studio"]`; } },
  { id: "open-no-data", set: "edge", engine: "codex", run: async (page) => { await openRow(page, "no-reading"); return `${rowOf("no-reading")} [data-account-refresh-limits]`; } },
  { id: "open-stale-read", set: "edge", engine: "codex", run: async (page) => { await openRow(page, "stale-read"); return `${rowOf("stale-read")} [data-account-reset-credits]`; } },
  { id: "signing-in-codex", set: "edge", engine: "codex", run: async () => `[data-account-signin="dev-signing-in"]` },
  { id: "signing-in-claude", set: "edge", engine: "claude", run: async () => `${rowOf("browser-signing-in")} [role="group"]` },
  { id: "delete-confirm", set: "core", engine: "codex", run: async (page) => { await pressTool(page, "studio", "[data-account-remove]"); return `[data-account-remove-armed="studio"]`; } },
  { id: "delete-refused", set: "core", engine: "codex", refuse: { remove: true }, run: async (page) => {
    await pressTool(page, "studio", "[data-account-remove]");
    await page.locator(`[data-account-remove-confirm="studio"]`).click();
    await page.locator(`[data-account-refusal="studio"]`).waitFor();
    return `[data-account-refusal="studio"]`;
  } },
  { id: "provider-edit", set: "core", engine: "claude", run: async (page) => { await pressTool(page, "zen-go", "[data-account-provider-edit]"); return `[data-claude-provider-editor="zen-go"] input`; } },
  { id: "after-default", set: "core", engine: "codex", run: async (page, surface) => {
    await openRow(page, "studio");
    await page.locator(`[data-account-make-default="studio"]`).click();
    await page.waitForFunction((scope) => document.querySelector(`${scope} [data-account-row]`)?.getAttribute("data-account-row") === "studio", codexScope(surface));
    await settle(page);
    return `${rowOf("studio")} [data-account-default-mark]`;
  } },
  { id: "long-names-codex", set: "edge", engine: "codex", run: async () => `${rowOf("long-name")} [data-account-name]` },
  { id: "long-names-claude", set: "edge", engine: "claude", run: async () => `${rowOf("long-claude")} [data-account-name]` },
  { id: "provider-error", set: "edge", engine: "claude", run: async (page) => { await openRow(page, "bad-provider"); return `${rowOf("bad-provider")} [data-account-provider-edit]`; } },
  { id: "one-closes-as-another-opens", set: "core", engine: "codex", inMotion: true, run: async (page) => {
    await openRow(page, "studio");
    await page.locator(toggleOf("team-seat")).click();
    // Half way through the height change: the first row closing, the second opening.
    await page.evaluate(() => { for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 90; } });
    return `${rowOf("team-seat")} [data-account-opening]`;
  } },
];

async function settlePopover(page: Page) {
  // The popover places itself in its own layout effect and then hides what it lies over.
  await page.waitForFunction(() => document.querySelector("[data-account-status-popover]") !== null);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
}

/* ---------- what a frame is held to ---------- */

type Reading = { failures: string[]; facts: Record<string, unknown> };

/** Runs in the page: text, overlap, targets, contrast and the row facts. */
function measure(args: { target: string; phone: boolean; viewport: { width: number; height: number } }): Reading {
  const failures: string[] = [];
  const facts: Record<string, unknown> = {};
  const visible = (element: Element | null): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none") return false;
      if (node.hasAttribute("inert") && node.closest("[data-account-opening]")?.getAttribute("data-account-opening") !== "closing") return false;
    }
    return true;
  };
  const clip = (element: Element): DOMRect | null => {
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX !== "visible" || style.overflowY !== "visible") return node.getBoundingClientRect();
    }
    return null;
  };
  /* What of a line is painted: its box cut by every clipping ancestor (a scrolled list, a row part way through opening). */
  const painted = (rect: DOMRect, owner: Element): { left: number; top: number; right: number; bottom: number } | null => {
    let box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    for (let node: Element | null = owner; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const edge = node.getBoundingClientRect();
      box = { left: Math.max(box.left, edge.left), top: Math.max(box.top, edge.top), right: Math.min(box.right, edge.right), bottom: Math.min(box.bottom, edge.bottom) };
    }
    return box.right - box.left > 0.5 && box.bottom - box.top > 0.5 ? box : null;
  };
  // Text: every line of every visible text node stays inside the viewport and the surface it lies in.
  const lines: { rect: { left: number; top: number; right: number; bottom: number }; owner: Element; text: string }[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const owner = node.parentElement!;
    if (!node.textContent?.trim() || owner.closest("script, style, .sr-only") || !visible(owner)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width < 0.5 || rect.height < 0.5) continue;
      const shown = painted(rect, owner);
      if (shown) lines.push({ rect: shown, owner, text: (node.textContent ?? "").trim().slice(0, 40) });
      if (rect.left < -0.5 || rect.right > args.viewport.width + 0.5) failures.push(`text leaves the viewport: «${(node.textContent ?? "").trim().slice(0, 30)}» ${Math.round(rect.left)}..${Math.round(rect.right)}`);
      const box = clip(owner);
      if (box && (rect.left < box.left - 0.5 || rect.right > box.right + 0.5)) failures.push(`text cut by its surface: «${(node.textContent ?? "").trim().slice(0, 30)}»`);
    }
  }
  // Overlap: lines of different owners never lie on each other.
  for (let i = 0; i < lines.length; i += 1) for (let j = i + 1; j < lines.length; j += 1) {
    const a = lines[i]!, b = lines[j]!;
    if (a.owner === b.owner || a.owner.contains(b.owner) || b.owner.contains(a.owner)) continue;
    const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
    const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
    if (w > 1.5 && h > 2) failures.push(`text overlaps: «${a.text}» and «${b.text}»`);
  }
  // Targets: every control the frame shows keeps the floor and stays in the viewport.
  const floor = args.phone ? 43.5 : 23.5;
  for (const control of document.querySelectorAll<HTMLElement>("button, a[href], [role='switch'], input")) {
    if (!visible(control) || control.closest(".sr-only")) continue;
    const rect = control.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    if (rect.left < -0.5 || rect.right > args.viewport.width + 0.5) failures.push(`control leaves the viewport: ${control.tagName} ${control.getAttribute("data-account-toggle") ?? control.textContent?.slice(0, 20)}`);
    // The dialog's own footer (add, clean-up) is not the row.
    if (!control.closest("[data-account-row]")) continue;
    if (control.tagName === "A" && control.closest("[data-account-refusal]") === null && !control.closest("[data-account-signin]")) continue;
    if (rect.height < floor) failures.push(`target under ${floor}px high: ${control.textContent?.trim().slice(0, 24) || control.getAttribute("aria-label")} (${Math.round(rect.height)})`);
    if (args.phone && rect.width < floor) failures.push(`target under ${floor}px wide: ${control.textContent?.trim().slice(0, 24) || control.getAttribute("aria-label")} (${Math.round(rect.width)})`);
  }
  // Contrast of the row's text against what lies behind it.
  const parse = (value: string): [number, number, number, number] | null => {
    const rgb = /^rgba?\(([^)]+)\)$/.exec(value);
    if (rgb) { const parts = rgb[1]!.split(/[,\s/]+/).filter(Boolean).map(Number); return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1]; }
    const srgb = /^color\(srgb ([^)]+)\)$/.exec(value);
    if (srgb) { const parts = srgb[1]!.split(/[\s/]+/).filter(Boolean).map(Number); return [parts[0]! * 255, parts[1]! * 255, parts[2]! * 255, parts[3] ?? 1]; }
    return null;
  };
  const behind = (element: Element): [number, number, number] => {
    let base: [number, number, number] = [255, 255, 255];
    const stack: [number, number, number, number][] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const colour = parse(getComputedStyle(node).backgroundColor);
      if (colour && colour[3] > 0) { stack.push(colour); if (colour[3] >= 1) break; }
    }
    for (const [r, g, b, a] of stack.reverse()) base = [base[0] * (1 - a) + r * a, base[1] * (1 - a) + g * a, base[2] * (1 - a) + b * a];
    return base;
  };
  const luminance = ([r, g, b]: [number, number, number]) => {
    const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  let worst = 21;
  for (const line of lines) {
    if (!line.owner.closest("[data-account-row], [data-account-status-popover], [data-accounts-caption], [role='tooltip']")) continue;
    const ink = parse(getComputedStyle(line.owner).color);
    if (!ink) continue;
    const back = behind(line.owner);
    const fore: [number, number, number] = [back[0] * (1 - ink[3]) + ink[0] * ink[3], back[1] * (1 - ink[3]) + ink[1] * ink[3], back[2] * (1 - ink[3]) + ink[2] * ink[3]];
    const [hi, lo] = [Math.max(luminance(fore), luminance(back)), Math.min(luminance(fore), luminance(back))];
    const ratio = (hi + 0.05) / (lo + 0.05);
    const dim = Number(getComputedStyle(line.owner.closest("[data-limit-row]") ?? line.owner).opacity);
    if (dim < 1) continue;
    worst = Math.min(worst, ratio);
    if (ratio < 4.5) failures.push(`contrast ${ratio.toFixed(2)} under 4.5: «${line.text}»`);
  }
  facts.worstContrast = Number(worst.toFixed(2));
  // Rows: the name once, no decimal balance, bars toned by their number.
  const rows = [...document.querySelectorAll<HTMLElement>("[data-account-row]")];
  facts.rows = rows.map((row) => row.getAttribute("data-account-row"));
  for (const row of rows) {
    const id = row.getAttribute("data-account-row")!;
    const name = row.querySelector("[data-account-name]")?.textContent ?? "";
    // A sentence that names its subject (the removal question, a refusal) is not the name said again.
    const text = [...row.querySelectorAll("*")].filter((node) => visible(node) && node.children.length === 0 && !node.closest("[data-account-remove-armed], [data-account-refusal]")).map((node) => node.textContent ?? "").join("\n");
    if (name && text.split(name).length > 2) failures.push(`${id}: the name is said twice`);
    const balance = row.querySelector("[data-account-balance]")?.textContent ?? "";
    if (/[.,]\d{1,2}$|[.,]\d{4,}/.test(balance)) failures.push(`${id}: a decimal balance «${balance}»`);
    for (const fill of row.querySelectorAll<HTMLElement>("[data-meter-fill]")) {
      const left = Number(fill.getAttribute("data-meter-fill"));
      const tone = left <= 10 ? "danger" : left <= 30 ? "warning" : "engine";
      if (fill.getAttribute("data-meter-tone") !== tone) failures.push(`${id}: a ${left}% bar is toned ${fill.getAttribute("data-meter-tone")}`);
    }
    const pills = row.querySelectorAll("[class*='rounded-full'][class*='border'], [class*='bg-card'][class*='border']");
    if ([...pills].some((pill) => pill.textContent?.trim() && visible(pill))) failures.push(`${id}: a pill or a bordered box in the row`);
  }
  facts.credits = rows.filter((row) => row.querySelector("[data-account-spend-credits]")).map((row) => row.getAttribute("data-account-row"));
  // The defining element is on screen, whole, and not hidden by the status.
  const defining = document.querySelector<HTMLElement>(args.target);
  if (!defining) failures.push(`the defining element is missing: ${args.target}`);
  else {
    if (!visible(defining)) failures.push(`the defining element is hidden: ${args.target}`);
    const rect = defining.getBoundingClientRect();
    const box = clip(defining) ?? { top: 0, bottom: args.viewport.height, left: 0, right: args.viewport.width } as DOMRect;
    const popover = defining.closest("[role='tooltip']") !== null;
    const top = popover ? 0 : Math.max(0, box.top);
    const bottom = popover ? args.viewport.height : Math.min(args.viewport.height, box.bottom);
    if (rect.width < 1 || rect.height < 1) failures.push(`the defining element has no box: ${args.target}`);
    else if (rect.top < top - 0.75 || rect.bottom > bottom + 0.75 || rect.left < -0.5 || rect.right > args.viewport.width + 0.5) failures.push(`the defining element is cut: ${args.target} ${Math.round(rect.top)}..${Math.round(rect.bottom)} in ${Math.round(top)}..${Math.round(bottom)}`);
    facts.defining = { text: (defining.textContent ?? "").trim().slice(0, 80), rect: [rect.left, rect.top, rect.right, rect.bottom].map(Math.round) };
  }
  const tooltip = document.querySelector<HTMLElement>("[role='tooltip']");
  if (tooltip) {
    const rect = tooltip.getBoundingClientRect();
    facts.popover = { width: Math.round(rect.width), rect: [rect.left, rect.top, rect.right, rect.bottom].map(Math.round) };
    if (rect.left < 0 || rect.right > args.viewport.width || rect.top < 0 || rect.bottom > args.viewport.height) failures.push("the status popover leaves the viewport");
    if (rect.width > 281) failures.push(`the status popover is ${Math.round(rect.width)} px wide`);
    // Nothing it lies over stays showing half: a line it touches is hidden whole.
    for (const line of document.querySelectorAll<HTMLElement>("[data-account-line]")) {
      if (getComputedStyle(line).visibility === "hidden") continue;
      const range = document.createRange(); range.selectNodeContents(line);
      for (const part of range.getClientRects()) {
        if (part.width > 0.5 && part.left < rect.right && part.right > rect.left && part.top < rect.bottom && part.bottom > rect.top) { failures.push(`the status popover lies on a line it left showing: «${(line.textContent ?? "").slice(0, 30)}»`); break; }
      }
    }
  }
  return { failures, facts };
}

/** The credits line shows exactly where the rule says: paid credits and 5% or less left, or the switch on. */
function creditsExpected(model: Model, engine: RowEngine): string[] {
  if (engine !== "codex") return [];
  return model.codex.accounts.filter((account) => {
    if (account.spendCredits === true) return true;
    const limits = account.limits as { session?: { usedPercent: number } | null; weekly?: { usedPercent: number } | null } | null;
    const left = [limits?.session, limits?.weekly].flatMap((window) => window ? [Math.round(100 - window.usedPercent)] : []);
    return Number((account.paidCredits as { balance?: string } | null)?.balance) > 0 && left.length > 0 && Math.min(...left) <= 5;
  }).map((account) => account.id);
}

export type FrameOptions = {
  browser: Browser;
  base: string;
  out: string;
  routes: ReturnType<typeof accountRowRoutes>;
  surface: RowSurface;
  widths: number[];
  height: number;
  only?: string[];
};

/** Renders every state at every width, in both languages and both schemes; returns the failures with the frame that held them. */
export async function captureAccountRowFrames(options: FrameOptions): Promise<{ frames: number; failures: string[] }> {
  const { browser, base, out, routes, surface, widths, height } = options;
  const phone = surface === "phone";
  fs.mkdirSync(out, { recursive: true });
  const failures: string[] = [];
  const readings: Record<string, unknown> = {};
  let frames = 0;
  const only = options.only?.filter(Boolean) ?? [];
  const states = ROW_STATES.filter((state) => only.length === 0 || only.some((needle) => state.id.includes(needle)));
  for (const width of widths) for (const locale of ["uk", "en"] as const) for (const theme of ["light", "dark"] as const) for (const state of states) {
    routes.control.reset(state.set, state.next ?? null);
    Object.assign(routes.control.refuse, state.refuse ?? {});
    const key = `${surface}-${width}-${locale}-${theme}-${state.id}`;
    const query = `scenario=account-row&surface=${surface}&engine=${state.engine}${state.next ? `&next=${state.next}` : ""}`;
    const { page, context, pageErrors } = await openFixture(browser, `${base}?${query}`, { width, height }, theme, locale, "no-preference", phone);
    try {
      await page.locator(phone ? "[data-mobile2-account]" : "[data-account-row]").first().waitFor({ timeout: 15_000 }).catch(async (error) => {
        await page.screenshot({ path: path.join(out, `${key}-failed.png`) }).catch(() => {});
        throw new Error(`${key}: no row drew (${pageErrors.join(" | ") || "no page error"}): ${(await page.locator("body").innerText().catch(() => "")).slice(0, 300)} — ${error instanceof Error ? error.message.split("\n")[0] : error}`);
      });
      const before = routes.control.calls.length;
      const target = await state.run(page, surface, locale, routes.control);
      if (!state.inMotion) await settle(page);
      await page.locator(target).first().scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(60);
      const reading = await page.evaluate(measure, { target, phone, viewport: { width, height } });
      const mine = [...reading.failures];
      // Opening, closing and moving between rows send nothing and change no default.
      const sent = routes.control.calls.slice(before);
      if (QUIET_STATES.has(state.id) && sent.length > 0) mine.push(`opening sent ${sent.map((call) => call.method + call.path).join(", ")}`);
      if (state.id === "after-default" && !sent.some((call) => call.path.endsWith("/active"))) mine.push("Make default did not reach the route");
      const shown = (reading.facts.credits as string[]).sort().join(",");
      const wanted = creditsExpected(routes.control.model, state.engine).filter((id) => state.id !== "delete-refused" || id !== "studio").sort().join(",");
      if (!phone && shown !== wanted) mine.push(`credits show on [${shown}], the rule says [${wanted}]`);
      if (phone) {
        const onPhone = creditsExpected(routes.control.model, "codex").sort().join(",");
        if (shown !== onPhone) mine.push(`credits show on [${shown}], the rule says [${onPhone}]`);
      }
      if (pageErrors.length) mine.push(`page errors: ${pageErrors.join(" | ")}`);
      if (state.id === "after-default") {
        const focus = await page.evaluate(() => document.activeElement?.getAttribute("data-account-toggle") ?? "");
        if (focus !== "studio") mine.push(`focus is on «${focus}», not on the row's toggle`);
      }
      readings[key] = reading.facts;
      if (mine.length) failures.push(...mine.map((failure) => `${key}: ${failure}`));
      await page.screenshot({ path: path.join(out, `${key}.png`) });
      frames += 1;
    } finally { await context.close(); }
  }
  fs.writeFileSync(path.join(out, "readings.json"), JSON.stringify({ at: new Date().toISOString(), frames, failures, readings }, null, 1));
  return { frames, failures };
}

/** Keyboard: the dot, the name's toggle and the default control are separately reachable and named, the chevron is no stop, and the animation respects reduced motion. */
export async function captureAccountRowKeyboard(options: Pick<FrameOptions, "browser" | "base" | "out" | "routes" | "surface" | "height"> & { width: number }): Promise<string[]> {
  const { browser, base, out, routes, surface, height, width } = options;
  const phone = surface === "phone";
  const failures: string[] = [];
  fs.mkdirSync(out, { recursive: true });
  for (const locale of ["uk", "en"] as const) {
    routes.control.reset("core");
    const { page, context, pageErrors } = await openFixture(browser, `${base}?scenario=account-row&surface=${surface}&engine=codex`, { width, height }, "light", locale, "no-preference", phone);
    try {
      await page.locator("[data-account-row]").first().waitFor();
      const stops = async (count: number) => {
        const names: string[] = [];
        for (let i = 0; i < count; i += 1) {
          await page.keyboard.press("Tab");
          names.push(await page.evaluate(() => {
            const element = document.activeElement as HTMLElement | null;
            return `${element?.getAttribute("data-account-status") !== null ? "dot" : element?.hasAttribute("data-account-toggle") ? "toggle" : element?.hasAttribute("data-account-chevron") ? "chevron" : element?.hasAttribute("data-account-make-default") ? "default" : "other"}:${element?.getAttribute("aria-label") ?? element?.textContent?.trim() ?? ""}`;
          }));
        }
        return names;
      };
      await page.locator(`${rowOf("studio")} [data-account-toggle]`).focus();
      await page.keyboard.press("Enter");
      await settle(page);
      if (await page.locator(toggleOf("studio")).getAttribute("aria-expanded") !== "true") failures.push(`${locale}: Enter on the toggle did not open the row`);
      if (routes.control.calls.length) failures.push(`${locale}: opening by keyboard sent ${routes.control.calls.length} request(s)`);
      const order = await stops(2);
      if (order.some((stop) => stop.startsWith("chevron"))) failures.push(`${locale}: the chevron is a keyboard stop: ${order.join(" > ")}`);
      const first = order[0] ?? "";
      if (!first.startsWith("default:")) failures.push(`${locale}: the default control is not the next stop after the toggle: ${order.join(" > ")}`);
      if (!first.includes(translate(locale, "accounts.makeDefaultAria", { label: "studio" }))) failures.push(`${locale}: the default control is not named «${translate(locale, "accounts.makeDefaultAria", { label: "studio" })}»: ${first}`);
      const names = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-account-row='studio'] button")].filter((button) => button.tabIndex >= 0).map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? ""));
      if (new Set(names).size !== names.length) failures.push(`${locale}: two stops carry the same name: ${names.join(" | ")}`);
      // Back to the default control, and press it from the keyboard.
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Enter");
      await page.waitForFunction((scope) => document.querySelector(`${scope} [data-account-row]`)?.getAttribute("data-account-row") === "studio", codexScope(surface));
      await settle(page);
      const focus = await page.evaluate(() => document.activeElement?.getAttribute("data-account-toggle"));
      if (focus !== "studio") failures.push(`${locale}: after Make default focus is on «${focus}», not on the row's toggle`);
      if (routes.control.calls.length !== 1 || !routes.control.calls[0]!.path.endsWith("/active")) failures.push(`${locale}: Make default sent ${JSON.stringify(routes.control.calls)}`);
      await page.keyboard.press("Space");
      await settle(page);
      await page.screenshot({ path: path.join(out, `${surface}-${width}-${locale}-keyboard.png`) });
      if (pageErrors.length) failures.push(`${locale}: page errors ${pageErrors.join(" | ")}`);
    } finally { await context.close(); }
  }
  // Reduced motion: the lines swap at once and no transition runs.
  for (const locale of ["uk", "en"] as const) {
    routes.control.reset("core");
    const { page, context } = await openFixture(browser, `${base}?scenario=account-row&surface=${surface}&engine=codex`, { width, height }, "light", locale, "reduce", phone);
    try {
      await page.locator("[data-account-row]").first().waitFor();
      await page.locator(toggleOf("studio")).click();
      const state = await page.evaluate(() => ({
        running: document.getAnimations().filter((animation) => animation.effect instanceof KeyframeEffect && (animation as CSSTransition).transitionProperty === "grid-template-rows").length,
        open: document.querySelector("[data-account-row='studio'] [data-account-opening]")?.getAttribute("data-account-opening"),
        rows: getComputedStyle(document.querySelector("[data-account-row='studio'] [data-account-opening]")!).gridTemplateRows,
      }));
      if (state.running !== 0) failures.push(`${locale}: ${state.running} height transition(s) run under reduced motion`);
      if (state.open !== "open") failures.push(`${locale}: the row is not open at once under reduced motion (${state.open})`);
    } finally { await context.close(); }
  }
  return failures;
}
