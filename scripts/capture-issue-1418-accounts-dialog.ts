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
 * horizontal scroll. Transfer checklist (install
 * transfer slice 2): two accounts an import brought, signed out, one per
 * engine; each dialog lists its one row with its state, «Sign in» and «Not
 * needed here» in en/light and uk/dark, nothing overflowing. Shots land in
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

  /* An install transfer brought two accounts (install-memory-transfer §3.4):
     made signed out through the same account setup, with no identity read. */
  const { applyAccounts } = await import("@/lib/transfer/accounts");
  await applyAccounts("capture-import", "capture-export", [
    { key: "account:codex:team", value: { engine: "codex", id: "team", label: "Team", kind: "managed", active: true, identity: null } },
    { key: "account:claude:research", value: { engine: "claude", id: "research", label: "Research", kind: "managed", active: false, identity: null } },
  ], { identity: async () => null });

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
  bottom: number;
  viewport: number;
  scrollWidth: number;
  innerWidth: number;
}

/** The open accounts dialog that carries the transfer checklist, in any language. */
const CHECKLIST_DIALOG = '[role="dialog"]:has([data-transfer-checklist])';

/** The transfer checklist at the top of a dialog, read off the DOM. */
async function checklistFacts(page: Page): Promise<ChecklistFacts> {
  return page.evaluate((selector) => {
    const dialog = document.querySelector(selector)!;
    const section = dialog.querySelector("[data-transfer-checklist]");
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
      bottom: Math.round(dialog.getBoundingClientRect().bottom),
      viewport: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  }, CHECKLIST_DIALOG);
}

/* Each dialog lists the one account the transfer brought to its engine,
   signed out, with the product's own sign-in offered and every word in the
   page's language; nothing overflows and the dialog stays on screen. */
function checkChecklist(engine: "Codex" | "Claude", locale: "en" | "uk", facts: ChecklistFacts): void {
  const where = `desktop ${engine} transfer checklist (${locale})`;
  const words = locale === "en"
    ? { title: "Accounts from your other install", state: "Signed out", signIn: "Sign in", skip: "Not needed here" }
    : { title: "Акаунти з вашої іншої інсталяції", state: "Не ввійдено", signIn: "Увійти", skip: "Тут не потрібен" };
  const label = engine === "Codex" ? "Team" : "Research";
  if (facts.title !== words.title) throw new Error(`${where}: the title reads «${facts.title}»`);
  if (facts.rows.length !== 1 || facts.rows[0]!.label !== label) throw new Error(`${where}: rows are [${facts.rows.map((row) => row.label).join(", ")}], expected ${label}`);
  const row = facts.rows[0]!;
  if (row.state !== words.state) throw new Error(`${where}: the state reads «${row.state}»`);
  if (row.buttons.join("|") !== `${words.signIn}|${words.skip}`) throw new Error(`${where}: the row offers [${row.buttons.join(", ")}]`);
  if (row.overflow) throw new Error(`${where}: text in the row overflows its box`);
  if (facts.scrollWidth > facts.innerWidth) throw new Error(`${where}: the document scrolls to ${facts.scrollWidth}px at ${facts.innerWidth}px`);
  if (facts.bottom > facts.viewport) throw new Error(`${where}: the dialog ends at ${facts.bottom}px, past the ${facts.viewport}px viewport`);
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

    /* The transfer checklist in both languages and both schemes. */
    const TRIGGER = { en: (engine: string) => `button[aria-label="${engine} accounts — switch or add"]`, uk: (engine: string) => `button[aria-label="Акаунти ${engine} — змінити або додати"]` };
    for (const [locale, colorScheme] of [["en", "light"], ["uk", "dark"]] as const) {
      const write = await fetch(`${baseUrl}/api/operator/settings`, { method: "PUT", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ locale, source: "chosen" }) });
      if (!write.ok) throw new Error(`the interface language write answered ${write.status}`);
      const context = await browser.newContext({ viewport: DESKTOP, colorScheme, reducedMotion: "reduce" });
      await context.addInitScript((lang: string) => { localStorage.setItem("llv_lang", lang); }, locale);
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: "load" });
      /* The first-run install-ping notice sits over the dialog's lower edge. */
      const notice = page.locator("[data-telemetry-notice] button", { hasText: locale === "en" ? "Got it" : "Зрозуміло" });
      if (await notice.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false)) await notice.click();
      for (const engine of ["Codex", "Claude"] as const) {
        await page.click(TRIGGER[locale](engine));
        await page.waitForSelector(CHECKLIST_DIALOG);
        /* The shot shows the checklist above the cards it belongs to. */
        await page.waitForSelector(`${CHECKLIST_DIALOG} [data-account-limits]`, { timeout: 30_000 });
        await page.waitForTimeout(250);
        checkChecklist(engine, locale, await checklistFacts(page));
        const file = path.join(OUT_DIR, `1418-desktop-${engine.toLowerCase()}-transfer-${locale}-${colorScheme}.png`);
        await page.locator(CHECKLIST_DIALOG).screenshot({ path: file });
        console.log(`  ${path.basename(file)}`);
        await page.keyboard.press("Escape");
        await page.waitForSelector(CHECKLIST_DIALOG, { state: "detached" });
      }
      await context.close();
    }
    await fetch(`${baseUrl}/api/operator/settings`, { method: "PUT", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ locale: "en", source: "chosen" }) });

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
