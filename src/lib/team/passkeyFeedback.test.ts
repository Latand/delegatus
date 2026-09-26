import { expect, test } from "bun:test";

import { translate } from "@/lib/i18n";

import { passkeyFeedback } from "./passkeyFeedback";

test("WebAuthn feedback uses structured names and codes on both ceremonies", () => {
  const cases = [
    [{ name: "NotAllowedError", code: "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL" }, "sign-in", "team.passkey.noCredential"],
    [{ name: "NotAllowedError" }, "sign-in", "team.passkey.cancelled"],
    [{ name: "NotAllowedError" }, "registration", "team.passkey.cancelled"],
    [{ name: "TimeoutError" }, "sign-in", "team.passkey.timeout"],
    [{ name: "InvalidStateError" }, "registration", "team.passkey.alreadyRegistered"],
    [{ name: "SecurityError" }, "registration", "team.passkey.wrongAddress"],
    [{ name: "NotSupportedError" }, "sign-in", "team.passkey.browserUnsupportedSignIn"],
    [{ name: "NotSupportedError" }, "registration", "team.passkey.browserUnsupportedRegistration"],
  ] as const;
  for (const [error, flow, key] of cases) expect(passkeyFeedback(error, flow).key).toBe(key);
  expect(passkeyFeedback({ name: "NotAllowedError", message: "No credentials available" }, "sign-in").key).toBe("team.passkey.cancelled");
  expect(passkeyFeedback({ name: "NotAllowedError" }, "sign-in", { elapsedMs: 100, timeoutMs: 60_000 }).key).toBe("team.passkey.noCredential");
  expect(passkeyFeedback({ name: "NotAllowedError" }, "sign-in", { elapsedMs: 60_000, timeoutMs: 60_000 }).key).toBe("team.passkey.timeout");
  expect(passkeyFeedback({ name: "AbortError" }, "registration").tone).toBe("note");
  for (const locale of ["en", "uk"] as const) {
    for (const [, flow] of cases) {
      const text = translate(locale, passkeyFeedback({ name: "SecurityError" }, flow).key);
      expect(text).not.toContain("team.passkey.");
    }
  }
});
