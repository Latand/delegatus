import crypto from "node:crypto";

import { IMAGE_MIME_EXT, MAX_INBOX_IMAGE_BYTES } from "@/lib/imagePolicy";

/**
 * The pictures one transcript line carries, for a task's album. Both engines'
 * records are read here, and only the parts where a picture is a picture:
 *
 * - bytes an agent looked at or the operator pasted: Claude's
 *   `{ type: "image", source: { type: "base64" } }` blocks (a Read of an image,
 *   a pasted screenshot) and Codex's `data:image/…;base64,` parts;
 * - a file an agent opened as an image: a Claude Read whose result carried an
 *   image, a Codex `view_image` / image-view item, a `local_image` part;
 * - a file named in what an agent or the operator wrote: message text, and the
 *   string arguments of every tool call (a stage report, a PR body, the
 *   screenshot command that wrote the render).
 *
 * Tool OUTPUT text is not read for paths: a listing prints every file in a
 * directory, and a picture the agent never named is not one it made or saw.
 * What a line names is only a candidate; the album keeps the files that exist
 * under a served root when it is read.
 */

export type AlbumVia = "read" | "pasted" | "named";

/** One picture a line carries: a file on disk, bytes inside the transcript,
    or both (a Read whose file may be gone by the time the album is opened). */
export interface LineImage {
  /** Stable identity inside a task: `f:<path>` or `i:<digest of the bytes>`. */
  key: string;
  via: AlbumVia;
  path?: string;
  /** The ordinal of the inline picture inside its line, the handle the image
      route reads the bytes back by. */
  inline?: { ordinal: number; media: string; bytes: number };
}

/** A Read call's id and the image file it opened, carried from the call's
    line to its result's. */
export type PendingReads = Map<string, string>;

const MAX_PENDING_READS = 256;
const MAX_PATH_CHARS = 1024;
/** Longest string searched for paths: a base64 body or a file's contents is not prose. */
const MAX_SCANNED_STRING = 256 * 1024;
const RASTER_EXT = /\.(?:png|jpe?g|gif|webp)$/i;
/* An absolute or `~/` path ending in a raster extension, stopped by
   whitespace, quotes, brackets and the markdown/shell punctuation around it. */
const PATH_RE = /(?:~\/|\/)[^\s"'`<>()[\]{}|*?,;\\]*\.(?:png|jpe?g|gif|webp)(?![A-Za-z0-9_])/gi;
const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i;
const BASE64_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** Cheap test a line must pass before it is parsed at all. */
const LINE_HINT_RE = /"image|\.(?:png|jpe?g|gif|webp)/i;
const RASTER_EXT_ANYWHERE = /\.(?:png|jpe?g|gif|webp)/i;

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function decodedLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function digest(base64: string): string {
  return crypto.createHash("sha1").update(base64).digest("hex").slice(0, 24);
}

/** A raster path as written (a `file://` prefix dropped), or null. */
export function rasterPath(value: string): string | null {
  const path = value.trim().replace(/^file:\/\//, "");
  if (!path || path.length > MAX_PATH_CHARS || /[\0\r\n]/.test(path)) return null;
  if (!path.startsWith("/") && !path.startsWith("~/")) return null;
  return RASTER_EXT.test(path) ? path : null;
}

/** Every raster path a piece of text names, in order. */
export function pathsInText(text: string): string[] {
  if (!text || text.length > MAX_SCANNED_STRING || !RASTER_EXT_ANYWHERE.test(text)) return [];
  const found: string[] = [];
  for (const match of text.matchAll(PATH_RE)) {
    /* A URL's path or the tail of a relative path is not a file path; a flag's
       value (`--screenshot=/var/tmp/x.png`) is. */
    const before = text[match.index - 1];
    if (before && /[A-Za-z0-9_.:-]/.test(before)) continue;
    const path = rasterPath(match[0]);
    if (path && !path.includes("//")) found.push(path);
  }
  return found;
}

/** Every string value inside a tool call's input, bounded. */
function strings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || out.length > 200) return;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out, depth + 1);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, out, depth + 1);
}

class LineCollector {
  readonly images: LineImage[] = [];
  private ordinal = 0;
  /** The bytes of the inline picture at `capture`, for the image route. */
  captured: { media: string; data: string } | null = null;

  constructor(private readonly capture: number | null = null) {}

  named(text: string, via: AlbumVia = "named"): void {
    for (const path of pathsInText(text)) this.file(path, via);
  }

  file(path: string, via: AlbumVia): void {
    this.images.push({ key: `f:${path}`, via, path });
  }

  /** An inline picture, whether or not it can be drawn: the ordinal counts
      every one, so the image route finds the same picture by the same walk. */
  inline(media: string, data: string, via: AlbumVia, path?: string): void {
    const ordinal = this.ordinal++;
    const type = media.trim().toLowerCase();
    if (!IMAGE_MIME_EXT[type] || !BASE64_BODY_RE.test(data)) return;
    const bytes = decodedLength(data);
    if (bytes <= 0 || bytes > MAX_INBOX_IMAGE_BYTES) return;
    if (ordinal === this.capture) this.captured = { media: type, data };
    this.images.push({ key: path ? `f:${path}` : `i:${digest(data)}`, via, ...(path ? { path } : {}), inline: { ordinal, media: type, bytes } });
  }

