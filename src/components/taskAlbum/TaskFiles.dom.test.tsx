import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { TaskFile, TaskFilesLane } from "@/lib/taskFiles/files";

installActEnv();

/*
 * The Files view of a task's album: nothing is read until it is shown, the
 * list answers one small request per page of lanes, a row opens the shared
 * preview sheet above the album, and Markdown from a lane is rendered as
 * inert elements. Each state is found by its defining text.
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
const calls: Array<{ url: string; method: string }> = [];
let lanesAnswer: (ids: string[]) => { lanes: TaskFilesLane[]; omitted: number } | Response = () => ({ lanes: [], omitted: 0 });
let markdown = "# Heading\n\nbody\n";
let summary = { count: 0, newCount: 0, newestAt: 0 };

const HEAD = "a".repeat(40);
const file = (path: string, overrides: Partial<TaskFile> = {}): TaskFile => ({
  path, op: "add", added: 3, removed: 0, binary: false, mode: "file", size: 120, group: "document", previewable: true, ...overrides,
});
const okLane = (lane: string, files: TaskFile[], overrides: Partial<Extract<TaskFilesLane, { status: "ok" }>> = {}): TaskFilesLane => ({
  lane, status: "ok", head: HEAD, base: "b".repeat(40), headSource: "branch", committedAt: Date.parse("2026-11-02T10:00:00Z"), files, total: files.length, truncated: false, ...overrides,
});

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push({ url, method });
  if (url.startsWith("/api/task-album?")) return Response.json({ tasks: { "task-1": summary } });
  const list = url.match(/^\/api\/tasks\/task-1\/files\?lanes=(.*)$/);
  if (list) {
    const answer = lanesAnswer(decodeURIComponent(list[1]).split(","));
    return answer instanceof Response ? answer : Response.json(answer);
  }
  if (url.startsWith("/api/tasks/task-1/files/content?") && url.includes("mode=meta")) {
    const params = new URL(url, "http://localhost").searchParams;
    const name = params.get("file")!.split("/").pop()!;
    return Response.json({ name, kind: "text", mime: "text/plain; charset=utf-8", size: markdown.length, mtimeMs: 1, etag: '"gx"', revision: { head: HEAD, committedAt: 1, headSource: "branch" }, baseDir: "/fixture/docs" });
  }
  if (url.startsWith("/api/tasks/task-1/files/content?")) return new Response(markdown, { status: 206, headers: { "content-type": "text/plain" } });
  if (url.startsWith("/api/tasks/task-1/album")) return Response.json({ items: [], total: 0, nextCursor: null, indexing: false, lastOpenedAt: null, newCount: 0 });
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;

const { CardAlbumButton, PhoneAlbumRow } = await import("./AlbumButton");
const { resetAlbumSummaries } = await import("./albumSummaries");
const { ArtifactPreviewHost } = await import("@/components/preview/ArtifactPreviewHost");

const pipeline = (id: string, createdAt: string, overrides: Partial<Pipeline> = {}): Pipeline => ({
  id, task: `Lane ${id}\nmore text`, createdAt, state: "completed",
  stages: [{ id: "design", role: { roleId: "architect" } }], runs: [], ...overrides,
}) as unknown as Pipeline;

const roots: Root[] = [];
beforeEach(() => {
  setLocale("en");
  lanesAnswer = () => ({ lanes: [], omitted: 0 });
  markdown = "# Heading\n\nbody\n";
  summary = { count: 0, newCount: 0, newestAt: 0 };
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  resetAlbumSummaries();
  calls.length = 0;
});
afterAll(() => {
  globalThis.fetch = previousFetch;
});

const settle = async (ms = 80) => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
};
const filesCalls = () => calls.filter((call) => call.url.startsWith("/api/tasks/task-1/files"));
const albumCalls = () => calls.filter((call) => call.url.startsWith("/api/tasks/task-1/album"));

async function mount(pipelines: Pipeline[], options: { phone?: boolean } = {}): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(
    <>
      {options.phone
        ? <PhoneAlbumRow taskId="task-1" title="Task title" pipelines={pipelines} files={[]} filesAvailable rowClass="row" />
        : <CardAlbumButton taskId="task-1" title="Task title" pipelines={pipelines} files={[]} filesAvailable />}
      <ArtifactPreviewHost mobile={false} />
    </>,
  ));
  /* The board's summary read settles after 250 ms. */
  await settle(summary.count ? 320 : 80);
  return host;
}
const openFiles = async (host: HTMLElement) => {
  await act(async () => host.querySelector<HTMLButtonElement>("[data-album-button='task-1'], [data-phone-task-files='task-1']")!.click());
  await settle();
};
const text = () => document.querySelector("[data-task-album]")?.textContent ?? "";

