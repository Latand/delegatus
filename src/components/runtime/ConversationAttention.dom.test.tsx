import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import * as actualRuntimeHooks from "@/hooks/useRuntime";
import { en } from "@/lib/i18n/en";
import type { CommandResult } from "@/hooks/useRuntime";
import type { FileEntry } from "@/lib/types";

import type { RuntimeAttention } from "./runtimeModel";

/*
 * A structured conversation's attention card shows the answer the moment it is
 * pressed (audit B3, row C13): the controls give way to the chosen answer, a
 * refusal brings them back with the reason, and a held answer takes no second.
 */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node,
  HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
dom.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof dom.matchMedia;

const attention = {
  id: "attention-1", conversationId: "conversation-1", kind: "permission", state: "open", unowned: false, createdAt: "2026-10-16T10:00:00.000Z",
  request: { title: "Run a command", command: "rm -rf .next", protocol: { engine: "claude" } },
} as unknown as RuntimeAttention;
const answers: { attentionId: string; resolution: unknown }[] = [];
let settleAnswer: (result: CommandResult) => void = () => {};
const actual = { ...actualRuntimeHooks };
mock.module("@/hooks/useRuntime", () => ({
  ...actual,
  useRuntimeSession: () => ({ session: { conversationId: "conversation-1", host: { state: "alive" } }, uiState: "waiting", attentions: [attention], receipts: [], legacy: false, structuredControlsEnabled: true }),
  answerRuntime: (_conversation: string, attentionId: string, resolution: unknown) => {
    answers.push({ attentionId, resolution });
    return new Promise<CommandResult>((resolve) => { settleAnswer = resolve; });
  },
}));
afterAll(() => { mock.module("@/hooks/useRuntime", () => actual); });

const { ConversationAttention } = await import("./ConversationAttention");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  answers.length = 0;
});

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<ConversationAttention file={{ path: "/c.jsonl", conversationId: "conversation-1" } as unknown as FileEntry} />));
}
const button = (label: string) => [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);

test("Allow once shows the answer at once, sends once, and a refusal brings the buttons back with the reason", async () => {
  await mount();
  await act(async () => { button(en["runtime.attention.allowOnce"])!.click(); });
  expect(document.querySelector("[data-attention-answered]")?.textContent).toBe(en["runtime.attention.answered"].replace("{answer}", en["runtime.attention.allowOnce"]));
  expect(button(en["runtime.attention.allowOnce"])).toBeUndefined();
  expect(button(en["runtime.attention.deny"])).toBeUndefined();
  /* Enter approves on an open card; on an answered one it sends nothing more. */
  await act(async () => { document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event); });
  expect(answers).toHaveLength(1);
  expect(answers[0]!.resolution).toEqual({ behavior: "allow" });

  await act(async () => { settleAnswer({ ok: false, error: "host refused" } as CommandResult); });
  expect(document.querySelector("[data-attention-answered]")).toBeNull();
  expect(button(en["runtime.attention.allowOnce"])?.hasAttribute("disabled")).toBe(false);
  expect(document.querySelector("[role=alert]")?.textContent).toBe("host refused");
});
