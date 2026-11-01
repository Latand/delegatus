import { createHash } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { waitForStateLock } from "@/lib/state/lockWait";
import { smallStore } from "@/lib/state/smallStore";
import type { Locale } from "./contract";
import type { SessionStarter } from "./storage";
import { firedSentence, firedTitle, type FiredWording } from "./timerWords";

/*
 * Voice timers (docs/design/voice-timers.md). A timer is a row in state.sqlite, owned by whoever started the call, so it
 * outlives the call, a page reload and a Viewer restart. One armed timeout covers the earliest thing owed. Every wake
 * works from the rows, so a restart resumes where the last release stopped.
 *
 * Delivery is at most once per channel. Each channel records its own entry on the row. A voice entry owed to a call
 * lives in memory beside the row: a row that says `owed` with nothing in memory lost its call, and the wake moves it on.
 */

export const MIN_TIMER_MINUTES = 0.5;
export const MAX_TIMER_MINUTES = 1440;
export const MAX_PENDING_TIMERS = 20;
export const TIMER_LABEL_CHARS = 60;
/** A call that cannot say a timer within this long gives it to the next channel. */
export const VOICE_HOLD_MS = 60_000;
/** A fired timer no channel delivered stays owed this long, then becomes `missed`. */
export const OWED_MS = 12 * 3_600_000;
/** Settled rows go this long after they settle. */
export const RETAIN_MS = 24 * 3_600_000;
/** `list` still shows a fired or missed timer this long. */
export const RECENT_MS = 3_600_000;
/** A tab may still toast a timer another channel delivered this soon after it fired. */
export const TOAST_FRESH_MS = 120_000;
/** The next wake is never further off: it catches a row another release wrote, and a clock that jumped. */
export const RESCAN_MS = 60_000;
/** A release that does not own traffic asks again this soon. */
export const TRAFFIC_RECHECK_MS = 5_000;
/** A channel that failed is asked again after these waits, then left for the next call or page load. */
export const CHANNEL_RETRY_MS = [60_000, 300_000] as const;
/** Past this between due and fired, the sentence says when it was due. */
const LATE_MS = 60_000;
/** Heard this long after it fired, a timer is told as news from while the operator was away. */
const AWAY_MS = 60_000;

export type VoiceTimerState = "pending" | "fired" | "cancelled" | "missed";
export type PushOutcome = "sent" | "none" | "failed";
export type TelegramOutcome = "sent" | "uncertain" | "none" | "failed";
export interface VoiceEntry { state: "owed" | "spoken" | "withdrawn"; at: number; sessionId?: string }
export interface ChannelEntry<S extends string> { state: S; at: number; attempts: number; retryAt?: number }
export interface VoiceTimerDelivery {
  voice?: VoiceEntry;
  /** `sending` with nothing in flight was cut off, and is asked again under the same key. */
  push?: ChannelEntry<PushOutcome | "sending">;
  /** `off`: the operator had not chosen Telegram when the timer fired. */
  telegram?: ChannelEntry<TelegramOutcome | "sending" | "off">;
  toast?: { at: number };
}
export interface VoiceTimer {
  id: string;
  owner: SessionStarter;
  label: string | null;
  minutes: number;
  createdAt: number;
  dueAt: number;
  timeZone: string | null;
  locale: Locale;
  /** Set after a private read in the call that set it: its label stays in that call and on the owner's screens. */
  private: boolean;
  sessionId: string;
  /** The delegation and attempt that set it, so a duplicate handoff of one attempt sets one timer. */
  delegationId?: string;
  attempt?: string;
  state: VoiceTimerState;
  firedAt?: number;
  settledAt?: number;
  delivery: VoiceTimerDelivery;
}

const isOwner = (value: unknown): value is SessionStarter => {
  const row = value as { operator?: unknown; memberId?: unknown } | null;
  return !!row && (row.operator === true || (typeof row.memberId === "string" && !!row.memberId));
};
/** What a row must hold to be read at all. Every writer below stores this shape. */
export function validVoiceTimer(value: unknown): value is VoiceTimer {
  const row = value as Partial<VoiceTimer> | null;
  return !!row && typeof row.id === "string" && !!row.id && isOwner(row.owner) && (row.label === null || typeof row.label === "string")
    && Number.isFinite(row.minutes) && Number.isFinite(row.createdAt) && Number.isFinite(row.dueAt)
    && (row.timeZone === null || typeof row.timeZone === "string") && (row.locale === "en" || row.locale === "uk")
    && typeof row.private === "boolean" && typeof row.sessionId === "string"
    && (row.state === "pending" || row.state === "fired" || row.state === "cancelled" || row.state === "missed")
    && !!row.delivery && typeof row.delivery === "object";
}

