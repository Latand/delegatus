import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { useArchivedProjects, type UseArchivedProjects } from "./useArchivedProjects";

/*
 * The shelf is the server's (`archivedProjects` from /api/files, written by
 * PUT /api/projects/settings): a press draws at once and only a refusal draws
 * it back; a browser's older localStorage shelf still counts; real activity
 * takes a project off the shelf and tells the server so.
 */

const dom = new Window({ url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
const overrides: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  localStorage: dom.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const savedGlobals = new Map<string, { present: boolean; value: unknown }>();
const originalFetch = globalThis.fetch;
const puts: unknown[] = [];
let reply: () => Promise<Response> = async () => new Response(JSON.stringify({ ok: true }));

beforeAll(() => {
  for (const [key, value] of Object.entries(overrides)) {
    savedGlobals.set(key, { present: key in globals, value: globals[key] });
    globals[key] = value;
  }
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    puts.push(JSON.parse(String(init?.body)));
    return reply();
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [key, saved] of savedGlobals) {
    if (saved.present) globals[key] = saved.value;
    else delete globals[key];
  }
  dom.close();
});
beforeEach(() => {
  puts.length = 0;
  dom.localStorage.clear();
  reply = async () => new Response(JSON.stringify({ ok: true }));
});

const file = (project: string, over: Partial<FileEntry> = {}) => ({ project, path: `/s/${project}.jsonl`, activity: "idle", proc: null, ...over }) as FileEntry;

async function mount(initial: { files: FileEntry[]; server: string[] }) {
  let latest: UseArchivedProjects | null = null;
  let setInput: (value: { files: FileEntry[]; server: string[] }) => void = () => {};
  function Probe() {
    const [input, set] = useState(initial);
    setInput = set;
    latest = useArchivedProjects(input.files, {}, input.server);
    return null;
  }
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => { root.render(<Probe />); });
  return {
    hook: () => latest!,
    update: async (value: { files: FileEntry[]; server: string[] }) => { await act(async () => { setInput(value); }); },
    unmount: () => act(() => root.unmount()),
  };
}
const flush = () => act(async () => { for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });

test("the server's shelf and this browser's older one are both read", async () => {
  dom.localStorage.setItem("llvArchivedProjects", JSON.stringify(["old-local"]));
  const mounted = await mount({ files: [], server: ["on-server"] });
  try {
    expect([...mounted.hook().archivedProjects].sort()).toEqual(["old-local", "on-server"]);
  } finally { mounted.unmount(); }
});

test("archiving draws at once, writes archived:true, and holds until the server lists it", async () => {
  let release!: (response: Response) => void;
  reply = () => new Promise<Response>((resolve) => { release = resolve; });
  const mounted = await mount({ files: [file("atlas")], server: [] });
  try {
    let answer: unknown = null;
    let pending!: Promise<void>;
    await act(async () => { pending = mounted.hook().archiveProject("atlas").then((result) => { answer = result; }); });
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(true);
    expect(puts).toEqual([{ project: "atlas", archived: true }]);
    await act(async () => { release(new Response(JSON.stringify({ ok: true }))); await pending; });
    expect(answer).toEqual({ ok: true });
    /* Before the next files answer lists it, the press still holds. */
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(true);
    await mounted.update({ files: [file("atlas")], server: ["atlas"] });
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(true);
    /* Nothing went to this browser's own storage. */
    expect(dom.localStorage.getItem("llvArchivedProjects")).toBeNull();
  } finally { mounted.unmount(); }
});

test("a refused archive draws the row back and answers the refusal's code", async () => {
  reply = async () => new Response(JSON.stringify({ error: "PROJECT_ACTIVE" }), { status: 409 });
  const mounted = await mount({ files: [file("atlas")], server: [] });
  try {
    let answer: unknown = null;
    await act(async () => { answer = await mounted.hook().archiveProject("atlas"); });
    expect(answer).toEqual({ ok: false, code: "PROJECT_ACTIVE" });
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(false);
  } finally { mounted.unmount(); }
});

