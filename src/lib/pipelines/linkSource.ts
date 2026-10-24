import type { GithubRunner } from "@/lib/monitor/githubEvidence";
import {
  githubRepositoryOfRemote,
  normalizeWorkLinkInput,
  workLinkUrl,
  type ForgeCacheView,
  type WorkLinkKind,
} from "@/lib/forge/workLinks";
import type { BoardTask } from "@/lib/tasks/types";
import type { ExecPort } from "@/lib/workflows/provision";

import { MAX_TASK_LENGTH } from "./limits";
import type { CreatePipelineRequest, Pipeline } from "./types";

/*
 * A pasted PR or issue link, turned into a draft pipeline's request
 * (docs/research/competitors-2026-10.md, rank 4). Read-only: one or two
 * `gh api` reads and local `git remote` reads; nothing is fetched, created or
 * written. The draft itself is created through the ordinary create path and
 * starts only on the ordinary Start action.
 */

export type PipelineLinkRefusalCode =
  | "invalid"
  | "not_found"
  | "closed"
  | "merged"
  | "head_deleted"
  | "no_origin"
  | "repository_mismatch"
  | "forge_unavailable";

export type PipelineLinkTask = { id: string; text: string; updatedAt: string };

export type PipelineLinkSource = {
  kind: WorkLinkKind;
  /** `<owner>/<repo>`, as the forge names it today, lower-cased. */
  repository: string;
  number: number;
  url: string;
  title: string;
  /** A refused link never gets this far, so only open work remains. */
  state: "open" | "draft";
  base: { branch: string };
  /** The PR's head; null for an issue, whose draft gets a new lane branch. */
  head: {
    branch: string;
    sha: string;
    /** `<owner>/<repo>` holding the head branch. */
    repository: string;
    /** The configured remote whose fetch and push URLs all name the head
        repository, or the head repository's URL when none does. */
    remote: string;
    fork: boolean;
    /** Forks only: false when GitHub refuses pushes from the base's maintainers. */
    maintainerCanModify: boolean | null;
  } | null;
  /** Open tasks of this project whose work links already name the link,
      newest first. The draft joins the first unless the operator picks
      another. */
  tasks: PipelineLinkTask[];
  /** The create fields the draft takes from the link. */
  request: Pick<CreatePipelineRequest, "task" | "spec" | "baseBranch" | "delivery">;
  /** An issue is attached to the draft by hand, since nothing in a new lane
      names it; a PR is found through `delivery.pr`. */
  attachLink: string | null;
};

export type PipelineLinkResolution =
  | { ok: true; source: PipelineLinkSource }
  | { ok: false; code: PipelineLinkRefusalCode; error: string; params?: Record<string, string | number> };

export type PipelineLinkPorts = {
  gh: GithubRunner;
  exec: ExecPort;
  tasks: () => readonly BoardTask[];
  pipelines: () => readonly Pipeline[];
  projectForCwd: (cwd: string) => string | null;
  /** Every link a task carries, by repository and number. */
  taskLinks: (task: BoardTask, pipelines: readonly Pipeline[]) => ReadonlyArray<{ repository: string; number: number; kind: WorkLinkKind | null }>;
  cache: ForgeCacheView;
};

const refuse = (code: PipelineLinkRefusalCode, error: string, params?: Record<string, string | number>): PipelineLinkResolution =>
  ({ ok: false, code, error, ...(params ? { params } : {}) });

/** A configured remote and the GitHub repository each of its URLs names
    (null: not GitHub), as Git itself resolves them: `insteadOf` rewrites
    applied, and `pushurl` (every one of them) where it is set. */
type Remote = { name: string; fetch: Array<string | null>; push: Array<string | null> };

