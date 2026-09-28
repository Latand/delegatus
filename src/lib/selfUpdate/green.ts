/* An exact-tree, merged-PR check for unattended checkout updates. */
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { rollupChecks } from "@/lib/forge/checkRollup";
import { runGit } from "./git";

export type GreenVerdict = { state: "green" | "red" | "pending" | "checks-timeout" | "no-checks" | "no-pull-request" | "untested-tree" | "unknown" | "unavailable"; detail?: string; done?: number; total?: number; nextAt?: string; firstReadAt?: string };
export interface GreenPorts {
  fetch: typeof fetch;
  treeOf(repo: string, sha: string): Promise<string>;
  now(): number;
}
const defaultPorts: GreenPorts = {
  fetch,
  async treeOf(repo, sha) {
    const result = await runGit(["rev-parse", "--verify", `${sha}^{tree}`], repo);
    if (result.code !== 0) throw new Error("target tree is unreadable");
    return result.stdout.trim();
  },
  now: Date.now,
};
const TIMEOUT_MS = 15_000;
const WAIT_MS = 90 * 60_000;
type RequiredCheck = { name: string; appId: number | null };
class GitHubReadError extends Error {
  constructor(message: string, readonly nextAt?: string) { super(message); }
}

export class GreenReader {
  private readonly final = new Map<string, GreenVerdict>();
  private readonly firstPending = new Map<string, number>();
  private readonly required = new Map<string, { at: number; checks: RequiredCheck[] }>();
  constructor(private readonly ports: GreenPorts = defaultPorts) {}

