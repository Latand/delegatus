import path from "node:path";

import { statePath } from "@/lib/configDir";

import { atomicSecretWrite, readSafeJson, removeSafeFile } from "../sessionStore";

import { validBotToken } from "./contracts";

/**
 * The one module that holds the bot token
 * (`docs/design/telegram-bot-account.md`, Decision 2).
 *
 * The Bot API puts the token in the request PATH, so a fetch rejection, a
 * `Response.url` or a logged request would carry it. Everything past this file
 * receives a {@link BotTransport} whose only member is `call`: the token sits in
 * that function's closure, so `JSON.stringify` and `util.inspect` of a
 * transport show nothing, every fetch failure comes back as a code, and a
 * description Telegram sends is passed through with the token cut out of it.
 */

/** Why a call did not produce a result. `http` is Telegram's own refusal and
    carries its status; the other three never reached an answer. `unreachable`
    is the one that proves nothing left the machine (the connection was
    refused or the name did not resolve); after `network_failed` or
    `timed_out` the request may have reached Telegram. */
export type BotCallFailureKind = "http" | "unreachable" | "network_failed" | "timed_out";

/* Errors raised before a connection exists, so before any byte of the request
   was written. Anything else may have happened after the request left. */
const NOT_SENT_CODES = new Set(["ConnectionRefused", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export type BotCallResult<T = unknown> =
  | { ok: true; result: T }
  | {
    ok: false;
    kind: BotCallFailureKind;
    /** Telegram's `error_code` (HTTP status) when it answered. */
    status: number | null;
    /** Telegram's description, token-scrubbed and bounded. */
    description: string | null;
    retryAfterSeconds: number | null;
    migrateToChatId: string | null;
  };

export interface BotTransport {
  call<T = unknown>(method: string, params: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<BotCallResult<T>>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const API_ORIGIN = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 20_000;
const DESCRIPTION_MAX = 300;

/** Replaces every occurrence of the token — and its secret half alone — with
    `[token]`, then bounds the text. Telegram's descriptions do not echo the
    token today; this guards a future change on their side. */
export function scrubTokenText(value: string, token: string): string {
  const tail = token.slice(token.indexOf(":") + 1);
  let scrubbed = value.split(token).join("[token]");
  if (tail.length >= 8) scrubbed = scrubbed.split(tail).join("[token]");
  return scrubbed.length > DESCRIPTION_MAX ? `${scrubbed.slice(0, DESCRIPTION_MAX - 1)}…` : scrubbed;
}

function failure(kind: BotCallFailureKind, status: number | null = null, description: string | null = null, parameters?: unknown): BotCallResult<never> {
  const params = parameters && typeof parameters === "object" ? parameters as { retry_after?: unknown; migrate_to_chat_id?: unknown } : {};
  const retryAfter = typeof params.retry_after === "number" && Number.isFinite(params.retry_after) ? Math.max(0, Math.ceil(params.retry_after)) : null;
  const migrate = typeof params.migrate_to_chat_id === "number" && Number.isSafeInteger(params.migrate_to_chat_id)
    ? String(params.migrate_to_chat_id)
    : null;
  return { ok: false, kind, status, description, retryAfterSeconds: retryAfter, migrateToChatId: migrate };
}

/**
 * The production transport. `fetchImpl` is the test seam; nothing else about
 * the token is reachable from the returned object.
 */
export function createBotApiTransport(token: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)): BotTransport {
  if (!validBotToken(token)) throw new Error("bot token has an invalid shape");
  const call = async <T,>(method: string, params: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<BotCallResult<T>> => {
    if (!/^[A-Za-z]{1,64}$/.test(method)) return failure("http", 400, "invalid method name");
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    let response: Response;
    let body: unknown;
    try {
      /* The URL is built here and goes nowhere else: not into an error, a
         log line, or a returned value. */
      response = await fetchImpl(`${API_ORIGIN}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        redirect: "error",
        signal: controller.signal,
      });
      body = await response.json().catch(() => null);
    } catch (error) {
      /* Whatever was thrown may quote the request URL. It is dropped whole;
         only its code is read. */
      if (timedOut) return failure("timed_out");
      const code = (error as { code?: unknown } | null)?.code;
      return failure(typeof code === "string" && NOT_SENT_CODES.has(code) ? "unreachable" : "network_failed");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    const envelope = body && typeof body === "object" ? body as { ok?: unknown; result?: unknown; error_code?: unknown; description?: unknown; parameters?: unknown } : null;
    if (envelope?.ok === true) return { ok: true, result: envelope.result as T };
    const status = typeof envelope?.error_code === "number" ? envelope.error_code : response.status;
    if (!envelope && status >= 500) return failure("http", status, null);
    const description = typeof envelope?.description === "string" ? scrubTokenText(envelope.description, token) : null;
    return failure("http", status, description, envelope?.parameters);
  };
  return Object.freeze({ call });
}

/* ------------------------------------------------------------------------ */
/* The token file: `<state>/telegram/bot-token.json`, 0600 in the fenced 0700
   directory the personal connector already owns. The `bot-` prefix keeps the
   two accounts' files disjoint. */

const TOKEN_FILE = "bot-token.json";

export function telegramBotTokenPath(): string {
  return path.join(statePath("telegram"), TOKEN_FILE);
}

type StoredBotTokenFile = { version: 1; botId: string; token: string; savedAt: string };

export function saveBotToken(token: string, botId: string, now: Date = new Date()): void {
  if (!validBotToken(token)) throw new Error("bot token has an invalid shape");
  const stored: StoredBotTokenFile = { version: 1, botId, token, savedAt: now.toISOString() };
  atomicSecretWrite(telegramBotTokenPath(), JSON.stringify(stored));
}

/**
 * Reads the stored token and hands it ONLY to `use`, which builds whatever
 * needs it (a transport). The token itself is never returned.
 */
export function withStoredBotToken<T>(use: (token: string, botId: string) => T): T | null {
  const parsed = readSafeJson(telegramBotTokenPath(), true);
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Partial<StoredBotTokenFile>;
  if (row.version !== 1 || !validBotToken(row.token) || typeof row.botId !== "string") return null;
  return use(row.token, row.botId);
}

export function storedBotId(): string | null {
  return withStoredBotToken((_token, botId) => botId);
}

export function removeBotToken(): void {
  removeSafeFile(telegramBotTokenPath());
}
