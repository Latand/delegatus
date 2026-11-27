import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { projectAliasResolver } from "@/lib/projects/aliases";
import { isStagingMode } from "@/lib/staging";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized, type StateCollectionSeed } from "@/lib/state/sqliteStateStore";
import { resolveSecretDestination, UNSAFE_TEXT } from "./destination";
import { SecretRequestError, secretError, type SecretActor, type SecretDestination, type SecretFormat, type SecretRefusal, type SecretRequester, type SecretRequestRecord, type SecretState } from "./types";

const COLLECTION = "secret-requests";
const BUSY = "secret requests are busy";
const WAIT_MS = 5_000;
const DAY = 86_400_000;

const seed: StateCollectionSeed<SecretRequestRecord> = {
  collection: COLLECTION,
  schemaVersion: 1,
  migrationId: "secret-requests-v1",
  loadRecords: () => [],
  key: record => record.id,
};

let held: { filename: string; identity: string; store: SqliteStateCollection<SecretRequestRecord> } | undefined;

function decode(value: unknown): SecretRequestRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<SecretRequestRecord>;
  if (typeof row.id !== "string" || !/^sr_[a-f0-9]{32}$/.test(row.id)
    || !row.requester || !row.target || !row.destination || typeof row.destination.path !== "string"
    || !path.isAbsolute(row.destination.path) || path.resolve(row.destination.path) !== row.destination.path
    || !Array.isArray(row.transitions) || !row.transitions.length || !Array.isArray(row.refusals)
    || typeof row.expiresAt !== "number") return null;
  if (row.state === "writing" && (!row.write || !/^[a-f0-9]{32}$/.test(row.write.id) || !row.write.parent)) return null;
  if (row.state === "entered" && (!row.file || typeof row.length !== "number")) return null;
  return row.state && ["pending", "writing", "entered", "cancelled", "expired"].includes(row.state) ? row as SecretRequestRecord : null;
}

