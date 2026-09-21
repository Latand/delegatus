/**
 * Real-browser reopen profile for issue #1821.
 *
 *   bun scripts/profile-reopen.ts [--port 3131] [--cdp-port 9343] [--out file.md]
 *                                 [--runtime <bun>] [--repeat 3] [--keep]
 *                                 [--surface desktop|phone] [--shots <dir>]
 *
 * Answers one question with real milliseconds: when the operator reopens a
 * conversation that was on screen a moment ago, where does the wait go?
 *
 * It serves the repository's own PRODUCTION build (`next start`, never `next
 * dev`, so no compile step is measured), under a throwaway home seeded with a
 * catalog-sized corpus — nine background projects of twenty conversations
 * each, plus one project holding the two measured targets: a small transcript
 * (a dozen records) and a large one (tens of thousands). Each case is driven
 * on a 1280x800 desktop viewport and a 390x844 phone viewport — both set as
 * explicit device metrics and then read back off the page, because a window
 * sized from the command line gives the page 1280x713 and a table that claims
 * otherwise describes a run nobody made. Every case is repeated so the table
 * carries a median rather than one sample.
 *
 * The four cases per viewport and target:
 *
 *   cold            a fresh document with empty storage — nothing cached
 *   reopen-session  away until the pane is gone, then back — the in-memory
 *                   tail cache. On the desktop the board keeps every pane of
 *                   the current project mounted, so "away" means another
 *                   project, and the step asserts the pane really went
 *   reopen-reload   a NEW document, storage kept — what the operator calls
 *                   "restart / reopen", and the case #1821 is about
 *   revalidate      after a reopen, the first fresh tail record appended on
 *                   disk reaching the pane
 *
 * What each row attributes, and how:
 *
 * - the milestone is a PAINTED frame showing the target's rows: rows a reader
 *   can see (laid out, not hidden anywhere up their chain, on screen) in the
 *   pane that is active for the target. The poll notices them; the two
 *   animation frames after it, in each of which they must still be there,
 *   make the answer a frame that was rendered. A milestone no frame confirms
 *   is rejected, and the run fails rather than record a timer reading.
 * - transcript bytes arrive on a server-sent event stream that never ends, so
 *   its resource entry's `responseEnd` never lands while the page is alive —
 *   which is why an earlier version of this script recorded every case,
 *   including real cold opens, as having had "no log request before the
 *   paint". The stream is instrumented where the bytes are delivered instead
 *   (see `NETWORK_PROBE` in `profileBrowser.ts`): when it opened, when the
 *   first chunk for THIS transcript landed, and how big it was.
 * - the interval from those bytes to the painted frame is the client's own
 *   parse and render, with the main-thread long-task time inside it.
 * - a case that paints before any bytes — which is the point of the change —
 *   reports that, and then how long revalidation took to reach the pane.
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
  armDocuments,
  assertViewport,
  Cdp,
  DEFAULT_CHROME,
  devToolsPort,
  launchChrome,
  navigate,
  outputLines,
  pageWebSocketUrl,
  parseArgs,
  ProfileTable,
  seededEnvironment,
  setViewport,
  stop,
  VIEWPORTS,
  waitForServer,
  type Milestone,
  type Surface,
} from "./profileBrowser";

const repoRoot = path.resolve(import.meta.dir, "..");
const args = parseArgs();
const PORT = Number(args.get("port") ?? 3131);
/** `--cdp-port 0` lets Chrome pick a free port and reads it back. */
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
/** `--json <file>`: every sample of every case, for the committed evidence. */
const JSON_OUT = args.get("json");
/** `--shots <dir>`: 390 px captures of the reopen moment, cold and warm. */
const SHOTS = args.get("shots");
/** `--surface desktop|phone`: one viewport only, for a quick iteration. */
const SURFACES: readonly Surface[] = (args.get("surface") ?? "both") === "both" ? (["desktop", "phone"] as const) : ([args.get("surface")] as unknown as readonly Surface[]);

