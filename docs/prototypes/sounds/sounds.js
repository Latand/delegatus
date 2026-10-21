/* The sound table of docs/design/sound-redesign.md §5.2–§5.3.
 *
 * Every pitch is in D major (D, E, F#, A, B) so overlapping sounds never
 * clash; the dictation pair keeps its old pitches. Contours carry meaning:
 * the two sounds that need the operator are the loudest, and no two sounds
 * share a gesture (§5.3, the contour table; `contourCheck` below). */
(() => {
  const DS = window.DelegatusSounds;

  // ── Palettes: one set of gestures, two bodies ──────────────────────────

  /** Palette 1, recommended: pure sines, apart from the typing noise band. */
  const glass = {
    id: "glass",
    number: 1,
    name: { uk: "Скло", en: "Glass" },
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
    shape: (note) => note,
  };

  /** Palette 2: a marimba bar, one octave down, shorter. */
  const wood = {
    id: "wood",
    number: 2,
    name: { uk: "Дерево", en: "Wood" },
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
    shape: (note) => ({
      ...note,
      hz: note.hz * 0.5,
      glideFrom: note.glideFrom && note.glideFrom * 0.5,
      decay: note.decay * 0.7,
    }),
  };

  // ── The sounds ─────────────────────────────────────────────────────────
  //
  // A strike: { at (s), note or hz, vel 0..1, decay (s to −60 dB), extras }.
  // `loudness` is the momentary maximum, in LUFS, the sound reaches at cue
  // volume 1.0; DS.calibrate measures each sound and sets its gain to match,
  // in each palette. The default volume 0.4 is 8 dB lower. The order, at
  // least 2 LU apart: S6 > S7 > S5 = S4 > S8 > S9 = S3, and S3 still 4 LU
  // or more over typing. S6 sits 1 LU under today's attention cue.

  /** S4's run: the shared opening of «Landed» and «Released». */
  const LANDED_RUN = [
    { at: 0, note: "D5", vel: 0.6, decay: 0.6 },
    { at: 0.07, note: "F#5", vel: 0.65, decay: 0.6 },
    { at: 0.14, note: "A5", vel: 0.7, decay: 0.6 },
    { at: 0.21, note: "D6", vel: 0.9, decay: 1.6, vibrato: { hz: 5, cents: 6 } },
  ];

  const SOUNDS = {
    "your-move": {
      code: "S6",
      name: { uk: "Ваш хід", en: "Your move" },
      // A call repeated, as a knock at the door is: the only sound that
      // repeats a figure, and the only rising one that stays below D6.
      strikes: [
        { at: 0, note: "F#5", vel: 0.7, decay: 0.35 },
        { at: 0.12, note: "B5", vel: 0.9, decay: 0.5 },
        { at: 0.4, note: "F#5", vel: 0.7, decay: 0.35 },
        { at: 0.52, note: "B5", vel: 1, decay: 1.0 },
      ],
      loudness: -14,
      length: 1.6,
    },

    fault: {
      code: "S7",
      name: { uk: "Збій", en: "Fault" },
      // Three notes falling, slowly beating, over a low drop. ±2.5 cents
      // beats at 1.7 Hz on D5 (0.85 Hz in palette 2): a slow sway.
      timbre: { detuneCents: 2.5, lowpass: { hz: 3200, q: 0.5 } },
      strikes: [
        { at: 0, note: "A5", vel: 0.85, decay: 0.5 },
        { at: 0.14, note: "F5", vel: 0.85, decay: 0.5 },
        { at: 0.28, note: "D5", vel: 1, decay: 1.1 },
        { at: 0, note: "D3", vel: 0.6, decay: 0.3, wave: "triangle", glideFrom: "G3", glideTime: 0.12 },
      ],
      loudness: -16,
      length: 1.3,
    },

    reply: {
      code: "S8",
      name: { uk: "Відповідь", en: "Reply" },
      // Two notes falling a fourth: the familiar «message arrived». Above
      // the call-ended pair (D6→A5, 90 ms) and slower, so the two never
      // read as one figure while a call is on.
      strikes: [
        { at: 0, note: "E6", vel: 0.8, decay: 0.5 },
        { at: 0.16, note: "B5", vel: 0.7, decay: 0.9 },
      ],
      loudness: -20,
      length: 1.0,
    },

    released: {
      code: "S5",
      name: { uk: "Випущено", en: "Released" },
      // The landed run over a low swell, ending higher.
      strikes: [
        ...LANDED_RUN,
        { at: 0, note: "D4", vel: 0.5, decay: 2.0, wave: "triangle", attack: 0.25 },
        { at: 0.42, note: "F#6", vel: 0.5, decay: 1.4 },
      ],
      loudness: -18,
      length: 2.2,
    },

    landed: {
      code: "S4",
      name: { uk: "Злито", en: "Landed" },
      // A quick major arpeggio up, the top note shimmering.
      strikes: LANDED_RUN,
      // A coalesced batch of n lanes adds up to three light grace notes.
      batch: (n) =>
        Array.from({ length: Math.min(n - 1, 3) }, (_, k) => ({
          at: 0.4 + 0.09 * k, note: "E6", vel: 0.3, decay: 0.4,
        })),
      loudness: -18,
      length: 1.8,
    },

    launched: {
      code: "S9",
      name: { uk: "Запущено", en: "Launched" },
      // A quick upward glide and a light answer.
      strikes: [
        { at: 0, note: "A5", vel: 0.6, decay: 0.25, glideFrom: "A4", glideTime: 0.09 },
        { at: 0.08, note: "E6", vel: 0.4, decay: 0.35 },
      ],
      loudness: -23,
      length: 0.45,
    },

    step: {
      code: "S3",
      name: { uk: "Крок", en: "Step" },
      // One short note: the quietest event sound.
      timbre: { modeLimit: 2, lowpass: { hz: 6000, q: 0.5 } },
      strikes: [{ at: 0, note: "A5", vel: 0.7, decay: 0.45 }],
      loudness: -23,
      length: 0.5,
    },

    // The small sounds keep their triggers and their fixed quiet levels.

    "voice-connect": {
      code: "V+",
      name: { uk: "Дзвінок почався", en: "Call connected" },
      strikes: [
        { at: 0, note: "A5", vel: 1, decay: 0.12 },
        { at: 0.09, note: "D6", vel: 1, decay: 0.12 },
      ],
      fixedGain: 0.05,
      length: 0.25,
    },

    "voice-disconnect": {
      code: "V−",
      name: { uk: "Дзвінок закінчився", en: "Call ended" },
      strikes: [
        { at: 0, note: "D6", vel: 1, decay: 0.12 },
        { at: 0.09, note: "A5", vel: 1, decay: 0.12 },
      ],
      fixedGain: 0.05,
      length: 0.25,
    },

    "dict-warn": {
      code: "D!",
      name: { uk: "Диктування: ліміт близько", en: "Dictation: near the cap" },
      // Two quick pings at the old pitch: a warning, and never the one
      // note of S3, which can play while the operator dictates.
      strikes: [
        { at: 0, hz: 660, vel: 0.8, decay: 0.2 },
        { at: 0.11, hz: 660, vel: 0.8, decay: 0.32 },
      ],
      fixedGain: 0.07,
      length: 0.8,
    },

    "dict-stop": {
      code: "D■",
      name: { uk: "Диктування зупинено", en: "Dictation stopped" },
      strikes: [
        { at: 0, note: "C5", vel: 1, decay: 0.3 },
        { at: 0.17, note: "E4", vel: 1, decay: 0.62 },
      ],
      fixedGain: 0.07,
      length: 0.8,
    },
  };

  /** Highest first: who wins the one event lane (§6.2). */
  const PRIORITY = ["your-move", "fault", "reply", "released", "landed", "launched", "step"];

  // ── Checks the page lists under «Rules check» ──────────────────────────

  /**
   * A sound's gesture: its melody notes in time order. A strike with its own
   * wave (S7's thud, S5's swell) accompanies the melody and is left out.
   */
  function gesture(sound) {
    const notes = sound.strikes
      .filter((strike) => !strike.wave)
      .map((strike) => ({ at: strike.at, hz: strike.hz ?? DS.hz(strike.note) }))
      .sort((a, b) => a.at - b.at);
    const steps = notes.slice(1).map((note, i) => {
      const cents = 1200 * Math.log2(note.hz / notes[i].hz);
      return Math.abs(cents) < 50 ? "=" : cents > 0 ? "+" : "−";
    });
    const gaps = notes.slice(1).map((note, i) => note.at - notes[i].at);
    return { notes, steps: steps.join(""), gaps };
  }

  /**
   * Two sounds read as one figure when they move the same way through the
   * same number of notes with onsets within 50 ms of each other, and either
   * land on the same pitches or have one note only: a single note has no
   * contour, so pitch height alone would have to tell it apart, and rhythm
   * is what listeners with weak pitch discrimination hear first.
   */
  function sameFigure(a, b) {
    const ga = gesture(a);
    const gb = gesture(b);
    if (ga.notes.length !== gb.notes.length || ga.steps !== gb.steps) return false;
    if (ga.gaps.some((gap, i) => Math.abs(gap - gb.gaps[i]) > 0.05)) return false;
    const samePitches = ga.notes.every((note, i) => Math.abs(1200 * Math.log2(note.hz / gb.notes[i].hz)) < 50);
    return ga.notes.length === 1 || samePitches;
  }

  function soundChecks() {
    const all = Object.values(SOUNDS);
    const clashes = [];
    all.forEach((a, i) => all.slice(i + 1).forEach((b) => {
      if (sameFigure(a, b)) clashes.push(`${a.code}/${b.code}`);
    }));
    const checks = [{
      name: {
        en: `No two sounds share a figure (direction, pitches, onsets within 50 ms)${clashes.length ? `: ${clashes.join(", ")}` : ""}`,
        uk: `Жодні два звуки не мають однієї фігури (напрям, ноти, вступи в межах 50 мс)${clashes.length ? `: ${clashes.join(", ")}` : ""}`,
      },
      pass: clashes.length === 0,
    }];

    // After DS.calibrate: each sound alone at the default volume stays under
    // the −10 dB limiter, which is there for overlaps only (§5.1).
    if (Object.keys(DS.measured).length) {
      const over = [];
      for (const palette of [glass, wood]) {
        for (const sound of all) {
          if (sound.fixedGain) continue;
          const alone = DS.measured[palette.id][sound.code];
          const peak = alone.peakDb + 20 * Math.log10(DS.gains[palette.id][sound.code] * DS.DEFAULT_VOLUME);
          if (peak >= DS.LIMIT.thresholdDb) over.push(`${palette.number}·${sound.code}`);
        }
      }
      checks.push({
        name: {
          en: `Each sound alone stays under the limiter at the default volume${over.length ? `: ${over.join(", ")}` : ""}`,
          uk: `Кожен звук окремо лишається під лімітером на типовій гучності${over.length ? `: ${over.join(", ")}` : ""}`,
        },
        pass: over.length === 0,
      });
    }
    return checks;
  }

  Object.assign(DS, { PALETTES: { glass, wood }, SOUNDS, PRIORITY, gesture, soundChecks });
})();
