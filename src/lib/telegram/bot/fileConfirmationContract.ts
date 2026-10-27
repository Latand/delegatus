import type { DocumentWarning } from "./documents";

export interface FileSendOptions {
  conversationId: string | null;
  clientRequestId: string;
  chat: string;
  topicId: number | null;
  replyToMessageId: number | null;
  format: "plain" | "html";
  silent: boolean;
  document?: { path: string; filename: string; caption: string | null };
  images?: Array<{ path: string; caption: string }>;
}
export interface FileConfirmationView {
  id: string;
  digest: string;
  kind: "document" | "media";
  chatId: string;
  chatTitle: string;
  topicId: number | null;
  options: FileSendOptions;
  files: Array<{ path: string; resolvedPath: string; filename: string; sha256: string; bytes: number }>;
  reasons: DocumentWarning[];
  createdAt: string;
  expiresAt: string;
  state: "pending" | "approved" | "sent" | "failed" | "uncertain" | "expired" | "rejected" | "unavailable";
  decidedAt?: string;
  decidedBy?: "owner";
  messageIds?: number[];
}

type Locale = "en" | "uk";
/* Counts one to three read as words; a larger count is a figure. */
const COUNT_WORDS = {
  en: ["one", "two", "three"],
  uk: { feminine: ["одна", "дві", "три"], neuter: ["одне", "два", "три"] },
} as const;
const UK_FORMS = {
  reason: { one: "причина", few: "причини", many: "причин" },
  warning: { one: "застереження", few: "застереження", many: "застережень" },
  image: { one: "зображення", few: "зображення", many: "зображень" },
} as const;
function ukCount(count: number, noun: keyof typeof UK_FORMS, gender: "feminine" | "neuter"): string {
  const form = new Intl.PluralRules("uk").select(count);
  const word = UK_FORMS[noun][form === "one" ? "one" : form === "few" ? "few" : "many"];
  return `${count >= 1 && count <= 3 ? COUNT_WORDS.uk[gender][count - 1] : count} ${word}`;
}
function enCount(count: number, singular: string): string {
  return `${count >= 1 && count <= 3 ? COUNT_WORDS.en[count - 1] : count} ${singular}${new Intl.PluralRules("en").select(count) === "one" ? "" : "s"}`;
}
const capital = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

