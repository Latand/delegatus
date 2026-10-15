import type { RuntimeHostClient } from "./client";
import { RUNTIME_SCHEMA_VERSION, type RuntimeSession, type RuntimeSnapshot } from "./contracts";

export const SNAPSHOT_ACTIVITY_LIMIT = 64;
export const SNAPSHOT_ACTIVITY_FIELDS = ["conversationId", "host", "turn", "attentionIds"] as const;
export const SNAPSHOT_OWNER_FIELDS = ["conversationId", "sessionKey", "artifactPath", "cwd", "host", "turn",
  "activeTurnId", "revision", "writerClaim", "writerStatus", "nativeTurnClaims"] as const;
export type RuntimeActivitySession = Pick<RuntimeSession, typeof SNAPSHOT_ACTIVITY_FIELDS[number]>;
export type RuntimeOwnerSession = Pick<RuntimeSession, typeof SNAPSHOT_OWNER_FIELDS[number]>;
export type RuntimeSnapshotMetadata = Pick<RuntimeSnapshot,
  "schemaVersion" | "snapshotSeq" | "retentionFloorSeq" | "runtime" | "filesRevision">;
export interface RuntimeSnapshotReads {
  metadata: RuntimeSnapshotMetadata;
  activity: RuntimeSnapshotMetadata & { sessions: RuntimeActivitySession[] };
  owners: RuntimeSnapshotMetadata & { sessions: RuntimeOwnerSession[] };
}
export type RuntimeSnapshotReadKind = keyof RuntimeSnapshotReads;
export interface RuntimeSnapshotReadRequest {
  version: 1;
  kind: RuntimeSnapshotReadKind;
  /** Activity only. Omitted reads the current snapshot population; a supplied
   * list selects at most 64 published conversation identities from it. */
  conversationIds?: readonly string[];
}

export function parseSnapshotReadRequest(value: unknown): RuntimeSnapshotReadRequest {
  const request = value as RuntimeSnapshotReadRequest | null;
  if (!request || request.version !== 1 || !["metadata", "activity", "owners"].includes(request.kind)
    || (request.kind === "activity"
      ? request.conversationIds !== undefined && (!Array.isArray(request.conversationIds) || request.conversationIds.length > SNAPSHOT_ACTIVITY_LIMIT
        || request.conversationIds.some(id => typeof id !== "string" || !id.trim() || id.length > 256))
      : request.conversationIds !== undefined)) throw new Error("runtime snapshot read is invalid");
  return request;
}

function pick<T, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value as object, key)).map(key => [key, value[key]])) as Pick<T, K>;
}

/** Also projects the response of a previous host that ignores snapshotRead.
 * Each answer identifies its shape; capability/data are never cached across
 * succession, and an error never triggers a second population request. */
export function projectSnapshotRead<K extends RuntimeSnapshotReadKind>(
  value: unknown, kind: K, conversationIds?: readonly string[],
): RuntimeSnapshotReads[K] {
  const snapshot = value as RuntimeSnapshotMetadata & { sessions?: RuntimeSession[]; snapshotRead?: RuntimeSnapshotReadRequest };
  if (!snapshot || snapshot.schemaVersion !== RUNTIME_SCHEMA_VERSION
    || !Number.isSafeInteger(snapshot.snapshotSeq) || snapshot.snapshotSeq < 0
    || !Number.isSafeInteger(snapshot.retentionFloorSeq) || snapshot.retentionFloorSeq < 0
    || snapshot.retentionFloorSeq > snapshot.snapshotSeq
    || !Number.isSafeInteger(snapshot.filesRevision) || snapshot.filesRevision < 0
    || !Number.isSafeInteger(snapshot.runtime?.hostEpoch) || snapshot.runtime.hostEpoch < 0
    || typeof snapshot.runtime.health !== "string"
    || snapshot.snapshotRead && (snapshot.snapshotRead.version !== 1 || snapshot.snapshotRead.kind !== kind)) {
    throw new Error("runtime snapshot read response is invalid");
  }
  const metadata = pick(snapshot, ["schemaVersion", "snapshotSeq", "retentionFloorSeq", "runtime", "filesRevision"]);
  if (kind === "metadata") return metadata as RuntimeSnapshotReads[K];
  if (!Array.isArray(snapshot.sessions)) throw new Error("runtime snapshot read sessions are invalid");
  const ids = new Set(conversationIds);
  const sessions = snapshot.sessions;
  // Do not replace missing evidence with defaults: a malformed answer must
  // remain unreadable to liveness and restart admission.
  for (const session of sessions) {
    if (!session || typeof session.conversationId !== "string"
      || !["registering", "hosted", "recovering", "unhosted", "conflict", "dead"].includes(session.host)
      || !["unknown", "idle", "running", "interrupt_requested"].includes(session.turn)
      || (kind === "activity" ? !Array.isArray(session.attentionIds) || session.attentionIds.some(id => typeof id !== "string")
        : !session.sessionKey || typeof session.sessionKey.sessionId !== "string" || !Number.isSafeInteger(session.revision)
          || !(session.activeTurnId === null || typeof session.activeTurnId === "string")
          || !(session.artifactPath === null || typeof session.artifactPath === "string")
          || !(session.cwd === null || typeof session.cwd === "string"))) {
      throw new Error("runtime snapshot read session is invalid");
    }
  }
  if (snapshot.snapshotRead && kind === "activity" && conversationIds !== undefined
    && sessions.some(session => !ids.has(session.conversationId))) {
    throw new Error("runtime snapshot read scope mismatch");
  }
  // Journal scopes can publish the same conversation identity. The request
  // limit bounds identities; retain every matching row in snapshot order.
  const selected = kind === "activity" && conversationIds !== undefined ? sessions.filter(session => ids.has(session.conversationId)) : sessions;
  return { ...metadata, sessions: selected.map(session => kind === "activity"
    ? pick(session, SNAPSHOT_ACTIVITY_FIELDS) : pick(session, SNAPSHOT_OWNER_FIELDS)) } as RuntimeSnapshotReads[K];
}

export async function readRuntimeSnapshot<K extends RuntimeSnapshotReadKind>(
  client: RuntimeHostClient, kind: K, conversationIds?: readonly string[],
): Promise<RuntimeSnapshotReads[K]> {
  if (client.readSnapshot) return client.readSnapshot(kind, conversationIds);
  return projectSnapshotRead(await client.snapshot(undefined, { voiceBodiesFor: [] }), kind, conversationIds);
}
