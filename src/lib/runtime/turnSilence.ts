import crypto from "node:crypto";
import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { verifiedBackgroundWork } from "@/lib/pipelines/backgroundTasks";
import { writeJsonDurably } from "@/lib/state/durableJson";
import type { HostState, RuntimeEvent } from "./engineHost";

export const TURN_SILENCE_MS = 15 * 60_000;
export const TURN_SILENCE_REASON = "turn-silence-timeout";
function checkpointPath(engine: string, session: string): string {
  return statePath("turn-silence", crypto.createHash("sha256").update(`${engine}:${session}`).digest("hex") + ".json");
}
export function turnSilenceProgress(engine: string, session: string, turn: string): number | undefined {
  try {
    const row = JSON.parse(fs.readFileSync(checkpointPath(engine, session), "utf8"));
    const activityAt = row.activityAt === undefined ? row.progressAt : row.activityAt;
    return row.version === 1 && row.turn === turn && Number.isFinite(activityAt) ? activityAt : undefined;
  } catch { return undefined; }
}

export interface TurnSilenceOptions {
  now?: () => number;
  schedule?: (callback: () => Promise<void>, delay: number) => () => void;
}
type Event = RuntimeEvent extends infer E ? E extends RuntimeEvent ? Omit<E, "seq"> : never : never;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/** One asynchronous deadline per owned turn. Transport echoes and heartbeat
 * frames never refresh it. Engine-owned foreground calls remain protected until
 * their actual result; a missing result is a wait diagnosis, never completion. */
