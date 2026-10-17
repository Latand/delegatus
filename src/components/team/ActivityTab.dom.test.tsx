import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installActEnv } from "@/test-helpers/actEnv";
import type { TeamEvent, TeamView } from "@/lib/team/contract";

/* Audit F1: a «Load more» that fails with events on screen says so beside the
   button, which doubles as Retry; the next press clears the line. */

const dom = new Window({ url: "http://localhost", width: 1440, height: 900 });
installActEnv();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent, sessionStorage: dom.sessionStorage, localStorage: dom.localStorage });
const { ActivityTab } = await import("./ActivityTab");
const { translate } = await import("@/lib/i18n");
const originalFetch = globalThis.fetch;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; globalThis.fetch = originalFetch; });

const VIEW: TeamView = { mode: "team", me: null, members: [], methods: {} } as unknown as TeamView;
const event = (id: string, at: string): TeamEvent => ({ id, at, actor: { kind: "system" }, action: "agent.started", project: null, subject: null, detail: null }) as unknown as TeamEvent;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

test("a failed Load more says so beside the button, keeps the events, and the next press clears it and loads the page", async () => {
  const reads: string[] = [];
  let refuseMore = true;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    reads.push(url);
    if (url.includes("before=")) {
      if (refuseMore) return Response.json({ error: "busy" }, { status: 503 });
      return Response.json({ events: [event("0000000000002-bbbbbbbb", "2026-10-15T09:00:00.000Z")], members: [], projects: [], nextBefore: null });
    }
    return Response.json({ events: [event("0000000000003-aaaaaaaa", "2026-10-16T09:00:00.000Z")], members: [], projects: [], nextBefore: "0000000000003-aaaaaaaa" });
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(<ActivityTab view={VIEW} />); });
  await settle();
  const more = () => [...host.querySelectorAll("button")].find((button) => button.textContent === translate("en", "team.activity.loadMore"));
  expect(host.querySelectorAll("[data-team-event]").length).toBe(1);

  await act(async () => { more()!.click(); });
  await settle();
  expect(host.querySelector("[data-team-activity-more-failed]")?.textContent).toBe(translate("en", "team.activity.loadMoreFailed"));
  expect(host.querySelectorAll("[data-team-event]").length).toBe(1);
  expect(more()?.disabled).toBe(false);

  refuseMore = false;
  await act(async () => { more()!.click(); });
  await settle();
  expect(host.querySelector("[data-team-activity-more-failed]")).toBeNull();
  expect(host.querySelectorAll("[data-team-event]").length).toBe(2);
  expect(reads.filter((url) => url.includes("before=")).length).toBe(2);
});
