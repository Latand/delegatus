/*
 * Every word the frames print, in both interface languages. The decision
 * card's own strings reuse the keys the prototype review window already has
 * (proto.q.recommended, proto.q.other, proto.q.multiple, proto.answer …); the
 * values below are those values, so the frames read as the shipped window.
 */
export type Lang = "uk" | "en";

export interface Question {
  id: string;
  text: string;
  options: Array<{ label: string; recommended?: boolean }>;
  other?: boolean;
  multiple?: boolean;
}

export interface Copy {
  seat: string;
  project: string;
  working: string;
  model: string;
  reports: string;
  journal: string;
  rotate: string;
  stopHost: string;
  fold: string;
  composer: string;
  composerPhone: string;
  phoneTitle: string;
  phoneStatus: string;
  /* The strip and the card. */
  open: string;
  openCount: (n: number) => string;
  more: (n: number) => string;
  decision: string;
  questionsCount: (n: number) => string;
  fromSeat: string;
  fromLane: string;
  task: string;
  recommended: string;
  other: string;
  multiple: string;
  commentPlaceholder: string;
  send: string;
  openPrototypes: string;
  variantsCount: (n: number) => string;
  answeredAt: (time: string) => string;
  delivered: string;
  answerBelow: string;
  inColumn: string;
  ofN: (i: number, n: number) => string;
  decisionsTab: string;
  reportsTab: string;
  /* The conversation. */
  operatorAsk: string;
  seatAsk: string;
  seatAck: string;
  seatEarlier: string;
  operatorMessage: string;
  /* The forms. */
  seatForm: { title: string; questions: Question[] };
  protoForm: { title: string; lane: string; questions: Question[]; variants: Array<{ n: number; name: string }> };
  thirdForm: { title: string };
  reportLines: Array<{ time: string; kind: string; tone: "status" | "blocked" | "done" | "question"; text: string }>;
  boardColumns: string[];
}

