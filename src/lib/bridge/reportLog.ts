import { operatorAsksSignature, projectReportLogAsks } from "@/lib/asks/store";
import type { ReportLogAsk } from "@/lib/asks/types";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { canonicalProject, recordedProjectRemote } from "@/lib/projects/aliases";
import { bridgeReportsEnabled } from "@/lib/projects/settings";
import { loadTasksForList } from "@/lib/tasks/store";

import { agentRegistry } from "@/lib/agent/registry";

import type { BridgeQuestion } from "./asks";
import { reportCardRefs, type ReportLogCard } from "./reportCardRefs";
import { seatIdentityResolver } from "./seatIdentity";
import { bridgeQuestionsForProject } from "./service";
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

/**
 * The project's decision requests as the needs-you panel reads them: `open`
 * lists every one still asking (each a needs-you row), `resolved` every one the
 * operator resolved and when. The rest (answered, retired, aged out) ask
 * nothing and carry no tick. Whole-project, never paged, so a tick on an
 * entry the log loaded earlier follows every change.
 */
export interface ReportLogQuestions {
  open: number[];
  resolved: Array<{ seq: number; at: string }>;
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
  /** Viewer-authored lines ("Asks you", docs/research/attention-classifier.md
      §7.4): an agent that asked the operator, with the conversation to open.
      They are no bridge report: nothing relays or posts them. They page on
      their own cursor: a page carries the newest lines past `asksBefore`,
      and the log merges them with the reports by time and by id. Absent from
      a server before them. */
  asks?: ReportLogAsk[];
  /** The cursor to pass as `asksBefore` for older ask lines, null at the start. */
  nextAsksBefore?: string | null;
  questions: ReportLogQuestions;
}

export interface ReportLogDependencies {
  /** The card ids the board shows for the project. */
  knownCards: (project: string) => ReadonlyMap<string, ReportLogCard["kind"]>;
  /** The project's ask lines past the cursor `before`, newest first, and the next cursor. */
  asks?: (inProject: (project: string) => boolean, before: string | null, limit: number) => { asks: ReportLogAsk[]; nextBefore: string | null };
  asksRevision?: () => string;
  /** The project's decision requests with where each stands. */
  questions?: (inProject: (project: string) => boolean) => BridgeQuestion[];
}

function projectQuestions(inProject: (project: string) => boolean): BridgeQuestion[] {
  const registry = agentRegistry();
  return bridgeQuestionsForProject(inProject, {
    canonicalConversationId: seatIdentityResolver((id) => registry.canonicalConversationId(id)),
  });
}

/** The page's questions, from the one projection the needs-you panel reads. */
export function reportLogQuestions(questions: readonly BridgeQuestion[]): ReportLogQuestions {
  return {
    open: questions.filter((question) => question.state === "open").map((question) => question.report.seq),
    resolved: questions.flatMap((question) => (question.state === "resolved" && question.resolved ? [{ seq: question.report.seq, at: question.resolved.at }] : [])),
  };
}

/** Ask lines one page carries at most. */
const ASK_LINES_PER_PAGE = 50;

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

const DEFAULT_DEPENDENCIES: ReportLogDependencies = {
  knownCards: boardCards,
  asks: (inProject, before, limit) => projectReportLogAsks(inProject, before, limit),
  asksRevision: operatorAsksSignature,
  questions: projectQuestions,
};

export function readProjectReportLog(
  request: { project: string; before?: number | null; asksBefore?: string | null; limit?: number; since?: string | null },
  dependencies: ReportLogDependencies = DEFAULT_DEPENDENCIES,
): ReportLogPage {
  const project = canonicalProject(request.project.trim());
  const inProject = (stored: string) => stored === project || canonicalProject(stored) === project;
  const questions = reportLogQuestions((dependencies.questions ?? projectQuestions)(inProject));
  /* A question stops asking on evidence outside the log too (its age, an
     operator message), so the revision a caller holds moves with the ticks. */
  const reportsRevision = `${bridgeReportLogSignature()}:${questions.open.join(",")}:${questions.resolved.map((entry) => entry.seq).join(",")}`;
  const asksRevision = dependencies.asksRevision?.() ?? "";
  const revision = asksRevision ? `${reportsRevision}|${asksRevision}` : reportsRevision;
  const base = {
    ok: true as const,
    project,
    bridgeReports: bridgeReportsEnabled(project),
    github: githubRepositoryOfRemote(recordedProjectRemote(project)),
    revision,
    questions,
  };
  /* The live refresh asks with the revision it holds; an unchanged log costs
     no read at all. */
  if (request.since && request.since === revision && request.before == null && request.asksBefore == null) {
    return { ...base, unchanged: true, entries: [], nextBefore: null, asks: [], nextAsksBefore: null };
  }
  const page = pageBridgeReports({
    inProject,
    before: request.before ?? null,
    limit: request.limit,
  });
  const known = page.reports.length ? dependencies.knownCards(project) : new Map<string, ReportLogCard["kind"]>();
  let asks: ReportLogAsk[] = [];
  let nextAsksBefore: string | null = null;
  try {
    const lines = dependencies.asks?.(inProject, request.asksBefore ?? null, ASK_LINES_PER_PAGE);
    asks = lines?.asks ?? [];
    nextAsksBefore = lines?.nextBefore ?? null;
  } catch {
    /* An unreadable ask record costs its lines, never the log. */
  }
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
    asks,
    nextAsksBefore,
  };
}
