/* Scenes, offline rendering and the waveform picture.
 *
 * A scene schedules sounds onto a graph from a start time. The page plays a
 * scene on its live AudioContext; `DelegatusSounds.capture` renders the same
 * scene on an OfflineAudioContext and hands back a WAV file and a PNG of its
 * waveform, which a headless browser turns into MP4 files with ffmpeg. */
(() => {
  const DS = window.DelegatusSounds;

  const SAMPLE_RATE = 48000;
  const PRE_ROLL = 0.3;
  /** Renders are lifted by this much, the same for every file (see createGraph). */
  const RENDER_MAKEUP_DB = 9;
  const DEFAULT_VOLUME = 0.4;

  // ── Scenes ─────────────────────────────────────────────────────────────

  /** One sound, with a little air before and after. */
  function soundScene(id, paletteId, { batch = 1 } = {}) {
    const sound = DS.SOUNDS[id];
    return {
      seconds: Math.max(2, PRE_ROLL + sound.length + 0.5),
      marks: [{ t: PRE_ROLL, id }],
      schedule(graph, t0, { volume }) {
        DS.play(graph, sound, DS.PALETTES[paletteId], { at: t0 + PRE_ROLL, volume, batch });
      },
    };
  }

  /** S4, S5, S6 and S9 back to back, so the four rising contours can be compared. */
  function risingScene(paletteId) {
    const order = ["landed", "released", "your-move", "launched"];
    const marks = [];
    let t = PRE_ROLL;
    for (const id of order) {
      marks.push({ t, id });
      t += DS.SOUNDS[id].length + 0.6;
    }
    return {
      seconds: t + 0.2,
      marks,
      schedule(graph, t0, { volume }) {
        for (const mark of marks) DS.play(graph, DS.SOUNDS[mark.id], DS.PALETTES[paletteId], { at: t0 + mark.t, volume });
      },
    };
  }

  /** A few tool calls in one on-screen pane: the kept typing effect. */
  function typingScene(source, slices) {
    const calls = [0, 0.9, 1.6, 2.9, 3.4, 4.6];
    return {
      seconds: PRE_ROLL + 5.6,
      marks: calls.map((t) => ({ t: PRE_ROLL + t, id: "typing" })),
      schedule(graph, t0, { volume }) {
        const random = DS.rng(7);
        for (const t of calls) DS.typing.play(graph, { at: t0 + PRE_ROLL + t, volume, random, source, slices });
      },
    };
  }

  /** S2 at its pace for n agents off screen. */
  function distantScene(agents, source, slices, seconds = 24) {
    const interval = DS.typing.distantInterval(agents);
    const times = [];
    for (let t = PRE_ROLL; t < seconds - 1; t += interval) times.push(t);
    return {
      seconds,
      marks: times.map((t) => ({ t, id: "distant" })),
      schedule(graph, t0, { volume }) {
        const random = DS.rng(11 + agents);
        for (const t of times) DS.typing.play(graph, { at: t0 + t, volume, random, source, slices, distant: true });
      },
    };
  }

  /**
   * Schedule the part of a simulated hour that falls in [from, to) seconds,
   * starting at context time t0. Called once for a render, and slice by
   * slice, ahead of the clock, while the page plays the hour live.
   */
  function scheduleHour(graph, hour, from, to, t0, { volume, paletteId, source, slices }) {
    const palette = DS.PALETTES[paletteId];
    const random = DS.rng(Math.floor(from) + 1);
    const inside = (t) => t >= from && t < to;
    const at = (t) => t0 + (t - from);

    const items = [
      ...hour.events.plays.filter((p) => inside(p.start)).map((p) => ({ t: p.start, play: p })),
      ...hour.tools.near.filter((c) => inside(c.t)).map((c) => ({ t: c.t, near: c })),
      ...hour.tools.distant.filter((c) => inside(c.t)).map((c) => ({ t: c.t, distant: c })),
    ].sort((a, b) => a.t - b.t);

    for (const item of items) {
      if (item.play) {
        const p = item.play;
        const handle = DS.play(graph, DS.SOUNDS[p.sound], palette, { at: at(p.start), volume, batch: p.n });
        if (p.cutAt !== null) handle.cut(at(p.cutAt));
      } else if (item.near) {
        DS.typing.play(graph, { at: at(item.t), volume, pan: item.near.pan, random, source, slices });
      } else {
        DS.typing.play(graph, { at: at(item.t), volume, random, source, slices, distant: true });
      }
    }
  }

  function hourScene(hour, from, seconds, paletteId, source, slices) {
    return {
      seconds,
      marks: hour.events.plays
        .filter((p) => p.start >= from && p.start < from + seconds)
        .map((p) => ({ t: p.start - from, id: p.sound, n: p.n, cut: p.cutAt !== null })),
      typing: hour.tools.near.filter((c) => c.t >= from && c.t < from + seconds).map((c) => c.t - from),
      distant: hour.tools.distant.filter((c) => c.t >= from && c.t < from + seconds).map((c) => c.t - from),
      schedule(graph, t0, { volume }) {
        scheduleHour(graph, hour, from, from + seconds, t0, { volume, paletteId, source, slices });
      },
    };
  }

  // ── Offline rendering ──────────────────────────────────────────────────

  async function renderScene(scene, { volume = DEFAULT_VOLUME } = {}) {
    const ctx = new OfflineAudioContext(2, Math.ceil(scene.seconds * SAMPLE_RATE), SAMPLE_RATE);
    const graph = DS.createGraph(ctx, { makeupDb: RENDER_MAKEUP_DB });
    // Sounds start at PRE_ROLL, past graph.settledAt; the hour excerpt's
    // first two seconds are lead-in, and its first sound plays after them.
    scene.schedule(graph, 0, { volume });
    return ctx.startRendering();
  }

  /** 16-bit PCM WAV, clipped at full scale. */
  function encodeWav(buffer) {
    const channels = buffer.numberOfChannels;
    const frames = buffer.length;
    const bytes = new DataView(new ArrayBuffer(44 + frames * channels * 2));
    const text = (offset, s) => [...s].forEach((c, i) => bytes.setUint8(offset + i, c.charCodeAt(0)));
    text(0, "RIFF");
    bytes.setUint32(4, 36 + frames * channels * 2, true);
    text(8, "WAVEfmt ");
    bytes.setUint32(16, 16, true);
    bytes.setUint16(20, 1, true);
    bytes.setUint16(22, channels, true);
    bytes.setUint32(24, buffer.sampleRate, true);
    bytes.setUint32(28, buffer.sampleRate * channels * 2, true);
    bytes.setUint16(32, channels * 2, true);
    bytes.setUint16(34, 16, true);
    text(36, "data");
    bytes.setUint32(40, frames * channels * 2, true);
    const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const sample = Math.max(-1, Math.min(1, data[c][i]));
        bytes.setInt16(offset, Math.round(sample * 32767), true);
        offset += 2;
      }
    }
    return bytes.buffer;
  }

  // ── The waveform picture ───────────────────────────────────────────────

  /** The product's dark tokens (src/styles/tokens.css): MP4s are watched full screen. */
  const INK = {
    canvas: "#111218", card: "#191b23", border: "#292c36", strong: "#3c404c",
    primary: "#e8e8ec", secondary: "#a2a2ae", muted: "#8b8b98", accent: "#8f88ff",
  };
  /** One colour per sound, from the same tokens. */
  const HUE = {
    "your-move": "#e0ae45", fault: "#f07171", reply: "#2dd4bf", released: "#4fc36f",
    landed: "#8f88ff", launched: "#6ea8ff", step: "#a2a2ae", typing: "#8b8b98", distant: "#5e6070",
    "voice-connect": "#2dd4bf", "voice-disconnect": "#2dd4bf", "dict-warn": "#e0ae45", "dict-stop": "#e0ae45",
  };
  const FRAME = { width: 1280, height: 720 };
  /** The waveform's box; the MP4 playhead moves across it. */
  const AREA = { x: 48, y: 250, w: 1184, h: 340 };

  function drawWaveform(buffer, scene, { title, subtitle, note }) {
    const canvas = document.createElement("canvas");
    canvas.width = FRAME.width;
    canvas.height = FRAME.height;
    const g = canvas.getContext("2d");
    const font = (size, weight = 400) => `${weight} ${size}px -apple-system, "Segoe UI", Inter, Roboto, sans-serif`;
    const seconds = buffer.duration;
    const xOf = (t) => AREA.x + (t / seconds) * AREA.w;

    g.fillStyle = INK.canvas;
    g.fillRect(0, 0, FRAME.width, FRAME.height);
    g.fillStyle = INK.card;
    g.strokeStyle = INK.border;
    g.beginPath();
    g.roundRect(24, 24, FRAME.width - 48, FRAME.height - 48, 12);
    g.fill();
    g.stroke();

    g.fillStyle = INK.primary;
    g.font = font(34, 600);
    g.fillText(title, AREA.x, 92);
    g.fillStyle = INK.secondary;
    g.font = font(22);
    g.fillText(subtitle, AREA.x, 132);

    // Event marks above the waveform: what played, when.
    const lane = AREA.y - 70;
    g.font = font(17, 600);
    g.textBaseline = "middle";
    let lastLabelEnd = -Infinity;
    for (const mark of scene.marks) {
      if (mark.id === "typing" || mark.id === "distant") continue;
      const x = xOf(mark.t);
      g.strokeStyle = HUE[mark.id];
      g.globalAlpha = 0.55;
      g.beginPath();
      g.moveTo(x, lane + 16);
      g.lineTo(x, AREA.y + AREA.h);
      g.stroke();
      g.globalAlpha = 1;
      const label = DS.SOUNDS[mark.id].code + (mark.n > 1 ? `×${mark.n}` : "") + (mark.cut ? "✂" : "");
      const width = g.measureText(label).width;
      const y = x < lastLabelEnd + 6 ? lane - 22 : lane; // stagger labels that would touch
      g.fillStyle = HUE[mark.id];
      g.fillText(label, x + 4, y);
      lastLabelEnd = Math.max(lastLabelEnd, x + 4 + width);
    }

    // Typing ticks: S1 tall, S2 short, in a strip just above the waveform.
    const ticks = [
      ...(scene.typing ?? []).map((t) => ({ t, h: 14, hue: HUE.typing })),
      ...(scene.distant ?? []).map((t) => ({ t, h: 7, hue: HUE.distant })),
      ...scene.marks.filter((m) => m.id === "typing").map((m) => ({ t: m.t, h: 14, hue: HUE.typing })),
      ...scene.marks.filter((m) => m.id === "distant").map((m) => ({ t: m.t, h: 7, hue: HUE.distant })),
    ];
    for (const tick of ticks) {
      g.fillStyle = tick.hue;
      g.fillRect(Math.round(xOf(tick.t)), AREA.y - 6 - tick.h, 2, tick.h);
    }

    // The waveform: each column's min and max, of the mid channel.
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    const mid = AREA.y + AREA.h / 2;
    g.strokeStyle = INK.border;
    g.beginPath();
    g.moveTo(AREA.x, mid);
    g.lineTo(AREA.x + AREA.w, mid);
    g.stroke();
    g.fillStyle = INK.accent;
    const perColumn = left.length / AREA.w;
    for (let col = 0; col < AREA.w; col++) {
      let lo = 0;
      let hi = 0;
      const end = Math.min(left.length, Math.floor((col + 1) * perColumn));
      for (let i = Math.floor(col * perColumn); i < end; i++) {
        const s = (left[i] + right[i]) / 2;
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
      const top = mid - hi * (AREA.h / 2);
      g.fillRect(AREA.x + col, top, 1, Math.max(1, (hi - lo) * (AREA.h / 2)));
    }

    // Time axis.
    const step = seconds > 30 ? 5 : seconds > 8 ? 2 : seconds > 3 ? 0.5 : 0.25;
    g.fillStyle = INK.muted;
    g.strokeStyle = INK.strong;
    g.font = font(15);
    g.textBaseline = "top";
    for (let t = 0; t <= seconds + 1e-9; t += step) {
      const x = xOf(t);
      g.beginPath();
      g.moveTo(x, AREA.y + AREA.h + 6);
      g.lineTo(x, AREA.y + AREA.h + 14);
      g.stroke();
      g.fillText(`${DS.number(t, step < 1 ? 2 : 0)} ${DS.t("seconds")}`, x - 12, AREA.y + AREA.h + 20);
    }

    g.fillStyle = INK.muted;
    g.font = font(16);
    g.fillText(note, AREA.x, FRAME.height - 76);
    return canvas.toDataURL("image/png");
  }

  // ── The capture seam ───────────────────────────────────────────────────

  const toBase64 = (arrayBuffer) => {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };

  /**
   * Everything the listening form needs, as named items. The driver calls
   * `items()` once and `render(name)` per item, and gets back the WAV and the
   * PNG (base64), the duration and the playhead box.
   */
  function captureCatalogue(slices) {
    const source = slices ? "original" : "replica";
    const typingName = DS.t(source);
    const catalogue = [];
    const add = (name, build) => catalogue.push({ name, build });
    const paletteTitle = (p) => DS.t("paletteLabel", { n: p.number, name: p.name[DS.lang] });

    for (const palette of Object.values(DS.PALETTES)) {
      const prefix = `palette-${palette.number}-${palette.id}`;
      for (const id of ["step", "landed", "released", "your-move", "fault", "reply", "launched",
        "voice-connect", "voice-disconnect", "dict-warn", "dict-stop"]) {
        const sound = DS.SOUNDS[id];
        add(`${prefix}/${sound.code.replace(/[^A-Z0-9]/gi, "") || "x"}-${id}`, () => ({
          scene: soundScene(id, palette.id),
          title: `${sound.code} · ${DS.soundName(sound)} · ${paletteTitle(palette)}`,
          subtitle: DS.meaning(id)[0],
        }));
      }
      add(`${prefix}/S4-landed-batch-of-4`, () => ({
        scene: soundScene("landed", palette.id, { batch: 4 }),
        title: `S4 · ${DS.soundName(DS.SOUNDS.landed)}, ${DS.t("batchOf", { n: 4 })} · ${paletteTitle(palette)}`,
        subtitle: DS.meaning("landed")[0],
      }));
      add(`${prefix}/rising-S4-S5-S6-S9`, () => ({
        scene: risingScene(palette.id),
        title: `${DS.t("risingTitle")} · ${paletteTitle(palette)}`,
        subtitle: DS.t("compareNote"),
      }));
    }

    add("typing/S1-original", () => ({
      scene: typingScene("original", slices),
      title: DS.t("typingTitle", { source: DS.t("original") }),
      subtitle: DS.meaning("typing")[0],
      needsSlices: true,
    }));
    add("typing/S1-replica", () => ({
      scene: typingScene("replica", null),
      title: DS.t("typingTitle", { source: DS.t("replica") }),
      subtitle: DS.meaning("typing")[0],
    }));
    for (const agents of [1, 4, 7]) {
      add(`typing/S2-distant-${agents}-off-screen`, () => ({
        scene: distantScene(agents, source, slices),
        title: DS.t("distantTitle", { n: agents }),
        subtitle: `${DS.meaning("distant")[0]} · ${typingName}`,
      }));
    }

    const hour = DS.hour.simulate();
    // The densest 56 s, with 2 s of lead-in and 2 s of tail.
    const densest = DS.hour.busiestMinute(hour, 56);
    const from = Math.max(0, densest.start - 2);
    const clock = (s) => `14:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    for (const palette of Object.values(DS.PALETTES)) {
      add(`hour/busiest-hour-60s-palette-${palette.number}-${palette.id}`, () => ({
        scene: hourScene(hour, from, 60, palette.id, source, slices),
        title: `${DS.t("excerpt", { from: clock(from), to: clock(from + 60) })} · ${paletteTitle(palette)}`,
        subtitle: DS.t("excerptNote", { label: hour.label, n: hour.liveSessions, typing: typingName }),
        hour: { from, plays: densest.plays },
      }));
    }
    return catalogue;
  }

  DS.capture = {
    items() {
      return captureCatalogue(DS.state.slices).map(({ name }) => name);
    },
    async render(name) {
      await DS.state.ready;
      const entry = captureCatalogue(DS.state.slices).find((item) => item.name === name);
      if (!entry) throw new Error(`no capture item ${name}`);
      const item = entry.build();
      if (item.needsSlices && !DS.state.slices) throw new Error("the original slices did not load");
      const buffer = await renderScene(item.scene);
      const png = drawWaveform(buffer, item.scene, {
        title: item.title,
        subtitle: item.subtitle,
        note: DS.t("renderNote", { volume: DS.number(DEFAULT_VOLUME, 2) }),
      });
      return {
        wav: toBase64(encodeWav(buffer)),
        png: png.slice(png.indexOf(",") + 1),
        seconds: buffer.duration,
        area: AREA,
        frame: FRAME,
        marks: item.scene.marks,
        hour: item.hour ?? null,
      };
    },
  };

  Object.assign(DS, { scenes: { soundScene, risingScene, typingScene, distantScene, hourScene }, scheduleHour, DEFAULT_VOLUME });
})();
