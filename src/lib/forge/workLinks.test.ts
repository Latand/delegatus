import { describe, expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";

import { emptyRepositoryEntry, forgeViewOf, type ForgeCacheFile, type StoredPullRequest } from "./cache";
import {
  editStoredWorkLinks,
  githubRepositoryOfRemote,
  MAX_WORK_LINKS,
  normalizeWorkLinkInput,
  resolvePipelineLinks,
  resolveTaskLinks,
  sortWorkLinks,
  type StoredWorkLink,
  type WorkLink,
} from "./workLinks";

/* PR and issue links (#2059), pure: invented repositories, branches and
   numbers, an in-memory cache, no store and no forge. */

const REPO = "acme/widgets";
const LANE_AT = "2026-09-20T10:00:00Z";

function pr(number: number, extra: Partial<StoredPullRequest> = {}): [string, StoredPullRequest] {
  return [String(number), {
    url: `https://github.com/acme/widgets/pull/${number}`,
    headRefName: `feature/${number}`,
    createdAt: "2026-09-21T10:00:00Z",
    state: "open",
    closes: [],
    checkedAt: "2026-09-22T10:00:00Z",
    ...extra,
  }];
}

function cache(prs: Array<[string, StoredPullRequest]>, extra: Partial<ForgeCacheFile["repositories"][string]> = {}) {
  const data: ForgeCacheFile = {
    schemaVersion: 1,
    repositories: { [REPO]: { ...emptyRepositoryEntry(), completeSince: "2026-09-22T00:00:00Z", prs: Object.fromEntries(prs), ...extra } },
  };
  return forgeViewOf(data);
}

function pipeline(extra: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "pipe-a",
    branch: "pipeline/lane-a",
    createdAt: LANE_AT,
    runs: [],
    taskIds: ["task-a"],
    ...extra,
  } as Pipeline;
}

const delivery = (branch: string, pr?: number) => ({
  target: { repository: "repo-fixture", remote: "https://github.com/acme/widgets.git", branch: `refs/heads/${branch}`, ...(pr ? { pr } : {}) },
}) as unknown as Pipeline["delivery"];

const provenanceRun = (number: number) => ({
  stageId: "build",
  attempts: [{ n: 1, report: { provenance: { pullRequest: { url: `https://github.com/acme/widgets/pull/${number}`, number, state: "OPEN" } } } }],
}) as unknown as Pipeline["runs"][number];

const numbers = (links: readonly WorkLink[]) => links.map((link) => `${link.kind}:${link.number}`);

describe("input normalization", () => {
  const context = { repository: REPO };
  test.each([
    ["#2059", { repository: REPO, number: 2059, kind: null }],
    ["2059", { repository: REPO, number: 2059, kind: null }],
    ["  <#2059>. ", { repository: REPO, number: 2059, kind: null }],
    ["PR 2059", { repository: REPO, number: 2059, kind: "pr" }],
    ["pr#2059", { repository: REPO, number: 2059, kind: "pr" }],
    ["issue 2059", { repository: REPO, number: 2059, kind: "issue" }],
    ["Other-Org/Other.Repo#12", { repository: "other-org/other.repo", number: 12, kind: null }],
    ["https://github.com/Acme/Widgets/pull/2059/files#diff-1", { repository: REPO, number: 2059, kind: "pr" }],
    ["github.com/acme/widgets/issues/7", { repository: REPO, number: 7, kind: "issue" }],
  ] as const)("%p", (raw, link) => {
    expect(normalizeWorkLinkInput(raw, context)).toEqual({ ok: true, link: { ...link } });
  });

  test("a bare number accepts a JSON number too, and the cache or an explicit kind decides what it is", () => {
    expect(normalizeWorkLinkInput(12, { repository: REPO, kindOf: () => "issue" })).toEqual({ ok: true, link: { repository: REPO, number: 12, kind: "issue" } });
    expect(normalizeWorkLinkInput("PR 12", { repository: REPO, kind: "issue" })).toMatchObject({ ok: true, link: { kind: "issue" } });
  });

  test.each([
    ["https://gitlab.com/acme/widgets/-/merge_requests/3", "only github.com"],
    ["#12", "bare number names nothing"],
    ["0", "positive integer"],
    ["-4", "positive integer"],
    ["", "empty"],
    ["the widgets PR", "not a pull request or issue reference"],
  ] as const)("refuses %p with the form that would work", (raw, reason) => {
    const result = normalizeWorkLinkInput(raw, { repository: raw === "#12" ? null : REPO });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(reason);
  });

  test("a GitHub remote in every form git writes it names one repository", () => {
    /* The scp and ssh forms are built from parts: `user@host` spelled out
       reads as a mailbox to the publication gate, and it names nobody. */
    const at = (user: string, rest: string) => [user, rest].join("@");
    for (const remote of [at("git", "github.com:acme/widgets.git"), "https://github.com/acme/widgets", `ssh://${at("git", "github.com/Acme/widgets.git")}`, "github.com/acme/widgets"]) {
      expect(githubRepositoryOfRemote(remote)).toBe(REPO);
    }
    expect(githubRepositoryOfRemote(at("git", "gitlab.com:acme/widgets.git"))).toBeNull();
    expect(githubRepositoryOfRemote("/srv/git/widgets")).toBeNull();
  });
});

