import crypto from "node:crypto";

import type { FinalAssistantMessage } from "@/lib/scanner/lastAssistantMessage";

import { askGist, askSkipReason } from "./gist";
import { ASK_THRESHOLD, jevCostCeilingUsd, jevFailureCostUsd, type JevVerdict } from "./jev";
import { currentSpend, spendMonth, type OperatorAskRecord, type OperatorAsksFileV1 } from "./store";

/*
 * One pass of the "Asks you" classifier (docs/research/attention-classifier.md
 * §7.1). For each conversation whose turn has ended, the last text the agent
 * wrote is sent once, unless a filter or the monthly cap says not to, or the
 * same words were already scored; an answer at or over the threshold records
 * an ask. A timeout, an error or a missing key records no ask and is not
 * retried: the message simply stays unclassified, and nothing else waits on
 * it. What a failed call may have cost still counts against the cap.
 *
 * The send is written ahead of the call: the message marked seen and its
 * largest possible cost counted, then settled to what the call cost once it
 * answers. A state write that fails after the call, or a process that dies
 * during it, leaves the ceiling counted and the message never sent again; a
 * send that cannot be recorded is not made. A state file that cannot be read
 * holds a spend nobody knows, so it counts as a cap reached: nothing is sent.
 */

/** A message older than this when the sweep first sees it is history. */
export const ASK_MAX_AGE_MS = 30 * 60_000;

/** One conversation as the sweep sees it. */
export interface AskCandidate {
  /** The durable conversation id, or the transcript path. */
  subject: string;
  conversationId: string | null;
  path: string;
  project: string;
  role: string | null;
  title: string | null;
  /** The agent is working: its turn has not ended. */
  working: boolean;
  /** A structured reason already holds: a question, a plan, a prompt. */
  structuredAsk: boolean;
  /** Epoch ms the latest turn started, when known. */
  lastTurnStartedAt: number | null;
}

export interface AskSweepPorts {
  now(): Date;
  /** The operator's switch and cap as they stand now. Read before every
      call, so a switch turned off mid-sweep sends nothing more. */
  settings(): { enabled: boolean; capUsd: number };
  /** When the switch turned on: nothing older is sent. */
  enabledSince: number | null;
  apiKey: string | null;
  candidates: readonly AskCandidate[];
  finalMessage(candidate: AskCandidate): FinalAssistantMessage | null;
  classify(text: string, apiKey: string): Promise<JevVerdict>;
  read(): OperatorAsksFileV1;
  write(mutation: (file: OperatorAsksFileV1) => void): void;
  /** Called once a new ask is recorded, so the board reads it without waiting. */
  onAsk?(ask: OperatorAskRecord): void;
}

export interface AskSweepResult {
  classified: number;
  asks: OperatorAskRecord[];
  skipped: number;
  capped: number;
  failed: number;
  /** The state file could not be read, so nothing was sent. */
  unreadable: boolean;
}

function bodyKey(text: string): string {
  return `body:${crypto.createHash("sha1").update(text.trim()).digest("hex").slice(0, 20)}`;
}

export function askId(subject: string, messageId: string): string {
  return `ask:${subject}:${messageId}`;
}

/**
 * `sent` is the caller's record of every message this process has sent, by
 * seen key to the message's time, kept for the life of the process: a message
 * is never sent twice here even while the state file cannot be written. A key
 * leaves it once its message is too old to be sent at all.
 */
