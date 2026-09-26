import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { withAccountMutationLock } from "@/lib/accounts/accountMutation";
import { statePath } from "@/lib/configDir";

import { deputyPrincipal, type DeputyPrincipal } from "./authority";
import { canonicalOrchestratorProject, orchestratorRevocations, orchestratorSeatFor } from "./seats";

/* The seat's deputies (docs/design/ghost-seat.md §4, §5): a short-lived fork of
 * an orchestrator seat that answers one side ask while the seat keeps working.
 *
 * A deputy is never a seat. Its record lives in a file of its own beside the
 * seats file rather than inside it: the seats reader refuses a schema it does
 * not know, so a version bump there would make an older build read every seat
 * as absent. Nothing here grants authority by itself; `./authority`
 * (`deputyPrincipal`) reads these rows against the seat record and fails
 * closed on anything that does not line up.
 *
 * The record is also what the seat's feed draws the deputy's block from: `ask`
 * is the block's head, `artifactPath` and `forkRecordCount` say which
 * transcript to read and where the deputy's own rows begin, and `result` is the
 * one line the finished block collapses to, with `touched` as its links.
 */

export const ORCHESTRATOR_DEPUTIES_SCHEMA_VERSION = 1;
/** A deputy that is still running this long after it started is interrupted. */
export const DEPUTY_LIFETIME_MS = 15 * 60_000;
/** Ended records kept on file, newest last; the oldest are trimmed first. */
export const DEPUTY_HISTORY_CAP = 100;
/** Ended records the seat read model carries beside the live one. */
export const DEPUTY_READ_LIMIT = 10;

export type DeputyOutcome = "done" | "timeout" | "host-died" | "seat-rotated" | "failed";

/** Who sent the ask, as the team recorded it (PR #2243 §6.7). Null on a solo
    install, where the operator is the only person. */
export interface DeputyAskSender {
  memberId: string;
  name: string;
  color: string | null;
  initials: string | null;
}

export interface DeputyAsk {
  text: string;
  /** How many images rode with the ask; the pictures themselves go to the
      deputy's host and are not copied into the record. */
  images: number;
  sender: DeputyAskSender | null;
}

export interface DeputyTouched {
  taskIds: string[];
  pipelineIds: string[];
  conversationIds: string[];
}

export interface DeputyResult {
  /** The one line the finished block collapses to, in the operator's language. */
  line: string;
  /** The deputy's final message, bounded. */
  finalText: string;
}

export interface DeputyNote {
  clientMessageId: string;
  sentAt: string;
  /** What the delivery answered: queued/delivered, or the refusal. */
  outcome: string;
}

export interface OrchestratorDeputy {
  askId: string;
  clientRequestId: string;
  project: string;
  seatConversationId: string;
  seatEpoch: number;
  seatPath: string | null;
  deputyConversationId: string | null;
  ask: DeputyAsk;
  artifactPath: string | null;
  /** Transcript records the fork copied from the seat. Everything before this
      count is the seat's own history, already on screen in its feed. */
  forkRecordCount: number | null;
  state: "pending" | "active" | "ended";
  startedAt: string;
  expiresAt: string;
  activatedAt: string | null;
  endedAt: string | null;
  outcome: DeputyOutcome | null;
  touched: DeputyTouched;
  result: DeputyResult | null;
  note: DeputyNote | null;
  /** Why a launch that never became a deputy failed. */
  error: string | null;
}

interface DeputyFile {
  schemaVersion: number;
  deputies: OrchestratorDeputy[];
}

const deputiesFile = () => statePath("orchestrator-deputies.json");

function emptyFile(): DeputyFile {
  return { schemaVersion: ORCHESTRATOR_DEPUTIES_SCHEMA_VERSION, deputies: [] };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function normalizeSender(value: unknown): DeputyAskSender | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sender = value as Partial<DeputyAskSender>;
  if (typeof sender.memberId !== "string" || !sender.memberId || typeof sender.name !== "string" || !sender.name) return null;
  return { memberId: sender.memberId, name: sender.name, color: stringOrNull(sender.color), initials: stringOrNull(sender.initials) };
}