/** Every remote of the checkout with its effective fetch and push URLs. */
async function checkoutRemotes(repoDir: string, exec: ExecPort): Promise<Remote[] | null> {
  const git = (args: string[]) => exec("git", args, repoDir, undefined, { timeoutMs: 10_000 });
  const names = await git(["remote"]);
  if (names.code !== 0) return null;
  const remotes: Remote[] = [];
  for (const name of names.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const fetch = await git(["remote", "get-url", "--all", name]);
    const push = await git(["remote", "get-url", "--push", "--all", name]);
    if (fetch.code !== 0 || push.code !== 0) return null;
    const repositories = (stdout: string) => stdout.split("\n").map((line) => line.trim()).filter(Boolean).map(githubRepositoryOfRemote);
    remotes.push({ name, fetch: repositories(fetch.stdout), push: repositories(push.stdout) });
  }
  return remotes;
}

/** Whether a lane delivering through `remote` reads and writes `repository`
    and nothing else: a remote whose push URL names another repository would
    publish the lane there, and one whose fetch URL differs fails the
    publication's own fence. */
function remoteNames(remote: Remote, repository: string, canonical: (repository: string) => string): boolean {
  const urls = [...remote.fetch, ...remote.push];
  return urls.length > 0 && urls.every((url) => url !== null && canonical(url) === repository);
}

