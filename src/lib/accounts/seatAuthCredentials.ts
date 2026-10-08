import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { listClaudeAccounts, claudeHomeOwningTranscript } from "./claude";
import { listCodexAccounts, codexHomeOwningSessionPath } from "./codex";
import { readClaudeCredentials, claudeKeychainCredentialChangedAt } from "./claudeCredentials";
import { providerCredentialRevision, providerCredentialChangedAt } from "./claudeProviderHealth";

const credentialAccounts = (engine: "claude" | "codex") => engine === "claude" ? listClaudeAccounts() : listCodexAccounts();

export interface SeatAuthCredentialBaseline {
  engine: "claude" | "codex";
  accountId: string;
  stamp: string;
  scope: string;
}

export function normalizeSeatAuthCredentialBaseline(value: unknown): SeatAuthCredentialBaseline | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Partial<SeatAuthCredentialBaseline>;
  if ((row.engine !== "claude" && row.engine !== "codex") || typeof row.accountId !== "string" || !row.accountId
    || typeof row.stamp !== "string" || typeof row.scope !== "string" || !row.scope.startsWith("seat-auth-baseline:")) return undefined;
  return { engine: row.engine, accountId: row.accountId, stamp: row.stamp, scope: row.scope };
}

/** Remember credential contents when the seat becomes readable, before its tick. */
export function captureSeatAuthCredentialBaseline(engine: string | null | undefined, transcript: string | null, scope: string): SeatAuthCredentialBaseline | undefined {
  if ((engine !== "claude" && engine !== "codex") || !transcript) return undefined;
  const home = engine === "claude" ? claudeHomeOwningTranscript(transcript) : codexHomeOwningSessionPath(transcript);
  const account = home ? credentialAccounts(engine).find(row => row.home === home) : null;
  if (!account) return undefined;
  const stamp = seatAuthCredentialStamp(engine, account.id, scope);
  return stamp ? { engine, accountId: account.id, stamp, scope } : undefined;
}

function readableCredentialFile(file: string): { content: string; modifiedAt: number } | null {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== (process.getuid?.() ?? stat.uid) || (stat.mode & 0o077) !== 0
      || (stat.mode & 0o400) === 0 || stat.size > 1024 * 1024) return null;
    return { content: fs.readFileSync(descriptor, "utf8"), modifiedAt: stat.mtimeMs };
  } catch { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

export function seatAuthCredentialStamp(engine: "claude" | "codex", accountId: string | null, incidentId: string): string | null {
  if (!accountId) return null;
  const account = credentialAccounts(engine).find((row) => row.id === accountId);
  if (!account) return null;
  const fingerprint = (value: unknown) => createHmac("sha256", incidentId).update(JSON.stringify(value)).digest("hex");
  if ("provider" in account && account.provider) {
    const revision = providerCredentialRevision(account.home);
    const changedAt = providerCredentialChangedAt(account.home);
    if (!revision || changedAt === null) return null;
    const token = readableCredentialFile(path.join(account.home, ".provider-token"));
    const runtime = readableCredentialFile(path.join(account.home, ".provider-runtime"));
    const headersFile = path.join(account.home, ".provider-headers");
    const headers = fs.existsSync(headersFile) ? readableCredentialFile(headersFile) : undefined;
    if (!token || !runtime || headers === null || revision !== providerCredentialRevision(account.home)) return null;
    return `${changedAt}:provider:${fingerprint([token.content, runtime.content, headers?.content ?? null])}`;
  }
  if (engine === "claude") {
    const credential = readClaudeCredentials(account.home);
    if (credential.state !== "present") return null;
    if (credential.source === "keychain") {
      // A Keychain login has no file timestamp. Retain only an incident-scoped
      // fingerprint, never the document or the request-local account identity.
      const changedAt = claudeKeychainCredentialChangedAt(account.home);
      return `${changedAt ?? "unknown"}:keychain:${fingerprint(credential.document)}`;
    }
  }
  const file = readableCredentialFile(path.join(account.home, engine === "claude" ? ".credentials.json" : "auth.json"));
  if (!file) return null;
  try {
    const document: unknown = JSON.parse(file.content);
    if (!document || typeof document !== "object" || Array.isArray(document)) return null;
    return `${file.modifiedAt}:file:${fingerprint(document)}`;
  } catch { return null; }
}

export function seatAuthCredentialChangedAt(stamp: string | null): number | null {
  const timestamp = Number(stamp?.split(":")[0]);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

export function seatAuthCredentialsChanged(before: string | null, after: string | null): boolean {
  if (after === null || before === after) return false;
  // Metadata can change independently of credentials. Only their contents,
  // fingerprinted for this incident, prove a repair after first detection.
  const fingerprint = (stamp: string | null) => stamp?.match(/^(?:unknown|\d+(?:\.\d+)?):(?:file|keychain|provider):([a-f0-9]{64})$/)?.[1] ?? null;
  const previous = fingerprint(before);
  const current = fingerprint(after);
  return !previous || !current || previous !== current;
}
