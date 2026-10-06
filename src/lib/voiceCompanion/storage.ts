import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { configFilePath, statePath } from "@/lib/configDir";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import { canonicalProject } from "@/lib/projects/aliases";
import type { CompanionEvent, Delivery, Locale, Proposal } from "./contract";
import type { OperatorInput } from "./gate";

export interface CompanionSettings {
  enabled: boolean;
  backend: "official-realtime" | "demo";
  monthlyCapUsd: number;
  keySource: "env" | "file" | "missing";
  keyEnvironment: "OPENAI_API_KEY";
  month: string;
  usageUsd: number;
  reservedUsd: number;
  incomplete: boolean;
}
export interface StoredProposal {
  proposal: Proposal;
  sourceText: string;
  expiresAt: number;
  state: "pending" | "cancelled" | "admitted";
  delivery?: Delivery;
  text?: string;
  status?: "delivered" | "queued" | "unknown";
  reports: string[];
}
export interface StoredSession {
  id: string;
  project: string;
  locale: Locale;
  generation: number;
  createdAt: number;
  closed: boolean;
  inputs: OperatorInput[];
  proposals: Record<string, StoredProposal>;
  events: CompanionEvent[];
  seq: number;
}
interface Charge { month: string; usd: number; reserved: boolean; incomplete: boolean }
export interface CompanionDocument {
  version: 1;
  settings: Pick<CompanionSettings, "enabled" | "backend" | "monthlyCapUsd">;
  charges: Record<string, Charge>;
  sessions: Record<string, StoredSession>;
}
const empty = (): CompanionDocument => ({ version: 1, settings: { enabled: false, backend: "official-realtime", monthlyCapUsd: 20 }, charges: {}, sessions: {} });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const recipientValid = (value: unknown): boolean => record(value) && identifier(value.project) && identifier(value.conversationId)
  && Number.isSafeInteger(value.seatEpoch) && (value.seatEpoch as number) >= 0 && ["claude", "codex"].includes(value.engine as string);
function sessionValid(key: string, session: unknown): boolean {
  if (!record(session) || session.id !== key || !identifier(key) || !identifier(session.project)
    || !["en", "uk"].includes(session.locale as string) || typeof session.closed !== "boolean"
    || !Number.isSafeInteger(session.generation) || (session.generation as number) < 1 || !Number.isFinite(session.createdAt)
    || !Number.isSafeInteger(session.seq) || (session.seq as number) < 0 || !Array.isArray(session.inputs)
    || !Array.isArray(session.events) || session.events.length > 512 || !record(session.proposals)) return false;
  if (session.inputs.some(input => !record(input) || !identifier(input.itemId) || typeof input.text !== "string" || typeof input.final !== "boolean")) return false;
  if (session.events.some(event => !record(event) || event.sessionId !== key || event.version !== 1 || !identifier(event.eventId)
    || !identifier(event.type) || !Number.isSafeInteger(event.seq) || !Number.isSafeInteger(event.generation) || !Number.isFinite(event.atMs))) return false;
  return Object.entries(session.proposals).every(([id, held]) => {
    if (!record(held) || !record(held.proposal) || held.proposal.proposalId !== id || !identifier(id)
      || !identifier(held.proposal.callId) || !identifier(held.proposal.sourceItemId) || typeof held.proposal.instruction !== "string"
      || !recipientValid(held.proposal.recipient) || canonicalProject((held.proposal.recipient as { project: string }).project) !== canonicalProject(session.project as string)
      || typeof held.sourceText !== "string" || !Number.isFinite(held.expiresAt) || !["pending", "cancelled", "admitted"].includes(held.state as string)
      || !Array.isArray(held.reports) || !held.reports.every(identifier)) return false;
    if (held.state !== "admitted") return held.delivery === undefined && held.text === undefined && held.status === undefined;
    return record(held.delivery) && held.delivery.proposalId === id && held.delivery.callId === held.proposal.callId
      && identifier(held.delivery.clientMessageId) && (held.delivery.operationId === null || identifier(held.delivery.operationId))
      && recipientValid(held.delivery.recipient) && JSON.stringify(held.delivery.recipient) === JSON.stringify(held.proposal.recipient)
      && typeof held.text === "string" && (held.status === undefined || ["delivered", "queued", "unknown"].includes(held.status as string));
  });
}

