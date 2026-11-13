import { expect, test } from "bun:test";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import { buildPipeline } from "@/lib/pipelines/store";
import { emptyRepositoryEntry, forgeViewOf, type ForgeCacheFile } from "./cache";
import { ForgeAppWriteRefused, forgeWriter } from "./appWrite";
import { creationIssueLinks, deliveredIssues, issueDeliveryHoldsArchive, issueDeliverySeatSignals, sweepIssueDelivery, type IssueDeliveryPorts } from "./issueDelivery";
import { editStoredWorkLinks, type StoredWorkLink } from "./workLinks";

const REPO = "acme/widgets";
const AT = "2026-11-01T12:00:00.000Z";
const NOW = Date.parse(AT) + 1000;
const link = (number = 3900, part = false): StoredWorkLink => ({ repository: REPO, number, kind: "issue", addedAt: AT, addedBy: "agent", ...(part ? { part: true } : {}) });
function lane(id = "lane", number = 3909): Pipeline {
  const p = buildPipeline({ id, task: "#3900 Deliver widget controls", taskIds: ["outcome"], project: "fixture", repoDir: "fixture", stages: [], srcPath: null, srcConversationId: null, now: AT });
  p.state = "completed"; p.closedAt = AT; p.workLinks = [link()];
  p.delivery = { target: { repository: "fixture", remote: `https://github.com/${REPO}.git`, branch: `refs/heads/${p.branch}`, pr: number }, disposition: "owner", publish: "disabled", ownerId: id, epoch: 1, active: false, journal: [] };
  p.merge = { state: "merged", mergedAt: AT, repository: REPO, prNumber: number } as Pipeline["merge"];
  return p;
}
function fixture(lanes = [lane()]) {
  let now = NOW;
  const data: ForgeCacheFile = { schemaVersion: 1, repositories: { [REPO]: emptyRepositoryEntry() } };
  const writes: string[][] = [], reads: string[][] = [];
  const comments: Array<{ body: string; created_at: string }> = [];
  const tasks: BoardTask[] = [];
  const issue = { state: "open", state_reason: null as string | null, pull_request: undefined as unknown };
  const primary = { number: 3909, state: "closed", merged_at: AT as string | null, merge_commit_sha: "c".repeat(40), base: { ref: "main", repo: { default_branch: "main" } }, title: "Deliver widget controls", head: { ref: "pipeline/lane", sha: "a".repeat(40) } };
  let closer: { number: number; repository: { nameWithOwner: string } } | null = null;
  const ports: IssueDeliveryPorts = {
    now: () => now, since: () => "2026-11-01T00:00:00.000Z", loadPipelines: () => lanes, loadTasks: ids => tasks.filter(t => ids.has(t.id)),
    repositoryOf: p => p.delivery ? REPO : null, pullRequestOf: p => p.delivery?.target.pr ? { repository: REPO, number: p.delivery.target.pr } : null,
    cache: () => ({ data, view: forgeViewOf(data) }), inspectTitle: async () => true,
    mutate: async (id, change) => { const p = lanes.find(p => p.id === id); return p ? change(p) : false; },
    run: async args => {
      reads.push(args);
      const route = args[1]!;
      if (route === "graphql") return JSON.stringify({ data: { repository: { issue: { timelineItems: { nodes: [{ closer }] } } } } });
      if (route.includes("/compare/")) return JSON.stringify({ base_commit: { sha: primary.merge_commit_sha }, merge_base_commit: { sha: "d".repeat(40) } });
      if (route.includes("/commits/") && route.endsWith("/pulls?per_page=100")) return JSON.stringify([]);
      if (route.includes("/pulls/")) return JSON.stringify(primary);
      if (route.includes("/comments?")) return JSON.stringify(comments);
      if (/\/issues\/\d+$/.test(route)) return JSON.stringify(issue);
      throw new Error(`Unexpected read ${route}`);
    },
    write: async (args, _repo, before) => {
      before?.(); writes.push(args);
      const values = args.filter((_, i) => args[i - 1] === "-f");
      const body = values.find(v => v.startsWith("body="));
      if (body) comments.push({ body: body.slice(5), created_at: AT });
      if (values.includes("state=closed")) { issue.state = "closed"; issue.state_reason = "completed"; }
      if (values.includes("state=open")) issue.state = "open";
      return "{}";
    },
  };
  return { lanes, ports, data, reads, writes, issue, primary, comments, tasks, sweep: () => sweepIssueDelivery(ports), advance: () => { now += 600_000; }, closer: (number: number) => { closer = { number, repository: { nameWithOwner: REPO } }; } };
}

test("reported title closes the delivered issue as completed once, independently of PR body", async () => {
  const f = fixture();
  f.lanes[0]!.workLinks = creationIssueLinks(f.lanes[0]!, { repository: REPO, cache: forgeViewOf(f.data), lanes: [], pullRequestOf: f.ports.pullRequestOf });
  await f.sweep();
  expect(f.comments.map(c => c.body)).toEqual(["Landed in #3909."]);
  expect(f.writes.at(-1)).toContain("state_reason=completed");
  expect(f.lanes[0]!.issueDelivery).toMatchObject([{ number: 3900, state: "closed", mode: "close", pr: 3909 }]);
  const calls = f.reads.length; f.issue.state = "open"; await f.sweep();
  expect(f.reads.length).toBe(calls); expect(f.writes).toHaveLength(2); expect(f.issue.state).toBe("open");
});

