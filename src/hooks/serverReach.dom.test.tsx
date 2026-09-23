/**
 * Reconnecting is visible and quiet (#2071, docs/design/skeletons-and-
 * transitions.md D7).
 *
 * A deploy restarts the server for tens of seconds. The board used to say
 * nothing on the phone and turn its desktop header red ("could not be
 * loaded") for a routine restart. It now says "reconnecting · showing
 * {time}" inside the bar, where it moves nothing, and keeps the red alert and
 * the phone's offline banner for an outage of a minute or more.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { en } from "@/lib/i18n/en";

import { setRuntimeBusForTests, setRuntimeUiEnabledForTests, type RuntimeBus } from "./runtimeBus";
import { deriveServerReach, nextReachBoundary, OFFLINE_AFTER_MS, RECONNECT_FLOOR_MS, ServerReachProvider, useDerivedServerReach, type ServerReach } from "./serverReach";

const T = Date.UTC(2100, 0, 2, 14, 2);
const base = { connection: "live" as const, streamDownSince: null, streamLastEventAt: null, filesFailingSince: null, filesLastSuccessAt: null, now: T };

test("a healthy tab reads ok", () => {
  expect(deriveServerReach(base).kind).toBe("ok");
});

test("a failed files read with data on screen is a reconnect, until a minute has passed", () => {
  const failing = { ...base, filesFailingSince: T - 5_000, filesLastSuccessAt: T - 12_000 };
  expect(deriveServerReach(failing)).toEqual({ kind: "reconnecting", lastGoodAt: T - 12_000 });
  expect(deriveServerReach({ ...failing, now: T - 5_000 + OFFLINE_AFTER_MS }).kind).toBe("offline");
  /* The next change is the minute mark, met by one timer. */
  expect(nextReachBoundary(failing)).toBe(T - 5_000 + OFFLINE_AFTER_MS);
});

test("a stream blip under two seconds draws nothing; a longer one is a reconnect dated by the stream's last event; offline is offline", () => {
  const down = { ...base, connection: "reconnecting" as const, streamDownSince: T - 500, streamLastEventAt: T - 9_000 };
  expect(deriveServerReach(down).kind).toBe("ok");
  expect(nextReachBoundary(down)).toBe(T - 500 + RECONNECT_FLOOR_MS);
  /* The time shown is the last event the stream delivered, not the moment it
     was noticed down. */
  expect(deriveServerReach({ ...down, now: T - 500 + RECONNECT_FLOOR_MS })).toEqual({ kind: "reconnecting", lastGoodAt: T - 9_000 });
  expect(deriveServerReach({ ...down, connection: "offline" }).kind).toBe("offline");
});

test("the stream's polling fallback is healthy: degraded reads ok however long it lasts, with no time anywhere", () => {
  /* startFallback: SSE is blocked, the snapshot is polled every 10 s and the
     files reads answer, so the data on screen is fresh. */
  for (const elapsed of [RECONNECT_FLOOR_MS, 20_000, 10 * 60_000, 24 * 60 * 60_000]) {
    const degraded = { ...base, connection: "degraded" as const, streamDownSince: T - elapsed, streamLastEventAt: T - elapsed, now: T };
    expect(deriveServerReach(degraded)).toEqual({ kind: "ok", lastGoodAt: null });
    expect(nextReachBoundary(degraded)).toBeNull();
  }
  /* Only a failing files read on top of it makes a reconnect. */
  expect(deriveServerReach({ ...base, connection: "degraded" as const, filesFailingSince: T - 3_000, filesLastSuccessAt: T - 13_000 })).toEqual({ kind: "reconnecting", lastGoodAt: T - 13_000 });
});

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
const SAVED: Record<string, unknown> = {};
const HAS: Record<string, boolean> = {};
beforeAll(() => {
  /* The banner reads the reach, not a live stream: keep the stream off. */
  setRuntimeUiEnabledForTests(false);
  for (const key of Object.keys(OVERRIDES)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = OVERRIDES[key];
  }
});
afterAll(async () => {
  /* Let React finish its scheduled work before the DOM globals go away. */
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  for (const key of Object.keys(OVERRIDES)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
  setRuntimeUiEnabledForTests(null);
});

const { MobileBannerSlot, MobileBarTitle } = await import("@/components/mobile/MobileShell");

let roots: Root[] = [];
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  dom.document.body.replaceChildren();
});
function render(reach: ServerReach, node: React.ReactNode): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(<ServerReachProvider value={reach}>{node}</ServerReachProvider>));
  return host as unknown as HTMLElement;
}
const phone = (reach: ServerReach) => render(reach, (
  <>
    <header data-mobile2-bar><MobileBarTitle>atlas</MobileBarTitle></header>
    <MobileBannerSlot screen="board" arrival={null} />
  </>
));

