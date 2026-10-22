import { createHmac, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stateDir, statePath } from "@/lib/configDir";
import { hashToken, tokensMatch } from "@/lib/authToken";

export const OPERATOR_COOKIE = "llv_operator";
const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const KEY_FILE = "operator-session-key";

/** A separate private signing key survives Viewer restart and release succession.
 * Verification only reads it; an API request cannot establish a session. */
function signingKey(): Buffer | null {
  let descriptor: number;
  try {
    const filename = statePath(KEY_FILE);
    if (process.platform === "win32" && fs.lstatSync(filename).isSymbolicLink()) throw new Error("solo browser session signing key is linked");
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== 32 || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)) {
      throw new Error("solo browser session signing key is not a private 32-byte file");
    }
    const key = Buffer.alloc(32);
    if (fs.readSync(descriptor, key, 0, key.length, 0) !== key.length) throw new Error("solo browser session signing key is incomplete");
    return key;
  } finally { fs.closeSync(descriptor); }
}

function ensureSigningKey(): Buffer {
  const existing = signingKey();
  if (existing) return existing;
  const filename = statePath(KEY_FILE);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    try { fs.writeFileSync(descriptor, randomBytes(32)); }
    finally { fs.closeSync(descriptor); }
    // Publish a complete key once. Concurrent generations must use the same winner.
    try { fs.linkSync(temporary, filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { fs.rmSync(temporary, { force: true }); }
  const key = signingKey();
  if (!key) throw new Error("solo browser session signing key is unavailable");
  return key;
}

function signature(key: Buffer, expires: number): string {
  const scope = `${stateDir()}:${hashToken(process.env.LLV_TOKEN ?? "").toString("hex")}`;
  return createHmac("sha256", key).update(`solo-browser-session:v1:${scope}:${expires}`).digest("base64url");
}

export function soloBrowserSession(now = Date.now()): string {
  const expires = now + LIFETIME_MS;
  return `v1.${expires}.${signature(ensureSigningKey(), expires)}`;
}

export function verifySoloBrowserSession(value: string | undefined, now = Date.now()): boolean {
  const match = /^v1\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(value ?? "");
  if (!match) return false;
  const expires = Number(match[1]);
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now + LIFETIME_MS) return false;
  try {
    const key = signingKey();
    return !!key && tokensMatch(match[2]!, signature(key, expires));
  } catch { return false; }
}
