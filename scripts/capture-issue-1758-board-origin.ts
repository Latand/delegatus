/**
 * Rendered acceptance for #1758, in a real browser against the production
 * build, at the width the operator reported:
 *
 *   bun run build && bun scripts/capture-issue-1758-board-origin.ts
 *
 * The claim under measurement: two LIVE background processes that no
 * conversation on the board owns must leave the board exactly where it was.
 * They used to dock above the board header as full-width strips titled
 * «Background task <id>», one 44 px row each, pushing the whole board down for
 * something the operator cannot act on.
 *
 * The run serves the production build against a purpose-built synthetic home
 * under the temp root — its own HOME, XDG dirs, TMPDIR, viewer state dir and
 * provider homes — so it neither reads nor writes the operator's live state,
 * and no real path reaches any measurement. Nothing is deployed.
 *
 * Three readings at 1280 px, in this order, against ONE server and ONE home,
 * so the only thing that differs between the first two is the processes
 * themselves:
 *
 *   1. `clean`   — the seeded project alone.
 *   2. `live`    — two parentless background processes added, each one a real
 *                  `.output` file held open by a real child process, which is
 *                  what makes the scanner call it live (`activity.ts` reads the
 *                  fd holders). The API is asked to confirm both arrived, live,
 *                  with no parent, in the board's own project, BEFORE anything
 *                  is measured: a reading taken over processes the Viewer never
 *                  saw would be green and worth nothing.
 *   3. `docked`  — the red path. A replica of the removed strip is inserted
 *                  above the board in the live page. The probe must report a
 *                  moved origin and see the strip; a run where it does not exits
 *                  non-zero, because a measurement that cannot go red says
 *                  nothing when it is green.
 *
 * The board origin is `[data-kanban-board]`'s own viewport top, plus every
 * element painted above it (walked out from the board through its ancestor
 * chain) with its box and its first words. `clean` and `live` must agree on
 * all of it.
 *
 * Measurements land in `evidence/issue-1758/board-origin.json`. Frames are
 * written beside the synthetic home, OUTSIDE the repository, and are not
 * committed: the evidence is the JSON and this driver.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

import { createCaptureDirectory } from "./capture-directory";

const repoRoot = path.resolve(import.meta.dir, "..");
const BASE = createCaptureDirectory({
  envName: "BOARD_CAPTURE_DIR",
  prefix: "llv-issue-1758",
  raw: process.env.BOARD_CAPTURE_DIR,
  repoRoot,
});
const HOME = path.join(BASE, "home");
const TMP = path.join(BASE, "tmp");
const OUT_DIR = path.join(BASE, "out");
const STATE_DIR = path.join(HOME, ".config", "agent-log-viewer", "state");
const EVIDENCE = path.join(repoRoot, "evidence", "issue-1758");

const PROJECT_NAME = "dock";
/** The reported width. */
const VIEWPORT = { width: 1280, height: 900 };
/** Two, because two is what the operator had stacked above their board. */
const TASK_IDS = ["aaaa1111", "bbbb2222"];
/** A session id no transcript in this home carries, which is what leaves the
    process parentless: `links.ts` binds a task to its session's transcript. */
const ORPHAN_SESSION = ["00000000", "1111", "4111", "8111", "222222222222"].join("-");

const uid = process.getuid?.() ?? 1000;
const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");
const line = (record: Record<string, unknown>) => JSON.stringify(record) + "\n";
const cwdOf = () => path.join(HOME, "Projects", PROJECT_NAME);

function must(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------------- */
/* The synthetic home                                                         */
/* ------------------------------------------------------------------------- */

function seedHome(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(TMP, `claude-${uid}`), { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(path.join(HOME, ".codex/sessions"), { recursive: true });
  const cwd = cwdOf();
  fs.mkdirSync(cwd, { recursive: true });
  const folder = path.join(HOME, ".claude/projects", projectSlug(cwd));
  fs.mkdirSync(folder, { recursive: true });
  /* Two ordinary conversations, so the board has cards of its own to draw and
     its header is where an operator would find it. */
  for (const index of [0, 1]) {
    const uuid = `${String(index + 1).padStart(8, "0")}-3333-4333-8333-333333333333`;
    const stamp = "2100-01-02T09:00:00.000Z";
    const title = `Agent ${index} watches area ${index}`;
    fs.writeFileSync(
      path.join(folder, `${uuid}.jsonl`),
      line({ type: "user", uuid: `${uuid}-u`, timestamp: stamp, cwd, message: { role: "user", content: `${title}.` } })
      + line({ type: "assistant", uuid: `${uuid}-a`, timestamp: stamp, cwd, message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: `${title} — recorded.` }] } }),
      "utf8",
    );
  }
}

