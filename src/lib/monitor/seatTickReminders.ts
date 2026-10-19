import { createHash } from "node:crypto";
import type { SeatTickCheckInput, SeatTickItem, SeatTickTaskInput, SeatTickPipelineInput } from "./types";

export const SEAT_REMINDER_AFTER_MS = 60 * 60_000;
export const SEAT_REMINDER_REPEAT_MS = 24 * SEAT_REMINDER_AFTER_MS;
const PREFIX = "reminder:";

/** The existing delivered-item ledger owns these stamps, including after restart. */
export function reminderDeliveredVersion(version: string, receivedAt: number): string {
  return version.startsWith(PREFIX) ? `${version.split("@")[0]}@${receivedAt}` : version;
}

export function isReminderVersion(version: string): boolean { return version.startsWith(PREFIX); }

export function recentReminderVersion(version: string, now: number): boolean {
  if (!isReminderVersion(version)) return false;
  const stamp = Number(version.split("@")[1]);
  return Number.isFinite(stamp) && now - stamp < SEAT_REMINDER_REPEAT_MS;
}

export function pauseReminderReady(pipeline: SeatTickPipelineInput, now: number): boolean {
  if (!pipeline.pausedBy || pipeline.pausedBy === "operator" || pipeline.state === "terminal") return false;
  const condition = pipeline.pause?.resumeCondition;
  if (condition?.kind === "date") return Date.parse(condition.at) <= now;
  if (condition?.kind === "account-usage") return pipeline.pauseConditionMet === true;
  const since = Date.parse(pipeline.pausedAt ?? pipeline.updatedAt ?? "");
  return Number.isFinite(since) && now - since >= SEAT_REMINDER_REPEAT_MS;
}

export function taskHasBlocker(task: SeatTickTaskInput, now: number): boolean {
  const hold = task.hold;
  return !!hold && hold.kind !== "unstated" && !!hold.note.trim()
    && (!hold.until || !Number.isFinite(Date.parse(hold.until)) || Date.parse(hold.until) > now);
}

/** One lookup per check over the already bounded delivered agenda. */
export function seatTickReminders(input: SeatTickCheckInput): SeatTickItem[] {
  const shown = new Map<string, number>();
  for (const version of input.state.itemsShown ?? []) {
    if (!isReminderVersion(version)) continue;
    const [key, stamp] = version.split("@");
    if (Number.isFinite(Number(stamp))) shown.set(key!, Number(stamp));
  }
  const items: SeatTickItem[] = [];
  for (const task of input.tasks) {
    if (!task.accepted || !["inbox", "assigned"].includes(task.status) || task.owned || task.runsOn || taskHasBlocker(task, input.now)) continue;
    const since = Date.parse(task.waitingSince ?? task.updatedAt ?? "");
    if (!Number.isFinite(since) || input.now - since < SEAT_REMINDER_AFTER_MS) continue;
    const key = `${PREFIX}task:${createHash("sha256").update(task.id).digest("hex")}`;
    const last = shown.get(key);
    if (last !== undefined && input.now - last < SEAT_REMINDER_REPEAT_MS) continue;
    items.push({ kind: "task", reminderKind: "task", id: task.id, occurredAt: new Date(since).toISOString(),
      itemVersion: `${key}@${input.now}`,
      label: `${task.title} — accepted work, no open lane; waited ${Math.floor((input.now - since) / SEAT_REMINDER_AFTER_MS)}h` });
  }
  for (const pipeline of input.pipelines) {
    if (!pauseReminderReady(pipeline, input.now)) continue;
    const since = pipeline.pausedAt ?? pipeline.updatedAt;
    const key = `${PREFIX}pause:${createHash("sha256").update(`${pipeline.id}:${pipeline.pauseGeneration ?? since ?? "legacy"}`).digest("hex")}`;
    const last = shown.get(key);
    if (last !== undefined && input.now - last < SEAT_REMINDER_REPEAT_MS) continue;
    const hours = since && Number.isFinite(Date.parse(since)) ? `${Math.floor((input.now - Date.parse(since)) / SEAT_REMINDER_AFTER_MS)}h` : "an unknown time";
    items.push({ kind: "pipeline", reminderKind: "pause", id: pipeline.id, occurredAt: since,
      itemVersion: `${key}@${input.now}`,
      label: `${pipeline.title} — paused for ${hours}; reason: ${pipeline.pause?.reason ?? "not recorded"}; ${pipeline.pause?.resumeCondition ? "resume condition is met" : "no resume condition recorded; review the pause"}; use pipeline_action resume when ready` });
  }
  return items.sort((a, b) => (a.occurredAt ?? "").localeCompare(b.occurredAt ?? "") || a.id.localeCompare(b.id));
}
