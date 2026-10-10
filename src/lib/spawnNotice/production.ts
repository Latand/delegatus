import fs from "node:fs";

import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import { agentRegistry } from "@/lib/agent/registry";
import { boardFor } from "@/lib/board/store";
import { deliverConversationMessage } from "@/lib/delivery";
import { readOrchestratorSeatFileOrNull } from "@/lib/orchestrator/seats";
import { agentMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import { readRuntimeSession, runtimeHostClient } from "@/lib/runtime/client";
import { tailRecords } from "@/lib/scanner/activity";
import { recordValue, recordsValue, stringValue } from "@/lib/scanner/json";
import { lastAssistantMessageFromRecords } from "@/lib/scanner/lastAssistantMessage";
import { hardenedRedact } from "@/lib/view/compactText";

import {
  pendingSpawnNotices,
  pruneSpawnNotices,
  readSpawnNoticeChild,
  recordSpawnNoticeAttempt,
  settleSpawnNotices,
} from "./store";
import {
  sweepSpawnNotices,
  type SpawnNoticeFinalMessage,
  type SpawnNoticeRecipient,
  type SpawnNoticeSweepPorts,
} from "./sweep";

const TITLE_LIMIT = 200;
const ERROR_LIMIT = 500;
const PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;

/**
 * Who a notice goes to (spawn-completion-notice §3.3). A retired seat's notice
 * goes to the seat holding its project now; a launcher the registry no longer
 * knows, or one superseded, gets nothing; neither does one archived on its
 * project's board, which a send would otherwise resume. A launcher whose host
 * was merely retired while idle is delivered: the send resumes it.
 */
export function spawnNoticeRecipient(
  launcher: string,
  ports: {
    seats: typeof readOrchestratorSeatFileOrNull;
    conversation: (id: string) => ReturnType<ReturnType<typeof agentRegistry>["conversation"]>;
    hiddenPaths: (project: string) => readonly string[];
  } = {
    seats: readOrchestratorSeatFileOrNull,
    conversation: (id) => agentRegistry().conversation(id as ViewerConversationId),
    hiddenPaths: (project) => boardFor(project).prefs.hidden,
  },
): SpawnNoticeRecipient {
  let target = launcher;
  const seats = ports.seats();
  if (seats && !Object.values(seats.seats).some((seat) => seat.conversationId === launcher)) {
    const retired = seats.revocations
      .filter((revocation) => revocation.conversationId === launcher)
      .sort((left, right) => right.revokedAt.localeCompare(left.revokedAt))[0];
    if (retired) {
      const current = seats.seats[retired.project]?.conversationId;
      if (!current) return { kind: "skip", reason: "no-seat" };
      target = current;
    }
  }
  const conversation = ports.conversation(target);
  const generation = conversation?.generations.at(-1);
  if (!conversation || conversation.supersededBy || !generation) return { kind: "skip", reason: "launcher-gone" };
  const project = conversationProjectKey(conversation.projectOwnership, generation.launchProfile, { cwd: generation.launchProfile.cwd });
  if (project) {
    const hidden = new Set(ports.hiddenPaths(project));
    if (conversation.generations.some((item) => hidden.has(item.path))) return { kind: "skip", reason: "launcher-closed" };
  }
  return { kind: "deliver", conversationId: conversation.id, path: generation.path };
}

/** The engine's own error text in a transcript tail, newest first. */
export function transcriptErrorFromRecords(records: readonly Record<string, unknown>[], engine: string): string | null {
  const ordered = [...records];
  if (engine === "codex") {
    let terminalIndex = -1;
    for (let index = 0; index < ordered.length; index += 1) {
      const record = ordered[index]!;
      const type = stringValue(recordValue(record.payload)?.type);
      if (type === "task_complete" || type === "turn_aborted") terminalIndex = index;
    }
    // A later completed turn supersedes errors retained from an earlier turn.
    if (terminalIndex >= 0 && stringValue(recordValue(ordered[terminalIndex]?.payload)?.type) === "task_complete") return null;
    let startIndex = -1;
    for (let index = 0; index <= (terminalIndex >= 0 ? terminalIndex : ordered.length - 1); index += 1) {
      if (stringValue(recordValue(ordered[index]?.payload)?.type) === "task_started") startIndex = index;
    }
    const from = startIndex >= 0 ? startIndex : terminalIndex >= 0 ? terminalIndex : 0;
    for (const record of [...ordered.slice(from, terminalIndex >= 0 ? terminalIndex + 1 : undefined)].reverse()) {
      const payload = recordValue(record.payload) ?? {};
      const type = stringValue(payload.type);
      if (type === "error") return stringValue(payload.message) ?? null;
      if (type === "turn_aborted") return stringValue(payload.reason) ?? null;
    }
    return null;
  }
  for (const record of [...ordered].reverse()) {
    if (record.type === "assistant" && record.isApiErrorMessage === true) {
      const text = recordsValue(recordValue(record.message)?.content)
        .map((part) => stringValue(part.text) ?? "")
        .join("\n")
        .trim();
      if (text) return text;
    }
    if (record.type === "system" && record.level === "error") {
      const text = stringValue(record.content)?.trim();
      if (text) return text;
    }
  }
  return null;
}

/** The child's final assistant message and any error text, from one bounded
    tail read. A caller's egress redactor sees raw text before any shaping. */
export function spawnNoticeFinalMessage(child: string, redact: (text: string) => string = hardenedRedact): SpawnNoticeFinalMessage {
  try {
    const conversation = agentRegistry().conversation(child as ViewerConversationId);
    const generation = conversation?.generations.at(-1);
    if (!conversation || !generation) return { text: null, error: null };
    const stat = fs.statSync(generation.path);
    if (!stat.isFile()) return { text: null, error: null };
    const records = tailRecords(generation.path, stat.size, stat.mtimeMs);
    const root = conversation.engine === "codex" ? "codex-sessions" : "claude-projects";
    const message = lastAssistantMessageFromRecords(records, root, stat.mtimeMs);
    const text = message?.text.trim() ? redact(message.text.trim()) : null;
    const error = transcriptErrorFromRecords(records, conversation.engine);
    return { text, error: error ? redact(error).slice(0, ERROR_LIMIT) : null };
  } catch {
    return { text: null, error: null };
  }
}

function productionPorts(): SpawnNoticeSweepPorts {
  return {
    now: Date.now,
    pending: pendingSpawnNotices,
    childRecord: readSpawnNoticeChild,
    async child(child) {
      const conversation = agentRegistry().conversation(child as ViewerConversationId);
      if (!conversation) return null;
      const title = (conversation.generations.at(-1)?.launchProfile.title ?? "").trim().slice(0, TITLE_LIMIT) || "spawned agent";
      const client = runtimeHostClient();
      if (!client) return { title, busy: false };
      try {
        const session = await readRuntimeSession(client, { conversationId: conversation.id });
        const busy = session !== null && session.host === "hosted"
          && (session.turn === "running" || session.turn === "interrupt_requested");
        return { title, busy };
      } catch {
        /* Nothing can say the turn is over, and a send would fail the same
           way: hold, and the next pass asks again. */
        return { title, busy: true };
      }
    },
    recipient: (launcher) => spawnNoticeRecipient(launcher),
    finalMessage: spawnNoticeFinalMessage,
    origin: (child) => agentMessageOrigin(agentRegistry().conversationDeliverySnapshot({ conversationId: child }), child),
    recordAttempt: recordSpawnNoticeAttempt,
    settle: settleSpawnNotices,
    async deliver(request) {
      const outcome = await deliverConversationMessage(request);
      if (outcome.ok) return { ok: true, operationId: outcome.operationId ?? null };
      return {
        ok: false,
        error: outcome.error,
        uncertain: outcome.actuation === "started" || outcome.resend !== undefined || outcome.status >= 500,
      };
    },
    log: (message, error) => console.error(message, error ?? ""),
  };
}

const scheduleHost = globalThis as typeof globalThis & {
  __llvSpawnNoticeRunning?: Promise<void> | null;
  __llvSpawnNoticePrunedAt?: number;
};

/** Fire-and-forget, one pass at a time: the pipeline controller calls it on
    every cycle, which the runtime host's `turn-ended` signal and the 30 s
    watchdog both start. */
export function scheduleSpawnNoticeSweep(ports: SpawnNoticeSweepPorts = productionPorts()): void {
  if (scheduleHost.__llvSpawnNoticeRunning) return;
  const run = sweepSpawnNotices(ports)
    .then(() => {
      const now = ports.now();
      if (now - (scheduleHost.__llvSpawnNoticePrunedAt ?? 0) < PRUNE_INTERVAL_MS) return;
      scheduleHost.__llvSpawnNoticePrunedAt = now;
      pruneSpawnNotices(new Date(now - RETENTION_MS).toISOString());
    })
    .catch((error) => ports.log?.("[spawn notice] sweep failed", error))
    .finally(() => { scheduleHost.__llvSpawnNoticeRunning = null; });
  scheduleHost.__llvSpawnNoticeRunning = run;
}