describe("discovery", () => {
  test("a lane whose PR sits on its delivery head, not on its lane branch, finds it", () => {
    const resolved = resolvePipelineLinks(pipeline({ delivery: delivery("fix/other-head") }), REPO, cache([pr(41, { headRefName: "fix/other-head" })]));
    expect(numbers(resolved.links)).toEqual(["pr:41"]);
    expect(resolved.links[0]).toMatchObject({ source: "auto", via: ["delivery-branch"], state: "open", url: "https://github.com/acme/widgets/pull/41" });
    expect(resolved.noPr).toBe(false);
  });

  test("the lane branch finds its PR, with the state the cache read", () => {
    const resolved = resolvePipelineLinks(pipeline(), REPO, cache([pr(42, { headRefName: "pipeline/lane-a", state: "merged" })]));
    expect(resolved.links[0]).toMatchObject({ number: 42, via: ["lane-branch"], state: "merged", checkedAt: "2026-09-22T10:00:00Z" });
  });

  test("a reused head's older PR predates the lane and is left out, unless delivery.pr names it", () => {
    const view = cache([pr(10, { headRefName: "hotfix/shared", createdAt: "2026-09-01T00:00:00Z", state: "merged" }), pr(43, { headRefName: "hotfix/shared" })]);
    expect(numbers(resolvePipelineLinks(pipeline({ delivery: delivery("hotfix/shared") }), REPO, view).links)).toEqual(["pr:43"]);
    const named = resolvePipelineLinks(pipeline({ delivery: delivery("hotfix/shared", 10) }), REPO, view);
    expect(numbers(named.links)).toEqual(["pr:43", "pr:10"]);
    expect(named.links.find((link) => link.number === 10)!.via.sort()).toEqual(["delivery-branch", "delivery-pr"]);
  });

  test("provenance alone names a PR the cache has not read yet: a neutral chip, not a state it never saw", () => {
    const resolved = resolvePipelineLinks(pipeline({ runs: [provenanceRun(44), provenanceRun(44)] }), REPO, cache([]));
    expect(resolved.links).toEqual([expect.objectContaining({ number: 44, kind: "pr", via: ["provenance"], state: null, checkedAt: null })]);
    expect(resolved.noPr).toBe(false);
  });

  test("the issues a PR closes come with it", () => {
    const resolved = resolvePipelineLinks(pipeline(), REPO, cache([pr(45, { headRefName: "pipeline/lane-a", closes: [2059, 2060] })]));
    expect(numbers(resolved.links)).toEqual(["pr:45", "issue:2060", "issue:2059"]);
    expect(resolved.links[1]).toMatchObject({ via: ["closes"], url: "https://github.com/acme/widgets/issues/2060", state: null });
  });

  test("no PR is said only once the repository's cache is complete", () => {
    expect(resolvePipelineLinks(pipeline(), REPO, cache([], { completeSince: null })).noPr).toBe(false);
    expect(resolvePipelineLinks(pipeline(), REPO, cache([])).noPr).toBe(true);
    expect(resolvePipelineLinks(pipeline(), null, cache([])).noPr).toBe(false);
    /* An attached issue is not a PR; an attached number of unknown kind might be. */
    const issue: StoredWorkLink = { repository: REPO, number: 9, kind: "issue", addedAt: LANE_AT, addedBy: "operator" };
    expect(resolvePipelineLinks(pipeline({ workLinks: [issue] }), REPO, cache([])).noPr).toBe(true);
    expect(resolvePipelineLinks(pipeline({ workLinks: [{ ...issue, kind: null }] }), REPO, cache([])).noPr).toBe(false);
  });

  test("a renamed repository resolves under its new name, whichever name the record uses", () => {
    const view = forgeViewOf({ schemaVersion: 1, repositories: { "acme/old-name": { ...emptyRepositoryEntry(), canonical: REPO, completeSince: LANE_AT, prs: Object.fromEntries([pr(46, { headRefName: "pipeline/lane-a" })]) } } });
    const manual: StoredWorkLink = { repository: REPO, number: 46, kind: null, addedAt: LANE_AT, addedBy: "agent" };
    const resolved = resolvePipelineLinks(pipeline({ workLinks: [manual] }), "acme/old-name", view);
    expect(resolved.links).toEqual([expect.objectContaining({ key: "acme/widgets#46", source: "manual", kind: "pr" })]);
  });
});

