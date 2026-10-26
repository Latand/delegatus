import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-gh-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { githubEvidenceSource, openIssuesForProposal, openIssuesRanked, openPullRequestsForRepo, rankOpenIssues } = await import("./githubEvidence");
type OpenIssueRow = import("./githubEvidence").OpenIssueRow;
const { evidenceFromGithub } = await import("./evidence");

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("github evidence", () => {
  test("reads pull requests and issues, and never writes", async () => {
    const invocations: string[][] = [];
    const source = githubEvidenceSource({
      cwd: SANDBOX,
      run: async (args) => {
        invocations.push(args);
        return args[0] === "pr"
          ? JSON.stringify([{ number: 737, title: "pipeline engine split", state: "OPEN", updatedAt: "2026-07-26T10:00:00Z" }])
          : JSON.stringify([{ number: 741, title: "recurring conversation monitor", state: "CLOSED", updatedAt: "2026-07-27T10:00:00Z" }]);
      },
    });
    const rows = await source();
    expect(rows.map((row) => row.number)).toEqual([737, 741]);
    expect(invocations.every((args) => args[1] === "list")).toBe(true);
    expect(invocations.flat()).not.toContain("create");

    const evidence = evidenceFromGithub(rows);
    expect(evidence[0]!.state).toBe("active");
    expect(evidence[1]!.state).toBe("terminal");
    expect(evidence[1]!.references).toEqual([741]);
  });

  test("garbage output is an error the run can degrade on, not a silent empty list", async () => {
    const source = githubEvidenceSource({ cwd: SANDBOX, run: async () => "not json" });
    expect(source()).rejects.toThrow(/parsable JSON/);
  });

  test("skips rows without a usable number", async () => {
    const source = githubEvidenceSource({ cwd: SANDBOX, run: async () => JSON.stringify([{ title: "no number" }, { number: 12, title: "ok", state: "OPEN" }]) });
    const rows = await source();
    expect(rows.map((row) => row.number)).toEqual([12, 12]);
  });
});

