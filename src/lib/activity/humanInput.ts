import crypto from "node:crypto";

import type { ExclusionReason, Interval, RequestKind, Surface } from "./method";
import { EXCLUSION_REASONS, REQUEST_KINDS, SURFACES } from "./method";

/*
 * Human input across hosts (docs/design/activity-dashboard.md, "Cross-host
 * human input"). The operator works on more than one host, so the human axis
 * reads human-input events from every expected host: the live request ledger,
 * and the host's own transcripts through a privacy-safe export. This module is
 * the pure half of that: which transcript records are human input at all, how
 * copies of one input collapse into one, and the export row format.
 *
 * Only real operator input counts. The positive signals are the Delegatus
 * structured-user marker with operator origin, the host's delivery provenance
 * naming the operator, and the engine's own record that a person typed the
 * prompt. Every other user record — scaffolds, stage templates, notifications,
 * injected hints, attached screenshots, messages from one agent to another
 * that arrive with role=user, and anything unmarked — is excluded and counted
 * by reason.
 *
 * A record's text is read only to classify it and to hash it. The text never
 * leaves the process; an exported event carries opaque ids, a canonical
 * content hash, a time, a host, a project, a kind and a surface.
 */

export const EXPORT_ROW_VERSION = 1;
const ID_DOMAIN = "delegatus-human-input-v1";
const REQUEST_KEY_DOMAIN = "delegatus-activity-request-v1";
/** Id-less copies further apart than this are separate inputs. */
export const FALLBACK_WINDOW_MS = 90_000;

export type InputSource = "ledger" | "transcripts";

/** One human input, as every source hands it to the method. */
export interface HumanInput {
  /** Stable, opaque dedupe ids: two inputs sharing any one are one input. */
  ids: string[];
  at: number;
  host: string;
  source: InputSource;
  project: string | null;
  kind: RequestKind;
  surface: Surface;
  /** Canonical content hash, for the fallback rule across hosts. Null for a
      ledger row, which never saw the text. */
  hash: string | null;
}

export { EXCLUSION_REASONS, type ExclusionReason } from "./method";

/* ------------------------------------------------------------------------ */
/* Ids                                                                       */
/* ------------------------------------------------------------------------ */

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** The key a request ledger row stores for an ingress idempotency key. */
export function ledgerRowKey(idempotencyKey: string): string {
  return sha256(`${REQUEST_KEY_DOMAIN}\0${idempotencyKey}`);
}

/** The request id of an ingress idempotency key: a delivered transcript
    record whose request the host's provenance names shares it with the
    ledger row that request wrote. */
export function requestKey(idempotencyKey: string): string {
  return ledgerRequestId(ledgerRowKey(idempotencyKey));
}

/** The key the request ledger stores, as a request id. */
export function ledgerRequestId(ledgerKey: string): string {
  return `r:${ledgerKey}`;
}

/** An engine's prompt or event id (Claude promptId or uuid, Codex item id, a
    Delegatus delivery key), made opaque: the raw id never leaves the host. */
export function messageId(kind: "claude-prompt" | "claude" | "codex" | "delivery", id: string): string {
  return `m:${sha256(`${ID_DOMAIN}\0${kind}\0${id}`)}`;
}

/** The id of an input no stable id names: its host, text hash and time. */
function fallbackId(host: string, textHash: string, at: number): string {
  return `h:${sha256(`${ID_DOMAIN}\0${host}\0${textHash}\0${at}`)}`;
}

/** Canonical text for the fallback rule: the Delegatus delivery marker line
    dropped, whitespace collapsed. */
export function canonicalTextHash(text: string): string {
  const body = text.replace(/^<!-- llv:structured-user[^>]*-->\n?/, "").trim().replace(/\s+/gu, " ");
  return sha256(`${ID_DOMAIN}\0${body}`);
}

/* ------------------------------------------------------------------------ */
/* Transcript records                                                        */
/* ------------------------------------------------------------------------ */

