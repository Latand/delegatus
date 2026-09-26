import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { claimInstall, OPEN_SIGN_IN_REQUEST_LIMIT, TeamError } from "./members";
import { PASSKEY_TTL_MS, passkeyRegistrationOptions, passkeySignInOptions, registerPasskey, relyingPartyFor, removePasskey, signInWithPasskey } from "./passkeys";
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

/* ---- a minimal CBOR encoder: the shapes WebAuthn uses and nothing else ---- */

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
}

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function cbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  const parts: Buffer[] = [head(5, value.size)];
  for (const [key, entry] of value) parts.push(cbor(key), cbor(entry));
  return Buffer.concat(parts);
}

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array | Buffer | string) => crypto.createHash("sha256").update(bytes).digest();
function counterBytes(counter: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(counter);
  return out;
}

/** WebCrypto signs P-256 as r‖s; WebAuthn carries it DER-encoded. */
function derSignature(raw: Uint8Array): Buffer {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    let body = Buffer.from(bytes.subarray(start));
    if (body[0]! & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
    return Buffer.concat([Buffer.from([0x02, body.length]), body]);
  };
  const sequence = Buffer.concat([integer(raw.subarray(0, 32)), integer(raw.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, sequence.length]), sequence]);
}

class SoftwareAuthenticator {
  readonly credentialId = crypto.randomBytes(16);
  private keys!: CryptoKeyPair;
  counter = 0;

  async init(): Promise<this> {
    this.keys = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    return this;
  }

  async register(options: { challenge: string; rp: { id?: string }; user: { id: string } }, origin: string) {
    const jwk = await crypto.webcrypto.subtle.exportKey("jwk", this.keys.publicKey);
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
    this.counter += 1;
    const authData = Buffer.concat([
      sha256(options.rp.id!), Buffer.from([0x45]), counterBytes(this.counter),
      Buffer.alloc(16), Buffer.from([0, this.credentialId.length]), this.credentialId, cose,
    ]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        attestationObject: b64url(cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]))),
        transports: ["internal" as const],
      },
    };
  }

  async assert(options: { challenge: string }, rpId: string, origin: string, userHandle: string, tamper = false) {
    this.counter += 1;
    const authData = Buffer.concat([sha256(rpId), Buffer.from([0x05]), counterBytes(this.counter)]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const raw = new Uint8Array(await crypto.webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, Buffer.concat([authData, sha256(clientData)])));
    if (tamper) raw[10] = raw[10]! ^ 0x01;
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(derSignature(raw)),
        userHandle,
      },
    };
  }
}

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
  test("a named HTTPS host and localhost can; an IP address or plain HTTP cannot", () => {
    expect(relyingPartyFor("dev.example.net:8443", true)).toEqual(RP);
    expect(relyingPartyFor("host.tail0000.ts.net", true)).toEqual({ rpId: "host.tail0000.ts.net", origin: "https://host.tail0000.ts.net" });
    expect(relyingPartyFor("localhost:8899", false)).toEqual({ rpId: "localhost", origin: "http://localhost:8899" });
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
