// The hero's demo: the Delegatus board, drawn in the product's own look over
// invented data, playing one flow by itself. A new project gets its
// orchestrator, the visitor's request becomes tasks, the orchestrator's wires
// reach the cards it runs, a pipeline passes Build, Review and Verify, and the
// card moves to Done. Nothing in it is a control.
//
// The whole flow is one timeline: every moving element gets one Web Animation
// of the same length, on transform and opacity only, repeating forever, so the
// browser plays it on the compositor and the loop has no seam. Positions are
// read once, when the stage is built (and again only when the language or the
// phone/desktop layout changes). Playback pauses off screen, in a hidden tab
// and on the visitor's pause; under reduced motion the finished board stands
// still with every step's caption. Classic script.
(function () {
  "use strict";

  const host = document.querySelector("[data-demo]");
  if (!host) return;
  const stage = host.querySelector(".demo-stage");
  const rail = document.querySelector("[data-demo-rail]");
  const pauseButton = document.querySelector("[data-demo-pause]");
  const { strings } = window.DLG.copy;
  const root = document.documentElement;
  const still = root.classList.contains("still");
  const phoneQuery = matchMedia("(max-width: 639px)");

  /* The stage is laid out at one size per layout and scaled to the column. */
  const SIZE = { desktop: { w: 1280, h: 720 }, phone: { w: 360, h: 606 } };

  /* The script, in milliseconds of one loop. */
  const LOOP = 24000;
  const AT = {
    reach: 650, create: 1700, panel: 1950, toComposer: 2600, focus: 3150, type: 3300, typed: 5250,
    toSend: 5350, send: 5900, bubble: 6000, think: 6250, answer: 7000, chips: 7200, fly: 7500, land: 7950,
    move: 9000, wires: 9600, build: 10300, buildOk: 12300, review: 12400, reviewOk: 14700,
    verify: 14800, verifyOk: 16200, merged: 16400, unwire: 16700, toDone: 17000, rest: 18000,
    resetA: 22600, resetB: 23300,
  };
  /* Where each step begins; the last ends as the board resets. */
  const STEPS = [0, 1900, 3200, 6300, 9000, 16800, AT.resetB];
  /* The finished board, for reduced motion. */
  const HOLD = 20500;
  const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
  const GLIDE = "cubic-bezier(0.45, 0.05, 0.2, 1)";

  const lang = () => (root.lang === "uk" ? "uk" : "en");
  const t = (key) => strings[lang()][key] ?? strings.en[key] ?? key;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  const svg = (paths, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    key: svg('<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>'),
    repeat: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
    gauge: svg('<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    plus: svg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
    grid: svg('<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>'),
    send: svg('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    merge: svg('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>'),
  };
  const MARK = '<img src="../../public/brand/delegatus-mark.svg" alt="" width="16" height="16">';
  const CURSOR = '<svg viewBox="0 0 20 22" aria-hidden="true"><path d="M2 1.5v16.2l4.3-4.1 2.9 6.6 2.9-1.3-2.9-6.5 6-.3z"/></svg>';

  const TASKS = [
    { id: "a", icon: ICON.key, title: "d.t1", line: "d.t1d" },
    { id: "b", icon: ICON.repeat, title: "d.t2", line: "d.t2d" },
    { id: "c", icon: ICON.gauge, title: "d.t3", line: "d.t3d" },
  ];

  function stagesHtml() {
    return ["build", "review", "verify"].map((name) => `<span class="d-stage" data-stage="${name}">
      <span class="d-st d-st-wait"><i class="d-sdot"></i>${esc(t(`d.${name}`))}</span>
      <span class="d-st d-st-run"><i class="d-spin"></i>${esc(t(`d.${name}`))}</span>
      <span class="d-st d-st-ok">${ICON.check}${esc(t(`d.${name}`))}</span></span>`).join('<i class="d-arrow"></i>');
  }

  function cardHtml(task) {
    const body = task.id === "a"
      ? `<div class="d-layer d-l-pipe"><div class="d-stages">${stagesHtml()}</div>
          <div class="d-foot"><span class="d-f d-f-run">${esc(t("d.engines"))}</span><span class="d-f d-f-ok">${ICON.merge}${esc(t("d.merged"))}</span></div></div>`
      : task.id === "b"
        ? `<div class="d-layer d-l-work"><span class="d-live"><i></i></span><span><span class="d-eng">Claude · </span>${esc(t("d.status.working"))}</span></div>`
        : "";
    return `<article class="d-card" data-card="${task.id}">
      <header class="d-ct">${task.icon}<span>${esc(t(task.title))}</span></header>
      <div class="d-cb"><p class="d-layer d-l-desc">${esc(t(task.line))}</p>${body}</div>
    </article>`;
  }

  function build() {
    const words = t("d.prompt").split(" ");
    stage.innerHTML = `
      <div class="d-top">
        <span class="d-proj"><i class="d-live"><i></i></i>${esc(t("d.project"))}</span>
        <span class="d-find">${ICON.search}${esc(t("d.find"))}</span>
        <span class="d-top-r">
          <span class="d-pill d-pill-on">${ICON.grid}${esc(t("d.board"))}</span>
          <span class="d-pill">${ICON.plus}${esc(t("d.task"))}</span>
          <span class="d-pill d-pill-orch">${MARK}${esc(t("d.orch"))}</span>
        </span>
      </div>
      <div class="d-body">
        <div class="d-seat">
          <section class="d-draft">
            <div class="d-draft-mark">${MARK}</div>
            <h3>${esc(t("d.draft.title"))}</h3>
            <p>${esc(t("d.draft.line"))}</p>
            <p class="d-engine"><i class="d-claude"></i>${esc(t("d.draft.engine"))}</p>
            <span class="d-create">${esc(t("d.draft.create"))}</span>
          </section>
          <section class="d-panel">
            <header class="d-ph">
              <span class="d-avatar">${MARK}</span>
              <span class="d-ph-name">${esc(t("d.orch"))}<small><i class="d-claude"></i>Claude · Opus 5.5</small></span>
              <span class="d-status"><span class="d-s d-s-wait">${esc(t("d.status.waiting"))}</span><span class="d-s d-s-work"><i class="d-live"><i></i></i>${esc(t("d.status.working"))}</span></span>
            </header>
            <div class="d-chat"><div class="d-msgs">
              <div class="d-msg d-user">${esc(t("d.prompt"))}</div>
              <div class="d-msg d-orch">
                <span class="d-think"><i></i><i></i><i></i></span>
                <div class="d-ans">
                  <p class="d-who"><i class="d-claude"></i>Claude</p>
                  <p>${esc(t("d.answer"))}</p>
                  <ol class="d-list">${TASKS.map((task) => `<li data-chip="${task.id}">${task.icon}<span>${esc(t(task.title))}</span></li>`).join("")}</ol>
                  <p>${esc(t("d.answer2"))}</p>
                </div>
              </div>
              ${["d.r1", "d.r2", "d.r3"].map((key) => `<p class="d-msg d-report">${ICON.check}<span>${esc(t(key))}</span></p>`).join("")}
            </div></div>
            <div class="d-comp">
              <span class="d-focus"></span>
              <span class="d-ph-text">${esc(t("d.placeholder"))}</span>
              <p class="d-typed">${words.map((word) => `<span>${esc(word)}</span>`).join(" ")}</p>
              <span class="d-caret"><i></i></span>
              <span class="d-send">${ICON.send}</span>
            </div>
          </section>
        </div>
        <div class="d-board">
          ${["inbox", "progress", "done"].map((col) => `<section class="d-col" data-col="${col}">
            <h4>${esc(t(`d.col.${col}`))}</h4>
            <div class="d-colb"><p class="d-empty">${esc(t("d.empty"))}</p>
              ${col === "inbox" ? cardHtml(TASKS[2]) : col === "progress" ? cardHtml(TASKS[1]) : cardHtml(TASKS[0])}
            </div></section>`).join("")}
        </div>
      </div>
      <div class="d-wires"></div>
      <span class="d-click"></span>
      <span class="d-cursor">${CURSOR}</span>`;
  }

  // ---------- Geometry, read once per build ----------

  let mode = "desktop";
  let scale = 1;
  const $ = (selector) => stage.querySelector(selector);
  const $$ = (selector) => [...stage.querySelectorAll(selector)];
  function box(el) {
    const r = el.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    return { x: (r.left - s.left) / scale, y: (r.top - s.top) / scale, w: r.width / scale, h: r.height / scale };
  }
  const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

  // ---------- The timeline ----------

  let tracks = [];
  const START = { o: 1, x: 0, y: 0, sx: 1, sy: 1 };
  function track(el, initial) {
    /* An element this layout does not draw would tick on the main thread every frame. */
    if (!el || !el.getClientRects().length) return { to() { return this; } };
    const start = { ...START, ...initial };
    const entry = { el, start, frames: [{ t: 0, p: start }] };
    tracks.push(entry);
    const api = {
      /* Hold the last state until t0, then move to p by t1 (t0 === t1 is a cut). */
      to(t0, t1, p, ease = EASE) {
        const last = entry.frames[entry.frames.length - 1];
        if (t0 < last.t) throw new Error(`demo: a frame at ${t0} ms after one at ${last.t} ms`);
        entry.frames.push({ t: t0, p: last.p, ease });
        entry.frames.push({ t: t1, p: { ...last.p, ...p } });
        return api;
      },
    };
    return api;
  }
  const same = (a, b) => a.o === b.o && a.x === b.x && a.y === b.y && a.sx === b.sx && a.sy === b.sy;

  /* Every track ends where it began: what moved fades out with the board,
     returns to its first place unseen, and what starts visible fades back in. */
  function keyframes(entry) {
    const frames = entry.frames.slice();
    const last = frames[frames.length - 1];
    if (!same(last.p, entry.start)) {
      if (last.t < AT.resetA) frames.push({ t: AT.resetA, p: last.p, ease: "ease-in-out" });
      frames.push({ t: AT.resetB, p: { ...last.p, o: 0 } });
      frames.push({ t: AT.resetB, p: { ...entry.start, o: 0 }, ease: "ease-out" });
    }
    frames.push({ t: LOOP, p: entry.start });
    const r = (n) => Math.round(n * 100) / 100;
    return frames.map((f) => ({
      offset: f.t / LOOP,
      easing: f.ease || "linear",
      opacity: r(f.p.o),
      transform: `translate(${r(f.p.x)}px, ${r(f.p.y)}px) scale(${r(f.p.sx)}, ${r(f.p.sy)})`,
    }));
  }

  function script() {
    tracks = [];
    const phone = mode === "phone";
    const seat = box($(".d-seat"));
    const panel = box($(".d-panel"));

    // Step 1 → 2: the cursor creates the orchestrator.
    const create = $(".d-create");
    const createAt = centre(box(create));
    track(create).to(AT.create, AT.create + 90, { sx: 0.96, sy: 0.96 }, "ease-out").to(AT.create + 90, AT.create + 260, { sx: 1, sy: 1 });
    track($(".d-draft")).to(AT.panel - 50, AT.panel + 250, { o: 0, sx: 0.98, sy: 0.98 }, "ease-in");
    track($(".d-panel"), { o: 0, y: 12 }).to(AT.panel, AT.panel + 550, { o: 1, y: 0 });

    // Step 3: the request is typed and sent.
    const comp = box($(".d-comp"));
    const send = $(".d-send");
    const sendAt = centre(box(send));
    track($(".d-focus"), { o: 0 }).to(AT.focus, AT.focus + 150, { o: 1 }).to(AT.send + 100, AT.send + 400, { o: 0 });
    track($(".d-ph-text")).to(AT.type - 40, AT.type, { o: 0 }).to(AT.bubble + 200, AT.bubble + 450, { o: 1 });
    const words = $$(".d-typed span");
    const caret = $(".d-caret");
    const caretStart = box(caret);
    const typedStep = (AT.typed - AT.type) / words.length;
    const caretTrack = track(caret, { o: 0 }).to(AT.focus, AT.focus, { o: 1 });
    words.forEach((word, index) => {
      const at = Math.round(AT.type + index * typedStep);
      track(word, { o: 0 }).to(at, at + 70, { o: 1 }, "linear").to(AT.send + 60, AT.send + 220, { o: 0 }, "linear");
      const end = box(word);
      caretTrack.to(at, at, { x: end.x + end.w + 2 - caretStart.x, y: end.y + (end.h - caretStart.h) / 2 - caretStart.y });
    });
    caretTrack.to(AT.send + 60, AT.send + 60, { o: 0 });
    track(send).to(AT.send, AT.send + 90, { sx: 0.88, sy: 0.88 }, "ease-out").to(AT.send + 90, AT.send + 280, { sx: 1, sy: 1 });

    // The chat: each message slides in, and the list moves up when it outgrows the window.
    const chat = box($(".d-chat"));
    const msgs = $(".d-msgs");
    const msgBox = box(msgs);
    const shiftFor = (el) => Math.min(0, chat.h - (box(el).y - msgBox.y + box(el).h) - 12);
    const user = $(".d-user");
    const orch = $(".d-orch");
    const reports = $$(".d-report");
    const shifts = [[AT.bubble, shiftFor(user)], [AT.think, shiftFor(orch)], ...reports.map((el, i) => [[AT.buildOk, AT.reviewOk, AT.merged][i] + 100, shiftFor(el)])];
    const listTrack = track(msgs);
    let shiftNow = 0;
    let shiftEnd = 0;
    const shiftAt = (time) => shifts.filter(([at]) => at <= time).reduce((_, [, y]) => y, 0);
    for (const [at, y] of shifts) {
      if (y === shiftNow) continue;
      const from = Math.max(at, shiftEnd);
      listTrack.to(from, from + 450, { y });
      shiftNow = y;
      shiftEnd = from + 450;
    }
    track(user, { o: 0, y: 10 }).to(AT.bubble, AT.bubble + 380, { o: 1, y: 0 });
    track(orch, { o: 0, y: 10 }).to(AT.think, AT.think + 300, { o: 1, y: 0 });
    track($(".d-think")).to(AT.answer - 120, AT.answer + 80, { o: 0 }, "linear");
    track($(".d-ans"), { o: 0 }).to(AT.answer, AT.answer + 300, { o: 1 });
    reports.forEach((el, i) => {
      const at = [AT.buildOk, AT.reviewOk, AT.merged][i] + 100;
      track(el, { o: 0, y: 8 }).to(at, at + 380, { o: 1, y: 0 });
    });
    track($(".d-s-work"), { o: 0 }).to(AT.bubble + 100, AT.bubble + 300, { o: 1 }).to(AT.merged + 200, AT.merged + 400, { o: 0 });
    track($(".d-s-wait")).to(AT.bubble + 100, AT.bubble + 300, { o: 0 }).to(AT.merged + 200, AT.merged + 400, { o: 1 });

    // Step 4: each task of the answer flies to the board and lands as a card.
    const columns = Object.fromEntries($$(".d-col").map((col) => [col.dataset.col, box(col.querySelector(".d-colb"))]));
    const cardEls = Object.fromEntries($$(".d-card").map((el) => [el.dataset.card, el]));
    const cardBox = box(cardEls.a);
    const gap = phone ? 6 : 10;
    const slot = (col, index) => ({ x: columns[col].x, y: columns[col].y + index * (cardBox.h + gap) });
    const home = { a: slot("done", 0), b: slot("progress", 0), c: slot("inbox", 0) };
    const offset = (id, at) => ({ x: at.x - home[id].x, y: at.y - home[id].y });
    const flight = { a: "a", b: "b", c: "c" };
    const wires = $(".d-wires");
    TASKS.forEach((task, index) => {
      const chip = stage.querySelector(`[data-chip="${task.id}"]`);
      track(chip, { o: 0, x: -6 }).to(AT.chips + index * 180, AT.chips + index * 180 + 300, { o: 1, x: 0 });
      const from = box(chip.querySelector("svg"));
      from.y += shiftAt(AT.fly);
      const to = slot("inbox", index);
      const dot = document.createElement("span");
      dot.className = "d-fly";
      dot.style.left = `${from.x + from.w / 2 - 5}px`;
      dot.style.top = `${from.y + from.h / 2 - 5}px`;
      wires.append(dot);
      const launch = AT.fly + index * 230;
      const land = launch + 520;
      track(dot, { o: 0 })
        .to(launch, launch + 80, { o: 1 }, "linear")
        .to(launch + 80, land, { x: to.x + 14 - (from.x + from.w / 2 - 5), y: to.y + 20 - (from.y + from.h / 2 - 5) }, GLIDE)
        .to(land, land + 160, { o: 0, sx: 2.2, sy: 2.2 }, "ease-out");
      const card = cardEls[flight[task.id]];
      const first = offset(task.id, to);
      const cardTrack = track(card, { o: 0, x: first.x, y: first.y + 6, sx: 0.97, sy: 0.97 }).to(land - 40, land + 360, { o: 1, y: first.y, sx: 1, sy: 1 });
      if (task.id === "a") {
        const mid = offset("a", slot("progress", 1));
        cardTrack.to(AT.move + 200, AT.move + 820, { x: mid.x, y: mid.y }, GLIDE).to(AT.toDone, AT.toDone + 750, { x: 0, y: 0 }, GLIDE);
      }
      if (task.id === "b") cardTrack.to(AT.move, AT.move + 620, { x: 0, y: 0 }, GLIDE);
      if (task.id === "c") cardTrack.to(AT.move + 650, AT.move + 1100, { x: 0, y: 0 }, GLIDE);
    });
    track($('.d-col[data-col="inbox"] .d-empty')).to(AT.land - 200, AT.land, { o: 0 });
    track($('.d-col[data-col="progress"] .d-empty')).to(AT.move, AT.move + 200, { o: 0 });
    track($('.d-col[data-col="done"] .d-empty')).to(AT.toDone + 200, AT.toDone + 450, { o: 0 });

    // The cards change face as their work starts and lands.
    track($('[data-card="a"] .d-l-desc')).to(AT.move + 400, AT.move + 600, { o: 0 });
    track($('[data-card="a"] .d-l-pipe'), { o: 0 }).to(AT.move + 600, AT.move + 900, { o: 1 });
    track($('[data-card="b"] .d-l-work'), { o: 0 }).to(AT.wires + 300, AT.wires + 600, { o: 1 });
    const stageRun = { build: [AT.build, AT.buildOk], review: [AT.review, AT.reviewOk], verify: [AT.verify, AT.verifyOk] };
    for (const [name, [run, ok]] of Object.entries(stageRun)) {
      const el = stage.querySelector(`[data-stage="${name}"]`);
      track(el.querySelector(".d-st-wait")).to(run, run + 200, { o: 0 });
      track(el.querySelector(".d-st-run"), { o: 0 }).to(run, run + 200, { o: 1 }).to(ok, ok + 200, { o: 0 });
      track(el.querySelector(".d-st-ok"), { o: 0, sx: 0.9, sy: 0.9 }).to(ok, ok + 260, { o: 1, sx: 1, sy: 1 });
    }
    track($(".d-f-run"), { o: 0 }).to(AT.move + 700, AT.move + 1000, { o: 1 }).to(AT.merged, AT.merged + 200, { o: 0 });
    track($(".d-f-ok"), { o: 0 }).to(AT.merged + 150, AT.merged + 400, { o: 1 });

    // Step 5: the orchestrator's wires reach the cards it runs.
    const assigned = columns.progress;
    const gutter = assigned.x - (phone ? 5 : 9);
    const seatPort = phone ? { x: gutter, y: panel.y + panel.h } : { x: panel.x + panel.w - 28, y: panel.y };
    const runY = phone ? seatPort.y : seatPort.y - 9;
    const route = (index) => {
      const y = slot("progress", index).y + (phone ? 16 : 21);
      const points = [seatPort];
      if (!phone) points.push({ x: seatPort.x, y: runY }, { x: gutter, y: runY });
      points.push({ x: gutter, y }, { x: assigned.x + 1, y });
      return points;
    };
    const drawWire = (points, from, until, pulses) => {
      const group = document.createElement("span");
      group.className = "d-wire";
      wires.append(group);
      const lengths = points.slice(1).map((p, i) => Math.abs(p.x - points[i].x) + Math.abs(p.y - points[i].y));
      const total = lengths.reduce((a, b) => a + b, 0);
      let at = from;
      const span = 520;
      points.slice(1).forEach((p, i) => {
        const a = points[i];
        if (lengths[i] < 0.5) return;
        const seg = document.createElement("i");
        const horizontal = a.y === p.y;
        seg.className = `d-seg ${horizontal ? "h" : "v"}`;
        Object.assign(seg.style, horizontal
          ? { left: `${Math.min(a.x, p.x)}px`, top: `${a.y - 0.75}px`, width: `${lengths[i]}px`, transformOrigin: p.x >= a.x ? "left" : "right" }
          : { left: `${a.x - 0.75}px`, top: `${Math.min(a.y, p.y)}px`, height: `${lengths[i]}px`, transformOrigin: p.y >= a.y ? "top" : "bottom" });
        group.append(seg);
        const d = (span * lengths[i]) / total;
        track(seg, horizontal ? { sx: 0 } : { sy: 0 }).to(at, at + d, horizontal ? { sx: 1 } : { sy: 1 }, "linear");
        at += d;
      });
      for (const [index, point] of [[0, points[0]], [1, points[points.length - 1]]]) {
        const port = document.createElement("i");
        port.className = `d-port${index === 0 ? " seat" : ""}`;
        port.style.left = `${point.x - 3.5}px`;
        port.style.top = `${point.y - 3.5}px`;
        group.append(port);
        const when = index === 0 ? from : from + span;
        track(port, { o: 0, sx: 0.2, sy: 0.2 }).to(when, when + 220, { o: 1, sx: 1, sy: 1 });
      }
      const pulse = document.createElement("i");
      pulse.className = "d-pulse";
      pulse.style.left = `${points[0].x - 4}px`;
      pulse.style.top = `${points[0].y - 4}px`;
      group.append(pulse);
      const pulseTrack = track(pulse, { o: 0 });
      for (const start of pulses) {
        pulseTrack.to(start, start + 60, { o: 1, x: 0, y: 0 }, "linear");
        let when = start + 60;
        points.slice(1).forEach((p, i) => {
          const d = (700 * lengths[i]) / total;
          pulseTrack.to(when, when + d, { x: p.x - points[0].x, y: p.y - points[0].y }, i === 0 ? "ease-in" : "linear");
          when += d;
        });
        pulseTrack.to(when, when + 120, { o: 0 }, "linear").to(when + 120, when + 120, { x: 0, y: 0 });
      }
      if (until) track(group).to(until, until + 300, { o: 0 });
    };
    drawWire(route(0), AT.wires, null, [AT.wires + 600, AT.review + 600]);
    drawWire(route(1), AT.wires + 200, AT.unwire, [AT.review - 700, AT.verify - 700]);

    // The cursor: rest, the create button, the composer, send, then it watches the board.
    const cursor = $(".d-cursor");
    const click = $(".d-click");
    const inbox = columns.inbox;
    const rest = phone ? { x: seat.x + seat.w * 0.72, y: seat.y + seat.h * 0.86 } : { x: columns.progress.x + columns.progress.w * 0.45, y: columns.progress.y + 420 };
    const typing = phone ? { x: comp.x + comp.w * 0.55, y: comp.y + comp.h + 24 } : { x: comp.x + comp.w * 0.62, y: comp.y + comp.h + 6 };
    const watchInbox = { x: inbox.x + inbox.w * (phone ? 0.5 : 0.62), y: slot("inbox", 2).y + cardBox.h + (phone ? 10 : 40) };
    const cardA = slot("progress", 1);
    const watchA = phone ? { x: cardA.x + cardBox.w * 0.7, y: cardA.y + cardBox.h + 34 } : { x: cardA.x + cardBox.w * 0.8, y: cardA.y + cardBox.h + 28 };
    const done = slot("done", 0);
    const watchDone = phone ? { x: done.x + cardBox.w * 0.6, y: done.y + cardBox.h + 30 } : { x: done.x + cardBox.w * 0.62, y: done.y + cardBox.h + 54 };
    const atComp = { x: comp.x + comp.w * 0.3, y: comp.y + comp.h * 0.42 };
    const pos = (p) => ({ x: p.x, y: p.y });
    track(cursor, pos(rest))
      .to(AT.reach, AT.create - 60, pos(createAt), GLIDE)
      .to(AT.create, AT.create + 90, { sx: 0.82, sy: 0.82 }, "ease-out").to(AT.create + 90, AT.create + 240, { sx: 1, sy: 1 })
      .to(AT.toComposer, AT.focus - 60, pos(atComp), GLIDE)
      .to(AT.focus, AT.focus + 90, { sx: 0.82, sy: 0.82 }, "ease-out").to(AT.focus + 90, AT.focus + 240, { sx: 1, sy: 1 })
      .to(AT.focus + 260, AT.type + 450, pos(typing), GLIDE)
      .to(AT.toSend, AT.send - 60, pos(sendAt), GLIDE)
      .to(AT.send, AT.send + 90, { sx: 0.82, sy: 0.82 }, "ease-out").to(AT.send + 90, AT.send + 240, { sx: 1, sy: 1 })
      .to(AT.think, AT.fly + 300, pos(watchInbox), GLIDE)
      .to(AT.wires + 300, AT.build + 300, pos(watchA), GLIDE)
      .to(AT.toDone + 300, AT.rest, pos(watchDone), GLIDE);
    const clickTrack = track(click, { o: 0, sx: 0.3, sy: 0.3 });
    for (const [at, p] of [[AT.create, createAt], [AT.focus, atComp], [AT.send, sendAt]]) {
      clickTrack.to(at, at, { x: p.x, y: p.y, o: 0.55, sx: 0.3, sy: 0.3 }).to(at, at + 480, { o: 0, sx: 1.6, sy: 1.6 }, "ease-out");
    }

    // The steps under the stage: the current one lit, each filling while it plays.
    if (!still && rail) {
      const items = [...rail.querySelectorAll(".demo-steps > li")];
      items.forEach((item, index) => {
        const [from, to] = [STEPS[index], STEPS[index + 1]];
        const first = index === 0;
        track(item.querySelector(".fill"), { sx: 0 }).to(from, to, { sx: 1 }, "linear");
        const on = track(item.querySelector(".on"), { o: first ? 1 : 0 });
        const cap = track(item.querySelector(".cap"), first ? {} : { o: 0, y: 6 });
        if (!first) {
          on.to(from - 150, from + 150, { o: 1 }, "ease-in-out");
          cap.to(from, from + 350, { o: 1, y: 0 });
        }
        if (to < AT.resetB) {
          on.to(to - 150, to + 150, { o: 0 }, "ease-in-out");
          cap.to(to - 250, to, { o: 0, y: -4 }, "ease-in");
        }
      });
    }
  }

  // ---------- Playback ----------

  let animations = [];
  let userPaused = false;
  let onScreen = false;
  let started = false;
  /* A capture holds the loop at a chosen moment. */
  let frozen = false;

  const now = () => {
    const time = animations[0]?.currentTime;
    return typeof time === "number" ? time % LOOP : 0;
  };

  function layout() {
    const size = SIZE[mode];
    scale = Math.max(0.01, host.clientWidth / size.w);
    stage.style.width = `${size.w}px`;
    stage.style.height = `${size.h}px`;
    stage.style.transform = `scale(${scale})`;
    host.style.height = `${Math.round(size.h * scale)}px`;
  }

  /* Build (or rebuild) the stage and its timeline, keeping the loop's place. */
  function start() {
    const time = animations.length ? now() : still ? HOLD : 0;
    const paused = still || !playing();
    for (const animation of animations) animation.cancel();
    animations = [];
    mode = phoneQuery.matches ? "phone" : "desktop";
    stage.dataset.mode = mode;
    layout();
    build();
    script();
    animations = tracks.map((entry) => entry.el.animate(keyframes(entry), { duration: LOOP, iterations: Infinity }));
    for (const animation of animations) {
      animation.currentTime = time;
      if (paused) animation.pause();
    }
    host.toggleAttribute("data-paused", paused);
  }

  const playing = () => !still && !frozen && !userPaused && onScreen && document.visibilityState === "visible";

  function sync() {
    const run = playing();
    const time = now();
    for (const animation of animations) {
      if (run && animation.playState !== "running") animation.play();
      if (!run && animation.playState === "running") animation.pause();
    }
    /* Paused animations stop on the same frame. */
    if (!run) for (const animation of animations) animation.currentTime = time;
    host.toggleAttribute("data-paused", !run);
    if (run && !started) {
      started = true;
      host.dispatchEvent(new CustomEvent("demo-start", { bubbles: true }));
    }
  }

  function labelPause() {
    if (!pauseButton) return;
    const label = t(userPaused ? "demo.play" : "demo.pause");
    pauseButton.setAttribute("aria-label", label);
    pauseButton.title = label;
    pauseButton.setAttribute("aria-pressed", String(userPaused));
  }

  pauseButton?.addEventListener("click", () => {
    userPaused = !userPaused;
    labelPause();
    sync();
  });

  /* The demo is built after the page's first paint, so the headline paints
     first; its box already holds the stage's size (styles.css), so nothing moves. */
  function init() {
    start();
    labelPause();
    observe();
  }
  requestAnimationFrame(() => setTimeout(init, 0));

  function observe() {
    new IntersectionObserver((entries) => {
      /* It starts once most of it is in view, so the first step is seen. */
      for (const entry of entries) onScreen = entry.isIntersecting && entry.intersectionRatio >= 0.55;
      sync();
    }, { threshold: [0, 0.55] }).observe(host);
    document.addEventListener("visibilitychange", sync);
    new ResizeObserver(layout).observe(host);
    phoneQuery.addEventListener("change", start);
    new MutationObserver(() => { start(); labelPause(); }).observe(root, { attributes: true, attributeFilter: ["lang"] });
  }

  /* For the render driver: the loop's length, its steps, and a hold at any moment. */
  window.DLG.demo = {
    loop: LOOP, steps: STEPS, hold: HOLD, now,
    seek(time) { frozen = true; sync(); for (const animation of animations) animation.currentTime = time; },
    release() { frozen = false; sync(); },
  };
})();
