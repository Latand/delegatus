import { ExternalRelayError } from "./errors";
import type { ExternalRelayAnswer, ExternalRelayRequest, RelayAttachment, RelayMention } from "./protocol";

const malformed = (): never => { throw new ExternalRelayError("malformed", 400); };
const invalid = (): never => { throw new ExternalRelayError("invalid_format", 422); };
const opaque = /^[A-Za-z0-9_-]{1,64}$/;

/** Offsets stay in original Unicode scalars, including astral characters.
 * Regions that cannot carry a person annotation get distinct negative leaves.
 * Syntax is bounded by the rich source cap before this scanner is called. */
function sourceLeaves(text: string) {
  const points = Array.from(text);
  const leaves = new Int32Array(points.length), code = new Uint8Array(points.length);
  // Match backtick runs once across the original source. Inline code may cross
  // a soft line break; per-line matching would admit a mention inside it.
  const runs: { start: number; end: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    if (points[i] === "\\") { i++; continue; }
    if (points[i] !== "`") continue;
    const start = i; while (points[i + 1] === "`") i++;
    runs.push({ start, end: i + 1 });
  }
  const next = new Map<number, number>(), matches = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i]!.end - runs[i]!.start, match = next.get(length);
    if (match !== undefined) matches.set(i, match);
    next.set(length, i);
  }
  for (let i = 0; i < runs.length; i++) {
    const match = matches.get(i); if (match === undefined) continue;
    code.fill(1, runs[i]!.start, runs[match]!.end); i = match;
  }
  // Links and emphasis can cross a soft line break too. Classify their
  // delimiters before assigning leaves to individual physical lines.
  const brackets: number[] = [], emphasis = new Map<string, number[]>();
  for (let i = 0; i < points.length; i++) {
    if (code[i]) continue;
    const c = points[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") brackets.push(i);
    if (c === "]" && brackets.length) {
      const start = brackets.pop()!;
      if (points[i + 1] === "(" || points[i + 1] === "[") {
        const opener = points[i + 1], closer = opener === "(" ? ")" : "]";
        let end = i + 2, depth = 1;
        for (; end < points.length && depth; end++) {
          if (points[end] === "\\") { end++; continue; }
          if (points[end] === opener) depth++;
          if (points[end] === closer) depth--;
        }
        leaves.fill(-1, start > 0 && points[start - 1] === "!" ? start - 1 : start, end);
        i = end - 1;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      let end = i + 1; while (points[end] === c) end++;
      const before = points[i - 1] ?? " ", after = points[end] ?? " ";
      if (!(c === "_" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) && !(c === "~" && end - i !== 2)) {
        const delimiter = points.slice(i, end).join(""), opens = emphasis.get(delimiter) ?? [];
        if (!/\s/.test(before) && opens.length) {
          const start = opens.pop()!; leaves.fill(-1, start, start + delimiter.length); leaves.fill(-1, i, end);
        } else if (!/\s/.test(after)) opens.push(i);
        emphasis.set(delimiter, opens);
      }
      i = end - 1;
    }
  }
  const images: { id: string; line: number }[] = [];
  let leaf = 1, base = 0, fence: string | null = null;
  const lines = text.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo]!, chars = Array.from(line);
    const marker = /^(?:\s{0,3}>\s*)*(?:\s*(?:[-+*]|\d+[.)])\s+)?\s*(`{3,}|~{3,})/.exec(line)?.[1];
    const indented = /^(?: {4}|\t)/.test(line);
    const isCode = !!fence || !!marker || indented;
    if (indented && !fence && !marker && /!\[.*\]\(attachment:/.test(line)) invalid();
    if (fence) { if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null; }
    else if (marker) fence = marker;
    const inert = new Uint8Array(chars.length);
    if (!isCode) {
      for (let i = 0; i < chars.length; i++) {
        if (code[base + i]) { leaves[base + i] = -1; inert[i] = 1; continue; }
        const c = chars[i];
        if (c === "\\") {
          leaves[base + i] = -1; inert[i] = 1;
          if (i + 1 < chars.length) { i++; leaves[base + i] = -1; inert[i] = 1; }
          continue;
        }
        if (c === "|") leaves[base + i] = -1;
      }

      const prefix = /^(?: {0,3}(?:>\s*)+| {0,3}#{1,6}\s+|\s*(?:[-+*]|\d+[.)])\s+)/.exec(line)?.[0];
      if (prefix) leaves.fill(-1, base, base + Array.from(prefix).length);
      for (let i = 0; i < chars.length; i++) {
        if (leaves[base + i]! < 0) leaf++;
        else leaves[base + i] = leaf;
      }
      const image = /^!\[\]\(attachment:([A-Za-z0-9_-]{1,64})\)\s*$/.exec(line);
      if (image && !inert[0]) images.push({ id: image[1]!, line: lineNo });
      else for (let i = 0; i < chars.length - 1; i++) if (chars[i] === "!" && chars[i + 1] === "[" && !inert[i]) invalid();
      const syntax = chars.map((c, i) => inert[i] ? " " : c).join("");
      if (/<\/?tg-slideshow\b/i.test(syntax)) invalid();
    }
    base += chars.length + 1; leaf++;
  }
  return { points, leaves, images, lines };
}

export function checkedMentions(value: unknown, text: string, format: string, request: ExternalRelayRequest): RelayMention[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > Math.min(16, request.input.format?.mentions?.max_items ?? 16)) return malformed();
  if (!value.length) return [];
  if (format !== "rich_markdown" || !request.features?.includes("relay_rich_messages") || Array.from(text).length > 32000 || /\p{Cs}/u.test(text)) return malformed();
  const { points, leaves } = sourceLeaves(text);
  const allowed = new Set<string>(), denied = new Set<string>();
  for (const { author } of request.input.conversation) {
    if (author.self || author.tags?.some(tag => ["bot", "assistant", "channel", "anonymous"].includes(tag))) denied.add(author.key);
    else allowed.add(author.key);
  }
  if (request.input.requester) {
    const who = request.input.requester;
    if (who.is_anonymous_admin) denied.add(who.key); else allowed.add(who.key);
  }
  let previousEnd = 0;
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "author_key,length,offset") return malformed();
    const { author_key, offset, length } = raw;
    if (typeof author_key !== "string" || !opaque.test(author_key) || /^\d+$/.test(author_key) || !allowed.has(author_key) || denied.has(author_key) || ["assistant", "bot", "channel", "anonymous"].includes(author_key)
      || !Number.isInteger(offset) || !Number.isInteger(length) || offset < previousEnd || offset > 31999 || length < 1 || length > Math.min(128, request.input.format?.mentions?.max_label_chars ?? 128) || offset + length > points.length) return malformed();
    const label = points.slice(offset, offset + length).join("");
    if (!label.trim() || /[\p{Cc}\p{Cs}]/u.test(label) || leaves[offset]! <= 0) return malformed();
    for (let i = offset; i < offset + length; i++) if (leaves[i] !== leaves[offset]) return malformed();
    previousEnd = offset + length;
    return { author_key, offset, length };
  });
}

/** Syntax precheck, before local files have been assigned stable upload IDs. */
export function photoReferenceSource(text: string): string {
  const { images, lines } = sourceLeaves(text);
  const positions = new Set(images.map(image => image.line));
  return lines.map((line, i) => positions.has(i) ? "photo" : line).join("\n");
}

/** Final validation runs against selected IDs and actual upload receipts. The
 * service alone composes the rich body and owns its single delivery receipt. */
export function validateAnswerComposition(answer: ExternalRelayAnswer, request: ExternalRelayRequest,
  selected: readonly RelayAttachment[], ready: readonly RelayAttachment[] = selected) {
  const mentions = checkedMentions(answer.mentions, answer.text, answer.format ?? "plain", request);
  if (answer.action === "ignore" && mentions.length) malformed();
  if (answer.format !== "rich_markdown" && !/!\[[^\]]*\]\(attachment:/.test(answer.text)) {
    if (selected.some(file => !ready.some(upload => upload.attachment_id === file.attachment_id && upload.kind === file.kind)))
      throw new ExternalRelayError("attachment_not_ready", 422);
    return;
  }
  const { images, lines } = sourceLeaves(answer.text);
  if (images.length) {
    if (answer.format !== "rich_markdown" || !request.features?.includes("relay_media_out")) invalid();
    const photos = selected.filter(file => file.kind === "photo");
    if (images.length !== photos.length || images.some((ref, i) => ref.id !== photos[i]!.attachment_id)) invalid();
    const start = images[0]!.line, end = images.at(-1)!.line;
    const positions = new Set(images.map(image => image.line));
    for (let i = start; i <= end; i++) if (!positions.has(i) && lines[i]!.trim()) invalid();
  }
  if (selected.some(file => !ready.some(upload => upload.attachment_id === file.attachment_id && upload.kind === file.kind)))
    throw new ExternalRelayError("attachment_not_ready", 422);
}
