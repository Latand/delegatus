import { raisesTier, type TurboTier } from "@/lib/accounts/codexServiceTiers";
import {
  TURBO_NOTICE_ATTEMPTS, endedTurbo, turboAccountVerdict, turboActive, turboEpisodeKey, turboNotice, upsertTurboSwitches,
  type TurboAccountReading, type TurboNotice, type TurboSetting, type TurboSwitch,
} from "./turbo";

/** Whether a notice still owes a delivery attempt. */
const owed = (notice: TurboNotice | undefined) => !notice?.deliveredAt && (notice?.attempts ?? 0) < TURBO_NOTICE_ATTEMPTS;

/**
 * Turbo's switch queue (docs/design/turbo-mode.md §2.7): one durable work
 * list per episode (the `switches` rows on the setting), drained off the
 * request path with at most {@link TURBO_MAX_IN_FLIGHT} switches in flight on
 * this machine, at least {@link TURBO_START_SPACING_MS} between starts and
 * {@link TURBO_ITEM_DEADLINE_MS} per item. Every step is awaited; nothing here
 * waits synchronously. A restart picks up `queued` and `applying` rows again,
 * and a row is never raised once its episode has ended.
 */

export const TURBO_MAX_IN_FLIGHT = 3;
export const TURBO_START_SPACING_MS = 2_000;
export const TURBO_ITEM_DEADLINE_MS = 120_000;
/** Items started per pass; the rest wait for the next pass. */
export const TURBO_ITEMS_PER_PASS = 24;

/** One live Codex conversation of the project, read once per episode change. */
export interface TurboCandidate {
  conversationId: string;
  accountId: string | null;
  model: string | null;
  /** The tier its launch profile records now. */
  tier: string | null;
  /** The project's seat: its tier changes, its turn is never cut. */
  seat?: boolean;
  /** The running attempt of a pipeline stage. */
  stage?: { pipelineId: string; stageId: string; attempt: number; definitionTier: string | null; switchOpen: boolean };
  /** A legacy tmux launch, whose tier is a launch flag. */
  legacy?: boolean;
  /** A turn is running; idle conversations go first. */
  busy?: boolean;
}

export type TurboStageResult = { state: "committed" | "armed" | "pending"; appliedTier?: string | null } | { state: "failed"; reason: string };

export interface TurboSweepPorts {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The project's current episode and its history, as stored. */
  read(project: string): { turbo?: TurboSetting | null; turboHistory?: TurboSetting[] };
  /** Merge a step into one episode under the store lock; null when it is gone. */
  update(project: string, startedAt: string, update: (episode: TurboSetting) => TurboSetting): TurboSetting | null | Promise<TurboSetting | null>;
  candidates(project: string): Promise<TurboCandidate[]>;
  /** Whether the conversation is still live, and its tier now. */
  liveTier(conversationId: string, expected?: Pick<TurboSwitch, "accountId" | "model">): Promise<{ live: boolean; hosted?: boolean; tier: string | null }>;
  reading(accountId: string): TurboAccountReading;
  authorize?(project: string, episode: string, conversationId: string): void;
  /** Live tier change of a non-stage conversation. */
  setTier(conversationId: string, operationId: string, tier: string | null, cut: "boundary" | "none", authorize?: () => void, expected?: Pick<TurboSwitch, "accountId" | "model">, beforeCut?: (turnId: string) => Promise<void>): Promise<{ cut: "cut" | "armed" | "none"; appliedTier?: string | null }>;
  /** Where an armed cut stands. */
  cutState(operationId: string, conversationId?: string, turnId?: string): string | Promise<string>;
  cancelCut(conversationId: string, operationId: string): Promise<void>;
  /** One system continuation after a cut, under a stable key. */
  continueConversation(conversationId: string, key: string): Promise<void>;
  /** override-stage applyNow on the running attempt (in-place). */
  stageTier(stage: NonNullable<TurboCandidate["stage"]> & { conversationId: string }, tier: string | null, cut: "boundary" | "none", episode: string): Promise<{ ok: true; settled?: true } | { ok: false; reason: string }>;
  /** Where that stage switch stands. */
  stageState(stage: NonNullable<TurboSwitch["stage"]>, conversationId: string, tier?: string | null): Promise<TurboStageResult>;
  /** Put the stage definition's tier back when it still holds Turbo's. */
  restoreStageDefinition(stage: NonNullable<TurboSwitch["stage"]>, from: string | null, expected: string | null, episode: string): Promise<void>;
  notify(project: string, key: string, text: string): Promise<{ delivered: boolean; error?: string }>;
}

