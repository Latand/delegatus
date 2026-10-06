export interface MediaCallbacks {
  playback(sample: { rms: number; playedMs: number; speaking: boolean }): void;
  input(speaking: boolean): void;
  lost(code: string): void;
}
export interface CompanionMedia {
  open(): Promise<string>;
  answer(sdp: string): Promise<void>;
  mute(muted: boolean): void;
  interrupt(): void;
  close(): Promise<void>;
}

/** Browser media only. Fresh duplex handling; no composer code is imported.
 * The model manages duplex audio. Local speech detection updates playback
 * presentation and drops audio during an explicit interruption. */
export class BrowserCompanionMedia implements CompanionMedia {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private microphone: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private context: AudioContext | null = null;
  private inputAnalyser: AnalyserNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private frame: number | null = null;
  private disposed = false;
  private inputOn = false;
  private inputLast = 0;
  private outputOn = false;
  private outputLast = 0;
  private outputStart = 0;
  private blocked = false;
  private cancelIce: (() => void) | null = null;
  constructor(private readonly callbacks: MediaCallbacks) {}

  async open(): Promise<string> {
    try {
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.disposed) { microphone.getTracks().forEach(track => track.stop()); throw new Error("SESSION_CLOSED"); }
      this.microphone = microphone;
    } catch (error) { throw new Error(error instanceof Error && error.message === "SESSION_CLOSED" ? "SESSION_CLOSED" : "MICROPHONE_REFUSED"); }
    try {
      const peer = this.peer = new RTCPeerConnection();
      const context = this.context = new AudioContext();
      await context.resume();
      if (this.disposed) throw new Error("SESSION_CLOSED");
      const input = this.inputAnalyser = context.createAnalyser(); input.fftSize = 512;
      context.createMediaStreamSource(this.microphone!).connect(input);
      const audio = this.audio = new Audio(); audio.autoplay = true;
      peer.addEventListener("track", event => {
        if (this.disposed || event.track.kind !== "audio") return;
        const stream = new MediaStream([event.track]);
        audio.srcObject = stream;
        const output = this.outputAnalyser = context.createAnalyser(); output.fftSize = 512;
        context.createMediaStreamSource(stream).connect(output);
        void audio.play().catch(() => { if (!this.disposed) this.callbacks.lost("AUDIO_REFUSED"); });
      });
      peer.addEventListener("connectionstatechange", () => {
        if (!this.disposed && ["failed", "closed"].includes(peer.connectionState)) this.callbacks.lost("PROVIDER_ERROR");
      });
      for (const track of this.microphone!.getAudioTracks()) peer.addTrack(track, this.microphone!);
      this.channel = peer.createDataChannel("oai-events");
      // Sideband owns every application effect. The frontend channel cannot
      // write provider commands and never forwards tool events to the server.
      this.channel.addEventListener("close", () => { if (!this.disposed) this.callbacks.lost("PROVIDER_ERROR"); });
      await peer.setLocalDescription(await peer.createOffer());
      if (this.disposed) throw new Error("SESSION_CLOSED");
      if (peer.iceGatheringState !== "complete") await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", changed); this.cancelIce = null; };
        const changed = () => { if (peer.iceGatheringState === "complete") { done(); resolve(); } };
        const timer = setTimeout(() => { done(); reject(new Error("PROVIDER_ERROR")); }, 10_000);
        this.cancelIce = () => { done(); reject(new Error("SESSION_CLOSED")); };
        peer.addEventListener("icegatheringstatechange", changed); changed();
      });
      if (this.disposed || !peer.localDescription?.sdp) throw new Error("SESSION_CLOSED");
      return peer.localDescription.sdp;
    } catch (error) { await this.close(); throw error instanceof Error && error.message === "SESSION_CLOSED" ? error : new Error("PROVIDER_ERROR"); }
  }
  async answer(sdp: string): Promise<void> {
    if (!this.peer || this.disposed) throw new Error("SESSION_CLOSED");
    await this.peer.setRemoteDescription({ type: "answer", sdp });
    if (this.disposed) throw new Error("SESSION_CLOSED");
    this.sample();
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
    const inputRms = this.rms(this.inputAnalyser);
    if (inputRms >= 0.035 && this.microphone?.getAudioTracks().some(track => track.enabled)) this.inputLast = now;
    const inputOn = now - this.inputLast < 200 && this.inputLast > 0;
    if (inputOn !== this.inputOn) { this.inputOn = inputOn; this.callbacks.input(inputOn); }
    const raw = this.rms(this.outputAnalyser);
    // Once an interrupted stream has gone quiet, a later spoken response can
    // play again. Microphone mute never mutes the companion's output.
    if (this.blocked && raw < 0.008 && !inputOn) { this.blocked = false; if (this.audio) this.audio.muted = false; }
    const audible = !this.blocked && this.audio && !this.audio.paused && !this.audio.muted ? raw : 0;
    if (audible >= 0.008) this.outputLast = now;
    const outputOn = !this.blocked && !!this.audio && !this.audio.paused && !this.audio.muted && this.outputLast > 0 && now - this.outputLast < 250;
    if (outputOn && !this.outputOn) this.outputStart = now;
    if (outputOn || this.outputOn) this.callbacks.playback({ rms: Math.min(1, audible * 5), playedMs: Math.max(0, now - this.outputStart), speaking: outputOn });
    this.outputOn = outputOn;
    this.frame = requestAnimationFrame(this.sample);
  };
  mute(muted: boolean): void { this.microphone?.getAudioTracks().forEach(track => { track.enabled = !muted; }); }
  interrupt(): void {
    this.blocked = true;
    if (this.audio) this.audio.muted = true;
    if (this.outputOn) this.callbacks.playback({ rms: 0, playedMs: performance.now() - this.outputStart, speaking: false });
    this.outputOn = false;
  }
  async close(): Promise<void> {
    this.disposed = true;
    this.cancelIce?.();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.microphone?.getTracks().forEach(track => track.stop()); this.microphone = null;
    this.channel?.close(); this.channel = null;
    this.peer?.close(); this.peer = null;
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; this.audio = null; }
    const context = this.context; this.context = null;
    if (context && context.state !== "closed") await context.close();
    this.inputAnalyser = null; this.outputAnalyser = null;
  }
}
