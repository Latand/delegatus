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
  const primary = { number: 3909, merged_at: AT as string | null, base: { ref: "main", repo: { default_branch: "main" } }, title: "Deliver widget controls", head: { ref: "pipeline/lane" } };
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
  if (kind === "other-base") expect(f.lanes[0]!.issueDelivery?.[0]).toMatchObject({ state: "skipped", reason: "other-base" });
});
test("old in-memory landings and Git-only lanes make no forge calls", async () => {
  const f = fixture(); f.ports.since = () => "2026-11-02T00:00:00Z"; await f.sweep();
  delete f.lanes[0]!.delivery; f.ports.since = () => AT;
  expect(creationIssueLinks(f.lanes[0]!, { repository: null, cache: forgeViewOf(f.data), lanes: [], pullRequestOf: f.ports.pullRequestOf })).toEqual([]);
  await f.sweep(); expect(f.reads).toEqual([]); expect(f.writes).toEqual([]);
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
  const f = fixture(); delete f.lanes[0]!.merge; cached(f, 3909, "closed");
  let scans = 0;
  f.data.repositories[REPO]!.prs = new Proxy(f.data.repositories[REPO]!.prs, { ownKeys: object => { scans++; return Reflect.ownKeys(object); } });
  const view = forgeViewOf(f.data); f.ports.cache = () => ({ data: f.data, view });
  await f.sweep(); const first = scans; await f.sweep();
  expect(scans).toBe(first); expect(f.reads).toEqual([]);
  const data: ForgeCacheFile = { ...f.data, repositories: { [REPO]: { ...emptyRepositoryEntry(), prs: { "3909": { ...f.data.repositories[REPO]!.prs["3909"]!, state: "merged", mergedAt: AT } } } } };
  f.ports.cache = () => ({ data, view: forgeViewOf(data) });
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
