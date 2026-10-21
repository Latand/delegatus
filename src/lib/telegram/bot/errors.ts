import { RETRYABLE_TELEGRAM_BOT_CODES, type TelegramBotErrorCode, type TelegramBotRefusal } from "./contracts";
import type { BotCallResult } from "./transport";
import type { ChatRow } from "./store";

export class TelegramBotError extends Error {
  constructor(
    readonly code: TelegramBotErrorCode,
    message: string,
    readonly extra: { retryAfterSeconds?: number; sentMessageIds?: number[]; secretClass?: string; refusals?: TelegramBotRefusal[] } = {},
  ) {
    super(message);
    this.name = "TelegramBotError";
  }

  get retryable(): boolean {
    return RETRYABLE_TELEGRAM_BOT_CODES.has(this.code);
  }
}

/** Telegram's refusal of a send, as one of our codes. */
export function sendFailure(result: Extract<BotCallResult, { ok: false }>, chat: ChatRow): TelegramBotError {
  // Keep the cause ahead of titles and advice in bounded bridge diagnostics.
  const detail = result.description ? `Telegram: ${result.description}; ` : "";
  if (result.kind === "unreachable") return new TelegramBotError("network_failed", "Telegram could not be reached, so nothing was sent");
  /* A connection that failed after it opened may have carried the post. */
  if (result.kind === "network_failed") return new TelegramBotError("network_failed", "the connection to Telegram failed; the message may or may not have been posted");
  if (result.kind === "timed_out") return new TelegramBotError("timed_out", "Telegram did not answer in time; the message may or may not have been posted");
  if (result.status === 429) {
    return new TelegramBotError("rate_limited", `${detail}Telegram is rate-limiting this bot; retry after ${result.retryAfterSeconds ?? 1} s`, { retryAfterSeconds: result.retryAfterSeconds ?? 1 });
  }
  if (result.status === 401 || result.status === 404) return new TelegramBotError("token_rejected", `${detail}Telegram rejected the bot token; the operator must paste a new one in the Telegram panel`);
  if (result.status === 403) {
    return new TelegramBotError("forbidden", `${detail}Telegram refused the post to ${chat.title}: the bot was blocked or removed, lacks the right to post, or the user never wrote to it`);
  }
  if (result.status === 400 && /chat not found/i.test(result.description ?? "")) return new TelegramBotError("bot_not_in_chat", `${detail}the bot cannot see this chat`);
  if (result.status === 400 && /not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|CHAT_SEND_.*_FORBIDDEN|TOPIC_CLOSED/i.test(result.description ?? "")) return new TelegramBotError("not_enough_rights", `${detail}the bot may not post here`);
  if (result.status === 400 && /parse entities|can't parse|unsupported start tag|unexpected end tag/i.test(result.description ?? "")) {
    return new TelegramBotError("format_invalid", `${detail}Telegram could not parse the HTML formatting`);
  }
  if (result.status !== null && result.status >= 500) return new TelegramBotError("telegram_failed", `${detail}Telegram failed to handle the request`);
  return new TelegramBotError("bad_request", `${detail}Telegram refused the message`);
}