describe("open issues for the proactive slot", () => {
  test("open issues arrive with their titles and labels, which is what a ranking needs", async () => {
    const calls: string[][] = [];
    const issues = await openIssuesForProposal({
      cwd: "/srv/repo",
      run: async (args) => {
        calls.push(args);
        return JSON.stringify([
          { number: 1245, title: "the native seat tick", labels: [{ name: "design" }, { name: "monitor" }], updatedAt: "2026-08-28T10:00:00Z" },
          { number: 1105, title: "engine-side wake", labels: [], updatedAt: null },
        ]);
      },
    });
    expect(calls[0]).toEqual(["issue", "list", "--state", "open", "--limit", "40", "--json", "number,title,labels,updatedAt"]);
    expect(issues).toEqual([
      { number: 1245, title: "the native seat tick", labels: ["design", "monitor"], updatedAt: "2026-08-28T10:00:00Z" },
      { number: 1105, title: "engine-side wake", labels: [], updatedAt: null },
    ]);
  });

  test("a gh that is missing, unauthenticated or rate-limited degrades to no issues instead of failing the slot", async () => {
    expect(await openIssuesForProposal({ cwd: "/srv/repo", run: async () => { throw new Error("gh: command not found"); } })).toEqual([]);
    expect(await openIssuesForProposal({ cwd: "/srv/repo", run: async () => "not json" })).toEqual([]);
    expect(await openIssuesForProposal({ cwd: "/srv/repo", run: async () => "{}" })).toEqual([]);
  });

  test("open pull requests are read with the head branch that ties one to a lane (#1289)", async () => {
    const calls: string[][] = [];
    const pullRequests = await openPullRequestsForRepo({
      cwd: "/srv/repo",
      run: async (args) => {
        calls.push(args);
        return JSON.stringify([
          { number: 1289, title: "wake on a merge that is waiting", headRefName: "topic-merge-queue", createdAt: "2026-08-27T10:00:00Z", updatedAt: "2026-08-29T10:00:00Z" },
          { number: 1285, title: "stop replaying closed lanes", headRefName: "topic-closed-lanes", createdAt: "2026-08-27T11:00:00Z", updatedAt: null },
        ]);
      },
    });
    expect(calls[0]).toEqual(["pr", "list", "--state", "open", "--limit", "60", "--json", "number,title,headRefName,createdAt,updatedAt"]);
    expect(pullRequests).toEqual({
      ok: true,
      pullRequests: [
        { number: 1289, title: "wake on a merge that is waiting", headRefName: "topic-merge-queue", createdAt: "2026-08-27T10:00:00Z", updatedAt: "2026-08-29T10:00:00Z" },
        { number: 1285, title: "stop replaying closed lanes", headRefName: "topic-closed-lanes", createdAt: "2026-08-27T11:00:00Z", updatedAt: null },
      ],
    });
    /* Read-only, like every other question asked of this seam. */
    expect(calls.flat()).not.toContain("merge");
  });

  /* Dropping the unusable row was the same collapse by a shorter route: one
     row nobody can attribute to a lane turned a nonempty answer into an empty
     one, and an empty one is the claim that everything merged. */
  test("a single row with no head branch is malformed output, never a repository with nothing open", async () => {
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => JSON.stringify([{ number: 1289 }]) }))
      .toEqual({ ok: false, unavailable: "malformed-output" });
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => JSON.stringify([{ title: "no number", headRefName: "topic" }]) }))
      .toEqual({ ok: false, unavailable: "malformed-output" });
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => JSON.stringify([{ number: 1289, headRefName: "topic" }]) }))
      .toEqual({ ok: false, unavailable: "malformed-output" });
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => JSON.stringify(["a string"]) }))
      .toEqual({ ok: false, unavailable: "malformed-output" });
  });

  /* And the mixed array, which is the case the skip hid best: the valid rows
     make the answer look like a real one while the dropped row is exactly the
     pull request that might still be open. */
  test("one unusable row among valid ones fails the whole read rather than shortening it", async () => {
    const mixed = JSON.stringify([
      { number: 1289, title: "kept", headRefName: "topic-merge-queue", createdAt: "2026-08-27T10:00:00Z" },
      { number: 1290, title: "no head" },
    ]);
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => mixed }))
      .toEqual({ ok: false, unavailable: "malformed-output" });
  });

  /* Title and update time do not decide which lane owned the head. */
  test("a row with creation time is read even without title or update time", async () => {
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => JSON.stringify([{ number: 1289, headRefName: "topic", createdAt: "2026-08-27T10:00:00Z" }]) }))
      .toEqual({ ok: true, pullRequests: [{ number: 1289, title: "", headRefName: "topic", createdAt: "2026-08-27T10:00:00Z", updatedAt: null }] });
  });

  /* The distinction the whole reason rests on: a repository with everything
     merged answers, and answering is what makes the tick's silence mean
     something. An empty ANSWER is still an answer. */
  test("a repository with nothing open answers, rather than failing to answer", async () => {
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => "[]" })).toEqual({ ok: true, pullRequests: [] });
  });

  /* And its mirror image: none of these establishes that a pull request
     merged, so none of them may be handed on as the empty list that says so. */
  test("a gh that cannot answer is carried as a failure, never as an empty list", async () => {
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => { throw new Error("gh: command not found"); } }))
      .toEqual({ ok: false, unavailable: "command-failed" });
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => "not json" }))
      .toEqual({ ok: false, unavailable: "malformed-output" });
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => "{}" }))
      .toEqual({ ok: false, unavailable: "malformed-output" });
  });

  /* `execFile` reports the timeout it enforces as a killed child, and an
     outage reads differently from a misconfiguration to whoever is holding the
     journal line. */
  test("a gh killed at its timeout is named as a timeout", async () => {
    const killed = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => { throw killed; } }))
      .toEqual({ ok: false, unavailable: "timed-out" });
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); } }))
      .toEqual({ ok: false, unavailable: "timed-out" });
  });

  test("a row without a usable number is dropped rather than ranked as issue zero", async () => {
    const issues = await openIssuesForProposal({
      cwd: "/srv/repo",
      run: async () => JSON.stringify([{ title: "no number" }, "a string", { number: 7, title: "kept", labels: [{ name: 7 }] }]),
    });
    expect(issues).toEqual([{ number: 7, title: "kept", labels: [], updatedAt: null }]);
  });
});

/* docs/design/board-maintenance-report.md §7: open issues ranked only by the
   priority a project records (decision D2). */