/** Machine-wide bound: every project's sweep shares these slots. */
class Slots {
  private used = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private readonly waiters: Array<() => void> = [];
  async acquire(ports: Pick<TurboSweepPorts, "now" | "sleep">): Promise<void> {
    while (this.used >= TURBO_MAX_IN_FLIGHT) await new Promise<void>(resolve => this.waiters.push(resolve));
    this.used += 1;
    for (;;) {
      const wait = this.lastStart + TURBO_START_SPACING_MS - ports.now();
      if (wait <= 0) break;
      await ports.sleep(wait);
    }
    this.lastStart = ports.now();
  }
  release(): void {
    this.used -= 1;
    this.waiters.shift()?.();
  }
  inFlight(): number { return this.used; }
}

const TIMED_OUT: unique symbol = Symbol("timed-out");

export class TurboSweep {
  private readonly slots = new Slots();
  private readonly running = new Map<string, Promise<void>>();
  private readonly rerun = new Set<string>();
  /** Armed cuts whose continuation this process still owes. */
  private readonly watched = new Set<string>();

  constructor(private readonly ports: TurboSweepPorts) {}

  inFlight(): number { return this.slots.inFlight(); }

  /** One serialized pass per project; a kick during a pass runs one more after it. */
  kick(project: string): Promise<void> {
    const current = this.running.get(project);
    if (current) { this.rerun.add(project); return current; }
    const run = (async () => {
      try {
        do { this.rerun.delete(project); await this.pass(project); } while (this.rerun.has(project));
      } finally { this.running.delete(project); }
    })();
    this.running.set(project, run);
    return run;
  }

  /** Whether the project still has Turbo work: an active episode or an ended one not yet reverted. */
  pending(project: string): boolean {
    const { turbo, turboHistory } = this.ports.read(project);
    return [...(turboHistory ?? []), ...(turbo ? [turbo] : [])].some(episode => turboActive(episode, this.ports.now()) || !episode.revertedAt);
  }

  private episodes(project: string): TurboSetting[] {
    const { turbo, turboHistory } = this.ports.read(project);
    return [...(turboHistory ?? []), ...(turbo ? [turbo] : [])];
  }

  private async pass(project: string): Promise<void> {
    for (const episode of this.episodes(project)) {
      if (turboActive(episode, this.ports.now())) {
        /* An older run still owns these tiers until its return lands. */
        const returning = this.episodes(project).some(other => other.startedAt !== episode.startedAt
          && other.switches.some(row => ["applying", "switched", "armed", "reverting"].includes(row.state) || row.state === "failed" && row.startedAt));
        if (!returning) await this.accelerate(project, episode);
      }
      else if (!episode.revertedAt) await this.revert(project, episode);
    }
  }

  private async write(project: string, episode: TurboSetting, rows: TurboSwitch[], extra: Partial<TurboSetting> = {}): Promise<TurboSetting | null> {
    return this.update(project, episode.startedAt, current => ({ ...current, ...extra, switches: upsertTurboSwitches(current.switches, rows) }));
  }

  private update(project: string, startedAt: string, update: (episode: TurboSetting) => TurboSetting) {
    return this.ports.update(project, startedAt, current => update(endedTurbo(current, this.ports.now())!));
  }

  private at(): string { return new Date(this.ports.now()).toISOString(); }

