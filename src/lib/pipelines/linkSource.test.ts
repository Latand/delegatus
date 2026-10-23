import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { forgeViewOf } from "@/lib/forge/cache";
import { taskWorkLinks } from "@/lib/forge/resolve";
import { EMPTY_FORGE_CACHE, resolvePipelineLinks, resolveTaskLinks, type ForgeCacheView } from "@/lib/forge/workLinks";
import type { BoardTask } from "@/lib/tasks/types";
import { realExec } from "@/lib/workflows/provision";

import { resolvePipelineLink, type PipelineLinkPorts } from "./linkSource";
import type { Pipeline } from "./types";

/* The pasted-link resolver (docs/research/competitors-2026-10.md rank 4).
   Every forge answer is a fixed fixture; nothing reaches GitHub, and only the
   URL-rewrite cases read a real Git checkout. */

const REPO_DIR = "/work/project";
const PROJECT = "repo-project";
const HEAD_SHA = "a".repeat(40);
const ORIGIN_URL = "https://github.com/Owner/Project.git";

type Answers = Record<string, unknown | Error>;

function prJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 41, title: "Teach the picker links", state: "open", draft: false, merged_at: null,
    html_url: "https://github.com/owner/project/pull/41", maintainer_can_modify: true,
    base: { ref: "release", sha: "b".repeat(40), repo: { full_name: "Owner/Project" } },
    head: { ref: "feature/links", sha: HEAD_SHA, repo: { full_name: "Owner/Project" } },
    ...overrides,
  };
}

function task(id: string, overrides: Partial<BoardTask> = {}): BoardTask {
  return { id, project: PROJECT, status: "assigned", text: `Task ${id}\nmore`, updatedAt: "2026-10-20T10:00:00.000Z",
    placement: "unplaced", assignments: [], createdAt: "2026-10-01T00:00:00.000Z", ...overrides } as unknown as BoardTask;
}

/** A checkout's remotes as Git resolves them: fetch URLs, and push URLs when
    they differ (`pushurl`). */
type Remotes = Record<string, { url: string[]; push?: string[] }>;

function ports(options: {
  answers?: Answers; remotes?: Remotes; remotesCode?: number; tasks?: BoardTask[]; pipelines?: Pipeline[]; project?: string | null;
  cache?: ForgeCacheView;
} = {}): PipelineLinkPorts & { ghCalls: string[][] } {
  const ghCalls: string[][] = [];
  const answers = options.answers ?? {};
  return {
    ghCalls,
    gh: async (args) => {
      ghCalls.push(args);
      const answer = answers[args.at(-1)!];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw Object.assign(new Error("Command failed: gh api"), { stderr: "gh: Not Found (HTTP 404)" });
      return JSON.stringify(answer);
    },
    exec: (command, args) => {
      expect(command).toBe("git");
      const remotes = options.remotes ?? { origin: { url: [ORIGIN_URL] } };
      if (args.length === 1 && args[0] === "remote") return { code: options.remotesCode ?? 0, stdout: Object.keys(remotes).map((name) => `${name}\n`).join(""), stderr: "" };
      /* A literal URL's effective URLs, read through a command-line remote: no rewrites here. */
      if (args[0] === "-c") {
        const [, probe, url] = /^remote\.([^=]+)\.url=(.*)$/.exec(args[1]!)!;
        expect(args.slice(2)).toEqual(["remote", "-v"]);
        expect(Object.keys(remotes)).not.toContain(probe);
        return { code: 0, stdout: `${probe}\t${url} (fetch)\n${probe}\t${url} (push)\n`, stderr: "" };
      }
      const name = args.at(-1)!;
      expect(args).toEqual(["remote", "get-url", ...(args.includes("--push") ? ["--push"] : []), "--all", name]);
      const remote = remotes[name]!;
      return { code: 0, stdout: (args.includes("--push") ? remote.push ?? remote.url : remote.url).map((url) => `${url}\n`).join(""), stderr: "" };
    },
    tasks: () => options.tasks ?? [],
    pipelines: () => options.pipelines ?? [],
    projectForCwd: (cwd) => (cwd === REPO_DIR ? options.project === undefined ? PROJECT : options.project : null),
    /* The board's own join, against an empty forge cache and a known repository. */
    taskLinks: options.cache
      /* The production join the source route uses, over the given cache. */
      ? (entry, pipelines) => taskWorkLinks(entry, pipelines, options.cache).links
      : (entry, pipelines) => resolveTaskLinks(entry,
        pipelines.filter((pipeline) => pipeline.taskIds?.includes(entry.id)).map((pipeline) => resolvePipelineLinks(pipeline, "owner/project", EMPTY_FORGE_CACHE)),
        EMPTY_FORGE_CACHE, "owner/project").links,
    cache: options.cache ?? EMPTY_FORGE_CACHE,
  };
}

