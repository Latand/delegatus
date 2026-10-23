import crypto from "node:crypto";

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

/** WebAuthn software authenticator used by the real passkey route tests. */
export class SoftwareAuthenticator {
  readonly credentialId = Buffer.alloc(16, 7);
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
      id: b64url(this.credentialId), rawId: b64url(this.credentialId), type: "public-key" as const, clientExtensionResults: {},
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
      id: b64url(this.credentialId), rawId: b64url(this.credentialId), type: "public-key" as const, clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(derSignature(raw)), userHandle,
      },
    };
  }
}
