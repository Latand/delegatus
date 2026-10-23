/* The Turbo prototype's one scene (docs/design/turbo-mode.md §2.3, §6).
 *
 * Each variant page sets `window.TURBO_VARIANT` and loads this file. The page
 * draws the seat tick settings the way SeatTickBody.tsx does — the desktop
 * popover under the dock switch, or the phone sheet below 640 px — with the
 * variant's Turbo control on the Full autonomy row.
 *
 *   ?state=off|hover|focus|dialog|switching|on|ending|disabled
 *   &theme=light|dark
 *   &credits=off|on   (the separate paid-credit approval; off by default)
 *
 * Without ?state the page opens in story mode: a bar of links to every state,
 * and the control works — press it, confirm, and it runs switching → on.
 * hover and focus are drawn with classes that copy :hover and :focus-visible,
 * so a rendered frame does not depend on where a pointer happens to be.
 * The data is invented: project, accounts, times and counts. */
(function () {
  const V = window.TURBO_VARIANT;
  const NAMES = { 1: "Форсаж", 2: "Тахометр", 3: "Червона кнопка" };
  const STATE_WORDS = {
    off: "вимкнено", hover: "наведення", focus: "фокус з клавіатури", dialog: "підтвердження",
    switching: "перемикання", on: "увімкнено", ending: "лишилось менше 10 хв", disabled: "недоступно",
  };
  const params = new URLSearchParams(location.search);
  const story = !params.has("state");
  let state = params.get("state") || "off";
  const theme = params.get("theme") || "light";
  /* The paid-credit approval (design §2.3, §2.13): a separate opt-in, off
     unless the operator ticks it. In the on states it is what was confirmed. */
  let credits = params.get("credits") === "on";
  document.documentElement.dataset.theme = theme;
  document.documentElement.lang = "uk";
  const phone = () => window.innerWidth < 640;
  let uid = 0;

  /* ── Facts the frames show ────────────────────────────────────────────── */
  const TURBO = {
    switching: { done: 2 },
    on: { done: 7 },
    ending: { done: 7, left: "8 хв" },
  };
  const TOTAL = 7;
  /* The project's allowed Codex accounts. `balance` is the paid-credit balance
     Delegatus reads per account (creditGuard.ts PaidCredits); null = none. */
  const ACCOUNTS = [
    { name: "Акаунт A", plan: "promax", usage: "тиждень 36 % · скидання 27.10",
      tier: "Ultrafast для GPT-6.1 Sol і GPT-6 Astra, Fast для інших", paidTier: "Ultrafast і Fast", balance: "412" },
    { name: "Акаунт B", plan: "pro", usage: "тиждень 58 % · скидання 25.10",
      tier: "Fast для всіх моделей", paidTier: "Fast", balance: "75", shared: "Його також використовують ще 2 проєкти" },
    { name: "Акаунт C", plan: "prolite", usage: "тиждень 12 % · скидання 28.10",
      tier: "Fast для всіх моделей", paidTier: "", balance: null },
  ];
  const PAYERS = ACCOUNTS.filter((a) => a.balance);
  const payerNames = () => PAYERS.map((a) => a.name.replace("Акаунт ", "")).join(" і ");
  const isOn = (s) => s === "switching" || s === "on" || s === "ending";

  /* ── Variant icons ────────────────────────────────────────────────────── */
  function flameSvg(cls) {
    const id = `f${V}-${uid++}`;
    return `<svg class="${cls}" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="${id}o" x1="1" x2="0" y1="0" y2="0">
          <stop offset="0" style="stop-color:var(--color-codex)"/>
          <stop offset=".35" style="stop-color:var(--color-caution)"/>
          <stop offset="1" style="stop-color:var(--color-danger)"/>
        </linearGradient>
      </defs>
      <path class="flame-outer" fill="url(#${id}o)" d="M100,2 C86,1 74,3 62,4 C54,5 48,2 40,4 C34,6 30,3 22,6 C16,8 10,7 2,11 C10,12 10,12 2,13 C10,17 16,16 22,18 C30,21 34,18 40,20 C48,22 54,19 62,20 C74,21 86,23 100,22 Z"/>
      <path class="flame-mid" style="fill:var(--color-crown)" d="M100,5.5 C84,5.5 70,7.5 56,8.5 C48,9 40,7.5 30,10.5 C36,12 36,12 30,13.5 C40,16.5 48,15 56,15.5 C70,16.5 84,18.5 100,18.5 Z"/>
      <path class="flame-core" style="fill:var(--glyph-astra-core)" d="M100,8.5 C88,8.5 78,10 66,11 L56,12 L66,13 C78,14 88,15.5 100,15.5 Z"/>
      <path class="flame-diamond" style="fill:var(--color-codex)" d="M92,12 L88,10 L84,12 L88,14 Z M78,12 L75,10.6 L72,12 L75,13.4 Z"/>
    </svg>`;
  }
  function nozzleSvg(cls) {
    return `<svg class="${cls}" viewBox="0 0 20 20" aria-hidden="true">
      <circle class="nz-1" cx="10" cy="10" r="8.2"/>
      <circle class="nz-2" cx="10" cy="10" r="5.4"/>
      <circle class="nz-3" cx="10" cy="10" r="2.6"/>
    </svg>`;
  }
  /* A gauge: seven ticks over a half circle, a red sector at the top end, a
     needle. One tick per conversation in this example (7 of them). */
  function gaugeSvg(cls, lit) {
    const ticks = [];
    for (let i = 0; i < TOTAL; i += 1) {
      const a = Math.PI + (i * Math.PI) / (TOTAL - 1);
      const x1 = 16 + 9.4 * Math.cos(a), y1 = 17 + 9.4 * Math.sin(a);
      const x2 = 16 + 12.6 * Math.cos(a), y2 = 17 + 12.6 * Math.sin(a);
      const red = i >= TOTAL - 2;
      ticks.push(`<line class="g-tick${i < lit ? " is-lit" : ""}${red ? " is-red" : ""}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`);
    }
    return `<svg class="${cls}" viewBox="0 0 32 20" aria-hidden="true">
      <path class="g-red" d="M24.84,8.16 A12.6,12.6 0 0 1 28.6,17"/>
      ${ticks.join("")}
      <line class="g-needle" x1="16" y1="17" x2="16" y2="6.5"/>
      <circle class="g-hub" cx="16" cy="17" r="2.2"/>
    </svg>`;
  }
  function miniMark() {
    if (V === 1) return `<span class="status-mark mark-1" aria-hidden="true">${flameSvg("mark-flame")}${nozzleSvg("mark-nozzle")}</span>`;
    if (V === 2) return `<span class="status-mark mark-2" aria-hidden="true">${gaugeSvg("mark-gauge", TOTAL)}</span>`;
    return `<span class="status-mark mark-3" aria-hidden="true"><span class="mark-cover"></span><span class="mark-dome"></span></span>`;
  }

  /* ── The variant's control ────────────────────────────────────────────── */
  function control(s) {
    const on = isOn(s);
    const sim = s === "hover" ? " sim-hover" : s === "focus" ? " sim-focus" : "";
    const disabled = s === "disabled" ? " disabled" : "";
    const done = on ? TURBO[s].done : 0;
    const a11y = `aria-label="Турбо-режим" aria-describedby="turbo-about"${disabled}`;
    if (V === 1) {
      return `<button type="button" role="switch" aria-checked="${on}" ${on ? "" : 'aria-haspopup="dialog"'} ${a11y}
        class="t1${sim}" data-turbo="${s}" data-turbo-control>
        <span class="t1-track">
          ${flameSvg("t1-flame")}
          <span class="t1-pilot"></span>
          <span class="t1-sparks"><i></i><i></i><i></i></span>
          <span class="t1-thumb">${nozzleSvg("t1-nozzle")}</span>
        </span>
      </button>`;
    }
    if (V === 2) {
      return `<button type="button" aria-pressed="${on}" ${on ? "" : 'aria-haspopup="dialog"'} ${a11y}
        class="t2${sim}" data-turbo="${s}" data-turbo-control>
        ${gaugeSvg("t2-gauge", s === "dialog" ? 0 : done)}
        <span class="t2-word" aria-hidden="true">Турбо</span>
      </button>`;
    }
    return `<span class="t3-wrap" data-turbo="${s}">
      <span class="t3-cap" aria-hidden="true">Турбо</span>
      <button type="button" aria-pressed="${on}" ${on ? "" : 'aria-haspopup="dialog"'} ${a11y}
        class="t3${sim}" data-turbo="${s}" data-turbo-control>
        <span class="t3-plate">
          <span class="t3-dome"></span>
          <span class="t3-cover"><span class="t3-lip"></span></span>
        </span>
      </button>
    </span>`;
  }

  function turboCaption(s) {
    if (s === "disabled") {
      return `<p id="turbo-about" class="caption caption-muted" data-turbo-about><b class="cap-head">Турбо недоступне:</b> дозволені акаунти Codex не мають швидших рівнів.</p>`;
    }
    if (isOn(s)) {
      const outcome = credits
        ? `<b class="cap-head cap-paid">Турбо з кредитами:</b> після ліміту акаунти ${payerNames()} платять кредитами.`
        : `<b class="cap-head">Турбо без кредитів:</b> лише включені ліміти акаунтів.`;
      return `<p id="turbo-about" class="caption" data-turbo-about data-turbo-credits-outcome="${credits ? "on" : "off"}">${outcome} Вимкнути можна будь-коли, розмови повернуть попередню швидкість із наступного ходу.</p>`;
    }
    return `<p id="turbo-about" class="caption" data-turbo-about><b class="cap-head">Турбо:</b> агенти Codex працюють на найшвидшій швидкості свого акаунта. Ліміти витрачаються швидше.</p>`;
  }

  /* One line, one fact each: the end time always; while the sweep runs, its
     own verb and count; in the last 10 minutes, the time left. */
  function turboStatus(s) {
    if (!isOn(s)) return "";
    const t = TURBO[s];
    const extra = s === "switching" ? ` · перемикаю розмови: ${t.done} з ${TOTAL}` : s === "ending" ? ` · лишилось ${t.left}` : "";
    return `<div class="status-line" data-turbo-status>${miniMark()}<span>Турбо до 14:00${extra}</span></div>`;
  }

  /* ── The seat tick body ───────────────────────────────────────────────── */
  /* Full autonomy, with Turbo beside it, sits right under the status block
     here; the product has it under the wakes section. The desktop popover is
     capped at 70vh (SeatTickChip.tsx), and under the wakes the Turbo row fell
     below that edge at 1280×800 and 1000×700 (docs/design/turbo-mode.md §6). */
  function body(s) {
    const p = phone();
    const autonomyRow = p
      ? `<div class="row"><p class="section-head">Повна автономія</p>
           <button type="button" role="switch" aria-checked="false" aria-label="Увімкнути повну автономію" class="toggle ring"><span></span></button></div>
         <p class="caption">Оркестратор вирішує сам, рухає роботу й шукає нову. Заборонене лишається забороненим.</p>
         <div class="row turbo-row turbo-row-${V}"><p class="section-head turbo-head">Турбо</p>${control(s)}</div>
         ${turboCaption(s)}`
      : `<div class="row autonomy-row"><p class="section-head">Повна автономія</p>
           <button type="button" role="switch" aria-checked="false" aria-label="Увімкнути повну автономію" class="toggle ring"><span></span></button>
           <span class="row-divider" aria-hidden="true"></span>
           ${V === 1 ? '<span class="section-head turbo-head turbo-head-inline" aria-hidden="true">Турбо</span>' : ""}
           ${control(s)}</div>
         <p class="caption">Оркестратор вирішує сам, рухає роботу й шукає нову. Заборонене лишається забороненим.</p>
         ${turboCaption(s)}`;
    return `<div class="body" data-seat-tick-body>
      ${p ? "" : '<p class="head">Тікер оркестратора · Delegatus</p>'}
      <div class="status">
        <div class="status-line"><span class="dot dot-ok" aria-hidden="true"></span><span>Пробудження щогодини, типово</span></div>
        <p class="status-detail">Останнє пробудження ${s === "ending" ? "13:04 · наступне 14:04" : "12:04 · наступне 13:04"}</p>
        ${turboStatus(s)}
      </div>
      <div class="section" data-seat-tick-autonomy-section>${autonomyRow}</div>
      <div class="section">
        <div class="row"><p class="section-head">Пробудження оркестратора</p>
          <button type="button" role="switch" aria-checked="true" aria-label="Вимкнути пробудження оркестратора" class="toggle ring"><span></span></button></div>
        <label class="field"><span class="field-label">Кожні (хв)</span><input class="control" inputmode="numeric" placeholder="60 (типово)"></label>
        <label class="field"><span class="field-label">Вказівки на кожне пробудження</span>
          <textarea class="control textarea" rows="2">Доведи лінії турбо-режиму й витрати лімітів до злиття; о 18:00 зупинись.</textarea>
          <span class="caption caption-muted">Агент отримує ці вказівки на кожне пробудження. Тут редагуються рядки оператора; нижче — усі рядки з авторами й датами запису. Ліміт 500 символів охоплює рядки всіх авторів. Для зміни розкладу потрібні вказівки. Скидання розкладу та завершення строку дії зберігають їх.</span></label>
        <ul class="lines"><li><div class="meta">Оператор · 21.10.2026, 11:58:12</div><p>Доведи лінії турбо-режиму й витрати лімітів до злиття; о 18:00 зупинись.</p></li></ul>
      </div>
    </div>`;
  }

  /* ── The confirmation (design §2.3) ───────────────────────────────────── */
  function dialogTitleIcon() {
    if (V === 1) return `<span class="dlg-icon dlg-icon-1" aria-hidden="true">${flameSvg("dlg-flame")}${nozzleSvg("dlg-nozzle")}</span>`;
    if (V === 2) return `<span class="dlg-icon dlg-icon-2" aria-hidden="true">${gaugeSvg("dlg-gauge", TOTAL)}</span>`;
    return `<span class="dlg-icon dlg-icon-3" aria-hidden="true"><span class="mark-cover"></span><span class="mark-dome"></span></span>`;
  }
  /* Each row names its tier, then what the credit approval means for it as it
     stands: no credits, or credits after the included limit. */
  function accountRow(a) {
    const outcome = !a.balance
      ? `<span class="account-credit" data-account-credit="none">Кредитів немає</span>`
      : credits
        ? `<span class="account-credit is-paid" data-account-credit="paid">З кредитами: після ліміту платить кредитами з балансу</span>`
        : `<span class="account-credit" data-account-credit="free">Без кредитів: турбо лише до 90 % ліміту</span>`;
    return `<li><div class="account-top"><span class="account-name">${a.name} <span class="account-plan">· ${a.plan}</span></span><span class="account-usage">${a.usage}</span></div>
      <span class="account-tier">${a.tier}</span>${outcome}${a.shared ? `<span class="account-shared">${a.shared}</span>` : ""}</li>`;
  }
  /* The separate approval: its own box, its own checkbox, never ticked by the
     main confirm. It says it is paid and who pays, with the tier each pays for. */
  function creditsBlock() {
    return `<div class="dialog-block">
        <p class="dialog-block-head">Платні кредити</p>
        <div class="credits${credits ? " is-on" : ""}" data-turbo-credits>
          <label class="credits-opt"><input type="checkbox" data-turbo-credits-toggle aria-describedby="turbo-credits-about"${credits ? " checked" : ""}>
            <span class="credits-title">Дозволити платні кредити</span></label>
          <p id="turbo-credits-about" class="credits-text">Це платно. Коли включений ліміт скінчиться, турбо продовжить за кредити з балансу акаунта, до кінця турбо. Витрачатимуть кредити:</p>
          <ul class="credits-list">${PAYERS.map((a) => `<li><b>${a.name}</b> · ${a.paidTier} · баланс ${a.balance}</li>`).join("")}</ul>
          <p class="credits-text credits-muted">Без позначки турбо не витрачає жодного кредиту. Інші проєкти на цих акаунтах кредитів не отримують.</p>
        </div>
      </div>`;
  }
  /* Two columns on desktop: what changes and the accounts on the left, the
     credit approval and the duration on the right, so the approval sits apart
     from the confirm and the whole dialog fits a 1000x700 window. One column
     on the phone sheet. */
  function dialogContent() {
    return `<div class="dialog-cols"><div class="dialog-col">
      <div class="dialog-block">
        <p class="dialog-block-head">Зараз</p>
        <p class="dialog-text">Перейдуть на нову швидкість 7 розмов Codex: 3 етапи ліній і 4 агенти. Ті, що працюють, завершать поточний крок, зупиняться й одразу продовжать швидше.</p>
      </div>
      <div class="dialog-block">
        <p class="dialog-block-head">Далі</p>
        <p class="dialog-text">Які наступні етапи ліній пришвидшити, вирішить оркестратор.</p>
      </div>
      <div class="dialog-block">
        <p class="dialog-block-head">Дозволені акаунти Codex</p>
        <ul class="accounts">${ACCOUNTS.map(accountRow).join("")}</ul>
      </div>
      </div><div class="dialog-col">
      ${creditsBlock()}
      <p class="dialog-note">Claude не змінюється: швидкий режим Claude оплачується окремо, з usage credits.</p>
      <label class="field"><span class="field-label">Тривалість</span>
        <select class="control" data-turbo-duration><option>1 год</option><option selected>2 год</option><option>4 год</option><option>8 год</option><option${credits ? " disabled" : ""}>До вимкнення</option></select>
        ${credits ? '<span class="caption caption-muted" data-turbo-duration-note>З кредитами турбо має строк: від 1 до 8 год.</span>' : ""}</label>
      </div></div>`;
  }
  function dialogButtons() {
    return `<button type="button" class="btn btn-quiet sim-focus" data-turbo-cancel>Скасувати</button>
      <button type="button" class="btn btn-brand turbo-confirm" data-turbo-confirm>${confirmIcon()}<span>Увімкнути турбо</span></button>`;
  }
  function confirmIcon() {
    if (V === 1) return `<span class="btn-icon btn-icon-1" aria-hidden="true">${flameSvg("btn-flame")}</span>`;
    if (V === 2) return `<span class="btn-icon btn-icon-2" aria-hidden="true">${gaugeSvg("btn-gauge", TOTAL)}</span>`;
    return `<span class="btn-icon btn-icon-3" aria-hidden="true"></span>`;
  }
  const LEAD = "Агенти Codex цього проєкту працюватимуть на найшвидшій швидкості, яку дає їхній акаунт. Ліміти витрачатимуться в кілька разів швидше.";

  function desktopDialog() {
    return `<div class="scrim" role="presentation" data-turbo-scrim>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="turbo-title" aria-describedby="turbo-lead">
        <div class="dialog-title">${dialogTitleIcon()}<div><h2 id="turbo-title">Увімкнути турбо?</h2></div></div>
        <div class="dialog-scroll"><p id="turbo-lead" class="dialog-lead">${LEAD}</p>
        ${dialogContent()}</div>
        <div class="dialog-actions">${dialogButtons()}</div>
      </div>
    </div>`;
  }
  function phoneDialog() {
    return `<div class="sheet-scrim sheet-scrim-top" role="presentation" data-turbo-scrim>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="turbo-title" aria-describedby="turbo-lead" data-turbo-sheet>
        <div class="sheet-grab"><span></span></div>
        <div class="sheet-header">${dialogTitleIcon()}<h2 id="turbo-title">Увімкнути турбо?</h2>
          <button type="button" class="sheet-close" aria-label="Скасувати" data-turbo-close><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
        <div class="sheet-body"><div class="dialog-body"><p id="turbo-lead" class="dialog-lead">${LEAD}</p>${dialogContent()}</div></div>
        <div class="sheet-footer dialog-actions">${dialogButtons()}</div>
      </div>
    </div>`;
  }

  /* ── The dock switch, with Turbo's mark beside the health dot ─────────── */
  function dockSwitch(s) {
    return `<span class="tick-switch" role="slider" aria-label="Активність тікера оркестратора" aria-valuetext="щогодини, типово${isOn(s) ? `. Турбо до 14:00, ${credits ? "з кредитами" : "без кредитів"}` : ""}">
      <span class="tick-track"><span class="tick-fill"></span>
        <span class="tick-notch" style="left:25px"></span><span class="tick-notch" style="left:45px"></span><span class="tick-notch" style="left:85px"></span>
        <span class="tick-thumb">1 год</span></span>
      ${isOn(s) ? `<span class="dock-mark">${miniMark()}</span>` : ""}
      <span class="dot dot-ok" aria-hidden="true"></span></span>`;
  }

  function tag(s) {
    const paid = s === "dialog" || isOn(s) ? (credits ? " · кредити дозволено" : " · без кредитів") : "";
    return `<p class="frame-tag" data-frame-tag>Варіант ${V} · «${NAMES[V]}» · ${STATE_WORDS[s]}${paid}</p>`;
  }
  function storyBar() {
    if (!story) return "";
    return `<nav class="story-bar"${state === "dialog" ? " inert" : ""}>${Object.keys(STATE_WORDS).map((k) => `<a href="?state=${k}&theme=${theme}&credits=${credits ? "on" : "off"}">${STATE_WORDS[k]}</a>`).join("")}
      <a href="?theme=${theme === "dark" ? "light" : "dark"}">${theme === "dark" ? "світла тема" : "темна тема"}</a><a href="index.html">усі варіанти</a></nav>`;
  }

  function render() {
    const s = state;
    const dialog = s === "dialog";
    const root = document.getElementById("root");
    document.body.classList.toggle("phone", phone());
    if (phone()) {
      root.innerHTML = `<div class="phone-app">
        <div class="phone-shell" ${dialog ? "inert" : ""}>
          <div class="phone-top"><span class="dock-brand">Delegatus</span><span class="dock-spacer"></span>${dockSwitch(s)}</div>
          <div class="phone-ghost"><div></div><div></div><div></div><div></div><div></div><div></div></div>
          <div class="sheet-scrim">
            <div class="sheet" role="dialog" aria-modal="true" aria-label="Тікер оркестратора · Delegatus" data-seat-sheet>
              <div class="sheet-grab"><span></span></div>
              <div class="sheet-header"><h2>Тікер оркестратора · Delegatus</h2>
                <button type="button" class="sheet-close" aria-label="Закрити"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
              <div class="sheet-body" data-seat-sheet-body>${body(s)}</div>
            </div>
          </div>
        </div>
        ${dialog ? phoneDialog() : ""}
        ${tag(s)}${storyBar()}
      </div>`;
    } else {
      root.innerHTML = `<div class="app">
        <div class="app-shell" ${dialog ? "inert" : ""}>
          <header class="dock"><span class="dock-brand">Delegatus</span><span class="dock-project">Оркестратор · Delegatus</span><span class="dock-spacer"></span>
            <span class="dock-label">Тікер</span>${dockSwitch(s)}</header>
          <div class="board-ghost"><div></div><div></div><div></div><div></div></div>
          <div class="popover" role="dialog" aria-modal="false" aria-label="Тікер оркестратора · Delegatus" data-seat-popover>${body(s)}</div>
        </div>
        ${dialog ? desktopDialog() : ""}
        ${tag(s)}${storyBar()}
      </div>`;
    }
    /* A confirmation stacked on the seat sheet covers it whole, so no cut
       title of the sheet below shows above it. */
    const below = document.querySelector("[data-seat-sheet]"), over = document.querySelector("[data-turbo-sheet]");
    if (below && over) over.style.minHeight = `${below.offsetHeight}px`;
    wire();
  }

  /* Story mode only: the control does what the design says. */
  function wire() {
    if (!story) return;
    const ctl = document.querySelector("[data-turbo-control]");
    ctl?.addEventListener("click", () => { if (isOn(state)) { state = "off"; credits = false; } else state = "dialog"; render(); });
    for (const q of ["[data-turbo-cancel]", "[data-turbo-close]"]) document.querySelector(q)?.addEventListener("click", () => { state = "off"; credits = false; render(); });
    document.querySelector("[data-turbo-confirm]")?.addEventListener("click", () => {
      state = "switching"; render();
      setTimeout(() => { if (state === "switching") { state = "on"; render(); } }, 2400);
    });
    const tick = document.querySelector("[data-turbo-credits-toggle]");
    tick?.addEventListener("change", () => { credits = tick.checked; render(); document.querySelector("[data-turbo-credits-toggle]")?.focus(); });
    document.querySelector("[data-turbo-scrim]")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) { state = "off"; credits = false; render(); } });
    if (state === "dialog") document.querySelector("[data-turbo-cancel]")?.focus();
  }
  document.addEventListener("keydown", (e) => { if (story && e.key === "Escape" && state === "dialog") { state = "off"; credits = false; render(); } });
  window.addEventListener("resize", () => { if (document.body.classList.contains("phone") !== phone()) render(); });
  render();
})();
