import { createHash } from "node:crypto";
import { z } from "zod";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { waitForStateLock } from "@/lib/state/lockWait";
import type { TelegramBotErrorCode } from "@/lib/telegram/bot/contracts";
import { ExternalRelayError, relayCall } from "./client";
import { recordSentRelayReference } from "./publishedReferences";
import type { PairedRelay } from "./store";
import { cloneMultipart, type CloneMethodPayload } from "./cloneMethods";

export const cloneClientKey = (relayId: string, caller: string, request: string, part: number) =>
  "ck_" + createHash("sha256").update(JSON.stringify(["delegatus-clone-send-v1", relayId, caller, request, part])).digest("base64url").slice(0, 40);
export interface CloneMethodInput {
  [key: string]: unknown;
  client_key: string; chat_id: number; text?: string; parse_mode?: "HTML" | null; method?: string;
  reply_to_message_id?: number; message_thread_id?: number; silent: boolean;
}
/** Legacy text producers keep their existing required fields. */
export interface CloneSendInput extends CloneMethodInput { text: string; parse_mode: "HTML" | null }
export type CloneSendResult = { kind: "sent"; messageId: number; messageIds?: number[]; messageKey: string; sentAt: number; replayed: boolean }
  | { kind: "refused"; code: TelegramBotErrorCode; fallback: boolean; retryAfterSeconds?: number; invalidate?: "stale" | "unsupported" }
  | { kind: "uncertain"; cause?: "send_uncertain" | "idempotency_conflict" };
const receipt = z.object({ message_id: z.number().int().positive(), message_key: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  message_ids: z.array(z.number().int().positive()).min(1).max(10).optional(),
  sent_at: z.string().datetime({ offset: true }), replayed: z.boolean() });
export function clonePayloadSupported(input: CloneSendInput): boolean {
  return typeof input.text === "string" && !!input.text.trim() && [...input.text].length <= 16384 && (input.parse_mode === "HTML" || input.text.length <= 4096)
    && Buffer.byteLength(JSON.stringify(input)) <= 65536;
}
const unused: Record<number, TelegramBotErrorCode> = { 400: "bad_request", 401: "chat_not_allowed", 403: "chat_not_allowed",
  404: "bot_not_in_chat", 413: "bad_request", 422: "bad_request", 426: "telegram_failed", 503: "telegram_failed" };
