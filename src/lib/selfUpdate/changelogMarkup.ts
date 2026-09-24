/* The inline markup of one changelog item, as the Update surface shows it.
   CHANGELOG.md items are written in a small subset of Markdown: a **bold lead
   sentence**, `code`, *emphasis*, inline links, bare URLs and reference-style
   links (`[#2096]`) whose targets are defined at the bottom of the file. This
   parses that subset into nodes the surface renders as elements, so a node
   only ever becomes a React element or a text node and no HTML from the file
   is rendered. Everything else degrades to its text without its markup: raw
   HTML tags, images (their alt text), strikethrough, footnote marks and
   references with no definition. A link is kept only when it goes to http(s);
   any other target reads as its label.

   The feed's renderer (`components/feed/markdown.tsx`) is not reused: it has
   no emphasis and no reference links, it embeds images and resolves relative
   paths to local files, which a changelog must not do, and truncating an item
   outside its spans needs the spans themselves. Pure. */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

/** Visible characters of a collapsed item that has no bold lead. */
export const LEAD_CHARS = 160;

interface Reference { start: number; end: number; labelStart: number; labelEnd: number; href: string }

interface Context {
  src: string;
  definitions: ReadonlyMap<string, string>;
  /** Where each resolved reference sits in the source, for `resolveReferences`. */
  resolved: Reference[] | null;
}

const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/;
const WORD = /[\p{L}\p{N}]/u;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const AUTOLINK = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/;
const HTML_TAG = /^<(?:\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|!--[\s\S]*?-->)/;
const BARE_URL = /^https?:\/\/[^\s<>[\]`]+/;
const DEFINITION = /^ {0,3}\[([^\]^][^\]]*)\]:\s*<?([^\s>]+)>?/;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»" };

export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** `[label]: url` lines anywhere in the file; the first definition of a label wins. */
export function linkDefinitions(text: string): Map<string, string> {
  const definitions = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = DEFINITION.exec(line);
    if (!match) continue;
    const label = normalizeLabel(match[1]!);
    if (!definitions.has(label)) definitions.set(label, match[2]!);
  }
  return definitions;
}

export function isSafeHref(href: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(href);
}

function runLength(src: string, at: number, to: number, char: string): number {
  let end = at;
  while (end < to && src[end] === char) end++;
  return end - at;
}

/** The start of the backtick run of exactly `run` that closes a code span. */
function codeClose(src: string, from: number, to: number, run: number): number {
  let at = from;
  while (at < to) {
    if (src[at] !== "`") { at++; continue; }
    const length = runLength(src, at, to, "`");
    if (length === run) return at;
    at += length;
  }
  return -1;
}

/** Past a code span opening at `at`, or -1 when its run never closes. */
function skipCode(src: string, at: number, to: number): number {
  const run = runLength(src, at, to, "`");
  const close = codeClose(src, at + run, to, run);
  return close < 0 ? -1 : close + run;
}

/** The `]` that closes the bracket at `open`, over nested brackets, escapes and code spans. */
function closingBracket(src: string, open: number, to: number): number {
  let depth = 0;
  for (let at = open; at < to; at++) {
    const char = src[at];
    if (char === "\\") { at++; continue; }
    if (char === "`") {
      const past = skipCode(src, at, to);
      if (past > 0) at = past - 1;
      continue;
    }
    if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return at;
  }
  return -1;
}

/** `(destination "title")` after a link label. */
function destination(src: string, paren: number, to: number): { href: string; end: number } | null {
  let at = paren + 1;
  while (at < to && src[at] === " ") at++;
  let href = "";
  if (src[at] === "<") {
    const close = src.indexOf(">", at);
    if (close < 0 || close >= to) return null;
    href = src.slice(at + 1, close);
    at = close + 1;
  } else {
    let depth = 0;
    while (at < to) {
      const char = src[at]!;
      if (char === "\\" && at + 1 < to && ESCAPABLE.test(src[at + 1]!)) { href += src[at + 1]; at += 2; continue; }
      if (WHITESPACE.test(char)) break;
      if (char === "(") depth++;
      else if (char === ")" && depth-- === 0) break;
      href += char;
      at++;
    }
  }
  while (at < to && src[at] === " ") at++;
  const quote = src[at];
  if (quote === "\"" || quote === "'" || quote === "(") {
    const close = src.indexOf(quote === "(" ? ")" : quote, at + 1);
    if (close < 0 || close >= to) return null;
    at = close + 1;
    while (at < to && src[at] === " ") at++;
  }
  return src[at] === ")" ? { href, end: at + 1 } : null;
}