export async function runAskSweep(ports: AskSweepPorts, sent: Map<string, number> = new Map()): Promise<AskSweepResult> {
  const result: AskSweepResult = { classified: 0, asks: [], skipped: 0, capped: 0, failed: 0, unreadable: false };
  if (!ports.apiKey || !ports.settings().enabled) return result;
  const credential = ports.apiKey;
  const horizon = ports.now().getTime() - ASK_MAX_AGE_MS;
  for (const [key, messageAt] of sent) if (messageAt < horizon) sent.delete(key);
  let state: OperatorAsksFileV1;
  try {
    state = ports.read();
  } catch {
    result.unreadable = true;
    return result;
  }
  const seen = new Set(state.seen);
  for (const candidate of ports.candidates) {
    if (candidate.working || candidate.structuredAsk) continue;
    const message = ports.finalMessage(candidate);
    if (!message) continue;
    const now = ports.now();
    /* The message must end the latest turn: one written before the latest
       prompt was already answered. */
    if (candidate.lastTurnStartedAt !== null && message.ts < candidate.lastTurnStartedAt) continue;
    if (now.getTime() - message.ts > ASK_MAX_AGE_MS) continue;
    if (ports.enabledSince !== null && message.ts < ports.enabledSince) continue;
    const seenKey = `${candidate.subject}:${message.id}`;
    if (seen.has(seenKey) || sent.has(seenKey)) continue;
    const skip = message.engineError ? "engine-error" : askSkipReason(message.text);
    if (skip) {
      ports.write((file) => { file.seen.push(seenKey); });
      seen.add(seenKey);
      result.skipped += 1;
      continue;
    }
    const settings = ports.settings();
    if (!settings.enabled) break;
    const textKey = bodyKey(message.text);
    const askFor = (score: number): OperatorAskRecord | null => score >= ASK_THRESHOLD ? {
      id: askId(candidate.subject, message.id),
      subject: candidate.subject,
      conversationId: candidate.conversationId,
      path: candidate.path,
      project: candidate.project,
      role: candidate.role,
      title: candidate.title,
      messageId: message.id,
      messageAt: message.ts,
      gist: askGist(message.text),
      score,
      recordedAt: ports.now().toISOString(),
    } : null;
    const record = (ask: OperatorAskRecord | null) => {
      if (!ask) return;
      result.asks.push(ask);
      ports.onAsk?.(ask);
    };
    /* Words already judged, by this agent before or by another, are judged
       the same again without a call: a question repeated after the operator
       answered is a new ask. */
    const known = ports.read().scores[textKey];
    if (known !== undefined) {
      const ask = askFor(known);
      ports.write((file) => {
        file.seen.push(seenKey);
        if (ask && !file.asks.some((held) => held.id === ask.id)) file.asks.push(ask);
      });
      seen.add(seenKey);
      result.skipped += 1;
      record(ask);
      continue;
    }
    const ceiling = jevCostCeilingUsd(message.text);
    const spend = currentSpend(ports.read(), now);
    if (spend.usd + ceiling > settings.capUsd) {
      ports.write((file) => { file.seen.push(seenKey); file.spend.capped += 1; });
      seen.add(seenKey);
      result.capped += 1;
      continue;
    }
    const month = spendMonth(now);
    ports.write((file) => {
      file.seen.push(seenKey);
      file.spend.calls += 1;
      file.spend.usd += ceiling;
    });
    seen.add(seenKey);
    sent.set(seenKey, message.ts);
    let verdict: JevVerdict | null = null;
    let failureCost = 0;
    try {
      verdict = await ports.classify(message.text, credential);
    } catch (error) {
      verdict = null;
      failureCost = jevFailureCostUsd(error, ceiling);
    }
    const ask = verdict ? askFor(verdict.score) : null;
    ports.write((file) => {
      /* The reservation settles to what the call may have cost: what the
         provider reported, or else the ceiling, so the cap errs on the side
         of spending less. Only an error status is known to bill nothing. A
         month that turned during the call keeps the reservation where it was
         made. */
      if (file.spend.month === month) file.spend.usd = Math.max(0, file.spend.usd - ceiling + (verdict ? verdict.costUsd : failureCost));
      if (verdict) {
        delete file.scores[textKey];
        file.scores[textKey] = verdict.score;
      }
      if (ask && !file.asks.some((held) => held.id === ask.id)) file.asks.push(ask);
    });
    if (!verdict) {
      result.failed += 1;
      continue;
    }
    result.classified += 1;
    record(ask);
  }
  return result;
}