/* ── throwaway home ─────────────────────────────────────────────────────── */

/* The seeded home holds a multi-megabyte corpus and a Chrome profile, and the
   /tmp tmpfs here runs under a per-user quota that other tooling shares — an
   exhausted quota shows up as unrelated commands failing with no output. So
   the run builds under /var/tmp unless the caller named a scratch root. */
const scratchRoot = process.env.LLV_PROFILE_TMPDIR?.trim() || (fs.existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir());
const root = fs.mkdtempSync(path.join(scratchRoot, "llv-reopen-profile-"));
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

function seedHome(): { small: Seeded; large: Seeded; other: Seeded; elsewhere: Seeded; total: number } {
  /* The measured project: the two targets plus a neighbour to switch to. */
  const small = write("gamma", "5a", 0, shortLines("gamma", cwdFor), "small");
  const large = write("gamma", "5b", 1, longLines("gamma", LARGE_RECORDS, cwdFor), "large");
  const other = write("gamma", "5c", 2, shortLines("gamma", cwdFor), "neighbour");
  let total = 3;
  /* One conversation in ANOTHER project, which is what a desktop reopen has to
     step away to: the board keeps every pane of the current project mounted,
     so a switch inside it never unmounts the target and never measures a
     reopen at all. */
  let elsewhere: Seeded | null = null;
  for (let project = 0; project < BACKGROUND_PROJECTS; project += 1) {
    const name = `proj${(project + 1).toString().padStart(2, "0")}`;
    for (let index = 0; index < BACKGROUND_PER_PROJECT; index += 1) {
      const seeded = write(name, `${(project + 1).toString(16)}${index.toString(16)}`, index, shortLines(name, cwdFor), "background");
      if (elsewhere === null) elsewhere = seeded;
      total += 1;
    }
  }
  /* The measured targets are the freshest, so the board puts them first. */
  const base = Date.now();
  fs.utimesSync(small.diskPath, new Date(base), new Date(base));
  fs.utimesSync(large.diskPath, new Date(base - 30_000), new Date(base - 30_000));
  fs.utimesSync(other.diskPath, new Date(base - 60_000), new Date(base - 60_000));
  return { small, large, other, elsewhere: elsewhere!, total };
}

/* ── recording ──────────────────────────────────────────────────────────── */

const table = new ProfileTable();
const js = JSON.stringify;

/**
 * One measured sample. Every number is real: the milestone is a frame that was
 * rendered (the DOM check plus the animation frames that carry it to the
 * compositor), and the attribution comes from the transport the Viewer
 * actually uses — a server-sent event stream whose resource entry would only
 * close when the stream does.
 */
interface Sample {
  /** ms from the clock's origin to the frame carrying the target's rows. */
  paintedMs: number;
  /** ms to those rows being in the DOM; `paintedMs` minus this is the frame. */
  detectedMs: number;
  /** Always true: a milestone no animation frame confirmed is rejected by
      the probe, so no sample exists for it. Kept in the evidence so a reader
      can see that for every sample. */
  rafConfirmed: boolean;
  /** The document's own responseEnd — how much is the HTML alone. */
  documentMs: number | null;
  /** The browser's first contentful paint, for the document cases. */
  fcpMs: number | null;
  /** When /api/files answered, and how big that answer was. */
  filesMs: number | null;
  filesKb: number | null;
  /** When the log stream for this step opened. */
  streamOpenMs: number | null;
  /** When the first stream chunk for THIS transcript arrived, before the
      paint (null when the rows were painted without waiting for any). */
  firstBytesMs: number | null;
  /** When the first chunk for this transcript arrived at all — the moment
      revalidation reached the pane, before or after the paint. */
  revalidatedMs: number | null;
  /** Size of that first delivered chunk, as it came over the stream. */
  payloadKb: number | null;
  /** Bytes in hand → rows on screen: the client's own parse and render. */
  parseRenderMs: number | null;
  /** Main-thread long-task time inside that interval. */
  blockingMs: number;
  /** Which transport delivered those bytes: the event stream, or the POST
      polling fallback the bus uses when the stream cannot connect. */
  via: "stream" | "poll" | null;
  /** Rows on screen at the milestone. */
  rows: number;
  /** Where the painted window starts in the tail stream: 0 is a first read of
      the file, a large number is a restored tail resumed in place. */
  windowStart: number | null;
  /** Conversations with a persisted tail in the store as this document's
      first script read it. A hint only, never proof: Chrome hands a new
      renderer its own snapshot of the origin's storage, and a tail the
      previous document wrote on its way out can be missing from that snapshot
      and still be restored by the app a few milliseconds later. Which path
      painted is read off the paint itself — see `paintedFromCache`. */
  storedTails: number;
  /** The store's keys at that moment, shortened; a transcript path is not
      printed in full. */
  storeKeys: string[];
  /** What the page asked for before the paint, as path@ms. */
  requests: string[];
  /** The log streams it opened before the paint. */
  streams: string[];
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round(((sorted[middle - 1]! + sorted[middle]!) / 2) * 10) / 10;
};
const round = (value: number) => Math.round(value * 10) / 10;
const spread = (values: number[]) => `${round(Math.min(...values))}–${round(Math.max(...values))} ms over ${values.length} runs`;

