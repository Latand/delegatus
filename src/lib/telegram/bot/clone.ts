import { cloneDirectory, type CloneRoute, type DiscoveredCloneChat } from "@/lib/externalRelay/cloneDirectory";
import { cloneClientKey, clonePayloadSupported, sendAsClone, type CloneSendInput, type CloneSendOptions, type CloneSendResult } from "@/lib/externalRelay/cloneSend";
import type { TelegramChatBot } from "./contracts";
import { TelegramBotError } from "./errors";
import type { BotTransport } from "./transport";
import { cloneMethodPayload, cloneMultipart } from "@/lib/externalRelay/cloneMethods";

export interface ClonePostingPort {
  discoverChats?(): Promise<DiscoveredCloneChat[]>;
  route(chatId: string): Promise<CloneRoute | null>;
  peek(chatId: string): CloneRoute | null;
  valid(route: CloneRoute, chatId: string): boolean;
  invalidate(route: CloneRoute, kind: "stale" | "unsupported"): void;
  send(route: CloneRoute, input: CloneSendInput, options: CloneSendOptions): Promise<CloneSendResult>;
}
export const productionClonePosting: ClonePostingPort = {
  discoverChats: () => cloneDirectory().discoverChats(),
  route: chat => cloneDirectory().route(chat), peek: chat => cloneDirectory().peek(chat),
  valid: (route, chat) => cloneDirectory().valid(route, chat), invalidate: (route, kind) => cloneDirectory().invalidate(route, kind),
  send: (route, input, options) => sendAsClone(route.relay, route.targetId, input, options),
};
export function cloneChatView(route: CloneRoute): TelegramChatBot {
  if (route.methodsFeature) {
    const rights = route.send?.rights;
    const member = rights ? !["left", "kicked"].includes(rights.status) : true;
    return { name: route.name, username: null, assigned: false, member, status: rights?.status ?? null,
      canPost: rights?.can_send_messages ?? (route.send?.limits.methods.includes("sendMessage") ? true : null), canSendPhotos: rights?.can_send_photos ?? null,
      canSendDocuments: rights?.can_send_documents ?? null, canManageTopics: false,
      reason: member === false ? "bot_not_in_chat" : rights?.can_send_messages === false ? "not_enough_rights" : null,
      checkedAt: rights?.read_at ?? null };
  }
  return { name: route.name, username: null, assigned: false, member: true, status: null, canPost: true,
    canSendPhotos: false, canSendDocuments: false, canManageTopics: false, reason: null, checkedAt: null };
}
export function cloneInput(route: CloneRoute, caller: string, key: string, params: Record<string, unknown>, part: number): CloneSendInput {
  const reply = (params.reply_parameters as { message_id?: number } | undefined)?.message_id;
  return { client_key: cloneClientKey(route.relay.id, caller, key, part), chat_id: Number(params.chat_id), text: String(params.text ?? ""),
    parse_mode: params.parse_mode === "HTML" ? "HTML" : null, silent: params.disable_notification === true,
    ...(reply ? { reply_to_message_id: reply } : {}), ...(params.message_thread_id ? { message_thread_id: Number(params.message_thread_id) } : {}) };
}
export { clonePayloadSupported };
export function cloneSupports(route: CloneRoute, caller: string, key: string, method: string, params: Record<string, unknown>, part: number): boolean {
  const input = cloneInput(route, caller, key, params, part);
  return route.methodsFeature ? !!route.send && !!cloneMethodPayload(method, params, input, route.send.limits, route.send.rights)
    : method === "sendMessage" && clonePayloadSupported(input);
}
export function cloneTransport(port: ClonePostingPort, route: CloneRoute, caller: string, key: string, authorize: () => Promise<void>,
  persistKey?: (input: CloneSendInput, part: number) => Promise<void>): BotTransport {
  return { call: async <T,>(method: string, params: Record<string, unknown>, options?: Parameters<BotTransport["call"]>[2]) => {
    if (!route.methodsFeature && method !== "sendMessage") throw new TelegramBotError("bad_request", "this clone sends group text only");
    const common = cloneInput(route, caller, key, params, options?.partIndex ?? 0);
    const payload = route.methodsFeature && route.send ? cloneMethodPayload(method, params, common, route.send.limits, route.send.rights) : null;
    if (route.methodsFeature) {
      if (!payload) throw new TelegramBotError("bad_request", "clone method, limits or rights changed");
      const upload = payload.files.length ? cloneMultipart(payload) : null;
      if (upload && upload.byteLength > route.send!.limits.max_body_bytes) return {
        ok: false, kind: "http", status: null, description: null, migrateToChatId: null, retryAfterSeconds: null,
        classified: { code: "document_too_large", fallback: true } };
      for (const file of payload.files) {
        const maxPixels = route.send!.limits.files[file.kind]?.max_pixels;
        if (maxPixels) {
          const sharp = (await import("sharp")).default;
          let pixels = Infinity;
          try { const metadata = await sharp(Buffer.from(await file.blob.arrayBuffer())).metadata(); pixels = (metadata.width ?? Infinity) * (metadata.height ?? Infinity); } catch { /* Refuse unreadable dimensions. */ }
          if (pixels > maxPixels) return { ok: false, kind: "http", status: null, description: null, migrateToChatId: null, retryAfterSeconds: null,
            classified: { code: "photo_invalid", fallback: true } };
        }
      }
    }
    const input = payload?.input ?? common;
    await persistKey?.(common, options?.partIndex ?? 0);
    const result = await port.send(route, common, { signal: options?.signal, partIndex: options?.partIndex ?? 0,
      ...(payload ? { payload } : {}),
      beforeSend: async () => {
        await authorize();
        if (!port.valid(route, String(params.chat_id))) throw new TelegramBotError("chat_not_allowed", "clone coverage changed");
      } });
    if (result.kind === "sent") {
      const messages = (result.messageIds ?? [result.messageId]).map(message_id => ({ message_id, date: result.sentAt,
        chat: { id: input.chat_id }, ...(input.message_thread_id ? { message_thread_id: input.message_thread_id } : {}) }));
      return { ok: true as const, result: (method === "sendMediaGroup" ? messages : messages[0]) as T };
    }
    if (result.kind === "refused" && result.invalidate) port.invalidate(route, result.invalidate);
    return { ok: false as const, kind: result.kind === "uncertain" ? "network_failed" as const : "http" as const,
      status: null, description: null, migrateToChatId: null,
      retryAfterSeconds: result.kind === "refused" ? result.retryAfterSeconds ?? null : null,
      classified: { code: result.kind === "uncertain" ? "send_uncertain" as const : result.code,
        fallback: result.kind === "refused" && result.fallback } };
  } };
}
