import { describe, expect, test } from "bun:test";

import {
  ACTIVE_PALETTE,
  CALIBRATED_GAIN,
  COMPRESSOR_MAKEUP_DB,
  EVENT_SOUNDS,
  measureLoudness,
  noteHz,
  PALETTES,
  SOUNDS,
  type SoundId,
  type SoundSpec,
} from "./synth";

/*
 * The sound table of docs/design/sound-redesign.md §5 as data. What it sounds
 * like is the render check's business (synth.browser.test.ts, in Chromium);
 * these are the properties the table itself has to keep.
 */

describe("the palette", () => {
  test("the product plays palette 2, «Wood», and Glass is one constant away", () => {
    expect(ACTIVE_PALETTE).toBe("wood");
    for (const palette of ["glass", "wood"] as const) {
      for (const id of EVENT_SOUNDS) expect(CALIBRATED_GAIN[palette][id]).toBeGreaterThan(0);
    }
  });

  test("Wood is one octave down and 30% shorter; Glass plays the table as written", () => {
    const strike = { at: 0.1, hz: 880, vel: 0.5, decay: 1, glideFrom: 440, glideTime: 0.09 };
    expect(PALETTES.wood.shape(strike)).toEqual({ ...strike, hz: 440, glideFrom: 220, decay: 0.7 });
    expect(PALETTES.glass.shape(strike)).toEqual(strike);
  });

  test("Wood is a marimba bar: its own overtone ratios and a mallet", () => {
    expect(PALETTES.wood.timbre.modes.map((mode) => mode.ratio)).toEqual([1, 3.93, 9.2]);
    expect(PALETTES.wood.timbre.mallet).toEqual({ bandHz: 2500, q: 1.5, gain: 0.18, length: 0.012 });
    expect(PALETTES.glass.timbre.mallet).toBeUndefined();
  });

  test("the compressor's own makeup (+5.7 dB) is what the graph takes back out", () => {
    expect(COMPRESSOR_MAKEUP_DB).toBeCloseTo(5.7, 6);
  });
});