test.each(["#3900 Build", "acme/widgets#3900 Build", "Issue #3900: Build", "Build (#3900)"])("creation accepts first-line issue reference %s", title => {
  const f = fixture(); f.lanes[0]!.task = `${title}\nDetails #7`;
  expect(creationIssueLinks(f.lanes[0]!, { repository: REPO, cache: forgeViewOf(f.data), lanes: [], pullRequestOf: f.ports.pullRequestOf })).toMatchObject([{ number: 3900 }]);
});
test.each(["PR #3900 Build", "Build #3900 controls", "Build\n#3900", "other/widgets#3900 Build"])("creation ignores %s", title => {
  const f = fixture(); f.lanes[0]!.task = title;
  expect(creationIssueLinks(f.lanes[0]!, { repository: REPO, cache: forgeViewOf(f.data), lanes: [], pullRequestOf: f.ports.pullRequestOf })).toEqual([]);
});
function cached(f: ReturnType<typeof fixture>, n: number, state: "open" | "merged" | "closed", title = "Widget work", head = "pipeline/lane") {
  f.data.repositories[REPO]!.prs[String(n)] = { url: `https://github.com/${REPO}/pull/${n}`, state, headRefName: head, createdAt: AT, checkedAt: AT, closes: [], title, ...(state === "merged" ? { mergedAt: AT } : {}) };
}
test("cached PR titles copy only the same-task predecessor and preserve partial markers", () => {
  const source = lane("source", 3845); source.workLinks = [link(7, true)];
  const unrelated = lane("unrelated", 3846); unrelated.workLinks = [link(8)];
  const next = lane("next"); next.task = "#3845 successor";
  const f = fixture([unrelated, source, next]); cached(f, 3845, "merged");
  const opts = { repository: REPO, cache: forgeViewOf(f.data), lanes: f.lanes, pullRequestOf: f.ports.pullRequestOf };
  expect(creationIssueLinks(next, opts)).toEqual([link(7, true)]);
  source.taskIds = ["other"]; expect(creationIssueLinks(next, opts)).toEqual([]);
  expect(creationIssueLinks(next, { ...opts, predecessorId: "source" })).toEqual([link(7, true)]);
});
test.each(["pr", "404"])("uncached title that resolves to %s is skipped without writes", async kind => {
  const f = fixture(); f.lanes[0]!.workLinks![0]!.kind = null;
  if (kind === "pr") f.issue.pull_request = {};
  else { const run = f.ports.run; f.ports.run = args => args[1]!.endsWith("/issues/3900") ? Promise.reject(new Error("HTTP 404")) : run(args); }
  await f.sweep(); expect(f.writes).toEqual([]); expect(f.lanes[0]!.issueDelivery).toMatchObject([{ state: "skipped", reason: "not-an-issue" }]);
});
test("task links added after creation count, lane partial markers override them", async () => {
  const f = fixture(); f.lanes[0]!.workLinks = [];
  f.tasks.push({ id: "outcome", workLinks: [link()] } as BoardTask);
  await f.sweep(); expect(f.issue.state).toBe("closed");
  f.lanes[0]!.workLinks = [link(3900, true)];
  expect(deliveredIssues(f.lanes[0]!, f.tasks, REPO, forgeViewOf(f.data))).toEqual([link(3900, true)]);
});
test("attach-link partial flag sets, preserves, clears and reports changes", () => {
  const meta = { now: AT, addedBy: "agent" as const };
  const edit = (links: StoredWorkLink[], part?: boolean) => editStoredWorkLinks(links, [{ ...link(), part }], [], meta);
  const added = edit([], true); expect(added).toMatchObject({ changed: true, links: [{ part: true }] });
  if (!added.ok) throw new Error("Attach refused");
  expect(edit(added.links)).toMatchObject({ changed: false, links: [{ part: true }] });
  const cleared = edit(added.links, false); expect(cleared).toMatchObject({ changed: true });
  if (!cleared.ok) throw new Error("Clear refused");
  expect(cleared.links[0]).not.toHaveProperty("part");
});
test.each(["open", "own-close", "other-close", "full-close"])("partial delivery handles %s and deduplicates the note", async kind => {
  const f = fixture(); f.lanes[0]!.workLinks = [link(3900, true)];
  if (kind !== "open") { f.issue.state = "closed"; f.closer(kind === "other-close" ? 77 : 3909); }
  if (kind === "full-close") {
    const full = lane("full", 77); full.issueDelivery = [{ repository: REPO, number: 3900, mode: "close", pr: 77, state: "closed", at: AT }]; f.lanes.push(full);
  }
  await f.sweep(); await f.sweep();
  expect(f.comments.map(c => c.body)).toEqual(["Part of this issue landed in #3909: Deliver widget controls"]);
  expect(f.writes.filter(args => args.includes("state=open"))).toHaveLength(kind === "own-close" ? 1 : 0);
  expect(f.issue.state).toBe(["other-close", "full-close"].includes(kind) ? "closed" : "open");
});
test("partial note omits a title refused by the publication inspector", async () => {
  const f = fixture(); f.lanes[0]!.workLinks = [link(3900, true)];
  f.ports.inspectTitle = async title => (await (await import("@/lib/pipelines/stagePullRequest")).inspectPullRequestText("title", title)).ok;
  f.primary.title = "Widget ".repeat(20); await f.sweep();
  expect(f.comments[0]?.body).toBe("Part of this issue landed in #3909.");
});
test.each(["cached", "receipt"])("batch %s closes both carried lanes, naming the batch", async kind => {
  const f = fixture([lane("first", 3909), lane("second", 3910)]); f.lanes[1]!.workLinks = [link(3902)];
  f.primary.number = 4000; f.primary.head.ref = "merge-batch/widgets"; f.primary.title = "Merge batch: #3909, #3910";
  if (kind === "cached") {
    for (const p of f.lanes) { delete p.merge; cached(f, p.delivery!.target.pr!, "closed"); }
    cached(f, 4000, "merged", f.primary.title, f.primary.head.ref);
  } else {
    for (const p of f.lanes) p.merge!.mergeCommit = "a".repeat(40);
    const run = f.ports.run; f.ports.run = args => args[1]!.includes("/commits/") ? Promise.resolve(JSON.stringify([f.primary])) : /\/pulls\/39/.test(args[1]!) ? Promise.resolve(JSON.stringify({ merged_at: null })) : run(args);
  }
  // Separate issue states while keeping the shared forge fixture compact.
  const run = f.ports.run; f.ports.run = args => /\/issues\/\d+$/.test(args[1]!) ? Promise.resolve(JSON.stringify({ state: f.writes.some(a => a[1] === args[1] && a.includes("state=closed")) ? "closed" : "open", state_reason: "completed" })) : run(args);
  await f.sweep();
  expect(f.comments.map(c => c.body)).toEqual(["Landed in #4000 (carrying #3909).", "Landed in #4000 (carrying #3910)."]);
  expect(f.lanes.map(p => p.issueDelivery?.[0]?.state)).toEqual(["closed", "closed"]);
});
test("partial issue closed by the batch is reopened", async () => {
  const f = fixture(); f.lanes[0]!.workLinks = [link(3900, true)]; f.issue.state = "closed"; f.closer(4000);
  cached(f, 3909, "closed"); cached(f, 4000, "merged", "Merge batch: #3909", "merge-batch/widgets");
  f.primary.head.ref = "merge-batch/widgets"; f.primary.title = "Merge batch: #3909";
  await f.sweep(); expect(f.issue.state).toBe("open"); expect(f.lanes[0]!.issueDelivery?.[0]?.state).toBe("reopened");
});
test("a human merge needs no runner merge record", async () => {
  const f = fixture(); delete f.lanes[0]!.merge; cached(f, 3909, "merged");
  await f.sweep(); expect(f.issue.state).toBe("closed");
});
test.each(["stale", "old", "other-base"])("primary landing check handles %s without a write", async kind => {
  const f = fixture(); if (kind === "stale") f.primary.merged_at = null;
  if (kind === "old") f.primary.merged_at = "2026-10-01T00:00:00Z";
  if (kind === "other-base") f.primary.base.ref = "release";
  await f.sweep(); expect(f.writes).toEqual([]);
  if (kind === "other-base") expect(f.lanes[0]!.issueDelivery?.[0]).toMatchObject({ state: "pending", failures: 0 });
});
test("old deliveries make no issue writes, and Git-only lanes make no forge calls", async () => {
  const f = fixture(); f.ports.since = () => "2026-11-02T00:00:00Z"; await f.sweep();
  expect(f.writes).toEqual([]);
  delete f.lanes[0]!.delivery; f.ports.since = () => AT;
  const reads = f.reads.length;
  expect(creationIssueLinks(f.lanes[0]!, { repository: null, cache: forgeViewOf(f.data), lanes: [], pullRequestOf: f.ports.pullRequestOf })).toEqual([]);
  await f.sweep(); expect(f.reads).toHaveLength(reads); expect(f.writes).toEqual([]);
});
test.each(["comment", "close", "reopen"])("a timed-out %s is reconciled before retry", async kind => {
  const f = fixture(); if (kind === "reopen") { f.lanes[0]!.workLinks = [link(3900, true)]; f.issue.state = "closed"; f.closer(3909); }
  const write = f.ports.write; let failed = false;
  f.ports.write = async (...args) => {
    const result = await write(...args);
    if (!failed && (kind === "comment" ? args[0][1]!.endsWith("/comments") : args[0].includes(kind === "close" ? "state=closed" : "state=open"))) { failed = true; throw new Error("timeout"); }
    return result;
  };
  await f.sweep(); expect(f.lanes[0]!.issueDelivery?.[0]).toMatchObject({ state: "pending", failures: 1 });
  f.advance(); await f.sweep();
  expect(f.comments).toHaveLength(1);
  expect(f.writes.filter(a => a.includes("state=closed"))).toHaveLength(kind === "reopen" ? 0 : 1);
  expect(f.lanes[0]!.issueDelivery?.[0]?.state).toBe(kind === "close" ? "already-closed" : kind === "comment" ? "closed" : "noted");
});
test("App refusal never falls back to a person and produces a seat signal", async () => {
  const f = fixture(); let personal = 0;
  f.ports.write = forgeWriter(async () => { personal++; return "{}"; }, async () => { throw new ForgeAppWriteRefused("grant unavailable"); }, () => true);
  await f.sweep(); expect(personal).toBe(0);
  expect(f.lanes[0]!.issueDelivery?.[0]).toMatchObject({ state: "refused", reason: "app-permission" });
  expect(issueDeliverySeatSignals(f.lanes, "fixture")).toHaveLength(1);
  expect(issueDeliverySeatSignals(f.lanes, "other")).toEqual([]);
});
test("three failures refuse, immediate retry does no I/O, archive hold has a bound", async () => {
  const f = fixture(); f.ports.run = async () => { throw new Error("offline"); };
  expect(issueDeliveryHoldsArchive(f.lanes[0]!, NOW)).toBe(true);
  for (let i = 0; i < 3; i++) { await f.sweep(); f.advance(); }
  expect(f.lanes[0]!.issueDelivery?.[0]).toMatchObject({ state: "refused", failures: 3, reason: "github-unavailable" });
  expect(issueDeliveryHoldsArchive(f.lanes[0]!, NOW)).toBe(false);
  delete f.lanes[0]!.issueDelivery;
  expect(issueDeliveryHoldsArchive(f.lanes[0]!, NOW + 31 * 86400_000)).toBe(false);
});
test("per-pass I/O is bounded to ten issues", async () => {
  const f = fixture(); f.lanes[0]!.workLinks = Array.from({ length: 15 }, (_, i) => link(100 + i));
  await f.sweep(); expect(f.lanes[0]!.issueDelivery).toHaveLength(10);
  await f.sweep(); expect(f.lanes[0]!.issueDelivery).toHaveLength(15);
});
test.each(["primary", "issue", "comments", "inspection", "credentials"])("detaching after the %s wait prevents every later write", async point => {
  const f = fixture(); if (point === "inspection") f.lanes[0]!.workLinks = [link(3900, true)];
  const detach = () => { f.lanes[0]!.workLinks = []; };
  const run = f.ports.run;
  f.ports.run = async args => {
    const result = await run(args);
    if ((point === "primary" && args[1]!.includes("/pulls/")) || (point === "issue" && args[1]!.endsWith("/issues/3900")) || (point === "comments" && args[1]!.includes("/comments?"))) detach();
    return result;
  };
  if (point === "inspection") f.ports.inspectTitle = async () => { detach(); return true; };
  if (point === "credentials") f.ports.write = async (_args, _repo, before) => { await Promise.resolve(); detach(); before?.(); throw new Error("Must not dispatch"); };
  await f.sweep(); expect(f.writes).toEqual([]);
});

