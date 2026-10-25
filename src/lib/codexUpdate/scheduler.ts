import fs from "node:fs/promises";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { CHECK_INTERVAL_MS, CodexUpdateReportPending, type UpdateNotice } from "./update";

export interface UpdateSchedulerPorts {
  clockFile: string;
  now(): number;
  current(): boolean;
  update(): Promise<void>;
  report(notice: UpdateNotice): Promise<void>;
}

/** The existing minute timer drives this bounded, non-overlapping job. The
 * durable outbox also covers unknown/unwritable locations before CLI state exists. */
export function createCodexUpdateTicker(ports: UpdateSchedulerPorts): () => Promise<void> {
  let running = false;
  return async () => {
    if (running || !ports.current()) return;
    running = true;
    try {
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
      if (ports.now() < clock.until || !ports.current()) return;
      try { await ports.update(); }
      catch (error) {
        // The CLI's own durable outbox retries on the next minute, keeping
        // its precise version/check and its original idempotency key.
        if (error instanceof CodexUpdateReportPending) return;
        const at = ports.now();
        clock = { until: at + CHECK_INTERVAL_MS, notice: {
          id: `unavailable:${at}`, at, version: "unknown", failed: true,
          line: "Codex CLI unknown: update location or compatibility tooling unavailable; skipped",
        } };
        writeJsonDurably(ports.clockFile, clock);
        await deliver();
      }
    } finally { running = false; }
  };
}