export const COPY: Record<Lang, Copy> = {
  uk: {
    seat: "Оркестратор",
    project: "delegatus",
    working: "працює",
    model: "Opus 5.5 · high",
    reports: "Звіти",
    journal: "Журнал",
    rotate: "Замінити",
    stopHost: "Зупинити хост",
    fold: "Згорнути",
    composer: "що зробити в delegatus?",
    composerPhone: "Напишіть оркестратору…",
    phoneTitle: "Оркестратор delegatus",
    phoneStatus: "працює 0:09 · Opus 5.5 · high",
    open: "Чекають рішення",
    openCount: (n) => `${n} чекають рішення`,
    more: (n) => `ще ${n}`,
    decision: "Рішення",
    questionsCount: (n) => `${n} ${n === 1 ? "питання" : "питання"}`,
    fromSeat: "оркестратор",
    fromLane: "лейн",
    task: "задача",
    recommended: "рекомендовано",
    other: "Інше — напишіть нижче",
    multiple: "Можна кілька",
    commentPlaceholder: "Що додати…",
    send: "Відповісти",
    openPrototypes: "Відкрити прототипи",
    variantsCount: (n) => `${n} варіанти`,
    answeredAt: (time) => `Відповідь · ${time}`,
    delivered: "доставлено",
    answerBelow: "Відповісти внизу",
    inColumn: "Відповісти в колонці «Рішення»",
    ofN: (i, n) => `${i} з ${n}`,
    decisionsTab: "Рішення",
    reportsTab: "Звіти",
    operatorAsk: "Що з «Готово» і деплоєм?",
    seatAsk: "«Готово» (#2744) пройшло рев'ю і візуальну перевірку. Щоб злити й задеплоїти, потрібні два рішення:",
    seatAck: "Прийняв: «Готово» зверху «Чекають на вас», деплой одразу після мержу. Зливаю #2744.",
    seatEarlier: "Тик спокійний: три лейни працюють, два чекають своєї черги на перевірки.",
    operatorMessage: "",
    seatForm: {
      title: "«Готово»: місце і деплой",
      questions: [
        {
          id: "pin",
          text: "Де закріпити список «Готово»?",
          options: [{ label: "Зверху «Чекають на вас»", recommended: true }, { label: "Зверху стрічки звітів" }, { label: "В обох місцях" }],
          other: true,
        },
        {
          id: "deploy",
          text: "Коли деплоїти після мержу?",
          options: [{ label: "Одразу, щойно main зелений", recommended: true }, { label: "Увечері, одним деплоєм" }],
        },
      ],
    },
    protoForm: {
      title: "Вікно підтвердження оновлення",
      lane: "e9e98524",
      variants: [{ n: 1, name: "Список за проєктами" }, { n: 2, name: "Підсумок і «Показати»" }],
      questions: [
        {
          id: "variant",
          text: "Який варіант будуємо?",
          options: [{ label: "1 — Список за проєктами", recommended: true }, { label: "2 — Підсумок і «Показати»" }],
        },
        {
          id: "phone",
          text: "На телефоні: шторка знизу чи вікно по центру?",
          options: [{ label: "Шторка знизу", recommended: true }, { label: "Вікно по центру" }],
        },
      ],
    },
    thirdForm: { title: "Акаунт для нічних лейнів Codex" },
    reportLines: [
      { time: "17:42", kind: "питання", tone: "question", text: "«Готово»: де закріпити і коли деплоїти — форма в розмові." },
      { time: "17:31", kind: "статус", tone: "status", text: "#2749 на рев'ю в лейні 1f2824d9; «Готово» чекає черги CPU для пушу." },
      { time: "17:05", kind: "завершено", tone: "done", text: "Задеплоєно main 0ef6ec49: базові докази для провалених тестів рев'ю (#2736)." },
    ],
    boardColumns: ["Вхідні", "У роботі", "Очікують", "Готові"],
  },
  en: {
    seat: "Orchestrator",
    project: "delegatus",
    working: "working",
    model: "Opus 5.5 · high",
    reports: "Reports",
    journal: "Log",
    rotate: "Replace",
    stopHost: "Stop host",
    fold: "Fold",
    composer: "what to do in delegatus?",
    composerPhone: "Tell the orchestrator…",
    phoneTitle: "Orchestrator for delegatus",
    phoneStatus: "working 0:09 · Opus 5.5 · high",
    open: "Waiting for a decision",
    openCount: (n) => `${n} waiting for a decision`,
    more: (n) => `${n} more`,
    decision: "Decision",
    questionsCount: (n) => `${n} ${n === 1 ? "question" : "questions"}`,
    fromSeat: "orchestrator",
    fromLane: "lane",
    task: "task",
    recommended: "recommended",
    other: "Other — write it below",
    multiple: "Choose any",
    commentPlaceholder: "Anything to add…",
    send: "Answer",
    openPrototypes: "Open prototypes",
    variantsCount: (n) => `${n} variants`,
    answeredAt: (time) => `Answered · ${time}`,
    delivered: "delivered",
    answerBelow: "Answer below",
    inColumn: "Answer in the Decisions column",
    ofN: (i, n) => `${i} of ${n}`,
    decisionsTab: "Decisions",
    reportsTab: "Reports",
    operatorAsk: "What about Done and the deploy?",
    seatAsk: "Done (#2744) passed review and the visual check. Two decisions before I merge and deploy:",
    seatAck: "Got it: Done on top of Waiting for you, deploy right after the merge. Merging #2744.",
    seatEarlier: "Quiet tick: three lanes running, two waiting for their turn on the checks.",
    operatorMessage: "",
    seatForm: {
      title: "Done: placement and deploy",
      questions: [
        {
          id: "pin",
          text: "Where does the Done list stay pinned?",
          options: [{ label: "On top of Waiting for you", recommended: true }, { label: "On top of the reports feed" }, { label: "Both places" }],
          other: true,
        },
        {
          id: "deploy",
          text: "When to deploy after the merge?",
          options: [{ label: "At once, as soon as main is green", recommended: true }, { label: "In the evening, one deploy" }],
        },
      ],
    },
    protoForm: {
      title: "Update confirmation window",
      lane: "e9e98524",
      variants: [{ n: 1, name: "List by project" }, { n: 2, name: "Summary and Show" }],
      questions: [
        {
          id: "variant",
          text: "Which variant do we build?",
          options: [{ label: "1 — List by project", recommended: true }, { label: "2 — Summary and Show" }],
        },
        {
          id: "phone",
          text: "On the phone: bottom sheet or centred window?",
          options: [{ label: "Bottom sheet", recommended: true }, { label: "Centred window" }],
        },
      ],
    },
    thirdForm: { title: "Account for night Codex lanes" },
    reportLines: [
      { time: "17:42", kind: "question", tone: "question", text: "Done: where to pin it and when to deploy — form in the conversation." },
      { time: "17:31", kind: "status", tone: "status", text: "#2749 in review on lane 1f2824d9; Done waits for the CPU queue to push." },
      { time: "17:05", kind: "done", tone: "done", text: "Deployed main 0ef6ec49: baseline evidence for failing review tests (#2736)." },
    ],
    boardColumns: ["Inbox", "In progress", "Waiting", "Done"],
  },
};
