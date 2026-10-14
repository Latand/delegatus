import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { readBridgeReportLog } from "@/lib/bridge/store";
import type { BridgeReportV1 } from "@/lib/bridge/types";
import { openCurrentDatabase } from "@/lib/state/currentDatabase";
import { publishedRelayReference, type PublishedRelayReference } from "./publishedReferences";
import type { ExternalRelayRequest } from "./protocol";
import type { OwnerInstruction } from "./profile";

export interface OwnerBridgeContext {
  project: string;
  sourceSeat: string;
  reportId: string;
  reportText: string;
}
export interface OwnerBridgeContextPorts {
  reports(): readonly BridgeReportV1[];
  reference(messageKey: string): PublishedRelayReference | null;
  chatId(alias: string): string | null;
}

function recordedChatId(alias: string): string | null {
  const file = statePath("telegram/bot.sqlite");
  if (!fs.existsSync(file)) return null;
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("owner report context requires the Bun runtime");
  const db = openCurrentDatabase(file, () => new sqlite.Database(file, { readonly: true }));
  try {
    return db.query<{ chat_id: string }, [string, string]>("SELECT chat_id FROM chats WHERE lower(alias) = ? OR chat_id = ?")
      .get(alias.trim().toLowerCase(), alias.trim())?.chat_id ?? null;
  } finally { db.close(); }
}

/** A reply, or a bare approval's immediately preceding message, must match a confirmed
 * publication receipt and the report's own Telegram message id and chat. */
export function resolveOwnerBridgeContext(request: ExternalRelayRequest, owner: OwnerInstruction, apiBase: string,
  ports: OwnerBridgeContextPorts = {
    reports: () => readBridgeReportLog().reports,
    reference: messageKey => publishedRelayReference(apiBase, request.target_id, messageKey),
    chatId: recordedChatId,
  }): OwnerBridgeContext | null {
  const messages = request.input.conversation;
  const triggerIndex = messages.findIndex(message => message.id === owner.messageId);
  const trigger = messages[triggerIndex];
  if (!trigger) return null;
  const previous = messages.slice(0, triggerIndex).at(-1);
  const messageKey = trigger.reply_to ?? (ownerNeedsClarification({ ...owner, bridgeReport: null }) ? previous?.id : undefined);
  if (!messageKey) return null;
  const reference = ports.reference(messageKey);
  if (!reference || reference.apiBase !== apiBase || reference.targetId !== request.target_id) return null;
  const matches = ports.reports().filter(report => report.project && report.origin?.kind === "manager" && report.origin.conversationId
    && report.telegram?.messageIds?.includes(reference.messageId)
    && ports.chatId(report.telegram.chat) === reference.chatId);
  if (matches.length !== 1) return null;
  const report = matches[0];
  return { project: report.project!, sourceSeat: report.origin!.conversationId!, reportId: report.id, reportText: report.body };
}

/** Follow only the triggering owner's explicit reply chain, never adjacent history. */
export function resolveOwnerReplyContext(request: ExternalRelayRequest, owner: OwnerInstruction) {
  if (request.input.respond_to !== owner.messageId) return null;
  const messages = request.input.conversation;
  const trigger = messages.find(message => message.id === request.input.respond_to);
  const target = trigger?.reply_to ? messages.find(message => message.id === trigger.reply_to) : undefined;
  if (!target?.text.trim()) return null;
  const earlier = target.reply_to ? messages.find(message => message.id === target.reply_to) : undefined;
  return { message_id: target.id, text: target.text, reply_to: target.reply_to,
    earlier_request: earlier ? { message_id: earlier.id, text: earlier.text } : null };
}

/** Bare approvals need a resolved report or an explicit reply with text. */
export function ownerNeedsClarification(owner: OwnerInstruction, request?: ExternalRelayRequest): boolean {
  if (owner.bridgeReport || request && resolveOwnerReplyContext(request, owner)) return false;
  const text = (owner.requestText ?? owner.text).replace(/^\s*\/ai(?:@\S+)?\s*/i, "").trim().toLowerCase().replace(/[.!?]+$/u, "");
  return !text || /^(?:го|go|go ahead|так|да|yes|yep|ok|ок|окей|ага|давай|погнали|вперед|запускай|починай|роби|продовжуй|continue|proceed|start|do it|do that|зроби це|це|це роби|that|this|[1-9]|(?:варіант|вариант|option)\s*[1-9])$/u.test(text);
}