export const voiceTimerStore = smallStore<VoiceTimer[]>({
  collection: "voice_timers", empty: () => [],
  parse: raw => Array.isArray(raw) ? raw.filter(validVoiceTimer) : [],
  toRows: timers => timers.map(value => ({ key: value.id, value })),
  fromRows: rows => rows.map(row => row.value as VoiceTimer), toFile: timers => timers,
});
export const voiceTimersFile = () => statePath("voice-timers.json");

const ownerKey = (owner: SessionStarter) => "memberId" in owner ? `member:${owner.memberId}` : "operator";
/** The order timers fire and are listed in. */
const byDue = (a: VoiceTimer, b: VoiceTimer) => a.dueAt - b.dueAt || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Some channel reached the operator. An uncertain Telegram send stays owed: the next call may still say it. */
export const timerDelivered = (row: VoiceTimer) => row.delivery.voice?.state === "spoken" || row.delivery.push?.state === "sent"
  || row.delivery.telegram?.state === "sent" || !!row.delivery.toast;
export function timerDeliveredBy(row: VoiceTimer): string[] {
  const { voice, push, telegram, toast } = row.delivery;
  return [...(voice?.state === "spoken" ? ["voice"] : []), ...(push?.state === "sent" ? ["push"] : []), ...(toast ? ["toast"] : []), ...(telegram?.state === "sent" ? ["telegram"] : [])];
}
const compact = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
const firedWording = (row: VoiceTimer, now: number): FiredWording =>
  now - row.firedAt! > AWAY_MS ? "away" : row.firedAt! - row.dueAt > LATE_MS ? "late" : "due";
/** A private timer's label never reaches a model outside the call that set it. */
export const timerLabelIn = (row: VoiceTimer, sessionId: string) => row.private && row.sessionId !== sessionId ? null : row.label;

export interface VoiceTimerPorts {
  now(): number;
  /** One armed wake; production uses an unref'd timeout. */
  schedule(wake: () => void, delayMs: number): { cancel(): void };
  ownsTraffic(): boolean;
  /** A call by this owner that can speak now. */
  liveCall(owner: SessionStarter): boolean;
  /** The installation's operator: their devices and Telegram chat are the ones push and Telegram reach. */
  isOperator(owner: SessionStarter): boolean;
  telegramChosen(): boolean;
  timeZone(): string | null;
  push(message: { id: string; title: string; body: string }): Promise<PushOutcome>;
  telegram(message: { id: string; text: string }): Promise<TelegramOutcome>;
  file?(): string;
}
export interface NewTimer {
  owner: SessionStarter; sessionId: string; callId: string; delegationId: string; attempt?: string;
  minutes: number; label: string | null; locale: Locale; private: boolean;
}
export type SetOutcome = { state: "set" | "duplicate"; timer: VoiceTimer; running: VoiceTimer[] } | { state: "limit"; running: VoiceTimer[] };
export type CancelOutcome =
  | { state: "cancelled"; timer: VoiceTimer; running: VoiceTimer[] }
  | { state: "ambiguous"; matches: VoiceTimer[] }
  | { state: "not_found"; running: VoiceTimer[] };
/** Everything the voice tool reaches: the tool's context carries this and no store. */
export type VoiceTimerCalls = Pick<VoiceTimers, "set" | "list" | "cancel">;

interface Owed { row: VoiceTimer; key: string; deadline: number; wording: FiredWording }

export class VoiceTimers {
  /** Fired timers a live call still has to say, in firing order. Looked up on every poll, so it never touches the store. */
  private owed: Owed[] = [];
  /** Spoken with the row not yet saying so; never handed to another channel meanwhile. */
  private readonly spokenUnsaved = new Map<string, { sessionId: string; at: number }>();
  private readonly sending = new Set<string>();
  private readonly work = new Set<Promise<unknown>>();
  private armed?: { cancel(): void };
  private running?: Promise<void>;
  private again = false;
  private stopped = false;
  /** Whole-store checks and inserts run one at a time, so the owner's cap holds. */
  private creating: Promise<unknown> = Promise.resolve();
  constructor(private readonly ports: VoiceTimerPorts) {}

