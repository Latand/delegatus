import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import type { ExternalRelayRequester } from "./protocol";
import { exemptFromMemberLimit, type RelayAnswerProfile } from "./profile";

/**
 * One read-only record per relayed request this install claimed (relay.md
 * §B.2): the input as the service sent it, the answer or hand-off, timing and
 * outcome. A record is kept for RELAY_ANSWER_RETENTION_DAYS after it ended.
 * It never holds the credential or the lease id, and nothing resumes from it.
 *
 * Layout: `external-relay/answers/<relay>/<target>/<started ms>_<request>.json`,
 * so a target's newest records are its last file names.
 */
export const RELAY_ANSWER_RETENTION_DAYS = 30;
const RETENTION_MS = RELAY_ANSWER_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const RELAY_ANSWER_LIST_LIMIT = 50;
const PREVIEW_CHARS = 160;
const safeId = /^[A-Za-z0-9_-]{1,64}$/;

export type RelayAnswerDelivery = "accepted" | "refused" | "unconfirmed";
/** Who asked, as the service's requester block says. Recorded, never trusted for access. */
export type RelayAnswerRequester = ExternalRelayRequester;
export type RelayToolCallRecord = {
  effect?: "action";
  round: number; tool: string; page: boolean; status: string; code: string | null;
  audience: string | null; truncated: boolean; replayed: boolean; withheld: boolean; local: boolean;
};
export type RelayAnswerRecord = {
  conversationId?: string;
  compaction?: { member: string; owner: string };
  rounds?: number;
  toolCalls?: RelayToolCallRecord[];
  v: 1;
  requestId: string;
  relayId: string;
  targetId: string;
  targetName: string | null;
  engine: string | null;
  model: string | null;
  claimedAt: string | null;
  /** The request's chat key (§A.8), when it carried one. */
  chatKey: string | null;
  requester: RelayAnswerRequester | null;
  /** True once the run was reserved: the answers the member limit counts. */
  admitted: boolean;
  /** The answer profile the run was given; null when it never ran. */
  profile: RelayAnswerProfile | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  state: "running" | "finished";
  /** `answered`, `declined:<reason>`, `failed:<reason>` or `lease_lost`; hand-off is `declined:handoff`. */
  outcome: string | null;
  answer: { action: string; text: string; reply_to: string | null } | null;
  /** Whether the service acknowledged the completion; null when none was sent. */
  delivery: RelayAnswerDelivery | null;
  /** `Request.input` exactly as received, unknown fields included. */
  input: unknown;
};
export type RelayAnswerSummary = Pick<
  RelayAnswerRecord,
  "requestId" | "startedAt" | "finishedAt" | "durationMs" | "state" | "outcome" | "delivery"
> & { request: string; answer: string | null };

export const relayAnswersRoot = () => statePath("external-relay/answers");
const targetDir = (relayId: string, targetId: string) =>
  path.join(relayAnswersRoot(), relayId, targetId);
const recordName = /^(\d+)_([A-Za-z0-9_-]{1,64})\.json$/;
const recordTempName = /^(\d+)_([A-Za-z0-9_-]{1,64})\.json\.\d+\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/;
/** The record files of one target, newest first, optionally of one request. */
function recordFiles(dir: string, requestId?: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") logFailure("read", error);
    return [];
  }
  return names
    .map((name) => recordName.exec(name))
    .filter((match): match is RegExpExecArray => !!match && (requestId === undefined || match[2] === requestId))
    .sort((a, b) => Number(b[1]) - Number(a[1]) || b[2]!.localeCompare(a[2]!))
    .map((match) => path.join(dir, match[0]));
}

function writeRecord(file: string, record: RelayAnswerRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
function readRecord(file: string): RelayAnswerRecord | null {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as RelayAnswerRecord;
    return record?.v === 1 && typeof record.requestId === "string" ? record : null;
  } catch {
    return null;
  }
}
const logFailure = (what: string, error: unknown) =>
  console.error(`External relay answer record ${what} failed`, error instanceof Error ? error.name : "unknown");
const expired = (record: RelayAnswerRecord, now: number) =>
  record.state === "finished" &&
  now - Date.parse(record.finishedAt ?? record.startedAt) > RETENTION_MS;

/**
 * The record of one claimed request, written as it moves. `begin` marks it
 * running once the agent launches, so a restart can settle it; `finish`
 * writes the terminal state. A request whose ids cannot name a file gets no
 * record. A failed write is logged and never stops the run or its cleanup.
 */
