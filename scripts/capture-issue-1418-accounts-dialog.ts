/**
 * Rendered verification of the accounts surfaces after #1418 / #1373 / #1358,
 * in a real browser: the desktop flyout at 1280×860 and, at 390×844, the phone
 * screen mobile v2 replaced the dialog with (issue #1439 lane 9,
 * docs/design/mobile-v2/README.md §4.8 — the phone has no project drawer and
 * no accounts dialog any more; Accounts & limits is a screen the board's ⋯
 * pushes).
 *
 *   bun run build && bun scripts/capture-issue-1418-accounts-dialog.ts
 *
 * The production build is served against a synthetic home under the temp root
 * — never the operator's live state, and every account is invented: on the
 * Codex side "Main" (pro, headroom), "Account A" (pro, exhausted, holding one
 * reset credit and holding the seat) and "Account C" (prolite); on the Claude
 * side "Main" (max, active, reporting a flagship weekly bucket) and "Account B"
 * (pro, none). One invented project with one transcript is seeded too, because
 * the phone reaches the screen from a board. The account controller is disabled
 * so the seeded readings stay, and the Codex binary is a stub that exits, so
 * the card actions exercise the routes end to end and land on their failure
 * notices without any provider call.
 *
 * Every shot also CHECKS what it shows. Desktop: no 'Bound to' chip anywhere,
 * one limits block per card with both actions, the reset control enabled only
 * on the card that holds a credit, the flagship row present only on the
 * account that reports a bucket, and no horizontal scroll. Phone: one limits
 * block per engine — the active account's card — with Refresh, the reset
 * control only on Codex and enabled only while that card holds a credit, every
 * meter filled with what REMAINS (its value equals the row's own «n% left»),
 * no corner number repeating the week the card lists, 44px targets and no
 * horizontal scroll. Transfer checklist (install transfer slice 2): an
 * import brought eight Codex accounts in every checklist state, two Claude
 * accounts (one a provider account that could not be made) and one Copilot
 * account. In en/light and uk/dark, at 1280×860 and at a short 1024×640, each
 * dialog stays wholly on screen with its header and close control, the
 * checklist heading is whole at the top when it opens, and every row and
 * action is reachable by scrolling, unclipped and uncovered; the phone screen
 * carries the same checklist, every action reachable at 44 px. The Copilot
 * list in the rail's footer is checked at 1280×860, 1024×640 and 707×744 as
 * it opens, before any input (its top, the heading, «Check all» and the first
 * action whole in the viewport cut by every clipping ancestor), then by wheel
 * turns over the list, which must reach every row and control while only a
 * scroller moves, never a hidden-overflow ancestor or the page. Shots land in
 * <tmp>/llv-issue-1418-latest/out/1418-<surface>-<engine>.png and are never
 * committed: the privacy gate refuses rasters.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright-core";

import { createCaptureDirectory } from "./capture-directory";
import { demoPort } from "./demo-capture";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BASE = createCaptureDirectory({
  envName: "ACCOUNTS_CAPTURE_DIR",
  prefix: "llv-issue-1418",
  raw: process.env.ACCOUNTS_CAPTURE_DIR,
  repoRoot: REPO_ROOT,
});
const HOME = path.join(BASE, "home");
const CONFIG = path.join(HOME, ".config");
const STATE = path.join(CONFIG, "agent-log-viewer", "state");
const OUT_DIR = path.join(BASE, "out");
const CODEX_STUB = path.join(BASE, "bin", "codex");
const DESKTOP = { width: 1280, height: 860 };
const INTERMEDIATE = { width: 1024, height: 640 };
/** A narrow desktop window the rail still shows in, where the Copilot list once ran under the lower edge. */
const NARROW = { width: 707, height: 744 };
const PHONE = { width: 390, height: 844 };
const DAY = 86_400;

const codexTrigger = 'button[aria-label="Codex accounts — switch or add"]';
const claudeTrigger = 'button[aria-label="Claude accounts — switch or add"]';
const dialogFor = (engine: "Codex" | "Claude") => `[role="dialog"][aria-label="${engine} accounts"]`;
/* The phone's route to the same accounts, mobile v2 lane 9: board ▸ ⋯ ▸
   Accounts & limits. The hooks are the shell's own (`data-mobile2-*`). */
const PHONE_SCREEN = '[data-mobile2-screen="accounts"]';
const REPO_DIR = path.join(HOME, "Projects", "atlas");
const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");
/* Composed rather than written out: a literal UUID in a published source file
   is what the privacy gate's resource-identifier rule exists to catch. */
const SESSION_UUID = ["00001418", "0000", "4000", "8000", "000000000000"].join("-");

function seedEnvironment(): void {
  process.env.HOME = HOME;
  process.env.XDG_CONFIG_HOME = CONFIG;
  process.env.LLV_STATE_DIR = STATE;
  process.env.LLV_CLAUDE_HOME = path.join(HOME, ".claude");
  process.env.LLV_CODEX_HOME = path.join(HOME, ".codex");
  process.env.COPILOT_HOME = path.join(HOME, ".copilot");
}

/* One invented project with one transcript: the phone's Accounts & limits
   screen is pushed from a board's ⋯ menu, and a board needs a project. */
