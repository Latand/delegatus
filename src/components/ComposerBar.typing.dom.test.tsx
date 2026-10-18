import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useEffect } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { useComposer } from "@/hooks/useComposer";
import { COMPOSER_FOCUS_ATTRIBUTE } from "@/lib/composerFocus";

import { ComposerBar } from "./ComposerBar";

/*
 * The draft is not state of the composer's owner. The pane composer is a
 * 6,000-line subtree owned by whoever calls `useComposer`; every keystroke used
 * to re-render all of it. Now the textarea subscribes to the draft itself, and
 * the owner renders again only when the one fact it reads — whether anything is
 * typed — changes.
 */

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

/* The React handlers are called directly, the way the other composer tests
   drive the field: the DOM's own input event does not reach them under the
   test DOM. A real browser delivers the same event objects. */
function props(field: HTMLTextAreaElement): Record<string, (event: unknown) => void> {
  return (field as unknown as Record<string, Record<string, (event: unknown) => void>>)[Object.keys(field).find((key) => key.startsWith("__reactProps$"))!]!;
}
function type(field: HTMLTextAreaElement, value: string) {
  flushSync(() => {
    field.value = value;
    props(field).onChange!({ target: field });
  });
}
function press(field: HTMLTextAreaElement, key: string) {
  let prevented = false;
  flushSync(() => {
    props(field).onKeyDown!({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, nativeEvent: { isComposing: false }, currentTarget: field, preventDefault() { prevented = true; } });
  });
  return prevented;
}

interface Probe { ownerRenders: number; persisted: string[]; composer: ReturnType<typeof useComposer> | null; submitted: string[] }
/* What the mounted owner reports; replaced for every case by `mount`. */
const probe: Probe = { ownerRenders: 0, persisted: [], composer: null, submitted: [] };

function Owner({ initial = "" }: { initial?: string }) {
  useEffect(() => { probe.ownerRenders += 1; });
  const composer = useComposer({
    initialText: () => initial,
    persistText: (value) => { probe.persisted.push(value); },
    submit: () => { probe.submitted.push(composer.textRef.current); },
  });
  useEffect(() => { probe.composer = composer; });
  return (
    <ComposerBar
      composer={composer}
      placeholder="Prompt"
      textareaAriaLabel="Prompt"
      imageAriaLabel="Add images"
      leftSlot={null}
      sendLabelIdle="Send"
      sendLabelRecording="Stop"
      sendIdleClassName="bg-accent"
    />
  );
}

function mount(initial = ""): { probe: Probe; field: HTMLTextAreaElement; send: HTMLButtonElement } {
  Object.assign(probe, { ownerRenders: 0, persisted: [], composer: null, submitted: [] });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<Owner initial={initial} />));
  return { probe, field: host.querySelector("textarea")!, send: host.querySelector('button[aria-label="Send"]') as HTMLButtonElement };
}

test("typing renders the textarea, not the owner of the composer", () => {
  const { probe, field } = mount();
  const afterMount = probe.ownerRenders;
  let text = "";
  for (const character of "hello world, how are the lanes?") {
    text += character;
    type(field, text);
    expect(field.value).toBe(text);
  }
  /* Only the first character changes what the owner reads (an empty draft
     becomes a sendable one); the other thirty add nothing to it. */
  expect(probe.ownerRenders - afterMount).toBe(1);
  expect(probe.composer!.textRef.current).toBe(text);
  expect(probe.persisted.at(-1)).toBe(text);
  expect(probe.persisted.length).toBe(text.length);
});

test("emptying the draft and refilling it tells the owner each time and keeps Send in step", () => {
  const { probe, field, send } = mount();
  expect(send.disabled).toBe(true);
  type(field, "a");
  expect(probe.composer!.canSend).toBe(true);
  expect(send.disabled).toBe(false);
  type(field, "ab");
  type(field, "");
  expect(send.disabled).toBe(true);
  expect(probe.composer!.hasText).toBe(false);
  type(field, "   ");
  expect(probe.composer!.hasText).toBe(false);
  type(field, "x");
  expect(send.disabled).toBe(false);
});

test("a draft restored from storage fills the field and counts as typed", () => {
  const { probe, field } = mount("restored draft");
  expect(field.value).toBe("restored draft");
  expect(probe.composer!.hasText).toBe(true);
  expect(probe.composer!.canSend).toBe(true);
});

test("setText from outside the field reaches the field and every reader of the ref", () => {
  const { probe, field } = mount();
  flushSync(() => probe.composer!.setText("from a recalled message"));
  expect(field.value).toBe("from a recalled message");
  flushSync(() => probe.composer!.setText((previous) => previous + "!"));
  expect(field.value).toBe("from a recalled message!");
  expect(probe.composer!.textRef.current).toBe("from a recalled message!");
  expect(probe.composer!.draftRevision.current).toBe(2);
});

test("a restore without persisting updates the field and leaves storage alone", () => {
  const { probe, field } = mount();
  flushSync(() => probe.composer!.setTextState("dropped link text"));
  expect(field.value).toBe("dropped link text");
  expect(probe.persisted).toEqual([]);
});

test("Enter submits the text typed so far without waiting for the owner to render", () => {
  const { probe, field } = mount();
  type(field, "ship it");
  expect(press(field, "Enter")).toBe(true);
  expect(probe.submitted).toEqual(["ship it"]);
});

test("the field carries the marker the typing watch looks for, and focusing it marks the document", () => {
  const { field } = mount();
  expect(field.hasAttribute("data-composer-field")).toBe(true);
  field.focus();
  expect(document.documentElement.hasAttribute(COMPOSER_FOCUS_ATTRIBUTE)).toBe(true);
  field.blur();
  expect(document.documentElement.hasAttribute(COMPOSER_FOCUS_ATTRIBUTE)).toBe(false);
});

test("a composer portalled into the floating window marks that window's document, and the opener's too, while a main-window composer stays mounted", () => {
  const pip = new Window();
  const pipDocument = pip.document as unknown as Document;
  (pip as unknown as { matchMedia(query: string): unknown }).matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  const host = document.createElement("div");
  document.body.append(host);
  const pipHost = pipDocument.createElement("div");
  pipDocument.body.append(pipHost);
  root = createRoot(host);
  flushSync(() => root!.render(<>
    <Owner />
    {createPortal(<Owner />, pipHost)}
  </>));
  const main = host.querySelector("textarea")!;
  const floating = pipHost.querySelector("textarea")!;
  expect(floating.ownerDocument).toBe(pipDocument);
  const marked = (target: Document) => target.documentElement.hasAttribute(COMPOSER_FOCUS_ATTRIBUTE);
  floating.focus();
  expect(marked(pipDocument)).toBe(true);
  expect(marked(document)).toBe(true);
  floating.blur();
  expect(marked(pipDocument)).toBe(false);
  expect(marked(document)).toBe(false);
  main.focus();
  expect(marked(document)).toBe(true);
  main.blur();
  expect(marked(document)).toBe(false);
  flushSync(() => root!.unmount());
  root = null;
  floating.focus();
  expect(marked(pipDocument)).toBe(false);
});