  private async accelerate(project: string, episode: TurboSetting): Promise<void> {
    const key = turboEpisodeKey(episode);
    if (!episode.switches.length && !episode.noticeOn) {
      /* read: the candidates once per episode, before anything is switched. */
      /* Idle conversations first: one call each and nothing to cut. */
      const candidates = [...await this.ports.candidates(project)].sort((left, right) => Number(!!left.busy) - Number(!!right.busy));
      const rows = candidates.map(candidate => this.plan(episode, candidate));
      const saved = await this.write(project, episode, rows);
      if (!saved) return;
      episode = saved;
    }
    if (owed(episode.noticeOn)) {
      const notice = turboNotice(episode, "on", { conversations: episode.switches.filter(row => row.state === "queued").length });
      const sent = await this.ports.notify(project, notice.key, notice.text).catch((error: unknown) => ({ delivered: false, error: String(error) }));
      episode = await this.update(project, episode.startedAt, current => ({ ...current, noticeOn: { key: notice.key, attempts: (current.noticeOn?.attempts ?? 0) + 1,
        ...(sent.delivered ? { deliveredAt: this.at() } : { error: sent.error ?? "not delivered" }) } })) ?? episode;
    }
    /* Reconcile a pre-restart dispatch before deciding whether the credit margin requires a return. */
    const resumed: TurboSwitch[] = [];
    for (const row of episode.switches.filter(row => row.state === "applying")) {
      const live = await this.ports.liveTier(row.conversationId, row);
      const applied = row.appliedTier === undefined ? row.to : row.appliedTier;
      if (row.cutTurnId && !row.stage) {
        if (live.live && live.tier !== applied) {
          await this.ports.setTier(row.conversationId, `${key}:${row.conversationId}:recover`, applied, "none",
            () => this.ports.authorize?.(project, key, row.conversationId), row);
        }
        resumed.push({ ...row, state: "armed" });
      } else resumed.push({ ...row, state: live.live && live.tier === applied ? "switched" : "queued" });
    }
    if (resumed.length) episode = await this.write(project, episode, resumed) ?? episode;
    /* The credit rule: a credit-holding account without approval stops at 90 %. */
    const accounts = [...new Set(episode.switches.filter(row => ["queued", "applying", "armed", "switched", "reverting"].includes(row.state) || row.state === "failed" && row.startedAt).map(row => row.accountId))];
    for (const accountId of accounts) {
      const verdict = turboAccountVerdict(episode, accountId, this.ports.reading(accountId), this.ports.now());
      if (verdict.verdict !== "hold" && !episode.switches.some(row => row.accountId === accountId && row.state === "reverting")) continue;
      const reason = verdict.reason ?? "credit margin reached";
      episode = await this.update(project, episode.startedAt, current => ({ ...current, held: { ...current.held, [accountId]: this.at() },
        switches: current.switches.map(row => row.accountId === accountId && row.state === "queued" ? { ...row, state: "skipped" as const, reason, at: this.at() } : row) })) ?? episode;
      await this.revertRows(project, episode, episode.switches.filter(row => row.accountId === accountId && (row.state === "switched" || row.state === "armed" || row.state === "reverting" || row.state === "failed" && row.startedAt)), reason);
      episode = this.episodes(project).find(item => item.startedAt === episode.startedAt) ?? episode;
    }
    const queued = episode.switches.filter(row => row.state === "queued");
    const work: Promise<void>[] = [];
    const errors: unknown[] = [];
    try {
      for (const row of queued.slice(0, TURBO_ITEMS_PER_PASS)) {
        await this.slots.acquire(this.ports);
        let dispatched = false;
        try {
          const current = this.episodes(project).find(item => item.startedAt === episode.startedAt);
          /* Never raise once the episode ended, even after a restart. */
          if (!current || !turboActive(current, this.ports.now())) break;
          const live = current.switches.find(item => item.conversationId === row.conversationId);
          if (live?.state !== "queued") continue;
          const verdict = turboAccountVerdict(current, row.accountId, this.ports.reading(row.accountId), this.ports.now());
          if (verdict.verdict === "hold") {
            await this.write(project, current, [{ ...live, state: "skipped", reason: verdict.reason, at: this.at() }]);
            this.rerun.add(project);
            continue;
          }
          const item = this.applyOne(project, current, live, key).finally(() => this.slots.release());
          dispatched = true;
          work.push(item.catch(error => { errors.push(error); }));
        } finally { if (!dispatched) this.slots.release(); }
      }
    } finally { await Promise.all(work); }
    if (errors.length) throw errors[0];
    if (this.episodes(project).find(item => item.startedAt === episode.startedAt)?.switches.some(row => row.state === "armed")) this.watchArmed(project, episode.startedAt);
  }