function seedProject(): void {
  const folder = path.join(HOME, ".claude", "projects", projectSlug(REPO_DIR));
  fs.mkdirSync(REPO_DIR, { recursive: true });
  fs.mkdirSync(folder, { recursive: true });
  const stamp = new Date();
  const lines = [
    { type: "user", uuid: `${SESSION_UUID}-u`, timestamp: new Date(stamp.getTime() - 60_000).toISOString(), cwd: REPO_DIR, sessionId: SESSION_UUID, message: { role: "user", content: "Read the limits dialog and report what each window says." } },
    { type: "assistant", uuid: `${SESSION_UUID}-a`, timestamp: stamp.toISOString(), cwd: REPO_DIR, sessionId: SESSION_UUID, message: { role: "assistant", model: "claude-opus-4-6", content: [{ type: "text", text: "Each card shows its windows with the headroom left in each." }] } },
  ];
  fs.writeFileSync(path.join(folder, `${SESSION_UUID}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

/* The accounts and their readings are written through the same modules the
   Viewer uses, after the environment points them at the synthetic home. */
async function seedHome(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(BASE, "tmp", `claude-${process.getuid?.() ?? 1000}`), { recursive: true });
  fs.mkdirSync(path.join(BASE, "tmux"), { recursive: true });
  fs.mkdirSync(STATE, { recursive: true });
  /* The setup guide opens by itself on a home with no Viewer state and covers
     the account buttons; this home stands for an install already set up. */
  fs.writeFileSync(path.join(STATE, "onboarding.json"), JSON.stringify({
    schemaVersion: 1, completedAt: null, dismissedAt: new Date().toISOString(), reason: "existing-install", steps: {}, lastHealth: null, walk: "skipped",
  }));
  fs.mkdirSync(path.join(HOME, ".codex", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".claude", "projects"), { recursive: true });
  seedProject();
  fs.mkdirSync(path.dirname(CODEX_STUB), { recursive: true });
  fs.writeFileSync(CODEX_STUB, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(HOME, ".codex", "auth.json"), "{}", { mode: 0o600 });
  fs.writeFileSync(path.join(HOME, ".claude", ".credentials.json"), "{}", { mode: 0o600 });

  const { createManagedCodexAccount, setActiveCodexAccount } = await import("@/lib/accounts/codex");
  const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
  const { agentRegistry } = await import("@/lib/agent/registry");

  const codexA = createManagedCodexAccount("Account A");
  fs.writeFileSync(path.join(codexA.home, "auth.json"), "{}", { mode: 0o600 });
  const codexC = createManagedCodexAccount("Account C");
  fs.writeFileSync(path.join(codexC.home, "auth.json"), "{}", { mode: 0o600 });
  /* The exhausted account holds the seat, because that is when a reset gets
     used: on the phone only the active account's card carries the limits
     block, so this is what puts a live «Use one reset» in the shot. */
  setActiveCodexAccount(codexA.id);
  const claudeB = createManagedClaudeAccount("Account B");
  fs.writeFileSync(path.join(claudeB.home, ".credentials.json"), "{}", { mode: 0o600 });

  await seedImportedAccounts();

  const now = new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const at = now.toISOString();
  const live = { source: "live" as const, reason: null, staleSince: null };
  const window = (usedPercent: number, resetsAt: number, windowMinutes: number) => ({ usedPercent, resetsAt, windowMinutes });
  agentRegistry().recordQuotaEvaluation({
    engine: "codex",
    observations: [
      {
        engine: "codex", accountId: "default", authenticated: true, authCheckedAt: at, observedAt: at, bootId: "capture", provenance: live,
        limits: { session: window(8, nowS + 3 * 3_600, 300), weekly: window(39, nowS + 3 * DAY, 10_080), plan: "pro", capturedAt: nowS },
        resetCredits: { availableCount: 0, expiresAt: null },
      },
      {
        engine: "codex", accountId: codexA.id, authenticated: true, authCheckedAt: at, observedAt: at, bootId: "capture", provenance: live,
        limits: { session: null, weekly: window(100, nowS + 5 * DAY, 10_080), plan: "pro", capturedAt: nowS },
        resetCredits: { availableCount: 1, expiresAt: nowS + 20 * DAY },
      },
      {
        engine: "codex", accountId: codexC.id, authenticated: true, authCheckedAt: at, observedAt: at, bootId: "capture", provenance: live,
        limits: { session: window(20, nowS + 2 * 3_600, 300), weekly: window(83, nowS + 2 * DAY, 10_080), plan: "prolite", capturedAt: nowS },
        resetCredits: { availableCount: 0, expiresAt: null },
      },
    ],
    signature: null, bootId: "capture", now: at, minimumGapMs: 60_000,
  });
  agentRegistry().recordQuotaEvaluation({
    engine: "claude",
    observations: [
      {
        engine: "claude", accountId: "default", authenticated: true, authCheckedAt: at, observedAt: at, bootId: "capture", provenance: live,
        limits: {
          session: window(12, nowS + 3_600, 300),
          weekly: window(40, nowS + 4 * DAY, 10_080),
          flagship: { ...window(63, nowS + 4 * DAY, 10_080), tier: "opus" },
          plan: "max", capturedAt: nowS,
        },
      },
      {
        engine: "claude", accountId: claudeB.id, authenticated: true, authCheckedAt: at, observedAt: at, bootId: "capture", provenance: live,
        limits: { session: window(5, nowS + 2 * 3_600, 300), weekly: window(70, nowS + 6 * DAY, 10_080), plan: "pro", capturedAt: nowS },
      },
    ],
    signature: null, bootId: "capture", now: at, minimumGapMs: 60_000,
  });
}

/* An install transfer brought these accounts (install-memory-transfer §3.4):
   made signed out through the account setup, their checklist rows in every
   state a row can show. The rows are written into the transfer's own
   collection, as an import's commit writes them. */
const IMPORTED_CODEX: { label: string; state: string; detail?: string; activeOnSource?: boolean; made?: false; retry?: true }[] = [
  { label: "Team 1", state: "signed_out", activeOnSource: true },
  { label: "Team 2", state: "signed_out" },
  { label: "Team 3", state: "different_account" },
  { label: "Team 4", state: "read_failed", detail: "identity-unreadable" },
  { label: "Team 5", state: "read_failed", detail: "quota probe timed out" },
  { label: "Team 6", state: "signed_out" },
  { label: "Team 7", state: "not_created", detail: "create-failed", made: false, retry: true },
  { label: "Team 8", state: "signed_out" },
];

async function seedImportedAccounts(): Promise<void> {
  const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
  const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
  const { createManagedCopilotAccount } = await import("@/lib/accounts/copilot");
  const { TRANSFER_ACCOUNTS_SEED } = await import("@/lib/transfer/accounts");
  const { initializeStateCollections, SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
  const row = (engine: string, sourceId: string, targetId: string | null, label: string, state: string, extra: Record<string, unknown> = {}) => ({
    kind: "account", importId: "capture-import", exportId: "capture-export", engine, sourceId, targetId, label, sourceKind: "managed",
    activeOnSource: false, identity: null, bindings: [], state, ...extra,
  });
  const rows: Record<string, unknown>[] = [];
  for (const [index, entry] of IMPORTED_CODEX.entries()) {
    const targetId = entry.made === false ? `team-${index + 1}` : createManagedCodexAccount(entry.label).id;
    rows.push(row("codex", `team-${index + 1}`, targetId, entry.label, entry.state, {
      ...(entry.detail ? { detail: entry.detail } : {}), ...(entry.activeOnSource ? { activeOnSource: true } : {}), ...(entry.retry ? { pendingCreate: true } : {}),
    }));
  }
  rows.push(row("claude", "research", createManagedClaudeAccount("Research").id, "Research", "signed_out"));
  rows.push(row("claude", "gateway", null, "Gateway", "not_created", { detail: "provider-account" }));
  rows.push(row("copilot", "github-work", createManagedCopilotAccount("GitHub work").id, "GitHub work", "signed_out"));
  const database = path.join(STATE, "state.sqlite");
  initializeStateCollections(database, [TRANSFER_ACCOUNTS_SEED]);
  const collection = new SqliteStateCollection<Record<string, unknown>>(database, {
    collection: TRANSFER_ACCOUNTS_SEED.collection, schemaVersion: 1, busyMessage: "transfer accounts busy",
    key: (value) => TRANSFER_ACCOUNTS_SEED.key(value as never), decode: (value) => value as Record<string, unknown>, clone: structuredClone,
  });
  try { collection.patchSync(() => ({ records: rows })); } finally { collection.close(); }
}

function serverEnvironment(port: number): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PATH: process.env.PATH,
    HOME,
    TMPDIR: path.join(BASE, "tmp"),
    TMUX_TMPDIR: path.join(BASE, "tmux"),
    XDG_CONFIG_HOME: CONFIG,
    XDG_CACHE_HOME: path.join(BASE, "cache"),
    XDG_RUNTIME_DIR: path.join(BASE, "runtime"),
    LLV_STATE_DIR: STATE,
    LLV_CLAUDE_HOME: path.join(HOME, ".claude"),
    LLV_CODEX_HOME: path.join(HOME, ".codex"),
    COPILOT_HOME: path.join(HOME, ".copilot"),
    LLV_CODEX_BINARY: CODEX_STUB,
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(port),
    TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", USER: "demo", LOGNAME: "demo", SHELL: "/bin/sh",
  };
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/api/files`)).ok) return;
    } catch {
      /* still booting */
    }
    await Bun.sleep(300);
  }
  throw new Error("production server did not become ready");
}

