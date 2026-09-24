import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale } from "@/lib/i18n";

import { ArtifactPreviewHost } from "./ArtifactPreviewHost";
import { openArtifactPreview } from "./previewBus";

installActEnv();

const dom = new Window({ url: "http://127.0.0.1:8898/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});

/* Which element was scrolled into view, in order. */
let scrolled: Element[] = [];
(dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function (this: Element) {
  scrolled.push(this);
};

type Route = { status: number; body: string | object; headers?: Record<string, string> };
let fetchLog: string[] = [];
let files: Record<string, { body: string; frame?: string }> = {};

function respond(route: Route): Response {
  const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
  return new Response(body, { status: route.status, headers: route.headers });
}

/* Every file has its own ETag, and a content read carrying another file's
   If-Match fails as the real route does. Meta answers a tick late, as over a
   network, so a pane mounted before its own meta arrives would show. */
const etagOf = (path: string) => `"e-${path}"`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

(globalThis as { fetch: unknown }).fetch = async (input: string | URL, init?: { headers?: Record<string, string> }) => {
  const url = new URL(String(input), "http://127.0.0.1:8898");
  fetchLog.push(url.pathname + url.search);
  const path = url.searchParams.get("path") ?? "";
  const file = url.pathname === "/api/artifact" ? files[path] : undefined;
  if (!file) return respond({ status: 404, body: { error: "file not found", code: "not-found" } });
  const name = path.split("/").pop()!;
  if (url.searchParams.get("mode") === "meta") {
    await tick();
    return respond({
      status: 200,
      body: { name, kind: "text", mime: "text/plain; charset=utf-8", size: file.body.length, etag: etagOf(path), ...(file.frame ? { frame: file.frame } : {}) },
    });
  }
  const ifMatch = init?.headers?.["if-match"];
  if (ifMatch !== undefined && ifMatch !== etagOf(path)) {
    fetchLog.push("412 " + path);
    return respond({ status: 412, body: { error: "file changed since the preview opened", code: "changed" } });
  }
  const range = init?.headers?.range?.match(/^bytes=(\d+)-(\d+)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range ? Math.min(Number(range[2]), file.body.length - 1) : file.body.length - 1;
  return respond({ status: range ? 206 : 200, body: file.body.slice(start, end + 1) });
};

const WIDE_ROW = `| ${Array.from({ length: 14 }, (_, i) => `column ${i + 1}`).join(" | ")} |`;
const GUIDE = [
  "# Release guide",
  "",
  "Intro paragraph with a [relative link](next.md#setup) and an [absolute one](/workspace/src/main.ts:3).",
  "",
  "## Checklist",
  "",
  "- first item",
  "  continued on a second line",
  "- second item",
  "  - nested item",
  "1. ordered one",
  "2. ordered two",
  "- [x] done task",
  "",
  "![diagram](img/flow.png)",
  "",
  "## Wide table",
  "",
  WIDE_ROW,
  `|${" --- |".repeat(14)}`,
  WIDE_ROW,
  "",
  "```ts",
  "export const answer = 42;",
  "```",
  "",
  "> quoted note",
  "",
  "See [the table](#wide-table).",
].join("\n");

/* Relative links a previewed document carries: percent-encoded fragments
   (Unicode and ASCII) and sibling files with a :line / :line:col suffix. */
const FRAGMENTS = [
  "# Fragments",
  "",
  "- [Encoded Unicode heading](deep.md#%D1%80%D0%BE%D0%B7%D0%B4%D1%96%D0%BB)",
  "- [Encoded ASCII heading](./deep.md#Step%202)",
  "- [Encoded Unicode id](../reports/round-2/index.html#%D1%80%D0%BE%D0%B7%D0%B4%D1%96%D0%BB)",
  "- [Encoded ASCII id](../reports/round-2/index.html#part%202)",
  "- [Line suffix](retry.ts:180)",
  "- [Line and column](retry.ts:180:5)",
].join("\n");

const RETRY_TS = Array.from({ length: 200 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n");

const MAIN_TS = "line one\nline two\nline three is the one\nline four\n";

let root: Root | null = null;

beforeEach(() => {
  setLocale("en");
  fetchLog = [];
  scrolled = [];
  files = {
    "/workspace/docs/guide.md": { body: GUIDE },
    "/workspace/docs/next.md": { body: "# Next\n\n## Setup\n\nsteps" },
    "/workspace/src/main.ts": { body: MAIN_TS },
    "/workspace/reports/round-2/index.html": {
      body: '<h2 id="decision-graph">Graph</h2>',
      frame: "/api/artifact/frame/SCOPE/index.html",
    },
    "/workspace/docs/fragments.md": { body: FRAGMENTS },
    "/workspace/docs/deep.md": { body: "# Deep\n\n## Вступ\n\n## Розділ\n\n## Step 2\n" },
    "/workspace/docs/retry.ts": { body: RETRY_TS },
    "/workspace/docs/links.md": {
      body: `# Links\n\n[The report on this host](http://viewer.example/#f=${encodeURIComponent("/workspace/reports/round-2/index.html#decision-graph")}).`,
    },
  };
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  dom.document.body.replaceChildren();
  dom.history.replaceState(null, "", dom.location.pathname);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

function sheet(): HTMLElement {
  return dom.document.querySelector("[data-artifact-preview]") as unknown as HTMLElement;
}

async function open(spelled: string): Promise<void> {
  await act(async () => root!.render(<ArtifactPreviewHost mobile={false} />));
  await act(async () => openArtifactPreview(spelled));
  await settle();
}

test("markdown renders as a document: headings, lists, table, code, quote, images and links", async () => {
  await open("/workspace/docs/guide.md");
  const doc = sheet().querySelector("[data-md-document]")!;
  expect(doc).not.toBeNull();
  expect(sheet().textContent).toContain("Markdown document");

  expect(doc.querySelector("h1")!.textContent).toBe("Release guide");
  expect(Array.from(doc.querySelectorAll("h2")).map((h) => h.getAttribute("data-md-anchor"))).toEqual(["checklist", "wide-table"]);

  const items = Array.from(doc.querySelectorAll("[data-md-list] li")).map((li) => li.textContent);
  expect(items).toContain("•first item continued on a second line");
  expect(items).toContain("◦nested item");
  expect(items).toContain("1.ordered one");
  expect(items).toContain("☑done task");

  const table = doc.querySelector("table")!;
  expect(table.querySelectorAll("th").length).toBe(14);
  /* A wide table scrolls inside its own box instead of widening the sheet. */
  expect(table.parentElement!.className).toContain("overflow-x-auto");
  expect(doc.querySelector("pre")!.textContent).toContain("export const answer = 42;");
  expect(doc.querySelector("blockquote")!.textContent).toBe("quoted note");

  /* A relative image resolves against the file's directory. */
  const image = doc.querySelector("img")!;
  expect(image.getAttribute("src")).toBe(`/api/artifact?path=${encodeURIComponent("/workspace/docs/img/flow.png")}`);
});

test("a relative link opens its target in the preview, resolved against the file's directory", async () => {
  await open("/workspace/docs/guide.md");
  const link = Array.from(sheet().querySelectorAll("a")).find((a) => a.textContent === "relative link")!;
  expect(link.getAttribute("href")).toBe(`/api/artifact?path=${encodeURIComponent("/workspace/docs/next.md")}`);
  await act(async () => {
    link.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
  });
  await settle();
  expect(fetchLog).toContain(`/api/artifact?path=${encodeURIComponent("/workspace/docs/next.md")}&mode=meta`);
  expect(sheet().querySelector("h1")!.textContent).toBe("Next");
  /* …and lands on the anchor the relative link carried. */
  expect(scrolled.at(-1)!.getAttribute("data-md-anchor")).toBe("setup");
});

test("the link's anchor scrolls to its heading, and an in-document link scrolls without touching the URL", async () => {
  await open("/workspace/docs/guide.md#wide-table");
  expect(scrolled.at(-1)!.getAttribute("data-md-anchor")).toBe("wide-table");

  scrolled = [];
  const hashBefore = dom.location.hash;
  const inDoc = Array.from(sheet().querySelectorAll("a")).find((a) => a.textContent === "the table")!;
  await act(async () => {
    inDoc.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
  });
  expect(scrolled.at(-1)!.getAttribute("data-md-anchor")).toBe("wide-table");
  expect(dom.location.hash).toBe(hashBefore);
});

test("the raw source is one toggle away", async () => {
  await open("/workspace/docs/guide.md");
  const source = sheet().querySelector('[data-preview-mode="source"]')!;
  expect(sheet().querySelector('[data-preview-mode="rendered"]')!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => {
    source.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  await settle();
  expect(sheet().querySelector("[data-md-document]")).toBeNull();
  expect(sheet().querySelector('[data-preview-line="0"]')!.textContent).toContain("# Release guide");
});

test("the owner's link opens the HTML report in a sandboxed frame at its anchor", async () => {
  const path = "/workspace/reports/round-2/index.html";
  await act(async () => {
    dom.history.replaceState(null, "", `#f=${encodeURIComponent(path + "#decision-graph")}`);
  });
  await act(async () => root!.render(<ArtifactPreviewHost mobile={false} />));
  await settle();

  expect(fetchLog[0]).toBe(`/api/artifact?path=${encodeURIComponent(path)}&mode=meta`);
  expect(sheet().textContent).toContain("HTML page");
  const frame = sheet().querySelector("iframe[data-preview-frame]")!;
  expect(frame.getAttribute("src")).toBe("/api/artifact/frame/SCOPE/index.html#decision-graph");
  const sandbox = (frame.getAttribute("sandbox") ?? "").split(/\s+/);
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox).not.toContain("allow-same-origin");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");

  const external = sheet().querySelector("[data-preview-open-external]")!;
  expect(external.getAttribute("href")).toBe("/api/artifact/frame/SCOPE/index.html#decision-graph");
  expect(external.getAttribute("target")).toBe("_blank");

  await act(async () => {
    sheet().querySelector('[data-preview-mode="source"]')!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  await settle();
  expect(sheet().querySelector("iframe")).toBeNull();
  expect(sheet().querySelector('[data-preview-line="0"]')!.textContent).toContain('<h2 id="decision-graph">');
});

test("a path that does not exist says so and shows the path", async () => {
  await open("http://127.0.0.1:8898/#f=" + encodeURIComponent("/workspace/reports/gone/index.html#summary"));
  expect(sheet().getAttribute("data-artifact-state")).toBe("missing");
  expect(sheet().textContent).toContain("There is no file at this path.");
  expect(sheet().querySelector("[data-preview-failure-path]")!.textContent).toBe("/workspace/reports/gone/index.html");
});

test("a :line link marks that line and scrolls it into view", async () => {
  await open("/workspace/src/main.ts:3");
  const target = sheet().querySelector("[data-preview-target]")!;
  expect(target.getAttribute("data-preview-line")).toBe("2");
  expect(target.textContent).toContain("line three is the one");
  expect(scrolled).toContain(target);
  expect(fetchLog[0]).toBe(`/api/artifact?path=${encodeURIComponent("/workspace/src/main.ts")}&mode=meta`);
});

function click(element: Element): void {
  element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
}

test("a relative link after a Source/Rendered round trip opens the next document with its own metadata", async () => {
  await open("/workspace/docs/guide.md");
  await act(async () => click(sheet().querySelector('[data-preview-mode="source"]')!));
  await settle();
  await act(async () => click(sheet().querySelector('[data-preview-mode="rendered"]')!));
  await settle();
  const link = Array.from(sheet().querySelectorAll("a")).find((a) => a.textContent === "relative link")!;
  scrolled = [];
  await act(async () => click(link));
  await settle();
  /* No read of next.md ever carried guide.md's ETag. */
  expect(fetchLog.filter((entry) => entry.startsWith("412 "))).toEqual([]);
  expect(sheet().getAttribute("data-artifact-state")).toBe("ready");
  expect(sheet().querySelector("h1")!.textContent).toBe("Next");
  expect(scrolled.at(-1)!.getAttribute("data-md-anchor")).toBe("setup");
});

test("an HTML anchor holding a dot or a slash reaches the frame, encoded or literal", async () => {
  const path = "/workspace/reports/round-2/index.html";
  for (const [hash, anchor] of [
    [`#f=${encodeURIComponent(path + "#section.1")}`, "section.1"],
    [`#f=${encodeURIComponent(path)}#section.1`, "section.1"],
    [`#f=${encodeURIComponent(path + "#part/2")}`, "part/2"],
  ] as const) {
    await act(async () => {
      dom.history.replaceState(null, "", hash);
    });
    await act(async () => root!.render(<ArtifactPreviewHost mobile={false} />));
    await act(async () => {
      dom.dispatchEvent(new dom.Event("hashchange"));
    });
    await settle();
    expect(sheet().getAttribute("data-artifact-state")).toBe("ready");
    expect(sheet().querySelector("iframe[data-preview-frame]")!.getAttribute("src")).toBe(
      `/api/artifact/frame/SCOPE/index.html#${encodeURIComponent(anchor)}`,
    );
  }
});

test("a link to the Viewer's own non-loopback host opens the same anchored report as a loopback link", async () => {
  dom.happyDOM.setURL("http://viewer.example/");
  try {
    await open("/workspace/docs/links.md");
    const link = Array.from(sheet().querySelectorAll("a")).find((a) => a.textContent === "The report on this host")!;
    await act(async () => click(link));
    await settle();
    expect(fetchLog.at(-1)).toBe(`/api/artifact?path=${encodeURIComponent("/workspace/reports/round-2/index.html")}&mode=meta`);
    expect(sheet().getAttribute("data-artifact-state")).toBe("ready");
    expect(sheet().querySelector("iframe[data-preview-frame]")!.getAttribute("src")).toBe("/api/artifact/frame/SCOPE/index.html#decision-graph");
  } finally {
    dom.happyDOM.setURL("http://127.0.0.1:8898/");
  }
});

test("relative links decode their fragment once: a Unicode or ASCII heading scrolls, an HTML id reaches the frame", async () => {
  for (const [label, heading] of [
    ["Encoded Unicode heading", "розділ"],
    ["Encoded ASCII heading", "step-2"],
  ] as const) {
    await open("/workspace/docs/fragments.md");
    scrolled = [];
    await act(async () => click(Array.from(sheet().querySelectorAll("a")).find((a) => a.textContent === label)!));
    await settle();
    expect(sheet().querySelector("h1")!.textContent).toBe("Deep");
    expect(scrolled.at(-1)!.getAttribute("data-md-anchor")).toBe(heading);
  }
  for (const [label, frameHash] of [
    ["Encoded Unicode id", "#%D1%80%D0%BE%D0%B7%D0%B4%D1%96%D0%BB"],
    ["Encoded ASCII id", "#part%202"],
  ] as const) {
    await open("/workspace/docs/fragments.md");
    await act(async () => click(Array.from(sheet().querySelectorAll("a")).find((a) => a.textContent === label)!));
    await settle();
    expect(sheet().querySelector("iframe[data-preview-frame]")!.getAttribute("src")).toBe(`/api/artifact/frame/SCOPE/index.html${frameHash}`);
  }
});

test("a sibling file with a :line or :line:col suffix opens with that line highlighted", async () => {
  for (const label of ["Line suffix", "Line and column"]) {
    await open("/workspace/docs/fragments.md");
    const link = Array.from(sheet().querySelectorAll("a")).find((a) => a.textContent === label)!;
    expect(link.getAttribute("data-file-link")).not.toBeNull();
    scrolled = [];
    await act(async () => click(link));
    await settle();
    expect(fetchLog).toContain(`/api/artifact?path=${encodeURIComponent("/workspace/docs/retry.ts")}&mode=meta`);
    const target = sheet().querySelector("[data-preview-target]")!;
    expect(target.getAttribute("data-preview-line")).toBe("179");
    expect(target.textContent).toContain("const line180 = 180;");
    expect(scrolled).toContain(target);
  }
});