  private plan(episode: TurboSetting, candidate: TurboCandidate): TurboSwitch {
    const at = this.at();
    const account = episode.plan.find(item => item.accountId === candidate.accountId);
    const to: TurboTier | undefined = candidate.model ? account?.tiers[candidate.model] : undefined;
    const base = { conversationId: candidate.conversationId, accountId: candidate.accountId ?? "", model: candidate.model ?? "", from: candidate.tier, to: to ?? "priority" as TurboTier, at,
      ...(candidate.stage ? { stage: { pipelineId: candidate.stage.pipelineId, stageId: candidate.stage.stageId, attempt: candidate.stage.attempt, definitionFrom: candidate.stage.definitionTier } } : {}) };
    const skip = (reason: string): TurboSwitch => ({ ...base, state: "skipped", reason });
    if (candidate.legacy) return skip("legacy terminal launch: its speed is a launch flag");
    if (!account) return skip("its account is not an allowed Codex account");
    if (!to) return skip("its account offers no faster tier for this model");
    if (candidate.stage?.switchOpen) return skip("another runtime switch is open on this stage");
    if (!raisesTier(candidate.tier, to)) return skip("already at this speed or faster");
    const verdict = turboAccountVerdict(episode, account.accountId, this.ports.reading(account.accountId), this.ports.now());
    if (verdict.verdict === "hold") return skip(verdict.reason ?? "credit margin reached");
    return { ...base, state: "queued", ...(candidate.seat ? { reason: "seat: speed only, its turn is never cut" } : {}) };
  }

  private async withDeadline<T>(operation: Promise<T> | ((active: () => boolean) => Promise<T>), remaining = TURBO_ITEM_DEADLINE_MS): Promise<T | typeof TIMED_OUT> {
    let active = true;
    const work = typeof operation === "function" ? operation(() => active) : operation;
    try { return await Promise.race<T | typeof TIMED_OUT>([work, this.ports.sleep(Math.max(0, remaining)).then((): typeof TIMED_OUT => TIMED_OUT)]); }
    finally { active = false; }
  }

