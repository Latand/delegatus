import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { Snapshot } from "@/lib/selfUpdate/types";

import { AutoDrainDecision } from "./AutoDrainDecision";
import { selfUpdateTicket, useSelfUpdateFeed, type Feed } from "./useSelfUpdateFeed";

/* The Update surface's feed reads the install every second while the stream
   is down, and a read can take longer than that: the reads overlap and finish
   in any order. What is shown is the newest read that finished, never an
   older one that finished after it, and an old failure never covers a newer
   answer. */

const dom = new Window({ url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
const overrides: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  // No stream: the feed polls from the start.
  EventSource: undefined,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const savedGlobals = new Map<string, { present: boolean; value: unknown }>();

beforeAll(() => {
  for (const [key, value] of Object.entries(overrides)) {
    savedGlobals.set(key, { present: key in globals, value: globals[key] });
    globals[key] = value;
  }
});

afterAll(() => {
  for (const [key, saved] of savedGlobals) {
    if (saved.present) globals[key] = saved.value;
    else delete globals[key];
  }
  void dom.happyDOM.close();
});

const OLD = "b".repeat(40);
const NEWER = "c".repeat(40);
const snapshotOf = (sha: string) => ({ installed: { sha, short: sha.slice(0, 7), version: "1.0.0", date: "" } }) as unknown as Snapshot;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Each GET the feed makes, answered by hand in any order. */
function answers() {
  const calls: { resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
  const fetcher = (() => new Promise<Response>((resolve, reject) => { calls.push({ resolve, reject }); })) as unknown as typeof fetch;
  return { fetcher, calls };
}

async function mountFeed(): Promise<{ feed: () => Feed; unmount: () => void }> {
  let latest: Feed | null = null;
  function Probe() {
    latest = useSelfUpdateFeed(true);
    return null;
  }
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => { root.render(<Probe />); });
  return { feed: () => latest!, unmount: () => act(() => root.unmount()) };
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
/** Until the feed has made `count` reads; it reads once a second. */
async function readsMade(calls: unknown[], count: number) {
  const deadline = Date.now() + 3_000;
  while (calls.length < count && Date.now() < deadline) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(calls.length).toBeGreaterThanOrEqual(count);
}

test("a read that finishes after a newer one never replaces what the newer one showed", async () => {
  const originalFetch = globalThis.fetch;
  const { fetcher, calls } = answers();
  globalThis.fetch = fetcher;
  const mounted = await mountFeed();
  try {
    await readsMade(calls, 2);
    await act(async () => { calls[1]!.resolve(json(snapshotOf(NEWER))); });
    await settle();
    expect(mounted.feed().snapshot?.installed.sha).toBe(NEWER);
    await act(async () => { calls[0]!.resolve(json(snapshotOf(OLD))); });
    await settle();
    expect(mounted.feed().snapshot?.installed.sha).toBe(NEWER);
    expect(mounted.feed().offline).toBe(false);
  } finally {
    mounted.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("an older read's failure never covers a newer answer, and a fresh answer after a failure is shown", async () => {
  const originalFetch = globalThis.fetch;
  const { fetcher, calls } = answers();
  globalThis.fetch = fetcher;
  const mounted = await mountFeed();
  try {
    await readsMade(calls, 2);
    await act(async () => { calls[1]!.resolve(json(snapshotOf(NEWER))); });
    await settle();
    await act(async () => { calls[0]!.reject(new Error("connection reset")); });
    await settle();
    expect(mounted.feed().offline).toBe(false);
    await readsMade(calls, 3);
    await act(async () => { calls[2]!.resolve(json({ code: "snapshot-failed", error: "launcher record unreadable" }, 503)); });
    await settle();
    expect(mounted.feed().failure).toBe("launcher record unreadable");
    expect(mounted.feed().snapshot?.installed.sha).toBe(NEWER);
    await readsMade(calls, 4);
    await act(async () => { calls[3]!.resolve(json(snapshotOf(OLD))); });
    await settle();
    expect(mounted.feed().failure).toBeNull();
    expect(mounted.feed().snapshot?.installed.sha).toBe(OLD);
  } finally {
    mounted.unmount();
    globalThis.fetch = originalFetch;
  }
});

/* #2594: an action's answer is one more source of the same snapshots. It is
   ordered by when the action was sent, so an answer that comes back after a
   newer read was shown (the old revision, its "commits behind") is dropped,
   while the action's own outcome stays. */
test("an action's answer that comes back after a newer read was shown never replaces it", async () => {
  const originalFetch = globalThis.fetch;
  const { fetcher, calls } = answers();
  globalThis.fetch = fetcher;
  const mounted = await mountFeed();
  try {
    await readsMade(calls, 1);
    const action = selfUpdateTicket();
    await readsMade(calls, 2);
    await act(async () => { calls[1]!.resolve(json(snapshotOf(NEWER))); });
    await settle();
    expect(mounted.feed().snapshot?.installed.sha).toBe(NEWER);
    await act(async () => { mounted.feed().accept(snapshotOf(OLD), action); });
    expect(mounted.feed().snapshot?.installed.sha).toBe(NEWER);
    // An action sent after that read answers with what is newest.
    const later = selfUpdateTicket();
    await act(async () => { mounted.feed().accept(snapshotOf(OLD), later); });
    expect(mounted.feed().snapshot?.installed.sha).toBe(OLD);
  } finally {
    mounted.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("a refused drain decision's snapshot that comes back after a newer read never replaces it, and the refusal is still said", async () => {
  const originalFetch = globalThis.fetch;
  const { fetcher, calls } = answers();
  let refuse!: (response: Response) => void;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith("/api/self-update/auto")
    ? new Promise<Response>((resolve) => { refuse = resolve; })
    : fetcher(input, init)) as typeof fetch;
  const mounted = await mountFeed();
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  try {
    await act(async () => { root.render(<AutoDrainDecision decision={{ id: "drain-current", blockers: null } as never} />); });
    await readsMade(calls, 1);
    await act(async () => { (host.querySelector("[data-action='keep-waiting']") as unknown as HTMLButtonElement).click(); });
    await readsMade(calls, 2);
    await act(async () => { calls[1]!.resolve(json(snapshotOf(NEWER))); });
    await settle();
    expect(mounted.feed().snapshot?.installed.sha).toBe(NEWER);
    await act(async () => { refuse(json({ error: "This automatic update decision is no longer pending", code: "auto-switch-superseded", snapshot: { ...snapshotOf(OLD), meta: {} } }, 409)); });
    await settle();
    expect(mounted.feed().snapshot?.installed.sha).toBe(NEWER);
    expect(host.querySelector("[role='alert']")?.textContent).toBeTruthy();
  } finally {
    act(() => root.unmount());
    host.remove();
    mounted.unmount();
    globalThis.fetch = originalFetch;
  }
});