test.each(["lane", "task"])("foreign repository issues on a %s never authorize a write", async source => {
  const f = fixture(); const foreign = { ...link(), repository: "other/widgets" };
  f.lanes[0]!.workLinks = source === "lane" ? [foreign] : [];
  if (source === "task") f.tasks.push({ id: "outcome", workLinks: [foreign] } as BoardTask);
  await f.sweep(); expect(f.reads).toEqual([]); expect(f.writes).toEqual([]);
});
test("canonical repository names preserve issue delivery after a rename", async () => {
  const f = fixture(); f.lanes[0]!.workLinks = [{ ...link(), repository: "acme/old-widgets" }];
  f.data.repositories["acme/old-widgets"] = { ...emptyRepositoryEntry(), canonical: REPO };
  await f.sweep(); expect(f.lanes[0]!.issueDelivery?.[0]).toMatchObject({ repository: REPO, state: "closed" });
});
test("a warm cache snapshot avoids history rescans and a replacement refines the landing", async () => {
  const f = fixture(); delete f.lanes[0]!.merge; cached(f, 3909, "open");
  let scans = 0;
  f.data.repositories[REPO]!.prs = new Proxy(f.data.repositories[REPO]!.prs, { ownKeys: object => { scans++; return Reflect.ownKeys(object); } });
  const view = forgeViewOf(f.data); f.ports.cache = () => ({ data: f.data, view });
  await f.sweep(); const first = scans; await f.sweep();
  expect(scans).toBe(first); expect(f.reads).toEqual([]);
  const data: ForgeCacheFile = { ...f.data, repositories: { [REPO]: { ...emptyRepositoryEntry(), prs: { "3909": { ...f.data.repositories[REPO]!.prs["3909"]!, state: "merged", mergedAt: AT } } } } };
  f.ports.cache = () => ({ data, view: forgeViewOf(data) });
  await f.sweep(); expect(f.issue.state).toBe("closed");
});
test("an authoritative merge settles a closed cache entry without waiting for cache replacement", async () => {
  const f = fixture(); f.lanes[0]!.merge = undefined; cached(f, 3909, "closed");
  await f.sweep(); expect(f.issue.state).toBe("closed");
});
test.each(["closer", "pending-save"])("a detached link after the %s await cannot write", async point => {
  const f = fixture();
  if (point === "closer") {
    f.lanes[0]!.workLinks = [link(3900, true)]; f.issue.state = "closed"; f.closer(3909);
    const run = f.ports.run; f.ports.run = async args => { const result = await run(args); if (args[1] === "graphql") f.lanes[0]!.workLinks = []; return result; };
  } else {
    const mutate = f.ports.mutate; f.ports.mutate = async (...args) => { const result = await mutate(...args); f.lanes[0]!.workLinks = []; return result; };
  }
  await f.sweep(); expect(f.writes).toEqual([]);
});
test.each(["closer", "readback", "comments"])("a refused %s read keeps its reason and retries without claiming delivery", async point => {
  const f = fixture();
  if (point === "closer") { f.lanes[0]!.workLinks = [link(3900, true)]; f.issue.state = "closed"; }
  const run = f.ports.run;
  f.ports.run = async args => {
    if ((point === "closer" && args[1] === "graphql") || (point === "comments" && args[1]!.includes("/comments?")) || (point === "readback" && f.issue.state === "closed")) throw new Error("unavailable");
    return run(args);
  };
  await f.sweep(); expect(f.lanes[0]!.issueDelivery?.[0]).toMatchObject({ state: "pending", failures: 1, reason: "github-unavailable" });
});

