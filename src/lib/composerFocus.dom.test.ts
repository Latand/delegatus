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
