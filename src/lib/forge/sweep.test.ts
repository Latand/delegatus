import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import { clearForgeCacheForTests, FORGE_LINKS_COLLECTION, forgeCacheView, nudgeForgeSweep, observeForgePullRequest, readForgeCache, resetForgeCacheForTests, updateForgeCache, PROPOSAL_ISSUE_LIMIT } from "./cache";
import { recordProjectRemote } from "@/lib/projects/aliases";
import { FORGE_FILL_LIMIT, FORGE_IDLE_INTERVAL_MS, FORGE_LIVE_INTERVAL_MS, FORGE_NUDGE_DEBOUNCE_MS, FORGE_PAGE_LIMIT, FORGE_RETRY_MS, sweepForgeLinks, type ForgeSweepPorts } from "./sweep";

/* The forge sweep (#2059) against an injected `gh` and clock, in a private
   directory: invented repositories and branches, no network. */

const REPO = "acme/widgets";
const T0 = Date.parse("2026-09-23T10:00:00Z");

let dir: string;
let file: string;
let previousState: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sweep-"));
  file = path.join(dir, "forge-links.json");
  previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = dir;
  resetForgeCacheForTests();
});
afterEach(() => {
  process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(dir, { recursive: true, force: true });
  resetForgeCacheForTests();
});

type Row = { number: number; headRefName?: string; headRefOid?: string; state?: string; isDraft?: boolean; createdAt?: string; updatedAt?: string; closes?: number[] };
const row = (entry: Row) => ({
  number: entry.number,
  url: `https://github.com/acme/widgets/pull/${entry.number}`,
  headRefName: entry.headRefName ?? `feature/${entry.number}`,
  headRefOid: entry.headRefOid ?? String(entry.number % 10).repeat(40),
  state: entry.state ?? "OPEN",
  isDraft: entry.isDraft ?? false,
  createdAt: entry.createdAt ?? "2026-09-22T00:00:00Z",
  updatedAt: entry.updatedAt ?? "2026-09-23T09:00:00Z",
  closingIssuesReferences: (entry.closes ?? []).map((number) => ({ number, url: `https://github.com/acme/widgets/issues/${number}` })),
});

/* Deep-frozen, so a sweep that tried to write a record would throw. */
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function lane(extra: Partial<Pipeline> = {}): Pipeline {
  return frozen({
    id: "pipe-a",
    project: "repo-fixture",
    state: "running",
    branch: "pipeline/lane-a",
    createdAt: "2026-09-21T00:00:00Z",
    taskIds: [],
    runs: [],
    delivery: { target: { repository: "repo-fixture", remote: "https://github.com/acme/widgets.git", branch: "refs/heads/pipeline/lane-a" } },
    ...extra,
  } as unknown as Pipeline);
}

function harness(answer: (args: string[]) => unknown, records: { pipelines?: Pipeline[]; tasks?: BoardTask[] } = {}) {
  let clock = T0;
  const calls: string[][] = [];
  const ports: ForgeSweepPorts = {
    now: () => clock,
    run: async (args) => {
      calls.push(args);
      const out = answer(args);
      if (out instanceof Error) throw out;
      return typeof out === "string" ? out : JSON.stringify(out);
    },
    loadPipelines: () => records.pipelines ?? [lane()],
    loadTasks: () => records.tasks ?? [],
    file,
  };
  return { ports, calls, advance: (ms: number) => { clock += ms; }, sweep: () => sweepForgeLinks(ports) };
}

const entry = () => readForgeCache(file).data.repositories[REPO]!;
const isSearch = (args: string[]) => args.includes("--search");

