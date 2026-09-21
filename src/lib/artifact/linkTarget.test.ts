import { describe, expect, test } from "bun:test";

import { parseConversationHash } from "@/lib/accounts/identity";

import { parseArtifactFragment } from "./fragment";
import { directoryOf, headingSlug, resolveLink, resolveRelative } from "./linkTarget";

const REPORT = "/workspace/checkout/reports/round-2/index.html";
const enc = encodeURIComponent;

function file(path: string, extra: { line?: number; column?: number; anchor?: string } = {}) {
  return { kind: "file", path, line: extra.line ?? null, column: extra.column ?? null, anchor: extra.anchor ?? null };
}

/* One row per link shape observed in agent transcripts (counts in the PR). */
const SHAPES: [string, string, ReturnType<typeof file> | { kind: "viewer"; hash: string } | null][] = [
  /* The owner's link: absolute viewer URL, encoded path, anchor glued on as %23. */
  ["viewer url, #f= file, encoded %23 anchor", `http://127.0.0.1:8898/#f=${enc(REPORT + "#decision-graph")}`, file(REPORT, { anchor: "decision-graph" })],
  ["viewer url, #f= file, literal # anchor", `http://127.0.0.1:8898/#f=${enc(REPORT)}#decision-graph`, file(REPORT, { anchor: "decision-graph" })],
  ["viewer url on another loopback port", `http://localhost:8899/#f=${enc(REPORT)}`, file(REPORT)],
  ["viewer url, #a= preview fragment", `http://127.0.0.1:8898/#a=${enc("/workspace/slides.pdf")}`, file("/workspace/slides.pdf")],
  ["bare #f= file hash", `#f=${enc("/workspace/notes/plan.md")}`, file("/workspace/notes/plan.md")],
  ["bare #f= file hash, literal anchor", `#f=${enc("/workspace/notes/plan.md")}#next-steps`, file("/workspace/notes/plan.md", { anchor: "next-steps" })],
  ["bare #f= unencoded path", "#f=/workspace/notes/plan.md", file("/workspace/notes/plan.md")],
  ["bare #a= with :line", `#a=${enc("~/checkout/src/main.ts:12")}`, file("~/checkout/src/main.ts", { line: 12 })],
  ["file:// url", "file:///workspace/figures/chart.png", file("/workspace/figures/chart.png")],
  ["file:// url, encoded space, :line:col", "file:///workspace/a%20b/main.ts:40:7", file("/workspace/a b/main.ts", { line: 40, column: 7 })],
  ["file:// url with anchor", "file:///workspace/reports/r/index.html#summary", file("/workspace/reports/r/index.html", { anchor: "summary" })],
  ["plain path with :line", "/workspace/src/lib/x.ts:57", file("/workspace/src/lib/x.ts", { line: 57 })],
  ["plain path with :line:col", "/workspace/src/lib/x.ts:57:3", file("/workspace/src/lib/x.ts", { line: 57, column: 3 })],
  ["plain path with :line-end range", "/workspace/src/lib/x.ts:57-80", file("/workspace/src/lib/x.ts", { line: 57 })],
  ["plain path with #L anchor", "/workspace/src/lib/x.ts#L12-L20", file("/workspace/src/lib/x.ts", { line: 12 })],
  ["plain markdown path with heading anchor", "/workspace/docs/spec.md#acceptance", file("/workspace/docs/spec.md", { anchor: "acceptance" })],
  ["~/ path", "~/checkout/docs/spec.md", file("~/checkout/docs/spec.md")],
  ["escaped parens (markdown target)", "/workspace/Home_\\(draft\\).md", file("/workspace/Home_(draft).md")],
  /* Transcripts stay with the conversation router, exactly as spelled. */
  ["#f= transcript", `#f=${enc("/home/u/.claude/projects/p/s.jsonl")}`, { kind: "viewer", hash: `#f=${enc("/home/u/.claude/projects/p/s.jsonl")}` }],
  ["#f= transcript with #question", `#f=${enc("/p/s.jsonl")}#question`, { kind: "viewer", hash: `#f=${enc("/p/s.jsonl")}#question` }],
  ["viewer url, #f= transcript", `http://127.0.0.1:8898/#f=${enc("/p/s.jsonl")}`, { kind: "viewer", hash: `#f=${enc("/p/s.jsonl")}` }],
  ["#f= launch placeholder", "#f=spawn%3Alaunch-1", { kind: "viewer", hash: "#f=spawn%3Alaunch-1" }],
  ["plain transcript path with :line", "/p/s.jsonl:12", { kind: "viewer", hash: `#f=${enc("/p/s.jsonl")}` }],
  ["claude task output", "/tmp/claude-1000/-p/sess/tasks/abc.output", { kind: "viewer", hash: `#f=${enc("/tmp/claude-1000/-p/sess/tasks/abc.output")}` }],
  ["#f= transcript whose name holds a #", `#f=${enc("/p/session #2.jsonl")}`, { kind: "viewer", hash: `#f=${enc("/p/session #2.jsonl")}` }],
  ["file whose name holds a #", "/workspace/notes #2.md", file("/workspace/notes #2.md")],
  ["file whose name holds a #, with an anchor", `#f=${enc("/workspace/notes #2.md#setup")}`, file("/workspace/notes #2.md", { anchor: "setup" })],
  ["#c= conversation", "#c=conv-1", { kind: "viewer", hash: "#c=conv-1" }],
  ["viewer url, #p= project", "http://127.0.0.1:8898/#p=repo-1", { kind: "viewer", hash: "#p=repo-1" }],
  /* Not the viewer's. */
  ["external web link", "https://example.com/docs#f=x", null],
  ["foreign host with a viewer-looking hash", `https://example.com/#f=${enc(REPORT)}`, null],
  ["viewer url without a fragment", "http://127.0.0.1:8898/", null],
  ["relative path with no base", "docs/spec.md", null],
  ["empty", "", null],
  ["#a= naming no local path", "#a=relative.md", null],
];

