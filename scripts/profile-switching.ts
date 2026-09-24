/**
 * Real-browser switching profile for issue #1432.
 *
 *   bun scripts/profile-switching.ts [--port 3121] [--cdp-port 9333] [--out file.md] [--keep]
 *
 * Seeds a throwaway home with the same invented corpus the DOM profile uses
 * (`src/test-helpers/switchingFixtures.ts`: short, long and tool-heavy
 * conversations in two projects), boots the repository's own Next.js dev
 * server under that home, and drives a headless Chrome over raw CDP through
 * the switching scenarios on a desktop viewport and a 390px phone viewport.
 * Every step reports real milliseconds and animation frames from the gesture
 * to the milestone, measured inside the page with `performance.now()` and
 * `requestAnimationFrame`.
 *
 * Nothing here names a person, an account or a machine: the home, the
 * projects and every transcript are invented, and the run deletes its home.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { en } from "@/lib/i18n/en";
import { appendedLine, switchingCorpus, transcriptText, type SwitchingConversation } from "@/test-helpers/switchingFixtures";

import {
  Cdp,
  DEFAULT_CHROME,
  launchChrome,
  measure,
  measureEach,
  navigate,
  outputLines,
  pageWebSocketUrl,
  parseArgs,
  ProfileTable,
  seededEnvironment,
  stop,
  waitForServer,
  describeRequests,
  type Milestone,
} from "./profileBrowser";

const repoRoot = path.resolve(import.meta.dir, "..");
const args = parseArgs();
const PORT = Number(args.get("port") ?? 3121);
const CDP_PORT = Number(args.get("cdp-port") ?? 9333);
const KEEP = args.has("keep");
const OUT = args.get("out");
/** `--dump`: print what the scanner made of the seeded home, then stop. */
const DUMP = args.has("dump");
/** `--server-log <file>`: keep the dev server's own output for the run. */
const SERVER_LOG = args.get("server-log");
const CHROME = DEFAULT_CHROME;

/* ── throwaway home ─────────────────────────────────────────────────────── */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-1432-profile-"));
const home = path.join(root, "home");
const slug = (value: string) => value.replace(/[^A-Za-z0-9]/g, "-");
const cwdFor = (project: string) => path.join(home, "Projects", project);
const corpus = switchingCorpus(cwdFor);

/** Session ids in the transcript's own shape, assembled from the corpus index. */
function sessionIdFor(index: number): string {
  const tail = (index + 1).toString(16).padStart(12, "0");
  return [`c${index}`.padEnd(8, "0"), "0000", "4000", "8000", tail].join("-");
}

interface Seeded extends SwitchingConversation {
  /** Absolute transcript path as the scanner will report it. */
  diskPath: string;
}