describe("open issues ranked for the board maintenance report", () => {
  const issue = (number: number, overrides: Partial<OpenIssueRow> = {}): OpenIssueRow => ({
    number,
    title: `issue ${number}`,
    createdAt: `2026-07-${String(10 + (number % 10)).padStart(2, "0")}T10:00:00Z`,
    updatedAt: `2026-09-${String(10 + (number % 10)).padStart(2, "0")}T10:00:00Z`,
    labels: [],
    milestone: null,
    openBlockers: 0,
    closingPullRequests: 0,
    projectFields: {},
    ...overrides,
  });
  const rank = (issues: OpenIssueRow[], onBoard: number[] = []) => rankOpenIssues(issues, { totalCount: issues.length, onBoard: new Set(onBoard) });

  test("a Project Priority field ranks first, then Urgency, and names the option as found", () => {
    const ranking = rank([
      issue(1, { projectFields: { Priority: "🟡 Medium" } }),
      issue(2, { projectFields: { Priority: "🔴 Critical", Status: "Backlog" } }),
      issue(3, { projectFields: { Urgency: "Soon" } }),
      issue(4, { projectFields: { Priority: "Someday maybe" } }),
    ]);
    expect(ranking.ranked.map((row) => [row.number, row.tier])).toEqual([[2, 0], [3, 1], [1, 2], [4, 2]]);
    expect(ranking.ranked[0]!.tierSignal).toBe("Priority 🔴 Critical");
    expect(ranking.signals).toEqual(["Project Priority field", "Project Urgency field"]);
    expect(ranking.unranked).toEqual([]);
  });

  test("a priority label ranks where no Project field does, and readiness orders within a tier", () => {
    const ranking = rank([
      issue(10, { labels: ["priority: urgent"] }),
      issue(11, { labels: ["P1"] }),
      issue(12, { labels: ["P1", "ready"] }),
      issue(13, { labels: ["bug"] }),
    ]);
    expect(ranking.ranked.map((row) => row.number)).toEqual([10, 12, 11]);
    expect(ranking.ranked[0]!.tierSignal).toBe("label priority: urgent");
    expect(ranking.signals).toEqual(["priority label"]);
    expect(ranking.unranked.map((row) => row.number)).toEqual([13]);
  });

  test("a milestone ranks after every tiered issue, soonest due first and undated last", () => {
    const ranking = rank([
      issue(20, { milestone: { title: "later", dueOn: "2026-12-01T00:00:00Z" } }),
      issue(21, { milestone: { title: "sooner", dueOn: "2026-10-01T00:00:00Z" } }),
      issue(22, { milestone: { title: "someday", dueOn: null } }),
      issue(23, { labels: ["priority: low"] }),
    ]);
    expect(ranking.ranked.map((row) => row.number)).toEqual([23, 21, 20, 22]);
    expect(ranking.signals).toEqual(["priority label", "milestone"]);
  });

  test("readiness alone ranks nothing, and no signal ranks nothing: the rest stay unranked, newest first", () => {
    const ranking = rank([
      issue(30, { projectFields: { Status: "Ready" }, labels: ["ready"], updatedAt: "2026-09-01T00:00:00Z" }),
      issue(31, { updatedAt: "2026-09-20T00:00:00Z" }),
      issue(32, { labels: ["bug", "enhancement"], updatedAt: "2026-09-10T00:00:00Z" }),
    ]);
    expect(ranking.ranked).toEqual([]);
    expect(ranking.signals).toEqual([]);
    expect(ranking.unranked.map((row) => row.number)).toEqual([31, 32, 30]);
  });

  test("issues on the board, closed by an open pull request, blocked or not open for work are counted and never ranked", () => {
    const ranking = rank([
      issue(40, { labels: ["P0"] }),
      issue(41, { labels: ["P0"], closingPullRequests: 1 }),
      issue(42, { labels: ["P0"], openBlockers: 2 }),
      issue(43, { labels: ["P0"], projectFields: { Status: "🏗 In Progress" } }),
      issue(44, { labels: ["P0"], projectFields: { Status: "On Hold" } }),
      issue(45, { labels: ["P0"] }),
    ], [45]);
    expect(ranking.ranked.map((row) => row.number)).toEqual([40]);
    expect(ranking.excluded).toBe(5);
  });

  test("one graphql read, repeated once without Project fields when they are unreadable", async () => {
    const calls: string[][] = [];
    const page = JSON.stringify({ data: { repository: { issues: {
      totalCount: 1,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ number: 7, title: "Fix it", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
        labels: { nodes: [{ name: "priority: high" }] }, milestone: null, issueDependenciesSummary: { blockedBy: 0 },
        closedByPullRequestsReferences: { totalCount: 0 } }],
    } } } });
    const result = await openIssuesRanked({
      cwd: SANDBOX,
      repository: "owner-a/repo-a",
      onBoard: new Set(),
      run: async (args) => {
        calls.push(args);
        const query = args.find((arg) => arg.startsWith("query="))!;
        if (query.includes("projectItems")) throw Object.assign(new Error("Resource not accessible by integration"), { code: 1 });
        return page;
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((args) => args[0] === "api" && args[1] === "graphql")).toBe(true);
    /* Read-only: a query, never a mutation. */
    expect(calls.flat().join(" ")).not.toMatch(/\bmutation\b/);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ranking.projectFieldsUnreadable).toBe(true);
    expect(result.ranking.ranked.map((row) => [row.number, row.tier])).toEqual([[7, 1]]);
  });

  /* A fake repository of 304 open issues served the way GitHub pages them:
     newest update first, 100 a page, `labels[]` matching any one label. Its
     only priority labels sit on issues 294th and 295th by update time. */
  const repositoryOf = (labelsOf: (position: number) => string[], repositoryLabels: string[]) => {
    const nodes = Array.from({ length: 304 }, (_, position) => ({
      number: 3000 - position,
      title: `issue at ${position}`,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: new Date(Date.parse("2026-09-27T00:00:00Z") - position * 3_600_000).toISOString(),
      labels: { nodes: labelsOf(position).map((name) => ({ name })) },
      milestone: null,
      issueDependenciesSummary: { blockedBy: 0 },
      closedByPullRequestsReferences: { totalCount: 0 },
    }));
    const calls: { after: string | null; labels: string[]; readsLabels: boolean }[] = [];
    const run = async (args: string[]) => {
      const after = args.find((arg) => arg.startsWith("after="))?.slice("after=".length) ?? null;
      const labels = args.filter((arg) => arg.startsWith("labels[]=")).map((arg) => arg.slice("labels[]=".length));
      const query = args.find((arg) => arg.startsWith("query="))!;
      calls.push({ after, labels, readsLabels: query.includes(" labels(first: 100)") });
      const matching = labels.length ? nodes.filter((node) => node.labels.nodes.some((label) => labels.includes(label.name))) : nodes;
      const start = after ? Number(after) : 0;
      const end = Math.min(start + 100, matching.length);
      return JSON.stringify({ data: { repository: {
        ...(labels.length ? {} : { labels: { nodes: repositoryLabels.map((name) => ({ name })) } }),
        issues: {
          totalCount: matching.length,
          pageInfo: { hasNextPage: end < matching.length, endCursor: end < matching.length ? String(end) : null },
          nodes: matching.slice(start, end),
        },
      } } });
    };
    return { run, calls };
  };

  test("a priority label recorded only on the third page is found by label, in one more read", async () => {
    const github = repositoryOf((position) => (position === 293 || position === 294 ? ["priority: urgent"] : position % 7 === 0 ? ["bug"] : []), ["bug", "enhancement", "priority: urgent", "priority: low"]);
    const result = await openIssuesRanked({ cwd: SANDBOX, repository: "owner-a/repo-a", onBoard: new Set(), run: github.run });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ranking.ranked.map((row) => [row.number, row.tier])).toEqual([[2706, 0], [2707, 0]]);
    expect(result.ranking.signals).toEqual(["priority label"]);
    /* The newest page is what was read in order; the label read adds only
       ranked issues, so the unranked count stays "of the 100 most recent". */
    expect(result.ranking.totalCount).toBe(304);
    expect(result.ranking.read).toBe(100);
    expect(result.ranking.unranked).toHaveLength(100);
    expect(github.calls).toEqual([
      { after: null, labels: [], readsLabels: true },
      { after: null, labels: ["priority: urgent"], readsLabels: false },
    ]);
  });

  test("a newest page that ranks high is the only read, and a repository with no priority label is never read by label", async () => {
    const ranksHigh = repositoryOf((position) => (position === 3 ? ["P1"] : position === 293 ? ["P0"] : []), ["P0", "P1"]);
    const high = await openIssuesRanked({ cwd: SANDBOX, repository: "owner-a/repo-a", onBoard: new Set(), run: ranksHigh.run });
    expect(high.ok && high.ranking.ranked.map((row) => row.number)).toEqual([2997]);
    expect(ranksHigh.calls).toHaveLength(1);

    const unlabelled = repositoryOf(() => [], ["bug", "enhancement"]);
    const none = await openIssuesRanked({ cwd: SANDBOX, repository: "owner-a/repo-a", onBoard: new Set(), run: unlabelled.run });
    expect(none.ok && none.ranking.ranked).toEqual([]);
    expect(unlabelled.calls.map((call) => [call.after, call.labels])).toEqual([[null, []], ["100", []]]);
    expect(none.ok && none.ranking.read).toBe(200);
  });

  test("a failed or malformed read is carried out as unavailable, never as an empty list", async () => {
    const timedOut = await openIssuesRanked({ cwd: SANDBOX, repository: "owner-a/repo-a", onBoard: new Set(),
      run: async () => { throw Object.assign(new Error("killed"), { killed: true }); } });
    expect(timedOut).toEqual({ ok: false, unavailable: "timed-out" });
    const malformed = await openIssuesRanked({ cwd: SANDBOX, repository: "owner-a/repo-a", onBoard: new Set(), run: async () => "not json" });
    expect(malformed).toEqual({ ok: false, unavailable: "malformed-output" });
    const errors = await openIssuesRanked({ cwd: SANDBOX, repository: "owner-a/repo-a", onBoard: new Set(),
      run: async () => JSON.stringify({ errors: [{ message: "rate limited" }] }) });
    expect(errors).toEqual({ ok: false, unavailable: "malformed-output" });
  });
});