/** Independent of the shared settings catalog owned by the voice-approval lane. */
export const fileConfirmationText = {
  en: {
    refuse: "Don't send", approve: "Send once anyway", sending: "Sending…", declining: "Declining…",
    loading: "Loading confirmation…",
    requestedPath: "Requested path", resolvedPath: "Resolved file", size: "Size", bytes: "bytes", chat: "Chat", chatId: "Chat id", topic: "Topic",
    replyTo: "Reply to message", caption: "Caption", format: "Caption format", plain: "Plain text", html: "HTML", silent: "Silent delivery", yes: "Yes", no: "No",
    roots: "Allowed folders", codes: "Detector codes", created: "Requested", decided: "Decided", id: "Request id", expires: "Valid until", digest: "Digest",
    line: "line", stateLabel: "State",
    status: { pending: "Awaiting your decision", sending: "Sending…", declining: "Declining…", approved: "Sending…", sent: "Sent", rejected: "Not sent", expired: "Expired", uncertain: "Delivery unconfirmed", failed: "Refused", unavailable: "Unavailable" },
    minutesLeft: (minutes: number, time: string) => `${minutes} min left, until ${time}`,
    at: (time: string) => `at ${time}`,
    sentTitle: (chat: string) => `Sent anyway to ${chat}`,
    sentBody: (time: string | null, subject: string, warnings: string) => `${time ? `At ${time} you` : "You"} approved ${subject} despite ${warnings}.`,
    linkSubject: (real: string, filename: string) => `${real}, which ${filename} links to,`,
    rejectedTitle: (chat: string) => `Not sent to ${chat}`,
    rejectedBody: (time: string | null, subject: string) => `${time ? `At ${time} you` : "You"} chose not to send ${subject}.`,
    usedUp: "This confirmation is used up.",
    expiredTitle: "This request expired",
    expiredBody: (time: string) => `It was valid until ${time}. Ask the agent for a new request.`,
    uncertainTitle: "Telegram did not confirm delivery",
    uncertainBody: (chat: string) => `Check ${chat} before asking for another send.`,
    failedTitle: "The send was refused",
    failedBody: "Review the details before asking for another send.",
    unavailableTitle: "This confirmation is unavailable",
    unavailableBody: "Ask the agent for a new send request.",
    ownerTitle: "Sign in to review this send",
    ownerBody: "Sign in with Telegram as the paired installation owner.",
    signIn: "Sign in",
  },
  uk: {
    refuse: "Не надсилати", approve: "Усе одно надіслати один раз", sending: "Надсилання…", declining: "Скасування…",
    loading: "Завантаження підтвердження…",
    requestedPath: "Запитаний шлях", resolvedPath: "Фактичний файл", size: "Розмір", bytes: "байт", chat: "Чат", chatId: "Ідентифікатор чату", topic: "Тема",
    replyTo: "Відповідь на повідомлення", caption: "Підпис", format: "Формат підпису", plain: "Звичайний текст", html: "HTML", silent: "Без сповіщення", yes: "Так", no: "Ні",
    roots: "Дозволені теки", codes: "Коди детекторів", created: "Запит", decided: "Рішення", id: "Ідентифікатор запиту", expires: "Діє до", digest: "Дайджест",
    line: "рядок", stateLabel: "Стан",
    status: { pending: "Очікує вашого рішення", sending: "Надсилання…", declining: "Скасування…", approved: "Надсилання…", sent: "Надіслано", rejected: "Не надіслано", expired: "Минув термін", uncertain: "Доставка не підтверджена", failed: "Відхилено", unavailable: "Недоступне" },
    minutesLeft: (minutes: number, time: string) => `ще ${minutes} хв, до ${time}`,
    at: (time: string) => `о ${time}`,
    sentTitle: (chat: string) => `Усе одно надіслано у ${chat}`,
    sentBody: (time: string | null, subject: string, warnings: string) => `${time ? `О ${time} ви` : "Ви"} підтвердили ${subject} попри ${warnings}.`,
    linkSubject: (real: string, filename: string) => `${real}, на який вказує ${filename},`,
    rejectedTitle: (chat: string) => `Не надіслано у ${chat}`,
    rejectedBody: (time: string | null, subject: string) => `${time ? `О ${time} ви` : "Ви"} вирішили не надсилати ${subject}.`,
    usedUp: "Це підтвердження використано.",
    expiredTitle: "Термін дії запиту минув",
    expiredBody: (time: string) => `Він діяв до ${time}. Попросіть агента про новий запит.`,
    uncertainTitle: "Telegram не підтвердив доставку",
    uncertainBody: (chat: string) => `Перевірте ${chat}, перш ніж просити про нове надсилання.`,
    failedTitle: "Надсилання відхилено",
    failedBody: "Перегляньте деталі, перш ніж просити про нове надсилання.",
    unavailableTitle: "Це підтвердження недоступне",
    unavailableBody: "Попросіть агента про новий запит на надсилання.",
    ownerTitle: "Увійдіть, щоб переглянути це надсилання",
    ownerBody: "Увійдіть через Telegram як власник, прив’язаний до цієї інсталяції.",
    signIn: "Увійти",
  },
} as const;

