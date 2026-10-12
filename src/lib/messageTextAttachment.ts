/** Small display metadata; the original draft remains the retry payload. */
export interface MessageTextAttachment {
  name: string;
  path: string;
  text: string;
}

/** The marker survives transcript adoption and reads on another device. */
export function messageTextAttachmentFromText(text: string): MessageTextAttachment | null {
  const lines = text.split("\n");
  const match = /^The full message is attached as (message(?:-\d+)?\.txt)\. Read the file in full before responding\.$/.exec(lines[0] ?? "");
  if (!match) return null;
  const path = lines.slice(1).find(candidate => {
    const normalized = candidate.replaceAll("\\", "/");
    const absolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
    return absolute && normalized.endsWith(`/${match[1]}`);
  });
  return path
    ? { name: match[1]!, path, text } : null;
}
