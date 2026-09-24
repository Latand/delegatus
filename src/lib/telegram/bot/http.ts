import { NextResponse } from "next/server";

import { UnsafeTelegramSessionError } from "../sessionStore";

import type { TelegramBotErrorCode } from "./contracts";
import { TelegramBotError } from "./service";

/**
 * How a bot refusal leaves a route: its code, its sentence, whether a retry
 * under a new key may help, and Telegram's wait when it gave one. Never a
 * raw error, which could carry a path or an upstream detail.
 */
const STATUS: Record<TelegramBotErrorCode, number> = {
  invalid_token: 400,
  not_a_bot: 400,
  bot_already_connected: 409,
  bot_not_connected: 409,
  token_rejected: 400,
  chat_unknown: 404,
  chat_not_allowed: 403,
  bot_not_in_chat: 409,
  alias_invalid: 400,
  alias_taken: 409,
  text_empty: 400,
  text_too_long: 400,
  format_invalid: 400,
  forbidden: 403,
  rate_limited: 429,
  send_uncertain: 409,
  send_partial: 409,
  bad_request: 400,
  /* 503 with a body is a verdict to the MCP dispatch; 502 and 504 would read
     as "the Viewer may not have answered". */
  network_failed: 503,
  timed_out: 503,
  telegram_failed: 503,
  storage_unsafe: 500,
};

export function telegramBotFailure(error: unknown): NextResponse {
  if (error instanceof TelegramBotError) {
    return NextResponse.json({
      error: error.message,
      code: error.code,
      retryable: error.retryable,
      ...(error.extra.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.extra.retryAfterSeconds } : {}),
      ...(error.extra.sentMessageIds ? { sentMessageIds: error.extra.sentMessageIds } : {}),
    }, { status: STATUS[error.code] ?? 400 });
  }
  if (error instanceof UnsafeTelegramSessionError) {
    return NextResponse.json({ error: "Telegram bot storage failed its safety checks", code: "storage_unsafe", retryable: false }, { status: 500 });
  }
  console.error("[telegram bot] request failed", error instanceof Error ? error.name : "unknown");
  return NextResponse.json({ error: "Telegram bot request failed", code: "action_failed", retryable: false }, { status: 500 });
}
