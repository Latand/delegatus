import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GithubEvidenceRow } from "./evidence";

/**
 * Pull requests and issues as correlation evidence (issue #741).
 *
 * Strictly read-only, and deliberately the one evidence source the run can do
 * without: a request the operator already opened an issue for must not be
 * materialized a second time, but a `gh` that is missing, unauthenticated or
 * rate-limited is a degraded run that says so — never a reason to skip the
 * board work.
 *
 * Nothing here ever creates an issue. That is an explicit operator decision,
 * and the monitor's job stops at surfacing the candidate.
 */

const execFileAsync = promisify(execFile);

export interface GithubRunner {
  (args: string[]): Promise<string>;
}

export interface GithubEvidenceOptions {
  cwd: string;
  limit?: number;
  run?: GithubRunner;
  timeoutMs?: number;
}

/** The one `gh` seam. Shared with the seat tick's proposal source (#1245), so
    there is a single place a command, a timeout or a buffer bound is chosen. */
export function githubRunner(cwd: string, timeoutMs: number): GithubRunner {
  return async (args) => {
    const { stdout } = await execFileAsync("gh", args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  };
}

function parseRows(raw: string, kind: GithubEvidenceRow["kind"]): GithubEvidenceRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`gh returned no parsable JSON for ${kind === "pull-request" ? "pull requests" : "issues"}`);
  }
  if (!Array.isArray(parsed)) return [];
  const rows: GithubEvidenceRow[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as { number?: unknown; title?: unknown; state?: unknown; updatedAt?: unknown };
    if (typeof row.number !== "number" || !Number.isSafeInteger(row.number)) continue;
    rows.push({
      kind,
      number: row.number,
      title: typeof row.title === "string" ? row.title : "",
      state: typeof row.state === "string" ? row.state : "OPEN",
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    });
  }
  return rows;
}

/** A `github` dependency for the run: open and recently closed work, both kinds. */
export function githubEvidenceSource(options: GithubEvidenceOptions): () => Promise<GithubEvidenceRow[]> {
  const limit = String(options.limit ?? 60);
  const run = options.run ?? githubRunner(options.cwd, options.timeoutMs ?? 20_000);
  const fields = "number,title,state,updatedAt";
  return async () => {
    const [prs, issues] = await Promise.all([
      run(["pr", "list", "--state", "all", "--limit", limit, "--json", fields]),
      run(["issue", "list", "--state", "all", "--limit", limit, "--json", fields]),
    ]);
    return [...parseRows(prs, "pull-request"), ...parseRows(issues, "issue")];
  };
}

/* ------------------------------------------------------------------------- *
 * Open issues as proposal material for the seat tick's proactive slot (#1245).
 *
 * The same `gh` seam above, asked a different question: correlation evidence
 * wants everything recently touched, a proposal wants what is still open and
 * what it is labelled. Strictly read-only, and degradable — a `gh` that is
 * missing, unauthenticated or rate-limited returns nothing and the seat ranks
 * from the board alone, because a proposal slot that failed outright would be a
 * wake that said nothing.
 *
 * Nothing here ever creates an issue.
 * ------------------------------------------------------------------------- */

export interface ProposalIssue {
  number: number;
  title: string;
  labels: string[];
  updatedAt: string | null;
}

const PROPOSAL_TITLE_LIMIT = 200;

function parseProposalIssues(raw: string): ProposalIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const issues: ProposalIssue[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as { number?: unknown; title?: unknown; labels?: unknown; updatedAt?: unknown };
    if (typeof row.number !== "number" || !Number.isSafeInteger(row.number)) continue;
    issues.push({
      number: row.number,
      title: typeof row.title === "string" ? row.title.slice(0, PROPOSAL_TITLE_LIMIT) : "",
      labels: (Array.isArray(row.labels) ? row.labels : []).flatMap((label) => {
        const name = (label as { name?: unknown } | null)?.name;
        return typeof name === "string" ? [name.slice(0, 60)] : [];
      }),
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    });
  }
  return issues;
}

