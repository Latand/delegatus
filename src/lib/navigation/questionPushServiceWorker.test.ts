import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { NOTIFICATION_OPEN_MESSAGE } from "./fragmentNavigation";

/*
 * The notification service worker (`public/question-push-sw.js`, #2105): a
 * tapped notification hands its link to the open tab, which opens it as an
 * in-app link — one history entry over the place the operator was — and
 * answers. Only a tab that does not answer is navigated by the worker, as
 * before; with no tab at all the worker opens one.
 */

type Handler = (event: unknown) => void;

function loadWorker(clients: unknown[]) {
  const handlers: Record<string, Handler> = {};
  const opened: string[] = [];
  const self = {
    addEventListener: (type: string, handler: Handler) => { handlers[type] = handler; },
    clients: { matchAll: async () => clients, openWindow: async (url: string) => { opened.push(url); return null; } },
    registration: { showNotification: async () => {} },
  };
  new Function("self", fs.readFileSync(path.resolve("public/question-push-sw.js"), "utf8"))(self);
  return { handlers, opened };
}

function tab(answers: boolean) {
  const calls: unknown[] = [];
  const client = {
    calls,
    focus: async () => { calls.push("focus"); return client; },
    navigate: async (url: string) => { calls.push(["navigate", url]); return client; },
    postMessage: (data: { type: string; url: string }, ports: MessagePort[]) => {
      calls.push(["message", data.type, data.url]);
      if (answers) ports[0]!.postMessage("taken");
    },
  };
  return client;
}

async function tap(handlers: Record<string, Handler>, url: string) {
  let work: Promise<unknown> = Promise.resolve();
  let closed = false;
  handlers.notificationclick!({ notification: { close: () => { closed = true; }, data: { url } }, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
  await work;
  return closed;
}

const url = "/#c=conversation_a#question";

test("a tab that answers takes the link, and the worker does not navigate it", async () => {
  const client = tab(true);
  const { handlers } = loadWorker([client]);
  expect(await tap(handlers, url)).toBe(true);
  expect(client.calls).toEqual(["focus", ["message", NOTIFICATION_OPEN_MESSAGE, url]]);
});

test("a tab that does not answer is navigated by the worker, as before", async () => {
  const client = tab(false);
  const { handlers } = loadWorker([client]);
  await tap(handlers, url);
  expect(client.calls).toEqual(["focus", ["message", NOTIFICATION_OPEN_MESSAGE, url], ["navigate", url], "focus"]);
}, 10_000);

test("with no tab open, the worker opens one on the link", async () => {
  const { handlers, opened } = loadWorker([]);
  await tap(handlers, url);
  expect(opened).toEqual([url]);
});
