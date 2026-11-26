import { SEAT_AGENDA_VERSION_PREFIX } from "./seatAgendaSchema";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { statePath } from "@/lib/configDir";
import { currentLegatusSeat, localLegatusProject } from "@/lib/orchestrator/legatusSeat";
import { orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { canonicalProject, projectAliasKeys } from "@/lib/projects/aliases";
import { isLegatusProject } from "@/lib/projects/serviceProject";
import { initializeStateCollectionsAsync, sharedStateReadonlyDatabase, stateTransactionAsync } from "@/lib/state/sqliteStateStore";

export interface SeatAgendaEntry {
  seq: number;
  id: string;
  kind: "legatus-question" | "operator-launch" | "legatus-message";
  target: string;
  source_project: string;
  ref: string;
  task_id: string | null;
  text: string;
  sender: string | null;
  urgent: 0 | 1;
  pending: 0 | 1;
}

const filename = () => statePath("state.sqlite");
export const agendaVersionFor = (entry: SeatAgendaEntry) => SEAT_AGENDA_VERSION_PREFIX + entry.id;

type AgendaNotification = (project: string) => void;
const notifications = globalThis as typeof globalThis & { __delegatusSeatAgendaNotify?: AgendaNotification };
export function bindSeatAgendaNotification(callback?: AgendaNotification): void {
  notifications.__delegatusSeatAgendaNotify = callback;
}

export function notifyLegatus(): void {
  const notify = notifications.__delegatusSeatAgendaNotify;
  if (!notify) return;
  const project = localLegatusProject();
  if (project && orchestratorSeatFor(project).active) notify(project);
}

function readableAgenda() {
  const dbPath = filename();
  if (!existsSync(dbPath)) return null;
  const db = sharedStateReadonlyDatabase(dbPath);
  return db.query("SELECT 1 FROM sqlite_master WHERE name = 'seat_agenda'").get() ? db : null;
}

export function pendingSeatAgenda(project: string, limit: number): SeatAgendaEntry[] {
  const db = readableAgenda();
  if (!db) return [];
  const legatus = isLegatusProject(project);
  if (legatus && project !== localLegatusProject()) return [];
  const select = db.query<SeatAgendaEntry, [string, number]>(
    "SELECT * FROM seat_agenda WHERE target = ? AND pending = 1 ORDER BY urgent DESC, seq LIMIT ?");
  return (legatus ? [""] : projectAliasKeys(project)).flatMap(key => select.all(key, limit))
    .sort((a, b) => b.urgent - a.urgent || a.seq - b.seq).slice(0, limit);
}

/** A crash between confirming a wake and clearing the inbox is safe. The
 * next check retries the exact credits from the durable wake state first. */
export async function acknowledgeSeatAgenda(project: string, versions: readonly string[]): Promise<void> {
  const ids = versions.filter(version => version.startsWith(SEAT_AGENDA_VERSION_PREFIX)).map(version => version.slice(SEAT_AGENDA_VERSION_PREFIX.length));
  if (!ids.length) return;
  const keys = isLegatusProject(project) ? [""] : projectAliasKeys(project);
  const db = readableAgenda();
  if (!db) return;
  const pending = db.query("SELECT 1 FROM seat_agenda WHERE pending = 1 AND id IN (SELECT value FROM json_each(?)) LIMIT 1");
  if (!pending.get(JSON.stringify(ids))) return;
  await stateTransactionAsync(filename(), "seat-agenda", writer => {
    const ack = writer.query("UPDATE seat_agenda SET pending = 0, text = '' WHERE id = ? AND target = ? AND pending = 1");
    for (const id of ids) for (const key of keys) ack.run(id, key);
  });
}

export async function recordOperatorLaunch(project: string, conversationId: string): Promise<void> {
  if (isLegatusProject(project)) return;
  const dbPath = filename();
  if (!readableAgenda()) await initializeStateCollectionsAsync(dbPath, []);
  const inserted = await stateTransactionAsync(dbPath, "seat-agenda", db => db.query(
    "INSERT OR IGNORE INTO seat_agenda(id, kind, target, source_project, ref, text) VALUES (?, 'operator-launch', '', ?, ?, '')",
  ).run(`operator-launch:${conversationId}`, project, conversationId).changes);
  if (inserted) notifyLegatus();
}

function messageId(conversationId: string, clientMessageId: string): string {
  return "agenda_" + createHash("sha256").update(JSON.stringify([conversationId, clientMessageId])).digest("hex");
}

export function legatusMessageReceipt(operationId: string, sender?: string | null) {
  const row = readableAgenda()?.query<Pick<SeatAgendaEntry, "target" | "pending" | "sender">, [string]>(
    "SELECT target, pending, sender FROM seat_agenda WHERE id = ? AND kind = 'legatus-message'",
  ).get(operationId);
  if (!row || (sender !== undefined && row.sender !== sender)) return null;
  return { operationId, project: row.target, state: row.pending ? "queued" as const : "delivered" as const };
}

export class SeatAgendaRefusal extends Error {}

export async function queueLegatusMessage(input: {
  conversationId: string; project: string; recipient?: string; clientMessageId: string; text: string; urgent: boolean;
}) {
  if (isLegatusProject(input.project)) throw new SeatAgendaRefusal("choose a project seat to receive the message");
  if (!input.text.trim() || input.text.length > 1_200 || JSON.stringify(input.text).length > 1_400 || /<!--\s*llv:|\[bridge\b/i.test(input.text)) {
    throw new SeatAgendaRefusal("seat agenda messages require 1–1200 characters without Delegatus metadata");
  }
  const id = messageId(input.conversationId, input.clientMessageId);
  const digest = createHash("sha256").update(JSON.stringify([input.text, input.urgent])).digest("hex");
  const dbPath = filename();
  if (!readableAgenda()) await initializeStateCollectionsAsync(dbPath, []);
  const state = await stateTransactionAsync(dbPath, "seat-agenda", db => {
    const existing = db.query<Pick<SeatAgendaEntry, "target" | "pending" | "ref">, [string]>("SELECT target, pending, ref FROM seat_agenda WHERE id = ?").get(id);
    if (existing) {
      if (existing.ref !== digest || canonicalProject(existing.target) !== input.project) throw new SeatAgendaRefusal("seat agenda request already belongs to another message");
      return existing.pending ? "queued" as const : "delivered" as const;
    }
    const sender = currentLegatusSeat(input.conversationId);
    if (!sender) throw new SeatAgendaRefusal("the Legatus seat changed before message admission");
    const recipient = orchestratorSeatFor(input.project).active?.conversationId;
    if (!recipient || (input.recipient && input.recipient !== recipient)) throw new SeatAgendaRefusal("the destination seat is unavailable or changed");
    db.query("INSERT INTO seat_agenda(id, kind, target, source_project, ref, text, sender, urgent) VALUES (?, 'legatus-message', ?, ?, ?, ?, ?, ?)")
      .run(id, input.project, sender.project, digest, input.text, input.conversationId, Number(input.urgent));
    return "queued" as const;
  });
  if (input.urgent && state === "queued") notifications.__delegatusSeatAgendaNotify?.(input.project);
  return { outcome: "accepted" as const, project: input.project, operationId: id, state };
}

export function recoverLegatusMessage(conversationId: string, clientMessageId: string) {
  return legatusMessageReceipt(messageId(conversationId, clientMessageId), conversationId);
}