function seedHome(): Seeded[] {
  const seeded: Seeded[] = [];
  corpus.forEach((entry, index) => {
    const cwd = cwdFor(entry.project);
    fs.mkdirSync(cwd, { recursive: true });
    const dir = path.join(home, ".claude", "projects", slug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const diskPath = path.join(dir, `${sessionIdFor(index)}.jsonl`);
    fs.writeFileSync(diskPath, transcriptText(entry.lines));
    seeded.push({ ...entry, diskPath });
  });
  /* No account is seeded: the switching paths under measurement never touch
     one, and a fake sign-in only makes the account controller spend the run
     talking to a provider that will refuse it. */
  /* Older mtimes for the older shapes so the board orders them the same way
     the DOM profile's fixtures do. */
  const base = Date.now();
  for (const entry of seeded) {
    const age = entry.shape === "short" ? 0 : entry.shape === "long" ? 60_000 : 120_000;
    fs.utimesSync(entry.diskPath, new Date(base - age), new Date(base - age));
  }
  return seeded;
}

/* ── recording ──────────────────────────────────────────────────────────── */

const table = new ProfileTable();
const record = (surface: string, step: string, milestone: Milestone, notes = ""): void => table.record(surface, step, milestone, notes);
const js = JSON.stringify;

/* ── scenarios ──────────────────────────────────────────────────────────── */

interface Scanned {
  path: string;
  conversationId?: string;
  title: string;
}

interface Catalog {
  files: Scanned[];
  /** Scanner project key per display name (a non-git directory keys as a hash). */
  keys: Record<string, string>;
}

async function scannedFiles(origin: string): Promise<Catalog> {
  const body = (await (await fetch(`${origin}/api/files`)).json()) as { files: Scanned[]; projectCatalog?: Array<{ project: string; displayName?: string }> };
  const keys: Record<string, string> = {};
  for (const entry of body.projectCatalog ?? []) keys[entry.displayName ?? entry.project] = entry.project;
  return { files: body.files, keys };
}

function findSeeded(seeded: Seeded[], project: string, shape: string): Seeded {
  const entry = seeded.find((candidate) => candidate.project === project && candidate.shape === shape);
  if (!entry) throw new Error(`corpus has no ${project}/${shape}`);
  return entry;
}

async function runDesktop(cdp: Cdp, origin: string, seeded: Seeded[], catalog: Catalog): Promise<void> {
  const short = findSeeded(seeded, "alpha", "short");
  const long = findSeeded(seeded, "alpha", "long");
  const tools = findSeeded(seeded, "alpha", "toolheavy");
  const betaA = findSeeded(seeded, "beta", "short");
  const betaB = findSeeded(seeded, "beta", "long");
  const projectUrl = (name: string) => `${origin}/#p=${encodeURIComponent(catalog.keys[name] ?? name)}`;
  /* Every «Open conversation» button is a conversation-hash anchor; the
     transcript-path form resolves through the same in-app route as `#c=`. */
  const hashOf = (entry: Seeded) => `#f=${encodeURIComponent(entry.diskPath)}`;
  const alphaPaths = [short.diskPath, long.diskPath, tools.diskPath];
  const betaPaths = [betaA.diskPath, betaB.diskPath];
  const painted = (paths: string[]) => paths.map((p) => `p.rows(${js(p)}) > 0`).join(" && ");

  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });

  /* Warm the dev server's compile once, then measure a cold mount. */
  await navigate(cdp, projectUrl("alpha"));
  await measure(cdp, "", painted(alphaPaths), 120_000);
  await navigate(cdp, "about:blank");
  await navigate(cdp, projectUrl("alpha"));
  const mount = await cdp.evaluate<{ at: Record<string, number>; requests: Array<{ at: number; ms: number; name: string }> }>(`(async () => {
    const p = window.__profile;
    const at = await p.untilEach({
      nodes: () => document.querySelectorAll('[data-scheme-node]').length >= ${alphaPaths.length},
      ${alphaPaths.map((path, index) => `rows${index}: () => p.rows(${js(path)}) > 0`).join(",\n      ")}
    }, 60000);
    const base = performance.now() - Math.max(...Object.values(at));
    return { at: Object.fromEntries(Object.entries(at).map(([key, value]) => [key, Math.round(value + base)])), requests: p.requestsSince(0) };
  })()`);
  record("desktop", "navigate → three cards painted (cold, since navigation start)", { ms: Math.max(...alphaPaths.map((_, index) => mount.at[`rows${index}`]!)), frames: "", seen: {} } as unknown as Milestone,
    `nodes at ${mount.at.nodes}ms; rows per pane ${alphaPaths.map((_, index) => mount.at[`rows${index}`]).join("/")}ms; requests ${describeRequests(mount.requests)}`);

  /* An in-app «Open conversation» link: every such button is a #c= anchor. */
  /* The click is dispatched the way a pointer does it — cancelable — and the
     browser's default (the hash navigation) is applied only when the app did
     not claim it, so the row can say which route the link took. */
  const link = (hash: string) => `const a = document.createElement("a"); a.href = ${js(hash)}; a.textContent = "open"; document.body.append(a); window.__linkInApp = !a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); a.remove(); if (!window.__linkInApp) location.hash = ${js(hash)}`;
  const inApp = () => cdp.evaluate<boolean>("window.__linkInApp === true").then((value) => (value ? "in-app yes" : "in-app no (hash navigation)"));
  const open = await measure(cdp, link(hashOf(short)), `p.ringed(${js(short.diskPath)})`, 20_000, { skeleton: "p.skeleton()" });
  record("desktop", "«Open conversation» link → target ringed", open, `${await inApp()}; skeleton ${open.seen.skeleton ? "shown" : "never"}; hash ${(await cdp.evaluate<string>("location.hash")).slice(0, 12)}…`);

  /* Project switch through the rail: first visit (cold board) and revisit. */
  const railClick = (label: string) => `Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim().startsWith(${js(label)})).click()`;
  const betaVisit = await measureEach(cdp, railClick("beta"), {
    rail: `p.rail().startsWith("beta")`,
    skeleton: `p.skeleton()`,
    nodes: `document.querySelectorAll('[data-scheme-node]').length >= ${betaPaths.length}`,
    ...Object.fromEntries(betaPaths.map((path, index) => [`rows${index}`, `p.rows(${js(path)}) > 0`])),
  });
  record("desktop", "project switch (first visit) → rail highlight", { ms: betaVisit.at.rail!, frames: "", seen: {} } as unknown as Milestone);
  record("desktop", "project switch (first visit) → cards painted (cold)", { ms: Math.max(...betaPaths.map((_, index) => betaVisit.at[`rows${index}`]!)), frames: "", seen: {} } as unknown as Milestone,
    `skeleton at ${betaVisit.at.skeleton}ms; nodes at ${betaVisit.at.nodes}ms; rows per pane ${betaPaths.map((_, index) => betaVisit.at[`rows${index}`]).join("/")}ms; requests ${describeRequests(betaVisit.requests)}`);
  const alphaRail = await measure(cdp, railClick("alpha"), `p.rail().startsWith("alpha")`);
  record("desktop", "project switch (revisit) → rail highlight", alphaRail);
  const alphaPaint = await measure(cdp, "", painted(alphaPaths), 30_000, { skeleton: "p.skeleton()" });
  record("desktop", "project switch (revisit) → cards painted from cache", alphaPaint, `skeleton ${alphaPaint.seen.skeleton ? "shown" : "never"}`);

  /* A cross-project link from alpha to beta's long conversation. */
  const cross = await measure(cdp, link(hashOf(betaB)), `p.rail().startsWith("beta")`, 20_000, { skeleton: "p.skeleton()" });
  record("desktop", "cross-project link → rail switched", cross, await inApp());
  const crossPaint = await measure(cdp, "", painted(betaPaths), 30_000, { skeleton: "p.skeleton()" });
  record("desktop", "cross-project link → beta cards painted from cache", crossPaint, `skeleton ${cross.seen.skeleton || crossPaint.seen.skeleton ? "shown" : "never"}`);
  const crossRing = await measure(cdp, "", `p.ringed(${js(betaB.diskPath)})`);
  record("desktop", "cross-project link → target ringed", crossRing);
  await measure(cdp, railClick("alpha"), painted(alphaPaths), 30_000);

  /* Keyboard: select a card, then ArrowRight to a neighbour. */
  const selectCard = (p: string) => `{ const n = document.querySelector('[data-scheme-node=${js(p)}]'); n.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 })); n.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); }`;
  await measure(cdp, selectCard(short.diskPath), `p.ringed(${js(short.diskPath)})`);
  const arrow = await measure(cdp, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))`, `!p.ringed(${js(short.diskPath)}) && (p.ringed(${js(long.diskPath)}) || p.ringed(${js(tools.diskPath)}))`);
  record("desktop", "ArrowRight → ring moves to the neighbour card", arrow);
  const clickFocus = await measure(cdp, selectCard(tools.diskPath), `p.ringed(${js(tools.diskPath)})`);
  record("desktop", "click on a card → ring moves", clickFocus);

  /* The tail moves on disk: scanner watch → stream → parse → paint. */
  const rowsBefore = await cdp.evaluate<number>(`window.__profile.rows(${js(short.diskPath)})`);
  /* Stashed on the page, never returned: CDP cannot serialise a DOM node. */
  await cdp.evaluate(`(window.__profileFirstRow = window.__profile.firstRow(${js(short.diskPath)})) !== undefined`);
  const appendedAt = Date.now();
  fs.appendFileSync(short.diskPath, appendedLine("alpha", 9_001, "desktop", cwdFor) + "\n");
  const fresh = await measure(cdp, "", `p.rows(${js(short.diskPath)}) > ${rowsBefore}`, 30_000);
  const preserved = await cdp.evaluate<boolean>(`window.__profile.firstRow(${js(short.diskPath)}) === window.__profileFirstRow`);
  record("desktop", "fresh tail record on disk → appended to the short card", { ...fresh, ms: Date.now() - appendedAt }, `first row node preserved ${preserved ? "yes" : "no"}`);

  /* A cold deep link from the URL. */
  await navigate(cdp, "about:blank");
  await navigate(cdp, `${origin}/${hashOf(betaA)}`);
  const cold = await cdp.evaluate<Milestone>(`(async () => { const p = window.__profile; const m = await p.until(() => p.rail().startsWith("beta") && p.rows(${js(betaA.diskPath)}) > 0, 60000); return { ms: Math.round(performance.now()), frames: m.frames, seen: {} }; })()`);
  record("desktop", "cold URL deep link → target project and card painted (since navigation start)", cold);
}

async function runPhone(cdp: Cdp, origin: string, seeded: Seeded[], catalog: Catalog): Promise<void> {
  const short = findSeeded(seeded, "alpha", "short");
  const long = findSeeded(seeded, "alpha", "long");
  const projectUrl = (name: string) => `${origin}/#p=${encodeURIComponent(catalog.keys[name] ?? name)}`;
  const titleOf = (entry: Seeded) => {
    const row = catalog.files.find((file) => file.path === entry.diskPath);
    if (!row) throw new Error(`scanner reported no row for ${entry.shape}`);
    return row.title;
  };
  /* The strip chip's title attribute is the cleaned title, capped at 60. */
  const chipTitle = (entry: Seeded) => `Array.from(document.querySelectorAll('button[title]')).find((b) => b.title.startsWith(${js(titleOf(entry).slice(0, 40))}))`;

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });

  await navigate(cdp, "about:blank");
  await navigate(cdp, projectUrl("alpha"));
  const mount = await cdp.evaluate<Milestone>(`(async () => { const p = window.__profile; const m = await p.until(() => p.focusedRows() > 0, 60000); return { ms: Math.round(performance.now()), frames: m.frames, seen: {} }; })()`);
  record("phone", "navigate → focused pane painted (cold, since navigation start)", mount, `focused ${await cdp.evaluate<string>("window.__profile.focusedPath()") === short.diskPath ? "short" : "other"}`);

  const tapChip = (entry: Seeded) => `${chipTitle(entry)}.click()`;
  const chipA = await measure(cdp, tapChip(short), `p.chipActive(${chipTitle(short)}.title) && p.focusedPath() === ${js(short.diskPath)}`);
  record("phone", "tap chip A (short) → chip highlighted and pane focused", chipA);
  const rowsA = await measure(cdp, "", `p.focusedPath() === ${js(short.diskPath)} && p.focusedRows() >= ${short.lines.length}`);
  record("phone", "tap chip A → A rows painted", rowsA);

  const chipB = await measure(cdp, tapChip(long), `p.focusedPath() === ${js(long.diskPath)}`);
  record("phone", "tap chip B (long, cold) → pane focused", chipB);
  const rowsB = await measure(cdp, "", `p.focusedPath() === ${js(long.diskPath)} && p.focusedRows() > 0`, 30_000);
  record("phone", "tap chip B (long, cold) → B rows painted", rowsB, `rows on screen ${await cdp.evaluate<number>("window.__profile.focusedRows()")}`);

  const back = await measure(cdp, tapChip(short), `p.focusedPath() === ${js(short.diskPath)} && p.focusedRows() > 0`);
  record("phone", "tap chip A again (cached) → A's previous rows on screen", back);

  await cdp.evaluate(`(window.__profileFirstRow = window.__profile.firstRow(${js(short.diskPath)})) !== undefined`);
  const rowsBefore = await cdp.evaluate<number>(`window.__profile.rows(${js(short.diskPath)})`);
  const appendedAt = Date.now();
  fs.appendFileSync(short.diskPath, appendedLine("alpha", 9_002, "phone", cwdFor) + "\n");
  const fresh = await measure(cdp, "", `p.rows(${js(short.diskPath)}) > ${rowsBefore}`, 30_000);
  const preserved = await cdp.evaluate<boolean>(`window.__profile.firstRow(${js(short.diskPath)}) === window.__profileFirstRow`);
  record("phone", "fresh tail record on disk → appended to A", { ...fresh, ms: Date.now() - appendedAt }, `first row node preserved ${preserved ? "yes" : "no"}`);

  /* Header swipe to the neighbour pane (synthetic touch sequence on the pane header). */
  const swipe = `{
    const header = document.querySelector('[data-testid="mobile-focused-pane"] header');
    const r = header.getBoundingClientRect();
    const touch = (x) => new Touch({ identifier: 1, target: header, clientX: x, clientY: r.top + r.height / 2 });
    header.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch(r.left + 200)], changedTouches: [touch(r.left + 200)] }));
    header.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [touch(r.left + 60)] }));
  }`;
  const before = await cdp.evaluate<string>("window.__profile.focusedPath()");
  const hop = await measure(cdp, swipe, `p.focusedPath() !== ${js(before)} && p.focusedRows() > 0`);
  record("phone", "header swipe → neighbour pane focused with cached rows", hop);

  /* Project switch through the drawer: first visit, then revisit. */
  const drawer = `document.querySelector('button[aria-label=${js(en["dash.openProjects"])}]').click()`;
  const railClick = (label: string) => `Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim().startsWith(${js(label)})).click()`;
  await cdp.evaluate(drawer);
  const toBeta = await measure(cdp, railClick("beta"), `${betaFocusedCheck(seeded)} && p.focusedRows() > 0`, 30_000, { skeleton: "p.skeleton()" });
  record("phone", "drawer project switch (first visit) → focused pane painted (cold)", toBeta, `skeleton ${toBeta.seen.skeleton ? "shown" : "never"}`);
  await cdp.evaluate(drawer);
  const backAlpha = await measure(cdp, railClick("alpha"), `${alphaFocusedCheck(seeded)} && p.focusedRows() > 0`, 30_000, { skeleton: "p.skeleton()" });
  record("phone", "drawer project switch (revisit) → focused pane painted from cache", backAlpha, `skeleton ${backAlpha.seen.skeleton ? "shown" : "never"}`);
}

