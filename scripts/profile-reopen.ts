/**
 * Real-browser reopen profile for issue #1821.
 *
 *   bun scripts/profile-reopen.ts [--port 3131] [--cdp-port 9343] [--out file.md]
 *                                 [--runtime <bun>] [--repeat 3] [--keep]
 *
 * Answers one question with real milliseconds: when the operator reopens a
 * conversation that was on screen a moment ago, where does the wait go?
 *
 * It serves the repository's own PRODUCTION build (`next start`, never `next
 * dev`, so no compile step is measured), under a throwaway home seeded with a
 * catalog-sized corpus — nine background projects of twenty conversations
 * each, plus one project holding the two measured targets: a small transcript
 * (a dozen records) and a large one (tens of thousands). Each case is driven
 * on a desktop viewport and on a 390 px phone viewport, and every case is
 * repeated so the table can carry a median rather than one sample.
 *
 * The four cases per viewport and target:
 *
 *   cold            a fresh document with empty storage — nothing cached
 *   reopen-session  switch away in-app and back — the in-memory tail cache
 *   reopen-reload   a NEW document, storage kept — what the operator calls
 *                   "restart / reopen", and the case #1821 is about
 *   revalidate      after a reopen, the first fresh tail record appended on
 *                   disk reaching the pane
 *
 * Every row attributes its time: when /api/files answered, when the first log
 * chunk arrived, and how much of the wait sat before the first painted row.
 *
 * Nothing here names a person, an account or a machine: the home, the
 * projects and every transcript are invented, and the run deletes its home.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendedLine, longLines, shortLines, transcriptText } from "@/test-helpers/switchingFixtures";

import {
  Cdp,
  DEFAULT_CHROME,
  launchChrome,
  navigate,
  outputLines,
  pageWebSocketUrl,
  parseArgs,
  ProfileTable,
  seededEnvironment,
  stop,
  waitForServer,
  type Milestone,
} from "./profileBrowser";

const repoRoot = path.resolve(import.meta.dir, "..");
const args = parseArgs();
const PORT = Number(args.get("port") ?? 3131);
const CDP_PORT = Number(args.get("cdp-port") ?? 9343);
const KEEP = args.has("keep");
const OUT = args.get("out");
const REPEAT = Math.max(1, Number(args.get("repeat") ?? 3));
/** The interpreter that serves the build; the pinned one, not the machine's. */
const RUNTIME = args.get("runtime") ?? process.execPath;
const CHROME = DEFAULT_CHROME;
/** `--dump`: print what the scanner made of the seeded home, then stop. */
const DUMP = args.has("dump");
const SERVER_LOG = args.get("server-log");
/** `--shots <dir>`: 390 px captures of the reopen moment, cold and warm. */
const SHOTS = args.get("shots");
/** `--surface desktop|phone`: one viewport only, for a quick iteration. */
const SURFACES = (args.get("surface") ?? "both") === "both" ? (["desktop", "phone"] as const) : ([args.get("surface")] as unknown as readonly Surface[]);

/* ── throwaway home ─────────────────────────────────────────────────────── */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-1821-profile-"));
const home = path.join(root, "home");
const slug = (value: string) => value.replace(/[^A-Za-z0-9]/g, "-");
const cwdFor = (project: string) => path.join(home, "Projects", project);

/** How many records the large target carries: ~3 MB of JSONL, several times
    the 768 kB live tail window, which is the shape of a real working day. */
const LARGE_RECORDS = Number(args.get("large-records") ?? 12_000);
const BACKGROUND_PROJECTS = 9;
const BACKGROUND_PER_PROJECT = 20;

interface Seeded {
  project: string;
  shape: string;
  diskPath: string;
  bytes: number;
  records: number;
}

function sessionIdFor(seed: string, index: number): string {
  const tail = (index + 1).toString(16).padStart(12, "0");
  return [seed.padEnd(8, "0").slice(0, 8), "0000", "4000", "8000", tail].join("-");
}

