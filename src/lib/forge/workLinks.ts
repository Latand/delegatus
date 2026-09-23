import type { Pipeline } from "@/lib/pipelines/types";

/*
 * PR and issue links on pipelines and task cards (#2059,
 * docs/design/pr-issue-chips.md).
 *
 * Pure and shared by the server and the board: no I/O here. A record stores
 * only the links someone attached by hand; everything a pipeline already says
 * about its pull request (its branches, `delivery.pr`, stage provenance) is
 * joined against the forge cache when the board or an agent reads it.
 */

export type WorkLinkKind = "pr" | "issue";

/** An operator- or agent-attached reference. `kind` is null while the number is
    not yet known to be a PR or an issue; an issue URL opens either, because
    GitHub redirects an issue URL to its pull request. */
export type StoredWorkLink = {
  /** `<owner>/<repo>`, lower-cased. */
  repository: string;
  number: number;
  kind: WorkLinkKind | null;
  addedAt: string;
  addedBy: "operator" | "agent";
};

/** Manual links a single record can carry. */
export const MAX_WORK_LINKS = 20;

export type WorkLinkVia = "manual" | "delivery-pr" | "provenance" | "lane-branch" | "delivery-branch" | "closes";
export type PullRequestState = "open" | "draft" | "merged" | "closed";

export type WorkLink = {
  /** `<repository>#<number>`, the dedupe key. */
  key: string;
  kind: WorkLinkKind | null;
  repository: string;
  number: number;
  url: string;
  /** Manual wins when both apply. */
  source: "auto" | "manual";
  /** Every piece of evidence that produced the link. */
  via: WorkLinkVia[];
  /** PRs only; null while the state was never read. */
  state: PullRequestState | null;
  /** When `state` was read from the forge. */
  checkedAt: string | null;
};

export type ResolvedWorkLinks = {
  links: WorkLink[];
  /** A PR was looked for and there is none: the repository's cache is complete
      and no rule produced a pull request. False while the answer is unknown. */
  noPr: boolean;
};

/** What `/api/files` carries: only records with something to show. */
export type FilesWorkLinks = {
  pipelines: Record<string, ResolvedWorkLinks>;
  tasks: Record<string, ResolvedWorkLinks>;
};

export const EMPTY_FILES_WORK_LINKS: FilesWorkLinks = { pipelines: {}, tasks: {} };

export type CachedPullRequest = {
  number: number;
  url: string;
  headRefName: string;
  createdAt: string;
  state: PullRequestState;
  /** Issues of the same repository this PR closes (`closingIssuesReferences`). */
  closes: number[];
  checkedAt: string;
};

/** One repository of the forge cache, indexed for read-time joins. */
export interface ForgeRepositoryView {
  /** The name GitHub answers with today (a renamed repository keeps its old
      name on records); links and URLs use it. */
  canonical: string;
  /** Every PR created before this instant is in the cache; null until the
      first complete read. */
  completeSince: string | null;
  pr(number: number): CachedPullRequest | undefined;
  byHead(head: string): readonly CachedPullRequest[];
  isIssue(number: number): boolean;
}

export interface ForgeCacheView {
  /** By the record's name or by the canonical one. */
  repository(name: string): ForgeRepositoryView | null;
}

export const EMPTY_FORGE_CACHE: ForgeCacheView = { repository: () => null };

/* ── Input ──────────────────────────────────────────────────────────────── */

export type NormalizedWorkLink = { repository: string; number: number; kind: WorkLinkKind | null };
export type WorkLinkInputResult = { ok: true; link: NormalizedWorkLink } | { ok: false; error: string };

const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;

function repositoryName(owner: string, repo: string): string | null {
  const name = repo.replace(/\.git$/i, "");
  return REPOSITORY_PART.test(owner) && REPOSITORY_PART.test(name) ? `${owner}/${name}`.toLowerCase() : null;
}

/** `<owner>/<repo>` of a GitHub remote in any form git or this repository
    writes it (the scp form `<user>@github.com:o/r.git`, `https://github.com/o/r`,
    `ssh://` URLs, the canonical `github.com/o/r`), else null. */