/** How a transcript's session was started, read from its own first records. */
export type SessionKind = "interactive" | "delegatus" | "automation" | "subagent";

/** How a conversation was launched, from the host's registry. */
export type LaunchKind = "operator" | "agent" | "pipeline";

export interface TranscriptContext {
  host: string;
  project: string | null;
  /** Identity of the transcript for the fan-out rule; stays on the host. */
  conversation: string;
  session: SessionKind;
  launch: LaunchKind | null;
  /** The origin of a Delegatus delivery, from the host's delivery provenance,
      and the ingress idempotency key it was admitted under when known. */
  deliveryOrigin?(record: UserRecord): { origin: "operator" | "agent"; idempotencyKey?: string } | null;
}

/** The fields of one user record the classifier reads. `text` is transient. */
export interface UserRecord {
  engine: "claude" | "codex";
  at: number;
  text: string;
  /** Claude `promptId`. */
  promptId: string | null;
  /** Claude `uuid` or Codex response item `id`. */
  messageId: string | null;
  /** The delivery key in a Codex structured-user marker. */
  deliveryKey: string | null;
  /** Origin stamped in a Codex structured-user marker. */
  markerOrigin: "operator" | "agent" | null;
  /** Written by a Delegatus delivery: a structured-user marker or a Claude
      `promptSource: "sdk"` record. */
  delivered: boolean;
  isMeta: boolean;
  isSidechain: boolean;
  isCompactSummary: boolean;
  promptSource: string | null;
  turnOrigin: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textOf(content: unknown): { text: string; toolResultOnly: boolean } {
  if (typeof content === "string") return { text: content, toolResultOnly: false };
  if (!Array.isArray(content)) return { text: "", toolResultOnly: false };
  const parts = content.map(record).filter((part): part is Record<string, unknown> => part !== null);
  const text = parts
    .filter((part) => part.type === "text" || part.type === "input_text")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("\n");
  return { text, toolResultOnly: parts.length > 0 && parts.every((part) => part.type === "tool_result") };
}

function timeOf(value: unknown): number | null {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

const MARKER = /^<!-- llv:structured-user((?: [a-z0-9]+=[^ >]+)*) -->/;

function markerFacts(text: string): { delivered: boolean; origin: "operator" | "agent" | null; key: string | null } {
  const marker = MARKER.exec(text);
  if (!marker) return { delivered: false, origin: null, key: null };
  let origin: "operator" | "agent" | null = null;
  let key: string | null = null;
  for (const [, name, value] of marker[1]!.matchAll(/ ([a-z0-9]+)=([^ >]+)/g)) {
    if (name === "ctx" && /^[oad]\./.test(value!)) {
      key = value!.split(".")[1] ?? null;
      if (value!.startsWith("o.")) origin = "operator";
      if (value!.startsWith("a.")) origin = "agent";
    }
    if (name === "dedup" && /^[a-f0-9]{64}$/.test(value!)) key ??= value!;
    if (name === "origin" && (value === "operator" || value === "agent")) origin = value;
  }
  return { delivered: true, origin, key };
}

/** A Claude transcript line, when it is a user message record with text. */
export function parseClaudeUserRecord(raw: unknown): UserRecord | null {
  const line = record(raw);
  if (!line || line.type !== "user") return null;
  const { text, toolResultOnly } = textOf(record(line.message)?.content);
  const at = timeOf(line.timestamp);
  if (toolResultOnly || !text.trim() || at === null) return null;
  const promptSource = typeof line.promptSource === "string" ? line.promptSource : null;
  return {
    engine: "claude",
    at,
    text,
    promptId: typeof line.promptId === "string" && line.promptId ? line.promptId : null,
    messageId: typeof line.uuid === "string" && line.uuid ? line.uuid : null,
    deliveryKey: null,
    markerOrigin: null,
    delivered: promptSource === "sdk",
    isMeta: line.isMeta === true,
    isSidechain: line.isSidechain === true,
    isCompactSummary: line.isCompactSummary === true,
    promptSource,
    turnOrigin: typeof line.turnOrigin === "string" ? line.turnOrigin : null,
  };
}

/** A Codex rollout line, when it is a user message item with text. */
export function parseCodexUserRecord(raw: unknown): UserRecord | null {
  const line = record(raw);
  const payload = record(line?.payload);
  if (!line || line.type !== "response_item" || payload?.type !== "message" || payload.role !== "user") return null;
  const { text } = textOf(payload.content);
  const at = timeOf(line.timestamp);
  if (!text.trim() || at === null) return null;
  const marker = markerFacts(text);
  return {
    engine: "codex",
    at,
    text,
    promptId: null,
    messageId: typeof payload.id === "string" && payload.id ? payload.id : null,
    deliveryKey: marker.key,
    markerOrigin: marker.origin,
    delivered: marker.delivered,
    isMeta: false,
    isSidechain: false,
    isCompactSummary: false,
    promptSource: null,
    turnOrigin: null,
  };
}

/** A Codex session from its `session_meta` payload. */
export function codexSessionKind(sessionMeta: unknown): SessionKind {
  const meta = record(sessionMeta);
  const source = meta?.source;
  if (record(source)?.subagent) return "subagent";
  if (meta?.originator === "codex_exec" || source === "exec") return "automation";
  if (meta?.originator === "llv-structured-host") return "delegatus";
  return "interactive";
}

/** A Claude session from its first user record's entrypoint: the terminal CLI
    is interactive; an SDK session is Delegatus's when the host's registry
    knows the conversation, and automation otherwise. */
export function claudeSessionKind(entrypoint: unknown, registered: boolean): SessionKind {
  if (entrypoint === "cli" || entrypoint === undefined || entrypoint === null) return "interactive";
  return registered ? "delegatus" : "automation";
}

const INJECTED_PREFIXES = [
  "<local-command-stdout", "<local-command-stderr", "<local-command-caveat", "<system-reminder", "<command-message",
  "# AGENTS.md", "<user_instructions", "<environment_context", "<user_shell_command", "<turn_aborted", "<skill",
];
const NOTIFICATION_PREFIXES = ["<task-notification", "This session is being continued from a previous conversation"];

export type Verdict =
  | { human: true; kind: RequestKind; surface: Surface; idempotencyKey?: string }
  | { human: false; reason: ExclusionReason };

/**
 * Whether one user record is operator input, and if not, why. A record counts
 * only on a positive signal: the operator-origin marker, the host's delivery
 * provenance naming the operator, or the engine's own "typed by a person"
 * flag. The first user message of a spawned conversation is judged by how it
 * was launched: a pipeline stage's is a generated template and a delegated
 * spawn's is another agent's.
 */
export function classifyUserRecord(rec: UserRecord, context: TranscriptContext, firstUserMessage: boolean): Verdict {
  const body = rec.text.trimStart().replace(MARKER, "").trimStart();
  if (rec.isMeta && /^\[Image\b/.test(body)) return { human: false, reason: "attachment" };
  if (rec.isMeta || INJECTED_PREFIXES.some((prefix) => body.startsWith(prefix))) return { human: false, reason: "injected" };
  if (rec.isCompactSummary || rec.promptSource === "system" || rec.turnOrigin === "task_notification"
    || NOTIFICATION_PREFIXES.some((prefix) => body.startsWith(prefix))) return { human: false, reason: "notification" };
  if (body.startsWith("[Request interrupted by user")) return { human: false, reason: "interrupt" };
  if (rec.isSidechain || context.session === "subagent") return { human: false, reason: "subagent" };
  if (context.session === "automation") return { human: false, reason: "automation" };
  const provenance = rec.delivered || context.session === "delegatus" ? context.deliveryOrigin?.(rec) ?? null : null;
  const origin = rec.markerOrigin ?? provenance?.origin ?? null;
  if (origin === "agent") return { human: false, reason: "agent-message" };
  if (firstUserMessage && context.launch === "pipeline") return { human: false, reason: "stage-template" };
  if (firstUserMessage && context.launch === "agent") return { human: false, reason: "scaffold" };
  if (origin === "operator") {
    return {
      human: true,
      kind: firstUserMessage && context.launch === "operator" ? "spawn" : "message",
      surface: "unknown",
      ...(provenance?.idempotencyKey ? { idempotencyKey: provenance.idempotencyKey } : {}),
    };
  }
  if (rec.promptSource === "typed" || rec.turnOrigin === "human") return { human: true, kind: "message", surface: "terminal" };
  if (firstUserMessage && context.launch === "operator") return { human: false, reason: "scaffold" };
  return { human: false, reason: "unmarked" };
}

/* ------------------------------------------------------------------------ */
/* Dedupe                                                                    */
/* ------------------------------------------------------------------------ */

/** A human input before dedupe, with the evidence the rules use. */
export interface InputCandidate {
  at: number;
  host: string;
  project: string | null;
  kind: RequestKind;
  surface: Surface;
  /** Opaque stable ids (`requestKey`, `messageId`). */
  ids: string[];
  /** Canonical text hash, for the fallback rule only. */
  textHash: string;
  conversation: string;
}

/** Build a candidate from a classified record. */
export function candidateFor(rec: UserRecord, context: TranscriptContext, verdict: { kind: RequestKind; surface: Surface; idempotencyKey?: string }): InputCandidate {
  const ids: string[] = [];
  if (verdict.idempotencyKey) ids.push(requestKey(verdict.idempotencyKey));
  if (rec.promptId) ids.push(messageId("claude-prompt", rec.promptId));
  if (rec.messageId) ids.push(messageId(rec.engine, rec.messageId));
  if (rec.deliveryKey) ids.push(messageId("delivery", rec.deliveryKey));
  return {
    at: rec.at,
    host: context.host,
    project: context.project,
    kind: verdict.kind,
    surface: verdict.surface,
    ids,
    textHash: canonicalTextHash(rec.text),
    conversation: context.conversation,
  };
}

class Groups {
  private parent: number[];
  constructor(size: number) { this.parent = Array.from({ length: size }, (_, index) => index); }
  find(index: number): number {
    while (this.parent[index] !== index) {
      this.parent[index] = this.parent[this.parent[index]!]!;
      index = this.parent[index]!;
    }
    return index;
  }
  join(a: number, b: number): void {
    const left = this.find(a);
    const right = this.find(b);
    if (left !== right) this.parent[Math.max(left, right)] = Math.min(left, right);
  }
}

/** Join every pair of items that share an id. */
function joinByIds(items: ReadonlyArray<{ ids: readonly string[] }>, groups: Groups): void {
  const byId = new Map<string, number>();
  items.forEach((item, index) => {
    for (const id of item.ids) {
      const seen = byId.get(id);
      if (seen === undefined) byId.set(id, index);
      else groups.join(seen, index);
    }
  });
}

/** The fallback rule over time-sorted items: an item joins an earlier one
    with the same content hash when it falls within FALLBACK_WINDOW_MS of that
    one's group's first copy and `eligible` allows the pair. It compares groups,
    so it never splits what the id rule joined. */
function joinByContent<T extends { at: number }>(
  items: readonly T[],
  groups: Groups,
  hashKey: (item: T) => string | null,
  eligible: (earlier: T, later: T) => boolean,
): void {
  const byHash = new Map<string, number[]>();
  items.forEach((item, index) => {
    const key = hashKey(item);
    if (key === null) return;
    const list = byHash.get(key) ?? [];
    for (const other of list) {
      const root = groups.find(other);
      if (root === groups.find(index) || !eligible(items[other]!, item)) continue;
      if (item.at - items[root]!.at <= FALLBACK_WINDOW_MS) {
        groups.join(other, index);
        break;
      }
    }
    list.push(index);
    byHash.set(key, list);
  });
}

/**
 * Collapse copies of one input on one host into one.
 *
 * 1. The id rule: candidates that share a prompt or event id are one input.
 *    A shared mirror, an account-store copy, and a resumed or continued
 *    transcript copy their records with the records' ids, and a delivery the
 *    host's provenance resolves carries its request key.
 * 2. The fallback rule, only between inputs no id joins: identical canonical
 *    content within FALLBACK_WINDOW_MS of the input's first copy is one input.
 *    That is a copy that lost its ids, or a Delegatus fan-out, whose copies in
 *    different conversations each got their own ids. Two records of one
 *    conversation that both carry ids are two messages, whatever they say.
 *
 * Each input keeps its earliest time, every id of its copies and the content
 * hash; one that no id names gets a fallback id from its host, hash and time.
 */
export function dedupeCandidates(candidates: readonly InputCandidate[]): HumanInput[] {
  const sorted = [...candidates].sort((a, b) => a.at - b.at || a.conversation.localeCompare(b.conversation));
  const groups = new Groups(sorted.length);
  joinByIds(sorted, groups);
  joinByContent(
    sorted,
    groups,
    (candidate) => `${candidate.host}\0${candidate.textHash}`,
    (earlier, later) => !(earlier.conversation === later.conversation && earlier.ids.length && later.ids.length),
  );
  const merged = new Map<number, { first: InputCandidate; ids: Set<string> }>();
  sorted.forEach((candidate, index) => {
    const root = groups.find(index);
    const entry = merged.get(root);
    if (entry) for (const id of candidate.ids) entry.ids.add(id);
    else merged.set(root, { first: candidate, ids: new Set(candidate.ids) });
  });
  return [...merged.values()].map(({ first, ids }) => ({
    ids: ids.size ? [...ids].sort() : [fallbackId(first.host, first.textHash, first.at)],
    at: first.at,
    host: first.host,
    source: "transcripts" as const,
    project: first.project,
    kind: first.kind,
    surface: first.surface,
    hash: first.textHash,
  })).sort((a, b) => a.at - b.at);
}

/**
 * Merge inputs from every source and host into one list.
 *
 * - Inside a span a host's request ledger covers, that host's transcript
 *   inputs that came through Delegatus (surface `unknown`) are dropped: the
 *   ledger recorded every Delegatus request there once, at ingress, fan-out
 *   included, and with its surface.
 * - Inputs sharing an id are one: the same message in stores on both hosts.
 * - The fallback rule across hosts: the same content hash on two hosts within
 *   FALLBACK_WINDOW_MS, with no id in common, is one input.
 *
 * The earliest copy's time wins, and a ledger row wins a tie.
 */
export function mergeHumanInputs(inputs: readonly HumanInput[], ledgerSpans: ReadonlyMap<string, readonly Interval[]>): HumanInput[] {
  const kept = inputs.filter((input) => {
    if (input.source !== "transcripts" || input.surface !== "unknown") return true;
    return !(ledgerSpans.get(input.host) ?? []).some((span) => input.at >= span.start && input.at <= span.end);
  }).sort((a, b) => a.at - b.at || (a.source === b.source ? 0 : a.source === "ledger" ? -1 : 1));
  const groups = new Groups(kept.length);
  joinByIds(kept, groups);
  joinByContent(kept, groups, (input) => input.hash, (earlier, later) => earlier.host !== later.host);
  const out = new Map<number, HumanInput>();
  kept.forEach((input, index) => {
    const root = groups.find(index);
    const entry = out.get(root);
    if (entry) entry.ids = [...new Set([...entry.ids, ...input.ids])].sort();
    else out.set(root, { ...input, ids: [...input.ids] });
  });
  return [...out.values()].sort((a, b) => a.at - b.at);
}

/* ------------------------------------------------------------------------ */
/* Export rows                                                               */
/* ------------------------------------------------------------------------ */

/** The first line of an export file: which host, and what span it speaks for. */
export interface ExportManifest {
  v: typeof EXPORT_ROW_VERSION;
  type: "manifest";
  host: string;
  coveredFrom: number;
  coveredUntil: number;
  exportedAt: number;
  /** Records seen, and records excluded by reason. Counts only. */
  records: number;
  excluded: Partial<Record<ExclusionReason, number>>;
}

export interface ExportEvent {
  v: typeof EXPORT_ROW_VERSION;
  type: "input";
  ids: string[];
  /** The canonical content hash; the text itself is never stored. */
  hash: string | null;
  at: number;
  host: string;
  project: string | null;
  kind: RequestKind;
  surface: Surface;
}

const HOST_ID = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const OPAQUE_ID = /^[rmh]:[0-9a-f]{64}$/;

export function validHostId(value: unknown): value is string {
  return typeof value === "string" && HOST_ID.test(value);
}

export function parseExportLine(line: string): ExportManifest | ExportEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const row = record(value);
  if (!row || row.v !== EXPORT_ROW_VERSION || !validHostId(row.host)) return null;
  if (row.type === "manifest") {
    if (!Number.isSafeInteger(row.coveredFrom) || !Number.isSafeInteger(row.coveredUntil)
      || (row.coveredFrom as number) > (row.coveredUntil as number) || !Number.isSafeInteger(row.exportedAt)) return null;
    const excluded: Partial<Record<ExclusionReason, number>> = {};
    for (const reason of EXCLUSION_REASONS) {
      const count = record(row.excluded)?.[reason];
      if (Number.isSafeInteger(count) && (count as number) > 0) excluded[reason] = count as number;
    }
    return {
      v: EXPORT_ROW_VERSION,
      type: "manifest",
      host: row.host,
      coveredFrom: row.coveredFrom as number,
      coveredUntil: row.coveredUntil as number,
      exportedAt: row.exportedAt as number,
      records: Number.isSafeInteger(row.records) ? row.records as number : 0,
      excluded,
    };
  }
  if (row.type !== "input") return null;
  if (!Array.isArray(row.ids) || !row.ids.length || !row.ids.every((id) => typeof id === "string" && OPAQUE_ID.test(id))
    || !(row.hash === null || row.hash === undefined || (typeof row.hash === "string" && /^[0-9a-f]{64}$/.test(row.hash)))
    || !Number.isSafeInteger(row.at) || (row.at as number) <= 0
    || !(row.project === null || (typeof row.project === "string" && row.project.trim()))
    || !REQUEST_KINDS.includes(row.kind as RequestKind)
    || !SURFACES.includes(row.surface as Surface)) return null;
  return {
    v: EXPORT_ROW_VERSION,
    type: "input",
    ids: row.ids as string[],
    hash: typeof row.hash === "string" ? row.hash : null,
    at: row.at as number,
    host: row.host,
    project: row.project as string | null,
    kind: row.kind as RequestKind,
    surface: row.surface as Surface,
  };
}

export function exportLines(manifest: Omit<ExportManifest, "v" | "type">, inputs: readonly HumanInput[]): string {
  const head: ExportManifest = { v: EXPORT_ROW_VERSION, type: "manifest", ...manifest };
  const rows = inputs.map((input): ExportEvent => ({
    v: EXPORT_ROW_VERSION,
    type: "input",
    ids: input.ids,
    hash: input.hash,
    at: input.at,
    host: input.host,
    project: input.project,
    kind: input.kind,
    surface: input.surface,
  }));
  return [head, ...rows].map((row) => JSON.stringify(row)).join("\n") + "\n";
}