/**
 * The two parentless background processes. Each is the file layout Claude Code
 * writes — `<tmp>/claude-<uid>/<slug>/<session>/tasks/<id>.output` — under a
 * session this home has no transcript for, so the scanner finds no owner for
 * it. Each file is then held open by a real child process appending to it,
 * because "live" for a background task means exactly that: a process holds the
 * output's fd (`activityVerdict`, reason `output_held`).
 */
function startBackgroundTasks(): ChildProcess[] {
  const root = path.join(TMP, `claude-${uid}`, projectSlug(cwdOf()), ORPHAN_SESSION, "tasks");
  fs.mkdirSync(root, { recursive: true });
  return TASK_IDS.map((id) => {
    const file = path.join(root, `${id}.output`);
    fs.writeFileSync(file, `starting ${id}\n`, "utf8");
    /* `exec` so the held fd belongs to the process this handle names, and the
       kill below really releases it. Its only output is its own heartbeat. */
    return spawn("/bin/sh", ["-c", `exec >>"${file}" 2>&1; while :; do printf 'tick\\n'; sleep 2; done`], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, PATH: "/usr/bin:/bin", HOME, TMPDIR: TMP },
    });
  });
}

function stopBackgroundTasks(holders: ChildProcess[]): void {
  /* Only the handles this run created — never a pattern match over the host's
     processes, which would match this very command line. */
  for (const holder of holders) {
    try { holder.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/* ------------------------------------------------------------------------- */
/* The server                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Every variable that decides where the Viewer reads and writes points at the
 * synthetic home, and every stray `LLV_*` the caller exported is dropped, so
 * this run cannot reach the operator's state. The rest of the environment is
 * inherited because `bun --bun` needs it.
 */
function buildEnvironment(port: number): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const name of Object.keys(inherited)) {
    if (name.startsWith("LLV_") || name.startsWith("__NEXT_PRIVATE")) delete inherited[name];
  }
  return {
    ...inherited,
    NODE_ENV: "production",
    HOME,
    TMPDIR: TMP,
    TMUX_TMPDIR: path.join(BASE, "tmux"),
    XDG_CONFIG_HOME: path.join(HOME, ".config"),
    XDG_CACHE_HOME: path.join(BASE, "cache"),
    XDG_RUNTIME_DIR: path.join(BASE, "runtime"),
    LLV_STATE_DIR: STATE_DIR,
    LLV_CLAUDE_HOME: path.join(HOME, ".claude"),
    LLV_CODEX_HOME: path.join(HOME, ".codex"),
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(port),
    TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", USER: "demo", LOGNAME: "demo", SHELL: "/bin/sh",
  };
}

/** Served under the very interpreter running this script — the Viewer's own
    production start command is Bun, and an older Bun answers 500 on every
    route rather than failing at boot. */
const CAPTURE_BUN = process.env.BOARD_CAPTURE_BUN?.trim() || process.execPath;

function startServer(port: number): ChildProcess {
  return spawn(CAPTURE_BUN, ["--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot, env: buildEnvironment(port), stdio: ["ignore", "inherit", "inherit"],
  });
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`production server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/api/files`)).ok) return;
    } catch { /* still booting */ }
    await Bun.sleep(400);
  }
  throw new Error("production server did not become ready");
}

async function stopServer(server: ChildProcess | null): Promise<void> {
  if (!server) return;
  server.kill("SIGTERM");
  const deadline = Date.now() + 20_000;
  while (server.exitCode === null && Date.now() < deadline) await Bun.sleep(200);
  if (server.exitCode === null) server.kill("SIGKILL");
}

interface ScannedFile {
  path: string;
  project: string;
  root: string;
  parent: string | null;
  activity: string;
  title: string;
}

const files = async (baseUrl: string): Promise<ScannedFile[]> =>
  ((await (await fetch(`${baseUrl}/api/files`)).json()) as { files?: ScannedFile[] }).files ?? [];

