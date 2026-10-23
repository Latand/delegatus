import { cloneDirectory, type CloneRoute, type DiscoveredCloneChat } from "@/lib/externalRelay/cloneDirectory";
import { cloneClientKey, clonePayloadSupported, sendAsClone, type CloneSendInput, type CloneSendOptions, type CloneSendResult } from "@/lib/externalRelay/cloneSend";
import type { TelegramChatBot } from "./contracts";
import { TelegramBotError } from "./errors";
import type { BotTransport } from "./transport";

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
export function cloneTransport(port: ClonePostingPort, route: CloneRoute, caller: string, key: string, authorize: () => Promise<void>): BotTransport {
  return { call: async <T,>(method: string, params: Record<string, unknown>, options?: Parameters<BotTransport["call"]>[2]) => {
    if (method !== "sendMessage") throw new TelegramBotError("bad_request", "this clone sends group text only");
    const input = cloneInput(route, caller, key, params, options?.partIndex ?? 0);
    const result = await port.send(route, input, { signal: options?.signal, partIndex: options?.partIndex ?? 0,
      beforeSend: async () => {
        await authorize();
        if (!port.valid(route, String(params.chat_id))) throw new TelegramBotError("chat_not_allowed", "clone coverage changed");
      } });
    if (result.kind === "sent") return { ok: true as const, result: { message_id: result.messageId, date: result.sentAt,
      chat: { id: input.chat_id }, ...(input.message_thread_id ? { message_thread_id: input.message_thread_id } : {}) } as T };
    if (result.kind === "refused" && result.invalidate) port.invalidate(route, result.invalidate);
    return { ok: false as const, kind: result.kind === "uncertain" ? "network_failed" as const : "http" as const,
      status: null, description: null, migrateToChatId: null,
      retryAfterSeconds: result.kind === "refused" ? result.retryAfterSeconds ?? null : null,
      classified: { code: result.kind === "uncertain" ? "send_uncertain" as const : result.code,
        fallback: result.kind === "refused" && result.fallback } };
  } };
}