export function githubRepositoryOfRemote(remote: string | null | undefined): string | null {
  const value = remote?.trim();
  if (!value) return null;
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?(?:www\.)?github\.com[:/]+([^/\s]+)\/([^/\s?#]+?)\/?$/i.exec(value);
  return match ? repositoryName(match[1]!, match[2]!) : null;
}

const HOW_TO_ATTACH = "attach a pull request or issue as #123, 123, owner/repo#123 or a github.com pull or issue URL";

/**
 * Every reasonable way a person writes a PR or an issue, normalized; refused
 * only when it cannot name one. `context.repository` is what a bare number
 * means; `context.kind` overrides the guess; `kindOf` answers from the cache.
 */
export function normalizeWorkLinkInput(
  raw: unknown,
  context: { repository: string | null; kind?: WorkLinkKind | null; kindOf?: (repository: string, number: number) => WorkLinkKind | null },
): WorkLinkInputResult {
  if (typeof raw === "number") raw = String(raw);
  if (typeof raw !== "string") return { ok: false, error: `a link must be a string; ${HOW_TO_ATTACH}` };
  const strip = (text: string) => text.trim().replace(/[.,;)]+$/, "").trim().replace(/^<(.*)>$/, "$1").trim();
  let value = strip(strip(raw));
  if (!value) return { ok: false, error: `the link is empty; ${HOW_TO_ATTACH}` };
  let repository: string | null = null;
  let kind: WorkLinkKind | null = null;
  let digits: string | null = null;
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)\/(pull|pulls|issues)\/(\d+)(?:[/?#].*)?$/i.exec(value);
  if (url) {
    repository = repositoryName(url[1]!, url[2]!);
    kind = url[3]!.toLowerCase() === "issues" ? "issue" : "pr";
    digits = url[4]!;
    if (!repository) return { ok: false, error: `${value} does not name a GitHub repository; ${HOW_TO_ATTACH}` };
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^\s/]+\.[a-z]{2,}\//i.test(value)) {
    return { ok: false, error: `only github.com pull request and issue URLs can be attached; ${HOW_TO_ATTACH}` };
  } else {
    const qualified = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(value);
    if (qualified) {
      repository = repositoryName(qualified[1]!, qualified[2]!);
      digits = qualified[3]!;
    } else {
      value = value.replace(/\s+/g, " ");
      const bare = /^(?:(pr|pull request|pull|issue)\s*)?#?\s*(-?\d+)$/i.exec(value);
      if (!bare) return { ok: false, error: `${value} is not a pull request or issue reference; ${HOW_TO_ATTACH}` };
      if (bare[1]) kind = bare[1].toLowerCase() === "issue" ? "issue" : "pr";
      digits = bare[2]!;
      repository = context.repository;
      if (!repository) return { ok: false, error: `this record's repository is not a GitHub repository this machine knows, so a bare number names nothing; attach the full github.com URL or owner/repo#${digits.replace(/^-/, "")}` };
    }
  }
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number <= 0) return { ok: false, error: `a pull request or issue number is a positive integer; ${HOW_TO_ATTACH}` };
  if (!repository) return { ok: false, error: HOW_TO_ATTACH };
  if (context.kind === "pr" || context.kind === "issue") kind = context.kind;
  else if (kind === null) kind = context.kindOf?.(repository, number) ?? null;
  return { ok: true, link: { repository, number, kind } };
}