/** Rows on screen before a single byte of this transcript reached the page
    can only have come from a cached tail. That is the proof a sample is warm,
    and its absence the proof it is cold. */
const paintedFromCache = (sample: Sample): boolean => sample.firstBytesMs === null;

/** The median of a field that a case may legitimately never have. */
function medianOf(samples: Sample[], pick: (sample: Sample) => number | null): number | null {
  const values = samples.map(pick).filter((value): value is number => value !== null);
  return values.length === samples.length && values.length > 0 ? median(values) : null;
}

/** Every sample of every case, so the evidence file can carry the raw numbers
    and not only the medians the table shows. */
const collected: Array<{ surface: string; step: string; samples: Sample[]; notes: string }> = [];

function recordSamples(surface: string, step: string, samples: Sample[], notes = ""): void {
  collected.push({ surface, step, samples, notes });
  const painted = samples.map((sample) => sample.paintedMs);
  const files = medianOf(samples, (sample) => sample.filesMs);
  const firstBytes = medianOf(samples, (sample) => sample.firstBytesMs);
  const revalidated = medianOf(samples, (sample) => sample.revalidatedMs);
  const payload = medianOf(samples, (sample) => sample.payloadKb);
  const parseRender = medianOf(samples, (sample) => sample.parseRenderMs);
  const document_ = medianOf(samples, (sample) => sample.documentMs);
  const fcp = medianOf(samples, (sample) => sample.fcpMs);
  const stream = medianOf(samples, (sample) => sample.streamOpenMs);
  const attribution = [
    document_ === null ? "" : `document ${document_}ms`,
    fcp === null ? "" : `first contentful paint ${fcp}ms`,
    files === null ? "no /api/files before the paint" : `/api/files answered ${files}ms`,
    stream === null ? "" : `log stream opened ${stream}ms`,
    firstBytes === null
      ? `painted before any transcript bytes${revalidated === null ? "" : `; revalidated ${revalidated}ms`}`
      : `first transcript bytes ${firstBytes}ms${payload === null ? "" : ` (${payload} kB)`}`,
    samples.every((sample) => sample.via === "poll") ? "delivered by the POST polling fallback" : "",
    parseRender === null ? "" : `bytes→rows ${parseRender}ms (main thread ${median(samples.map((sample) => sample.blockingMs))}ms)`,
    `frame +${median(samples.map((sample) => round(sample.paintedMs - sample.detectedMs)))}ms`,
    `painted from the cached tail in ${samples.filter(paintedFromCache).length} of ${samples.length}`,
    `rows ${median(samples.map((sample) => sample.rows))}`,
  ].filter(Boolean).join("; ");
  table.record(surface, step, { ms: median(painted), frames: "" as unknown as number, seen: {} } as Milestone,
    [notes, spread(painted), attribution].filter(Boolean).join("; "));
}

