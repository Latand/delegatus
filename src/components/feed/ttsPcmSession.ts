"use client";

import type { SpeechChunk } from "@/lib/ttsChunks";
import { announceCacheChange, billedVoice, TtsRequestError, voiceKey, type VoiceKey } from "./ttsSession";

export const PCM_RATE = 24000;
export const PCM_BUDGET = 32 * 1024 * 1024;
const BLOCK_SAMPLES = PCM_RATE / 10;
const cache = new Map<string, Float32Array[]>();
let cacheBytes = 0;
const bytesOf = (blocks: readonly Float32Array[]) => blocks.reduce((sum, block) => sum + block.byteLength, 0);
export const pcmVoice = (voice: VoiceKey): VoiceKey => ({ ...voice, encoding: "pcm_s16le", sampleRate: PCM_RATE });
export function pcmChunksCached(keys: readonly string[]): boolean { return keys.length > 0 && keys.every((key) => cache.has(key)); }
export function clearPcmCache(): void { cache.clear(); cacheBytes = 0; announceCacheChange(); }
function retain(key: string, blocks: Float32Array[], activeBytes: number): void {
  if (!cache.has(key)) { cache.set(key, blocks.slice()); cacheBytes += bytesOf(blocks); }
  trimCache(activeBytes);
  announceCacheChange();
}
function trimCache(activeBytes: number): void {
  while (cacheBytes + activeBytes > PCM_BUDGET && cache.size) {
    const [key, blocks] = cache.entries().next().value!;
    cache.delete(key); cacheBytes -= bytesOf(blocks);
  }
}

/** Fetch boundaries can cut a signed 16-bit sample in half. */
export class PcmDecoder {
  private carry: number | null = null;
  decode(bytes: Uint8Array): Float32Array {
    let joined = bytes;
    if (this.carry !== null) { joined = new Uint8Array(bytes.length + 1); joined[0] = this.carry; joined.set(bytes, 1); }
    this.carry = joined.length % 2 ? joined[joined.length - 1]! : null;
    const samples = new Float32Array(Math.floor(joined.length / 2));
    const view = new DataView(joined.buffer, joined.byteOffset, joined.byteLength);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    return samples;
  }
  finish(): void { if (this.carry !== null) throw new Error("incomplete PCM sample"); }
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new DOMException("aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** The real client request path. Retry only pre-body refusals; a failed stream
 * is terminal because replaying it could repeat speech already rendered. */
export async function requestPcm(text: string, signal: AbortSignal): Promise<{ body: ReadableStream<Uint8Array>; voice: VoiceKey }> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, mode: "soniox-pcm" }), signal });
    if (response.status === 429 && attempt < 3) {
      await response.body?.cancel();
      const raw = response.headers.get("retry-after");
      const seconds = raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : 1;
      await abortableDelay(Math.min(60, Math.max(1, seconds)) * 1000, signal);
      continue;
    }
    if (!response.ok) {
      let message: string | null = null;
      try { const body = await response.json(); message = typeof body.error === "string" ? body.error : null; } catch { /* status remains useful */ }
      throw new TtsRequestError(response.status, message);
    }
    const voice = billedVoice(response);
    if (!voice || voice.id !== "soniox" || !voice.language || voice.encoding !== "pcm_s16le" || voice.sampleRate !== PCM_RATE || response.headers.get("x-tts-channels") !== "1" || response.headers.get("content-type")?.split(";")[0] !== "audio/pcm" || !response.body) {
      await response.body?.cancel();
      throw new Error("invalid PCM geometry or voice identity");
    }
    return { body: response.body, voice };
  }
}

interface PendingChunk { blocks: Float32Array[]; complete: boolean; samples: number; scheduled: number; scheduledSamples: number; }
interface Span { node: AudioBufferSourceNode; chunk: number; start: number; end: number; sample: number; }
export interface PcmSessionOptions {
  chunks: SpeechChunk[];
  voice: VoiceKey;
  context: AudioContext;
  onPhase: (phase: "loading" | "playing") => void;
  onPosition: (position: { chunkIndex: number; charIndex: number; elapsed: number; total: number }) => void;
  onVoice: (voice: VoiceKey) => void;
  onError: (error: unknown) => void;
  onEnd: () => void;
}

/** One sample clock for the whole read. Fetches fill indexed queues; scheduling
 * advances only through complete predecessors. UI frames never trigger joins. */
