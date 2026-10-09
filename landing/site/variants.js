// Prototype variants for the operator's pick (docs/research/landing-onorca.md,
// "Ranked ideas"). `?variant=1`, `2` or `3` turns one on; without it the page
// is today's landing, untouched. Runs before main.js, so the markup it adds is
// translated, cloned and wired by main.js like the rest of the page.
//
//   1  The hero you can read: the hero frame near 1:1, a compatibility row
//      under the install box, step chips that fill while the script plays,
//      and a phone action with a bar that stays in reach.
//   2  Answers and proof: Delegatus beside an agent in a terminal, a full
//      FAQ, and the release history in the header and the footer.
//   3  Both, with the least new chrome: the readable hero, the compatibility
//      row, the filling chips, the phone action without the bar, a shorter
//      FAQ, and the release history folded into the footer's version line.
(function () {
  "use strict";

  const variant = Number(new URLSearchParams(location.search).get("variant"));
  if (![1, 2, 3].includes(variant)) return;

  const FEATURES = {
    readableHero: [1, 3],
    compat: [1, 3],
    stepFill: [1, 3],
    phoneShare: [1, 3],
    stickyBar: [1],
    compare: [2],
    faq: [2, 3],
    faqFull: [2],
    releaseNav: [2],
    releaseBand: [2],
    releaseMeta: [3],
  };
  const has = (feature) => FEATURES[feature].includes(variant);
  const root = document.documentElement;
  root.dataset.variant = String(variant);
  for (const feature of Object.keys(FEATURES)) if (has(feature)) root.classList.add(`vf-${feature}`);

  const { strings } = window.DLG.copy;
  Object.assign(strings.en, {
    "v.compat": "Compatibility",
    "v.compat.osL": "Runs on",
    "v.compat.os": "macOS · Linux · Windows through WSL 2",
    "v.compat.agentsL": "Agents",
    "v.compat.bunL": "Needs",
    "v.compat.agents": "Claude Code · Codex · GitHub Copilot for single agents",
    "v.compat.bun": "Bun 1.4+",
    "v.share": "Send the link to my computer",
    "v.share.note": "Delegatus runs on your computer. The prompt below is for an agent there.",
    "v.share.copied": "Link copied",
    "v.dock": "Delegatus runs on a computer.",
    "v.dock.btn": "Send me the link",
    "v.cmp.caption": "The same coding agent, alone in a terminal and under Delegatus",
    "v.cmp.what": "What happens",
    "v.cmp.alone": "An agent in a terminal",
    "v.cmp.under": "Under Delegatus",
    "v.cmp.r1": "Planning the work",
    "v.cmp.r1a": "You, prompt by prompt",
    "v.cmp.r1b": "An orchestrator agent keeps the board",
    "v.cmp.r2": "Where a task runs",
    "v.cmp.r2a": "Your checkout",
    "v.cmp.r2b": "Its own worktree",
    "v.cmp.r3": "Checking the change",
    "v.cmp.r3a": "You, once it says done",
    "v.cmp.r3b": "A fresh read-only reviewer, on the other engine",
    "v.cmp.r4": "A failed check",
    "v.cmp.r4a": "You notice and ask again",
    "v.cmp.r4b": "Back to the builder, within a round budget",
    "v.cmp.r5": "A decision only you can make",
    "v.cmp.r5a": "Waits in a terminal tab",
    "v.cmp.r5b": "Waits on its card, on your phone and in Telegram",
    "v.cmp.r6": "Past sessions",
    "v.cmp.r6a": "Log files on disk",
    "v.cmp.r6b": "Every conversation open and searchable",
    "v.cmp.r7": "Usage limits",
    "v.cmp.r7a": "One account at a time",
    "v.cmp.r7b": "Several accounts per engine, limits in view",
    "v.faq.title": "Questions people ask first.",
    "v.faq.q1": "Does it get around Anthropic’s or OpenAI’s terms?",
    "v.faq.a1": "No. Delegatus starts the official Claude Code and Codex CLIs, signed in with your own accounts, the way you would start them in a terminal. It does not share or resell access. Your provider’s terms and limits apply as always.",
    "v.faq.q2": "Is it Claude Code with a new face?",
    "v.faq.a2": "Claude Code and Codex do the work inside it. Delegatus adds what sits around them: an orchestrator that keeps a board of tasks, a worktree for each task, a fresh read-only reviewer for every round, decisions that wait for you on their card, and every conversation open and searchable.",
    "v.faq.q3": "What leaves my machine?",
    "v.faq.a3": "The board and every conversation stay on your machine, and the agents talk to their providers as they always do. Delegatus itself sends one anonymous install ping a day: a random id, the version, OS, architecture and install kind. Turn it off in Settings or with DELEGATUS_TELEMETRY=0.",
    "v.faq.q4": "Does it merge pull requests by itself?",
    "v.faq.a4": "Only when you turn that on. Merging on a passed review is off by default: a pipeline ends with its pull request open, and the orchestrator tells you it is ready.",
    "v.faq.q5": "Do I need both Claude Code and Codex?",
    "v.faq.a5": "No. Either one runs the orchestrator and the builders. With both, one engine builds and the other reviews. GitHub Copilot can run single agents too.",
    "v.faq.q6": "Does it run on Windows?",
    "v.faq.a6": "Through WSL 2. Delegatus is built for Linux and runs on macOS. Native Windows runs it with Claude Code only, without Codex, the MCP server or phone access, so the install prompt asks for WSL 2.",
    "v.faq.q7": "What does it cost?",
    "v.faq.a7": "Delegatus is free and open source under the MIT license. The agents run on your own Claude, Codex and Copilot accounts, within the plans you already have.",
    "v.faq.q8": "Can I check on it from my phone?",
    "v.faq.a8": "Yes, inside your tailnet. Delegatus publishes the board only inside your own Tailscale network, behind an access key. Decisions and reports can also reach you through your own Telegram bot.",
    "v.rel.changelog": "Changelog",
  });
  Object.assign(strings.uk, {
    "v.compat": "Сумісність",
    "v.compat.osL": "Працює на",
    "v.compat.os": "macOS · Linux · Windows через WSL 2",
    "v.compat.agentsL": "Агенти",
    "v.compat.bunL": "Потрібен",
    "v.compat.agents": "Claude Code · Codex · GitHub Copilot для окремих агентів",
    "v.compat.bun": "Bun 1.4+",
    "v.share": "Надіслати собі на комп’ютер",
    "v.share.note": "Delegatus працює на твоєму комп’ютері. Промпт нижче для агента, який там.",
    "v.share.copied": "Посилання скопійовано",
    "v.dock": "Delegatus працює на комп’ютері.",
    "v.dock.btn": "Надіслати собі",
    "v.cmp.caption": "Той самий агент: сам у терміналі і в Delegatus",
    "v.cmp.what": "Що відбувається",
    "v.cmp.alone": "Агент у терміналі",
    "v.cmp.under": "У Delegatus",
    "v.cmp.r1": "Планування роботи",
    "v.cmp.r1a": "Ти, промпт за промптом",
    "v.cmp.r1b": "Агент-оркестратор веде дошку",
    "v.cmp.r2": "Де виконується задача",
    "v.cmp.r2a": "У твоїй робочій копії",
    "v.cmp.r2b": "У власному worktree",
    "v.cmp.r3": "Перевірка зміни",
    "v.cmp.r3a": "Ти, коли агент скаже «готово»",
    "v.cmp.r3b": "Новий рев’юер лише для читання, на іншому рушії",
    "v.cmp.r4": "Перевірка не пройшла",
    "v.cmp.r4a": "Ти помічаєш і просиш ще раз",
    "v.cmp.r4b": "Робота повертається розробникові, у межах бюджету раундів",
    "v.cmp.r5": "Рішення, яке можеш ухвалити лише ти",
    "v.cmp.r5a": "Чекає у вкладці термінала",
    "v.cmp.r5b": "Чекає на картці, на телефоні й у Telegram",
    "v.cmp.r6": "Минулі сесії",
    "v.cmp.r6a": "Файли логів на диску",
    "v.cmp.r6b": "Кожна розмова відкрита, по всіх є пошук",
    "v.cmp.r7": "Ліміти використання",
    "v.cmp.r7a": "Один акаунт за раз",
    "v.cmp.r7b": "Кілька акаунтів на рушій, ліміти на виду",
    "v.faq.title": "Що питають насамперед.",
    "v.faq.q1": "Це обхід умов Anthropic чи OpenAI?",
    "v.faq.a1": "Ні. Delegatus запускає офіційні CLI Claude Code і Codex під твоїми власними акаунтами, так само як ти запустив би їх у терміналі. Він не ділиться доступом і не перепродує його. Умови й ліміти провайдера діють як завжди.",
    "v.faq.q2": "Це Claude Code з новим обличчям?",
    "v.faq.a2": "Роботу всередині роблять Claude Code і Codex. Delegatus додає те, що навколо них: оркестратора, який веде дошку задач, окремий worktree для кожної задачі, нового рев’юера лише для читання на кожен раунд, рішення, що чекають тебе на картці, і кожну розмову відкритою, з пошуком.",
    "v.faq.q3": "Що залишає мою машину?",
    "v.faq.a3": "Дошка й усі розмови лишаються на твоїй машині, а агенти звертаються до своїх провайдерів як завжди. Сам Delegatus раз на добу надсилає анонімний сигнал встановлення: випадковий id, версію, ОС, архітектуру й тип встановлення. Вимикається в Налаштуваннях або через DELEGATUS_TELEMETRY=0.",
    "v.faq.q4": "Він сам мерджить pull request’и?",
    "v.faq.a4": "Лише якщо ти це ввімкнеш. Мердж після успішного рев’ю за замовчуванням вимкнений: пайплайн завершується з відкритим pull request’ом, і оркестратор каже, що все готово.",
    "v.faq.q5": "Чи потрібні і Claude Code, і Codex?",
    "v.faq.a5": "Ні. Будь-який із них веде оркестратора й розробників. З обома один рушій пише код, а інший перевіряє. GitHub Copilot теж може вести окремих агентів.",
    "v.faq.q6": "Чи працює він на Windows?",
    "v.faq.a6": "Через WSL 2. Delegatus зроблений для Linux і працює на macOS. Нативний Windows запускає його лише з Claude Code, без Codex, MCP-сервера й доступу з телефона, тому промпт встановлення просить WSL 2.",
    "v.faq.q7": "Скільки це коштує?",
    "v.faq.a7": "Delegatus безкоштовний, з відкритим кодом під ліцензією MIT. Агенти працюють під твоїми власними акаунтами Claude, Codex і Copilot, у межах планів, які в тебе вже є.",
    "v.faq.q8": "Чи можна стежити з телефона?",
    "v.faq.a8": "Так, у твоїй мережі Tailscale. Delegatus публікує дошку лише всередині твоєї власної мережі Tailscale і закриває її ключем доступу. Рішення і звіти можуть приходити й через твого Telegram-бота.",
    "v.rel.changelog": "Журнал змін",
  });

  const $ = (selector) => document.querySelector(selector);
  const make = (html) => {
    const holder = document.createElement("template");
    holder.innerHTML = html.trim();
    return holder.content.firstElementChild;
  };
  const lang = () => (root.lang === "uk" ? "uk" : "en");
  const t = (key) => strings[lang()][key] ?? strings.en[key] ?? key;
  const onLanguage = [];
  new MutationObserver(() => onLanguage.forEach((run) => run())).observe(root, { attributes: true, attributeFilter: ["lang"] });
  const CHANGELOG = "https://github.com/Latand/delegatus/blob/main/CHANGELOG.md";

  // ---------- 1, 3: the hero frame near 1:1 ----------
  // Today the frame lays the product out 1820 px wide and scales it to the
  // page (0.70 at 1440, so 11 px text reads at 7.7 px). At 1400 × 860 the
  // product still docks the orchestrator beside the board, and at 1440 the
  // scale is 0.92.
  if (has("readableHero")) {
    const live = $('[data-live="hero"]');
    live.dataset.lw = "1400";
    live.dataset.lh = "860";
  }

  // ---------- 1, 3: compatibility under the install box ----------
  if (has("compat")) {
    const template = $("#install-template");
    const row = make(`<dl class="v-compat" data-i18n-aria="v.compat" aria-label="Compatibility">
      <dt data-i18n="v.compat.osL"></dt><dd data-i18n="v.compat.os"></dd>
      <dt data-i18n="v.compat.agentsL"></dt><dd data-i18n="v.compat.agents"></dd>
      <dt data-i18n="v.compat.bunL"></dt><dd data-i18n="v.compat.bun"></dd></dl>`);
    template.content.querySelector(".install").after(row);
  }

  // ---------- 1, 3: a phone visitor gets a phone action ----------
  const PHONE_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>';
  async function shareLink(label) {
    const url = `${location.origin}${location.pathname}?lang=${lang()}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: document.title, url });
        return;
      }
    } catch (error) {
      if (error && error.name === "AbortError") return;
    }
    try { await navigator.clipboard.writeText(url); } catch { return; }
    const was = label.dataset.i18n;
    label.textContent = t("v.share.copied");
    setTimeout(() => { label.textContent = t(was); }, 2000);
  }
  if (has("phoneShare")) {
    const share = make(`<div class="v-share">
      <button type="button" class="copy-btn v-share-btn">${PHONE_ICON}<span data-i18n="v.share"></span></button>
      <p data-i18n="v.share.note"></p></div>`);
    $('.hero [data-install="hero"]').append(share);
    share.querySelector("button").addEventListener("click", (event) => shareLink(event.currentTarget.querySelector("span")));
  }
  if (has("stickyBar")) {
    const dock = make(`<div class="v-dock" data-shown="false">
      <span data-i18n="v.dock"></span>
      <button type="button" class="copy-btn">${PHONE_ICON}<span data-i18n="v.dock.btn"></span></button></div>`);
    document.body.append(dock);
    dock.querySelector("button").addEventListener("click", (event) => shareLink(event.currentTarget.querySelector("span")));
    const seen = new Map();
    const watch = new IntersectionObserver((entries) => {
      for (const entry of entries) seen.set(entry.target, entry.isIntersecting);
      const show = !seen.get($(".hero")) && !seen.get($(".band"));
      dock.dataset.shown = String(show);
    });
    watch.observe($(".hero"));
    watch.observe($(".band"));
  }

  // ---------- 1, 3: the step chips fill while the script plays ----------
  if (has("stepFill")) {
    for (const button of document.querySelectorAll(".steps [data-step]")) button.prepend(make('<i class="v-fill" aria-hidden="true"></i>'));
    let fill = null;
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.type !== "dlg:state" || typeof data.step !== "number") return;
      // main.js marks the current step in its own listener, which runs after this one.
      setTimeout(() => {
        fill?.cancel();
        fill = null;
        if (!data.playing || root.classList.contains("still")) return;
        const buttons = [...document.querySelectorAll(".steps [data-step]")];
        const current = buttons.find((button) => button.getAttribute("aria-current") === "step") ?? buttons.find((button) => !button.hasAttribute("data-done"));
        const bar = current?.querySelector(".v-fill");
        if (!bar) return;
        fill = bar.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: data.nextInMs, fill: "forwards" });
      }, 0);
    });
  }

  // ---------- 2: Delegatus beside an agent in a terminal ----------
  if (has("compare")) {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => `<tr><th scope="row" data-i18n="v.cmp.r${n}"></th>
      <td data-i18n="v.cmp.r${n}a"></td><td data-i18n="v.cmp.r${n}b"></td></tr>`).join("");
    const table = make(`<div class="v-compare"><table>
      <caption data-i18n="v.cmp.caption"></caption>
      <thead><tr><th scope="col" data-i18n="v.cmp.what"></th><th scope="col" data-i18n="v.cmp.alone"></th>
      <th scope="col"><img src="../../public/brand/delegatus-mark.svg" alt="" width="16" height="16"><span data-i18n="v.cmp.under"></span></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`);
    const head = $(".sec-run .sec-head");
    const lead = make('<div class="v-run-lead"><p class="v-run-note" data-i18n="run.c4"></p></div>');
    lead.prepend(head.querySelector("h2"));
    head.prepend(lead);
    head.querySelector(".caps-grid").replaceWith(table);
  }

  // ---------- 2, 3: the FAQ ----------
  if (has("faq")) {
    const numbers = has("faqFull") ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 2, 3, 4, 5, 7];
    const items = numbers.map((n) => `<details class="v-q"><summary><span data-i18n="v.faq.q${n}"></span>
      <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg></summary>
      <p data-i18n="v.faq.a${n}"></p></details>`).join("");
    $("#main").append(make(`<section class="sec sec-faq" data-section="faq">
      <h2 data-i18n="v.faq.title"></h2><div class="v-faq">${items}</div></section>`));
  }

  // ---------- 2, 3: the release history, read from npm ----------
  if (has("releaseNav") || has("releaseBand") || has("releaseMeta")) {
    if (has("releaseNav")) {
      $(".nav-gh").after(make(`<a class="v-rel-nav" href="${CHANGELOG}"><i class="dot dot-green"></i><span data-v-rel="nav"></span></a>`));
    }
    if (has("releaseBand")) {
      $(".band-meta").before(make(`<p class="v-ship"><span data-v-rel="band"></span> <a href="${CHANGELOG}" data-i18n="v.rel.changelog"></a></p>`));
    }
    if (has("releaseMeta")) {
      $("[data-version]").parentElement.after(make(`<span data-v-rel="meta"></span>`));
      $(".band-meta").append(make(`<a href="${CHANGELOG}" data-i18n="v.rel.changelog"></a>`));
    }
    let releases = null;
    const DAY = 86_400_000;
    const plural = (count, forms) => forms[new Intl.PluralRules(lang()).select(count)] ?? forms.other;
    function renderReleases() {
      if (!releases) return;
      const uk = lang() === "uk";
      const now = Date.now();
      const days = Math.max(0, Math.round((now - releases.latestAt) / DAY));
      const ago = new Intl.RelativeTimeFormat(lang(), { numeric: "auto" }).format(-days, "day");
      const month = releases.times.filter((at) => now - at <= 30 * DAY).length;
      const word = uk ? plural(month, { one: "реліз", few: "релізи", many: "релізів", other: "релізу" }) : plural(month, { one: "release", other: "releases" });
      for (const el of document.querySelectorAll("[data-v-rel]")) {
        const kind = el.dataset.vRel;
        if (kind === "nav") el.textContent = `${releases.latest} · ${ago}`;
        if (kind === "band") el.textContent = uk
          ? `${month} ${word} за останні 30 днів. Остання версія, ${releases.latest}, вийшла ${ago}.`
          : `${month} ${word} in the last 30 days. The latest, ${releases.latest}, came out ${ago}.`;
        if (kind === "meta") el.textContent = uk ? `вийшла ${ago} · ${month} ${word} за 30 днів` : `released ${ago} · ${month} ${word} in 30 days`;
      }
    }
    onLanguage.push(renderReleases);
    fetch("https://registry.npmjs.org/delegatus-cli")
      .then((response) => (response.ok ? response.json() : null))
      .then((pkg) => {
        const latest = pkg && pkg["dist-tags"] && pkg["dist-tags"].latest;
        if (!latest || !pkg.time || !pkg.time[latest]) return;
        // 0.0.0 held the name before the first release under it.
        const times = Object.entries(pkg.time)
          .filter(([version]) => /^\d+\.\d+\.\d+$/.test(version) && version !== "0.0.0")
          .map(([, at]) => Date.parse(at));
        releases = { latest, latestAt: Date.parse(pkg.time[latest]), times };
        renderReleases();
      })
      .catch(() => {});
  }
})();
