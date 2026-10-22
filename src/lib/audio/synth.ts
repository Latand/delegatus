/**
 * The synthesis engine of docs/design/sound-redesign.md §5.
 *
 * A sound is data: a list of strikes played on a timbre. One renderer turns
 * that data into oscillators, envelopes and filters on any BaseAudioContext,
 * so the same code plays live in the tab and renders offline for the render
 * check. No event sound fetches or decodes a file; the kept typing slices are
 * the one recorded material, and they are played through the same graph.
 *
 * The graph (§5.1):
 *
 *   event bus ─┐
 *              ├─ master ─ limiter ─ makeup⁻¹ ─ destination
 *   typing bus ┘
 */

/** The event sounds of the sound map (§3.1), named for what they tell. */
export type EventSoundId = "your-move" | "fault" | "reply" | "released" | "landed" | "launched" | "step";
/** The dictation pair, at its fixed quiet level and its old pitches. */
export type SmallSoundId = "dict-warn" | "dict-stop";
export type SoundId = EventSoundId | SmallSoundId;

export type PaletteId = "glass" | "wood";

/**
 * The palette the product plays: «Дерево», palette 2, the operator's choice
 * of 2026-10-22. One constant, so «Скло» is one word away.
 */
export const ACTIVE_PALETTE: PaletteId = "wood";

/** One resonant mode of the struck body. `decayScale` shortens upper modes. */
export interface Mode { ratio: number; gain: number; decayScale: number }

export interface Timbre {
  wave: OscillatorType;
  modes: readonly Mode[];
  /** Only the first n modes sound. */
  modeLimit?: number;
  /** Seconds, linear ramp from 0. */
  attack: number;
  /** > 0: each mode is a pair at ±detune, levels 0.6 and 0.4 (slow, shallow beating). */
  detuneCents?: number;
  /** A noise strike: the mallet hitting the bar. */
  mallet?: { bandHz: number; q: number; gain: number; length: number };
  lowpass: { hz: number; q: number };
}

export interface Strike {
  /** Seconds after the sound starts. */
  at: number;
  hz: number;
  /** 0..1, multiplies every mode gain. */
  vel: number;
  /** Seconds to −60 dB. */
  decay: number;
  /** Start pitch, exponential glide to `hz` over `glideTime`. */
  glideFrom?: number;
  glideTime?: number;
  /** Per-strike override (a low swell, a thud). */
  wave?: OscillatorType;
  attack?: number;
  vibrato?: { hz: number; cents: number };
}

export interface SoundSpec {
  strikes: readonly Strike[];
  /** Timbre overrides for this sound. */
  timbre?: Partial<Timbre>;
  /** For a coalesced batch of n events: strikes added to the gesture. */
  batch?: (n: number) => Strike[];
  /** LUFS momentary maximum at cue volume 1.0; sets the gain (§6.3). */
  loudness?: number;
  /** A fixed linear gain instead of a measured one (the dictation pair). */
  fixedGain?: number;
  /** Seconds until every node has stopped. */
  length: number;
}

export interface Palette {
  id: PaletteId;
  timbre: Timbre;
  /** Register shift of the palette, applied to every event sound's strikes. */
  shape: (strike: Strike) => Strike;
}

/** setTargetAtTime falls by e per time constant; ln(1000) of them is −60 dB. */
const TO_SIXTY_DB = Math.log(1000);

// ── Pitch ────────────────────────────────────────────────────────────────

const SEMITONE_FROM_A: Record<string, number> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };

/** Equal-tempered frequency of a note name: "D5" → 587.33, "F#6" → 1479.98. */
export function noteHz(note: string): number {
  const match = /^([A-G])(#|b)?(\d)$/.exec(note);
  if (!match) throw new Error(`not a note name: ${note}`);
  const [, letter, accidental, octave] = match;
  const shift = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
  const semitones = SEMITONE_FROM_A[letter!]! + shift + (Number(octave) - 4) * 12;
  return 440 * 2 ** (semitones / 12);
}

// ── Palettes (§5.2): one set of gestures, two bodies ─────────────────────

export const PALETTES: Record<PaletteId, Palette> = {
  /** Palette 1: pure sines, apart from the typing noise band. */
  glass: {
    id: "glass",
    timbre: {
      wave: "sine",
      modes: [
        { ratio: 1, gain: 1, decayScale: 1 },
        { ratio: 2, gain: 0.12, decayScale: 0.6 },
        { ratio: 3, gain: 0.04, decayScale: 0.35 },
      ],
      attack: 0.006,
      lowpass: { hz: 5000, q: 0.5 },
    },
    shape: (strike) => strike,
  },
  /** Palette 2: a marimba bar, one octave down, shorter. */
  wood: {
    id: "wood",
    timbre: {
      wave: "sine",
      modes: [
        { ratio: 1, gain: 1, decayScale: 1 },
        { ratio: 3.93, gain: 0.22, decayScale: 0.3 }, // the bar's own overtones,
        { ratio: 9.2, gain: 0.05, decayScale: 0.12 }, // not the harmonic series
      ],
      attack: 0.002,
      mallet: { bandHz: 2500, q: 1.5, gain: 0.18, length: 0.012 },
      lowpass: { hz: 4200, q: 0.5 },
    },
    shape: (strike) => ({
      ...strike,
      hz: strike.hz * 0.5,
      glideFrom: strike.glideFrom === undefined ? undefined : strike.glideFrom * 0.5,
      decay: strike.decay * 0.7,
    }),
  },
};

// ── The sounds (§5.3) ────────────────────────────────────────────────────
//
// Every pitch is in D major (D, E, F#, A, B), so overlapping sounds never
// clash; the dictation pair keeps its old pitches. The contour carries the
// meaning, and no two sounds share a figure.

const n = noteHz;

/** S4's run: the shared opening of «Landed» and «Released». */
const LANDED_RUN: readonly Strike[] = [
  { at: 0, hz: n("D5"), vel: 0.6, decay: 0.6 },
  { at: 0.07, hz: n("F#5"), vel: 0.65, decay: 0.6 },
  { at: 0.14, hz: n("A5"), vel: 0.7, decay: 0.6 },
  { at: 0.21, hz: n("D6"), vel: 0.9, decay: 1.6, vibrato: { hz: 5, cents: 6 } },
];

export const SOUNDS: Record<SoundId, SoundSpec> = {
  /** S6: a call repeated, as a knock at the door is; stays below D6. */
  "your-move": {
    strikes: [
      { at: 0, hz: n("F#5"), vel: 0.7, decay: 0.35 },
      { at: 0.12, hz: n("B5"), vel: 0.9, decay: 0.5 },
      { at: 0.4, hz: n("F#5"), vel: 0.7, decay: 0.35 },
      { at: 0.52, hz: n("B5"), vel: 1, decay: 1.0 },
    ],
    loudness: -14,
    length: 1.6,
  },
  /** S7: three notes falling, slowly beating (±2.5 cents), over a low drop. */
  fault: {
    timbre: { detuneCents: 2.5, lowpass: { hz: 3200, q: 0.5 } },
    strikes: [
      { at: 0, hz: n("A5"), vel: 0.85, decay: 0.5 },
      { at: 0.14, hz: n("F5"), vel: 0.85, decay: 0.5 },
      { at: 0.28, hz: n("D5"), vel: 1, decay: 1.1 },
      { at: 0, hz: n("D3"), vel: 0.6, decay: 0.3, wave: "triangle", glideFrom: n("G3"), glideTime: 0.12 },
    ],
    loudness: -16,
    length: 1.3,
  },
  /** S8: two notes falling a fourth, «message arrived». */
  reply: {
    strikes: [
      { at: 0, hz: n("E6"), vel: 0.8, decay: 0.5 },
      { at: 0.16, hz: n("B5"), vel: 0.7, decay: 0.9 },
    ],
    loudness: -20,
    length: 1.0,
  },
  /** S5: the landed run over a low swell, ending higher. */
  released: {
    strikes: [
      ...LANDED_RUN,
      { at: 0, hz: n("D4"), vel: 0.5, decay: 2.0, wave: "triangle", attack: 0.25 },
      { at: 0.42, hz: n("F#6"), vel: 0.5, decay: 1.4 },
    ],
    loudness: -18,
    length: 2.2,
  },
  /** S4: a quick major arpeggio up, the top note shimmering. */
  landed: {
    strikes: LANDED_RUN,
    /* A coalesced batch of n lanes adds up to three light grace notes. */
    batch: (count) =>
      Array.from({ length: Math.max(0, Math.min(count - 1, 3)) }, (_, k) => ({
        at: 0.4 + 0.09 * k, hz: n("E6"), vel: 0.3, decay: 0.4,
      })),
    loudness: -18,
    length: 1.8,
  },
  /** S9: a quick upward glide and a light answer. */
  launched: {
    strikes: [
      { at: 0, hz: n("A5"), vel: 0.6, decay: 0.25, glideFrom: n("A4"), glideTime: 0.09 },
      { at: 0.08, hz: n("E6"), vel: 0.4, decay: 0.35 },
    ],
    loudness: -23,
    length: 0.45,
  },
  /** S3: one short note, the quietest event sound. */
  step: {
    timbre: { modeLimit: 2, lowpass: { hz: 6000, q: 0.5 } },
    strikes: [{ at: 0, hz: n("A5"), vel: 0.7, decay: 0.45 }],
    loudness: -23,
    length: 0.5,
  },
  /** Two quick pings at the old pitch: never the one note of S3. */
  "dict-warn": {
    strikes: [
      { at: 0, hz: 660, vel: 0.8, decay: 0.2 },
      { at: 0.11, hz: 660, vel: 0.8, decay: 0.32 },
    ],
    fixedGain: 0.07,
    length: 0.8,
  },
  /** A low fall: recording has stopped. */
  "dict-stop": {
    strikes: [
      { at: 0, hz: n("C5"), vel: 1, decay: 0.3 },
      { at: 0.17, hz: n("E4"), vel: 1, decay: 0.62 },
    ],
    fixedGain: 0.07,
    length: 0.8,
  },
};

export const EVENT_SOUNDS: readonly EventSoundId[] = ["your-move", "fault", "reply", "released", "landed", "launched", "step"];

/**
 * Linear gain at cue volume 1.0 that brings each sound to its `loudness`,
 * per palette (§6.3): `10^((loudness − measured) / 20)`, where `measured` is
 * the sound's momentary maximum rendered alone at gain 1 by
 * {@link calibrateSounds}. Rendering is deterministic, so the measurement is
 * kept here rather than repeated in every tab; `src/lib/audio/synth.browser.test.ts`
 * renders every sound through Chromium's Web Audio, recalibrates, and fails
 * when a gain here drifts from what the engine measures.
 */
export const CALIBRATED_GAIN: Record<PaletteId, Record<EventSoundId, number>> = {
  glass: {
    "your-move": 0.5961,
    fault: 0.4354,
    reply: 0.3475,
    released: 0.2586,
    landed: 0.2946,
    launched: 0.5727,
    step: 0.4906,
  },
  wood: {
    "your-move": 0.7664,
    fault: 0.5081,
    reply: 0.4696,
    released: 0.3326,
    landed: 0.3761,
    launched: 0.7679,
    step: 0.6277,
  },
};

// ── The graph (§5.1) ─────────────────────────────────────────────────────

/** The limiter only catches overlaps; no single sound reaches it at the default volume. */
export const LIMIT = { thresholdDb: -10, ratio: 20, attack: 0.003, release: 0.15 } as const;
/**
 * A Web Audio compressor adds its own makeup gain, (1 / its gain at 0 dBFS)^0.6,
 * +5.7 dB at these settings. The graph takes it back out, so below the
 * threshold the limiter changes nothing.
 */
export const COMPRESSOR_MAKEUP_DB = -0.6 * (LIMIT.thresholdDb - LIMIT.thresholdDb / LIMIT.ratio);
/**
 * The compressor starts from a low-gain state and needs about 100 ms to
 * settle; a sound scheduled sooner comes out up to 5 dB quiet.
 */
export const GRAPH_SETTLE_SECONDS = 0.15;
/** Typing sits this far under an event sound while it plays (−9 dB, §6.4). */
export const TYPING_DUCKED = 0.35;
const DUCK_IN_SECONDS = 0.02;
const DUCK_OUT_SECONDS = 0.4;
/** A cut sound fades over this long (§6.2). */
export const CUT_FADE_SECONDS = 0.04;

export interface SoundGraph {
  context: BaseAudioContext;
  eventBus: GainNode;
  typingBus: GainNode;
  /** Context time before which nothing should be scheduled. */
  settledAt: number;
  /** Duck the typing bus under one event sound. Call in time order. */
  duckTyping(at: number, length: number): void;
}

/** Freeze a parameter at time t, keeping the value it has there. */
function holdAt(param: AudioParam, t: number, knownValue: number): void {
  const hold = (param as AudioParam & { cancelAndHoldAtTime?: (t: number) => void }).cancelAndHoldAtTime;
  if (typeof hold === "function") {
    hold.call(param, t);
  } else {
    /* Firefox has no cancelAndHoldAtTime; the caller knows the value there. */
    param.cancelScheduledValues(t);
    param.setValueAtTime(knownValue, t);
  }
}

export function createSoundGraph(context: BaseAudioContext, { makeupDb = 0 }: { makeupDb?: number } = {}): SoundGraph {
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = LIMIT.thresholdDb;
  limiter.knee.value = 0;
  limiter.ratio.value = LIMIT.ratio;
  limiter.attack.value = LIMIT.attack;
  limiter.release.value = LIMIT.release;

  const master = context.createGain();
  const eventBus = context.createGain();
  const typingBus = context.createGain();
  eventBus.connect(master);
  typingBus.connect(master);
  typingBus.gain.setValueAtTime(1, 0); // an anchor for cancelAndHoldAtTime
  const makeup = context.createGain();
  makeup.gain.value = 10 ** ((makeupDb - COMPRESSOR_MAKEUP_DB) / 20);
  master.connect(limiter).connect(makeup).connect(context.destination);

  let duckedUntil = -1;
  const typingLevelAt = (t: number): number =>
    t <= duckedUntil ? TYPING_DUCKED : Math.min(1, TYPING_DUCKED + ((1 - TYPING_DUCKED) * (t - duckedUntil)) / DUCK_OUT_SECONDS);

  return {
    context,
    eventBus,
    typingBus,
    settledAt: context.currentTime + GRAPH_SETTLE_SECONDS,
    duckTyping(at, length) {
      const gain = typingBus.gain;
      const end = Math.max(duckedUntil, at + length);
      holdAt(gain, at, typingLevelAt(at));
      gain.linearRampToValueAtTime(TYPING_DUCKED, at + DUCK_IN_SECONDS);
      gain.setValueAtTime(TYPING_DUCKED, end);
      gain.linearRampToValueAtTime(1, end + DUCK_OUT_SECONDS);
      duckedUntil = end;
    },
  };
}

/**
 * The one graph of a context, built on first use: the typing slices, the
 * event sounds and the dictation pair all share its buses and its limiter.
 */
const graphs = new WeakMap<BaseAudioContext, SoundGraph>();
export function soundGraphFor(context: BaseAudioContext): SoundGraph {
  let graph = graphs.get(context);
  if (!graph) {
    graph = createSoundGraph(context);
    graphs.set(context, graph);
  }
  return graph;
}

// ── One strike ───────────────────────────────────────────────────────────

/** One second of white noise per context, shared by every mallet. */
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

/** mulberry32: a tiny seeded generator, so the noise is the same every time. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noise(context: BaseAudioContext): AudioBuffer {
  let buffer = noiseBuffers.get(context);
  if (!buffer) {
    buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const samples = buffer.getChannelData(0);
    const random = seeded(0x5eed);
    for (let i = 0; i < samples.length; i++) samples[i] = random() * 2 - 1;
    noiseBuffers.set(context, buffer);
  }
  return buffer;
}

/**
 * Where in the noise buffer a strike's mallet reads, from the strike's own
 * time within its sound. The slice changes a struck sound's peak by up to
 * 1.8 dB, so it must not depend on when the sound happens to start; these
 * are the slices of the renders the design's level table was measured from
 * (the prototype started each sound 0.3 s into its render).
 */
function malletNoiseOffset(at: number): number {
  return ((0.3 + at) * 7.31) % 0.9;
}

/** A beating mode is two oscillators; unequal levels keep each dip shallow. */
const TWIN_WEIGHTS = [0.6, 0.4] as const;

/**
 * A struck body: one oscillator per resonant mode (a detuned pair when the
 * timbre beats), each with its own exponential decay, plus an optional
 * mallet of filtered noise. Upper modes die sooner, as on a real bar.
 */
function strike(context: BaseAudioContext, into: AudioNode, timbre: Timbre, note: Strike, start: number): void {
  const t = start + note.at;
  const attack = note.attack ?? timbre.attack;
  const modes = timbre.modes.slice(0, timbre.modeLimit ?? timbre.modes.length);
  const twins = timbre.detuneCents ? [-1, 1] : [0];

  for (const mode of modes) {
    twins.forEach((twin, which) => {
      const osc = context.createOscillator();
      osc.type = note.wave ?? timbre.wave;
      const target = note.hz * mode.ratio;
      const gliding = note.glideFrom !== undefined && note.glideTime !== undefined;
      const from = gliding ? note.glideFrom! * mode.ratio : target;
      /* The static value too: until the event at `t` applies, a param holds
         its default (440 Hz), and Chrome lets that leak into the first frames
         depending on where `t` falls in its 128-frame block. The leak moved
         a sound's peak by up to 1.8 dB with its start time. */
      osc.frequency.value = from;
      osc.frequency.setValueAtTime(from, t);
      if (gliding) osc.frequency.exponentialRampToValueAtTime(target, t + note.glideTime!);
      osc.detune.value = twin * (timbre.detuneCents ?? 0);

      /* A detuned pair sums to the level of one mode, so beating adds no loudness. */
      const level = note.vel * mode.gain * (timbre.detuneCents ? TWIN_WEIGHTS[which]! : 1);
      const decay = note.decay * mode.decayScale;
      const env = context.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(level, t + attack);
      env.gain.setTargetAtTime(0, t + attack, decay / TO_SIXTY_DB);

      const stop = t + attack + decay + 0.05;
      if (note.vibrato) {
        const lfo = context.createOscillator();
        const depth = context.createGain();
        lfo.frequency.value = note.vibrato.hz;
        depth.gain.value = note.vibrato.cents;
        lfo.connect(depth).connect(osc.detune);
        lfo.start(t);
        lfo.stop(stop);
      }
      osc.connect(env).connect(into);
      osc.start(t);
      osc.stop(stop);
    });
  }

  /* A swell is bowed, not struck: no mallet under a slow attack. */
  if (timbre.mallet && attack < 0.05) {
    const { bandHz, q, gain, length } = timbre.mallet;
    const source = context.createBufferSource();
    source.buffer = noise(context);
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = bandHz;
    band.Q.value = q;
    const env = context.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain * note.vel, t + 0.001);
    env.gain.setTargetAtTime(0, t + 0.001, length / TO_SIXTY_DB);
    source.connect(band).connect(env).connect(into);
    source.start(t, malletNoiseOffset(note.at));
    source.stop(t + length + 0.02);
  }
}