export class PcmSession {
  private stopped = false;
  private generation = 0;
  private aborts = new Map<number, AbortController>();
  private queued = new Map<number, PendingChunk>();
  private spans: Span[] = [];
  private scheduleCursor = 0;
  private playingCursor = 0;
  private nextTime = 0;
  private firstStarted = false;
  private lastRequest = -Infinity;
  private frame = 0;
  private cadence: ReturnType<typeof setTimeout> | null = null;
  private phase: "loading" | "playing" | null = null;
  private durations = new Map<number, number>();
  private seekSample = 0;
  constructor(private options: PcmSessionOptions) {}

  start(fromChar = 0): void {
    this.scheduleCursor = Math.max(0, this.options.chunks.findIndex((chunk) => chunk.end > fromChar));
    this.playingCursor = this.scheduleCursor;
    this.setPhase("loading");
    this.pump();
    this.frame = requestAnimationFrame(() => this.tick());
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true; this.generation++;
    this.cancelAudio();
    for (const abort of this.aborts.values()) abort.abort();
    this.aborts.clear(); this.queued.clear();
    cancelAnimationFrame(this.frame);
    if (this.cadence) clearTimeout(this.cadence);
    void this.options.context.close().catch(() => undefined);
  }
  seekToChar(char: number): void {
    if (this.stopped) return;
    const index = this.options.chunks.findIndex((chunk) => chunk.end > char);
    if (index < 0) return;
    this.generation++;
    for (const abort of this.aborts.values()) abort.abort();
    this.queued.clear(); this.cancelAudio();
    this.scheduleCursor = index; this.playingCursor = index; this.firstStarted = false;
    const chunk = this.options.chunks[index]!;
    const blocks = cache.get(voiceKey(pcmVoice(this.options.voice), chunk.text));
    this.seekSample = blocks ? Math.floor(bytesOf(blocks) / 4 * Math.max(0, char - chunk.start) / chunk.text.length) : 0;
    this.setPhase("loading"); this.pump();
  }
  private cancelAudio(): void {
    for (const span of this.spans) { try { span.node.stop(); } catch { /* already ended */ } span.node.disconnect(); }
    this.spans = []; this.nextTime = 0;
  }
  private setPhase(phase: "loading" | "playing"): void {
    if (this.phase !== phase) { this.phase = phase; this.options.onPhase(phase); }
  }
  private activeBytes(): number { return [...this.queued.values()].reduce((sum, data) => sum + bytesOf(data.blocks), 0) + this.spans.reduce((sum, span) => sum + (span.node.buffer?.length ?? 0) * 4, 0); }
  private pump(): void {
    if (this.stopped) return;
    if (this.playingCursor >= this.options.chunks.length) return;
    const last = Math.min(this.options.chunks.length - 1, this.playingCursor + (this.firstStarted ? 2 : 0));
    for (let index = this.playingCursor; index <= last; index++) {
      if (this.queued.has(index) || this.aborts.has(index)) continue;
      const chunk = this.options.chunks[index]!;
      const key = voiceKey(pcmVoice(this.options.voice), chunk.text);
      const cached = cache.get(key);
      if (cached) {
        cache.delete(key); cache.set(key, cached);
        this.queued.set(index, { blocks: cached, complete: true, samples: bytesOf(cached) / 4, scheduled: 0, scheduledSamples: 0 });
        this.durations.set(index, bytesOf(cached) / 4 / PCM_RATE);
        this.schedule();
        continue;
      }
      if (this.aborts.size >= 2) break;
      const delay = this.lastRequest + 1000 - performance.now();
      if (delay > 0) {
        if (!this.cadence) this.cadence = setTimeout(() => { this.cadence = null; this.pump(); }, delay);
        break;
      }
      this.lastRequest = performance.now();
      const abort = new AbortController(); this.aborts.set(index, abort);
      this.queued.set(index, { blocks: [], complete: false, samples: 0, scheduled: 0, scheduledSamples: 0 });
      void this.fetchChunk(index, abort, this.generation);
    }
  }
  private async fetchChunk(index: number, abort: AbortController, generation: number): Promise<void> {
    const alive = () => !this.stopped && generation === this.generation && !abort.signal.aborted;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const cancel = () => { void reader?.cancel().catch(() => undefined); };
    abort.signal.addEventListener("abort", cancel, { once: true });
    try {
      const response = await requestPcm(this.options.chunks[index]!.text, abort.signal);
      if (!alive()) { await response.body.cancel(); return; }
      this.options.onVoice(response.voice);
      this.options.voice = response.voice;
      reader = response.body.getReader();
      const decoder = new PcmDecoder();
      let pending = new Float32Array(0);
      const data = this.queued.get(index)!;
      const append = (block: Float32Array) => {
        data.blocks.push(block); data.samples += block.length;
        if (data.samples / PCM_RATE >= 115 || this.activeBytes() > PCM_BUDGET) throw new Error("speech stream exceeded its duration or memory limit");
        trimCache(this.activeBytes());
        this.schedule();
      };
      while (alive()) {
        const { done, value } = await reader.read();
        if (!alive()) return;
        if (done) break;
        if (value.byteLength > PCM_BUDGET / 4) throw new Error("oversized PCM packet");
        const samples = decoder.decode(value);
        const joined = new Float32Array(pending.length + samples.length);
        joined.set(pending); joined.set(samples, pending.length);
        let at = 0;
        for (; at + BLOCK_SAMPLES <= joined.length; at += BLOCK_SAMPLES) append(joined.slice(at, at + BLOCK_SAMPLES));
        pending = joined.slice(at);
      }
      if (!alive()) return;
      decoder.finish();
      if (pending.length) append(pending);
      if (!data.samples) throw new Error("empty PCM stream");
      data.complete = true; this.durations.set(index, data.samples / PCM_RATE);
      retain(voiceKey(response.voice, this.options.chunks[index]!.text), data.blocks, this.activeBytes());
      this.schedule();
    } catch (error) {
      if (alive()) { this.options.onError(error); this.stop(); }
    } finally {
      abort.signal.removeEventListener("abort", cancel);
      try { await reader?.cancel(); } catch { /* original error is reported */ }
      if (this.aborts.get(index) === abort) this.aborts.delete(index);
      if (!this.stopped) this.pump();
    }
  }
  private schedule(): void {
    if (this.stopped) return;
    const context = this.options.context;
    if (context.state !== "running") return;
    while (this.scheduleCursor < this.options.chunks.length) {
      const data = this.queued.get(this.scheduleCursor);
      if (!data) break;
      while (data.scheduled < data.blocks.length) {
        let block = data.blocks[data.scheduled++]!;
        let sampleOffset = data.scheduledSamples; data.scheduledSamples += block.length;
        if (this.seekSample) {
          const skip = Math.min(block.length, this.seekSample); this.seekSample -= skip; sampleOffset += skip; block = block.subarray(skip);
          if (!block.length) continue;
        }
        trimCache(this.activeBytes() + block.byteLength);
        if (this.activeBytes() + block.byteLength > PCM_BUDGET) {
          this.options.onError(new Error("speech queue exceeded its memory limit")); this.stop(); return;
        }
        const buffer = context.createBuffer(1, block.length, PCM_RATE);
        buffer.copyToChannel(block as Float32Array<ArrayBuffer>, 0);
        const node = context.createBufferSource(); node.buffer = buffer; node.connect(context.destination);
        const start = this.nextTime > context.currentTime ? this.nextTime : context.currentTime + 0.02;
        const end = start + block.length / PCM_RATE;
        this.spans.push({ node, chunk: this.scheduleCursor, start, end, sample: sampleOffset });
        node.start(start); this.nextTime = end;
      }
      if (!data.complete) break;
      this.scheduleCursor++;
    }
  }
  private tick(): void {
    if (this.stopped) return;
    this.schedule();
    const now = this.options.context.currentTime;
    while (this.spans.length && this.spans[0]!.end <= now) {
      const done = this.spans.shift()!; done.node.disconnect();
      if (this.options.context.state === "running") this.firstStarted = true;
      if (done.chunk < (this.spans[0]?.chunk ?? this.scheduleCursor)) { this.queued.delete(done.chunk); this.playingCursor = Math.max(this.playingCursor, done.chunk + 1); }
    }
    const current = this.spans.find((span) => span.start <= now && span.end > now);
    if (current && this.options.context.state === "running") {
      this.firstStarted = true; this.playingCursor = current.chunk;
      this.setPhase("playing");
      const chunk = this.options.chunks[current.chunk]!;
      const elapsed = this.options.chunks.slice(0, current.chunk).reduce((sum, chunk, index) => sum + (this.durations.get(index) ?? chunk.text.length / 15), 0) + current.sample / PCM_RATE + Math.max(0, now - current.start);
      const total = this.options.chunks.reduce((sum, value, index) => sum + (this.durations.get(index) ?? value.text.length / 15), 0);
      this.options.onPosition({ chunkIndex: current.chunk, charIndex: chunk.start, elapsed, total });
      this.pump();
    } else {
      this.setPhase("loading");
      if (!this.spans.length && this.scheduleCursor === this.options.chunks.length && !this.aborts.size) {
        this.options.onEnd(); this.stop(); return;
      }
    }
    this.pump();
    this.frame = requestAnimationFrame(() => this.tick());
  }
}