const OUTCOMES: readonly DeputyOutcome[] = ["done", "timeout", "host-died", "seat-rotated", "failed"];

export function normalizeDeputy(value: unknown): OrchestratorDeputy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<OrchestratorDeputy>;
  if (typeof row.askId !== "string" || !row.askId) return null;
  if (typeof row.clientRequestId !== "string" || !row.clientRequestId) return null;
  if (typeof row.project !== "string" || !row.project) return null;
  if (typeof row.seatConversationId !== "string" || !row.seatConversationId) return null;
  if (typeof row.seatEpoch !== "number" || !Number.isInteger(row.seatEpoch) || row.seatEpoch < 1) return null;
  if (row.state !== "pending" && row.state !== "active" && row.state !== "ended") return null;
  if (typeof row.startedAt !== "string" || typeof row.expiresAt !== "string") return null;
  const ask = (row.ask ?? {}) as Partial<DeputyAsk>;
  const touched = (row.touched ?? {}) as Partial<DeputyTouched>;
  const result = row.result && typeof row.result === "object" && typeof row.result.line === "string"
    ? { line: row.result.line, finalText: typeof row.result.finalText === "string" ? row.result.finalText : "" }
    : null;
  const note = row.note && typeof row.note === "object" && typeof row.note.clientMessageId === "string"
    ? { clientMessageId: row.note.clientMessageId, sentAt: String(row.note.sentAt ?? ""), outcome: String(row.note.outcome ?? "") }
    : null;
  return {
    askId: row.askId,
    clientRequestId: row.clientRequestId,
    project: canonicalOrchestratorProject(row.project),
    seatConversationId: row.seatConversationId,
    seatEpoch: row.seatEpoch,
    seatPath: stringOrNull(row.seatPath),
    deputyConversationId: stringOrNull(row.deputyConversationId),
    ask: {
      text: typeof ask.text === "string" ? ask.text : "",
      images: typeof ask.images === "number" && Number.isInteger(ask.images) && ask.images > 0 ? ask.images : 0,
      sender: normalizeSender(ask.sender),
    },
    artifactPath: stringOrNull(row.artifactPath),
    forkRecordCount: typeof row.forkRecordCount === "number" && Number.isInteger(row.forkRecordCount) && row.forkRecordCount >= 0
      ? row.forkRecordCount
      : null,
    state: row.state,
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
    activatedAt: stringOrNull(row.activatedAt),
    endedAt: stringOrNull(row.endedAt),
    outcome: OUTCOMES.includes(row.outcome as DeputyOutcome) ? row.outcome as DeputyOutcome : null,
    touched: { taskIds: strings(touched.taskIds), pipelineIds: strings(touched.pipelineIds), conversationIds: strings(touched.conversationIds) },
    result,
    note,
    error: stringOrNull(row.error),
  };
}

/** Null when the file cannot be read or is from a future schema: a caller
    that grants anything on these rows must grant nothing then. A missing
    file is a real "no deputies". */
export function readDeputyFileOrNull(): DeputyFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(deputiesFile(), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? emptyFile() : null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DeputyFile>;
    if (parsed.schemaVersion !== ORCHESTRATOR_DEPUTIES_SCHEMA_VERSION) return null;
    const file = emptyFile();
    for (const candidate of Array.isArray(parsed.deputies) ? parsed.deputies : []) {
      const deputy = normalizeDeputy(candidate);
      if (deputy) file.deputies.push(deputy);
    }
    return file;
  } catch {
    return null;
  }
}

export function readDeputies(): OrchestratorDeputy[] {
  return readDeputyFileOrNull()?.deputies ?? [];
}

function writeDeputyFile(file: DeputyFile): void {
  const filePath = deputiesFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(file, null, 2) + "\n", "utf8");
  fs.renameSync(temp, filePath);
}