// ── One sound ────────────────────────────────────────────────────────────

export interface PlayingSound {
  /** Context time at which the sound has stopped. */
  end: number;
  /** Fade out over 40 ms from context time `t`. */
  cut(t: number): void;
}

export interface PlaySoundOptions {
  /** Context time to start at. */
  at: number;
  /** Cue volume (0..1), or any extra factor the caller multiplies in. */
  volume: number;
  pan?: number;
  /** Events coalesced into this play (S4 adds grace notes). */
  batch?: number;
  palette?: PaletteId;
  /** Override the calibrated gain (calibration passes 1). */
  gain?: number;
}

/**
 * Render one sound onto the graph:
 *
 *   strikes ─ sound lowpass ─ gain(calibrated × volume) ─ pan ─ event bus
 *
 * An event sound ducks the typing bus for its length; the dictation pair,
 * at its fixed quiet level, does not.
 */
export function playSound(graph: SoundGraph, id: SoundId, options: PlaySoundOptions): PlayingSound {
  const { context } = graph;
  const sound = SOUNDS[id];
  const palette = PALETTES[options.palette ?? ACTIVE_PALETTE];
  const timbre: Timbre = { ...palette.timbre, ...sound.timbre };
  const event = sound.fixedGain === undefined;
  const strikes = [...sound.strikes, ...(sound.batch ? sound.batch(options.batch ?? 1) : [])]
    /* The dictation pair keeps its old pitches in every palette. */
    .map((note) => (event ? palette.shape(note) : note));

  const lowpass = context.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = timbre.lowpass.hz;
  lowpass.Q.value = timbre.lowpass.q;
  const out = context.createGain();
  const base = sound.fixedGain ?? options.gain ?? CALIBRATED_GAIN[palette.id][id as EventSoundId];
  const level = base * options.volume;
  out.gain.setValueAtTime(level, options.at);
  let tail: AudioNode = out;
  if (typeof context.createStereoPanner === "function") {
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, options.pan ?? 0));
    out.connect(panner);
    tail = panner;
  }
  lowpass.connect(out);
  tail.connect(graph.eventBus);

  for (const note of strikes) strike(context, lowpass, timbre, note, options.at);
  if (event) graph.duckTyping(options.at, sound.length);

  return {
    end: options.at + sound.length,
    cut(t) {
      holdAt(out.gain, t, level);
      out.gain.linearRampToValueAtTime(0, t + CUT_FADE_SECONDS);
    },
  };
}