/** Owner-only atomic publication, including the containing directory's sync. */
function writePrivate(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const parent = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/** Session authority and accounting only. Delivery receipts and reports remain
 * in their existing stores. Reads fail closed on corrupt/unreadable state. */
export class CompanionStorage {
  constructor(private readonly now: () => number = Date.now) {}
  private file() { return statePath("voice-companion.json"); }
  read(): CompanionDocument {
    try {
      const value = JSON.parse(fs.readFileSync(this.file(), "utf8")) as CompanionDocument;
      if (!record(value) || value.version !== 1 || !record(value.settings) || !record(value.charges) || !record(value.sessions)
        || typeof value.settings.enabled !== "boolean" || !["demo", "official-realtime"].includes(value.settings.backend)
        || !Number.isFinite(value.settings.monthlyCapUsd) || value.settings.monthlyCapUsd < 0
        || Object.values(value.charges).some(charge => !charge || !Number.isFinite(charge.usd) || charge.usd < 0
          || !/^\d{4}-\d{2}$/.test(charge.month) || typeof charge.reserved !== "boolean" || typeof charge.incomplete !== "boolean")
        || Object.entries(value.sessions).some(([key, session]) => !sessionValid(key, session))) throw new Error("invalid state");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw new Error("COMPANION_STATE_UNAVAILABLE");
    }
  }
  change<T>(operation: (document: CompanionDocument) => T): T {
    const file = this.file();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    return withFileTransactionSync(file, "companion state is busy", () => {
      const document = this.read();
      const result = operation(document);
      writePrivate(file, JSON.stringify(document));
      return result;
    });
  }
  settings(): CompanionSettings {
    const document = this.read();
    const month = new Date(this.now()).toISOString().slice(0, 7);
    const charges = Object.values(document.charges).filter(charge => charge.month === month);
    return { ...document.settings, keySource: this.keySource(), keyEnvironment: "OPENAI_API_KEY", month,
      usageUsd: charges.filter(charge => !charge.reserved).reduce((sum, charge) => sum + charge.usd, 0),
      reservedUsd: charges.filter(charge => charge.reserved).reduce((sum, charge) => sum + charge.usd, 0),
      incomplete: charges.some(charge => charge.incomplete) };
  }
  updateSettings(update: Partial<Pick<CompanionSettings, "enabled" | "backend" | "monthlyCapUsd">>): CompanionSettings {
    if ((update.enabled !== undefined && typeof update.enabled !== "boolean")
      || (update.backend !== undefined && update.backend !== "official-realtime" && update.backend !== "demo")
      || (update.monthlyCapUsd !== undefined && (!Number.isFinite(update.monthlyCapUsd) || update.monthlyCapUsd < 0 || update.monthlyCapUsd > 10_000))) throw new Error("INVALID_SETTINGS");
    this.change(document => { Object.assign(document.settings, update); });
    return this.settings();
  }
  private keySource(): CompanionSettings["keySource"] {
    if (process.env.OPENAI_API_KEY?.trim()) return "env";
    try { return fs.statSync(configFilePath("openai-api-key")).isFile() ? "file" : "missing"; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw new Error("KEY_UNAVAILABLE"); }
  }
  saveKey(key: string): void {
    if (this.keySource() === "env") throw new Error("KEY_FROM_ENV");
    if (!key.trim() || key.length > 512 || /[\s\u0000-\u001f]/u.test(key.trim())) throw new Error("INVALID_KEY");
    writePrivate(configFilePath("openai-api-key"), `${key.trim()}\n`);
  }
  /** Called only at an explicitly requested provider call; never by settings. */
  providerKey(): string {
    const environment = process.env.OPENAI_API_KEY?.trim();
    if (environment) return environment;
    try {
      const key = fs.readFileSync(configFilePath("openai-api-key"), "utf8").trim();
      if (key) return key;
    } catch { /* No credential is exposed in the failure. */ }
    throw new Error("NO_KEY");
  }
  reserve(key: string, usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) throw new Error("INVALID_USAGE");
    this.change(document => {
      if (document.charges[key]) return;
      const month = new Date(this.now()).toISOString().slice(0, 7);
      const spent = Object.values(document.charges).filter(charge => charge.month === month).reduce((sum, charge) => sum + charge.usd, 0);
      if (spent + usd > document.settings.monthlyCapUsd) throw new Error("CAP_REACHED");
      document.charges[key] = { month, usd, reserved: true, incomplete: false };
    });
  }
  settle(key: string, usd: number | null): void {
    if (usd !== null && (!Number.isFinite(usd) || usd < 0)) throw new Error("INVALID_USAGE");
    this.change(document => {
      const charge = document.charges[key];
      if (!charge?.reserved) return;
      charge.reserved = false;
      charge.incomplete = usd === null;
      if (usd !== null) charge.usd = Math.max(0, usd);
    });
  }
}
