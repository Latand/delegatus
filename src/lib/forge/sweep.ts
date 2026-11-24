import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import os from "node:os";

import { githubRunner, githubUnavailableFromError, type GithubRunner } from "@/lib/monitor/githubEvidence";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import { activeSeatsByCurrentProject } from "@/lib/orchestrator/seatProjectIdentity";

import { emptyRepositoryEntry, forgeCacheFile, clearForgeNudges, pendingForgeNudges, readForgeCache, updateForgeCache, proposalIssueSnapshot, PROPOSAL_ISSUE_LIMIT, type ForgeRepositoryEntry, type ForgeSweepError, type StoredPullRequest } from "./cache";
import { pipelineRepository, taskRepository } from "./resolve";
import { githubRepositoryOfRemote, normalizeWorkLinkInput, type PullRequestState } from "./workLinks";
import { githubReadDiagnostic } from "./githubReadFailure";

/*
 * The one poller (#2059, docs/design/pr-issue-chips.md §4.2). One
 * repository-wide `gh pr list` answers every head of every pipeline in about a
 * second, so the sweep reads each repository instead of each lane. It takes no
 * pipeline or task lock and writes nothing but the forge cache: records are
 * read through the same lease-free loads a stage report uses.
 * Seated repositories also replace one bounded proposal-issue page here;
 * wake composition reads that persisted observation without contacting GitHub.
 */

export const FORGE_LIVE_INTERVAL_MS = 3 * 60_000;
export const FORGE_IDLE_INTERVAL_MS = 30 * 60_000;
export const FORGE_NUDGE_DEBOUNCE_MS = 30_000;
/** A failed read waits this long before it is tried again. */
export const FORGE_RETRY_MS = 3 * 60_000;
export const FORGE_PAGE_LIMIT = 100;
export const FORGE_FULL_LIMIT = 5_000;
export const FORGE_FILL_LIMIT = 10;
const FORGE_TIMEOUT_MS = 20_000;

const PR_FIELDS = "number,url,headRefName,headRefOid,state,isDraft,createdAt,updatedAt,title,mergedAt,closingIssuesReferences";
const LEGACY_PR_FIELDS = "number,url,headRefName,headRefOid,state,isDraft,createdAt,updatedAt,title,mergedAt";

export interface ForgeSweepPorts {
  now: () => number;
  run: GithubRunner;
  loadPipelines: () => readonly Pipeline[];
  loadTasks: () => readonly BoardTask[];
  loadSeatProjects?: () => readonly string[];
  file?: string;
  log?: (message: string, error?: unknown) => void;
}

type SweptRow = StoredPullRequest & { number: number; updatedAt: string };

function parseRows(raw: string, checkedAt: string): SweptRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: SweptRow[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") return null;
    const row = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(row.number) || typeof row.url !== "string" || typeof row.headRefName !== "string" || typeof row.state !== "string") return null;
    const state = row.isDraft === true && row.state === "OPEN" ? "draft" : row.state.toLowerCase();
    if (state !== "open" && state !== "draft" && state !== "merged" && state !== "closed") return null;
    const closes = (Array.isArray(row.closingIssuesReferences) ? row.closingIssuesReferences : []).flatMap((reference) => {
      const ref = reference as { number?: unknown; url?: unknown } | null;
      if (!ref || !Number.isSafeInteger(ref.number)) return [];
      /* Only this repository's issues: a closing reference into another
         repository would read as the wrong issue under this one's name. */
      const own = typeof ref.url !== "string" || repositoryOfUrl(ref.url) === repositoryOfUrl(row.url as string);
      return own ? [ref.number as number] : [];
    });
    rows.push({
      number: row.number as number,
      url: row.url,
      headRefName: row.headRefName,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
      state: state as PullRequestState,
      closes,
      checkedAt,
      ...(typeof row.headRefOid === "string" && /^[0-9a-f]{40}$/i.test(row.headRefOid) ? { headRefOid: row.headRefOid } : {}),
      ...(typeof row.title === "string" ? { title: row.title.slice(0, 512) } : {}),
      /* gh answers an unmerged PR's mergedAt as null or the zero instant. */
      ...(typeof row.mergedAt === "string" && Number.isFinite(Date.parse(row.mergedAt)) && Date.parse(row.mergedAt) > 0 ? { mergedAt: row.mergedAt } : {}),
    });
  }
  return rows;
}