/** The same attach or detach list, whatever shape a caller sent. */
export function workLinkInputs(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/* ── Resolution ─────────────────────────────────────────────────────────── */

export const workLinkKey = (repository: string, number: number) => `${repository}#${number}`;

export function workLinkUrl(repository: string, number: number, kind: WorkLinkKind | null): string {
  return `https://github.com/${repository}/${kind === "pr" ? "pull" : "issues"}/${number}`;
}

type LinkDraft = { repository: string; number: number; kind: WorkLinkKind | null; source: "auto" | "manual"; via: WorkLinkVia[] };

/** Turns drafts into links against the cache, merging repeated keys. */
function materialize(drafts: readonly LinkDraft[], cache: ForgeCacheView): WorkLink[] {
  const byKey = new Map<string, WorkLink>();
  for (const draft of drafts) {
    const view = cache.repository(draft.repository);
    const repository = view?.canonical ?? draft.repository;
    const cached = view?.pr(draft.number);
    const kind: WorkLinkKind | null = cached ? "pr" : draft.kind ?? (view?.isIssue(draft.number) ? "issue" : null);
    const link: WorkLink = {
      key: workLinkKey(repository, draft.number),
      kind,
      repository,
      number: draft.number,
      url: cached?.url ?? workLinkUrl(repository, draft.number, kind),
      source: draft.source,
      via: [...draft.via],
      state: kind === "pr" && cached ? cached.state : null,
      checkedAt: kind === "pr" && cached ? cached.checkedAt : null,
    };
    const prior = byKey.get(link.key);
    byKey.set(link.key, prior ? mergeLink(prior, link) : link);
  }
  return [...byKey.values()];
}

function mergeLink(a: WorkLink, b: WorkLink): WorkLink {
  const kind = a.kind ?? b.kind;
  const fresher = (b.checkedAt ?? "") > (a.checkedAt ?? "") ? b : a;
  return {
    ...a,
    kind,
    url: a.kind ? a.url : b.url,
    source: a.source === "manual" || b.source === "manual" ? "manual" : "auto",
    via: [...new Set([...a.via, ...b.via])],
    state: fresher.state ?? a.state ?? b.state,
    checkedAt: fresher.checkedAt ?? a.checkedAt ?? b.checkedAt,
  };
}

const STATE_ORDER: Record<PullRequestState, number> = { open: 0, draft: 1, merged: 2, closed: 3 };

function linkRank(link: WorkLink): number {
  if (link.kind === "issue") return 6;
  if (link.kind === null) return 5;
  return link.state ? STATE_ORDER[link.state] : 4;
}

/** PRs before issues; open, draft, merged, closed, then unread; the newest
    number first within each, so a retry's merged PR leads the closed attempt
    it replaced. */
export function sortWorkLinks(links: readonly WorkLink[]): WorkLink[] {
  return [...links].sort((a, b) => linkRank(a) - linkRank(b) || b.number - a.number || a.key.localeCompare(b.key));
}

export function mergeWorkLinks(lists: ReadonlyArray<readonly WorkLink[]>): WorkLink[] {
  const byKey = new Map<string, WorkLink>();
  for (const list of lists) for (const link of list) {
    const prior = byKey.get(link.key);
    byKey.set(link.key, prior ? mergeLink(prior, link) : { ...link, via: [...link.via] });
  }
  return sortWorkLinks([...byKey.values()]);
}

function manualDrafts(links: readonly StoredWorkLink[] | undefined): LinkDraft[] {
  return (links ?? []).map((link) => ({ repository: link.repository, number: link.number, kind: link.kind, source: "manual", via: ["manual"] }));
}

export type PipelineLinkRecord = Pick<Pipeline, "branch" | "createdAt" | "delivery" | "runs" | "workLinks">;

const stripHeads = (ref: string) => ref.replace(/^refs\/heads\//, "");

/**
 * A pipeline's links, by the design's rules (§4.4): manual links, the recorded
 * `delivery.pr`, every PR stage provenance saw, and the cached PRs whose head
 * is the lane or the delivery branch — created no earlier than the lane, so a
 * reused head name cannot hand a new lane an old PR, unless `delivery.pr`
 * names it — and then the issues those PRs close.
 */
export function resolvePipelineLinks(pipeline: PipelineLinkRecord, repository: string | null, cache: ForgeCacheView): ResolvedWorkLinks {
  const drafts: LinkDraft[] = manualDrafts(pipeline.workLinks);
  const view = repository ? cache.repository(repository) : null;
  if (repository) {
    const deliveryPr = pipeline.delivery?.target.pr;
    if (deliveryPr) drafts.push({ repository, number: deliveryPr, kind: "pr", source: "auto", via: ["delivery-pr"] });
    const seen = new Set<number>();
    for (const run of pipeline.runs ?? []) for (const attempt of run.attempts ?? []) {
      const number = attempt.report?.provenance?.pullRequest?.number;
      if (!Number.isSafeInteger(number) || !number || seen.has(number)) continue;
      seen.add(number);
      drafts.push({ repository, number, kind: "pr", source: "auto", via: ["provenance"] });
    }
    if (view) {
      const heads: Array<[string, WorkLinkVia]> = [[pipeline.branch, "lane-branch"]];
      const deliveryBranch = pipeline.delivery?.target.branch ? stripHeads(pipeline.delivery.target.branch) : "";
      if (deliveryBranch) heads.push([deliveryBranch, "delivery-branch"]);
      for (const [head, via] of heads) {
        if (!head) continue;
        for (const pr of view.byHead(head)) {
          if (pr.number !== deliveryPr && pipeline.createdAt && pr.createdAt < pipeline.createdAt) continue;
          drafts.push({ repository, number: pr.number, kind: "pr", source: "auto", via: [via] });
        }
      }
    }
  }
  const found = materialize(drafts, cache);
  const closes: LinkDraft[] = [];
  for (const link of found) {
    if (link.kind !== "pr") continue;
    for (const issue of cache.repository(link.repository)?.pr(link.number)?.closes ?? []) {
      closes.push({ repository: link.repository, number: issue, kind: "issue", source: "auto", via: ["closes"] });
    }
  }
  const links = mergeWorkLinks([found, materialize(closes, cache)]);
  const hasPr = found.some((link) => link.kind !== "issue");
  return { links, noPr: Boolean(repository && view?.completeSince && !hasPr) };
}

/** A task's card: its own manual links and the links of every pipeline it
    carries, deduplicated. A task never says "no PR": many are chat work. */
export function resolveTaskLinks(
  task: { workLinks?: StoredWorkLink[] },
  pipelines: readonly ResolvedWorkLinks[],
  cache: ForgeCacheView,
): ResolvedWorkLinks {
  const own = materialize(manualDrafts(task.workLinks), cache);
  return { links: mergeWorkLinks([own, ...pipelines.map((entry) => entry.links)]), noPr: false };
}

/* ── Stored-link edits ──────────────────────────────────────────────────── */

export type WorkLinkEdit =
  | { ok: true; links: StoredWorkLink[]; changed: boolean }
  | { ok: false; error: string; status: number; code: string };

/**
 * Applies attach and detach sets to a record's manual links. An attach that
 * already exists is a no-op; a detach removes only manual links, and one that
 * names a link the record never attached is a no-op too. `autoKeys` answers
 * which keys the record's own evidence produces, so a detach of one of those
 * says why it changes nothing rather than pretending it worked.
 */
export function editStoredWorkLinks(
  current: readonly StoredWorkLink[] | undefined,
  attach: readonly NormalizedWorkLink[],
  detach: readonly NormalizedWorkLink[],
  meta: { now: string; addedBy: StoredWorkLink["addedBy"]; canonical?: (repository: string) => string },
  autoVia?: (link: NormalizedWorkLink) => WorkLinkVia[] | null,
): WorkLinkEdit {
  const canonical = meta.canonical ?? ((repository: string) => repository);
  const same = (a: { repository: string; number: number }, b: { repository: string; number: number }) =>
    a.number === b.number && canonical(a.repository) === canonical(b.repository);
  let links = [...(current ?? [])];
  let changed = false;
  for (const target of detach) {
    const kept = links.filter((link) => !same(link, target));
    if (kept.length !== links.length) {
      links = kept;
      changed = true;
      continue;
    }
    const via = autoVia?.(target);
    if (via?.length) {
      return {
        ok: false,
        status: 409,
        code: "WORK_LINK_AUTO",
        error: `#${target.number} is found automatically (${via.join(", ")}), not attached by hand, so there is nothing to detach`,
      };
    }
  }
  for (const target of attach) {
    const existing = links.findIndex((link) => same(link, target));
    if (existing >= 0) {
      const prior = links[existing]!;
      if (target.kind && prior.kind !== target.kind) {
        links[existing] = { ...prior, kind: target.kind };
        changed = true;
      }
      continue;
    }
    if (links.length >= MAX_WORK_LINKS) {
      return {
        ok: false,
        status: 409,
        code: "WORK_LINK_LIMIT",
        error: `a record carries at most ${MAX_WORK_LINKS} attached links; detach one first. Attached: ${links.map((link) => `${link.repository}#${link.number}`).join(", ")}`,
      };
    }
    links.push({ repository: target.repository, number: target.number, kind: target.kind, addedAt: meta.now, addedBy: meta.addedBy });
    changed = true;
  }
  return { ok: true, links, changed };
}
