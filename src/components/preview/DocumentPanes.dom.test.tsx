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

(globalThis as { fetch: unknown }).fetch = (input: string | URL, init?: { headers?: Record<string, string> }) => {
  const url = new URL(String(input), "http://127.0.0.1:8898");
  fetchLog.push(url.pathname + url.search);
  const path = url.searchParams.get("path") ?? "";
  const file = url.pathname === "/api/artifact" ? files[path] : undefined;
  if (!file) return Promise.resolve(respond({ status: 404, body: { error: "file not found", code: "not-found" } }));
  const name = path.split("/").pop()!;
  if (url.searchParams.get("mode") === "meta") {
    return Promise.resolve(
      respond({
        status: 200,
        body: { name, kind: "text", mime: "text/plain; charset=utf-8", size: file.body.length, etag: '"e1"', ...(file.frame ? { frame: file.frame } : {}) },
      }),
    );
  }
  const range = init?.headers?.range?.match(/^bytes=(\d+)-(\d+)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range ? Math.min(Number(range[2]), file.body.length - 1) : file.body.length - 1;
  return Promise.resolve(respond({ status: range ? 206 : 200, body: file.body.slice(start, end + 1) }));
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
  for (let i = 0; i < 4; i++) {
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
  expect(image.getAttribute("src")).toBe(`/api/image?path=${encodeURIComponent("/workspace/docs/img/flow.png")}`);
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