test("a task with lanes and no pictures shows a files entry; nothing is read until it opens", async () => {
  const host = await mount([pipeline("a", "2026-11-01T00:00:00Z")]);
  const button = host.querySelector<HTMLButtonElement>("[data-album-button='task-1']");
  expect(button).not.toBeNull();
  expect(button!.getAttribute("aria-label")).toBe("Open the files of «Task title»");
  expect(filesCalls()).toEqual([]);
  expect(albumCalls()).toEqual([]);
});

test("opened on Files, the dialog reads the lane list but not the images, and does not mark any picture seen", async () => {
  lanesAnswer = () => ({ lanes: [okLane("a", [file("docs/summary.md")])], omitted: 0 });
  const host = await mount([pipeline("a", "2026-11-01T00:00:00Z")]);
  await openFiles(host);
  expect(filesCalls().map((call) => call.url)).toEqual(["/api/tasks/task-1/files?lanes=a"]);
  expect(albumCalls()).toEqual([]);
  expect(document.querySelector("h2")!.textContent).toBe("Files");
  expect(document.querySelector("[data-album-view='files']")!.getAttribute("aria-pressed")).toBe("true");
  /* Switching to Images loads them once, then back to Files re-reads nothing. */
  await act(async () => document.querySelector<HTMLButtonElement>("[data-album-view='images']")!.click());
  await settle();
  expect(albumCalls().filter((call) => call.method === "GET")).toHaveLength(1);
  await act(async () => document.querySelector<HTMLButtonElement>("[data-album-view='files']")!.click());
  await settle();
  expect(filesCalls()).toHaveLength(1);
});

test("a task with pictures opens on Images and reads no file list until Files is chosen", async () => {
  summary = { count: 2, newCount: 0, newestAt: 1 };
  lanesAnswer = () => ({ lanes: [okLane("a", [file("docs/summary.md")])], omitted: 0 });
  const host = await mount([pipeline("a", "2026-11-01T00:00:00Z")]);
  await openFiles(host);
  expect(document.querySelector("h2")!.textContent).toBe("Images");
  expect(filesCalls()).toEqual([]);
  await act(async () => document.querySelector<HTMLButtonElement>("[data-album-view='files']")!.click());
  await settle();
  expect(filesCalls()).toHaveLength(1);
});

test("the phone row opens the same dialog on Files", async () => {
  lanesAnswer = () => ({ lanes: [okLane("a", [file("docs/summary.md")])], omitted: 0 });
  const host = await mount([pipeline("a", "2026-11-01T00:00:00Z")], { phone: true });
  expect(host.querySelector("[data-phone-task-files='task-1']")!.textContent).toContain("Files");
  await openFiles(host);
  expect(filesCalls()).toHaveLength(1);
  expect(text()).toContain("summary.md");
});