function trimHistory(file: DeputyFile): void {
  const ended = file.deputies.filter((deputy) => deputy.state === "ended");
  const excess = ended.length - DEPUTY_HISTORY_CAP;
  if (excess <= 0) return;
  const drop = new Set(ended.slice(0, excess).map((deputy) => deputy.askId));
  file.deputies = file.deputies.filter((deputy) => !drop.has(deputy.askId));
}

/** Read, change and write the file under the lock the seat record uses. An
    unreadable file refuses the write rather than overwriting what it could
    not read. */
function mutateDeputies<T>(operation: (file: DeputyFile) => { value: T; changed: boolean }): T {
  return withAccountMutationLock(() => {
    const file = readDeputyFileOrNull();
    if (!file) throw new Error("orchestrator deputy record is unreadable");
    const { value, changed } = operation(file);
    if (changed) {
      trimHistory(file);
      writeDeputyFile(file);
    }
    return value;
  });
}

/** Whether a deputy still holds its seat's authority on its own terms: not
    ended and not past its expiry. The seat half is `deputyPrincipal`'s. */
export function deputyLive(deputy: Pick<OrchestratorDeputy, "state" | "endedAt" | "expiresAt">, nowMs: number): boolean {
  if (deputy.state === "ended" || deputy.endedAt) return false;
  const expires = Date.parse(deputy.expiresAt);
  return Number.isFinite(expires) && nowMs < expires;
}

export type BeginDeputyResult =
  | { kind: "begun"; deputy: OrchestratorDeputy }
  /** The same request replayed by its key, for the caller to finish. */
  | { kind: "replay"; deputy: OrchestratorDeputy }
  /** Another deputy of this seat is still live (slice 1: one at a time). */
  | { kind: "limit"; deputy: OrchestratorDeputy };

export function beginDeputy(input: {
  project: string;
  seatConversationId: string;
  seatEpoch: number;
  seatPath: string | null;
  clientRequestId: string;
  ask: DeputyAsk;
  now?: Date;
  askId?: string;
}): BeginDeputyResult {
  const now = input.now ?? new Date();
  return mutateDeputies<BeginDeputyResult>((file) => {
    const replay = file.deputies.find((deputy) => deputy.clientRequestId === input.clientRequestId);
    if (replay) return { value: { kind: "replay" as const, deputy: replay }, changed: false };
    const live = file.deputies.find((deputy) => deputy.seatConversationId === input.seatConversationId
      && deputyLive(deputy, now.getTime()));
    if (live) return { value: { kind: "limit" as const, deputy: live }, changed: false };
    const deputy: OrchestratorDeputy = {
      askId: input.askId ?? `deputy_${crypto.randomUUID()}`,
      clientRequestId: input.clientRequestId,
      project: canonicalOrchestratorProject(input.project),
      seatConversationId: input.seatConversationId,
      seatEpoch: input.seatEpoch,
      seatPath: input.seatPath,
      deputyConversationId: null,
      ask: input.ask,
      artifactPath: null,
      forkRecordCount: null,
      state: "pending",
      startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DEPUTY_LIFETIME_MS).toISOString(),
      activatedAt: null,
      endedAt: null,
      outcome: null,
      touched: { taskIds: [], pipelineIds: [], conversationIds: [] },
      result: null,
      note: null,
      error: null,
    };
    file.deputies.push(deputy);
    return { value: { kind: "begun" as const, deputy }, changed: true };
  });
}

/** Apply a change to one record; null when the record is gone. */
export function updateDeputy(
  askId: string,
  change: (deputy: OrchestratorDeputy) => OrchestratorDeputy | null,
): OrchestratorDeputy | null {
  return mutateDeputies((file) => {
    const index = file.deputies.findIndex((deputy) => deputy.askId === askId);
    if (index < 0) return { value: null, changed: false };
    const next = change(file.deputies[index]!);
    if (!next) return { value: file.deputies[index]!, changed: false };
    file.deputies[index] = next;
    return { value: next, changed: true };
  });
}

