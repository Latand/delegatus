import { float32ToPcm16 } from "@/lib/audio";
import { applySonioxFrame, sonioxLiveInitialState, sonioxStartRequest, SONIOX_LIVE_WS_URL } from "./sonioxLive";
import { publishDictationTrace, type DictationTrace } from "./dictationTrace";
import type { TranscriptionLanguage } from "./languages";

export const DICTATION_TOKEN_MS = 10_000;
export const DICTATION_CONNECT_MS = 10_000;
export const DICTATION_DRAIN_MS = 8_000;
export const DICTATION_BATCH_MS = 120_000;
/** 1,920,000 PCM16 samples = 3,840,000 bytes (120 s at 16 kHz).
 * A full buffer stops capture and recovers it; no old sample is evicted. */
export const DICTATION_BUFFER_SAMPLES = 1_920_000;
const MAX_SOCKET_BYTES = 256 * 1024;

export interface DictationSessionCallbacks {
  partial(text: string): void;
  commit(text: string, language?: TranscriptionLanguage): void;
  done(text: string | null, issue?: "tail" | "recovery" | "buffer"): void;
  busy(): void;
  language: TranscriptionLanguage;
}

/** One owner from microphone grant through live drain or one batch recovery. */
export class DictationSession {
  readonly ctx: AudioContext;
  private processor: ScriptProcessorNode;
  private source: MediaStreamAudioSourceNode;
  private chunks: Int16Array[] = [];
  private baseSample = 0;
  private sentSample = 0;
  private sentChunks = 0;
  private discarded = false;
  private state = sonioxLiveInitialState();
  private ws: WebSocket | null = null;
  private connectTimer: number | null = null;
  private drainTimer: number | null = null;
  private drainDeadlineAt: number | null = null;
  private batchAbort: AbortController | null = null;
  private inputStopped = false;
  private ending = false;
  private ended = false;
  private limit = false;
  private mode: "pending" | "live" | "batch" = "pending";
  private stopPromise: Promise<void> | null = null;

  constructor(private stream: MediaStream, private trace: DictationTrace, private callbacks: DictationSessionCallbacks) {
    try { this.ctx = new AudioContext({ sampleRate: 16_000 }); }
    catch { this.ctx = new AudioContext(); }
    this.trace.sampleRate = this.ctx.sampleRate;
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.source = this.ctx.createMediaStreamSource(stream);
    this.processor.onaudioprocess = event => {
      if (this.inputStopped || this.ended) return;
      const input = event.inputBuffer.getChannelData(0);
      const count = Math.min(input.length, DICTATION_BUFFER_SAMPLES - this.trace.bufferedSamples);
      if (count) {
        this.chunks.push(float32ToPcm16(input.subarray(0, count)));
        this.trace.capturedSamples += count;
        this.trace.bufferedSamples += count;
        this.trace.peakBufferedSamples = Math.max(this.trace.peakBufferedSamples, this.trace.bufferedSamples);
      }
      this.flush();
      if (this.trace.bufferedSamples >= DICTATION_BUFFER_SAMPLES) {
        this.limit = true;
        void this.recover();
      }
    };
    this.source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
    publishDictationTrace(this.trace);
  }

