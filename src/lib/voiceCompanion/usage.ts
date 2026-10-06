import { jsonObject } from "./provider";

/** Standard global rates verified 2026-10-06. Configuration pins default
 * service tier and exposes no hosted paid tools. See the linked pricing note. */
export const LIVE_USD_PER_SECOND = 0.05 / 60;
export const BACKEND_RESPONSE_RESERVE_USD = 0.20;
export const VOICE_SESSION_RESERVE_USD = 0.27; // five minutes plus close drain
export const LIVE_SESSION_LIMIT_MS = 300_000;

export function backendUsageUsd(value: unknown): number | null {
  const usage = jsonObject(value);
  const details = jsonObject(usage?.input_tokens_details);
  const input = usage?.input_tokens; const output = usage?.output_tokens;
  const cached = details?.cached_tokens ?? 0;
  if (![input, output, cached].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
    || (cached as number) > (input as number)) return null;
  const large = (input as number) > 272_000;
  return ((input as number) - (cached as number)) * (large ? 0.2 : 0.1) / 1_000_000
    + (cached as number) * (large ? 0.02 : 0.01) / 1_000_000
    + (output as number) * (large ? 0.75 : 0.5) / 1_000_000;
}
