const encode = new TextEncoder();
const decode = new TextDecoder("utf-8", { fatal: true });
export const utf8 = (text: string) => encode.encode(text);
export const randomBytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));

export function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function bytes(value: unknown, min: number, max = min): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > Math.ceil(max * 4 / 3) || !/^[\w-]+$/.test(value)) {
    throw new Error("Invalid encoding");
  }
  const data = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
  if (data.length < min || data.length > max || base64url(data) !== value) throw new Error("Invalid encoding");
  return data;
}

export const sha256 = async (value: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest("SHA-256", value));
export const hex = (value: Uint8Array) => Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");

type Purpose = "enroll" | "login";

function challengeMessage(purpose: Purpose, data: string, enrollmentHash: string) {
  return utf8(`${purpose}.${data}.${enrollmentHash}`);
}

export async function makeChallenge(key: CryptoKey, purpose: Purpose, now: number, enrollmentHash = "") {
  const payload = new Uint8Array(24);
  new DataView(payload.buffer).setBigUint64(0, BigInt(now + (purpose === "enroll" ? 300_000 : 120_000)));
  payload.set(randomBytes(16), 8);
  const data = base64url(payload);
  const mac = await crypto.subtle.sign("HMAC", key, challengeMessage(purpose, data, enrollmentHash));
  const challenge = new Uint8Array(56);
  challenge.set(payload);
  challenge.set(new Uint8Array(mac), payload.length);
  return base64url(challenge);
}

export async function ceremony(
  input: Record<string, unknown>, key: CryptoKey, purpose: Purpose,
  origin: string, rpHash: Uint8Array, now: number, enrollmentHash = "",
) {
  const client = bytes(input.clientDataJSON, 1, 8192);
  const data = JSON.parse(decode.decode(client));
  if (data?.type !== (purpose === "enroll" ? "webauthn.create" : "webauthn.get") ||
      data.origin !== origin || (data.crossOrigin !== undefined && data.crossOrigin !== false)) {
    throw new Error("Invalid client data");
  }
  const challenge = bytes(data.challenge, 56);
  const payload = challenge.subarray(0, 24);
  const expires = Number(new DataView(payload.buffer, payload.byteOffset).getBigUint64(0));
  if (expires <= now || !await crypto.subtle.verify("HMAC", key, challenge.subarray(24),
    challengeMessage(purpose, base64url(payload), enrollmentHash))) throw new Error("Invalid challenge");

  const auth = bytes(input.authenticatorData, 37, 8192);
  if (rpHash.some((byte, index) => auth[index] !== byte) || (auth[32] & 5) !== 5) {
    throw new Error("Invalid authenticator data");
  }
  return {
    client, auth, expires, nonce: base64url(payload.subarray(8)),
    count: new DataView(auth.buffer, auth.byteOffset).getUint32(33),
  };
}

const rsa = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const ec = { name: "ECDSA", namedCurve: "P-256" };

export async function publicKey(alg: unknown, spki: BufferSource) {
  if (alg !== -7 && alg !== -257) throw new Error("Invalid algorithm");
  const key = await crypto.subtle.importKey("spki", spki, alg === -7 ? ec : rsa, false, ["verify"]);
  if (alg === -257 && (key.algorithm as RsaHashedKeyAlgorithm).modulusLength < 2048) {
    throw new Error("Invalid RSA key");
  }
  return key;
}

function rawSignature(der: Uint8Array) {
  const raw = new Uint8Array(64);
  if (der[0] !== 0x30 || der[1] !== der.length - 2 || der.length > 72) throw new Error("Invalid DER");
  let offset = 2;
  for (let index = 0; index < 2; index++) {
    const size = der[offset + 1];
    const start = offset + 2;
    const end = start + size;
    if (der[offset] !== 2 || !size || size > 33 || end > der.length || (der[start] & 0x80) !== 0 ||
        (size > 1 && der[start] === 0 && (der[start + 1] & 0x80) === 0)) throw new Error("Invalid DER integer");
    const significant = der.subarray(start + Number(der[start] === 0), end);
    if (!significant.length || significant.length > 32) throw new Error("Invalid DER integer");
    raw.set(significant, (index + 1) * 32 - significant.length);
    offset = end;
  }
  if (offset !== der.length) throw new Error("Invalid DER");
  return raw;
}

export async function verifyAssertion(
  alg: number, spki: BufferSource, client: Uint8Array<ArrayBuffer>, auth: Uint8Array<ArrayBuffer>, signature: unknown,
) {
  const key = await publicKey(alg, spki);
  const input = new Uint8Array(auth.length + 32);
  input.set(auth);
  input.set(await sha256(client), auth.length);
  const sig = bytes(signature, 8, alg === -7 ? 72 : 600);
  return crypto.subtle.verify(alg === -7 ? { name: "ECDSA", hash: "SHA-256" } : rsa, key,
    alg === -7 ? rawSignature(sig) : sig, input);
}