function write(project: string, seed: string, index: number, lines: string[], shape: string): Seeded {
  const cwd = cwdFor(project);
  fs.mkdirSync(cwd, { recursive: true });
  const dir = path.join(home, ".claude", "projects", slug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const diskPath = path.join(dir, `${sessionIdFor(seed, index)}.jsonl`);
  const text = transcriptText(lines);
  fs.writeFileSync(diskPath, text);
  return { project, shape, diskPath, bytes: new TextEncoder().encode(text).length, records: lines.length };
}

function seedHome(): { small: Seeded; large: Seeded; other: Seeded; total: number } {
  /* The measured project: the two targets plus a neighbour to switch to. */
  const small = write("gamma", "5a", 0, shortLines("gamma", cwdFor), "small");
  const large = write("gamma", "5b", 1, longLines("gamma", LARGE_RECORDS, cwdFor), "large");
  const other = write("gamma", "5c", 2, shortLines("gamma", cwdFor), "neighbour");
  let total = 3;
  for (let project = 0; project < BACKGROUND_PROJECTS; project += 1) {
    const name = `proj${(project + 1).toString().padStart(2, "0")}`;
    for (let index = 0; index < BACKGROUND_PER_PROJECT; index += 1) {
      write(name, `${(project + 1).toString(16)}${index.toString(16)}`, index, shortLines(name, cwdFor), "background");
      total += 1;
    }
  }
  /* The measured targets are the freshest, so the board puts them first. */
  const base = Date.now();
  fs.utimesSync(small.diskPath, new Date(base), new Date(base));
  fs.utimesSync(large.diskPath, new Date(base - 30_000), new Date(base - 30_000));
  fs.utimesSync(other.diskPath, new Date(base - 60_000), new Date(base - 60_000));
  return { small, large, other, total };
}

/* ── recording ──────────────────────────────────────────────────────────── */

const table = new ProfileTable();
const js = JSON.stringify;

/** One measured sample: total ms to the first painted row, and where it went. */
interface Sample {
  /** performance.now() when the target's first feed row was in the DOM. */
  paintedMs: number;
  /** When /api/files answered, relative to the same clock (null: never). */
  filesMs: number | null;
  /** When the first transcript bytes arrived (a log request's responseEnd). */
  logMs: number | null;
  /** The document's own responseEnd — how much is the HTML alone. */
  documentMs: number | null;
  /** Rows on screen at the milestone. */
  rows: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round(((sorted[middle - 1]! + sorted[middle]!) / 2) * 10) / 10;
};
const round = (value: number) => Math.round(value * 10) / 10;
const spread = (values: number[]) => `${round(Math.min(...values))}–${round(Math.max(...values))} ms over ${values.length} runs`;

function recordSamples(surface: string, step: string, samples: Sample[], notes = ""): void {
  const painted = samples.map((sample) => sample.paintedMs);
  const attribution = [
    samples.every((sample) => sample.documentMs !== null) ? `document ${median(samples.map((s) => s.documentMs!))}ms` : "",
    samples.every((sample) => sample.filesMs !== null) ? `/api/files answered ${median(samples.map((s) => s.filesMs!))}ms` : "no /api/files before the paint",
    samples.every((sample) => sample.logMs !== null) ? `first log bytes ${median(samples.map((s) => s.logMs!))}ms` : "no log request before the paint",
    `rows ${median(samples.map((s) => s.rows))}`,
  ].filter(Boolean).join("; ");
  table.record(surface, step, { ms: median(painted), frames: "" as unknown as number, seen: {} } as Milestone,
    [notes, spread(painted), attribution].filter(Boolean).join("; "));
}

/* ── in-page measurement ────────────────────────────────────────────────── */

/**
 * Wait for the target's first painted feed row, then read the attribution out
 * of the page's own resource timeline. `origin` is the clock's zero: the
 * document's navigation start for a fresh document, or the stamp taken just
 * before the gesture for an in-app step.
 */
function sampleExpression(check: string, originExpression: string, timeoutMs: number, rowsExpression: string): string {
  return `(async () => {
    const p = window.__profile;
    const origin = ${originExpression};
    await p.until(() => (${check}), ${timeoutMs});
    const painted = performance.now();
    const at = (predicate) => {
      const entry = performance.getEntriesByType('resource').filter(predicate).sort((a, b) => a.responseEnd - b.responseEnd)[0];
      return entry ? Math.round((entry.responseEnd - origin) * 10) / 10 : null;
    };
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      paintedMs: Math.round((painted - origin) * 10) / 10,
      filesMs: at((entry) => entry.name.includes('/api/files') && entry.responseEnd >= origin && entry.responseEnd <= painted),
      logMs: at((entry) => /\\/api\\/logs?(\\/|\\?|$)/.test(entry.name) && entry.responseEnd >= origin && entry.responseEnd <= painted),
      documentMs: nav && nav.responseEnd >= origin && nav.responseEnd <= painted ? Math.round((nav.responseEnd - origin) * 10) / 10 : null,
      rows: ${rowsExpression},
    };
  })()`;
}

/* ── scenarios ──────────────────────────────────────────────────────────── */

type Surface = "desktop" | "phone";

interface Target {
  entry: Seeded;
  label: string;
}

async function setViewport(cdp: Cdp, surface: Surface): Promise<void> {
  if (surface === "phone") {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
    return;
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
}

/** The check that the target's feed is painted, per surface. */
function paintedCheck(surface: Surface, target: Seeded): string {
  return surface === "phone"
    ? `p.focusedPath() === ${js(target.diskPath)} && p.focusedRows() > 0`
    : `p.rows(${js(target.diskPath)}) > 0`;
}

function rowsExpression(surface: Surface, target: Seeded): string {
  return surface === "phone" ? "p.focusedRows()" : `p.rows(${js(target.diskPath)})`;
}

const deepLink = (origin: string, entry: Seeded) => `${origin}/#f=${encodeURIComponent(entry.diskPath)}`;

/** A fresh document at the target's deep link, measured from navigation start. */
async function openFresh(cdp: Cdp, origin: string, surface: Surface, target: Seeded, timeoutMs = 120_000): Promise<Sample> {
  await navigate(cdp, "about:blank");
  await navigate(cdp, deepLink(origin, target));
  return cdp.evaluate<Sample>(sampleExpression(paintedCheck(surface, target), "0", timeoutMs, rowsExpression(surface, target)));
}

/** Empty every client store, so the next document is a true cold open. The
    app document is left first: a store cleared under a live page races the
    page's own writes, and an evaluate in flight across it dies with it. */
async function clearStorage(cdp: Cdp, origin: string): Promise<void> {
  await navigate(cdp, "about:blank");
  await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
}

/** Retry once on the one flake a driven navigation produces: an evaluate that
    was in flight when the target navigated. A second failure is a real error. */
async function retrying<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("navigated or closed")) throw error;
    console.log(`  ! ${what}: target navigated mid-evaluate, retrying once`);
    return run();
  }
}