/* ── in-page measurement ────────────────────────────────────────────────── */

/**
 * Wait for the frame that shows the target's rows, then read the attribution
 * out of the network probe and the page's own timelines. `origin` is the
 * clock's zero: the document's navigation start for a fresh document, or the
 * stamp taken just before the gesture for an in-app step.
 *
 * `revalidateMs` is how long the sample may then wait for the transcript bytes
 * that confirm the painted rows — which is the whole point of a case that
 * paints before it asks.
 */
function sampleExpression(options: {
  check: string;
  origin: string;
  timeoutMs: number;
  rows: string;
  target: string;
  revalidateMs?: number;
}): string {
  const revalidateMs = options.revalidateMs ?? 20_000;
  return `(async () => {
    const p = window.__profile;
    const origin = ${options.origin};
    const target = ${js(options.target)};
    /* When transcript bytes for THIS conversation first reached the page:
       a chunk on the event stream, or — when the stream cannot connect, since
       Chrome holds six sockets per origin and the Viewer's stream never ends —
       a completed POST /api/logs body that asked for this transcript and got
       bytes for it. See deliveryFor in profileBrowser.ts. */
    const bytesFor = () => p.deliveryFor(target, origin);
    const milestone = await p.paintedAt(() => (${options.check}), ${options.timeoutMs});
    const painted = milestone.painted;
    const rows = ${options.rows};
    const atPaint = (() => { const seen = bytesFor(); return seen && seen.at <= painted ? seen : null; })();
    let revalidated = atPaint;
    if (revalidated === null) {
      try {
        await p.until(() => bytesFor() !== null, ${revalidateMs});
        revalidated = bytesFor();
      } catch (error) { revalidated = null; }
    }
    const net = p.net(origin, painted);
    const rel = (value) => (value === null || value === undefined ? null : Math.round((value - origin) * 10) / 10);
    const kb = (chars) => Math.round(chars / 102.4) / 10;
    const files = net.requests.filter((entry) => entry.url.includes('/api/files')).sort((a, b) => a.end - b.end)[0] || null;
    const stream = net.streams.sort((a, b) => a.open - b.open)[0] || null;
    const nav = performance.getEntriesByType('navigation')[0];
    const from = atPaint ? atPaint.at : origin;
    const blocking = net.longtasks
      .filter((entry) => entry.start + entry.duration > from && entry.start < painted)
      .reduce((total, entry) => total + Math.min(entry.duration, painted - entry.start), 0);
    return {
      paintedMs: rel(painted),
      detectedMs: rel(milestone.detected),
      rafConfirmed: !!milestone.rafConfirmed,
      documentMs: nav && nav.responseEnd >= origin && nav.responseEnd <= painted ? rel(nav.responseEnd) : null,
      fcpMs: origin === 0 && net.paint['first-contentful-paint'] !== undefined ? net.paint['first-contentful-paint'] : null,
      filesMs: files ? rel(files.bodyEnd ?? files.end) : null,
      filesKb: files && files.bytes ? kb(files.bytes) : null,
      streamOpenMs: stream ? rel(stream.open) : null,
      firstBytesMs: atPaint ? rel(atPaint.at) : null,
      revalidatedMs: revalidated ? rel(revalidated.at) : null,
      payloadKb: revalidated ? kb(revalidated.bytes) : null,
      via: revalidated ? revalidated.via : null,
      parseRenderMs: atPaint ? Math.round((painted - atPaint.at) * 10) / 10 : null,
      blockingMs: Math.round(blocking * 10) / 10,
      rows: rows,
      windowStart: p.windowStart(target),
      storedTails: net.storedTails,
      storeKeys: net.storeKeys,
      streams: net.streams.map((entry) => 'stream@' + rel(entry.open) + ' first ' + rel(entry.firstChunkAt) + ' paths ' + Object.keys(entry.paths).length),
      requests: net.requests.slice().sort((a, b) => a.end - b.end).slice(-40).map((entry) => {
        const at = entry.url.indexOf('/api');
        return (at >= 0 ? entry.url.slice(at, at + 60) : entry.url.slice(0, 60)) + '@' + rel(entry.end);
      }),
    };
  })()`;
}

