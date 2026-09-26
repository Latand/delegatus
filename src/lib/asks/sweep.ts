import crypto from "node:crypto";

import type { FinalAssistantMessage } from "@/lib/scanner/lastAssistantMessage";

import { askGist, askSkipReason } from "./gist";
import { ASK_THRESHOLD, estimatedJevCostUsd, JevError, type JevVerdict } from "./jev";
import { currentSpend, type OperatorAskRecord, type OperatorAsksFileV1 } from "./store";

/*
 * One pass of the "Asks you" classifier (docs/research/attention-classifier.md
 * §7.1). For each conversation whose turn has ended, the last text the agent
 * wrote is sent once, unless a filter or the monthly cap says not to; an
 * answer at or over the threshold records an ask. A timeout, an error or a
 * missing key records nothing and is not retried: the message simply stays
 * unclassified, and nothing else waits on it.
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
  enabled: boolean;
  /** When the switch turned on: nothing older is sent. */
  enabledSince: number | null;
  capUsd: number;
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
}

function bodyKey(text: string): string {
  return `body:${crypto.createHash("sha1").update(text.trim()).digest("hex").slice(0, 20)}`;
}

export function askId(subject: string, messageId: string): string {
  return `ask:${subject}:${messageId}`;
}

export async function runAskSweep(ports: AskSweepPorts, inflight: Set<string> = new Set()): Promise<AskSweepResult> {
  const result: AskSweepResult = { classified: 0, asks: [], skipped: 0, capped: 0, failed: 0 };
  if (!ports.enabled || !ports.apiKey) return result;
  const key = ports.apiKey;
  let seen = new Set(ports.read().seen);
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
    const key = `${candidate.subject}:${message.id}`;
    if (seen.has(key) || inflight.has(key)) continue;
    const duplicate = bodyKey(message.text);
    const skip = message.engineError ? "engine-error" : askSkipReason(message.text) ?? (seen.has(duplicate) ? "duplicate" : null);
    if (skip) {
      ports.write((file) => { file.seen.push(key); });
      seen.add(key);
      result.skipped += 1;
      continue;
    }
    const estimate = estimatedJevCostUsd(message.text);
    const spend = currentSpend(ports.read(), now);
    if (spend.usd + estimate > ports.capUsd) {
      ports.write((file) => { file.seen.push(key); file.spend.capped += 1; });
      seen.add(key);
      result.capped += 1;
      continue;
    }
    inflight.add(key);
    let verdict: JevVerdict | null = null;
    let timedOut = false;
    try {
      verdict = await ports.classify(message.text, key);
    } catch (error) {
      verdict = null;
      timedOut = error instanceof JevError && error.code === "timeout";
    } finally {
      inflight.delete(key);
    }
    const recordedAt = ports.now();
    const ask: OperatorAskRecord | null = verdict && verdict.score >= ASK_THRESHOLD ? {
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
      score: verdict.score,
      recordedAt: recordedAt.toISOString(),
    } : null;
    ports.write((file) => {
      file.seen.push(key, duplicate);
      file.spend.calls += 1;
      /* A call that timed out may still have been billed: count the
         estimate, so the cap errs on the side of spending less. A refused
         or failed request bills nothing. */
      file.spend.usd += verdict ? verdict.costUsd : timedOut ? estimate : 0;
      if (ask && !file.asks.some((held) => held.id === ask.id)) file.asks.push(ask);
    });
    seen = new Set([...seen, key, duplicate]);
    if (!verdict) {
      result.failed += 1;
      continue;
    }
    result.classified += 1;
    if (ask) {
      result.asks.push(ask);
      ports.onAsk?.(ask);
    }
  }
  return result;
}
