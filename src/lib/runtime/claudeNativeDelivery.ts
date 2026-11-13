import { normalizeQueueEntry, type NormalizedQueueEntry, type QueueEntry } from "./engineHost";
import type { ClaudeDeliveryRecord, ClaudeDeliveryState, ClaudeTranscriptUser } from "./claudeStreamBrokerHost";
import { structuredContent } from "./structuredContent";

export interface ClaudeNativeWriter {
  sessionId: string;
  writerId: string;
  process: { pid: number; startIdentity: string };
}

export interface ClaudeNativeInput extends ClaudeNativeWriter {
  version: 1;
  inputUuid: string;
  intent: "may-have-written";
}

export interface ClaudeNativeResult extends ClaudeNativeWriter {
  version: 1;
  resultUuid: string;
  inputUuids: string[];
  turnId: string;
  status: "completed";
}

/** A terminal anchor closes only its owning turn. It supplies no batch
 * membership and cannot settle any delivery receipt. */
export interface ClaudeNativeTurnBoundary extends ClaudeNativeWriter {
  version: 1;
  resultUuid: string;
  inputUuid: string;
  turnId: string;
  status: "completed" | "interrupted" | "error";
}

export function nativeTurnBoundary(value: unknown): ClaudeNativeTurnBoundary | null {
  const row = object(value), writer = nativeWriter(value);
  return row?.version === 1 && writer && claudeNativeUuid(row.resultUuid) && claudeNativeUuid(row.inputUuid)
    && typeof row.turnId === "string" && row.turnId.length > 0 && row.turnId.length <= 512
    && ["completed", "interrupted", "error"].includes(String(row.status))
    ? { ...writer, version: 1, resultUuid: row.resultUuid, inputUuid: row.inputUuid,
      turnId: row.turnId, status: row.status as ClaudeNativeTurnBoundary["status"] } : null;
}

export function nativeTurnBoundaryMember(states: readonly ClaudeDeliveryState[], proof: ClaudeNativeTurnBoundary): ClaudeDeliveryState | null {
  return states.find(state => state.entry.id === proof.turnId && state.native?.inputUuid === proof.inputUuid
    && sameNativeWriter(state.native, proof) && !state.nativeNoWrite && !state.nativeUnverified
    && !state.nativeResult && !state.nativeTerminal) ?? null;
}

export type ClaudeNativeTerminal = Omit<ClaudeNativeResult, "status"> & { status: "interrupted" | "error" };

export function nativeTerminal(value: unknown): ClaudeNativeTerminal | null {
  const row = object(value);
  if (!row || row.status !== "interrupted" && row.status !== "error") return null;
  const parsed = nativeResult({ ...row, status: "completed" });
  return parsed ? { ...parsed, status: row.status } : null;
}

export interface ClaudeNativeConsumed extends ClaudeNativeWriter {
  version: 1;
  inputUuid: string;
  canonicalUuid: string;
  entryId: string;
  contentDigest: string;
  /** An input written at idle already owns its initial batch. Queued echoes
   * retain null until a result identifies which batch consumed them. */
  turnId: string | null;
  /** Canonical replay shape only. Every member still needs its independent
      terminal identity proof before this manifest can reach the feed. */
  mergedInputUuids?: string[];
  mergedContentDigest?: string;
}

export function nativeConsumed(value: unknown): ClaudeNativeConsumed | null {
  const row = object(value);
  const writer = nativeWriter(value);
  const merged = row?.mergedInputUuids === undefined && row?.mergedContentDigest === undefined ? undefined : nativeUuids(row?.mergedInputUuids);
  if (merged !== undefined && (!merged || merged.length < 2 || merged.at(-1) !== row?.inputUuid
    || typeof row?.mergedContentDigest !== "string" || !/^[0-9a-f]{64}$/.test(row.mergedContentDigest))) return null;
  return row?.version === 1 && writer && claudeNativeUuid(row.inputUuid)
    && row.canonicalUuid === row.inputUuid && typeof row.entryId === "string" && row.entryId.length > 0
    && typeof row.contentDigest === "string" && /^[0-9a-f]{64}$/.test(row.contentDigest)
    && (row.turnId === null || row.turnId === row.entryId)
    ? { ...writer, version: 1, inputUuid: row.inputUuid, canonicalUuid: row.inputUuid,
      entryId: row.entryId, contentDigest: row.contentDigest, turnId: row.turnId as string | null,
      ...(merged ? { mergedInputUuids: merged, mergedContentDigest: row.mergedContentDigest as string } : {}) } : null;
}

