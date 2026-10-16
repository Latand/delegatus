import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import type { TelegramReportsPayload } from "@/lib/telegram/reportContracts";

import { useTelegramReports, type TelegramReportsState } from "./useTelegramReports";

/**
 * Saving the analyst brief must report the outcome the SERVER gave (#1086
 * critique). A save the panel accepts on the client's behalf is the one bug
 * that cannot be seen from the panel: the operator rewrites the brief, the
 * request fails, the editor looks unchanged, and the next run uses the old text.
 */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
});

const originalFetch = globalThis.fetch;
let root: Root | null = null;
let latest: TelegramReportsState | null = null;

function Harness() {
  const state = useTelegramReports(true);
  useEffect(() => { latest = state; }, [state]);
  return null;
}

async function mount(): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness />);
    await Bun.sleep(0);
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  latest = null;
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
});

const payload = (promptIsDefault: boolean): TelegramReportsPayload => ({
  settings: { enabled: true, time: "10:00", groups: [], promptIsDefault },
  history: [],
  nextRunAt: "2026-08-22T07:00:00.000Z",
});

/** GET list → GET prompt → POST save, in the order the editor makes them. */
function serve(save: Response): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    if ((init?.method ?? "GET") === "POST") return save;
    if (url.includes("prompt=1")) {
      return new Response(JSON.stringify({ prompt: "Write it in Ukrainian.", defaultPrompt: "Write one report." }), { status: 200 });
    }
    return new Response(JSON.stringify({ reports: payload(true) }), { status: 200 });
  }) as unknown as typeof fetch;
}

test("a rejected prompt save keeps the editor open and announces the failure", async () => {
  serve(new Response(JSON.stringify({ code: "action_failed" }), { status: 500 }));
  await mount();
  await act(async () => { await latest!.loadPrompt(); });
  expect(latest?.prompt?.prompt).toBe("Write it in Ukrainian.");

  await act(async () => { await latest!.savePrompt("Пиши звіт українською."); });
  /* The editor is still open — its textarea still holds the operator's text —
     and the section has a failure to render above it. */
  expect(latest?.prompt).not.toBeNull();
  expect(latest?.failure?.code).toBe("action_failed");
});

test("a save the server never answered is a transport failure, not a silent success", async () => {
  serve(new Response("", { status: 200 }));
  await mount();
  await act(async () => { await latest!.loadPrompt(); });
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

  await act(async () => { await latest!.savePrompt("Пиши звіт українською."); });
  expect(latest?.prompt).not.toBeNull();
  expect(latest?.failure?.code).toBe("transport");
});

test("an accepted save closes the editor and takes the settings the save returned", async () => {
  serve(new Response(JSON.stringify({ reports: payload(false) }), { status: 200 }));
  await mount();
  await act(async () => { await latest!.loadPrompt(); });

  await act(async () => { await latest!.savePrompt("Пиши звіт українською."); });
  expect(latest?.prompt).toBeNull();
  expect(latest?.failure).toBeNull();
  /* Back on the settings view, the prompt row reads from the server's own
     answer — the acknowledgement is that state, not a client-side guess. */
  expect(latest?.reports?.settings.promptIsDefault).toBe(false);
});

/* Audit B40, B41: the report settings and the prompt show at once and lock
   nothing; a refusal puts the stored settings back and reopens the editor with
   the typed text. */
function held(): { posts: unknown[]; answer: (response: Response) => Promise<void> } {
  const posts: unknown[] = [];
  let release: (response: Response) => void = () => {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    if ((init?.method ?? "GET") === "POST") {
      posts.push(JSON.parse(String(init!.body)));
      return new Promise<Response>((resolve) => { release = resolve; });
    }
    if (url.includes("prompt=1")) return new Response(JSON.stringify({ prompt: "Write it in Ukrainian.", defaultPrompt: "Write one report." }), { status: 200 });
    return new Response(JSON.stringify({ reports: payload(true) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { posts, answer: (response) => act(async () => { release(response); await Bun.sleep(0); }) };
}

test("a settings change shows at once without locking the section, and a refusal puts the stored settings back", async () => {
  const server = held();
  await mount();
  let saving: Promise<void> = Promise.resolve();
  await act(async () => { saving = latest!.saveSettings({ enabled: false, time: "11:30", groups: [], promptIsDefault: true }); await Bun.sleep(0); });
  expect(latest?.reports?.settings.enabled).toBe(false);
  expect(latest?.reports?.settings.time).toBe("11:30");
  expect(latest?.busy).toBe(false);
  expect(server.posts).toEqual([{ action: "settings", settings: { enabled: false, time: "11:30", groups: [], promptIsDefault: true } }]);
  await server.answer(new Response(JSON.stringify({ code: "action_failed" }), { status: 500 }));
  await act(async () => { await saving; });
  expect(latest?.reports?.settings.enabled).toBe(true);
  expect(latest?.reports?.settings.time).toBe("10:00");
  expect(latest?.failure?.code).toBe("action_failed");
});

test("a prompt save closes the editor and reads as edited by you at once, and a refusal reopens it with the typed text", async () => {
  const server = held();
  await mount();
  await act(async () => { await latest!.loadPrompt(); });
  let saving: Promise<void> = Promise.resolve();
  await act(async () => { saving = latest!.savePrompt("Пиши звіт українською."); await Bun.sleep(0); });
  expect(latest?.prompt).toBeNull();
  expect(latest?.reports?.settings.promptIsDefault).toBe(false);
  expect(latest?.busy).toBe(false);
  expect(server.posts).toHaveLength(1);
  await server.answer(new Response(JSON.stringify({ code: "action_failed" }), { status: 500 }));
  await act(async () => { await saving; });
  expect(latest?.prompt?.prompt).toBe("Пиши звіт українською.");
  expect(latest?.reports?.settings.promptIsDefault).toBe(true);
  expect(latest?.failure?.code).toBe("action_failed");
});

test("two refused settings writes together leave the stored settings, not the first press's prediction", async () => {
  const posts: unknown[] = [];
  const release: Array<(response: Response) => void> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") {
      posts.push(JSON.parse(String(init!.body)));
      return new Promise<Response>((resolve) => { release.push(resolve); });
    }
    return new Response(JSON.stringify({ reports: payload(true) }), { status: 200 });
  }) as unknown as typeof fetch;
  await mount();
  const stored = latest!.reports!.settings;
  await act(async () => {
    void latest!.saveSettings({ ...stored, enabled: false });
    void latest!.saveSettings({ ...stored, enabled: false, time: "11:30" });
    await Bun.sleep(0);
  });
  expect(latest?.reports?.settings.time).toBe("11:30");
  const refusal = () => new Response(JSON.stringify({ code: "action_failed" }), { status: 500 });
  await act(async () => { release[0]!(refusal()); await Bun.sleep(0); });
  /* The newer press is still out and stays drawn. */
  expect(latest?.reports?.settings.time).toBe("11:30");
  await act(async () => { release[1]!(refusal()); await Bun.sleep(0); });
  expect(latest?.reports?.settings).toEqual(stored);
  expect(latest?.failure?.code).toBe("action_failed");
});