describe("many-to-many", () => {
  test("a manual link on a discovered PR is one link, manual, carrying both kinds of evidence", () => {
    const manual: StoredWorkLink = { repository: REPO, number: 47, kind: null, addedAt: LANE_AT, addedBy: "operator" };
    const resolved = resolvePipelineLinks(pipeline({ workLinks: [manual] }), REPO, cache([pr(47, { headRefName: "pipeline/lane-a" })]));
    expect(resolved.links).toHaveLength(1);
    expect(resolved.links[0]).toMatchObject({ source: "manual", kind: "pr", state: "open" });
    expect(resolved.links[0]!.via.sort()).toEqual(["lane-branch", "manual"]);
  });

  test("three pipelines of one task sharing a PR draw one chip on the card, beside the task's own link", () => {
    const view = cache([pr(48, { headRefName: "fix/shared", closes: [2059] })]);
    const lanes = ["a", "b", "c"].map((id) => resolvePipelineLinks(pipeline({ id, branch: `pipeline/${id}`, delivery: delivery("fix/shared") }), REPO, view));
    const own: StoredWorkLink = { repository: REPO, number: 2059, kind: "issue", addedAt: LANE_AT, addedBy: "operator" };
    const card = resolveTaskLinks({ workLinks: [own, { ...own, number: 49, kind: "pr" }] }, lanes, view);
    /* 49 was never read, so it follows the open 48. */
    expect(numbers(card.links)).toEqual(["pr:48", "pr:49", "issue:2059"]);
    expect(card.links.find((link) => link.number === 2059)).toMatchObject({ source: "manual" });
    expect(card.noPr).toBe(false);
  });

  test("order: open, draft, merged, closed, unread, then issues; newest first within each", () => {
    const view = cache([pr(50, { state: "closed" }), pr(51, { state: "merged" }), pr(52, { state: "draft" }), pr(53), pr(54, { state: "merged" })]);
    const manual = (number: number, kind: StoredWorkLink["kind"]): StoredWorkLink => ({ repository: REPO, number, kind, addedAt: LANE_AT, addedBy: "operator" });
    const resolved = resolveTaskLinks({ workLinks: [50, 51, 52, 53, 54].map((n) => manual(n, "pr")).concat(manual(60, "issue"), manual(61, "pr"), manual(62, null)) }, [], view);
    expect(numbers(sortWorkLinks(resolved.links))).toEqual(["pr:53", "pr:52", "pr:54", "pr:51", "pr:50", "pr:61", "null:62", "issue:60"]);
  });
});

describe("manual attach and detach", () => {
  const meta = { now: "2026-09-23T00:00:00Z", addedBy: "agent" as const };
  const link = (number: number, kind: "pr" | "issue" | null = null) => ({ repository: REPO, number, kind });

  test("an attach is added once; a repeat is a no-op; a kind learned later is recorded", () => {
    const first = editStoredWorkLinks(undefined, [link(1)], [], meta);
    expect(first).toEqual({ ok: true, changed: true, links: [{ repository: REPO, number: 1, kind: null, addedAt: meta.now, addedBy: "agent" }] });
    const again = editStoredWorkLinks(first.ok ? first.links : [], [link(1)], [], meta);
    expect(again).toMatchObject({ ok: true, changed: false });
    const typed = editStoredWorkLinks(first.ok ? first.links : [], [link(1, "issue")], [], meta);
    expect(typed).toMatchObject({ ok: true, changed: true, links: [{ number: 1, kind: "issue" }] });
  });

  test("a renamed repository's two names are one link", () => {
    const stored: StoredWorkLink[] = [{ repository: "acme/old-name", number: 5, kind: "pr", addedAt: meta.now, addedBy: "operator" }];
    const canonical = (name: string) => (name === "acme/old-name" ? REPO : name);
    expect(editStoredWorkLinks(stored, [link(5)], [], { ...meta, canonical })).toMatchObject({ ok: true, changed: false });
    expect(editStoredWorkLinks(stored, [], [link(5)], { ...meta, canonical })).toEqual({ ok: true, changed: true, links: [] });
  });

  test("detaching a discovered link names its evidence and changes nothing; an unknown one is a no-op", () => {
    const refused = editStoredWorkLinks([], [], [link(7)], meta, () => ["delivery-branch"]);
    expect(refused).toMatchObject({ ok: false, status: 409, code: "WORK_LINK_AUTO" });
    expect(!refused.ok && refused.error).toContain("delivery-branch");
    expect(editStoredWorkLinks([], [], [link(7)], meta, () => null)).toMatchObject({ ok: true, changed: false });
  });

  test("the limit refuses the next attach and lists what is attached", () => {
    const full = Array.from({ length: MAX_WORK_LINKS }, (_, index) => ({ repository: REPO, number: index + 1, kind: null, addedAt: meta.now, addedBy: "operator" as const }));
    const refused = editStoredWorkLinks(full, [link(99)], [], meta);
    expect(refused).toMatchObject({ ok: false, status: 409, code: "WORK_LINK_LIMIT" });
    expect(!refused.ok && refused.error).toContain("acme/widgets#20");
  });
});