  private file(): string { return this.ports.file?.() ?? voiceTimersFile(); }
  private async rows(): Promise<VoiceTimer[]> {
    const rows: VoiceTimer[] = [];
    for (let after = "";;) {
      const page = await waitForStateLock("voice_timers.read", () => voiceTimerStore.readPage(this.file(), after, 128));
      if (!page.length) return rows;
      for (const row of page) if (validVoiceTimer(row.value)) rows.push(row.value);
      else console.error("[voice timers] unreadable row", row.key);
      after = page.at(-1)!.key;
    }
  }
  /** One row's compare-and-set: `change` sees the row as stored, and null leaves it as it is. */
  private patch(id: string, change: (row: VoiceTimer) => VoiceTimer | null): Promise<VoiceTimer | null> {
    return waitForStateLock("voice_timers.patch", () => voiceTimerStore.patchRows(this.file(), 2, tx => {
      const held = tx.get(id)?.value;
      if (!validVoiceTimer(held)) return null;
      const next = change(held);
      if (next) tx.put({ key: id, value: next });
      return next;
    }));
  }

  /** At Viewer boot, and from anything that changed a row. */
  start(): void { this.stopped = false; this.kick(); }
  stop(): void { this.stopped = true; this.armed?.cancel(); this.armed = undefined; }
  /** Waits for the wake and every send in flight. */
  async settled(): Promise<void> {
    while (this.running || this.work.size) await Promise.all([this.running, ...this.work]);
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.work.add(promise);
    void promise.catch(() => undefined).finally(() => { this.work.delete(promise); });
    return promise;
  }
  private kick(): void {
    if (this.stopped) return;
    if (this.running) { this.again = true; return; }
    const finish = () => {
      this.running = undefined;
      if (this.again) { this.again = false; this.kick(); }
    };
    this.running = this.pass().catch(error => {
      console.error("[voice timers] wake failed", error instanceof Error ? error.message : String(error));
      this.arm(TRAFFIC_RECHECK_MS);
    }).then(finish, finish);
  }
  private arm(delayMs: number): void {
    this.armed?.cancel();
    if (!this.stopped) this.armed = this.ports.schedule(() => { this.armed = undefined; this.kick(); }, Math.max(0, delayMs));
  }

  private async pass(): Promise<void> {
    await this.saveSpoken();
    if (!this.ports.ownsTraffic()) { this.arm(TRAFFIC_RECHECK_MS); return; }
    const now = this.ports.now();
    const rows = (await this.rows()).sort(byDue);
    for (const row of rows.filter(row => row.state === "pending" && row.dueAt <= now)) await this.fire(row, now);
    // A call that held a timer too long gives it up here; a call that ended gave it up already.
    this.owed = this.owed.filter(entry => entry.deadline > now);
    let next = RESCAN_MS;
    const sooner = (at: number) => { next = Math.min(next, at - now); };
    for (const entry of this.owed) sooner(entry.deadline);
    for (const held of await this.rows()) {
      const row = held.state === "fired" ? await this.afterCall(held, now) : held;
      if (row.state === "pending") sooner(row.dueAt);
      else if (row.state === "fired" && !this.owedHere(row.id) && !this.spokenUnsaved.has(row.id) && row.delivery.voice?.state !== "spoken") {
        if (now - row.firedAt! < OWED_MS) this.channels(row, now, sooner);
        else if (!timerDelivered(row)) await this.patch(row.id, stored => stored.state === "fired" && !timerDelivered(stored) ? { ...stored, state: "missed", settledAt: now } : null);
      }
      const settled = row.state === "fired" ? row.firedAt! : row.settledAt;
      if (row.state !== "pending" && settled !== undefined && now - settled >= RETAIN_MS)
        await waitForStateLock("voice_timers.retire", () => voiceTimerStore.patchRows(this.file(), 2, tx => { tx.delete(row.id); }));
    }
    this.arm(next);
  }
  private owedHere(id: string): boolean { return this.owed.some(entry => entry.row.id === id); }