/* ------------------------------------------------------------------------- *
 * Open pull requests as the seat tick's unmerged-merge evidence (#1289).
 *
 * The third question asked of the same `gh` seam, and the narrowest: which pull
 * requests are still open, and what branch each one is the head of. The branch
 * is the whole point — it is what ties a pull request back to the lane that
 * produced it, so a lane that finished with its work unmerged can be named
 * rather than merely counted.
 *
 * Unlike the two questions above, this one does NOT degrade to an empty list.
 * An empty list here is a claim — every pull request those lanes opened has
 * since been merged or closed — and a `gh` that is missing, unauthenticated,
 * rate-limited, killed at the timeout, or answering with anything but a JSON
 * array of rows that can be attributed to a branch has established no such
 * thing. Collapsing the two made a failed read indistinguishable from a
 * finished merge, and the tick then reported `nothing owed` on the strength of
 * it, which is the twelve-hour silence #1289 exists to end returning by a
 * slower route. So the failure is carried out as a failure and the caller
 * decides what it costs.
 *
 * Read-only. Nothing here merges, closes, comments on or opens a pull request.
 * ------------------------------------------------------------------------- */

export interface OpenPullRequest {
  number: number;
  title: string;
  /** The branch the pull request is the head of. */
  headRefName: string;
  /** Its opening instant fences a reused head to the lane that owned it then. */
  createdAt: string;
  updatedAt: string | null;
}

/**
 * Why the question could not be answered.
 *
 * Coarse on purpose: this token travels into a published journal line, so it
 * names the class of the failure and never the command, the repository, the
 * account or `gh`'s own stderr.
 */
export type OpenPullRequestsUnavailable = "timed-out" | "command-failed" | "malformed-output";

/** Either the answer or the reason there is none — never both, and never an
    empty list standing in for the second. */
export type OpenPullRequestsResult =
  | { ok: true; pullRequests: OpenPullRequest[] }
  | { ok: false; unavailable: OpenPullRequestsUnavailable };

const PULL_REQUEST_TITLE_LIMIT = 200;

/**
 * Null means the read failed rather than answered, and there are two ways.
 *
 * Output that is not a JSON array at all is the obvious one. The other is a
 * well-formed array carrying a row that names no number or no head branch:
 * dropping that row quietly turns a nonempty answer into an empty one, and an
 * empty one here is a claim — every pull request those lanes opened has since
 * merged or closed. A single unusable row was therefore enough to buy the
 * quiet verdict this result type exists to make earnable, which is the
 * collapse the type was introduced to end taking a shorter route.
 *
 * Number, head branch and creation time make a row attributable. A reused
 * branch can point at a later lane's PR, so an absent creation time cannot
 * prove which finished lane left it open. A missing title or update time is
 * harmless because neither decides ownership.
 * Exactly the empty array stays the answer that nothing is open.
 */
function parseOpenPullRequests(raw: string): OpenPullRequest[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: OpenPullRequest[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry as { number?: unknown; title?: unknown; headRefName?: unknown; createdAt?: unknown; updatedAt?: unknown };
    if (typeof row.number !== "number" || !Number.isSafeInteger(row.number)) return null;
    /* A row with no head branch cannot be attributed to a lane, and a pull
       request nobody can name is not evidence that nothing is open. */
    if (typeof row.headRefName !== "string" || !row.headRefName) return null;
    if (typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))) return null;
    rows.push({
      number: row.number,
      title: typeof row.title === "string" ? row.title.slice(0, PULL_REQUEST_TITLE_LIMIT) : "",
      headRefName: row.headRefName,
      createdAt: row.createdAt,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    });
  }
  return rows;
}

/** A command that failed and a command that was killed at the timeout are
    different facts about the machine, and whoever reads the journal line is
    telling an outage from a misconfiguration. `execFile` reports its own
    timeout as a killed child. */
export function githubUnavailableFromError(error: unknown): OpenPullRequestsUnavailable {
  const detail = error as { killed?: unknown; code?: unknown; name?: unknown } | null | undefined;
  if (detail?.killed === true || detail?.code === "ETIMEDOUT" || detail?.name === "TimeoutError") return "timed-out";
  return "command-failed";
}

export async function openPullRequestsForRepo(options: {
  cwd: string;
  limit?: number;
  run?: GithubRunner;
  timeoutMs?: number;
}): Promise<OpenPullRequestsResult> {
  const run = options.run ?? githubRunner(options.cwd, options.timeoutMs ?? 20_000);
  let raw: string;
  try {
    raw = await run(["pr", "list", "--state", "open", "--limit", String(options.limit ?? 60), "--json", "number,title,headRefName,createdAt,updatedAt"]);
  } catch (error) {
    return { ok: false, unavailable: githubUnavailableFromError(error) };
  }
  const pullRequests = parseOpenPullRequests(raw);
  return pullRequests ? { ok: true, pullRequests } : { ok: false, unavailable: "malformed-output" };
}

