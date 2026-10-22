import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { claimInstall, OPEN_SIGN_IN_REQUEST_LIMIT, TeamError } from "./members";
import { PASSKEY_TTL_MS, passkeyRegistrationOptions, passkeySignInOptions, registerPasskey, relyingPartyFor, removePasskey, signInWithPasskey } from "./passkeys";
import { SoftwareAuthenticator } from "./softwareAuthenticator.test-support";
import { resetTeamStoreForTests, teamStore } from "./store";

/*
 * Passkeys through SimpleWebAuthn under Bun (sign-in-and-team §2.2, §5.4),
 * with a software authenticator: a WebCrypto P-256 key that builds the same
 * attestation and assertion bytes a browser hands over. The library's own
 * verification decides every case below.
 */

const DESKTOP = { surface: "desktop" as const, browser: "chrome" as const };
const RP = { rpId: "dev.example.net", origin: "https://dev.example.net:8443" };

let stateDir = "";
const previousStateDir = process.env.LLV_STATE_DIR;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-team-passkey-"));
  process.env.LLV_STATE_DIR = stateDir;
  resetTeamStoreForTests();
});
afterEach(() => {
  resetTeamStoreForTests();
  process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function registered(synced = false) {
  const store = teamStore();
  const mira = claimInstall(store, "Mira", DESKTOP).member;
  const authenticator = await new SoftwareAuthenticator().init();
  /* A synced passkey counts nothing: it reports 0 at registration and after. */
  if (synced) authenticator.counter = -1;
  const { id, options } = await passkeyRegistrationOptions(store, mira, RP);
  const passkey = await registerPasskey(store, mira, id, await authenticator.register(options, RP.origin), RP, DESKTOP);
  return { store, mira, authenticator, passkey, userHandle: options.user.id };
}

describe("which hosts can hold a passkey", () => {
  test("only a named HTTPS host can offer passkeys", () => {
    expect(relyingPartyFor("dev.example.net:8443", true)).toEqual(RP);
    expect(relyingPartyFor("host.tail0000.ts.net", true)).toEqual({ rpId: "host.tail0000.ts.net", origin: "https://host.tail0000.ts.net" });
    expect(relyingPartyFor("localhost:8899", false)).toBeNull();
    expect(relyingPartyFor("localhost:8899", true)).toBeNull();
    expect(relyingPartyFor("device.localhost:8899", true)).toBeNull();
    expect(relyingPartyFor("203.0.113.20:8898", true)).toBeNull();
    expect(relyingPartyFor("[::1]:8898", false)).toBeNull();
    expect(relyingPartyFor("dev.example.net", false)).toBeNull();
  });
});

describe("registering and signing in with a passkey", () => {
  test("a registered passkey signs its member in, and the counter moves", async () => {
    const { store, mira, authenticator, passkey, userHandle } = await registered();
    expect(passkey).toMatchObject({ memberId: mira.id, rpId: RP.rpId, counter: 1, label: "Chrome on desktop" });
    const { id, options } = await passkeySignInOptions(RP);
    const signedIn = await signInWithPasskey(store, id, await authenticator.assert(options, RP.rpId, RP.origin, userHandle), RP, DESKTOP);
    expect(signedIn.member.id).toBe(mira.id);
    expect(signedIn.session.method).toBe("passkey");
    expect(store.passkey(passkey.id)?.counter).toBe(2);
    expect(store.passkey(passkey.id)?.lastUsedAt).not.toBeNull();
  });

  test("a tampered signature is refused", async () => {
    const { store, authenticator, userHandle } = await registered();
    const { id, options } = await passkeySignInOptions(RP);
    const assertion = await authenticator.assert(options, RP.rpId, RP.origin, userHandle, true);
    await expect(signInWithPasskey(store, id, assertion, RP, DESKTOP)).rejects.toThrow(TeamError);
  });

  test("an assertion for another host is refused, and a passkey made on another host is never accepted here", async () => {
    const { store, authenticator, userHandle } = await registered();
    const other = { rpId: "other.example.net", origin: "https://other.example.net" };
    const { id, options } = await passkeySignInOptions(other);
    const assertion = await authenticator.assert(options, other.rpId, other.origin, userHandle);
    await expect(signInWithPasskey(store, id, assertion, other, DESKTOP)).rejects.toThrow("this passkey is not registered here");
  });

  test("an assertion signed for the wrong origin is refused", async () => {
    const { store, authenticator, userHandle } = await registered();
    const { id, options } = await passkeySignInOptions(RP);
    const assertion = await authenticator.assert(options, RP.rpId, "https://evil.example.net", userHandle);
    await expect(signInWithPasskey(store, id, assertion, RP, DESKTOP)).rejects.toThrow("the passkey could not be verified");
  });

  test("a counter that goes backwards is refused, as a cloned authenticator would be", async () => {
    const { store, authenticator, passkey, userHandle } = await registered();
    store.usePasskey(passkey.id, 50, new Date().toISOString());
    const { id, options } = await passkeySignInOptions(RP);
    await expect(signInWithPasskey(store, id, await authenticator.assert(options, RP.rpId, RP.origin, userHandle), RP, DESKTOP)).rejects.toThrow("the passkey could not be verified");
  });

  test("a synced passkey that always reports 0 signs in every time", async () => {
    const { store, mira, authenticator, passkey, userHandle } = await registered(true);
    expect(passkey.counter).toBe(0);
    for (let round = 0; round < 2; round += 1) {
      authenticator.counter = -1;
      const { id, options } = await passkeySignInOptions(RP);
      const signedIn = await signInWithPasskey(store, id, await authenticator.assert(options, RP.rpId, RP.origin, userHandle), RP, DESKTOP);
      expect(signedIn.member.id).toBe(mira.id);
    }
  });

  test("an options request answers once", async () => {
    const { store, authenticator, userHandle } = await registered();
    const { id, options } = await passkeySignInOptions(RP);
    await signInWithPasskey(store, id, await authenticator.assert(options, RP.rpId, RP.origin, userHandle), RP, DESKTOP);
    await expect(signInWithPasskey(store, id, await authenticator.assert(options, RP.rpId, RP.origin, userHandle), RP, DESKTOP)).rejects.toThrow("the passkey request expired");
  });

  /* Security review of the rebased head, P2: a flood of keyless options
     requests pushed a waiting ceremony's challenge out before the person
     finished with their authenticator. */
  test("a ceremony in progress survives a flood of options requests, and the flood stores nothing", async () => {
    const { store, mira, authenticator, userHandle } = await registered();
    const { id, options } = await passkeySignInOptions(RP);
    for (let n = 0; n < OPEN_SIGN_IN_REQUEST_LIMIT + 8; n += 1) await passkeySignInOptions(RP);
    expect(store.countOpenKeylessChallenges("passkey", new Date().toISOString())).toBe(0);
    const signedIn = await signInWithPasskey(store, id, await authenticator.assert(options, RP.rpId, RP.origin, userHandle), RP, DESKTOP);
    expect(signedIn.member.id).toBe(mira.id);
  });

  test("a sign-in request past its lifetime, or with its lifetime rewritten, is refused", async () => {
    const { store, authenticator, userHandle } = await registered();
    const now = Date.now();
    const stale = await passkeySignInOptions(RP, now - PASSKEY_TTL_MS - 1);
    await expect(signInWithPasskey(store, stale.id, await authenticator.assert(stale.options, RP.rpId, RP.origin, userHandle), RP, DESKTOP))
      .rejects.toThrow("the passkey request expired");
    const [body, mac] = stale.id.split(".");
    const fields = JSON.parse(Buffer.from(body!.slice(2), "base64url").toString("utf8"));
    const forged = `${body!.slice(0, 2)}${Buffer.from(JSON.stringify({ ...fields, expiresAt: now + PASSKEY_TTL_MS })).toString("base64url")}.${mac}`;
    await expect(signInWithPasskey(store, forged, await authenticator.assert(stale.options, RP.rpId, RP.origin, userHandle), RP, DESKTOP))
      .rejects.toThrow("the passkey request expired");
  });

  test("a removed passkey signs nobody in", async () => {
    const { store, mira, authenticator, passkey, userHandle } = await registered();
    expect(removePasskey(store, mira, passkey.id)).toBe(true);
    const { id, options } = await passkeySignInOptions(RP);
    await expect(signInWithPasskey(store, id, await authenticator.assert(options, RP.rpId, RP.origin, userHandle), RP, DESKTOP)).rejects.toThrow("this passkey is not registered here");
  });
});
