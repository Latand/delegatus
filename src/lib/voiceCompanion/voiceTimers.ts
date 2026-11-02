import { createHash } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { waitForStateLock } from "@/lib/state/lockWait";
import { smallStore } from "@/lib/state/smallStore";
import type { Locale } from "./contract";
import type { HeldSpeech, SpeechOutcome } from "./provider";
import type { SessionStarter } from "./storage";
import { firedSentence, firedTitle, type FiredWording } from "./timerWords";

/*
 * Voice timers (docs/design/voice-timers.md). A timer is a row in state.sqlite, owned by whoever started the call, so it
 * outlives the call, a page reload and a Viewer restart. One armed timeout covers the earliest thing owed. Every wake
 * works from the rows, so a restart resumes where the last release stopped.
 *
 * Delivery is at most once per channel. Each channel records its own entry on the row. A voice entry owed to a call
 * lives in memory beside the row: a row that says `owed` with nothing in memory lost its call, and the wake moves it on.
 * The row says `saying` before the provider is handed the words. With nothing in memory that row may or may not have been
 * voiced, so it becomes `uncertain`: the voice never says it again and the other channels may. A toast works the same way:
 * the row says `showing` before a tab shows it, and no tab is offered it again, whatever answer is lost.
 *
 * A row that can need no more work moves from `<id>` to `done:<id>` in one write, so a wake reads what is active and a
 * separate cursor retires the history one page at a time.
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
/** A tab that claimed a toast has this long to say it showed it; after that the toast is free to claim again. */
export const TOAST_LEASE_MS = 30_000;
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
/** A channel whose write the store refused is tried again after these waits, the last one repeating. */
export const WRITE_RETRY_MS = [5_000, 30_000, 60_000] as const;
/** Past this between due and fired, the sentence says when it was due. */
const LATE_MS = 60_000;
/** Heard this long after it fired, a timer is told as news from while the operator was away. */
const AWAY_MS = 60_000;
const ROW_PAGE = 128;
/** The retire cursor reads this many history rows, once per rescan. */
const RETIRE_PAGE = 64;
/** History keys sort before every active key, so a read from `ACTIVE_AFTER` never sees one. */
const HISTORY = "done:";
const ACTIVE_AFTER = "vt";

export type VoiceTimerState = "pending" | "fired" | "cancelled" | "missed";
export type PushOutcome = "sent" | "uncertain" | "none" | "failed";
export type TelegramOutcome = "sent" | "uncertain" | "none" | "failed";
export interface VoiceEntry { state: "owed" | "saying" | "spoken" | "withdrawn" | "uncertain"; at: number; sessionId?: string }
export interface ChannelEntry<S extends string> { state: S; at: number; attempts: number; retryAt?: number }
export interface VoiceTimerDelivery {
  voice?: VoiceEntry;
  /** `sending` with nothing in flight was cut off, and is asked again under the same key. */
  push?: ChannelEntry<PushOutcome | "sending">;
  /** `off`: the operator had not chosen Telegram when the timer fired. */
  telegram?: ChannelEntry<TelegramOutcome | "sending" | "off">;
  /** `leased`: a tab claimed it and shows nothing yet, so the lease running out frees it. `showing`: the tab is about to
   * show it, so it may be on screen and is never offered again. `attempt` tells a late answer from a later claim. */
  toast?: { state: "leased" | "showing" | "shown"; at: number; attempt: number; leaseUntil?: number };
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
  /** When it moved to the history; its row key then starts `done:`. */
  archivedAt?: number;
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
  toRows: timers => timers.map(value => ({ key: value.archivedAt === undefined ? value.id : `${HISTORY}${value.id}`, value })),
  fromRows: rows => rows.map(row => row.value as VoiceTimer), toFile: timers => timers,
});
export const voiceTimersFile = () => statePath("voice-timers.json");

const ownerKey = (owner: SessionStarter) => "memberId" in owner ? `member:${owner.memberId}` : "operator";
/** The order timers fire and are listed in. */
const byDue = (a: VoiceTimer, b: VoiceTimer) => a.dueAt - b.dueAt || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Some channel reached the operator. An uncertain Telegram send stays owed: the next call may still say it. */
export const timerDelivered = (row: VoiceTimer) => row.delivery.voice?.state === "spoken" || row.delivery.push?.state === "sent"
  || row.delivery.telegram?.state === "sent" || row.delivery.toast?.state === "shown";