/* ── scenarios ──────────────────────────────────────────────────────────── */

interface Target {
  entry: Seeded;
  label: string;
}

/** The check that the target's feed is painted, per surface: rows of the
    target a reader can see, in the pane that is active for it. */
function paintedCheck(surface: Surface, target: Seeded): string {
  return `p.targetPainted(${js(target.diskPath)}, ${js(surface)})`;
}

/** The target's rows in the DOM, seen or not: what "the pane is gone" is
    asked of. */
function rowsExpression(surface: Surface, target: Seeded): string {
  return surface === "phone" ? "p.focusedRows()" : `p.rows(${js(target.diskPath)})`;
}

const deepLink = (origin: string, entry: Seeded) => `${origin}/#f=${encodeURIComponent(entry.diskPath)}`;

function sampleFor(surface: Surface, target: Seeded, origin: string, timeoutMs: number): string {
  return sampleExpression({
    check: paintedCheck(surface, target),
    origin,
    timeoutMs,
    rows: `p.visibleRows(${js(target.diskPath)}, ${js(surface)})`,
    target: target.diskPath,
  });
}

/** Leave the app document, closing the log streams it opened first: their
    sockets are what the NEXT document would otherwise queue behind. */
async function leavePage(cdp: Cdp): Promise<void> {
  try {
    await cdp.evaluate("(window.__net && window.__net.closeStreams ? window.__net.closeStreams() : 0)");
  } catch {
    /* already on about:blank, or the document went away under the call */
  }
  await navigate(cdp, "about:blank");
}

/** A fresh document at the target's deep link, measured from navigation start. */
async function openFresh(cdp: Cdp, origin: string, surface: Surface, target: Seeded, timeoutMs = 120_000): Promise<Sample> {
  await leavePage(cdp);
  await navigate(cdp, deepLink(origin, target));
  return cdp.evaluate<Sample>(sampleFor(surface, target, "0", timeoutMs));
}

/** Empty every client store, so the next document is a true cold open. The
    app document is left first: a store cleared under a live page races the
    page's own writes, and an evaluate in flight across it dies with it. */
async function clearStorage(cdp: Cdp, origin: string): Promise<void> {
  /* In the page first: the CDP clear is asynchronous with respect to the
     document, and a "cold" open that still found a persisted tail is not the
     case the row claims to measure. `coldSample` below checks which it was. */
  try {
    await cdp.evaluate("(() => { try { localStorage.clear(); sessionStorage.clear(); return 1; } catch (error) { return 0; } })()");
  } catch {
    /* already on about:blank */
  }
  await leavePage(cdp);
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

/**
 * Step away from the target far enough that coming back is a REOPEN.
 *
 * On the phone one conversation is on screen at a time, so the neighbour in
 * the same project is enough. On the desktop the board keeps every pane of the
 * current project mounted with its rows in the DOM: a switch inside the
 * project leaves the target's rows exactly where they were, and a milestone
 * that only asks for rows is then already true before the gesture — which is
 * what made the in-app desktop numbers sub-millisecond and meaningless. So the
 * desktop steps into ANOTHER project, and the step asserts the target's pane
 * is really gone before anything is timed.
 */
async function stepAway(cdp: Cdp, surface: Surface, target: Seeded, neighbour: Seeded, elsewhere: Seeded): Promise<void> {
  const away = surface === "phone" ? neighbour : elsewhere;
  await retrying("in-app step away", async () => {
    await cdp.evaluate(`location.hash = ${js(`#f=${encodeURIComponent(away.diskPath)}`)}`);
    await cdp.evaluate(sampleFor(surface, away, "0", 60_000));
  });
  const gone = await cdp.evaluate<{ rows: number; focused: string | null }>(
    `(() => { const p = window.__profile; return { rows: ${rowsExpression(surface, target)}, focused: p.focusedPath() }; })()`,
  );
  const left = surface === "phone" ? gone.focused !== target.diskPath : gone.rows === 0;
  if (!left) {
    throw new Error(`the step away left the target on screen (rows ${gone.rows}, focused ${gone.focused}): coming back would not be a reopen`);
  }
}

/**
 * A cold open that is provably cold. The page keeps a throttled write of its
 * own pending, so a store cleared while the document is still alive can be
 * rewritten in the milliseconds before it goes away — and a "cold" row that
 * actually found a tail measures the opposite of what it claims. A sample
 * whose rows were on screen before any of the transcript's bytes arrived was
 * painted from a cache, whatever the store looked like to the document's
 * first script, so it is simply taken again.
 */
async function coldSample(cdp: Cdp, origin: string, surface: Surface, entry: Seeded): Promise<Sample> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await clearStorage(cdp, origin);
    const sample = await retrying("cold open", () => openFresh(cdp, origin, surface, entry));
    if (sample.storedTails <= 0 && !paintedFromCache(sample)) return sample;
    console.log("  ! the cold document still found a persisted tail (the page rewrote it as the store was cleared); taking the sample again");
  }
  throw new Error("could not open a document with an empty store");
}