/* What a detector found, in a few words, by the class `documentSecret` names. */
const SECRET_THING: Record<Locale, Record<string, string>> = {
  en: { "private_key": "a private key", "api_token": "an API token", "bot_token": "a bot token", "jwt": "a JWT", "bearer_token": "an access token", "authorization_header": "an authorization header", "cookie_header": "a session cookie", "url_credentials": "a password inside a link", "credential_assignment": "a password or key", "provider_credential": "a service credential" },
  uk: { "private_key": "приватний ключ", "api_token": "API-токен", "bot_token": "токен бота", "jwt": "JWT-токен", "bearer_token": "токен доступу", "authorization_header": "заголовок авторизації", "cookie_header": "кукі сесії", "url_credentials": "пароль у посиланні", "credential_assignment": "пароль чи ключ", "provider_credential": "облікові дані сервісу" },
};
const secretThing = (reason: DocumentWarning, locale: Locale) => (reason.secretClass && Object.hasOwn(SECRET_THING[locale], reason.secretClass) ? SECRET_THING[locale][reason.secretClass] : locale === "uk" ? "секрет" : "a secret");
const basename = (file: string) => file.replace(/\/+$/, "").split("/").pop() || file;
const rootNames = (roots: string[]) => roots.map(basename).join(", ");

export interface FileConfirmationSummary {
  /** The pending heading: the strongest reason (a secret, then a hidden folder, then the folders outside the roots). */
  heading: string;
  /** Who wants to send what, where, and the file a link really points at. */
  intro: string;
  /** The sentence that introduces `reasons`; null when the heading said the only reason. */
  more: string | null;
  /** Every other reason, in stored order, as a sentence. */
  reasons: string[];
  /** The last two segments of the resolved file when the requested name is a link to it. */
  real: string | null;
  /** What was sent or declined: the file, the file a link points at, or the image count. */
  approvedSubject: string;
  declinedSubject: string;
  /** The reason count as words ("three warnings"). */
  warnings: string;
  /** Names a sentence must keep on one line when they are short. */
  names: string[];
}

