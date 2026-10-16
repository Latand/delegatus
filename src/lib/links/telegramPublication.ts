/** One-hop history publication over the authenticated board exchange.
 * The sender retains custody in its existing outbox until Celestia ACKs. */
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { parseSqliteJson } from "@/lib/sqliteReadAttribution";
import { z } from "zod";
import { statePath } from "@/lib/configDir";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { ExternalRelayError } from "@/lib/externalRelay/client";
import { readRelayStore } from "@/lib/externalRelay/store";
import { relayPublishBody, type TelegramPublishReceipt } from "@/lib/externalRelay/publish";
import { publishDurableTelegramMessage, telegramPublicationTarget } from "@/lib/externalRelay/telegramPublication";
import { telegramBotTokenPath, withStoredBotToken } from "@/lib/telegram/bot/transport";
import { expireOutbound, holdPublications, outboundKey, outboundState, outboundPostingAllowed, publicationCooldown,
  samePublicationTarget, type OutboundMessage } from "@/lib/telegram/bot/outbound";
import { publicationFailure } from "@/lib/telegram/bot/outboundPublication";
import { readPeers, safeEqual } from "./state";
import { linkedPeer, type LinkedPeer } from "./linked";

const targetSchema = z.object({ relayId: z.string().min(1).max(128), apiBase: z.string().max(2048),
  targetId: z.string().min(1).max(64), ownerId: z.string().regex(/^[1-9]\d{0,15}$/) }).strict();