  private async fire(row: VoiceTimer, now: number): Promise<void> {
    const fired = await this.patch(row.id, stored => {
      if (stored.state !== "pending" || stored.dueAt > now) return null;
      const live = this.ports.liveCall(stored.owner);
      return { ...stored, state: "fired", firedAt: now, delivery: live ? { voice: { state: "owed", at: now } } : {} };
    });
    // The call may have gone while that write waited; the wake then hands the timer on.
    if (fired?.delivery.voice && this.ports.liveCall(fired.owner)) this.owe(fired, now);
  }
  private owe(row: VoiceTimer, now: number): void {
    this.owed.push({ row, key: ownerKey(row.owner), deadline: now + VOICE_HOLD_MS, wording: firedWording(row, now) });
  }
  /** A row still saying `owed` with no call holding it: its call ended, held it too long, or went with a restart. */
  private async afterCall(row: VoiceTimer, now: number): Promise<VoiceTimer> {
    if (row.delivery.voice?.state !== "owed" || this.owedHere(row.id) || this.spokenUnsaved.has(row.id)) return row;
    return await this.patch(row.id, stored => stored.delivery.voice?.state === "owed"
      ? { ...stored, delivery: { ...stored.delivery, voice: { state: "withdrawn", at: now } } } : null) ?? row;
  }

  /** Push and Telegram for a timer no live call holds. Sends run beside the wake, so a slow one delays no other timer. */
  private channels(row: VoiceTimer, now: number, sooner: (at: number) => void): void {
    const owed = (entry: ChannelEntry<string> | undefined, channel: string) => {
      if (this.sending.has(`${channel}:${row.id}`)) return false;
      if (!entry || (entry.state === "sending" && entry.attempts <= CHANNEL_RETRY_MS.length)) return true;
      if (entry.state !== "failed" || entry.attempts > CHANNEL_RETRY_MS.length) return false;
      if (entry.retryAt! > now) { sooner(entry.retryAt!); return false; }
      return true;
    };
    const operator = this.ports.isOperator(row.owner);
    if (owed(row.delivery.push, "push")) this.track(this.send(row, "push", operator
      ? () => this.ports.push({ id: row.id, title: firedTitle(row.locale), body: this.offCallText(row, now) })
      : async () => "none"));
    if (owed(row.delivery.telegram, "telegram")) this.track(this.send(row, "telegram", !operator ? async () => "none"
      : !this.ports.telegramChosen() ? async () => "off"
      : () => this.ports.telegram({ id: row.id, text: `${firedTitle(row.locale)}. ${this.offCallText(row, now)}` })));
  }
  /** Push and Telegram leave the call: a private timer goes out without its label. */
  private offCallText(row: VoiceTimer, now: number): string {
    return firedSentence({ ...row, label: row.private ? null : row.label }, row.locale, firedWording(row, now));
  }
  private async send(row: VoiceTimer, channel: "push" | "telegram", deliver: () => Promise<string>): Promise<void> {
    const key = `${channel}:${row.id}`;
    this.sending.add(key);
    try {
      const now = this.ports.now();
      const earlier = row.delivery[channel]?.attempts;
      const attempts = (earlier ?? 0) + 1;
      const claimed = await this.patch(row.id, stored => stored.state === "fired" && !this.owedHere(row.id) && stored.delivery[channel]?.attempts === earlier
        ? { ...stored, delivery: { ...stored.delivery, [channel]: { state: "sending", at: now, attempts } } } : null);
      if (!claimed) return;
      let outcome: string;
      try { outcome = await deliver(); }
      catch (error) { console.error(`[voice timers] ${channel} failed`, error instanceof Error ? error.name : "unknown"); outcome = "failed"; }
      const at = this.ports.now();
      const retryAt = outcome === "failed" && attempts <= CHANNEL_RETRY_MS.length ? { retryAt: at + CHANNEL_RETRY_MS[attempts - 1]! } : {};
      await this.patch(row.id, stored => ({ ...stored, delivery: { ...stored.delivery, [channel]: { state: outcome, at, attempts, ...retryAt } } }) as VoiceTimer);
    } finally {
      this.sending.delete(key);
      if (!this.stopped) this.kick();
    }
  }