/** The forge's own JSON for one REST path; a 404 is `null`, any other failure throws. */
async function ghJson(gh: GithubRunner, apiPath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await gh(["api", "--method", "GET", apiPath]);
  } catch (error) {
    const text = `${(error as { stderr?: unknown }).stderr ?? ""} ${error instanceof Error ? error.message : String(error)}`;
    if (/HTTP 404|Not Found/i.test(text)) return null;
    throw new Error(text.trim().split("\n").find(Boolean)?.slice(0, 300) ?? "gh failed");
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("gh returned no JSON object");
  return parsed as Record<string, unknown>;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const repoName = (value: unknown): string => str((value as { full_name?: unknown } | null)?.full_name).toLowerCase();

function draftTask(kind: WorkLinkKind, number: number, title: string): string {
  const text = `${kind === "pr" ? "PR" : "Issue"} #${number}: ${title.trim() || "untitled"}`;
  return text.length > MAX_TASK_LENGTH ? text.slice(0, MAX_TASK_LENGTH) : text;
}

/**
 * Resolves `link` against the checkout at `repoDir` (already admitted by the
 * repository preflight). The checkout's `origin` is the repository a bare
 * number means and the one the link must belong to: a lane fetches its base
 * from `origin`, so a link into any other repository is refused by name.
 */
export async function resolvePipelineLink(link: string, repoDir: string, ports: PipelineLinkPorts): Promise<PipelineLinkResolution> {
  const remotes = await checkoutRemotes(repoDir, ports.exec);
  if (!remotes) return refuse("forge_unavailable", "could not read this checkout's remotes; retry");
  const origin = remotes.find((remote) => remote.name === "origin")?.fetch[0] ?? null;
  const parsed = normalizeWorkLinkInput(link, { repository: origin });
  if (!parsed.ok) return refuse("invalid", parsed.error);
  const canonical = (repository: string) => (ports.cache.repository(repository)?.canonical ?? repository).toLowerCase();
  const { number } = parsed.link;
  const repository = canonical(parsed.link.repository);
  if (!origin) return refuse("no_origin", "this checkout has no GitHub origin, so a lane cannot fetch a base for the link", { repository });
  if (canonical(origin) !== repository) {
    return refuse("repository_mismatch", `the link is in ${repository}, and this checkout's origin is ${canonical(origin)}; choose a checkout whose origin is ${repository}`,
      { repository, origin: canonical(origin) });
  }

  let kind: WorkLinkKind | null = parsed.link.kind;
  let issue: Record<string, unknown> | null = null;
  try {
    if (kind !== "pr") {
      issue = await ghJson(ports.gh, `repos/${repository}/issues/${number}`);
      if (!issue) return refuse("not_found", `#${number} was not found in ${repository}, or this machine's GitHub sign-in cannot see it`, { repository, number });
      /* GitHub answers a PR number on the issues path too. */
      kind = issue.pull_request ? "pr" : "issue";
    }
    if (kind === "issue") {
      if (str(issue!.state) !== "open") return refuse("closed", `issue #${number} in ${repository} is closed`, { repository, number });
      const repo = await ghJson(ports.gh, `repos/${repository}`);
      const baseBranch = str(repo?.default_branch);
      if (!baseBranch) return refuse("forge_unavailable", `GitHub returned no default branch for ${repository}`);
      const title = str(issue!.title);
      const url = str(issue!.html_url) || workLinkUrl(repository, number, "issue");
      return { ok: true, source: {
        kind, repository, number, url, title, state: "open",
        base: { branch: baseBranch }, head: null,
        tasks: linkedTasks(repository, number, kind, repoDir, ports, canonical),
        request: { task: draftTask(kind, number, title), spec: `Source: ${url}`, baseBranch },
        attachLink: `${repository}#${number}`,
      } };
    }
    const pr = await ghJson(ports.gh, `repos/${repository}/pulls/${number}`);
    if (!pr) return refuse("not_found", `PR #${number} was not found in ${repository}, or this machine's GitHub sign-in cannot see it`, { repository, number });
    if (pr.merged_at) return refuse("merged", `PR #${number} in ${repository} is already merged`, { repository, number });
    if (str(pr.state) !== "open") return refuse("closed", `PR #${number} in ${repository} is closed`, { repository, number });
    const base = pr.base as Record<string, unknown> | null;
    const head = pr.head as Record<string, unknown> | null;
    const headRepository = repoName(head?.repo);
    const headBranch = str(head?.ref);
    const headSha = str(head?.sha);
    if (!headRepository || !headBranch || !/^[0-9a-f]{40}$/i.test(headSha)) {
      return refuse("head_deleted", `PR #${number}'s head repository or branch no longer exists`, { repository, number });
    }
    const baseBranch = str(base?.ref);
    if (!baseBranch) return refuse("forge_unavailable", `GitHub returned no base branch for PR #${number}`);
    const headCanonical = canonical(headRepository);
    const fork = headCanonical !== repository;
    /* The configured remote that reads and pushes the head repository, origin
       first; else the head repository's own URL, which no configuration of
       this checkout can redirect. */
    const remote = [...remotes].sort((a, b) => Number(b.name === "origin") - Number(a.name === "origin"))
      .find((candidate) => remoteNames(candidate, headCanonical, canonical))?.name
      ?? `https://github.com/${headRepository}.git`;
    const title = str(pr.title);
    const url = str(pr.html_url) || workLinkUrl(repository, number, "pr");
    return { ok: true, source: {
      kind: "pr", repository, number, url, title, state: pr.draft === true ? "draft" : "open",
      base: { branch: baseBranch },
      head: { branch: headBranch, sha: headSha.toLowerCase(), repository: headRepository, remote, fork,
        maintainerCanModify: fork ? pr.maintainer_can_modify === true : null },
      tasks: linkedTasks(repository, number, "pr", repoDir, ports, canonical),
      request: {
        task: draftTask("pr", number, title),
        spec: `Source: ${url}`,
        baseBranch,
        /* A fork's PR number names a PR of this repository, never of the
           fork the lane pushes to. */
        delivery: { branch: `refs/heads/${headBranch}`, remote, pr: number, ...(fork ? { prRepository: repository } : {}) },
      },
      attachLink: null,
    } };
  } catch (error) {
    return refuse("forge_unavailable", `GitHub could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function linkedTasks(
  repository: string, number: number, kind: WorkLinkKind, repoDir: string,
  ports: PipelineLinkPorts, canonical: (repository: string) => string,
): PipelineLinkTask[] {
  const project = ports.projectForCwd(repoDir);
  if (!project) return [];
  const candidates = ports.tasks().filter((task) => task.project === project && task.status !== "done");
  if (!candidates.length) return [];
  const pipelines = ports.pipelines();
  return candidates
    .filter((task) => ports.taskLinks(task, pipelines).some((link) => link.number === number
      && (link.kind === kind || link.kind === null) && canonical(link.repository) === repository))
    /* Instants: a stored stamp may be written with or without milliseconds. */
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.id.localeCompare(b.id))
    .map((task) => ({ id: task.id, text: task.text.split("\n")[0]!.slice(0, 200), updatedAt: task.updatedAt }));
}
