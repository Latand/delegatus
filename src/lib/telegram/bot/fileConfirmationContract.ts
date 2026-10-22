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

/** Independent of the shared settings catalog owned by the voice-approval lane. */
export const fileConfirmationText = {
  en: {
    title: "Send this file to Telegram?", intro: "Review the detector warnings and the exact destination. Approval sends these bytes once. This request expires after ten minutes.",
    requestedPath: "Requested path", resolvedPath: "Resolved file", replyTo: "Reply to message", format: "Caption format", plain: "Plain text", html: "HTML", silent: "Silent delivery", yes: "Yes", no: "No",
    chat: "Destination chat", topic: "Topic", files: "Files", reasons: "Detector warnings", expires: "Expires", caption: "Caption", approve: "Approve and send once", reject: "Do not send", loading: "Loading confirmation…",
    owner: "Sign in with Telegram as the paired installation owner to review this send.", signIn: "Sign in", unavailable: "This confirmation is unavailable. Ask for a new send request.", failed: "The send was refused. Review the result before requesting another send.", sent: "Sent. This confirmation has been used.", rejected: "Send declined.", pending: "Awaiting your decision", approved: "Sending…", expired: "This confirmation has expired. Ask for a new send request.", uncertain: "Telegram did not confirm delivery. Check the destination before requesting another send.",
  },
  uk: {
    title: "Надіслати цей файл у Telegram?", intro: "Перевірте попередження детекторів і точне місце доставки. Підтвердження надсилає ці байти один раз. Запит діє десять хвилин.",
    requestedPath: "Запитаний шлях", resolvedPath: "Фактичний файл", replyTo: "Відповідь на повідомлення", format: "Формат підпису", plain: "Звичайний текст", html: "HTML", silent: "Без сповіщення", yes: "Так", no: "Ні",
    chat: "Чат доставки", topic: "Тема", files: "Файли", reasons: "Попередження детекторів", expires: "Діє до", caption: "Підпис", approve: "Підтвердити й надіслати один раз", reject: "Не надсилати", loading: "Завантаження підтвердження…",
    owner: "Для перевірки увійдіть через Telegram як власник, прив’язаний до цієї інсталяції.", signIn: "Увійти", unavailable: "Це підтвердження недоступне. Попросіть новий запит на надсилання.", failed: "Надсилання відхилено. Перевірте результат перед новим запитом.", sent: "Надіслано. Це підтвердження вже використано.", rejected: "Надсилання скасовано.", pending: "Очікує на ваше рішення", approved: "Надсилання…", expired: "Термін дії підтвердження минув. Попросіть новий запит.", uncertain: "Telegram не підтвердив доставку. Перевірте чат перед новим запитом на надсилання.",
  },
} as const;

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
