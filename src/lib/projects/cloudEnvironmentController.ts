import fs from "node:fs";
import { statePath, stateDir } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { assertStateMutationAllowed } from "@/lib/state/stateMutationBarrier";
import { lastScannedProjectCatalog } from "@/lib/scanner/scanCache";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { accountManager } from "@/lib/accounts/manager";
import { projectAllowsAccount } from "@/lib/accounts/projectBindings";
import { canonicalProject, recordedProjectRemote } from "./aliases";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { prepareCloudEnvironment, readCloudEnvironmentBindings, recordCloudEnvironmentPrerequisite, clearCloudEnvironmentPrerequisite, cloudAccountVersion, cloudEnvironmentBindingsRevision } from "./codexCloudEnvironments";
import { onCloudEnvironmentDemand, takeCloudEnvironmentDemand } from "./cloudEnvironmentDemand";
import { openCloudEnvironmentBackend } from "@/lib/pipelines/cloudEnvironmentClient";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

export function cloudEnvironmentControllerPorts() {
  return { catalog: lastScannedProjectCatalog, accounts: listCodexAccounts,
    remote: recordedProjectRemote, allowed: projectAllowsAccount,
    read: readCloudEnvironmentBindings, prepare: prepareCloudEnvironment, revision: cloudEnvironmentBindingsRevision,
    backend: openCloudEnvironmentBackend,
    resolve: (project: string, accountId: string) => accountManager.resolveProjectSpawn("codex", { project, requestedId: accountId, requireCapacity: false }) };
}

type SavedBinding = ReturnType<typeof readCloudEnvironmentBindings>["bindings"][number];
/** An unavailable binding still inside its short reconciliation window. Past
 * the window (three failures, or the setup deadline) the outcome is terminal. */
const reconciling = (row: SavedBinding, now: number) => row.retries < 3 && row.deadlineAt > now;
/** Whether the background walk contacts the provider for one pair.
 *
 * Healthy and pending bindings keep their timers: a ready binding is
 * revalidated when its day ends, a setup in progress is polled, a failure
 * inside its reconciliation window backs off and retries. A terminal
 * unavailable binding waits for a trigger: `retryUnavailable` (a pipeline or
 * an operator asked for the pair, or this release visits it for the first
 * time), a sign-in no saved binding has seen, or a changed choice (which
 * reads as `discovering`). Its recorded cooldown bounds every trigger. */
export function cloudEnvironmentPreparationDue(saved: readonly SavedBinding[], accountVersion: string, now: number, retryUnavailable: boolean): boolean {
  if (!saved.length || saved.every(row => row.accountVersion !== accountVersion)) return true;
  return saved.some(row => row.state === "discovering"
    || (row.retryAt <= now && (row.state !== "unavailable" || retryUnavailable || reconciling(row, now))));
}

const WALK_MS = 2000;
/** Between checks while a whole walk found nothing due. */
const QUIET_MS = 30_000;
/** A quiet controller walks again this often, for changes its cheap check
 * cannot see (a project's remote, its account pool, a legacy project choice). */
const QUIET_RESCAN_MS = 10 * 60_000;

/** A keyset cursor walks every project/account pair, one pair per tick, and is
 * persisted after provider work so a restarted release continues from there.
 * One network slice runs at a time, outside controller ticks. A walk that
 * finds nothing due puts the controller in a quiet state: until a demand, a
 * binding change, an account or catalog change or the next timer it reads
 * only the bindings revision and account file metadata, and writes nothing. */