test("restoring clears the project from both shelves and writes archived:false", async () => {
  dom.localStorage.setItem("llvArchivedProjects", JSON.stringify(["atlas"]));
  const mounted = await mount({ files: [], server: ["atlas"] });
  try {
    await act(async () => { await mounted.hook().unarchiveProject("atlas"); });
    expect(puts).toEqual([{ project: "atlas", archived: false }]);
    expect(JSON.parse(dom.localStorage.getItem("llvArchivedProjects")!)).toEqual([]);
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(false);
  } finally { mounted.unmount(); }
});

test("an agent working in a shelved project takes it off the shelf and tells the server once", async () => {
  dom.localStorage.setItem("llvArchivedProjects", JSON.stringify(["local-lab"]));
  const mounted = await mount({ files: [], server: ["atlas"] });
  try {
    expect([...mounted.hook().archivedProjects].sort()).toEqual(["atlas", "local-lab"]);
    const live = [file("atlas", { activity: "live" }), file("local-lab", { proc: "running" })];
    await mounted.update({ files: live, server: ["atlas"] });
    await flush();
    expect([...mounted.hook().archivedProjects]).toEqual([]);
    expect(puts).toEqual([{ project: "atlas" }]);
    expect(JSON.parse(dom.localStorage.getItem("llvArchivedProjects")!)).toEqual([]);
    /* The next poll, still before the server dropped it, sends nothing again. */
    await mounted.update({ files: [...live], server: ["atlas"] });
    await flush();
    expect(puts).toEqual([{ project: "atlas" }]);
  } finally { mounted.unmount(); }
});


test("a refused restore keeps the older local shelf", async () => {
  dom.localStorage.setItem("llvArchivedProjects", JSON.stringify(["atlas"]));
  reply = async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  const mounted = await mount({ files: [], server: [] });
  try {
    await act(async () => { await mounted.hook().unarchiveProject("atlas"); });
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(true);
    expect(JSON.parse(dom.localStorage.getItem("llvArchivedProjects")!)).toEqual(["atlas"]);
  } finally { mounted.unmount(); }
});

test("an older refused press cannot discard a newer identical press", async () => {
  const releases: Array<(response: Response) => void> = [];
  reply = () => new Promise<Response>((resolve) => releases.push(resolve));
  const mounted = await mount({ files: [], server: [] });
  try {
    let first!: Promise<unknown>, second!: Promise<unknown>;
    await act(async () => { first = mounted.hook().archiveProject("atlas"); second = mounted.hook().archiveProject("atlas"); });
    await act(async () => { releases[0]!(new Response("{}", { status: 403 })); await first; });
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(true);
    await act(async () => { releases[1]!(new Response("{}")); await second; });
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(true);
  } finally { mounted.unmount(); }
});

