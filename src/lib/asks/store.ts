import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";

import type { ReportLogAsk } from "./types";

/*
 * What the "Asks you" classifier has decided (docs/research/attention-classifier.md
 * §7), in one state file the Viewer's classifier alone writes:
 *
 *  - `asks`: every message it judged an ask, newest last. The newest per
 *    conversation is that conversation's open ask; each one is a line in its
 *    project's report log.
 *  - `seen`: the messages already sent (or skipped), so none is sent twice.
 *  - `scores`: each classified text's score by its hash, so the same words,
 *    repeated by the same agent or written by another, are judged again
 *    without a second call.
 *  - `spend`: this month's calls and their billed cost, against the cap.
 *
 * Anything unreadable reads as empty: a lost file costs a flag that does not
 * show, never a message sent twice in the same process (the sweep also keeps
 * its own in-memory set) and never a spend over the cap for long.
 */

export const OPERATOR_ASKS_SCHEMA_VERSION = 1 as const;
const ASK_CAPACITY = 1_000;
const ASK_RETENTION_MS = 30 * 24 * 3_600_000;
const SEEN_CAPACITY = 5_000;

export interface OperatorAskRecord {
  id: string;
  /** The durable conversation id, or the transcript path the registry does not know. */
  subject: string;
  conversationId: string | null;
  path: string;
  project: string;
  role: string | null;
  title: string | null;
  messageId: string;
  /** Epoch ms of the message that asks. */
  messageAt: number;
  gist: string;
  score: number;
  recordedAt: string;
}

export interface AsksSpend {
  /** UTC `YYYY-MM`. */
  month: string;
  usd: number;
  calls: number;
  /** Messages left unclassified because the cap was reached. */
  capped: number;
}

export interface OperatorAsksFileV1 {
  schemaVersion: typeof OPERATOR_ASKS_SCHEMA_VERSION;
  revision: number;
  spend: AsksSpend;
  seen: string[];
  /** Text hash → score, oldest first. Absent from files written before it. */
  scores: Record<string, number>;
  asks: OperatorAskRecord[];
}

export function operatorAsksFile(): string {
  return statePath("operator-asks.json");
}

export function spendMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

function emptyFile(now: Date): OperatorAsksFileV1 {
  return { schemaVersion: OPERATOR_ASKS_SCHEMA_VERSION, revision: 0, spend: { month: spendMonth(now), usd: 0, calls: 0, capped: 0 }, seen: [], scores: {}, asks: [] };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableString = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function parseAsk(value: unknown): OperatorAskRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.subject !== "string" || typeof record.path !== "string") return null;
  if (typeof record.project !== "string" || typeof record.messageId !== "string" || typeof record.gist !== "string") return null;
  if (!finite(record.messageAt) || !finite(record.score) || typeof record.recordedAt !== "string") return null;
  return {
    id: record.id,
    subject: record.subject,
    conversationId: nullableString(record.conversationId),
    path: record.path,
    project: record.project,
    role: nullableString(record.role),
    title: nullableString(record.title),
    messageId: record.messageId,
    messageAt: record.messageAt,
    gist: record.gist,
    score: record.score,
    recordedAt: record.recordedAt,
  };
}

function parseScores(value: unknown): Record<string, number> {
  const scores: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return scores;
  for (const [key, score] of Object.entries(value)) {
    if (finite(score) && score >= 0 && score <= 1) scores[key] = score;
  }
  return scores;
}

export function readOperatorAsks(file = operatorAsksFile(), now = new Date()): OperatorAsksFileV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return emptyFile(now);
  }
  const parsed = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Partial<OperatorAsksFileV1> : {};
  if (parsed.schemaVersion !== OPERATOR_ASKS_SCHEMA_VERSION) return emptyFile(now);
  const spend = parsed.spend && typeof parsed.spend === "object" ? parsed.spend as Partial<AsksSpend> : {};
  return {
    schemaVersion: OPERATOR_ASKS_SCHEMA_VERSION,
    revision: Number.isInteger(parsed.revision) ? parsed.revision! : 0,
    spend: {
      month: typeof spend.month === "string" ? spend.month : spendMonth(now),
      usd: finite(spend.usd) && spend.usd >= 0 ? spend.usd : 0,
      calls: finite(spend.calls) ? spend.calls : 0,
      capped: finite(spend.capped) ? spend.capped : 0,
    },
    seen: Array.isArray(parsed.seen) ? parsed.seen.filter((key): key is string => typeof key === "string") : [],
    scores: parseScores(parsed.scores),
    asks: Array.isArray(parsed.asks) ? parsed.asks.map(parseAsk).filter((ask): ask is OperatorAskRecord => ask !== null) : [],
  };
}

/** This month's spend: a new month starts from nothing. */
export function currentSpend(file: OperatorAsksFileV1, now: Date): AsksSpend {
  const month = spendMonth(now);
  return file.spend.month === month ? file.spend : { month, usd: 0, calls: 0, capped: 0 };
}

/** One read-modify-write. The classifier is the only writer, in one process. */
export function mutateOperatorAsks(
  mutation: (current: OperatorAsksFileV1) => void,
  now = new Date(),
  file = operatorAsksFile(),
): OperatorAsksFileV1 {
  const current = readOperatorAsks(file, now);
  current.spend = currentSpend(current, now);
  mutation(current);
  const floor = now.getTime() - ASK_RETENTION_MS;
  const next: OperatorAsksFileV1 = {
    ...current,
    revision: current.revision + 1,
    seen: current.seen.slice(-SEEN_CAPACITY),
    scores: Object.fromEntries(Object.entries(current.scores).slice(-SEEN_CAPACITY)),
    asks: current.asks.filter((ask) => ask.messageAt >= floor).slice(-ASK_CAPACITY),
  };
  writeJsonDurably(file, next, { space: 0 });
  return next;
}

/** Each conversation's newest ask, by durable id and by transcript path. */
export function openAskIndex(file: OperatorAsksFileV1): Map<string, OperatorAskRecord> {
  const index = new Map<string, OperatorAskRecord>();
  for (const ask of file.asks) {
    const held = index.get(ask.subject);
    if (held && held.messageAt > ask.messageAt) continue;
    index.set(ask.subject, ask);
    if (ask.conversationId) index.set(ask.conversationId, ask);
    index.set(ask.path, ask);
  }
  return index;
}

export function reportLogAsk(ask: OperatorAskRecord): ReportLogAsk {
  return {
    id: ask.id,
    at: new Date(ask.messageAt).toISOString(),
    conversationId: ask.conversationId,
    path: ask.path,
    role: ask.role,
    title: ask.title,
    gist: ask.gist,
  };
}

/** Moves whenever the file does, for the report log's `unchanged` answer. */
export function operatorAsksSignature(file = operatorAsksFile()): string {
  try {
    const stat = fs.statSync(file);
    return `asks:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "asks:missing";
  }
}

/** A project's ask lines, newest first, down to `since` (epoch ms) when given. */
export function projectReportLogAsks(
  inProject: (project: string) => boolean,
  since: number | null,
  limit: number,
  file: OperatorAsksFileV1 = readOperatorAsks(),
): ReportLogAsk[] {
  return file.asks
    .filter((ask) => inProject(ask.project) && (since === null || ask.messageAt >= since))
    .sort((left, right) => right.messageAt - left.messageAt || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map(reportLogAsk);
}
