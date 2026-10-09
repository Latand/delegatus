import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { RelayChatsPayload } from "@/lib/externalRelay/relayChats";
import type { FileEntry } from "@/lib/types";

/*
 * The relay's chats in the conversation list (relay-slice3.md §4): one row per
 * chat and context in the words of the operator's language, no row offering
 * to delete, and a row opening the conversation in the agent window whose
 * reader is read only. The reader itself is BranchPane, recorded here by its
 * props; the browser driver draws the real one.
 */

const dom = new Window();
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = () => ({
  matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
});
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) => dom.setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: number) => dom.clearTimeout(id as never),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const panes: { file: FileEntry; readOnly?: boolean; noComposer?: boolean }[] = [];
mock.module("@/components/BranchPane", () => ({
  BranchPane: (props: { file: FileEntry; readOnly?: boolean; noComposer?: boolean; chrome?: { header: unknown; attributes?: Record<string, string> } }) => {
    panes.push(props);
    return <section data-fake-pane={props.file.path} {...props.chrome?.attributes}>{props.chrome?.header as never}</section>;
  },
}));

const { RelayChatsView, relayChatsCatalog, relayChatTitle, useRelayChats } = await import("./RelayChats");
const { setLocale, translate } = await import("@/lib/i18n");

const file = (id: string, mtime: number): FileEntry => ({
  path: `/accounts/claude/main/projects/-tmp-llv-relay-conv-${id}/${id}.jsonl`, root: "claude-projects", name: `${id}.jsonl`,
  project: "relay-chats-relay-1", projectName: "Example relay", title: "server title", engine: "claude", kind: "session", fmt: "claude",
  parent: null, mtime, size: 400, activity: "idle", proc: null, pid: null, model: "opus", pendingQuestion: null, waitingInput: null,
});
const chat = (id: string, over: Partial<RelayChatsPayload["chats"][number]> = {}): RelayChatsPayload["chats"][number] => ({
  id, relayId: "relay-1", relayName: "Example relay", targetId: "bot-1", targetName: "Support bot", chatKey: "QmF6x9Lk2pTw7RzA", context: "member",
  engine: "claude", turns: 3, compactions: 0, createdAt: "2026-10-09T08:00:00.000Z", lastTurnAt: "2026-10-09T09:00:00.000Z", state: "idle",
  file: file(id, 1_791_540_000), ...over,
});
const payload: RelayChatsPayload = {
  relays: [{ id: "relay-1", name: "Example relay", origin: "https://relay.example" }, { id: "relay-2", name: "Quiet relay", origin: "https://quiet.example" }],
  chats: [
    chat("c1"),
    chat("c2", { context: "owner" }),
    chat("c3", { chatKey: "Zt81sKe04VbHn2Qd", targetName: null, targetId: "gone" }),
    /* Its first turn wrote nothing yet: there is nothing to open. */
    chat("c4", { file: null }),
    /* The second relay holds only such a chat, so it gets no sidebar entry. */
    chat("c5", { relayId: "relay-2", relayName: "Quiet relay", file: null }),
  ],
};

let mounted: { root: Root; host: HTMLElement } | null = null;
afterEach(async () => {
  if (mounted) { const { root, host } = mounted; await act(async () => root.unmount()); host.remove(); mounted = null; }
  panes.length = 0;
  setLocale("en");
});
async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(node));
  return host;
}

test("each relay whose chats hold a conversation is one sidebar entry under its name, drawn as current", () => {
  expect(relayChatsCatalog(null)).toEqual([]);
  expect(relayChatsCatalog(payload)).toEqual([{ project: "relay-chats-relay-1", displayName: "Example relay", conversations: 3, smt: 1_791_540_000, recent: true }]);
});

test("a row names the chat, whose session it is and the target, in English and Ukrainian", () => {
  const en = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("en", key, params);
  const uk = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("uk", key, params);
  expect(relayChatTitle(en, payload.chats[0]!)).toBe("Chat QmF6x9 · members · Support bot");
  expect(relayChatTitle(uk, payload.chats[1]!)).toBe("Чат QmF6x9 · власник · Support bot");
  expect(relayChatTitle(en, payload.chats[2]!)).toBe("Chat Zt81sK · members");
});

test("the leaf lists the chats with a transcript, offers no delete, and opens one read only in the agent window", async () => {
  const host = await mount(<RelayChatsView relayId="relay-1" payload={payload} />);
  const rows = Array.from(host.querySelectorAll<HTMLElement>("[data-relay-chat]"));
  expect(rows.map((row) => row.getAttribute("data-relay-chat"))).toEqual(["c1", "c2", "c3"]);
  expect(rows[1]!.getAttribute("data-relay-chat-context")).toBe("owner");
  expect(rows[0]!.textContent).toContain("Chat QmF6x9 · members · Support bot");
  /* The ordinary conversation row, with its delete control left out. */
  expect(rows.every((row) => row.querySelectorAll("button").length === 1)).toBe(true);
  expect(host.querySelector("[data-relay-chats-count]")?.textContent).toBe("3");

  await act(async () => rows[0]!.querySelector("button")!.click());
  expect(host.querySelector("[data-agent-window]")?.getAttribute("data-agent-window")).toBe("c1");
  expect(panes.at(-1)).toMatchObject({ readOnly: true });
  expect(panes.at(-1)!.file.title).toBe("Chat QmF6x9 · members · Support bot");
  expect(host.querySelector("[data-relay-chat-read-only]")?.textContent).toBe("Read only");

  /* Esc leaves the window; the next row opens beside the first. */
  await act(async () => { document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event); });
  expect(host.querySelector("[data-agent-window]")).toBeNull();
  await act(async () => rows[1]!.querySelector("button")!.click());
  expect(Array.from(host.querySelectorAll("[data-open-agent]")).map((row) => row.getAttribute("data-open-agent"))).toEqual(["c1", "c2"]);
  expect(host.querySelector("[data-agent-window]")?.getAttribute("data-agent-window")).toBe("c2");
  /* Closing the one shown hands the reader to the other; closing the last closes the window. */
  await act(async () => host.querySelector<HTMLButtonElement>('[data-open-agent-close="c2"]')!.click());
  expect(host.querySelector("[data-agent-window]")?.getAttribute("data-agent-window")).toBe("c1");
  await act(async () => host.querySelector<HTMLButtonElement>('[data-open-agent-close="c1"]')!.click());
  expect(host.querySelector("[data-agent-window]")).toBeNull();
});

test("a relay with no conversation to open says so, in Ukrainian too", async () => {
  setLocale("uk");
  const host = await mount(<RelayChatsView relayId="relay-2" payload={payload} />);
  expect(host.querySelectorAll("[data-relay-chat]")).toHaveLength(0);
  expect(host.querySelector("[data-relay-chats-state]")?.getAttribute("data-relay-chats-state")).toBe("empty");
  expect(host.querySelector("[data-relay-chats-state]")?.textContent).toContain("Жоден чат ще не має розмови.");
});

test("the poll keeps nothing from a route that refuses this Viewer", async () => {
  const previous = globalThis.fetch;
  const answers: Response[] = [Response.json({ error: "operator_only" }, { status: 403 })];
  globalThis.fetch = (async () => answers.shift() ?? Response.json(payload)) as unknown as typeof fetch;
  let seen: RelayChatsPayload | null | undefined;
  function Probe() { seen = useRelayChats(); return null; }
  try {
    await mount(<Probe />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(seen).toBeNull();
  } finally { globalThis.fetch = previous; }
});
