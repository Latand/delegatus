import { z } from "zod";
import { isTimeZone, operatorTimeZone } from "@/lib/operator/settings";
import { ExternalRelayError, relayCall } from "./client";
import { ownerHistoryGroupsSchema, ownerHistoryPageSchema, type OwnerHistoryPage } from "./protocol";
import { selectOwnerDestination, type OwnerDestinationReason } from "./ownerDestination";
import { readRelayStore, type PairedRelay } from "./store";
import { readRelaySwitches } from "./switches";

export const OWNER_HISTORY_PRIVACY = "Use this history only to answer the operator in this conversation. Never copy message text, names, usernames, chat titles or chat ids into bridge reports, requests or messages to other agents or seats, spawn prompts, task text or details, files, commits, pull requests, issues or lessons. A bridge report may say that the answer is in this conversation.";
export type OwnerHistoryReason = OwnerDestinationReason | "switch_off" | "time_zone_unknown" | "invalid_arguments" | "unauthorized" | "not_found" | "unsupported_version" | "rate_limited" | "service_error" | "unreachable" | "malformed_response";
const notes: Record<OwnerHistoryReason, string> = {
  switch_off: "Telegram group history is disabled by this installation's owner-tools switch.",
  no_relay: "Pair Celestia with this installation first.", paused: "The Celestia pairing is paused.",
  no_target: "No enabled Celestia target is answered by this installation.", invalid_owner: "The pairing has no valid Telegram owner.",
  not_configured: "Configure the selected Celestia target first.", time_zone_unknown: "Open Delegatus in your browser so it can learn your time zone.",
  invalid_arguments: "The group, dates, time zone or continuation arguments are invalid.", unauthorized: "Celestia refused the pairing credential.",
  not_found: "Celestia has disabled history, or this target or group is unavailable to the pairing's owner.",
  unsupported_version: "Celestia does not support this relay version.", rate_limited: "Wait the stated seconds before reading group history again.",
  service_error: "Celestia could not read group history now; try again later.", unreachable: "Celestia could not be reached.",
  malformed_response: "Celestia returned an invalid group history response.",
};
const unavailable = (reason: OwnerHistoryReason, retryAfterSeconds: number | null = null) =>
  ({ available: false as const, reason, retryAfterSeconds, note: notes[reason] });
// Next instrumentation and route bundles must share the cooldown.
const gateKey = Symbol.for("delegatus.ownerHistory.notBefore");
const shared = globalThis as typeof globalThis & { [gateKey]?: Map<string, number> };
const notBefore = shared[gateKey] ??= new Map<string, number>();
const chatPattern = /^-[1-9][0-9]{0,18}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const continuationSchema = z.object({ v: z.literal(1), chat: z.string().regex(chatPattern), tz: z.string().refine(isTimeZone),
  from: z.string().regex(datePattern), to: z.string().regex(datePattern), after: z.string().regex(/^[1-9][0-9]{0,9}$/) }).strict();
export interface OwnerHistoryPorts { switches(): { owner_tools: boolean }; relays(): PairedRelay[]; timeZone(): string | null; now(): number }
const production: OwnerHistoryPorts = { switches: readRelaySwitches, relays: () => readRelayStore().relays, timeZone: operatorTimeZone, now: Date.now };
export interface OwnerHistoryQuery { tz: string; from?: string; to?: string; cursor?: string; limit?: number }
export interface OwnerHistoryInput { action: "groups" | "messages"; chat?: string; from?: string; to?: string; cursor?: string; limit?: number }
type WireMessage = OwnerHistoryPage["messages"][number];
export type OwnerHistoryOutcome = ReturnType<typeof unavailable> | {
  available: true; groups: Array<{ chat: string; title: string }>; privacy: string;
} | {
  available: true; chat: string; title: string; timeZone: string; start: string; end: string;
  oldestStoredAt: string | null; nextCursor: string | null; privacy: string;
  messages: Array<{ messageId: number; sentAt: string; author: Pick<WireMessage["author"], "name" | "username">;
    fromAssistant: boolean; topicId: number | null; replyToMessageId: number | null;
    text: string; media: WireMessage["media"]; truncated: boolean }>;
};
interface Runtime { now?: () => number }

