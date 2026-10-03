import crypto from "node:crypto";
import { agentRegistry } from "@/lib/agent/registry";
import { withAccountMutationLock } from "@/lib/accounts/accountMutation";
import { seatIdentityResolver } from "@/lib/bridge/seatIdentity";

import { bridgeDirectiveBody, bridgeDirectiveId } from "@/lib/bridge/directive";
import { recordBridgeDirectiveAnswer, recordBridgeDirectivePendingAnswer } from "@/lib/bridge/service";
import { readBridgeReportLog } from "@/lib/bridge/store";
import type { BridgeReportV1 } from "@/lib/bridge/types";
import { orchestratorSeatForCurrentProject } from "@/lib/orchestrator/seatProjectIdentity";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { effectiveReportTelegram } from "@/lib/projects/settings";
import { readRuntimeSession, runtimeHostClient } from "@/lib/runtime/client";
import { resolveOriginalSend, type OriginalSendBinding, type OriginalSendEvidence } from "@/lib/runtime/sendSettlement";
import { enqueueStructuredMessage, type StructuredMessageDependencies } from "@/lib/runtime/structuredMessageDelivery";
import { withdrawRuntimeWake } from "@/lib/monitor/seatTickSources";
import { existingTeamStore } from "@/lib/team/store";

import { type ReportReplyRow, TelegramBotStore, type TgUpdate } from "./store";

export interface ReplySeat { conversationId: string; path: string | null }
export interface ReportReplyPorts {
  operatorId(): string | null;
  reports(): readonly BridgeReportV1[];
  destination(project: string): { chat: string; topicId?: number } | null;
  seat(project: string): ReplySeat | null;
  ready(seat: ReplySeat): Promise<boolean>;
  original(binding: OriginalSendBinding): Promise<OriginalSendEvidence>;
  deliver(binding: OriginalSendBinding & { path: string }): Promise<{ ok: boolean; operationId?: string; delivered?: boolean; refused?: boolean }>;
  withdraw(operationId: string, deliveryId: string | null): Promise<"withdrawn" | "too-late" | "unknown">;
}

/** Strict operator reading: the active installation owner, linked by Telegram sign-in. */
export function reportReplyOperatorId(): string | null {
  const owner = existingTeamStore()?.owner();
  return owner?.status === "active" ? owner.telegram?.userId ?? null : null;
}

/** Same durable reservation and runtime journal used by seat directives. */
export async function deliverReportReply(binding: OriginalSendBinding & { path: string }, dependencies: StructuredMessageDependencies = {}) {
  const result = await enqueueStructuredMessage({ ...binding, images: [], origin: { kind: "operator" }, policy: "queue", text: binding.text! }, dependencies);
  if (!result) return { ok: false, refused: true };
  return { ok: result.ok, operationId: result.operationId,
    delivered: result.ok && result.outcome === "delivered", refused: !result.ok && result.admission === "refused" };
}

export const productionReportReplyPorts: ReportReplyPorts = {
  operatorId: reportReplyOperatorId,
  reports: () => readBridgeReportLog().reports,
  destination: effectiveReportTelegram,
  seat: project => {
    const seat = orchestratorSeatForCurrentProject(project);
    return seat.pending ? null : seat.active?.conversationId ? { conversationId: seat.active.conversationId, path: seat.active.path } : null;
  },
  ready: async seat => {
    const client = runtimeHostClient();
    if (!client) return false;
    const session = await readRuntimeSession(client, { conversationId: seat.conversationId });
    return session?.host === "hosted" && session.turn === "idle";
  },
  original: resolveOriginalSend,
  deliver: deliverReportReply,
  withdraw: async (operationId, deliveryId) => {
    // A migration hold has not reached the runtime journal. Fence only a
    // still-held row under the same lock its assignment uses.
    if (deliveryId) {
      const withdrawn = withAccountMutationLock(() => {
        const registry = agentRegistry();
        const row = registry.readOnlySnapshot().heldDeliveries[deliveryId];
        if (row?.state !== "held" || row.command.operationId !== operationId) return false;
        registry.terminalizeHeldDelivery(deliveryId, "Telegram reply recipient rotated before delivery");
        return true;
      });
      if (withdrawn) return "withdrawn";
    }
    const client = runtimeHostClient();
    return client ? withdrawRuntimeWake(operationId, "Telegram reply recipient rotated before delivery", client) : "unknown";
  },
};