function repositoryOfUrl(url: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\//i.exec(url);
  return match ? githubRepositoryOfRemote(`github.com/${match[1]}/${match[2]}`) : null;
}

type Demand = { live: boolean; numbers: Set<number>; proposals?: boolean };

/** Every repository the board's records name, whether it holds something that
    can still change, and the numbers a record names outright. */
function collectDemand(ports: ForgeSweepPorts): Map<string, Demand> {
  const demand = new Map<string, Demand>();
  const want = (repository: string | null) => {
    if (!repository) return null;
    let entry = demand.get(repository);
    if (!entry) demand.set(repository, entry = { live: false, numbers: new Set() });
    return entry;
  };
  for (const pipeline of ports.loadPipelines()) {
    const own = want(pipelineRepository(pipeline));
    if (own && pipeline.state !== "completed" && pipeline.state !== "closed" && !pipeline.hiddenAt) own.live = true;
    if (own && pipeline.delivery?.target.pr) own.numbers.add(pipeline.delivery.target.pr);
    for (const link of pipeline.workLinks ?? []) want(link.repository)?.numbers.add(link.number);
  }
  for (const task of ports.loadTasks()) {
    const repository = taskRepository(task);
    if (task.workLinks?.length) want(repository);
    for (const link of task.workLinks ?? []) want(link.repository)?.numbers.add(link.number);
    if (task.status !== "done" && task.hold?.kind === "pr" && task.hold.ref) {
      const hold = normalizeWorkLinkInput(task.hold.ref, { repository, kind: "pr" });
      if (hold.ok) {
        const entry = want(hold.link.repository);
        if (entry) {
          entry.live = true;
          entry.numbers.add(hold.link.number);
        }
      }
    }
  }
  let seatProjects: readonly string[] = [];
  try { seatProjects = ports.loadSeatProjects?.() ?? []; }
  catch (error) { ports.log?.("[forge proposals] seated projects unavailable", error instanceof Error ? error.name : "unknown"); }
  for (const project of seatProjects) {
    const own = want(taskRepository({ project }));
    if (own) { own.live = true; own.proposals = true; }
  }
  return demand;
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);

function due(entry: ForgeRepositoryEntry | undefined, demand: Demand, nudgedAt: number | undefined, now: number): boolean {
  const finished = ms(entry?.lastAttemptAt ?? null);
  if (Number.isFinite(finished) && entry?.lastError && now - finished < FORGE_RETRY_MS) return false;
  if (!entry?.completeSince) return true;
  const swept = ms(entry.lastSweepAt);
  if (!Number.isFinite(swept)) return true;
  const since = now - swept;
  if (nudgedAt !== undefined && since >= FORGE_NUDGE_DEBOUNCE_MS) return true;
  const live = demand.live || Object.values(entry.prs).some((pr) => pr.state === "open" || pr.state === "draft");
  return since >= (live ? FORGE_LIVE_INTERVAL_MS : FORGE_IDLE_INTERVAL_MS);
}

type RepositoryOutcome =
  | { ok: true; rows: SweptRow[]; complete: boolean; full: boolean; canonical: string | null; filled: SweptRow[]; issues: number[]; fillFailure?: RepositoryReadFailure }
  | RepositoryReadFailure;

type RepositoryReadFailure = { ok: false; error: ForgeSweepError; diagnostic: string };

function failedRead(error: unknown): RepositoryReadFailure {
  return { ok: false, error: githubUnavailableFromError(error), diagnostic: githubReadDiagnostic(error).message };
}

const malformedRead: RepositoryReadFailure = {
  ok: false, error: "malformed-output", diagnostic: "GitHub read returned an invalid response. Check the gh version and retry.",
};

/** Debian's gh cannot name closingIssuesReferences in --json. Keep that
 * linkage by asking GraphQL for each returned page in one bounded batch. */
