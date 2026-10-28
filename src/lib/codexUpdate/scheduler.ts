import fs from "node:fs/promises";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { CHECK_INTERVAL_MS, CodexUpdateReportPending, type UpdateNotice } from "./update";

export interface UpdateSchedulerPorts {
  clockFile: string;
  now(): number;
  current(): boolean;
  hasPending?(): boolean | Promise<boolean>;
  update(requested: boolean): Promise<void>;
  report(notice: UpdateNotice): Promise<void>;
}

/** The existing minute timer drives this bounded, non-overlapping job. The
 * durable outbox also covers unknown/unwritable locations before CLI state exists. */
export function createCodexUpdateTicker(ports: UpdateSchedulerPorts): (requested?: boolean) => Promise<void> {
  let running = false, requested = false, pendingRequest = false;
  const pass = async (requested: boolean) => {
    let clock: { until: number; notice: UpdateNotice | null } = { until: 0, notice: null };
    try {
      clock = JSON.parse(await fs.readFile(ports.clockFile, "utf8"));
      if (!Number.isFinite(clock.until) || clock.notice !== null && (!clock.notice || typeof clock.notice.id !== "string")) throw new Error("invalid updater clock");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const deliver = async () => {
      if (!clock.notice) return;
      await ports.report(clock.notice);
      clock.notice = null; writeJsonDurably(ports.clockFile, clock);
    };
    await deliver();
    if (!requested && ports.now() < clock.until && !await ports.hasPending?.()) return;
    if (!ports.current()) return;
    // The updater distinguishes an old outbox blocking entry from a report
    // after the requested work; only the former keeps this intent pending.
    if (requested) pendingRequest = false;
    try { await ports.update(requested); }
    catch (error) {
      // The CLI's own durable outbox retries on the next minute, keeping
      // its precise version/check and its original idempotency key.
      if (error instanceof CodexUpdateReportPending) {
        if (requested && error.beforeCheck) pendingRequest = true;
        return !error.beforeCheck;
      }
      const at = ports.now();
      clock = { until: at + CHECK_INTERVAL_MS, notice: {
        id: `unavailable:${at}`, at, version: "unknown", failed: true,
        line: "Codex CLI unknown: update location or compatibility tooling unavailable; skipped",
      } };
      writeJsonDurably(ports.clockFile, clock);
      await deliver();
    }
  };
  return async (request = false) => {
    if (!ports.current()) return;
    // An automatic pass may still stop at the CLI's own daily budget after
    // an await. Join it with one explicit follow-up; requests during that
    // explicit pass coalesce, so a drain always has at most two passes.
    if (request && (!running || !requested)) pendingRequest = true;
    if (running) return;
    running = true;
    try {
      for (let passIndex = 0; passIndex < 2; passIndex++) {
        requested = pendingRequest;
        if (await pass(requested) === false) return;
        if (!pendingRequest || !ports.current()) return;
      }
    } finally { running = false; }
  };
}