describe("the sweep", () => {
  test("an exact PR hold discovers and refreshes its repository from a cold cache", async () => {
    const repository = "other/repository";
    const task = frozen({ id: "held-pr", project: "repo-without-work-links", status: "blocked", workLinks: undefined,
      hold: { kind: "pr", ref: `https://github.com/${repository}/pull/41`, since: "2026-09-22T00:00:00Z", note: "Wait for this PR", by: "agent" } } as unknown as BoardTask);
    let state: "OPEN" | "CLOSED" | "MERGED" = "OPEN";
    const h = harness(args => {
      if (args[0] !== "pr") throw new Error("unexpected forge request");
      return [{ ...row({ number: 41, state }), url: `https://github.com/${repository}/pull/41` }];
    }, { pipelines: [], tasks: [task] });

    expect(await h.sweep()).toEqual([repository]);
    expect(h.calls[0]).toEqual(expect.arrayContaining(["--repo", repository]));
    expect(forgeCacheView(file).repository(repository)?.pr(41)?.state).toBe("open");

    state = "CLOSED";
    h.advance(FORGE_LIVE_INTERVAL_MS);
    await h.sweep();
    expect(forgeCacheView(file).repository(repository)?.pr(41)?.state).toBe("closed");

    state = "MERGED";
    h.advance(FORGE_LIVE_INTERVAL_MS);
    await h.sweep();
    expect(forgeCacheView(file).repository(repository)?.pr(41)?.state).toBe("merged");
  });

  test("a numbered PR hold takes its repository from the lane carrying the task through an open-to-closed transition", async () => {
    const task = frozen({ id: "held-number", project: "repo-without-remote", status: "blocked",
      hold: { kind: "pr", ref: "41", since: "2026-09-22T00:00:00Z", note: "Wait for this PR", by: "agent" } } as unknown as BoardTask);
    let state: "OPEN" | "CLOSED" = "OPEN";
    const h = harness(args => {
      if (args[0] !== "pr") throw new Error("unexpected forge request");
      return [row({ number: 41, state })];
    }, { pipelines: [lane({ state: "closed", taskIds: [task.id] })], tasks: [task] });

    expect(await h.sweep()).toEqual([REPO]);
    expect(forgeCacheView(file).repository(REPO)?.pr(41)?.state).toBe("open");
    state = "CLOSED";
    h.advance(FORGE_LIVE_INTERVAL_MS);
    await h.sweep();
    expect(forgeCacheView(file).repository(REPO)?.pr(41)?.state).toBe("closed");
  });

  test("seated repositories without lanes refresh a bounded replaceable proposal page", async () => {
    const project = `repo-${"a".repeat(32)}`;
    recordProjectRemote({ project, canonicalRemote: "github.com/acme/widgets" });
    let issues = Array.from({ length: PROPOSAL_ISSUE_LIMIT + 5 }, (_, index) => ({ number: index + 1,
      title: "x".repeat(250), labels: Array.from({ length: 25 }, () => ({ name: "y".repeat(70) })), updatedAt: null }));
    const h = harness(args => args[0] === "issue" ? issues : [], { pipelines: [] });
    h.ports.loadSeatProjects = () => [project];
    expect(await h.sweep()).toEqual([REPO]);
    expect(h.calls.filter(args => args[0] === "issue")).toEqual([["issue", "list", "--repo", REPO, "--state", "open", "--limit", "40", "--json", "number,title,labels,updatedAt"]]);
    resetForgeCacheForTests();
    const proposals = forgeCacheView(file).repository(REPO)!.proposalIssues!;
    expect(proposals).toHaveLength(PROPOSAL_ISSUE_LIMIT);
    expect(proposals[0]).toEqual({ number: 1, title: "x".repeat(200), labels: Array(20).fill("y".repeat(60)), updatedAt: null, checkedAt: new Date(T0).toISOString() });
    const script = `import { forgeCacheView } from ${JSON.stringify(path.join(import.meta.dir, "cache.ts"))};
      console.log(JSON.stringify(forgeCacheView(process.argv[1]).repository("acme/widgets").proposalIssues));`;
    const child = spawn(process.execPath, ["-e", script, file], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    let output = "", error = "";
    child.stdout!.on("data", chunk => { output += chunk; });
    child.stderr!.on("data", chunk => { error = (error + chunk).slice(-8_000); });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error(`fresh cache reader exited ${code}: ${error}`)));
    });
    expect(JSON.parse(output)).toEqual(proposals);
    issues = [];
    h.advance(FORGE_LIVE_INTERVAL_MS);
    await h.sweep();
    expect(entry().proposals).toEqual({ checkedAt: new Date(T0 + FORGE_LIVE_INTERVAL_MS).toISOString(), issues: [] });
  });

  for (const failure of ["refused", "timed-out", "malformed"] as const) test(`proposal ${failure} keeps the prior age and PR membership`, async () => {
    const project = `repo-${"a".repeat(32)}`;
    recordProjectRemote({ project, canonicalRemote: "github.com/acme/widgets" });
    let fail = false;
    const h = harness(args => {
      if (args[0] !== "issue") return [row({ number: 7, closes: [3] })];
      if (!fail) return [{ number: 3, title: "A proposal", labels: [{ name: "design" }], updatedAt: null }];
      if (failure === "malformed") return [{ number: 3, title: "Missing labels" }];
      return Object.assign(new Error("issue read failed"), failure === "timed-out" ? { killed: true, signal: "SIGTERM" } : {});
    });
    h.ports.loadSeatProjects = () => [project];
    await h.sweep();
    const prior = entry().proposals;
    fail = true;
    h.advance(FORGE_LIVE_INTERVAL_MS);
    await h.sweep();
    resetForgeCacheForTests();
    expect(entry().proposals).toEqual(prior);
    expect(entry().lastSweepAt).toBe(new Date(T0 + FORGE_LIVE_INTERVAL_MS).toISOString());
    expect(entry().prs["7"]!.closes).toEqual([3]);
    expect(forgeCacheView(file).repository(REPO)!.isIssue(7)).toBe(false);
  });

  test("directory and other-forge seats make no proposal request", async () => {
    recordProjectRemote({ project: `repo-${"b".repeat(32)}`, canonicalRemote: "gitlab.com/acme/widgets" });
    const h = harness(() => { throw new Error("unexpected network request"); }, { pipelines: [] });
    h.ports.loadSeatProjects = () => ["dir-work", `repo-${"b".repeat(32)}`];
    expect(await h.sweep()).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("an unreadable seat list preserves PR refresh and retries proposal discovery next sweep", async () => {
    const project = `repo-${"a".repeat(32)}`;
    recordProjectRemote({ project, canonicalRemote: "github.com/acme/widgets" });
    const h = harness(args => args[0] === "issue" ? [] : [row({ number: 7 })]);
    const warnings: string[] = [];
    h.ports.log = message => { warnings.push(message); };
    h.ports.loadSeatProjects = () => { throw new Error("seat store unavailable"); };
    expect(await h.sweep()).toEqual([REPO]);
    expect(entry().prs["7"]?.state).toBe("open");
    expect(entry().proposals).toBeUndefined();
    expect(warnings).toHaveLength(1);
    h.ports.loadSeatProjects = () => [project];
    h.advance(FORGE_LIVE_INTERVAL_MS);
    await h.sweep();
    expect(entry().proposals).toEqual({ checkedAt: new Date(T0 + FORGE_LIVE_INTERVAL_MS).toISOString(), issues: [] });
  });

  test("gh 2.23 rejecting closingIssuesReferences still completes the repository cache", async () => {
    const h = harness((args) => {
      if (args[0] === "api" && args[1] === "graphql") {
        return { data: { repository: { p0: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } } } } };
      }
      if (args.at(-1)?.includes("closingIssuesReferences")) {
        return Object.assign(new Error('Unknown JSON field: "closingIssuesReferences"'), { stderr: 'Unknown JSON field: "closingIssuesReferences"' });
      }
      const legacy = row({ number: 7, headRefName: "pipeline/lane-a" });
      delete (legacy as Partial<typeof legacy>).closingIssuesReferences;
      return [legacy];
    });

    expect(await h.sweep()).toEqual([REPO]);
    expect(entry()).toMatchObject({
      completeSince: new Date(T0).toISOString(),
      lastError: null,
      prs: { "7": { headRefName: "pipeline/lane-a", closes: [] } },
    });
  });

  test("old gh falls back to GraphQL and preserves closing issue links", async () => {
    const delivery = { target: { repository: "repo-fixture", remote: `https://github.com/${REPO}.git`, branch: "main", pr: 8 } } as Pipeline["delivery"];
    const h = harness(args => {
      if (args[0] === "api" && args[1] === "graphql") return { data: { repository: { p0: { closingIssuesReferences: { nodes: [{ number: 42, url: "https://github.com/acme/widgets/issues/42" }], pageInfo: { hasNextPage: false } } } } } };
      if (args.at(-1)?.includes("closingIssuesReferences")) return Object.assign(new Error("Unknown JSON field: closingIssuesReferences"), { stderr: 'Unknown JSON field: "closingIssuesReferences"' });
      if (args[1] === "view") return row({ number: 8 });
      const legacy = row({ number: 7, headRefName: "pipeline/lane-a" });
      delete (legacy as Partial<typeof legacy>).closingIssuesReferences;
      return [legacy];
    }, { pipelines: [lane({ delivery })] });
    expect(await h.sweep()).toEqual([REPO]);
    expect(h.calls.map(args => args.slice(0, 2))).toEqual([
      ["pr", "list"], ["pr", "list"], ["api", "graphql"],
      ["pr", "view"], ["pr", "view"], ["api", "graphql"],
    ]);
    expect(entry().prs["7"]).toMatchObject({ closes: [42], headRefName: "pipeline/lane-a", state: "open" });
    expect(entry().prs["8"]).toMatchObject({ closes: [42], state: "open" });
    expect(entry().lastError).toBeNull();
    expect(entry().canonical).toBe(REPO);
  });

  /* docs/design/done-section.md §2.1: a merge batch's title names the PRs it
     landed, and every landed PR is dated by its own or its batch's merge. */
  test("title and mergedAt are asked for and kept, on the current and the legacy field set", async () => {
    for (const legacy of [false, true]) {
      resetForgeCacheForTests();
      clearForgeCacheForTests(file);
      const rows = () => [
        { ...row({ number: 9, state: "MERGED", headRefName: "merge-batch/b1" }), title: "Merge batch: #7, #8", mergedAt: "2026-09-23T02:21:00Z" },
        { ...row({ number: 7, state: "CLOSED" }), title: "Lane seven", mergedAt: null },
        { ...row({ number: 6, state: "MERGED" }), title: "Lane six", mergedAt: "2026-09-23T01:10:00Z" },
        { ...row({ number: 5, state: "OPEN" }), title: "Lane five", mergedAt: "0001-01-01T00:00:00Z" },
      ];
      const h = harness((args) => {
        if (args[0] === "api") return { data: { repository: Object.fromEntries([0, 1, 2, 3].map((index) => [`p${index}`, { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } }])) } };
        if (legacy && args.at(-1)?.includes("closingIssuesReferences")) return Object.assign(new Error("Unknown JSON field"), { stderr: 'Unknown JSON field: "closingIssuesReferences"' });
        return rows();
      });
      await h.sweep();
      const asked = h.calls.filter((args) => args[1] === "list").map((args) => args.at(-1)!);
      for (const fields of asked) expect(fields.split(",")).toEqual(expect.arrayContaining(["title", "mergedAt"]));
      expect(asked).toHaveLength(legacy ? 2 : 1);
      expect(entry().prs["9"]).toMatchObject({ title: "Merge batch: #7, #8", mergedAt: "2026-09-23T02:21:00Z", headRefName: "merge-batch/b1" });
      expect(entry().prs["7"]).toMatchObject({ title: "Lane seven", state: "closed" });
      expect(entry().prs["7"]!.mergedAt).toBeUndefined();
      expect(entry().prs["6"]).toMatchObject({ title: "Lane six", mergedAt: "2026-09-23T01:10:00Z" });
      expect(entry().prs["5"]!.mergedAt).toBeUndefined();
    }
  });

  test("old gh keeps the cache incomplete when closing references cannot be read in full", async () => {
    const h = harness((args) => {
      if (args[0] === "api") return { data: { repository: { p0: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: true } } } } } };
      if (args.at(-1)?.includes("closingIssuesReferences")) return Object.assign(new Error("Unknown JSON field"), { stderr: 'Unknown JSON field: "closingIssuesReferences"' });
      return [row({ number: 7 })];
    });
    await h.sweep();
    expect(entry().completeSince).toBeNull();
    expect(entry().lastError).toBe("command-failed");
  });

  test("the first sweep is a full read: the backfill, draft mapped from isDraft, closing issues kept", async () => {
    const h = harness(() => [row({ number: 7, isDraft: true, closes: [3] }), row({ number: 6, state: "MERGED", headRefName: "pipeline/lane-a" })]);
    expect(await h.sweep()).toEqual([REPO]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual(expect.arrayContaining(["pr", "list", "--repo", REPO, "--state", "all", "--limit", "5000"]));
    expect(isSearch(h.calls[0]!)).toBe(false);
    expect(entry().completeSince).toBe(new Date(T0).toISOString());
    expect(entry().prs["7"]).toMatchObject({ state: "draft", closes: [3] });
    expect(entry().prs["6"]).toMatchObject({ state: "merged", headRefName: "pipeline/lane-a" });
    expect(entry().canonical).toBe(REPO);
  });

  test("head commits: kept for the worktree sweep, and an entry cached without them is read in full once", async () => {
    const h = harness((args) => (isSearch(args)
      ? [row({ number: 6, state: "MERGED", updatedAt: "2026-09-23T09:59:00Z" })]
      : [row({ number: 6, state: "MERGED", headRefOid: "c".repeat(40) }), row({ number: 5, state: "MERGED", headRefOid: "d".repeat(40) })]));
    /* A cache written before head commits were read: complete, and without them. */
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, repositories: { [REPO]: {
      canonical: REPO, completeSince: "2026-09-20T00:00:00Z", lastSweepAt: "2026-09-23T09:00:00Z", lastAttemptAt: null, lastError: null, issues: {},
      prs: { "5": { url: "https://github.com/acme/widgets/pull/5", headRefName: "feature/5", createdAt: "", state: "merged", closes: [], checkedAt: "" } },
    } } }));
    expect(await h.sweep()).toEqual([REPO]);
    expect(isSearch(h.calls[0]!)).toBe(false);
    expect(h.calls[0]!.join(" ")).toContain("headRefOid");
    expect(entry().headRefOids).toBe(true);
    expect(entry().prs["5"]?.headRefOid).toBe("d".repeat(40));
    expect(entry().prs["6"]?.headRefOid).toBe("c".repeat(40));
    /* Afterwards the page is enough again. */
    h.advance(FORGE_IDLE_INTERVAL_MS);
    await h.sweep();
    expect(isSearch(h.calls.at(-1)!)).toBe(true);
    expect(entry().prs["5"]?.headRefOid).toBe("d".repeat(40));
  });

  test("intervals: a live repository every 3 minutes, an idle one every 30, a nudge after 30 seconds", async () => {
    const h = harness((args) => (isSearch(args) ? [row({ number: 7, updatedAt: "2026-09-23T09:59:00Z" })] : [row({ number: 7 })]));
    await h.sweep();
    h.advance(FORGE_LIVE_INTERVAL_MS - 1_000);
    expect(await h.sweep()).toEqual([]);
    h.advance(1_000);
    expect(await h.sweep()).toEqual([REPO]);
    expect(isSearch(h.calls.at(-1)!)).toBe(true);

    const idle = harness((args) => (isSearch(args) ? [row({ number: 7, state: "MERGED", updatedAt: "2026-09-23T09:59:00Z" })] : [row({ number: 7, state: "MERGED" })]),
      { pipelines: [lane({ state: "completed" })] });
    resetForgeCacheForTests();
    clearForgeCacheForTests(file);
    await idle.sweep();
    idle.advance(FORGE_LIVE_INTERVAL_MS);
    expect(await idle.sweep()).toEqual([]);
    nudgeForgeSweep(REPO);
    idle.advance(FORGE_NUDGE_DEBOUNCE_MS);
    expect(await idle.sweep()).toEqual([REPO]);
    idle.advance(FORGE_IDLE_INTERVAL_MS - 1_000);
    expect(await idle.sweep()).toEqual([]);
    idle.advance(1_000);
    expect(await idle.sweep()).toEqual([REPO]);
  });

  test("a page that does not reach back to the previous sweep falls back to a full read", async () => {
    let search = 0;
    const h = harness((args) => {
      if (!isSearch(args)) return [row({ number: 1 })];
      search += 1;
      return Array.from({ length: FORGE_PAGE_LIMIT }, (_, index) => row({ number: 100 + index, updatedAt: "2026-09-23T10:02:00Z" }));
    });
    await h.sweep();
    h.advance(FORGE_LIVE_INTERVAL_MS);
    await h.sweep();
    expect(search).toBe(1);
    expect(h.calls.map(isSearch)).toEqual([false, true, false]);
  });

  test("an empty page under a stale name proves nothing once PRs are known, and the next search uses the name GitHub answered with", async () => {
    const h = harness((args) => {
      if (args.includes("acme/old-name") && isSearch(args)) return [];
      return isSearch(args) ? [row({ number: 7, updatedAt: "2026-09-23T09:59:00Z" })] : [row({ number: 7 })];
    }, { pipelines: [lane({ delivery: { target: { repository: "repo-fixture", remote: "https://github.com/acme/old-name.git", branch: "refs/heads/pipeline/lane-a" } } as Pipeline["delivery"] })] });
    await h.sweep();
    expect(readForgeCache(file).data.repositories["acme/old-name"]!.canonical).toBe(REPO);
    h.advance(FORGE_LIVE_INTERVAL_MS);
    await h.sweep();
    expect(h.calls[1]).toEqual(expect.arrayContaining(["--repo", REPO, "--search", "sort:updated-desc"]));
  });

  test("a timed-out read leaves every entry and completeSince as they were, and waits before retrying", async () => {
    let fail = false;
    const h = harness(() => (fail ? Object.assign(new Error("killed"), { killed: true }) : [row({ number: 7 })]));
    await h.sweep();
    const before = entry();
    fail = true;
    h.advance(FORGE_LIVE_INTERVAL_MS);
    await h.sweep();
    expect(entry()).toMatchObject({ lastError: "timed-out", completeSince: before.completeSince, lastSweepAt: before.lastSweepAt, prs: before.prs });
    h.advance(60_000);
    expect(await h.sweep()).toEqual([]);
  });

  test.each([
    ["missing CLI", "ENOENT", "", "gh) not found on PATH", "Install gh"],
    ["no login", 1, "To get started with GitHub CLI, please run: gh auth login", "authentication failed", "GH_CONFIG_DIR"],
    ["DNS", 1, "error connecting to api.github.com: lookup api.github.com: no such host", "DNS lookup failed", "Check DNS"],
    ["TLS certificate", 1, "proxyconnect tcp: tls: failed to verify certificate: x509: certificate signed by unknown authority", "certificate verification failed", "Check the system trust store"],
    ["other exit", 17, "unknown flag --fixture", "(exit 17): unknown flag.", "Check the gh installation"],
  ] as const)("%s logs a remedy, keeps cached links and retries on cooldown", async (_name, code, stderr, cause, remedy) => {
    let fail = false;
    const error = Object.assign(new Error("Command failed: gh"), { code, stderr });
    const h = harness(() => fail ? error : [row({ number: 7 })]);
    const messages: string[] = [];
    h.ports.log = (message, detail) => { messages.push(`${message} ${detail ?? ""}`); };
    await h.sweep();
    const before = entry();
    fail = true;
    h.advance(FORGE_LIVE_INTERVAL_MS);
    expect(await h.sweep()).toEqual([REPO]);
    expect(entry()).toMatchObject({ lastError: "command-failed", completeSince: before.completeSince, lastSweepAt: before.lastSweepAt, prs: before.prs });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(cause);
    expect(messages[0]).toContain(remedy);

    resetForgeCacheForTests();
    h.advance(FORGE_RETRY_MS - 1);
    expect(await h.sweep()).toEqual([]);
    expect(h.calls).toHaveLength(2);
    expect(messages).toHaveLength(1);

    fail = false;
    h.advance(1);
    expect(await h.sweep()).toEqual([REPO]);
    expect(h.calls).toHaveLength(3);
    expect(entry().lastError).toBeNull();
  });

  test("generic gh stderr is withheld from sweep log detail while cache remains usable", async () => {
    let fail = false;
    const privateFragments = ["@synthetic_handle", "private-owner/private-repo", "/Volumes/Private Drive/Account A/config"];
    const error = Object.assign(new Error("Command failed: gh"), {
      code: 17,
      stderr: `unknown gh failure ${privateFragments.join(" ")}`,
    });
    const h = harness(() => fail ? error : [row({ number: 7 })]);
    const logs: string[] = [];
    h.ports.log = (message, detail) => { logs.push(`${message} ${detail ?? ""}`); };
    await h.sweep();
    const before = entry();
    fail = true;
    h.advance(FORGE_LIVE_INTERVAL_MS);
    await h.sweep();
    expect(entry()).toMatchObject({ lastError: "command-failed", completeSince: before.completeSince, lastSweepAt: before.lastSweepAt, prs: before.prs });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("exit 17");
    expect(logs[0]).toContain("Check the gh installation and configuration");
    for (const fragment of privateFragments) expect(logs[0]).not.toContain(fragment);
  });

  test.each([
    ["command failure", Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" }), "command-failed", "network request failed"],
    ["empty object", {}, "malformed-output", "invalid response"],
  ] as const)("a numbered PR fill with %s keeps list evidence and waits through a nudge cooldown", async (_case, failure, code, diagnostic) => {
    let fillFails = true;
    const linked = lane({ delivery: { target: { repository: "repo-fixture", remote: `https://github.com/${REPO}.git`, branch: "main", pr: 8 } } as Pipeline["delivery"] });
    const h = harness(args => {
      if (args[0] === "pr" && args[1] === "view") {
        if (fillFails) return failure;
        return row({ number: 8 });
      }
      return [row({ number: 7 })];
    }, { pipelines: [linked] });
    const logs: string[] = [];
    h.ports.log = (message, detail) => { logs.push(`${message} ${detail ?? ""}`); };
    await h.sweep();
    expect(entry().prs["7"]).toBeDefined();
    expect(entry()).toMatchObject({ lastError: code, prs: { "7": expect.anything() }, issues: {} });
    expect(entry().prs["8"]).toBeUndefined();
    expect(logs).toEqual([expect.stringContaining(diagnostic)]);

    resetForgeCacheForTests();
    nudgeForgeSweep(REPO, T0);
    h.advance(FORGE_RETRY_MS - 1);
    expect(await h.sweep()).toEqual([]);
    expect(h.calls.filter(args => args[1] === "view")).toHaveLength(1);
    expect(entry().prs["7"]).toBeDefined();

    fillFails = false;
    h.advance(1);
    await h.sweep();
    expect(h.calls.filter(args => args[1] === "view")).toHaveLength(2);
    expect(entry().prs["8"]).toBeDefined();
    expect(entry().lastError).toBeNull();
  });

  test.each([false, true])("a slow read failure waits from completion (numbered fill: %s)", async fill => {
    const duration = FORGE_RETRY_MS + 1;
    const link = { target: { repository: "repo-fixture", remote: `https://github.com/${REPO}.git`, branch: "main", pr: 8 } } as Pipeline["delivery"];
    let fail = true;
    const h = harness(args => {
      if (fill && args[1] === "list") return [row({ number: 7 })];
      if (!fail) return fill ? row({ number: 8 }) : [row({ number: 7 })];
      h.advance(duration);
      return Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
    }, { pipelines: [lane({ ...(fill ? { delivery: link } : {}) })] });
    expect(await h.sweep()).toEqual([REPO]);
    resetForgeCacheForTests();
    const finishedAt = new Date(T0 + duration).toISOString();
    expect(entry()).toMatchObject({ lastError: "timed-out", lastAttemptAt: finishedAt,
      lastSweepAt: fill ? new Date(T0).toISOString() : null });
    if (fill) expect(entry().prs["7"]?.checkedAt).toBe(new Date(T0).toISOString());
    const calls = h.calls.length;
    fail = false;
    expect(await h.sweep()).toEqual([]);
    h.advance(FORGE_RETRY_MS - 1);
    expect(await h.sweep()).toEqual([]);
    expect(h.calls).toHaveLength(calls);
    h.advance(1);
    expect(await h.sweep()).toEqual([REPO]);
    expect(entry().lastError).toBeNull();
  });

  test.each([
    ["DNS failure", Object.assign(new Error("Command failed: gh api"), {
      code: 1, stderr: "error connecting to api.github.com: lookup api.github.com: no such host",
    }), "command-failed", "DNS lookup failed"],
    ["null PR node", { data: { repository: { p0: null } } }, "malformed-output", "invalid response"],
    ["PR lookup failure", new Error("Could not resolve to a PullRequest"), "command-failed", "repository data was not found"],
  ] as const)("legacy GraphQL %s keeps its failure classification in list and fill", async (_case, answer, code, diagnostic) => {
    for (const method of ["list", "view"]) {
      clearForgeCacheForTests(file);
      resetForgeCacheForTests();
      const delivery = { target: { repository: "repo-fixture", remote: `https://github.com/${REPO}.git`, branch: "main", pr: 8 } } as Pipeline["delivery"];
      const h = harness(args => {
        if (args[0] === "api") return answer;
        if (args[1] !== method) return [row({ number: 7 })];
        if (args.at(-1)?.includes("closingIssuesReferences")) return new Error("Unknown JSON field: closingIssuesReferences");
        return method === "list" ? [row({ number: 7 })] : row({ number: 8 });
      }, { pipelines: [lane({ delivery })] });
      const logs: string[] = [];
      h.ports.log = (message, detail) => { logs.push(`${message} ${detail ?? ""}`); };
      expect(await h.sweep()).toEqual([REPO]);
      expect(h.calls.at(-1)?.slice(0, 2)).toEqual(["api", "graphql"]);
      expect(entry().lastError).toBe(code);
      expect(logs).toEqual([expect.stringContaining(diagnostic)]);
      expect(Object.keys(entry().prs)).toEqual(method === "list" ? [] : ["7"]);
      expect(entry().issues).toEqual({});
    }
  });

  test.each(["[null]", "graphql-null"])("malformed legacy read %s reports invalid response without losing cache", async malformed => {
    let legacy = false;
    const h = harness(args => {
      if (args[0] === "api") return "graphql-null";
      if (args.at(-1)?.includes("closingIssuesReferences")) {
        return Object.assign(new Error('Unknown JSON field: "closingIssuesReferences"'), { stderr: 'Unknown JSON field: "closingIssuesReferences"' });
      }
      legacy = true;
      return malformed === "[null]" ? [null] : [row({ number: 7 })];
    });
    await h.sweep();
    expect(legacy).toBe(true);
    expect(entry().lastError).toBe("malformed-output");
    expect(entry().lastSweepAt).toBeNull();
    expect(entry().prs).toEqual({});
  });

  test("numbers a record names outright and the cache lacks are read one by one, at most ten a sweep; a non-PR is recorded as an issue", async () => {
    const tasks = [frozen({
      id: "task-a", project: "repo-fixture",
      workLinks: Array.from({ length: 14 }, (_, index) => ({ repository: REPO, number: 500 + index, kind: null, addedAt: "2026-09-23T00:00:00Z", addedBy: "operator" })),
    } as unknown as BoardTask)];
    const h = harness((args) => {
      if (args[1] === "view") {
        const number = Number(args[2]);
        if (number % 2) return Object.assign(new Error("gh failed"), { stderr: `GraphQL: Could not resolve to a PullRequest with the number of ${number}.` });
        return row({ number });
      }
      return [row({ number: 7 })];
    }, { tasks });
    await h.sweep();
    expect(h.calls.filter((args) => args[1] === "view")).toHaveLength(FORGE_FILL_LIMIT);
    expect(Object.keys(entry().prs).filter((key) => Number(key) >= 500)).toHaveLength(5);
    expect(Object.keys(entry().issues)).toHaveLength(5);
  });

  test("the sweep writes no record and nothing but its cache", async () => {
    const h = harness(() => [row({ number: 7, headRefName: "pipeline/lane-a" })]);
    /* Every record is deep-frozen: a write would throw inside the sweep. */
    await expect(h.sweep()).resolves.toEqual([REPO]);
    expect(fs.readdirSync(dir).filter((name) => !name.startsWith("state.sqlite") && !name.startsWith("forge-links.json"))).toEqual([]);
    const db = new Database(path.join(dir, "state.sqlite"), { readonly: true });
    try {
      expect(db.query<{ collection: string }, []>("SELECT DISTINCT collection FROM state_rows").all().map((rowOf) => rowOf.collection)).toEqual([FORGE_LINKS_COLLECTION]);
    } finally { db.close(); }
  });

  test("a stage report's PR reaches the cache at once, without a forge call, and never overrides a fresher state", () => {
    observeForgePullRequest(REPO, { url: "https://github.com/acme/widgets/pull/9", number: 9, state: "OPEN" }, "pipeline/lane-a", "2026-09-23T10:00:00Z", file);
    expect(entry().prs["9"]).toMatchObject({ state: "open", headRefName: "pipeline/lane-a" });
    expect(entry().completeSince).toBeNull();
    updateForgeCache((data) => { data.repositories[REPO]!.prs["9"] = { ...data.repositories[REPO]!.prs["9"]!, headRefName: "other", state: "merged" }; }, file);
    observeForgePullRequest(REPO, { url: "https://github.com/acme/widgets/pull/9", number: 9, state: "OPEN" }, "pipeline/lane-a", "2026-09-23T10:05:00Z", file);
    expect(entry().prs["9"]).toMatchObject({ state: "merged", headRefName: "pipeline/lane-a" });
  });
});

test("the board's read path has no way to reach the forge: only the sweep imports the gh seam", () => {
  const source = (name: string) => fs.readFileSync(path.join(import.meta.dir, name), "utf8");
  for (const name of ["workLinks.ts", "cache.ts", "resolve.ts"]) {
    expect(source(name)).not.toMatch(/^import .*(child_process|githubEvidence|"\.\/sweep")/m);
  }
  expect(source("sweep.ts")).toContain("githubRunner");
});