async function legacyPullRequestRows(raw: string, run: GithubRunner): Promise<string> {
  let rows: unknown;
  try { rows = JSON.parse(raw); } catch { throw new InvalidLegacyResponse(); }
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new InvalidLegacyResponse();
  for (let start = 0; start < rows.length; start += FORGE_PAGE_LIMIT) {
    const batch = rows.slice(start, start + FORGE_PAGE_LIMIT) as Record<string, unknown>[];
    const repository = batch.map((row) => typeof row.url === "string" ? repositoryOfUrl(row.url) : null).find(Boolean);
    if (!repository) throw new InvalidLegacyResponse();
    const [owner, name] = repository.split("/");
    const aliases = batch.map((row, index) => {
      if (!Number.isSafeInteger(row.number)) throw new InvalidLegacyResponse();
      return `p${index}: pullRequest(number: ${row.number}) { closingIssuesReferences(first: 100) { nodes { number url } pageInfo { hasNextPage } } }`;
    });
    const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${aliases.join(" ")} } }`;
    const rawAnswer = await run(["api", "graphql", "-f", `query=${query}`]);
    let answer: unknown;
    try { answer = JSON.parse(rawAnswer); } catch { throw new InvalidLegacyResponse(); }
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new InvalidLegacyResponse();
    const response = answer as { data?: { repository?: Record<string, unknown> }; errors?: unknown[] };
    if (response.errors?.length || !response.data?.repository) throw new InvalidLegacyResponse();
    for (const [index, row] of batch.entries()) {
      const pr = response.data.repository[`p${index}`] as { closingIssuesReferences?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } } } | null;
      const refs = pr?.closingIssuesReferences;
      const hasNextPage = refs?.pageInfo?.hasNextPage;
      if (!Array.isArray(refs?.nodes) || typeof hasNextPage !== "boolean"
        || refs.nodes.some((ref) => !ref || typeof ref !== "object"
          || !Number.isSafeInteger((ref as { number?: unknown }).number)
          || typeof (ref as { url?: unknown }).url !== "string")) throw new InvalidLegacyResponse();
      if (hasNextPage) throw new Error("closing issue references are incomplete");
      row.closingIssuesReferences = refs.nodes;
    }
  }
  return JSON.stringify(rows);
}

class InvalidLegacyResponse extends Error {}

async function readRepository(repository: string, entry: ForgeRepositoryEntry | undefined, demand: Demand, ports: ForgeSweepPorts, startedAt: string): Promise<RepositoryOutcome> {
  const name = entry?.canonical ?? repository;
  const list = async (args: string[]): Promise<SweptRow[] | RepositoryReadFailure> => {
    try {
      return parseRows(await ports.run(["pr", "list", "--repo", name, "--state", "all", ...args, "--json", PR_FIELDS]), startedAt) ?? malformedRead;
    } catch (error) {
      if (!/Unknown JSON field[^\n]*closingIssuesReferences/i.test(`${(error as { stderr?: unknown })?.stderr ?? ""}\n${(error as Error)?.message ?? ""}`)) return failedRead(error);
      try {
        const raw = await ports.run(["pr", "list", "--repo", name, "--state", "all", ...args, "--json", LEGACY_PR_FIELDS]);
        return parseRows(await legacyPullRequestRows(raw, ports.run), startedAt) ?? malformedRead;
      } catch (fallbackError) {
        return fallbackError instanceof InvalidLegacyResponse ? malformedRead : failedRead(fallbackError);
      }
    }
  };
  let rows: SweptRow[] | null = null;
  let complete = false;
  let full = false;
  /* An entry cached before head commits were read is read in full once, so
     the merged PRs it already holds gain theirs. */
  if (entry?.completeSince && entry.lastSweepAt && entry.headRefOids) {
    const page = await list(["--limit", String(FORGE_PAGE_LIMIT), "--search", "sort:updated-desc"]);
    if (!Array.isArray(page)) return page;
    const oldest = Math.min(...page.map((row) => ms(row.updatedAt)).filter(Number.isFinite));
    /* The page proves coverage when it reaches back to the previous sweep, or
       when it is the repository's whole history. An empty page proves nothing
       once PRs are known: a search under a stale name answers `[]`. */
    const overlapped = page.length < FORGE_PAGE_LIMIT ? page.length > 0 || Object.keys(entry.prs).length === 0 : oldest <= ms(entry.lastSweepAt);
    if (overlapped) {
      rows = page;
      complete = true;
    }
  }
  if (rows === null) {
    const all = await list(["--limit", String(FORGE_FULL_LIMIT)]);
    if (!Array.isArray(all)) return all;
    rows = all;
    complete = true;
    full = true;
  }
  const canonical = rows.map((row) => repositoryOfUrl(row.url)).find(Boolean) ?? null;
  const known = new Set([...Object.keys(entry?.prs ?? {}), ...Object.keys(entry?.issues ?? {})].map(Number));
  for (const row of rows) known.add(row.number);
  const missing = [...demand.numbers].filter((number) => !known.has(number)).slice(0, FORGE_FILL_LIMIT);
  const filled: SweptRow[] = [];
  const issues: number[] = [];
  let fillFailure: RepositoryReadFailure | undefined;
  for (const number of missing) {
    let raw: string;
    let legacy = false;
    try {
      try {
        raw = await ports.run(["pr", "view", String(number), "--repo", canonical ?? name, "--json", PR_FIELDS]);
      } catch (error) {
        if (!/Unknown JSON field[^\n]*closingIssuesReferences/i.test(`${(error as { stderr?: unknown })?.stderr ?? ""}\n${(error as Error)?.message ?? ""}`)) throw error;
        raw = await ports.run(["pr", "view", String(number), "--repo", canonical ?? name, "--json", LEGACY_PR_FIELDS]);
        legacy = true;
      }
    } catch (error) {
      /* gh names a number that is not a pull request this way; anything else
         is an outage, and the number is asked again next time. */
      const detail = `${(error as { stderr?: unknown })?.stderr ?? ""} ${(error as Error)?.message ?? ""}`;
      if (/Could not resolve to a PullRequest/i.test(detail)) issues.push(number);
      else fillFailure ??= failedRead(error);
      continue;
    }
    let rowsJson = `[${raw.trim()}]`;
    if (legacy) {
      try { rowsJson = await legacyPullRequestRows(rowsJson, ports.run); }
      catch (error) {
        fillFailure ??= error instanceof InvalidLegacyResponse ? malformedRead : failedRead(error);
        continue;
      }
    }
    const parsed = parseRows(rowsJson, startedAt);
    const [row] = parsed ?? [];
    if (parsed?.length === 1 && row?.number === number) filled.push(row);
    else fillFailure ??= malformedRead;
  }
  return { ok: true, rows, complete, full, canonical, filled, issues, fillFailure };
}

function applyOutcome(entry: ForgeRepositoryEntry, outcome: RepositoryOutcome, startedAt: string, finishedAt: string): void {
  entry.lastAttemptAt = finishedAt;
  if (!outcome.ok) {
    /* Missing one read loses nothing when the next page overlaps, so the
       entries and `completeSince` stay exactly as they were. */
    entry.lastError = outcome.error;
    return;
  }
  entry.lastError = outcome.fillFailure?.error ?? null;
  for (const row of [...outcome.rows, ...outcome.filled]) {
    const { number, updatedAt: _updatedAt, ...stored } = row;
    entry.prs[String(number)] = stored;
    delete entry.issues[String(number)];
  }
  for (const number of outcome.issues) entry.issues[String(number)] = { checkedAt: startedAt };
  if (outcome.canonical) entry.canonical = outcome.canonical;
  if (outcome.complete) entry.completeSince = entry.completeSince ?? startedAt;
  if (outcome.full) entry.headRefOids = true;
  entry.lastSweepAt = startedAt;
}

/**
 * One pass: every due repository is read, one at a time, and the cache is
 * written once per repository. Returns the repositories it read.
 */
export async function sweepForgeLinks(ports: ForgeSweepPorts): Promise<string[]> {
  return withViewerOperation("forge.sweep", async () => {
  const file = ports.file ?? forgeCacheFile();
  const demand = collectDemand(ports);
  const nudged = pendingForgeNudges();
  const now = ports.now();
  const data = readForgeCache(file).data;
  const canonicalOf = new Map<string, string>();
  for (const [name, entry] of Object.entries(data.repositories)) if (entry.canonical) canonicalOf.set(entry.canonical, name);
  /* A link pasted under the new name of a renamed repository is the same
     repository as the records' old name; read it once. */
  for (const [name, wanted] of [...demand]) {
    const alias = canonicalOf.get(name);
    if (!alias || alias === name) continue;
    const target = demand.get(alias) ?? { live: false, numbers: new Set<number>() };
    target.live ||= wanted.live;
    target.proposals ||= wanted.proposals;
    for (const number of wanted.numbers) target.numbers.add(number);
    demand.set(alias, target);
    demand.delete(name);
  }
  const read: string[] = [];
  const dueNow = [...demand].filter(([name, wanted]) => due(data.repositories[name], wanted, nudged.get(name) ?? nudged.get(data.repositories[name]?.canonical ?? ""), now));
  for (const [name, wanted] of dueNow) {
    const startedAt = new Date(ports.now()).toISOString();
    const outcome = await readRepository(name, readForgeCache(file).data.repositories[name], wanted, ports, startedAt);
    const finishedAt = new Date(ports.now()).toISOString();
    updateForgeCache((next) => applyOutcome(next.repositories[name] ??= emptyRepositoryEntry(), outcome, startedAt, finishedAt), file);
    // Commit PR evidence first: a pending proposal read cannot hold it back.
    // The existing runner gives this separate request its own 20-second bound.
    if (wanted.proposals) {
      const checkedAt = new Date(ports.now()).toISOString();
      try {
        const repository = readForgeCache(file).data.repositories[name]?.canonical ?? name;
        const rows: unknown = JSON.parse(await ports.run(["issue", "list", "--repo", repository, "--state", "open", "--limit", String(PROPOSAL_ISSUE_LIMIT), "--json", "number,title,labels,updatedAt"]));
        const proposals = proposalIssueSnapshot({ checkedAt, issues: Array.isArray(rows) ? rows.slice(0, PROPOSAL_ISSUE_LIMIT).map(row => ({ ...row,
          labels: Array.isArray(row?.labels) ? row.labels.slice(0, 20).map((label: { name?: unknown } | null) => label?.name) : null })) : null });
        if (!proposals) throw new Error("malformed proposal issues");
        updateForgeCache(next => { (next.repositories[name] ??= emptyRepositoryEntry()).proposals = proposals; }, file);
      } catch (error) {
        // Keep the previous observation and its age, including after restart.
        const diagnostic = githubReadDiagnostic(error).message;
        if (outcome.ok || diagnostic !== outcome.diagnostic) ports.log?.(`[forge proposals] ${name}: ${diagnostic}`);
      }
    }
    clearForgeNudges([name, data.repositories[name]?.canonical ?? name]);
    if (!outcome.ok) ports.log?.(`[forge links] ${name}: ${outcome.error}`, outcome.diagnostic);
    else if (outcome.fillFailure) ports.log?.(`[forge links] ${name}: ${outcome.fillFailure.error}`, outcome.fillFailure.diagnostic);
    read.push(name);
  }
  return read;
  });
}

/* ── Scheduling from the controller cycle ───────────────────────────────── */

const scheduleHost = globalThis as typeof globalThis & { __llvForgeSweepRunning?: Promise<unknown> | null; __llvForgeSweepStartedAt?: number };

/** Fire-and-forget, one run at a time, errors logged and never thrown: the
    controller calls this at the end of every cycle, as it does the archive. */
export function scheduleForgeSweep(ports: Partial<ForgeSweepPorts> & Pick<ForgeSweepPorts, "loadPipelines" | "loadTasks">): void {
  if (scheduleHost.__llvForgeSweepRunning) return;
  /* The controller cycles on every signal; nothing can be due sooner than the
     nudge debounce, so the records are not even read before then. */
  const now = (ports.now ?? Date.now)();
  if (now - (scheduleHost.__llvForgeSweepStartedAt ?? -Infinity) < FORGE_NUDGE_DEBOUNCE_MS) return;
  scheduleHost.__llvForgeSweepStartedAt = now;
  const log = ports.log ?? ((message: string, error?: unknown) => console.error(message, error ?? ""));
  const run = sweepForgeLinks({
    now: ports.now ?? Date.now,
    run: ports.run ?? githubRunner(os.tmpdir(), FORGE_TIMEOUT_MS),
    loadSeatProjects: () => activeSeatsByCurrentProject().map(seat => seat.project),
    ...ports,
    log,
  }).catch((error) => log("[forge links] sweep failed", error)).finally(() => {
    scheduleHost.__llvForgeSweepRunning = null;
  });
  scheduleHost.__llvForgeSweepRunning = run;
}