test("a same-repository PR resolves its base, head and an origin delivery to the PR branch", async () => {
  const p = ports({ answers: { "repos/owner/project/pulls/41": prJson() } });
  const result = await resolvePipelineLink("https://github.com/Owner/Project/pull/41/files", REPO_DIR, p);
  expect(result).toEqual({ ok: true, source: {
    kind: "pr", repository: "owner/project", number: 41, url: "https://github.com/owner/project/pull/41",
    title: "Teach the picker links", state: "open",
    base: { branch: "release" },
    head: { branch: "feature/links", sha: HEAD_SHA, repository: "owner/project", remote: "origin", fork: false, maintainerCanModify: null },
    tasks: [],
    request: {
      task: "PR #41: Teach the picker links",
      spec: "Source: https://github.com/owner/project/pull/41",
      baseBranch: "release",
      delivery: { branch: "refs/heads/feature/links", remote: "origin", pr: 41 },
    },
    attachLink: null,
  } });
  /* One read: a pull URL names its kind. */
  expect(p.ghCalls).toEqual([["api", "--method", "GET", "repos/owner/project/pulls/41"]]);
});

test("a fork PR delivers through the remote that names the fork", async () => {
  const p = ports({
    remotes: { origin: { url: [ORIGIN_URL] }, contributor: { url: ["https://github.com/Contributor/Project.git"] }, mirror: { url: ["/srv/mirror.git"] } },
    answers: {
      "repos/owner/project/issues/41": { number: 41, state: "open", pull_request: { url: "x" } },
      "repos/owner/project/pulls/41": prJson({ draft: true, head: { ref: "main", sha: HEAD_SHA, repo: { full_name: "Contributor/Project" } } }),
    },
  });
  const result = await resolvePipelineLink("owner/project#41", REPO_DIR, p);
  if (!result.ok) throw new Error(result.error);
  expect(result.source.state).toBe("draft");
  expect(result.source.head).toEqual({ branch: "main", sha: HEAD_SHA, repository: "contributor/project", remote: "contributor", fork: true, maintainerCanModify: true });
  /* The PR number names a PR of the upstream, which the delivery carries. */
  expect(result.source.request.delivery).toEqual({ branch: "refs/heads/main", remote: "contributor", pr: 41, prRepository: "owner/project" });
  /* `owner/repo#N` names no kind, so the issues path told a PR apart first. */
  expect(p.ghCalls.map((call) => call.at(-1))).toEqual(["repos/owner/project/issues/41", "repos/owner/project/pulls/41"]);
});

test("a fork no remote names is delivered to by URL, and a locked fork says so", async () => {
  const p = ports({ answers: { "repos/owner/project/pulls/41": prJson({ maintainer_can_modify: false, head: { ref: "fix", sha: HEAD_SHA, repo: { full_name: "Someone/Project" } } }) } });
  const result = await resolvePipelineLink("https://github.com/owner/project/pull/41", REPO_DIR, p);
  if (!result.ok) throw new Error(result.error);
  expect(result.source.head).toMatchObject({ remote: "https://github.com/someone/project.git", fork: true, maintainerCanModify: false });
  expect(result.source.request.delivery).toEqual({ branch: "refs/heads/fix", remote: "https://github.com/someone/project.git", pr: 41, prRepository: "owner/project" });
});

/** Real Git in a temporary checkout: an origin on the upstream and a
    `contributor` remote on the fork, plus a bare repository a rewrite can
    send the fork's URL to. */