export function recordDeputyFork(askId: string, fork: { deputyConversationId: string; artifactPath: string; forkRecordCount: number }): OrchestratorDeputy | null {
  return updateDeputy(askId, (deputy) => {
    /* A replay after the fork was recorded keeps the first answer: the count
       names the seat's history as it stood when the copy was taken. */
    if (deputy.deputyConversationId && deputy.artifactPath && deputy.forkRecordCount !== null) return null;
    return { ...deputy, ...fork };
  });
}

export function activateDeputy(askId: string, now = new Date()): OrchestratorDeputy | null {
  return updateDeputy(askId, (deputy) => deputy.state !== "pending" ? null : { ...deputy, state: "active", activatedAt: now.toISOString() });
}

/** End a record once. A second end (a sweep racing the route, a predecessor
    release still running its timer) leaves the first answer standing. */
export function endDeputy(askId: string, ending: {
  outcome: DeputyOutcome;
  now?: Date;
  touched?: DeputyTouched;
  result?: DeputyResult | null;
  error?: string | null;
}): OrchestratorDeputy | null {
  const now = ending.now ?? new Date();
  return updateDeputy(askId, (deputy) => deputy.state === "ended" ? null : {
    ...deputy,
    state: "ended",
    endedAt: now.toISOString(),
    outcome: ending.outcome,
    touched: ending.touched ?? deputy.touched,
    result: ending.result ?? deputy.result,
    error: ending.error ?? deputy.error,
  });
}

export function recordDeputyNote(askId: string, note: DeputyNote): OrchestratorDeputy | null {
  return updateDeputy(askId, (deputy) => deputy.note ? null : { ...deputy, note });
}

/** The live record and the newest ended ones of one seat, newest first. */
export function deputiesForSeatIn(
  deputies: readonly OrchestratorDeputy[],
  seatConversationId: string,
  limit = DEPUTY_READ_LIMIT,
): OrchestratorDeputy[] {
  const own = deputies.filter((deputy) => deputy.seatConversationId === seatConversationId);
  const live = own.filter((deputy) => deputy.state !== "ended");
  const ended = own.filter((deputy) => deputy.state === "ended").slice(-limit);
  return [...live, ...ended].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}

/** Every conversation and transcript a deputy record names, for the lists
    that must leave them out (§5 "hidden from lists"). Null when the record
    cannot be read. */
export function deputyConversationRefs(): { conversationIds: string[]; paths: string[] } | null {
  const file = readDeputyFileOrNull();
  if (!file) return null;
  return deputyConversationRefsIn(file.deputies);
}

export function deputyConversationRefsIn(deputies: readonly OrchestratorDeputy[]): { conversationIds: string[]; paths: string[] } {
  const conversationIds = new Set<string>();
  const paths = new Set<string>();
  for (const deputy of deputies) {
    if (deputy.deputyConversationId) conversationIds.add(deputy.deputyConversationId);
    if (deputy.artifactPath) paths.add(deputy.artifactPath);
  }
  return { conversationIds: [...conversationIds], paths: [...paths] };
}

/** {@link deputyPrincipal} over the durable records, read per call so a
    rotation, a revocation or an ended record takes effect on the next call.
    An unreadable deputy file names no deputy. */
export function productionDeputyPrincipal(conversationId: string | null | undefined, now = Date.now()): DeputyPrincipal | null {
  if (!conversationId) return null;
  const deputies = readDeputyFileOrNull()?.deputies ?? [];
  if (!deputies.some((deputy) => deputy.deputyConversationId === conversationId)) return null;
  return deputyPrincipal(conversationId, {
    deputies: () => deputies,
    activeSeat: (project) => orchestratorSeatFor(project).active,
    revocations: orchestratorRevocations,
    now: () => now,
  });
}
