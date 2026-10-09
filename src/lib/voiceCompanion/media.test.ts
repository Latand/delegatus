import { afterEach, expect, test } from "bun:test";
import { BrowserCompanionMedia } from "./media";

const originals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});
const callbacks = () => ({ playback: () => {}, input: () => {}, lost: () => {} });

test("hangup while microphone permission is pending stops the subsequently granted tracks", async () => {
  let grant!: (value: MediaStream) => void;
  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => { stopped++; } }] } as unknown as MediaStream;
  install("navigator", { mediaDevices: { getUserMedia: () => new Promise<MediaStream>(resolve => { grant = resolve; }) } });
  const media = new BrowserCompanionMedia(callbacks());
  const opening = media.open();
  await media.close();
  grant(stream);
  await expect(opening).rejects.toThrow("SESSION_CLOSED");
  expect(stopped).toBe(1);
});

test("failed media setup and a repeated hangup release only owned microphone, peer and audio resources", async () => {
  let stopped = 0, peerClosed = 0, contextClosed = 0;
  const track = { enabled: true, stop: () => { stopped++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  install("navigator", { mediaDevices: { getUserMedia: async () => stream } });
  install("RTCPeerConnection", class extends EventTarget { close() { peerClosed++; } });
  install("AudioContext", class { state = "running"; async resume() { throw new Error("synthetic failure"); } async close() { contextClosed++; } });
  const media = new BrowserCompanionMedia(callbacks());
  await expect(media.open()).rejects.toThrow("PROVIDER_ERROR");
  await media.close();
  expect([stopped, peerClosed, contextClosed]).toEqual([1, 1, 1]);
});

test("hangup cancels an unfinished ICE gather immediately", async () => {
  let waiting!: () => void;
  const iceWaiting = new Promise<void>(resolve => { waiting = resolve; });
  const track = { stop() {} };
  install("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } });
  install("RTCPeerConnection", class extends EventTarget {
    iceGatheringState = "gathering";
    addTrack() {} createDataChannel() { return Object.assign(new EventTarget(), { close() {} }); }
    async createOffer() { return {}; } async setLocalDescription() {} close() {}
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
      super.addEventListener(type, listener, options);
      if (type === "icegatheringstatechange") waiting();
    }
  });
  install("AudioContext", class {
    state = "running"; async resume() {} async close() {}
    createAnalyser() { return {}; } createMediaStreamSource() { return { connect() {} }; }
  });
  install("Audio", class { pause() {} });
  const media = new BrowserCompanionMedia(callbacks());
  const opening = media.open();
  await iceWaiting;
  await media.close();
  await expect(opening).rejects.toThrow("SESSION_CLOSED");
});

test("played RMS drives the mouth; microphone mute preserves output and interruption yields until quiet", async () => {
  let clock = 100, inputRms = 0, outputRms = 0, frame: FrameRequestCallback | null = null;
  const track = { enabled: true, stop: () => {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class FakePeer extends EventTarget {
    static current: FakePeer;
    iceGatheringState = "complete"; localDescription = { sdp: "synthetic-offer" }; connectionState = "connected";
    constructor() { super(); FakePeer.current = this; }
    addTrack() {} createDataChannel() { return Object.assign(new EventTarget(), { close() {} }); }
    async createOffer() { return {}; } async setLocalDescription() {} async setRemoteDescription() {} close() {}
  }
  class FakeAudio {
    static current: FakeAudio;
    paused = true; muted = false; autoplay = false; srcObject: unknown = null;
    constructor() { FakeAudio.current = this; }
    async play() { this.paused = false; } pause() { this.paused = true; }
  }
  class FakeAnalyser {
    fftSize = 512;
    constructor(private readonly value: () => number) {}
    getFloatTimeDomainData(data: Float32Array) { data.fill(this.value()); }
  }
  install("performance", { now: () => clock });
  install("navigator", { mediaDevices: { getUserMedia: async () => stream } });
  install("RTCPeerConnection", FakePeer); install("Audio", FakeAudio);
  install("MediaStream", class {});
  install("AudioContext", class {
    state = "running"; async resume() {} async close() {}
    createAnalyser() { return new FakeAnalyser(() => outputRms); }
    createMediaStreamSource(source: unknown) { return { connect(analyser: FakeAnalyser) { if (source === stream) Object.assign(analyser, { getFloatTimeDomainData: (data: Float32Array) => data.fill(inputRms) }); } }; }
  });
  install("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
  install("cancelAnimationFrame", () => { frame = null; });
  const inputs: boolean[] = [];
  const samples: Array<{ rms: number; speaking: boolean }> = [];
  const media = new BrowserCompanionMedia({ ...callbacks(), input: value => { inputs.push(value); if (value) media.interrupt(); }, playback: sample => samples.push(sample) });
  await media.open();
  const peer = FakePeer.current, audio = FakeAudio.current;
  peer.dispatchEvent(Object.assign(new Event("track"), { track: { kind: "audio" } }));
  await media.answer("synthetic-answer");
  outputRms = 0.1;
  const tick = () => (frame as unknown as FrameRequestCallback)(performance.now());
  tick();
  expect(samples.at(-1)!.speaking).toBe(true);
  expect(samples.at(-1)!.rms).toBeCloseTo(0.5, 6);
  media.mute(true); inputRms = 0.1; tick();
  expect(track.enabled).toBe(false);
  expect(audio.muted).toBe(false);
  expect(samples.at(-1)!.speaking).toBe(true);
  media.mute(false);
  for (let ms = 0; ms < 14_000; ms += 1000 / 60) {
    clock = 100 + ms;
    outputRms = ms % 310 < 240 && ms % 4340 < 3140 ? 0.1 : 0;
    inputRms = outputRms ? 0.04 : 0;
    tick();
    expect(audio.muted).toBe(false);
  }
  expect(inputs).toEqual([]);
  outputRms = 0.1;
  media.interrupt(); tick();
  expect(audio.muted).toBe(true);
  expect(samples.at(-1)!.speaking).toBe(false);
  outputRms = 0; tick();
  clock += 600; tick();
  expect(audio.muted).toBe(true);
  clock += 900; tick();
  expect(audio.muted).toBe(false);
  outputRms = 0.1; tick();
  expect(samples.at(-1)!.speaking).toBe(true);
  await media.close();
  expect(frame).toBeNull();
});