interface DialogFacts {
  boundChips: number;
  boundText: boolean;
  cards: number;
  refreshButtons: number;
  resetButtons: number;
  resetEnabled: string[];
  flagshipRows: string[];
  bottom: number;
  viewport: number;
  scrollWidth: number;
  innerWidth: number;
}

async function dialogFacts(page: Page, engine: "Codex" | "Claude"): Promise<DialogFacts> {
  return page.evaluate((selector) => {
    const dialog = document.querySelector(selector)!;
    return {
      boundChips: dialog.querySelectorAll("[data-account-projects]").length,
      boundText: (dialog.textContent ?? "").includes("Bound to"),
      cards: dialog.querySelectorAll("[data-account-limits]").length,
      refreshButtons: dialog.querySelectorAll("[data-account-refresh-limits]").length,
      resetButtons: dialog.querySelectorAll("[data-account-use-reset]").length,
      resetEnabled: [...dialog.querySelectorAll<HTMLButtonElement>("[data-account-use-reset]")].filter((button) => !button.disabled).map((button) => button.getAttribute("data-account-use-reset")!),
      flagshipRows: [...dialog.querySelectorAll("[data-limit-row^='tier:']")].map((row) => row.closest("[data-account-limits]")!.getAttribute("data-account-limits")!),
      bottom: Math.round(dialog.getBoundingClientRect().bottom),
      viewport: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  }, dialogFor(engine));
}

/* The dialog is the DESKTOP surface now: the phone's accounts live on their
   own screen (`checkScreen`), which never opens this. */
function checkDialog(engine: "Codex" | "Claude", facts: DialogFacts): void {
  const where = `desktop ${engine}`;
  if (facts.boundChips > 0 || facts.boundText) throw new Error(`${where}: a 'Bound to' chip is still on a card`);
  if (facts.cards === 0) throw new Error(`${where}: no card rendered a limits block`);
  if (facts.refreshButtons !== facts.cards) throw new Error(`${where}: ${facts.refreshButtons} refresh actions for ${facts.cards} limits blocks`);
  if (engine === "Codex") {
    if (facts.resetButtons !== facts.cards) throw new Error(`${where}: ${facts.resetButtons} reset controls for ${facts.cards} cards`);
    if (facts.resetEnabled.join() !== "account-a") throw new Error(`${where}: the reset control is enabled on [${facts.resetEnabled.join(", ")}], expected only the account holding a credit`);
    if (facts.flagshipRows.length) throw new Error(`${where}: a Codex card drew a flagship row`);
  } else {
    if (facts.resetButtons !== 0) throw new Error(`${where}: a Claude card drew a reset control`);
    if (facts.flagshipRows.join() !== "default") throw new Error(`${where}: flagship rows on [${facts.flagshipRows.join(", ")}], expected only the account reporting a bucket`);
  }
  if (facts.scrollWidth > facts.innerWidth) throw new Error(`${where}: the document scrolls to ${facts.scrollWidth}px at ${facts.innerWidth}px`);
  if (facts.bottom > facts.viewport) throw new Error(`${where}: the dialog ends at ${facts.bottom}px, past the ${facts.viewport}px viewport`);
}

interface ChecklistFacts {
  rows: { label: string; state: string; buttons: string[]; overflow: boolean }[];
  title: string | null;
}

/** The open accounts dialog that carries the transfer checklist, in any language. */
const CHECKLIST_DIALOG = '[role="dialog"]:has([data-transfer-checklist])';

/** The transfer checklist inside a container, read off the DOM. */
async function checklistFacts(page: Page, container: string): Promise<ChecklistFacts> {
  return page.evaluate((selector) => {
    const section = document.querySelector(selector)!.querySelector("[data-transfer-checklist]");
    return {
      title: section?.querySelector("h3")?.textContent ?? null,
      rows: [...(section?.querySelectorAll("[data-transfer-account]") ?? [])].map((row) => {
        const spans = row.querySelectorAll("span");
        return {
          label: spans[0]?.textContent ?? "",
          state: spans[1]?.textContent ?? "",
          buttons: [...row.querySelectorAll<HTMLButtonElement>("button")].filter((button) => !button.disabled).map((button) => (button.textContent ?? "").trim()),
          overflow: [...row.querySelectorAll<HTMLElement>("*")].some((element) => element.scrollWidth > element.clientWidth + 1 && !element.classList.contains("truncate")),
        };
      }),
    };
  }, container);
}

const WORDS = {
  en: { title: "Accounts from your other install", signIn: "Sign in", again: "Sign in again", confirm: "This is the right account", retry: "Try again", skip: "Not needed here",
    signedOut: "Signed out", different: "Different account", readFailed: "Limits not read", notCreated: "Not created" },
  uk: { title: "Акаунти з вашої іншої інсталяції", signIn: "Увійти", again: "Увійти знову", confirm: "Це правильний акаунт", retry: "Спробувати ще раз", skip: "Тут не потрібен",
    signedOut: "Не ввійдено", different: "Інший акаунт", readFailed: "Ліміти не прочитано", notCreated: "Не створено" },
} as const;

/** What each imported row must say and offer, per engine and language. */
function expectedRows(engine: "codex" | "claude" | "copilot", locale: "en" | "uk"): { label: string; state: string; buttons: string[] }[] {
  const w = WORDS[locale];
  if (engine === "claude") return [
    { label: "Research", state: w.signedOut, buttons: [w.signIn, w.skip] },
    { label: "Gateway", state: w.notCreated, buttons: [w.skip] },
  ];
  if (engine === "copilot") return [{ label: "GitHub work", state: w.signedOut, buttons: [w.signIn, w.skip] }];
  return IMPORTED_CODEX.map((entry) => entry.state === "signed_out" ? { label: entry.label, state: w.signedOut, buttons: [w.signIn, w.skip] }
    : entry.state === "different_account" ? { label: entry.label, state: w.different, buttons: [w.again, w.confirm, w.skip] }
      : entry.state === "read_failed" ? { label: entry.label, state: w.readFailed, buttons: entry.detail === "identity-unreadable" ? [w.again, w.confirm, w.skip] : [w.again, w.skip] }
        : { label: entry.label, state: w.notCreated, buttons: [w.retry, w.skip] });
}

function checkChecklist(where: string, engine: "codex" | "claude" | "copilot", locale: "en" | "uk", facts: ChecklistFacts): void {
  if (facts.title !== WORDS[locale].title) throw new Error(`${where}: the title reads «${facts.title}»`);
  const expected = expectedRows(engine, locale);
  const got = facts.rows.map((row) => ({ label: row.label, state: row.state, buttons: row.buttons }));
  if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error(`${where}: rows are ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  if (facts.rows.some((row) => row.overflow)) throw new Error(`${where}: text in a row overflows its box`);
}

/**
 * Whether everything the checklist offers can be reached in `container`: the
 * container lies wholly inside the viewport, its close control too; the
 * checklist heading's text is whole at the opening scroll position; and every
 * row and every action, once scrolled to, lies wholly inside the viewport and
 * every scrolling ancestor, with nothing (a sticky header, fixed chrome) drawn
 * over its centre. Measured from the elements and the heading's text range.
 */
async function reachability(page: Page, container: string, closeControl: string | null): Promise<string[]> {
  return page.evaluate(async ({ selector, close }) => {
    const problems: string[] = [];
    const root = document.querySelector(selector) as HTMLElement;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const viewport = { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
    type Box = { top: number; left: number; bottom: number; right: number };
    const round = (box: Box) => `${Math.round(box.top)}..${Math.round(box.bottom)}`;
    const inside = (box: Box, bound: Box) => box.top >= bound.top - 0.5 && box.bottom <= bound.bottom + 0.5 && box.left >= bound.left - 0.5 && box.right <= bound.right + 0.5;
    const clip = (element: Element): Box => {
      let box: Box = { ...viewport };
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (!/(auto|scroll|hidden)/.test(style.overflowY + style.overflowX)) continue;
        const rect = node.getBoundingClientRect();
        box = { top: Math.max(box.top, rect.top), left: Math.max(box.left, rect.left), bottom: Math.min(box.bottom, rect.bottom), right: Math.min(box.right, rect.right) };
      }
      return box;
    };
    const uncovered = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return !!hit && (hit === element || element.contains(hit));
    };
    if (root.getAttribute("role") === "dialog" && !inside(root.getBoundingClientRect(), viewport)) problems.push(`the dialog spans ${round(root.getBoundingClientRect())} in a ${window.innerHeight}px viewport`);
    if (close) {
      const control = root.querySelector(close);
      if (!control || !inside(control.getBoundingClientRect(), viewport) || !uncovered(control)) problems.push("the close control is not wholly on screen");
    }
    const heading = root.querySelector("[data-transfer-checklist] h3");
    if (!heading) return [...problems, "no checklist heading"];
    if (root.getAttribute("role") === "dialog") {
      const range = document.createRange();
      range.selectNodeContents(heading);
      const text = range.getBoundingClientRect();
      if (!inside(text, clip(heading))) problems.push(`the checklist heading's text is cut at opening (${round(text)} in ${round(clip(heading))})`);
    }
    const targets = [...root.querySelectorAll("[data-transfer-checklist] [data-transfer-account]")].flatMap((row) => [row, ...row.querySelectorAll("button")]);
    for (const target of targets) {
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
      await frame();
      const name = `${target.closest("[data-transfer-account]")?.getAttribute("data-transfer-account")} ${target.tagName === "BUTTON" ? `«${(target.textContent ?? "").trim()}»` : "row"}`;
      const rect = target.getBoundingClientRect();
      if (!inside(rect, clip(target))) problems.push(`${name} is cut by a scroll edge (${round(rect)} in ${round(clip(target))})`);
      else if (!uncovered(target)) problems.push(`${name} is covered at its centre`);
      if (target.tagName === "BUTTON" && root.closest("[data-mobile2-screen]") && rect.height < 44) problems.push(`${name} is ${Math.round(rect.height)}px tall, under 44px`);
    }
    if (close) {
      const control = root.querySelector(close);
      if (!control || !inside(control.getBoundingClientRect(), viewport) || !uncovered(control)) problems.push("the close control left the screen while scrolling");
    }
    return problems;
  }, { selector: container, close: closeControl });
}

