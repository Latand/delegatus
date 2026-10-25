import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

/**
 * The sealed form of a transfer bundle (docs/design/install-memory-transfer.md
 * §2.1, operator decision Q4): one plain JSON line naming the key derivation
 * and cipher, then the plain bundle encrypted in 1 MiB chunks, each with its
 * own nonce and tag. Every chunk's additional data binds the header line, the
 * chunk's index and whether it is the last one, so chunks cannot be dropped,
 * reordered or cut off at the end without the open failing.
 *
 * Plain ESM with node builtins only, so the CLI (`bin/transfer.mjs`) and the
 * TypeScript sources share one definition.
 *
 * Frame: flag (1 byte, 1 on the last chunk) | length (4 bytes, big endian) |
 * nonce (12) | tag (16) | ciphertext (length).
 */

export const SEALED_FORMAT = "delegatus-transfer-sealed";
const CHUNK = 1024 * 1024;
const KDF = { name: "scrypt", N: 32768, r: 8, p: 1 };
const MAX_HEADER_BYTES = 4096;
const PASSPHRASE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export class TransferSealError extends Error {
  /** @param {"not_sealed" | "bad_header" | "wrong_passphrase_or_damaged" | "truncated"} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "TransferSealError";
    this.code = code;
  }
}

/** A passphrase of six groups of five characters (about 147 bits), shown once and never stored. */
export function generatePassphrase(random = randomBytes) {
  const groups = [];
  for (let group = 0; group < 6; group += 1) {
    const bytes = random(5);
    let text = "";
    for (const byte of bytes) text += PASSPHRASE_ALPHABET[byte % PASSPHRASE_ALPHABET.length];
    groups.push(text);
  }
  return groups.join("-");
}

/** @param {Uint8Array} bytes */
export function isSealedBundle(bytes) {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 64))).toString("utf8");
  return head.startsWith(`{"format":"${SEALED_FORMAT}"`);
}

/** @param {string} passphrase @param {Buffer} salt @param {{N: number, r: number, p: number}} kdf */
function deriveKey(passphrase, salt, kdf) {
  const normalized = passphrase.trim().toUpperCase();
  return scryptSync(normalized, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r });
}

/** @param {Buffer} headerLine @param {number} index @param {number} last */
function additionalData(headerLine, index, last) {
  const position = Buffer.alloc(9);
  position.writeBigUInt64BE(BigInt(index));
  position[8] = last;
  return Buffer.concat([createHash("sha256").update(headerLine).digest(), position]);
}

/**
 * @param {Uint8Array} plain the plain bundle bytes
 * @param {string} passphrase
 * @param {{ random?: (size: number) => Buffer }} [options]
 * @returns {Buffer}
 */
export function sealBundle(plain, passphrase, options = {}) {
  const random = options.random ?? randomBytes;
  const salt = random(16);
  const header = { format: SEALED_FORMAT, version: 1, kdf: { ...KDF, salt: salt.toString("base64") }, cipher: "aes-256-gcm", chunk: CHUNK };
  const headerLine = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  const key = deriveKey(passphrase, salt, KDF);
  const frames = [headerLine];
  const source = Buffer.from(plain);
  const count = Math.max(1, Math.ceil(source.length / CHUNK));
  for (let index = 0; index < count; index += 1) {
    const last = index === count - 1 ? 1 : 0;
    const part = source.subarray(index * CHUNK, (index + 1) * CHUNK);
    const nonce = random(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(additionalData(headerLine, index, last));
    const body = Buffer.concat([cipher.update(part), cipher.final()]);
    const frame = Buffer.alloc(1 + 4 + 12 + 16);
    frame[0] = last;
    frame.writeUInt32BE(body.length, 1);
    nonce.copy(frame, 5);
    cipher.getAuthTag().copy(frame, 17);
    frames.push(frame, body);
  }
  return Buffer.concat(frames);
}

/**
 * @param {Uint8Array} sealed
 * @param {string} passphrase
 * @returns {Buffer} the plain bundle bytes
 */
export function unsealBundle(sealed, passphrase) {
  const bytes = Buffer.from(sealed);
  const newline = bytes.indexOf(0x0a);
  if (newline < 0 || newline > MAX_HEADER_BYTES || !isSealedBundle(bytes)) throw new TransferSealError("not_sealed", "this file is not a sealed Delegatus transfer");
  const headerLine = bytes.subarray(0, newline + 1);
  let header;
  try { header = JSON.parse(headerLine.toString("utf8")); } catch { header = null; }
  const kdf = header?.kdf;
  if (header?.format !== SEALED_FORMAT || header.version !== 1 || header.cipher !== "aes-256-gcm" || header.chunk !== CHUNK
    || kdf?.name !== "scrypt" || ![16384, 32768, 65536, 131072].includes(kdf.N) || kdf.r !== 8 || kdf.p !== 1 || typeof kdf.salt !== "string") {
    throw new TransferSealError("bad_header", "the sealed transfer names a format this Delegatus cannot open");
  }
  const key = deriveKey(passphrase, Buffer.from(kdf.salt, "base64"), kdf);
  const parts = [];
  let offset = newline + 1;
  let index = 0;
  let ended = false;
  while (offset < bytes.length) {
    if (ended || offset + 33 > bytes.length) throw new TransferSealError("truncated", "the sealed transfer is incomplete or has extra bytes");
    const last = bytes[offset];
    const length = bytes.readUInt32BE(offset + 1);
    const nonce = bytes.subarray(offset + 5, offset + 17);
    const tag = bytes.subarray(offset + 17, offset + 33);
    if (length > CHUNK || offset + 33 + length > bytes.length || (last !== 0 && last !== 1)) throw new TransferSealError("truncated", "the sealed transfer is incomplete");
    const body = bytes.subarray(offset + 33, offset + 33 + length);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(additionalData(headerLine, index, last));
      decipher.setAuthTag(tag);
      parts.push(decipher.update(body), decipher.final());
    } catch {
      throw new TransferSealError("wrong_passphrase_or_damaged", "the passphrase is wrong or the sealed transfer is damaged");
    }
    offset += 33 + length;
    index += 1;
    ended = last === 1;
  }
  if (!ended) throw new TransferSealError("truncated", "the sealed transfer ends before its last chunk");
  return Buffer.concat(parts);
}