interface LinkSpan { labelStart: number; labelEnd: number; end: number; href: string | null; reference: boolean }

/** An inline link, or a full, collapsed or shortcut reference, opening at `open`. */
function linkAt(context: Context, open: number, to: number): LinkSpan | null {
  const { src } = context;
  const close = closingBracket(src, open, to);
  if (close < 0) return null;
  const labelStart = open + 1;
  if (src[close + 1] === "(") {
    const target = destination(src, close + 1, to);
    if (target) return { labelStart, labelEnd: close, end: target.end, href: target.href, reference: false };
  }
  if (close === labelStart) return null;
  let key = src.slice(labelStart, close);
  let end = close + 1;
  if (src[end] === "[") {
    const refClose = src.indexOf("]", end + 1);
    const ref = refClose > 0 && refClose < to ? src.slice(end + 1, refClose) : null;
    if (ref !== null && !ref.includes("[")) {
      if (ref.trim()) key = ref;
      end = refClose + 1;
    }
  }
  return { labelStart, labelEnd: close, end, href: context.definitions.get(normalizeLabel(key)) ?? null, reference: true };
}

const leftFlanking = (before: string, after: string) =>
  !WHITESPACE.test(after) && (!PUNCTUATION.test(after) || WHITESPACE.test(before) || PUNCTUATION.test(before));
const rightFlanking = (before: string, after: string) =>
  !WHITESPACE.test(before) && (!PUNCTUATION.test(before) || WHITESPACE.test(after) || PUNCTUATION.test(after));

/** The run of exactly `length` marks that closes emphasis opened before `from`.
    Code spans, links and tags between are skipped whole, so a mark inside
    them never closes; a run of another length is nested emphasis. */
function emphasisClose(context: Context, mark: string, length: number, from: number, to: number): number {
  const { src } = context;
  let at = from;
  while (at < to) {
    const char = src[at]!;
    if (char === "\\") { at += 2; continue; }
    if (char === "`") { const past = skipCode(src, at, to); at = past > 0 ? past : at + runLength(src, at, to, "`"); continue; }
    if (char === "[") { const link = linkAt(context, at, to); at = link ? link.end : at + 1; continue; }
    if (char === "<") { const tag = HTML_TAG.exec(src.slice(at, to)) ?? AUTOLINK.exec(src.slice(at, to)); at += tag ? tag[0].length : 1; continue; }
    if (char !== mark) { at++; continue; }
    const run = runLength(src, at, to, mark);
    const before = src[at - 1]!;
    const after = at + run < to ? src[at + run]! : " ";
    if (run === length && at > from && rightFlanking(before, after) && (mark === "*" || !WORD.test(after))) return at;
    at += run;
  }
  return -1;
}

/** A link's label with any link inside it read as text: links do not nest. */
function unlinked(nodes: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    const add = node.kind === "link" ? unlinked(node.children)
      : node.kind === "strong" || node.kind === "em" ? [{ ...node, children: unlinked(node.children) }]
      : [node];
    for (const item of add) {
      const last = out.at(-1);
      if (item.kind === "text" && last?.kind === "text") out[out.length - 1] = { kind: "text", text: last.text + item.text };
      else out.push(item);
    }
  }
  return out;
}

function decodeEntity(entity: string): string | null {
  const numeric = /^#(?:x([0-9a-f]{1,6})|([0-9]{1,7}))$/i.exec(entity);
  if (numeric) {
    const code = numeric[1] ? parseInt(numeric[1], 16) : Number(numeric[2]);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null;
  }
  return ENTITIES[entity] ?? null;
}