async function waitFor<T>(read: () => Promise<T | null>, what: string, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(1_500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/* ------------------------------------------------------------------------- */
/* The in-page probe                                                          */
/* ------------------------------------------------------------------------- */

interface AboveBoard {
  tag: string;
  className: string;
  top: number;
  height: number;
  width: number;
  /** Spans the board's own column, which is the shape the dock had. */
  spansBoardWidth: boolean;
  text: string;
}
interface OriginReading {
  boardTop: number;
  boardLeft: number;
  viewportWidth: number;
  boardWidth: number;
  /** Every element painted above the board, in paint order. */
  above: AboveBoard[];
  /** Of those, the ones spanning the board's column. */
  boardWidthRowsAbove: number;
  /** Of those, the ones naming a background process. */
  backgroundStripsAbove: number;
  /** Whether the page names a background process ANYWHERE — the other half of
      the issue: they must stay reachable, in the sidebar and the file list. */
  namedSomewhereOnThePage: boolean;
}

/* Runs inside the page. A missing board throws rather than reading zero: a
   sentinel would compare equal between two cases and pass every assertion
   below while measuring nothing. */
const readOrigin = (): OriginReading => {
  const board = document.querySelector("[data-kanban-board]");
  if (!board) throw new Error("no [data-kanban-board] on the page — nothing to measure");
  const host = document.body;
  const above: AboveBoard[] = [];
  const round = (value: number) => Number(value.toFixed(2));
  const boardRect = board.getBoundingClientRect();
  for (let node: Element | null = board; node && node !== host; node = node.parentElement) {
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      const rect = sibling.getBoundingClientRect();
      if (rect.height === 0) continue;
      above.unshift({
        tag: sibling.tagName.toLowerCase(),
        className: sibling.getAttribute("class") ?? "",
        top: round(rect.top),
        height: round(rect.height),
        width: round(rect.width),
        spansBoardWidth: rect.width >= boardRect.width - 2,
        text: (sibling.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      });
    }
  }
  return {
    boardTop: round(boardRect.top),
    boardLeft: round(boardRect.left),
    viewportWidth: window.innerWidth,
    boardWidth: round(boardRect.width),
    above,
    boardWidthRowsAbove: above.filter((item) => item.spansBoardWidth).length,
    backgroundStripsAbove: above.filter((item) => item.text.includes("Background task")).length,
    namedSomewhereOnThePage: (document.body.textContent ?? "").includes("Background task"),
  };
};

/** The removed dock, put back by hand: the exact wrapper and row the dashboard
    used to render above the board. */
const injectDock = (titles: string[]): void => {
  const board = document.querySelector("[data-kanban-board]");
  if (!board) throw new Error("no [data-kanban-board] on the page — nothing to dock above");
  /* The dock was a sibling of the board's own column wrapper, which is the
     board element's parent; that wrapper is what it pushed down. */
  const anchor = board.parentElement?.parentElement ?? board.parentElement!;
  const strip = document.createElement("div");
  strip.className = "shrink-0 border-b border-border";
  strip.style.background = "rgba(0,128,0,0.12)";
  for (const title of titles) {
    const row = document.createElement("div");
    row.className = "border-l-4";
    row.style.height = "44px";
    row.style.borderLeft = "4px solid green";
    row.textContent = `Background task ${title}`;
    strip.appendChild(row);
  }
  anchor.parentElement!.insertBefore(strip, anchor);
};

async function openBoard(browser: Browser, baseUrl: string, project: string): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: "no-preference" });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/#p=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForSelector("[data-kanban-board]", { timeout: 120_000 });
  await page.waitForTimeout(2_500);
  return page;
}

/* ------------------------------------------------------------------------- */

/**
 * One case: a server generation over the shared synthetic home, the board
 * opened at 1280 px, and one reading.
 *
 * A generation per case rather than one server throughout, because the Viewer
 * serves `/api/files` from a cached projection whose first, staged form carries
 * conversations only: a background process appearing after that projection was
 * built is not visible to a poller for as long as the cache stands, and a
 * reading taken then would call the dock absent because the Viewer had not yet
 * heard of the processes. A generation that boots with them already on disk
 * cannot be wrong about them. Both cases read the same home, so nothing but
 * the processes differs between them.
 */
