import type { DismissedBy } from "@/lib/attention/dismissalTypes";
import type { BridgeAsk, FileEntry } from "@/lib/types";

import {
  type BridgeResolvedAskV1,
  bridgeReportOriginLabel,
  isBridgeDecisionRequestClass,
  BRIDGE_ASK_TTL_SECONDS,
  type BridgeReportLogV1,
  type BridgeReportV1,
  type CanonicalSeatConversationId,
} from "./types";

/**
 * The bridge log, read as "who is waiting on the operator" (issue #1168).
 *
 * The report log has always had exactly one consumer: the voice gateway, which
 * drains it while a call is live and at the start of its next turn. So with the
 * gateway off — the ordinary state of this machine — a manager that filed
 * `blocked` ("I cannot proceed") or `question` ("I need an answer") reached the
 * operator as prose inside a dock feed and nothing else. No badge, no count, no
 * queue entry, nothing that survives scrolling past it.
 *
 * This module is the missing read. It is pure over the log and derives at
 * read time: everything it decides comes out of fields the log already
 * carries — the row's class, key and seq, the seqs a directive answered, and
 * the seqs the operator resolved — plus, when the caller has them, the
 * operator's own messages to the seat.
 *
 * EVERY unanswered decision request is its own question. The report log shows
 * each one with a tick, and the needs-you panel lists each one as a row; the
 * two read this one projection, so they cannot disagree about which are open.
 * A question stops asking when:
 *
 * - the operator resolves it (a tick in the log, «Dismiss» on its row), which
 *   is one record, `resolvedAsks`, in the log itself;
 * - a directive answered its seq and reached the manager;
 * - the operator wrote to the seat after it was filed: they answered it there;
 * - its seat is no longer the project's: a project has exactly one designated
 *   orchestrator at a time, so the successor's first report retires whatever
 *   its predecessor was still asking;
 * - it aged past {@link BRIDGE_ASK_TTL_SECONDS}.
 *
 * The manager merely filing another report no longer retires a question: that
 * made at most one question open per project, so a second question silently
 * took the first one away before anybody had read it.
 */

/** Where one decision request stands. `open` asks; every other state does not. */
export type BridgeQuestionState = "open" | "resolved" | "answered" | "retired" | "lapsed";

export interface BridgeQuestion {
  report: BridgeReportV1;
  /** The seat that filed it, canonical. */
  seat: string;
  state: BridgeQuestionState;
  /** Set on `resolved`: the operator's (or an agent's) record. */
  resolved?: { at: string; by: DismissedBy };
}

/**
 * Whether one row speaks in the MANAGER's own voice.
 *
 * `bridge_report` is callable from every session, and this ask points at the
 * orchestrator's own card, which would misattribute a worker's blocker to the
 * seat that never filed it. The origin label is the existing authority on that
 * question (a null label means the manager's own voice, legacy origin-less rows
 * included), so this reuses it rather than minting a second rule.
 */
function isManagerVoice(report: BridgeReportV1): boolean {
  return bridgeReportOriginLabel(report.origin) === null;
}

/**
 * The identity #1168 puts on the attention item: the caller's own report key,
 * verbatim, or nothing.
 *
 * The acceptance criterion is `id = the report key`, so there is no substitute
 * to fall back to — the hashed `id` is a digest and cannot be spelled back out
 * into the key it was derived from. A row that carries no key therefore opens
 * no ask at all rather than reaching the operator's card under an identity the
 * contract does not name.
 *
 * Only rows written BEFORE the log kept keys are in that position; the store
 * writes every decision request's key through verbatim, so nothing appended
 * since can land here. Excluding them is bounded: the log's capacity retires
 * them, the seat's next report opens a compliant ask, and the seat keeps every
 * other attention signal it had before this projection existed.
 */
function askIdentity(report: BridgeReportV1): string | null {
  const key = report.key?.trim();
  return key ? key : null;
}

export interface OpenBridgeAskOptions {
  now: Date;
  ttlSeconds?: number;
  /** Resolves a report's recorded seat to the conversation identity the file
      scan carries, so an account migration's rekey does not orphan the ask. The
      SAME resolver settles a directive's ref (`recordBridgeDirectiveAnswer`):
      one side canonicalizing while the other compares raw ids is how a rekeyed
      seat's ask outlives the directive that answered it. */
  canonicalConversationId?: CanonicalSeatConversationId;
  /** Whether an accepted directive's send has since been DELIVERED (#1131).
      A directive the runtime only admitted has reached nobody, so its answer
      waits in the log against the operation id that send returned; this is what
      turns that parked ref into a cleared ask, and what leaves a dropped one
      standing. Absent, only recorded answers clear an ask. */
  deliveredOperation?: (operationId: string) => boolean;
  /** Whether the operator wrote to this seat (canonical id) at or after
      `atMs`: an answer given in the seat's own conversation. Absent, only the
      log's own records clear a question. */
  operatorWroteSince?: (seat: string, atMs: number) => boolean;
}

/** The first line of a report, bounded, for the row that lists it. */
const ASK_LINE_MAX = 240;
function askLine(body: string): string {
  const line = body.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > ASK_LINE_MAX ? `${line.slice(0, ASK_LINE_MAX - 1)}…` : line;
}

