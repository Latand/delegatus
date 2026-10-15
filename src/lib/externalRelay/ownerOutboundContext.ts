import { statePath } from "@/lib/configDir";
import { withStoredBotToken } from "@/lib/telegram/bot/transport";
import { isOutboundQuestion, ownerQuestionCutoff, scopedOutbound, samePublicationTarget, type OutboundMessage } from "@/lib/telegram/bot/outbound";
import { waitForStateLock } from "@/lib/state/lockWait";
import { publishedRelayReference, type PublishedRelayReference } from "./publishedReferences";
import type { ExternalRelayRequest } from "./protocol";
import type { OwnerInstruction } from "./profile";
import type { PairedRelay } from "./store";

type Message = ExternalRelayRequest["input"]["conversation"][number];
export interface OwnerOutboundContext {
  resolution: "explicit_parent" | "latest_open_question" | "ambiguous" | "history";
  questionIds: string[];
  origins: Record<string, OutboundMessage["origin"]>;
  conversation: Message[];
}
export interface OwnerOutboundPorts {
  reference(key: string): Promise<PublishedRelayReference | null>;
  botId(): string | null;
  cutoff?(scope: string, requestId: string, at: number): Promise<number>;
  messages(botId: string, chatId: string, topicId: number | null, before: number, messageId?: number): Promise<OutboundMessage[]>;
}
/** Scope comes from confirmed publication identities in this turn, including
 * a missing explicit parent. A chat key, adjacent text and the owner's id
 * cannot prove a forum topic. Conflicting or legacy anchors remain unresolved. */
export async function resolveOwnerOutboundContext(request: ExternalRelayRequest, owner: OwnerInstruction, relay: PairedRelay,
  ports: OwnerOutboundPorts = {
    reference: key => waitForStateLock("relay.owner-context.reference", () => publishedRelayReference(relay.api_base, request.target_id, key), { waitMs: 5000 }),
    cutoff: (scope, requestId, at) => ownerQuestionCutoff(statePath("telegram/bot.sqlite"), scope, requestId, at),
    botId: () => withStoredBotToken((_token, id) => id),
    messages: (botId, chatId, topicId, before, messageId) => scopedOutbound(statePath("telegram/bot.sqlite"), botId, chatId, topicId, before, messageId),
  }): Promise<OwnerOutboundContext | null> {
  if (request.input.respond_to !== owner.messageId) return null;
  const trigger = request.input.conversation.find(m => m.id === owner.messageId);
  const botId = ports.botId();
  if (!trigger || !botId) return null;
  const explicit = trigger.reply_to ? await ports.reference(trigger.reply_to) : null;
  const references: Array<{ id: string; reference: PublishedRelayReference }> = [];
  if (explicit) references.push({ id: trigger.reply_to!, reference: explicit });
  else {
    for (const m of request.input.conversation) {
      if (!m.author.self) continue;
      const reference = await ports.reference(m.id);
      if (reference) references.push({ id: m.id, reference });
    }
  }
  if (!references.length || references.some(({ reference: r }) => r.topicId === undefined
    || r.apiBase !== relay.api_base || r.targetId !== request.target_id)) return null;
  const scope = references[0]!.reference;
  if (references.some(({ reference: r }) => r.chatId !== scope.chatId || r.topicId !== scope.topicId)) return null;
  const before = Math.floor(Date.parse(trigger.sent_at) / 1000);
  const rows = (await ports.messages(botId, scope.chatId, scope.topicId!, before, explicit?.messageId)).filter(m =>
    samePublicationTarget(m.target, { relayId: relay.id, apiBase: relay.api_base, targetId: request.target_id, ownerId: relay.owner.id }));
  // Prove this bot actually owns an anchor; two bots may reuse message ids.
  if (!rows.some(m => references.some(({ reference: r }) => r.messageId === m.messageId))) {
    const anchor = await ports.messages(botId, scope.chatId, scope.topicId!, before, scope.messageId);
    if (!anchor.some(m => m.messageId === scope.messageId && m.botId === botId && m.chatId === scope.chatId && m.topicId === scope.topicId
      && samePublicationTarget(m.target, { relayId: relay.id, apiBase: relay.api_base, targetId: request.target_id, ownerId: relay.owner.id }))) return null;
  }
  const previousOwner = request.input.conversation.filter(m => m.id !== trigger.id && !m.author.self
    && m.author.key === trigger.author.key && Date.parse(m.sent_at) < Date.parse(trigger.sent_at))
    .reduce((latest, m) => Math.max(latest, Date.parse(m.sent_at) / 1000), -Infinity);
  const savedCutoff = await ports.cutoff?.(JSON.stringify([relay.id, request.target_id, botId, scope.chatId, scope.topicId]), request.request_id, before) ?? 0;
  const open = rows.filter(m => isOutboundQuestion(m) && m.date > Math.max(previousOwner, savedCutoff));
  const groups = new Set(open.map(m => m.sendKey));
  const selected = explicit ? rows.filter(m => m.messageId === explicit.messageId) : rows.filter(m => m.date > Math.max(previousOwner, savedCutoff));
  if (trigger.reply_to && !explicit) return null;
  if (!selected.length) return null;
  const mapped = new Map(references.map(({ id, reference }) => [reference.messageId, id]));
  const ids = new Set(request.input.conversation.map(m => m.id));
  const origins: OwnerOutboundContext["origins"] = {};
  const additions: Message[] = [];
  const confirmed = new Map<string, Message>();
  const questionIds: string[] = [];
  for (const row of selected) {
    let id = mapped.get(row.messageId) ?? `local_outbound_${row.messageId}`;
    while (!mapped.has(row.messageId) && ids.has(id)) id += "_local";
    ids.add(id);
    origins[id] = row.origin;
    if (explicit || open.includes(row)) questionIds.push(id);
    const existing = request.input.conversation.find(m => m.id === id);
    const self = ["agent", "review", "poll"].includes(row.origin);
    const message: Message = { id, author: self && existing ? { ...existing.author, self: true }
      : { key: self ? "local_assistant" : `local_${row.origin}`, name: self ? "Assistant" : row.origin, self },
      sent_at: new Date(row.date * 1000).toISOString(), text: row.text,
      reply_to: row.replyToMessageId ? mapped.get(row.replyToMessageId) ?? null : null };
    if (existing) confirmed.set(id, { ...existing, text: row.text, author: message.author });
    else additions.push(message);
  }
  // Place recovered text immediately before the current answer. Existing
  // service rows retain their ids and order. The local receipt supplies complete
  // text and origin even when remote publication was truncated.
  const conversation = request.input.conversation.flatMap(m => m.id === trigger.id ? [...additions, m] : [confirmed.get(m.id) ?? m]);
  return { resolution: explicit ? "explicit_parent" : groups.size > 1 ? "ambiguous" : groups.size === 1 ? "latest_open_question" : "history",
    questionIds, origins, conversation };
}