test("rows: declared result first, previewable rows are buttons, the others are plain and say why", async () => {
  lanesAnswer = () => ({
    lanes: [okLane("a", [
      file("docs/handoff.md", { group: "declared", declaredBy: "design" }),
      file("docs/readme.md"),
      file("img/shot.png", { group: "image", size: 2048 }),
      file("src/gone.ts", { op: "delete", group: "source", previewable: false, mode: null, size: null, added: 0, removed: 4 }),
      file("link.md", { mode: "link", previewable: false }),
      file("vendor/module.md", { mode: "submodule", size: null, previewable: false }),
      file("data/huge.txt", { size: 9 * 1024 * 1024, previewable: false, group: "document" }),
      file(".env.local", { group: "other", previewable: false }),
    ])],
    omitted: 0,
  });
  const host = await mount([pipeline("a", "2026-11-01T00:00:00Z")]);
  await openFiles(host);
  const row = (path: string) => document.querySelector<HTMLElement>(`[data-task-file="${path}"]`);
  /* Visible: declared, documents, images. Source and other fold; deleted source folds. */
  expect(row("docs/handoff.md")!.textContent).toContain("Design result");
  expect(row("docs/handoff.md")!.querySelector("button")!.getAttribute("aria-label")).toBe("handoff.md, new, in docs. Open");
  expect(row("img/shot.png")!.querySelector("button")).not.toBeNull();
  expect(row("link.md")!.querySelector("button")).toBeNull();
  expect(row("link.md")!.textContent).toContain("link");
  expect(row("vendor/module.md")!.textContent).toContain("submodule");
  expect(row("data/huge.txt")!.textContent).toContain("too large to preview");
  expect(row("data/huge.txt")!.textContent).toContain("9.0 MiB");
  expect(row("src/gone.ts")).toBeNull();
  const fold = document.querySelector<HTMLButtonElement>("[data-task-files-fold]")!;
  expect(fold.textContent).toBe("Show 2 other changed files");
  await act(async () => fold.click());
  expect(row("src/gone.ts")!.textContent).toContain("deleted");
  expect(row("src/gone.ts")!.querySelector("button")).toBeNull();
  expect(row(".env.local")!.textContent).toContain("no preview");
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(fold.textContent).toBe("Hide other changed files");
});

test("states: lane heading with the short commit, running note, truncation, empty lane and unavailable lanes with Retry", async () => {
  lanesAnswer = (ids) => ({
    lanes: ids.map((id): TaskFilesLane => id === "a"
      ? okLane("a", [file("docs/a.md")], { total: 230, truncated: true, headSource: "last-passed" })
      : id === "b" ? okLane("b", [])
      : id === "c" ? { lane: "c", status: "unavailable", reason: "repository-missing" }
      : { lane: "d", status: "unavailable", reason: "busy" }),
    omitted: 0,
  });
  const host = await mount([
    pipeline("a", "2026-11-04T00:00:00Z", { state: "running" }), pipeline("b", "2026-11-03T00:00:00Z"),
    pipeline("c", "2026-11-02T00:00:00Z"), pipeline("d", "2026-11-01T00:00:00Z"),
  ]);
  await openFiles(host);
  const content = text();
  expect(content).toContain("at aaaaaaa");
  expect(content).toContain("last passed commit; branch removed");
  expect(content).toContain("The running stage's uncommitted changes appear after it commits.");
  expect(content).toContain("229 more files not listed");
  expect(content).toContain("No committed changes in this lane yet.");
  expect(content).toContain("This lane's repository isn't on this machine.");
  expect(content).toContain("Still reading this lane.");
  /* Only the lane that may be retried carries Retry; retrying asks for that lane alone. */
  const unavailable = document.querySelector("[data-task-files-unavailable='busy']")!;
  expect(document.querySelector("[data-task-files-unavailable='repository-missing'] button")).toBeNull();
  calls.length = 0;
  await act(async () => unavailable.querySelector("button")!.click());
  await settle();
  expect(filesCalls().map((call) => call.url)).toEqual(["/api/tasks/task-1/files?lanes=d"]);
});