/**
 * Every decision request the log holds, oldest first, with where it stands.
 * Only rows in the manager's own voice (see {@link isManagerVoice}), routed to
 * a project and a seat, keyed, and dated are questions at all: the rest never
 * asked anyone.
 */
export function bridgeQuestions(log: BridgeReportLogV1, options: OpenBridgeAskOptions): BridgeQuestion[] {
  const canonical = options.canonicalConversationId ?? ((id: string) => id);
  const ttlMs = (options.ttlSeconds ?? BRIDGE_ASK_TTL_SECONDS) * 1000;
  const answered = new Set(log.answeredRefs ?? []);
  const delivered = options.deliveredOperation;
  if (delivered) {
    for (const pending of log.pendingAnswers ?? []) {
      if (delivered(pending.operationId)) answered.add(pending.ref);
    }
  }
  const resolved = new Map((log.resolvedAsks ?? []).map((entry) => [entry.seq, entry] as const));

  /* Which seat is the project's now: the one its manager's newest report was
     routed to, whatever class it was. */
  const currentSeat = new Map<string, BridgeReportV1>();
  for (const report of log.reports) {
    if (!isManagerVoice(report)) continue;
    if (!report.project || !report.targetSeatConversationId) continue;
    const incumbent = currentSeat.get(report.project);
    if (!incumbent || report.seq > incumbent.seq) currentSeat.set(report.project, report);
  }

  const questions: BridgeQuestion[] = [];
  for (const report of [...log.reports].sort((left, right) => left.seq - right.seq)) {
    if (!isManagerVoice(report)) continue;
    if (!report.project || !report.targetSeatConversationId) continue;
    if (!isBridgeDecisionRequestClass(report.class)) continue;
    if (askIdentity(report) === null) continue;
    const at = Date.parse(report.at);
    /* An unparseable time cannot be aged, and an ask nothing can retire is
       worse than one that never opened. */
    if (!Number.isFinite(at)) continue;
    const seat = canonical(report.targetSeatConversationId);
    const project = currentSeat.get(report.project);
    const record = resolved.get(report.seq);
    let state: BridgeQuestionState = "open";
    if (record) state = "resolved";
    else if (answered.has(report.seq) || options.operatorWroteSince?.(seat, at)) state = "answered";
    else if (project && canonical(project.targetSeatConversationId!) !== seat) state = "retired";
    else if (options.now.getTime() - at > ttlMs) state = "lapsed";
    questions.push({ report, seat, state, ...(record ? { resolved: { at: record.at, by: record.by } } : {}) });
  }
  return questions;
}

/**
 * The open questions of every seat, oldest first, keyed by the conversation id
 * of the seat that filed them — which is the card the operator answers them on.
 * Each is its own needs-you item.
 */
export function openBridgeAsks(
  log: BridgeReportLogV1,
  options: OpenBridgeAskOptions,
): Map<string, BridgeAsk[]> {
  const asks = new Map<string, BridgeAsk[]>();
  for (const question of bridgeQuestions(log, options)) {
    if (question.state !== "open") continue;
    const list = asks.get(question.seat) ?? [];
    list.push({ id: askIdentity(question.report)!, at: question.report.at, seq: question.report.seq, body: askLine(question.report.body) });
    asks.set(question.seat, list);
  }
  return asks;
}

/**
 * Stamp each seat's open ask onto its own scanned entry.
 *
 * A retired round is skipped on purpose. Terminal supersedence (issue #383) and
 * migration both demote a conversation's live attention fields earlier in the
 * projection — `pendingQuestion`, `waitingInput`, the rate-limit wall — because
 * the successor carries the live card. An ask stamped afterwards would be the
 * one signal that survived that demotion and would re-raise a dead round's
 * card. Every other entry is left exactly as it was, including one whose
 * conversation the registry has not identified yet.
 */
export function overlayBridgeAsks(
  files: FileEntry[],
  asks: ReadonlyMap<string, readonly BridgeAsk[]>,
): void {
  if (asks.size === 0) return;
  for (const file of files) {
    if (file.supersededBy || file.migratedTo) continue;
    const open = file.conversationId ? asks.get(file.conversationId) : undefined;
    if (!open?.length) continue;
    file.bridgeAsks = [...open];
    file.bridgeAsk = open.at(-1)!;
  }
}

/**
 * The operator's resolutions as the seat tick reads them (§5.1): a question
 * the operator resolved is a question they answered, so it counts as an
 * operator message in the seat it was asked from, at the moment it was
 * resolved. Only the operator's own resolutions count, and only of the rows
 * handed in (the project's manager reports).
 */
export function resolvedQuestionAnswers(
  reports: readonly BridgeReportV1[],
  resolved: readonly BridgeResolvedAskV1[],
): { conversationId: string; at: string }[] {
  const bySeq = new Map(reports.map((report) => [report.seq, report] as const));
  return resolved.flatMap((entry) => {
    const report = bySeq.get(entry.seq);
    return report?.targetSeatConversationId && entry.by.kind === "operator" && isBridgeDecisionRequestClass(report.class)
      ? [{ conversationId: report.targetSeatConversationId, at: entry.at }]
      : [];
  });
}
