import { afterAll, afterEach, expect, jest, test } from "bun:test";
import fs from "node:fs";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import type { Pipeline } from "@/lib/pipelines/types";

installActEnv();

/*
 * The board's beat (docs/design/task-file-preview.md §6.7, §11.4): twenty
 * cards' album entries, half with lanes and half with pictures, and ten turns
 * of the 45-second summary beat. The one batched summary read repeats once per
 * beat, and nothing else is requested: no file list, no file content. The same
 * case runs unchanged on the base revision, where it records the same
 * requests per beat.
 */

const dom = new Window({ url: "http://localhost:3000/", width: 1440, height: 900 });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent,
  CustomEvent: dom.CustomEvent, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  matchMedia: dom.matchMedia.bind(dom),
});

const previousFetch = globalThis.fetch;
const requests: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  requests.push(url.replace(/\?.*$/, ""));
  if (url.startsWith("/api/task-album?")) {
    const ids = decodeURIComponent(url.split("ids=")[1] ?? "").split(",");
    return Response.json({ tasks: Object.fromEntries(ids.filter((id) => Number(id.split("-")[1]) % 2 === 0).map((id) => [id, { count: 2, newCount: 0, newestAt: 1 }])) });
  }
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;

const { CardAlbumButton } = await import("./AlbumButton");
const { resetAlbumSummaries } = await import("./albumSummaries");

const roots: Root[] = [];
afterEach(() => {
  jest.useRealTimers();
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  resetAlbumSummaries();
  requests.length = 0;
});
afterAll(() => { globalThis.fetch = previousFetch; });

test("twenty cards over ten beats request only the batched summary, once per beat", async () => {
  jest.useFakeTimers();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const lanes = [{ id: "lane", stages: [], runs: [] } as unknown as Pipeline];
  act(() => root.render(
    <>
      {Array.from({ length: 20 }, (_, index) => (
        /* Odd cards have lanes and no pictures; even cards have pictures. */
        <CardAlbumButton key={index} taskId={`task-${index}`} title={`Task ${index}`} pipelines={index % 2 ? lanes : []} files={[]} filesAvailable={index % 2 === 1} />
      ))}
    </>,
  ));
  const beat = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); }); };
  await beat(300);
  for (let turn = 0; turn < 10; turn += 1) await beat(45_000);
  const summaryReads = requests.filter((url) => url === "/api/task-album").length;
  /* A comparison run records its numbers beside its log. */
  if (process.env.LLV_BEAT_OUT) fs.appendFileSync(process.env.LLV_BEAT_OUT, `${JSON.stringify({ summaryReads, otherRequests: requests.length - summaryReads, buttons: host.querySelectorAll("[data-album-button]").length })}\n`);
  expect(summaryReads).toBeGreaterThanOrEqual(10);
  expect(summaryReads).toBeLessThanOrEqual(12);
  expect(requests.filter((url) => url !== "/api/task-album")).toEqual([]);
  expect(host.querySelectorAll("[data-album-button]").length).toBeGreaterThanOrEqual(10);
});
