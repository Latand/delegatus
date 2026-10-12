/* #2761: eight real browser views of the board over retained registry history,
   while two writers run. One implementation with two callers: the candidate
   gate runs it inside a container from the candidate image against that
   image's own production build, and the board driver's `registry-history`
   case (scripts/capture-board-geometry.ts) runs it against a local build for
   rendered evidence. `candidateBrowser.ts` holds the bounds and the verdict.

   A request's time runs from the page issuing it to its last byte, so a wait
   for a free browser connection counts: the operator waits through it too.
   A request that failed counts the time until it did, and one still open
   when the window closes counts its age so far; only the declared event
   streams (`CANDIDATE_BROWSER_STREAM_ROUTES`) stay open by design.
   Main-thread delay is bounded apart for the boot (navigation to a drawn
   board) and for operation after it. */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { CandidateBrowserMeasurements, CandidateBrowserView } from "./candidateBrowser";
import { CANDIDATE_BROWSER_STREAM_ROUTES, summarizeBrowserViews } from "./candidateBrowser";

export const CANDIDATE_BROWSER_VIEWS = 8;
export const CANDIDATE_BROWSER_WINDOW_MS = 30_000;

/** Where a browser can be found: an explicit path, else the image's own Chromium. */
export function candidateBrowserExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.LLV_CANDIDATE_BROWSER_BIN?.trim() || env.CHROME_BIN?.trim();
  if (explicit) return explicit;
  for (const candidate of ["/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export interface BrowserViewPin { path: string; conversationId: string; title: string }

/** The pin each view opens: a different transcribed conversation per view. */
export function browserViewPins(conversations: ReadonlyArray<{ path: string; conversationId: string }>, views = CANDIDATE_BROWSER_VIEWS): BrowserViewPin[] {
  return Array.from({ length: views }, (_, index) => {
    const selected = conversations[(index * 7 + 3) % conversations.length]!;
    /* The page names the conversation it opened by its title. */
    return { path: selected.path, conversationId: selected.conversationId, title: `Synthetic conversation ${Number(/(\d+)\.jsonl$/.exec(selected.path)?.[1] ?? -1)}` };
  });
}

export interface BrowserWriters {
  /** The runtime and the runner file that has the `--writer` mode. */
  runtime: string;
  entry: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  registry: string;
  keys: ReadonlyArray<{ key: string; servers: string[] }>;
  stopFile: string;
}

/** One ordinary API request: answered with `status`, or failed with `error` and status 0. */
interface Request { route: string; files: boolean; status: number; ms: number; queuedMs: number; firstByteMs: number; at: number; error?: string }

/** What the board driver keeps beside each view's reading. */
export interface BrowserViewDiagnostics {
  view: number;
  hash: string;
  slowest: Request[];
  opening: Request[];
  unfinished: Array<{ route: string; at: number; ageMs: number }>;
  failures: Array<{ route: string; error: string }>;
  /** The document's own timing from navigation: what the page waited for before any API request. */
  document: { responseStartMs: number; responseEndMs: number; domContentLoadedMs: number; loadMs: number } | null;
  /** The page's scripts and styles: how many, when the last one arrived, and the slowest. */
  assets: {
    count: number; bytes: number; lastEndMs: number;
    /** From the request's start: sent once a connection was free, first byte, last byte. */
    slowest: Array<{ name: string; startMs: number; ms: number; sentMs: number; firstByteMs: number; endMs: number }>;
  };
}

export interface BrowserRunResult {
  views: CandidateBrowserView[];
  diagnostics: BrowserViewDiagnostics[];
  measurements: CandidateBrowserMeasurements;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!) : 0;
}

function startWriters(writers: BrowserWriters, owner: number): { stop(): Promise<{ latencies: number[]; failures: number }> } {
  const children: ChildProcess[] = [];
  const results = [0, 1].map((half) => {
    const writer = spawn(writers.runtime, [writers.entry, "--writer", "--owner", String(owner),
      "--registry", writers.registry,
      "--keys", JSON.stringify(writers.keys.filter((_, index) => index % 2 === half)),
      "--stop", writers.stopFile], { cwd: writers.cwd, env: writers.env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(writer);
    return new Promise<{ latencies: number[]; failures: number }>((resolve) => {
      let output = "";
      let errors = "";
      writer.stdout?.on("data", (chunk) => { output += String(chunk); });
      writer.stderr?.on("data", (chunk) => { errors = `${errors}${String(chunk)}`.slice(-2_000); });
      writer.once("exit", (code) => {
        try {
          const report = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as { latencies?: number[]; failures?: number; busy?: number };
          resolve({ latencies: report.latencies ?? [], failures: (report.failures ?? 0) + (report.busy ?? 0) });
        } catch {
          /* A writer that could not even report is a failed writer, never zero failures. */
          if (errors) console.error(`[candidate browser] writer ${half} exited ${code}: ${errors.split("\n").filter(Boolean).slice(-3).join(" | ")}`);
          resolve({ latencies: [], failures: 1 });
        }
      });
    });
  });
  return {
    async stop() {
      fs.writeFileSync(writers.stopFile, "1");
      const timer = setTimeout(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); }, 15_000);
      const settled = await Promise.all(results);
      clearTimeout(timer);
      return { latencies: settled.flatMap((result) => result.latencies), failures: settled.reduce((sum, result) => sum + result.failures, 0) };
    },
  };
}

/**
 * Open {@link CANDIDATE_BROWSER_VIEWS} views of the board at `baseUrl`, each
 * pinning its own conversation, start the two writers once every view has
 * drawn, and watch each view hold its selection and answer input for the
 * window. The server must already be up and have built its first board.
 */
export async function measureBoardInBrowser(options: {
  baseUrl: string;
  executablePath: string | null;
  pins: readonly BrowserViewPin[];
  writers: BrowserWriters;
  windowMs?: number;
  screenshotDir?: string;
}): Promise<BrowserRunResult> {
  const { chromium } = await import("playwright-core");
  const windowMs = options.windowMs ?? CANDIDATE_BROWSER_WINDOW_MS;
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
  });
  let writers: ReturnType<typeof startWriters> | null = null;
  try {
    const views = await Promise.all(options.pins.map(async (pin, index) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      /* An operator's browser streams, so EventSource stays as it is. */
      await context.addInitScript(() => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem("llv_lang", "en");
        localStorage.setItem("llvSound", "0");
        localStorage.setItem("llvSchemeMode", "select");
      });
      /* The page's own clock from the first script: a 50 ms timer that runs
         late by however long the main thread was busy, each sample stamped. */
      await context.addInitScript(() => {
        const probe = { lags: [] as Array<[number, number]> };
        (window as unknown as { __historyProbe: typeof probe }).__historyProbe = probe;
        let expected = performance.now() + 50;
        const tick = () => { const now = performance.now(); probe.lags.push([now, Math.max(0, now - expected)]); expected = now + 50; setTimeout(tick, 50); };
        setTimeout(tick, 50);
      });
      const page = await context.newPage();
      const requests: Request[] = [];
      const failed: { route: string; error: string }[] = [];
      let navigatedAt = 0;
      /* Ordinary requests the page started and has not finished: what can
         hold a connection, and what an operator is still waiting for. */
      const open = new Map<object, { route: string; at: number; startedAt: number }>();
      const ordinary = (url: URL) => url.pathname.startsWith("/api/") && !CANDIDATE_BROWSER_STREAM_ROUTES.has(url.pathname);
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (ordinary(url)) open.set(request, { route: url.pathname, at: Date.now() - navigatedAt, startedAt: Date.now() });
      });
      page.on("requestfinished", async (request) => {
        open.delete(request);
        const url = new URL(request.url());
        if (!ordinary(url)) return;
        const timing = request.timing();
        const response = await request.response().catch(() => null);
        requests.push({
          route: url.pathname,
          files: url.pathname === "/api/files",
          status: response?.status() ?? 0,
          ms: Math.round(Math.max(0, timing.responseEnd)),
          queuedMs: Math.round(Math.max(0, timing.requestStart)),
          firstByteMs: Math.round(Math.max(0, timing.responseStart)),
          at: Math.round(timing.startTime - navigatedAt),
        });
      });
      page.on("requestfailed", (request) => {
        const started = open.get(request);
        open.delete(request);
        const url = new URL(request.url());
        if (!ordinary(url)) return;
        const error = request.failure()?.errorText ?? "failed";
        failed.push({ route: url.pathname, error });
        /* However it ended, the page waited this long for it. */
        const ms = started ? Date.now() - started.startedAt : 0;
        requests.push({ route: url.pathname, files: url.pathname === "/api/files", status: 0, ms, queuedMs: 0, firstByteMs: 0, at: started?.at ?? 0, error });
      });
      navigatedAt = Date.now();
      const started = performance.now();
      await page.goto(`${options.baseUrl}/#f=${encodeURIComponent(pin.path)}`, { waitUntil: "domcontentloaded" });
      const drawn = await page.waitForSelector("[data-kanban-board]", { timeout: 60_000 }).then(() => true, () => false);
      const readyMs = drawn ? Math.round(performance.now() - started) : Number.POSITIVE_INFINITY;
      const drawnAt = await page.evaluate(() => performance.now());
      return { index, context, page, pin, requests, failed, open, readyMs, drawnAt, staleSeen: 0, lostSeen: 0, inputs: [] as number[] };
    }));
    writers = startWriters(options.writers, process.pid);
    const input = async (view: (typeof views)[number]) => {
      const inputStarted = performance.now();
      await view.page.mouse.wheel(0, 240);
      await view.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
      view.inputs.push(Math.round(performance.now() - inputStarted));
    };
    /* The page opens the pin and then names it canonically, `#c=<id>`. */
    const holdsSelection = async (view: (typeof views)[number]) => {
      const hash = await view.page.evaluate(() => decodeURIComponent(location.hash));
      const named = hash.includes(`c=${view.pin.conversationId}`) || hash.includes(`f=${view.pin.path}`);
      return named && await view.page.getByText(view.pin.title, { exact: true }).count() > 0;
    };
    /* While the writers run: each view keeps its selection, never falls back
       to the missing-conversation notice, and answers an input. */
    for (const until = performance.now() + windowMs; performance.now() < until;) {
      await Promise.all(views.map(async (view) => {
        if (await view.page.locator("[data-stale-focus-notice]").count()) view.staleSeen += 1;
        if (!await holdsSelection(view)) view.lostSeen += 1;
      }));
      if (views[0]!.inputs.length < 2 && performance.now() > until - windowMs * (views[0]!.inputs.length ? 0.33 : 0.66)) {
        await Promise.all(views.map(input));
      }
      await Bun.sleep(2_000);
    }
    const written = await writers.stop();
    writers = null;
    const readings: CandidateBrowserView[] = [];
    const diagnostics: BrowserViewDiagnostics[] = [];
    for (const view of views) {
      const lags = await view.page.evaluate(() => (window as unknown as { __historyProbe: { lags: Array<[number, number]> } }).__historyProbe.lags);
      const bootLags = lags.filter(([at]) => at <= view.drawnAt).map(([, lag]) => lag);
      const operatingLags = lags.filter(([at]) => at > view.drawnAt).map(([, lag]) => lag);
      const hash = await view.page.evaluate(() => decodeURIComponent(location.hash));
      const documentTiming = await view.page.evaluate(() => {
        const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        return entry ? {
          responseStartMs: Math.round(entry.responseStart), responseEndMs: Math.round(entry.responseEnd),
          domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd), loadMs: Math.round(entry.loadEventEnd),
        } : null;
      });
      const assets = await view.page.evaluate(() => {
        const entries = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
          .filter((entry) => entry.name.includes("/_next/static/"));
        return {
          count: entries.length,
          bytes: entries.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
          lastEndMs: Math.round(Math.max(0, ...entries.map((entry) => entry.responseEnd))),
          slowest: [...entries].sort((left, right) => right.duration - left.duration).slice(0, 4)
            .map((entry) => ({
              name: new URL(entry.name).pathname.split("/").at(-1) ?? "", startMs: Math.round(entry.startTime), ms: Math.round(entry.duration),
              sentMs: Math.round(entry.requestStart - entry.startTime), firstByteMs: Math.round(entry.responseStart - entry.startTime),
              endMs: Math.round(entry.responseEnd - entry.startTime),
            })),
        };
      });
      const stillSelected = await holdsSelection(view);
      if (await view.page.locator("[data-stale-focus-notice]").count()) view.staleSeen += 1;
      const answered = view.requests.filter((request) => request.files && request.status >= 200 && request.status < 400);
      /* Still open as the window closes: its age so far is its time. */
      const closedAt = Date.now();
      const unfinished = [...view.open.values()].map((request) => ({ route: request.route, at: request.at, ageMs: closedAt - request.startedAt }));
      const timed = [...view.requests.map((request) => ({ route: request.route, ms: request.ms })),
        ...unfinished.map((request) => ({ route: `${request.route} (unanswered)`, ms: request.ageMs }))];
      const slowestTimed = [...timed].sort((a, b) => b.ms - a.ms)[0];
      const slowest = [...view.requests].sort((a, b) => b.ms - a.ms);
      /* A poll the page itself abandons for a newer one is the client's
         choice, and its time above is still counted; a 5xx or any other
         failure is an error. */
      const failedRequest = (request: Request) => request.status >= 500 || (request.status === 0 && request.error !== "net::ERR_ABORTED");
      const errors = view.requests.filter((request) => request.files && failedRequest(request)).length;
      const otherErrors = view.requests.filter((request) => !request.files && failedRequest(request));
      readings.push({
        view: view.index,
        readyMs: view.readyMs,
        cards: await view.page.locator("[data-kanban-card]").count(),
        selection: { stillSelected, checksLost: view.lostSeen, staleNoticeSeen: view.staleSeen },
        files: {
          answered: answered.length,
          answeredDuringWrites: answered.filter((request) => request.at > view.drawnAt).length,
          errors,
          p95Ms: percentile(answered.map((request) => request.ms), 0.95),
          maxMs: Math.max(0, ...answered.map((request) => request.ms)),
          queuedMaxMs: Math.max(0, ...view.requests.filter((request) => request.files).map((request) => request.queuedMs)),
        },
        api: {
          requests: view.requests.length + unfinished.length,
          maxMs: Math.round(Math.max(0, ...timed.map((request) => request.ms))),
          slowestRoute: slowestTimed?.route ?? null,
          errors: otherErrors.length,
          firstError: otherErrors[0] ? `${otherErrors[0].route} ${otherErrors[0].status ? `HTTP ${otherErrors[0].status}` : otherErrors[0].error}` : null,
          unfinished: unfinished.length,
        },
        lag: {
          bootMaxMs: Math.round(Math.max(0, ...bootLags)),
          samples: operatingLags.length, p95Ms: percentile(operatingLags, 0.95), maxMs: Math.round(Math.max(0, ...operatingLags)),
        },
        inputMs: view.inputs,
      });
      diagnostics.push({
        view: view.index,
        hash: hash.replace(view.pin.conversationId, "<selected>").replace(view.pin.path, "<selected>"),
        slowest: slowest.slice(0, 5),
        opening: [...view.requests].sort((a, b) => a.at - b.at).slice(0, 60),
        unfinished: [...unfinished].sort((a, b) => a.at - b.at).slice(0, 10),
        /* A failed request, and an answer the server refused, with its status. */
        failures: [
          ...view.failed.filter((failure) => failure.error !== "net::ERR_ABORTED"),
          ...view.requests.filter((request) => request.status >= 500).map((request) => ({ route: request.route, error: `HTTP ${request.status}` })),
        ].slice(0, 5),
        document: documentTiming,
        assets,
      });
      if (options.screenshotDir) await view.page.screenshot({ path: path.join(options.screenshotDir, `registry-history-view-${view.index}.png`) });
      await view.context.close();
    }
    const writes = {
      count: written.latencies.length,
      p95Ms: percentile(written.latencies, 0.95),
      maxMs: Math.round(Math.max(0, ...written.latencies)),
      failures: written.failures,
    };
    return { views: readings, diagnostics, measurements: summarizeBrowserViews(readings, writes) };
  } finally {
    if (writers) await writers.stop().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