/** Only a documented unused-key response permits a second transport. */
export function classifyCloneFailure(error: unknown, methods = false): CloneSendResult | null {
  if (error instanceof ExternalRelayError) {
    const payload = error.payload as { error?: { key_state?: unknown } } | undefined;
    const state = payload?.error?.key_state;
    if (state === "uncertain" || state === "taken") return { kind: "uncertain", cause: state === "taken" ? "idempotency_conflict" : "send_uncertain" };
    if (state === "pending") return { kind: "uncertain" };
    if (state !== undefined && state !== "unused" || methods && state !== "unused") return null;
    if (state === "unused") {
      const code: TelegramBotErrorCode = error.code === "not_enough_rights" ? "not_enough_rights"
        : error.code === "unsupported_media_type" ? "document_type" : error.code === "too_large" ? "document_too_large"
        : error.code === "rate_limited" ? "rate_limited"
        : ["format_invalid", "text_too_long"].includes(error.code) ? error.code as TelegramBotErrorCode
        : error.code === "clone_inactive" || error.code === "clone_not_in_chat" ? "bot_not_in_chat" : unused[error.status] ?? "telegram_failed";
      return { kind: "refused", code, fallback: code !== "rate_limited",
        ...(code === "rate_limited" ? { retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterSeconds ?? 1)) } : {}),
        ...(["clone_inactive", "clone_not_in_chat", "not_enough_rights"].includes(error.code) ? { invalidate: "stale" as const } : {}) };
    }
  }
  if (methods) return null;
  if (!(error instanceof ExternalRelayError)) {
    return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ConnectionRefused"].includes(String((error as NodeJS.ErrnoException)?.code))
      ? { kind: "refused", code: "network_failed", fallback: true } : null;
  }
  if (error.status === 429) return { kind: "refused", code: "rate_limited", fallback: false,
    retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterSeconds ?? 1)) };
  if (error.status === 409 && ["send_uncertain", "idempotency_conflict"].includes(error.code)) return { kind: "uncertain", cause: error.code as "send_uncertain" | "idempotency_conflict" };
  const code = error.status === 409 && ["clone_inactive", "clone_not_in_chat"].includes(error.code) ? "bot_not_in_chat"
    : unused[error.status];
  if (!code) return error.code === "dns_error" ? { kind: "refused", code: "network_failed", fallback: true } : null;
  return { kind: "refused", code: error.status === 400 && ["format_invalid", "text_too_long"].includes(error.code)
    ? error.code as TelegramBotErrorCode : code, fallback: true,
    ...([401, 403, 404].includes(error.status) || error.status === 409 ? { invalidate: "stale" as const } : {}),
    ...(error.status === 426 ? { invalidate: "unsupported" as const } : {}) };
}
export interface CloneSendOptions {
  deadline?: number; signal?: AbortSignal; beforeSend?: () => void | Promise<void>;
  partIndex?: number;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
  payload?: CloneMethodPayload;
}
export async function sendAsClone(relay: PairedRelay, targetId: string, legacyInput: CloneSendInput, options: CloneSendOptions = {}): Promise<CloneSendResult> {
  const input = options.payload?.input ?? legacyInput;
  const upload = options.payload?.files.length ? cloneMultipart(options.payload) : undefined;
  const attemptMs = upload ? 125000 + Math.ceil(upload.byteLength / 700000) * 1000 : 20000;
  const budget = upload ? attemptMs * 2 : 25000;
  const now = options.now ?? Date.now, start = now(), deadline = Math.min(options.deadline ?? start + budget, start + budget);
  if (!options.payload && !clonePayloadSupported(legacyInput)) return { kind: "refused", code: "text_too_long", fallback: true };
  return withViewerOperation("external-relay.clone-send", async () => {
    let outcome: CloneSendResult = { kind: "uncertain" }, status: number | null = null;
    let unresolvedAttempt = false;
    try {
      while (now() < deadline && !options.signal?.aborted) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(attemptMs, deadline - now()));
        const abort = () => controller.abort();
        options.signal?.addEventListener("abort", abort, { once: true });
        let delay = 100;
        let authorityRefused = false;
        try {
          const answer = await relayCall(relay.api_base, `/targets/${encodeURIComponent(targetId)}/send`, "POST", input, relay.credential,
            { timeoutMs: 0, signal: controller.signal, maxBytes: 65536, detailedErrors: true, ...(upload ? { upload } : {}),
              beforeSend: async () => { try { await options.beforeSend?.(); } catch { authorityRefused = true; throw new Error("send authority changed"); } },
              onResponseStatus: value => { status = value; } });
          const parsed = receipt.safeParse(answer.body);
          if (answer.status !== 200 || !parsed.success || now() >= deadline) break;
          const data = parsed.data;
          if (data.message_ids && (data.message_ids[0] !== data.message_id || new Set(data.message_ids).size !== data.message_ids.length)) break;
          if (input.method === "sendMediaGroup" && (!data.message_ids || !Array.isArray(input.media) || data.message_ids.length !== input.media.length)) break;
          if (input.method && input.method !== "sendMediaGroup" && data.message_ids && data.message_ids.length !== 1) break;
          await waitForStateLock("relay.clone-send-reference", () => recordSentRelayReference(relay.api_base, targetId,
            { messageKey: data.message_key, chatId: String(input.chat_id), messageId: data.message_id, topicId: input.message_thread_id ?? null }),
          { waitMs: Math.max(0, Math.min(5000, deadline - now())) });
          outcome = { kind: "sent", messageId: data.message_id, ...(data.message_ids ? { messageIds: data.message_ids } : {}), messageKey: data.message_key,
            sentAt: Math.floor(Date.parse(data.sent_at) / 1000), replayed: data.replayed };
          break;
        } catch (error) {
          if (authorityRefused) {
            outcome = unresolvedAttempt ? { kind: "uncertain" } : { kind: "refused", code: "chat_not_allowed", fallback: true };
            break;
          }
          // No exception text, body or arbitrary relay code leaves this boundary.
          const classified = classifyCloneFailure(error, !!options.payload);
          const provenUnused = error instanceof ExternalRelayError && (error.payload as { error?: { key_state?: unknown } } | undefined)?.error?.key_state === "unused";
          if (classified) { outcome = unresolvedAttempt && !provenUnused && classified.kind !== "uncertain" ? { kind: "uncertain" } : classified; break; }
          unresolvedAttempt = true;
          if (error instanceof ExternalRelayError && error.status === 409 && error.code === "send_in_progress")
            delay = Math.max(100, Math.ceil((error.retryAfterSeconds ?? 1) * 1000));
          // Unknown 4xx responses have no unused-key guarantee.
          else if (error instanceof ExternalRelayError && error.status >= 300 && error.status < 500) break;
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        }
        if (now() + delay >= deadline || options.signal?.aborted) break;
        await (options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(delay);
      }
      return outcome;
    } finally {
      console.info(`[relay clone-send] ${JSON.stringify({ outcome: outcome.kind, code: outcome.kind === "refused" ? outcome.code : null,
        status, elapsedMs: Math.max(0, now() - start), partIndex: options.partIndex ?? 0 })}`);
    }
  });
}