export async function openIssuesForProposal(options: {
  cwd: string;
  limit?: number;
  run?: GithubRunner;
  timeoutMs?: number;
}): Promise<ProposalIssue[]> {
  const run = options.run ?? githubRunner(options.cwd, options.timeoutMs ?? 20_000);
  try {
    const raw = await run(["issue", "list", "--state", "open", "--limit", String(options.limit ?? 40), "--json", "number,title,labels,updatedAt"]);
    return parseProposalIssues(raw);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------------- *
 * Open issues ranked by the priority a project records, for the board
 * maintenance report (docs/design/board-maintenance-report.md §7).
 *
 * The fourth question asked of the same `gh` seam. Priority lives in a
 * different place per project — a Project's single-select field, a label, a
 * milestone — and in some repositories barely at all, so the ranking uses only
 * what a project actually recorded, names the signal on every row, and says in
 * one neutral line when there is none. It invents no order for the rest and
 * never suggests how a project should record priority (operator decision D2).
 *
 * One `gh api graphql` call in the common case. A token without Project scope
 * answers with an error for `projectItems`; the call is repeated once without
 * them and the ranking says the fields were unreadable. Like the pull-request
 * read above, a failure is carried out as a failure, never as an empty list.
 *
 * Read-only. Nothing here labels, comments on, closes or opens an issue.
 * ------------------------------------------------------------------------- */

export interface OpenIssueRow {
  number: number;
  title: string;
  createdAt: string;
  updatedAt: string | null;
  labels: string[];
  milestone: { title: string; dueOn: string | null } | null;
  /** Open issues recorded as blocking this one. */
  openBlockers: number;
  /** Open pull requests that close this issue when they merge. */
  closingPullRequests: number;
  /** Single-select field values of the issue's Project items, by field name;
      the first Project that sets a field wins. */
  projectFields: Record<string, string>;
}

export interface RankedIssue extends OpenIssueRow {
  /** 0 (critical) to 3 (low); null when no priority signal names one. */
  tier: number | null;
  /** The signal the tier came from, as printed. */
  tierSignal: string | null;
  ready: boolean;
  status: string | null;
}

export interface IssueRanking {
  /** Open issues the repository has, and how many of them were read. */
  totalCount: number;
  read: number;
  /** Excluded before ranking: already on the board, closed by an open pull
      request, blocked, or in a Project status that is not open for work. */
  excluded: number;
  /** Issues with a tier or a milestone, in rank order. */
  ranked: RankedIssue[];
  /** The rest, newest update first. Nothing orders them further. */
  unranked: RankedIssue[];
  /** The signals the ranked issues were ranked by, in the order they apply. */
  signals: string[];
  projectFieldsUnreadable: boolean;
}

export type RankedIssuesResult =
  | { ok: true; ranking: IssueRanking }
  | { ok: false; unavailable: OpenPullRequestsUnavailable };

const ISSUE_PAGE_SIZE = 100;
const ISSUE_TITLE_LIMIT = 200;

function issuesQuery(withProjects: boolean): string {
  const projects = withProjects
    ? " projectItems(first: 3) { nodes { fieldValues(first: 20) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } } } }"
    : "";
  return "query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) {"
    + ` issues(states: OPEN, first: ${ISSUE_PAGE_SIZE}, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {`
    + " totalCount pageInfo { hasNextPage endCursor } nodes { number title createdAt updatedAt"
    + " labels(first: 10) { nodes { name } } milestone { title dueOn }"
    + " issueDependenciesSummary { blockedBy }"
    + " closedByPullRequestsReferences(first: 1, includeClosedPrs: false) { totalCount }"
    + `${projects} } } } }`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nodesOf(value: unknown): unknown[] {
  const nodes = record(value)?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

interface IssuePage {
  totalCount: number;
  issues: OpenIssueRow[];
  endCursor: string | null;
  hasNextPage: boolean;
}

/** Null when the answer is not a page of issues at all. A response that also
    carries `errors` is refused, so a partial answer never reads as whole. */
function parseIssuePage(raw: string): IssuePage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const body = record(parsed);
  if (!body || (Array.isArray(body.errors) && body.errors.length > 0)) return null;
  const issues = record(record(record(body.data)?.repository)?.issues);
  if (!issues || typeof issues.totalCount !== "number" || !Array.isArray(issues.nodes)) return null;
  const rows: OpenIssueRow[] = [];
  for (const entry of issues.nodes) {
    const node = record(entry);
    if (!node || typeof node.number !== "number" || !Number.isSafeInteger(node.number)) return null;
    if (typeof node.createdAt !== "string" || !Number.isFinite(Date.parse(node.createdAt))) return null;
    const milestone = record(node.milestone);
    const projectFields: Record<string, string> = {};
    for (const item of nodesOf(node.projectItems)) {
      for (const value of nodesOf(record(item)?.fieldValues)) {
        const field = record(record(value)?.field)?.name;
        const name = record(value)?.name;
        if (typeof field === "string" && typeof name === "string" && !(field in projectFields)) projectFields[field] = name.slice(0, 60);
      }
    }
    const blockers = record(node.issueDependenciesSummary)?.blockedBy;
    const closing = record(node.closedByPullRequestsReferences)?.totalCount;
    rows.push({
      number: node.number,
      title: typeof node.title === "string" ? node.title.slice(0, ISSUE_TITLE_LIMIT) : "",
      createdAt: node.createdAt,
      updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : null,
      labels: nodesOf(node.labels).flatMap((label) => {
        const name = record(label)?.name;
        return typeof name === "string" ? [name.slice(0, 60)] : [];
      }),
      milestone: milestone && typeof milestone.title === "string"
        ? { title: milestone.title.slice(0, 60), dueOn: typeof milestone.dueOn === "string" ? milestone.dueOn : null }
        : null,
      openBlockers: typeof blockers === "number" ? blockers : 0,
      closingPullRequests: typeof closing === "number" ? closing : 0,
      projectFields,
    });
  }
  const pageInfo = record(issues.pageInfo);
  return {
    totalCount: issues.totalCount,
    issues: rows,
    endCursor: typeof pageInfo?.endCursor === "string" ? pageInfo.endCursor : null,
    hasNextPage: pageInfo?.hasNextPage === true,
  };
}

/** Lower-cased words of an option name, with emoji and punctuation removed. */
function optionWords(name: string): string {
  return name.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
}

const TIER_WORDS: Readonly<Record<string, number>> = {
  critical: 0, urgent: 0, blocker: 0, p0: 0,
  high: 1, soon: 1, p1: 1,
  medium: 2, normal: 2, p2: 2,
  low: 3, whenever: 3, p3: 3,
};

/** The tier an option names; an option outside the list ranks as medium. */
function tierOf(name: string): number {
  for (const word of optionWords(name).split(" ")) {
    const tier = TIER_WORDS[word];
    if (tier !== undefined) return tier;
  }
  return 2;
}

/** A label that records priority, and the level it names. */
function labelTier(label: string): number | null {
  const words = optionWords(label);
  const level = /^priority (\S+)$/.exec(words)?.[1];
  if (level) return tierOf(level);
  if (/^p[0-3]$/.test(words)) return TIER_WORDS[words]!;
  if (words === "critical" || words === "urgent") return 0;
  return null;
}

/** Project fields are matched by name, whatever the project capitalized. */
function fieldValue(fields: Record<string, string>, wanted: string): string | null {
  for (const [field, value] of Object.entries(fields)) if (optionWords(field) === wanted) return value;
  return null;
}

const STATUS_CLOSED_FOR_WORK = ["done", "complete", "completed", "closed", "shipped", "cancelled", "canceled", "blocked", "on hold", "hold", "paused", "in progress", "doing", "in review", "review"];

function statusClosedForWork(status: string): boolean {
  const words = optionWords(status);
  return STATUS_CLOSED_FOR_WORK.some((phrase) => words === phrase || words.startsWith(`${phrase} `) || words.endsWith(` ${phrase}`));
}

function statusReady(status: string | null, labels: readonly string[]): boolean {
  if (status) {
    const words = optionWords(status);
    if (/\bready\b/.test(words) || /\btodo\b/.test(words) || /\bto do\b/.test(words)) return true;
  }
  return labels.some((label) => {
    const words = optionWords(label);
    return words === "ready" || words === "ready for agent";
  });
}

function rankedIssue(issue: OpenIssueRow): RankedIssue {
  const priority = fieldValue(issue.projectFields, "priority");
  const urgency = fieldValue(issue.projectFields, "urgency");
  const status = fieldValue(issue.projectFields, "status");
  let tier: number | null = null;
  let tierSignal: string | null = null;
  if (priority) {
    tier = tierOf(priority);
    tierSignal = `Priority ${priority}`;
  } else if (urgency) {
    tier = tierOf(urgency);
    tierSignal = `Urgency ${urgency}`;
  } else {
    for (const label of issue.labels) {
      const labelled = labelTier(label);
      if (labelled === null) continue;
      tier = labelled;
      tierSignal = `label ${label}`;
      break;
    }
  }
  return { ...issue, tier, tierSignal, ready: statusReady(status, issue.labels), status };
}

function dueMs(issue: RankedIssue): number {
  if (!issue.milestone) return Number.POSITIVE_INFINITY;
  const due = issue.milestone.dueOn ? Date.parse(issue.milestone.dueOn) : Number.NaN;
  /* A milestone with no date sorts after every dated one, and before none. */
  return Number.isFinite(due) ? due : Number.MAX_SAFE_INTEGER;
}

/** Tier, then readiness, then the soonest milestone, then the longest wait. */
function compareRanked(left: RankedIssue, right: RankedIssue): number {
  return (left.tier ?? 4) - (right.tier ?? 4)
    || Number(right.ready) - Number(left.ready)
    || dueMs(left) - dueMs(right)
    || Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || left.number - right.number;
}

/**
 * Pure: rank what was read. Only an issue carrying a tier or a milestone is
 * ranked; readiness orders ranked issues and never ranks one by itself, since it
 * records state and says nothing about priority.
 */
export function rankOpenIssues(
  issues: readonly OpenIssueRow[],
  options: { totalCount: number; onBoard: ReadonlySet<number>; projectFieldsUnreadable?: boolean },
): IssueRanking {
  let excluded = 0;
  const ranked: RankedIssue[] = [];
  const unranked: RankedIssue[] = [];
  for (const issue of issues) {
    const row = rankedIssue(issue);
    if (options.onBoard.has(issue.number) || issue.closingPullRequests > 0 || issue.openBlockers > 0
      || (row.status !== null && statusClosedForWork(row.status))) {
      excluded += 1;
      continue;
    }
    (row.tier !== null || row.milestone ? ranked : unranked).push(row);
  }
  ranked.sort(compareRanked);
  unranked.sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt) - Date.parse(left.updatedAt ?? left.createdAt));
  const used = new Set(ranked.map((issue) => issue.tierSignal?.split(" ", 1)[0] ?? "milestone"));
  const signals = [
    ...(used.has("Priority") ? ["Project Priority field"] : []),
    ...(used.has("Urgency") ? ["Project Urgency field"] : []),
    ...(used.has("label") ? ["priority label"] : []),
    ...(ranked.some((issue) => issue.milestone) ? ["milestone"] : []),
  ];
  return {
    totalCount: options.totalCount,
    read: issues.length,
    excluded,
    ranked,
    unranked,
    signals,
    projectFieldsUnreadable: options.projectFieldsUnreadable === true,
  };
}

/**
 * The open issues of `repository` (`owner/name` on github.com), ranked. The
 * caller has already established that the project's origin is on GitHub; a
 * project that is not runs no `gh` at all.
 */
export async function openIssuesRanked(options: {
  cwd: string;
  repository: string;
  onBoard: ReadonlySet<number>;
  run?: GithubRunner;
  timeoutMs?: number;
}): Promise<RankedIssuesResult> {
  const [owner, name] = options.repository.split("/");
  if (!owner || !name) return { ok: false, unavailable: "command-failed" };
  const run = options.run ?? githubRunner(options.cwd, options.timeoutMs ?? 20_000);
  const page = async (withProjects: boolean, after: string | null): Promise<IssuePage | OpenPullRequestsUnavailable> => {
    let raw: string;
    try {
      raw = await run(["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`,
        ...(after ? ["-F", `after=${after}`] : []), "-f", `query=${issuesQuery(withProjects)}`]);
    } catch (error) {
      return githubUnavailableFromError(error);
    }
    return parseIssuePage(raw) ?? "malformed-output";
  };
  let withProjects = true;
  let first = await page(true, null);
  /* A token without Project scope fails the whole query on `projectItems`;
     one retry without them still ranks by labels and milestones. A timeout is
     not retried: the budget it spent is the budget the report has. */
  if (typeof first === "string" && first !== "timed-out") {
    withProjects = false;
    first = await page(false, null);
  }
  if (typeof first === "string") return { ok: false, unavailable: first };
  let issues = first.issues;
  const rank = () => rankOpenIssues(issues, { totalCount: first.totalCount, onBoard: options.onBoard, projectFieldsUnreadable: !withProjects });
  let ranking = rank();
  /* A second page only when the first ranked nothing above medium. */
  if (first.hasNextPage && first.endCursor && !ranking.ranked.some((issue) => (issue.tier ?? 4) <= 1)) {
    const second = await page(withProjects, first.endCursor);
    if (typeof second !== "string") {
      issues = [...issues, ...second.issues];
      ranking = rank();
    }
  }
  return { ok: true, ranking };
}
