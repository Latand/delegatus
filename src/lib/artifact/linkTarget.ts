/*
 * The ONE reader of the file links agents write. Every surface that turns a
 * link into an action — the hash router, the preview's `#a=` entry, markdown
 * anchors and file chips in the feed — asks this module what a link names, so
 * a shape recognized in one place is recognized everywhere.
 *
 * The shapes are the ones agents already produce (observed across transcripts,
 * see the pull request that introduced this module): an absolute viewer URL or
 * a bare hash (`#f=`, `#a=`, `#c=`, `#p=`), a percent-encoded path with its
 * in-file anchor glued on as `%23name` or written literally as `#name`,
 * `:line` / `:line:col` / `:line-end` suffixes, GitHub-style `#L12` anchors,
 * `file://` URLs and plain absolute or `~/` paths.
 *
 * Pure string work, no I/O: whether the named file may be read is decided
 * where it always was, by /api/artifact.
 */

/** A local file to open in the preview. */
export interface FileLinkTarget {
  kind: "file";
  /** Absolute or `~/` path with every suffix and anchor removed. */
  path: string;
  line: number | null;
  column: number | null;
  /** In-file anchor (a heading slug or an HTML id), without the `#`. */
  anchor: string | null;
}

/** A fragment the conversation/project router already owns (`#c=`, `#p=`,
    `#f=` naming a transcript). `hash` is exactly what that router parses. */
export interface ViewerHashTarget {
  kind: "viewer";
  hash: string;
}

export type LinkTarget = FileLinkTarget | ViewerHashTarget;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isLocalPath(value: string): boolean {
  return value.startsWith("/") || value === "~" || value.startsWith("~/");
}

/** A `#f=` payload the conversation router resolves: a transcript file (a
    `.jsonl`, or a Claude background task's `.output` under its temp root —
    both are cards the scanner lists), or an identity that is not a filesystem
    path at all (`spawn:<launch>`). */
export function isTranscriptPayload(path: string): boolean {
  return !isLocalPath(path) || /\.jsonl$/i.test(path) || /\/claude-\d+\/.+\/tasks\/[^/]+\.output$/.test(path);
}

const LINE_ANCHOR_RE = /^L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/;
const LINE_SUFFIX_RE = /:(\d+)(?::(\d+)|-\d+)?$/;

/** Whether the last segment of `path` (a `:line` suffix aside) ends in a file
    extension — the mark of a complete file name. */
function endsInExtension(path: string): boolean {
  const name = path.replace(LINE_SUFFIX_RE, "").split("/").pop() ?? "";
  return /[^.]\.[A-Za-z0-9]+$/.test(name);
}

/** Where the in-file anchor starts in `path#anchor`, or -1. A `#` right after
    a complete file name (`report.html#section.1`, `notes #2.md#setup`) opens
    the anchor whatever the anchor holds, since element ids may contain `.` and
    `/`. Failing that, the last `#` does when what follows holds no `/` or `.`
    (`Makefile#install`), so `notes #2.md` stays a name. */
function anchorStart(spelled: string): number {
  for (let at = spelled.indexOf("#"); at >= 0; at = spelled.indexOf("#", at + 1)) {
    if (endsInExtension(spelled.slice(0, at))) return at;
  }
  const last = spelled.lastIndexOf("#");
  return last >= 0 && !/[/.]/.test(spelled.slice(last + 1)) ? last : -1;
}

/**
 * Splits `path[:line[:col]][#anchor]` into its parts. `#L12` and `#L12-L20`
 * are line anchors (the GitHub spelling), every other anchor is kept verbatim.
 * See {@link anchorStart} for which `#` opens the anchor.
 */
export function parseFileSpelling(spelled: string): FileLinkTarget {
  let rest = spelled;
  let anchor: string | null = null;
  const hashAt = anchorStart(rest);
  if (hashAt >= 0) {
    anchor = rest.slice(hashAt + 1) || null;
    rest = rest.slice(0, hashAt);
  }
  let line: number | null = null;
  let column: number | null = null;
  const suffix = rest.match(LINE_SUFFIX_RE);
  if (suffix) {
    line = Number(suffix[1]);
    column = suffix[2] ? Number(suffix[2]) : null;
    rest = rest.slice(0, suffix.index);
  }
  if (anchor) {
    const lineAnchor = anchor.match(LINE_ANCHOR_RE);
    if (lineAnchor) {
      line ??= Number(lineAnchor[1]);
      column ??= lineAnchor[2] ? Number(lineAnchor[2]) : null;
      anchor = null;
    }
  }
  return { kind: "file", path: rest, line: line && line > 0 ? line : null, column: column && column > 0 ? column : null, anchor };
}