// ── Typing (§5.4, §5.5) ──────────────────────────────────────────────────

/** S2: the same slice, one room away (−14 dB). */
export const DISTANT_GAIN = 0.2;
/**
 * The room's 1400 Hz lowpass takes about 5.5 LU out of slices centred at
 * 3–5.5 kHz. Putting it back leaves S2 heard about 14 LU under S1.
 */
export const ROOM_LOSS_DB = 5.5;
export const DISTANT_RATE = 0.92;
export const DISTANT_PAN = 0.3;

export interface PlaySliceOptions {
  at: number;
  /** Final linear gain of the near slice (routine gain × cue volume). */
  gain: number;
  pan: number;
  /** S2: slowed, muffled, quieter, panned at random by the caller. */
  distant?: boolean;
}

/**
 * One typing slice on the typing bus. S1 plays it as recorded; S2 through
 *
 *   slice at rate 0.92 ─ lowpass 1400 Hz ─ gain × 0.2 × room loss ─ pan ─ typing bus
 */
export function playSlice(graph: SoundGraph, buffer: AudioBuffer, options: PlaySliceOptions): AudioBufferSourceNode {
  const { context } = graph;
  const source = context.createBufferSource();
  source.buffer = buffer;
  const gain = context.createGain();
  gain.gain.value = options.gain * (options.distant ? DISTANT_GAIN * 10 ** (ROOM_LOSS_DB / 20) : 1);
  let input: AudioNode = gain;
  if (options.distant) {
    source.playbackRate.value = DISTANT_RATE;
    const room = context.createBiquadFilter();
    room.type = "lowpass";
    room.frequency.value = 1400;
    room.Q.value = 0.7;
    room.connect(gain);
    input = room;
  }
  let tail: AudioNode = gain;
  if (typeof context.createStereoPanner === "function") {
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, options.pan));
    gain.connect(panner);
    tail = panner;
  }
  tail.connect(graph.typingBus);
  source.connect(input);
  source.start(options.at);
  return source;
}