test("phone, reconnecting: a quiet line under the name, inside the bar, and no banner", () => {
  const host = phone({ kind: "reconnecting", lastGoodAt: T });
  const line = host.querySelector("[data-mobile2-bar] [data-reach-line]");
  expect(line).not.toBeNull();
  expect(line!.textContent).toMatch(/^reconnecting · showing \d\d:\d\d$/);
  expect(line!.getAttribute("role")).toBe("status");
  expect(line!.className).toContain("text-muted");
  expect(host.querySelector("[data-mobile2-bar] [data-mobile2-title-text]")!.textContent).toBe("atlas");
  expect(host.querySelector("[data-mobile2-banner]")).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("phone, no time known yet: the short line", () => {
  const host = phone({ kind: "reconnecting", lastGoodAt: null });
  expect(host.querySelector("[data-reach-line]")!.textContent).toBe(en["reach.reconnectingShort"]);
});

test("phone, a minute or more: the offline banner, and the quiet line gives way to it", () => {
  const host = phone({ kind: "offline", lastGoodAt: T });
  expect(host.querySelector("[data-reach-line]")).toBeNull();
  const banner = host.querySelector('[data-mobile2-banner-kind="offline"]');
  expect(banner).not.toBeNull();
  expect(banner!.textContent).toContain(en["mobile2.banner.offlineTitle"]);
});

test("phone, healthy: just the name", () => {
  const host = phone({ kind: "ok", lastGoodAt: null });
  expect(host.querySelector("[data-reach-line]")).toBeNull();
  expect(host.querySelector("[data-mobile2-banner]")).toBeNull();
  expect(host.querySelector("[data-mobile2-bar]")!.textContent).toBe("atlas");
});

/* The hook the Viewer uses, over a stream held in one state: past the floor,
   what does the phone bar say? */
function Bar() {
  const reach = useDerivedServerReach({ catalogFailures: 0 });
  return (
    <ServerReachProvider value={reach}>
      <header data-mobile2-bar><MobileBarTitle>atlas</MobileBarTitle></header>
    </ServerReachProvider>
  );
}
async function barAfterFloor(connection: "degraded" | "reconnecting", lastEventAt: number): Promise<HTMLElement> {
  const state = { enabled: true, connection, lastEventAt, resyncedAt: null };
  setRuntimeUiEnabledForTests(true);
  setRuntimeBusForTests({ start() {}, stop() {}, subscribe: () => () => {}, getState: () => state } as unknown as RuntimeBus);
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(<Bar />));
  await new Promise((resolve) => setTimeout(resolve, RECONNECT_FLOOR_MS + 300));
  flushSync(() => undefined);
  return host as unknown as HTMLElement;
}

test("hook: the stream's healthy polling fallback puts no line and no time in the bar", async () => {
  try {
    const host = await barAfterFloor("degraded", T);
    expect(host.querySelector("[data-reach-line]")).toBeNull();
    expect(host.querySelector("[data-mobile2-bar]")!.textContent).toBe("atlas");
  } finally {
    setRuntimeBusForTests(null);
    setRuntimeUiEnabledForTests(false);
  }
});

test("hook: a stream really reconnecting shows the line with its last event's time", async () => {
  try {
    const lastEvent = new Date(2100, 0, 2, 14, 2).getTime();
    const host = await barAfterFloor("reconnecting", lastEvent);
    expect(host.querySelector("[data-reach-line]")!.textContent).toBe("reconnecting · showing 14:02");
  } finally {
    setRuntimeBusForTests(null);
    setRuntimeUiEnabledForTests(false);
  }
});
