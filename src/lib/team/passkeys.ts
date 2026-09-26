import crypto from "node:crypto";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

import { PRODUCT_NAME } from "@/lib/brand";

import type { Member } from "./contract";
import { appendTeamEvent } from "./events";
import { challengeIsOpen, issueChallenge, newChallengeId, TeamError, type Device, type SignedIn } from "./members";
import { mintSession, sha256Hex } from "./sessions";
import type { StoredPasskey, TeamStore } from "./store";

/*
 * Passkeys (§5.4, D6), through SimpleWebAuthn. The relying party is the host
 * the request arrived on, so a passkey made on the stage box's name is offered
 * there and nowhere else, and a member simply has one passkey per origin they
 * use. Attestation `none`, user verification required, discoverable
 * credentials preferred so the sign-in page needs no username.
 */

export const PASSKEY_TTL_MS = 2 * 60_000;
export const MAX_PASSKEYS = 10;

export interface RelyingParty {
  rpId: string;
  origin: string;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function hostWithoutPort(host: string): string {
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  const index = host.lastIndexOf(":");
  return index === -1 ? host : host.slice(0, index);
}

/** The relying party a request can use, or null for an IP address, loopback
    name, or plain-HTTP origin. */
export function relyingPartyFor(hostHeader: string | null, https: boolean): RelyingParty | null {
  const host = hostHeader?.trim().toLowerCase() ?? "";
  if (!host) return null;
  const name = hostWithoutPort(host);
  if (!name || name === "localhost" || name.endsWith(".localhost") || IPV4.test(name) || name.includes(":")) return null;
  if (!https) return null;
  return { rpId: name, origin: `${https ? "https" : "http"}://${host}` };
}

function passkeyLabel(device: Device): string {
  const browser = { chrome: "Chrome", safari: "Safari", firefox: "Firefox", edge: "Edge", other: "Browser" }[device.browser];
  const surface = { desktop: "desktop", phone: "phone", tablet: "tablet", other: "device" }[device.surface];
  return `${browser} on ${surface}`;
}

export async function passkeyRegistrationOptions(store: TeamStore, member: Member, rp: RelyingParty, nowMs = Date.now()) {
  const existing = store.passkeysFor(member.id).filter((passkey) => passkey.rpId === rp.rpId);
  if (store.passkeysFor(member.id).length >= MAX_PASSKEYS) throw new TeamError("passkey_limit", "a member can keep at most ten passkeys", 409);
  const options = await generateRegistrationOptions({
    rpName: PRODUCT_NAME,
    rpID: rp.rpId,
    userName: member.name,
    userDisplayName: member.name,
    userID: new TextEncoder().encode(member.id),
    attestationType: "none",
    excludeCredentials: existing.map((passkey) => ({ id: passkey.id, transports: passkey.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    timeout: PASSKEY_TTL_MS,
  });
  const { challenge } = issueChallenge(store, {
    kind: "passkey",
    ttlMs: PASSKEY_TTL_MS,
    memberId: member.id,
    payload: { purpose: "register", challenge: options.challenge, rpId: rp.rpId, origin: rp.origin },
  }, nowMs);
  return { id: challenge.id, options };
}

export async function registerPasskey(
  store: TeamStore,
  member: Member,
  id: unknown,
  response: RegistrationResponseJSON,
  rp: RelyingParty,
  device: Device,
  nowMs = Date.now(),
): Promise<StoredPasskey> {
  const challenge = typeof id === "string" ? store.challenge(id) : null;
  if (!challengeIsOpen(challenge, nowMs) || challenge.kind !== "passkey" || challenge.payload?.purpose !== "register"
    || challenge.memberId !== member.id || challenge.payload.rpId !== rp.rpId) {
    throw new TeamError("passkey_expired", "the passkey request expired; try again", 410);
  }
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.payload.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
    });
  } catch {
    throw new TeamError("passkey_rejected", "the passkey could not be verified", 400);
  }
  if (!verification.verified) throw new TeamError("passkey_rejected", "the passkey could not be verified", 400);
  const info = verification.registrationInfo;
  const passkey: StoredPasskey = {
    id: info.credential.id,
    memberId: member.id,
    rpId: rp.rpId,
    publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
    counter: info.credential.counter,
    transports: info.credential.transports ?? [],
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    label: passkeyLabel(device),
    createdAt: new Date(nowMs).toISOString(),
    lastUsedAt: null,
  };
  store.transaction(() => {
    if (!store.consumeChallenge(challenge.id, new Date(nowMs).toISOString())) throw new TeamError("passkey_expired", "the passkey request expired; try again", 410);
    if (store.passkey(passkey.id)) throw new TeamError("passkey_exists", "this passkey is already registered", 409);
    store.insertPasskey(passkey);
    appendTeamEvent(store, { actor: { kind: "member", memberId: member.id }, action: "passkey.added", subject: { kind: "passkey", id: passkey.id.slice(0, 16), title: passkey.label }, detail: { rpId: rp.rpId } }, nowMs);
  });
  return passkey;
}

/*
 * A sign-in request is opened by someone nobody knows yet, so storing one per
 * request let a flood push a person's out while they were still at their
 * authenticator. Instead the request travels sealed in its own id: the
 * WebAuthn challenge, the host and the moment it expires, under a key this
 * process made at start. Nothing is written until a passkey answers it; the
 * answer then records the challenge as used, so it signs in once. A restart
 * voids the key, and with it only ceremonies still in their two minutes.
 */
interface SealedSignIn {
  challenge: string;
  rpId: string;
  origin: string;
  expiresAt: number;
}

const SIGN_IN_KEY = Symbol.for("llv.team.passkeySignInKey");

function signInKey(): Buffer {
  const holder = globalThis as unknown as Record<symbol, Buffer | undefined>;
  return holder[SIGN_IN_KEY] ??= crypto.randomBytes(32);
}

function signInMac(body: string): string {
  return crypto.createHmac("sha256", signInKey()).update(body).digest("base64url");
}

function sealSignIn(fields: SealedSignIn): string {
  const body = `p_${Buffer.from(JSON.stringify(fields)).toString("base64url")}`;
  return `${body}.${signInMac(body)}`;
}

function openSignIn(id: unknown, nowMs: number): SealedSignIn | null {
  if (typeof id !== "string" || id.length > 2048) return null;
  const [body, mac, extra] = id.split(".");
  if (!body?.startsWith("p_") || !mac || extra !== undefined) return null;
  const expected = Buffer.from(signInMac(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const fields = JSON.parse(Buffer.from(body.slice(2), "base64url").toString("utf8")) as SealedSignIn;
    return typeof fields.challenge === "string" && typeof fields.rpId === "string" && typeof fields.origin === "string"
      && typeof fields.expiresAt === "number" && fields.expiresAt > nowMs ? fields : null;
  } catch {
    return null;
  }
}

export async function passkeySignInOptions(rp: RelyingParty, nowMs = Date.now()) {
  const options = await generateAuthenticationOptions({ rpID: rp.rpId, userVerification: "required", timeout: PASSKEY_TTL_MS });
  const id = sealSignIn({ challenge: options.challenge, rpId: rp.rpId, origin: rp.origin, expiresAt: nowMs + PASSKEY_TTL_MS });
  return { id, options };
}

export async function signInWithPasskey(
  store: TeamStore,
  id: unknown,
  response: AuthenticationResponseJSON,
  rp: RelyingParty,
  device: Device,
  nowMs = Date.now(),
): Promise<SignedIn> {
  const sealed = openSignIn(id, nowMs);
  if (!sealed || sealed.rpId !== rp.rpId || sealed.origin !== rp.origin) {
    throw new TeamError("passkey_expired", "the passkey request expired; try again", 410);
  }
  const passkey = typeof response?.id === "string" ? store.passkey(response.id) : null;
  /* A passkey made for another host is never accepted here, whatever it signs. */
  if (!passkey || passkey.rpId !== rp.rpId) throw new TeamError("passkey_unknown", "this passkey is not registered here", 404);
  const member = store.member(passkey.memberId);
  if (!member || member.status !== "active") throw new TeamError("passkey_unknown", "this passkey is not registered here", 404);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: sealed.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
      credential: {
        id: passkey.id,
        publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")),
        counter: passkey.counter,
        transports: passkey.transports as never,
      },
    });
  } catch {
    throw new TeamError("passkey_rejected", "the passkey could not be verified", 401);
  }
  if (!verification.verified) throw new TeamError("passkey_rejected", "the passkey could not be verified", 401);
  return store.transaction(() => {
    const used = sha256Hex(sealed.challenge);
    if (store.challengeBySecret(used)) throw new TeamError("passkey_expired", "the passkey request expired; try again", 410);
    const at = new Date(nowMs).toISOString();
    store.insertChallenge({
      id: newChallengeId(), kind: "passkey", secretHash: used, userCode: null, memberId: member.id, createdBy: null,
      createdAt: at, expiresAt: new Date(sealed.expiresAt).toISOString(), consumedAt: at, attempts: 0, invitedName: null,
      result: null, requester: null, payload: { purpose: "sign-in", rpId: rp.rpId },
    });
    /* A counter that went backwards was already refused by the library (a
       cloned authenticator); synced passkeys report 0 and pass untouched. */
    store.usePasskey(passkey.id, verification.authenticationInfo.newCounter, new Date(nowMs).toISOString());
    const { value, session } = mintSession(store, member.id, "passkey", device, nowMs);
    appendTeamEvent(store, {
      actor: { kind: "member", memberId: member.id },
      action: "session.signed_in",
      subject: { kind: "session", id: session.id.slice(0, 12), title: null },
      detail: { method: "passkey", surface: device.surface, browser: device.browser },
    }, nowMs);
    return { member, cookie: value, session };
  });
}

export function removePasskey(store: TeamStore, member: Member, id: string, nowMs = Date.now()): boolean {
  const passkey = store.passkey(id);
  if (!passkey || passkey.memberId !== member.id) return false;
  store.transaction(() => {
    store.deletePasskey(id);
    appendTeamEvent(store, { actor: { kind: "member", memberId: member.id }, action: "passkey.removed", subject: { kind: "passkey", id: id.slice(0, 16), title: passkey.label } }, nowMs);
  });
  return true;
}
