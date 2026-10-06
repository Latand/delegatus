"use client";

import type { CompanionCommand, CompanionEvent, Locale, Payload, VoiceCompanionAdapter } from "./contract";
import { BrowserCompanionMedia, type CompanionMedia, type MediaCallbacks } from "./media";

interface AdapterOptions {
  fetch?: typeof fetch;
  media?(callbacks: MediaCallbacks): CompanionMedia;
  pollMs?: number;
}

/** Typed adapter consumed by useVoiceCompanion. Server events own transcripts,
 * proposals, receipt/reply correlation and usage. Local events own played RMS.
 * No provider key, provider tool invocation or usage submission enters here. */
export class OfficialVoiceCompanionAdapter implements VoiceCompanionAdapter {
  readonly mode = "official-realtime";
  private listeners = new Set<(event: CompanionEvent) => void>();
  private media: CompanionMedia | null = null;
  private sessionId: string | null = null;
  private observedId: string | null = null;
  private pendingDeliveries = new Set<string>();
  private requestId: string | null = null;
  private cursor = 0;
  private seq = 0;
  private born = 0;
  private epoch = 0;
  private localSession = "";
  private latestOutput: string | null = null;
  private playing: { responseId: string; itemId: string; playedMs: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closing: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private poll: Promise<void> | null = null;
  constructor(private readonly options: AdapterOptions = {}) {}
  subscribe(emit: (event: CompanionEvent) => void): () => void { this.listeners.add(emit); return () => { this.listeners.delete(emit); }; }
  private emit(payload: Payload, original?: CompanionEvent): void {
    const event = { ...payload, version: 1 as const, sessionId: original?.sessionId ?? this.sessionId ?? this.observedId ?? this.localSession, generation: 1,
      eventId: original?.eventId ?? crypto.randomUUID(), seq: ++this.seq, atMs: Math.max(0, performance.now() - this.born) } as CompanionEvent;
    for (const listener of this.listeners) listener(event);
  }
  private async request(body?: unknown, query = ""): Promise<Record<string, unknown>> {
    const response = await (this.options.fetch ?? fetch)(`/api/voice-companion/session${query}`, {
      cache: "no-store", signal: AbortSignal.timeout(40_000),
      ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result?.code === "string" && /^[A-Z_]{1,40}$/.test(result.code) ? result.code : "COMPANION_UNAVAILABLE");
    return result;
  }
  start(options: { locale: Locale; project: string }): Promise<void> {
    if (this.starting) return this.starting;
    const promise = this.begin(options);
    this.starting = promise;
    return promise.finally(() => { if (this.starting === promise) this.starting = null; });
  }
  private async begin(options: { locale: Locale; project: string }): Promise<void> {
    await this.close();
    this.stopObserver();
    const epoch = ++this.epoch;
    this.localSession = crypto.randomUUID(); this.requestId = crypto.randomUUID();
    this.cursor = 0; this.seq = 0; this.born = performance.now(); this.latestOutput = null;
    const callbacks: MediaCallbacks = { playback: sample => { if (epoch === this.epoch) this.playback(sample); },
      input: value => { if (epoch === this.epoch) this.input(value); }, lost: code => { if (epoch === this.epoch) this.lost(code); } };
    const media = this.media = this.options.media?.(callbacks) ?? new BrowserCompanionMedia(callbacks);
    try {
      const sdp = await media.open();
      if (epoch !== this.epoch) throw new Error("SESSION_CLOSED");
      const result = await this.request({ action: "start", ...options, sdp, requestId: this.requestId });
      if (typeof result.sessionId !== "string" || typeof result.sdp !== "string") throw new Error("PROVIDER_ERROR");
      if (epoch !== this.epoch) { await this.request({ action: "close", sessionId: result.sessionId }); throw new Error("SESSION_CLOSED"); }
      this.sessionId = result.sessionId;
      this.observedId = result.sessionId;
      this.localSession = result.sessionId;
      await media.answer(result.sdp);
      if (epoch !== this.epoch) throw new Error("SESSION_CLOSED");
      await this.readEvents();
      this.schedule(epoch);
    } catch (error) {
      if (epoch !== this.epoch) { await media.close(); return; }
      // Publish readiness for a failed local attempt so hooks can display its
      // error even when no server session was minted (microphone/key/cap).
      if (!this.sessionId) this.emit({ type: "session.ready", mode: this.mode });
      const code = error instanceof Error && /^[A-Z_]{1,40}$/.test(error.message) ? error.message : "PROVIDER_ERROR";
      await this.close();
      this.emit({ type: "error", code, recoverable: false });
      throw error;
    }
  }
  private schedule(epoch: number): void {
    if (this.timer || epoch !== this.epoch || !this.observedId || (!this.sessionId && !this.pendingDeliveries.size)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.readEvents().then(() => this.schedule(epoch)).catch(() => {
        if (epoch !== this.epoch) return;
        if (this.sessionId) this.lost("PROVIDER_ERROR");
        else this.emit({ type: "error", code: "COMPANION_UNAVAILABLE", recoverable: true });
      });
    }, this.options.pollMs ?? (this.sessionId ? 500 : 2_000));
  }
  private readEvents(): Promise<void> {
    if (this.poll) return this.poll;
    const sessionId = this.observedId;
    if (!sessionId) return Promise.resolve();
    const epoch = this.epoch;
    const promise = (async () => {
      const result = await this.request(undefined, `?sessionId=${encodeURIComponent(sessionId)}&after=${this.cursor}`);
      if (epoch !== this.epoch || !Array.isArray(result.events)) return;
      for (const value of result.events as CompanionEvent[]) {
        if (value.sessionId !== sessionId || value.seq <= this.cursor) continue;
        this.cursor = value.seq;
        if (value.type === "delegation.tool.result" && "delivery" in value.result) this.pendingDeliveries.add(value.result.delivery.clientMessageId);
        if (value.type === "delegation.delivery.settled" && value.status === "failed") this.pendingDeliveries.delete(value.delivery.clientMessageId);
        if (value.type === "orchestrator.answer" && value.status !== "progress") this.pendingDeliveries.delete(value.delivery.clientMessageId);
        if (value.type === "transcript.snapshot" && value.speaker === "companion") this.latestOutput = value.itemId;
        this.emit(value, value);
        if (value.type === "session.closed") {
          this.stopPlayback("closed");
          await this.media?.close(); this.media = null;
          this.sessionId = null; this.requestId = null;
          if (this.timer) clearTimeout(this.timer); this.timer = null;
        }
      }
      this.schedule(epoch);
    })();
    this.poll = promise;
    return promise.finally(() => { if (this.poll === promise) this.poll = null; });
  }
  private playback(sample: { rms: number; playedMs: number; speaking: boolean }): void {
    if (!this.sessionId) return;
    if (sample.speaking && !this.playing) {
      this.playing = { responseId: `played-${crypto.randomUUID()}`, itemId: this.latestOutput ?? `audio-${crypto.randomUUID()}`, playedMs: 0 };
      this.emit({ type: "playback.started", ...this.playing });
    }
    if (this.playing) {
      this.playing.playedMs = sample.playedMs;
      if (sample.speaking) this.emit({ type: "playback.level", ...this.playing, rms: sample.rms });
      else this.stopPlayback("ended");
    }
  }
  private stopPlayback(reason: Extract<Payload, { type: "playback.stopped" }>["reason"]): void {
    if (this.playing) this.emit({ type: "playback.stopped", ...this.playing, reason });
    this.playing = null;
  }
  private input(speaking: boolean): void {
    if (!this.sessionId) return;
    if (speaking) { this.stopPlayback("interrupted"); this.media?.interrupt(); }
    this.emit({ type: speaking ? "input.speech.started" : "input.speech.stopped", itemId: "local-microphone" });
  }
  async command(command: CompanionCommand): Promise<void> {
    if (!this.sessionId) throw new Error("SESSION_CLOSED");
    if (command.type === "interrupt") { this.stopPlayback("interrupted"); this.media?.interrupt(); }
    if (command.type === "mute") this.media?.mute(command.muted);
    await this.request({ action: "command", sessionId: this.sessionId, command });
    await this.readEvents();
  }
  private lost(code: string): void {
    this.emit({ type: "error", code, recoverable: false });
    void this.close().catch(() => undefined);
  }
  async refresh(): Promise<void> { await this.readEvents(); this.schedule(this.epoch); }
  private stopObserver(): void {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.observedId = null; this.pendingDeliveries.clear();
  }
  async dispose(): Promise<void> {
    const observedId = this.observedId;
    await this.close();
    if (this.observedId === observedId) { ++this.epoch; this.stopObserver(); await this.poll; }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    ++this.epoch;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.stopPlayback("closed");
    const sessionId = this.sessionId; const requestId = this.requestId;
    const media = this.media;
    const promise = (async () => {
      // Disable microphone input immediately; keep WebRTC alive while final
      // provider usage drains through the server's close request.
      media?.mute(true);
      try {
        if (sessionId || requestId) await this.request({ action: "close", ...(sessionId ? { sessionId } : { requestId }) });
        if (sessionId) { await this.poll; await this.readEvents(); }
      } catch { this.emit({ type: "error", code: "FINALIZATION_INCOMPLETE", recoverable: true }); }
      finally {
        await media?.close();
        this.media = null; this.sessionId = null; this.requestId = null;
        this.schedule(this.epoch);
      }
    })();
    this.closing = promise;
    return promise.finally(() => { if (this.closing === promise) this.closing = null; });
  }
}
