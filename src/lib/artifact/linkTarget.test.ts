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
  ["#f= transcript", `#f=${enc("/workspace/.claude/projects/p/s.jsonl")}`, { kind: "viewer", hash: `#f=${enc("/workspace/.claude/projects/p/s.jsonl")}` }],
  ["#f= transcript with #question", `#f=${enc("/p/s.jsonl")}#question`, { kind: "viewer", hash: `#f=${enc("/p/s.jsonl")}#question` }],
  ["viewer url, #f= transcript", `http://127.0.0.1:8898/#f=${enc("/p/s.jsonl")}`, { kind: "viewer", hash: `#f=${enc("/p/s.jsonl")}` }],
  ["#f= launch placeholder", "#f=spawn%3Alaunch-1", { kind: "viewer", hash: "#f=spawn%3Alaunch-1" }],
  ["plain transcript path with :line", "/p/s.jsonl:12", { kind: "viewer", hash: `#f=${enc("/p/s.jsonl")}` }],
  ["claude task output", "/tmp/claude-1000/-p/sess/tasks/abc.output", { kind: "viewer", hash: `#f=${enc("/tmp/claude-1000/-p/sess/tasks/abc.output")}` }],
  ["#f= transcript whose name holds a #", `#f=${enc("/p/session #2.jsonl")}`, { kind: "viewer", hash: `#f=${enc("/p/session #2.jsonl")}` }],
  ["file whose name holds a #", "/workspace/notes #2.md", file("/workspace/notes #2.md")],
  ["file whose name holds a #, with an anchor", `#f=${enc("/workspace/notes #2.md#setup")}`, file("/workspace/notes #2.md", { anchor: "setup" })],
  /* Element ids may hold `.` and `/`: after a complete file name, the `#` is the anchor. */
  ["#f= dotted anchor, encoded", `#f=${enc(REPORT + "#section.1")}`, file(REPORT, { anchor: "section.1" })],
  ["#f= dotted anchor, literal", `#f=${enc(REPORT)}#section.1`, file(REPORT, { anchor: "section.1" })],
  ["viewer url, slashed anchor, encoded", `http://127.0.0.1:8898/#f=${enc(REPORT + "#part/2")}`, file(REPORT, { anchor: "part/2" })],
  ["plain path, slashed anchor", `${REPORT}#part/2`, file(REPORT, { anchor: "part/2" })],
  ["extensionless name with anchor", "/workspace/Makefile#install", file("/workspace/Makefile", { anchor: "install" })],
  /* Every spelling of a transcript reaches the same conversation hash. */
  ["file:// transcript", "file:///workspace/session.jsonl", { kind: "viewer", hash: `#f=${enc("/workspace/session.jsonl")}` }],
  ["file:// transcript with :line", "file:///workspace/session.jsonl:12", { kind: "viewer", hash: `#f=${enc("/workspace/session.jsonl")}` }],
  ["#f= transcript with :line, encoded", `#f=${enc("/workspace/session.jsonl:12")}`, { kind: "viewer", hash: `#f=${enc("/workspace/session.jsonl")}` }],
  ["#f= transcript with encoded #question", `#f=${enc("/workspace/session.jsonl#question")}`, { kind: "viewer", hash: `#f=${enc("/workspace/session.jsonl")}#question` }],
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

  test("a transcript's :line and encoded #question never reach the conversation lookup", () => {
    expect(parseConversationHash(`#f=${enc("/workspace/session.jsonl:12")}`).filePath).toBe("/workspace/session.jsonl");
    expect(parseConversationHash(`#f=${enc("/workspace/session.jsonl#question")}`).filePath).toBe("/workspace/session.jsonl");
    expect(parseConversationHash(`#f=${enc("/p/session #2.jsonl")}#question`).filePath).toBe("/p/session #2.jsonl");
    expect(parseArtifactFragment(`#f=${enc("/workspace/session.jsonl:12")}`)).toBeNull();
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

  test("decode an encoded fragment exactly once and keep literal filename characters", () => {
    const base = "/workspace/docs";
    expect(resolveRelative(base, "t.md#%D1%80%D0%BE%D0%B7%D0%B4%D1%96%D0%BB")).toBe("/workspace/docs/t.md#розділ");
    expect(resolveRelative(base, "t.md#Step%202")).toBe("/workspace/docs/t.md#Step 2");
    expect(resolveRelative(base, "t.md#100%25")).toBe("/workspace/docs/t.md#100%");
    expect(resolveRelative(base, "t.md#%2541")).toBe("/workspace/docs/t.md#%41");
    expect(resolveRelative(base, "t.md#bad%zz")).toBe("/workspace/docs/t.md#bad%zz");
    expect(resolveLink(resolveRelative(base, "../r/index.html#%D1%80")!)).toEqual({ kind: "file", path: "/workspace/r/index.html", line: null, column: null, anchor: "р" });
    expect(resolveLink(resolveRelative(base, "t.md#Step%202")!)).toMatchObject({ path: "/workspace/docs/t.md", anchor: "Step 2" });
  });

  test("a sibling file with a :line or :line:col suffix is a file, never a URL scheme", () => {
    const base = "/workspace/src";
    expect(resolveRelative(base, "retry.ts:180")).toBe("/workspace/src/retry.ts:180");
    expect(resolveLink(resolveRelative(base, "retry.ts:180")!)).toEqual({ kind: "file", path: "/workspace/src/retry.ts", line: 180, column: null, anchor: null });
    expect(resolveLink(resolveRelative(base, "retry.ts:180:5")!)).toEqual({ kind: "file", path: "/workspace/src/retry.ts", line: 180, column: 5, anchor: null });
    expect(resolveLink(resolveRelative(base, "retry.ts:12-20")!)).toMatchObject({ path: "/workspace/src/retry.ts", line: 12 });
    for (const href of ["tel:5551234", "news:12", "mailto:a@example.com", "https://example.com:8080", "urn:isbn:0451450523"]) {
      expect(resolveRelative(base, href)).toBeNull();
    }
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
