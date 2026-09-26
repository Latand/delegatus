import type { BridgeReportClass } from "./types";

/*
 * The words the Viewer itself writes into a report: the header's kind, the
 * section headings and the task-change labels (docs/design/orchestrator-reports.md
 * §3.2, §3.8). Its own small table because the UI dictionaries are client
 * modules, and because these few strings are the whole vocabulary a report
 * renderer needs. English whenever the interface language is not known yet.
 */

export type ReportLocale = "en" | "uk";

export const REPORT_SECTION_IDS = ["prod", "tasks", "merged", "inProgress", "queued", "decision"] as const;
export type ReportSectionId = typeof REPORT_SECTION_IDS[number];
/** The sections a caller writes; `tasks` is the Viewer's alone. */
export const SEAT_SECTION_IDS = ["prod", "merged", "inProgress", "queued", "decision"] as const;
export type SeatSectionId = typeof SEAT_SECTION_IDS[number];

export const CLASS_EMOJI: Record<BridgeReportClass, string> = {
  completed: "✅",
  failed: "❌",
  blocked: "⛔",
  question: "❓",
  review_verdict: "🔍",
  status: "🕒",
};

export const SECTION_EMOJI: Record<ReportSectionId, string> = {
  prod: "✅",
  tasks: "📋",
  merged: "🔀",
  inProgress: "🛠",
  queued: "⏳",
  decision: "❓",
};

/** Items a section shows before the rest collapse into "and N more". */
export const SECTION_ITEM_LIMIT: Record<SeatSectionId, number> = {
  prod: 6,
  merged: 6,
  inProgress: 6,
  queued: 4,
  decision: 3,
};

interface Words {
  kind: Record<BridgeReportClass | "deploy", string>;
  heading: Record<ReportSectionId, string>;
  task: { done: string; blocked: string; assigned: string; created: string };
  notOnProdYet: string;
  andMore: (count: number) => string;
  hidden: (count: number) => string;
  dateLocale: string;
}

const WORDS: Record<ReportLocale, Words> = {
  en: {
    kind: {
      completed: "completed",
      failed: "failed",
      blocked: "blocked",
      question: "question",
      review_verdict: "review verdict",
      status: "status",
      deploy: "deploy",
    },
    heading: {
      prod: "On prod",
      tasks: "Tasks since the previous deploy",
      merged: "Merged, goes out with the next deploy",
      inProgress: "In progress",
      queued: "Next",
      decision: "Needs a decision",
    },
    task: { done: "Done", blocked: "Blocked", assigned: "In progress", created: "New" },
    notOnProdYet: "(not on prod yet)",
    andMore: (count) => `and ${count} more`,
    hidden: (count) => `${count} hidden`,
    dateLocale: "en-GB",
  },
  uk: {
    kind: {
      completed: "завершено",
      failed: "помилка",
      blocked: "заблоковано",
      question: "питання",
      review_verdict: "вердикт ревʼю",
      status: "статус",
      deploy: "деплой",
    },
    heading: {
      prod: "На проді",
      tasks: "Задачі з попереднього деплою",
      merged: "Змерджено, піде з наступним деплоєм",
      inProgress: "В роботі",
      queued: "Далі",
      decision: "Чекає рішення",
    },
    task: { done: "Готово", blocked: "Заблоковано", assigned: "В роботі", created: "Нові" },
    notOnProdYet: "(ще не на проді)",
    andMore: (count) => `і ще ${count}`,
    hidden: (count) => `${count} приховано`,
    dateLocale: "uk-UA",
  },
};

export function reportWords(locale: ReportLocale | null): Words {
  return WORDS[locale ?? "en"];
}

/** "25.09, 21:45 GMT+3" in the operator's zone, or the host's when unknown. */
export function reportDateTime(at: Date, locale: ReportLocale | null, timeZone: string | null): string {
  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  };
  try {
    return new Intl.DateTimeFormat(reportWords(locale).dateLocale, options).format(at);
  } catch {
    const { timeZone: _ignored, ...hostOptions } = options;
    return new Intl.DateTimeFormat(reportWords(locale).dateLocale, hostOptions).format(at);
  }
}