test("GitHub reads use the declared App without a host gh configuration", async () => {
  const { githubRunner } = await import("./githubEvidence");
  const calls: string[] = [];
  const run = githubRunner(SANDBOX, 1000, {
    declared: repository => repository === "acme/widgets",
    asApp: async (args, repository) => { calls.push(repository); return JSON.stringify(args); },
    exec: async () => { throw new Error("no host gh configuration"); },
  });
  const args = ["pr", "list", "--repo", "Acme/Widgets", "--json", "number"];
  expect(await run(args)).toBe(JSON.stringify(args));
  expect(await run(["api", "repos/acme/widgets/issues/46"])).toContain("issues/46");
  expect(await run(["repo", "view", "Acme/Widgets", "--json", "defaultBranchRef"])).toContain("defaultBranchRef");
  expect(await run(["api", "graphql", "-F", "owner=acme", "-F", "name=widgets", "-f", "query=query { repository(owner: $owner, name: $name) { name } }"])).toContain("graphql");
  expect(calls).toEqual(["acme/widgets", "acme/widgets", "acme/widgets", "acme/widgets"]);
  await expect(run(["pr", "merge", "46", "--repo", "acme/widgets"])).rejects.toThrow("no host gh configuration");
  await expect(run(["pr", "list", "--repo", "acme/other"])).rejects.toThrow("no host gh configuration");
  for (const args of [
    ["pr", "view", "https://github.com/acme/widgets/pull/46"],
    ["issue", "view", "https://github.com/acme/widgets/issues/47"],
    ["repo", "view", "https://github.com/acme/widgets"],
  ]) expect(await run(args)).toBe(JSON.stringify(args));
  await expect(run(["pr", "view", "https://example.invalid/acme/widgets/pull/46"])).rejects.toThrow("no host gh configuration");
});

