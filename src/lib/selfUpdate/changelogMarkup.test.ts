import { describe, expect, test } from "bun:test";
import fs from "node:fs";

import { changelogDelta } from "./changelog";
import { LEAD_CHARS, linkDefinitions, parseInline, plainText, resolveReferences, splitItem, type Inline } from "./changelogMarkup";

const text = (value: string): Inline => ({ kind: "text", text: value });
const pr = (number: number) => `https://github.com/example/delegatus/pull/${number}`;
const RELEASE = fs.readFileSync(new URL("./__fixtures__/changelog-1.4.0.md", import.meta.url), "utf8");
const BEFORE = RELEASE.replace(/## \[1\.4\.0\][\s\S]*?(?=## \[1\.3\.0\])/, "");

/** Every text node of a tree, where a markup character left over would show. */
function texts(nodes: readonly Inline[]): string[] {
  return nodes.flatMap((node) => node.kind === "text" ? [node.text] : node.kind === "code" ? [] : texts(node.children));
}

describe("parseInline", () => {
  test("bold, italic, code and inline links become nodes, with no markup left in the text", () => {
    expect(parseInline("**Task icons.** Pick one with `I` or *any* _other_ way, see [lucide](https://lucide.dev).")).toEqual([
      { kind: "strong", children: [text("Task icons.")] },
      text(" Pick one with "),
      { kind: "code", text: "I" },
      text(" or "),
      { kind: "em", children: [text("any")] },
      text(" "),
      { kind: "em", children: [text("other")] },
      text(" way, see "),
      { kind: "link", href: "https://lucide.dev", children: [text("lucide")] },
      text("."),
    ]);
  });

  test("markup nests: code and a link inside bold, bold inside emphasis", () => {
    expect(parseInline("**`request_attention` reaches [a phone](https://x.dev/p)** and *a **b** c*")).toEqual([
      { kind: "strong", children: [{ kind: "code", text: "request_attention" }, text(" reaches "), { kind: "link", href: "https://x.dev/p", children: [text("a phone")] }] },
      text(" and "),
      { kind: "em", children: [text("a "), { kind: "strong", children: [text("b")] }, text(" c")] },
    ]);
  });

  test("a mark inside a code span or a link target is not markup", () => {
    expect(parseInline("`**not bold**` [x](https://x.dev/a_b_c) end")).toEqual([
      { kind: "code", text: "**not bold**" },
      text(" "),
      { kind: "link", href: "https://x.dev/a_b_c", children: [text("x")] },
      text(" end"),
    ]);
  });

  test("underscores inside a word, a spaced asterisk and escapes stay text", () => {
    expect(parseInline("request_attention and 5 * 3 and \\*literal\\*")).toEqual([text("request_attention and 5 * 3 and *literal*")]);
  });

  test("unknown markup degrades to its text without its marks", () => {
    expect(parseInline("~~gone~~ <b>bold</b> ![shot](a.png) note[^1] [#9999] &amp; &#8594;<br/>")).toEqual([text("gone bold shot note #9999 & →")]);
  });

  test("raw HTML never becomes a node: tags drop and what they wrapped is text", () => {
    const nodes = parseInline("<img src=x onerror=\"alert(1)\"><script>alert(2)</script> <a href=\"javascript:x\">ok</a>");
    expect(nodes).toEqual([text("alert(2) ok")]);
  });

  test("only http(s) targets are links; any other reads as its label", () => {
    expect(parseInline("[run](javascript:alert(1)) [doc](docs/design/self-update.md) <https://x.dev/a> <mailto:a@b>")).toEqual([
      text("run doc "),
      { kind: "link", href: "https://x.dev/a", children: [text("https://x.dev/a")] },
      text(" mailto:a@b"),
    ]);
  });

  test("a bare URL is a link without the sentence's punctuation", () => {
    expect(parseInline("See https://x.dev/a(b). Or (https://x.dev/c).")).toEqual([
      text("See "),
      { kind: "link", href: "https://x.dev/a(b)", children: [text("https://x.dev/a(b)")] },
      text(". Or ("),
      { kind: "link", href: "https://x.dev/c", children: [text("https://x.dev/c")] },
      text(")."),
    ]);
  });

  test("links do not nest: a URL inside a link's label is its text", () => {
    expect(parseInline("[see https://x.dev/a now](https://x.dev/b) and [**<https://x.dev/c>**](https://x.dev/d)")).toEqual([
      { kind: "link", href: "https://x.dev/b", children: [text("see https://x.dev/a now")] },
      text(" and "),
      { kind: "link", href: "https://x.dev/d", children: [{ kind: "strong", children: [text("https://x.dev/c")] }] },
    ]);
  });

  test("a bold lead with nothing after it shows whole", () => {
    const nodes = parseInline(`**${"word ".repeat(50).trim()}** `);
    expect(splitItem(nodes)).toEqual({ lead: nodes, rest: [], cut: false });
  });

  test("an unmatched mark is a character, not markup", () => {
    expect(parseInline("a ** b and [open and `tick")).toEqual([text("a ** b and [open and `tick")]);
  });
});

describe("reference-style links", () => {
  const definitions = linkDefinitions(`[#2096]: ${pr(2096)}\n[#2083]: ${pr(2083)}\n[Docs]: <https://x.dev/docs>\n[#2096]: https://x.dev/second\n[^1]: a footnote`);

  test("definitions are read from the file; the first one of a label wins and footnotes are not links", () => {
    expect([...definitions]).toEqual([["#2096", pr(2096)], ["#2083", pr(2083)], ["docs", "https://x.dev/docs"]]);
  });

  test("shortcut, full and collapsed references are rewritten as inline links", () => {
    expect(resolveReferences("Done opens twenty cards at a time ([#2096], [#2083]).", definitions))
      .toBe(`Done opens twenty cards at a time ([#2096](${pr(2096)}), [#2083](${pr(2083)})).`);
    expect(resolveReferences("[the board][#2096], [docs][] and [DOCS]", definitions))
      .toBe(`[the board](${pr(2096)}), [docs](https://x.dev/docs) and [DOCS](https://x.dev/docs)`);
  });

  test("a reference inside a code span or with no definition is left as written", () => {
    const source = "`[#2096]` and [#1] and [x](https://x.dev/y)";
    expect(resolveReferences(source, definitions)).toBe(source);
    expect(parseInline(source)).toEqual([
      { kind: "code", text: "[#2096]" },
      text(" and #1 and "),
      { kind: "link", href: "https://x.dev/y", children: [text("x")] },
    ]);
  });

  test("the real 1.4.0 section: every item's references resolve and nothing reads as markup", () => {
    const { entries } = changelogDelta(BEFORE, RELEASE);
    /* 15 Added, 5 Changed, 10 Fixed and 2 Removed. */
    expect(entries).toHaveLength(32);
    for (const entry of entries) {
      const nodes = parseInline(entry.text);
      for (const value of texts(nodes)) expect(value).not.toMatch(/\*\*|\[#?\w|\]\(|`/);
    }
    const board = parseInline(entries[0]!.text);
    expect(board[0]).toEqual({ kind: "strong", children: [text("The phone board is the desktop's kanban.")] });
    const links = board.filter((node) => node.kind === "link");
    expect(links).toEqual([
      { kind: "link", href: pr(2096), children: [text("#2096")] },
      { kind: "link", href: pr(2083), children: [text("#2083")] },
    ]);
  });
});

describe("splitItem", () => {
  test("an item that fits shows whole", () => {
    const nodes = parseInline("`/favicon.ico` serves the Delegatus emblem ([#2073](https://x.dev/2073)).");
    expect(splitItem(nodes)).toEqual({ lead: nodes, rest: [], cut: false });
  });

  test("a bold lead shows in full, however long, and the rest waits behind the expand", () => {
    const lead = `**${"A lead that runs long ".repeat(10).trim()}.**`;
    const nodes = parseInline(`${lead} The rest of the entry ([#1](https://x.dev/1)).`);
    const parts = splitItem(nodes);
    expect(parts.lead).toEqual([nodes[0]!]);
    expect(plainText(parts.lead).length).toBeGreaterThan(LEAD_CHARS);
    expect(plainText(parts.rest)).toBe(" The rest of the entry (#1).");
    expect(parts.cut).toBe(false);
  });

  test("without a bold lead, the first sentence when it fits", () => {
    const nodes = parseInline(`A Deployer whose brief quotes your go runs those steps. ${"Without that approval it still plans, validates and stops. ".repeat(3)}`.trim());
    const parts = splitItem(nodes);
    expect(plainText(parts.lead)).toBe("A Deployer whose brief quotes your go runs those steps.");
    expect(parts.cut).toBe(false);
    expect(plainText(parts.lead) + plainText(parts.rest)).toBe(plainText(nodes));
  });

  test("a long first sentence ends on a word boundary outside every span", () => {
    const nodes = parseInline([
      "Attention requests, reply suggestions and per-project seat tick settings are",
      "stored in SQLite (`state.sqlite`, collections `attention`,",
      "`reply_suggestions` and `seat_tick_settings`) instead of `attention.json`,",
      "`reply-suggestions.json` and [the seat tick file](https://x.dev/seat-tick-settings.json). A write commits only",
      "the rows it changed (#1905).",
    ].join(" "));
    const parts = splitItem(nodes);
    expect(parts.cut).toBe(true);
    expect(plainText(parts.lead)).toBe("Attention requests, reply suggestions and per-project seat tick settings are stored in SQLite (state.sqlite, collections attention, reply_suggestions and");
    expect(plainText(parts.lead) + plainText(parts.rest)).toBe(plainText(nodes));
  });

  test("at every limit, a cut lands between spans or on a space in text, and each span in the lead is whole", () => {
    const nodes = parseInline([
      "Plain words first, then `a code span`, then [a link with words](https://x.dev/a), then **bold words**,",
      "then *emphasis in words*, then `another span` and a long tail of plain words that goes on past the limit",
      "without any sentence end so the cut must fall on a word boundary somewhere between these spans.",
    ].join(" "));
    const spans = new Set(nodes.filter((node) => node.kind !== "text"));
    for (let limit = 1; limit <= plainText(nodes).length + 5; limit++) {
      const parts = splitItem(nodes, limit);
      expect(plainText(parts.lead) + plainText(parts.rest)).toBe(plainText(nodes));
      for (const node of [...parts.lead, ...parts.rest]) if (node.kind !== "text") expect(spans.has(node)).toBe(true);
      if (!parts.cut) continue;
      /* The lead never ends mid-word or mid-span: what follows is text that
         starts with a space or a clause mark. */
      expect(parts.rest[0]!.kind).toBe("text");
      expect(plainText(parts.rest.slice(0, 1))).toMatch(/^[\s,;:—–-]/);
    }
  });
});
