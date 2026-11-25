import { SecretRequestError } from "./types";

export const ENV_FILE_LIMIT = 1024 * 1024;
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const EXPORT = Buffer.from("export");

interface EnvScan {
  definition: { valueFrom: number; to: number } | null;
  newline: "\r\n" | "\n";
}

function horizontal(byte: number): boolean {
  return byte === 32 || byte === 9;
}

function keyByte(byte: number): boolean {
  return byte === 95 || (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
}

function lineEnd(bytes: Buffer, from: number): number {
  const lf = bytes.indexOf(10, from);
  return lf === -1 ? bytes.length : lf;
}

/** Keep byte offsets so the unedited file never needs decoding or re-encoding. */
export function scanEnvFile(bytes: Buffer, key: string): EnvScan {
  if (bytes.length > ENV_FILE_LIMIT) throw new SecretRequestError("secret_env_unparsed");
  if (!ENV_KEY.test(key)) throw new SecretRequestError("secret_env_key_invalid");
  const firstLf = bytes.indexOf(10);
  const newline = firstLf > 0 && bytes[firstLf - 1] === 13 ? "\r\n" : "\n";
  const wanted = Buffer.from(key);
  let definition: EnvScan["definition"] = null;
  let from = 0;
  while (from < bytes.length) {
    // Retain a UTF-8 BOM at the start even when the first assignment changes.
    let cursor = from === 0 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : from;
    while (horizontal(bytes[cursor])) cursor++;
    if (bytes.subarray(cursor, cursor + EXPORT.length).equals(EXPORT) && horizontal(bytes[cursor + EXPORT.length])) {
      cursor += 6;
      while (horizontal(bytes[cursor])) cursor++;
    }
    const nameFrom = cursor;
    while (keyByte(bytes[cursor])) cursor++;
    const nameTo = cursor;
    while (horizontal(bytes[cursor])) cursor++;
    if (nameTo === nameFrom || bytes[cursor] !== 61) {
      from = lineEnd(bytes, cursor) + 1;
      continue;
    }
    const valueFrom = ++cursor;
    while (horizontal(bytes[cursor])) cursor++;
    const quote = bytes[cursor];
    if (quote === 34 || quote === 39 || quote === 96) {
      cursor++;
      while (cursor < bytes.length && bytes[cursor] !== quote) {
        cursor += bytes[cursor] === 92 ? 2 : 1;
      }
      if (cursor >= bytes.length) throw new SecretRequestError("secret_env_unparsed");
      cursor++;
    }
    const end = lineEnd(bytes, cursor);
    if (bytes.subarray(nameFrom, nameTo).equals(wanted)) {
      if (definition) throw new SecretRequestError("secret_env_key_duplicated");
      definition = { valueFrom, to: end > from && bytes[end - 1] === 13 ? end - 1 : end };
    }
    from = end + 1;
  }
  return { definition, newline };
}

const BARE_PUNCTUATION = Buffer.from("_./:@%+=,-~");
function needsQuotes(value: Uint8Array): boolean {
  let quoted = false;
  for (const byte of value) {
    if (byte === 39 || byte === 92 || byte === 36 || byte === 10 || byte === 13) {
      throw new SecretRequestError("secret_env_value_unquotable");
    }
    if (!(keyByte(byte) || BARE_PUNCTUATION.includes(byte))) quoted = true;
  }
  return quoted;
}

export function composeEnvFile(bytes: Buffer, key: string, value: Uint8Array): Buffer {
  const { definition, newline } = scanEnvFile(bytes, key);
  const quote = needsQuotes(value) ? "'" : "";
  const closing = Buffer.from(quote);
  if (definition) return Buffer.concat([
    bytes.subarray(0, definition.valueFrom), closing, value, closing, bytes.subarray(definition.to),
  ]);
  const separator = bytes.length && bytes.at(-1) !== 10 ? newline : "";
  return Buffer.concat([bytes, Buffer.from(`${separator}${key}=${quote}`), value, Buffer.from(quote + newline)]);
}
