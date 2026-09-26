// Every visible word of the page, in English and Ukrainian, and the two
// install prompts. Classic script (no modules) so the page opens from file://.
(function () {
  "use strict";

  const promptHead = [
    "Install Delegatus on this machine and connect yourself to it.",
    "Project: https://github.com/Latand/delegatus",
    "",
    "1. Run `bun --version`. If Bun is missing or older than 1.4, install it with",
    "   `curl -fsSL https://bun.com/install | bash`, then use ~/.bun/bin/bun if",
    "   `bun` is not on PATH yet.",
    "2. Install the CLI: `bun add -g delegatus-cli`",
    "3. Start it in the background so it keeps running after this session:",
    "   `mkdir -p ~/.cache/delegatus && nohup ~/.bun/bin/delegatus --no-open > ~/.cache/delegatus/server.log 2>&1 &`",
    "   Wait up to 60 seconds for http://127.0.0.1:8898/ to answer. If it does",
    "   not, show me the last 30 lines of that log.",
  ];

  const promptTail = [
    "   (it becomes available in your next session).",
    "5. Give me the link to open. The setup guide there connects my agents,",
    "   picks a project and creates its orchestrator.",
    "",
    "On native Windows, stop after step 1 and tell me to run this inside WSL 2.",
  ];

  const mcpStep = {
    claude: ["4. Register its MCP server for yourself:", "   `claude mcp add viewer -s user -- delegatus-mcp`"],
    codex: ["4. Register its MCP server for yourself:", "   `codex mcp add viewer -- delegatus-mcp`"],
  };

  function prompt(agent, lang) {
    const lines = [...promptHead, ...mcpStep[agent], ...promptTail];
    if (lang === "uk") lines.push("", "Відповідай українською.");
    return lines.join("\n");
  }

  const strings = {
    en: {
      "meta.title": "Delegatus: delegate everything",
      "meta.description":
        "Tell one agent what you want shipped. It runs Claude Code and Codex builders and reviewers, checks the work and reports back.",
      "nav.docs": "Docs",
      "nav.lang": "Language",
      "hero.title": "Delegate everything.",
      "hero.sub":
        "Tell one agent what you want shipped. It runs the builders and reviewers, checks the work and reports back.",
      "hero.shotAlt":
        "Delegatus: the operator asks the harbor-api orchestrator to take the open work; it answers with a plan, and reports stack up in the log beside it.",
      "hero.phoneAlt":
        "Delegatus on a phone: the harbor-api board, with the task that needs a decision pinned first.",
      "hero.replay": "Replay",
      "install.tabs": "Install through your agent",
      "install.copy": "Copy prompt",
      "install.copied": "Copied. Paste it into {agent}",
      "install.more": "Read the whole prompt",
      "install.less": "Show less",
      "legacy.open": "I still use a terminal",
      "legacy.title": "Legacy install",
      "legacy.needs": "Needs Bun 1.4+:",
      "legacy.copy": "Copy the command",
      "legacy.copied": "Copied",
      "legacy.tease": "Hehe. Typing commands yourself? How vintage.",
      "legacy.fine": "Fine. I’ll be in the browser.",
      "run.title": "It runs the work, and checks it.",
      "run.alt":
        "A pipeline for Idempotent refunds: Build on Claude Opus 5.5 passed, Review on Codex is running, Verify waits; beneath it the builder’s and the reviewer’s conversations side by side.",
      "run.c1": "Each task gets a worktree, a builder and a fresh reviewer.",
      "run.c2": "Claude Code builds, Codex reviews, and they message each other.",
      "run.c3": "Reports land as work passes; decisions come to you.",
      "open.title": "Every conversation, open.",
      "open.alt":
        "A Claude Code session read as a chat, with an edit shown as a diff and a passing test run; over it, message search across projects, and the Claude accounts panel with each account’s limits.",
      "open.phoneAlt": "A Claude Code session on a phone, read as a chat: a passing test run and the agent’s answer.",
      "open.c1": "Every Claude Code, Codex and Copilot session reads as a chat.",
      "open.c2": "Search every conversation with {key}.",
      "open.c3": "Several Claude and Codex accounts, limits in view.",
      "reach.title": "It finds you when it needs you.",
      "reach.c1": "Your board on your phone, inside your tailnet.",
      "reach.c2": "Telegram built in: agents read chats you allow and report through your bot.",
      "reach.phoneAlt":
        "The harbor-api board on a phone: Back off webhook retries is pinned first with its amber needs-a-decision chip.",
      "tg.label": "Your bot, in Telegram",
      "tg.report": "Idempotent refunds: Build passed. 4 tests pass.",
      "tg.question": "Retry window: 24 or 72 hours?",
      "foot.line": "Open source. Runs on your machine, on your own accounts.",
      "foot.version": "version",
      "search.title": "Find my messages",
      "search.mine": "My messages",
      "search.everything": "Everything",
      "search.results": "Results",
      "search.you": "you",
      "search.agent": "agent",
      "search.query": "retries",
      "hit1.title": "Back off webhook retries",
      "hit1.text": "Stop {m} after 24 or 72 hours? The spec leaves it open.",
      "hit2.title": "Checkout form",
      "hit2.text": "Failed payments now say why, and {m} keep the cart.",
      "hit3.title": "Offline sync",
      "hit3.text": "Queue the {m} until the phone is back online.",
      "hit.m1": "retries",
    },
    uk: {
      "meta.title": "Delegatus: делегуй усе",
      "meta.description":
        "Скажи одному агенту, що треба зробити. Він запускає розробників і рев’юерів Claude Code і Codex, перевіряє роботу і звітує.",
      "nav.docs": "Документація",
      "nav.lang": "Мова",
      "hero.title": "Делегуй усе.",
      "hero.sub":
        "Скажи одному агенту, що треба зробити. Він запускає розробників і рев’юерів, перевіряє роботу і звітує.",
      "hero.shotAlt":
        "Delegatus: оператор просить оркестратора harbor-api взятися за відкриту роботу; той відповідає планом, а поруч у журналі з’являються звіти.",
      "hero.phoneAlt": "Delegatus на телефоні: дошка harbor-api, задача, що чекає рішення, закріплена першою.",
      "hero.replay": "Ще раз",
      "install.tabs": "Встановлення через твого агента",
      "install.copy": "Копіювати промпт",
      "install.copied": "Скопійовано. Встав у {agent}",
      "install.more": "Прочитати весь промпт",
      "install.less": "Згорнути",
      "legacy.open": "Я ще користуюсь терміналом",
      "legacy.title": "Застаріле встановлення",
      "legacy.needs": "Потрібен Bun 1.4+:",
      "legacy.copy": "Копіювати команду",
      "legacy.copied": "Скопійовано",
      "legacy.tease": "Хі-хі. Сам набираєш команди? Як вінтажно.",
      "legacy.fine": "Гаразд. Я чекатиму в браузері.",
      "run.title": "Він веде роботу і перевіряє її.",
      "run.alt":
        "Пайплайн «Idempotent refunds»: Build на Claude Opus 5.5 пройдено, Review на Codex виконується, Verify чекає; під ним розмови розробника і рев’юера поруч.",
      "run.c1": "Кожна задача отримує worktree, розробника і нового рев’юера.",
      "run.c2": "Claude Code пише, Codex перевіряє, і вони пишуть одне одному.",
      "run.c3": "Звіти приходять, щойно робота проходить; до тебе доходять лише рішення.",
      "open.title": "Кожна розмова відкрита.",
      "open.alt":
        "Сесія Claude Code як чат: правка у вигляді диффу і успішний прогін тестів; поверх неї пошук повідомлень по проєктах і панель акаунтів Claude з лімітами кожного.",
      "open.phoneAlt": "Сесія Claude Code на телефоні як чат: успішний прогін тестів і відповідь агента.",
      "open.c1": "Кожна сесія Claude Code, Codex і Copilot читається як чат.",
      "open.c2": "Шукай по всіх розмовах через {key}.",
      "open.c3": "Кілька акаунтів Claude і Codex, ліміти на виду.",
      "reach.title": "Він знайде тебе, коли ти потрібен.",
      "reach.c1": "Твоя дошка на телефоні, у твоїй мережі Tailscale.",
      "reach.c2": "Telegram вбудований: агенти читають дозволені чати і звітують через твого бота.",
      "reach.phoneAlt":
        "Дошка harbor-api на телефоні: «Back off webhook retries» закріплена першою з бурштиновою позначкою «потрібне рішення».",
      "tg.label": "Твій бот у Telegram",
      "tg.report": "Idempotent refunds: Build пройшов. 4 тести проходять.",
      "tg.question": "Вікно повторів: 24 чи 72 години?",
      "foot.line": "Відкритий код. Працює на твоїй машині, на твоїх акаунтах.",
      "foot.version": "версія",
      "search.title": "Знайти мої повідомлення",
      "search.mine": "Мої повідомлення",
      "search.everything": "Усе",
      "search.results": "Результати",
      "search.you": "ви",
      "search.agent": "агент",
      "search.query": "повтори",
      "hit1.title": "Back off webhook retries",
      "hit1.text": "Зупиняти {m} через 24 чи 72 години? Специфікація цього не каже.",
      "hit2.title": "Checkout form",
      "hit2.text": "Невдалі платежі тепер пояснюють причину, а {m} зберігають кошик.",
      "hit3.title": "Offline sync",
      "hit3.text": "Став {m} у чергу, поки телефон не повернеться в мережу.",
      "hit.m1": "повтори",
    },
  };

  window.DLG = window.DLG || {};
  window.DLG.copy = { strings, prompt, agents: { claude: "Claude Code", codex: "Codex" } };
})();
