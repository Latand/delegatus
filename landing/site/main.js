// Behaviour for the landing: language, install boxes, the legacy giggle and
// the live demo frames. The hero's demo plays itself (boardDemo.js). Classic
// script.
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

  function countEvent(event, agent) {
    const body = { event, lang, ...(agent ? { agent } : {}) };
    try {
      navigator.sendBeacon("/api/event", new Blob([JSON.stringify(body)], { type: "application/json" }));
    } catch { /* Counting is best-effort and never blocks the visitor's action. */ }
  }

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
      countEvent("copy_prompt", box.agent);
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
      countEvent("copy_legacy");
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

  // ---------- The phone visitor's action ----------
  //
  // Delegatus runs on a computer, so on a phone the hero leads with sending
  // this page there: the system share sheet, or a copied link without one.

  const share = document.querySelector("[data-share]");
  share?.addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}?lang=${lang}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: document.title, url });
        return;
      }
    } catch (error) {
      if (error && error.name === "AbortError") return;
    }
    if (!(await writeClipboard(url))) return;
    const label = share.querySelector("span");
    label.textContent = t("share.copied");
    setTimeout(() => { label.textContent = t("share.btn"); }, 2000);
  });

  // The hero's demo counts once, when it first plays on screen.
  document.addEventListener("demo-start", () => countEvent("demo_start"), { once: true });

  // ---------- The live frames ----------
  //
  // The pictures of the product below the hero are the product: an iframe
  // running Delegatus's own interface over invented data (demo/). The page
  // tells a frame which language, step and view to show.

  // A touch screen this short is a phone turned sideways; a tablet keeps the
  // desktop frames.
  const phoneQuery = matchMedia("(max-width: 639px), (hover: none) and (pointer: coarse) and (max-height: 639px)");
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
  // The frame that is showing full screen, and how: the browser's Fullscreen
  // API where it exists, or the same layout as a fixed overlay where it does not.
  let fsLive = null;
  let fsNative = false;
  let fsScroll = null;
  let fsWatch = null;

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
    // A phone demo keeps the product's canonical viewport in every mode.
    // Fit the whole device into the available space rather than stretching
    // the chat to the browser's viewport (including short landscape screens).
    const full = fsLive === live;
    const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
    if (live.root) live.root.style.maxHeight = full && phone ? `${visibleHeight}px` : "";
    const width = (full ? live.host.clientWidth : live.el.clientWidth) || 1;
    const lw = phone ? Number(d.pw) : full ? width : Math.max(Number(d.lw), width);
    const lh = phone ? Number(d.ph) : full ? live.host.clientHeight || 1 : Number(d.lh);
    // Embedded frames size against the layout viewport, which holds still
    // while the browser's toolbar collapses or the keyboard opens, so the
    // page under the visitor's finger does not reflow.
    const availableHeight = full
      ? Math.min(live.host.clientHeight || 1, visibleHeight) - 24
      : document.documentElement.clientHeight * 0.78;
    const scale = phone
      ? Math.max(0.01, Math.min(1, (width - 24) / lw, availableHeight / lh))
      : full ? 1 : width / lw;
    live.el.style.height = full ? "" : `${Math.ceil(lh * scale) + (phone ? 24 : 0)}px`;
    live.el.dataset.mode = phone ? "phone" : "desktop";
    if (live.iframe) {
      live.iframe.style.width = `${lw}px`;
      live.iframe.style.height = `${lh}px`;
      live.iframe.style.left = phone ? "50%" : "0";
      live.iframe.style.top = phone ? "50%" : "0";
      live.iframe.style.transformOrigin = phone ? "center" : "0 0";
      live.iframe.style.transform = phone ? `translate(-50%, -50%) scale(${scale})` : scale === 1 ? "" : `scale(${scale})`;
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
    for (const tab of document.querySelectorAll(`[data-tabs-for="${live.id}"] [data-view]`)) {
      const on = tab.dataset.view === view;
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
        const view = tab.dataset.view;
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
    if (first) live.view = first.dataset.view;
  }

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
    if (data.type === "dlg:state" && typeof data.step === "number") live.step = data.step;
  });

  // Each frame loads as it comes near.
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
  // run frame goes full screen inside its window, so its tabs stay in reach;
  // the other two take a strip of their own.
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
    countEvent("fullscreen_open");
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
    live.root.style.maxHeight = "";
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
  window.visualViewport?.addEventListener("resize", relayout);

  onLanguage = () => {
    renderReleases();
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
  // ---------- Live numbers: the version and how recently it shipped ----------

  let releases = null;
  const DAY = 86_400_000;
  function renderReleases() {
    if (!releases) return;
    const now = Date.now();
    const days = Math.max(0, Math.round((now - releases.latestAt) / DAY));
    const ago = new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(-days, "day");
    const month = releases.times.filter((at) => now - at <= 30 * DAY).length;
    const form = new Intl.PluralRules(lang).select(month);
    const word = lang === "uk"
      ? ({ one: "реліз", few: "релізи", many: "релізів" })[form] ?? "релізу"
      : form === "one" ? "release" : "releases";
    document.querySelector("[data-released]").textContent = lang === "uk"
      ? `вийшла ${ago} · ${month} ${word} за 30 днів`
      : `released ${ago} · ${month} ${word} in 30 days`;
  }

  fetch("https://registry.npmjs.org/delegatus-cli")
    .then((r) => (r.ok ? r.json() : null))
    .then((pkg) => {
      const latest = pkg && pkg["dist-tags"] && pkg["dist-tags"].latest;
      if (!latest) return;
      document.querySelector("[data-version]").textContent = latest;
      if (!pkg.time || !pkg.time[latest]) return;
      // 0.0.0 held the name before the first release under it.
      const times = Object.entries(pkg.time)
        .filter(([version]) => /^\d+\.\d+\.\d+$/.test(version) && version !== "0.0.0")
        .map(([, at]) => Date.parse(at));
      releases = { latestAt: Date.parse(pkg.time[latest]), times };
      renderReleases();
    })
    .catch(() => {});
})();
