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
    wanted: false,
  }));
  const hero = lives.find((live) => live.id === "hero");
  let heroManual = false;
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
    const width = live.el.clientWidth || 1;
    const lw = phone ? Number(d.pw) : Math.max(Number(d.lw), width);
    const lh = phone ? Number(d.ph) : Number(d.lh);
    const scale = width / lw;
    live.el.style.height = `${Math.round(lh * scale)}px`;
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
      live.el.removeAttribute("data-busy");
      live.el.setAttribute("data-loaded", "");
      setTimeout(() => old.remove(), 450);
    };
    next.settle = settle;
    setTimeout(settle, 6000);
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
    if (fresh) reload(live);
    else send(live, { type: "dlg:view", view });
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
        showView(live, view, live !== hero);
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
    if (data.type === "dlg:viewed") {
      if (live.iframe.settle) live.iframe.settle();
      else live.el.setAttribute("data-loaded", "");
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
      near.unobserve(entry.target);
    }
  }, { rootMargin: "900px 0px" });
  for (const live of lives) if (live !== hero) near.observe(live.el);

  const relayout = () => lives.forEach(layout);
  new ResizeObserver(relayout).observe(document.body);
  phoneQuery.addEventListener("change", relayout);

  onLanguage = () => {
    renderSteps();
    for (const live of lives) {
      if (live.iframe) {
        live.iframe.title = live.el.getAttribute("aria-label") || "Delegatus";
        reload(live);
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