test.each(["missing", "malformed", "multiple"])("paginated comment output handles %s pages", async kind => {
  const f = fixture(); const run = f.ports.run;
  f.ports.run = async args => {
    if (!args[1]!.includes("/comments?")) return run(args);
    expect(args.slice(-3)).toEqual(["--paginate", "--jq", "@json"]);
    return kind === "missing" ? "" : kind === "malformed" ? "{}" : `[]\n${JSON.stringify([{ body: "Landed in #3909.", created_at: AT }])}\n[]\n`;
  };
  await f.sweep();
  if (kind === "multiple") {
    expect(f.lanes[0]!.issueDelivery?.[0]?.state).toBe("closed");
    expect(f.writes).toHaveLength(1); expect(f.comments).toEqual([]);
  } else {
    expect(f.lanes[0]!.issueDelivery?.[0]).toMatchObject({ state: "pending", reason: "github-unavailable" }); expect(f.writes).toEqual([]);
  }
});


test("a repository rename preserves final delivery when a person reopens the issue", async () => {
  const f = fixture(); await f.sweep(); f.issue.state = "open";
  const data: ForgeCacheFile = { ...f.data, repositories: { [REPO]: { ...f.data.repositories[REPO]!, canonical: "acme/renamed-widgets" } } };
  f.ports.cache = () => ({ data, view: forgeViewOf(data) });
  const calls = f.reads.length; await f.sweep();
  expect(f.reads).toHaveLength(calls); expect(f.writes).toHaveLength(2); expect(f.issue.state).toBe("open");
});


