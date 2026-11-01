import type { ToolProperty } from "./readSchemas";
import type { CompanionToolContext } from "./tools";
import { withoutCredentials, withoutLocalPaths } from "./redaction";
import { minutesLeft, minutesLeftText, namedClockText } from "./timerTime";
import { MAX_PENDING_TIMERS, MAX_TIMER_MINUTES, MIN_TIMER_MINUTES, TIMER_LABEL_CHARS, timerDeliveredBy, timerLabelIn, type VoiceTimer, type VoiceTimerCalls } from "./voiceTimers";
import type { SessionStarter } from "./storage";

export interface TimerToolContext { calls: VoiceTimerCalls; owner: SessionStarter; private: boolean }

/** Bounds a model can overstep are answered with the nearest value (the handler says so), so the schema carries none. */
export const TIMER_TOOL_SCHEMA: Record<string, ToolProperty> = {
  action: { type: "string", enum: ["set", "list", "cancel"] },
  minutes: { type: ["number", "null"], description: `set: the duration in minutes, from ${MIN_TIMER_MINUTES} to ${MAX_TIMER_MINUTES}. Null otherwise.` },
  label: { type: ["string", "null"], maxLength: 400, description: "set: the operator's own word for this timer; null when they named nothing." },
  timer: { type: ["string", "null"], maxLength: 400, description: "cancel: a handle from set or list, or the label's words. Null otherwise." },
};

const named = (row: VoiceTimer, sessionId: string) => {
  const label = timerLabelIn(row, sessionId);
  return label ? `«${label}»` : `the ${row.minutes}-minute timer`;
};
/** A timer as the backend reads it: the handle to act on, the words to say and the ISO times later tools may localise. */
const rowFacts = (row: VoiceTimer, sessionId: string, now: number) => ({ timer: row.id, label: timerLabelIn(row, sessionId), minutes: row.minutes,
  createdAt: new Date(row.createdAt).toISOString(), dueAt: new Date(row.dueAt).toISOString(), at: namedClockText(row.dueAt, row.timeZone), minutesLeft: minutesLeft(row.dueAt - now) });
const runningLine = (row: VoiceTimer, sessionId: string, now: number) => `${named(row, sessionId)} ${minutesLeftText(row.dueAt - now)}, at ${namedClockText(row.dueAt, row.timeZone)}`;
const runningCount = (count: number) => count === 0 ? "No timer is running." : count === 1 ? "One timer is running." : `${count} timers are running.`;
/** The operator's words as a label: no control characters, secrets or paths, and at most the label's length. */
function cleanLabel(value: unknown, secrets: readonly string[]): { label: string | null; shortened: boolean } {
  if (typeof value !== "string") return { label: null, shortened: false };
  const words = [...withoutLocalPaths(withoutCredentials(value, secrets)).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim()];
  return { label: words.slice(0, TIMER_LABEL_CHARS).join("").trim() || null, shortened: words.length > TIMER_LABEL_CHARS };
}

export async function runTimerTool(context: CompanionToolContext, args: Record<string, unknown>): Promise<unknown> {
  const timers = context.timers;
  if (!timers) return { status: "refused", code: "timers_unavailable", speech: "Timers are not available in this call. Say so in one short sentence." };
  const sessionId = context.sessionId;
  if (args.action === "set") {
    if (typeof args.minutes !== "number") return { status: "refused", code: "minutes_required", speech: "No timer was set: no duration was given. Ask the operator how long." };
    const minutes = Math.min(MAX_TIMER_MINUTES, Math.max(MIN_TIMER_MINUTES, args.minutes));
    const { label, shortened } = cleanLabel(args.label, context.secrets ?? []);
    const outcome = await timers.calls.set({ owner: timers.owner, sessionId, callId: context.callId, delegationId: context.delegationId, attempt: context.attempt?.sourceItemId,
      minutes, label, locale: context.admission.session(sessionId).locale, private: timers.private });
    if (outcome.state === "limit") return { status: "refused", code: "timer_limit", running: outcome.running.length,
      speech: `No timer was set: ${outcome.running.length} timers are already running, and ${MAX_PENDING_TIMERS} is the limit. Say so, and offer to cancel one.` };
    const row = outcome.timer;
    const notes = [...(minutes !== args.minutes ? [`It was asked for ${args.minutes} minutes; a timer runs from ${MIN_TIMER_MINUTES} to ${MAX_TIMER_MINUTES} minutes, so it is set for ${minutes}. Say so.`] : []),
      ...(shortened ? [`The label was shortened to ${TIMER_LABEL_CHARS} characters.`] : [])];
    return { status: outcome.state === "set" ? "set" : "already_set", ...rowFacts(row, sessionId, row.createdAt), running: outcome.running.length,
      speech: [`${outcome.state === "set" ? "" : "This timer was already set. "}${row.label ? `Timer «${row.label}» set for ${minutes} minutes` : `A ${minutes}-minute timer is set`}, until ${namedClockText(row.dueAt, row.timeZone)}.`, runningCount(outcome.running.length), ...notes].join(" ") };
  }
  if (args.action === "list") {
    const { running, recent, now } = await timers.calls.list(timers.owner);
    const earlier = recent.map(row => ({ ...rowFacts(row, sessionId, now), state: row.state, firedAt: new Date(row.firedAt!).toISOString(), firedClock: namedClockText(row.firedAt!, row.timeZone), deliveredBy: timerDeliveredBy(row) }));
    return { status: "ok", running: running.map(row => rowFacts(row, sessionId, now)), recent: earlier,
      speech: `${running.length ? `${runningCount(running.length)} ${running.map(row => runningLine(row, sessionId, now)).join("; ")}.` : "No timer is running."}${earlier.length ? ` ${earlier.length} fired in the last hour; say them only when asked.` : ""}` };
  }
  if (typeof args.timer !== "string" || !args.timer.trim()) return { status: "refused", code: "timer_required", speech: "Nothing was cancelled: no timer was named. Ask which one." };
  const outcome = await timers.calls.cancel(timers.owner, sessionId, args.timer);
  if (outcome.state === "ambiguous") return { status: "ambiguous", matches: outcome.matches.map(row => rowFacts(row, sessionId, row.createdAt)),
    speech: `Nothing was cancelled. ${outcome.matches.length} timers match: ${outcome.matches.map(row => `${named(row, sessionId)} at ${namedClockText(row.dueAt, row.timeZone)}`).join("; ")}. Ask which one, then call again with its handle.` };
  if (outcome.state === "not_found") return { status: "not_found", running: outcome.running.map(row => rowFacts(row, sessionId, row.createdAt)),
    speech: `Nothing was cancelled: no running timer matches. ${runningCount(outcome.running.length)}${outcome.running.length ? ` ${outcome.running.map(row => `${named(row, sessionId)} at ${namedClockText(row.dueAt, row.timeZone)}`).join("; ")}.` : ""}` };
  return { status: "cancelled", ...rowFacts(outcome.timer, sessionId, outcome.timer.createdAt), running: outcome.running.length,
    speech: `${timerLabelIn(outcome.timer, sessionId) ? `Timer ${named(outcome.timer, sessionId)}` : `The ${outcome.timer.minutes}-minute timer`} is cancelled. ${runningCount(outcome.running.length)}${outcome.running.length === 1 ? ` It is up at ${namedClockText(outcome.running[0]!.dueAt, outcome.running[0]!.timeZone)}.` : ""}` };
}
