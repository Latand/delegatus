import { recoverCheckoutDeployments, settleCheckoutDeployment } from "./deployments";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { endRestartGate, restartGateFile } from "./restartGate";
import { releaseDrain, writeDrain } from "./drain";
import { launcherControlFile, publishLauncherRequest, type LauncherRecord } from "./launcher";
export interface ApplyIntent {
  requestId: string; target: string; releasePointer?: string; rollbackPointer: string | null; launcherPid: number; launcherIdentity: string | null;
  rollbackWebRevision?: string | null; rollbackHostRevision?: string | null; rollbackPackage?: { root: string; version: string };
  autoGateId?: string; switchedAt?: string; admissionRefused?: boolean; externalRestart?: boolean; trigger: "operator" | "seat" | "auto"; deploymentId?: string; startedAt: string;
  state: "building" | "ready" | "switching" | "done" | "failed"; rolledBack: boolean; detail?: string;
}
export function writeAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 }); renameSync(temporary, file);
}
export class ApplyController {
  current: ApplyIntent | null = null;
  constructor(private readonly directory: string) {
    try { const value = JSON.parse(readFileSync(join(directory, "apply.json"), "utf8"));
      if (typeof value.requestId !== "string" || !/^[a-f0-9]{40}$/.test(value.target)) throw new Error("Invalid apply intent");
      this.current = value;
      if (value.state === "building") { this.restoreUntaken(); this.patch({ state: "failed", detail: "The Viewer stopped during the build" }); }
    } catch (error) { if (existsSync(join(directory, "apply.json"))) throw error; }
    recoverCheckoutDeployments(directory, this.current);
  }
  begin(record: LauncherRecord, target: string, trigger: ApplyIntent["trigger"], deploymentId?: string, options: { rollbackPointer?: string | null; rollbackRevision?: string | null; state?: "building" | "ready"; autoGateId?: string } = {}): void {
    if (this.current && ["building", "ready", "switching"].includes(this.current.state)) throw new Error("An apply is already active");
    this.current = { requestId: randomUUID(), target, releasePointer: record.releasePointer, trigger, deploymentId, rollbackPointer: options.rollbackPointer !== undefined ? options.rollbackPointer : existsSync(record.releasePointer) ? readFileSync(record.releasePointer, "utf8") : null,
      rollbackWebRevision: options.rollbackRevision !== undefined ? options.rollbackRevision : record.web.revision,
      rollbackHostRevision: options.rollbackRevision !== undefined ? options.rollbackRevision : record.runtimeHost.revision,
      launcherPid: record.launcher.pid, launcherIdentity: record.launcher.startIdentity, state: options.state ?? "building", autoGateId: options.autoGateId, rolledBack: false, startedAt: new Date().toISOString() };
    if (!record.checkout && record.installRoot) {
      try { const version = JSON.parse(readFileSync(join(record.installRoot, "package.json"), "utf8")).version;
        if (typeof version === "string") this.current.rollbackPackage = { root: record.installRoot, version };
      } catch { /* A package without its manifest cannot prove a legacy rollback. */ }
    }
    this.save();
  }
  patch(patch: Partial<ApplyIntent>): void { if (this.current) { this.current = { ...this.current, ...patch }; this.save(); } }
  private save(): void { writeAtomic(join(this.directory, "apply.json"), this.current); if (this.current) settleCheckoutDeployment(this.directory, this.current); }
  restoreUntaken(record?: LauncherRecord): void {
    const intent = this.current;
    const file = record?.releasePointer ?? intent?.releasePointer;
    if (!intent || !file || !existsSync(file)) return;
    const pointer = JSON.parse(readFileSync(file, "utf8"));
    if (pointer.sha !== intent.target) return;
    if (intent.rollbackPointer === null) rmSync(file, { force: true });
    else { const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, intent.rollbackPointer, { mode: 0o600 }); renameSync(temporary, file); }
  }
  send(record: LauncherRecord, autoGateId?: string): void {
    const intent = this.current;
    if (!intent || record.launcher.relaunch !== 1 || record.launcher.pid !== intent.launcherPid
      || record.launcher.startIdentity !== intent.launcherIdentity) throw new Error("The launcher must be upgraded before applying this release");
    if (existsSync(record.requestFile)) throw new Error("A launcher request is already pending");
    if (!autoGateId) writeDrain(join(this.directory, "auto-drain.json"), { id: intent.requestId, target: intent.target, since: intent.startedAt, until: Date.now() + 10 * 60_000, persistent: true });
    rmSync(`${record.requestFile}.result.json`, { force: true });
    this.patch({ state: "switching", externalRestart: false, switchedAt: new Date().toISOString() });
    try {
      publishLauncherRequest(record.requestFile, { requestId: intent.requestId, role: "relaunch", target: intent.target,
        rollbackPointer: intent.rollbackPointer, requestedAt: intent.startedAt, ...(autoGateId ? { autoGateId } : {}) });
    } catch (error) {
      this.restoreUntaken(record);
      this.patch({ state: "failed", detail: "The launcher request could not be published" });
      this.releaseAdmission(record, intent);
      throw error;
    }
  }
  observe(record: LauncherRecord, hostHealthy = true, now = Date.now()): "done" | "failed" | null {
    const intent = this.current;
    if (!intent || !["ready", "switching", "done", "failed"].includes(intent.state)) return null;
    let result: { requestId?: string; target?: string; state?: string; detail?: string; previousEntry?: string } | null = null;
    try { result = JSON.parse(readFileSync(`${record.requestFile}.result.json`, "utf8")); } catch { /* no terminal admission result */ }
    const sameLauncher = record.launcher.pid === intent.launcherPid && record.launcher.startIdentity === intent.launcherIdentity;
    const trialFile = launcherControlFile(record.requestFile, "trial");
    let trial: { requestId?: string; target?: string; rollbackPointer?: string | null; state?: string; detail?: string; previousEntry?: string } | null = null;
    try { trial = JSON.parse(readFileSync(trialFile, "utf8")); } catch { /* no readable trial */ }
    const coherentRollback = (requirePointer = true): boolean => {
      if (!hostHealthy || (record.launcher.state && record.launcher.state !== "healthy")
        || record.web.state !== "healthy" || record.runtimeHost.state !== "healthy") return false;
      let rollbackRevision: string | null = null;
      try { rollbackRevision = JSON.parse(intent.rollbackPointer ?? "null")?.sha?.slice(0, 7) ?? null; } catch { /* An unpublished release uses captured serving revisions. */ }
      const webRevision = rollbackRevision ?? intent.rollbackWebRevision;
      const hostRevision = rollbackRevision ?? intent.rollbackHostRevision;
      const pointerRestored = intent.rollbackPointer === null ? !existsSync(record.releasePointer)
        : existsSync(record.releasePointer) && readFileSync(record.releasePointer, "utf8") === intent.rollbackPointer;
      let packageRestored = false;
      if (!record.checkout && intent.rollbackPointer === null && intent.rollbackPackage
        && (sameLauncher && record.installRoot === intent.rollbackPackage.root
          || trial?.previousEntry === join(intent.rollbackPackage.root, "bin", "cli.mjs")
          || result?.requestId === intent.requestId && result.target === intent.target && result.state === "rolled-back"
            && result.previousEntry === join(intent.rollbackPackage.root, "bin", "cli.mjs"))
        && (!record.installRoot || record.installRoot === intent.rollbackPackage.root)
        && intent.rollbackWebRevision === null && intent.rollbackHostRevision === null) {
        try { packageRestored = JSON.parse(readFileSync(join(intent.rollbackPackage.root, "package.json"), "utf8")).version === intent.rollbackPackage.version; } catch { /* Missing or changed package cannot settle. */ }
      }
      return (!requirePointer || pointerRestored) && (!record.launcher.revision || record.launcher.revision.slice(0, 7) === webRevision) && webRevision === hostRevision && !!(packageRestored || webRevision && hostRevision)
        && record.web.revision === webRevision && record.runtimeHost.revision === hostRevision;
    };
    // A crash can follow the terminal intent write but precede hold release.
    // Verify the cold serving generation before releasing that same owner;
    // the terminal state and its receipt are never written a second time.
    if (intent.state === "done" || intent.state === "failed") {
      const targetServing = hostHealthy && record.launcher.state === "healthy" && record.web.state === "healthy"
        && record.runtimeHost.state === "healthy" && record.web.revision === intent.target.slice(0, 7)
        && record.runtimeHost.revision === intent.target.slice(0, 7)
        && (!record.launcher.revision || record.launcher.revision === intent.target);
      if (intent.state === "done" ? targetServing : coherentRollback()) this.releaseAdmission(record, intent);
      return null;
    }
    // A first upgrade may return to a launcher predating the trial protocol.
    // Its healthy record carries no request ID; the owned trial, restored raw
    // pointer and independently checked serving processes establish rollback.
    if (intent.externalRestart && trial?.requestId === intent.requestId && trial.target === intent.target
      && trial.state === "rolled-back" && trial.rollbackPointer === intent.rollbackPointer && hostHealthy
      && (!record.launcher.state || record.launcher.state === "healthy")
      && (record.launcher.requestId == null || record.launcher.requestId === intent.requestId)
      && record.web.state === "healthy" && record.runtimeHost.state === "healthy") {
      if (coherentRollback()) {
        this.patch({ state: "failed", rolledBack: true, detail: trial.detail ?? "The replacement rolled back to the previous release" });
        this.releaseAdmission(record, intent); rmSync(trialFile, { force: true }); return "failed";
      }
    }
    const externalUntaken = intent.state === "switching" && intent.externalRestart && intent.switchedAt
      && now - Date.parse(intent.switchedAt) > 60_000 && sameLauncher && hostHealthy
      && (!record.launcher.state || record.launcher.state === "healthy")
      && record.web.state === "healthy" && record.runtimeHost.state === "healthy"
      && record.launcher.requestId !== intent.requestId;
    const untaken = intent.state === "switching" && !intent.externalRestart && intent.switchedAt
      && now - Date.parse(intent.switchedAt) > 30_000 && record.launcher.state === "healthy"
      && record.launcher.requestId !== intent.requestId && !existsSync(record.requestFile)
      && !existsSync(launcherControlFile(record.requestFile, "trial"));
    if ((result?.requestId === intent.requestId && result.state === "rejected") || untaken || externalUntaken) {
      // A pointer restore is allowed only when the verified source already
      // serves coherently. A cold candidate needs launcher recovery first.
      if (!coherentRollback(false)) return null;
      this.restoreUntaken(record);
      if (!coherentRollback()) return null;
      if (externalUntaken && trial?.requestId === intent.requestId) rmSync(trialFile, { force: true });
      this.patch({ state: "failed", admissionRefused: true, detail: result?.detail ?? "The launcher did not take the durable update request" });
      this.releaseAdmission(record, intent); return "failed";
    }
    const trialProtocol = record.launcher.relaunch === 1 || record.launcher.protocol === "delegatus-launcher-relaunch-v1";
    const bootstrap = intent.state === "ready" && trialProtocol && record.launcher.state === "healthy" && hostHealthy
      && (record.launcher.pid !== intent.launcherPid || record.launcher.startIdentity !== intent.launcherIdentity);
    const successor = !sameLauncher && trialProtocol && record.launcher.state === "healthy" && hostHealthy;
    if (!bootstrap && (record.launcher.requestId !== intent.requestId || (!sameLauncher && !successor))) return null;
    const error = record.launcher.error;
    if (error?.kind === "fell-back") {
      if (!coherentRollback()) return null;
      this.patch({ state: "failed", rolledBack: true, detail: error.detail });
      this.releaseAdmission(record, intent); return "failed";
    }
    if (error && record.launcher.state === "healthy") {
      if (!coherentRollback(false)) return null;
      this.restoreUntaken(record);
      if (!coherentRollback()) return null;
      const detail = error.kind === "message" ? error.text : "The launcher refused the replacement";
      this.patch({ state: "failed", detail });
      this.releaseAdmission(record, intent); return "failed";
    }
    if (!hostHealthy || record.launcher.state !== "healthy" || error || record.web.state !== "healthy" || record.runtimeHost.state !== "healthy"
      || record.launcher.revision && record.launcher.revision !== intent.target
      || record.web.revision !== intent.target.slice(0, 7) || record.runtimeHost.revision !== intent.target.slice(0, 7)) return null;
    this.patch({ state: "done" }); this.releaseAdmission(record, intent); return "done";
  }
  private releaseAdmission(record: LauncherRecord, intent: ApplyIntent): void {
    // Consume only this settled request, after coherent serving verification.
    try {
      const request = JSON.parse(readFileSync(record.requestFile, "utf8"));
      if (request.requestId === intent.requestId && request.target === intent.target) rmSync(record.requestFile, { force: true });
    } catch { /* Missing, unreadable or foreign requests keep their custody. */ }
    releaseDrain(join(this.directory, "auto-drain.json"), intent.requestId);
    if (intent.autoGateId) endRestartGate(restartGateFile(record.requestFile), intent.autoGateId);
  }

}