export function nativeMergedContent(states: readonly ClaudeDeliveryState[]) {
  return structuredContent(states.map((state, index) => state.entry.content.text
    + (index < states.length - 1 && state.entry.content.text ? "\n" : "")).join(""),
  states.flatMap(state => state.entry.content.images));
}

export function nativeMergedMembers(states: readonly ClaudeDeliveryState[], evidence: ClaudeNativeConsumed): ClaudeDeliveryState[] | null {
  const ids = evidence.mergedInputUuids;
  if (!ids || ids.at(-1) !== evidence.inputUuid) return null;
  const members = states.filter(state => ids.includes(state.native?.inputUuid ?? ""));
  if (members.length !== ids.length || members.some((state, index) => !state.native || state.nativeUnverified || state.nativeNoWrite
    || !sameNativeWriter(state.native, evidence) || state.native.inputUuid !== ids[index])
    || members.at(-1)?.entry.id !== evidence.entryId) return null;
  return nativeMergedContent(members).contentDigest === evidence.mergedContentDigest ? members : null;
}

export const CLAUDE_NATIVE_INPUT_LIMIT = 3;
export const claudeNativeUuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function nativeWriter(value: unknown): ClaudeNativeWriter | null {
  const row = object(value);
  const process = object(row?.process);
  return row && claudeNativeUuid(row.sessionId) && claudeNativeUuid(row.writerId)
    && Number.isSafeInteger(process?.pid) && Number(process?.pid) > 0
    && typeof process?.startIdentity === "string" && process.startIdentity.length > 0 && process.startIdentity.length <= 256
    ? { sessionId: row.sessionId, writerId: row.writerId, process: { pid: Number(process.pid), startIdentity: process.startIdentity } } : null;
}

export function nativeInput(value: unknown): ClaudeNativeInput | null {
  const row = object(value);
  const writer = nativeWriter(value);
  return row?.version === 1 && row.intent === "may-have-written" && claudeNativeUuid(row.inputUuid) && writer
    ? { ...writer, version: 1, inputUuid: row.inputUuid, intent: "may-have-written" } : null;
}

export function nativeUuids(value: unknown): string[] | null {
  return Array.isArray(value) && value.length > 0 && value.length <= CLAUDE_NATIVE_INPUT_LIMIT
    && value.every(claudeNativeUuid) && new Set(value).size === value.length ? [...value] : null;
}

export function nativeResult(value: unknown): ClaudeNativeResult | null {
  const row = object(value);
  const writer = nativeWriter(value);
  const inputs = nativeUuids(row?.inputUuids);
  return row?.version === 1 && writer && inputs && claudeNativeUuid(row.resultUuid)
    && typeof row.turnId === "string" && row.turnId.length > 0 && row.turnId.length <= 512 && row.status === "completed"
    ? { ...writer, version: 1, inputUuids: inputs, resultUuid: row.resultUuid, turnId: row.turnId, status: "completed" } : null;
}

export function sameNativeWriter(left: ClaudeNativeWriter, right: ClaudeNativeWriter): boolean {
  return left.sessionId === right.sessionId && left.writerId === right.writerId
    && left.process.pid === right.process.pid && left.process.startIdentity === right.process.startIdentity;
}

/** A boundary consumes an ordered prefix of this writer's outstanding inputs.
 * Neither an echo nor an assistant's singular anchor can remove an input. */
export function nativeResultMembers(states: readonly ClaudeDeliveryState[], proof: ClaudeNativeResult): ClaudeDeliveryState[] | null {
  const outstanding = states.filter(state => state.native && sameNativeWriter(state.native, proof) && !state.nativeResult && !state.nativeTerminal && !state.nativeTurnBoundary && !state.nativeNoWrite);
  const members = outstanding.slice(0, proof.inputUuids.length);
  return members.length === proof.inputUuids.length && members[0]?.entry.id === proof.turnId
    && members.every((state, index) => !state.nativeUnverified && state.native!.inputUuid === proof.inputUuids[index])
    ? members : null;
}

/** Strictly top-level, owned-stream success evidence on the verified CLI.
 * Other terminal branches retain uncertainty until independently verified. */
export function nativeBoundary(frame: Record<string, unknown>, writer: ClaudeNativeWriter,
  turnId: string, states: readonly ClaudeDeliveryState[]): ClaudeNativeResult | null {
  const inputs = nativeUuids(frame.user_message_uuids);
  if (frame.type !== "result" || frame.session_id !== writer.sessionId || frame.parent_tool_use_id != null
    || frame.agent_id != null || frame.is_error === true || frame.aborted === true || frame.error != null
    || frame.subtype !== "success" || !claudeNativeUuid(frame.uuid) || !inputs
    || frame.user_message_uuid != null && !inputs.includes(String(frame.user_message_uuid))) return null;
  const proof: ClaudeNativeResult = { ...writer, version: 1, resultUuid: frame.uuid, inputUuids: inputs, turnId, status: "completed" };
  return nativeResultMembers(states, proof) ? proof : null;
}

