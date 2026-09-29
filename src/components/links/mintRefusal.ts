import type { MessageKey, TFunction } from "@/lib/i18n";
import type { MintRefusal } from "@/lib/links/protocol";

/** Every refusal POST /api/links/codes answers with: mintCode's own, the
    route's, and a request that never got an answer. */
export const MINT_REFUSALS = [
  "needs-access-key", "invalid-address", "needs-remote-entry", "http-public", "open-to-internet",
  "host-rewritten", "tls-failure", "unverified", "owner-required", "staging", "unavailable",
] as const satisfies readonly (MintRefusal | "owner-required" | "staging" | "unavailable")[];

type Unlisted = Exclude<MintRefusal, (typeof MINT_REFUSALS)[number]>;
/** Fails to compile when mintCode gains a refusal the list above does not name. */
export const everyRefusalListed: [Unlisted] extends [never] ? true : Unlisted = true;

/** The sentence shown under "Allow a connection" when no code was made. An
    unknown refusal is still named, so a failed mint is never silent. */
export function mintRefusalMessage(t: TFunction, error: string): string {
  return (MINT_REFUSALS as readonly string[]).includes(error)
    ? t(`links.mint.${error}` as MessageKey)
    : t("links.mint.other", { reason: error });
}