async function measure(
  browser: Browser,
  label: string,
  port: number,
  expectTasks: number,
  after?: (page: Page) => Promise<OriginReading>,
): Promise<{ origin: OriginReading; extra: OriginReading | null; project: string; tasks: ScannedFile[] }> {
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  try {
    server = startServer(port);
    await waitForServer(baseUrl, server);
    const scan = await waitFor(
      async () => {
        const all = await files(baseUrl);
        const conversations = all.filter((file) => file.root === "claude-projects");
        const tasks = all.filter((file) => file.root === "claude-tasks" && TASK_IDS.some((id) => file.path.endsWith(`${id}.output`)));
        if (process.env.BOARD_CAPTURE_DEBUG === "1") {
          console.log(`[${label}] ${conversations.length} conversations, ${tasks.length}/${expectTasks} seeded processes: ${tasks.map((task) => `${task.activity}/${task.parent ?? "no-parent"}`).join(" ")}`);
        }
        if (conversations.length < 2 || tasks.length !== expectTasks) return null;
        return tasks.every((task) => task.activity === "live") ? { conversations, tasks } : null;
      },
      `${label}: the seeded home to be scanned with ${expectTasks} live background processes`,
    );
    const project = scan.conversations[0]!.project;
    must(Boolean(project), `${label}: the scan produced no project key`);
    /* A reading is worth something only if the Viewer saw exactly the thing the
       issue is about: live, parentless, and on THIS board's project. */
    must(scan.tasks.every((task) => task.parent === null), `${label}: a background process was bound to a parent conversation`);
    must(scan.tasks.every((task) => task.project === project), `${label}: a background process landed in another project than the board's`);

    const page = await openBoard(browser, baseUrl, project);
    const origin = await page.evaluate(readOrigin);
    await page.screenshot({ path: path.join(OUT_DIR, `1758-${label}.png`) });
    const extra = after ? await after(page) : null;
    await page.context().close();
    return { origin, extra, project, tasks: scan.tasks };
  } finally {
    await stopServer(server);
  }
}

async function main(): Promise<void> {
  seedHome();
  const port = 41_000 + (process.pid % 2_000);
  let browser: Browser | null = null;
  let holders: ChildProcess[] = [];
  try {
    const executablePath = process.env.CHROME_BIN
      ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

    /* 1. The board with nothing but its own conversations. */
    const cleanCase = await measure(browser, "clean", port, 0);
    const clean = cleanCase.origin;
    must(clean.backgroundStripsAbove === 0, "the clean board already drew a background-task strip");

    /* 2 and 3. The same home with two live parentless background processes,
       and the red path in the same page. */
    holders = startBackgroundTasks();
    const liveCase = await measure(browser, "live", port + 1, TASK_IDS.length, async (page) => {
      await page.evaluate(injectDock, TASK_IDS);
      await page.waitForTimeout(250);
      const reading = await page.evaluate(readOrigin);
      await page.screenshot({ path: path.join(OUT_DIR, "1758-docked.png") });
      return reading;
    });
    const withTasks = liveCase.origin;
    const docked = liveCase.extra!;
    const live = liveCase.tasks;
    /* Both generations must have read the same project, or the two readings are
       of two different boards. */
    must(cleanCase.project === liveCase.project, "the two generations resolved different projects for the same home");

    /* The elements above the board, compared by what they occupy rather than by
       what they say: the sidebar legitimately gains a row per background process
       — that is where a parentless one stays reachable — and its own text is
       therefore expected to differ. Its BOX may not, and neither may anything
       else above the board. */
    const boxesAbove = (reading: OriginReading) => JSON.stringify(reading.above.map((item) => ({
      tag: item.tag, className: item.className, top: item.top, height: item.height, width: item.width,
    })));
    const verdicts = {
      noStripAboveTheHeader: withTasks.backgroundStripsAbove === 0,
      sameBoardOrigin: withTasks.boardTop === clean.boardTop,
      sameBoxesAboveTheBoard: boxesAbove(withTasks) === boxesAbove(clean),
      /* Nothing was lost with the dock: the page still names both processes. */
      stillReachableOnThePage: withTasks.namedSomewhereOnThePage && !clean.namedSomewhereOnThePage,
      /* The red path: the removed dock, put back, must move the board and be
         seen by the same probe that called the board unmoved above. */
      probeSeesADock: docked.backgroundStripsAbove >= 1 && docked.boardTop > withTasks.boardTop,
    };

    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(
      path.join(EVIDENCE, "board-origin.json"),
      JSON.stringify({
        issue: 1758,
        viewport: VIEWPORT,
        parentlessBackgroundTasks: TASK_IDS.length,
        scanned: {
          conversations: 2,
          backgroundTasks: live.map((task) => ({
            title: task.title,
            activity: task.activity,
            parent: task.parent,
            sameProjectAsTheBoard: task.project === liveCase.project,
          })),
        },
        cases: { clean, live: withTasks, docked },
        verdicts,
      }, null, 2) + "\n",
      "utf8",
    );

    for (const [name, held] of Object.entries(verdicts)) {
      console.log(`${held ? "ok  " : "FAIL"} ${name}`);
    }
    must(Object.values(verdicts).every(Boolean), "the rendered acceptance did not hold");
    console.log(`board top ${clean.boardTop} clean, ${withTasks.boardTop} with two live parentless processes, ${docked.boardTop} with the dock put back`);
  } finally {
    stopBackgroundTasks(holders);
    await browser?.close();
  }
}

await main();
