/* #2761: the browser half of the candidate gate.

   The board's HTTP answers can be fast while the page an operator opens is
   not: every view issues two dozen requests over six connections, and a slow
   side request holds a connection the board's own projection waits for. The
   gate therefore opens eight real browser views over the synthetic retained
   history while two writers run, and bounds what a person waits through: the
   board drawn, each request from issue to last byte, the page's main thread
   and its answer to input. `candidateBrowserRun.ts` drives the views; this
   module holds the bounds and the verdict, so the runner, the board driver and
   the deployment adapter judge the same numbers. */

export interface CandidateBrowserBounds {
  /** Navigation to a drawn board. */
  readyMs: number;
  /** `/api/files`, from the page issuing it to its last byte. */
  filesP95Ms: number;
  filesMaxMs: number;
  /** Any other API request the page made, measured the same way. */
  apiMaxMs: number;
  /** The page's main thread before its board drew, and while it operated. */
  bootLagMaxMs: number;
  lagP95Ms: number;
  lagMaxMs: number;
  /** A wheel turn to the next frame. */
  inputMs: number;
}

export const CANDIDATE_BROWSER_BOUNDS: CandidateBrowserBounds = Object.freeze({
  readyMs: 10_000, filesP95Ms: 5_000, filesMaxMs: 10_000, apiMaxMs: 10_000,
  bootLagMaxMs: 1_000, lagP95Ms: 50, lagMaxMs: 500, inputMs: 500,
});

export const CANDIDATE_BROWSER_MINIMUMS = Object.freeze({ views: 8, inputsPerView: 2, writes: 50 });

/** One view as it was measured. */
export interface CandidateBrowserView {
  view: number;
  readyMs: number;
  cards: number;
  selection: { stillSelected: boolean; checksLost: number; staleNoticeSeen: number };
  files: { answered: number; answeredDuringWrites: number; errors: number; p95Ms: number; maxMs: number; queuedMaxMs: number };
  api: { requests: number; maxMs: number; slowestRoute: string | null };
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
  bootLagMaxMs: number;
  lagP95Ms: number;
  lagMaxMs: number;
  inputMaxMs: number;
  inputsMin: number;
  selectionsLost: number;
  staleNotices: number;
}

export function summarizeBrowserViews(
  views: readonly CandidateBrowserView[],
  writes: CandidateBrowserMeasurements["writes"],
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
    bootLagMaxMs: max(views.map((view) => view.lag.bootMaxMs)),
    lagP95Ms: max(views.map((view) => view.lag.p95Ms)),
    lagMaxMs: max(views.map((view) => view.lag.maxMs)),
    inputMaxMs: max(views.flatMap((view) => view.inputMs)),
    inputsMin: views.length ? Math.min(...views.map((view) => view.inputMs.length)) : 0,
    selectionsLost: views.filter((view) => !view.selection.stillSelected || view.selection.checksLost > 0).length,
    staleNotices: views.reduce((sum, view) => sum + view.selection.staleNoticeSeen, 0),
  };
}

/** Every bound the views breached, one sentence each, worst view first. */
export function candidateBrowserBreaches(
  measured: CandidateBrowserMeasurements,
  bounds: CandidateBrowserBounds = CANDIDATE_BROWSER_BOUNDS,
): string[] {
  const breaches: string[] = [];
  const over = (label: string, value: number, limit: number) => {
    if (value > limit) breaches.push(`${label} ${value}ms exceeds ${limit}ms`);
  };
  const minimum = CANDIDATE_BROWSER_MINIMUMS;
  if (measured.views < minimum.views) breaches.push(`browser views: measured ${measured.views}, at least ${minimum.views} required`);
  if (measured.writes.count < minimum.writes) breaches.push(`browser writers: measured ${measured.writes.count} writes, at least ${minimum.writes} required`);
  if (measured.writes.failures) breaches.push(`${measured.writes.failures} browser writer write(s) failed`);
  over("browser board drawn", measured.readyMaxMs, bounds.readyMs);
  over("browser /api/files p95", measured.filesP95Ms, bounds.filesP95Ms);
  over("browser /api/files max", measured.filesMaxMs, bounds.filesMaxMs);
  if (measured.apiMaxMs > bounds.apiMaxMs) {
    breaches.push(`browser ${measured.apiMaxRoute ?? "API request"} ${measured.apiMaxMs}ms exceeds ${bounds.apiMaxMs}ms`);
  }
  over("browser main-thread delay before the board drew", measured.bootLagMaxMs, bounds.bootLagMaxMs);
  over("browser main-thread delay p95", measured.lagP95Ms, bounds.lagP95Ms);
  over("browser main-thread delay max", measured.lagMaxMs, bounds.lagMaxMs);
  over("browser input answer", measured.inputMaxMs, bounds.inputMs);
  if (measured.inputsMin < minimum.inputsPerView) breaches.push(`a browser view answered ${measured.inputsMin} input(s), at least ${minimum.inputsPerView} required`);
  if (measured.filesErrors) breaches.push(`${measured.filesErrors} browser /api/files request(s) failed`);
  if (measured.viewsWithoutAnswerDuringWrites) breaches.push(`${measured.viewsWithoutAnswerDuringWrites} browser view(s) received no board answer while the writers ran`);
  if (measured.selectionsLost) breaches.push(`${measured.selectionsLost} browser view(s) lost their selected conversation`);
  if (measured.staleNotices) breaches.push(`browser views showed the missing-conversation notice ${measured.staleNotices} time(s)`);
  return breaches;
}