export class TurnSilence {
  private turn: string | null = null;
  private progressAt = 0;
  private checkpointProgressAt = 0;
  private activityAt = 0;
  private revision = 0;
  private persistedAt: number | null = null;
  private checkpoint: string | null = null;
  private cancel: (() => void) | null = null;
  private backgroundRead: Promise<"absent" | "pending" | "unknown"> | null = null;
  private readonly tools = new Set<string>();
  private readonly background = new Set<string>();
  private overflow = false;
  private holding: string | null = null;
  private readonly now: () => number;
  private readonly schedule: NonNullable<TurnSilenceOptions["schedule"]>;
  constructor(private readonly ports: {
    engine: string;
    artifactPath: () => string | null;
    state: () => HostState;
    current: () => boolean;
    expire: (turn: string) => void;
    hold: (turn: string, reason: string) => void;
  }, options: TurnSilenceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback, delay) => {
      const timer = setTimeout(() => { void callback(); }, delay);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  }
  observe(event: Event, restored = false): void {
    if (!this.current()) { this.stop(); return; }
    if (event.kind === "turn-started") {
      if (this.turn === event.turnId) return;
      this.stop(); this.turn = event.turnId; this.progressAt = this.checkpointProgressAt = this.activityAt = this.now();
      this.checkpoint = checkpointPath(this.ports.engine, this.ports.state().sessionKey);
      try {
        const saved = JSON.parse(fs.readFileSync(this.checkpoint, "utf8"));
        if (saved.version !== 1 || typeof saved.turn !== "string" || !Number.isFinite(saved.progressAt)
          || saved.activityAt !== undefined && !Number.isFinite(saved.activityAt)
          || saved.waiting !== undefined && typeof saved.waiting !== "boolean"
          || !Array.isArray(saved.tools) || !Array.isArray(saved.background)
          || [...saved.tools, ...saved.background].some(id => typeof id !== "string") || saved.tools.length + saved.background.length > 1024) throw new Error("invalid checkpoint");
        if (saved.turn === this.turn) {
          // Checkpoints are coalesced for 30 seconds. Retain that fixed
          // allowance across repeated adoption without moving the checkpoint.
          this.checkpointProgressAt = saved.progressAt;
          this.activityAt = saved.activityAt === undefined ? saved.progressAt : saved.activityAt;
          this.progressAt = Math.min(this.progressAt, saved.progressAt + 30_000);
          this.persistedAt = saved.progressAt;
          this.holding = saved.waiting === true ? "restored wait awaiting ownership verification" : null;
          for (const id of saved.tools) this.tools.add(id);
          for (const id of saved.background) this.background.add(id);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") { this.overflow = true; this.ports.hold(this.turn, "silence checkpoint unavailable; ownership retained"); }
      }
      this.persist(); this.arm(this.holding !== null ? 0 : Math.max(0, TURN_SILENCE_MS - (this.now() - this.progressAt))); return;
    }
    if (event.kind === "turn-ended" && event.turnId === this.turn
      || event.kind === "session-status" && ["dead", "unhosted"].includes(event.status)) { this.stop(); return; }
    if (this.turn && event.kind === "attention-resolved") {
      this.progressAt = this.checkpointProgressAt = this.now(); this.holding = null; this.revision++; this.persist(true); this.arm(); return;
    }
    if (!this.turn || event.kind !== "item" && event.kind !== "delta" || event.turnId !== this.turn) return;
    const beforeWait = this.tools.size + ":" + this.background.size;
    const wasHolding = this.holding !== null;
    let progress = event.kind === "delta" && !!event.text.trim();
    if (event.kind === "item") {
      const item = object(event.item);
      const message = object(item.message);
      const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
      // Claude provider failures have assistant-shaped envelopes too.
      if (item.type === "assistant" && item.error == null && !item.isApiErrorMessage) {
        progress ||= blocks.some(block => ["text", "thinking", "tool_use"].includes(String(block.type)));
        for (const block of blocks) if (block.type === "tool_use" && typeof block.id === "string") this.tools.add(block.id);
      }
      for (const block of blocks) if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        progress = true; this.tools.delete(block.tool_use_id);
      }
      const type = item.sessionUpdate ?? item.type;
      const tool = ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "imageView", "imageGeneration", "tool_call", "tool_call_update"].includes(String(type));
      const id = item.toolCallId ?? item.id;
      if (tool && typeof id === "string") {
        progress = true;
        if (event.phase === "completed" && !["inProgress", "in_progress", "running", "pending"].includes(String(item.status))) this.tools.delete(id); else this.tools.add(id);
      }
      progress ||= type === "agentMessage" || type === "reasoning" || type === "agent_message_chunk" || type === "agent_thought_chunk";
      if (item.type === "system" && typeof item.task_id === "string") {
        if (item.subtype === "task_started") this.background.add(item.task_id);
        if (item.subtype === "task_notification") this.background.delete(item.task_id);
      }
      if (this.tools.size + this.background.size > 1024) { this.tools.clear(); this.background.clear(); this.overflow = true; }
    }
    if (restored) {
      if (beforeWait !== this.tools.size + ":" + this.background.size) {
        this.revision++; this.holding = "restored tool inventory awaiting ownership verification"; this.persist(true); this.arm(0);
      }
      return;
    }
    if (progress || beforeWait !== this.tools.size + ":" + this.background.size) {
      this.revision++; this.progressAt = this.checkpointProgressAt = this.activityAt = this.now(); this.holding = null; this.arm();
    }
    this.persist(beforeWait !== this.tools.size + ":" + this.background.size || wasHolding && progress);
  }
  private persist(force = false): void {
    if (!force && this.persistedAt !== null && this.checkpointProgressAt <= this.persistedAt) return;
    if (this.overflow || !this.checkpoint || !this.turn || !force && this.persistedAt !== null && this.now() - this.persistedAt < 30_000) return;
    try { writeJsonDurably(this.checkpoint, { version: 1, turn: this.turn, progressAt: this.checkpointProgressAt, activityAt: this.activityAt, waiting: this.holding !== null, tools: [...this.tools], background: [...this.background] }); this.persistedAt = this.now(); }
    catch { this.overflow = true; this.ports.hold(this.turn, "silence checkpoint unavailable; ownership retained"); }
  }
  private current(): boolean { try { return this.ports.current(); } catch { return false; } }
  private arm(delay = TURN_SILENCE_MS): void {
    this.cancel?.();
    this.cancel = this.schedule(() => this.check(), delay);
  }
  async check(): Promise<void> {
    this.cancel?.(); this.cancel = null;
    const turn = this.turn;
    if (!turn || !this.current()) { this.stop(); return; }
    const revision = this.revision;
    let recordedBackground: "absent" | "pending" | "unknown" = "absent";
    const transcript = this.ports.artifactPath();
    if (transcript) {
      if (!this.backgroundRead) {
        const read = (async (): Promise<"absent" | "pending" | "unknown"> => {
          try {
            await fs.promises.stat(transcript);
            const work = await verifiedBackgroundWork(transcript, this.now());
            return work.state === "unreadable" ? "unknown" : work.names.length ? "pending" : "absent";
          } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
        })();
        this.backgroundRead = read;
        void read.then(() => { if (this.backgroundRead === read) this.backgroundRead = null; });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        recordedBackground = await Promise.race([this.backgroundRead, new Promise<"unknown">(resolve => {
          timer = setTimeout(() => resolve("unknown"), 30_000); timer.unref?.();
        })]);
      } finally { if (timer) clearTimeout(timer); }
      if (!this.current() || this.turn !== turn || revision !== this.revision) return;
    }
    const state = this.ports.state();
    if (state.activeTurnRef !== turn || ["dead", "unhosted"].includes(state.status)) { this.stop(); return; }
    const retryAt = Date.parse(state.providerRetry?.retryAt ?? "");
    const waiting = this.overflow ? "tool ownership inventory unavailable"
      : state.pendingAttention.length ? "permission or question pending"
      : this.tools.size ? "foreground tool awaiting its result"
      : recordedBackground === "unknown" ? "background ownership evidence unavailable"
      : recordedBackground === "pending" || this.background.size ? "recorded background task awaiting completion; owner deadline unavailable"
      : retryAt > this.now() ? "provider retry deadline pending" : null;
    if (waiting) {
      if (this.holding !== waiting) { this.holding = waiting; this.ports.hold(turn, waiting); }
      this.progressAt = this.checkpointProgressAt = this.now(); this.persist(); this.arm(30_000); return;
    }
    if (this.holding !== null) {
      this.holding = null; this.progressAt = this.checkpointProgressAt = this.now(); this.persist(true); this.arm(); return;
    }
    const remaining = TURN_SILENCE_MS - (this.now() - this.progressAt);
    if (remaining > 0) { this.arm(remaining); return; }
    // All checks and the terminal transition are synchronous: no await can
    // replace the turn or writer between the fence and termination.
    if (this.current() && this.ports.state().activeTurnRef === turn) this.ports.expire(turn);
    this.stop();
  }
  stop(): void {
    this.cancel?.(); this.cancel = null; this.turn = null; this.revision++; this.persistedAt = null; this.checkpoint = null;
    this.tools.clear(); this.background.clear(); this.overflow = false; this.holding = null;
  }
}