  get active(): boolean { return !this.ending && !this.ended; }
  useBatch(): void { if (this.active) { this.mode = "batch"; this.trace.path = "batch"; this.trace.provider = "batch"; publishDictationTrace(this.trace); } }
  connect(token: string): void {
    if (!this.active) return;
    this.mode = "live";
    this.trace.path = "live"; this.trace.provider = "soniox"; this.trace.connectOutcome = "pending";
    const began = Date.now();
    try {
      const ws = new WebSocket(SONIOX_LIVE_WS_URL);
      this.ws = ws;
      ws.binaryType = "arraybuffer";
      this.connectTimer = window.setTimeout(() => {
        this.trace.connectMs = Date.now() - began;
        this.trace.connectOutcome = "deadline";
        this.fallBack();
      }, DICTATION_CONNECT_MS);
      ws.addEventListener("open", () => {
        if (!this.active || this.ws !== ws) return;
        this.clearConnect();
        this.trace.connectMs = Date.now() - began; this.trace.connectOutcome = "ok";
        try { ws.send(JSON.stringify(sonioxStartRequest({ token, sampleRate: this.ctx.sampleRate }))); this.flush(); }
        catch { this.trace.closeReason = "error"; this.fallBack(); }
        publishDictationTrace(this.trace);
      });
      ws.addEventListener("message", event => {
        if (this.ended || this.ws !== ws) return;
        const update = applySonioxFrame(this.state, event.data);
        if (!update) return;
        if (update.error) { this.trace.closeReason = "error"; this.fallBack(); return; }
        this.state = update.state;
        this.trace.finalSegments += update.finalSegments;
        this.trace.replayedFinals += update.replayedFinals;
        if (update.commit) {
          // Missing identities cannot safely advance the recovery seam. Batch the retained audio.
          const end = update.state.committedThroughMs;
          if (!update.stableCommit || end === undefined || end * this.ctx.sampleRate / 1000 > this.sentSample) { this.trace.closeReason = "error"; this.fallBack(); return; }
          this.trace.commits += update.segments;
          this.trim(Math.floor(end * this.ctx.sampleRate / 1000));
          this.callbacks.commit(update.commit, update.language);
          publishDictationTrace(this.trace);
        }
        this.callbacks.partial(update.liveText);
        if (update.finished) {
          if (!this.inputStopped) { this.fallBack(); return; }
          this.trace.drainOutcome = "ok";
          this.finish("");
        }
      });
      ws.addEventListener("close", event => {
        this.trace.closeCode = event.code;
        if (this.trace.closeReason !== "error") this.trace.closeReason = event.code === 1000 ? "normal" : "abnormal";
        if (this.trace.connectOutcome === "pending") this.trace.connectMs = Date.now() - began;
        publishDictationTrace(this.trace);
        if (this.ws !== ws || this.ended) return;
        this.fallBack();
      });
      ws.addEventListener("error", () => {
        if (this.ws !== ws || this.ended) return;
        this.trace.closeReason = "error";
        if (this.trace.connectOutcome === "pending") this.trace.connectMs = Date.now() - began;
        this.fallBack();
      });
    } catch { this.trace.connectOutcome = "error"; this.fallBack(); }
  }

