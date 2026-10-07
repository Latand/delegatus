import { jsonObject } from "./provider";

/** Standard global rates verified 2026-10-06. Configuration pins default
 * service tier and exposes no hosted paid tools. See the linked pricing note. */
export const LIVE_USD_PER_SECOND = 0.05 / 60;
export const BACKEND_MAX_OUTPUT_TOKENS = 512;
/** The dearest one backend response can be: the model's whole context window
 * at the large-input rate for a cache write, plus every allowed output token. */
export const BACKEND_RESPONSE_RESERVE_USD = 1_050_000 * 0.25 / 1_000_000 + BACKEND_MAX_OUTPUT_TOKENS * 0.75 / 1_000_000;
/** Backend responses one delegation may take: reads, then the spoken answer. */
export const BACKEND_ROUNDS = 4;
export const VOICE_SESSION_RESERVE_USD = 0.27; // five minutes plus close drain
/** Client delegation: this server starts every backend response itself and
 * pays for each before it asks. A start holds the voice reservation and needs
 * room beside it for one backend response, so a board question can be answered. */
export const SESSION_START_ROOM_USD = VOICE_SESSION_RESERVE_USD + BACKEND_RESPONSE_RESERVE_USD;
export const LIVE_SESSION_LIMIT_MS = 300_000;
/** How long a mint whose answer was lost blocks the next one. The provider
 * lists no sessions, so one created without its answer cannot be named or hung
 * up. Its browser never received the negotiation answer and closed its peer,
 * so no media can reach it; it is held as open, and charged, for the first
 * voice window its reservation pays for. */
export const UNCERTAIN_MINT_HOLD_MS = LIVE_SESSION_LIMIT_MS;

/** A cache write costs 1.25 times the input rate it is billed at. */
const CACHE_WRITE = 1.25;
/** What one backend response cost by its own usage, or null when the usage is
 * missing or cannot be read: the caller then keeps the whole reservation. */
export function backendUsageUsd(value: unknown): number | null {
  const usage = jsonObject(value);
  if (usage?.input_tokens_details !== undefined && usage.input_tokens_details !== null && !jsonObject(usage.input_tokens_details)) return null;
  const details = jsonObject(usage?.input_tokens_details);
  const input = usage?.input_tokens; const output = usage?.output_tokens;
  const cached = details?.cached_tokens ?? 0; const written = details?.cache_write_tokens ?? 0;
  if (![input, output, cached, written].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
    || (cached as number) + (written as number) > (input as number)) return null;
  const large = (input as number) > 272_000;
  const rate = large ? 0.2 : 0.1;
  return ((input as number) - (cached as number) - (written as number)) * rate / 1_000_000
    + (written as number) * rate * CACHE_WRITE / 1_000_000
    + (cached as number) * (large ? 0.02 : 0.01) / 1_000_000
    + (output as number) * (large ? 0.75 : 0.5) / 1_000_000;
}
