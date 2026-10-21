/* The sound table of docs/design/sound-redesign.md §5.2–§5.3.
 *
 * Every pitch is in D major (D, E, F#, A, B) so overlapping sounds never
 * clash; the dictation pair keeps its old pitches. Contours carry meaning:
 * the two sounds that need the operator are the loudest, and no two rising
 * sounds share a top note and its onset (§5.3, the contour table). */
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
  // `peak` is the linear gain at cue volume 1.0; the default volume is 0.4.

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
      peak: 0.5,
      length: 1.6,
    },

    fault: {
      code: "S7",
      name: { uk: "Збій", en: "Fault" },
      // Three notes falling, slowly beating, over a low drop.
      timbre: { detuneCents: 8, lowpass: { hz: 3200, q: 0.5 } },
      strikes: [
        { at: 0, note: "A5", vel: 0.85, decay: 0.5 },
        { at: 0.14, note: "F5", vel: 0.85, decay: 0.5 },
        { at: 0.28, note: "D5", vel: 1, decay: 1.1 },
        { at: 0, note: "D3", vel: 0.6, decay: 0.3, wave: "triangle", glideFrom: "G3", glideTime: 0.12 },
      ],
      peak: 0.42,
      length: 1.3,
    },

    reply: {
      code: "S8",
      name: { uk: "Відповідь", en: "Reply" },
      // Two notes falling a fourth: the familiar «message arrived».
      strikes: [
        { at: 0, note: "D6", vel: 0.8, decay: 0.5 },
        { at: 0.13, note: "A5", vel: 0.7, decay: 0.9 },
      ],
      peak: 0.3,
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
      peak: 0.36,
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
      peak: 0.32,
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
      peak: 0.2,
      length: 0.45,
    },

    step: {
      code: "S3",
      name: { uk: "Крок", en: "Step" },
      // One short note: the quietest event sound.
      timbre: { modeLimit: 2, lowpass: { hz: 6000, q: 0.5 } },
      strikes: [{ at: 0, note: "A5", vel: 0.7, decay: 0.45 }],
      peak: 0.18,
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
      strikes: [{ at: 0, hz: 660, vel: 0.8, decay: 0.32 }],
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

  Object.assign(DS, { PALETTES: { glass, wood }, SOUNDS, PRIORITY });
})();