async function withCheckout(run: (checkout: string, other: string, git: (...args: string[]) => Promise<void>) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "link-source-"));
  const checkout = path.join(root, "checkout");
  const other = path.join(root, "other.git");
  const git = async (...args: string[]) => {
    const result = await realExec("git", args, checkout);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  };
  try {
    fs.mkdirSync(checkout);
    await git("init", "-q", "-b", "main");
    await git("init", "-q", "--bare", other);
    await git("remote", "add", "origin", ORIGIN_URL);
    await git("remote", "add", "contributor", "https://github.com/contributor/project.git");
    await run(checkout, other, git);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("a fork URL that this checkout's Git rewrites send to another repository is refused, through a real checkout", async () => {
  const answers = { "repos/owner/project/pulls/41": prJson({ head: { ref: "fix", sha: HEAD_SHA, repo: { full_name: "Contributor/Project" } } }) };
  const resolve = (checkout: string) => resolvePipelineLink("https://github.com/owner/project/pull/41", checkout, { ...ports({ answers }), exec: realExec });
  await withCheckout(async (checkout, other, git) => {
    expect(await resolve(checkout)).toMatchObject({ ok: true, source: { request: { delivery: { remote: "contributor", prRepository: "owner/project" } } } });
    /* A rewrite of every https remote to ssh keeps each on its repository. */
    await git("config", "url.ssh://github.com/.insteadOf", "https://github.com/");
    expect(await resolve(checkout)).toMatchObject({ ok: true, source: { request: { delivery: { remote: "contributor" } } } });
    await git("config", "--unset", "url.ssh://github.com/.insteadOf");
    for (const key of ["pushInsteadOf", "insteadOf"]) {
      /* The rewrite takes the contributor remote and the fork's own URL alike, so nothing can deliver to the fork. */
      await git("config", `url.${other}.${key}`, "https://github.com/contributor/project.git");
      const refused = await resolve(checkout);
      expect(refused).toMatchObject({ ok: false, code: "remote_rewritten", params: { repository: "contributor/project" } });
      if (!refused.ok) expect(refused.error).toContain("https://github.com/contributor/project.git to another repository than contributor/project");
      await git("config", "--unset", `url.${other}.${key}`);
    }
    /* With the rewrite on the contributor remote alone, the fork's own URL still reaches the fork. */
    await git("remote", "set-url", "--push", "contributor", other);
    expect(await resolve(checkout)).toMatchObject({ ok: true, source: { request: { delivery: { remote: "https://github.com/contributor/project.git" } } } });
  });
});

test("a fork PR's task is found by its own number only, never by another fork's PR on the same head name", async () => {
  /* Two forks each open a PR from their `main`; the upstream's cache holds both under one head name. */
  const cache = forgeViewOf({ schemaVersion: 1, repositories: { "owner/project": {
    canonical: null, completeSince: "2026-10-01T00:00:00Z", lastSweepAt: null, lastAttemptAt: null, lastError: null, issues: {},
    prs: {
      "41": { url: "https://github.com/owner/project/pull/41", headRefName: "main", createdAt: "2026-10-02T00:00:00Z", state: "open", closes: [], checkedAt: "2026-10-03T00:00:00Z" },
      "42": { url: "https://github.com/owner/project/pull/42", headRefName: "main", createdAt: "2026-10-04T00:00:00Z", state: "open", closes: [], checkedAt: "2026-10-05T00:00:00Z" },
    },
  } } });
  const laneA = { id: "laneA", project: PROJECT, taskIds: ["task-a"], branch: "pipeline/fork-a-laneA", createdAt: "2026-10-03T00:00:00Z", runs: [],
    delivery: { target: { repository: "repo-fork-a", remote: "https://github.com/fork-a/project.git", branch: "refs/heads/main", pr: 41, prRepository: "owner/project" } },
  } as unknown as Pipeline;
  const forkPr = (number: number, fork: string) => prJson({ number, html_url: `https://github.com/owner/project/pull/${number}`, head: { ref: "main", sha: HEAD_SHA, repo: { full_name: fork } } });
  const answers = { "repos/owner/project/pulls/41": forkPr(41, "fork-a/project"), "repos/owner/project/pulls/42": forkPr(42, "fork-b/project") };
  const p = ports({ answers, tasks: [task("task-a")], pipelines: [laneA], cache });
  const tasksOf = async (number: number) => {
    const result = await resolvePipelineLink(`https://github.com/owner/project/pull/${number}`, REPO_DIR, p);
    if (!result.ok) throw new Error(result.error);
    return result.source.tasks.map((entry) => entry.id);
  };
  expect(await tasksOf(41)).toEqual(["task-a"]);
  expect(await tasksOf(42)).toEqual([]);
  /* The lane's card carries its own PR, in the upstream, and not the other fork's. */
  expect(taskWorkLinks(task("task-a"), [laneA], cache).links.map((link) => `${link.repository}#${link.number}`)).toEqual(["owner/project#41"]);
});

test("a remote is chosen only when every fetch and push URL names the head repository", async () => {
  const forkPr = prJson({ head: { ref: "fix", sha: HEAD_SHA, repo: { full_name: "Contributor/Project" } } });
  const deliveryOf = async (remotes: Remotes, pr = forkPr) => {
    const result = await resolvePipelineLink("https://github.com/owner/project/pull/41", REPO_DIR, ports({ remotes, answers: { "repos/owner/project/pulls/41": pr } }));
    if (!result.ok) throw new Error(result.error);
    expect(result.source.head!.remote).toBe(result.source.request.delivery!.remote!);
    return result.source.request.delivery!.remote;
  };
  /* A fork remote whose pushurl names another repository would publish there. */
  expect(await deliveryOf({ origin: { url: [ORIGIN_URL] }, contributor: { url: ["https://github.com/contributor/project.git"], push: ["ssh://github.com/elsewhere/project.git"] } }))
    .toBe("https://github.com/contributor/project.git");
  /* One of several pushurls naming another repository is enough to refuse the remote. */
  expect(await deliveryOf({ origin: { url: [ORIGIN_URL] }, contributor: { url: ["https://github.com/contributor/project.git"], push: ["ssh://github.com/contributor/project.git", "/srv/backup.git"] } }))
    .toBe("https://github.com/contributor/project.git");
  /* A fetch URL elsewhere fails the publication's own fetch fence, so it is not chosen either. */
  expect(await deliveryOf({ origin: { url: [ORIGIN_URL] }, contributor: { url: ["https://github.com/elsewhere/project.git"], push: ["ssh://github.com/contributor/project.git"] } }))
    .toBe("https://github.com/contributor/project.git");
  /* Separate fetch and push URLs of the same fork are one repository. */
  expect(await deliveryOf({ origin: { url: [ORIGIN_URL] }, contributor: { url: ["https://github.com/contributor/project.git"], push: ["ssh://github.com/Contributor/Project.git"] } }))
    .toBe("contributor");
  /* A same-repository PR: origin whose pushurl names another repository is passed over for a remote that names it, else its URL. */
  const samePr = prJson();
  expect(await deliveryOf({ origin: { url: [ORIGIN_URL], push: ["ssh://github.com/mirror/project.git"] } }, samePr)).toBe("https://github.com/owner/project.git");
  expect(await deliveryOf({ origin: { url: [ORIGIN_URL], push: ["ssh://github.com/mirror/project.git"] }, upstream: { url: [ORIGIN_URL] } }, samePr)).toBe("upstream");
  expect(await deliveryOf({ origin: { url: [ORIGIN_URL], push: ["ssh://github.com/owner/project.git"] }, upstream: { url: [ORIGIN_URL] } }, samePr)).toBe("origin");
});

test("a same-repository PR whose origin pushes elsewhere still names no prRepository, and the preview shows where it pushes", async () => {
  const result = await resolvePipelineLink("https://github.com/owner/project/pull/41", REPO_DIR, ports({
    remotes: { origin: { url: [ORIGIN_URL], push: ["ssh://github.com/mirror/project.git"] } }, answers: { "repos/owner/project/pulls/41": prJson() } }));
  if (!result.ok) throw new Error(result.error);
  expect(result.source.head).toMatchObject({ repository: "owner/project", remote: "https://github.com/owner/project.git", fork: false });
  expect(result.source.request.delivery).toEqual({ branch: "refs/heads/feature/links", remote: "https://github.com/owner/project.git", pr: 41 });
});

test("an issue resolves to a new lane on the default branch with the issue attached", async () => {
  const p = ports({ answers: {
    "repos/owner/project/issues/7": { number: 7, title: "Links should start work", state: "open", html_url: "https://github.com/owner/project/issues/7" },
    "repos/owner/project": { default_branch: "trunk" },
  } });
  const result = await resolvePipelineLink("https://github.com/owner/project/issues/7", REPO_DIR, p);
  expect(result).toEqual({ ok: true, source: {
    kind: "issue", repository: "owner/project", number: 7, url: "https://github.com/owner/project/issues/7",
    title: "Links should start work", state: "open", base: { branch: "trunk" }, head: null, tasks: [],
    request: { task: "Issue #7: Links should start work", spec: "Source: https://github.com/owner/project/issues/7", baseBranch: "trunk" },
    attachLink: "owner/project#7",
  } });
});

test("an issue URL that names a PR, and a bare number in the checkout's origin, both resolve as the PR", async () => {
  const answers = {
    "repos/owner/project/issues/41": { number: 41, state: "open", pull_request: { url: "x" } },
    "repos/owner/project/pulls/41": prJson(),
  };
  for (const link of ["https://github.com/owner/project/issues/41", "#41"]) {
    const result = await resolvePipelineLink(link, REPO_DIR, ports({ answers }));
    if (!result.ok) throw new Error(result.error);
    expect(result.source).toMatchObject({ kind: "pr", number: 41, request: { delivery: { pr: 41 } } });
  }
});

test("open tasks already linked to the link are found, newest first; done, unlinked and other projects are not", async () => {
  const lane = { id: "lane1", taskIds: ["via-lane"], branch: "pipeline/x", createdAt: "2026-10-01T00:00:00Z",
    delivery: { target: { repository: "repo-x", remote: ORIGIN_URL, branch: "refs/heads/feature/links", pr: 41 } }, runs: [] } as unknown as Pipeline;
  const manual = (number: number, kind: "pr" | "issue" | null) => [{ repository: "owner/project", number, kind, addedAt: "2026-10-01T00:00:00Z", addedBy: "operator" as const }];
  const tasks = [
    task("manual-old", { workLinks: manual(41, "pr"), updatedAt: "2026-10-19T09:00:00Z" }),
    task("via-lane", { updatedAt: "2026-10-21T09:00:00.000Z" }),
    task("unknown-kind", { workLinks: manual(41, null), updatedAt: "2026-10-20T09:00:00.5Z" }),
    task("issue-same-number", { workLinks: manual(41, "issue"), updatedAt: "2026-10-22T09:00:00Z" }),
    task("done", { workLinks: manual(41, "pr"), status: "done" } as Partial<BoardTask>),
    task("elsewhere", { workLinks: manual(41, "pr"), project: "repo-other" }),
    task("unlinked"),
  ];
  const result = await resolvePipelineLink("https://github.com/owner/project/pull/41", REPO_DIR,
    ports({ answers: { "repos/owner/project/pulls/41": prJson() }, tasks, pipelines: [lane] }));
  if (!result.ok) throw new Error(result.error);
  expect(result.source.tasks).toEqual([
    { id: "via-lane", text: "Task via-lane", updatedAt: "2026-10-21T09:00:00.000Z" },
    { id: "unknown-kind", text: "Task unknown-kind", updatedAt: "2026-10-20T09:00:00.5Z" },
    { id: "manual-old", text: "Task manual-old", updatedAt: "2026-10-19T09:00:00Z" },
  ]);
});

test("stale and unknown links are refused with a reason that names them", async () => {
  const cases: Array<[string, Answers, string, string]> = [
    ["https://github.com/owner/project/pull/41", {}, "not_found", "PR #41 was not found in owner/project"],
    ["https://github.com/owner/project/issues/9", {}, "not_found", "#9 was not found in owner/project"],
    ["https://github.com/owner/project/pull/41", { "repos/owner/project/pulls/41": prJson({ state: "closed", merged_at: "2026-10-02T00:00:00Z" }) }, "merged", "PR #41 in owner/project is already merged"],
    ["https://github.com/owner/project/pull/41", { "repos/owner/project/pulls/41": prJson({ state: "closed" }) }, "closed", "PR #41 in owner/project is closed"],
    ["https://github.com/owner/project/issues/9", { "repos/owner/project/issues/9": { number: 9, state: "closed" } }, "closed", "issue #9 in owner/project is closed"],
    ["https://github.com/owner/project/pull/41", { "repos/owner/project/pulls/41": prJson({ head: { ref: "gone", sha: HEAD_SHA, repo: null } }) }, "head_deleted", "PR #41's head repository or branch no longer exists"],
    ["https://github.com/owner/project/pull/41", { "repos/owner/project/pulls/41": new Error("gh: API rate limit exceeded (HTTP 403)") }, "forge_unavailable", "GitHub could not be read: gh: API rate limit exceeded (HTTP 403)"],
    ["https://gitlab.com/owner/project/-/merge_requests/3", {}, "invalid", "only github.com pull request and issue URLs"],
    ["https://github.com/other/project/pull/41", {}, "repository_mismatch", "the link is in other/project, and this checkout's origin is owner/project"],
  ];
  for (const [link, answers, code, error] of cases) {
    const result = await resolvePipelineLink(link, REPO_DIR, ports({ answers }));
    expect(result.ok).toBe(false);
    if (result.ok) continue;
    expect(result.code).toBe(code as never);
    expect(result.error).toContain(error);
  }
});

test("a checkout without a GitHub origin is refused, and a bare number names nothing there", async () => {
  const noRemote = ports({ remotes: {} });
  expect(await resolvePipelineLink("https://github.com/owner/project/pull/41", REPO_DIR, noRemote)).toMatchObject({ ok: false, code: "no_origin" });
  expect(await resolvePipelineLink("#41", REPO_DIR, noRemote)).toMatchObject({ ok: false, code: "invalid" });
  expect(noRemote.ghCalls).toEqual([]);
  const unreadable = ports({ remotesCode: 128 });
  expect(await resolvePipelineLink("#41", REPO_DIR, unreadable)).toMatchObject({ ok: false, code: "forge_unavailable" });
});