export function answerRecorder(base: {
  requestId: unknown;
  relayId: string;
  targetId: unknown;
  targetName: string | null;
  claimedAt: unknown;
  chatKey?: string | null;
  requester?: ExternalRelayRequester | null;
  input: unknown;
}) {
  const { requestId, targetId } = base;
  if (typeof requestId !== "string" || typeof targetId !== "string" || !safeId.test(requestId) || !safeId.test(targetId) || !safeId.test(base.relayId))
    return null;
  const started = Date.now();
  const file = path.join(targetDir(base.relayId, targetId), `${started}_${requestId}.json`);
  let record: RelayAnswerRecord = {
    v: 1,
    requestId,
    relayId: base.relayId,
    targetId,
    targetName: base.targetName,
    engine: null,
    model: null,
    claimedAt: typeof base.claimedAt === "string" ? base.claimedAt : null,
    chatKey: base.chatKey ?? null,
    requester: base.requester
      ? { ...base.requester }
      : null,
    admitted: false,
    profile: null,
    startedAt: new Date(started).toISOString(),
    finishedAt: null,
    durationMs: null,
    state: "running",
    outcome: null,
    answer: null,
    delivery: null,
    input: base.input ?? null,
  };
  let begun = false;
  let finished = false;
  return {
    get begun() { return begun; },
    get finished() { return finished; },
    begin(engine: string | null, model: string | null, profile: RelayAnswerProfile) {
      record = { ...record, engine, model, profile, admitted: true };
      begun = true;
      try {
        writeRecord(file, record);
      } catch (error) {
        logFailure("write", error);
      }
    },
    bindConversation(conversationId: string) {
      record = { ...record, conversationId };
      if (begun) {
        try { writeRecord(file, record); } catch (error) { logFailure("write", error); }
      }
    },
    finish(result: Pick<RelayAnswerRecord, "outcome" | "answer" | "delivery"> & Partial<Pick<RelayAnswerRecord, "rounds" | "toolCalls" | "compaction">>) {
      if (finished) return;
      finished = true;
      const now = Date.now();
      record = { ...record, ...result, state: "finished", finishedAt: new Date(now).toISOString(), durationMs: now - started };
      try {
        writeRecord(file, record);
      } catch (error) {
        logFailure("write", error);
      }
    },
    recordDelivery(result: Pick<RelayAnswerRecord, "outcome" | "delivery">) {
      if (!finished) return;
      // Keep the locally generated answer even if delivery rejects it.
      record = { ...record, ...result };
      try {
        writeRecord(file, record);
      } catch (error) {
        logFailure("write", error);
      }
    },
  };
}
export type AnswerRecorder = NonNullable<ReturnType<typeof answerRecorder>>;

/** Settles a record a dead owner left running, as the orphan sweep settles its lease. */
export function settleInterruptedAnswer(relayId: string, targetId: string, requestId: string, delivery: RelayAnswerDelivery, conversationId?: string): void {
  try {
    for (const file of recordFiles(targetDir(relayId, targetId), requestId)) {
      const record = readRecord(file);
      if (!record) continue;
      if (record.state !== "running") {
        if (conversationId && record.conversationId !== conversationId) writeRecord(file, { ...record, conversationId });
        continue;
      }
      const now = Date.now();
      writeRecord(file, {
        ...record,
        ...(conversationId ? { conversationId } : {}),
        state: "finished",
        outcome: "failed:install_restarted",
        delivery,
        finishedAt: new Date(now).toISOString(),
        durationMs: now - Date.parse(record.startedAt),
      });
    }
  } catch (error) {
    logFailure("settle", error);
  }
}

/** Removes expired records, and reconciles unfinished records when the owner
 * supplies the active ledger. Snapshot files before the ledger so a newly
 * reserved run cannot be mistaken for abandoned work. */