test.each(["git-only", "ordinary", "issue", "refresh"])("creation reads only the needed context for %s", kind => {
  const f = fixture(); const p = f.lanes[0]!;
  p.task = kind === "issue" ? "Issue #3900: Widget controls" : "Widget controls";
  const reads = { cache: 0, lanes: 0, predecessor: 0 };
  const links = creationIssueLinks(p, {
    repository: kind === "git-only" ? null : REPO,
    cache: () => { reads.cache++; return forgeViewOf(f.data); },
    lanes: () => { reads.lanes++; throw new Error("Creation must not scan unrelated lanes"); },
    ...(kind === "refresh" ? { predecessorId: "prior" } : {}),
    predecessor: id => { expect(id).toBe("prior"); reads.predecessor++; return { ...p, id, workLinks: [link(3900, true)] }; },
    pullRequestOf: f.ports.pullRequestOf,
  });
  expect(reads).toEqual({ cache: ["issue", "refresh"].includes(kind) ? 1 : 0, lanes: 0, predecessor: kind === "refresh" ? 1 : 0 });
  expect(links).toHaveLength(["issue", "refresh"].includes(kind) ? 1 : 0);
  if (kind === "refresh") expect(links[0]?.part).toBe(true);
});

test("a batch-branch delivery waits for its merge commit to reach the default branch", async () => {
  const f = fixture(); f.primary.base.ref = "batch/widgets";
  let landed = false, reads = 0;
  f.ports.readLanding = async args => {
    reads++;
    expect(args[1]).toBe(`repos/${REPO}/compare/${"c".repeat(40)}...main?per_page=1`);
    return JSON.stringify({ base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: (landed ? "c" : "d").repeat(40) } });
  };
  await f.sweep();
  expect(f.lanes[0]!.issueDelivery).toMatchObject([{ state: "pending", failures: 0 }]);
  expect(f.writes).toEqual([]);
  await f.sweep(); expect(reads).toBe(1);
  f.advance(); landed = true; await f.sweep();
  expect(f.issue.state).toBe("closed");
  expect(f.lanes[0]!.issueDelivery).toMatchObject([{ state: "closed" }]);
});

