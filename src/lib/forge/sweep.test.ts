import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import { nudgeForgeSweep, observeForgePullRequest, readForgeCache, resetForgeCacheForTests } from "./cache";
import { FORGE_FILL_LIMIT, FORGE_IDLE_INTERVAL_MS, FORGE_LIVE_INTERVAL_MS, FORGE_NUDGE_DEBOUNCE_MS, FORGE_PAGE_LIMIT, sweepForgeLinks, type ForgeSweepPorts } from "./sweep";

/* The forge sweep (#2059) against an injected `gh` and clock, in a private
   directory: invented repositories and branches, no network, no state store. */

const REPO = "acme/widgets";
const T0 = Date.parse("2026-09-23T10:00:00Z");

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sweep-"));
  file = path.join(dir, "forge-links.json");
  resetForgeCacheForTests();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetForgeCacheForTests();
});

type Row = { number: number; headRefName?: string; state?: string; isDraft?: boolean; createdAt?: string; updatedAt?: string; closes?: number[] };
const row = (entry: Row) => ({
  number: entry.number,
  url: `https://github.com/acme/widgets/pull/${entry.number}`,
  headRefName: entry.headRefName ?? `feature/${entry.number}`,
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
    fs.rmSync(file, { force: true });
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

  test("the sweep writes no record and nothing but its cache file", async () => {
    const h = harness(() => [row({ number: 7, headRefName: "pipeline/lane-a" })]);
    /* Every record is deep-frozen: a write would throw inside the sweep. */
    await expect(h.sweep()).resolves.toEqual([REPO]);
    expect(fs.readdirSync(dir)).toEqual(["forge-links.json"]);
  });

  test("a stage report's PR reaches the cache at once, without a forge call, and never overrides a fresher state", () => {
    observeForgePullRequest(REPO, { url: "https://github.com/acme/widgets/pull/9", number: 9, state: "OPEN" }, "pipeline/lane-a", "2026-09-23T10:00:00Z", file);
    expect(entry().prs["9"]).toMatchObject({ state: "open", headRefName: "pipeline/lane-a" });
    expect(entry().completeSince).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, repositories: { [REPO]: { ...entry(), prs: { 9: { ...entry().prs["9"], headRefName: "other", state: "merged" } } } } }));
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