/** The sentences of variant 2 of the owner page, from the stored view alone. */
export function fileConfirmationSummary(view: Pick<FileConfirmationView, "chatTitle" | "files" | "reasons">, locale: Locale): FileConfirmationSummary {
  const uk = locale === "uk";
  const words = fileConfirmationText[locale];
  const several = view.files.length > 1;
  const first = view.files[0];
  const filename = first?.filename ?? "";
  const real = !several && first && first.resolvedPath && first.resolvedPath !== first.path ? first.resolvedPath.split("/").filter(Boolean).slice(-2).join("/") : null;
  const lead = view.reasons.find(reason => reason.code === "document_secret")
    ?? view.reasons.find(reason => reason.code === "document_forbidden_path")
    ?? view.reasons.find(reason => reason.code === "document_outside_roots");
  const fallback = (reason: DocumentWarning) => fileConfirmationReason(reason, locale);
  const headingFor = (reason: DocumentWarning | undefined): string => {
    if (!reason) return uk ? "Delegatus зупинив це надсилання" : "Delegatus paused this send";
    if (reason.code === "document_secret") return uk ? `Схоже, у цьому файлі ${secretThing(reason, locale)}` : `This file looks like it holds ${secretThing(reason, locale)}`;
    if (reason.code === "document_forbidden_path" && reason.segment) {
      return uk ? `${several ? "Один із файлів" : "Файл"} лежить у прихованій теці ${reason.segment}` : `${several ? "One of these files" : "This file"} is inside the hidden folder ${reason.segment}`;
    }
    if (reason.code === "document_outside_roots" && reason.roots?.length) {
      return uk ? `${several ? "Один із файлів" : "Файл"} поза теками, з яких дозволено надсилати (${rootNames(reason.roots)})` : `${several ? "One of these files" : "This file"} is outside the folders files may be sent from (${rootNames(reason.roots)})`;
    }
    return fallback(reason).replace(/\.$/, "");
  };
  const rest = view.reasons.filter(reason => reason !== lead);
  const names = [filename, view.chatTitle, ...(real ? [real] : [])];
  let previous: string | null | undefined;
  const reasons = rest.map((reason, index) => {
    const about = several ? reason.path ?? null : first?.path ?? null;
    const same = index > 0 && about !== null && about === previous;
    previous = about;
    if (several && !reason.path) return fallback(reason);
    const name = several ? basename(reason.path!) : null;
    if (name) names.push(name);
    /* Every reason sentence opens with its subject: the file, its own name among several, or "it" after a sentence about the same file. */
    const subject = same ? (uk ? "Він" : "It") : name ?? (uk ? "Файл" : "The file");
    if (reason.code === "document_forbidden_path" && reason.segment) return uk ? `${subject} лежить у прихованій теці ${reason.segment}.` : `${subject} is inside the hidden folder ${reason.segment}.`;
    if (reason.code === "document_outside_roots" && reason.roots?.length) return uk ? `${subject} поза теками, з яких дозволено надсилати (${rootNames(reason.roots)}).` : `${subject} is outside the folders files may be sent from (${rootNames(reason.roots)}).`;
    if (reason.code === "document_secret") {
      const line = reason.line ? ` (${words.line} ${reason.line})` : "";
      if (uk) return `Схоже, у ${same ? "ньому" : name ?? "файлі"} ${secretThing(reason, locale)}${line}.`;
      return `${subject} looks like it holds ${secretThing(reason, locale)}${line}.`;
    }
    return fallback(reason);
  });
  const images = uk ? ukCount(view.files.length, "image", "neuter") : enCount(view.files.length, "image");
  const intro = several
    ? (uk ? `Агент хоче надіслати ${images} у ${view.chatTitle}.` : `An agent wants to send ${images} to ${view.chatTitle}.`)
    : uk ? `Агент хоче надіслати ${filename} у ${view.chatTitle}${real ? `, а це посилання на ${real}` : ""}.`
      : `An agent wants to send ${filename} to ${view.chatTitle}${real ? `, and it is a link to ${real}` : ""}.`;
  const count = rest.length;
  const more = !count ? null : uk ? `Ще ${ukCount(count, "reason", "feminine")}, чому Delegatus зупинив надсилання:` : `${capital(enCount(count, "more reason"))} Delegatus paused it:`;
  return {
    heading: headingFor(lead),
    intro,
    more,
    reasons,
    real,
    approvedSubject: several ? images : real ? words.linkSubject(real, filename) : filename,
    declinedSubject: several ? images : filename,
    warnings: uk ? ukCount(view.reasons.length, "warning", "neuter") : enCount(view.reasons.length, "warning"),
    names: [...new Set(names.filter(Boolean))],
  };
}

/** Route verdicts are untrusted data at the MCP transport boundary. */
export function readFileConfirmationLink(value: unknown): { id: string; url: string; expiresAt: string } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(candidate.id)
    || candidate.url !== `/telegram-file-confirmation?id=${candidate.id}` || typeof candidate.expiresAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate.expiresAt) || !Number.isFinite(Date.parse(candidate.expiresAt))) return null;
  return { id: candidate.id, url: candidate.url, expiresAt: candidate.expiresAt } as { id: string; url: string; expiresAt: string };
}

/** The app route must navigate in the transcript instead of opening a file preview. */
export function isFileConfirmationUrl(href: string): boolean {
  return /^\/telegram-file-confirmation\?id=[A-Za-z0-9_-]{1,80}$/.test(href);
}

export function fileConfirmationReason(reason: DocumentWarning, locale: "en" | "uk"): string {
  if (locale === "en") return reason.reason;
  if (reason.code === "document_forbidden_path") return reason.path && reason.segment ? `${reason.path} проходить через прихований каталог ${reason.segment}.` : reason.reason;
  if (reason.code === "document_outside_roots") return reason.path && reason.roots ? `${reason.path} розташований поза дозволеними каталогами документів (${reason.roots.join(", ")}).` : reason.reason;
  return `Файл містить дані, схожі на секрет${reason.secretClass ? ` (${reason.secretClass}${reason.line ? `, рядок ${reason.line}` : ""})` : ""}.`;
}
