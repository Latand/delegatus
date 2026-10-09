import { expect, test } from "bun:test";
import { configureAudioPrefsStorage, CUES_ENABLED_KEY } from "@/lib/audio/prefs";
import { createBrowserCues, CUE_CLOSE_MS, CUE_PEAK_GAIN, CUE_TONES } from "./cues";

/** A recording AudioContext: every oscillator, its frequency and schedule, and every gain value ever set. */
function fakeAudio() {
  const log = { contexts: 0, closed: 0, resumed: 0, oscillators: [] as Array<{ type: string; hz: number; start: number | null; stop: number | null }>, gains: [] as number[], gainNodes: 0, connections: 0 };
  class Param { setValueAtTime(value: number) { log.gains.push(value); } linearRampToValueAtTime(value: number) { log.gains.push(value); } exponentialRampToValueAtTime(value: number) { log.gains.push(value); } }
  class Context {
    currentTime = 10; state = "running"; destination = {};
    constructor() { log.contexts += 1; }
    async resume() { log.resumed += 1; }
    async close() { log.closed += 1; this.state = "closed"; }
    createGain() { log.gainNodes += 1; return { gain: new Param(), connect() { log.connections += 1; } }; }
    createOscillator() {
      const row = { type: "", hz: 0, start: null as number | null, stop: null as number | null };
      log.oscillators.push(row);
      return {
        set type(value: string) { row.type = value; }, frequency: { set value(hz: number) { row.hz = hz; }, setValueAtTime(hz: number) { row.hz = hz; } },
        connect() { log.connections += 1; }, start(at: number) { row.start = at; }, stop(at: number) { row.stop = at; },
      };
    }
  }
  return { log, factory: () => new Context() as unknown as AudioContext };
}

test("the connect cue is two quiet rising tones and the disconnect cue the same two falling, each under 250 ms, with nothing fetched or decoded", async () => {
  const fetches: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => { fetches.push(input); return new Response(""); }) as typeof fetch;
  try {
    const audio = fakeAudio();
    const cues = createBrowserCues(audio.factory);
    cues.prepare();
    cues.connect();
    expect(audio.log.oscillators.map((row) => [row.type, row.hz])).toEqual([["sine", CUE_TONES.low], ["sine", CUE_TONES.high]]);
    cues.disconnect();
    expect(audio.log.oscillators.slice(2).map((row) => row.hz)).toEqual([CUE_TONES.high, CUE_TONES.low]);
    for (const first of [0, 2]) {
      const [a, b] = audio.log.oscillators.slice(first, first + 2);
      expect(a!.start).not.toBeNull();
      expect(b!.stop! - a!.start!).toBeLessThan(0.25);
    }
    expect(Math.max(...audio.log.gains)).toBeLessThanOrEqual(CUE_PEAK_GAIN);
    expect(CUE_PEAK_GAIN).toBeLessThanOrEqual(0.05);
    expect(fetches).toEqual([]);
    /* One context for the whole session, created on prepare and closed on dispose. */
    expect(audio.log.contexts).toBe(1);
    cues.dispose();
    /* A cue that sounds as the page leaves is not cut off. */
    expect(audio.log.closed).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, CUE_CLOSE_MS + 50));
    expect(audio.log.closed).toBe(1);
  } finally { globalThis.fetch = realFetch; }
});

test("the header sound switch governs the cues: muted plays nothing, and unmuting mid-session brings them back", () => {
  let enabled = false;
  const audio = fakeAudio();
  const cues = createBrowserCues(audio.factory, () => enabled);
  cues.prepare();
  cues.connect();
  cues.disconnect();
  expect(audio.log.oscillators).toEqual([]);
  enabled = true;
  cues.connect();
  expect(audio.log.oscillators.map((row) => row.hz)).toEqual([CUE_TONES.low, CUE_TONES.high]);
});

test("with no switch handed over, the cues read the device's own sound preference", () => {
  const stored = new Map<string, string>([[CUES_ENABLED_KEY, "off"]]);
  configureAudioPrefsStorage({ getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); } });
  try {
    const audio = fakeAudio();
    const cues = createBrowserCues(audio.factory);
    cues.connect();
    expect(audio.log.oscillators).toEqual([]);
    stored.set(CUES_ENABLED_KEY, "on");
    cues.connect();
    expect(audio.log.oscillators).toHaveLength(2);
  } finally { configureAudioPrefsStorage(undefined); }
});

test("a cue is best effort: a browser with no audio, or one that refuses, plays nothing and throws nothing", () => {
  const refusing = createBrowserCues(() => { throw new Error("NotAllowedError"); });
  expect(() => { refusing.prepare(); refusing.connect(); refusing.disconnect(); refusing.dispose(); }).not.toThrow();
  const audio = fakeAudio();
  const cues = createBrowserCues(audio.factory);
  /* A cue without a prepare (the context closed since) opens its own. */
  cues.connect();
  expect(audio.log.oscillators).toHaveLength(2);
  cues.dispose();
  cues.disconnect();
  expect(audio.log.contexts).toBe(2);
});
