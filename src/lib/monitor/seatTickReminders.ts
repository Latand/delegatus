import { redactMonitorText } from "./redact";
import type { OverdueTaskCursor } from "@/lib/state/sqliteStateStore";
import { createHash } from "node:crypto";
import type { SeatTickCheckInput, SeatTickItem, SeatTickTaskInput, SeatTickPipelineInput, SeatTickTaskPage } from "./types";

export const SEAT_REMINDER_AFTER_MS = 60 * 60_000;
export const SEAT_REMINDER_REPEAT_MS = 24 * SEAT_REMINDER_AFTER_MS;
const PREFIX = "reminder:";

/** The existing delivered-item ledger owns these stamps, including after restart. */
export function reminderDeliveredVersion(version: string, receivedAt: number): string {
  const [key, , ...metadata] = version.split("@");
  return version.startsWith(PREFIX) ? [key, receivedAt, ...metadata].join("@") : version;
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

export function taskIsOverdue(task: SeatTickTaskInput, now: number): boolean {
  return task.status !== "done" && !task.runsOn && !!task.dueAt && Date.parse(task.dueAt) <= now
    && !(task.hold?.until && Date.parse(task.hold.until) > now);
}

function age(ms: number): string {
  const hours = Math.max(0, Math.floor(ms / SEAT_REMINDER_AFTER_MS));
  return hours >= 24 ? `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}` : `${hours}h`;
}

function overdueReminderKey(id: string, dueAt: string): string {
  return `${PREFIX}overdue:${createHash("sha256").update(JSON.stringify([id, new Date(dueAt).toISOString()])).digest("hex")}`;
}

/** Credits share the exact rendered bullet with the hashed reminder version.
 * Only delivery records them, so selection cannot skip an unseen task. */
function overdueDateVersion(id: string, dueAt: string, now: number): string {
  return `${PREFIX}overdue-date:${Buffer.from(JSON.stringify([id, Date.parse(dueAt)])).toString("base64url")}@${now}`;
}

/** Recent credits suppress repeats. Historical credits keep the discovery
 * head for unseen dates while the cursor drains older daily repeats. */
export function shownOverdueDates(versions: readonly string[], now: number, includeExpired = false): string[] {
  return versions.flatMap(version => {
    if (!version.startsWith(`${PREFIX}overdue-date:`) || !includeExpired && !recentReminderVersion(version, now)) return [];
    const stamp = version.split("@")[1];
    if (!stamp || !Number.isFinite(Number(stamp))) return [];
    try {
      const pair: unknown = JSON.parse(Buffer.from(version.split("@")[0]!.slice(`${PREFIX}overdue-date:`.length), "base64url").toString());
      return Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && Number.isFinite(pair[1])
        ? [`t:${pair[0]}:${pair[1]}`] : [];
    } catch { return []; }
  });
}

/** One recent cursor, replaced only by a complete delivered sweep bullet. */
export function overdueSweepCursor(versions: readonly string[], now: number): OverdueTaskCursor | null {
  for (const version of [...versions].reverse()) {
    if (!version.startsWith(`${PREFIX}overdue-sweep@`) || !recentReminderVersion(version, now)) continue;
    try {
      const value: unknown = JSON.parse(Buffer.from(version.split("@")[2] ?? "", "base64url").toString());
      if (Array.isArray(value) && value.length === 3 && [0, 1, 2].includes(value[0]) && Number.isFinite(value[1]) && typeof value[2] === "string") return [value[0], value[1], value[2]];
    } catch { /* Malformed metadata grants no cursor. */ }
  }
  return null;
}

/** One lookup per check over the already bounded delivered agenda. */
export function seatTickReminders(input: SeatTickCheckInput): SeatTickItem[] {
  const shown = new Map<string, number>();
  for (const version of input.state.itemsShown ?? []) {
    if (!isReminderVersion(version)) continue;
    const [key, stamp] = version.split("@");
    if (Number.isFinite(Number(stamp))) shown.set(key!, Number(stamp));
  }
  const items: { dueAt: number; item: SeatTickItem }[] = [];
  const overdueItems: SeatTickItem[] = [];
  const overdue = (input.overdueTasks ?? []).filter(task => taskIsOverdue(task, input.now));
  const overdueIds = new Set(overdue.map(task => task.id));
  const priority = (task: SeatTickTaskInput) => task.priority === "high" ? 0 : task.priority === "low" ? 2 : 1;
  for (const task of [...overdue].sort((a, b) => priority(a) - priority(b) || Date.parse(a.dueAt!) - Date.parse(b.dueAt!) || a.id.localeCompare(b.id))) {
    const key = overdueReminderKey(task.id, task.dueAt!);
    const last = shown.get(key);
    if (last !== undefined && input.now - last < SEAT_REMINDER_REPEAT_MS) continue;
    const history = task.dueHistory;
    const moved = history?.slips ?? 0;
    const first = new Date(history?.firstAt ?? task.dueAt!).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    const action = moved >= 3 ? ": move again only with a lane running on it or a hold with an until; otherwise split or close it" : "";
    const opened = Date.parse(task.createdAt ?? task.waitingSince ?? task.updatedAt ?? "");
    overdueItems.push({
      kind: "task", reminderKind: "overdue", id: task.id, occurredAt: task.dueAt,
      itemVersion: `${key}@${input.now}`,
      creditVersions: [overdueDateVersion(task.id, task.dueAt!, input.now),
        ...(task.overdueSweep ? [`${PREFIX}overdue-sweep@${input.now}@${task.overdueSweep}`] : [])],
      label: `overdue ${age(input.now - Date.parse(task.dueAt!))} · open ${Number.isFinite(opened) ? age(input.now - opened) : "unknown"} · ${task.priority ?? "normal"} · moved ${moved}×${action} (first due ${first}) · ${task.owned ? "lane running" : "no lane"} — ${task.title}`,
    });
  }
  for (const task of input.tasks) {
    if (overdueIds.has(task.id) || taskIsOverdue(task, input.now)) continue;
    if (!task.accepted || !["inbox", "assigned"].includes(task.status) || task.owned || task.runsOn || task.hold) continue;
    const since = Date.parse(task.waitingSince ?? task.updatedAt ?? "");
    if (!Number.isFinite(since) || input.now - since < SEAT_REMINDER_AFTER_MS) continue;
    const key = `${PREFIX}task:${createHash("sha256").update(task.id).digest("hex")}`;
    const last = shown.get(key);
    if (last !== undefined && input.now - last < SEAT_REMINDER_REPEAT_MS) continue;
    items.push({ dueAt: last === undefined ? since : Math.max(since, last + SEAT_REMINDER_REPEAT_MS), item: {
      kind: "task", reminderKind: "task", id: task.id, occurredAt: new Date(since).toISOString(),
      itemVersion: `${key}@${input.now}`,
      label: `Accepted work, no open lane; waited ${Math.floor((input.now - since) / SEAT_REMINDER_AFTER_MS)}h — ${task.title}` } });
  }
  for (const pipeline of input.pipelines) {
    if (!pauseReminderReady(pipeline, input.now)) continue;
    const since = pipeline.pausedAt ?? pipeline.updatedAt;
    const key = `${PREFIX}pause:${createHash("sha256").update(`${pipeline.id}:${pipeline.pauseGeneration ?? since ?? "legacy"}`).digest("hex")}`;
    const last = shown.get(key);
    if (last !== undefined && input.now - last < SEAT_REMINDER_REPEAT_MS) continue;
    const parsed = Date.parse(since ?? "");
    const firstDue = Number.isFinite(parsed) ? parsed : input.now;
    items.push({ dueAt: last === undefined ? firstDue : Math.max(firstDue, last + SEAT_REMINDER_REPEAT_MS), item: {
      kind: "pipeline", reminderKind: "pause", id: pipeline.id, occurredAt: since,
      itemVersion: `${key}@${input.now}`,
      label: `${pipeline.title} — paused; reason: ${pipeline.pause?.reason ?? "not recorded"}; ${pipeline.pause?.resumeCondition ? "resume condition is met" : "no resume condition recorded; review the pause"}; use pipeline_action resume when ready` } });
  }
  return [...overdueItems, ...items.sort((a, b) => a.dueAt - b.dueAt || a.item.id.localeCompare(b.item.id) || a.item.kind.localeCompare(b.item.kind))
    .map(entry => entry.item)];
}

const singleLine = (text: string, max: number) => redactMonitorText(text).replace(/\s+/g, " ").slice(0, max);
const taskKey = (id: string, kind: "task" | "waiting") => `${PREFIX}${kind}:${createHash("sha256").update(id).digest("hex")}`;

/** The delivered reminder ledger is the page cursor. No selection earns credit. */
export function seatTickTaskPage(input: SeatTickCheckInput, legacy: readonly SeatTickTaskInput[] = []): SeatTickTaskPage | undefined {
  const fresh = { ...input, state: { ...input.state, itemsShown: [] } };
  const all = seatTickReminders(fresh).filter(item => item.kind === "task");
  const tasks = new Map([...input.tasks, ...(input.overdueTasks ?? [])].map(task => [task.id, task]));
  const used = new Set(all.map(item => item.id));
  for (const task of legacy) {
    if (used.has(task.id) || task.status === "blocked" || task.hold) continue;
    used.add(task.id);
    all.push({ kind: "task", reminderKind: "task", id: task.id, label: task.title, itemVersion: `${taskKey(task.id, "task")}@${input.now}` });
  }
  const waiting = input.tasks.filter(task => !used.has(task.id) && !taskIsOverdue(task, input.now) && task.status !== "done" && !task.owned && !task.runsOn && (task.status === "blocked" || !!task.hold));
  const rank = (task: SeatTickTaskInput) => task.hold?.until && Date.parse(task.hold.until) <= input.now ? 0 : !taskHasBlocker(task, input.now) ? 1 : 2;
  waiting.sort((a, b) => rank(a) - rank(b) || Date.parse(a.hold?.since ?? a.waitingSince ?? a.updatedAt ?? "") - Date.parse(b.hold?.since ?? b.waitingSince ?? b.updatedAt ?? "") || a.id.localeCompare(b.id));
  for (const task of waiting) all.push({ kind: "task", reminderKind: "waiting", id: task.id, label: task.title, itemVersion: `${taskKey(task.id, "waiting")}@${input.now}` });
  const knownOverdue = [...tasks.values()].filter(task => taskIsOverdue(task, input.now));
  if (!all.length && !knownOverdue.length) return undefined;
  const shown = new Set((input.state.itemsShown ?? []).filter(version => recentReminderVersion(version, input.now)).map(version => version.split("@")[0]));
  const lastShown = new Map((input.state.itemsShown ?? []).map(version => [version.split("@")[0]!, Number(version.split("@")[1])]));
  const owedAt = (item: SeatTickItem) => {
    const task = tasks.get(item.id)!;
    const since = Date.parse(task.waitingSince ?? task.updatedAt ?? "") || 0;
    const stamp = lastShown.get(item.itemVersion!.split("@")[0]!);
    return stamp !== undefined && Number.isFinite(stamp) ? Math.max(since, stamp + SEAT_REMINDER_REPEAT_MS) : since;
  };
  const rowClass = (item: SeatTickItem) => item.reminderKind === "overdue" ? 0 : item.reminderKind === "task" ? 1 : 2;
  const due = all.filter(item => !shown.has(item.itemVersion!.split("@")[0])).sort((a, b) =>
    rowClass(a) - rowClass(b) || (a.reminderKind === "task" ? owedAt(a) - owedAt(b) || a.id.localeCompare(b.id) : 0));
  const counts = (kind: SeatTickItem["reminderKind"]) => all.filter(item => item.reminderKind === kind).length;
  const rows: SeatTickTaskPage["rows"] = [];
  let length = 0;
  for (const item of due) {
    const task = tasks.get(item.id)!;
    const hold = task.hold;
    const since = Date.parse(hold?.since ?? task.waitingSince ?? task.updatedAt ?? "");
    const holdText = !hold ? "none" : `${hold.until && Date.parse(hold.until) <= input.now ? `lapsed ${hold.until.slice(0, 10)} ` : ""}${hold.kind} by ${hold.by}${hold.until ? ` until ${hold.until.slice(0, 10)}` : hold.since ? ` since ${hold.since.slice(0, 10)}` : ""}: ${singleLine(hold.note, 90)}`;
    const meta = item.reminderKind === "overdue"
      ? `overdue ${age(input.now - Date.parse(task.dueAt!))} | ${task.priority ?? "normal"} · moved ${task.dueHistory?.slips ?? 0}× · ${task.owned ? "lane running" : "no lane"}`
      : `${item.reminderKind === "waiting" ? "waiting" : "unstarted"} ${Number.isFinite(since) ? age(input.now - since) : "age unknown"}`;
    const line = `- ${task.id} | ${meta} | due ${task.dueAt?.slice(0, 10) ?? "none"} | hold: ${holdText} | ${singleLine(task.title, 70)}`;
    if (rows.length === 10 || length + line.length + 1 > 1500) break; // 300 reserved for counts and the read command
    rows.push({ item, line });
    length += line.length + 1;
  }
  const namedOverdue = knownOverdue.filter(task => shown.has(overdueReminderKey(task.id, task.dueAt!))).length;
  const other = all.filter(item => item.reminderKind !== "overdue");
  const namedOther = other.filter(item => shown.has(item.itemVersion!.split("@")[0])).length;
  const named = namedOverdue + namedOther;
  const pending = knownOverdue.length + other.length - named;
  const header = `Tasks: overdue ${knownOverdue.length}${(input.overdueTasks?.length ?? 0) >= 51 ? "+" : ""}, unstarted ${counts("task")}, waiting ${counts("waiting")}. This page: ${rows.length}. Not yet named in the last 24 h: ${Math.max(0, pending - rows.length)} more, on later wakes. Named in the last 24 h: ${named}. get_task <id> reads a task in full.`;
  return { lines: [header, ...rows.map(row => row.line)], rows, due: due.length };
}
