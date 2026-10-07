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
  monthlyCapUsd: number;
  keySource: "env" | "file" | "missing";
  keyEnvironment: "OPENAI_API_KEY";
  month: string;
  usageUsd: number;
  reservedUsd: number;
  incomplete: boolean;
  /** A mint whose answer was lost may have opened a provider session nobody
   * can name; no new voice session starts until the operator releases it. */
  uncertainSession: boolean;
}
export interface StoredProposal {
  proposal: Proposal;
  sourceText: string;
  expiresAt: number;
  state: "pending" | "cancelled" | "admitted";
  delivery?: Delivery;
  text?: string;
  /** Admission writes "unknown" with the key, so a send whose outcome was
   * never recorded (a restart in between) is recovered with that key. */
  status?: "delivered" | "queued" | "unknown" | "failed";
  /** The operator's Live turn when the proposal was raised. */
  sourceTurn?: number;
  /** Why a waiting confirmation ended with nothing sent. */
  cancelCode?: string;
  /** What admitted the send: no confirmation asked, a tap, or the operator's spoken answer. */
  via?: "auto" | "tap" | "speech";
  reports: string[];
}
export interface StoredSession {
  authority?: "live-model";
  providerId?: string;
  /** The provider session may still be open (and billing): set at mint, cleared
   * only by a confirmed hangup or the provider's own close. Recovery retries it. */
  remoteOpen?: boolean;
  /** A mint asked of the provider whose answer never arrived: it may have
   * created a session nobody can name. Set before the request, cleared by its
   * answer, by the provider's refusal, or by the operator's release. */
  mintUncertain?: boolean;
  /** The process and service instance that minted the provider session. */
  owner?: { pid: number; instance: string };
  mintRequestId?: string;
  mintDigest?: string;
  answerSdp?: string;
  usage?: { seconds: number; responses: Record<string, { usd: number | null; complete: boolean }> };
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
interface Charge { month: string; usd: number; observedUsd?: number; reserved: boolean; incomplete: boolean }
export interface CompanionDocument {
  version: 1;
  settings: Pick<CompanionSettings, "enabled" | "monthlyCapUsd">;
  charges: Record<string, Charge>;
  sessions: Record<string, StoredSession>;
}
const empty = (): CompanionDocument => ({ version: 1, settings: { enabled: false, monthlyCapUsd: 20 }, charges: {}, sessions: {} });
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
  if (session.authority !== undefined && session.authority !== "live-model") return false;
  if (session.providerId !== undefined && !identifier(session.providerId)) return false;
  if (session.remoteOpen !== undefined && typeof session.remoteOpen !== "boolean") return false;
  if (session.mintUncertain !== undefined && typeof session.mintUncertain !== "boolean") return false;
  if (session.owner !== undefined && (!record(session.owner) || !Number.isSafeInteger(session.owner.pid) || !identifier(session.owner.instance))) return false;
  if (session.mintRequestId !== undefined && !identifier(session.mintRequestId)) return false;
  if (session.mintDigest !== undefined && (typeof session.mintDigest !== "string" || !/^[a-f0-9]{64}$/.test(session.mintDigest))) return false;
  if (session.answerSdp !== undefined && (typeof session.answerSdp !== "string" || session.answerSdp.length > 96_000)) return false;
  if (session.usage !== undefined && (!record(session.usage) || typeof session.usage.seconds !== "number" || !Number.isFinite(session.usage.seconds)
    || session.usage.seconds < 0 || !record(session.usage.responses) || Object.values(session.usage.responses).some(row => !record(row)
      || typeof row.complete !== "boolean" || (row.usd !== null && (typeof row.usd !== "number" || !Number.isFinite(row.usd) || row.usd < 0))))) return false;
  if (session.inputs.some(input => !record(input) || !identifier(input.itemId) || typeof input.text !== "string" || typeof input.final !== "boolean"
    || (input.turn !== undefined && (!Number.isSafeInteger(input.turn) || (input.turn as number) < 0)))) return false;
  if (session.events.some(event => !record(event) || event.sessionId !== key || event.version !== 1 || !identifier(event.eventId)
    || !identifier(event.type) || !Number.isSafeInteger(event.seq) || !Number.isSafeInteger(event.generation) || !Number.isFinite(event.atMs))) return false;
  return Object.entries(session.proposals).every(([id, held]) => {
    if (!record(held) || !record(held.proposal) || (held.proposal.authority !== undefined && held.proposal.authority !== "live-model") || held.proposal.proposalId !== id || !identifier(id)
      || !identifier(held.proposal.callId) || !identifier(held.proposal.sourceItemId) || typeof held.proposal.instruction !== "string"
      || !recipientValid(held.proposal.recipient) || canonicalProject((held.proposal.recipient as { project: string }).project) !== canonicalProject(session.project as string)
      || typeof held.sourceText !== "string" || !Number.isFinite(held.expiresAt) || !["pending", "cancelled", "admitted"].includes(held.state as string)
      || !Array.isArray(held.reports) || !held.reports.every(identifier)
      || (held.sourceTurn !== undefined && (!Number.isSafeInteger(held.sourceTurn) || (held.sourceTurn as number) < 0))) return false;
    if (held.state !== "admitted") return held.delivery === undefined && held.text === undefined && held.status === undefined;
    return record(held.delivery) && held.delivery.proposalId === id && held.delivery.callId === held.proposal.callId
      && identifier(held.delivery.clientMessageId) && (held.delivery.operationId === null || identifier(held.delivery.operationId))
      && recipientValid(held.delivery.recipient) && JSON.stringify(held.delivery.recipient) === JSON.stringify(held.proposal.recipient)
      && typeof held.text === "string" && (held.status === undefined || ["delivered", "queued", "unknown", "failed"].includes(held.status as string));
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

const uncertainMint = (session: StoredSession) => !session.providerId && !!session.mintUncertain && session.remoteOpen !== false;
/** Session authority and accounting only. Delivery receipts and reports remain
 * in their existing stores. Reads fail closed on corrupt/unreadable state. */
export class CompanionStorage {
  constructor(private readonly now: () => number = Date.now) {}
  private file() { return statePath("voice-companion.json"); }
  read(): CompanionDocument {
    try {
      const value = JSON.parse(fs.readFileSync(this.file(), "utf8")) as CompanionDocument;
      if (!record(value) || value.version !== 1 || !record(value.settings) || !record(value.charges) || !record(value.sessions)
        || typeof value.settings.enabled !== "boolean"
        || !Number.isFinite(value.settings.monthlyCapUsd) || value.settings.monthlyCapUsd < 0
        || Object.values(value.charges).some(charge => !charge || !Number.isFinite(charge.usd) || charge.usd < 0
          || !/^\d{4}-\d{2}$/.test(charge.month) || typeof charge.reserved !== "boolean" || typeof charge.incomplete !== "boolean"
          || (charge.observedUsd !== undefined && (!Number.isFinite(charge.observedUsd) || charge.observedUsd < 0 || charge.observedUsd > charge.usd)))
        || Object.entries(value.sessions).some(([key, session]) => !sessionValid(key, session))) throw new Error("invalid state");
      /* Earlier builds stored a backend: the real voice, or a scripted demo the product no longer has. A stored
         demo reads as off, so turning the companion on is the operator's own choice of the real voice; the next
         write leaves the field out. */
      const legacy = value.settings as typeof value.settings & { backend?: unknown };
      if (legacy.backend !== undefined) {
        if (legacy.backend !== "official-realtime" && legacy.backend !== "demo") throw new Error("invalid state");
        if (legacy.backend === "demo") legacy.enabled = false;
        delete legacy.backend;
      }
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
      usageUsd: charges.reduce((sum, charge) => sum + (charge.reserved ? charge.observedUsd ?? 0 : charge.usd), 0),
      reservedUsd: charges.filter(charge => charge.reserved).reduce((sum, charge) => sum + charge.usd - (charge.observedUsd ?? 0), 0),
      incomplete: charges.some(charge => charge.incomplete),
      uncertainSession: Object.values(document.sessions).some(uncertainMint) };
  }
  /** The operator's word that the provider session a lost mint answer may have
   * opened is closed: the operator can see the provider's own usage, this
   * service cannot. Its charge is kept, incomplete, grown to the time since it
   * was minted at `usdPerSecond`; only then can a new session be minted. */
  releaseUncertainMints(usdPerSecond: number): CompanionSettings {
    if (!Number.isFinite(usdPerSecond) || usdPerSecond < 0) throw new Error("INVALID_USAGE");
    this.change(document => {
      for (const session of Object.values(document.sessions).filter(uncertainMint)) {
        const charge = document.charges[session.id];
        if (charge) {
          charge.reserved = false; charge.incomplete = true;
          charge.usd = Math.max(charge.usd, charge.observedUsd ?? 0, Math.max(15, (this.now() - session.createdAt) / 1_000) * usdPerSecond);
        }
        session.remoteOpen = false; delete session.mintUncertain;
      }
    });
    return this.settings();
  }
  updateSettings(update: Partial<Pick<CompanionSettings, "enabled" | "monthlyCapUsd">>): CompanionSettings {
    if (Object.keys(update).some(key => key !== "enabled" && key !== "monthlyCapUsd")
      || (update.enabled !== undefined && typeof update.enabled !== "boolean")
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
  /** Every credential this installation could present, for redaction only. */
  credentials(): string[] {
    const found: string[] = [];
    const environment = process.env.OPENAI_API_KEY?.trim();
    if (environment) found.push(environment);
    try { const key = fs.readFileSync(configFilePath("openai-api-key"), "utf8").trim(); if (key) found.push(key); }
    catch { /* No key file: nothing of it can be echoed. */ }
    return found;
  }
  /** Holds `usd` when `room` (at least `usd`) is free under the cap. */
  reserve(key: string, usd: number, room = usd): void {
    if (!Number.isFinite(usd) || usd < 0 || !Number.isFinite(room) || room < usd) throw new Error("INVALID_USAGE");
    this.change(document => {
      if (document.charges[key]) return;
      const month = new Date(this.now()).toISOString().slice(0, 7);
      const spent = Object.values(document.charges).filter(charge => charge.month === month).reduce((sum, charge) => sum + charge.usd, 0);
      if (spent + room > document.settings.monthlyCapUsd) throw new Error("CAP_REACHED");
      document.charges[key] = { month, usd, reserved: true, incomplete: false };
    });
  }
  /** Extend a live reservation before accepting more provider work. */
  extend(key: string, usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) throw new Error("INVALID_USAGE");
    this.change(document => {
      const charge = document.charges[key];
      if (!charge?.reserved) throw new Error("INVALID_USAGE");
      const month = new Date(this.now()).toISOString().slice(0, 7);
      if (charge.month !== month) throw new Error("CAP_REACHED");
      const spent = Object.values(document.charges).filter(row => row.month === month).reduce((sum, row) => sum + row.usd, 0);
      if (spent + usd > document.settings.monthlyCapUsd) throw new Error("CAP_REACHED");
      charge.usd += usd;
    });
  }
  /** Gives back the part of a live reservation a finished response did not
   * use. What has been observed stays held. */
  release(key: string, usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) throw new Error("INVALID_USAGE");
    this.change(document => {
      const charge = document.charges[key];
      if (!charge?.reserved) return;
      charge.usd = Math.max(charge.observedUsd ?? 0, charge.usd - usd);
    });
  }
  settle(key: string, usd: number | null): void {
    if (usd !== null && (!Number.isFinite(usd) || usd < 0)) throw new Error("INVALID_USAGE");
    this.change(document => {
      const charge = document.charges[key];
      if (!charge?.reserved) return;
      charge.reserved = false;
      charge.incomplete = usd === null;
      if (usd !== null) charge.usd = Math.max(0, usd, charge.observedUsd ?? 0);
    });
  }
  /** A settled charge whose provider session was not confirmed closed: it
   * grows to what that session may have cost and stays incomplete. */
  accrue(key: string, usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) throw new Error("INVALID_USAGE");
    this.change(document => {
      const charge = document.charges[key];
      if (!charge || charge.reserved || usd <= charge.usd) return;
      charge.usd = usd; charge.incomplete = true;
    });
  }
  observe(key: string, usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) throw new Error("INVALID_USAGE");
    this.change(document => {
      const charge = document.charges[key];
      if (!charge?.reserved) return;
      charge.observedUsd = Math.max(charge.observedUsd ?? 0, usd);
      charge.usd = Math.max(charge.usd, charge.observedUsd);
    });
  }
}