/** Durable explicit membership can prove arrival, while terminal ownership
 * remains pending. A canonical row belongs only to its own supplied UUID. */
export function nativeTranscriptMembers(states: readonly ClaudeDeliveryState[], user: ClaudeTranscriptUser,
  sessionId: string): ClaudeDeliveryState[] | null {
  if (!user.prompt || user.nativeIdentityInvalid || user.sessionId !== sessionId || !claudeNativeUuid(user.uuid)) return null;
  const ids = [...(user.mergedSendUuids ?? []), user.uuid];
  if (!nativeUuids(ids)) return null;
  const members = ids.map(id => states.find(state => state.native?.inputUuid === id));
  const first = members[0]?.native;
  if (!first || members.some(state => !state?.native || state.nativeUnverified || state.nativeNoWrite
    || !sameNativeWriter(state.native, first))) return null;
  const ordered = states.filter(state => ids.includes(state.native?.inputUuid ?? ""));
  return ordered.every((state, index) => state === members[index]) ? ordered : null;
}

export function sameNormalizedEntry(left: NormalizedQueueEntry, right: NormalizedQueueEntry): boolean {
  return left.id === right.id
    && left.contentDigest === right.contentDigest
    && left.expectedTurnId === right.expectedTurnId
    && JSON.stringify(left.parts) === JSON.stringify(right.parts);
}

export function deliveryRecord(value: unknown): ClaudeDeliveryRecord | null {
  const candidate = object(value);
  if (candidate?.kind === "native-turn-boundary" && object(candidate.evidence)) return candidate as unknown as ClaudeDeliveryRecord;
  if (candidate?.kind === "native-terminal" && object(candidate.evidence)) return candidate as unknown as ClaudeDeliveryRecord;
  if (candidate?.kind === "native-consumed" && object(candidate.evidence)) return candidate as unknown as ClaudeDeliveryRecord;
  if (candidate?.kind === "native-result" && object(candidate.proof)) return candidate as unknown as ClaudeDeliveryRecord;
  if (candidate?.kind === "native-no-write" && typeof candidate.entryId === "string" && typeof candidate.inputUuid === "string") return candidate as unknown as ClaudeDeliveryRecord;
  if (candidate?.kind === "queued") {
    const entry = object(candidate.entry);
    if (typeof entry?.id !== "string" || !entry.id) return null;
    if (candidate.disposition !== "turn-started" && candidate.disposition !== "queued-next-turn") return null;
    if (typeof candidate.queuedAt !== "string") return null;
    try {
      return { ...candidate, entry: normalizeQueueEntry(entry as unknown as QueueEntry) } as ClaudeDeliveryRecord;
    } catch {
      return null;
    }
  }
  if (candidate?.kind === "delivered"
    && typeof candidate.entryId === "string"
    && (typeof candidate.engineMessageId === "string" || candidate.engineMessageId === null)
    && typeof candidate.deliveredAt === "string"
    && (candidate.confirmation === undefined || candidate.confirmation === "operation-bound" || candidate.confirmation === "inferred" || candidate.confirmation === "unverified")) return candidate as unknown as ClaudeDeliveryRecord;
  return null;
}

export function parseDeliveryRecords(contents: string): ClaudeDeliveryRecord[] {
  const records: ClaudeDeliveryRecord[] = [];
  const lines = contents.split("\n");
  const terminated = contents.endsWith("\n");
  if (!contents) return records;
  for (const [index, line] of lines.entries()) {
    if (!line && index === lines.length - 1 && terminated) continue;
    if (!line) throw new Error("Claude delivery ledger contains an empty record");
    let value: unknown;
    try { value = JSON.parse(line); }
    catch {
      if (index === lines.length - 1 && !terminated) break;
      throw new Error("Claude delivery ledger contains malformed JSON");
    }
    const parsed = deliveryRecord(value);
    if (!parsed) {
      if (index === lines.length - 1 && !terminated) break;
      throw new Error("Claude delivery ledger contains an invalid record");
    }
    if (index === lines.length - 1 && !terminated) {
      if (parsed.kind.startsWith("native-")) break;
      if (parsed.kind === "queued" && parsed.native !== undefined) {
        records.push({ ...parsed, native: { version: 0 } });
        break;
      }
    }
    records.push(parsed);
  }
  return records;
}