  /** Hot path: every poll of a live call asks. */
  owedTo(owner: SessionStarter): boolean {
    const key = ownerKey(owner);
    return this.owed.some(entry => entry.key === key);
  }
  /** Says what this call owes, in firing order. Taken out of the list before `say` runs, and every step up to its return
   * is synchronous: a wake that withdraws the timer and a second poll that would say it again both find it gone. */
  speakOwed(owner: SessionStarter, sessionId: string, locale: Locale, say: (sentence: string, id: string) => boolean): void {
    const key = ownerKey(owner);
    for (let index = this.owed.findIndex(entry => entry.key === key); index >= 0; index = this.owed.findIndex(entry => entry.key === key)) {
      const [entry] = this.owed.splice(index, 1);
      const sentence = firedSentence({ ...entry.row, label: timerLabelIn(entry.row, sessionId) }, locale, entry.wording);
      if (!say(sentence, entry.row.id)) { this.owed.splice(index, 0, entry); break; }
      this.spokenUnsaved.set(entry.row.id, { sessionId, at: this.ports.now() });
    }
    this.track(this.saveSpoken());
  }
  private async saveSpoken(): Promise<void> {
    for (const [id, spoken] of [...this.spokenUnsaved]) {
      try {
        await this.patch(id, stored => ({ ...stored, delivery: { ...stored.delivery, voice: { state: "spoken", at: spoken.at, sessionId: spoken.sessionId } } }));
        this.spokenUnsaved.delete(id);
      } catch (error) { console.error("[voice timers] spoken not saved", error instanceof Error ? error.message : String(error)); }
    }
  }
  /** A new call says what fired while no channel reached the owner. */
  callStarted(owner: SessionStarter): void {
    this.track((async () => {
      const key = ownerKey(owner);
      const now = this.ports.now();
      for (const row of (await this.rows()).sort(byDue)) {
        if (row.state !== "fired" || ownerKey(row.owner) !== key || timerDelivered(row) || now - row.firedAt! >= OWED_MS || this.owedHere(row.id) || !this.ports.liveCall(owner)) continue;
        const held = await this.patch(row.id, stored => stored.state === "fired" && !timerDelivered(stored)
          ? { ...stored, delivery: { ...stored.delivery, voice: { state: "owed", at: now } } } : null);
        if (held) this.owed.push({ row: held, key, deadline: now + VOICE_HOLD_MS, wording: "away" });
      }
      if (this.owed.length) this.kick();
    })().catch(error => { console.error("[voice timers] call start read failed", error instanceof Error ? error.message : String(error)); }));
  }
  /** A call ended: with no other call by this owner, what it still owed goes to the next channel. */
  callEnded(owner: SessionStarter): void {
    if (this.ports.liveCall(owner)) return;
    const key = ownerKey(owner);
    if (!this.owed.some(entry => entry.key === key)) return;
    this.owed = this.owed.filter(entry => entry.key !== key);
    this.kick();
  }

