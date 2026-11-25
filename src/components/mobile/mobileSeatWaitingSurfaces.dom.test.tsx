import { afterAll, afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { emptyStore } from "@/components/runtime/runtimeModel";
import { setLocale, translate, type Locale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/*
 * The seat's finished turn reads the same word wherever the phone names it.
 *
 * The conversation bar already read «waiting · age» for an idle seat with no
 * form open, while the switcher's seat row and the ⋯ menu's head read «done»
 * for the same conversation. Each surface asks `chatStateBits` with the flag
 * the focus view derives once, so a surface that drops it fails here.
 */

const dom = new Window({ url: "http://localhost/" });
installActEnv();
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
(dom as unknown as { matchMedia(q: string): unknown }).matchMedia = (query: string) => ({
  matches: true, media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
});

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const inert = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inert, lastEventAt: null }),
  useRuntime: () => inert,
  useRuntimeEnabled: () => false,
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const { MobileConversationMenu } = await import("./MobileConversationMenu");
const { MobileSwitchSheet, switchList } = await import("./MobileSwitchSheet");

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const AGE_S = 1_044;

/** A seat whose turn ended 17 min 24 s ago and whose host is still alive. */
const seatFile = {
  path: "/repo/atlas/seat.jsonl", root: "claude-projects", name: "seat.jsonl", project: "atlas", title: "Atlas orchestrator",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: NOW_S - AGE_S, size: 1, activity: "idle",
  proc: "running", pid: 4242, conversationId: "conversation_seat", model: "opus", renamable: true,
  lastTurn: { startedAt: NOW_MS - (AGE_S + 400) * 1000, endedAt: NOW_MS - AGE_S * 1000 },
  pendingQuestion: null, waitingInput: null,
} as unknown as FileEntry;

let roots: Root[] = [];
function mount(node: React.ReactNode): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  act(() => { root.render(node); });
  return host as unknown as HTMLElement;
}

function switcher(props: { seatWaiting?: boolean; decisionWaiting?: boolean }): HTMLElement {
  const entries = switchList([{ key: seatFile.path, file: seatFile }], { seatKey: seatFile.path, nowMs: NOW_MS });
  return mount(
    <MobileSwitchSheet title="atlas" entries={entries} currentKey={null} nowMs={NOW_MS} onPick={() => undefined} onClose={() => undefined} {...props} />,
  );
}

function menu(props: { seatWaiting?: boolean; decisionWaiting?: boolean }): HTMLElement {
  return mount(
    <MobileConversationMenu
      file={seatFile} stage={null} crowned={false} hostTaskCount={0} projectName="atlas"
      onRename={() => undefined} onOpenHost={() => undefined} onClose={() => undefined} {...props}
    />,
  );
}

const phrase = (host: HTMLElement) => host.querySelector("[data-mobile2-state-phrase]") as unknown as HTMLElement;

beforeEach(() => {
  setLocale("en");
  /* The menu head reads the wall clock for the age, so the clock stands still. */
  setSystemTime(new Date(NOW_MS));
});
afterEach(async () => {
  setSystemTime();
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  dom.document.body.replaceChildren();
});
afterAll(() => mock.module("@/hooks/useRuntime", () => actualRuntimeHooks));

for (const locale of ["en", "uk"] as Locale[]) {
  const waitingWord = () => translate(locale, "mobile2.chat.stateWaiting").split("{")[0]!;
  const doneWord = () => translate(locale, "mobile2.chat.stateDone").split("{")[0]!;

  test(`${locale}: the switcher's seat row reads «waiting · age» in the quiet tone`, () => {
    setLocale(locale);
    const el = phrase(switcher({ seatWaiting: true }));
    expect(el.textContent!.startsWith(waitingWord())).toBe(true);
    expect(el.textContent).toContain("17");
    expect(el.getAttribute("data-mobile2-state-phrase")).toBe("neutral");
  });

  test(`${locale}: the ⋯ menu head reads «waiting · age» in the quiet tone`, () => {
    setLocale(locale);
    const el = phrase(menu({ seatWaiting: true }));
    expect(el.textContent!.startsWith(waitingWord())).toBe(true);
    expect(el.getAttribute("data-mobile2-state-phrase")).toBe("neutral");
  });

  test(`${locale}: an open decision form keeps the seat's waiting word with its own tone on both surfaces`, () => {
    setLocale(locale);
    for (const el of [phrase(switcher({ seatWaiting: true, decisionWaiting: true })), phrase(menu({ seatWaiting: true, decisionWaiting: true }))]) {
      expect(el.textContent!.startsWith(waitingWord())).toBe(true);
      expect(el.getAttribute("data-mobile2-state-phrase")).toBe("warning");
    }
  });

  test(`${locale}: a conversation that is not an idle seat still reads «done»`, () => {
    setLocale(locale);
    expect(phrase(switcher({})).textContent!.startsWith(doneWord())).toBe(true);
    expect(phrase(menu({})).textContent!.startsWith(doneWord())).toBe(true);
  });
}

test("only the seat's own row speaks the seat's waiting reading", () => {
  const other = { ...seatFile, path: "/repo/atlas/other.jsonl", name: "other.jsonl", conversationId: "conversation_other" } as FileEntry;
  const entries = switchList([{ key: seatFile.path, file: seatFile }, { key: other.path, file: other }], { seatKey: seatFile.path, nowMs: NOW_MS });
  const host = mount(<MobileSwitchSheet title="atlas" entries={entries} currentKey={null} nowMs={NOW_MS} seatWaiting onPick={() => undefined} onClose={() => undefined} />);
  const rows = [...host.querySelectorAll("[data-mobile2-state-phrase]")] as unknown as HTMLElement[];
  expect(rows).toHaveLength(2);
  const words = rows.map((row) => row.textContent!.split(" ")[0]);
  expect(words).toContain(translate("en", "mobile2.chat.stateWaiting").split(" ")[0]);
  expect(words).toContain(translate("en", "mobile2.chat.stateDone").split(" ")[0]);
});