  private flush(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.ending || this.ended) return;
    try {
      while (this.sentChunks < this.chunks.length) {
        const chunk = this.chunks[this.sentChunks];
        const end = this.sentSample + chunk.length;
        if (ws.bufferedAmount > MAX_SOCKET_BYTES) { this.trace.closeReason = "error"; this.fallBack(); return; }
        ws.send(chunk.slice().buffer);
        this.trace.sentSamples += chunk.length;
        this.sentSample = end;
        this.sentChunks++;
      }
    } catch { this.trace.closeReason = "error"; this.fallBack(); }
  }
  private trim(through: number): void {
    while (this.chunks.length && this.baseSample < through) {
      const chunk = this.chunks[0];
      const count = Math.min(chunk.length, through - this.baseSample);
      if (count === chunk.length) { this.chunks.shift(); this.sentChunks = Math.max(0, this.sentChunks - 1); }
      else this.chunks[0] = chunk.slice(count);
      this.baseSample += count;
      this.trace.bufferedSamples -= count;
    }
  }
  private clearConnect(): void { if (this.connectTimer !== null) window.clearTimeout(this.connectTimer); this.connectTimer = null; }
  private stopInput(): void {
    if (this.inputStopped) return;
    this.inputStopped = true;
    this.trace.stoppedAt ??= Date.now();
    this.processor.onaudioprocess = null;
    this.processor.disconnect(); this.source.disconnect();
    this.stream.getTracks().forEach(track => track.stop());
    void this.ctx.close().catch(() => undefined);
  }
  stop(): void {
    if (this.ending || this.ended || this.drainTimer !== null) return;
    this.stopInput(); this.callbacks.busy();
    if (this.mode !== "live" || this.ws?.readyState !== WebSocket.OPEN) { void this.recover(); return; }
    this.trace.drainOutcome = "pending";
    this.drainDeadlineAt = Date.now() + DICTATION_DRAIN_MS;
    this.drainTimer = window.setTimeout(() => {
      this.trace.drainOutcome = "deadline";
      this.finish(null, "tail");
    }, DICTATION_DRAIN_MS);
    publishDictationTrace(this.trace);
    try { this.ws.send(""); } catch { void this.recover(); }
  }
  /** Keep recording through a failed live connection; Stop batches the retained
   * seam and everything spoken afterwards. A Stop already draining keeps its deadline. */
  private fallBack(): void {
    if (this.ending || this.ended) return;
    if (this.inputStopped) { void this.recover(); return; }
    this.clearConnect();
    if (this.trace.connectOutcome === "pending") this.trace.connectOutcome = "error";
    const ws = this.ws; this.ws = null;
    try { ws?.close(); } catch { /* Retired. */ }
    this.mode = "batch";
    this.trace.path = "live-batch";
    this.callbacks.partial("");
    publishDictationTrace(this.trace);
  }

  private recover(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.ended) return Promise.resolve();
    // Retire callbacks before close or the first await. Every failure gets one upload.
    this.ending = true;
    this.stopInput(); this.clearConnect();
    if (this.drainTimer !== null) window.clearTimeout(this.drainTimer);
    this.drainTimer = null;
    const ws = this.ws; this.ws = null;
    try { ws?.close(); } catch { /* Retired. */ }
    if (this.trace.connectOutcome === "pending") this.trace.connectOutcome = "error";
    if (this.trace.drainOutcome === "pending") this.trace.drainOutcome = "error";
    this.callbacks.partial(""); this.callbacks.busy();
    this.trace.path = this.trace.path === "live" || this.trace.path === "live-batch" ? "live-batch" : "batch";
    if (this.trace.provider === "pending") this.trace.provider = "batch";
    this.trace.batchOutcome = "pending";
    publishDictationTrace(this.trace);
    this.stopPromise = this.upload();
    return this.stopPromise;
  }
  private async upload(): Promise<void> {
    if (!this.trace.bufferedSamples) { this.trace.batchOutcome = "ok"; this.finish(""); return; }
    const abort = new AbortController(); this.batchAbort = abort;
    // A close during live Stop shares the original drain deadline.
    const allowance = this.drainDeadlineAt === null ? DICTATION_BATCH_MS : Math.max(0, this.drainDeadlineAt - Date.now());
    const timer = window.setTimeout(() => { this.trace.batchOutcome = "deadline"; abort.abort(); this.finish(null, "recovery"); }, allowance);
    try {
      const form = new FormData(); form.append("file", this.wav(), "dictation.wav"); form.append("language", this.callbacks.language);
      const response = await fetch("/api/transcribe", { method: "POST", body: form, signal: abort.signal });
      if (this.ended) return;
      const json = await response.json() as { text?: unknown };
      if (this.ended) return;
      if (!response.ok || typeof json.text !== "string") throw new Error("Batch unavailable");
      const text = json.text.trim();
      this.trace.batchOutcome = text ? "ok" : "error";
      if (text) { this.trace.finalSegments++; this.trace.commits++; }
      this.finish(text || null, text ? undefined : "recovery");
    } catch {
      if (!this.ended) { this.trace.batchOutcome = "error"; this.finish(null, "recovery"); }
    } finally { window.clearTimeout(timer); this.batchAbort = null; }
  }
  private wav(): Blob {
    const bytes = this.trace.bufferedSamples * 2;
    const header = new ArrayBuffer(44); const view = new DataView(header);
    const tag = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
    tag(0, "RIFF"); view.setUint32(4, 36 + bytes, true); tag(8, "WAVE"); tag(12, "fmt "); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, this.ctx.sampleRate, true); view.setUint32(28, this.ctx.sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, bytes, true);
    return new Blob([header, ...this.chunks.map(chunk => chunk.slice().buffer)], { type: "audio/wav" });
  }
  private finish(text: string | null, issue?: "tail" | "recovery" | "buffer"): void {
    if (this.ended) return;
    this.ended = true; this.stopInput(); this.clearConnect();
    if (this.drainTimer !== null) window.clearTimeout(this.drainTimer); this.drainTimer = null;
    const ws = this.ws; this.ws = null;
    if (ws) { try { ws.close(1000); } catch { /* Closed. */ } }
    this.trace.endedAt = Date.now();
    this.trace.outcome = this.discarded ? "discarded" : text === null ? "incomplete" : this.limit ? "buffer-limit" : "complete";
    publishDictationTrace(this.trace);
    this.chunks = [];
    this.callbacks.done(text, this.limit && text !== null ? "buffer" : issue);
  }
  /** Retire the early capture when handing ownership to another live provider. */
  release(): void {
    this.ended = true; this.processor.onaudioprocess = null; this.processor.disconnect(); this.source.disconnect();
    void this.ctx.close().catch(() => undefined); this.chunks = [];
  }
  discard(): void {
    if (this.ended) return;
    this.discarded = true;
    this.batchAbort?.abort();
    this.finish(null);
  }
}
