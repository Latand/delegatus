import os from "node:os";

import { githubRunner, githubUnavailableFromError, type GithubRunner } from "@/lib/monitor/githubEvidence";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import { emptyRepositoryEntry, forgeCacheFile, clearForgeNudges, pendingForgeNudges, readForgeCache, updateForgeCache, type ForgeRepositoryEntry, type ForgeSweepError, type StoredPullRequest } from "./cache";
import { pipelineRepository, taskRepository } from "./resolve";
import { githubRepositoryOfRemote, type PullRequestState } from "./workLinks";

/*
 * The one poller (#2059, docs/design/pr-issue-chips.md §4.2). One
 * repository-wide `gh pr list` answers every head of every pipeline in about a
 * second, so the sweep reads each repository instead of each lane. It takes no
 * pipeline or task lock and writes nothing but the forge cache: records are
 * read through the same lease-free loads a stage report uses.
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

const PR_FIELDS = "number,url,headRefName,headRefOid,state,isDraft,createdAt,updatedAt,closingIssuesReferences";

export interface ForgeSweepPorts {
  now: () => number;
  run: GithubRunner;
  loadPipelines: () => readonly Pipeline[];
  loadTasks: () => readonly BoardTask[];
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
    });
  }
  return rows;
}

function repositoryOfUrl(url: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\//i.exec(url);
  return match ? githubRepositoryOfRemote(`github.com/${match[1]}/${match[2]}`) : null;
}

type Demand = { live: boolean; numbers: Set<number> };

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
    if (!task.workLinks?.length) continue;
    want(taskRepository(task));
    for (const link of task.workLinks) want(link.repository)?.numbers.add(link.number);
  }
  return demand;
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);

function due(entry: ForgeRepositoryEntry | undefined, demand: Demand, nudgedAt: number | undefined, now: number): boolean {
  const attempted = ms(entry?.lastAttemptAt ?? null);
  if (Number.isFinite(attempted) && entry?.lastError && now - attempted < FORGE_RETRY_MS) return false;
  if (!entry?.completeSince) return true;
  const swept = ms(entry.lastSweepAt);
  if (!Number.isFinite(swept)) return true;
  const since = now - swept;
  if (nudgedAt !== undefined && since >= FORGE_NUDGE_DEBOUNCE_MS) return true;
  const live = demand.live || Object.values(entry.prs).some((pr) => pr.state === "open" || pr.state === "draft");
  return since >= (live ? FORGE_LIVE_INTERVAL_MS : FORGE_IDLE_INTERVAL_MS);
}

type RepositoryOutcome =
  | { ok: true; rows: SweptRow[]; complete: boolean; full: boolean; canonical: string | null; filled: SweptRow[]; issues: number[] }
  | { ok: false; error: ForgeSweepError };

async function readRepository(repository: string, entry: ForgeRepositoryEntry | undefined, demand: Demand, ports: ForgeSweepPorts, startedAt: string): Promise<RepositoryOutcome> {
  const name = entry?.canonical ?? repository;
  const list = async (args: string[]): Promise<SweptRow[] | ForgeSweepError> => {
    try {
      return parseRows(await ports.run(["pr", "list", "--repo", name, "--state", "all", ...args, "--json", PR_FIELDS]), startedAt) ?? "malformed-output";
    } catch (error) {
      return githubUnavailableFromError(error);
    }
  };
  let rows: SweptRow[] | ForgeSweepError | null = null;
  let complete = false;
  let full = false;
  /* An entry cached before head commits were read is read in full once, so
     the merged PRs it already holds gain theirs. */
  if (entry?.completeSince && entry.lastSweepAt && entry.headRefOids) {
    const page = await list(["--limit", String(FORGE_PAGE_LIMIT), "--search", "sort:updated-desc"]);
    if (typeof page === "string") return { ok: false, error: page };
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
    if (typeof all === "string") return { ok: false, error: all };
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
  for (const number of missing) {
    try {
      const raw = await ports.run(["pr", "view", String(number), "--repo", canonical ?? name, "--json", PR_FIELDS]);
      const parsed = parseRows(`[${raw.trim()}]`, startedAt);
      if (parsed?.[0]) filled.push(parsed[0]);
    } catch (error) {
      /* gh names a number that is not a pull request this way; anything else
         is an outage, and the number is asked again next time. */
      const detail = `${(error as { stderr?: unknown })?.stderr ?? ""} ${(error as Error)?.message ?? ""}`;
      if (/Could not resolve to a PullRequest/i.test(detail)) issues.push(number);
    }
  }
  return { ok: true, rows, complete, full, canonical, filled, issues };
}

function applyOutcome(entry: ForgeRepositoryEntry, outcome: RepositoryOutcome, startedAt: string): void {
  entry.lastAttemptAt = startedAt;
  if (!outcome.ok) {
    /* Missing one read loses nothing when the next page overlaps, so the
       entries and `completeSince` stay exactly as they were. */
    entry.lastError = outcome.error;
    return;
  }
  entry.lastError = null;
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
    for (const number of wanted.numbers) target.numbers.add(number);
    demand.set(alias, target);
    demand.delete(name);
  }
  const read: string[] = [];
  const dueNow = [...demand].filter(([name, wanted]) => due(data.repositories[name], wanted, nudged.get(name) ?? nudged.get(data.repositories[name]?.canonical ?? ""), now));
  for (const [name, wanted] of dueNow) {
    const startedAt = new Date(ports.now()).toISOString();
    const outcome = await readRepository(name, readForgeCache(file).data.repositories[name], wanted, ports, startedAt);
    updateForgeCache((next) => applyOutcome(next.repositories[name] ??= emptyRepositoryEntry(), outcome, startedAt), file);
    clearForgeNudges([name, data.repositories[name]?.canonical ?? name]);
    if (!outcome.ok) ports.log?.(`[forge links] ${name}: ${outcome.error}`);
    read.push(name);
  }
  return read;
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
    ...ports,
    log,
  }).catch((error) => log("[forge links] sweep failed", error)).finally(() => {
    scheduleHost.__llvForgeSweepRunning = null;
  });
  scheduleHost.__llvForgeSweepRunning = run;
}
