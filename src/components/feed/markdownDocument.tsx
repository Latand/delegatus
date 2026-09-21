"use client";

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";

import { headingSlug } from "@/lib/artifact/linkTarget";

import { CodeBlock, md, MdDocumentContext, MdImageRow, MdTable, type MdDocumentScope } from "./markdown";

/*
 * A whole markdown FILE, rendered by the feed's grammar: the same inline pass,
 * code blocks, tables and image rows a chat message uses, assembled into
 * document blocks — headings with scroll targets, paragraphs, nested lists,
 * block quotes and rules — instead of the pre-wrapped lines of a message.
 */

type Block =
  | { kind: "heading"; level: number; text: string; slug: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: { depth: number; ordered: boolean; marker: string; text: string; task: boolean | null }[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; code: string; lang: string | null }
  | { kind: "table"; rows: string[] }
  | { kind: "images"; images: { alt: string; src: string }[] }
  | { kind: "rule" };

const FENCE_OPEN_RE = /^\s*(```+|~~~+)\s*([A-Za-z0-9+#_-]+)?/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE_RE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const IMAGE_LINE_RE = /^\s*!\[([^\]]*)\]\(((?:\\.|[^)\s\\])+)\)\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;

function startsBlock(line: string): boolean {
  return (
    FENCE_OPEN_RE.test(line) ||
    HEADING_RE.test(line) ||
    RULE_RE.test(line) ||
    LIST_RE.test(line) ||
    TABLE_ROW_RE.test(line) ||
    IMAGE_LINE_RE.test(line) ||
    QUOTE_RE.test(line)
  );
}

/** Splits a markdown file into document blocks. Exported for tests. */
export function parseMarkdownDocument(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const slugs = new Map<string, number>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(FENCE_OPEN_RE);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1]![0] === "`" ? "`" : "~"}{${fence[1]!.length},}\\s*$`);
      const code: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      blocks.push({ kind: "code", code: code.join("\n"), lang: fence[2] ?? null });
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      const text = heading[2]!;
      const base = headingSlug(text.replace(/[`*_]/g, "")) || "section";
      const seen = slugs.get(base) ?? 0;
      slugs.set(base, seen + 1);
      blocks.push({ kind: "heading", level: heading[1]!.length, text, slug: seen ? `${base}-${seen}` : base });
      i++;
      continue;
    }
    if (RULE_RE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (TABLE_ROW_RE.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i]!)) rows.push(lines[i++]!);
      blocks.push({ kind: "table", rows });
      continue;
    }
    if (IMAGE_LINE_RE.test(line)) {
      const images: { alt: string; src: string }[] = [];
      let m: RegExpMatchArray | null;
      while (i < lines.length && (m = lines[i]!.match(IMAGE_LINE_RE))) {
        images.push({ alt: m[1]!, src: m[2]! });
        i++;
      }
      blocks.push({ kind: "images", images });
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const quoted: string[] = [];
      let m: RegExpMatchArray | null;
      while (i < lines.length && (m = lines[i]!.match(QUOTE_RE))) {
        quoted.push(m[1]!);
        i++;
      }
      blocks.push({ kind: "quote", text: quoted.join("\n") });
      continue;
    }
    if (LIST_RE.test(line)) {
      const items: Extract<Block, { kind: "list" }>["items"] = [];
      const indents: number[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const item = current.match(LIST_RE);
        if (item) {
          const indent = item[1]!.replace(/\t/g, "    ").length;
          while (indents.length && indents[indents.length - 1]! > indent) indents.pop();
          if (!indents.length || indents[indents.length - 1]! < indent) indents.push(indent);
          const task = item[3]!.match(/^\[([ xX])\]\s+(.*)$/);
          items.push({
            depth: indents.length - 1,
            ordered: /\d/.test(item[2]!),
            marker: item[2]!,
            text: task ? task[2]! : item[3]!,
            task: task ? task[1] !== " " : null,
          });
          i++;
          continue;
        }
        /* A continuation line (indented, not a new block) joins its item; a
           blank line followed by more items keeps the list going. */
        if (current.trim() && /^\s+/.test(current) && !startsBlock(current.trimStart())) {
          items[items.length - 1]!.text += " " + current.trim();
          i++;
          continue;
        }
        if (!current.trim() && i + 1 < lines.length && LIST_RE.test(lines[i + 1]!)) {
          i++;
          continue;
        }
        break;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() && (paragraph.length === 0 || !startsBlock(lines[i]!))) {
      paragraph.push(lines[i++]!.trim());
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

const HEADING_CLASS: Record<number, string> = {
  1: "mt-2 mb-3 border-b border-border pb-1.5 text-[21px] font-bold leading-tight",
  2: "mt-6 mb-2.5 border-b border-border pb-1 text-[17px] font-bold leading-snug",
  3: "mt-5 mb-2 text-[15px] font-bold",
  4: "mt-4 mb-1.5 text-[13.5px] font-bold",
  5: "mt-3 mb-1 text-[13px] font-semibold",
  6: "mt-3 mb-1 text-[12.5px] font-semibold text-muted",
};

function Heading({ level, slug, children }: { level: number; slug: string; children: ReactNode }) {
  const props = { "data-md-anchor": slug, className: `scroll-mt-3 text-primary ${HEADING_CLASS[level]}` };
  if (level === 1) return <h1 {...props}>{children}</h1>;
  if (level === 2) return <h2 {...props}>{children}</h2>;
  if (level === 3) return <h3 {...props}>{children}</h3>;
  if (level === 4) return <h4 {...props}>{children}</h4>;
  if (level === 5) return <h5 {...props}>{children}</h5>;
  return <h6 {...props}>{children}</h6>;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "heading":
      return (
        <Heading key={key} level={block.level} slug={block.slug}>
          {md(block.text)}
        </Heading>
      );
    case "paragraph":
      return (
        <p key={key} className="my-2.5">
          {md(block.text)}
        </p>
      );
    case "quote":
      return (
        <blockquote key={key} className="my-2.5 border-l-[3px] border-border pl-3 text-muted">
          {block.text.split(/\n\s*\n/).map((part, index) => (
            <p key={index} className="my-1">
              {md(part.replace(/\n/g, " "))}
            </p>
          ))}
        </blockquote>
      );
    case "code":
      return <CodeBlock key={key} code={block.code} lang={block.lang} />;
    case "table":
      return <MdTable key={key} rows={block.rows} />;
    case "images":
      return <MdImageRow key={key} images={block.images} />;
    case "rule":
      return <hr key={key} className="my-4 border-border" />;
    case "list":
      return (
        <ul key={key} className="my-2.5 list-none p-0" data-md-list>
          {block.items.map((item, index) => (
            <li
              key={index}
              className="relative my-1 pl-5"
              style={{ marginLeft: `${item.depth * 1.25}rem` }}
            >
              <span aria-hidden className="absolute left-0 top-0 w-4 text-right tabular-nums text-muted">
                {item.task !== null ? (item.task ? "☑" : "☐") : item.ordered ? item.marker : item.depth % 2 ? "◦" : "•"}
              </span>
              {md(item.text)}
            </li>
          ))}
        </ul>
      );
  }
}

/** Finds the heading an anchor names: the exact slug, else a case-insensitive
    or slugified match (agents write `#Decision Graph` as often as the slug). */
function findAnchor(container: HTMLElement, anchor: string): HTMLElement | null {
  const wanted = [anchor, anchor.toLowerCase(), headingSlug(anchor)];
  for (const node of Array.from(container.querySelectorAll<HTMLElement>("[data-md-anchor]"))) {
    if (wanted.includes(node.getAttribute("data-md-anchor") ?? "")) return node;
  }
  return null;
}

export function MarkdownDocument({ text, baseDir, anchor }: { text: string; baseDir: string; anchor: string | null }) {
  const ref = useRef<HTMLElement | null>(null);
  const blocks = useMemo(() => parseMarkdownDocument(text), [text]);
  const scrollToAnchor = useCallback((target: string) => {
    const node = ref.current ? findAnchor(ref.current, target) : null;
    node?.scrollIntoView({ block: "start" });
  }, []);
  const scope = useMemo<MdDocumentScope>(() => ({ baseDir, scrollToAnchor }), [baseDir, scrollToAnchor]);
  useEffect(() => {
    if (anchor) scrollToAnchor(anchor);
  }, [anchor, blocks, scrollToAnchor]);
  return (
    <MdDocumentContext.Provider value={scope}>
      <article ref={ref} data-md-document className="min-w-0 break-words text-[13px] leading-[1.6] text-primary">
        {blocks.map(renderBlock)}
      </article>
    </MdDocumentContext.Provider>
  );
}
