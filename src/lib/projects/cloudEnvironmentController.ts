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
import { prepareCloudEnvironment, readCloudEnvironmentBindings, recordCloudEnvironmentPrerequisite, clearCloudEnvironmentPrerequisite, cloudAccountVersion } from "./codexCloudEnvironments";
import { openCloudEnvironmentBackend } from "@/lib/pipelines/cloudEnvironmentClient";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

export function cloudEnvironmentControllerPorts() {
  return { catalog: lastScannedProjectCatalog, accounts: listCodexAccounts,
    remote: recordedProjectRemote, allowed: projectAllowsAccount,
    read: readCloudEnvironmentBindings, prepare: prepareCloudEnvironment,
    backend: openCloudEnvironmentBackend,
    resolve: (project: string, accountId: string) => accountManager.resolveProjectSpawn("codex", { project, requestedId: accountId, requireCapacity: false }) };
}

/** A persisted keyset cursor makes every project/account reachable across
 * release restarts. One network slice runs at a time, outside controller ticks. */
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
  stop() { this.stopped = true; this.abort.abort(); clearTimeout(this.timer); }
  start() { this.schedule(0); }
  private schedule(delay: number) { if (!this.stopped) { this.timer = setTimeout(() => { void this.pass(); }, delay); this.timer.unref?.(); } }
  async pass(): Promise<void> {
    if (this.stopped || this.active) return;
    this.active = true;
    let completedCursor: string | null = null;
    try {
      const catalog = this.ports.catalog();
      if (!catalog) return;
      if (catalog !== this.catalog) { this.catalog = catalog; this.projects = [...new Set(catalog.map(p => canonicalProject(p.project)))].sort(); }
      if (Date.now() >= this.accountsAt) { this.accounts = this.ports.accounts().filter(a => a.authPresent).sort((a, b) => a.id.localeCompare(b.id)); this.accountsAt = Date.now() + 30_000; }
      const file = statePath("cloud-environment-cursor.json");
      let after = "";
      try { const value: unknown = JSON.parse(fs.readFileSync(file, "utf8")); if (value && typeof value === "object" && "after" in value && typeof value.after === "string") after = value.after; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cloud environment preparation cursor is unreadable"); }
      // Binary-search the project prefix; never walk earlier projects on a tick.
      const projectKey = after.split("\0")[0] ?? "";
      let lo = 0, hi = this.projects.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.projects[mid]! < projectKey) lo = mid + 1; else hi = mid; }
      let selected: { project: string; accountId: string; cursor: string } | undefined;
      for (let i = lo; i < Math.min(this.projects.length, lo + 8) && !selected; i++) {
        const project = this.projects[i]!;
        for (const account of this.accounts) {
          const cursor = `${project}\0${account.id}`;
          if (cursor > after) { selected = { project, accountId: account.id, cursor }; break; }
        }
      }
      const guard = () => { this.abort.signal.throwIfAborted(); assertStateMutationAllowed(stateDir()); };
      guard();
      if (!selected) { writeJsonDurably(file, { after: "" }); return; }
      const { project, accountId } = selected;
      completedCursor = selected.cursor;
      const repository = githubRepositoryOfRemote(this.ports.remote(project));
      if (repository && this.ports.allowed(project, "codex", accountId)) {
        const saved = this.ports.read(project, { accountId }).bindings.filter(r => r.kind === "automatic" && r.repository === repository);
        const version = cloudAccountVersion({ home: this.accounts.find(account => account.id === accountId)!.home });
        if (!saved.length || saved.some(r => r.retryAt <= Date.now() || r.state === "discovering" || r.accountVersion !== version)) {
          const resolve = () => this.ports.resolve(project, accountId);
          const chosen = resolve();
          if (chosen.kind === "available") {
            const assertCurrent = () => {
              guard(); const current = resolve();
              if (!this.ports.allowed(project, "codex", accountId) || current.kind !== "available" || current.account.home !== chosen.account.home
                || githubRepositoryOfRemote(this.ports.remote(project)) !== repository) throw new Error("Cloud environment preparation authority changed");
            };
            try { await withViewerOperation("cloud.environment-preparation", async () => {
              const backend = await this.ports.backend({ account: chosen.account, signal: this.abort.signal, assertCurrent });
              let ref: unknown;
              try { ref = (await backend.findRepository(repository)).defaultBranch; } finally { backend.close(); }
              assertCurrent();
              if (typeof ref !== "string" || !ref) throw new Error("Cloud repository default branch is unavailable");
              await this.ports.prepare({ project, account: chosen.account, repository, ref, signal: this.abort.signal, assertCurrent });
              await clearCloudEnvironmentPrerequisite(project, accountId, repository, assertCurrent);
            }); } catch (error) { assertCurrent(); await recordCloudEnvironmentPrerequisite(project, accountId, repository, error, assertCurrent, version); }
          }
        }
      }
      guard(); writeJsonDurably(file, { after: selected.cursor });
    } catch (error) {
      // Provider bodies never cross the client boundary. This log reports only
      // the failed operation; the binding carries its typed prerequisite.
      if (!this.stopped) console.error("[cloud environments] preparation deferred", error instanceof Error ? error.name : "unknown");
    } finally {
      if (!this.stopped && completedCursor) {
        try { assertStateMutationAllowed(stateDir()); writeJsonDurably(statePath("cloud-environment-cursor.json"), { after: completedCursor }); }
        catch { if (!this.stopped) console.error("[cloud environments] preparation cursor could not be saved"); }
      }
      this.active = false; this.schedule(2000);
    }
  }
}
let controller: CloudEnvironmentController | undefined;
export function startCloudEnvironmentController(): void { if (!controller) { controller = new CloudEnvironmentController(); controller.start(); } }
export function stopCloudEnvironmentController(): void { controller?.stop(); controller = undefined; }
