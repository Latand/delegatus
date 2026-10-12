/** Small display metadata; the original draft remains the retry payload. */
export interface MessageTextAttachment {
  name: string;
  path: string;
  text: string;
}

export interface MessageTextAttachmentMarker extends MessageTextAttachment {
  /** The operator's own opening words, when the marker carries them. */
  excerpt: string | null;
  /** Paths of the operator's other attachments, the generated file excluded. */
  operatorPaths: string[];
}

const EXCERPT_PREFIX = "The message begins: ";
const EXCERPT_CODE_POINTS = 160;

/** One line of the operator's opening words: the delivered marker carries it,
 * so the sent bubble, the transcript row and another device all show the same
 * recognisable text. Null when the text has no words to show. */
export function messageTextExcerpt(text: string): string | null {
  const words = text.replace(/\s+/g, " ").trim();
  if (!words) return null;
  const points = Array.from(words);
  const shown = points.length > EXCERPT_CODE_POINTS
    ? `${points.slice(0, EXCERPT_CODE_POINTS).join("").trimEnd()}…` : words;
  return `${EXCERPT_PREFIX}${shown}`;
}

/** The marker survives transcript adoption and reads on another device. */
export function messageTextAttachmentFromText(text: string): MessageTextAttachmentMarker | null {
  const lines = text.split("\n");
  const match = /^The full message is attached as (message(?:-\d+)?\.txt)\. Read the file in full before responding\.$/.exec(lines[0] ?? "");
  if (!match) return null;
  const rest = lines.slice(1);
  const excerptLine = rest[0]?.startsWith(EXCERPT_PREFIX) ? rest[0] : null;
  const paths = excerptLine === null ? rest : rest.slice(1);
  const path = paths.find(candidate => {
    const normalized = candidate.replaceAll("\\", "/");
    const absolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
    return absolute && normalized.endsWith(`/${match[1]}`);
  });
  return path ? {
    name: match[1]!,
    path,
    text,
    excerpt: excerptLine?.slice(EXCERPT_PREFIX.length) ?? null,
    operatorPaths: paths.filter(candidate => candidate !== path && candidate.trim() !== ""),
  } : null;
}