test("an activity restore retries unchanged polls with backoff, then persists after activity and remount", async () => {
  const timers: Array<{ run: () => void; delay: number }> = [];
  const original = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay: number) => {
    if (delay >= 1_000 && delay <= 30_000) {
      timers.push({ run, delay });
      return 123 as unknown as ReturnType<typeof setTimeout>;
    }
    return original(run, delay);
  }) as typeof setTimeout);
  reply = async () => new Response("{}", { status: 503 });
  const live = [file("atlas", { activity: "live" })];
  const server = ["atlas"];
  const mounted = await mount({ files: live, server });
  try {
    await flush();
    expect(puts).toHaveLength(1);
    expect(timers.map(timer => timer.delay)).toEqual([1_000]);
    await mounted.update({ files: live, server });
    expect(puts).toHaveLength(1);
    await mounted.update({ files: [...live], server: [...server] });
    expect(puts).toHaveLength(1);
    await act(async () => { timers.shift()!.run(); });
    await flush();
    expect(puts).toHaveLength(2);
    expect(timers.map(timer => timer.delay)).toEqual([2_000]);
    for (const delay of [4_000, 8_000, 16_000, 30_000, 30_000]) {
      await act(async () => { timers.shift()!.run(); });
      await flush();
      expect(timers.map(timer => timer.delay)).toEqual([delay]);
    }
    reply = async () => new Response("{}");
    await act(async () => { timers.shift()!.run(); });
    await flush();
    expect(puts).toEqual(Array.from({ length: 8 }, () => ({ project: "atlas" })));
    expect(timers).toHaveLength(0);
    await mounted.update({ files: [file("atlas")], server });
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(false);
    await mounted.update({ files: [file("atlas")], server: [] });
  } finally { mounted.unmount(); timer.mockRestore(); }
  const reopened = await mount({ files: [file("atlas")], server: [] });
  try { expect(reopened.hook().archivedProjects.has("atlas")).toBe(false); }
  finally { reopened.unmount(); }
});

test("activity restore cancels its pending retry on unmount", async () => {
  const original = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay: number) => {
    if (delay === 1_000) return 456 as unknown as ReturnType<typeof setTimeout>;
    return original(run, delay);
  }) as typeof setTimeout);
  const cancel = spyOn(globalThis, "clearTimeout");
  reply = async () => new Response("{}", { status: 503 });
  const mounted = await mount({ files: [file("atlas", { activity: "live" })], server: ["atlas"] });
  try {
    await flush();
    expect(puts).toHaveLength(1);
    mounted.unmount();
    expect(cancel).toHaveBeenCalledWith(456);
  } finally { timer.mockRestore(); cancel.mockRestore(); }
});


test("an already-matching server answer retires a successful local restore", async () => {
  dom.localStorage.setItem("llvArchivedProjects", JSON.stringify(["atlas"]));
  const mounted = await mount({ files: [], server: [] });
  try {
    await act(async () => { await mounted.hook().unarchiveProject("atlas"); });
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(false);
    await mounted.update({ files: [], server: ["atlas"] });
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(true);
  } finally { mounted.unmount(); }
});


test("opposing presses reach the server in order and a refusal keeps the last accepted value", async () => {
  const releases: Array<(response: Response) => void> = [];
  reply = () => new Promise<Response>((resolve) => releases.push(resolve));
  const mounted = await mount({ files: [], server: [] });
  try {
    let archive!: Promise<unknown>, restore!: Promise<unknown>;
    await act(async () => { archive = mounted.hook().archiveProject("atlas"); restore = mounted.hook().unarchiveProject("atlas"); });
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(false);
    expect(puts).toEqual([{ project: "atlas", archived: true }]);
    await act(async () => { releases[0]!(new Response("{}")); await archive; });
    expect(puts).toEqual([{ project: "atlas", archived: true }, { project: "atlas", archived: false }]);
    await act(async () => { releases[1]!(new Response("{}", { status: 403 })); await restore; });
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(true);
    await mounted.update({ files: [], server: ["atlas"] });
    await mounted.update({ files: [], server: [] });
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(false);
  } finally { mounted.unmount(); }
});


test("a successful activity restore stays restored after the agent idles and the hook reopens", async () => {
  const mounted = await mount({ files: [file("atlas", { activity: "live" })], server: ["atlas"] });
  try {
    await flush();
    await mounted.update({ files: [file("atlas")], server: ["atlas"] });
    expect(mounted.hook().archivedProjects.has("atlas")).toBe(false);
    expect(puts).toEqual([{ project: "atlas" }]);
    await mounted.update({ files: [file("atlas")], server: [] });
  } finally { mounted.unmount(); }
  const reopened = await mount({ files: [file("atlas")], server: [] });
  try { expect(reopened.hook().archivedProjects.has("atlas")).toBe(false); }
  finally { reopened.unmount(); }
});