  async set(input: NewTimer): Promise<SetOutcome> {
    const run = this.creating.then(() => this.create(input));
    this.creating = run.catch(() => undefined);
    return run;
  }
  private async create(input: NewTimer): Promise<SetOutcome> {
    const key = ownerKey(input.owner);
    const now = this.ports.now();
    const mine = (await this.rows()).filter(row => row.state === "pending" && ownerKey(row.owner) === key).sort(byDue);
    const twin = input.attempt ? mine.find(row => row.attempt === input.attempt && row.delegationId !== input.delegationId
      && row.minutes === input.minutes && row.label === input.label) : undefined;
    if (twin) return { state: "duplicate", timer: twin, running: mine };
    // One provider call sets one timer, however often its call is replayed.
    const id = `vt_${createHash("sha256").update(`${input.sessionId}\n${input.callId}`).digest("hex").slice(0, 16)}`;
    const replayed = await waitForStateLock("voice_timers.read", () => voiceTimerStore.readRow(this.file(), id));
    if (validVoiceTimer(replayed?.value)) return { state: "duplicate", timer: replayed.value, running: mine };
    if (mine.length >= MAX_PENDING_TIMERS) return { state: "limit", running: mine };
    const timer: VoiceTimer = { id, owner: input.owner, label: input.label, minutes: input.minutes, createdAt: now, dueAt: now + Math.round(input.minutes * 60_000),
      timeZone: this.ports.timeZone(), locale: input.locale, private: input.private, sessionId: input.sessionId, delegationId: input.delegationId,
      ...(input.attempt ? { attempt: input.attempt } : {}), state: "pending", delivery: {} };
    await waitForStateLock("voice_timers.create", () => voiceTimerStore.patchRows(this.file(), 2, tx => { tx.put({ key: id, value: timer }); }));
    this.kick();
    return { state: "set", timer, running: [...mine, timer].sort(byDue) };
  }
  /** The owner's running timers, and those that fired within the hour. */
  async list(owner: SessionStarter): Promise<{ running: VoiceTimer[]; recent: VoiceTimer[]; now: number; }> {
    const key = ownerKey(owner);
    const now = this.ports.now();
    const mine = (await this.rows()).filter(row => ownerKey(row.owner) === key).sort(byDue);
    return { running: mine.filter(row => row.state === "pending"), now,
      recent: mine.filter(row => (row.state === "fired" || row.state === "missed") && now - (row.settledAt ?? row.firedAt!) < RECENT_MS) };
  }
  /** The handle wins. Then a label: exact first, then one that contains the words or is contained by them.
   * Several matches cancel nothing. A private label from another call is matched by handle only. */
  async cancel(owner: SessionStarter, sessionId: string, query: string): Promise<CancelOutcome> {
    const key = ownerKey(owner);
    const now = this.ports.now();
    const running = (await this.rows()).filter(row => row.state === "pending" && ownerKey(row.owner) === key).sort(byDue);
    const wanted = compact(query);
    const labelled = running.filter(row => timerLabelIn(row, sessionId) !== null);
    const label = (row: VoiceTimer) => compact(row.label!);
    const exact = labelled.filter(row => label(row) === wanted);
    const near = labelled.filter(row => wanted && (label(row).includes(wanted) || wanted.includes(label(row))));
    const handle = running.filter(row => row.id === query.trim());
    const matches = handle.length ? handle : exact.length ? exact : near;
    if (!matches.length) return { state: "not_found", running };
    if (matches.length > 1) return { state: "ambiguous", matches };
    const timer = await this.patch(matches[0]!.id, stored => stored.state === "pending" ? { ...stored, state: "cancelled", settledAt: now } : null);
    if (!timer) return { state: "not_found", running: running.filter(row => row.id !== matches[0]!.id) };
    this.kick();
    return { state: "cancelled", timer, running: running.filter(row => row.id !== timer.id) };
  }

  private toastable(row: VoiceTimer, now: number): boolean {
    return row.state === "fired" && !row.delivery.toast && row.delivery.voice?.state !== "spoken" && !this.owedHere(row.id) && !this.spokenUnsaved.has(row.id)
      && now - row.firedAt! < OWED_MS && (now - row.firedAt! < TOAST_FRESH_MS || !timerDelivered(row));
  }
  /** What a tab of this owner should do: toast these, and read again when the next timer is due. */
  async forTab(owner: SessionStarter): Promise<{ claimable: string[]; nextInMs: number | null }> {
    const key = ownerKey(owner);
    const now = this.ports.now();
    const mine = (await this.rows()).filter(row => ownerKey(row.owner) === key).sort(byDue);
    const pending = mine.filter(row => row.state === "pending");
    return { claimable: mine.filter(row => this.toastable(row, now)).map(row => row.id), nextInMs: pending.length ? Math.max(0, pending[0]!.dueAt - now) : null };
  }
  /** The first tab to ask shows the toast. A tab whose own timeout ran before the server's fires the timer first. */
  async claimToast(owner: SessionStarter, id: string, locale: Locale): Promise<{ claimed: false } | { claimed: true; text: string; title: string }> {
    const before = await waitForStateLock("voice_timers.read", () => voiceTimerStore.readRow(this.file(), id));
    if (!validVoiceTimer(before?.value) || ownerKey(before.value.owner) !== ownerKey(owner)) return { claimed: false };
    if (before.value.state === "pending" && before.value.dueAt <= this.ports.now() && this.ports.ownsTraffic()) {
      this.kick();
      await this.running;
    }
    const now = this.ports.now();
    const row = await this.patch(id, stored => this.toastable(stored, now) ? { ...stored, delivery: { ...stored.delivery, toast: { at: now } } } : null);
    return row ? { claimed: true, title: firedTitle(locale), text: firedSentence(row, locale, firedWording(row, now)) } : { claimed: false };
  }
}
