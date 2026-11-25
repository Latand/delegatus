import { MeasuredCache } from "@/lib/cacheTelemetry";
/* An exact-tree, merged-PR check for unattended checkout updates. */
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { rollupLatestChecksByName } from "@/lib/forge/checkRollup";
import { runGit } from "./git";

export type GreenVerdict = { state: "green" | "red" | "pending" | "checks-timeout" | "no-checks" | "no-pull-request" | "untested-tree" | "unknown" | "unavailable"; detail?: string; checks?: string[]; optionalCheckFailures?: string[]; done?: number; total?: number; nextAt?: string; firstReadAt?: string };
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
  private readonly final = new MeasuredCache<string, GreenVerdict>("verdicts", "selfUpdate/green");
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
  private async workflowRuns(url: string): Promise<unknown[]> {
    const all: unknown[] = [];
    let next: string | null = url;
    for (let pages = 0; next && pages < 10; pages++) {
      if (!next.startsWith("https://api.github.com/")) throw new Error("GitHub pagination left its host");
      const page = await this.page(next);
      const runs = (page.body as { workflow_runs?: unknown })?.workflow_runs;
      if (!Array.isArray(runs)) throw new Error("GitHub returned invalid workflow runs");
      all.push(...runs);
      next = page.next;
    }
    if (next) throw new Error("GitHub returned too many pages");
    return all;
  }
  private async requiredChecks(repository: string, branch: string, fresh: boolean): Promise<RequiredCheck[]> {
    const key = `${repository}:${branch}`;
    const cached = this.required.get(key);
    if (!fresh && cached && this.ports.now() - cached.at < 30 * 60_000) return cached.checks;
    // A branch confirms its required checks in two places: classic protection
    // and the active rules that apply to it (rulesets, including inherited
    // ones). Both are read and validated before either is believed, so a
    // branch whose only requirement lives in a ruleset is not mistaken for one
    // that requires nothing.
    const api = `https://api.github.com/repos/${repository}`;
    const [branchPage, rules] = await Promise.all([
      this.page(`${api}/branches/${encodeURIComponent(branch)}`),
      this.list(`${api}/rules/branches/${encodeURIComponent(branch)}?per_page=100`),
    ]);
    const branchView = branchPage.body as { protected?: unknown; protection?: unknown } | null;
    if (!branchView || typeof branchView !== "object" || typeof branchView.protected !== "boolean") {
      throw new Error("GitHub returned an invalid branch protection response");
    }
    const protection = branchView.protection;
    // GitHub omits the member for an unprotected branch; an explicit null is
    // not a confirmed answer and must not stand in for an empty required set.
    if (protection === undefined) {
      if (branchView.protected) throw new Error("GitHub returned an invalid branch protection response");
    } else if (protection === null || typeof protection !== "object" || Array.isArray(protection)) {
      throw new Error("GitHub returned an invalid branch protection response");
    }
    // An absent object is an empty required set. A present one that is not an
    // object is unreadable, and its members must never be defaulted past it.
    // A present object must also state the set itself (contexts or checks);
    // one that states neither is unreadable, not an empty requirement.
    const status = (protection as { required_status_checks?: unknown } | undefined | null)?.required_status_checks;
    if (status !== undefined && (!status || typeof status !== "object" || Array.isArray(status))) {
      throw new Error("GitHub returned an invalid required status checks response");
    }
    const { contexts, checks: configured } = (status ?? {}) as { contexts?: unknown; checks?: unknown };
    if (status !== undefined && contexts === undefined && configured === undefined) {
      throw new Error("GitHub returned required status checks without a required set");
    }
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
    // Every rule is read, so a malformed one anywhere refuses the whole read
    // instead of hiding the requirement it may carry.
    for (const rule of rules) {
      if (!rule || typeof rule !== "object" || typeof (rule as { type?: unknown }).type !== "string") {
        throw new Error("GitHub returned an invalid branch rule");
      }
      if ((rule as { type: string }).type !== "required_status_checks") continue;
      const configuredByRule = (rule as { parameters?: { required_status_checks?: unknown } }).parameters?.required_status_checks;
      if (!Array.isArray(configuredByRule) || !configuredByRule.every((check) =>
        check && typeof check === "object" && typeof check.context === "string" && check.context
        && (check.integration_id === undefined || check.integration_id === null || Number.isInteger(check.integration_id)))) {
        throw new Error("GitHub returned invalid ruleset required checks");
      }
      for (const { context, integration_id } of configuredByRule as { context: string; integration_id?: number | null }[]) {
        // The rule's integration binds the check to its GitHub App, as classic
        // protection does; an absent one accepts the check from any source.
        const appId = integration_id === undefined || integration_id === -1 ? null : integration_id;
        if (!checks.some((check) => check.name === context && check.appId === appId)) checks.push({ name: context, appId });
      }
    }
    this.required.set(key, { at: this.ports.now(), checks });
    return checks;
  }
  async read(remote: string, branch: string, target: string, checkout: string, firstReadAt?: string, fresh = false,
    policy: "automatic" | "manual-update" | "exact-deploy" = "automatic"): Promise<GreenVerdict> {
    const repository = githubRepositoryOfRemote(remote);
    if (!repository) return { state: "unavailable" };
    const exactDeploy = policy === "exact-deploy";
    const manualUpdate = policy === "manual-update";
    const requiredPolicy = exactDeploy || manualUpdate;
    const cacheKey = requiredPolicy ? `${target}:${policy}` : target;
    const cached = this.final.get(cacheKey);
    if (cached && !fresh) return cached;
    const finish = (verdict: GreenVerdict) => {
      // A failed run can be rerun. The next deployment must read its result,
      // including when this fresh failure replaced a previously cached green.
      if (verdict.state === "red") this.final.delete(cacheKey);
      else if (!["pending", "unknown"].includes(verdict.state)) {
        this.final.set(cacheKey, verdict);
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
      const exactTarget = headTree !== await this.ports.treeOf(checkout, target);
      // Delegatus runs its runtime gate on main as well as PRs. Only that
      // app-bound required gate can certify a different, post-merge tree.
      if (exactTarget && !["latand/delegatus", "latand/live-log-viewer-next"].includes(repository.toLowerCase())) return { state: "untested-tree" };
      const evidence = exactDeploy || exactTarget ? target : head;
      const [runs, statuses, required] = await Promise.all([
        this.checkRuns(`${api}/commits/${evidence}/check-runs?per_page=100`),
        this.list(`${api}/commits/${evidence}/statuses?per_page=100`),
        this.requiredChecks(repository, branch, fresh),
      ]);
      let runtimeGatePending = false;
      let runtimeGateRed = false;
      if (exactTarget) {
        const gate = required.find(check => check.name === "runtime-gate" && check.appId === 15368);
        if (!gate) return { state: "untested-tree" };
        const workflows = await this.workflowRuns(`${api}/actions/runs?head_sha=${target}&event=push&per_page=100`);
        const matching = workflows.filter(value => {
          const run = value as { path?: string; head_sha?: string; event?: string };
          return run.path === ".github/workflows/bun-runtime.yml" && run.head_sha === target && run.event === "push";
        }) as { id?: number; created_at?: string; status?: string; conclusion?: string; check_suite_id?: number }[];
        matching.sort((a, b) => (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0) || (b.id ?? 0) - (a.id ?? 0));
        const workflow = matching[0];
        if (!workflow || workflow.status !== "completed" || workflow.conclusion !== "success" || !Number.isSafeInteger(workflow.check_suite_id)) {
          if (workflow?.status === "completed" && workflow.conclusion === "failure") runtimeGateRed = true;
          else runtimeGatePending = true;
        } else {
          const gates = runs.filter(run => {
            const item = run as { name?: unknown; app?: { id?: unknown }; check_suite?: { id?: number }; status?: string; conclusion?: string };
            return item.name === gate.name && item.app?.id === gate.appId && item.check_suite?.id === workflow.check_suite_id
              && item.status === "completed" && item.conclusion === "success";
          });
          runtimeGatePending = !gates.length;
        }
      }
      const runGroups = new Map<number | null, Record<string, unknown>[]>();
      for (const run of runs) {
        const item = run as Record<string, unknown>;
        const appId = (item.app as { id?: unknown } | null)?.id;
        const group = Number.isInteger(appId) ? appId as number : null;
        const entries = runGroups.get(group) ?? [];
        // Optional cancellations settle like neutral/skipped runs. Required
        // checks retain their verdict and their configured GitHub App binding.
        const optionalCancellation = item.status === "completed" && item.conclusion === "cancelled"
          && !required.some(check => check.name === item.name && (check.appId === null || check.appId === group));
        entries.push({ ...item, startedAt: item.started_at, conclusion: optionalCancellation ? "neutral" : item.conclusion });
        runGroups.set(group, entries);
      }
      // The statuses endpoint returns newest first. Keep that order when
      // created_at ties; rollupChecks cannot distinguish statuses within a second.
      const seenStatuses = new Set<string>();
      const latestStatuses = statuses.flatMap((status) => {
        if (!status || typeof status !== "object") return [];
        const item = status as Record<string, unknown>;
        const context = typeof item.context === "string" ? item.context : "";
        if (!context || seenStatuses.has(context)) return [];
        seenStatuses.add(context);
        return [{ ...item, startedAt: item.created_at }];
      });
      const checks = [
        ...[...runGroups].flatMap(([appId, entries]) => {
          if (!requiredPolicy) return rollupLatestChecksByName(entries).map(check => ({ ...check, kind: "run" as const, appId }));
          // A queued rerun has no started_at yet. REST ids still establish
          // which same-app run is newer; a missing timestamp cannot revive
          // the preceding run's failure.
          const latestIds = new Map<unknown, number>();
          for (const entry of entries) if (typeof entry.id === "number" && Number.isSafeInteger(entry.id))
            latestIds.set(entry.name, Math.max(latestIds.get(entry.name) ?? 0, entry.id));
          return rollupLatestChecksByName(entries.filter(entry => !latestIds.has(entry.name) || entry.id === latestIds.get(entry.name)))
            .map(check => ({ ...check, kind: "run" as const, appId }));
        }),
        ...rollupLatestChecksByName(latestStatuses).map((check) => ({ ...check, kind: "status" as const, appId: null })),
      ];
      const requiredOnly = requiredPolicy && required.length > 0;
      if (!checks.length) {
        if (runtimeGateRed) return finish({ state: "red", detail: "runtime-gate",
          checks: manualUpdate ? ["runtime-gate"] : [...new Set([...required.map(check => check.name), "runtime-gate"])].sort() });
        return requiredOnly ? { state: "pending", done: 0, total: required.length, checks: required.map(check => check.name).sort() }
          : finish({ state: "no-checks", checks: required.map(check => check.name).sort() });
      }
      // Manual updates and exact deploys use the same branch protection. An
      // exact deploy with an empty required set keeps every observed check in
      // scope. A manual update gates on the required checks alone, so a branch
      // that confirms none (a readable answer, never an unreadable one, which
      // is "unknown" above) leaves nothing to gate on: every observed check is
      // optional there, and a red one is the warning, not a refusal.
      const isRequired = (check: (typeof checks)[number]) => required.some(({ name, appId }) => check.name === name
        && (appId === null || (check.kind === "run" && check.appId === appId)));
      const relevant = requiredOnly ? checks.filter(isRequired) : manualUpdate ? [] : checks;
      const red = relevant.filter(check => check.verdict === "red").map(check => check.name);
      const notGreen = [...new Set([...relevant.filter(check => check.verdict !== "green").map(check => check.name),
        ...required.filter(({ name, appId }) => !checks.some(check => check.name === name && check.verdict === "green"
          && (appId === null || (check.kind === "run" && check.appId === appId)))).map(check => check.name)])].sort();
      if (red.length || runtimeGateRed) return finish({ state: "red", detail: red[0] ?? "runtime-gate",
        checks: [...new Set([...(manualUpdate ? red : notGreen), ...(runtimeGateRed || (!manualUpdate && runtimeGatePending) ? ["runtime-gate"] : [])])].sort() });
      const done = requiredOnly ? required.filter(({ name, appId }) => checks.some(check => check.name === name && check.verdict === "green"
        && (appId === null || (check.kind === "run" && check.appId === appId)))).length : relevant.filter(check => check.verdict === "green").length;
      const total = requiredOnly ? required.length : relevant.length;
      const missing = required.find(({ name, appId }) => !checks.some((check) => check.name === name && check.verdict === "green"
        && (appId === null || (check.kind === "run" && check.appId === appId))));
      if (done === total && !missing && !runtimeGatePending) {
        const optionalCheckFailures = manualUpdate
          ? [...new Set(checks.filter(check => check.verdict === "red" && !isRequired(check)).map(check => check.name))].sort() : [];
        return finish({ state: "green", done, total, ...(optionalCheckFailures.length ? { optionalCheckFailures } : {}) });
      }
      if (runtimeGatePending) return { state: "pending", done, total, detail: "runtime-gate", checks: [...new Set([...notGreen, "runtime-gate"])].sort() };
      if (requiredPolicy) return { state: "pending", done, total, detail: missing?.name, checks: notGreen };
      const persistedFirst = firstReadAt ? Date.parse(firstReadAt) : NaN;
      const first = this.firstPending.get(target) ?? (Number.isFinite(persistedFirst) ? persistedFirst : this.ports.now());
      this.firstPending.set(target, first);
      if (this.ports.now() - first >= WAIT_MS) return finish({ state: "checks-timeout", detail: missing?.name, checks: notGreen });
      return { state: "pending", done, total, detail: missing?.name, checks: notGreen, firstReadAt: new Date(first).toISOString() };
    } catch (error) {
      return { state: "unknown", detail: error instanceof Error ? error.message : String(error), ...(error instanceof GitHubReadError && error.nextAt ? { nextAt: error.nextAt } : {}) };
    }
  }
}
