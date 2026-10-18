/* #2761: the browser half of the candidate gate.

   The board's HTTP answers can be fast while the page an operator opens is
   not: every view issues two dozen requests over six connections, and a slow
   side request holds a connection the board's own projection waits for. The
   gate therefore opens eight real browser views over the synthetic retained
   history while two writers run, and bounds what a person waits through: the
   board drawn, each request from issue to last byte, the page's main thread
   and its answer to input. The server those views are opened on is watched
   from inside (`candidateServerLoopProbe.ts`): its event loop is bounded while
   the views open and while they operate, because a server held for most of a
   second by one route or one background tick passed every bound read in the
   page. `candidateBrowserRun.ts` drives the views; this
   module holds the bounds and the verdict, so the runner, the board driver and
   the deployment adapter judge the same numbers. */

export interface CandidateBrowserBounds {
  /** Navigation to a drawn board. */
  readyMs: number;
  /** `/api/files`, from the page issuing it to its last byte. */
  filesP95Ms: number;
  filesMaxMs: number;
  /** Any other API request the page made, measured the same way. One still
      open when the window closes counts its age so far, and one that failed
      counts the time until it did. */
  apiMaxMs: number;
  /** The page's main thread before its board drew, and while it operated. */
  bootLagMaxMs: number;
  lagP95Ms: number;
  lagMaxMs: number;
  /** A wheel turn to the next frame. */
  inputMs: number;
  /** The serving process's own event loop: while the views open, and while they operate. */
  serverBootLoopMaxMs: number;
  serverLoopP95Ms: number;
  serverLoopMaxMs: number;
}

export const CANDIDATE_BROWSER_BOUNDS: CandidateBrowserBounds = Object.freeze({
  readyMs: 10_000, filesP95Ms: 5_000, filesMaxMs: 10_000, apiMaxMs: 10_000,
  bootLagMaxMs: 1_000, lagP95Ms: 50, lagMaxMs: 500, inputMs: 500,
  serverBootLoopMaxMs: 1_000, serverLoopP95Ms: 50, serverLoopMaxMs: 500,
});

/* `serverLoopSamples`: a 10 ms timer over the shortest window the helper is run with. */
export const CANDIDATE_BROWSER_MINIMUMS = Object.freeze({ views: 8, inputsPerView: 2, writes: 50, serverLoopSamples: 300 });

/** The serving process's event loop, as its own probe measured it. */
export interface CandidateBrowserServerLoop {
  /** Samples while the views operated. */
  samples: number;
  /** The longest delay from the first navigation until the views' opening requests settled. */
  bootMaxMs: number;
  p95Ms: number;
  maxMs: number;
}

/** The page's server-sent event streams: held open by design, so neither
    their age nor their end is a request's answer. Every other `/api/` route
    is an ordinary request, bounded and required to answer without a 5xx. */
export const CANDIDATE_BROWSER_STREAM_ROUTES: ReadonlySet<string> = new Set(["/api/streams", "/api/runtime/stream", "/api/logs/stream"]);

/** One view as it was measured. */
export interface CandidateBrowserView {
  view: number;
  readyMs: number;
  cards: number;
  selection: { stillSelected: boolean; checksLost: number; staleNoticeSeen: number };
  files: { answered: number; answeredDuringWrites: number; errors: number; p95Ms: number; maxMs: number; queuedMaxMs: number };
  api: {
    requests: number;
    maxMs: number;
    slowestRoute: string | null;
    /** Ordinary requests other than `/api/files` that answered 5xx or failed. */
    errors: number;
    firstError: string | null;
    /** Ordinary requests still open when the window closed. */
    unfinished: number;
  };
  lag: { bootMaxMs: number; samples: number; p95Ms: number; maxMs: number };
  inputMs: number[];
}

/** What the gate carries about the views: the worst of each, and the counts. */
export interface CandidateBrowserMeasurements {
  views: number;
  writes: { count: number; p95Ms: number; maxMs: number; failures: number };
  readyMaxMs: number;
  filesP95Ms: number;
  filesMaxMs: number;
  filesErrors: number;
  viewsWithoutAnswerDuringWrites: number;
  apiMaxMs: number;
  apiMaxRoute: string | null;
  apiErrors: number;
  apiFirstError: string | null;
  apiUnfinished: number;
  bootLagMaxMs: number;
  lagP95Ms: number;
  lagMaxMs: number;
  inputMaxMs: number;
  inputsMin: number;
  selectionsLost: number;
  staleNotices: number;
  /** Null when the server carried no probe or the probe did not answer: a refusal. */
  server: CandidateBrowserServerLoop | null;
}