/** Resolves a viewer fragment (`#f=…`, `#a=…`, `#c=…`, `#p=…`). */
function resolveHash(hash: string): LinkTarget | null {
  const match = hash.match(/^#([acfp])=(.+)$/);
  if (!match) return null;
  const key = match[1]!;
  if (key === "c" || key === "p") return { kind: "viewer", hash };
  /* The anchor can arrive encoded inside the payload (`…index.html%23x`) or
     literally after it (`…index.html#x`); decoding the whole payload turns
     both into the same `path#anchor` spelling. */
  const spelled = decode(match[2]!);
  const target = parseFileSpelling(spelled);
  if (key === "f") {
    const question = spelled.endsWith("#question");
    const whole = question ? spelled.slice(0, -"#question".length) : spelled;
    /* A transcript opens its conversation. The hash handed on names the bare
       transcript path, whichever spelling arrived (`:12`, `%23question` or a
       literal `#question`), so the conversation lookup matches the file. */
    const transcript = isTranscriptPayload(whole) ? whole : isTranscriptPayload(target.path) ? target.path : null;
    if (transcript !== null) return transcriptTarget(transcript, question);
  }
  return isLocalPath(target.path) ? target : null;
}

function transcriptTarget(path: string, question = false): ViewerHashTarget {
  return { kind: "viewer", hash: "#f=" + encodeURIComponent(path) + (question ? "#question" : "") };
}

/**
 * What a link names, or null when it is not the viewer's to open (an ordinary
 * web link, a relative path with no base, junk).
 *
 * `viewerHosts` names the hosts (with port) the viewer itself is served on;
 * loopback hosts on any port always count, because agents write
 * `http://127.0.0.1:8898/#f=…` whichever address the operator opened.
 */
export function resolveLink(raw: string, options: { viewerHosts?: readonly string[] } = {}): LinkTarget | null {
  const value = raw.trim().replace(/\\([()])/g, "$1");
  if (!value) return null;
  if (value.startsWith("#")) return resolveHash(value);
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (!/^#[acfp]=./.test(url.hash)) return null;
    const viewer = LOOPBACK_HOSTS.has(url.hostname) || (options.viewerHosts ?? []).includes(url.host);
    return viewer ? resolveHash(url.hash) : null;
  }
  if (/^file:\/\//i.test(value)) {
    /* file:///abs/path — the authority is empty (or localhost) and the path is
       percent-encoded like any URL path. */
    const rest = value.replace(/^file:\/\/(?:localhost)?/i, "");
    const target = parseFileSpelling(decode(rest));
    if (!isLocalPath(target.path)) return null;
    return isTranscriptPayload(target.path) ? transcriptTarget(target.path) : target;
  }
  if (isLocalPath(value)) {
    const target = parseFileSpelling(value);
    if (isTranscriptPayload(target.path)) return transcriptTarget(target.path);
    return target;
  }
  return null;
}

/**
 * Joins a relative link written inside a document to that document's
 * directory: `./img/a.png`, `../b.md#x`, `c.css`, `retry.ts:180`. Returns null
 * for anything that is not relative (schemes, absolute paths, bare anchors).
 *
 * A link's path and fragment are both percent-decoded once, as a browser
 * reads an href, so `b.md#%D1%80` lands on the heading `р` and the HTML pane
 * encodes it exactly once more for the frame.
 */
export function resolveRelative(baseDir: string, href: string): string | null {
  if (!href || href.startsWith("#") || href.startsWith("/") || href.startsWith("~")) return null;
  const hashAt = href.indexOf("#");
  const pathPart = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const tail = hashAt >= 0 ? decode(href.slice(hashAt)) : "";
  /* `retry.ts:180` reads as a URL scheme to the generic pattern; a complete
     file name followed by a line suffix is a sibling file, never a scheme. */
  const named = pathPart.replace(LINE_SUFFIX_RE, "");
  const fileLine = named !== pathPart && !named.includes(":") && endsInExtension(pathPart);
  if (!fileLine && /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const home = baseDir.startsWith("~");
  const segments = baseDir.replace(/^~/, "").split("/").filter(Boolean);
  for (const segment of decode(pathPart).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return (home ? "~/" : "/") + segments.join("/") + tail;
}

/** The directory a file path lives in (`/a/b/c.md` → `/a/b`). */
export function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? (path.startsWith("~") ? "~" : "/") : path.slice(0, at);
}

/** GitHub-style heading slug: lower-case, punctuation dropped, spaces to
    dashes. Duplicates are numbered by the caller. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