function betaFocusedCheck(seeded: Seeded[]): string {
  const paths = seeded.filter((entry) => entry.project === "beta").map((entry) => entry.diskPath);
  return `[${paths.map((candidate) => js(candidate)).join(",")}].includes(p.focusedPath())`;
}
function alphaFocusedCheck(seeded: Seeded[]): string {
  const paths = seeded.filter((entry) => entry.project === "alpha").map((entry) => entry.diskPath);
  return `[${paths.map((candidate) => js(candidate)).join(",")}].includes(p.focusedPath())`;
}

/* ── main ───────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const seeded = seedHome();
  const env = seededEnvironment(root);
  const origin = `http://127.0.0.1:${PORT}`;
  const server = spawn(
    process.execPath,
    ["--bun", path.join(repoRoot, "node_modules/.bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(PORT)],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const serverLogs = outputLines(server);
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    console.log(`dev server starting on ${origin} under ${root}`);
    await waitForServer(`${origin}/api/files`, server, serverLogs);
    /* The scanner needs a moment to attribute the seeded transcripts. */
    let catalog: Catalog = { files: [], keys: {} };
    for (let attempt = 0; attempt < 60; attempt += 1) {
      catalog = await scannedFiles(origin);
      if (seeded.every((entry) => catalog.files.some((file) => file.path === entry.diskPath)) && catalog.keys.alpha && catalog.keys.beta) break;
      await Bun.sleep(1_000);
    }
    const missing = seeded.filter((entry) => !catalog.files.some((file) => file.path === entry.diskPath));
    if (missing.length) throw new Error(`scanner never listed ${missing.map((entry) => entry.shape).join(", ")}\n${serverLogs()}`);
    console.log(`scanner lists ${catalog.files.length} transcripts`);
    if (DUMP) {
      const body = (await (await fetch(`${origin}/api/files`)).json()) as { files: Array<Record<string, unknown>>; projectCatalog: unknown; projectCwds: unknown };
      const redact = (value: unknown) => JSON.stringify(value).replaceAll(root, "<root>");
      for (const file of body.files) {
        console.log(redact(Object.fromEntries(["path", "project", "cwd", "projectRoot", "activity", "kind", "root", "title", "conversationId"].map((key) => [key, file[key]]))));
      }
      console.log("catalog", redact(body.projectCatalog));
      console.log("cwds", redact(body.projectCwds));
      return;
    }

    chrome = launchChrome({ cdpPort: CDP_PORT, userDataDir: path.join(root, "chrome"), home: root, chrome: CHROME });
    cdp = await Cdp.connect(await pageWebSocketUrl(CDP_PORT));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    console.log("desktop 1280×800");
    await runDesktop(cdp, origin, seeded, catalog);
    console.log("phone 390×844");
    await runPhone(cdp, origin, seeded, catalog);

    const markdown = table.markdown("#1432 switching profile (real browser: headless Chrome, Next.js dev server, throwaway home)");
    console.log(`\n${markdown}`);
    if (OUT) fs.writeFileSync(OUT, markdown);
  } finally {
    cdp?.close();
    await stop(chrome);
    await stop(server);
    if (SERVER_LOG) fs.writeFileSync(SERVER_LOG, serverLogs().replaceAll(root, "<root>"));
    if (KEEP) console.log(`kept ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
  process.exit(1);
});
