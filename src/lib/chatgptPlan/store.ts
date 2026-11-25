import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { statePath } from "@/lib/configDir";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { writeTextDurably } from "@/lib/state/durableJson";
import { ISSUER, PLAN_SCOPE, clientIdValid, object } from "./constants";
import { PlanError } from "./errors";

const MAX_BYTES = 64 * 1024;
export type TokenSet = {
  accessToken: string; refreshToken?: string; idToken: string; expiresAt: number;
  earliestRefreshAt?: number; scopes: string[]; refreshedAt: number;
};
export type Credentials = {
  version: 1; issuer: typeof ISSUER; clientId: string; savedAt: number;
  grantId?: string;
  subject?: string; email?: string; tokens?: TokenSet; models?: string[];
  pendingRegistration?: true; pendingRotation?: true;
  registrationMode?: "dynamic";
  signedOut?: true; revocationConfirmed?: boolean; acknowledged?: boolean;
  reconnect?: "reconnect_required" | "client_rejected";
  planPauseUntil?: number;
  planPauseReason?: "plan_limit" | "retry_later";
  pendingGrantRefresh?: string;
  pendingGrantClientId?: string;
  pendingClientId?: string;
  planRestriction?: "not_eligible" | "request_invalid" | "policy_denied";
};

const hasOwner = (uid: number) => !process.getuid || process.getuid() === uid;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
export const textField = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export const epoch = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const modelSlug = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);

async function privateDirectory(directory: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(directory, { mode: 0o700, recursive: true });
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || !hasOwner(stat.uid) || (stat.mode & 0o077)) throw new Error("unsafe directory");
    return true;
  } catch (error) {
    if (missing(error) && !create) return false;
    throw error;
  }
}

export class PlanStore {
  constructor(private readonly directory: () => string = () => statePath("chatgpt-plan")) {}

  async read(name: "host" | "credentials"): Promise<unknown> {
    const directory = this.directory();
    try {
      if (!await privateDirectory(directory, false)) return undefined;
      const file = await open(join(directory, `${name}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || !hasOwner(stat.uid) || stat.size > MAX_BYTES || (stat.mode & 0o077)) throw new Error("unsafe file");
        const bytes = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== stat.size) throw new Error("file changed");
        return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as unknown;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (missing(error)) return undefined;
      throw new PlanError(name === "host" ? "host_file" : "credential_file");
    }
  }

  async transaction<T>(name: "host" | "credentials", operation: () => Promise<T>, waitMs = 15_000): Promise<T> {
    const directory = this.directory();
    try { await privateDirectory(directory, true); }
    catch { throw new PlanError(name === "host" ? "host_file" : "credential_file"); }
    return withFileTransactionAsync(join(directory, `${name}.json`), "ChatGPT plan store busy", operation, { waitMs });
  }

  /** Called under the file transaction, after validating the existing record. */
  write(name: "host" | "credentials", value: unknown): void {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MAX_BYTES) throw new PlanError(name === "host" ? "host_file" : "credential_file");
    writeTextDurably(join(this.directory(), `${name}.json`), body);
  }

  async credentials(): Promise<Credentials | undefined> {
    const value = await this.read("credentials");
    if (value === undefined) return undefined;
    const row = object(value);
    const tokens = object(row?.tokens);
    if (!row || row.version !== 1 || row.issuer !== ISSUER || !clientIdValid(row.clientId) || !epoch(row.savedAt)
      || (row.email !== undefined && (typeof row.email !== "string" || row.email.length > 320))
      || (row.subject !== undefined && !textField(row.subject))
      || (row.planPauseUntil !== undefined && !epoch(row.planPauseUntil))
      || (row.planPauseReason !== undefined && row.planPauseReason !== "plan_limit" && row.planPauseReason !== "retry_later")
      || (row.pendingGrantRefresh !== undefined && !textField(row.pendingGrantRefresh))
      || (row.pendingGrantClientId !== undefined && !clientIdValid(row.pendingGrantClientId))
      || (row.pendingClientId !== undefined && !clientIdValid(row.pendingClientId))
      || (row.grantId !== undefined && !textField(row.grantId))
      || (row.planRestriction !== undefined && row.planRestriction !== "not_eligible" && row.planRestriction !== "request_invalid" && row.planRestriction !== "policy_denied")
      || (row.registrationMode !== undefined && row.registrationMode !== "dynamic")
      || (row.models !== undefined && (!Array.isArray(row.models) || row.models.length > 200 || !row.models.every(modelSlug)))
      || ["pendingRotation", "pendingRegistration", "signedOut"].some(key => row[key] !== undefined && row[key] !== true)
      || ["acknowledged", "revocationConfirmed"].some(key => row[key] !== undefined && typeof row[key] !== "boolean")
      || (row.reconnect !== undefined && row.reconnect !== "reconnect_required" && row.reconnect !== "client_rejected")
      || (row.pendingRotation && !tokens)
      || (row.registrationMode && !row.pendingRegistration)
      || (row.tokens !== undefined && (!tokens || !textField(row.subject) || !textField(tokens.accessToken)
        || !textField(tokens.idToken) || !epoch(tokens.expiresAt) || !epoch(tokens.refreshedAt)
        || (tokens.earliestRefreshAt !== undefined && !epoch(tokens.earliestRefreshAt))
        || !Array.isArray(tokens.scopes) || !tokens.scopes.every(textField)
        || ((tokens.refreshToken !== undefined || row.pendingRotation || tokens.scopes.includes(PLAN_SCOPE))
          && !textField(tokens.refreshToken))))) throw new PlanError("credential_file");
    return value as Credentials;
  }
}