test("a lone lane named like the task adds no second mention; a root file has no empty directory line; an unreadable running lane promises nothing", async () => {
  lanesAnswer = (ids) => ({ lanes: ids.map((id): TaskFilesLane => okLane(id, [file("README.md"), file("docs/a.md")])), omitted: 0 });
  const host = await mount([pipeline("a", "2026-11-04T00:00:00Z", { task: "Task title" })]);
  await openFiles(host);
  const heading = document.querySelector("[data-task-files-lane='a'] h3")!;
  expect(heading.className).toContain("sr-only");
  const root = document.querySelector("[data-task-file='README.md']")!;
  expect(root.querySelectorAll("button > span > span").length).toBe(1);
  expect(root.textContent).toContain("120 B");
  expect(document.querySelector("[data-task-file='docs/a.md'] bdi")?.textContent).toBe("docs");

  lanesAnswer = (ids) => ({ lanes: ids.map((id): TaskFilesLane => ({ lane: id, status: "unavailable", reason: "repository-missing" })), omitted: 0 });
  const second = await mount([pipeline("b", "2026-11-04T00:00:00Z", { task: "Task title", state: "running" })]);
  await openFiles(second);
  expect(document.querySelector("[data-task-files-running]")).toBeNull();
  expect(document.querySelector("[data-task-files-unavailable='repository-missing']")).not.toBeNull();
});

test("a view with no committed file says so; a failed read says so with Retry", async () => {
  lanesAnswer = () => ({ lanes: [okLane("a", [])], omitted: 0 });
  const host = await mount([pipeline("a", "2026-11-01T00:00:00Z")]);
  await openFiles(host);
  expect(document.querySelector("[data-task-files-empty]")!.textContent).toBe("No committed files yet. Files this task's lanes add or change appear here after each commit.");
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  lanesAnswer = () => new Response("{}", { status: 500 });
  const failedHost = await mount([pipeline("a", "2026-11-01T00:00:00Z")]);
  await openFiles(failedHost);
  expect(document.querySelector("[data-task-files-failed]")!.textContent).toContain("Couldn't load the files");
  lanesAnswer = () => ({ lanes: [okLane("a", [file("docs/a.md")])], omitted: 0 });
  await act(async () => document.querySelector<HTMLButtonElement>("[data-task-files-failed] button")!.click());
  await settle();
  expect(text()).toContain("a.md");
});

test("a lane the answer leaves out settles into its own note, beside the lanes that answered, and older lanes stay reachable", async () => {
  const lanes = Array.from({ length: 7 }, (_, i) => pipeline(`l${i}`, `2026-11-0${i + 1}T00:00:00Z`));
  lanesAnswer = (ids) => ({ lanes: ids.filter((id) => id !== "l5").map((id) => okLane(id, [file(`docs/${id}.md`)])), omitted: 1 });
  const host = await mount(lanes);
  await openFiles(host);
  expect(document.querySelector("[data-task-files-loading]")).toBeNull();
  expect(document.querySelector("[data-task-files-lane='l5'] [data-task-files-unavailable='omitted']")!.textContent).toBe("Files for this lane aren't available here.");
  expect(document.querySelector("[data-task-files-lane='l5'] button")).toBeNull();
  expect(text()).toContain("l6.md");
  await act(async () => document.querySelector<HTMLButtonElement>("[data-task-files-older]")!.click());
  await settle();
  expect(document.querySelectorAll("[data-task-files-lane]")).toHaveLength(7);
});

test("a view whose every lane is left out settles instead of loading forever", async () => {
  lanesAnswer = () => ({ lanes: [], omitted: 1 });
  const host = await mount([pipeline("a", "2026-11-01T00:00:00Z")]);
  await openFiles(host);
  expect(document.querySelector("[data-task-files-loading]")).toBeNull();
  expect(document.querySelector("[data-task-files-unavailable='omitted']")).not.toBeNull();
  expect(document.querySelector("[data-task-files-empty]")).toBeNull();
});

test("lanes are read newest first, five at a time, older ones on request", async () => {
  const lanes = Array.from({ length: 7 }, (_, i) => pipeline(`l${i}`, `2026-11-0${i + 1}T00:00:00Z`));
  lanesAnswer = (ids) => ({ lanes: ids.map((id) => okLane(id, [file(`docs/${id}.md`)])), omitted: 0 });
  const host = await mount(lanes);
  await openFiles(host);
  expect(filesCalls().map((call) => call.url)).toEqual(["/api/tasks/task-1/files?lanes=l6,l5,l4,l3,l2"]);
  await act(async () => document.querySelector<HTMLButtonElement>("[data-task-files-older]")!.click());
  await settle();
  expect(filesCalls().map((call) => call.url).at(-1)).toBe("/api/tasks/task-1/files?lanes=l1,l0");
  expect(document.querySelector("[data-task-files-older]")).toBeNull();
  expect(document.querySelectorAll("[data-task-files-lane]")).toHaveLength(7);
});