export function replayClaudeDeliveries(records: ClaudeDeliveryRecord[], sessionId: string): ClaudeDeliveryState[] {
  const states: ClaudeDeliveryState[] = [];
  const boundaries = new Set<string>();
  for (const row of records) {
    if (row.kind === "queued") {
      const input = nativeInput(row.native);
      const prior = states.find(state => state.entry.id === row.entry.id);
      if (prior) {
        if (prior.nativeNoWrite && input && input.sessionId === sessionId && prior.native?.inputUuid === input.inputUuid
          && sameNormalizedEntry(prior.entry, row.entry)) {
          prior.native = input; prior.nativeNoWrite = false; prior.disposition = row.disposition;
          states.splice(states.indexOf(prior), 1); states.push(prior);
        }
        continue;
      }
      const invalid = row.native !== undefined && (!input || input.sessionId !== sessionId
        || states.some(state => state.native?.inputUuid === input.inputUuid || state.delivered && state.engineMessageId === input.inputUuid));
      states.push({ entry: row.entry, disposition: row.disposition, queuedAt: row.queuedAt, delivered: false,
        ...(invalid ? { nativeUnverified: true } : input ? { native: input } : {}) });
    } else if (row.kind === "native-turn-boundary") {
      const proof = nativeTurnBoundary(row.evidence);
      if (!proof || proof.sessionId !== sessionId || boundaries.has(proof.resultUuid)) continue;
      const state = nativeTurnBoundaryMember(states, proof);
      if (!state || state.nativeTurnBoundary) continue;
      boundaries.add(proof.resultUuid);
      state.nativeTurnBoundary = proof;
    } else if (row.kind === "native-terminal") {
      const evidence = nativeTerminal(row.evidence);
      if (!evidence || evidence.sessionId !== sessionId || boundaries.has(evidence.resultUuid)) continue;
      const attempted = nativeResultMembers(states, { ...evidence, status: "completed" });
      if (!attempted || attempted.some(state => state.nativeNoWrite)) continue;
      boundaries.add(evidence.resultUuid);
      for (const state of attempted) state.nativeTerminal = evidence;
    } else if (row.kind === "native-consumed") {
      const evidence = nativeConsumed(row.evidence);
      const state = evidence && states.find(state => state.entry.id === evidence.entryId);
      if (!evidence || !state?.native || state.nativeUnverified || state.nativeNoWrite || state.nativeConsumed
        || !sameNativeWriter(state.native, evidence) || state.native.inputUuid !== evidence.inputUuid
        || state.entry.contentDigest !== evidence.contentDigest || evidence.turnId !== null && state.disposition !== "turn-started") continue;
      if (evidence.mergedInputUuids && !nativeMergedMembers(states, evidence)) continue;
      state.nativeConsumed = evidence;
      state.engineMessageId = evidence.canonicalUuid;
      if (evidence.turnId) { state.delivered = true; state.confirmation = "operation-bound"; }
    } else if (row.kind === "native-result") {
      const proof = nativeResult(row.proof);
      if (!proof || proof.sessionId !== sessionId || boundaries.has(proof.resultUuid)) continue;
      const members = nativeResultMembers(states, proof);
      if (!members || members.some(state => state.nativeNoWrite)) continue;
      boundaries.add(proof.resultUuid);
      for (const state of members) { state.nativeResult = proof; state.delivered = true; state.confirmation = "operation-bound"; }
    } else if (row.kind === "native-no-write") {
      const state = states.find(state => state.entry.id === row.entryId);
      if (state?.native?.inputUuid === row.inputUuid && !state.nativeResult && !state.nativeTerminal && !state.nativeTurnBoundary && !state.nativeConsumed) state.nativeNoWrite = true;
    } else {
      const state = states.find(state => state.entry.id === row.entryId);
      if (!state || state.native || state.nativeUnverified
        || row.confirmation === "inferred" && states.some(candidate => candidate.nativeUnverified)
        || row.engineMessageId && states.some(candidate => candidate.native?.inputUuid === row.engineMessageId)) continue;
      if (state.delivered && state.engineMessageId !== row.engineMessageId) continue;
      if (row.engineMessageId && states.some(candidate => candidate.delivered
        && candidate.entry.id !== row.entryId && candidate.engineMessageId === row.engineMessageId)) continue;
      state.delivered = true;
      state.engineMessageId = row.engineMessageId;
      const confirmation = row.confirmation ?? "unverified";
      if (state.confirmation !== "operation-bound"
        && (state.confirmation !== "inferred" || confirmation === "operation-bound")) state.confirmation = confirmation;
    }
  }
  return states;
}
