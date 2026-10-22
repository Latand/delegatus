/* The kept typing effect (S1) and distant typing (S2):
 * docs/design/sound-redesign.md §5.4–§5.5.
 *
 * S1 is the product's eight recorded slices, byte for byte, one drawn at
 * random per tool call. The prototype loads them from public/audio/cues when
 * the page is served from the repository root; opened as a file, it has only
 * the synthesized replica, which is offered as a listening variant. */
(() => {
  const DS = window.DelegatusSounds;

  /** Each tool call's slice plays at this gain × cue volume (src/lib/audio/cues.ts). */
  const ROUTINE_GAIN = 0.5;
  /** S2: the same slice, one room away (−14 dB). */
  const DISTANT_GAIN = 0.2;
  /**
   * The room's 1400 Hz lowpass takes about 5.5 LU out of slices centred at
   * 3–5.5 kHz (measured: S2 sat 19–20 LU under S1 with this at 0 dB). Putting
   * it back leaves S2 heard 14 LU under S1, as DISTANT_GAIN intends.
   */
  const ROOM_LOSS_DB = 5.5;
  const SLICE_FILES = Array.from({ length: 8 }, (_, i) => `tool-tick-${i + 1}.mp3`);
  const SLICE_DIR = new URL("../../../public/audio/cues/", document.baseURI);

  /** The recorded slices, decoded once; null when the page cannot fetch them. */
  async function loadSlices(ctx) {
    try {
      return await Promise.all(SLICE_FILES.map(async (file) => {
        const response = await fetch(new URL(file, SLICE_DIR));
        if (!response.ok) throw new Error(`${file}: ${response.status}`);
        return ctx.decodeAudioData(await response.arrayBuffer());
      }));
    } catch {
      return null;
    }
  }

  // ── The replica, specified from the measured slices ────────────────────

  /**
   * One tool call's burst of keystrokes. Measured from the slices: 3 to 9
   * keys, 50–125 ms apart, each falling 20 dB in 15–25 ms, centred at
   * 3–5.5 kHz, with the occasional duller space bar.
   */
  function burst(random) {
    const strokes = [];
    const count = 3 + Math.floor(random() * 7);
    let at = 0.02 + random() * 0.12;
    for (let i = 0; i < count && at < 0.62; i++) {
      const space = random() < 0.15;
      strokes.push({
        at,
        bandHz: space ? 1100 : 2200 + random() * 2300,
        q: space ? 1.2 : 2 + random() * 2,
        toTwentyDb: space ? 0.035 : 0.012 + random() * 0.012,
        bodyHz: 180 + random() * 80, // the key bottoming out
        bodyGain: 0.25,
        gainDb: -4 * random(),
      });
      at += 0.05 + random() * 0.075;
    }
    return strokes;
  }

  /** Raw keystroke level, set so the replica peaks where the slices do. */
  const KEY_LEVEL = 1.0;

  function keystroke(ctx, into, key, start, rate) {
    const t = start + key.at / rate;
    const level = KEY_LEVEL * 10 ** (key.gainDb / 20);

    const click = ctx.createBufferSource();
    click.buffer = DS.noise(ctx);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = key.bandHz * rate;
    band.Q.value = key.q;
    const clickEnv = ctx.createGain();
    clickEnv.gain.setValueAtTime(0, t);
    clickEnv.gain.linearRampToValueAtTime(level, t + 0.0005);
    clickEnv.gain.setValueAtTime(level, t + 0.003); // the 3 ms strike
    clickEnv.gain.setTargetAtTime(0, t + 0.003, key.toTwentyDb / DS.TO_TWENTY_DB);
    click.connect(band).connect(clickEnv).connect(into);
    click.start(t, (key.at * 13.7 + start * 3.1) % 0.9);
    click.stop(t + key.toTwentyDb * 3 + 0.01);

    const body = ctx.createOscillator();
    body.frequency.value = key.bodyHz * rate;
    const bodyEnv = ctx.createGain();
    bodyEnv.gain.setValueAtTime(0, t);
    bodyEnv.gain.linearRampToValueAtTime(level * key.bodyGain, t + 0.001);
    bodyEnv.gain.setTargetAtTime(0, t + 0.001, 0.012 / DS.TO_SIXTY_DB);
    body.connect(bodyEnv).connect(into);
    body.start(t);
    body.stop(t + 0.03);
  }

  // ── Playing one tool call ──────────────────────────────────────────────

  /**
   * S1, or S2 with `distant`. `source` is "original" (needs `slices`) or
   * "replica". The distant chain (§5.5):
   *
   *   slice at rate 0.92 ─ lowpass 1400 Hz ─ gain × 0.2 × room loss ─ pan ±0.3 ─ typing bus
   */
  function play(graph, { at, volume = 0.4, pan = 0, random, source, slices, distant = false }) {
    const { ctx } = graph;
    const rate = distant ? 0.92 : 1;

    const gain = ctx.createGain();
    gain.gain.value = ROUTINE_GAIN * volume * (distant ? DISTANT_GAIN * 10 ** (ROOM_LOSS_DB / 20) : 1);
    const panner = ctx.createStereoPanner();
    panner.pan.value = distant ? (random() * 2 - 1) * 0.3 : pan;
    let input = gain;
    if (distant) {
      const room = ctx.createBiquadFilter();
      room.type = "lowpass";
      room.frequency.value = 1400;
      room.Q.value = 0.7;
      room.connect(gain);
      input = room;
    }
    gain.connect(panner).connect(graph.typingBus);

    if (source === "original" && slices) {
      const slice = ctx.createBufferSource();
      slice.buffer = slices[Math.floor(random() * slices.length)];
      slice.playbackRate.value = rate;
      slice.connect(input);
      slice.start(at);
      return at + slice.buffer.duration / rate;
    }
    for (const key of burst(random)) keystroke(ctx, input, key, at, rate);
    return at + 0.653 / rate;
  }

  /** S2's pace: one slice every clamp(8 / √n, 3, 8) s for n agents off screen. */
  function distantInterval(agentsOffScreen) {
    return Math.min(8, Math.max(3, 8 / Math.sqrt(Math.max(1, agentsOffScreen))));
  }

  DS.typing = { loadSlices, burst, play, distantInterval, SLICE_SECONDS: 0.653 };
})();
