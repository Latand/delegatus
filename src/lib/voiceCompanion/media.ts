import { attachVoiceOutput, openVoiceMicrophone } from "@/lib/audio/voiceDevices";
import { DISPLAY_PAUSE_MS } from "./liveTranscript";

export interface MediaCallbacks {
  playback(sample: { rms: number; playedMs: number; speaking: boolean }): void;
  input(speaking: boolean): void;
  lost(code: string, cause?: import("./contract").DropCause): void;
  connection(state: "disconnected" | "connected", inputSpeaking?: boolean): void;
}
export interface CompanionMedia {
  open(): Promise<string>;
  /** Replaces just the peer; the call keeps capture, output and user activation. */
  restart?(callbacks: MediaCallbacks): Promise<string>;
  answer(sdp: string): Promise<void>;
  mute(muted: boolean): void;
  interrupt(): void;
  close(): Promise<void>;
}

/** Browser media only. Fresh duplex handling; no composer code is imported.
 * The provider manages duplex audio. The output analyser drives presentation;
 * only the explicit interrupt command mutes received audio. */
export class BrowserCompanionMedia implements CompanionMedia {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private microphone: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private releaseMicrophone: (() => void) | null = null;
  private detachOutput: (() => void) | null = null;
  private context: AudioContext | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private inputAnalyser: AnalyserNode | null = null;
  private frame: number | null = null;
  private disposed = false;
  private outputOn = false;
  private outputLast = 0;
  private outputStart = 0;
  private blocked = false;
  private inputMuted = false;
  private quietSince: number | null = null;
  private cancelIce: (() => void) | null = null;
  private generation = 0;
  private capturing: Promise<void> | null = null;
  constructor(private callbacks: MediaCallbacks) {}
  private capture(): Promise<void> {
    if (this.microphone) return Promise.resolve();
    if (this.capturing) return this.capturing;
    const promise = (async () => {
      const { stream: microphone, release } = await openVoiceMicrophone({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      if (this.disposed) { microphone.getTracks().forEach(track => track.stop()); release(); throw new Error("SESSION_CLOSED"); }
      this.microphone = microphone;
      this.releaseMicrophone = release;
      for (const track of microphone.getAudioTracks()) track.enabled = !this.inputMuted;
    })();
    this.capturing = promise;
    return promise.finally(() => { if (this.capturing === promise) this.capturing = null; });
  }
  open(): Promise<string> { return this.negotiate(false); }
  private async negotiate(retainOnFailure: boolean): Promise<string> {
    if (this.disposed) throw new Error("SESSION_CLOSED");
    const generation = ++this.generation;
    try { await this.capture(); if (this.disposed || generation !== this.generation) throw new Error("SESSION_CLOSED"); }
    catch (error) { throw new Error(error instanceof Error && error.message === "SESSION_CLOSED" ? "SESSION_CLOSED" : "MICROPHONE_REFUSED"); }
    let peer: RTCPeerConnection | null = null;
    try {
      peer = this.peer = new RTCPeerConnection();
      const currentPeer = peer;
      const context = this.context ??= new AudioContext();
      await context.resume();
      if (this.disposed || generation !== this.generation) throw new Error("SESSION_CLOSED");
      if (!this.inputAnalyser) {
        this.inputAnalyser = context.createAnalyser(); this.inputAnalyser.fftSize = 512;
        context.createMediaStreamSource(this.microphone!).connect(this.inputAnalyser);
      }
      const audio = this.audio ??= new Audio(); audio.autoplay = true;
      this.detachOutput ??= attachVoiceOutput(audio);
      currentPeer.addEventListener("track", event => {
        if (this.disposed || currentPeer !== this.peer || event.track.kind !== "audio") return;
        const stream = new MediaStream([event.track]);
        audio.srcObject = stream;
        const output = this.outputAnalyser = context.createAnalyser(); output.fftSize = 512;
        context.createMediaStreamSource(stream).connect(output);
        void audio.play().catch(() => { if (!this.disposed && currentPeer === this.peer) this.callbacks.lost("AUDIO_REFUSED", "audio-refused"); });
      });
      currentPeer.addEventListener("connectionstatechange", () => {
        if (this.disposed || currentPeer !== this.peer) return;
        if (["failed", "closed"].includes(currentPeer.connectionState)) this.callbacks.lost("PROVIDER_ERROR", "ice-failed");
        if (currentPeer.connectionState === "disconnected" || currentPeer.connectionState === "connected") this.callbacks.connection(currentPeer.connectionState,
          !!this.microphone?.getAudioTracks().some(track => track.enabled) && this.rms(this.inputAnalyser) >= 0.008);
      });
      for (const track of this.microphone!.getAudioTracks()) currentPeer.addTrack(track, this.microphone!);
      this.channel = currentPeer.createDataChannel("oai-events");
      // Sideband owns every application effect. The frontend channel cannot
      // write provider commands and never forwards tool events to the server.
      this.channel.addEventListener("close", () => { if (!this.disposed && currentPeer === this.peer) this.callbacks.lost("PROVIDER_ERROR", "channel-closed"); });
      await currentPeer.setLocalDescription(await currentPeer.createOffer());
      if (this.disposed || generation !== this.generation) throw new Error("SESSION_CLOSED");
      if (currentPeer.iceGatheringState !== "complete") await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); currentPeer.removeEventListener("icegatheringstatechange", changed); this.cancelIce = null; };
        const changed = () => { if (currentPeer.iceGatheringState === "complete") { done(); resolve(); } };
        const timer = setTimeout(() => { done(); reject(new Error("PROVIDER_ERROR")); }, 10_000);
        this.cancelIce = () => { done(); reject(new Error("SESSION_CLOSED")); };
        currentPeer.addEventListener("icegatheringstatechange", changed); changed();
      });
      if (this.disposed || generation !== this.generation || !currentPeer.localDescription?.sdp) throw new Error("SESSION_CLOSED");
      return currentPeer.localDescription.sdp;
    } catch (error) {
      if (generation === this.generation) {
        if (retainOnFailure) {
          this.peer = null;
          this.channel?.close(); this.channel = null; peer?.close();
        } else await this.close();
      }
      else if (peer !== this.peer) peer?.close();
      throw error instanceof Error && error.message === "SESSION_CLOSED" ? error : new Error("PROVIDER_ERROR");
    }
  }
  async answer(sdp: string): Promise<void> {
    if (!this.peer || this.disposed) throw new Error("SESSION_CLOSED");
    const peer = this.peer;
    await peer.setRemoteDescription({ type: "answer", sdp });
    if (this.disposed || peer !== this.peer) throw new Error("SESSION_CLOSED");
    if (this.frame === null) this.sample();
  }
  async restart(callbacks: MediaCallbacks): Promise<string> {
    this.callbacks = callbacks;
    this.cancelIce?.();
    const peer = this.peer; this.peer = null;
    this.channel?.close(); this.channel = null; peer?.close();
    if (this.frame !== null) cancelAnimationFrame(this.frame); this.frame = null;
    this.outputAnalyser = null; this.outputOn = false; this.outputLast = 0; this.blocked = false; this.quietSince = null;
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; this.audio.muted = false; }
    return this.negotiate(true);
  }
  private rms(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    return Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
  }
  private sample = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const raw = this.rms(this.outputAnalyser);
    if (this.blocked) {
      if (raw >= 0.008) this.quietSince = null;
      else this.quietSince ??= now;
      if (this.quietSince !== null && now - this.quietSince >= DISPLAY_PAUSE_MS) {
        this.blocked = false; this.quietSince = null;
        if (this.audio) this.audio.muted = false;
      }
    }
    const audible = !this.blocked && this.audio && !this.audio.paused && !this.audio.muted ? raw : 0;
    if (audible >= 0.008) this.outputLast = now;
    const outputOn = !this.blocked && !!this.audio && !this.audio.paused && !this.audio.muted && this.outputLast > 0 && now - this.outputLast < 250;
    if (outputOn && !this.outputOn) this.outputStart = now;
    if (outputOn || this.outputOn) this.callbacks.playback({ rms: Math.min(1, audible * 5), playedMs: Math.max(0, now - this.outputStart), speaking: outputOn });
    this.outputOn = outputOn;
    this.frame = requestAnimationFrame(this.sample);
  };
  mute(muted: boolean): void {
    this.inputMuted = muted;
    this.microphone?.getAudioTracks().forEach(track => { track.enabled = !muted; });
  }
  interrupt(): void {
    this.blocked = true; this.quietSince = null;
    if (this.audio) this.audio.muted = true;
    if (this.outputOn) this.callbacks.playback({ rms: 0, playedMs: performance.now() - this.outputStart, speaking: false });
    this.outputOn = false;
  }
  async close(): Promise<void> {
    ++this.generation;
    this.disposed = true;
    this.cancelIce?.();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.microphone?.getTracks().forEach(track => track.stop()); this.microphone = null;
    this.releaseMicrophone?.(); this.releaseMicrophone = null;
    this.detachOutput?.(); this.detachOutput = null;
    this.channel?.close(); this.channel = null;
    this.peer?.close(); this.peer = null;
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; this.audio = null; }
    const context = this.context; this.context = null;
    if (context && context.state !== "closed") await context.close();
    this.outputAnalyser = null;
    this.inputAnalyser = null;
  }
}
