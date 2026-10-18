import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { COMPOSER_FOCUS_ATTRIBUTE, watchComposerFocus } from "./composerFocus";

const dom = new Window();
const root = dom.document as unknown as Document;
const marked = () => root.documentElement.hasAttribute(COMPOSER_FOCUS_ATTRIBUTE);

afterEach(() => { root.body.replaceChildren(); });

function field(composer: boolean): HTMLTextAreaElement {
  const el = root.createElement("textarea");
  if (composer) el.setAttribute("data-composer-field", "");
  root.body.append(el);
  return el;
}

test("the document is marked while a composer field has the focus and clear when it loses it", () => {
  const stop = watchComposerFocus(root);
  const composer = field(true);
  composer.focus();
  expect(marked()).toBe(true);
  composer.blur();
  expect(marked()).toBe(false);
  stop();
});

test("focus on any other field leaves the animations running", () => {
  const stop = watchComposerFocus(root);
  field(false).focus();
  expect(marked()).toBe(false);
  stop();
});

test("a field already focused when the watch starts is picked up, and the last stop clears the mark", () => {
  const composer = field(true);
  composer.focus();
  const first = watchComposerFocus(root);
  expect(marked()).toBe(true);
  const second = watchComposerFocus(root);
  first();
  expect(marked()).toBe(true);
  second();
  expect(marked()).toBe(false);
});

test("a second document registered beside the first gets its own watch and the mark follows either", () => {
  const other = new Window().document as unknown as Document;
  const stopMain = watchComposerFocus(root);
  const stopOther = watchComposerFocus(other);
  const floating = other.createElement("textarea");
  floating.setAttribute("data-composer-field", "");
  other.body.append(floating);
  floating.focus();
  expect(other.documentElement.hasAttribute(COMPOSER_FOCUS_ATTRIBUTE)).toBe(true);
  expect(marked()).toBe(true);
  floating.blur();
  expect(other.documentElement.hasAttribute(COMPOSER_FOCUS_ATTRIBUTE)).toBe(false);
  expect(marked()).toBe(false);
  /* Releasing the floating window's watch leaves the opener's running. */
  stopOther();
  const composer = field(true);
  composer.focus();
  expect(marked()).toBe(true);
  stopMain();
  expect(marked()).toBe(false);
});

test("a release is counted once", () => {
  const first = watchComposerFocus(root);
  const second = watchComposerFocus(root);
  first();
  first();
  const composer = field(true);
  composer.focus();
  expect(marked()).toBe(true);
  second();
  expect(marked()).toBe(false);
});