describe("resolveLink — every observed shape", () => {
  for (const [name, input, expected] of SHAPES) {
    test(name, () => {
      expect(resolveLink(input) as unknown).toEqual(expected);
    });
  }

  test("the page's own non-loopback host counts as the viewer", () => {
    expect(resolveLink(`http://viewer.tailnet:8898/#f=${enc(REPORT)}`, { viewerHosts: ["viewer.tailnet:8898"] }) as unknown).toEqual(file(REPORT));
    expect(resolveLink(`http://viewer.tailnet:8898/#f=${enc(REPORT)}`)).toBeNull();
  });
});

describe("the hash routers agree with the resolver", () => {
  test("a #f= naming a file is no conversation, and the preview takes it", () => {
    const hash = `#f=${enc(REPORT + "#decision-graph")}`;
    expect(parseConversationHash(hash)).toEqual({ conversationId: null, filePath: null, project: null });
    expect(parseArtifactFragment(hash)).toBe(REPORT + "#decision-graph");
  });

  test("a #f= naming a transcript stays a conversation and never opens the preview", () => {
    const hash = `#f=${enc("/p/s.jsonl")}#question`;
    expect(parseConversationHash(hash).filePath).toBe("/p/s.jsonl");
    expect(parseArtifactFragment(hash)).toBeNull();
  });
});

describe("relative links inside a document", () => {
  test("resolve against the file's directory", () => {
    const base = directoryOf("/workspace/docs/guide/intro.md");
    expect(base).toBe("/workspace/docs/guide");
    expect(resolveRelative(base, "img/shot.png")).toBe("/workspace/docs/guide/img/shot.png");
    expect(resolveRelative(base, "./next.md#setup")).toBe("/workspace/docs/guide/next.md#setup");
    expect(resolveRelative(base, "../api/ref%20v2.md")).toBe("/workspace/docs/api/ref v2.md");
    expect(resolveRelative("~/notes", "a.md")).toBe("~/notes/a.md");
  });

  test("leave absolute, scheme and anchor-only links alone", () => {
    for (const href of ["/abs.md", "~/x.md", "https://example.com", "mailto:a@example.com", "#top", "data:image/png;base64,AA"]) {
      expect(resolveRelative("/workspace", href)).toBeNull();
    }
  });
});

test("heading slugs follow the GitHub spelling", () => {
  expect(headingSlug("Decision Graph")).toBe("decision-graph");
  expect(headingSlug("  What's next? (v2)  ")).toBe("whats-next-v2");
  expect(headingSlug("Рішення та наслідки")).toBe("рішення-та-наслідки");
});
