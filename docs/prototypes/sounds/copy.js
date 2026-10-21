/* Every visible line of the prototype, in the two languages Delegatus ships.
 * ?lang=en|uk picks one; Ukrainian is the default. Rates are quoted from
 * docs/design/sound-redesign.md §3.1 and §10 (window W, machine-wide); the
 * page names no file path, seed or section number. */
(() => {
  const DS = window.DelegatusSounds;

  const COPY = {
    uk: {
      title: "Звуки Delegatus · прототип",
      intro: "Кожен звук нижче синтезовано кодом у браузері: осцилятори, обвідні, фільтри й шум, без файлів. Набір тексту можна послухати і в оригінальному записі, і в синтезованій копії.",
      served: "Оригінальний запис набору завантажено.",
      fileOnly: "Сторінку відкрито як файл, тож оригінальний запис набору недоступний і звучить синтезована копія. Щоб почути оригінал, відкрийте сторінку через локальний вебсервер, запущений у теці Delegatus.",
      controls: "Налаштування",
      palette: "Палітра",
      recommended: "рекомендовано",
      typingSource: "Набір тексту",
      original: "оригінальні 8 файлів",
      replica: "синтезована копія",
      volume: "Гучність сигналів",
      sounds: "Звуки",
      colCode: "№",
      colSound: "Звук",
      colMeans: "Що каже",
      colSource: "Коли звучить",
      colPlay: "Прослухати",
      play: "Грати",
      batch: "4 лейни разом",
      agents: "{n} поза екраном",
      compare: "Чотири висхідні звуки підряд: S4, S5, S6, S9",
      compareNote: "Усі чотири йдуть угору, тож розрізняються верхньою нотою, її моментом і ритмом.",
      smallSounds: "Малі звуки: дзвінок і диктування",
      hour: "Година пікового навантаження",
      hourIntro: "Найнавантаженіша година з історії, {label}: {calls} викликів інструментів і {sources} озвучуваних подій у реальному темпі. Кількість у кожному п'ятихвилинному відрізку справжня, а місце події всередині відрізка вибрано випадково. Справжні події йдуть сплесками, які правила зливають в один звук, тож за реальними часами ця година дала б 38 звуків, а тут, де події розкидано рівномірно, звучить більше.",
      startAt: "Почати з хвилини",
      liveSessions: "Живих сесій",
      liveSessionsNote: "з них 2 на екрані (S1), решта поза екраном (S2); пік в аудиті — 26",
      withAsks: "Також S6 на виведене «питає вас» (не рекомендовано)",
      busiest: "найщільніша хвилина",
      start: "Грати годину",
      stop: "Зупинити",
      position: "Позиція",
      tableSound: "Звук",
      tablePlays: "Прозвучало",
      playedOf: "{plays} із {sources}",
      playedNote: "Одне число: прозвучала кожна подія. Два числа: скільки звуків прозвучало із скількох подій, а решту правила злили або відкинули.",
      tableTyping: "Набір",
      silent: "Мовчать: {starts} стартів етапів, {fails} провалів етапів (ідуть на виправлення){asks}.",
      silentAsks: ", {n} виведених «питає вас»",
      typingSummary: "{calls} викликів: {near} разів S1 для двох панелей на екрані, {distant} разів S2 для {off} сесій поза екраном (раз на {interval} с).",
      rules: "Перевірка правил",
      rulesNote: "Правила часу (злиття, паузи, пріоритет) на випадках, які має перевіряти впровадження, і перевірка самих звуків.",
      pass: "так",
      fail: "НІ",
      footer: "Прототип для форми прослуховування. Впровадження — окремим лейном після відповіді.",
      renderNote: "гучність сигналів {volume} · +9 дБ для прослуховування, однаково для всіх файлів",
      excerpt: "Година пікового навантаження, {from}–{to}",
      excerptNote: "{label} · {n} сесій · набір: {typing}",
      risingTitle: "S4 · S5 · S6 · S9 підряд",
      paletteLabel: "Палітра {n} · {name}",
      typingTitle: "S1 · Набір: {source}",
      distantTitle: "S2 · Набір здалеку: {n} поза екраном",
      batchOf: "партія з {n}",
      seconds: "с",
    },
    en: {
      title: "Delegatus sounds · prototype",
      intro: "Every sound below is synthesized by code in the browser: oscillators, envelopes, filters and noise, no files. The typing can be heard both as the original recording and as a synthesized replica.",
      served: "The original typing recording is loaded.",
      fileOnly: "This page was opened as a file, so the original typing recording is unavailable and the synthesized replica plays. To hear the original, open the page through a local web server started in the Delegatus folder.",
      controls: "Settings",
      palette: "Palette",
      recommended: "recommended",
      typingSource: "Typing",
      original: "the original 8 files",
      replica: "synthesized replica",
      volume: "Cue volume",
      sounds: "Sounds",
      colCode: "#",
      colSound: "Sound",
      colMeans: "Tells you",
      colSource: "Plays on",
      colPlay: "Listen",
      play: "Play",
      batch: "4 lanes at once",
      agents: "{n} off screen",
      compare: "The four rising sounds back to back: S4, S5, S6, S9",
      compareNote: "All four go up, so they differ in their top note, when it arrives, and their rhythm.",
      smallSounds: "Small sounds: calls and dictation",
      hour: "The busiest hour",
      hourIntro: "The busiest hour on record, {label}: {calls} tool calls and {sources} voiced events at real pace. Each five-minute bin holds its real count, and where an event falls inside its bin is chosen at random. Real events come in bursts that the rules merge into one sound, so at their real times this hour would give 38 sounds; spread evenly as here, more of them play.",
      startAt: "Start at minute",
      liveSessions: "Live sessions",
      liveSessionsNote: "2 of them on screen (S1), the rest off screen (S2); the audit's peak is 26",
      withAsks: "Also S6 for an inferred «asks you» (not recommended)",
      busiest: "densest minute",
      start: "Play the hour",
      stop: "Stop",
      position: "Position",
      tableSound: "Sound",
      tablePlays: "Played",
      playedOf: "{plays} of {sources}",
      playedNote: "One number: every event played. Two numbers: how many sounds played out of how many events; the rules merged or dropped the rest.",
      tableTyping: "Typing",
      silent: "Silent: {starts} stage starts, {fails} stage failures (they go to a fixer){asks}.",
      silentAsks: ", {n} inferred «asks you»",
      typingSummary: "{calls} calls: S1 {near} times for two panes on screen, S2 {distant} times for {off} sessions off screen (once every {interval} s).",
      rules: "Rules check",
      rulesNote: "The timing rules (merging, gaps, priority) on the cases the implementation has to test, and a check of the sounds themselves.",
      pass: "yes",
      fail: "NO",
      footer: "A prototype for the listening form. Implementation is a separate lane after the answer.",
      renderNote: "cue volume {volume} · +9 dB for listening, the same for every file",
      excerpt: "The busiest hour, {from}–{to}",
      excerptNote: "{label} · {n} sessions · typing: {typing}",
      risingTitle: "S4 · S5 · S6 · S9 back to back",
      paletteLabel: "Palette {n} · {name}",
      typingTitle: "S1 · Typing: {source}",
      distantTitle: "S2 · Distant typing: {n} off screen",
      batchOf: "batch of {n}",
      seconds: "s",
    },
  };

  /** What each sound tells the operator, and where it comes from. */
  const MEANING = {
    uk: {
      typing: ["Агент на екрані працює просто зараз", "кожен новий виклик інструмента в панелі на екрані · до {toolPeak}/год"],
      distant: ["Агенти поза екраном працюють, і приблизно скільки", "ті самі виклики сесій без живої панелі · фрагмент раз на 3–8 с"],
      step: ["Лейн просунувся вперед", "етап пройшов · {step}/год, після правил {stepAfter}/год"],
      landed: ["Лейн завершено: злито або нічого зливати", "злиття або завершення без злиття · {landed}/год"],
      released: ["Нова версія Delegatus уже працює", "розгортання вдалося · {released}/год"],
      "your-move": ["Щось чекає на вашу відповідь", "рішення, форми, запити уваги, питання · {yourMove}/год після правил"],
      fault: ["Щось зламалося, треба глянути", "збій запуску, блок злиття, збій розгортання, ліміт · {fault}/год"],
      reply: ["Розмова, куди ви щойно написали, відповіла", "хід, що несе ваше повідомлення, завершився · лише ваші надсилання"],
      launched: ["Запуск, який ви попросили, прийнято", "квитанція запуску в картці нового агента · лише ваші запуски"],
      "voice-connect": ["Голосовий компаньйон на лінії, з ним можна говорити", "як і зараз · {voice}/год"],
      "voice-disconnect": ["Голосовий компаньйон більше не на лінії, хоч би хто завершив розмову", "як і зараз · завершили ви, ліміт або обрив зв'язку"],
      "dict-warn": ["Запис зупиниться сам за {pingLead} с: час закінчувати думку", "як і зараз · за {pingLead} с до межі запису"],
      "dict-stop": ["Минуло {capMinutes} хвилин запису: текст чекає в полі, нічого не надіслано", "як і зараз · лише на межі, не коли зупиняєте ви"],
    },
    en: {
      typing: ["An agent on screen is working right now", "each new tool call in a pane on screen · up to {toolPeak}/h"],
      distant: ["Agents off screen are working, and roughly how many", "the same calls for sessions with no live pane · one slice per 3–8 s"],
      step: ["A lane moved forward", "a stage passed · {step}/h, {stepAfter}/h after the rules"],
      landed: ["A lane finished: merged, or nothing to merge", "a merge, or a completion with no merge · {landed}/h"],
      released: ["A new Delegatus version is serving", "a deploy succeeded · {released}/h"],
      "your-move": ["Something is waiting for your answer", "decisions, forms, attention requests, questions · {yourMove}/h after the rules"],
      fault: ["Something broke and needs a look", "failed launch, blocked merge, failed deploy, limit · {fault}/h"],
      reply: ["The conversation you just wrote to has answered", "the turn carrying your message completed · your sends only"],
      launched: ["The launch you asked for was accepted", "the launch receipt in the new-agent card · your launches only"],
      "voice-connect": ["The voice companion is on the line to talk with", "as today · {voice}/h"],
      "voice-disconnect": ["The voice companion has left the line, whoever ended the call", "as today · you, the cap or a lost connection"],
      "dict-warn": ["Recording stops on its own in {pingLead} s: time to finish the thought", "as today · {pingLead} s before the recording cap"],
      "dict-stop": ["{capMinutes} minutes of recording are up: the text waits in the field, nothing was sent", "as today · only at the cap, never when you stop it"],
    },
  };

  /** The audit's rates and the product's limits the lines above quote, with their decimals. */
  const FIGURES = {
    toolPeak: [1632, 0], step: [10.1, 1], stepAfter: [8.7, 1], landed: [2.94, 2], released: [0.42, 2],
    yourMove: [1.89, 2], fault: [1.03, 2], voice: [0.04, 2],
    pingLead: [30, 0], capMinutes: [10, 0], // src/lib/dictationTimer.ts
  };

  const query = new URLSearchParams(location.search);
  const lang = query.get("lang") === "en" ? "en" : "uk";

  /** A line of copy with its {placeholders} filled. */
  function t(key, vars = {}) {
    return COPY[lang][key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
  }

  /** A number written the way the language writes it. */
  const number = (n, digits = 0) =>
    n.toLocaleString(lang === "uk" ? "uk-UA" : "en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

  /** What a sound tells the operator and when it plays, with the figures written the language's way. */
  const meaning = (id) =>
    MEANING[lang][id].map((line) => line.replace(/\{(\w+)\}/g, (_, name) => number(...FIGURES[name])));

  Object.assign(DS, { lang, t, number, meaning, soundName: (sound) => sound.name[lang] });
})();
