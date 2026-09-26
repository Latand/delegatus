import type { MessageKey, TFunction } from "@/lib/i18n";

export type PasskeyFlow = "sign-in" | "registration";
export type PasskeyFeedback = { key: MessageKey; tone: "error" | "note" };

export function passkeyFeedbackText(t: TFunction, feedback: PasskeyFeedback, address?: string | null, currentOrigin?: string): string {
  if (feedback.key === "team.passkey.wrongAddress" && address && address !== currentOrigin) return t("team.passkey.wrongAddressAt", { address });
  return t(feedback.key);
}

export function passkeyUnavailableText(t: TFunction, address?: string | null): string {
  return address ? t("team.passkey.unavailableAt", { address }) : t("team.passkey.unavailable");
}

/** Browser and SimpleWebAuthn error identifiers are stable; messages are not. */
export function passkeyFeedback(error: unknown, flow: PasskeyFlow, timing?: { elapsedMs: number; timeoutMs?: number }): PasskeyFeedback {
  const named = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; cause?: unknown } : null;
  const name = typeof named?.name === "string" ? named.name : "";
  const code = typeof named?.code === "string" ? named.code : "";
  const cause = named?.cause && typeof named.cause === "object" ? named.cause as { name?: unknown } : null;
  const causeName = typeof cause?.name === "string" ? cause.name : "";
  const is = (value: string) => name === value || causeName === value;

  if (flow === "sign-in" && (code === "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL"
    || (is("NotAllowedError") && timing && timing.elapsedMs < 1_200))) {
    return { key: "team.passkey.noCredential", tone: "error" };
  }
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || is("InvalidStateError")) {
    return { key: "team.passkey.alreadyRegistered", tone: "error" };
  }
  if (code === "ERROR_INVALID_DOMAIN" || code === "ERROR_INVALID_RP_ID" || is("SecurityError")) {
    return { key: "team.passkey.wrongAddress", tone: "error" };
  }
  if (is("NotSupportedError") || code === "ERROR_AUTHENTICATOR_PUBLIC_KEY_UNSUPPORTED") {
    return { key: flow === "sign-in" ? "team.passkey.browserUnsupportedSignIn" : "team.passkey.browserUnsupportedRegistration", tone: "error" };
  }
  if (is("TimeoutError") || (is("NotAllowedError") && timing?.timeoutMs && timing.elapsedMs >= timing.timeoutMs - 1_000)) {
    return { key: "team.passkey.timeout", tone: "error" };
  }
  if (code === "ERROR_CEREMONY_ABORTED" || is("AbortError") || is("NotAllowedError")) {
    return { key: "team.passkey.cancelled", tone: "note" };
  }
  return { key: "team.passkey.failed", tone: "error" };
}
