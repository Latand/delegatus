/** Durable, one-hop seat messages riding the existing linked-board exchange. */
import { randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { canonicalProject } from "@/lib/projects/aliases";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { peerSeatMessages, recordSeatMessages, wasSeatLinkRevoked } from "./boardLinks";
import { linkedContext, type LinkedPeer } from "./linked";
import { grantRows, peerRows } from "./protocol";
import { readSelf } from "./self";
import { sha, sharedProjects } from "./state";
import { deliverLinkedSeatMessage } from "./seatMessageDelivery";

type Ack = { id: string; st: "accepted" | "refused"; code?: string };
export type SeatMessage = { id: string; p: string; at: number; k: string; t: string };
export type SeatMessagePart = { v: 1; out?: SeatMessage[]; ack?: Ack[] };
type Row = { key: string; dir: "out" | "in"; id: string; link: string; connection: string; p: string; at: number; k: string;
  t?: string; ackPending?: boolean; digest: string; sentAt?: number; ack?: Ack; receivedAt?: number; prelude?: string;
  st?: "received" | "delivering" | "accepted" | "refused"; code?: string; operationId?: string;
  lease?: { pid: number; identity: string | null; token: string } };
const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-zA-Z0-9_-]{1,64}$/;
const OBJECT = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const seed = { collection: "link_messages", schemaVersion: 1, migrationId: "linked-seat-messages-v1", key: (row: Row) => row.key, loadRecords: (): Row[] => [] };
const stores = new Map<string, SqliteStateCollection<Row>>();
function collection(create = false): SqliteStateCollection<Row> | null {
  const file = statePath("state.sqlite");
  const held = stores.get(file);
  if (held) return held;
  if (!create && !stateCollectionsInitialized(file, [seed])) return null;
  if (create) initializeStateCollections(file, [seed]);
  const opened = new SqliteStateCollection<Row>(file, { collection: seed.collection, schemaVersion: 1,
    busyMessage: "linked seat messages busy", key: seed.key, clone: structuredClone, strictDecode: true,
    decode: v => OBJECT(v) && typeof v.key === "string" && (v.dir === "in" || v.dir === "out") && typeof v.id === "string" ? v as Row : null });
  stores.set(file, opened); return opened;
}
const snapshots = new WeakMap<SqliteStateCollection<Row>, { revision: number; rows: Row[] }>();
function rows(): readonly Row[] {
  const opened = collection();
  if (!opened) return [];
  const revision = opened.revision();
  let held = snapshots.get(opened);
  if (!held || held.revision !== revision) { held = { revision, rows: opened.snapshot() }; snapshots.set(opened, held); }
  return held.rows;
}
export class SeatMessageRefusal extends Error { constructor(readonly code: string, message: string) { super(message); } }
function refuse(code: string, message: string): never { throw new SeatMessageRefusal(code, message); }
export function seatMessageTextValid(text: string): boolean { return text.length <= 8_000 && !!text.trim() && !/<!--\s*llv:|\[bridge\b/i.test(text); }

/** Resolve and refuse before binding a logical MCP request. `null` is local. */
export function resolveSeatMessageMachine(machine: string, project: string): LinkedPeer | null {
  const context = linkedContext();
  const wanted = machine.trim().toLowerCase();
  if (wanted === "here" || wanted === "this machine" || wanted === context.self?.id || wanted === readSelf()?.label.toLowerCase()) return null;
  const matches = context.links.filter(link => wanted === link.label.toLowerCase() || wanted === link.install || wanted === link.prefix);
  if (matches.length > 1) refuse("machine_ambiguous", `The machine matches several links: ${matches.map(link => link.label).join(", ")}.`);
  if (!matches.length) {
    const revoked = peerRows().some(peer => peer.state === "revoked" && [peer.id, peer.install, peer.install.slice(0, 8), peer.label.toLowerCase()].includes(wanted));
    const previous = wasSeatLinkRevoked(wanted) || rows().some(row => row.link === wanted || row.link.slice(0, 8) === wanted);
    refuse(revoked || previous ? "link_revoked" : "machine_unknown", `${machine} is ${revoked || previous ? "no longer linked" : "not linked"} to this machine.`);
  }
  const link = matches[0]!;
  if (!link.projects.has(canonicalProject(project))) refuse("project_not_linked", `The project is not shared with ${link.label}; both machines must share it.`);
  const health = link.side === "peer" ? peerRows().find(peer => peer.id === link.id) : grantRows().find(grant => grant.id === link.id);
  if (health?.state === "failing" || (link.side === "grant" && Date.now() - (health?.lastCall ?? 0) > 900_000)) refuse("peer_unreachable", `${link.label} has not been reachable recently.`);
  if (!peerSeatMessages(link.key)) refuse("peer_cannot_relay", `${link.label} runs a Delegatus without seat messages; update it.`);
  return link;
}

export function queueSeatMessage(link: LinkedPeer, project: string, text: string, seatConversationId: string, clientMessageId: string) {
  if (!text.trim()) refuse("message_empty", "Message text is required.");
  if (text.length > 8_000) refuse("message_too_long", "Seat messages are limited to 8000 UTF-16 units.");
  if (!seatMessageTextValid(text)) refuse("relay_reserved_metadata", "Relay the words without Delegatus authority markers or bridge trailers.");
  const p = canonicalProject(project), k = sha(seatConversationId).slice(0, 16);
  const key = `out:${link.install}:${sha(clientMessageId)}`;
  const digest = sha(JSON.stringify({ p, k, t: text }));
  const opened = collection(true)!;
  return opened.boundedPatch(2, tx => {
    const prior = tx.get(key);
    if (prior) {
      if (prior.digest !== digest) refuse("idempotency_conflict", "The message key does not match its original words or sender.");
      return seatMessageAcceptance(prior, link.label);
    }
    const all = rows().filter(row => row.dir === "out" && row.link === link.install);
    if (all.filter(row => !row.ack && Date.now() - row.at <= 30 * DAY).length >= 20) refuse("message_backlog", `20 messages to ${link.label} are still waiting.`);
    if (all.filter(row => row.at >= Date.now() - DAY).length >= 200) refuse("quota", "The link's daily seat-message quota was reached.");
    const row: Row = { key, dir: "out", id: randomUUID(), link: link.install, connection: connection(link), p, k, t: text, at: Date.now(), digest };
    tx.put(row); return seatMessageAcceptance(row, link.label);
  });
}
function seatMessageAcceptance(row: Row, machine?: string) {
  return { outcome: "accepted", operationId: `seatmsg_${row.id}`, ...(machine ? { machine } : {}), state: row.ack?.st ?? "queued", ...(row.ack?.code ? { code: row.ack.code } : {}) };
}
export function recoverSeatMessage(install: string, clientMessageId: string) {
  const row = rows().find(row => row.key === `out:${install}:${sha(clientMessageId)}`);
  return row ? seatMessageAcceptance(row) : null;
}
function connection(link: LinkedPeer): string {
  return link.side === "grant" ? link.key : `${link.key}:${peerRows().find(peer => peer.id === link.id)?.grantId ?? "missing"}`;
}
export function seatMessageReceipt(operationId: string) {
  const row = rows().find(row => row.dir === "out" && `seatmsg_${row.id}` === operationId);
  if (!row) return null;
  const linked = linkedContext().links.some(link => link.install === row.link && row.connection === connection(link) && link.projects.has(row.p) && peerSeatMessages(link.key));
  const expired = Date.now() - row.at > 30 * DAY;
  return { operationId, state: row.ack?.st ?? (!linked || expired ? row.sentAt ? "unknown" : "not-delivered" : "queued"),
    ...(row.ack?.code ? { code: row.ack.code } : {}) };
}
export function messagesPending(id: string): boolean {
  const link = linkedContext().links.find(link => link.side === "peer" && link.id === id);
  return !!link && peerSeatMessages(link.key) && rows().some(row => row.dir === "out" && row.link === link.install && row.connection === connection(link) && !row.ack && link.projects.has(row.p) && Date.now() - row.at <= 30 * DAY);
}

/** The envelope is strict. Invalid individual rows with a valid id get a refusal. */
export function validSeatMessagePart(value: unknown): value is SeatMessagePart {
  if (!OBJECT(value) || value.v !== 1 || Object.keys(value).some(k => !["v", "out", "ack"].includes(k)) || Buffer.byteLength(JSON.stringify(value)) > 160_000) return false;
  if (value.out !== undefined && (!Array.isArray(value.out) || value.out.length > 10 || value.out.some(row => !OBJECT(row) || typeof row.id !== "string" || !UUID.test(row.id)))) return false;
  if (value.ack !== undefined && (!Array.isArray(value.ack) || value.ack.length > 10 || value.ack.some(row => !OBJECT(row) || typeof row.id !== "string" || !UUID.test(row.id)
    || !["accepted", "refused"].includes(String(row.st)) || (row.code !== undefined && (typeof row.code !== "string" || !CODE.test(row.code))) || Object.keys(row).some(k => !["id", "st", "code"].includes(k))))) return false;
  return true;
}
function validMessage(row: SeatMessage, projects: ReadonlySet<string>): boolean {
  return Object.keys(row).every(k => ["id", "p", "at", "k", "t"].includes(k)) && typeof row.p === "string" && projects.has(row.p)
    && /^repo-[0-9a-f]{32}$/.test(row.p) && Number.isSafeInteger(row.at) && row.at >= 0 && typeof row.k === "string" && /^[0-9a-f]{16}$/.test(row.k)
    && typeof row.t === "string" && seatMessageTextValid(row.t);
}

export function acceptSeatMessages(link: LinkedPeer, part: SeatMessagePart): number {
  recordSeatMessages(link.key, true);
  const newMessages = (part.out ?? []).filter(message => !rows().some(row => row.key === `in:${link.install}:${message.id}`));
  const today = rows().filter(row => row.dir === "in" && row.link === link.install && (row.receivedAt ?? 0) >= Date.now() - DAY).length;
  if (today + newMessages.length > 200) refuse("quota", "The link's daily seat-message quota was reached.");
  let moved = 0;
  for (const message of part.out ?? []) {
    const key = `in:${link.install}:${message.id}`;
    const prior = rows().find(row => row.key === key);
    if (prior) {
      if (!prior.ackPending && (prior.st === "accepted" || prior.st === "refused")) collection(true)!.boundedPatch(2, tx => {
        const current = tx.get(key); if (current && !current.ackPending) { current.ackPending = true; tx.put(current); }
      });
      continue;
    }
    const malformed = !validMessage(message, link.projects);
    const code = malformed ? "malformed" : Date.now() - message.at > 30 * DAY ? "expired" : message.at > Date.now() + 3_600_000 ? "malformed" : null;
    const display = sharedProjects().find(project => project.key === message.p)?.name ?? "Shared project";
    collection(true)!.boundedPatch(2, tx => {
      if (tx.get(key)) return;
      tx.put({ key, dir: "in", id: message.id, link: link.install, connection: connection(link), p: malformed ? "" : message.p, at: malformed ? Date.now() : message.at,
        k: malformed ? "" : message.k, receivedAt: Date.now(), digest: sha(JSON.stringify(message)),
        ...(code ? { st: "refused", code, ackPending: true } : { st: "received", t: message.t, prelude: `${display} on ${link.label}` }) }); moved++;
    });
  }
  for (const ack of part.ack ?? []) {
    const original = rows().find(row => row.dir === "out" && row.link === link.install && row.connection === connection(link) && row.id === ack.id);
    if (!original || original.ack) continue;
    collection(true)!.boundedPatch(2, tx => {
      const held = tx.get(original.key);
      if (!held || held.ack) return;
      delete held.t; held.ack = ack; tx.put(held); moved++;
    });
  }
  return moved;
}

export function seatMessagesPart(link: LinkedPeer | null): SeatMessagePart {
  if (!link || !peerSeatMessages(link.key)) return { v: 1 };
  const all = rows();
  const candidates = all.filter(row => row.dir === "out" && row.link === link.install && row.connection === connection(link) && !row.ack && link.projects.has(row.p) && Date.now() - row.at <= 30 * DAY)
    .sort((a, b) => a.at - b.at).slice(0, 10);
  const pending: Row[] = [];
  const out: SeatMessage[] = [];
  for (const row of candidates) {
    const message = { id: row.id, p: row.p, at: row.at, k: row.k, t: row.t! };
    // Reserve room for ten acknowledgements before adding escaped text.
    if (Buffer.byteLength(JSON.stringify({ v: 1, out: [...out, message] })) > 158_000) break;
    pending.push(row); out.push(message);
  }
  const ack = all.filter(row => row.dir === "in" && row.link === link.install && row.connection === connection(link) && row.ackPending && (row.st === "accepted" || row.st === "refused"))
    .sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0)).slice(0, 10)
    .map(row => ({ id: row.id, st: row.st as Ack["st"], ...(row.code ? { code: row.code } : {}) }));
  for (const item of ack) {
    const key = `in:${link.install}:${item.id}`;
    collection(true)!.boundedPatch(2, tx => { const row = tx.get(key); if (row?.ackPending) { row.ackPending = false; tx.put(row); } });
  }
  for (const row of pending) if (!row.sentAt) collection(true)!.boundedPatch(2, tx => {
    const held = tx.get(row.key); if (held && !held.sentAt) { held.sentAt = Date.now(); tx.put(held); }
  });
  return { v: 1, ...(out.length ? { out } : {}), ...(ack.length ? { ack } : {}) };
}