export function summarizeBrowserViews(
  views: readonly CandidateBrowserView[],
  writes: CandidateBrowserMeasurements["writes"],
  server: CandidateBrowserServerLoop | null,
): CandidateBrowserMeasurements {
  const max = (values: number[]) => Math.round(Math.max(0, ...values.map((value) => Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER)));
  const slowest = [...views].sort((left, right) => right.api.maxMs - left.api.maxMs)[0];
  return {
    views: views.length,
    writes,
    readyMaxMs: max(views.map((view) => view.readyMs)),
    filesP95Ms: max(views.map((view) => view.files.p95Ms)),
    filesMaxMs: max(views.map((view) => view.files.maxMs)),
    filesErrors: views.reduce((sum, view) => sum + view.files.errors, 0),
    viewsWithoutAnswerDuringWrites: views.filter((view) => !view.files.answeredDuringWrites).length,
    apiMaxMs: max(views.map((view) => view.api.maxMs)),
    apiMaxRoute: slowest?.api.slowestRoute ?? null,
    apiErrors: views.reduce((sum, view) => sum + view.api.errors, 0),
    apiFirstError: views.find((view) => view.api.firstError)?.api.firstError ?? null,
    apiUnfinished: views.reduce((sum, view) => sum + view.api.unfinished, 0),
    bootLagMaxMs: max(views.map((view) => view.lag.bootMaxMs)),
    lagP95Ms: max(views.map((view) => view.lag.p95Ms)),
    lagMaxMs: max(views.map((view) => view.lag.maxMs)),
    inputMaxMs: max(views.flatMap((view) => view.inputMs)),
    inputsMin: views.length ? Math.min(...views.map((view) => view.inputMs.length)) : 0,
    selectionsLost: views.filter((view) => !view.selection.stillSelected || view.selection.checksLost > 0).length,
    staleNotices: views.reduce((sum, view) => sum + view.selection.staleNoticeSeen, 0),
    server,
  };
}

/** Every bound the views breached, one sentence each, worst view first. */
export function candidateBrowserBreaches(
  measured: CandidateBrowserMeasurements,
  bounds: CandidateBrowserBounds = CANDIDATE_BROWSER_BOUNDS,
  timingWarnings?: string[],
): string[] {
  const breaches: string[] = [];
  const over = (label: string, value: number, limit: number) => {
    if (value > limit) (timingWarnings ?? breaches).push(`${label} ${value}ms exceeds ${limit}ms`);
  };
  const minimum = CANDIDATE_BROWSER_MINIMUMS;
  if (measured.views < minimum.views) breaches.push(`browser views: measured ${measured.views}, at least ${minimum.views} required`);
  if (measured.writes.count < minimum.writes) breaches.push(`browser writers: measured ${measured.writes.count} writes, at least ${minimum.writes} required`);
  if (measured.writes.failures) breaches.push(`${measured.writes.failures} browser writer write(s) failed`);
  over("browser board drawn", measured.readyMaxMs, bounds.readyMs);
  over("browser /api/files p95", measured.filesP95Ms, bounds.filesP95Ms);
  over("browser /api/files max", measured.filesMaxMs, bounds.filesMaxMs);
  if (measured.apiMaxMs > bounds.apiMaxMs) {
    (timingWarnings ?? breaches).push(`browser ${measured.apiMaxRoute ?? "API request"} ${measured.apiMaxMs}ms exceeds ${bounds.apiMaxMs}ms`);
  }
  over("browser main-thread delay before the board drew", measured.bootLagMaxMs, bounds.bootLagMaxMs);
  over("browser main-thread delay p95", measured.lagP95Ms, bounds.lagP95Ms);
  over("browser main-thread delay max", measured.lagMaxMs, bounds.lagMaxMs);
  over("browser input answer", measured.inputMaxMs, bounds.inputMs);
  if (measured.inputsMin < minimum.inputsPerView) breaches.push(`a browser view answered ${measured.inputsMin} input(s), at least ${minimum.inputsPerView} required`);
  if (measured.filesErrors) breaches.push(`${measured.filesErrors} browser /api/files request(s) failed`);
  if (measured.apiErrors) breaches.push(`${measured.apiErrors} other browser API request(s) failed, first ${measured.apiFirstError ?? "unnamed"}`);
  if (measured.viewsWithoutAnswerDuringWrites) breaches.push(`${measured.viewsWithoutAnswerDuringWrites} browser view(s) received no board answer while the writers ran`);
  if (measured.selectionsLost) breaches.push(`${measured.selectionsLost} browser view(s) lost their selected conversation`);
  if (measured.staleNotices) breaches.push(`browser views showed the missing-conversation notice ${measured.staleNotices} time(s)`);
  if (!measured.server) breaches.push("the server's event loop was not measured while the browser views ran");
  else {
    if (measured.server.samples < minimum.serverLoopSamples) {
      breaches.push(`server event loop under the browser views: measured ${measured.server.samples} samples, at least ${minimum.serverLoopSamples} required`);
    }
    over("server event-loop delay while the browser views opened", measured.server.bootMaxMs, bounds.serverBootLoopMaxMs);
    over("server event-loop delay p95 under the browser views", measured.server.p95Ms, bounds.serverLoopP95Ms);
    over("server event-loop delay max under the browser views", measured.server.maxMs, bounds.serverLoopMaxMs);
  }
  return breaches;
}