const destinationSchema = z.object({ botId: z.string().regex(/^[1-9]\d{0,15}$/), target: targetSchema,
  connectionId: z.string().min(1).max(128), proof: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const receiptSchema = z.object({ botId: z.string().regex(/^[1-9]\d{0,15}$/), chatId: z.string().regex(/^-?[1-9]\d{0,15}$/),
  messageId: z.number().int().min(1).max(2147483647), date: z.number().int().min(1).max(8640000000000),
  topicId: z.number().int().min(1).nullable(), text: z.string().min(1).max(24000) }).strict();
const itemSchema = z.object({ key: z.string().max(128), attempts: z.number().int().min(1).max(64),
  receipt: receiptSchema, destination: destinationSchema, proof: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const ackSchema = z.object({ key: z.string().max(128), attempts: z.number().int().min(1).max(64),
  state: z.enum(["published", "retry", "terminal"]), reason: z.string().regex(/^(?:published|unconfirmed|cooldown|expired|stale_message|invalid_receipt|[0-9]{3}:[a-z][a-z_]{0,39})$/),
  delayMs: z.number().int().min(0).max(86400000).optional() }).strict();
const partSchema = z.object({ v: z.literal(1), destination: destinationSchema.optional(),
  out: z.array(itemSchema).max(1).optional(), ack: z.array(ackSchema).max(1).optional() }).strict();
export type TelegramPublicationPart = z.infer<typeof partSchema>;
type Destination = z.infer<typeof destinationSchema>;
type BotDestination = Pick<Destination, "botId" | "target">;
type Item = z.infer<typeof itemSchema>;
type Ack = z.infer<typeof ackSchema>;
type UnsignedItem = Omit<Item, "proof">;
/** A peer grant alone cannot establish that the sender controls this bot. */
export function telegramPublicationProof(item: UnsignedItem, token: string): string {
  const r = item.receipt, t = item.destination.target;
  return createHmac("sha256", token).update(JSON.stringify(["delegatus.telegram-publication.v1", item.key, item.attempts,
    item.destination.connectionId, item.destination.botId, t.relayId, t.apiBase, t.targetId, t.ownerId,
    r.botId, r.chatId, r.messageId, r.date, r.topicId, r.text])).digest("hex");
}
export function telegramDestinationProof(destination: BotDestination, connectionId: string, token: string): string {
  const t = destination.target;
  return createHmac("sha256", token).update(JSON.stringify(["delegatus.telegram-destination.v1", connectionId,
    destination.botId, t.relayId, t.apiBase, t.targetId, t.ownerId])).digest("hex");
}

export const validTelegramPublicationPart = (value: unknown): value is TelegramPublicationPart => partSchema.safeParse(value).success;
/** Bot-free links retain their existing idle wire and do no publication work.
 * A configured bot is re-read on every call, so connection changes wake this
 * path without an unbounded or stale discovery cache. */
export function telegramPublicationAvailable(input?: unknown): boolean {
  const part = input as TelegramPublicationPart | undefined;
  return !!(part?.destination || part?.out?.length || part?.ack?.length) || fs.existsSync(telegramBotTokenPath());
}

export interface TelegramPublicationPorts {
  filename: string;
  now(): number;
  botId(): string | null;
  destination(): BotDestination | null;
  connectionId(link: LinkedPeer): string | null;
  destinationProof(destination: BotDestination, connectionId: string): string | null;
  owns(ownerId: string): boolean | null;
  allowed(message: OutboundMessage): boolean;
  proof(item: UnsignedItem): string | null;
  current(link: LinkedPeer): LinkedPeer | null;
  publish(receipt: TelegramPublishReceipt, authorize: () => void): Promise<unknown>;
}
function productionPorts(): TelegramPublicationPorts {
  return { filename: statePath("telegram/bot.sqlite"), now: Date.now,
    botId: () => withStoredBotToken((_token, id) => id),
    destination: () => {
      const botId = withStoredBotToken((_token, id) => id);
      const target = botId ? telegramPublicationTarget(botId) : null;
      return botId && target ? { botId, target } : null;
    },
    owns: ownerId => {
      const known = readRelayStore().relays.filter(r => r.owner.namespace === "telegram");
      return known.length ? known.some(r => !r.paused && r.owner.id === ownerId) : null;
    },
    connectionId: link => link.side === "grant" ? link.id
      : readPeers().peers.find(peer => peer.id === link.id && peer.install === link.install && peer.state !== "revoked")?.grantId ?? null,
    destinationProof: (destination, id) => withStoredBotToken((token, botId) => botId === destination.botId
      ? telegramDestinationProof(destination, id, token) : null),
    proof: item => withStoredBotToken((token, id) => id === item.receipt.botId ? telegramPublicationProof(item, token) : null),
    allowed: message => outboundPostingAllowed(statePath("telegram/bot.sqlite"), message),
    current: link => linkedPeer(link.side, link.id), publish: publishDurableTelegramMessage,
  };
}
const connection = (link: LinkedPeer) => JSON.stringify([link.key, link.install]);
const sameDestination = (a: BotDestination | null | undefined, b: BotDestination | null | undefined) =>
  !!a && !!b && a.botId === b.botId && samePublicationTarget(a.target, b.target);
function authorizeLink(link: LinkedPeer, ports: TelegramPublicationPorts): void {
  const current = ports.current(link);
  if (!current || current.install !== link.install || !current.projects.size || current.projects.size !== link.projects.size
    || [...link.projects].some(project => !current.projects.has(project))) throw Error("Telegram publication link revoked");
}

/** A destination is pinned once. Discovery carries no receipt text. */
async function outgoing(link: LinkedPeer, remote: Destination | undefined, ports: TelegramPublicationPorts): Promise<Item[]> {
  if (!remote || ports.owns(remote.target.ownerId) === false || ports.botId() !== remote.botId || !fs.existsSync(ports.filename)) return [];
  const connectionId = ports.connectionId(link);
  const destinationProof = connectionId ? ports.destinationProof(remote, connectionId) : null;
  if (!connectionId || remote.connectionId !== connectionId || !destinationProof || !safeEqual(remote.proof, destinationProof)) return [];
  return outboundState(ports.filename, true, db => {
    authorizeLink(link, ports);
    if (ports.owns(remote.target.ownerId) === false || ports.botId() !== remote.botId || ports.connectionId(link) !== connectionId) return [];
    const freshProof = ports.destinationProof(remote, connectionId);
    if (!freshProof || !safeEqual(remote.proof, freshProof)) return [];
    expireOutbound(db, ports.now());
    const rows = db.query<{ key: string; value_json: string | null; attempts: number; link: string | null; destination: string | null }, [number, string]>(`
      SELECT o.key, CASE WHEN length(CAST(o.value_json AS BLOB))<=131072 THEN o.value_json ELSE NULL END AS value_json, o.attempts, h.link, h.destination FROM relay_outbound o
      LEFT JOIN relay_outbound_handoffs h ON h.key=o.key
      WHERE o.state IN ('unrouted', 'forwarding') AND o.due<=?
        AND (h.link IS NULL OR h.link=?) ORDER BY o.due, o.key LIMIT 16`).all(ports.now(), connection(link));
    for (const row of rows) {
      if (row.attempts >= 64) {
        db.query("UPDATE relay_outbound SET state='terminal' WHERE key=?").run(row.key);
        db.query("INSERT OR REPLACE INTO relay_publication_results VALUES (?, 'attempts_exhausted')").run(row.key);
        continue;
      }
      if (row.value_json === null) {
        db.query("UPDATE relay_outbound SET state='terminal' WHERE key=?").run(row.key);
        db.query("INSERT OR REPLACE INTO relay_publication_results VALUES (?, 'invalid_receipt')").run(row.key);
        continue;
      }
      const message = parseSqliteJson(row.value_json, db) as OutboundMessage;
      if (message.botId !== remote.botId || message.target || !ports.allowed(message) || (row.link && (row.link !== connection(link)
        || !sameDestination(parseSqliteJson(row.destination!, db), remote)))) {
        db.query("UPDATE relay_outbound SET due=? WHERE key=?").run(ports.now() + 30000, row.key);
        continue;
      }
      const body = relayPublishBody(message);
      if (!body) {
        db.query("UPDATE relay_outbound SET state='terminal' WHERE key=?").run(row.key);
        db.query("INSERT OR REPLACE INTO relay_publication_results VALUES (?, 'invalid_receipt')").run(row.key);
        continue;
      }
      const item: UnsignedItem = { key: row.key, attempts: row.attempts + 1, destination: remote,
        receipt: { botId: message.botId, chatId: message.chatId, messageId: message.messageId,
          date: message.date, topicId: message.topicId, text: body.text } };
      const proof = ports.proof(item);
      if (!proof) return [];
      db.query("INSERT OR IGNORE INTO relay_outbound_handoffs VALUES (?, ?, ?)").run(row.key, connection(link), JSON.stringify(remote));
      db.query("UPDATE relay_outbound SET state='forwarding', attempts=attempts+1, due=? WHERE key=?")
        .run(ports.now() + Math.min(300000, 1000 * 2 ** Math.min(row.attempts, 9)), row.key);
      return [{ ...item, proof }];
    }
    return [];
  });
}
async function acceptAck(link: LinkedPeer, ack: Ack, ports: TelegramPublicationPorts): Promise<void> {
  if (!fs.existsSync(ports.filename)) return;
  await outboundState(ports.filename, true, db => {
    authorizeLink(link, ports);
    const bound = db.query<{ link: string }, [string]>("SELECT link FROM relay_outbound_handoffs WHERE key=?").get(ack.key);
    if (bound?.link !== connection(link)) return;
    const changed = db.query(`UPDATE relay_outbound SET state=?, due=?
      WHERE key=? AND state='forwarding' AND attempts=?`).run(ack.state === "retry" ? "forwarding" : ack.state,
        ports.now() + (ack.delayMs ?? Math.min(300000, 1000 * 2 ** Math.min(ack.attempts - 1, 9))), ack.key, ack.attempts);
    if (changed.changes) db.query("INSERT OR REPLACE INTO relay_publication_results VALUES (?, ?)").run(ack.key, ack.reason);
  });
}
async function receive(link: LinkedPeer, item: Item, ports: TelegramPublicationPorts): Promise<Ack> {
  const ack = (state: Ack["state"], reason: string, delayMs?: number): Ack => ({ key: item.key, attempts: item.attempts, state, reason,
    ...(delayMs === undefined ? {} : { delayMs }) });
  const authorize = () => {
    if (ports.now() >= (item.receipt.date + 86400) * 1000) throw new ExternalRelayError("stale_message", 400);
    authorizeLink(link, ports);
    if (!sameDestination(item.destination, ports.destination()) || item.receipt.botId !== item.destination.botId)
      throw Error("Telegram publication destination revoked");
    const proof = ports.proof(item);
    if (item.destination.connectionId !== ports.connectionId(link) || !proof || !safeEqual(item.proof, proof)) throw new ExternalRelayError("bot_proof_refused", 403);
  };
  if (item.key !== outboundKey(item.receipt) || !relayPublishBody(item.receipt)) return ack("terminal", "invalid_receipt");
  if (ports.now() >= (item.receipt.date + 86400) * 1000) return ack("terminal", "expired");
  if (item.receipt.date * 1000 > ports.now() + 60000) return ack("terminal", "stale_message");
  // No peer owner flags, model prompt or conversation attribution are imported.
  const message: OutboundMessage = { ...item.receipt, target: item.destination.target, origin: "agent", conversationId: null,
    replyToMessageId: null, sendKey: item.key };
  try {
    authorize();
    await outboundState(ports.filename, true, () => {});
    authorize();
    const until = await publicationCooldown(ports.filename, message);
    authorize();
    if (until > ports.now()) return ack("retry", "cooldown", until - ports.now());
    const result = await ports.publish(item.receipt, authorize);
    authorizeLink(link, ports);
    return result === "published" ? ack("published", "published") : ack("retry", "unconfirmed");
  } catch (error) {
    const failure = publicationFailure(error);
    if (failure.delayMs) await holdPublications(ports.filename, message, ports.now() + failure.delayMs);
    return ack(failure.terminalReason ? "terminal" : "retry", failure.reason, failure.delayMs);
  }
}

/** Optional v1 part: old peers ignore it and retain local custody. Each call
 * attempts at most one service publication and exports at most one receipt. */
export async function exchangeTelegramPublications(link: LinkedPeer | null, input?: unknown,
  ports: TelegramPublicationPorts = productionPorts(), guard: () => void = () => {}): Promise<TelegramPublicationPart> {
  const original = ports;
  ports = { ...original, current: link => { guard(); return original.current(link); } };
  return withViewerOperation("links.telegram-publication", async () => {
    if (!link || !link.projects.size) return { v: 1 };
    authorizeLink(link, ports);
    if (input !== undefined && !validTelegramPublicationPart(input)) throw Error("malformed Telegram publication part");
    const part = input as TelegramPublicationPart | undefined;
    for (const ack of part?.ack ?? []) await acceptAck(link, ack, ports);
    const ack: Ack[] = [];
    for (const item of part?.out ?? []) ack.push(await receive(link, item, ports));
    authorizeLink(link, ports);
    const route = ports.destination();
    const connectionId = ports.connectionId(link);
    const proof = route && connectionId ? ports.destinationProof(route, connectionId) : null;
    const destination = route && connectionId && proof ? { ...route, connectionId, proof } : null;
    const out = await outgoing(link, part?.destination, ports);
    authorizeLink(link, ports);
    return { v: 1, ...(destination ? { destination } : {}), ...(out.length ? { out } : {}), ...(ack.length ? { ack } : {}) };
  });
}