  private async applyOne(project: string, episode: TurboSetting, row: TurboSwitch, key: string): Promise<void> {
    const startedAt = row.startedAt ?? this.at();
    const deadline = Date.parse(startedAt) + TURBO_ITEM_DEADLINE_MS;
    const started = { ...row, state: "applying" as const, startedAt, at: this.at() };
    if (!await this.write(project, episode, [started])) return;
    const operationId = `${key}:${row.conversationId}`;
    const seat = row.reason?.startsWith("seat:");
    let armed = false;
    const authorize = () => {
      this.ports.authorize?.(project, key, row.conversationId);
      if (!armed && this.ports.now() >= deadline) throw new Error("timed out");
      const current = this.episodes(project).find(item => item.startedAt === episode.startedAt);
      if (!current || !turboActive(current, this.ports.now())
        || turboAccountVerdict(current, row.accountId, this.ports.reading(row.accountId), this.ports.now()).verdict === "hold") {
        throw new Error("Turbo authority or included usage ended before dispatch");
      }
    };
    const settle = async (state: TurboSwitch["state"], reason?: string) => this.update(project, episode.startedAt, current => ({ ...current,
      switches: current.switches.map(item => item.conversationId === row.conversationId && item.state === "applying"
        ? { ...item, state, at: this.at(), ...(reason ? { reason } : item.reason && !seat ? { reason: undefined } : {}) } : item) }));
    try {
      authorize();
      if (row.stage) {
        const outcome = await this.withDeadline(async active => {
          const requested = await this.ports.stageTier({ ...row.stage!, definitionTier: row.stage!.definitionFrom ?? null, switchOpen: false, conversationId: row.conversationId }, row.to, "boundary", key);
          if (!requested.ok) return { state: "failed" as const, reason: requested.reason };
          if (requested.settled) return { state: "committed" as const, appliedTier: row.to };
          for (;;) {
            if (!active()) throw new Error("stage tier observation deadline ended");
            const state = await this.ports.stageState(row.stage!, row.conversationId, row.to);
            if (state.state !== "pending") return state;
            await this.ports.sleep(1_000);
          }
        }, deadline - this.ports.now());
        if (outcome === TIMED_OUT) { await settle("failed", "timed out"); return; }
        if (outcome.state === "failed") await settle("failed", outcome.reason);
        else {
          if (outcome.appliedTier !== undefined) await this.update(project, episode.startedAt, current => ({ ...current, switches: current.switches.map(item => item.conversationId === row.conversationId ? { ...item, appliedTier: outcome.appliedTier } : item) }));
          await settle(outcome.state === "armed" ? "armed" : "switched");
        }
        return;
      }
      const outcome = await this.withDeadline(this.ports.setTier(row.conversationId, operationId, row.to, seat ? "none" : "boundary", authorize, row, async turnId => {
        const saved = await this.update(project, episode.startedAt, current => ({ ...current, switches: current.switches.map(item => item.conversationId === row.conversationId ? { ...item, cutTurnId: turnId } : item) }));
        if (!saved) throw new Error("the Turbo episode disappeared before the cut");
        row = { ...row, cutTurnId: turnId };
      }), deadline - this.ports.now());
      if (outcome === TIMED_OUT) { await settle("failed", "timed out"); return; }
      armed = outcome.cut === "armed";
      if (outcome.appliedTier !== undefined) {
        row = { ...row, appliedTier: outcome.appliedTier };
        await this.update(project, episode.startedAt, current => ({ ...current, switches: current.switches.map(item => item.conversationId === row.conversationId
          ? { ...item, appliedTier: outcome.appliedTier } : item) }));
      }
      if (outcome.cut === "cut") await this.ports.continueConversation(row.conversationId, `${operationId}:continue`);
      await settle(outcome.cut === "armed" ? "armed" : "switched");
      try { authorize(); }
      catch { await this.revertRows(project, episode, [{ ...row, state: outcome.cut === "armed" ? "armed" : "switched" }], "Turbo ended while switching"); }
    } catch (error) {
      await settle("failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** settle: an armed conversation is continued once its cut happens, or marked switched when its turn ended first. */
  private watchArmed(project: string, startedAt: string): void {
    const tick = async () => {
      const episode = this.episodes(project).find(item => item.startedAt === startedAt);
      if (!episode) return;
      const key = turboEpisodeKey(episode);
      let waiting = false;
      for (const row of episode.switches.filter(item => item.state === "armed" && !item.stage)) {
        const operationId = `${key}:${row.conversationId}`;
        const state = await this.ports.cutState(operationId, row.conversationId, row.cutTurnId);
        if (state === "armed" || state === "unknown" && row.cutTurnId) { waiting = true; continue; }
        if (state === "cut") {
          try { await this.ports.continueConversation(row.conversationId, `${operationId}:continue`); }
          catch (error) {
            await this.update(project, startedAt, current => ({ ...current, switches: current.switches.map(item => item.conversationId === row.conversationId && item.state === "armed"
              ? { ...item, reason: `continuation pending: ${error instanceof Error ? error.message : String(error)}` } : item) }));
            waiting = true; continue;
          }
        }
        await this.update(project, startedAt, current => ({ ...current, switches: current.switches.map(item => item.conversationId === row.conversationId && item.state === "armed"
          ? { ...item, state: "switched" as const, ...(state === "cut" ? { cutSettled: true } : {}), at: this.at(), ...(state === "cut" || state === "turn-ended" ? {} : { reason: `cut ${state}; the next turn runs at the new speed` }) } : item) }));
      }
      for (const row of episode.switches.filter(item => item.state === "armed" && item.stage)) {
        const state = await this.ports.stageState(row.stage!, row.conversationId, row.to).catch(() => ({ state: "pending" as const }));
        if (state.state === "armed" || state.state === "pending") { waiting = true; continue; }
        await this.update(project, startedAt, current => ({ ...current, switches: current.switches.map(item => item.conversationId === row.conversationId && item.state === "armed"
          ? { ...item, state: state.state === "failed" ? "failed" as const : "switched" as const, at: this.at(), ...(state.state === "failed" ? { reason: state.reason } : {}) } : item) }));
      }
      if (waiting) await this.ports.sleep(5_000).then(tick);
    };
    const id = `${project}:${startedAt}`;
    if (this.watched.has(id)) return;
    this.watched.add(id);
    void tick().catch(error => { console.error(`[turbo] armed switch reconciliation failed for ${project}: ${error instanceof Error ? error.name : "unknown"}`); }).finally(() => this.watched.delete(id));
  }

  private async revert(project: string, episode: TurboSetting): Promise<void> {
    if (owed(episode.noticeOff) && episode.noticeOn?.deliveredAt) {
      const notice = turboNotice(episode, "off", { conversations: episode.switches.filter(row => row.state === "switched" || row.state === "armed").length });
      const sent = await this.ports.notify(project, notice.key, notice.text).catch((error: unknown) => ({ delivered: false, error: String(error) }));
      episode = await this.update(project, episode.startedAt, current => ({ ...current, noticeOff: { key: notice.key, attempts: (current.noticeOff?.attempts ?? 0) + 1,
        ...(sent.delivered ? { deliveredAt: this.at() } : { error: sent.error ?? "not delivered" }) } })) ?? episode;
    }
    /* An applying call may have landed before its acknowledgement was lost.
       Keep its original tier until the host has proved whether it needs a return. */
    for (const row of episode.switches.filter(row => row.state === "applying" || row.state === "failed" && row.startedAt)) {
      const live = await this.ports.liveTier(row.conversationId, row);
      const applied = row.appliedTier === undefined ? row.to : row.appliedTier;
      const uncertain = live.live && live.tier === row.from;
      const restore = live.live && (live.tier === applied || uncertain);
      episode = await this.write(project, episode, [{ ...row, state: restore ? "switched" : "skipped", ...(uncertain ? { uncertain: true } : {}),
        reason: restore ? "reconciled unacknowledged switch" : "Turbo ended before this conversation was switched", at: this.at() }]) ?? episode;
    }
    const stopped = episode.switches.filter(row => row.state === "queued");
    if (stopped.length) episode = await this.write(project, episode, stopped.map(row => ({ ...row, state: "skipped", reason: "Turbo ended before this conversation was switched", at: this.at() }))) ?? episode;
    await this.revertRows(project, episode, episode.switches.filter(row => row.state === "switched" || row.state === "armed" || row.state === "reverting"), `Turbo ended (${episode.endReason ?? "turned-off"})`);
    const after = this.episodes(project).find(item => item.startedAt === episode.startedAt);
    if (after && !after.switches.some(row => ["switched", "armed", "reverting", "queued", "applying"].includes(row.state))
      && !(owed(after.noticeOff) && after.noticeOn?.deliveredAt)) {
      await this.update(project, episode.startedAt, current => ({ ...current, revertedAt: this.at() }));
    }
  }

  /** Each conversation returns to its own previous tier from its next turn; nothing is cut. */
  private async revertRows(project: string, episode: TurboSetting, rows: TurboSwitch[], reason: string): Promise<void> {
    const key = turboEpisodeKey(episode);
    for (let row of rows.slice(0, TURBO_ITEMS_PER_PASS)) {
      await this.slots.acquire(this.ports);
      try {
        const cutSettled = row.cutSettled === true || row.state === "switched";
        row = { ...row, ...(cutSettled ? { cutSettled: true } : {}) };
        await this.write(project, episode, [{ ...row, state: "reverting", at: this.at() }]);
        const operationId = `${key}:${row.conversationId}`;
        let note = reason;
        if (row.state === "armed" && !row.stage) await this.ports.cancelCut(row.conversationId, operationId);
        const live = await this.ports.liveTier(row.conversationId, row);
        if (!row.stage && row.cutTurnId && !cutSettled && live.live && live.hosted !== false) {
          const cut = await this.ports.cutState(operationId, row.conversationId, row.cutTurnId);
          if (cut === "armed" || cut === "unknown") {
            throw new Error("the boundary interrupt is still settling");
          }
        }
        const applied = row.appliedTier === undefined ? row.to : row.appliedTier;
        if (row.stage) {
          if (live.hosted === false && live.live && (live.tier === applied || row.uncertain && live.tier === row.from)) {
            const returned = await this.withDeadline(this.ports.setTier(row.conversationId, `${operationId}:revert`, row.from, "none", undefined, row));
            if (returned === TIMED_OUT) throw new Error("the offline profile return timed out");
            await this.ports.restoreStageDefinition(row.stage, row.stage.definitionFrom ?? null, row.to, key);
          } else {
            if (row.uncertain && live.live && live.tier === row.from) {
              const confirmed = await this.withDeadline(this.ports.setTier(row.conversationId, `${operationId}:reconcile`, row.from, "none", undefined, row));
              if (confirmed === TIMED_OUT) throw new Error("the uncertain switch back timed out");
            }
            const outcome = live.live && (live.tier === applied || row.uncertain && live.tier === row.from)
              ? await this.withDeadline(this.ports.stageTier({ ...row.stage, definitionTier: row.to, switchOpen: false, conversationId: row.conversationId }, row.from, "none", key))
              : null;
            if (outcome === TIMED_OUT) throw new Error("the stage switch back timed out");
            else if (outcome && !outcome.ok) throw new Error(outcome.reason);
            else if (outcome) {
              if (!outcome.settled) {
                const settled = await this.withDeadline(async active => {
                  for (;;) {
                    if (!active()) throw new Error("stage tier observation deadline ended");
                    const state = await this.ports.stageState(row.stage!, row.conversationId, row.from);
                    if (state.state === "failed") throw new Error(state.reason);
                    if (state.state === "committed") return true;
                    await this.ports.sleep(1_000);
                  }
                });
                if (settled === TIMED_OUT) throw new Error("the stage switch back is still pending");
              }
              await this.ports.restoreStageDefinition(row.stage, row.stage.definitionFrom ?? null, row.from, key);
            } else await this.ports.restoreStageDefinition(row.stage, row.stage.definitionFrom ?? null, row.to, key);
          }
        } else if (live.live && (live.tier === applied || row.uncertain && live.tier === row.from)) {
          const outcome = await this.withDeadline(this.ports.setTier(row.conversationId, `${operationId}:revert`, row.from, "none", undefined, row));
          if (outcome === TIMED_OUT) throw new Error("the switch back timed out");
        } else note = live.live ? `${reason}; its speed was changed since, so it is kept` : `${reason}; the conversation is no longer live`;
        if (!row.stage && row.cutTurnId && await this.ports.cutState(operationId, row.conversationId, row.cutTurnId) === "cut") {
          await this.ports.continueConversation(row.conversationId, `${operationId}:continue`);
        }
        await this.write(project, episode, [{ ...row, state: "reverted", reason: note, at: this.at() }]);
      } catch (error) {
        await this.write(project, episode, [{ ...row, state: "reverting", reason: `${reason}; switch back failed: ${error instanceof Error ? error.message : String(error)}`, at: this.at() }]);
      } finally { this.slots.release(); }
    }
  }
}