/** Only ordinary, unforwarded replies from the explicitly linked human enter. */
export function admitReportReplies(store: TelegramBotStore, botId: string, updates: readonly TgUpdate[], ports: ReportReplyPorts): void {
  const operatorId = ports.operatorId();
  if (!operatorId) return;
  const reports = ports.reports();
  for (const update of updates) {
    const message = update.message;
    if (!message || update.edited_message || update.edited_channel_post || message.edit_date != null
      || !message.from || message.from.is_bot !== false || message.sender_chat
      || !Number.isSafeInteger(message.from.id) || message.from.id <= 0 || String(message.from.id) !== operatorId
      || Object.keys(message).some(key => key.startsWith("forward_")) || message.is_automatic_forward
      || !Number.isSafeInteger(message.message_id) || message.message_id <= 0
      || !Number.isSafeInteger(message.chat.id) || !Number.isSafeInteger(message.reply_to_message?.message_id)) continue;
    const chatId = String(message.chat.id);
    const report = reports.find(report => {
      if (!report.project || report.origin?.kind !== "manager" || !report.origin.conversationId || !report.telegram) return false;
      const destination = ports.destination(report.project);
      const chat = destination ? store.resolveChat(destination.chat) : null;
      return chat?.chatId === chatId
        && (destination?.topicId ?? null) === (message.message_thread_id ?? null)
        // The bot receipt commits before the report log's Telegram mirror.
        // Match it directly so a reply in that window is still admitted.
        && store.postedReport(report.id, report.origin.conversationId, chatId, message.reply_to_message!.message_id);
    });
    if (!report?.project) continue;
    // Identity is per message, independent of update id, seat, and process lifetime.
    const identity = crypto.createHash("sha256").update(`${botId}:${chatId}:${message.message_id}`).digest("hex");
    const text = message.text?.trim() || message.caption?.trim() || "A non-text reply to this report arrived in Telegram; its media is not supported.";
    store.admitReportReply({ key: identity, botId, senderId: operatorId, project: canonicalOrchestratorProject(report.project), seq: report.seq,
      text: bridgeDirectiveBody(`Operator reply from Telegram:\n\n${text}`, { ref: report.seq }),
      state: "pending", attempt: 0, recipient: null, operationId: null, refused: false, revision: 0 });
  }
}

function binding(row: ReportReplyRow): OriginalSendBinding {
  return { conversationId: row.recipient!, clientMessageId: bridgeDirectiveId(`telegram_${row.key}`, row.attempt), text: row.text, origin: { kind: "operator" } };
}

/** The inbox holds busy/rotating seats. An uncertain send keeps its frozen identity. */
export async function drainReportReplies(store: TelegramBotStore, botId: string, ports: ReportReplyPorts): Promise<void> {
  for (let row of store.pendingReportReplies()) {
    if (row.botId !== botId || row.senderId !== ports.operatorId()) continue;
    const save = (next: ReportReplyRow): boolean => {
      if (!store.updateReportReply(row, next)) return false;
      row = { ...next, revision: row.revision + 1 };
      return true;
    };
    const finish = () => {
      recordBridgeDirectiveAnswer(row.seq, { project: row.project, seatConversationId: row.recipient! }, seatIdentityResolver(id => agentRegistry().canonicalConversationId(id)));
      save({ ...row, state: "delivered", text: "" });
    };
    const current = ports.seat(row.project);
    if (row.recipient) {
      const original = await ports.original(binding(row));
      if (original.kind === "found") {
        if (!original.current.readable) continue;
        const receipt = original.current.value;
        if (receipt.state === "delivered") { finish(); continue; }
        const safe = receipt.resend === "safe";
        const rotated = current?.conversationId !== row.recipient;
        const withdrawn = rotated && receipt.state === "in-flight"
          && await ports.withdraw(original.operationId, original.deliveryId) === "withdrawn";
        if (safe || withdrawn) {
          if (!save({ ...row, attempt: row.attempt + 1, recipient: null, operationId: null, refused: false })) continue;
        } else continue;
      } else if (original.kind !== "absent" || row.operationId) continue;
      else if (current?.conversationId !== row.recipient) {
        // Absence alone never licenses sending to a different recipient.
        if (!row.refused || !save({ ...row, attempt: row.attempt + 1, recipient: null, refused: false })) continue;
      }
    }
    if (!current || !await ports.ready(current)) continue;
    // Refresh designation after the asynchronous readiness check.
    if (ports.seat(row.project)?.conversationId !== current.conversationId) continue;
    if (!row.recipient && !save({ ...row, recipient: current.conversationId })) continue;
    if (row.recipient !== current.conversationId) continue;
    // Persist the dispatch boundary before asking the durable delivery path.
    if (!save({ ...row, refused: false })) continue;
    const result = await ports.deliver({ ...binding(row), path: current.path ?? "" });
    if (result.delivered) { finish(); continue; }
    if (result.operationId) {
      recordBridgeDirectivePendingAnswer(row.seq, { project: row.project, seatConversationId: row.recipient! }, result.operationId, seatIdentityResolver(id => agentRegistry().canonicalConversationId(id)));
    }
    save({ ...row, operationId: result.operationId ?? row.operationId, refused: result.refused === true });
  }
}