test("a failed page of older lanes says so beside its button, keeps the lanes shown, and Show older lanes asks for the same lanes again", async () => {
  const lanes = Array.from({ length: 6 }, (_, i) => pipeline(`l${i}`, `2026-11-0${i + 1}T00:00:00Z`));
  let failing = true;
  lanesAnswer = (ids) => ids.includes("l0") && failing ? new Response("{}", { status: 500 }) : { lanes: ids.map((id) => okLane(id, [file(`docs/${id}.md`)])), omitted: 0 };
  const host = await mount(lanes);
  await openFiles(host);
  await act(async () => document.querySelector<HTMLButtonElement>("[data-task-files-older]")!.click());
  await settle();
  expect(document.querySelector("[data-task-files-older-failed]")!.textContent).toBe("Couldn't load older lanes. Press Show older lanes to try again.");
  expect(document.querySelectorAll("[data-task-files-lane]")).toHaveLength(5);
  expect(document.querySelector("[data-task-files-older]")).not.toBeNull();
  failing = false;
  await act(async () => document.querySelector<HTMLButtonElement>("[data-task-files-older]")!.click());
  await settle();
  expect(filesCalls().map((call) => call.url).slice(-2)).toEqual(["/api/tasks/task-1/files?lanes=l0", "/api/tasks/task-1/files?lanes=l0"]);
  expect(document.querySelector("[data-task-files-older-failed]")).toBeNull();
  expect(document.querySelector("[data-task-files-older]")).toBeNull();
  expect(document.querySelectorAll("[data-task-files-lane]")).toHaveLength(6);
  expect(text()).toContain("l0.md");
});

