/** A Telegram chat reference pasted by an operator or agent. */
export function parseTelegramChatReference(value: unknown): { chat: string; topicId?: number } | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (/^-?\d+$/.test(input) && Number.isSafeInteger(Number(input))) return { chat: input };
  const direct = /^@([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(input);
  if (direct) return { chat: `@${direct[1]}` };
  const url = /^(?:https?:\/\/)?(?:www\.)?t\.me\/([^?#]+)\/?(?:[?#].*)?$/i.exec(input);
  if (!url) return null;
  const parts = url[1]!.replace(/\/$/, "").split("/");
  let chat: string;
  let topic: string | undefined;
  if (parts[0] === "c" && (parts.length === 3 || parts.length === 4) && /^\d+$/.test(parts[1] ?? "")) {
    chat = `-100${parts[1]}`;
    topic = parts[2];
  } else if ((parts.length === 1 || parts.length === 2 || parts.length === 3) && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(parts[0] ?? "")) {
    chat = `@${parts[0]}`;
    topic = parts[1];
  } else return null;
  if (topic === undefined) return { chat };
  const topicId = Number(topic);
  return /^\d+$/.test(topic) && Number.isSafeInteger(topicId) && topicId > 0
    && (parts.length < 4 || /^\d+$/.test(parts[3] ?? ""))
    && (parts.length < 3 || parts[0] === "c" || /^\d+$/.test(parts[2] ?? ""))
    ? { chat, topicId } : null;
}