export function pruneAnswerRecords(now = Date.now(), activeRuns?: () => readonly {
  relayId: string; targetId: string; requestId: string;
}[]): number {
  let removed = 0;
  const root = relayAnswersRoot();
  const entries = (dir: string) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  const files: string[] = [];
  for (const relay of entries(root))
    for (const target of entries(path.join(root, relay)))
      for (const name of entries(path.join(root, relay, target))) {
        if (!recordName.test(name) && !recordTempName.test(name)) continue;
        files.push(path.join(root, relay, target, name));
      }
  let active: Set<string> | null = null;
  const key = (run: { relayId: string; targetId: string; requestId: string }) =>
    JSON.stringify([run.relayId, run.targetId, run.requestId]);
  try {
    if (activeRuns) active = new Set(activeRuns().map(key));
  } catch (error) {
    logFailure("reconcile", error);
    return removed;
  }
  for (const file of files) {
    try {
      // Without ledger reconciliation, recent files need no read.
      const old = now - fs.statSync(file).mtimeMs > RETENTION_MS;
      if (!active && !old) continue;
      const temporary = recordTempName.exec(path.basename(file));
      if (temporary) {
        const scope = { relayId: path.basename(path.dirname(path.dirname(file))), targetId: path.basename(path.dirname(file)), requestId: temporary[2]! };
        if (!old || active?.has(key(scope))) continue;
        fs.rmSync(file, { force: true });
        removed += 1;
        continue;
      }
      const record = readRecord(file);
      if (record?.state === "running" && active) {
        if (active.has(key(record))) continue;
        if (!old) {
          writeRecord(file, {
            ...record, state: "finished", outcome: "failed:install_restarted", delivery: "unconfirmed",
            finishedAt: new Date(now).toISOString(), durationMs: now - Date.parse(record.startedAt),
          });
          continue;
        }
        // A failed settlement write must not keep abandoned chat text
        // forever. An active run above is always preserved.
      } else if (record && !expired(record, now)) continue;
      if (!old) continue;
      fs.rmSync(file, { force: true });
      removed += 1;
    } catch (error) {
      logFailure("prune", error);
    }
  }
  return removed;
}

const clip = (text: string) => {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS - 1).join("")}…` : chars.join("");
};
/** The text the request answers: the message named by respond_to, else request_text. */
function requestPreview(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = input as { respond_to?: unknown; request_text?: unknown; conversation?: unknown };
  const conversation = Array.isArray(value.conversation) ? value.conversation : [];
  const trigger = conversation.find((message) => message && typeof message === "object" && (message as { id?: unknown }).id === value.respond_to) as { text?: unknown } | undefined;
  if (trigger && typeof trigger.text === "string") return clip(trigger.text);
  return typeof value.request_text === "string" ? clip(value.request_text) : "";
}

/** A target's records, newest first, at most `limit`, without expired ones. */
export function listAnswerRecords(relayId: string, targetId: string, limit = RELAY_ANSWER_LIST_LIMIT): RelayAnswerSummary[] {
  if (!safeId.test(relayId) || !safeId.test(targetId)) return [];
  const now = Date.now();
  const rows: RelayAnswerSummary[] = [];
  for (const file of recordFiles(targetDir(relayId, targetId))) {
    if (rows.length >= limit) break;
    const record = readRecord(file);
    if (!record || expired(record, now)) continue;
    rows.push({
      requestId: record.requestId,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: record.durationMs,
      state: record.state,
      outcome: record.outcome,
      delivery: record.delivery,
      request: requestPreview(record.input),
      answer: record.answer?.text ? clip(record.answer.text) : null,
    });
  }
  return rows;
}

/**
 * The answers this install ran for one member in one chat since `sinceMs`
 * (§B.8), and when the oldest of them started. A request without a chat key
 * counts against the member's other keyless requests to the target.
 */
export function countMemberAnswers(scope: {
  relayId: string;
  targetId: string;
  chatKey: string | null;
  requesterKey: string;
  sinceMs: number;
}): { count: number; oldestMs: number | null } {
  const counted = new Set<string>();
  let count = 0;
  let oldestMs: number | null = null;
  if (!safeId.test(scope.relayId) || !safeId.test(scope.targetId)) return { count, oldestMs };
  for (const file of recordFiles(targetDir(scope.relayId, scope.targetId))) {
    const started = Number(recordName.exec(path.basename(file))?.[1]);
    // Newest first: the rest started before the window.
    if (started < scope.sinceMs) break;
    const record = readRecord(file);
    if (
      !record?.admitted ||
      !record.requester ||
      record.requester.key !== scope.requesterKey ||
      exemptFromMemberLimit(record.requester) ||
      (record.chatKey ?? null) !== scope.chatKey
    ) continue;
    if (!counted.has(record.requestId)) {
      counted.add(record.requestId);
      count += 1;
    }
    oldestMs = started;
  }
  return { count, oldestMs };
}

/** One record, or null when it is unknown or expired. */
export function readAnswerRecord(relayId: string, targetId: string, requestId: string): RelayAnswerRecord | null {
  if (!safeId.test(relayId) || !safeId.test(targetId) || !safeId.test(requestId)) return null;
  const [file] = recordFiles(targetDir(relayId, targetId), requestId);
  const record = file ? readRecord(file) : null;
  return record && !expired(record, Date.now()) ? record : null;
}