  /** A Claude image block or a Codex data-URL part; true when it was one. */
  imageBlock(block: Rec, via: AlbumVia, path?: string): boolean {
    const source = rec(block.source);
    if (str(source.data)) {
      this.inline(str(source.media_type), str(source.data), via, path);
      return true;
    }
    const url = str(block.image_url) || str(rec(block.image_url).url) || (str(block.data).startsWith("data:") ? str(block.data) : "");
    const match = url.match(DATA_URL_RE);
    if (match) {
      this.inline(match[1]!, match[2]!, via, path);
      return true;
    }
    return false;
  }
}

function claudeContent(line: Rec, collect: LineCollector, reads: PendingReads): void {
  const message = rec(line.message);
  const role = str(message.role) || str(line.type);
  const content = message.content;
  if (typeof content === "string") {
    collect.named(content);
    return;
  }
  for (const raw of arr(content)) {
    const block = rec(raw);
    const type = str(block.type);
    if (type === "text") collect.named(str(block.text));
    else if (type === "image") collect.imageBlock(block, role === "user" ? "pasted" : "read");
    else if (type === "tool_use") {
      const input = rec(block.input);
      const name = str(block.name);
      const readPath = name === "Read" ? rasterPath(str(input.file_path)) : null;
      if (readPath && str(block.id)) {
        reads.set(str(block.id), readPath);
        if (reads.size > MAX_PENDING_READS) reads.delete(reads.keys().next().value!);
      }
      if (!readPath) {
        const values: string[] = [];
        strings(input, values);
        for (const value of values) collect.named(value);
      }
    } else if (type === "tool_result") {
      const id = str(block.tool_use_id);
      const readPath = reads.get(id);
      if (readPath) reads.delete(id);
      let pictured = false;
      for (const part of arr(block.content)) {
        const item = rec(part);
        if (str(item.type) === "image") pictured = collect.imageBlock(item, "read", readPath) || pictured;
      }
      /* A Read of an image whose result carried no bytes (a newer harness
         keeps them out of the transcript) still opened that file. */
      if (readPath && !pictured && block.is_error !== true) collect.file(readPath, "read");
    }
  }
}

function codexParts(content: unknown, collect: LineCollector, via: AlbumVia): void {
  if (typeof content === "string") {
    collect.named(content);
    return;
  }
  for (const raw of arr(content)) {
    const part = rec(raw);
    const type = str(part.type);
    const text = str(part.text) || str(part.input_text) || str(part.output_text);
    if (text) collect.named(text);
    if (type === "input_image" || type === "image") {
      const referenced = rasterPath(str(rec(part.image_url).path) || str(rec(part.source).path));
      if (referenced) collect.file(referenced, via);
      else collect.imageBlock(part, via);
    } else if (type === "local_image" || type === "local-image" || type === "localImage") {
      const path = rasterPath(str(part.path) || str(part.local_path) || str(part.image_url) || str(part.url));
      if (path) collect.file(path, via);
    }
  }
}

function codexRecord(line: Rec, collect: LineCollector): void {
  const payload = rec(line.payload);
  const type = str(payload.type) || str(line.type);
  const body = Object.keys(payload).length ? payload : line;
  if (type === "message") {
    codexParts(body.content, collect, str(body.role) === "user" ? "pasted" : "read");
  } else if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") {
    const name = str(body.name);
    const args = str(body.arguments) || str(body.input);
    if (name === "view_image") {
      let parsed: Rec = {};
      try {
        parsed = rec(JSON.parse(args));
      } catch {
        /* not JSON: read it as text below */
      }
      const path = rasterPath(str(parsed.path));
      if (path) {
        collect.file(path, "read");
        return;
      }
    }
    if (args) collect.named(args);
    const values: string[] = [];
    strings(body.action, values);
    for (const value of values) collect.named(value);
  } else if (type === "function_call_output" || type === "custom_tool_call_output") {
    const output = body.output;
    for (const raw of arr(output)) {
      const part = rec(raw);
      if (str(part.type) === "input_image" || str(part.type) === "image") collect.imageBlock(part, "read");
    }
  } else if (/image_?view|view_image/i.test(type)) {
    const path = rasterPath(str(body.path));
    if (path) collect.file(path, "read");
  } else if (type === "user_message" || type === "agent_message") {
    collect.named(str(body.message));
    for (const image of arr(body.images)) {
      const url = str(image);
      const match = url.match(DATA_URL_RE);
      if (match) collect.inline(match[1]!, match[2]!, "pasted");
    }
  }
}

function walkLine(record: Rec, collect: LineCollector, reads: PendingReads): void {
  if (record.message !== undefined && (record.type === "user" || record.type === "assistant")) claudeContent(record, collect, reads);
  else if (record.payload !== undefined || typeof record.type === "string") codexRecord(record, collect);
}

/** Whether a line could carry a picture at all, before it is parsed. */
export function lineMayHoldImage(text: string): boolean {
  return LINE_HINT_RE.test(text);
}

/** The timestamp a line carries, in ms, or null. */
export function lineTimestamp(line: Rec): number | null {
  const value = str(line.timestamp) || str(rec(line.payload).timestamp);
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** The pictures of one parsed line, in the order the line holds them. */
export function extractLineImages(line: unknown, reads: PendingReads): LineImage[] {
  const collect = new LineCollector();
  walkLine(rec(line), collect, reads);
  const seen = new Set<string>();
  return collect.images.filter((image) => {
    if (seen.has(image.key)) return false;
    seen.add(image.key);
    return true;
  });
}

/** The bytes of the `ordinal`-th inline picture of a line, found by the same
    walk that indexed it. */
export function inlineImageAt(line: unknown, ordinal: number): { media: string; data: string } | null {
  const collect = new LineCollector(ordinal);
  walkLine(rec(line), collect, new Map());
  return collect.captured;
}