test("a failed middle page is retried as it was before any later page is asked for, so no lane is skipped", async () => {
  const lanes = Array.from({ length: 12 }, (_, i) => pipeline(`l${String(i).padStart(2, "0")}`, `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
  let failing = true;
  lanesAnswer = (ids) => ids.includes("l06") && failing ? new Response("{}", { status: 500 }) : { lanes: ids.map((id) => okLane(id, [file(`docs/${id}.md`)])), omitted: 0 };
  const host = await mount(lanes);
  await openFiles(host);
  const older = () => document.querySelector<HTMLButtonElement>("[data-task-files-older]")!;
  await act(async () => older().click());
  await settle();
  expect(document.querySelector("[data-task-files-older-failed]")).not.toBeNull();
  expect(older()).not.toBeNull();
  failing = false;
  await act(async () => older().click());
  await settle();
  const asked = filesCalls().map((call) => call.url);
  expect(asked.at(-1)).toBe(asked.at(-2));
  expect(asked.at(-1)).toBe("/api/tasks/task-1/files?lanes=l06,l05,l04,l03,l02");
  await act(async () => older().click());
  await settle();
  expect(filesCalls().map((call) => call.url).at(-1)).toBe("/api/tasks/task-1/files?lanes=l01,l00");
  expect(document.querySelectorAll("[data-task-files-lane]")).toHaveLength(12);
  expect(document.querySelector("[data-task-files-older]")).toBeNull();
});

const press = async (key: string) => {
  await act(async () => { document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as unknown as Event); });
  await settle(20);
};

test("a row opens the preview above the album; Escape closes the sheet, then the album, and focus returns to the row", async () => {
  markdown = "# Heading\n\nbody text\n";
  lanesAnswer = () => ({ lanes: [okLane("a", [file("docs/summary.md")])], omitted: 0 });
  const host = await mount([pipeline("a", "2026-11-01T00:00:00Z")]);
  await openFiles(host);
  const row = document.querySelector<HTMLButtonElement>("[data-task-file='docs/summary.md'] button")!;
  act(() => row.focus());
  calls.length = 0;
  await act(async () => row.click());
  await settle(120);
  const sheet = document.querySelector<HTMLElement>("[data-artifact-preview]")!;
  expect(sheet).not.toBeNull();
  expect(Number(sheet.style.zIndex)).toBeGreaterThan(66);
  const album = document.querySelector<HTMLElement>("[data-task-album]")!;
  expect(album.className).toContain("z-");
  /* Meta first, then bounded content, both through the task's own route. */
  expect(calls[0]!.url).toBe(`/api/tasks/task-1/files/content?lane=a&head=${HEAD}&file=docs%2Fsummary.md&mode=meta`);
  expect(calls.some((call) => call.url === `/api/tasks/task-1/files/content?lane=a&head=${HEAD}&file=docs%2Fsummary.md`)).toBe(true);
  expect(calls.some((call) => call.url.startsWith("/api/artifact"))).toBe(false);
  expect(sheet.textContent).toContain("at aaaaaaa");
  expect(sheet.textContent).toContain("Heading");
  expect(sheet.querySelector<HTMLAnchorElement>("a[download]")!.getAttribute("href")).toBe(`/api/tasks/task-1/files/content?lane=a&head=${HEAD}&file=docs%2Fsummary.md&download=1`);
  await press("Escape");
  expect(document.querySelector("[data-artifact-preview]")).toBeNull();
  expect(document.querySelector("[data-task-album]")).not.toBeNull();
  expect(document.activeElement).toBe(row);
  await press("Escape");
  expect(document.querySelector("[data-task-album]")).toBeNull();
});

test("Markdown from a lane renders no script, image, frame or code-running link", async () => {
  markdown = [
    "# Title", "", "<script>window.__ran = 1</script>", "", "<img src=x onerror=\"window.__ran = 2\">", "",
    "<iframe src=\"http://example.invalid\"></iframe>", "", "[js](javascript:window.__ran=3)", "", "[data](data:text/html,<b>x</b>)", "", "plain **bold** text",
  ].join("\n");
  lanesAnswer = () => ({ lanes: [okLane("a", [file("docs/summary.md")])], omitted: 0 });
  const host = await mount([pipeline("a", "2026-11-01T00:00:00Z")]);
  await openFiles(host);
  await act(async () => document.querySelector<HTMLButtonElement>("[data-task-file='docs/summary.md'] button")!.click());
  await settle(120);
  const rendered = document.querySelector<HTMLElement>("[data-md-scroll]")!;
  expect(rendered.textContent).toContain("plain");
  expect(rendered.querySelector("script, img, iframe, object, embed")).toBeNull();
  /* React replaces a javascript: href with its own refusal, so the payload never reaches the page. */
  for (const anchor of rendered.querySelectorAll("a")) {
    const href = anchor.getAttribute("href") ?? "";
    expect(href).not.toContain("__ran");
    if (/^\s*javascript:/i.test(href)) expect(href).toContain("React has blocked a javascript: URL");
  }
  expect((globalThis as { __ran?: number }).__ran).toBeUndefined();
});

test("the sheet's failure states come from the route's status", async () => {
  lanesAnswer = () => ({ lanes: [okLane("a", [file("docs/summary.md")])], omitted: 0 });
  const original = globalThis.fetch;
  const host = await mount([pipeline("a", "2026-11-01T00:00:00Z")]);
  await openFiles(host);
  globalThis.fetch = (async (input: RequestInfo | URL) => String(input).includes("mode=meta")
    ? Response.json({ error: "x", code: "symlink" }, { status: 403 })
    : original(input)) as typeof fetch;
  await act(async () => document.querySelector<HTMLButtonElement>("[data-task-file='docs/summary.md'] button")!.click());
  await settle(80);
  expect(document.querySelector("[data-artifact-state]")!.getAttribute("data-artifact-state")).toBe("denied");
  globalThis.fetch = original;
});
