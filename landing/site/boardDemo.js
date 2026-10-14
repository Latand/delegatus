// The hero's demo: the Delegatus board, drawn in the product's own look over
// invented data, playing one flow by itself. A new project gets its
// orchestrator, the visitor's request becomes tasks, the orchestrator's wires
// reach the cards it runs, a pipeline passes Build, Review and Verify, and the
// card moves to Done. Nothing in it is a control.
//
// Every drawn element copies a product component (landing/site/README.md lists
// which): the header row, the seat pane, the calm task cards with their model
// glyphs, the four columns and, on a phone, the product's own phone screens.
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

  /* The stage is laid out at one size per layout and scaled to the column.
     The desktop board is short enough that the stage and the steps under it
     fit a 1440×900 first screen below the headline. */
  const SIZE = { desktop: { w: 1280, h: 384 }, phone: { w: 360, h: 606 } };

  /* The script, in milliseconds of one loop. */
  const LOOP = 24000;
  const AT = {
    reach: 650, create: 1700, panel: 1950, toComposer: 2600, focus: 3150, type: 3300, typed: 5250,
    toSend: 5350, send: 5900, bubble: 6000, think: 6250, answer: 7000, chips: 7200, fly: 7500, land: 7950,
    move: 9000, wires: 9600, build: 10300, buildOk: 12300, review: 12400, reviewOk: 14700,
    verify: 14800, verifyOk: 16200, merged: 16400, unwire: 16700, toDone: 17000, rest: 18000,
    resetA: 22600, resetB: 23300,
  };
  /* The phone shows the same story on the product's phone screens, so some moments differ:
     the chat is its own screen, and the tabs are tapped to reach each column. */
  const PH = { dock: 3050, slide: 3150, chatOut: 7900, tapInbox: 8250, land: 8700, move: 9400, tapProgress: 9650, wires: 9800 };
  /* Where each step begins; the last ends as the board resets. */
  const STEPS = [0, 1900, 3200, 6300, 9000, 16800, AT.resetB];
  /* The finished board, for reduced motion. */
  const HOLD = 20500;
  const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
  const GLIDE = "cubic-bezier(0.45, 0.05, 0.2, 1)";

  const lang = () => (root.lang === "uk" ? "uk" : "en");
  const t = (key) => strings[lang()][key] ?? strings.en[key] ?? key;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  /* Lucide icons, as the product draws them (the names are the ones the product imports). */
  const svg = (paths, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    funnel: svg('<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/>'),
    plus: svg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
    bot: svg('<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>'),
    history: svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'),
    more: svg('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
    play: svg('<polygon points="6 3 20 12 6 21 6 3"/>'),
    mic: svg('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>'),
    down: svg('<path d="m6 9 6 6 6-6"/>'),
    right: svg('<path d="m9 18 6-6-6-6"/>'),
    left: svg('<path d="m15 18-6-6 6-6"/>'),
    expand: svg('<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>'),
    log: svg('<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>'),
    zap: svg('<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>'),
    clip: svg('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
    done: svg('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
    copy: svg('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
    tools: svg('<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    sliders: svg('<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>'),
    chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    userCheck: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>'),
    receipt: svg('<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M14 8H8"/><path d="M16 12H8"/><path d="M13 16H8"/>'),
    repeat: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
    shield: svg('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>'),
  };
  const CURSOR = '<svg viewBox="0 0 20 22" aria-hidden="true"><path d="M2 1.5v16.2l4.3-4.1 2.9 6.6 2.9-1.3-2.9-6.5 6-.3z"/></svg>';
  const AVATAR = (size) => `<img class="d-av" src="brand/role-orchestrator.svg" alt="" width="${size}" height="${size}">`;

  /* The model glyphs a stage wears, drawn on the product's 16-unit grid: copied
     from src/components/kanban/StageGlyph.tsx (Opus, Sol and Sonnet). */
  const r2 = (v) => Math.round(v * 100) / 100;
  const polar = (radius, deg) => {
    const a = (deg * Math.PI) / 180;
    return [r2(8 + radius * Math.sin(a)), r2(8 - radius * Math.cos(a))];
  };
  const petal = (deg, length, width) => {
    const [tx, ty] = polar(length, deg);
    const [mx, my] = polar(length / 2, deg);
    const a = (deg * Math.PI) / 180;
    const [px, py] = [Math.cos(a) * width, Math.sin(a) * width];
    return `M8 8Q${r2(mx + px)} ${r2(my + py)} ${tx} ${ty}Q${r2(mx - px)} ${r2(my - py)} 8 8Z`;
  };
  const every = (count, offset = 0) => Array.from({ length: count }, (_, index) => offset + (index * 360) / count);
  const OPUS = every(8).map((deg) => petal(deg, 7.7, 2.3)).join("");
  const SOL = every(8, 22.5).map((deg) => { const [a, b] = [polar(5.3, deg), polar(7.3, deg)]; return `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`; }).join("");
  const NIB = [1.6, 14.4];
  const quill = (points) => `M${points.map(([s, w]) => `${r2(NIB[0] + (s + w) * Math.SQRT1_2)} ${r2(NIB[1] + (w - s) * Math.SQRT1_2)}`).join("L")}Z`;
  const SONNET = quill([[5.4, -0.55], [7, -2.5], [9.4, -3.69], [12, -4], [14.6, -3.38], [16.7, -1.88], [18.3, 0], [16.9, 1.31], [14.6, 2.19], [12, 2.56], [10.4, 2.25], [9.5, 1], [9.1, 2.19], [7.3, 1.56], [5.4, 0.55]])
    + quill([[5.6, -0.5], [3.4, -0.5], [3.1, -0.95], [0, 0], [3.1, 0.95], [3.4, 0.5], [5.6, 0.5]])
    + quill([[7.4, -0.28], [15.6, -0.12], [15.6, 0.12], [7.4, 0.28]]);
  const GLYPH = {
    opus: `<path class="fill" d="${OPUS}"/><circle class="fill" cx="8" cy="8" r="2.2"/>`,
    sol: `<path class="ray" d="${SOL}"/><circle class="disc" cx="8" cy="8" r="3.5"/>`,
    sonnet: `<path class="fill" fill-rule="evenodd" d="${SONNET}"/>`,
  };
  const glyph = (kind, state) => `<span class="mg mg-${kind}" data-state="${state}"><svg viewBox="0 0 16 16" aria-hidden="true">${GLYPH[kind]}</svg>${state === "passed" ? '<i class="mg-badge"><svg viewBox="0 0 8 8"><path d="m1.9 4.1 1.4 1.4 2.9-3"/></svg></i>' : ""}</span>`;
  const SPARK = `<svg class="d-spark" viewBox="0 0 16 16" aria-hidden="true"><path d="${OPUS}"/><circle cx="8" cy="8" r="2.2"/></svg>`;
  const STAGE_MODEL = { build: "opus", review: "sol", verify: "sonnet" };

  const TASKS = {
    a: { icon: ICON.receipt, title: "d.t1", color: "#3d7fd6" },
    b: { icon: ICON.repeat, title: "d.t2", color: "#1a9e8f" },
    c: { icon: ICON.shield, title: "d.t3", color: "#1a9e8f" },
  };
  const TASK_IDS = ["a", "b", "c"];

  /* Counts that change while the story plays: each value is its own layer, and
     the script cross-fades them at the times given here. */
  const LAND = (index) => AT.fly + index * 230 + 520;
  const MOVED = { b: AT.move + 620, a: AT.move + 820 };
  const COUNTS = {
    desktop: {
      inbox: [[0, "0"], [LAND(0), "1"], [LAND(1), "2"], [LAND(2), "3"], [MOVED.b, "2"], [MOVED.a, "1"]],
      progress: [[0, "0"], [MOVED.b, "1"], [MOVED.a, "2"], [AT.toDone + 450, "1"]],
      waiting: [[0, "0"]],
      done: [[0, "0"], [AT.toDone + 750, "1"]],
      sum: [[0, ""], [AT.wires + 300, "1"], [AT.build, "2"], [AT.merged, "1"]],
      work: [[0, ""], [AT.wires + 300, "1"], [AT.build, "2"], [AT.merged, "1"]],
    },
    phone: {
      inbox: [[0, "0"], [PH.land, "1"], [PH.land + 230, "2"], [PH.land + 460, "3"], [PH.move, "1"]],
      progress: [[0, "0"], [PH.move, "2"], [AT.toDone, "1"]],
      waiting: [[0, "0"]],
      done: [[0, "0"], [AT.toDone, "1"]],
      sum: [[0, ""], [PH.wires + 300, "1"], [AT.build, "2"], [AT.merged, "1"]],
    },
  };
  const counts = () => COUNTS[mode];
  const countHtml = (name) => `<span class="d-n" data-n="${name}">${counts()[name].map(([, value]) => `<span>${name === "sum" ? sumHtml(value) : name === "work" ? (value ? `<i class="d-dot"></i>${esc(value)}` : "") : esc(value)}</span>`).join("")}</span>`;
  const sumHtml = (value) => (value ? `<i class="d-dot"></i>${mode === "phone" ? esc(value) : esc(t(`d.sum${value}`))}` : "");

  const timeOf = ["12:05", "12:07", "12:09", "12:11"];
  const who = (time) => `<p class="d-who">${AVATAR(20)}${SPARK}<span>Claude · ${time}</span></p>`;

  function chatHtml() {
    return `<div class="d-chat"><div class="d-msgs">
      <div class="d-msg d-user"><span class="d-cp">${ICON.copy}</span><div class="d-bub">${esc(t("d.prompt"))}</div></div>
      <div class="d-msg d-orch">
        <span class="d-think"><i></i><i></i><i></i></span>
        <div class="d-ans">
          ${who(timeOf[0])}
          <p>${esc(t("d.answer"))}</p>
          <ol class="d-tools">${TASK_IDS.map((id) => `<li data-chip="${id}">${ICON.tools}<b>MCP · VIEWER</b><span>${esc(t("d.tool.task"))} ${esc(t(TASKS[id].title))}</span>${ICON.done}</li>`).join("")}</ol>
          <p>${esc(t("d.answer2"))}</p>
          <p class="d-worked"><span>${esc(t("d.worked"))}</span></p>
        </div>
      </div>
      ${["d.r1", "d.r2", "d.r3"].map((key, index) => `<div class="d-msg d-report">${who(timeOf[index + 1])}<p>${esc(t(key))}</p></div>`).join("")}
    </div></div>
    <p class="d-turn"><i></i>${esc(t("d.turn"))}</p>`;
  }

  /* The typed request and its caret, in both layouts. */
  const typedHtml = () => `<span class="d-focus"></span>
        <span class="d-ph-text">${esc(t("d.placeholder"))}</span>
        <p class="d-typed">${t("d.prompt").split(" ").map((word) => `<span>${esc(word)}</span>`).join(" ")}</p>
        <span class="d-caret"><i></i></span>`;

  function composerHtml() {
    return `<div class="d-comp">
        ${typedHtml()}
        <span class="d-cr"><span class="d-mic">${ICON.mic}</span><span class="d-send">${ICON.play}</span><span class="d-dd">${ICON.down}</span></span>
      </div>
      <div class="d-cfoot"><span class="d-model">${ICON.zap}Opus 5.5 · Light${ICON.down}</span><span class="d-cf-r">${ICON.clip}${ICON.more}</span></div>`;
  }

  /* The phone's composer is one box: the field on top, the tools row inside the
     same box (model chip, attach, dictate, send). Copies the unit in
     src/components/ComposerBar.tsx (`unitTools`). */
  function phoneComposerHtml() {
    return `<div class="d-comp d-pcomp">
        ${typedHtml()}
        <div class="d-ptools"><span class="d-pchip">Opus 5.5 · high${ICON.down}</span><span class="d-pt">${ICON.clip}</span><span class="d-pt d-mic">${ICON.mic}</span><span class="d-grow"></span><span class="d-send">${ICON.play}</span><span class="d-pt d-dd">${ICON.down}</span></div>
      </div>`;
  }

  /* A task's calm card on one of its faces: the Inbox card is its head alone,
     the working card adds the state line (and the stage chain), the Done card
     the merge. Copies src/components/kanban/KanbanCard.tsx and CardStateLine.tsx. */
  const stateLine = (owner, text) => `<span class="d-sl"><i class="d-sd" data-owner="${owner}"></i><span class="d-sw" data-owner="${owner}">${esc(text)}</span></span>`;
  function stageHtml(name) {
    const label = esc(t(`d.${name}`));
    const kind = STAGE_MODEL[name];
    return `<span class="d-stage" data-stage="${name}">
      <span class="d-st d-st-wait">${glyph(kind, "waiting")}<span>${label}</span></span>
      <span class="d-st d-st-run">${glyph(kind, "running")}<span>${label}</span></span>
      <span class="d-st d-st-ok">${glyph(kind, "passed")}<span>${label}</span></span></span>`;
  }
  function cardHtml(id, face) {
    const task = TASKS[id];
    const head = `<header class="d-ch"><span class="d-ti">${task.icon}</span><span class="d-title">${esc(t(task.title))}</span><span class="d-fold">${ICON.right}</span><span class="d-more">${ICON.more}</span></header>`;
    let body = "";
    if (face === "work" && id === "b") body = `<div class="d-line d-l-work">${stateLine("working", t("d.working1"))}</div>`;
    if (face === "work" && id === "a") {
      body = `<div class="d-line"><span class="d-l-work">${stateLine("working", t("d.working1"))}</span><span class="d-l-done">${stateLine("done", t("d.merged"))}</span></div>
        <div class="d-chain">${["build", "review", "verify"].map(stageHtml).join('<i class="d-to">→</i>')}</div>`;
    }
    if (face === "done") {
      body = `<div class="d-line">${stateLine("done", t("d.merged"))}</div>
        <div class="d-ended"><span>${ICON.check}${esc(t("d.ended"))}</span><b>PR #128</b></div>`;
    }
    return `<article class="d-card" data-card="${id}" data-face="${face}" style="--label:${task.color}">${head}${body}</article>`;
  }

  // ---------- The desktop board ----------

  function buildDesktop() {
    const col = (name) => {
      if (name === "waiting") {
        return `<section class="d-col d-strip" data-col="waiting"><b>${countHtml("waiting")}</b><h4>${esc(t("d.col.waiting"))}</h4></section>`;
      }
      const sum = name === "progress" ? `<span class="d-sum">${countHtml("sum")}</span>` : "";
      return `<section class="d-col" data-col="${name}">
        <header class="d-chd"><h4>${esc(t(`d.col.${name}`))}</h4>${countHtml(name)}${sum}<span class="d-grow"></span>${ICON.expand}${ICON.more}</header>
        <div class="d-colb"><div class="d-emptybox"><b>${esc(t(`d.empty.${name}.t`))}</b><span>${esc(t(`d.empty.${name}.b`))}</span></div></div>
      </section>`;
    };
    stage.innerHTML = `
      <div class="d-top">
        <b class="d-proj">${esc(t("d.project"))}</b>
        <span class="d-cnt">${countHtml("work")}</span>
        <span class="d-grow"></span>
        <span class="d-grp d-find"><span class="d-fi">${ICON.search}${esc(t("d.find"))}</span><span class="d-fb">${ICON.funnel}</span></span>
        <span class="d-btn">${ICON.plus}</span>
        <span class="d-grp"><span class="d-ob">${ICON.bot}${esc(t("d.orch"))}</span><span class="d-fb">${ICON.history}</span></span>
        <span class="d-btn d-bare">${ICON.more}</span>
        <span class="d-needs">${esc(t("d.needs"))}<b>0</b></span>
      </div>
      <div class="d-seat">
        <span class="d-role">${ICON.zap}</span>
        <header class="d-ph">
          ${AVATAR(26)}
          <span class="d-ph-name">${esc(t("d.orch"))}</span>
          <span class="d-status">
            <span class="d-s d-s-none"><i class="d-q"></i>${esc(t("d.status.none"))}</span>
            <span class="d-s d-s-wait"><i class="d-q"></i>${esc(t("d.status.waiting"))}</span>
            <span class="d-s d-s-work"><i class="d-live"><i></i></i>${esc(t("d.status.working"))}</span>
          </span>
          <span class="d-grow"></span>
          <span class="d-hi d-hi-p">${ICON.log}${ICON.expand}</span><span class="d-hi">${ICON.left}</span>
        </header>
        <section class="d-draft">
          <h3>${esc(t("d.draft.title"))}</h3>
          <div class="d-runs"><span class="d-rl">${esc(t("d.draft.runs"))}</span><span class="d-rv">${SPARK}${esc(t("d.draft.engine"))}</span><span class="d-rc">${esc(t("d.draft.change"))}</span></div>
          <span class="d-create">${ICON.bot}${esc(t("d.draft.create"))}</span>
        </section>
        <section class="d-panel">
          <div class="d-row2"><span class="d-eng">${SPARK}Claude</span><span class="d-mod"><b>Opus 5.5</b> · High</span><span class="d-acct">Main</span><span class="d-ctx">6%<i></i></span></div>
          ${chatHtml()}
          ${composerHtml()}
        </section>
      </div>
      <div class="d-board">${["inbox", "progress", "waiting", "done"].map(col).join("")}</div>
      <div class="d-cards">${[["a", "in"], ["b", "in"], ["c", "in"], ["b", "work"], ["a", "work"], ["a", "done"]].map(([id, face]) => cardHtml(id, face)).join("")}</div>
      <div class="d-wires"></div>
      <span class="d-click"></span>
      <span class="d-cursor">${CURSOR}</span>`;
  }

  // ---------- The phone's screens ----------

  function buildPhone() {
    const tab = (name) => `<span class="p-tab" data-tab="${name}"><b>${esc(t(`d.col.${name}`))}</b><span class="p-cn">${countHtml(name)}${name === "progress" ? `<span class="p-sum">${countHtml("sum")}</span>` : ""}</span></span>`;
    const faces = { inbox: [["a", "in"], ["b", "in"], ["c", "in"]], progress: [["b", "work"], ["a", "work"]], waiting: [], done: [["a", "done"]] };
    const column = (name) => `<div class="p-col" data-col="${name}">${name === "progress" ? `<div class="p-empty"><i>${ICON.userCheck}</i><b>${esc(t("d.empty.progress.t"))}</b><p>${esc(t("d.empty.progress.b"))}</p><span class="p-tell">${ICON.chat}${esc(t("d.m.tell"))}</span></div>` : ""}${faces[name].map(([id, face]) => cardHtml(id, face)).join("")}</div>`;
    stage.innerHTML = `
      <div class="p-board">
        <header class="p-bar"><b>${esc(t("d.project"))}${ICON.down}</b><span class="d-grow"></span>${ICON.search}${ICON.more}</header>
        <div class="p-seat">
          <i class="p-ic">${ICON.bot}</i>
          <span class="p-st p-st-none"><b>${esc(t("d.m.none"))}</b><u>${esc(t("d.m.create"))}${ICON.right}</u></span>
          <span class="p-st p-st-wait"><b>${esc(t("d.orch"))}</b><i class="p-badge">${esc(t("d.m.returned"))}</i></span>
          <span class="p-st p-st-work"><b>${esc(t("d.orch"))}</b><i class="p-badge p-badge-ok">${esc(t("d.m.working"))}</i></span>
          <span class="p-sl">${ICON.sliders}</span>
        </div>
        <nav class="p-tabs"><i class="p-sel"></i>${["inbox", "progress", "waiting", "done"].map(tab).join("")}<i class="p-under"></i></nav>
        <div class="p-cols">${["inbox", "progress", "waiting", "done"].map(column).join("")}</div>
        <div class="p-dock">
          <span class="p-dk p-dk-none"><i class="p-ic">${ICON.bot}</i><span>${esc(t("d.m.dockCreate"))}</span>${ICON.right}</span>
          <span class="p-dk p-dk-ready"><i class="p-ic">${ICON.bot}</i><span>${esc(t("d.m.dock"))}</span>${ICON.mic}</span>
        </div>
      </div>
      <div class="p-chat">
        <header class="p-ch">${ICON.left}${AVATAR(30)}<span class="p-ct"><b>${esc(t("d.orch"))}</b><em class="d-status"><span class="d-s d-s-wait"><i class="p-cd"></i>${esc(t("d.m.returned"))}</span><span class="d-s d-s-work"><i class="p-cd p-cd-ok"></i>${esc(t("d.m.working"))}</span></em></span></header>
        ${chatHtml()}
        ${phoneComposerHtml()}
      </div>
      <div class="d-wires"></div>
      <span class="d-click"></span>
      <span class="d-cursor">${CURSOR}</span>`;
  }

  function build() {
    if (mode === "phone") buildPhone();
    else buildDesktop();
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
  /* A track moves an element's opacity and transform together, or one of the two
     (group "o" or "t"), so a card can fade while it glides on its own clock. */
  function track(el, initial, group) {
    /* An element this layout does not draw would tick on the main thread every frame. */
    if (!el || !el.getClientRects().length) return { to() { return this; } };
    const start = { ...START, ...initial };
    const entry = { el, start, group, frames: [{ t: 0, p: start }] };
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
    return frames.map((f) => {
      const frame = { offset: f.t / LOOP, easing: f.ease || "linear" };
      if (entry.group !== "t") frame.opacity = r(f.p.o);
      if (entry.group !== "o") frame.transform = `translate(${r(f.p.x)}px, ${r(f.p.y)}px) scale(${r(f.p.sx)}, ${r(f.p.sy)})`;
      return frame;
    });
  }

  /* The layers of a changing count: each fades in at its time and out at the next. */
  function counter(el, steps) {
    if (steps.length < 2) return;
    [...el.children].forEach((layer, index) => {
      const fade = track(layer, { o: index === 0 ? 1 : 0 });
      if (index > 0) fade.to(steps[index][0], steps[index][0] + 160, { o: 1 }, "linear");
      if (index < steps.length - 1) fade.to(steps[index + 1][0], steps[index + 1][0] + 160, { o: 0 }, "linear");
    });
  }

  /* The composer, the typed request and the chat, shared by the seat's pane and the phone's chat screen. */
  function chatTracks(waitFrom) {
    const comp = box($(".d-comp"));
    const send = $(".d-send");
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
    const shiftAt = (time) => shifts.filter(([at]) => at <= time).reduce((_, [, y]) => y, 0);
    const listTrack = track(msgs);
    let shiftNow = 0;
    let shiftEnd = 0;
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
    $$("[data-chip]").forEach((chip, index) => track(chip, { o: 0, x: -6 }).to(AT.chips + index * 180, AT.chips + index * 180 + 300, { o: 1, x: 0 }));
    track($(".d-turn"), { o: 0 }).to(AT.merged + 400, AT.merged + 650, { o: 1 });
    /* The seat's word: waiting, working while it answers, waiting again after the merge. */
    track($(".d-s-work"), { o: 0 }).to(AT.bubble + 100, AT.bubble + 300, { o: 1 }).to(AT.merged + 200, AT.merged + 400, { o: 0 });
    const waiting = track($(".d-s-wait"), { o: waitFrom === null ? 1 : 0 });
    if (waitFrom !== null) waiting.to(waitFrom, waitFrom + 200, { o: 1 }, "linear");
    waiting.to(AT.bubble + 100, AT.bubble + 300, { o: 0 }).to(AT.merged + 200, AT.merged + 400, { o: 1 });
    return { comp, send, sendAt: centre(box(send)), shiftAt };
  }

  /* One orchestrator wire: straight runs with rounded bends, drawn from the
     seat to a card's port as a reveal (scale) of each run, with a pulse riding
     it. Copies src/components/kanban/orchestratorWires.ts (the bend is 6 px). */
  const BEND = 6;
  function drawWire(points, from, until, pulses) {
    const group = document.createElement("span");
    group.className = "d-wire";
    $(".d-wires").append(group);
    const sign = (n) => Math.sign(n);
    const dirs = points.slice(1).map((p, i) => ({ x: sign(p.x - points[i].x), y: sign(p.y - points[i].y) }));
    const lengths = points.slice(1).map((p, i) => Math.abs(p.x - points[i].x) + Math.abs(p.y - points[i].y));
    const total = lengths.reduce((a, b) => a + b, 0);
    const span = 520;
    let at = from;
    points.slice(1).forEach((p, i) => {
      const a = points[i];
      const lead = i > 0 ? BEND : 0;
      const tail = i < lengths.length - 1 ? BEND : 0;
      const dir = dirs[i];
      const start = { x: a.x + dir.x * lead, y: a.y + dir.y * lead };
      const end = { x: p.x - dir.x * tail, y: p.y - dir.y * tail };
      const len = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
      const seg = document.createElement("i");
      const horizontal = dir.y === 0;
      seg.className = `d-seg ${horizontal ? "h" : "v"}`;
      Object.assign(seg.style, horizontal
        ? { left: `${Math.min(start.x, end.x)}px`, top: `${a.y - 0.75}px`, width: `${len}px`, transformOrigin: dir.x > 0 ? "left" : "right" }
        : { left: `${a.x - 0.75}px`, top: `${Math.min(start.y, end.y)}px`, height: `${len}px`, transformOrigin: dir.y > 0 ? "top" : "bottom" });
      group.append(seg);
      const d = (span * lengths[i]) / total;
      track(seg, horizontal ? { sx: 0 } : { sy: 0 }).to(at, at + d * (len / (lengths[i] || 1)), horizontal ? { sx: 1 } : { sy: 1 }, "linear");
      at += d;
      if (i < lengths.length - 1) {
        /* The bend: a square quarter circle at the corner, shown as the run reaches it. */
        const next = dirs[i + 1];
        const corner = document.createElement("i");
        corner.className = "d-bend";
        const x0 = Math.min(p.x - dir.x * BEND, p.x + next.x * BEND);
        const y0 = Math.min(p.y - dir.y * BEND, p.y + next.y * BEND);
        /* The two sides of its box that meet at the corner point carry the line and the radius. */
        const v = p.y === y0 ? "Top" : "Bottom";
        const h = p.x === x0 ? "Left" : "Right";
        Object.assign(corner.style, { left: `${x0}px`, top: `${y0}px`, width: `${BEND}px`, height: `${BEND}px`, [`border${v}${h}Radius`]: `${BEND}px`, [`border${v}Width`]: "1.5px", [`border${h}Width`]: "1.5px" });
        group.append(corner);
        track(corner, { o: 0 }).to(at - 40, at + 40, { o: 1 }, "linear");
      }
    });
    for (const [index, point] of [[0, points[0]], [1, points[points.length - 1]]]) {
      const port = document.createElement("i");
      port.className = `d-port${index === 0 ? " seat" : ""}`;
      port.style.left = `${point.x - 4}px`;
      port.style.top = `${point.y - 4}px`;
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
  }

  /* The work card's own moments: the stage chain runs Build, Review, Verify, and the state line ends on the merge. */
  function chainTracks(card, workAt) {
    track(card.querySelector(".d-l-work"), { o: 0 }).to(workAt, workAt + 250, { o: 1 }).to(AT.merged, AT.merged + 200, { o: 0 });
    track(card.querySelector(".d-l-done"), { o: 0 }).to(AT.merged + 150, AT.merged + 400, { o: 1 });
    const stageRun = { build: [AT.build, AT.buildOk], review: [AT.review, AT.reviewOk], verify: [AT.verify, AT.verifyOk] };
    for (const [name, [run, ok]] of Object.entries(stageRun)) {
      const el = card.querySelector(`[data-stage="${name}"]`);
      track(el.querySelector(".d-st-wait")).to(run, run + 200, { o: 0 });
      track(el.querySelector(".d-st-run"), { o: 0 }).to(run, run + 200, { o: 1 }).to(ok, ok + 200, { o: 0 });
      track(el.querySelector(".d-st-ok"), { o: 0, sx: 0.9, sy: 0.9 }).to(ok, ok + 260, { o: 1, sx: 1, sy: 1 });
    }
  }

  /* The steps under the stage: the current one lit, each filling while it plays. */
  function railTracks() {
    if (still || !rail) return;
    const items = [...rail.querySelectorAll(".demo-steps > li")];
    items.forEach((item, index) => {
      const [from, to] = [STEPS[index], STEPS[index + 1]];
      const first = index === 0;
      track(item.querySelector(".fill"), { sx: 0 }).to(from, to, { sx: 1 }, "linear");
      const on = track(item.querySelector(".on"), { o: first ? 1 : 0 });
      /* A caption is never missing: the next one replaces it at once and
         rises into place, and the first comes back as the board resets. */
      const cap = track(item.querySelector(".cap"), first ? {} : { o: 0, y: 6 });
      if (!first) {
        on.to(from - 150, from + 150, { o: 1 }, "ease-in-out");
        cap.to(from, from, { o: 1 }).to(from, from + 300, { y: 0 });
      }
      if (to < AT.resetB) on.to(to - 150, to + 150, { o: 0 }, "ease-in-out");
      cap.to(to, to, { o: 0, y: 6 });
      if (first) cap.to(AT.resetB, AT.resetB, { o: 1 }).to(AT.resetB, AT.resetB + 300, { y: 0 });
    });
  }

  /* The cursor and its click rings, from the moments it rests, taps and moves on. */
  function cursorTracks(rest, moves, taps) {
    const size = SIZE[mode];
    const phone = mode === "phone";
    /* Every rest point keeps the whole pointer (the finger's ring, the arrow's
       tail) inside the stage, which clips whatever crosses its edge. */
    const reach = phone ? { left: 16, top: 16, right: 16, bottom: 16 } : { left: 2, top: 2, right: 20, bottom: 24 };
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const pos = (p) => ({ x: clamp(p.x, reach.left, size.w - reach.right), y: clamp(p.y, reach.top, size.h - reach.bottom) });
    const cursorTrack = track($(".d-cursor"), pos(rest));
    const events = [...moves.map(([from, to, point]) => ({ from, move: [from, to, point] })), ...taps.map((at) => ({ from: at, tap: at }))].sort((a, b) => a.from - b.from);
    for (const event of events) {
      if (event.move) cursorTrack.to(event.move[0], event.move[1], pos(event.move[2]), GLIDE);
      else cursorTrack.to(event.tap, event.tap + 90, { sx: 0.82, sy: 0.82 }, "ease-out").to(event.tap + 90, event.tap + 240, { sx: 1, sy: 1 });
    }
  }
  function clickRings(rings) {
    const clickTrack = track($(".d-click"), { o: 0, sx: 0.3, sy: 0.3 });
    for (const [at, p] of rings) clickTrack.to(at, at, { x: p.x, y: p.y, o: 0.55, sx: 0.3, sy: 0.3 }).to(at, at + 480, { o: 0, sx: 1.6, sy: 1.6 }, "ease-out");
  }

  function scriptDesktop() {
    const press = (el, at) => track(el).to(at, at + 90, { sx: 0.96, sy: 0.96 }, "ease-out").to(at + 90, at + 260, { sx: 1, sy: 1 });
    const seat = box($(".d-seat"));

    // Step 1 → 2: the cursor creates the orchestrator.
    const create = $(".d-create");
    const createAt = centre(box(create));
    press(create, AT.create);
    track($(".d-draft")).to(AT.panel - 50, AT.panel + 250, { o: 0, sx: 0.98, sy: 0.98 }, "ease-in");
    track($(".d-panel"), { o: 0, y: 12 }).to(AT.panel, AT.panel + 550, { o: 1, y: 0 });
    track($(".d-hi-p"), { o: 0 }).to(AT.panel, AT.panel + 300, { o: 1 });
    track($(".d-s-none")).to(AT.panel, AT.panel + 200, { o: 0 }, "linear");
    $$("[data-n]").forEach((el) => counter(el, counts()[el.dataset.n]));

    // Step 3 and the chat.
    const { comp, sendAt, shiftAt } = chatTracks(AT.panel);

    // Step 4: each task of the answer flies to the board and lands as a card.
    const colb = Object.fromEntries($$(".d-col:not(.d-strip)").map((col) => [col.dataset.col, box(col.querySelector(".d-colb"))]));
    const cards = Object.fromEntries($$(".d-card").map((el) => [`${el.dataset.card}-${el.dataset.face}`, el]));
    const GAP = 8;
    const PAD = 8;
    const heightOf = (key) => box(cards[key]).h;
    const slot = (col, keys, index) => ({ x: colb[col].x + PAD, y: keys.slice(0, index).reduce((y, key) => y + heightOf(key) + GAP, colb[col].y + 2) });
    const inbox = ["a-in", "b-in", "c-in"];
    const progress = ["b-work", "a-work"];
    for (const [key, el] of Object.entries(cards)) {
      const col = key.endsWith("-in") ? "inbox" : key.endsWith("-work") ? "progress" : "done";
      el.style.width = `${colb[col].w - 2 * PAD}px`;
    }
    const wires = $(".d-wires");
    const home = { a: slot("inbox", inbox, 0), b: slot("inbox", inbox, 1), c: slot("inbox", inbox, 2) };
    const bPos = slot("progress", progress, 0);
    const aPos = slot("progress", progress, 1);
    const c0 = home.a;
    const dPos = slot("done", ["a-done"], 0);
    TASK_IDS.forEach((id, index) => {
      const chip = stage.querySelector(`[data-chip="${id}"]`);
      const from = box(chip.querySelector("svg"));
      from.y += shiftAt(AT.fly);
      const to = home[id];
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
        .to(land, land + 120, { o: 0, sx: 2.2, sy: 2.2 }, "ease-out");
      /* The card is opaque almost at once and grows from its top edge. */
      const fade = track(cards[`${id}-in`], { o: 0 }, "o").to(land - 60, land + 200, { o: 1 }, "ease-out");
      const move = track(cards[`${id}-in`], { ...to, sx: 0.97, sy: 0.97 }, "t").to(land - 60, land + 360, { sx: 1, sy: 1 });
      /* Task b and a are handed to In progress (the card changes face on the way); c rises to the top of the Inbox. */
      if (id === "a") { fade.to(AT.move + 500, AT.move + 800, { o: 0 }, "linear"); move.to(AT.move + 200, AT.move + 820, aPos, GLIDE); }
      if (id === "b") { fade.to(AT.move + 300, AT.move + 600, { o: 0 }, "linear"); move.to(AT.move, AT.move + 620, bPos, GLIDE); }
      if (id === "c") move.to(AT.move + 650, AT.move + 1100, c0, GLIDE);
    });
    const empty = (name, from, to) => track($(`.d-col[data-col="${name}"] .d-emptybox`)).to(from, to, { o: 0 });
    empty("inbox", LAND(0) - 200, LAND(0));
    empty("progress", MOVED.b - 100, MOVED.b + 150);
    empty("done", AT.toDone + 450, AT.toDone + 750);
    track(cards["b-work"], { o: 0 }, "o").to(AT.move, AT.move + 300, { o: 1 }, "linear");
    track(cards["b-work"], { ...home.b }, "t").to(AT.move, AT.move + 620, bPos, GLIDE);
    track(cards["a-work"], { o: 0 }, "o").to(AT.move + 200, AT.move + 500, { o: 1 }, "linear").to(AT.toDone, AT.toDone + 300, { o: 0 }, "linear");
    track(cards["a-work"], { ...home.a }, "t").to(AT.move + 200, AT.move + 820, aPos, GLIDE).to(AT.toDone, AT.toDone + 750, dPos, GLIDE);
    track(cards["a-done"], { o: 0 }, "o").to(AT.toDone, AT.toDone + 300, { o: 1 }, "linear");
    track(cards["a-done"], { ...aPos }, "t").to(AT.toDone, AT.toDone + 750, dPos, GLIDE);

    /* The cards change face as their work starts and lands. */
    track(cards["b-work"].querySelector(".d-l-work"), { o: 0 }).to(AT.wires + 300, AT.wires + 600, { o: 1 });
    chainTracks(cards["a-work"], AT.build);

    // Step 5: the orchestrator's wires reach the cards it runs.
    const lane = seat.y + 11;
    const gutter = colb.progress.x - 6;
    const seatPort = { x: seat.x + seat.w, y: lane };
    const route = (pos) => {
      const y = pos.y + 21;
      return [seatPort, { x: gutter, y: lane }, { x: gutter, y }, { x: pos.x, y }];
    };
    drawWire(route(bPos), AT.wires, null, [AT.wires + 600, AT.review + 600]);
    drawWire(route(aPos), AT.wires + 200, AT.unwire, [AT.review - 700, AT.verify - 700]);

    // The cursor: rest, the create button, the composer, send, then it watches the board.
    const inboxArea = colb.inbox;
    const rest = { x: colb.progress.x + colb.progress.w * 0.45, y: SIZE.desktop.h * 0.78 };
    const typing = { x: comp.x + comp.w * 0.62, y: comp.y + comp.h + 6 };
    const watchInbox = { x: inboxArea.x + inboxArea.w * 0.62, y: slot("inbox", inbox, 2).y + heightOf("c-in") + 30 };
    const watchA = { x: aPos.x + box(cards["a-work"]).w * 0.8, y: aPos.y + heightOf("a-work") + 24 };
    const watchDone = { x: dPos.x + box(cards["a-done"]).w * 0.62, y: dPos.y + heightOf("a-done") + 40 };
    const atComp = { x: comp.x + comp.w * 0.3, y: comp.y + comp.h * 0.42 };
    cursorTracks(rest, [
      [AT.reach, AT.create - 60, createAt],
      [AT.toComposer, AT.focus - 60, atComp],
      [AT.focus + 260, AT.type + 450, typing],
      [AT.toSend, AT.send - 60, sendAt],
      [AT.think, AT.fly + 300, watchInbox],
      [AT.wires + 300, AT.build + 300, watchA],
      [AT.toDone + 300, AT.rest, watchDone],
    ], [AT.create, AT.focus, AT.send]);
    clickRings([[AT.create, createAt], [AT.focus, atComp], [AT.send, sendAt]]);
    railTracks();
  }

  function scriptPhone() {
    $$("[data-n]").forEach((el) => counter(el, counts()[el.dataset.n]));

    // Step 1 → 2: the finger taps «Create an orchestrator»; the seat row and the dock change.
    const createAt = centre(box($(".p-st-none u")));
    track($(".p-st-none")).to(AT.panel, AT.panel + 200, { o: 0 }, "linear");
    track($(".p-st-wait"), { o: 0 }).to(AT.panel, AT.panel + 250, { o: 1 }).to(AT.bubble + 100, AT.bubble + 300, { o: 0 }).to(AT.merged + 200, AT.merged + 400, { o: 1 });
    track($(".p-st-work"), { o: 0 }).to(AT.bubble + 100, AT.bubble + 300, { o: 1 }).to(AT.merged + 200, AT.merged + 400, { o: 0 });
    track($(".p-sl"), { o: 0 }).to(AT.panel, AT.panel + 300, { o: 1 });
    track($(".p-dk-none")).to(AT.panel, AT.panel + 250, { o: 0 }, "linear");
    track($(".p-dk-ready"), { o: 0 }).to(AT.panel, AT.panel + 250, { o: 1 }, "linear");

    // Step 3: the finger taps the dock; the chat is its own screen, which slides in for the request.
    const dockAt = centre(box($(".p-dock")));
    track($(".p-chat"), { x: SIZE.phone.w }, "t").to(PH.slide, PH.slide + 350, { x: 0 }).to(PH.chatOut, PH.chatOut + 400, { x: SIZE.phone.w });
    const { comp, sendAt } = chatTracks(null);

    // Step 4: the Inbox tab opens and the three tasks land in it, then two are handed to In progress.
    const tabs = Object.fromEntries($$("[data-tab]").map((el) => [el.dataset.tab, box(el)]));
    const tabAt = (name) => centre(tabs[name]);
    track($(".p-sel"), { x: tabs.progress.x }).to(PH.tapInbox, PH.tapInbox + 300, { x: tabs.inbox.x }).to(PH.tapProgress, PH.tapProgress + 300, { x: tabs.progress.x }).to(AT.toDone, AT.toDone + 300, { x: tabs.done.x });
    const under = $(".p-under");
    track(under, { x: tabs.progress.x }).to(PH.tapInbox, PH.tapInbox + 300, { x: tabs.inbox.x }).to(PH.tapProgress, PH.tapProgress + 300, { x: tabs.progress.x }).to(AT.toDone, AT.toDone + 300, { x: tabs.done.x });
    const cols = Object.fromEntries($$(".p-col").map((el) => [el.dataset.col, el]));
    track(cols.progress).to(PH.tapInbox, PH.tapInbox + 200, { o: 0 }, "linear").to(PH.tapProgress + 150, PH.tapProgress + 350, { o: 1 }, "linear").to(AT.toDone, AT.toDone + 220, { o: 0 }, "linear");
    track(cols.inbox, { o: 0 }).to(PH.tapInbox + 150, PH.tapInbox + 350, { o: 1 }, "linear").to(PH.tapProgress, PH.tapProgress + 200, { o: 0 }, "linear");
    track(cols.done, { o: 0 }).to(AT.toDone + 150, AT.toDone + 350, { o: 1 }, "linear");
    track($(".p-empty"), { o: 1 }).to(PH.tapInbox, PH.tapInbox + 200, { o: 0 }, "linear");

    const cards = Object.fromEntries($$(".d-card").map((el) => [`${el.dataset.card}-${el.dataset.face}`, el]));
    const PAD = 8;
    const stack = (keys, index) => keys.slice(0, index).reduce((y, key) => y + box(cards[key]).h + PAD, PAD);
    const inbox = ["a-in", "b-in", "c-in"];
    const progress = ["b-work", "a-work"];
    inbox.forEach((key, index) => {
      const land = PH.land + index * 230;
      const fade = track(cards[key], { o: 0 }, "o").to(land, land + 220, { o: 1 }, "ease-out");
      const move = track(cards[key], { y: stack(inbox, index) - 8 }, "t").to(land, land + 320, { y: stack(inbox, index) });
      if (key === "a-in") fade.to(PH.move, PH.move + 250, { o: 0 }, "linear");
      if (key === "b-in") fade.to(PH.move + 100, PH.move + 350, { o: 0 }, "linear");
      if (key === "c-in") move.to(PH.move + 250, PH.move + 650, { y: PAD }, GLIDE);
    });
    progress.forEach((key, index) => {
      const at = PH.tapProgress + 150 + index * 120;
      track(cards[key], { o: 0 }, "o").to(at, at + 220, { o: 1 }, "ease-out");
      track(cards[key], { y: stack(progress, index) - 8 }, "t").to(at, at + 320, { y: stack(progress, index) });
    });
    track(cards["b-work"].querySelector(".d-l-work"), { o: 0 }).to(PH.wires + 300, PH.wires + 600, { o: 1 });
    chainTracks(cards["a-work"], AT.build);
    track(cards["a-done"], { o: 0 }, "o").to(AT.toDone + 250, AT.toDone + 470, { o: 1 }, "ease-out");
    track(cards["a-done"], { y: PAD - 8 }, "t").to(AT.toDone + 250, AT.toDone + 570, { y: PAD });

    // Step 5: the orchestrator's wires run down the open tab's left margin into the cards it runs.
    const seat = box($(".p-seat"));
    const gutter = 6;
    const cardX = box($(".p-col")).x + 16;
    const colY = box($(".p-col")).y;
    const route = (index) => {
      const y = colY + stack(progress, index) + 21;
      return [{ x: gutter, y: seat.y + seat.h / 2 }, { x: gutter, y }, { x: cardX, y }];
    };
    drawWire(route(0), PH.wires, AT.toDone, [PH.wires + 600, AT.review + 600]);
    drawWire(route(1), PH.wires + 200, AT.unwire, [AT.review - 700, AT.verify - 700]);

    // The finger: «Create an orchestrator», the dock, send, then the tabs it opens.
    const typing = { x: comp.x + comp.w * 0.55, y: comp.y + comp.h + 24 };
    cursorTracks({ x: 300, y: 520 }, [
      [AT.reach, AT.create - 60, createAt],
      [AT.toComposer, PH.slide - 60, dockAt],
      [PH.slide + 260, AT.type + 450, typing],
      [AT.toSend, AT.send - 60, sendAt],
      [PH.chatOut, PH.tapInbox - 60, tabAt("inbox")],
      [PH.land + 700, PH.tapProgress - 60, tabAt("progress")],
      [10400, 12200, { x: 250, y: 400 }],
      [AT.verifyOk + 200, AT.toDone - 60, tabAt("done")],
      [AT.toDone + 400, AT.rest, { x: 300, y: 520 }],
    ], [AT.create, PH.slide, AT.send, PH.tapInbox, PH.tapProgress, AT.toDone]);
    clickRings([[AT.create, createAt], [PH.slide, dockAt], [AT.send, sendAt], [PH.tapInbox, tabAt("inbox")], [PH.tapProgress, tabAt("progress")], [AT.toDone, tabAt("done")]]);
    railTracks();
  }

  function script() {
    tracks = [];
    if (mode === "phone") scriptPhone();
    else scriptDesktop();
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
      /* It plays once most of it is in view, or while its top edge is on screen
         with a quarter of it showing: the hero sits partly under the fold of a
         laptop's first screen, and its first step is at the top. Scrolled on,
         with the top gone and less than most of it left, it pauses. */
      for (const entry of entries) {
        const top = entry.rootBounds ? entry.rootBounds.top : 0;
        const topInView = entry.boundingClientRect.top >= top;
        onScreen = entry.isIntersecting && (entry.intersectionRatio >= 0.55 || (topInView && entry.intersectionRatio >= 0.25));
      }
      sync();
    }, { threshold: [0, 0.25, 0.55] }).observe(host);
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
