import { createHash, randomUUID } from "node:crypto";
import type { TelegramBotStore } from "./store";
import { TelegramBotError } from "./errors";
import type { FileConfirmationView, FileSendOptions } from "./fileConfirmationContract";

export const FILE_CONFIRMATION_TTL_MS = 600_000;
const PENDING_CAP = 128;
type Snapshot = Pick<FileConfirmationView, "kind" | "chatId" | "chatTitle" | "topicId" | "options" | "files" | "reasons"> & { botId: string };
export type FileSendApproval = { digest: string; authorize(): void; expiresAt: string };

/** The digest covers the full operation. A new send key grants no new permission. */
export function fileSendDigest(snapshot: Snapshot): string {
  const options = { ...snapshot.options, clientRequestId: undefined };
  return createHash("sha256").update(JSON.stringify([snapshot.kind, snapshot.botId, snapshot.chatId, options, snapshot.files])).digest("hex");
}
function invalid(): never { throw new TelegramBotError("confirmation_invalid", "This file confirmation is changed, expired, used or unavailable; request a new send."); }

/** Live requests belong to one Viewer service. Disk is audit only: restoring or
 * editing a row never creates approval authority. Restart requires a fresh request.
 * At most 128 pending metadata entries and 256 audit records; no file bytes stay.
 */
export class FileSendConfirmations {
  readonly #pending = new Map<string, Snapshot & { view: FileConfirmationView }>();
  private initialized = false;
  constructor(private readonly store: () => TelegramBotStore, private readonly now: () => Date, private readonly newId: () => string = randomUUID) {}

  clear(): void { this.#pending.clear(); this.initialized = false; }

  private journal<T>(work: (db: import("bun:sqlite").Database) => T): T {
    return this.store().postingState(db => {
      // These small writes refuse contention immediately; they never wait on the loop.
      const timeout = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout ?? 5000;
      db.exec("PRAGMA busy_timeout=0");
      try {
        if (!this.initialized) {
          db.exec("CREATE TABLE IF NOT EXISTS file_send_confirmations (id TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
          this.initialized = true;
        }
        return work(db);
      } finally { db.exec(`PRAGMA busy_timeout=${timeout}`); }
    });
  }
  private record(view: FileConfirmationView): void {
    this.journal(db => {
      db.query("INSERT INTO file_send_confirmations(id,value_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json").run(view.id, JSON.stringify(view));
      db.query("DELETE FROM file_send_confirmations WHERE id IN (SELECT id FROM file_send_confirmations ORDER BY rowid DESC LIMIT -1 OFFSET 256)").run();
    });
  }
  private expire(): void {
    const now = this.now().getTime();
    for (const [id, entry] of this.#pending) {
      if (Date.parse(entry.view.expiresAt) <= now) {
        this.#pending.delete(id);
        this.record({ ...entry.view, state: "expired" });
      }
    }
  }
  request(snapshot: Snapshot): { id: string; url: string; expiresAt: string } {
    this.expire();
    if (this.#pending.size >= PENDING_CAP || Buffer.byteLength(JSON.stringify(snapshot)) > 128_000) invalid();
    const id = this.newId();
    if (this.#pending.has(id) || this.journal(db => db.query("SELECT 1 FROM file_send_confirmations WHERE id=?").get(id))) invalid();
    const details = structuredClone(snapshot);
    const view: FileConfirmationView = { kind: details.kind, chatId: details.chatId, chatTitle: details.chatTitle, topicId: details.topicId, options: details.options, files: details.files, reasons: details.reasons, id, digest: fileSendDigest(snapshot), createdAt: this.now().toISOString(), expiresAt: new Date(this.now().getTime() + FILE_CONFIRMATION_TTL_MS).toISOString(), state: "pending" };
    this.record(view);
    this.#pending.set(id, { ...structuredClone(snapshot), view });
    return { id, url: `/telegram-file-confirmation?id=${encodeURIComponent(id)}`, expiresAt: view.expiresAt };
  }
  read(id: string): FileConfirmationView {
    this.expire();
    const live = this.#pending.get(id);
    if (live) return structuredClone(live.view);
    const row = this.journal(db => db.query<{ value_json: string }, [string]>("SELECT value_json FROM file_send_confirmations WHERE id=?").get(id));
    if (!row) invalid();
    const view = JSON.parse(row.value_json) as FileConfirmationView;
    return { ...view, state: view.state === "pending" || view.state === "approved" ? "unavailable" : view.state };
  }
  async decide<T>(id: string, digest: string, approve: boolean, authorize: () => void,
    send: (kind: Snapshot["kind"], options: FileSendOptions, approval: FileSendApproval) => Promise<T>): Promise<T | { rejected: true }> {
    authorize();
    this.expire();
    const entry = this.#pending.get(id);
    if (!entry || entry.view.digest !== digest) invalid();
    // Consume before every await and before recording approval. There is no replay branch.
    this.#pending.delete(id);
    const view = { ...entry.view, state: approve ? "approved" as const : "rejected" as const, decidedAt: this.now().toISOString(), decidedBy: "owner" as const };
    this.record(view);
    if (!approve) return { rejected: true };
    try {
      const answer = await send(entry.kind, { ...entry.options, clientRequestId: `file-confirmation:${id}` }, { digest, authorize, expiresAt: view.expiresAt });
      this.record({ ...view, state: "sent", messageIds: (answer as { messageIds?: number[] }).messageIds });
      return answer;
    } catch (error) {
      this.record({ ...view, state: error instanceof TelegramBotError && error.code !== "send_uncertain" ? "failed" : "uncertain" });
      throw error;
    }
  }
}
