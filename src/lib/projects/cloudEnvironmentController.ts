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
/** The one binding that decides whether the background walk contacts the
 * provider for a pair. The walk prepares only the repository's default branch,
 * so it answers for two rows: the unresolved-ref row (`ref: ""`), which exists
 * while the default-branch lookup is failing and therefore speaks for the
 * pair's latest outcome, and otherwise the default branch's own row. Rows of
 * other refs belong to the stages that prepared them. `"lookup"` means the
 * default branch is unknown and no failure is recorded, so one lookup is owed;
 * `"absent"` means the default branch has no binding yet. */
export function cloudEnvironmentGate(saved: readonly SavedBinding[], defaultRef: string | undefined): SavedBinding | "lookup" | "absent" {
  const unresolved = saved.find(row => row.ref === "");
  if (unresolved) return unresolved;
  if (defaultRef === undefined) return "lookup";
  return saved.find(row => row.ref === defaultRef) ?? "absent";
}
/** Whether the walk contacts the provider for the pair behind `gate`.
 *
 * Healthy and pending bindings keep their timers: a ready binding is
 * revalidated when its day ends, a setup in progress is polled, a failure
 * inside its reconciliation window backs off and retries. A changed sign-in
 * or a changed choice (which reads as `discovering`) is due at once. A
 * terminal unavailable binding waits for `trigger` (a stage or an operator
 * asked for the pair, or this release has yet to look at it), and its
 * recorded cooldown bounds every trigger. `followUp` is false for a pair whose
 * last attempt was a release's first look: that look is a single attempt, so
 * its failure is left without the retries of a reconciliation window. */
export function cloudEnvironmentPreparationDue(gate: ReturnType<typeof cloudEnvironmentGate>, accountVersion: string, now: number, trigger: boolean, followUp = true): boolean {
  if (typeof gate === "string") return true;
  if (gate.accountVersion !== accountVersion || gate.state === "discovering") return true;
  return gate.retryAt <= now && (gate.state !== "unavailable" || trigger || (followUp && reconciling(gate, now)));
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
  /** Each pair's default branch as the last successful lookup reported it,
   * persisted beside the cursor. */
  private readonly defaultRefs = new Map<string, string>();
  /** Pairs with no trigger outstanding. A pair is absent until this release
   * has served it once, and a demand removes it again; a trigger that meets a
   * cooldown stays outstanding until the cooldown ends. */
  private readonly served = new Set<string>();
  /** Pairs a stage or an operator asked for and that are yet to be attempted. */
  private readonly demanded = new Set<string>();
  /** Pairs whose last attempt was this release's first look at a terminal
   * binding. Releases start several times a day, so that look spends one
   * attempt; the full failure budget is kept for the other triggers. */
  private readonly single = new Set<string>();
  private walkSignature: string | null = null;
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
    try {
      const value: unknown = JSON.parse(fs.readFileSync(statePath("cloud-environment-cursor.json"), "utf8"));
      if (value && typeof value === "object" && "after" in value && typeof value.after === "string") after = value.after;
      if (value && typeof value === "object" && "defaultRefs" in value && value.defaultRefs && typeof value.defaultRefs === "object") {
        for (const [pair, ref] of Object.entries(value.defaultRefs)) if (typeof ref === "string" && ref) this.defaultRefs.set(pair, ref);
      }
    }
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
      const after = this.readCursor();
      const demand = takeCloudEnvironmentDemand();
      if (demand) {
        const project = canonicalProject(demand.project);
        delay = 0;
        if (this.projects.includes(project) && this.accounts.some(account => account.id === demand.accountId)) {
          this.guard();
          const pair = `${project}\0${demand.accountId}`;
          this.served.delete(pair); this.demanded.add(pair);
          if (await this.visit(project, demand.accountId, pair, attempt)) this.restartWalk();
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
      // A project or account that appears while pairs are being walked starts
      // the count again, so the walk ends only after every current pair.
      if (signature !== this.walkSignature) { this.walkSignature = signature; this.walked = 0; }
      // Read before the walk's first pair: a binding written while it walks
      // differs from this value, so the quiet check walks again.
      if (this.walked === 0) this.walkRevision = this.ports.revision();
      const selected = this.nextPair(after);
      this.guard();
      if (!selected) { delay = QUIET_MS; return; }
      this.cursor = selected.cursor;
      if (await this.visit(selected.project, selected.accountId, selected.cursor, attempt)) this.restartWalk();
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
        try {
          assertStateMutationAllowed(stateDir());
          if (this.defaultRefs.size > 4096) for (const pair of this.defaultRefs.keys()) if (!this.projects.includes(pair.split("\0")[0]!)) this.defaultRefs.delete(pair);
          writeJsonDurably(statePath("cloud-environment-cursor.json"), { after: this.cursor, defaultRefs: Object.fromEntries(this.defaultRefs) });
        }
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
  /** A binding timer the quiet state must wake for. */
  private wakeAt(at: number) {
    this.nextTimerAt = Math.min(this.nextTimerAt, at);
    if (this.quiet) this.quiet.until = Math.min(this.quiet.until, at);
  }
  /** Evaluate one pair and, when it is due, run one provider slice for it.
   * Returns whether the provider was contacted. */
  private async visit(project: string, accountId: string, pair: string, attempt: { pair: string | null }): Promise<boolean> {
    const repository = githubRepositoryOfRemote(this.ports.remote(project));
    if (!repository || !this.ports.allowed(project, "codex", accountId)) return false;
    const saved = this.ports.read(project, { accountId }).bindings.filter(r => r.kind === "automatic" && r.repository === repository);
    const version = cloudAccountVersion({ home: this.accounts.find(account => account.id === accountId)!.home });
    const now = Date.now(), trigger = !this.served.has(pair);
    const gate = cloudEnvironmentGate(saved, this.defaultRefs.get(pair));
    const followUp = !this.single.has(pair);
    if (!cloudEnvironmentPreparationDue(gate, version, now, trigger, followUp)) {
      // Not due means a binding whose timer lies ahead. A terminal one wakes
      // the walk only for an outstanding trigger, which is served when its
      // cooldown ends; every other binding wakes it at its own timer.
      if (typeof gate !== "string") {
        const terminal = gate.state === "unavailable" && !(followUp && reconciling(gate, now));
        if (!terminal || trigger) this.wakeAt(gate.retryAt);
        if (!terminal) this.served.add(pair);
      }
      return false;
    }
    const resolve = () => this.ports.resolve(project, accountId);
    const chosen = resolve();
    if (chosen.kind !== "available") return false;
    this.served.add(pair);
    // Due only because this release had yet to look at a terminal binding.
    const firstLook = typeof gate !== "string" && gate.accountVersion === version && gate.state === "unavailable"
      && !(followUp && reconciling(gate, now)) && !this.demanded.has(pair);
    if (firstLook) this.single.add(pair); else this.single.delete(pair);
    this.demanded.delete(pair);
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
      this.defaultRefs.set(pair, ref);
      await this.ports.prepare({ project, account: chosen.account, repository, ref, signal: this.abort.signal, assertCurrent });
      await clearCloudEnvironmentPrerequisite(project, accountId, repository, assertCurrent);
    }); } catch (error) { assertCurrent(); await recordCloudEnvironmentPrerequisite(project, accountId, repository, error, assertCurrent, version, firstLook); }
    return true;
  }
}
let controller: CloudEnvironmentController | undefined;
export function startCloudEnvironmentController(): void { if (!controller) { controller = new CloudEnvironmentController(); controller.start(); } }
export function stopCloudEnvironmentController(): void { controller?.stop(); controller = undefined; }