// ── Loudness (§6.3) ──────────────────────────────────────────────────────

interface Biquad { b: readonly [number, number, number]; a: readonly [number, number] }

/**
 * The K-weighting of ITU-R BS.1770 at any sample rate: a high shelf (+4 dB
 * above about 1.7 kHz) and a high-pass at 38 Hz, with libebur128's constants.
 */
function kWeighting(rate: number): Biquad[] {
  let k = Math.tan((Math.PI * 1681.974450955533) / rate);
  const vh = 10 ** (3.999843853973347 / 20);
  const vb = vh ** 0.4996667741545416;
  let q = 0.7071752369554196;
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b: [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0],
    a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0],
  };
  k = Math.tan((Math.PI * 38.13547087602444) / rate);
  q = 0.5003270373238773;
  a0 = 1 + k / q + k * k;
  const highpass: Biquad = { b: [1, -2, 1], a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0] };
  return [shelf, highpass];
}

function filter(samples: Float32Array, { b, a }: Biquad): Float32Array {
  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]!;
    const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

export interface Loudness {
  /** EBU R 128 momentary maximum (K-weighted, 400 ms every 100 ms), LUFS. */
  momentaryMax: number;
  /** Sample peak, dBFS. */
  peakDb: number;
}

/**
 * The momentary maximum and sample peak of rendered channels. A struck
 * sound's loudness is what its overlapping tails add up to, which no single
 * strike's level shows; this is what each gain is set from.
 */