async function runSurface(cdp: Cdp, origin: string, surface: Surface, targets: Target[], other: Seeded): Promise<void> {
  await setViewport(cdp, surface);

  for (const { entry, label } of targets) {
    const cold: Sample[] = [];
    const reload: Sample[] = [];
    const session: Sample[] = [];
    for (let run = 0; run < REPEAT; run += 1) {
      await clearStorage(cdp, origin);
      cold.push(await retrying("cold open", () => openFresh(cdp, origin, surface, entry)));
      /* Same browser profile, same storage, a brand new document: the reopen
         the operator performs with a reload, a respawn or a resume. */
      reload.push(await retrying("reopen after reload", () => openFresh(cdp, origin, surface, entry)));

      /* In-app: away to the neighbour conversation and back, no navigation. */
      await retrying("in-app step away", async () => {
        await cdp.evaluate(`location.hash = ${js(`#f=${encodeURIComponent(other.diskPath)}`)}`);
        await cdp.evaluate(sampleExpression(paintedCheck(surface, other), "0", 60_000, rowsExpression(surface, other)));
      });
      session.push(await retrying("reopen in session", () => cdp.evaluate<Sample>(`(async () => {
        const since = performance.now();
        location.hash = ${js(`#f=${encodeURIComponent(entry.diskPath)}`)};
        return (${sampleExpression(paintedCheck(surface, entry), "since", 60_000, rowsExpression(surface, entry))});
      })()`)));
    }
    recordSamples(surface, `cold open, ${label} (empty storage, since navigation start)`, cold);
    recordSamples(surface, `reopen after reload, ${label} (new document, storage kept)`, reload);
    recordSamples(surface, `reopen in the same session, ${label} (in-app, since the gesture)`, session);
  }

  /* Revalidation: a fresh record on disk must still reach the pane after a
     reopen painted from cache, and it must land as one appended row. */
  const target = targets[0]!.entry;
  await openFresh(cdp, origin, surface, target);
  const before = await cdp.evaluate<number>(`window.__profile.${surface === "phone" ? "focusedRows()" : `rows(${js(target.diskPath)})`}`);
  await cdp.evaluate(`(window.__firstRow = window.__profile.firstRow(${js(target.diskPath)})) !== undefined`);
  const appendedAt = Date.now();
  fs.appendFileSync(target.diskPath, appendedLine("gamma", 9_100, surface, cwdFor) + "\n");
  const fresh = await cdp.evaluate<{ rows: number }>(`(async () => {
    const p = window.__profile;
    await p.until(() => (${surface === "phone" ? "p.focusedRows()" : `p.rows(${js(target.diskPath)})`}) > ${before}, 40000);
    return { rows: ${surface === "phone" ? "p.focusedRows()" : `p.rows(${js(target.diskPath)})`} };
  })()`);
  const preserved = await cdp.evaluate<boolean>(`window.__profile.firstRow(${js(target.diskPath)}) === window.__firstRow`);
  table.record(surface, "revalidate after a reopen: fresh record on disk → appended row",
    { ms: Date.now() - appendedAt, frames: "" as unknown as number, seen: {} } as Milestone,
    `rows ${before} → ${fresh.rows}; first row node preserved ${preserved ? "yes" : "no"}`);
}

/* ── captures ───────────────────────────────────────────────────────────── */

/**
 * The reopen moment itself, at a phone viewport: the frame in which the
 * conversation pane is on screen for a brand-new document. Cold (an empty
 * store, which is what every reopen used to be) and warm (a store holding the
 * tail this conversation had a moment ago) are captured at the SAME milestone,
 * so the pair shows what the operator actually waits for. A settled frame
 * follows each, which is where a flash or a jump after revalidation would
 * show.
 */
async function captureReopenMoment(cdp: Cdp, origin: string, target: Seeded, dir: string, label: string, cold: boolean): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  if (cold) await clearStorage(cdp, origin);
  else await navigate(cdp, "about:blank");
  const shoot = async (name: string): Promise<void> => {
    const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(dir, name), Buffer.from(shot.data, "base64"));
    console.log(`  shot ${name}`);
  };
  await navigate(cdp, deepLink(origin, target));
  /* The pane is on screen: whatever it holds at this instant is the reopen. */
  await cdp.evaluate(`(() => { const p = window.__profile; return p.until(() => !!document.querySelector('[data-testid="mobile-focused-pane"]'), 60000); })()`);
  await shoot(`${label}-reopen-moment.png`);
  await cdp.evaluate(`(() => { const p = window.__profile; return p.until(() => ${rowsExpression("phone", target)} > 0, 60000); })()`);
  await Bun.sleep(1_200);
  await shoot(`${label}-settled.png`);
}

/* ── server-side attribution ────────────────────────────────────────────── */

async function serverTimings(origin: string, small: Seeded, large: Seeded): Promise<string[]> {
  const notes: string[] = [];
  const time = async (label: string, run: () => Promise<number>): Promise<void> => {
    const samples: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) samples.push(await run());
    notes.push(`${label}: median ${median(samples)} ms (${spread(samples)})`);
  };
  await time("GET /api/files?view=summary", async () => {
    const started = performance.now();
    await (await fetch(`${origin}/api/files?view=summary`)).text();
    return round(performance.now() - started);
  });
  for (const [label, entry] of [["small", small], ["large", large]] as const) {
    await time(`POST /api/logs, ${label} transcript (${Math.round(entry.bytes / 1024)} kB on disk)`, async () => {
      const started = performance.now();
      const response = await fetch(`${origin}/api/logs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reqs: [{ id: "0", path: entry.diskPath, offset: 0 }] }),
      });
      const body = await response.text();
      const ms = round(performance.now() - started);
      if (!body.includes('"size"')) throw new Error(`unexpected /api/logs answer: ${body.slice(0, 200)}`);
      return ms;
    });
  }
  return notes;
}

