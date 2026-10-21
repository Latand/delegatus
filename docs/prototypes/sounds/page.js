/* The page: settings, the sound tables, the busy hour and the rules check. */
(() => {
  const DS = window.DelegatusSounds;
  const $ = (id) => document.getElementById(id);
  const query = new URLSearchParams(location.search);

  document.documentElement.lang = DS.lang;
  if (["light", "dark"].includes(query.get("theme"))) document.documentElement.dataset.theme = query.get("theme");
  document.title = DS.t("title");
  for (const node of document.querySelectorAll("[data-copy]")) node.textContent = DS.t(node.dataset.copy);

  // ── State and the live context ─────────────────────────────────────────

  const settings = { paletteId: "glass", source: "original", volume: DS.DEFAULT_VOLUME };
  DS.state = { slices: null, ready: null };

  /** Decoding needs no running context, so the slices load before any gesture. */
  DS.state.ready = DS.typing.loadSlices(new OfflineAudioContext(2, 1, 48000)).then((slices) => {
    DS.state.slices = slices;
    if (!slices) settings.source = "replica";
    $("slices-status").textContent = DS.t(slices ? "served" : "fileOnly");
    renderChoices();
  });

  let live = null;
  /** The page's one AudioContext and its graph, made on the first press. */
  function liveContext() {
    if (!live) {
      const ctx = new AudioContext();
      live = { ctx, graph: DS.createGraph(ctx) };
    }
    void live.ctx.resume();
    return live;
  }

  function playScene(scene) {
    const { ctx, graph } = liveContext();
    scene.schedule(graph, ctx.currentTime + 0.05, { volume: settings.volume });
  }

  const sourceNow = () => (settings.source === "original" && DS.state.slices ? "original" : "replica");

  // ── Settings ───────────────────────────────────────────────────────────

  function radios(fieldset, name, options, current, onPick) {
    fieldset.querySelectorAll("label").forEach((label) => label.remove());
    for (const option of options) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = name;
      input.value = option.value;
      input.checked = option.value === current;
      input.disabled = Boolean(option.disabled);
      input.addEventListener("change", () => onPick(option.value));
      label.append(input, option.label);
      fieldset.append(label);
    }
  }

  function renderChoices() {
    radios($("palette-choice"), "palette",
      Object.values(DS.PALETTES).map((p) => ({
        value: p.id,
        label: `${p.number} · ${p.name[DS.lang]}${p.number === 1 ? ` (${DS.t("recommended")})` : ""}`,
      })),
      settings.paletteId, (value) => { settings.paletteId = value; });
    radios($("typing-choice"), "typing", [
      { value: "original", label: `${DS.t("original")} (${DS.t("recommended")})`, disabled: !DS.state.slices },
      { value: "replica", label: DS.t("replica") },
    ], settings.source, (value) => { settings.source = value; });
  }
  renderChoices();

  $("volume").addEventListener("input", (event) => {
    settings.volume = Number(event.target.value);
    $("volume-out").textContent = settings.volume.toFixed(2);
  });

  // ── The sound tables ───────────────────────────────────────────────────

  /** Small sounds borrow the hue of the sound closest in meaning. */
  const HUE_ALIAS = { distant: "typing", "voice-connect": "reply", "voice-disconnect": "reply", "dict-warn": "your-move", "dict-stop": "your-move" };
  const hueOf = (id) => `var(--hue-${HUE_ALIAS[id] ?? id})`;

  function button(text, onClick) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = text;
    node.addEventListener("click", onClick);
    return node;
  }

  function soundRow(table, { id, code, name, actions }) {
    const [means, source] = DS.meaning(id);
    const row = table.insertRow();
    const codeCell = row.insertCell();
    codeCell.className = "code";
    codeCell.style.setProperty("--hue", hueOf(id));
    codeCell.textContent = code;
    row.insertCell().textContent = name;
    row.insertCell().textContent = means;
    row.insertCell().textContent = source;
    const cell = row.insertCell();
    const box = document.createElement("div");
    box.className = "actions";
    box.append(...actions);
    cell.append(box);
  }

  function header(table) {
    const row = table.createTHead().insertRow();
    for (const key of ["colCode", "colSound", "colMeans", "colSource", "colPlay"]) {
      const th = document.createElement("th");
      th.textContent = DS.t(key);
      row.append(th);
    }
  }

  const playSound = (id, options) => () => playScene(DS.scenes.soundScene(id, settings.paletteId, options));

  function renderSoundTables() {
    const table = $("sound-table");
    header(table);
    const body = table.createTBody();
    soundRow(body, {
      id: "typing", code: "S1", name: DS.lang === "uk" ? "Набір" : "Typing",
      actions: [button(DS.t("play"), () => playScene(DS.scenes.typingScene(sourceNow(), DS.state.slices)))],
    });
    soundRow(body, {
      id: "distant", code: "S2", name: DS.lang === "uk" ? "Набір здалеку" : "Distant typing",
      actions: [1, 4, 7].map((n) => button(DS.t("agents", { n }),
        () => playScene(DS.scenes.distantScene(n, sourceNow(), DS.state.slices, 16)))),
    });
    for (const id of ["step", "landed", "released", "your-move", "fault", "reply", "launched"]) {
      const sound = DS.SOUNDS[id];
      const actions = [button(DS.t("play"), playSound(id))];
      if (id === "landed") actions.push(button(DS.t("batch"), playSound(id, { batch: 4 })));
      soundRow(body, { id, code: sound.code, name: DS.soundName(sound), actions });
    }

    const small = $("small-table");
    header(small);
    const smallBody = small.createTBody();
    for (const id of ["voice-connect", "voice-disconnect", "dict-warn", "dict-stop"]) {
      const sound = DS.SOUNDS[id];
      soundRow(smallBody, { id, code: sound.code, name: DS.soundName(sound), actions: [button(DS.t("play"), playSound(id))] });
    }

    $("rising").textContent = DS.t("compare");
    $("rising").addEventListener("click", () => playScene(DS.scenes.risingScene(settings.paletteId)));
  }
  renderSoundTables();

  // ── The busy hour ──────────────────────────────────────────────────────

  let hour = null;
  let run = null;
  const ROWS = ["your-move", "fault", "released", "landed", "step"];

  const clock = (seconds) => {
    const s = Math.max(0, Math.floor(seconds));
    const hourOf = 14 + Math.floor(s / 3600);
    return `${hourOf}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };

  function simulate() {
    stopHour();
    hour = DS.hour.simulate({
      liveSessions: Math.min(26, Math.max(3, Number($("live-sessions").value) || 12)),
      inferredAsks: $("with-asks").checked,
    });
    const sources = Object.values(hour.events.stats.sources).reduce((a, b) => a + b, 0);
    $("hour-intro").textContent = DS.t("hourIntro", {
      label: hour.label, calls: DS.number(hour.tools.calls), sources, seed: hour.seed,
    });
    renderHourTable();
    drawTimeline(Number($("start-minute").value) * 60);
  }

  function renderHourTable() {
    const table = $("hour-table");
    table.replaceChildren();
    const head = table.createTHead().insertRow();
    for (const [key, numeric] of [["tableSound", false], ["tableSources", true], ["tablePlays", true]]) {
      const th = document.createElement("th");
      th.textContent = DS.t(key);
      if (numeric) th.className = "num";
      head.append(th);
    }
    const body = table.createTBody();
    for (const id of ROWS) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.className = "code";
      cell.style.setProperty("--hue", hueOf(id));
      cell.textContent = `${DS.SOUNDS[id].code} ${DS.soundName(DS.SOUNDS[id])}`;
      const sources = hour.events.stats.sources[id] ?? 0;
      const plays = hour.events.plays.filter((p) => p.sound === id && !p.replay).length;
      Object.assign(row.insertCell(), { className: "num", textContent: DS.number(sources) });
      Object.assign(row.insertCell(), { className: "num", textContent: DS.number(plays) });
    }
    const { tools, silent } = hour;
    $("typing-summary").textContent = DS.t("typingSummary", {
      calls: DS.number(tools.calls), near: DS.number(tools.near.length), distant: DS.number(tools.distant.length),
      off: tools.offScreen, interval: DS.number(tools.interval, 1),
    });
    $("silent-summary").textContent = DS.t("silent", {
      starts: silent.stageStarts, fails: silent.stageFails,
      asks: silent.inferredAsks ? DS.t("silentAsks", { n: silent.inferredAsks }) : "",
    });
  }

  /** One row per voiced class, typing density underneath, and the playhead. */
  function drawTimeline(position) {
    const canvas = $("timeline");
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const g = canvas.getContext("2d");
    g.scale(ratio, ratio);
    const style = getComputedStyle(document.documentElement);
    const color = (name) => style.getPropertyValue(name).trim();
    const left = 44;
    const span = width - left - 8;
    const xOf = (t) => left + (t / 3600) * span;
    const rowHeight = (height - 40) / (ROWS.length + 1);

    g.font = `600 11px ${color("--font-sans")}`;
    g.textBaseline = "middle";
    ROWS.forEach((id, i) => {
      const y = 8 + i * rowHeight;
      g.fillStyle = color(`--hue-${id}`);
      g.fillText(DS.SOUNDS[id].code, 8, y + rowHeight / 2);
      for (const play of hour.events.plays.filter((p) => p.sound === id)) {
        g.fillRect(xOf(play.start) - 1, y + 3, 3, rowHeight - 6);
      }
    });

    // Typing: calls per minute, S1 and S2 together.
    const y = 8 + ROWS.length * rowHeight;
    const perMinute = new Array(60).fill(0);
    for (const c of [...hour.tools.near, ...hour.tools.distant]) perMinute[Math.min(59, Math.floor(c.t / 60))]++;
    const peak = Math.max(...perMinute);
    g.fillStyle = color("--hue-typing");
    g.fillText("S1·S2", 4, y + rowHeight / 2);
    perMinute.forEach((count, minute) => {
      const h = (count / peak) * (rowHeight - 4);
      g.fillRect(xOf(minute * 60) + 1, y + rowHeight - h, span / 60 - 2, h);
    });

    // Minute ticks and the playhead.
    g.fillStyle = color("--color-muted");
    g.font = `11px ${color("--font-sans")}`;
    g.textBaseline = "top";
    g.textAlign = "center";
    for (let minute = 0; minute <= 60; minute += 10) {
      const label = clock(minute * 60).slice(0, 5);
      const half = g.measureText(label).width / 2;
      g.fillText(label, Math.min(width - half - 2, Math.max(half + 2, xOf(minute * 60))), height - 26);
    }
    g.textAlign = "start";
    g.fillStyle = color("--color-primary");
    g.fillRect(xOf(position), 4, 2, height - 34);
  }

  function startHour() {
    const { ctx } = liveContext();
    const graph = DS.createGraph(ctx);
    const from = Math.min(59, Math.max(0, Number($("start-minute").value) || 0)) * 60;
    const t0 = ctx.currentTime + 0.1;
    const options = { volume: settings.volume, paletteId: settings.paletteId, source: sourceNow(), slices: DS.state.slices };
    let scheduledUntil = from;

    const tick = () => {
      const position = from + Math.max(0, ctx.currentTime - t0);
      const until = Math.min(3600, position + 1.5);
      if (until > scheduledUntil) {
        DS.scheduleHour(graph, hour, scheduledUntil, until, t0 + (scheduledUntil - from), options);
        scheduledUntil = until;
      }
      $("hour-position").textContent = clock(position);
      drawTimeline(position);
      if (position >= 3600) stopHour();
    };
    run = { graph, timer: setInterval(tick, 250) };
    tick();
    $("hour-play").textContent = DS.t("stop");
    $("hour-play").setAttribute("aria-pressed", "true");
  }

  function stopHour() {
    if (run) {
      clearInterval(run.timer);
      run.graph.master.gain.setTargetAtTime(0, run.graph.ctx.currentTime, 0.03);
      const graph = run.graph;
      setTimeout(() => graph.master.disconnect(), 300);
      run = null;
    }
    $("hour-play").textContent = DS.t("start");
    $("hour-play").setAttribute("aria-pressed", "false");
  }

  $("hour-play").addEventListener("click", () => (run ? stopHour() : startHour()));
  $("live-sessions").addEventListener("change", simulate);
  $("with-asks").addEventListener("change", simulate);
  $("start-minute").addEventListener("change", () => drawTimeline(Number($("start-minute").value) * 60));
  $("densest").addEventListener("click", () => {
    $("start-minute").value = Math.floor(DS.hour.busiestMinute(hour).start / 60);
    drawTimeline(Number($("start-minute").value) * 60);
  });
  $("timeline").addEventListener("click", (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    const t = ((event.clientX - box.left - 44) / (box.width - 52)) * 3600;
    $("start-minute").value = Math.min(59, Math.max(0, Math.floor(t / 60)));
    drawTimeline(Number($("start-minute").value) * 60);
  });
  $("timeline").setAttribute("aria-label", DS.t("hour"));
  window.addEventListener("resize", () => drawTimeline(Number($("start-minute").value) * 60));
  simulate();

  // ── The rules check ────────────────────────────────────────────────────

  for (const check of DS.lane.selfCheck()) {
    const item = document.createElement("li");
    const verdict = document.createElement("span");
    verdict.className = check.pass ? "ok" : "bad";
    verdict.textContent = DS.t(check.pass ? "pass" : "fail");
    item.append(verdict, ` · ${check.name[DS.lang]}`);
    $("checks").append(item);
  }
})();