test.each(["batch/widgets", "stage/widgets", "integration/widgets", "release"])("a partial delivery through %s stays open after reaching main", async branch => {
  const f = fixture(); f.primary.base.ref = branch; f.lanes[0]!.workLinks![0]!.part = true;
  f.ports.readLanding = async () => JSON.stringify({ base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } });
  await f.sweep();
  expect(f.issue.state).toBe("open"); expect(f.comments).toHaveLength(1);
  expect(f.lanes[0]!.issueDelivery).toMatchObject([{ state: "noted" }]);
});

test.each(["bad-sha", "wrong-base", "invalid-proof", "offline"])("batch landing refuses %s evidence before an issue write", async mode => {
  const f = fixture(); f.primary.base.ref = "batch/widgets";
  if (mode === "bad-sha") f.primary.merge_commit_sha = "../main";
  let reads = 0;
  f.ports.readLanding = async () => {
    reads++;
    if (mode === "offline") throw new Error("offline");
    return JSON.stringify({ base_commit: { sha: (mode === "wrong-base" ? "d" : "c").repeat(40) },
      ...(mode === "invalid-proof" ? {} : { merge_base_commit: { sha: "c".repeat(40) } }) });
  };
  await f.sweep(); expect(f.writes).toEqual([]);
  expect(f.lanes[0]!.issueDelivery).toMatchObject([{ state: "pending", failures: 1, reason: "github-unavailable" }]);
  expect(reads).toBe(mode === "bad-sha" ? 0 : 1);
});

test("detaching during the batch comparison prevents every later write", async () => {
  const f = fixture(); f.primary.base.ref = "batch/widgets";
  f.ports.readLanding = async () => {
    f.lanes[0]!.workLinks = [];
    return JSON.stringify({ base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "c".repeat(40) } });
  };
  await f.sweep(); expect(f.writes).toEqual([]);
});

test("a waiting batch delivery leaves the sweep free to settle a peer", async () => {
  const first = lane("waiting"), peer = lane("peer", 3910); peer.workLinks = [link(3901)];
  const f = fixture([first, peer]); f.primary.base.ref = "batch/widgets";
  const run = f.ports.run;
  f.ports.run = async args => args[1]!.endsWith("/pulls/3910")
    ? JSON.stringify({ ...f.primary, base: { ref: "main", repo: { default_branch: "main" } } }) : run(args);
  f.ports.readLanding = async () => JSON.stringify({ base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: "d".repeat(40) } });
  await f.sweep();
  expect(first.issueDelivery).toMatchObject([{ state: "pending", failures: 0 }]);
  expect(peer.issueDelivery).toMatchObject([{ state: "closed" }]);
  expect(f.writes.every(args => args[1]!.includes("/issues/3901"))).toBe(true);
});

test("a durable pending task-only issue holds archival until its existing thirty-day bound", () => {
  const p = lane(); p.workLinks = [];
  p.issueDelivery = [{ repository: REPO, number: 3900, pr: 3909, mode: "close", state: "pending", at: AT }];
  expect(issueDeliveryHoldsArchive(p, Date.parse(AT) + 10 * 86400_000)).toBe(true);
  expect(issueDeliveryHoldsArchive(p, Date.parse(AT) + 31 * 86400_000)).toBe(false);
});

test.each([false, true])("a locally squashed closed PR waits for its carrier and settles partial=%s", async partial => {
  const f = fixture(); const p = f.lanes[0]!; p.merge = undefined;
  cached(f, 3909, "closed"); f.primary.merged_at = null; f.primary.base.ref = "batch/widgets";
  if (partial) { p.workLinks![0]!.part = true; f.issue.state = "closed"; f.closer(4000); }
  let merged = false, proofs = 0;
  const run = f.ports.run;
  f.ports.run = async args => args[1]!.endsWith("/pulls/4000") ? JSON.stringify({
    number: 4000, state: merged ? "closed" : "open", merged_at: merged ? AT : null,
    base: { ref: "main", repo: { default_branch: "main" } }, head: { ref: "batch/widgets" }, title: "Widget batch",
  }) : run(args);
  f.ports.carriedLanding = async (_lane, repository, pr, base, head) => {
    proofs++; expect({ repository, pr, base, head }).toEqual({ repository: REPO, pr: 3909, base: "main", head: "a".repeat(40) });
    return merged ? { state: "landed", batch: 4000, mergedAt: AT, commit: "c".repeat(40) } : { state: "waiting", batch: 4000 };
  };
  await f.sweep(); expect(p.issueDelivery).toMatchObject([{ state: "pending", batch: 4000, failures: 0 }]);
  expect(f.writes).toEqual([]);
  f.advance(); await f.sweep(); expect(proofs).toBe(1);
  f.advance(); merged = true; await f.sweep();
  expect(p.issueDelivery).toMatchObject([{ state: partial ? "reopened" : "closed", batch: 4000 }]);
  expect(f.issue.state).toBe(partial ? "open" : "closed");
  expect(f.comments).toHaveLength(1);
  expect(f.comments[0]!.body).toContain("#4000 (carrying #3909)");
});

