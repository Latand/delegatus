const b64 = value => Buffer.from(value).toString("base64url");
export const testToken = b64(Buffer.alloc(32, 17));
export const secondToken = b64(Buffer.alloc(32, 18));
export const forgedCookie = "__Host-dlg_stats=" + b64(Buffer.alloc(32, 19));

async function digest(value) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", value));
}

export async function enrollmentSecret(token, time) {
  return `v1.${Math.floor(time / 1000) + 86400}.${(await digest(Buffer.from(token, "base64url"))).toString("hex")}`;
}

function encodeDer(raw) {
  const integer = part => {
    let start = 0;
    while (start < part.length - 1 && part[start] === 0) start++;
    const significant = part.subarray(start);
    const pad = significant[0] & 128 ? [0] : [];
    return Buffer.from([2, significant.length + pad.length, ...pad, ...significant]);
  };
  const r = integer(raw.subarray(0, 32));
  const s = integer(raw.subarray(32));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}

export async function authenticator(origin, rpId, idByte = 1, rsaBits = 0) {
  const alg = rsaBits ? -257 : -7;
  const signing = rsaBits ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
  const pair = await crypto.subtle.generateKey(rsaBits ? {
    ...signing, modulusLength: rsaBits, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  } : { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const id = b64(Buffer.alloc(16, idByte));
  const publicKey = b64(await crypto.subtle.exportKey("spki", pair.publicKey));
  let handle;
  async function records(type, challenge, changes) {
    const client = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...changes.client }));
    const auth = Buffer.alloc(37);
    auth.set(await digest(Buffer.from(changes.rpId ?? rpId)));
    auth[32] = changes.flags ?? 5;
    auth.writeUInt32BE(changes.count ?? 0, 33);
    return { client, auth };
  }
  return {
    id, publicKey, alg,
    async registration(options, token, changes = {}) {
      handle = options.user.id;
      const { client, auth } = await records("webauthn.create", options.challenge, changes);
      return { token, id, publicKey, alg, clientDataJSON: b64(client), authenticatorData: b64(auth) };
    },
    async assertion(options, changes = {}) {
      const { client, auth } = await records("webauthn.get", options.challenge, changes);
      const raw = Buffer.from(await crypto.subtle.sign(signing, pair.privateKey, Buffer.concat([auth, await digest(client)])));
      return {
        id, userHandle: handle, clientDataJSON: b64(client), authenticatorData: b64(auth),
        signature: b64(rsaBits ? raw : encodeDer(raw)),
      };
    },
  };
}

export function fixtureInstallId(index) {
  return ["f0000000", "0000", "4000", "8000", String(index).padStart(12, "0")].join("-");
}