export class CloudEnvironmentController {
  constructor(private readonly ports = cloudEnvironmentControllerPorts()) {}
  private stopped = false;
  private active = false;
  private abort = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private catalog: ReturnType<typeof lastScannedProjectCatalog> = null;
  private projects: string[] = [];
  private accounts: ReturnType<typeof listCodexAccounts> = [];
  private accountsAt = 0;
  private cursor: string | null = null;
  /** Pairs this release has already evaluated; the first visit is a trigger. */
  private readonly seen = new Set<string>();
  private walked = 0;
  private walkRevision: number | null = null;
  private nextTimerAt = Number.POSITIVE_INFINITY;
  private quiet: { signature: string; revision: number | null; until: number } | null = null;
  stop() { this.stopped = true; this.abort.abort(); clearTimeout(this.timer); onCloudEnvironmentDemand(undefined); }
  start() { onCloudEnvironmentDemand(() => { if (!this.active) { clearTimeout(this.timer); this.schedule(0); } }); this.schedule(0); }
  private schedule(delay: number) { if (!this.stopped) { this.timer = setTimeout(() => { void this.pass(); }, delay); this.timer.unref?.(); } }
  private guard() { this.abort.signal.throwIfAborted(); assertStateMutationAllowed(stateDir()); }
  private restartWalk() { this.quiet = null; this.walked = 0; this.nextTimerAt = Number.POSITIVE_INFINITY; }
  private readCursor(): string {
    if (this.cursor !== null) return this.cursor;
    let after = "";
    try { const value: unknown = JSON.parse(fs.readFileSync(statePath("cloud-environment-cursor.json"), "utf8")); if (value && typeof value === "object" && "after" in value && typeof value.after === "string") after = value.after; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cloud environment preparation cursor is unreadable"); }
    return this.cursor = after;
  }
  /** The next pair after the cursor, wrapping to the first pair at the end. */
  private nextPair(after: string): { project: string; accountId: string; cursor: string } | undefined {
    // Binary-search the project prefix; never walk earlier projects on a tick.
    const projectKey = after.split("\0")[0] ?? "";
    let lo = 0, hi = this.projects.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.projects[mid]! < projectKey) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < Math.min(this.projects.length, lo + 8); i++) {
      const project = this.projects[i]!;
      for (const account of this.accounts) {
        const cursor = `${project}\0${account.id}`;
        if (cursor > after) return { project, accountId: account.id, cursor };
      }
    }
    return after ? this.nextPair("") : undefined;
  }
  async pass(): Promise<void> {
    if (this.stopped || this.active) return;
    this.active = true;
    let delay = WALK_MS;
    const attempt: { pair: string | null } = { pair: null };
    let signature: string | null = null;
    try {
      const catalog = this.ports.catalog();
      if (!catalog) return;
      if (catalog !== this.catalog) { this.catalog = catalog; this.projects = [...new Set(catalog.map(p => canonicalProject(p.project)))].sort(); }
      if (Date.now() >= this.accountsAt) { this.accounts = this.ports.accounts().filter(a => a.authPresent).sort((a, b) => a.id.localeCompare(b.id)); this.accountsAt = Date.now() + 30_000; }
      const demand = takeCloudEnvironmentDemand();
      if (demand) {
        const project = canonicalProject(demand.project);
        delay = 0;
        if (this.projects.includes(project) && this.accounts.some(account => account.id === demand.accountId)) {
          this.guard();
          const pair = `${project}\0${demand.accountId}`;
          if (await this.visit(project, demand.accountId, pair, true, attempt)) this.restartWalk();
        }
        return;
      }
      signature = JSON.stringify([this.projects, this.accounts.map(account => [account.id, cloudAccountVersion({ home: account.home })])]);
      if (this.quiet) {
        const now = Date.now();
        if (this.quiet.signature === signature && now < this.quiet.until && this.ports.revision() === this.quiet.revision) {
          delay = Math.max(WALK_MS, Math.min(QUIET_MS, this.quiet.until - now)); return;
        }
        this.restartWalk();
      }
      // Read before the walk's first pair: a binding written while it walks
      // differs from this value, so the quiet check walks again.
      if (this.walked === 0) this.walkRevision = this.ports.revision();
      const selected = this.nextPair(this.readCursor());
      this.guard();
      if (!selected) { delay = QUIET_MS; return; }
      this.cursor = selected.cursor;
      if (await this.visit(selected.project, selected.accountId, selected.cursor, false, attempt)) this.restartWalk();
      else this.idleVisit(signature);
    } catch (error) {
      // A pair that failed before reaching the provider counts as walked, so
      // it cannot keep the controller out of its quiet state.
      if (attempt.pair) this.restartWalk(); else if (signature) this.idleVisit(signature);
      // Provider bodies never cross the client boundary. This log reports only
      // the failed operation; the binding carries its typed prerequisite.
      if (!this.stopped) console.error("[cloud environments] preparation deferred", error instanceof Error ? error.name : "unknown");
    } finally {
      // Only a pass that reached the provider records its place: a restarted
      // release continues after that pair, and an idle pass writes nothing.
      if (!this.stopped && attempt.pair && this.cursor !== null) {
        try { assertStateMutationAllowed(stateDir()); writeJsonDurably(statePath("cloud-environment-cursor.json"), { after: this.cursor }); }
        catch { if (!this.stopped) console.error("[cloud environments] preparation cursor could not be saved"); }
      }
      this.active = false; this.schedule(delay);
    }
  }
  /** Count a pair that needed nothing. After a whole walk of them the
   * controller goes quiet until the earliest binding timer or the rescan. */
  private idleVisit(signature: string) {
    if (++this.walked < this.projects.length * this.accounts.length) return;
    this.quiet = { signature, revision: this.walkRevision, until: Math.min(this.nextTimerAt, Date.now() + QUIET_RESCAN_MS) };
    this.walked = 0; this.nextTimerAt = Number.POSITIVE_INFINITY;
  }
  /** Evaluate one pair and, when it is due, run one provider slice for it.
   * Returns whether the provider was contacted. */
  private async visit(project: string, accountId: string, pair: string, demanded: boolean, attempt: { pair: string | null }): Promise<boolean> {
    const repository = githubRepositoryOfRemote(this.ports.remote(project));
    if (!repository || !this.ports.allowed(project, "codex", accountId)) return false;
    const saved = this.ports.read(project, { accountId }).bindings.filter(r => r.kind === "automatic" && r.repository === repository);
    const version = cloudAccountVersion({ home: this.accounts.find(account => account.id === accountId)!.home });
    const now = Date.now();
    if (!cloudEnvironmentPreparationDue(saved, version, now, demanded || !this.seen.has(pair))) {
      this.seen.add(pair);
      for (const row of saved) if (row.state !== "unavailable" || reconciling(row, now)) this.nextTimerAt = Math.min(this.nextTimerAt, row.retryAt);
      return false;
    }
    const resolve = () => this.ports.resolve(project, accountId);
    const chosen = resolve();
    if (chosen.kind !== "available") return false;
    this.seen.add(pair);
    const assertCurrent = () => {
      this.guard(); const current = resolve();
      if (!this.ports.allowed(project, "codex", accountId) || current.kind !== "available" || current.account.home !== chosen.account.home
        || githubRepositoryOfRemote(this.ports.remote(project)) !== repository) throw new Error("Cloud environment preparation authority changed");
    };
    attempt.pair = pair;
    try { await withViewerOperation("cloud.environment-preparation", async () => {
      const backend = await this.ports.backend({ account: chosen.account, signal: this.abort.signal, assertCurrent });
      let ref: unknown;
      try { ref = (await backend.findRepository(repository)).defaultBranch; } finally { backend.close(); }
      assertCurrent();
      if (typeof ref !== "string" || !ref) throw new Error("Cloud repository default branch is unavailable");
      await this.ports.prepare({ project, account: chosen.account, repository, ref, signal: this.abort.signal, assertCurrent });
      await clearCloudEnvironmentPrerequisite(project, accountId, repository, assertCurrent);
    }); } catch (error) { assertCurrent(); await recordCloudEnvironmentPrerequisite(project, accountId, repository, error, assertCurrent, version); }
    return true;
  }
}
let controller: CloudEnvironmentController | undefined;
export function startCloudEnvironmentController(): void { if (!controller) { controller = new CloudEnvironmentController(); controller.start(); } }
export function stopCloudEnvironmentController(): void { controller?.stop(); controller = undefined; }