test("closed batch probes without a receipt never spend the entire sweep on the same lanes", async () => {
  const lanes = Array.from({ length: 13 }, (_, index) => {
    const p = lane(`lane-${index}`, 4000 + index); p.merge = undefined; p.workLinks = [link(5000 + index, index === 12)]; return p;
  });
  const f = fixture(lanes); f.primary.merged_at = null; f.primary.base.ref = "batch/widgets";
  for (let index = 0; index < lanes.length; index++) cached(f, 4000 + index, "closed");
  f.ports.carriedLanding = async () => ({ state: "waiting" });
  await f.sweep(); expect(lanes.filter(p => p.issueDelivery?.length)).toHaveLength(10);
  f.advance(); await f.sweep(); expect(lanes.filter(p => p.issueDelivery?.length)).toHaveLength(13);
  expect(lanes[12]!.issueDelivery?.[0]?.mode).toBe("part");
  expect(f.writes).toEqual([]);
});

test("detaching while closed-PR patch verification waits prevents issue writes", async () => {
  const f = fixture(); f.lanes[0]!.merge = undefined; cached(f, 3909, "closed");
  f.primary.merged_at = null; f.primary.base.ref = "batch/widgets";
  f.ports.carriedLanding = async () => {
    f.lanes[0]!.workLinks = [];
    return { state: "landed", batch: 4000, mergedAt: AT, commit: "c".repeat(40) };
  };
  await f.sweep(); expect(f.writes).toEqual([]);
});

test.each(["proof", "issue", "comments", "credentials"] as const)("a reviewed head changed during %s prevents later issue writes", async point => {
  const f = fixture(); const p = f.lanes[0]!; p.merge = undefined; p.lastPassedCommit = "a".repeat(40);
  cached(f, 3909, "closed"); f.primary.merged_at = null; f.primary.base.ref = "batch/widgets";
  const run = f.ports.run;
  f.ports.run = async args => {
    if (args[1]!.endsWith("/pulls/4000")) return JSON.stringify({ number: 4000, merged_at: AT, head: { ref: "batch/widgets" }, base: { ref: "main", repo: { default_branch: "main" } } });
    const value = await run(args);
    if ((point === "issue" && args[1]!.endsWith("/issues/3900")) || (point === "comments" && args[1]!.includes("/issues/3900/comments?"))) p.lastPassedCommit = "b".repeat(40);
    return value;
  };
  f.ports.carriedLanding = async () => {
    if (point === "proof") p.lastPassedCommit = "b".repeat(40);
    return { state: "landed", batch: 4000, mergedAt: AT, commit: "c".repeat(40) };
  };
  if (point === "credentials") f.ports.write = async (_args, _repository, before) => {
    p.lastPassedCommit = "b".repeat(40); before?.(); throw new Error("Must not dispatch");
  };
  await f.sweep(); expect(f.writes).toEqual([]);
});

test("a changed reviewed head invalidates a cached open carrier", async () => {
  const f = fixture(); const p = f.lanes[0]!; p.merge = undefined; p.lastPassedCommit = "a".repeat(40);
  cached(f, 3909, "closed"); f.primary.merged_at = null; f.primary.base.ref = "batch/widgets";
  const heads: string[] = [], run = f.ports.run;
  f.ports.run = async args => args[1]!.endsWith("/pulls/4000")
    ? JSON.stringify({ state: "open", merged_at: null, head: { ref: "batch/old" } }) : run(args);
  f.ports.carriedLanding = async (_lane, _repo, _pr, _base, head) => {
    heads.push(head);
    return { state: "waiting", batch: head === "a".repeat(40) ? 4000 : 5000, commit: "c".repeat(40) };
  };
  await f.sweep(); f.advance(); p.lastPassedCommit = "b".repeat(40); await f.sweep();
  expect(heads).toEqual(["a".repeat(40), "b".repeat(40)]);
  expect(p.issueDelivery).toMatchObject([{ state: "pending", batch: 5000, batchHead: "b".repeat(40) }]);
  expect(f.writes).toEqual([]);
});

test("a declined cached carrier is replaced only by a fresh verified landing", async () => {
  const f = fixture(); const p = f.lanes[0]!; p.merge = undefined; p.lastPassedCommit = "a".repeat(40);
  cached(f, 3909, "closed"); f.primary.merged_at = null; f.primary.base.ref = "batch/widgets";
  let proofs = 0;
  const run = f.ports.run;
  f.ports.run = async args => {
    if (args[1]!.endsWith("/pulls/4000")) return JSON.stringify({ state: "closed", merged_at: null, head: { ref: "batch/declined" } });
    if (args[1]!.endsWith("/pulls/5000")) return JSON.stringify({ number: 5000, state: "closed", merged_at: AT, head: { ref: "batch/widgets" }, base: { ref: "main", repo: { default_branch: "main" } } });
    return run(args);
  };
  f.ports.carriedLanding = async () => ++proofs === 1
    ? { state: "waiting", batch: 4000, commit: "c".repeat(40) }
    : { state: "landed", batch: 5000, mergedAt: AT, commit: "d".repeat(40) };
  await f.sweep(); expect(f.writes).toEqual([]);
  f.advance(); await f.sweep();
  expect(proofs).toBe(2);
  expect(p.issueDelivery).toMatchObject([{ state: "closed", batch: 5000, batchCommit: "d".repeat(40) }]);
});

