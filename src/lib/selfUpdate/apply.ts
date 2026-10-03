import { settleCheckoutDeployment } from "./deployments";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { releaseDrain, writeDrain } from "./drain";
import type { LauncherRecord } from "./launcher";
export interface ApplyIntent {
  requestId: string; target: string; rollbackPointer: string | null; launcherPid: number; launcherIdentity: string | null;
  switchedAt?: string; admissionRefused?: boolean; externalRestart?: boolean; trigger: "operator" | "seat" | "auto"; deploymentId?: string; startedAt: string;
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
      if (value.state === "building") this.patch({ state: "failed", detail: "The Viewer stopped during the build" });
    } catch (error) { if (existsSync(join(directory, "apply.json"))) throw error; }
  }
  begin(record: LauncherRecord, target: string, trigger: ApplyIntent["trigger"], deploymentId?: string): void {
    if (this.current && ["building", "ready", "switching"].includes(this.current.state)) throw new Error("An apply is already active");
    this.current = { requestId: randomUUID(), target, trigger, deploymentId, rollbackPointer: existsSync(record.releasePointer) ? readFileSync(record.releasePointer, "utf8") : null,
      launcherPid: record.launcher.pid, launcherIdentity: record.launcher.startIdentity, state: "building", rolledBack: false, startedAt: new Date().toISOString() };
    this.save();
  }
  patch(patch: Partial<ApplyIntent>): void { if (this.current) { this.current = { ...this.current, ...patch }; this.save(); } }
  private save(): void { writeAtomic(join(this.directory, "apply.json"), this.current); if (this.current) settleCheckoutDeployment(this.directory, this.current); }
  send(record: LauncherRecord, autoGateId?: string): void {
    const intent = this.current;
    if (!intent || record.launcher.relaunch !== 1 || record.launcher.pid !== intent.launcherPid
      || record.launcher.startIdentity !== intent.launcherIdentity) throw new Error("The launcher must be upgraded before applying this release");
    if (existsSync(record.requestFile)) throw new Error("A launcher request is already pending");
    if (!autoGateId) writeDrain(join(this.directory, "auto-drain.json"), { id: intent.requestId, target: intent.target, since: intent.startedAt, until: Date.now() + 10 * 60_000, persistent: true });
    rmSync(`${record.requestFile}.result.json`, { force: true });
    this.patch({ state: "switching", switchedAt: new Date().toISOString() });
    try {
      writeAtomic(record.requestFile, { requestId: intent.requestId, role: "relaunch", target: intent.target,
        rollbackPointer: intent.rollbackPointer, requestedAt: intent.startedAt, ...(autoGateId ? { autoGateId } : {}) });
    } catch (error) {
      releaseDrain(join(this.directory, "auto-drain.json"), intent.requestId);
      this.patch({ state: "failed", detail: "The launcher request could not be published" });
      throw error;
    }
  }
  observe(record: LauncherRecord, hostHealthy = true): "done" | "failed" | null {
    const intent = this.current;
    if (!intent || !["ready", "switching"].includes(intent.state)) return null;
    let result: { requestId?: string; state?: string; detail?: string } | null = null;
    try { result = JSON.parse(readFileSync(`${record.requestFile}.result.json`, "utf8")); } catch { /* no terminal admission result */ }
    const untaken = intent.state === "switching" && !intent.externalRestart && intent.switchedAt
      && Date.now() - Date.parse(intent.switchedAt) > 30_000 && record.launcher.state === "healthy"
      && record.launcher.requestId !== intent.requestId && !existsSync(record.requestFile)
      && !existsSync(record.requestFile.replace(/request-([^/]+)\.json$/, "trial-$1.json"));
    if ((result?.requestId === intent.requestId && result.state === "rejected") || untaken) {
      // The serving generation never took this request. Restore only our own
      // published pointer; an unrelated newer pointer retains its custody.
      try {
        if (JSON.parse(readFileSync(record.releasePointer, "utf8")).sha === intent.target) {
          if (intent.rollbackPointer === null) rmSync(record.releasePointer, { force: true });
          else { const temporary = `${record.releasePointer}.${process.pid}.tmp`; writeFileSync(temporary, intent.rollbackPointer, { mode: 0o600 }); renameSync(temporary, record.releasePointer); }
        }
      } catch { /* A missing pointer already resolves to the serving install. */ }
      this.patch({ state: "failed", admissionRefused: true, detail: result?.detail ?? "The launcher did not take the durable update request" });
      releaseDrain(join(this.directory, "auto-drain.json"), intent.requestId); return "failed";
    }
    const bootstrap = intent.state === "ready" && record.launcher.relaunch === 1
      && (record.launcher.pid !== intent.launcherPid || record.launcher.startIdentity !== intent.launcherIdentity);
    if (!bootstrap && (record.launcher.requestId !== intent.requestId
      || (!intent.externalRestart && (record.launcher.pid !== intent.launcherPid || record.launcher.startIdentity !== intent.launcherIdentity)))) return null;
    const error = record.launcher.error;
    if (error?.kind === "fell-back") {
      this.patch({ state: "failed", rolledBack: true, detail: error.detail });
      releaseDrain(join(this.directory, "auto-drain.json"), intent.requestId); return "failed";
    }
    if (!hostHealthy || record.launcher.state !== "healthy" || error || record.web.state !== "healthy" || record.runtimeHost.state !== "healthy"
      || record.web.revision !== intent.target.slice(0, 7) || record.runtimeHost.revision !== intent.target.slice(0, 7)) return null;
    this.patch({ state: "done" }); releaseDrain(join(this.directory, "auto-drain.json"), intent.requestId); return "done";
  }
}