test("cwd reads resolve local Git context and recheck a changed origin", async () => {
  const { githubRunner } = await import("./githubEvidence");
  const root = path.join(SANDBOX, "checkout");
  fs.mkdirSync(path.join(root, "nested"), { recursive: true });
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    expect(result.exitCode).toBe(0);
  };
  git("init");
  git("remote", "add", "origin", "https://github.com/Acme/Widgets.git");
  const calls: { args: string[]; repository: string }[] = [];
  let fallbacks = 0;
  const run = githubRunner(path.join(root, "nested"), 1000, {
    declared: repository => repository === "acme/widgets",
    asApp: async (args, repository) => { calls.push({ args, repository }); return "[]"; },
    exec: async () => { fallbacks++; throw new Error("no host gh configuration"); },
  });
  for (const args of [["pr", "list"], ["issue", "list"], ["pr", "view", "46"], ["issue", "view", "47"], ["repo", "view"]]) {
    expect(await run(args)).toBe("[]");
    expect(calls.at(-1)).toEqual({ args: args[0] === "repo" ? ["repo", "view", "acme/widgets"] : [...args, "--repo", "acme/widgets"], repository: "acme/widgets" });
  }
  expect(fallbacks).toBe(0);
  for (const args of [
    ["pr", "merge", "46"], ["issue", "create", "--title", "example"], ["repo", "edit"],
    ["repo", "list", "acme"],
    ["api", "repos/acme/widgets/issues", "-f", "title=example"],
    ["api", "repos/acme/widgets/issues/46", "--method=PATCH"],
    ["api", "graphql", "-f", "query=mutation { example }"],
    ["pr", "list", "--repo", "acme/other"],
    ["pr", "list", "--repo", "invalid"],
  ]) await expect(run(args)).rejects.toThrow("no host gh configuration");
  expect(calls).toHaveLength(5);
  git("remote", "set-url", "origin", "https://github.com/acme/other.git");
  await expect(run(["pr", "list"])).rejects.toThrow("no host gh configuration");
  git("remote", "remove", "origin");
  await expect(run(["issue", "list"])).rejects.toThrow("no host gh configuration");
  expect(calls).toHaveLength(5);
});