describe("the sounds", () => {
  const PITCH_CLASSES_D_MAJOR = new Set([2, 4, 6, 9, 11]); // D E F# A B, C = 0
  const pitchClass = (hz: number) => (((Math.round(12 * Math.log2(hz / noteHz("C4"))) % 12) + 12) % 12);

  test("every event pitch is in D major, but for the minor third of the falling fault", () => {
    /* §5.3's table writes S7 as A5 → F5 → D5 (698.46 Hz): the one figure that
       falls into D minor, the colour a fault should have. Every other pitch is
       D, E, F#, A or B, so overlapping sounds never clash. */
    const outside: string[] = [];
    for (const id of EVENT_SOUNDS) {
      for (const strike of SOUNDS[id].strikes) {
        if (!PITCH_CLASSES_D_MAJOR.has(pitchClass(strike.hz))) outside.push(`${id}@${strike.hz.toFixed(2)}`);
      }
    }
    expect(outside).toEqual(["fault@698.46"]);
  });

  test("the dictation pair keeps its old pitches: E5 pings, C5 → E4", () => {
    expect(SOUNDS["dict-warn"].strikes.map((s) => s.hz)).toEqual([660, 660]);
    expect(SOUNDS["dict-stop"].strikes.map((s) => Math.round(s.hz))).toEqual([523, 330]);
    expect(SOUNDS["dict-warn"].fixedGain).toBe(0.07);
    expect(SOUNDS["dict-stop"].fixedGain).toBe(0.07);
  });

  test("the targets keep the order S6 > S7 > S5 = S4 > S8 > S9 = S3, 2 LU apart", () => {
    const lufs = (id: SoundId) => SOUNDS[id].loudness!;
    expect([lufs("your-move"), lufs("fault"), lufs("released"), lufs("landed"), lufs("reply"), lufs("launched"), lufs("step")])
      .toEqual([-14, -16, -18, -18, -20, -23, -23]);
  });

  test("a batch of n landings adds min(n − 1, 3) E6 grace notes from 0.40 s", () => {
    const batch = SOUNDS.landed.batch!;
    expect(batch(1)).toEqual([]);
    expect(batch(3).map((s) => s.at)).toEqual([0.4, 0.49]);
    expect(batch(9)).toHaveLength(3);
    expect(batch(9).every((s) => Math.round(s.hz) === Math.round(noteHz("E6")))).toBe(true);
  });

  /**
   * The design's distinctness rule (§5.3), as the prototype's «Rules check»
   * states it: two sounds read as one figure when they move the same way
   * through the same number of notes with onsets within 50 ms, and either land
   * on the same pitches or have one note only. A strike with its own wave (a
   * thud, a swell) accompanies the melody and is left out.
   */
  function gesture(sound: SoundSpec) {
    const notes = sound.strikes.filter((s) => !s.wave).map((s) => ({ at: s.at, hz: s.hz })).sort((a, b) => a.at - b.at);
    const steps = notes.slice(1).map((note, i) => {
      const cents = 1200 * Math.log2(note.hz / notes[i]!.hz);
      return Math.abs(cents) < 50 ? "=" : cents > 0 ? "+" : "−";
    }).join("");
    const gaps = notes.slice(1).map((note, i) => note.at - notes[i]!.at);
    return { notes, steps, gaps };
  }
  function sameFigure(a: SoundSpec, b: SoundSpec): boolean {
    const ga = gesture(a);
    const gb = gesture(b);
    if (ga.notes.length !== gb.notes.length || ga.steps !== gb.steps) return false;
    if (ga.gaps.some((gap, i) => Math.abs(gap - gb.gaps[i]!) > 0.05)) return false;
    const samePitches = ga.notes.every((note, i) => Math.abs(1200 * Math.log2(note.hz / gb.notes[i]!.hz)) < 50);
    return ga.notes.length === 1 || samePitches;
  }

  test("no two sounds share a figure, the small ones included", () => {
    const ids = Object.keys(SOUNDS) as SoundId[];
    const clashes: string[] = [];
    ids.forEach((a, i) => ids.slice(i + 1).forEach((b) => {
      if (sameFigure(SOUNDS[a], SOUNDS[b])) clashes.push(`${a}/${b}`);
    }));
    expect(clashes).toEqual([]);
  });

  test("the rule catches the collisions the design fixed: one-ping dict-warn against S3", () => {
    const onePing: SoundSpec = { strikes: [{ at: 0, hz: 660, vel: 0.8, decay: 0.32 }], length: 0.5 };
    expect(sameFigure(onePing, SOUNDS.step)).toBe(true);
  });

  test("S6 is the only rising sound that stops below D6", () => {
    const top = (id: SoundId) => Math.max(...SOUNDS[id].strikes.filter((s) => !s.wave).map((s) => s.hz));
    expect(top("your-move")).toBeLessThan(noteHz("D6") - 1);
    for (const id of ["landed", "released", "launched"] as const) expect(top(id)).toBeGreaterThanOrEqual(noteHz("D6") - 1);
  });
});

describe("the loudness meter (EBU R 128 momentary, sample peak)", () => {
  const RATE = 48000;
  const sine = (amplitude: number, hz = 997, seconds = 1) =>
    Float32Array.from({ length: RATE * seconds }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / RATE));

  test("a stereo 997 Hz sine at −18 dBFS reads −18 LUFS and peaks at −18 dBFS", () => {
    const amplitude = 10 ** (-18 / 20);
    const measured = measureLoudness([sine(amplitude), sine(amplitude)], RATE);
    expect(measured.momentaryMax).toBeCloseTo(-18, 1);
    expect(measured.peakDb).toBeCloseTo(-18, 1);
  });

  test("one channel alone is 3 LU quieter", () => {
    const measured = measureLoudness([sine(10 ** (-18 / 20))], RATE);
    expect(measured.momentaryMax).toBeCloseTo(-21.01, 1);
  });

  test("the maximum is the loudest 400 ms, not the average", () => {
    const quiet = sine(0.01, 997, 2);
    quiet.set(sine(0.5, 997, 0.4).subarray(0, RATE * 0.4), RATE);
    const measured = measureLoudness([quiet, quiet], RATE);
    expect(measured.momentaryMax).toBeCloseTo(20 * Math.log10(0.5), 0);
  });

  test("silence has no loudness", () => {
    expect(measureLoudness([new Float32Array(RATE)], RATE).momentaryMax).toBe(-Infinity);
  });
});