/** A per-message process lease fences overlapping Viewer generations. The
 * local delivery key recovers a send admitted before an outcome was saved. */
export async function drainSeatMessages(link: LinkedPeer): Promise<void> {
  for (const row of rows().filter(row => row.dir === "in" && row.link === link.install && row.connection === connection(link) && (row.st === "received" || row.st === "delivering"))) {
    if (row.lease && procBackend.pidAlive(row.lease.pid) && !procBackend.processExited(row.lease.pid)
      && (row.lease.identity === null || procBackend.processIdentity(row.lease.pid) === row.lease.identity)) continue;
    const lease = { pid: process.pid, identity: procBackend.processIdentity(process.pid), token: randomUUID() };
    const held = collection(true)!.boundedPatch(2, tx => {
      const current = tx.get(row.key);
      if (!current || current.st !== row.st || current.lease?.token !== row.lease?.token) return null;
      current.st = "delivering"; current.lease = lease; tx.put(current); return current;
    });
    if (!held) continue;
    try {
      const live = linkedContext().links.find(current => current.key === link.key && current.install === link.install && connection(current) === held.connection);
      const outcome = !live ? { st: "refused" as const, code: "link_revoked" }
        : !live.projects.has(held.p) ? { st: "refused" as const, code: "project_not_linked" }
        : await deliverLinkedSeatMessage(held.p, held.t!, held.prelude!, `peer:${link.prefix}:${held.id}`);
      collection(true)!.boundedPatch(2, tx => {
        const current = tx.get(held.key); if (current?.lease?.token !== lease.token) return;
        delete current.lease;
        if (outcome.st === "retry") { current.st = "received"; }
        else { current.st = outcome.st; current.ackPending = true; current.code = outcome.code; current.operationId = outcome.operationId; delete current.t; }
        tx.put(current);
      });
    } catch (error) {
      collection(true)!.boundedPatch(2, tx => {
        const current = tx.get(held.key); if (current?.lease?.token !== lease.token) return;
        current.st = "received"; delete current.lease; tx.put(current);
      });
      throw error;
    }
  }
  // A retained id outlives the replay window. Prune in bounded batches.
  const expired = rows().filter(row => Date.now() - (row.receivedAt ?? row.at) > 35 * DAY).slice(0, 100);
  if (expired.length) collection(true)!.boundedPatch(expired.length, tx => { for (const row of expired) tx.delete(row.key); });
}