test("a merged carrier without patch proof exhausts its durable retries and raises attention", async () => {
  const f = fixture(); const p = f.lanes[0]!; p.merge = undefined; p.lastPassedCommit = "a".repeat(40);
  cached(f, 3909, "closed"); f.primary.merged_at = null; f.primary.base.ref = "batch/widgets";
  const run = f.ports.run;
  f.ports.run = async args => args[1]!.endsWith("/pulls/4000")
    ? JSON.stringify({ state: "closed", merged_at: AT, head: { ref: "batch/widgets" } }) : run(args);
  let proofs = 0;
  f.ports.carriedLanding = async () => {
    proofs++;
    return { state: "waiting", batch: 4000, commit: "c".repeat(40), unproven: true };
  };
  for (let index = 0; index < 3; index++) { await f.sweep(); f.advance(); }
  expect(p.issueDelivery).toMatchObject([{ state: "refused", reason: "github-unavailable", failures: 3 }]);
  expect(issueDeliverySeatSignals([p], "fixture")).toHaveLength(1);
  await f.sweep(); expect(proofs).toBe(3); expect(f.writes).toEqual([]);
});

test("task-only issue links keep a completed lane hot until delivery is settled", () => {
  const p = lane(); p.workLinks = []; p.issueDelivery = undefined;
  expect(issueDeliveryHoldsArchive(p, NOW, [link()])).toBe(true);
  p.issueDelivery = [{ repository: REPO, number: 3900, pr: 3909, mode: "close", state: "closed", at: AT }];
  expect(issueDeliveryHoldsArchive(p, NOW, [link()])).toBe(false);
  expect(issueDeliveryHoldsArchive(p, Date.parse(AT) + 31 * 86400_000, [link()])).toBe(false);
});


test("a merged integration PR uses its later main carrier time and retains carrier identity", async () => {
  const f = fixture(), p = f.lanes[0]!; p.merge = undefined;
  cached(f, 3909, "merged");
  f.data.repositories[REPO]!.prs["3909"]!.mergedAt = "2026-10-31T13:00:00.000Z";
  f.primary.merged_at = "2026-10-31T13:00:00.000Z";
  f.primary.base.ref = "integration";
  f.lanes[0]!.workLinks = [link(3900, true)];
  f.issue.state = "closed";
  const original = f.ports.run;
  f.ports.run = async args => {
    const route = args[1]!;
    if (route.endsWith("/pulls/4000")) return JSON.stringify({ ...f.primary, number: 4000, merged_at: AT,
      base: { ref: "main", repo: { default_branch: "main" } }, head: { ref: "merge-batch/widgets" }, title: "Merge batch: #3909" });
    if (route.includes("/commits/") && route.endsWith("/pulls?per_page=100")) return JSON.stringify([
      { ...f.primary, number: 4000, merged_at: AT, base: { ref: "main", repo: { default_branch: "main" } },
        head: { ref: "merge-batch/widgets" }, title: "Merge batch: #3909" },
    ]);
    return original(args);
  };
  f.closer(4000);
  await f.sweep();
  expect(f.issue.state).toBe("open");
  expect(f.writes.filter(args => args.includes("state=open"))).toHaveLength(1);
  expect(p.issueDelivery).toMatchObject([{ state: "reopened", batch: 4000 }]);
});

test.each([false, true])("a carrier landing controls rollout even when its work PR closed earlier: backfill=%s", async backfill => {
  const f = fixture(), p = f.lanes[0]!; p.merge = undefined;
  p.closedAt = "2026-10-31T12:00:00.000Z"; cached(f, 3909, "closed");
  f.primary.merged_at = null; f.primary.base.ref = "integration/widgets";
  const mergedAt = backfill ? "2026-10-31T13:00:00.000Z" : AT;
  const read = f.ports.run;
  f.ports.run = async args => args[1]!.endsWith("/pulls/4000")
    ? JSON.stringify({ ...f.primary, number: 4000, merged_at: mergedAt, base: { ref: "main", repo: { default_branch: "main" } } }) : read(args);
  f.ports.carriedLanding = async () => ({ state: "landed", batch: 4000, mergedAt, commit: "c".repeat(40) });
  await f.sweep(); expect(p.issueDelivery?.[0]?.state).toBe(backfill ? "skipped" : "closed");
  expect(f.writes).toHaveLength(backfill ? 0 : 2);
  const calls = f.reads.length; await f.sweep(); expect(f.reads.length).toBe(calls);
});
