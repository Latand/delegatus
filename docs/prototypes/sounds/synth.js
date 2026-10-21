/* The synthesis engine of docs/design/sound-redesign.md §5.1.
 *
 * A sound is data: a list of strikes played on a timbre. One renderer turns
 * that data into oscillators, envelopes and filters on any BaseAudioContext,
 * so the same code plays live in the page and renders offline for the MP4
 * files. Nothing here fetches or decodes a file. */
(() => {
  const DS = (window.DelegatusSounds ||= {});

  /** setTargetAtTime falls by e per time constant; ln(1000) of them is −60 dB. */
  const TO_SIXTY_DB = Math.log(1000);
  /** …and ln(10) of them is −20 dB. */
  const TO_TWENTY_DB = Math.log(10);

  // ── Pitch ──────────────────────────────────────────────────────────────

  const SEMITONE_FROM_A = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };

  /** Equal-tempered frequency of a note name: "D5" → 587.33, "F#6" → 1479.98. */
  function hz(note) {
    const match = /^([A-G])(#|b)?(\d)$/.exec(note);
    if (!match) throw new Error(`not a note name: ${note}`);
    const [, letter, accidental, octave] = match;
    const shift = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
    const semitones = SEMITONE_FROM_A[letter] + shift + (Number(octave) - 4) * 12;
    return 440 * 2 ** (semitones / 12);
  }

  // ── Randomness that renders the same file twice ────────────────────────

  /** mulberry32: a tiny seeded generator, so a render is reproducible. */
  function rng(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** One second of white noise per context, shared by every strike and keystroke. */
  const noiseBuffers = new WeakMap();
  function noise(ctx) {
    let buffer = noiseBuffers.get(ctx);
    if (!buffer) {
      buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const samples = buffer.getChannelData(0);
      const random = rng(0x5eed);
      for (let i = 0; i < samples.length; i++) samples[i] = random() * 2 - 1;
      noiseBuffers.set(ctx, buffer);
    }
    return buffer;
  }

  /**
   * Freeze a parameter at time t, keeping the value it has there. Firefox has
   * no cancelAndHoldAtTime, so it gets the value the caller knows it holds.
   */
  function holdAt(param, t, knownValue) {
    if (param.cancelAndHoldAtTime) {
      param.cancelAndHoldAtTime(t);
    } else {
      param.cancelScheduledValues(t);
      param.setValueAtTime(knownValue, t);
    }
  }

  // ── The graph: two buses, one limiter ──────────────────────────────────

  /**
   * A beating mode is two oscillators at ±detuneCents. Unequal levels keep
   * each dip shallow: 0.6 against 0.4 swing at most 14 dB, where an equal
   * pair falls to silence at every beat.
   */
  const TWIN_WEIGHTS = [0.6, 0.4];

  /** Typing sits this far under an event sound while it plays (−9 dB). */
  const DUCKED = 0.35;

  /**
   * event bus ─┐
   *            ├─ master ─ limiter ─ destination
   * typing bus ┘
   *
   * The limiter only catches overlaps; at the default cue volume no single
   * sound reaches it (the rules check measures that). A Web Audio compressor
   * adds its own makeup gain, (1 / its gain at 0 dBFS)^0.6, which is +5.7 dB
   * at these settings; the graph takes it back out, so below the threshold
   * the limiter changes nothing and the mix is the level the product plays.
   * `makeupDb` lifts the finished mix by one fixed amount, the same for every
   * file, so a render is loud enough to judge without changing any balance.
   */
  const LIMIT = { thresholdDb: -10, ratio: 20 };
  const COMPRESSOR_MAKEUP_DB = -0.6 * (LIMIT.thresholdDb - LIMIT.thresholdDb / LIMIT.ratio);

  function createGraph(ctx, { makeupDb = 0 } = {}) {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMIT.thresholdDb;
    limiter.knee.value = 0;
    limiter.ratio.value = LIMIT.ratio;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;

    const master = ctx.createGain();
    const eventBus = ctx.createGain();
    const typingBus = ctx.createGain();
    eventBus.connect(master);
    typingBus.connect(master);
    typingBus.gain.setValueAtTime(1, 0); // an anchor for cancelAndHoldAtTime
    const makeup = ctx.createGain();
    makeup.gain.value = 10 ** ((makeupDb - COMPRESSOR_MAKEUP_DB) / 20);
    master.connect(limiter).connect(makeup).connect(ctx.destination);

    let duckedUntil = -1;
    /** The typing bus level at time t under the ducks scheduled so far. */
    const typingLevelAt = (t) =>
      t <= duckedUntil ? DUCKED : Math.min(1, DUCKED + ((1 - DUCKED) * (t - duckedUntil)) / 0.4);

    /** Duck the typing bus for one event sound (§6.4). Call in time order. */
    function duckTyping(at, length) {
      const gain = typingBus.gain;
      const end = Math.max(duckedUntil, at + length);
      holdAt(gain, at, typingLevelAt(at));
      gain.linearRampToValueAtTime(DUCKED, at + 0.02);
      gain.setValueAtTime(DUCKED, end);
      gain.linearRampToValueAtTime(1, end + 0.4);
      duckedUntil = end;
    }

    // The compressor starts from a low-gain state and needs about 100 ms to
    // settle; a sound scheduled sooner comes out up to 5 dB quiet.
    const settledAt = ctx.currentTime + 0.15;
    return { ctx, master, eventBus, typingBus, duckTyping, settledAt };
  }

  // ── One strike ─────────────────────────────────────────────────────────

  /**
   * A struck body: one oscillator per resonant mode (a detuned pair when the
   * timbre beats), each with its own exponential decay, plus an optional
   * mallet of filtered noise. Upper modes die sooner, as on a real bar.
   */
  function strike(ctx, into, timbre, note, start) {
    const t = start + note.at;
    const attack = note.attack ?? timbre.attack;
    const modes = timbre.modes.slice(0, timbre.modeLimit ?? timbre.modes.length);
    const twins = timbre.detuneCents ? [-1, 1] : [0];
    const weights = timbre.detuneCents ? TWIN_WEIGHTS : [1];
    let lastStop = t;

    for (const mode of modes) {
      twins.forEach((twin, which) => {
        const osc = ctx.createOscillator();
        osc.type = note.wave ?? timbre.wave;
        const target = note.hz * mode.ratio;
        if (note.glideFrom) {
          osc.frequency.setValueAtTime(note.glideFrom * mode.ratio, t);
          osc.frequency.exponentialRampToValueAtTime(target, t + note.glideTime);
        } else {
          osc.frequency.setValueAtTime(target, t);
        }
        osc.detune.value = twin * (timbre.detuneCents ?? 0);

        // A detuned pair sums to the level of one mode, so beating adds no loudness.
        const level = note.vel * mode.gain * weights[which];
        const decay = note.decay * mode.decayScale;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(level, t + attack);
        env.gain.setTargetAtTime(0, t + attack, decay / TO_SIXTY_DB);

        const stop = t + attack + decay + 0.05;
        if (note.vibrato) vibrato(ctx, osc, note.vibrato, t, stop);
        osc.connect(env).connect(into);
        osc.start(t);
        osc.stop(stop);
        lastStop = Math.max(lastStop, stop);
      });
    }

    // A swell is bowed, not struck: no mallet under a slow attack.
    if (timbre.mallet && attack < 0.05) mallet(ctx, into, timbre.mallet, note.vel, t);
    return lastStop;
  }

  function vibrato(ctx, osc, { hz: rate, cents }, start, stop) {
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = rate;
    depth.gain.value = cents;
    lfo.connect(depth).connect(osc.detune);
    lfo.start(start);
    lfo.stop(stop);
  }

  /** The mallet hitting the bar: a few milliseconds of band-passed noise. */
  function mallet(ctx, into, { bandHz, q, gain, length }, vel, t) {
    const source = ctx.createBufferSource();
    source.buffer = noise(ctx);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = bandHz;
    band.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain * vel, t + 0.001);
    env.gain.setTargetAtTime(0, t + 0.001, length / TO_SIXTY_DB);
    source.connect(band).connect(env).connect(into);
    source.start(t, (t * 7.31) % 0.9);
    source.stop(t + length + 0.02);
  }

  // ── One sound ──────────────────────────────────────────────────────────

  /**
   * Render `sound` (an entry of DS.SOUNDS) in `palette` at context time `at`.
   *
   *   strikes ─ sound lowpass ─ gain(calibrated × volume) ─ pan ─ event bus
   *
   * The gain is the one `calibrate` measured for this sound in this palette,
   * or `gain` when the caller passes one (calibration itself passes 1).
   * Returns a handle whose `cut(t)` fades the sound out over 40 ms, which is
   * how a higher-priority sound interrupts a lower one (§6.2).
   */
  function play(graph, sound, palette, { at, volume = 0.4, pan = 0, batch = 1, gain } = {}) {
    const { ctx } = graph;
    const timbre = { ...palette.timbre, ...sound.timbre };
    const notes = [...sound.strikes, ...(sound.batch ? sound.batch(batch) : [])]
      .map(resolve)
      .map(palette.shape);

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = timbre.lowpass.hz;
    lowpass.Q.value = timbre.lowpass.q;
    const out = ctx.createGain();
    const level = sound.fixedGain ?? (gain ?? calibratedGain(sound, palette)) * volume;
    out.gain.setValueAtTime(level, at);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    lowpass.connect(out).connect(panner).connect(graph.eventBus);

    for (const note of notes) strike(ctx, lowpass, timbre, note, at);
    if (!sound.fixedGain) graph.duckTyping(at, sound.length);

    return {
      end: at + sound.length,
      cut(t) {
        holdAt(out.gain, t, level);
        out.gain.linearRampToValueAtTime(0, t + 0.04);
      },
    };
  }

  // ── Loudness: what sets each sound's gain ──────────────────────────────

  /**
   * The K-weighting of ITU-R BS.1770 at any sample rate: a high shelf (+4 dB
   * above about 1.7 kHz, the head's own boost) and a high-pass at 38 Hz.
   * Coefficients as libebur128 derives them.
   */
  function kWeighting(rate) {
    let k = Math.tan((Math.PI * 1681.974450955533) / rate);
    const vh = 10 ** (3.999843853973347 / 20);
    const vb = vh ** 0.4996667741545416;
    let q = 0.7071752369554196;
    let a0 = 1 + k / q + k * k;
    const shelf = {
      b: [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0],
      a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0],
    };
    k = Math.tan((Math.PI * 38.13547087602444) / rate);
    q = 0.5003270373238773;
    a0 = 1 + k / q + k * k;
    const highpass = { b: [1, -2, 1], a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0] };
    return [shelf, highpass];
  }

  function biquad(samples, { b, a }) {
    const out = new Float32Array(samples.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      out[i] = y;
    }
    return out;
  }

  /**
   * The momentary maximum of an AudioBuffer in LUFS (EBU R 128: K-weighted,
   * 400 ms windows every 100 ms, channels summed), and its sample peak in
   * dBFS. A struck sound's loudness is what overlapping tails add up to,
   * which no single strike's level shows.
   */
  function loudness(buffer) {
    const rate = buffer.sampleRate;
    const filters = kWeighting(rate);
    const squares = [];
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const raw = buffer.getChannelData(c);
      for (const s of raw) peak = Math.max(peak, Math.abs(s));
      const weighted = filters.reduce(biquad, raw);
      const prefix = new Float64Array(weighted.length + 1);
      for (let i = 0; i < weighted.length; i++) prefix[i + 1] = prefix[i] + weighted[i] * weighted[i];
      squares.push(prefix);
    }
    const width = Math.round(0.4 * rate);
    const hop = Math.round(0.1 * rate);
    let loudest = 0;
    for (let start = 0; start + width <= buffer.length; start += hop) {
      let sum = 0;
      for (const prefix of squares) sum += (prefix[start + width] - prefix[start]) / width;
      loudest = Math.max(loudest, sum);
    }
    const db = (x) => (x > 0 ? 10 * Math.log10(x) : -Infinity);
    return { momentaryMax: -0.691 + db(loudest), peakDb: 2 * db(peak) };
  }

  /** gains[paletteId][code]: the linear gain at cue volume 1.0, once measured. */
  const gains = {};
  /** Each sound alone at gain 1: its momentary maximum and peak, per palette. */
  const measured = {};

  function calibratedGain(sound, palette) {
    const gain = gains[palette.id]?.[sound.code];
    if (gain === undefined) throw new Error(`${sound.code} has no gain for ${palette.id}: await DelegatusSounds.calibrate() first`);
    return gain;
  }

  /**
   * Render every leveled sound alone at gain 1 in every palette, measure it,
   * and set its gain so that at cue volume 1.0 it reaches its `loudness`
   * (LUFS, momentary maximum). Deterministic, about a second of offline
   * rendering in all; needs no user gesture.
   */
  async function calibrate() {
    const rate = 48000;
    for (const palette of Object.values(DS.PALETTES)) {
      gains[palette.id] = {};
      measured[palette.id] = {};
      for (const sound of Object.values(DS.SOUNDS)) {
        if (sound.fixedGain) continue;
        const ctx = new OfflineAudioContext(2, Math.ceil((sound.length + 0.2) * rate), rate);
        const bus = ctx.createGain();
        bus.connect(ctx.destination);
        play({ ctx, eventBus: bus, duckTyping() {} }, sound, palette, { at: 0, volume: 1, gain: 1 });
        const alone = loudness(await ctx.startRendering());
        measured[palette.id][sound.code] = alone;
        gains[palette.id][sound.code] = 10 ** ((sound.loudness - alone.momentaryMax) / 20);
      }
    }
    return { gains, measured };
  }

  /** A strike written with a note name gets its frequency; glides too. */
  function resolve(note) {
    return {
      ...note,
      hz: note.hz ?? hz(note.note),
      glideFrom: note.glideFrom && (typeof note.glideFrom === "string" ? hz(note.glideFrom) : note.glideFrom),
    };
  }

  Object.assign(DS, { hz, rng, noise, createGraph, play, loudness, calibrate, gains, measured, LIMIT, TO_SIXTY_DB, TO_TWENTY_DB });
})();
