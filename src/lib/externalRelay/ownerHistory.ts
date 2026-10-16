import { z } from "zod";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { withHistoryDeadline, type HistoryClock } from "./historyDeadline";
import { isTimeZone, operatorTimeZone } from "@/lib/operator/settings";
import { ExternalRelayError, relayCall } from "./client";
import { ownerHistoryGroupsSchema, ownerHistoryPageSchema, type OwnerHistoryPage } from "./protocol";
import { selectOwnerDestination, type OwnerDestinationReason } from "./ownerDestination";
import { readRelayStore, type PairedRelay } from "./store";
import { readRelaySwitches } from "./switches";

export const OWNER_HISTORY_PRIVACY = "Use this history only to answer the operator in this conversation. Never copy message text, names, usernames, chat titles or chat ids into bridge reports, requests or messages to other agents or seats, spawn prompts, task text or details, files, commits, pull requests, issues or lessons. A bridge report may say that the answer is in this conversation.";
export type OwnerHistoryReason = OwnerDestinationReason | "switch_off" | "time_zone_unknown" | "invalid_arguments" | "unauthorized" | "not_found" | "unsupported_version" | "rate_limited" | "service_error" | "malformed_response" | "deadline_exceeded" | "deadline_loop_stalled" | "dns_error" | "connect_error" | "tls_error" | "transport_error" | "response_too_large" | "forbidden" | "request_timeout" | "bad_gateway" | "gateway_timeout" | "http_error";
const notes: Record<OwnerHistoryReason, string> = {
  switch_off: "Telegram group history is disabled by this installation's owner-tools switch.",
  no_relay: "Pair Celestia with this installation first.", paused: "The Celestia pairing is paused.",
  no_target: "No enabled Celestia target is answered by this installation.", invalid_owner: "The pairing has no valid Telegram owner.",
  not_configured: "Configure the selected Celestia target first.", time_zone_unknown: "Open Delegatus in your browser so it can learn your time zone.",
  invalid_arguments: "The group, dates, time zone or continuation arguments are invalid.", unauthorized: "Celestia refused the pairing credential.",
  not_found: "Celestia has disabled history, or this target or group is unavailable to the pairing's owner.",
  unsupported_version: "Celestia does not support this relay version.", rate_limited: "Wait the stated seconds before reading group history again.",
  service_error: "Celestia could not read group history now; try again later.",
  deadline_exceeded: "The group history request exceeded its four-second deadline.",
  deadline_loop_stalled: "The group history deadline fired while the Delegatus event loop was stalled; the response could not be confirmed in time.",
  dns_error: "The Celestia address could not be resolved by DNS.",
  connect_error: "The connection to Celestia failed or was interrupted.",
  tls_error: "The secure connection to Celestia failed TLS verification or negotiation.",
  transport_error: "The group history request failed in the transport.",
  response_too_large: "Celestia returned group history larger than the allowed response size.",
  forbidden: "Celestia refused access to group history.",
  request_timeout: "Celestia timed out receiving the group history request.",
  bad_gateway: "The Celestia gateway returned an invalid upstream response.",
  gateway_timeout: "The Celestia gateway timed out waiting for group history.",
  http_error: "Celestia returned an HTTP error while reading group history.",
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
export interface OwnerHistoryPorts { switches(): { owner_tools: boolean }; relays(): PairedRelay[]; timeZone(): string | null; now(): number; clock?: HistoryClock }
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
interface Runtime { now?: () => number; clock?: HistoryClock }

async function call(relay: PairedRelay, route: string, maxBytes: number, runtime: Runtime, signal: AbortSignal, observeStatus: (status: number) => void) {
  const now = runtime.now ?? Date.now;
  const key = `${relay.id}:${relay.api_base}`;
  const remaining = (notBefore.get(key) ?? 0) - now();
  if (remaining > 0) throw new ExternalRelayError("rate_limited", 429, Math.ceil(remaining / 1000));
  notBefore.delete(key);
  try {
    // The total deadline owns cancellation; a socket-idle timer could win before
    // readable bytes are processed after a Viewer stall.
    return await relayCall(relay.api_base, route, "GET", undefined, relay.credential,
      { timeoutMs: 0, maxBytes, signal, detailedErrors: true, onResponseStatus: observeStatus });
  } catch (error) {
    if (error instanceof ExternalRelayError && error.status === 429) {
      const seconds = Math.max(1, Math.min(60, Math.ceil(error.retryAfterSeconds ?? 60)));
      notBefore.set(key, now() + seconds * 1000);
      throw new ExternalRelayError("rate_limited", 429, seconds);
    }
    throw error;
  }
}
async function historyAttempt<T>(kind: OwnerHistoryInput["action"], runtime: Runtime, work: (signal: AbortSignal, observeStatus: (status: number) => void) => Promise<T>) {
  return withViewerOperation("external-relay.owner-history", async () => {
    const metrics = { elapsedMs: 0, loopGapMs: 0 };
    let observedStatus: number | null = null;
    try { return await withHistoryDeadline(signal => work(signal, status => { observedStatus = status; }), metrics, runtime.clock); }
    catch (error) {
      // Allowlist only: error messages, payloads, routes and identifiers can all
      // carry private history or credentials, including on malformed responses.
      const status = error instanceof ExternalRelayError && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : observedStatus;
      console.warn(`[relay owner-history] ${JSON.stringify({ cause: reason(error), routeKind: kind, status,
        elapsedMs: Math.round(metrics.elapsedMs), loopGapMs: Math.round(metrics.loopGapMs) })}`);
      throw error;
    }
  });
}
export async function readOwnerGroups(relay: PairedRelay, targetId: string, runtime: Runtime = {}) {
  return historyAttempt("groups", runtime, async (signal, observeStatus) => {
    const result = await call(relay, `/targets/${encodeURIComponent(targetId)}/owner/groups`, relay.limits.max_response_bytes, runtime, signal, observeStatus);
    const parsed = ownerHistoryGroupsSchema.safeParse(result.body);
    if (result.status !== 200 || !parsed.success) throw new ExternalRelayError("malformed_response", result.status);
    return parsed.data;
  });
}
export async function readOwnerGroupMessages(relay: PairedRelay, targetId: string, chatId: string, query: OwnerHistoryQuery, runtime: Runtime = {}) {
  return historyAttempt("messages", runtime, async (signal, observeStatus) => {
    if (!chatPattern.test(chatId)) throw new ExternalRelayError("invalid_arguments");
    const params = new URLSearchParams({ tz: query.tz });
    for (const key of ["from", "to", "cursor", "limit"] as const) if (query[key] !== undefined) params.set(key, String(query[key]));
    const result = await call(relay, `/targets/${encodeURIComponent(targetId)}/owner/groups/${chatId}/messages?${params}`, 12000, runtime, signal, observeStatus);
    const parsed = ownerHistoryPageSchema.safeParse(result.body);
    if (result.status !== 200 || !parsed.success || String(parsed.data.chat_id) !== chatId || parsed.data.timezone !== query.tz)
      throw new ExternalRelayError("malformed_response", result.status);
    return parsed.data;
  });
}
function reason(error: unknown): OwnerHistoryReason {
  if (!(error instanceof ExternalRelayError)) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (typeof code === "string") {
      if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "dns_error";
      if (/TLS|SSL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return "tls_error";
      if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return "connect_error";
    }
    return "transport_error";
  }
  if ([400, 422].includes(error.status)) return "invalid_arguments";
  if (error.status === 403) return "forbidden";
  if (error.status === 401) return "unauthorized";
  if (error.status === 404) return "not_found";
  if (error.status === 426) return "unsupported_version";
  if (error.status === 429) return "rate_limited";
  if (error.status === 408) return "request_timeout";
  if (error.status === 502) return "bad_gateway";
  if (error.status === 504) return "gateway_timeout";
  if ([500, 503].includes(error.status)) return "service_error";
  if (error.status >= 300) return "http_error";
  if (error.code === "too_large") return "response_too_large";
  if (["malformed", "malformed_response"].includes(error.code)) return "malformed_response";
  if (error.code === "invalid_arguments") return "invalid_arguments";
  if (["deadline_exceeded", "deadline_loop_stalled", "dns_error"].includes(error.code)) return error.code as OwnerHistoryReason;
  if (error.code === "unreachable") return "connect_error";
  return "transport_error";
}
/** One page, no content persistence, and no caller-supplied owner or target. */
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
      const page = await readOwnerGroups(relay, targetId, { now: ports.now, clock: ports.clock });
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
    const page = await readOwnerGroupMessages(relay, targetId, chat, { tz, from, to, cursor, limit: args.data.limit }, { now: ports.now, clock: ports.clock });
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
    const outcome = unavailable(reason(error), error instanceof ExternalRelayError && error.status === 429 ? error.retryAfterSeconds : null);
    if (error instanceof ExternalRelayError && error.status >= 300) {
      outcome.note = outcome.reason === "http_error" ? `Celestia returned HTTP ${error.status} while reading group history.`
        : `${outcome.note} HTTP ${error.status}.`;
    }
    return outcome;
  }
}
export type OwnerHistoryRead = typeof readOwnerHistory;