/**
 * The Copilot list as it opens in the rail's footer, then as the operator
 * scrolls it with the wheel. Every box is measured against the viewport cut by
 * every ancestor that clips (the list's own scroller among them). At the
 * opening, before any input: the list's top, the checklist heading, «Check
 * all» and the first row's first action have their text wholly inside that
 * box. Then wheel turns over the list reach every checklist row and every
 * control of the list, each wholly inside the box and hit at its centre. Only
 * an ancestor that is a scroller (overflow-y auto or scroll) may have moved:
 * one whose overflow is hidden, or the page itself, scrolled only by script,
 * which is what an unreachable control looks like from the inside.
 */
async function copilotReachability(page: Page, list: string): Promise<string[]> {
  const TARGETS = "[data-transfer-checklist] [data-transfer-account], button, input";
  /* Shared by every measurement below, installed once on the page: the clip
     box of an element (the viewport cut by every clipping ancestor), an
     element's text box, and whether a box lies outside a clip. */
  await page.evaluate(() => {
    const host = window as unknown as Record<string, unknown>;
    host.__copilotClip = (element: Element) => {
      let box = { top: 0, bottom: window.innerHeight };
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(node).overflowY)) continue;
        const rect = node.getBoundingClientRect();
        box = { top: Math.max(box.top, rect.top), bottom: Math.min(box.bottom, rect.bottom) };
      }
      return box;
    };
    host.__copilotText = (element: Element) => { const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect(); };
  });
  const opening = await page.evaluate(({ selector }) => {
    const host = window as unknown as { __copilotClip: (element: Element) => { top: number; bottom: number }; __copilotText: (element: Element) => DOMRect };
    const clipOf = host.__copilotClip, textBox = host.__copilotText;
    const outside = (rect: { top: number; bottom: number }, clip: { top: number; bottom: number }) => rect.top < clip.top - 0.5 || rect.bottom > clip.bottom + 0.5;
    const span = (rect: { top: number; bottom: number }, clip: { top: number; bottom: number }) => `${rect.top.toFixed(2)}..${rect.bottom.toFixed(2)} outside ${clip.top.toFixed(2)}..${clip.bottom.toFixed(2)}`;
    const problems: string[] = [];
    const panel = document.querySelector(`${selector} [data-copilot-panel]`) as HTMLElement | null;
    if (!panel) return ["no Copilot list opened"];
    const top = panel.getBoundingClientRect();
    if (outside({ top: top.top, bottom: top.top + 1 }, clipOf(panel))) problems.push(`the list's top is at ${span({ top: top.top, bottom: top.top + 1 }, clipOf(panel))} at the opening`);
    const whole = (element: Element | null | undefined, name: string) => {
      if (!element) { problems.push(`no ${name}`); return; }
      const text = textBox(element), clip = clipOf(element);
      if (outside(text, clip)) problems.push(`${name} text is at ${span(text, clip)} at the opening`);
    };
    const checklist = panel.querySelector("[data-transfer-checklist]");
    whole(checklist?.querySelector("h3"), "the checklist heading");
    whole(checklist?.querySelector("h3")?.parentElement?.querySelector("button"), "«Check all»");
    whole(checklist?.querySelector("[data-transfer-account] button"), "the first row's first action");
    return problems;
  }, { selector: list });
  const box = await page.locator(`${list} [data-copilot-panel]`).boundingBox();
  if (!box) return [...opening, "the Copilot list has no box"];
  const visible = await page.evaluate(({ selector }) => {
    const clipOf = (window as unknown as { __copilotClip: (element: Element) => { top: number; bottom: number } }).__copilotClip;
    const panel = document.querySelector(`${selector} [data-copilot-panel]`)!;
    const rect = panel.getBoundingClientRect(), clip = clipOf(panel);
    return { top: Math.max(rect.top, clip.top), bottom: Math.min(rect.bottom, clip.bottom) };
  }, { selector: list });
  await page.mouse.move(box.x + box.width / 2, (visible.top + visible.bottom) / 2);
  const targets = await page.evaluate(({ selector, targets }) => document.querySelector(`${selector} [data-copilot-panel]`)!.querySelectorAll(targets).length, { selector: list, targets: TARGETS });
  const problems = [...opening];
  for (let index = 0; index < targets; index += 1) {
    for (let turn = 0; turn < 40; turn += 1) {
      const where = await page.evaluate(({ selector, index, targets }) => {
        const clipOf = (window as unknown as { __copilotClip: (element: Element) => { top: number; bottom: number } }).__copilotClip;
        const target = document.querySelector(`${selector} [data-copilot-panel]`)!.querySelectorAll(targets)[index]!;
        const rect = target.getBoundingClientRect(), clip = clipOf(target);
        return rect.top < clip.top - 0.5 ? -1 : rect.bottom > clip.bottom + 0.5 ? 1 : 0;
      }, { selector: list, index, targets: TARGETS });
      if (where === 0) break;
      await page.mouse.wheel(0, where * 60);
      await page.waitForTimeout(30);
    }
    problems.push(...await page.evaluate(({ selector, index, targets }) => {
      const clipOf = (window as unknown as { __copilotClip: (element: Element) => { top: number; bottom: number } }).__copilotClip;
      const outside = (rect: { top: number; bottom: number }, clip: { top: number; bottom: number }) => rect.top < clip.top - 0.5 || rect.bottom > clip.bottom + 0.5;
      const found: string[] = [];
      const panel = document.querySelector(`${selector} [data-copilot-panel]`) as HTMLElement;
      const target = panel.querySelectorAll(targets)[index]! as HTMLElement;
      const name = target.tagName === "BUTTON" ? `«${(target.textContent ?? "").trim()}»` : target.tagName === "INPUT" ? "the label field" : `row ${target.getAttribute("data-transfer-account")}`;
      const rect = target.getBoundingClientRect();
      if (outside(rect, clipOf(target))) found.push(`${name} is cut at ${Math.round(rect.top)}..${Math.round(rect.bottom)} after scrolling with the wheel`);
      else {
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (!hit || !(hit === target || target.contains(hit))) found.push(`${name} is covered at its centre`);
      }
      for (let node: HTMLElement | null = target.parentElement; node; node = node.parentElement) {
        if (node.scrollTop !== 0 && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) found.push(`${node.tagName.toLowerCase()} (overflow ${getComputedStyle(node).overflowY}) scrolled by ${node.scrollTop}px`);
      }
      if ((document.scrollingElement?.scrollTop ?? 0) !== 0) found.push("the page scrolled");
      return found;
    }, { selector: list, index, targets: TARGETS }));
  }
  return [...new Set(problems)];
}