test("a repository environment override takes precedence over cwd for reads", async () => {
  const { githubRunner } = await import("./githubEvidence");
  const previous = process.env.GH_REPO;
  const calls: string[] = [];
  const run = githubRunner(SANDBOX, 1000, {
    declared: repository => repository === "acme/widgets",
    asApp: async (args, repository) => { calls.push(repository); return JSON.stringify(args); },
    exec: async () => { throw new Error("no host gh configuration"); },
  });
  try {
    process.env.GH_REPO = "Acme/Widgets";
    expect(await run(["pr", "list"])).toBe(JSON.stringify(["pr", "list", "--repo", "acme/widgets"]));
    expect(calls).toEqual(["acme/widgets"]);
    process.env.GH_REPO = "acme/other";
    await expect(run(["issue", "list"])).rejects.toThrow("no host gh configuration");
    // An explicit repository still wins over the environment.
    expect(await run(["repo", "view", "acme/widgets"])).toContain("widgets");
    expect(calls).toEqual(["acme/widgets", "acme/widgets"]);
  } finally {
    if (previous === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = previous;
  }
});

test("a read carries only the App token and never retries as another identity", async () => {
  const { githubRunner } = await import("./githubEvidence");
  const { forgeAppWriter, ForgeAppTokenSource } = await import("@/lib/forge/appWrite");
  let fallbackCalls = 0;
  let calls = 0;
  const asApp = forgeAppWriter(SANDBOX, 1000, {
    source: { NODE_ENV: "test", HOME: SANDBOX, GH_CONFIG_DIR: path.join(SANDBOX, "unused-config"), GITHUB_TOKEN: "unused-token" },
    tokens: new ForgeAppTokenSource(async () => ({ token: "test-app-token", expiresAt: null })),
    exec: async (_args, env) => {
      calls++;
      expect(env.GH_TOKEN).toBe("test-app-token");
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_CONFIG_DIR).not.toBe(path.join(SANDBOX, "unused-config"));
      throw new Error("read refused");
    },
  });
  const run = githubRunner(SANDBOX, 1000, { asApp, declared: () => true, exec: async () => { fallbackCalls++; return "[]"; } });
  const root = path.join(SANDBOX, "refused-checkout");
  fs.mkdirSync(root);
  expect(Bun.spawnSync(["git", "init", root]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-C", root, "remote", "add", "origin", "https://github.com/acme/widgets.git"]).exitCode).toBe(0);
  const cwdRun = githubRunner(root, 1000, { asApp, declared: () => true, exec: async () => { fallbackCalls++; return "[]"; } });
  for (const args of [["pr", "view", "46", "--repo", "acme/widgets"], ["repo", "view", "acme/widgets"]]) {
    await expect(run(args)).rejects.toThrow("read refused");
  }
  await expect(cwdRun(["issue", "list"])).rejects.toThrow("read refused");
  expect(calls).toBe(3);
  expect(fallbackCalls).toBe(0);
  const mintRefused = githubRunner(root, 1000, {
    declared: () => true,
    asApp: forgeAppWriter(root, 1000, {
      tokens: new ForgeAppTokenSource(async () => { throw new Error("mint refused"); }),
      exec: async () => { throw new Error("unexpected dispatch"); },
    }),
    exec: async () => { fallbackCalls++; return "[]"; },
  });
  for (const args of [["pr", "list"], ["repo", "view", "acme/widgets"]]) {
    await expect(mintRefused(args)).rejects.toThrow("mint refused");
  }
  expect(fallbackCalls).toBe(0);
});


describe("REST read credential classification", () => {
  const bodyFlags = [
    ["--raw-field", "title=example"], ["--raw-field=title=example"],
    ["--field", "title=example"], ["--field=title=example"],
    ["-f", "title=example"], ["-ftitle=example"], ["-f=title=example"],
    ["-F", "title=example"], ["-Ftitle=example"], ["-F=title=example"],
    ["--input", "body.json"], ["--input=body.json"],
    ["-if", "title=example"], ["-f", "--method=GET"],
  ];
  test.each(bodyFlags.map(flags => [flags]))("body flags %j keep writes on the ordinary route", async (flags: string[]) => {
    const { githubRunner } = await import("./githubEvidence");
    const ordinary: string[][] = [];
    let appCalls = 0;
    const run = githubRunner(SANDBOX, 1000, {
      declared: () => true,
      asApp: async () => { appCalls++; return "app"; },
      exec: async args => { ordinary.push(args); return "ordinary"; },
    });
    const args = ["api", "repos/acme/widgets/issues", ...flags];
    expect(await run(args)).toBe("ordinary");
    expect(ordinary).toEqual([args]);
    expect(appCalls).toBe(0);
  });

  test.each([["-X", "GET"], ["-XGET"], ["--method", "GET"], ["--method=GET"]].map(method => [method]))(
    "explicit GET %j uses the App even with query parameters", async (method: string[]) => {
      const { githubRunner } = await import("./githubEvidence");
      const calls: string[][] = [];
      const run = githubRunner(SANDBOX, 1000, {
        declared: repository => repository === "acme/widgets",
        asApp: async args => { calls.push(args); return "app"; },
        exec: async () => { throw new Error("unexpected ordinary dispatch"); },
      });
      const args = ["api", "repos/acme/widgets/issues", ...method, "--field=state=open"];
      expect(await run(args)).toBe("app");
      expect(calls).toEqual([args]);
    },
  );

  test.each([["-X", "POST"], ["-XPATCH"], ["--method", "PUT"], ["--method=DELETE"], ["-XGET", "--method=POST"]].map(method => [method]))(
    "explicit write method %j keeps its route", async (method: string[]) => {
      const { githubRunner } = await import("./githubEvidence");
      let appCalls = 0;
      const run = githubRunner(SANDBOX, 1000, {
        declared: () => true,
        asApp: async () => { appCalls++; return "app"; },
        exec: async args => JSON.stringify(args),
      });
      const args = ["api", "repos/acme/widgets/issues", ...method];
      expect(await run(args)).toBe(JSON.stringify(args));
      expect(appCalls).toBe(0);
    },
  );

  test("REST and GraphQL App read refusals never try ordinary credentials", async () => {
    const { githubRunner } = await import("./githubEvidence");
    const repositories: string[] = [];
    let ordinary = 0;
    const run = githubRunner(SANDBOX, 1000, {
      declared: repository => repository === "acme/widgets",
      asApp: async (_args, repository) => { repositories.push(repository); throw new Error("App refused"); },
      exec: async () => { ordinary++; return "ordinary"; },
    });
    for (const args of [
      ["api", "repos/acme/widgets/issues", "--method=GET"],
      ["api", "graphql", "-F", "owner=acme", "-F", "name=widgets", "-f", "query=query { repository(owner: $owner, name: $name) { name } }"],
    ]) await expect(run(args)).rejects.toThrow("App refused");
    expect(repositories).toEqual(["acme/widgets", "acme/widgets"]);
    expect(ordinary).toBe(0);
  });
});

describe("checkout read repository selection", () => {
  function checkout() {
    const root = fs.mkdtempSync(path.join(SANDBOX, "remote-selection-"));
    const git = (...args: string[]) => {
      expect(Bun.spawnSync(["git", ...args], { cwd: root }).exitCode).toBe(0);
    };
    git("init");
    return { root, git };
  }
  const reads = [["pr", "list"], ["issue", "list"], ["repo", "view"]];
  const pinned = (args: string[], repository: string) => args[0] === "repo"
    ? [...args, repository] : [...args, "--repo", repository];

  test("configured defaults override origin and are reread between calls", async () => {
    const { githubRunner } = await import("./githubEvidence");
    const { root, git } = checkout();
    git("remote", "add", "origin", "https://github.com/acme/widgets.git");
    git("remote", "add", "upstream", "https://github.com/acme/canonical.git");
    git("config", "remote.origin.gh-resolved", "base");
    const calls: { args: string[]; repository: string }[] = [];
    const run = githubRunner(root, 1000, {
      declared: () => true,
      asApp: async (args, repository) => { calls.push({ args, repository }); return "app"; },
      exec: async () => { throw new Error("unexpected ordinary dispatch"); },
    });
    expect(await run(["pr", "list"])).toBe("app");
    expect(calls.pop()?.repository).toBe("acme/widgets");
    git("config", "--unset", "remote.origin.gh-resolved");
    git("config", "remote.upstream.gh-resolved", "base");
    for (const args of reads) {
      expect(await run(args)).toBe("app");
      expect(calls.pop()).toEqual({ args: pinned(args, "acme/canonical"), repository: "acme/canonical" });
    }
    git("config", "remote.upstream.gh-resolved", "acme/selected");
    expect(await run(["issue", "list"])).toBe("app");
    expect(calls.pop()?.repository).toBe("acme/selected");
  });

  test("checkout remote preference works with or without origin", async () => {
    const { githubRunner } = await import("./githubEvidence");
    const { root, git } = checkout();
    git("remote", "add", "upstream", "https://github.com/acme/canonical.git");
    const run = githubRunner(root, 1000, {
      declared: repository => repository === "acme/canonical",
      asApp: async (args, repository) => JSON.stringify({ args, repository }),
      exec: async () => { throw new Error("unexpected ordinary dispatch"); },
    });
    for (const args of reads) expect(JSON.parse(await run(args))).toEqual({ args: pinned(args, "acme/canonical"), repository: "acme/canonical" });
    git("remote", "add", "origin", "https://github.com/acme/widgets.git");
    git("remote", "add", "github", "https://github.com/acme/mirror.git");
    expect(JSON.parse(await run(["pr", "list"])).repository).toBe("acme/canonical");
    git("remote", "remove", "upstream");
    const mirrorRun = githubRunner(root, 1000, {
      declared: repository => repository === "acme/mirror",
      asApp: async (_args, repository) => repository,
      exec: async () => { throw new Error("unexpected ordinary dispatch"); },
    });
    expect(await mirrorRun(["pr", "list"])).toBe("acme/mirror");
  });

  test("an undeclared default passes original arguments, and explicit sources override it", async () => {
    const { githubRunner } = await import("./githubEvidence");
    const { root, git } = checkout();
    git("remote", "add", "origin", "https://github.com/acme/widgets.git");
    git("remote", "add", "upstream", "https://github.com/acme/canonical.git");
    git("config", "remote.upstream.gh-resolved", "base");
    const ordinary: string[][] = [];
    let appCalls = 0;
    const run = githubRunner(root, 1000, {
      declared: repository => repository === "acme/widgets",
      asApp: async (_args, repository) => { appCalls++; return repository; },
      exec: async args => { ordinary.push(args); return "ordinary"; },
    });
    for (const args of reads) expect(await run(args)).toBe("ordinary");
    expect(ordinary).toEqual(reads);
    expect(appCalls).toBe(0);
    const previous = process.env.GH_REPO;
    try {
      process.env.GH_REPO = "acme/widgets";
      for (const args of reads) expect(await run(args)).toBe("acme/widgets");
      process.env.GH_REPO = "acme/canonical";
      expect(await run(["pr", "list", "--repo", "acme/widgets"])).toBe("acme/widgets");
      expect(await run(["repo", "view", "acme/widgets"])).toBe("acme/widgets");
    } finally {
      if (previous === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = previous;
    }
    expect(appCalls).toBe(5);
  });

  test("a chosen default's App refusal never falls back to origin or ordinary credentials", async () => {
    const { githubRunner } = await import("./githubEvidence");
    const { root, git } = checkout();
    git("remote", "add", "origin", "https://github.com/acme/widgets.git");
    git("remote", "add", "upstream", "https://github.com/acme/canonical.git");
    git("config", "remote.upstream.gh-resolved", "base");
    const repositories: string[] = [];
    let ordinary = 0;
    const run = githubRunner(root, 1000, {
      declared: () => true,
      asApp: async (_args, repository) => { repositories.push(repository); throw new Error("App refused"); },
      exec: async () => { ordinary++; return "ordinary"; },
    });
    for (const args of reads) await expect(run(args)).rejects.toThrow("App refused");
    expect(repositories).toEqual(reads.map(() => "acme/canonical"));
    expect(ordinary).toBe(0);
  });
});