/* ── main ───────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const { small, large, other, total } = seedHome();
  const env = seededEnvironment(root, { nodeEnv: "production" });
  const origin = `http://127.0.0.1:${PORT}`;
  if (!fs.existsSync(path.join(repoRoot, ".next", "BUILD_ID"))) {
    throw new Error("no production build found: run `bun run build` first — this profile never measures `next dev`");
  }
  const server = spawn(
    RUNTIME,
    ["--bun", path.join(repoRoot, "node_modules/.bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(PORT)],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const serverLogs = outputLines(server);
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    console.log(`production server starting on ${origin} under ${root} (${total} seeded transcripts, large target ${Math.round(large.bytes / 1024)} kB)`);
    await waitForServer(`${origin}/api/files`, server, serverLogs);
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const body = (await (await fetch(`${origin}/api/files?view=summary`)).json()) as { files: Array<{ path: string }> };
      const listed = new Set(body.files.map((file) => file.path));
      if ([small, large, other].every((entry) => listed.has(entry.diskPath))) {
        console.log(`scanner lists ${body.files.length} transcripts`);
        break;
      }
      if (attempt === 89) throw new Error(`scanner never listed the targets\n${serverLogs()}`);
      await Bun.sleep(1_000);
    }
    if (DUMP) {
      const body = (await (await fetch(`${origin}/api/files?view=summary`)).json()) as { files: Array<Record<string, unknown>> };
      for (const file of body.files.slice(0, 8)) console.log(JSON.stringify(Object.fromEntries(["path", "project", "title", "size", "activity"].map((key) => [key, file[key]]))).replaceAll(root, "<root>"));
      return;
    }

    const server_notes = await serverTimings(origin, small, large);
    for (const note of server_notes) console.log(`  server | ${note}`);

    chrome = launchChrome({ cdpPort: CDP_PORT, userDataDir: path.join(root, "chrome"), home: root, chrome: CHROME });
    cdp = await Cdp.connect(await pageWebSocketUrl(CDP_PORT));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    /* One warm-up document: the first request of a production server still
       loads its route modules, and that belongs to no case under measurement. */
    await navigate(cdp, deepLink(origin, small));
    await Bun.sleep(3_000);

    const targets: Target[] = [
      { entry: small, label: `small transcript (${small.records} records, ${Math.round(small.bytes / 1024)} kB)` },
      { entry: large, label: `large transcript (${large.records} records, ${Math.round(large.bytes / 1024)} kB)` },
    ];
    for (const surface of SURFACES) {
      console.log(surface === "phone" ? "phone 390×844" : "desktop 1280×800");
      await runSurface(cdp, origin, surface, targets, other);
    }

    if (SHOTS) {
      console.log(`390 px captures → ${SHOTS}`);
      await setViewport(cdp, "phone");
      await captureReopenMoment(cdp, origin, large, SHOTS, "cold-empty-store", true);
      /* The warm case needs the store filled by a previous document first. */
      await openFresh(cdp, origin, "phone", large);
      await Bun.sleep(2_500);
      await captureReopenMoment(cdp, origin, large, SHOTS, "warm-cached-tail", false);
    }

    const markdown = [
      table.markdown("#1821 reopen profile (real browser: headless Chrome, production build, throwaway home)", "median ms to the first painted feed row"),
      "",
      "Server-side, measured against the same production server:",
      ...server_notes.map((note) => `- ${note}`),
      "",
    ].join("\n");
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