function databaseIdentity(filename: string): string {
  try {
    const stat = fs.statSync(filename, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch { return ""; }
}

function collection(create: true): SqliteStateCollection<SecretRequestRecord>;
function collection(create: false): SqliteStateCollection<SecretRequestRecord> | null;
function collection(create: boolean) {
  const filename = statePath("state.sqlite");
  const identity = databaseIdentity(filename);
  if (held && held.filename === filename && held.identity === identity) return held.store;
  if (!create && (!identity || !stateCollectionsInitialized(filename, [seed]))) return null;
  if (create) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    initializeStateCollections(filename, [seed]);
  }
  const store = new SqliteStateCollection<SecretRequestRecord>(filename, {
    collection: COLLECTION,
    schemaVersion: seed.schemaVersion,
    busyMessage: BUSY,
    key: seed.key,
    decode,
    clone: structuredClone,
    preserveRejectedRecords: true,
  });
  held = { filename, identity: databaseIdentity(filename), store };
  return store;
}

export function findSecretRequestRecord(id: string): SecretRequestRecord | null {
  return collection(false)?.get(id) ?? null;
}

export async function secretRequestRecords(): Promise<readonly SecretRequestRecord[]> {
  return await collection(false)?.loadReadonlyAsync() ?? [];
}

export async function writingSecretRequests(): Promise<SecretRequestRecord[]> {
  const records = await collection(false)?.loadReadonlyAsync() ?? [];
  return records.filter(row => row.state === "writing").map(row => structuredClone(row));
}

export async function updateSecretRequest<T extends SecretRequestRecord>(
  id: string, update: (record: SecretRequestRecord) => T, terminalAt?: number,
): Promise<T> {
  const store = collection(true);
  if (terminalAt !== undefined) return store.mutate((rows, persist) => {
    const position = rows.findIndex(row => row.id === id);
    if (position === -1) throw new SecretRequestError("secret_not_pending");
    const record = rows[position];
    const next = update(record);
    if (next === record) return next;
    rows[position] = next;
    return persist(retainedRecords(rows, terminalAt)).then(() => next);
  }, undefined, false, WAIT_MS);
  return store.boundedPatchAsync(2, tx => {
    const record = tx.get(id);
    if (!record) throw new SecretRequestError("secret_not_pending");
    const next = update(record);
    if (next !== record) tx.put(next);
    return next;
  }, WAIT_MS);
}

function retainedRecords(rows: SecretRequestRecord[], now: number) {
  const terminal = rows.filter(row => row.state === "entered" || row.state === "cancelled" || row.state === "expired")
    .sort((a, b) => b.transitions.at(-1)!.at - a.transitions.at(-1)!.at || a.id.localeCompare(b.id));
  const prune = new Set(terminal.filter((row, index) => index >= 500 || row.transitions.at(-1)!.at < now - 90 * DAY).map(row => row.id));
  return rows.filter(row => !prune.has(row.id));
}

export function transition(record: SecretRequestRecord, state: SecretState, actor: SecretActor, at: number) {
  return [...record.transitions, { at, state, actor }];
}

export function entryRefusals(record: SecretRequestRecord, code: SecretRefusal, at: number) {
  return [...record.refusals.slice(-9), { at, code }];
}

export function auditTransition(record: SecretRequestRecord) {
  console.info(`[secret-request] ${record.id} ${record.state} ${record.destination.effect}`);
}

export interface CreateSecretRequest {
  clientRequestId: string;
  purpose: string;
  destination: SecretDestination;
  format?: SecretFormat;
  minLength?: number;
  expiresInMinutes?: number;
  taskId?: string;
}

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const unsafePurpose = new RegExp(UNSAFE_TEXT.source, "gu");

export async function createSecretRequest(
  caller: { project: string; requester: SecretRequester }, input: CreateSecretRequest, now = Date.now(),
): Promise<SecretRequestRecord> {
  try {
    if (isStagingMode()) throw new SecretRequestError("staging");
    const { project, requester } = caller;
    const { clientRequestId, minLength, expiresInMinutes = 1440, format = "line", destination } = input;
    if (typeof clientRequestId !== "string" || !clientRequestId || typeof input.purpose !== "string"
      || !destination || typeof destination.path !== "string" || !["file", "env"].includes(destination.kind)
      || (destination.kind === "env" && typeof destination.key !== "string")
      || (destination.kind === "file" && ((destination.replace !== undefined && typeof destination.replace !== "boolean")
        || (destination.trailingNewline !== undefined && typeof destination.trailingNewline !== "boolean")))
      || (format !== "line" && format !== "token")
      || (minLength !== undefined && (!Number.isInteger(minLength) || minLength < 1 || minLength > 256))
      || !Number.isInteger(expiresInMinutes) || expiresInMinutes < 5 || expiresInMinutes > 10_080) {
      throw new SecretRequestError("secret_request_input");
    }
    const purpose = input.purpose.replace(unsafePurpose, "").trim();
    if (!purpose || [...purpose].length > 300) throw new SecretRequestError("secret_request_input");

    const target: SecretDestination = destination.kind === "env"
      ? { kind: "env", path: destination.path, key: destination.key }
      : { kind: "file", path: destination.path, replace: destination.replace ?? false, trailingNewline: destination.trailingNewline ?? true };
    const taskId = input.taskId ?? requester.stage?.taskId ?? null;
    if (taskId !== null && typeof taskId !== "string") throw new SecretRequestError("secret_request_input");
    const id = "sr_" + sha256(`secret-request-v1:${requester.conversationId}:${clientRequestId}`).slice(0, 32);
    const argumentDigest = sha256(JSON.stringify([input.purpose, target, format, minLength ?? null, expiresInMinutes, input.taskId ?? null]));
    const replay = (row: SecretRequestRecord) => {
      if (row.argumentDigest !== argumentDigest) throw new SecretRequestError("idempotency_conflict");
      return row;
    };
    const found = findSecretRequestRecord(id);
    if (found) return replay(found);
    const resolved = await resolveSecretDestination(project, target);
    const canonical = projectAliasResolver();
    const created: SecretRequestRecord = {
      id, argumentDigest, project, requester, taskId, purpose, target, format, minLength,
      createdAt: now, expiresAt: now + expiresInMinutes * 60_000,
      destination: resolved.destination, destinationRevision: resolved.revision,
      state: "pending", transitions: [{ at: now, state: "pending", actor: "requester" }], refusals: [],
    };

    const saved = await collection(true).mutate((rows, persist) => {
      const old = rows.find(row => row.id === id);
      if (old) return replay(old);
      const open = rows.filter(row => row.state === "writing" || (row.state === "pending" && row.expiresAt > now));
      if (open.filter(row => row.requester.conversationId === requester.conversationId).length >= 3
        || open.filter(row => canonical(row.project) === canonical(project)).length >= 10) {
        throw new SecretRequestError("secret_too_many_open");
      }
      return persist(retainedRecords([...rows, created], now)).then(() => created);
    }, undefined, false, WAIT_MS);
    if (saved === created) auditTransition(created);
    return saved;
  } catch (error) {
    throw secretError(error, "secret_request_unavailable");
  }
}