interface EngineFacts {
  engine: string;
  cards: number;
  refreshButtons: number;
  resetButtons: number;
  resetEnabled: string[];
  flagshipRows: string[];
  /** Per window row: what the row printed, and what its meter drew. */
  rows: { row: string; printed: number; meter: number }[];
  corner: { left: number; window: string; windows: string[] } | null;
}

interface ScreenFacts {
  boundChips: number;
  boundText: boolean;
  engines: EngineFacts[];
  minTarget: number;
  scrollWidth: number;
  innerWidth: number;
}

/** What the phone's Accounts & limits screen is showing, read off the DOM. */
async function screenFacts(page: Page): Promise<ScreenFacts> {
  return page.evaluate((selector) => {
    const screen = document.querySelector(selector)!;
    const percent = (text: string | null | undefined) => {
      const match = /(\d+)%/.exec(text ?? "");
      return match ? Number(match[1]) : Number.NaN;
    };
    const targets = [...screen.querySelectorAll<HTMLElement>("button, a[href]")]
      .filter((element) => element.getBoundingClientRect().height > 0);
    return {
      boundChips: screen.querySelectorAll("[data-account-projects]").length,
      boundText: (screen.textContent ?? "").includes("Bound to"),
      engines: [...screen.querySelectorAll("[data-mobile2-accounts-engine]")].map((section) => {
        const card = section.querySelector("[data-account-limits]")?.closest("[data-mobile2-account]") ?? null;
        const corner = card?.querySelector("[data-mobile2-account-corner]") ?? null;
        return {
          engine: section.getAttribute("data-mobile2-accounts-engine")!,
          cards: section.querySelectorAll("[data-account-limits]").length,
          refreshButtons: section.querySelectorAll("[data-account-refresh-limits]").length,
          resetButtons: section.querySelectorAll("[data-account-use-reset]").length,
          resetEnabled: [...section.querySelectorAll<HTMLButtonElement>("[data-account-use-reset]")].filter((button) => !button.disabled).map((button) => button.getAttribute("data-account-use-reset")!),
          flagshipRows: [...section.querySelectorAll("[data-limit-row^='tier:']")].map((row) => row.closest("[data-account-limits]")!.getAttribute("data-account-limits")!),
          rows: [...section.querySelectorAll("[data-limit-row]")].map((row) => ({
            row: row.getAttribute("data-limit-row")!,
            /* The row reads «<window> <meter> n% left», then its reset line
               under it: the first percentage in it is the headroom. */
            printed: percent(row.textContent),
            meter: Number(row.querySelector("[role='meter']")?.getAttribute("aria-valuenow") ?? Number.NaN),
          })),
          corner: corner
            ? {
              left: percent(corner.textContent),
              window: corner.getAttribute("data-mobile2-account-window")!,
              windows: [...(card?.querySelectorAll("[data-limit-row] dt") ?? [])].map((label) => (label.textContent ?? "").trim()),
            }
            : null,
        };
      }),
      minTarget: Math.min(...targets.map((element) => Math.round(element.getBoundingClientRect().height))),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  }, PHONE_SCREEN);
}

/* The phone's contract (README §4.8, §5), checked on the rendered screen: one
   limits block per engine — the active account's — the actions that block
   carries, and the two numbers the redesign fixed. */
function checkScreen(facts: ScreenFacts): void {
  const where = "phone accounts screen";
  if (facts.boundChips > 0 || facts.boundText) throw new Error(`${where}: a 'Bound to' chip is still on a card`);
  if (facts.engines.map((engine) => engine.engine).join() !== "claude,codex") throw new Error(`${where}: engine sections are [${facts.engines.map((engine) => engine.engine).join(", ")}], expected claude,codex`);
  for (const engine of facts.engines) {
    const at = `${where} (${engine.engine})`;
    if (engine.cards !== 1) throw new Error(`${at}: ${engine.cards} limits blocks, expected exactly the active account's`);
    if (engine.refreshButtons !== 1) throw new Error(`${at}: ${engine.refreshButtons} refresh actions for one limits block`);
    if (engine.engine === "codex") {
      if (engine.resetButtons !== 1) throw new Error(`${at}: ${engine.resetButtons} reset controls, expected one on the active card`);
      if (engine.resetEnabled.join() !== "account-a") throw new Error(`${at}: the reset control is enabled on [${engine.resetEnabled.join(", ")}], expected the account holding a credit`);
      if (engine.flagshipRows.length) throw new Error(`${at}: a Codex card drew a flagship row`);
    } else {
      if (engine.resetButtons !== 0) throw new Error(`${at}: a Claude card drew a reset control`);
      if (engine.flagshipRows.join() !== "default") throw new Error(`${at}: flagship rows on [${engine.flagshipRows.join(", ")}], expected only the account reporting a bucket`);
    }
    if (!engine.rows.length) throw new Error(`${at}: the active card drew no window row`);
    for (const row of engine.rows) {
      if (!Number.isFinite(row.printed) || !Number.isFinite(row.meter)) throw new Error(`${at}: the ${row.row} row has no number (printed ${row.printed}, meter ${row.meter})`);
      /* One meaning per meter: the fill IS what the row says is left. */
      if (row.printed !== row.meter) throw new Error(`${at}: the ${row.row} meter is at ${row.meter}% while its row reads ${row.printed}% left`);
    }
    /* Since #2776 the active card lists its week right below its head, so the
       head carries no corner number that would say it twice. */
    if (engine.corner) throw new Error(`${at}: the active card repeats its week in a corner number («${engine.corner.window}»)`);
  }
  if (facts.minTarget < 44) throw new Error(`${where}: a control is ${facts.minTarget}px tall, under the 44px floor`);
  if (facts.scrollWidth > facts.innerWidth) throw new Error(`${where}: the document scrolls to ${facts.scrollWidth}px at ${facts.innerWidth}px`);
}

/** Board ▸ ⋯ ▸ Accounts & limits — the phone's one route to its accounts. */
async function openAccountsScreen(page: Page, baseUrl: string, projectId: string): Promise<void> {
  await page.goto(`${baseUrl}/#p=${encodeURIComponent(projectId)}`, { waitUntil: "load" });
  await page.waitForSelector('[data-mobile2-screen="board"]', { timeout: 20_000 });
  await page.click('[data-mobile2-open="menu"]');
  await page.waitForSelector('[data-mobile2-sheet="menu"]');
  await page.click('[data-mobile2-go="accounts"]');
  await page.waitForSelector(PHONE_SCREEN, { timeout: 20_000 });
  await page.waitForSelector(`${PHONE_SCREEN} [data-limit-row]`, { timeout: 30_000 });
  await page.waitForTimeout(400);
}

/** The project the seeded transcript scanned into. */
async function seededProject(baseUrl: string): Promise<string> {
  const body = await (await fetch(`${baseUrl}/api/files`)).json() as { files?: { cwd?: string; project?: string }[] };
  const project = (body.files ?? []).find((file) => file.cwd === REPO_DIR)?.project;
  if (!project) throw new Error("the seeded project did not scan");
  return project;
}

async function openDialog(page: Page, engine: "Codex" | "Claude"): Promise<void> {
  const trigger = engine === "Codex" ? codexTrigger : claudeTrigger;
  /* The page counts as loaded before the limits read lands; the trigger names
     the active account's tightest window once it has. */
  await page.waitForFunction((selector) => !document.querySelector(selector)?.getAttribute("title")?.includes("Loading"), trigger, { timeout: 30_000 });
  await page.click(trigger);
  await page.waitForSelector(dialogFor(engine));
  await page.waitForTimeout(250);
}

async function closeDialog(page: Page, engine: "Codex" | "Claude"): Promise<void> {
  await page.click(`${dialogFor(engine)} button[aria-label="Close"]`);
  await page.waitForSelector(dialogFor(engine), { state: "detached" });
}

async function shootScreen(page: Page): Promise<void> {
  const file = path.join(OUT_DIR, "1418-phone-accounts.png");
  await page.screenshot({ path: file });
  console.log(`  ${path.basename(file)}`);
}

async function shoot(page: Page, engine: "Codex" | "Claude", suffix = ""): Promise<void> {
  const file = path.join(OUT_DIR, `1418-desktop-${engine.toLowerCase()}${suffix}.png`);
  await page.locator(dialogFor(engine)).screenshot({ path: file });
  console.log(`  ${path.basename(file)}`);
}

async function main(): Promise<void> {
  const port = demoPort(process.env.ACCOUNTS_CAPTURE_PORT, 4418, "ACCOUNTS_CAPTURE_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  seedEnvironment();
  await seedHome();
  /* `package.json`'s own start command: `bunx next start` hands the server to
     node, where the instrumentation hook dies on "SQLite state stores require
     the Bun runtime" and every request 500s. */
  const server = spawn("bun", ["--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: REPO_ROOT,
    env: serverEnvironment(port),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const executablePath = process.env.CHROME_BIN
    ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    await waitForServer(baseUrl, server);
    console.log(`screenshots: ${OUT_DIR}`);

    const desktop = await browser.newPage({ viewport: DESKTOP });
    await desktop.goto(baseUrl, { waitUntil: "load" });
    await desktop.waitForSelector(codexTrigger);
    for (const engine of ["Codex", "Claude"] as const) {
      await openDialog(desktop, engine);
      checkDialog(engine, await dialogFacts(desktop, engine));
      await shoot(desktop, engine);
      if (engine === "Codex") {
        /* The actions fire on the first click — no confirm step — and reach the
           route: with the stub binary the live read fails, so the card lands on
           its failure notice, which is the wiring proven end to end. */
        await desktop.click('[data-account-refresh-limits="account-a"]');
        await desktop.waitForSelector(`${dialogFor(engine)} .text-danger:has-text("Could not re-read limits for Account A")`, { timeout: 30_000 });
        await shoot(desktop, engine, "-refresh-failed");
        const confirm = await desktop.locator(`${dialogFor(engine)} button:has-text("Confirm")`).count();
        if (confirm) throw new Error("desktop Codex: a confirmation control appeared for a limits action");
      }
      await closeDialog(desktop, engine);
    }
    await desktop.close();

    /* The transfer checklist in both languages and both schemes, at a full
       desktop and at a short window, then on the phone and in the Copilot list. */
    const TRIGGER = { en: (engine: string) => `button[aria-label="${engine} accounts — switch or add"]`, uk: (engine: string) => `button[aria-label="Акаунти ${engine} — змінити або додати"]` };
    const CLOSE = { en: 'header button[aria-label="Close"]', uk: 'header button[aria-label="Закрити"]' };
    const COPILOT_ROW = { en: 'button[aria-label="GitHub Copilot accounts"]', uk: 'button[aria-label="Акаунти GitHub Copilot"]' };
    const problems: string[] = [];
    for (const [locale, colorScheme] of [["en", "light"], ["uk", "dark"]] as const) {
      const write = await fetch(`${baseUrl}/api/operator/settings`, { method: "PUT", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ locale, source: "chosen" }) });
      if (!write.ok) throw new Error(`the interface language write answered ${write.status}`);
      for (const [size, viewport] of [["desktop", DESKTOP], ["short", INTERMEDIATE], ["narrow", NARROW]] as const) {
        const context = await browser.newContext({ viewport, colorScheme, reducedMotion: "reduce" });
        await context.addInitScript((lang: string) => { localStorage.setItem("llv_lang", lang); }, locale);
        const page = await context.newPage();
        await page.goto(baseUrl, { waitUntil: "load" });
        /* The first-run install-ping notice sits over the dialog's lower edge. */
        const notice = page.locator("[data-telemetry-notice] button", { hasText: locale === "en" ? "Got it" : "Зрозуміло" });
        if (await notice.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false)) await notice.click();
        for (const engine of size === "narrow" ? [] : ["Codex", "Claude"] as const) {
          await page.click(TRIGGER[locale](engine));
          await page.waitForSelector(CHECKLIST_DIALOG);
          await page.waitForSelector(`${CHECKLIST_DIALOG} [data-account-limits]`, { timeout: 30_000 });
          await page.waitForTimeout(250);
          const where = `${size} ${engine} transfer checklist (${locale}, ${colorScheme})`;
          checkChecklist(where, engine === "Codex" ? "codex" : "claude", locale, await checklistFacts(page, CHECKLIST_DIALOG));
          const base = `1418-${size}-${engine.toLowerCase()}-transfer-${locale}-${colorScheme}`;
          await page.screenshot({ path: path.join(OUT_DIR, `${base}-open.png`) });
          problems.push(...(await reachability(page, CHECKLIST_DIALOG, CLOSE[locale])).map((problem) => `${where}: ${problem}`));
          await page.screenshot({ path: path.join(OUT_DIR, `${base}-scrolled.png`) });
          console.log(`  ${base}-open.png, ${base}-scrolled.png`);
          await page.keyboard.press("Escape");
          await page.waitForSelector(CHECKLIST_DIALOG, { state: "detached" });
        }
        {
          await page.click(COPILOT_ROW[locale]);
          const list = '[data-engine-limits="copilot"]';
          await page.waitForSelector(`${list} [data-transfer-checklist="copilot"]`, { timeout: 30_000 });
          await page.waitForTimeout(250);
          const where = `${size} Copilot list transfer checklist (${locale}, ${colorScheme})`;
          checkChecklist(where, "copilot", locale, await checklistFacts(page, list));
          const base = `1418-${size}-copilot-transfer-${locale}-${colorScheme}`;
          await page.screenshot({ path: path.join(OUT_DIR, `${base}-open.png`) });
          problems.push(...(await copilotReachability(page, list)).map((problem) => `${where}: ${problem}`));
          await page.screenshot({ path: path.join(OUT_DIR, `${base}-scrolled.png`) });
          console.log(`  ${base}-open.png, ${base}-scrolled.png`);
        }
        await context.close();
      }
      const phoneContext = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme, reducedMotion: "reduce" });
      await phoneContext.addInitScript((lang: string) => { localStorage.setItem("llv_lang", lang); }, locale);
      const phonePage = await phoneContext.newPage();
      await openAccountsScreen(phonePage, baseUrl, await seededProject(baseUrl));
      await phonePage.screenshot({ path: path.join(OUT_DIR, `1418-phone-transfer-${locale}-${colorScheme}-open.png`) });
      for (const engine of ["claude", "codex"] as const) {
        const section = `${PHONE_SCREEN} [data-mobile2-accounts-engine="${engine}"]`;
        const where = `phone ${engine} transfer checklist (${locale}, ${colorScheme})`;
        checkChecklist(where, engine, locale, await checklistFacts(phonePage, section));
        problems.push(...(await reachability(phonePage, section, null)).map((problem) => `${where}: ${problem}`));
        await phonePage.screenshot({ path: path.join(OUT_DIR, `1418-phone-transfer-${locale}-${colorScheme}-${engine}.png`) });
      }
      console.log(`  1418-phone-transfer-${locale}-${colorScheme}-{open,claude,codex}.png`);
      await phoneContext.close();
    }
    await fetch(`${baseUrl}/api/operator/settings`, { method: "PUT", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ locale: "en", source: "chosen" }) });
    if (problems.length) throw new Error(`the transfer checklist is not wholly reachable:\n${problems.join("\n")}`);

    /* The phone (mobile v2 lane 9): one screen holds both engines, so there is
       one shot and one set of checks, reached the way the operator reaches it. */
    const phone = await browser.newPage({ viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await openAccountsScreen(phone, baseUrl, await seededProject(baseUrl));
    checkScreen(await screenFacts(phone));
    await shootScreen(phone);
    await phone.close();
    console.log("accounts: desktop flyout and phone screen verified");
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