  private async page(url: string): Promise<{ body: unknown; next: string | null }> {
    const response = await this.ports.fetch(url, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      const reset = response.headers.get("x-ratelimit-reset");
      const nextAt = reset && /^\d+$/.test(reset) ? new Date(Number(reset) * 1000).toISOString() : "";
      throw new GitHubReadError(`GitHub HTTP ${response.status}${nextAt ? `; retry after ${nextAt}` : ""}`, nextAt || undefined);
    }
    const match = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "");
    return { body: await response.json(), next: match?.[1] ?? null };
  }
  private async list(url: string): Promise<unknown[]> {
    const all: unknown[] = [];
    let next: string | null = url;
    for (let pages = 0; next && pages < 10; pages++) {
      if (!next.startsWith("https://api.github.com/")) throw new Error("GitHub pagination left its host");
      const page = await this.page(next);
      if (!Array.isArray(page.body)) throw new Error("GitHub returned an invalid list");
      all.push(...page.body);
      next = page.next;
    }
    if (next) throw new Error("GitHub returned too many pages");
    return all;
  }
  private async checkRuns(url: string): Promise<unknown[]> {
    const all: unknown[] = [];
    let next: string | null = url;
    for (let pages = 0; next && pages < 10; pages++) {
      if (!next.startsWith("https://api.github.com/")) throw new Error("GitHub pagination left its host");
      const page = await this.page(next);
      const runs = (page.body as { check_runs?: unknown })?.check_runs;
      if (!Array.isArray(runs)) throw new Error("GitHub returned invalid check runs");
      all.push(...runs);
      next = page.next;
    }
    if (next) throw new Error("GitHub returned too many check runs");
    return all;
  }
  private async requiredChecks(repository: string, branch: string, fresh: boolean): Promise<RequiredCheck[]> {
    const key = `${repository}:${branch}`;
    const cached = this.required.get(key);
    if (!fresh && cached && this.ports.now() - cached.at < 30 * 60_000) return cached.checks;
    const branchView = (await this.page(`https://api.github.com/repos/${repository}/branches/${encodeURIComponent(branch)}`)).body as { protected?: unknown; protection?: { required_status_checks?: { contexts?: unknown; checks?: unknown } } };
    if (typeof branchView?.protected !== "boolean" || (branchView.protected && (!branchView.protection || typeof branchView.protection !== "object"))) {
      throw new Error("GitHub returned an invalid branch protection response");
    }
    const contexts = branchView?.protection?.required_status_checks?.contexts;
    const configured = branchView?.protection?.required_status_checks?.checks;
    if (contexts !== undefined && (!Array.isArray(contexts) || !contexts.every((name) => typeof name === "string"))) {
      throw new Error("GitHub returned invalid required checks");
    }
    if (configured !== undefined && (!Array.isArray(configured) || !configured.every((check) =>
      check && typeof check === "object" && typeof check.context === "string"
      && (check.app_id === null || Number.isInteger(check.app_id))))) {
      throw new Error("GitHub returned invalid required check sources");
    }
    const checks = ((configured as { context: string; app_id: number | null }[] | undefined) ?? [])
      .map(({ context, app_id }) => ({ name: context, appId: app_id === -1 ? null : app_id }));
    for (const name of (contexts as string[] | undefined) ?? []) {
      if (!checks.some((check) => check.name === name)) checks.push({ name, appId: null });
    }
    this.required.set(key, { at: this.ports.now(), checks });
    return checks;
  }
  async read(remote: string, branch: string, target: string, checkout: string, firstReadAt?: string, fresh = false): Promise<GreenVerdict> {
    const repository = githubRepositoryOfRemote(remote);
    if (!repository) return { state: "unavailable" };
    const cached = this.final.get(target);
    if (cached && !fresh) return cached;
    const finish = (verdict: GreenVerdict) => {
      if (!["pending", "unknown"].includes(verdict.state)) {
        this.final.set(target, verdict);
        if (this.final.size > 8) this.final.delete(this.final.keys().next().value!);
      }
      return verdict;
    };
    try {
      const api = `https://api.github.com/repos/${repository}`;
      const pulls = await this.list(`${api}/commits/${target}/pulls?per_page=100`);
      const pull = pulls.find((item) => {
        const value = item as { merged_at?: string | null; merge_commit_sha?: string; base?: { ref?: string } };
        return value.merged_at && value.merge_commit_sha === target && value.base?.ref === branch;
      }) as { head?: { sha?: string } } | undefined;
      const head = pull?.head?.sha;
      if (!head || !/^[a-f0-9]{40}$/.test(head)) return finish({ state: "no-pull-request" });
      const commit = (await this.page(`${api}/commits/${head}`)).body as { commit?: { tree?: { sha?: string } } };
      const headTree = commit?.commit?.tree?.sha;
      if (!headTree) throw new Error("GitHub returned no head tree");
      if (headTree !== await this.ports.treeOf(checkout, target)) return finish({ state: "untested-tree" });
      const [runs, statuses, required] = await Promise.all([
        this.checkRuns(`${api}/commits/${head}/check-runs?per_page=100`),
        this.list(`${api}/commits/${head}/statuses?per_page=100`),
        this.requiredChecks(repository, branch, fresh),
      ]);
      const runGroups = new Map<number | null, Record<string, unknown>[]>();
      for (const run of runs) {
        const item = run as Record<string, unknown>;
        const appId = (item.app as { id?: unknown } | null)?.id;
        const group = Number.isInteger(appId) ? appId as number : null;
        const entries = runGroups.get(group) ?? [];
        entries.push({ ...item, startedAt: item.started_at });
        runGroups.set(group, entries);
      }
      const checks = [
        ...[...runGroups].flatMap(([appId, entries]) => rollupChecks(entries).map((check) => ({ ...check, kind: "run" as const, appId }))),
        ...rollupChecks(statuses.map((status) => {
          const item = status as Record<string, unknown>;
          return { ...item, startedAt: item.created_at };
        })).map((check) => ({ ...check, kind: "status" as const, appId: null })),
      ];
      if (!checks.length) return finish({ state: "no-checks" });
      const red = checks.find((check) => check.verdict === "red");
      if (red) return finish({ state: "red", detail: red.name });
      const done = checks.filter((check) => check.verdict === "green").length;
      const missing = required.find(({ name, appId }) => !checks.some((check) => check.name === name && check.verdict === "green"
        && (appId === null || (check.kind === "run" && check.appId === appId))));
      if (done === checks.length && !missing) return finish({ state: "green", done, total: checks.length });
      const persistedFirst = firstReadAt ? Date.parse(firstReadAt) : NaN;
      const first = this.firstPending.get(target) ?? (Number.isFinite(persistedFirst) ? persistedFirst : this.ports.now());
      this.firstPending.set(target, first);
      if (this.ports.now() - first >= WAIT_MS) return finish({ state: "checks-timeout", detail: missing?.name });
      return { state: "pending", done, total: checks.length, detail: missing?.name, firstReadAt: new Date(first).toISOString() };
    } catch (error) {
      return { state: "unknown", detail: error instanceof Error ? error.message : String(error), ...(error instanceof GitHubReadError && error.nextAt ? { nextAt: error.nextAt } : {}) };
    }
  }
}