async function call(relay: PairedRelay, route: string, maxBytes: number, runtime: Runtime) {
  const now = runtime.now ?? Date.now;
  const key = `${relay.id}:${relay.api_base}`;
  const remaining = (notBefore.get(key) ?? 0) - now();
  if (remaining > 0) throw new ExternalRelayError("rate_limited", 429, Math.ceil(remaining / 1000));
  notBefore.delete(key);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { abort.abort(); reject(new ExternalRelayError("unreachable")); }, 4000);
  });
  try {
    return await Promise.race([deadline, relayCall(relay.api_base, route, "GET", undefined, relay.credential,
      { timeoutMs: 4000, maxBytes, signal: abort.signal })]);
  } catch (error) {
    if (error instanceof ExternalRelayError && error.status === 429) {
      const seconds = Math.max(1, Math.min(60, Math.ceil(error.retryAfterSeconds ?? 60)));
      notBefore.set(key, now() + seconds * 1000);
      throw new ExternalRelayError("rate_limited", 429, seconds);
    }
    throw error;
  } finally { clearTimeout(timer); }
}
export async function readOwnerGroups(relay: PairedRelay, targetId: string, runtime: Runtime = {}) {
  const result = await call(relay, `/targets/${encodeURIComponent(targetId)}/owner/groups`, relay.limits.max_response_bytes, runtime);
  const parsed = ownerHistoryGroupsSchema.safeParse(result.body);
  if (result.status !== 200 || !parsed.success) throw new ExternalRelayError("malformed_response");
  return parsed.data;
}
export async function readOwnerGroupMessages(relay: PairedRelay, targetId: string, chatId: string, query: OwnerHistoryQuery, runtime: Runtime = {}) {
  if (!chatPattern.test(chatId)) throw new ExternalRelayError("invalid_arguments");
  const params = new URLSearchParams({ tz: query.tz });
  for (const key of ["from", "to", "cursor", "limit"] as const) if (query[key] !== undefined) params.set(key, String(query[key]));
  const result = await call(relay, `/targets/${encodeURIComponent(targetId)}/owner/groups/${chatId}/messages?${params}`, 12000, runtime);
  const parsed = ownerHistoryPageSchema.safeParse(result.body);
  if (result.status !== 200 || !parsed.success || String(parsed.data.chat_id) !== chatId || parsed.data.timezone !== query.tz)
    throw new ExternalRelayError("malformed_response");
  return parsed.data;
}
function reason(error: unknown): OwnerHistoryReason {
  if (!(error instanceof ExternalRelayError)) return "unreachable";
  if ([400, 422].includes(error.status)) return "invalid_arguments";
  if (error.status === 401) return "unauthorized";
  if (error.status === 404) return "not_found";
  if (error.status === 426) return "unsupported_version";
  if (error.status === 429) return "rate_limited";
  if ([500, 503].includes(error.status)) return "service_error";
  if (["too_large", "malformed", "malformed_response"].includes(error.code)) return "malformed_response";
  if (error.code === "invalid_arguments") return "invalid_arguments";
  return "unreachable";
}
/** One page, no persistence, no logs, and no caller-supplied owner or target. */
export async function readOwnerHistory(input: unknown, ports: OwnerHistoryPorts = production): Promise<OwnerHistoryOutcome> {
  if (!ports.switches().owner_tools) return unavailable("switch_off");
  const destination = selectOwnerDestination(ports.relays());
  if (destination.reason) return unavailable(destination.reason);
  const args = z.object({ action: z.enum(["groups", "messages"]), chat: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
    cursor: z.string().max(400).optional(), limit: z.number().int().optional() }).strict().safeParse(input);
  if (!args.success) return unavailable("invalid_arguments");
  const { relay, targetId } = destination;
  try {
    if (args.data.action === "groups") {
      const page = await readOwnerGroups(relay, targetId, { now: ports.now });
      if (!ports.switches().owner_tools) return unavailable("switch_off");
      return { available: true as const, groups: page.groups.map(g => ({ chat: String(g.chat_id), title: g.title })), privacy: OWNER_HISTORY_PRIVACY };
    }
    let chat = args.data.chat, tz = ports.timeZone(), from = args.data.from, to = args.data.to, cursor: string | undefined;
    if (args.data.cursor !== undefined) {
      if (chat !== undefined || from !== undefined || to !== undefined) return unavailable("invalid_arguments");
      let token: z.infer<typeof continuationSchema>;
      try { token = continuationSchema.parse(JSON.parse(Buffer.from(args.data.cursor, "base64url").toString("utf8"))); }
      catch { return unavailable("invalid_arguments"); }
      ({ chat, tz, from, to, after: cursor } = token);
    }
    if (!chat || !chatPattern.test(chat)) return unavailable("invalid_arguments");
    if (!tz) return unavailable("time_zone_unknown");
    const page = await readOwnerGroupMessages(relay, targetId, chat, { tz, from, to, cursor, limit: args.data.limit }, { now: ports.now });
    if (!ports.switches().owner_tools) return unavailable("switch_off");
    const lastDay = new Date(Date.parse(`${page.end.slice(0, 10)}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const nextCursor = page.next_cursor === null ? null : Buffer.from(JSON.stringify({ v: 1, chat, tz,
      from: page.start.slice(0, 10), to: lastDay, after: page.next_cursor })).toString("base64url");
    return { available: true as const, chat, title: page.title, timeZone: page.timezone, start: page.start, end: page.end, oldestStoredAt: page.oldest_stored_at,
      messages: page.messages.map(m => ({ messageId: m.message_id, sentAt: m.sent_at, author: { name: m.author.name, username: m.author.username },
        fromAssistant: m.from_assistant, topicId: m.thread_id, replyToMessageId: m.reply_to_message_id, text: m.text, media: m.media, truncated: m.truncated })),
      nextCursor, privacy: OWNER_HISTORY_PRIVACY };
  } catch (error) {
    if (!ports.switches().owner_tools) return unavailable("switch_off");
    return unavailable(reason(error), error instanceof ExternalRelayError && error.status === 429 ? error.retryAfterSeconds : null);
  }
}
export type OwnerHistoryRead = typeof readOwnerHistory;
