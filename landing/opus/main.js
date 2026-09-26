// Behaviour for the landing: language, install boxes, the legacy giggle, the
// handoff in the hero and the pass edge in the pipeline. Classic script.
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
  const heroBirds = () => [...document.querySelectorAll(".hero .catcher, .hero .note, .hero .perch")];

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
    for (const el of document.querySelectorAll("[data-i18n-mark]")) {
      el.innerHTML = escapeHtml(t(el.dataset.i18nMark)).replace("{m}", `<mark>${escapeHtml(t("hit.m1"))}</mark>`);
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
    try { localStorage.setItem("dlg-lang", lang); } catch { /* private mode */ }
    try {
      const url = new URL(location.href);
      url.searchParams.set("lang", lang);
      history.replaceState(null, "", url);
    } catch { /* file:// in some browsers */ }
  }

  for (const button of document.querySelectorAll("[data-lang]")) {
    button.addEventListener("click", () => applyLanguage(button.dataset.lang, true));
  }
  applyLanguage(lang, false);

  // ---------- The handoff (hero) ----------

  const OPERATOR_LINE =
    "Take the open harbor-api work: idempotent refunds first, then the webhook retries and the key rotation.";

  function whenReady(img, el, threshold, run) {
    let loaded = img.complete && img.naturalWidth > 0;
    let seen = false;
    let fired = false;
    const go = () => {
      if (fired || !loaded || !seen) return;
      fired = true;
      run();
    };
    if (!loaded) {
      img.addEventListener("load", () => { loaded = true; go(); }, { once: true });
      img.addEventListener("error", () => { loaded = true; go(); }, { once: true });
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        seen = true;
        io.disconnect();
        go();
      }
    }, { threshold });
    io.observe(el);
  }

  function setupHandoff() {
    const wrap = document.querySelector("[data-handoff]");
    if (!wrap || still || !("animate" in Element.prototype)) return;
    const crop = wrap.querySelector(".crop");
    const img = crop.querySelector("img.base");
    const layer = (name) => [...crop.querySelectorAll(`[data-layer="${name}"]`)];
    const composer = layer("composer")[0];
    const typed = composer.querySelector("span");
    const bubble = layer("bubble")[0];
    const working = layer("working")[0];
    const lines = layer("line");
    const entries = [...crop.querySelectorAll(".entry")].slice(0, 3);
    const needs = layer("needs")[0];
    const catcher = wrap.querySelector(".catcher");
    const note = wrap.querySelector(".note");
    const replay = wrap.querySelector("[data-replay]");

    let anims = [];
    let typingFrame = 0;
    let doneTimer = 0;

    const hold = (el, delay, from, to, duration = 1, easing = "linear") =>
      el.animate([from, to], { delay, duration, easing, fill: "backwards" });

    function build() {
      const unit = crop.clientWidth / 1022;
      const wrapBox = wrap.getBoundingClientRect();
      const noteBox = note.getBoundingClientRect();
      const bubbleBox = bubble.getBoundingClientRect();
      const dx = bubbleBox.left + bubbleBox.width / 2 - (noteBox.left + noteBox.width / 2);
      const dy = bubbleBox.top + bubbleBox.height / 2 - (noteBox.top + noteBox.height / 2);
      const sx = bubbleBox.width / note.offsetWidth;
      const sy = bubbleBox.height / note.offsetHeight;
      void wrapBox;

      const m = {
        all: catcher.querySelector(".m-all"),
        body: catcher.querySelector(".m-body"),
        wingL: catcher.querySelector(".m-wing-l"),
        wingR: catcher.querySelector(".m-wing-r"),
        glint: catcher.querySelector(".m-glint"),
      };
      const entryHeight = crop.querySelector(".entry").getBoundingClientRect().height;

      anims = [
        // 0–2 s: the operator's line is typed into the composer.
        hold(composer, 2000, { opacity: 1 }, { opacity: 0 }, 120),
        // 2 s: send. The bubble lands in the chat…
        hold(bubble, 2020, { opacity: 1 }, { opacity: 0 }, 160),
        // …and a copy of it folds into a note and flies to the mascot.
        hold(note, 2080, { opacity: 0 }, { opacity: 1 }, 1),
        note.animate(
          [
            { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy}) rotate(0deg)`, backgroundColor: "#262a36", borderRadius: "10px", offset: 0 },
            { transform: `translate(${dx * 0.86}px, ${dy * 0.86 - 18}px) scale(1.25) rotate(-3deg)`, backgroundColor: "#fbebdd", borderRadius: "3px", offset: 0.34 },
            { transform: "translate(0, 0) scale(1) rotate(-8deg)", backgroundColor: "#fbebdd", borderRadius: "3px", offset: 1 },
          ],
          { delay: 2120, duration: 900, easing: EASE, fill: "backwards" },
        ),
        // The mascot raises its wings to catch it, nods once, the glasses glint.
        hold(m.wingL, 2700, { transform: "rotate(-52deg)" }, { transform: "none" }, 360, EASE),
        hold(m.wingR, 2700, { transform: "rotate(52deg)" }, { transform: "none" }, 360, EASE),
        m.all.animate(
          [{ transform: "none" }, { transform: "translateY(2px) scaleY(.95)" }, { transform: "none" }],
          { delay: 2980, duration: 320, easing: "ease-out" },
        ),
        m.body.animate(
          [{ transform: "none" }, { transform: "rotate(7deg) translateY(1px)" }, { transform: "none" }],
          { delay: 3180, duration: 480, easing: "ease-in-out" },
        ),
        m.glint.animate(
          [{ opacity: 0.95, transform: "translateX(0)" }, { opacity: 0.95, transform: "translateX(46px)" }],
          { delay: 3520, duration: 560, easing: "ease-in-out" },
        ),
        // 3–6 s: the orchestrator's answer streams in, line by line.
        hold(lines[0], 3250, { opacity: 1 }, { opacity: 0 }, 220, "ease-out"),
        ...[
          [1, 3480, 520],
          [2, 4020, 520],
          [3, 4560, 180],
          [4, 4880, 620],
        ].map(([i, delay, duration]) =>
          lines[i].animate(
            [{ opacity: 1, clipPath: "inset(0 0 0 0)" }, { opacity: 1, clipPath: "inset(0 0 0 100%)" }],
            { delay, duration, easing: "steps(16, end)", fill: "backwards" },
          ),
        ),
        hold(lines[5], 5640, { opacity: 1 }, { opacity: 0 }, 260, "ease-out"),
        hold(working, 4300, { opacity: 1 }, { opacity: 0 }, 260, "ease-out"),
        // 6–9 s: three reports drop into the log, each on top of the last.
        ...[2, 1, 0].map((i, order) =>
          entries[i].animate(
            [
              { height: "0px", opacity: 0, transform: `translateY(${-14 * unit}px)` },
              { height: `${entryHeight}px`, opacity: 1, transform: "none" },
            ],
            { delay: 6150 + order * 760, duration: 560, easing: EASE, fill: "backwards" },
          ),
        ),
        // The amber "Needs you 1" pill pulses once.
        needs.animate(
          [
            { boxShadow: "0 0 0 0 rgb(224 174 69 / 0.7)" },
            { boxShadow: `0 0 0 ${10 * unit}px rgb(224 174 69 / 0)` },
          ],
          { delay: 8500, duration: 900, easing: "ease-out" },
        ),
      ];
    }

    function typeLine(start) {
      cancelAnimationFrame(typingFrame);
      const from = start + 150;
      const to = start + 1850;
      const step = (now) => {
        const p = Math.min(1, Math.max(0, (now - from) / (to - from)));
        typed.textContent = OPERATOR_LINE.slice(0, Math.round(p * OPERATOR_LINE.length));
        composer.scrollLeft = composer.scrollWidth;
        if (p < 1) typingFrame = requestAnimationFrame(step);
      };
      typed.textContent = "";
      typingFrame = requestAnimationFrame(step);
    }

    function play() {
      anims.forEach((a) => a.cancel());
      build();
      wrap.dataset.state = "playing";
      const start = performance.now();
      typeLine(start);
      clearTimeout(doneTimer);
      doneTimer = setTimeout(() => { wrap.dataset.state = "done"; }, 9500);
    }

    // Hold the first frame (empty chat, empty log) until the capture is in and visible.
    build();
    anims.forEach((a) => a.pause());
    typed.textContent = "";
    whenReady(img, crop, 0.35, play);
    replay.addEventListener("click", play);
  }

  // ---------- The pass edge (pipeline) ----------

  function setupPipeline() {
    const crop = document.querySelector("[data-pipeline]");
    if (!crop || still || !("animate" in Element.prototype)) return;
    const edge = crop.querySelector('[data-layer="edge"]');
    const dot = crop.querySelector('[data-layer="breathe"]');
    const draw = edge.animate(
      [{ opacity: 1, clipPath: "inset(0 0 0 0)" }, { opacity: 1, clipPath: "inset(0 0 0 100%)" }],
      { duration: 600, easing: "ease-out", fill: "backwards" },
    );
    draw.pause();
    whenReady(crop.querySelector("img"), crop, 0.45, () => {
      draw.play();
      dot.animate(
        [
          { boxShadow: "0 0 0 0 rgb(79 195 111 / 0.55)" },
          { boxShadow: "0 0 0 7px rgb(79 195 111 / 0)" },
        ],
        { duration: 2200, delay: 700, iterations: Infinity, easing: "ease-out" },
      );
    });
  }

  setupHandoff();
  setupPipeline();

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