export function timerDeliveredBy(row: VoiceTimer): string[] {
  const { voice, push, telegram, toast } = row.delivery;
  return [...(voice?.state === "spoken" ? ["voice"] : []), ...(push?.state === "sent" ? ["push"] : []), ...(toast?.state === "shown" ? ["toast"] : []), ...(telegram?.state === "sent" ? ["telegram"] : [])];
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
  /** Retires a timer's per-device push claims, once the timer itself retires. */
  forgetPush(id: string): Promise<void>;
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

/** Hands one sentence to a call: null when nothing happened and the next poll may ask again. */
export type SayTimer = (sentence: string, id: string, settled: (outcome: SpeechOutcome) => void) => HeldSpeech | null;

interface Owed {
  row: VoiceTimer; key: string; deadline: number; wording: FiredWording;
  /** The row says `saying`. */
  reserved?: boolean;
  /** The store refused that write: no poll tries it again before this. */
  retryAt?: number;
  /** The provider holds the words and has not voiced them. */
  held?: HeldSpeech & { sessionId: string };
}

export class VoiceTimers {
  /** Fired timers a live call still has to say, in firing order. Looked up on every poll, so it never touches the store. */
  private owed: Owed[] = [];
  /** A voice outcome the row does not say yet; never handed to another channel meanwhile. */
  private readonly unsaved = new Map<string, VoiceEntry>();
  /** Owners with a poll handing sentences over. */
  private readonly speaking = new Set<string>();
  private readonly sending = new Set<string>();
  /** What a channel answered that the row does not say yet. Its next try writes this and asks the channel nothing. */
  private readonly unsavedSends = new Map<string, { id: string; channel: "push" | "telegram"; entry: ChannelEntry<string> }>();
  /** A channel's write the store refused, and when it is next tried. */
  private readonly refused = new Map<string, { failures: number; at: number }>();
  private readonly work = new Set<Promise<unknown>>();
  private armed?: { cancel(): void };
  private running?: Promise<void>;
  private again = false;
  private stopped = false;
  /** Whole-store checks and inserts run one at a time, so the owner's cap holds. */
  private creating: Promise<unknown> = Promise.resolve();
  private retireAfter = HISTORY;
  private retireAt = 0;
  constructor(private readonly ports: VoiceTimerPorts) {}

  private file(): string { return this.ports.file?.() ?? voiceTimersFile(); }
  private async pages(after: string, inRange: (key: string) => boolean): Promise<VoiceTimer[]> {
    const rows: VoiceTimer[] = [];
    for (let cursor = after;;) {
      const page = await waitForStateLock("voice_timers.read", () => voiceTimerStore.readPage(this.file(), cursor, ROW_PAGE));
      for (const row of page) {
        if (!inRange(row.key)) return rows;
        if (validVoiceTimer(row.value)) rows.push(row.value);
        else console.error("[voice timers] unreadable row", row.key);
      }
      if (page.length < ROW_PAGE) return rows;
      cursor = page.at(-1)!.key;
    }
  }
  /** What can still need work. A wake, a tab's read, a set and a cancel read this, never the history. */
  private activeRows(): Promise<VoiceTimer[]> { return this.pages(ACTIVE_AFTER, () => true); }
  private historyRows(): Promise<VoiceTimer[]> { return this.pages(HISTORY, key => key.startsWith(HISTORY)); }
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
    // A call that held a timer too long gives it up here; a call that ended gave it up already.
    for (const entry of this.owed.filter(entry => entry.deadline <= this.ports.now())) this.giveUp(entry);
    await this.saveVoice();
    await this.saveSends();
    if (!this.ports.ownsTraffic()) { this.arm(TRAFFIC_RECHECK_MS); return; }
    const now = this.ports.now();
    const rows = (await this.activeRows()).sort(byDue);
    let next = RESCAN_MS;
    const sooner = (at: number) => { next = Math.min(next, at - now); };
    for (const held of rows) {
      const fired = held.state === "pending" && held.dueAt <= now ? await this.fire(held, now) ?? held : held;
      let row = fired.state === "fired" ? await this.afterCall(fired, now) : fired;
      if (row.state === "pending") sooner(row.dueAt);
      else if (row.state === "fired" && !this.voiceHeld(row.id) && row.delivery.voice?.state !== "spoken") {
        if (now - row.firedAt! < OWED_MS) this.channels(row, now, sooner);
        else if (!timerDelivered(row)) row = await this.patch(row.id, stored => stored.state === "fired" && !timerDelivered(stored) ? { ...stored, state: "missed", settledAt: now } : null) ?? row;
      }
      if (this.archivable(row, now)) await this.archive(row.id, now);
    }
    for (const entry of this.owed) sooner(entry.deadline);
    for (const { at } of this.refused.values()) if (at > now) sooner(at);
    await this.retirePage(now);
    this.arm(next);
  }
  private owedHere(id: string): boolean { return this.owed.some(entry => entry.row.id === id); }
  /** A live call or an unsaved outcome speaks for the voice's entry on this row. */
  private voiceHeld(id: string): boolean { return this.owedHere(id) || this.unsaved.has(id); }

  private async fire(row: VoiceTimer, now: number): Promise<VoiceTimer | null> {
    const fired = await this.patch(row.id, stored => {
      if (stored.state !== "pending" || stored.dueAt > now) return null;
      const live = this.ports.liveCall(stored.owner);
      return { ...stored, state: "fired", firedAt: now, delivery: live ? { voice: { state: "owed", at: now } } : {} };
    });
    // The call may have gone while that write waited; the wake then hands the timer on.
    if (fired?.delivery.voice && this.ports.liveCall(fired.owner)) this.owe(fired, now);
    return fired;
  }
  private owe(row: VoiceTimer, now: number): void {
    this.owed.push({ row, key: ownerKey(row.owner), deadline: now + VOICE_HOLD_MS, wording: firedWording(row, now) });
  }
  /** A row with a voice entry and no call holding it: its call ended, held it too long, or went with a restart.
   * `owed` was never voiced. `saying` may have been, and is never voiced again. */
  private async afterCall(row: VoiceTimer, now: number): Promise<VoiceTimer> {
    const state = row.delivery.voice?.state;
    if ((state !== "owed" && state !== "saying") || this.voiceHeld(row.id)) return row;
    return await this.patch(row.id, stored => {
      const voice = stored.delivery.voice;
      if (voice?.state !== "owed" && voice?.state !== "saying") return null;
      return { ...stored, delivery: { ...stored.delivery, voice: { ...voice, state: voice.state === "owed" ? "withdrawn" : "uncertain", at: now } } };
    }) ?? row;
  }

  /** Whether anything could still happen to this row. */
  private archivable(row: VoiceTimer, now: number): boolean {
    if (row.state === "cancelled" || row.state === "missed") return true;
    if (row.state !== "fired" || this.voiceHeld(row.id) || this.sending.has(`push:${row.id}`) || this.sending.has(`telegram:${row.id}`)) return false;
    const voice = row.delivery.voice?.state;
    const toast = row.delivery.toast;
    if (voice === "owed" || voice === "saying" || (toast?.state === "leased" && toast.leaseUntil! > now)) return false;
    if (voice === "spoken") return true;
    // Asked for the last time: `sending` here was cut off, and `failed` has no retry left.
    const closed = (entry: ChannelEntry<string> | undefined) => !!entry && ((entry.state !== "sending" && entry.state !== "failed") || entry.attempts > CHANNEL_RETRY_MS.length);
    return timerDelivered(row) && now - row.firedAt! >= TOAST_FRESH_MS && closed(row.delivery.push) && closed(row.delivery.telegram);
  }
  private async archive(id: string, now: number): Promise<void> {
    const moved = await waitForStateLock("voice_timers.archive", () => voiceTimerStore.patchRows(this.file(), 3, tx => {
      const held = tx.get(id)?.value;
      if (!validVoiceTimer(held) || !this.archivable(held, now)) return false;
      tx.delete(id);
      tx.put({ key: `${HISTORY}${id}`, value: { ...held, archivedAt: now } });
      return true;
    }));
    if (moved) { this.refused.delete(`push:${id}`); this.refused.delete(`telegram:${id}`); }
  }
  /** One page of the history per rescan, however often a wake runs and however long the history is. */
  private async retirePage(now: number): Promise<void> {
    if (now < this.retireAt && this.retireAt - now <= RESCAN_MS) return;
    this.retireAt = now + RESCAN_MS;
    const page = (await waitForStateLock("voice_timers.read", () => voiceTimerStore.readPage(this.file(), this.retireAfter, RETIRE_PAGE))).filter(row => row.key.startsWith(HISTORY));
    this.retireAfter = page.length === RETIRE_PAGE ? page.at(-1)!.key : HISTORY;
    for (const { key, value } of page) {
      const settled = validVoiceTimer(value) ? value.settledAt ?? value.firedAt : undefined;
      if (settled === undefined || now - settled < RETAIN_MS) continue;
      // Its push claims go first: a row kept by a failure here retires them on the cursor's next round, and a row gone first would orphan them.
      if ((value as VoiceTimer).delivery.push) {
        try { await this.ports.forgetPush((value as VoiceTimer).id); }
        catch (error) { console.error("[voice timers] push claims not retired", error instanceof Error ? error.name : "unknown"); continue; }
      }
      await waitForStateLock("voice_timers.retire", () => voiceTimerStore.patchRows(this.file(), 1, tx => { tx.delete(key); }));
    }
  }

  /** Push and Telegram for a timer no live call holds. Sends run beside the wake, so a slow one delays no other timer. */
  private channels(row: VoiceTimer, now: number, sooner: (at: number) => void): void {
    const owed = (entry: ChannelEntry<string> | undefined, channel: string) => {
      const key = `${channel}:${row.id}`;
      if (this.sending.has(key) || (this.refused.get(key)?.at ?? 0) > now) return false;
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
  /** Each refusal pushes this channel's next try further out, so a store that stays read-only costs a bounded number of writes. */
  private writeRefused(key: string, error: unknown): void {
    const failures = (this.refused.get(key)?.failures ?? 0) + 1;
    this.refused.set(key, { failures, at: this.ports.now() + WRITE_RETRY_MS[Math.min(failures, WRITE_RETRY_MS.length) - 1]! });
    console.error(`[voice timers] ${key} not recorded, ${failures} in a row`, error instanceof Error ? error.name : "unknown");
  }
  private async saveSend(key: string): Promise<void> {
    const held = this.unsavedSends.get(key);
    if (!held) return;
    try {
      await this.patch(held.id, stored => ({ ...stored, delivery: { ...stored.delivery, [held.channel]: held.entry } }) as VoiceTimer);
      this.unsavedSends.delete(key);
      this.refused.delete(key);
    } catch (error) { this.writeRefused(key, error); }
  }
  /** Answers the store refused, each at its own retry time. */
  private async saveSends(): Promise<void> {
    const now = this.ports.now();
    for (const key of [...this.unsavedSends.keys()]) if ((this.refused.get(key)?.at ?? 0) <= now) await this.saveSend(key);
  }
  private async send(row: VoiceTimer, channel: "push" | "telegram", deliver: () => Promise<string>): Promise<void> {
    const key = `${channel}:${row.id}`;
    this.sending.add(key);
    try {
      const now = this.ports.now();
      const earlier = row.delivery[channel]?.attempts;
      const attempts = (earlier ?? 0) + 1;
      let claimed: VoiceTimer | null;
      try {
        claimed = await this.patch(row.id, stored => stored.state === "fired" && !this.voiceHeld(row.id) && stored.delivery[channel]?.attempts === earlier
          ? { ...stored, delivery: { ...stored.delivery, [channel]: { state: "sending", at: now, attempts } } } : null);
        this.refused.delete(key);
      } catch (error) { this.writeRefused(key, error); return; }
      if (!claimed) return;
      let outcome: string;
      try { outcome = await deliver(); }
      catch (error) { console.error(`[voice timers] ${channel} failed`, error instanceof Error ? error.name : "unknown"); outcome = "failed"; }
      const at = this.ports.now();
      const retryAt = outcome === "failed" && attempts <= CHANNEL_RETRY_MS.length ? { retryAt: at + CHANNEL_RETRY_MS[attempts - 1]! } : {};
      this.unsavedSends.set(key, { id: row.id, channel, entry: { state: outcome, at, attempts, ...retryAt } });
      await this.saveSend(key);
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
  /** Says what this call owes, in firing order, one owner's poll at a time. The row says `saying` before any words leave,
   * so a restart can never voice a timer twice. A timer stays owed until the provider reports what became of its words. */
  speakOwed(owner: SessionStarter, sessionId: string, locale: Locale, say: SayTimer): void {
    const key = ownerKey(owner);
    if (this.speaking.has(key) || !this.nextToSay(key)) return;
    this.speaking.add(key);
    this.track(this.speakAll(key, sessionId, locale, say).finally(() => { this.speaking.delete(key); }));
  }
  private async speakAll(key: string, sessionId: string, locale: Locale, say: SayTimer): Promise<void> {
    for (let entry = this.nextToSay(key); entry; entry = this.nextToSay(key)) {
      if (!entry.reserved && !await this.reserve(entry, sessionId)) {
        // A write that failed left it owed for the next poll. Gone means another outcome took it.
        if (this.owed.includes(entry)) return;
        continue;
      }
      if (!this.owed.includes(entry)) continue;
      const taken = entry;
      const sentence = firedSentence({ ...taken.row, label: timerLabelIn(taken.row, sessionId) }, locale, taken.wording);
      const held = say(sentence, taken.row.id, outcome => this.speechSettled(taken, sessionId, outcome));
      if (!held) return;
      if (this.owed.includes(taken)) taken.held = { withdraw: () => held.withdraw(), sessionId };
    }
  }
  private nextToSay(key: string): Owed | undefined {
    const now = this.ports.now();
    return this.owed.find(entry => entry.key === key && !entry.held && (entry.retryAt ?? 0) <= now);
  }
  private async reserve(entry: Owed, sessionId: string): Promise<boolean> {
    const { id } = entry.row;
    try {
      // Only `owed` becomes `saying`, so however many entries reach here for one timer, one call voices it.
      const row = await this.patch(id, stored => stored.state === "fired" && stored.delivery.voice?.state === "owed"
        ? { ...stored, delivery: { ...stored.delivery, voice: { state: "saying", at: this.ports.now(), sessionId } } } : null);
      if (!row) { this.drop(entry); return false; }
      entry.reserved = true;
      // It was given up while that write waited, before any words left.
      if (!this.owed.includes(entry)) this.remember(id, { state: "withdrawn", at: this.ports.now() });
      return this.owed.includes(entry);
    } catch (error) {
      console.error("[voice timers] voice reservation failed", error instanceof Error ? error.message : String(error));
      entry.retryAt = this.ports.now() + WRITE_RETRY_MS[0];
      return false;
    }
  }
  private drop(entry: Owed): void { this.owed = this.owed.filter(other => other !== entry); }
  private remember(id: string, voice: VoiceEntry): void {
    this.unsaved.set(id, voice);
    this.track(this.saveVoice());
  }
  /** What became of words the provider took. A late answer about a timer given up as uncertain still corrects its row. */
  private speechSettled(entry: Owed, sessionId: string, outcome: SpeechOutcome): void {
    this.drop(entry);
    const at = this.ports.now();
    this.remember(entry.row.id, outcome === "handed" ? { state: "spoken", at, sessionId } : outcome === "uncertain" ? { state: "uncertain", at, sessionId } : { state: "withdrawn", at });
  }
  /** The next channel's turn. Words still queued at the provider are taken back; words already on their way stay uncertain. */
  private giveUp(entry: Owed): void {
    this.drop(entry);
    const at = this.ports.now();
    if (entry.held) this.unsaved.set(entry.row.id, entry.held.withdraw() ? { state: "withdrawn", at } : { state: "uncertain", at, sessionId: entry.held.sessionId });
    else if (entry.reserved) this.unsaved.set(entry.row.id, { state: "withdrawn", at });
  }
  private async saveVoice(): Promise<void> {
    for (const id of [...this.unsaved.keys()]) {
      try {
        // The newest outcome at the moment of the write: a later answer may have replaced the one this pass saw.
        let voice: VoiceEntry | undefined;
        await this.patch(id, stored => { voice = this.unsaved.get(id); return voice ? { ...stored, delivery: { ...stored.delivery, voice } } : null; });
        if (voice && this.unsaved.get(id) === voice) this.unsaved.delete(id);
        if (voice && voice.state !== "spoken") this.kick();
      } catch (error) { console.error("[voice timers] voice outcome not saved", error instanceof Error ? error.message : String(error)); }
    }
  }
  /** A new call says what fired while no channel reached the owner. */
  callStarted(owner: SessionStarter): void {
    this.track(this.owedToNewCall(owner).catch(error => { console.error("[voice timers] call start read failed", error instanceof Error ? error.message : String(error)); }));
  }
  private async owedToNewCall(owner: SessionStarter): Promise<void> {
    const key = ownerKey(owner);
    const now = this.ports.now();
    // Only a voice entry that says nothing was ever voiced gives the timer to this call.
    const free = (row: VoiceTimer) => row.state === "fired" && !timerDelivered(row) && row.delivery.voice?.state !== "saying" && row.delivery.voice?.state !== "uncertain";
    for (const row of (await this.activeRows()).sort(byDue)) {
      if (!free(row) || ownerKey(row.owner) !== key || now - row.firedAt! >= OWED_MS || this.voiceHeld(row.id) || !this.ports.liveCall(owner)) continue;
      // What this read saw may be stale by now: `saying` must never go back to `owed`.
      const held = await this.patch(row.id, stored => free(stored) ? { ...stored, delivery: { ...stored.delivery, voice: { state: "owed", at: now } } } : null);
      if (held && this.ports.liveCall(owner)) this.owed.push({ row: held, key, deadline: now + VOICE_HOLD_MS, wording: firedWording(held, now) });
    }
    this.kick();
  }
  /** A call ended. With no other call by this owner, what it still owed goes to the next channel; with one, only what
   * that call's provider was holding does. */
  callEnded(owner: SessionStarter, sessionId?: string): void {
    const key = ownerKey(owner);
    const alive = this.ports.liveCall(owner);
    const leaving = this.owed.filter(entry => entry.key === key && (!alive || entry.held?.sessionId === sessionId && sessionId !== undefined));
    if (!leaving.length) return;
    for (const entry of leaving) this.giveUp(entry);
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
    const mine = (await this.activeRows()).filter(row => row.state === "pending" && ownerKey(row.owner) === key).sort(byDue);
    const twin = input.attempt ? mine.find(row => row.attempt === input.attempt && row.delegationId !== input.delegationId
      && row.minutes === input.minutes && row.label === input.label) : undefined;
    if (twin) return { state: "duplicate", timer: twin, running: mine };
    // One provider call sets one timer, however often its call is replayed.
    const id = `vt_${createHash("sha256").update(`${input.sessionId}\n${input.callId}`).digest("hex").slice(0, 16)}`;
    const replayed = await waitForStateLock("voice_timers.read", () => voiceTimerStore.readRow(this.file(), id) ?? voiceTimerStore.readRow(this.file(), `${HISTORY}${id}`));
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
    const mine = [...await this.activeRows(), ...await this.historyRows()].filter(row => ownerKey(row.owner) === key).sort(byDue);
    return { running: mine.filter(row => row.state === "pending"), now,
      recent: mine.filter(row => (row.state === "fired" || row.state === "missed") && now - (row.settledAt ?? row.firedAt!) < RECENT_MS) };
  }
  /** The handle wins. Then a label: exact first, then one that contains the words or is contained by them.
   * Several matches cancel nothing. A private label from another call is matched by handle only. */
  async cancel(owner: SessionStarter, sessionId: string, query: string): Promise<CancelOutcome> {
    const key = ownerKey(owner);
    const now = this.ports.now();
    const running = (await this.activeRows()).filter(row => row.state === "pending" && ownerKey(row.owner) === key).sort(byDue);
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

  /** No toast during a call: a live call delivers by voice, and a timer it could not say comes back when it ends. */
  private toastAllowed(row: VoiceTimer, now: number): boolean {
    return row.state === "fired" && row.delivery.voice?.state !== "spoken" && !this.voiceHeld(row.id) && !this.ports.liveCall(row.owner)
      && now - row.firedAt! < OWED_MS && (now - row.firedAt! < TOAST_FRESH_MS || !timerDelivered(row));
  }
  /** Free to claim: nobody holds it, and no tab can have shown it. */
  private toastable(row: VoiceTimer, now: number): boolean {
    const toast = row.delivery.toast;
    return (!toast || (toast.state === "leased" && toast.leaseUntil! <= now)) && this.toastAllowed(row, now);
  }
  /** What a tab of this owner should do: toast these, and read again when the next timer is due or a lease runs out. */
  async forTab(owner: SessionStarter): Promise<{ claimable: string[]; nextInMs: number | null }> {
    const key = ownerKey(owner);
    const now = this.ports.now();
    const mine = (await this.activeRows()).filter(row => ownerKey(row.owner) === key).sort(byDue);
    const pending = mine.filter(row => row.state === "pending").map(row => row.dueAt);
    const leases = mine.flatMap(row => row.state === "fired" && row.delivery.toast?.state === "leased" && row.delivery.toast.leaseUntil! > now ? [row.delivery.toast.leaseUntil!] : []);
    const next = [...pending, ...leases];
    return { claimable: mine.filter(row => this.toastable(row, now)).map(row => row.id), nextInMs: next.length ? Math.max(0, Math.min(...next) - now) : null };
  }
  /** The first tab to ask holds the toast for a short lease, and `toastShowing` commits it to showing. A tab that went
   * away with a claim holds nothing past the lease. A tab whose own timeout ran before the server's fires the timer first. */
  async claimToast(owner: SessionStarter, id: string, locale: Locale): Promise<{ claimed: false } | { claimed: true; text: string; title: string; lease: number }> {
    const before = await waitForStateLock("voice_timers.read", () => voiceTimerStore.readRow(this.file(), id));
    if (!validVoiceTimer(before?.value) || ownerKey(before.value.owner) !== ownerKey(owner)) return { claimed: false };
    if (before.value.state === "pending" && before.value.dueAt <= this.ports.now() && this.ports.ownsTraffic()) {
      this.kick();
      await this.running;
    }
    const now = this.ports.now();
    const row = await this.patch(id, stored => this.toastable(stored, now)
      ? { ...stored, delivery: { ...stored.delivery, toast: { state: "leased", at: now, attempt: (stored.delivery.toast?.attempt ?? 0) + 1, leaseUntil: now + TOAST_LEASE_MS } } } : null);
    return row ? { claimed: true, title: firedTitle(locale), text: firedSentence(row, locale, firedWording(row, now)), lease: row.delivery.toast!.attempt } : { claimed: false };
  }
  /** A tab's toast entry, when this owner's tab still holds this attempt. */
  private toastEntry(stored: VoiceTimer, owner: string, lease: number) {
    const toast = stored.delivery.toast;
    return ownerKey(stored.owner) === owner && toast?.attempt === lease ? toast : null;
  }
  /** The tab is about to show its claim. From here the toast may be on screen, so no tab is offered it again, whatever
   * answer is lost. The same lease asked again answers the same, for the tab whose answer was lost before it showed. */
  async toastShowing(owner: SessionStarter, id: string, lease: number): Promise<{ showing: boolean }> {
    const key = ownerKey(owner);
    const now = this.ports.now();
    const row = await this.patch(id, stored => {
      const toast = this.toastEntry(stored, key, lease);
      if (!toast || toast.state === "shown" || !this.toastAllowed(stored, now)) return null;
      return toast.state === "showing" ? stored : { ...stored, delivery: { ...stored.delivery, toast: { state: "showing", at: now, attempt: lease } } };
    });
    return { showing: !!row };
  }
  /** The tab showed it. A receipt told twice, by a reload or another tab, answers the same. */
  async toastShown(owner: SessionStarter, id: string, lease: number): Promise<{ shown: boolean }> {
    const key = ownerKey(owner);
    const now = this.ports.now();
    const row = await this.patch(id, stored => {
      const toast = this.toastEntry(stored, key, lease);
      if (toast?.state === "shown") return stored;
      return toast?.state === "showing" ? { ...stored, delivery: { ...stored.delivery, toast: { state: "shown", at: now, attempt: lease } } } : null;
    });
    if (row) this.kick();
    return { shown: !!row };
  }
  /** The tab committed and then showed nothing: it was hidden or had no host. The toast is free again at once. */
  async toastReleased(owner: SessionStarter, id: string, lease: number): Promise<{ released: boolean }> {
    const key = ownerKey(owner);
    const now = this.ports.now();
    const row = await this.patch(id, stored => this.toastEntry(stored, key, lease)?.state === "showing"
      ? { ...stored, delivery: { ...stored.delivery, toast: { state: "leased", at: now, attempt: lease, leaseUntil: now } } } : null);
    return { released: !!row };
  }
}
