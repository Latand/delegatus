import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { canonicalProject, recordedProjectRemote } from "@/lib/projects/aliases";
import { bridgeReportsEnabled } from "@/lib/projects/settings";
import { loadTasksForList } from "@/lib/tasks/store";

import { reportCardRefs, type ReportLogCard } from "./reportCardRefs";
import { bridgeReportLogSignature, pageBridgeReports } from "./store";
import type { BridgeReportClass } from "./types";

export { reportCardRefs, type ReportLogCard };

/*
 * The operator's read of one project's bridge reports (#2146): the log beside
 * the orchestrator's chat. It pages the stored rows newest first and says,
 * for each body, which card ids the board knows, so the panel can link them.
 * Nothing here opens a channel or moves a cursor; the voice relay keeps its own
 * delivery.
 */

export interface ReportLogEntry {
  seq: number;
  at: string;
  class: BridgeReportClass;
  body: string;
  /** Card ids in the body that name a card on this project's board. */
  cards: ReportLogCard[];
}

export interface ReportLogPage {
  ok: true;
  project: string;
  /** The project's bridge reports setting: off, the panel says so. */
  bridgeReports: boolean;
  /** `<owner>/<repo>` a bare `#123` links to, null without a GitHub remote. */
  github: string | null;
  /** Moves whenever the log does; a caller holding it can ask for `unchanged`. */
  revision: string;
  unchanged?: true;
  entries: ReportLogEntry[];
  /** The seq to pass as `before` for the next older page, null at the start. */
  nextBefore: number | null;
}

export interface ReportLogDependencies {
  /** The card ids the board shows for the project. */
  knownCards: (project: string) => ReadonlyMap<string, ReportLogCard["kind"]>;
}

function boardCards(project: string): ReadonlyMap<string, ReportLogCard["kind"]> {
  const cards = new Map<string, ReportLogCard["kind"]>();
  for (const task of loadTasksForList()) {
    if (canonicalProject(task.project) === project) cards.set(task.id, "task");
  }
  for (const pipeline of loadPipelinesForList()) {
    if (canonicalProject(pipeline.project) === project) cards.set(pipeline.id, "pipeline");
  }
  return cards;
}

const DEFAULT_DEPENDENCIES: ReportLogDependencies = { knownCards: boardCards };

export function readProjectReportLog(
  request: { project: string; before?: number | null; limit?: number; since?: string | null },
  dependencies: ReportLogDependencies = DEFAULT_DEPENDENCIES,
): ReportLogPage {
  const project = canonicalProject(request.project.trim());
  const revision = bridgeReportLogSignature();
  const base = {
    ok: true as const,
    project,
    bridgeReports: bridgeReportsEnabled(project),
    github: githubRepositoryOfRemote(recordedProjectRemote(project)),
    revision,
  };
  /* The live refresh asks with the revision it holds; an unchanged log costs
     no read at all. */
  if (request.since && request.since === revision && request.before == null) {
    return { ...base, unchanged: true, entries: [], nextBefore: null };
  }
  const page = pageBridgeReports({
    inProject: (stored) => stored === project || canonicalProject(stored) === project,
    before: request.before ?? null,
    limit: request.limit,
  });
  const known = page.reports.length ? dependencies.knownCards(project) : new Map<string, ReportLogCard["kind"]>();
  return {
    ...base,
    entries: page.reports.map((report) => ({
      seq: report.seq,
      at: report.at,
      /* Legacy confirmation rows never reach a page. */
      class: report.class as BridgeReportClass,
      body: report.body,
      cards: reportCardRefs(report.body, known),
    })),
    nextBefore: page.nextBefore,
  };
}