async function runSurface(cdp: Cdp, origin: string, surface: Surface, targets: Target[], other: Seeded, elsewhere: Seeded): Promise<void> {
  await setViewport(cdp, surface);
  await navigate(cdp, deepLink(origin, targets[0]!.entry));
  const viewport = await assertViewport(cdp, surface);
  console.log(`  viewport ${viewport.width}x${viewport.height} at dpr ${viewport.dpr}`);

  for (const { entry, label } of targets) {
    const cold: Sample[] = [];
    const reload: Sample[] = [];
    const session: Sample[] = [];
    for (let run = 0; run < REPEAT; run += 1) {
      cold.push(await coldSample(cdp, origin, surface, entry));
      /* Same browser profile, same storage, a brand new document: the reopen
         the operator performs with a reload, a respawn or a resume. */
      reload.push(await retrying("reopen after reload", () => openFresh(cdp, origin, surface, entry)));

      /* In-app, no navigation: away until the pane is gone, then back. */
      await stepAway(cdp, surface, entry, other, elsewhere);
      session.push(await retrying("reopen in session", () => cdp.evaluate<Sample>(`(async () => {
        const since = performance.now();
        location.hash = ${js(`#f=${encodeURIComponent(entry.diskPath)}`)};
        return (${sampleFor(surface, entry, "since", 60_000)});
      })()`)));
    }
    recordSamples(surface, `cold open, ${label} (empty storage, since navigation start)`, cold);
    recordSamples(surface, `reopen after reload, ${label} (new document, storage kept)`, reload);
    recordSamples(surface, `reopen in the same session, ${label} (in-app, since the gesture)`, session);
  }

  /* Revalidation: a fresh record on disk must still reach the pane after a
     reopen painted from cache, and it must land as one appended row. What is
     timed is that ROW: the one carrying the appended record's text, new since
     the append was armed, visible in the pane that is active for the target
     (on the phone, only while the focused conversation is the target), and
     confirmed by the same two animation frames as every reopen row. The clock
     starts at the arming stamp, taken before the record is written, so the
     number includes the whole trip from disk to the painted frame. */
  const target = targets[0]!.entry;
  const marker = `Fresh tail record ${surface}.`;
  await openFresh(cdp, origin, surface, target);
  const armed = await cdp.evaluate<{ rows: number; visibleRows: number }>(
    `window.__profile.armAppend(${js(target.diskPath)}, ${js(surface)}, ${js(marker)})`,
  );
  fs.appendFileSync(target.diskPath, appendedLine("gamma", 9_100, surface, cwdFor) + "\n");
  const appended = await cdp.evaluate<AppendedMilestone>("window.__profile.appendedAt(40000)");
  if (!appended.rafConfirmed) throw new Error("the appended row's milestone was not confirmed by a frame");
  if (appended.appendedRows !== 1) throw new Error(`the appended record landed as ${appended.appendedRows} rows, expected exactly one`);
  if (!appended.firstRowPreserved) throw new Error("the first row node was replaced while the record was appended");
  table.record(surface, "revalidate after a reopen: fresh record on disk → appended row",
    { ms: appended.paintedMs, frames: "" as unknown as number, seen: {} } as Milestone,
    `appended row painted ${appended.paintedMs}ms (in the DOM ${appended.detectedMs}ms, frame +${round(appended.paintedMs - appended.detectedMs)}ms); `
    + `rows ${armed.rows} → ${appended.rows}, visible ${armed.visibleRows} → ${appended.visibleRows}; first row node preserved yes`);
  collected.push({ surface, step: "revalidate after a reopen: fresh record on disk → appended row", samples: [appended as unknown as Sample], notes: "one appended record, timed from the arming stamp" });
}

/** What the probe reports for the appended row; see `appendedAt` in profileBrowser.ts. */
interface AppendedMilestone {
  detectedMs: number;
  paintedMs: number;
  rafConfirmed: boolean;
  rows: number;
  visibleRows: number;
  appendedRows: number;
  firstRowPreserved: boolean;
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
  else await leavePage(cdp);
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

/** The commit the measured build came from, and whether the checkout had
    changes on top of it: a number is attributable to a revision or to none. */
function revision(): { commit: string; dirty: boolean; buildId: string } {
  const git = (...argv: string[]) => Bun.spawnSync(["git", ...argv], { cwd: repoRoot }).stdout.toString().trim();
  return {
    commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain", "--untracked-files=no").length > 0,
    buildId: fs.readFileSync(path.join(repoRoot, ".next", "BUILD_ID"), "utf8").trim(),
  };
}

async function main(): Promise<void> {
  const { small, large, other, elsewhere, total } = seedHome();
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
    cdp = await Cdp.connect(await pageWebSocketUrl(CDP_PORT || await devToolsPort(path.join(root, "chrome"))));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    /* Before the first document: the stream and paint instrumentation, and a
       foregrounded page, without which no frame is a measurement. */
    await armDocuments(cdp);

    /* One warm-up document: the first request of a production server still
       loads its route modules, and that belongs to no case under measurement. */
    await navigate(cdp, deepLink(origin, small));
    await Bun.sleep(3_000);

    const targets: Target[] = [
      { entry: small, label: `small transcript (${small.records} records, ${Math.round(small.bytes / 1024)} kB)` },
      { entry: large, label: `large transcript (${large.records} records, ${Math.round(large.bytes / 1024)} kB)` },
    ];
    for (const surface of SURFACES) {
      console.log(`${surface} ${VIEWPORTS[surface].width}×${VIEWPORTS[surface].height}`);
      await runSurface(cdp, origin, surface, targets, other, elsewhere);
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
      table.markdown("#1821 reopen profile (real browser: headless Chrome, production build, throwaway home)", "median ms to the painted frame carrying the rows"),
      "",
      "Server-side, measured against the same production server:",
      ...server_notes.map((note) => `- ${note}`),
      "",
    ].join("\n");
    console.log(`\n${markdown}`);
    if (OUT) fs.writeFileSync(OUT, markdown);
    if (JSON_OUT) {
      fs.writeFileSync(JSON_OUT, `${JSON.stringify({
        revision: revision(),
        viewports: Object.fromEntries(SURFACES.map((surface) => [surface, VIEWPORTS[surface]])),
        corpus: { seededTranscripts: total, projects: BACKGROUND_PROJECTS + 1, smallRecords: small.records, largeRecords: large.records, largeKb: Math.round(large.bytes / 1024) },
        samplesPerCase: REPEAT,
        server: server_notes,
        rows: table.rows,
        cases: collected,
      }, null, 2)}\n`);
      console.log(`raw samples → ${JSON_OUT}`);
    }
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