function parseRange(context: Context, from: number, to: number): Inline[] {
  const { src } = context;
  const nodes: Inline[] = [];
  let text = "";
  const append = (node: Inline) => {
    const last = nodes.at(-1);
    if (node.kind === "text" && last?.kind === "text") last.text += node.text;
    else nodes.push(node);
  };
  const push = (...add: Inline[]) => {
    if (text) append({ kind: "text", text });
    text = "";
    for (const node of add) append(node);
  };

  let at = from;
  while (at < to) {
    const char = src[at]!;
    const rest = () => src.slice(at, to);

    if (char === "\\" && at + 1 < to && ESCAPABLE.test(src[at + 1]!)) { text += src[at + 1]; at += 2; continue; }

    if (char === "`") {
      const run = runLength(src, at, to, "`");
      const close = codeClose(src, at + run, to, run);
      if (close < 0) { text += src.slice(at, at + run); at += run; continue; }
      let code = src.slice(at + run, close);
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      push({ kind: "code", text: code });
      at = close + run;
      continue;
    }

    if (char === "!" && src[at + 1] === "[") {
      const image = linkAt(context, at + 1, to);
      if (image) { push({ kind: "text", text: plainText(parseRange(context, image.labelStart, image.labelEnd)) }); at = image.end; continue; }
    }

    if (char === "[") {
      if (src[at + 1] === "^") {
        const close = src.indexOf("]", at);
        if (close > 0 && close < to) { at = close + 1; continue; }
      }
      const link = linkAt(context, at, to);
      if (link) {
        const children = parseRange(context, link.labelStart, link.labelEnd);
        if (link.href && isSafeHref(link.href)) push({ kind: "link", href: link.href, children: unlinked(children) });
        else push(...children);
        if (link.reference && link.href && context.resolved) {
          context.resolved.push({ start: at, end: link.end, labelStart: link.labelStart, labelEnd: link.labelEnd, href: link.href });
        }
        at = link.end;
        continue;
      }
    }

    if (char === "<") {
      const autolink = AUTOLINK.exec(rest());
      if (autolink) {
        const href = autolink[1]!;
        push(isSafeHref(href) ? { kind: "link", href, children: [{ kind: "text", text: href }] } : { kind: "text", text: href });
        at += autolink[0].length;
        continue;
      }
      const tag = HTML_TAG.exec(rest());
      if (tag) { at += tag[0].length; continue; }
    }

    if (char === "h" && (at === from || !WORD.test(src[at - 1]!))) {
      const bare = BARE_URL.exec(rest());
      if (bare) {
        let href = bare[0].replace(/[.,;:!?'"»*_~]+$/, "");
        while (href.endsWith(")") && (href.match(/\)/g)?.length ?? 0) > (href.match(/\(/g)?.length ?? 0)) href = href.slice(0, -1);
        push({ kind: "link", href, children: [{ kind: "text", text: href }] });
        at += href.length;
        continue;
      }
    }

    if (char === "&") {
      const entity = /^&(#?[A-Za-z0-9]{1,8});/.exec(rest());
      const decoded = entity ? decodeEntity(entity[1]!) : null;
      if (entity && decoded !== null) { text += decoded; at += entity[0].length; continue; }
    }

    if (char === "~" && src[at + 1] === "~") {
      const close = src.indexOf("~~", at + 2);
      if (close > at + 2 && close < to) { push(...parseRange(context, at + 2, close)); at = close + 2; continue; }
    }

    if (char === "*" || char === "_") {
      const run = runLength(src, at, to, char);
      const before = at === from ? " " : src[at - 1]!;
      const after = at + run < to ? src[at + run]! : " ";
      if (run <= 3 && leftFlanking(before, after) && (char === "*" || !WORD.test(before))) {
        const close = emphasisClose(context, char, run, at + run, to);
        if (close > 0) {
          const inner = parseRange(context, at + run, close);
          push(run === 1 ? { kind: "em", children: inner }
            : run === 2 ? { kind: "strong", children: inner }
            : { kind: "strong", children: [{ kind: "em", children: inner }] });
          at = close + run;
          continue;
        }
      }
      text += src.slice(at, at + run);
      at += run;
      continue;
    }

    text += char;
    at++;
  }
  push();
  return nodes;
}

/** One changelog item's inline markup as nodes. A reference with no
    definition here reads as its label (see `resolveReferences`). */
export function parseInline(text: string): Inline[] {
  return parseRange({ src: text, definitions: new Map(), resolved: null }, 0, text.length);
}

/** Rewrites each reference-style link that `definitions` resolves as an
    inline link, leaving everything else byte for byte, so an item carries its
    own targets once it leaves the file that defines them. */
export function resolveReferences(text: string, definitions: ReadonlyMap<string, string>): string {
  const resolved: Reference[] = [];
  parseRange({ src: text, definitions, resolved }, 0, text.length);
  /* A reference inside another one's label goes with its outer link. */
  const outer: Reference[] = [];
  for (const ref of resolved.sort((a, b) => a.start - b.start)) if (ref.start >= (outer.at(-1)?.end ?? 0)) outer.push(ref);
  let out = text;
  for (const ref of outer.reverse()) {
    const href = ref.href.replace(/[()\\]/g, "\\$&").replace(/\s/g, "%20");
    out = `${out.slice(0, ref.start)}[${text.slice(ref.labelStart, ref.labelEnd)}](${href})${out.slice(ref.end)}`;
  }
  return out;
}

export function plainText(nodes: readonly Inline[]): string {
  return nodes.map((node) => node.kind === "text" || node.kind === "code" ? node.text : plainText(node.children)).join("");
}

export interface ItemParts {
  /** What a collapsed item shows. */
  lead: Inline[];
  /** The rest of the item, behind its expand; `lead` then `rest` is the whole item. */
  rest: Inline[];
  /** The lead stops mid-sentence, so a collapsed item ends in an ellipsis. */
  cut: boolean;
}

/** Splits a top-level text node at `offset`; spans are never split. */
function splitAt(nodes: readonly Inline[], index: number, offset: number): { lead: Inline[]; rest: Inline[] } {
  const node = nodes[index] as Extract<Inline, { kind: "text" }>;
  const head = node.text.slice(0, offset);
  const tail = node.text.slice(offset);
  return {
    lead: [...nodes.slice(0, index), ...(head ? [{ kind: "text" as const, text: head }] : [])],
    rest: [...(tail ? [{ kind: "text" as const, text: tail }] : []), ...nodes.slice(index + 1)],
  };
}

const SENTENCE_START = /[\p{Lu}("«“]/u;

/** What a collapsed item shows. An item that fits shows whole. A bold lead
    shows in full, however long. Otherwise the first sentence when it fits,
    else the text up to the last word boundary that fits. Every boundary is
    in top-level text, so a code span, a link or emphasis is never cut. */
export function splitItem(nodes: readonly Inline[], limit = LEAD_CHARS): ItemParts {
  const whole = { lead: [...nodes], rest: [], cut: false };
  if (plainText(nodes).length <= limit) return whole;
  if (nodes[0]?.kind === "strong") return plainText(nodes.slice(1)).trim() ? { lead: [nodes[0]], rest: nodes.slice(1), cut: false } : whole;

  let seen = 0;
  let word: { index: number; offset: number } | null = null;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (node.kind !== "text") {
      seen += plainText([node]).length;
      continue;
    }
    for (let offset = 0; offset < node.text.length; offset++) {
      if (seen + offset > limit && word) break;
      const char = node.text[offset]!;
      if (/[.!?]/.test(char) && WHITESPACE.test(node.text[offset + 1] ?? "")) {
        const following = node.text.slice(offset + 1).trimStart();
        const next = following ? following[0]! : nodes[index + 1];
        const starts = typeof next === "string" ? SENTENCE_START.test(next) : next !== undefined && next.kind !== "text";
        if (starts && seen + offset + 1 <= limit) {
          const parts = splitAt(nodes, index, offset + 1);
          return { ...parts, cut: false };
        }
      }
      if (WHITESPACE.test(char) && (seen + offset <= limit || !word)) {
        /* The cut drops a trailing clause mark with the space before it. */
        const head = node.text.slice(0, offset).replace(/[\s,;:—–-]+$/, "");
        if (head.length > 0 || index > 0) word = { index, offset: head.length };
      }
    }
    seen += node.text.length;
    if (seen > limit && word) break;
  }
  if (!word) return whole;
  const parts = splitAt(nodes, word.index, word.offset);
  if (parts.rest.length === 0 || !plainText(parts.rest).trim()) return whole;
  return { ...parts, cut: true };
}
