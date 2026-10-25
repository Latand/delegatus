import { shortId } from "@/lib/shortIds";
import type { IssueReportLanguage } from "./approvalForm";
import type { IssueReportFinding } from "./scrub";
import type { IssueReportPreview } from "./store";

type PreviewText = Pick<IssueReportPreview, "digest" | "title" | "body" | "privacyJudgment" | "hints" | "hintWarnings">;

/* Every line the preview adds around the report, in the operator's interface
   language. The title, the body and the agent's judgment stay as written. */
const COPY = {
  en: {
    heading: "PREVIEW", digest: "Digest",
    from: "PUBLISHED FROM HERE", to: "PUBLISHED UP TO HERE", title: "Title", body: "Body",
    below: "Everything below this line stays in this chat.",
    judgment: "Agent's privacy judgment",
    assessment: "Assessment", removed: "Removed", harmless: "Harmless hints and reasons", uncertainties: "Uncertainties",
    legacy: "No agent judgment was recorded for this preview. Read the whole text before approving.",
    hints: "Detector hints",
    unrecorded: "Detector hints were not recorded. Read the whole text.",
    none: "None found. A clean result proves nothing; read the whole text.",
    inTitle: "title", line: "body, line", lines: "body, lines", decoded: "decoded form",
    warning: "Warning",
    closing: "Approving it in the decision form files exactly the title and body above as a public issue in the Delegatus repository, readable by anyone. Hints do not prevent this.",
  },
  uk: {
    heading: "ПОПЕРЕДНІЙ ПЕРЕГЛЯД", digest: "Дайджест",
    from: "ПУБЛІКУЄТЬСЯ ЗВІДСИ", to: "ПУБЛІКУЄТЬСЯ ДОСЮДИ", title: "Назва", body: "Текст",
    below: "Усе нижче цього рядка лишається в цьому чаті.",
    judgment: "Оцінка приватності від агента",
    assessment: "Оцінка", removed: "Вилучено", harmless: "Нешкідливі підказки та причини", uncertainties: "Сумніви",
    legacy: "Для цього перегляду оцінку агента не записано. Прочитайте весь текст перед схваленням.",
    hints: "Підказки детекторів",
    unrecorded: "Підказки детекторів не записано. Прочитайте весь текст.",
    none: "Нічого не знайдено. Чистий результат нічого не доводить; прочитайте весь текст.",
    inTitle: "назва", line: "текст, рядок", lines: "текст, рядки", decoded: "розкодований вигляд",
    warning: "Попередження",
    closing: "Схвалення у формі рішення створить із назви й тексту вище, без жодних змін, публічний issue в репозиторії Delegatus, який може прочитати будь-хто. Підказки цьому не перешкоджають.",
  },
} as const;

/* The detectors' plain labels and the one source warning, in Ukrainian. A
   label missing here is shown as the detector wrote it. */
const UK: Record<string, string> = {
  "a local path": "локальний шлях", "a URL": "URL-адреса", "a domain": "домен", "a port": "порт",
  "an IP address": "IP-адреса", "an email address": "адреса електронної пошти", "a phone number": "номер телефону",
  "a conversation, deployment, card or pipeline id": "ідентифікатор розмови, розгортання, картки або пайплайна",
  "a usage limit": "ліміт використання", "an account name": "назва облікового запису", "a person's name": "ім’я людини",
  "another project": "інший проєкт", "a host name": "назва хоста", "a secret": "секрет", "a credential": "облікові дані",
  "a home directory path": "шлях до домашньої теки", "a private network address": "адреса приватної мережі",
  "a resource identifier": "ідентифікатор ресурсу", "a line copied from a conversation": "рядок, скопійований із розмови",
  "a quoted block": "блок цитати", "a quotation": "цитата",
  "an embedded image; review screenshot redaction": "вбудоване зображення; перевірте, що на знімку все приховано",
  "Known-name hints are unavailable; review names and identities yourself.": "Підказки щодо відомих імен недоступні; перевірте імена й особи самостійно.",
};

/* A delimiter longer than every embedded run preserves literal backticks. */
const verbatim = (text: string) => text.trim().split("\n").filter((line) => line.trim())
  .map((line) => {
    const value = line.trim();
    const length = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length)) + 1;
    const fence = "`".repeat(length);
    const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
    return `${fence}${padding}${value}${padding}${fence}`;
  }).join(" ↵ ");

/* Boundary-like report lines are quoted, so only the preview's own markers
   have the unquoted boundary style. The publication bytes stay untouched. */
const distinguishBoundaries = (text: string) => text.split("\n").map((line) =>
  /PUBLISHED (?:FROM HERE|UP TO HERE)|ПУБЛІКУЄТЬСЯ (?:ЗВІДСИ|ДОСЮДИ)/i.test(line) ? `> ${line}` : line).join("\n");

/* The chat draws an unclosed code fence to the end of the message, which
   would swallow the closing marker and everything after it. */
function leavesFenceOpen(body: string): boolean {
  let open = false;
  for (const line of body.split("\n")) open = open ? !/^\s*```\s*$/.test(line) : /^\s*```/.test(line);
  return open;
}

/** A chat-ready preview: the text that gets published as one bounded unit, the agent's review after it. */
export function issueReportPreviewText(preview: PreviewText, language: IssueReportLanguage = "en"): string {
  const copy = COPY[language];
  const local = (text: string) => (language === "uk" ? UK[text] ?? text : text);
  const judgment = preview.privacyJudgment;
  /* One line per span, whatever number of detectors pointed at it. */
  const spans = new Map<string, { hint: IssueReportFinding; labels: string[] }>();
  for (const hint of preview.hints ?? []) {
    const key = [hint.where, hint.reading, hint.lines.join(","), hint.span.text.trim()].join("\n");
    const label = local(hint.label ?? String(hint.class).replaceAll("_", " "));
    const entry = spans.get(key) ?? { hint, labels: [] };
    if (!entry.labels.includes(label)) entry.labels.push(label);
    spans.set(key, entry);
  }
  const place = (hint: IssueReportFinding) => (hint.where === "title" ? copy.inTitle
    : `${hint.lines.length > 1 ? copy.lines : copy.line} ${hint.lines.join(", ")}`) + (hint.reading === "decoded" ? `, ${copy.decoded}` : "");
  /* Quoting moves a line out of the chat's fence parsing, so the fence is
     counted on the lines as drawn. */
  const title = distinguishBoundaries(preview.title);
  const body = distinguishBoundaries(preview.body);
  return [
    copy.heading, `${copy.digest}: ${shortId(preview.digest)}`, "",
    `**━━ ${copy.from} ━━**`,
    `> ${copy.title}`, title,
    `> ${copy.body}`, body, ...(leavesFenceOpen(`${title}\n${body}`) ? ["```"] : []),
    `**━━ ${copy.to} ━━**`,
    copy.below, "",
    `**${copy.judgment}**`,
    judgment ? `${copy.assessment}: ${judgment.assessment}\n${copy.removed}: ${judgment.removed}\n${copy.harmless}: ${judgment.harmlessHints}\n${copy.uncertainties}: ${judgment.uncertainties}`
      : copy.legacy,
    "", `**${copy.hints}**`,
    ...(spans.size ? [...spans.values()].map(({ hint, labels }) => `- ${labels.join(", ")} · ${place(hint)}: ${verbatim(hint.span.text)}`) : [preview.hints === undefined ? copy.unrecorded : copy.none]),
    ...(preview.hintWarnings?.length ? ["", ...preview.hintWarnings.map((warning) => `${copy.warning}: ${local(warning)}`)] : []),
    "", copy.closing,
  ].join("\n");
}
