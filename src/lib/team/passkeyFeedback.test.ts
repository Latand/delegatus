import { expect, test } from "bun:test";

import { translate } from "@/lib/i18n";

import { passkeyFeedback, passkeyFeedbackText } from "./passkeyFeedback";

test("WebAuthn feedback uses structured names and codes on both ceremonies", () => {
  const cases = [
    [{ name: "NotAllowedError", code: "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL" }, "sign-in", "team.passkey.noCredential"],
    [{ name: "NotAllowedError" }, "sign-in", "team.passkey.noCredentialOrCancelled"],
    [{ name: "NotAllowedError" }, "registration", "team.passkey.cancelled"],
    [{ name: "TimeoutError" }, "sign-in", "team.passkey.timeout"],
    [{ name: "InvalidStateError" }, "registration", "team.passkey.alreadyRegistered"],
    [{ name: "SecurityError" }, "registration", "team.passkey.wrongAddress"],
    [{ name: "NotSupportedError" }, "sign-in", "team.passkey.browserUnsupportedSignIn"],
    [{ name: "NotSupportedError" }, "registration", "team.passkey.browserUnsupportedRegistration"],
  ] as const;
  for (const [error, flow, key] of cases) expect(passkeyFeedback(error, flow).key).toBe(key);
  expect(passkeyFeedback({ name: "NotAllowedError", message: "No credentials available" }, "sign-in").key).toBe("team.passkey.noCredentialOrCancelled");
  expect(passkeyFeedback({ name: "NotAllowedError" }, "sign-in", { elapsedMs: 100, timeoutMs: 60_000 }).tone).toBe("note");
  expect(passkeyFeedback({ name: "NotAllowedError" }, "sign-in", { elapsedMs: 60_000, timeoutMs: 60_000 }).key).toBe("team.passkey.timeout");
  expect(passkeyFeedback({ name: "AbortError" }, "registration").tone).toBe("note");
  const wrongAddress = passkeyFeedback({ name: "SecurityError" }, "registration");
  const en = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("en", key, params);
  expect(passkeyFeedbackText(en, wrongAddress, "https://team.example.test", "https://team.example.test")).toBe(translate("en", "team.passkey.wrongAddress"));
  expect(passkeyFeedbackText(en, wrongAddress, "https://team.example.test", "http://127.0.0.1:8899")).toContain("https://team.example.test");
  for (const locale of ["en", "uk"] as const) {
    for (const [, flow] of cases) {
      const text = translate(locale, passkeyFeedback({ name: "SecurityError" }, flow).key);
      expect(text).not.toContain("team.passkey.");
    }
  }
});
