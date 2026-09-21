import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { previewTarget } from "@/components/preview/ArtifactPreviewHost";
import { onArtifactPreview } from "@/components/preview/previewBus";

import { md } from "./markdown";

installActEnv();

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});

let root: Root | null = null;
let opened: string[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  opened = [];
  unsubscribe = onArtifactPreview((request) => opened.push(request.path));
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
});

afterEach(async () => {
  unsubscribe?.();
  await act(async () => root?.unmount());
  dom.document.body.replaceChildren();
});

async function renderMd(text: string): Promise<void> {
  await act(async () => {
    root!.render(<div>{md(text)}</div>);
  });
}

function anchor(): HTMLAnchorElement {
  const a = dom.document.querySelector("a");
  expect(a).not.toBeNull();
  return a as unknown as HTMLAnchorElement;
}

test("a linked local PDF opens the in-app preview instead of navigating", async () => {
  await renderMd("The summary is in [the report](~/fixtures/out/report.pdf).");
  const a = anchor();
  /* href still names the resource for copy/open-in-new-tab affordances */
  const href = new URL(a.getAttribute("href")!, "http://127.0.0.1:8898");
  expect(href.pathname).toBe("/api/artifact");
  expect(href.searchParams.get("path")).toBe("~/fixtures/out/report.pdf");
  await act(async () => {
    a.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  expect(opened).toEqual(["~/fixtures/out/report.pdf"]);
  expect(dom.location.hash).toBe("");
});

test("image and text artifact links intercept the same way", async () => {
  await renderMd("See [the shot](~/fixtures/shots/board.png) and [the log](/tmp/fixtures/run.log).");
  const anchors = [...dom.document.querySelectorAll("a")] as unknown as HTMLAnchorElement[];
  expect(anchors.length).toBe(2);
  for (const a of anchors) {
    await act(async () => {
      a.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
    });
  }
  expect(opened).toEqual(["~/fixtures/shots/board.png", "/tmp/fixtures/run.log"]);
});

test("a transcript .jsonl link keeps the conversation deep-link", async () => {
  await renderMd("Resume [the session](~/fixtures/projects/session.jsonl).");
  expect(anchor().getAttribute("href")).toBe("#f=" + encodeURIComponent("~/fixtures/projects/session.jsonl"));
  expect(opened).toEqual([]);
});

test("ordinary web links keep their normal behavior", async () => {
  await renderMd("Read [the docs](https://example.com/guide.pdf).");
  const a = anchor();
  expect(a.getAttribute("href")).toBe("https://example.com/guide.pdf");
  expect(a.getAttribute("target")).toBe("_blank");
  await act(async () => {
    a.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  expect(opened).toEqual([]);
});

test("an escaped paren resolves back into the URL", async () => {
  await renderMd("Read [the page](https://example.com/acme/widgets/wiki/Home_\\(draft\\)) now.");
  expect(anchor().getAttribute("href")).toBe("https://example.com/acme/widgets/wiki/Home_(draft)");
});

test("a local link with a :line suffix previews the file itself", async () => {
  await renderMd("Fix [the bug](~/fixtures/src/main.ts:42).");
  await act(async () => {
    anchor().dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  expect(opened).toEqual(["~/fixtures/src/main.ts:42"]);
});

test("the owner's viewer URL in prose opens the report in the preview, not a new tab", async () => {
  const report = "/workspace/checkout/reports/round-2/index.html";
  await renderMd(`Added the decision graph: http://127.0.0.1:8898/#f=${encodeURIComponent(report + "#decision-graph")}`);
  const a = anchor();
  expect(a.getAttribute("target")).toBeNull();
  expect(new URL(a.getAttribute("href")!, "http://127.0.0.1:8898").searchParams.get("path")).toBe(report);
  await act(async () => {
    a.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  /* The raw spelling travels; the preview reads it with the same resolver. */
  expect(opened).toHaveLength(1);
  expect(previewTarget(opened[0]!)).toEqual({ kind: "file", path: report, line: null, column: null, anchor: "decision-graph" });
});

test("a viewer URL naming a conversation becomes the in-app hash the router intercepts", async () => {
  await renderMd("Continue in [the lane](http://127.0.0.1:8898/#c=conversation-1).");
  const a = anchor();
  expect(a.getAttribute("href")).toBe("#c=conversation-1");
  expect(a.getAttribute("target")).toBeNull();
});

test("file:// and plain-path links to any local file open the preview, never a dead #f=", async () => {
  await renderMd("See [a](file:///workspace/a%20b/notes.md#setup) and [b](/workspace/out/build).");
  const anchors = [...dom.document.querySelectorAll("a")] as unknown as HTMLAnchorElement[];
  for (const a of anchors) {
    expect(a.getAttribute("href")!.startsWith("#f=")).toBe(false);
    await act(async () => {
      a.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
    });
  }
  expect(opened).toEqual(["file:///workspace/a%20b/notes.md#setup", "/workspace/out/build"]);
});

test("a transcript link opens its conversation whichever spelling it has", async () => {
  await renderMd("Read [one](file:///workspace/session.jsonl), [two](file:///workspace/session.jsonl:12) and [three](/workspace/session.jsonl:12).");
  const anchors = [...dom.document.querySelectorAll("a")] as unknown as HTMLAnchorElement[];
  expect(anchors.map((a) => a.getAttribute("href"))).toEqual(Array(3).fill(`#f=${encodeURIComponent("/workspace/session.jsonl")}`));
  for (const a of anchors) {
    await act(async () => {
      a.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
    });
  }
  expect(opened).toEqual([]);
});