export function measureLoudness(channels: readonly Float32Array[], sampleRate: number): Loudness {
  const weights = kWeighting(sampleRate);
  const prefixes: Float64Array[] = [];
  let peak = 0;
  let length = 0;
  for (const raw of channels) {
    length = raw.length;
    for (const sample of raw) peak = Math.max(peak, Math.abs(sample));
    const weighted = weights.reduce(filter, raw);
    const prefix = new Float64Array(weighted.length + 1);
    for (let i = 0; i < weighted.length; i++) prefix[i + 1] = prefix[i]! + weighted[i]! * weighted[i]!;
    prefixes.push(prefix);
  }
  const width = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  let loudest = 0;
  for (let start = 0; start + width <= length; start += hop) {
    let sum = 0;
    for (const prefix of prefixes) sum += (prefix[start + width]! - prefix[start]!) / width;
    loudest = Math.max(loudest, sum);
  }
  const db = (x: number) => (x > 0 ? 10 * Math.log10(x) : -Infinity);
  return { momentaryMax: -0.691 + db(loudest), peakDb: 2 * db(peak) };
}

export type OfflineContextFactory = (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

const CALIBRATION_RATE = 48000;

/** Render one sound alone on a bare bus, at `gain`, and measure it. */
export async function renderAlone(
  offline: OfflineContextFactory,
  id: EventSoundId,
  palette: PaletteId,
  gain: number,
): Promise<Loudness> {
  const context = offline(2, Math.ceil((SOUNDS[id].length + 0.2) * CALIBRATION_RATE), CALIBRATION_RATE);
  const bus = context.createGain();
  bus.connect(context.destination);
  const graph: SoundGraph = { context, eventBus: bus, typingBus: bus, settledAt: 0, duckTyping() {} };
  playSound(graph, id, { at: 0, volume: 1, gain, palette });
  const rendered = await context.startRendering();
  const channels = Array.from({ length: rendered.numberOfChannels }, (_, c) => rendered.getChannelData(c));
  return measureLoudness(channels, rendered.sampleRate);
}

/**
 * Measure every event sound alone at gain 1 in `palette` and answer the gain
 * that brings it to its target loudness at cue volume 1.0 — the procedure
 * behind {@link CALIBRATED_GAIN}.
 */
export async function calibrateSounds(offline: OfflineContextFactory, palette: PaletteId): Promise<Record<EventSoundId, number>> {
  const gains = {} as Record<EventSoundId, number>;
  for (const id of EVENT_SOUNDS) {
    const alone = await renderAlone(offline, id, palette, 1);
    gains[id] = 10 ** ((SOUNDS[id].loudness! - alone.momentaryMax) / 20);
  }
  return gains;
}

/**
 * Render one sound through the whole product graph (buses, limiter, makeup
 * taken back out), started after the graph has settled, at cue volume
 * `volume` (`delay` seconds later still), and measure it. This is what the
 * render check compares with the
 * design's level table.
 */
export async function renderThroughGraph(
  offline: OfflineContextFactory,
  id: EventSoundId,
  { volume, palette = ACTIVE_PALETTE, delay = 0 }: { volume: number; palette?: PaletteId; delay?: number },
): Promise<Loudness> {
  const length = GRAPH_SETTLE_SECONDS + delay + SOUNDS[id].length + 0.3;
  const context = offline(2, Math.ceil(length * CALIBRATION_RATE), CALIBRATION_RATE);
  const graph = createSoundGraph(context);
  playSound(graph, id, { at: graph.settledAt + delay, volume, palette });
  const rendered = await context.startRendering();
  const channels = Array.from({ length: rendered.numberOfChannels }, (_, c) => rendered.getChannelData(c));
  return measureLoudness(channels, rendered.sampleRate);
}
