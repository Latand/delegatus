import { describe, expect, test } from "bun:test";
import { GreenReader } from "./green";

const SHA = "a".repeat(40);
const HEAD = "b".repeat(40);
const TREE = "c".repeat(40);

function reader(options: { runs?: Record<string, unknown>[]; statuses?: Record<string, unknown>[]; required?: string[]; pull?: boolean; mergeSha?: string; tree?: string; response?: number; invalidBranch?: boolean } = {}) {
  let reads = 0;
  let now = 1_000;
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    reads += 1;
    calls.push(url);
    if (options.response) return new Response("{}", { status: options.response });
    const body = url.includes("/pulls") ? (options.pull === false ? [] : [{ merged_at: "2026-01-01", merge_commit_sha: options.mergeSha ?? SHA, base: { ref: "main" }, head: { sha: HEAD } }])
      : url.includes("/check-runs") ? { check_runs: options.runs ?? [{ name: "test", status: "completed", conclusion: "success", started_at: "2026-01-01" }] }
      : url.includes("/statuses") ? options.statuses ?? []
      : url.includes("/branches/") ? (options.invalidBranch ? {} : { protected: true, protection: { required_status_checks: { contexts: options.required ?? [] } } })
      : { commit: { tree: { sha: options.tree ?? TREE } } };
    return Response.json(body);
  };
  const subject = new GreenReader({ fetch: fetcher as typeof fetch, treeOf: async () => TREE, now: () => now });
  return { subject, calls, reads: () => reads, advance: (ms: number) => { now += ms; } };
}

describe("green merge evidence", () => {
  test("green check runs need no commit statuses, and a settled verdict is cached", async () => {
    const h = reader({ runs: [{ name: "privacy", status: "completed", conclusion: "skipped", started_at: "2026-01-01" }], required: ["privacy"] });
    expect((await h.subject.read("https://github.com/example/project.git", "main", SHA, "/checkout")).state).toBe("green");
    const count = h.reads();
    await h.subject.read("https://github.com/example/project.git", "main", SHA, "/checkout");
    expect(h.reads()).toBe(count);
  });

  test("fresh authorization rereads check runs and required contexts after a cached green", async () => {
    const options: { runs: { name: string; status: string; conclusion: string | null }[]; required: string[] } = { runs: [{ name: "privacy", status: "completed", conclusion: "success" }], required: ["privacy"] };
    const h = reader(options);
    expect((await h.subject.read("github.com/example/project", "main", SHA, "/checkout")).state).toBe("green");
    const count = h.reads();
    options.runs[0]!.status = "in_progress";
    options.runs[0]!.conclusion = null;
    expect((await h.subject.read("github.com/example/project", "main", SHA, "/checkout", undefined, true)).state).toBe("pending");
    expect(h.reads()).toBeGreaterThan(count);
    expect(h.calls.slice(count).some((url) => url.includes("/branches/main"))).toBe(true);
    options.runs[0]!.status = "completed";
    options.runs[0]!.conclusion = "failure";
    expect((await h.subject.read("github.com/example/project", "main", SHA, "/checkout", undefined, true)).state).toBe("red");
    options.runs[0]!.conclusion = "success";
    options.required.push("new-required-check");
    expect((await h.subject.read("github.com/example/project", "main", SHA, "/checkout", undefined, true)).state).toBe("pending");
  });

  test("a red optional status blocks an unattended update", async () => {
    const h = reader({ statuses: [{ context: "optional", state: "error", created_at: "2026-01-01" }] });
    expect(await h.subject.read("github.com/example/project", "main", SHA, "/checkout")).toMatchObject({ state: "red", detail: "optional" });
  });

  test("pending checks time out after the first read", async () => {
    const h = reader({ runs: [{ name: "test", status: "in_progress", conclusion: null }] });
    expect((await h.subject.read("github.com/example/project", "main", SHA, "/checkout")).state).toBe("pending");
    h.advance(90 * 60_000);
    expect((await h.subject.read("github.com/example/project", "main", SHA, "/checkout")).state).toBe("checks-timeout");
  });

  test("a missing PR or different tree cannot authorize the target", async () => {
    expect((await reader({ pull: false }).subject.read("github.com/example/project", "main", SHA, "/checkout")).state).toBe("no-pull-request");
    expect((await reader({ mergeSha: "d".repeat(40) }).subject.read("github.com/example/project", "main", SHA, "/checkout")).state).toBe("no-pull-request");
    expect((await reader({ tree: "d".repeat(40) }).subject.read("github.com/example/project", "main", SHA, "/checkout")).state).toBe("untested-tree");
  });

  test("neutral checks are green; absent checks are not; a missing required context waits", async () => {
    expect((await reader({ runs: [{ name: "suite", status: "completed", conclusion: "neutral" }] }).subject.read("github.com/example/project", "main", SHA, "/checkout")).state).toBe("green");
    expect((await reader({ runs: [], statuses: [] }).subject.read("github.com/example/project", "main", SHA, "/checkout")).state).toBe("no-checks");
    const h = reader({ required: ["privacy"] });
    expect((await h.subject.read("github.com/example/project", "main", SHA, "/checkout")).state).toBe("pending");
    h.advance(90 * 60_000);
    expect((await h.subject.read("github.com/example/project", "main", SHA, "/checkout")).state).toBe("checks-timeout");
  });

  test("an unreadable API and a non-GitHub remote remain unavailable", async () => {
    expect((await reader({ response: 404 }).subject.read("github.com/example/project", "main", SHA, "/checkout")).state).toBe("unknown");
    expect((await reader({ invalidBranch: true }).subject.read("github.com/example/project", "main", SHA, "/checkout")).state).toBe("unknown");
    expect((await reader().subject.read("/var/git/project", "main", SHA, "/checkout")).state).toBe("unavailable");
  });

  test("check-run pagination includes a red run beyond the first hundred", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ name: `check-${index}`, status: "completed", conclusion: "success", started_at: "2026-01-01" }));
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pulls")) return Response.json([{ merged_at: "2026-01-01", merge_commit_sha: SHA, base: { ref: "main" }, head: { sha: HEAD } }]);
      if (url.includes("/check-runs")) return new Response(JSON.stringify({ check_runs: url.includes("page=2") ? [{ name: "late", status: "completed", conclusion: "failure" }] : first }),
        { headers: url.includes("page=2") ? {} : { link: `<https://api.github.com/repos/example/project/commits/${HEAD}/check-runs?per_page=100&page=2>; rel="next"` } });
      if (url.includes("/statuses")) return Response.json([]);
      if (url.includes("/branches/")) return Response.json({ protected: true, protection: { required_status_checks: { contexts: [] } } });
      return Response.json({ commit: { tree: { sha: TREE } } });
    };
    const subject = new GreenReader({ fetch: fetcher as typeof fetch, treeOf: async () => TREE, now: () => 1_000 });
    expect(await subject.read("github.com/example/project", "main", SHA, "/checkout")).toMatchObject({ state: "red", detail: "late" });
  });

  test("rate-limit reset time is retained for the next attempt", async () => {
    const reset = 1_800_000_000;
    const subject = new GreenReader({ fetch: (async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } })) as unknown as typeof fetch,
      treeOf: async () => TREE, now: () => 1_000 });
    expect(await subject.read("github.com/example/project", "main", SHA, "/checkout")).toMatchObject({ state: "unknown", nextAt: new Date(reset * 1_000).toISOString() });
  });
});
