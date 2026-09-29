// Behaviour for the landing: language, install boxes, the legacy giggle and
// the live demo frames. Classic script.
(function () {
  "use strict";

  const { strings, prompt, agents } = window.DLG.copy;
  const mascot = window.DLG.mascot;
  const root = document.documentElement;
  const still = root.classList.contains("still");
  const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

  let lang = root.lang === "uk" ? "uk" : "en";
  const t = (key) => strings[lang][key] ?? strings.en[key] ?? key;
  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---------- Install boxes ----------

  const template = document.getElementById("install-template");
  const installs = [];

  for (const slot of document.querySelectorAll("[data-install]")) {
    slot.appendChild(template.content.cloneNode(true));
    const id = slot.dataset.install;
    const box = {
      slot,
      agent: "claude",
      tabs: [...slot.querySelectorAll('[role="tab"]')],
      panel: slot.querySelector('[role="tabpanel"]'),
      code: slot.querySelector("[data-prompt]"),
      copy: slot.querySelector("[data-copy-prompt]"),
      copyLabel: slot.querySelector("[data-copy-label]"),
      more: slot.querySelector(".prompt-more"),
      legacyLink: slot.querySelector(".legacy-link"),
      legacy: slot.querySelector(".legacy"),
      bubble: slot.querySelector("[data-bubble]"),
      copyCmd: slot.querySelector("[data-copy-cmd]"),
      copyTimer: 0,
      legacyState: "closed",
      anims: [],
    };
    box.panel.id = `prompt-${id}`;
    box.legacy.id = `legacy-${id}`;
    box.legacyLink.setAttribute("aria-controls", box.legacy.id);
    box.tabs.forEach((tab) => {
      tab.id = `tab-${id}-${tab.dataset.agent}`;
      tab.setAttribute("aria-controls", box.panel.id);
    });
    installs.push(box);
    wireInstall(box);
  }

  mascot.mount(document);

  function renderPrompt(box) {
    const text = prompt(box.agent, lang);
    box.code.innerHTML = escapeHtml(text).replace(/`([^`]+)`/g, '<span class="cmd">`$1`</span>');
    box.panel.setAttribute("aria-labelledby", `tab-${box.slot.dataset.install}-${box.agent}`);
  }

  function selectTab(box, agent, focus) {
    box.agent = agent;
    for (const tab of box.tabs) {
      const on = tab.dataset.agent === agent;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
    resetCopy(box);
    renderPrompt(box);
  }

  function resetCopy(box) {
    clearTimeout(box.copyTimer);
    box.copy.removeAttribute("data-copied");
    box.copyLabel.textContent = t("install.copy");
  }

  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      area.remove();
      return ok;
    }
  }

  function wireInstall(box) {
    box.tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => selectTab(box, tab.dataset.agent, false));
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        const next = box.tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + box.tabs.length) % box.tabs.length];
        selectTab(box, next.dataset.agent, true);
      });
    });

    box.copy.addEventListener("click", async () => {
      const ok = await writeClipboard(prompt(box.agent, lang));
      if (!ok) return;
      box.copy.setAttribute("data-copied", "");
      box.copyLabel.textContent = t("install.copied").replace("{agent}", agents[box.agent]);
      clearTimeout(box.copyTimer);
      box.copyTimer = setTimeout(() => resetCopy(box), 2000);
    });

    box.more.addEventListener("click", () => {
      const open = box.panel.dataset.open !== "true";
      box.panel.dataset.open = String(open);
      box.more.setAttribute("aria-expanded", String(open));
      box.more.querySelector("span").textContent = t(open ? "install.less" : "install.more");
    });

    box.legacyLink.addEventListener("click", () => {
      if (box.legacyState === "closed") openLegacy(box);
      else closeLegacy(box);
    });

    box.copyCmd.addEventListener("click", async () => {
      const ok = await writeClipboard("bunx delegatus-cli");
      if (!ok) return;
      box.copyCmd.setAttribute("data-copied", "");
      box.copyCmd.setAttribute("aria-label", t("legacy.copied"));
      setTimeout(() => {
        box.copyCmd.removeAttribute("data-copied");
        box.copyCmd.setAttribute("aria-label", t("legacy.copy"));
      }, 2000);
      if (box.legacyState === "teasing") settleLegacy(box);
    });
  }

  // ---------- The giggle ----------

  function parts(host) {
    return {
      host,
      body: host.querySelector(".m-body"),
      glasses: host.querySelector(".m-glasses"),
    };
  }

  function stopAnims(box) {
    box.anims.forEach((a) => a.cancel());
    box.anims = [];
  }

  // The mascot appears once per viewport: while the hero's legacy box has it
  // giggling, the hero's own bird steps out of view, and it comes back once
  // the giggler has ducked ("I'll be in the browser").
  const heroBirds = () => [...document.querySelectorAll(".hero .catcher")];

  function awayHeroBirds(box, away) {
    if (box.slot.dataset.install !== "hero") return;
    for (const bird of heroBirds()) {
      if (still) {
        bird.style.visibility = away ? "hidden" : "";
        continue;
      }
      bird.animate(
        away
          ? [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(18px) scale(.9)" }]
          : [{ opacity: 0, transform: "translateY(18px) scale(.9)" }, { opacity: 1, transform: "none" }],
        { duration: 320, easing: EASE, fill: "forwards" },
      );
    }
  }

  function openLegacy(box) {
    stopAnims(box);
    awayHeroBirds(box, true);
    box.legacyState = "teasing";
    box.legacy.hidden = false;
    box.legacyLink.setAttribute("aria-expanded", "true");
    box.bubble.textContent = t("legacy.tease");
    box.bubble.style.opacity = "";
    const m = parts(box.legacy.querySelector(".giggler"));
    m.host.style.transform = "";
    if (still) return;
    box.anims.push(
      m.host.animate([{ transform: "translateY(12%)" }, { transform: "translateY(-60%)" }], { duration: 460, easing: EASE, fill: "backwards" }),
      box.bubble.animate(
        [{ opacity: 0, transform: "translateY(6px) scale(.94)" }, { opacity: 1, transform: "none" }],
        { duration: 360, delay: 380, easing: EASE, fill: "backwards" },
      ),
      // Shoulders shake: two short cycles, and the glasses bounce 2 px.
      m.body.animate(
        [
          { transform: "none" },
          { transform: "translateY(-1.6px) rotate(-2deg)" },
          { transform: "none" },
          { transform: "translateY(-1.6px) rotate(2deg)" },
          { transform: "none" },
        ],
        { duration: 360, delay: 520, easing: "ease-in-out" },
      ),
      m.glasses.animate(
        [{ transform: "none" }, { transform: "translateY(-2px)" }, { transform: "none" }, { transform: "translateY(-2px)" }, { transform: "none" }],
        { duration: 360, delay: 520, easing: "ease-in-out" },
      ),
    );
  }

  function settleLegacy(box) {
    box.legacyState = "settled";
    box.bubble.textContent = t("legacy.fine");
    if (still) {
      awayHeroBirds(box, false);
      return;
    }
    setTimeout(() => { if (box.legacyState === "settled") awayHeroBirds(box, false); }, 1950);
    const m = parts(box.legacy.querySelector(".giggler"));
    box.anims.push(
      m.host.animate([{ transform: "translateY(-60%)" }, { transform: "translateY(14%)" }], {
        duration: 420, delay: 1500, easing: "cubic-bezier(0.7, 0, 0.84, 0)", fill: "forwards",
      }),
      box.bubble.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, delay: 1750, fill: "forwards" }),
    );
  }

  function closeLegacy(box) {
    if (box.legacyState === "teasing") awayHeroBirds(box, false);
    stopAnims(box);
    box.legacyState = "closed";
    box.legacy.hidden = true;
    box.legacyLink.setAttribute("aria-expanded", "false");
  }

  // ---------- Language ----------

  function applyLanguage(next, persist) {
    const position = { left: scrollX, top: scrollY, behavior: "instant" };
    lang = next;
    root.lang = lang;
    document.title = t("meta.title");
    document.querySelector('meta[name="description"]').setAttribute("content", t("meta.description"));
    for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
    for (const el of document.querySelectorAll("[data-i18n-key]")) {
      el.innerHTML = escapeHtml(t(el.dataset.i18nKey)).replace("{key}", "<kbd>/</kbd>");
    }
    for (const button of document.querySelectorAll("[data-lang]")) {
      button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
    }
    for (const box of installs) {
      resetCopy(box);
      renderPrompt(box);
      box.more.querySelector("span").textContent = t(box.panel.dataset.open === "true" ? "install.less" : "install.more");
      if (box.legacyState === "teasing") box.bubble.textContent = t("legacy.tease");
      if (box.legacyState === "settled") box.bubble.textContent = t("legacy.fine");
    }
    if (!persist) return;
    onLanguage();
    try { localStorage.setItem("dlg-lang", lang); } catch { /* private mode */ }
    try {
      const url = new URL(location.href);
      url.searchParams.set("lang", lang);
      history.replaceState(null, "", url);
    } catch { /* file:// in some browsers */ }
    // Translation can change line wrapping above the reader. Resolve layout
    // now, then retain the position from before the language changed.
    window.scrollTo(position);
  }

  let onLanguage = () => {};
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.addEventListener("click", () => {
      if (button.dataset.lang !== lang) applyLanguage(button.dataset.lang, true);
    });
  }
  applyLanguage(lang, false);

  // ---------- The live demo ----------
  //
  // Every picture of the product on this page is the product: an iframe
  // running Delegatus's own interface over invented data (demo/). The page
  // tells a frame which language, step and view to show; the hero's frame
  // runs the scripted walkthrough and reports its step back.

  const phoneQuery = matchMedia("(max-width: 639px)");
  // Where the hero's frame turns at each step of the script. On the desktop
  // the board has the orchestrator docked beside it; on the phone the chat
  // holds the request until it is sent, the board shows the new card, and
  // "Orchestrator" is its report log once the reports start landing.
  const HERO_VIEW_FOR_STEP = { 0: "board", 2: "board", 3: "orchestrator", 4: "orchestrator", 5: "board" };
  const HERO_PHONE_VIEW_FOR_STEP = { 0: "orchestrator", 2: "board", 3: "orchestrator", 4: "orchestrator", 5: "board" };
  const lives = [...document.querySelectorAll("[data-live]")].map((el) => ({
    el,
    id: el.dataset.live,
    host: el.querySelector(".live-frame"),
    fixed: el.hasAttribute("data-fixed"),
    iframe: null,
    phone: false,
    step: null,
    view: null,
  }));
  const hero = lives.find((live) => live.id === "hero");
  let panAnimation = 0;
  function stopPanMomentum() {
    cancelAnimationFrame(panAnimation);
    panAnimation = 0;
  }
  // A forwarded pan follows the finger in viewport coordinates. The frame moves
  // under the finger whenever the page scrolls, so the frame's own reading of
  // the touch is turned into viewport terms here, where the frame's position
  // is known, and the page is never scrolled by a difference between readings
  // taken in a frame that has moved in between.
  let pan = null;
  function fingerInViewport(live, y) {
    const box = live.iframe.getBoundingClientRect();
    return box.top + y * (box.height / (live.iframe.offsetHeight || 1));
  }
  window.addEventListener("touchstart", stopPanMomentum, { passive: true });
  window.addEventListener("wheel", stopPanMomentum, { passive: true });
  function coastPan(velocity) {
    if (!Number.isFinite(velocity) || Math.abs(velocity) < 0.35) return;
    stopPanMomentum();
    let last = performance.now();
    function tick(now) {
      const elapsed = Math.min(32, now - last);
      last = now;
      window.scrollBy(0, velocity * elapsed);
      velocity *= Math.exp(-elapsed / 180);
      if (Math.abs(velocity) >= 0.05) panAnimation = requestAnimationFrame(tick);
      else panAnimation = 0;
    }
    panAnimation = requestAnimationFrame(tick);
  }
  let heroManual = false;
  // The frame that is showing full screen, and how: the browser's Fullscreen
  // API where it exists, or the same layout as a fixed overlay where it does not.
  let fsLive = null;
  let fsNative = false;
  let fsScroll = null;
  let fsWatch = null;
  const heroViewFor = (step) => ((hero.fixed || phoneQuery.matches) ? HERO_PHONE_VIEW_FOR_STEP : HERO_VIEW_FOR_STEP)[step];

  function liveSrc(live) {
    const params = new URLSearchParams(live.phone ? live.el.dataset.phoneQuery : live.el.dataset.query);
    params.set("lang", lang);
    if (live.step !== null) params.set("step", String(live.step));
    if (live.view) params.set("view", live.view);
    return `demo/index.html?${params}`;
  }

  function layout(live) {
    const phone = live.fixed || phoneQuery.matches;
    const d = live.el.dataset;
    // Full screen runs the product at the size of the space it has, unscaled,
    // so its own responsive layout decides what the visitor sees.
    const full = fsLive === live;
    const width = (full ? live.host.clientWidth : live.el.clientWidth) || 1;
    const lw = full ? width : phone ? Number(d.pw) : Math.max(Number(d.lw), width);
    const lh = full ? live.host.clientHeight || 1 : phone ? Number(d.ph) : Number(d.lh);
    const scale = full ? 1 : width / lw;
    live.el.style.height = full ? "" : `${Math.round(lh * scale)}px`;
    live.el.dataset.mode = phone ? "phone" : "desktop";
    if (live.iframe) {
      live.iframe.style.width = `${lw}px`;
      live.iframe.style.height = `${lh}px`;
      live.iframe.style.transform = scale === 1 ? "" : `scale(${scale})`;
    }
    if (phone !== live.phone) {
      live.phone = phone;
      if (live.iframe) live.iframe.src = liveSrc(live);
    }
  }

  function createFrame(live) {
    const iframe = document.createElement("iframe");
    iframe.title = live.el.getAttribute("aria-label") || "Delegatus";
    iframe.src = liveSrc(live);
    // Esc inside the product reaches the page as well, for the overlay mode.
    iframe.addEventListener("load", () => {
      try { iframe.contentWindow.addEventListener("keydown", onEscape); } catch { /* cross-origin */ }
    });
    return iframe;
  }

  function mount(live) {
    if (live.iframe) return;
    live.iframe = createFrame(live);
    layout(live);
    live.host.appendChild(live.iframe);
  }

  // A new face of a frame is a fresh frame, laid over the old one and swapped
  // in once it has drawn, so a view never inherits what the last one left open.
  function reload(live) {
    if (!live.iframe) return;
    live.el.querySelector(".demo-retry")?.remove();
    const next = createFrame(live);
    next.dataset.incoming = "";
    const old = live.iframe;
    live.iframe = next;
    layout(live);
    live.host.appendChild(next);
    live.el.setAttribute("data-busy", "");
    const settle = () => {
      if (!next.isConnected || !next.hasAttribute("data-incoming")) return;
      next.removeAttribute("data-incoming");
      delete next.settle;
      live.el.removeAttribute("data-busy");
      live.el.setAttribute("data-loaded", "");
      setTimeout(() => old.remove(), 450);
    };
    next.settle = settle;
  }

  function send(live, message) {
    if (live.iframe && live.iframe.contentWindow) live.iframe.contentWindow.postMessage(message, "*");
  }

  function markTabs(live, view) {
    live.view = view;
    for (const tab of document.querySelectorAll(`[data-tabs-for="${live.id}"] [data-view], [data-tabs-for="${live.id}"] [data-hero-view]`)) {
      const on = (tab.dataset.view || tab.dataset.heroView) === view;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    }
  }

  function showView(live, view, fresh) {
    markTabs(live, view);
    live.el.querySelector(".demo-retry")?.remove();
    if (fresh) reload(live);
    else {
      live.el.setAttribute("data-busy", "");
      send(live, { type: "dlg:view", view });
    }
  }

  // Tab lists: each drives the frame of its own section.
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    if (list.closest(".install")) continue;
    const section = list.closest("section");
    const live = list.dataset.for ? lives.find((entry) => entry.id === list.dataset.for) : lives.find((entry) => section && section.contains(entry.el));
    if (!live) continue;
    list.dataset.tabsFor = live.id;
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => {
        if (live === hero) heroManual = true;
        const view = tab.dataset.view || tab.dataset.heroView;
        if (view === live.view && live.iframe) return;
        if (!live.iframe) {
          live.view = view;
          mount(live);
        }
        showView(live, view, false);
      });
      tab.addEventListener("keydown", (event) => {
        const vertical = list.getAttribute("aria-orientation") === "vertical";
        const forward = vertical ? "ArrowDown" : "ArrowRight";
        const back = vertical ? "ArrowUp" : "ArrowLeft";
        if (event.key !== forward && event.key !== back) return;
        event.preventDefault();
        const next = tabs[(index + (event.key === forward ? 1 : -1) + tabs.length) % tabs.length];
        next.focus();
        next.click();
      });
    });
    const first = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
    if (first) live.view = first.dataset.view || first.dataset.heroView;
  }

  // The hero's steps: a rail under the frame, and a line that says what just happened.
  const stepButtons = [...document.querySelectorAll("[data-step]")];
  const hint = document.querySelector("[data-step-hint]");
  let heroStep = 0;
  const playback = document.querySelector("[data-playback]");
  let playbackAnimation;

  function renderSteps() {
    const shown = heroStep === 1 ? 0 : heroStep;
    for (const button of stepButtons) {
      const at = Number(button.dataset.step);
      button.toggleAttribute("data-done", at < shown || (heroStep === 1 && at === 0));
      if (at === shown && heroStep !== 1) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    }
    hint.textContent = t(`hint.${heroStep}`);
    hint.dataset.step = String(heroStep);
  }

  for (const button of stepButtons) {
    button.addEventListener("click", () => {
      const to = Number(button.dataset.step);
      heroManual = false;
      mount(hero);
      if (to < heroStep || !hero.iframe) {
        hero.step = to;
        heroStep = to;
        renderSteps();
        showView(hero, heroViewFor(to), true);
        return;
      }
      heroStep = to;
      renderSteps();
      send(hero, { type: "dlg:step", step: to });
      showView(hero, heroViewFor(to));
    });
  }
  document.querySelector("[data-replay]").addEventListener("click", () => {
    heroManual = false;
    hero.step = 0;
    heroStep = 0;
    renderSteps();
    showView(hero, heroViewFor(0), true);
  });

  window.addEventListener("message", (event) => {
    const live = lives.find((entry) => entry.iframe && entry.iframe.contentWindow === event.source);
    const data = event.data;
    if (!live || !data || typeof data.type !== "string") return;
    // A frame that fills the screen has no page to pan.
    const pans = live.phone && fsLive !== live;
    if (data.type === "dlg:vertical-start") {
      if (pans) stopPanMomentum();
      pan = null;
      return;
    }
    if (data.type === "dlg:vertical-pan") {
      if (!pans || !live.iframe || !Number.isFinite(data.y)) return;
      const now = fingerInViewport(live, data.y);
      if (!pan) pan = { last: Number.isFinite(data.fromY) ? fingerInViewport(live, data.fromY) : now, samples: [] };
      const at = performance.now();
      pan.samples.push({ y: now, at });
      pan.samples = pan.samples.filter((sample) => at - sample.at <= 90);
      window.scrollBy(0, Math.max(-100, Math.min(100, pan.last - now)));
      pan.last = now;
      return;
    }
    if (data.type === "dlg:vertical-end") {
      const samples = pan ? pan.samples : [];
      pan = null;
      if (!pans || samples.length < 2) return;
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (last.at > first.at && performance.now() - last.at < 80) {
        coastPan(Math.max(-1.8, Math.min(1.8, (first.y - last.y) / (last.at - first.at))));
      }
      return;
    }
    if (data.type === "dlg:view-error") {
      if (live.view && data.view !== live.view) {
        send(live, { type: "dlg:view", view: live.view });
        return;
      }
      live.el.removeAttribute("data-busy");
      live.el.querySelector(".demo-retry")?.remove();
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "demo-retry";
      retry.textContent = lang === "uk" ? "Не вдалося відкрити. Спробувати ще раз" : "Could not open this view. Try again";
      retry.addEventListener("click", () => showView(live, live.view || data.view));
      live.el.appendChild(retry);
      return;
    }
    if (data.type === "dlg:viewed") {
      if (data.view && live.view && data.view !== live.view) {
        // A click during script loading may precede the frame's listener.
        // Replay the reader's latest tab once the frame can receive it.
        send(live, { type: "dlg:view", view: live.view });
        return;
      }
      live.el.querySelector(".demo-retry")?.remove();
      if (live.iframe.settle) live.iframe.settle();
      else {
        live.el.setAttribute("data-loaded", "");
        live.el.removeAttribute("data-busy");
      }
      return;
    }
    if (data.type === "dlg:lang" && (data.lang === "en" || data.lang === "uk") && data.lang !== lang) {
      applyLanguage(data.lang, true);
      return;
    }
    if (data.type !== "dlg:state" || typeof data.step !== "number") return;
    const moved = data.step !== live.step;
    live.step = data.step;
    if (live !== hero) return;
    heroStep = data.step;
    playback.hidden = !data.playing;
    playbackAnimation?.cancel();
    if (data.playing && !still) playbackAnimation = playback.querySelector("span").animate(
      [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      { duration: data.nextInMs, fill: "forwards" },
    );
    renderSteps();
    /* While the script plays, the frame turns to where the step happened. */
    const target = heroViewFor(data.step);
    if (moved && !heroManual && target && target !== hero.view) showView(hero, target);
  });

  // The hero's frame loads with the page, on the view its first step shows;
  // the others as they come near.
  markTabs(hero, heroViewFor(0));
  mount(hero);
  const near = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const live = lives.find((item) => item.el === entry.target);
      if (live) mount(live);
    }
  }, { threshold: 0.1 });
  for (const live of lives) near.observe(live.el);


  // ---------- Full screen ----------
  //
  // Every frame has a control that shows it at the size of the screen. The
  // hero and the run frame go full screen inside their window, so the tabs and
  // the hero's steps stay in reach; the other two take a strip of their own.
  // Where the browser has no element fullscreen (iPhone), the same layout
  // is a fixed overlay with the page behind it locked.

  const ICON_ENTER = '<svg class="i i-enter" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
  const ICON_EXIT = '<svg class="i i-exit" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>';
  const nativeElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

  for (const live of lives) {
    live.root = live.el.closest(".stage-wrap") || live.el;
    live.fsButton = document.createElement("button");
    live.fsButton.type = "button";
    live.fsButton.className = "fs-btn";
    live.fsButton.innerHTML = ICON_ENTER + ICON_EXIT;
    live.fsButton.addEventListener("click", () => (fsLive === live ? leaveFullscreen() : enterFullscreen(live)));
    const bar = live.root.querySelector(":scope > .stage-bar");
    if (bar) bar.after(live.fsButton);
    else live.root.appendChild(live.fsButton);
  }

  function labelFullscreen() {
    for (const live of lives) {
      const label = t(fsLive === live ? "demo.exitFullscreen" : "demo.fullscreen");
      live.fsButton.setAttribute("aria-label", label);
      live.fsButton.title = label;
      live.fsButton.toggleAttribute("data-on", fsLive === live);
    }
  }

  function enterFullscreen(live) {
    if (fsLive) return;
    fsLive = live;
    fsNative = false;
    fsScroll = { left: scrollX, top: scrollY };
    live.root.setAttribute("data-fs", "");
    root.classList.add("fs-lock");
    labelFullscreen();
    layout(live);
    fsWatch = new ResizeObserver(() => layout(live));
    fsWatch.observe(live.host);
    live.fsButton.focus({ preventScroll: true });
    const request = live.root.requestFullscreen || live.root.webkitRequestFullscreen;
    if (request && document.fullscreenEnabled !== false) {
      try { Promise.resolve(request.call(live.root)).catch(() => {}); } catch { /* the overlay stands */ }
    }
  }

  // Leaving the browser's full screen is asynchronous; the page is put back
  // once it has finished, so what moves during the exit cannot move the page.
  function leaveFullscreen() {
    if (!fsLive) return;
    const live = fsLive;
    if (nativeElement() === live.root) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      setTimeout(() => { if (fsLive === live) finishLeave(); }, 1000);
      return;
    }
    finishLeave();
  }

  function finishLeave() {
    const live = fsLive;
    if (!live) return;
    fsLive = null;
    fsNative = false;
    fsWatch?.disconnect();
    fsWatch = null;
    live.root.removeAttribute("data-fs");
    root.classList.remove("fs-lock");
    labelFullscreen();
    lives.forEach(layout);
    // The frame left the page's flow while it was full, which can move the page.
    const back = () => window.scrollTo({ ...fsScroll, behavior: "instant" });
    back();
    requestAnimationFrame(() => { back(); requestAnimationFrame(back); });
    live.fsButton.focus({ preventScroll: true });
  }

  function onFullscreenChange() {
    if (!fsLive) return;
    if (nativeElement() === fsLive.root) fsNative = true;
    else if (fsNative) finishLeave();
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  // The browser takes Esc itself in native full screen; the overlay needs it
  // here. The demo also sends itself a synthetic Esc to close panels between
  // views, which is not the visitor's.
  function onEscape(event) {
    if (event.key === "Escape" && event.isTrusted && fsLive && !fsNative && !event.defaultPrevented) leaveFullscreen();
  }
  document.addEventListener("keydown", onEscape);
  window.addEventListener("resize", () => { if (fsLive) layout(fsLive); });
  labelFullscreen();

  const relayout = () => lives.forEach(layout);
  new ResizeObserver(relayout).observe(document.body);
  phoneQuery.addEventListener("change", relayout);

  onLanguage = () => {
    renderSteps();
    labelFullscreen();
    for (const live of lives) {
      live.el.querySelector(".demo-retry")?.remove();
      if (live.iframe) {
        live.iframe.title = live.el.getAttribute("aria-label") || "Delegatus";
        const rect = live.el.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < innerHeight) reload(live);
        else {
          // Hidden translated frames restart when they enter the viewport.
          // Release the old Viewer now so its timers stop and its old language
          // cannot flash into view while the replacement starts.
          live.host.replaceChildren();
          live.iframe = null;
          live.el.removeAttribute("data-loaded");
          live.el.removeAttribute("data-busy");
        }
      }
    }
  };
  renderSteps();

  // ---------- Live numbers: stars and version ----------

  fetch("https://api.github.com/repos/Latand/delegatus", { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((repo) => {
      if (!repo || typeof repo.stargazers_count !== "number") return;
      document.querySelector("[data-stars-count]").textContent = repo.stargazers_count.toLocaleString(lang === "uk" ? "uk-UA" : "en-US");
      document.querySelector("[data-stars]").hidden = false;
    })
    .catch(() => {});

  fetch("https://registry.npmjs.org/delegatus-cli", { headers: { Accept: "application/vnd.npm.install-v1+json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((pkg) => {
      const latest = pkg && pkg["dist-tags"] && pkg["dist-tags"].latest;
      if (latest) document.querySelector("[data-version]").textContent = latest;
    })
    .catch(() => {});
})();
