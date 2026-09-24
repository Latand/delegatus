import { afterEach, expect, test } from "bun:test";

import { navigateToFragment, setFragmentNavigator } from "./fragmentNavigation";

/* The one door for in-app fragment navigation (#2105): the phone's Viewer
   serves it so the navigation store writes the entry; unserved, the fragment
   is assigned as before. */

const assigned: string[] = [];
const original = (globalThis as { window?: unknown }).window;
afterEach(() => {
  assigned.length = 0;
  (globalThis as { window?: unknown }).window = original;
});

function fakeWindow() {
  (globalThis as { window?: unknown }).window = { location: { set hash(value: string) { assigned.push(value); } } };
}

test("a served navigation writes no fragment; a release hands it back to the plain assignment", () => {
  fakeWindow();
  const seen: string[] = [];
  const release = setFragmentNavigator((hash) => { seen.push(hash); return true; });
  navigateToFragment("#c=conversation_a");
  expect(seen).toEqual(["#c=conversation_a"]);
  expect(assigned).toEqual([]);
  release();
  navigateToFragment("#p=atlas");
  expect(assigned).toEqual(["#p=atlas"]);
});

test("a fragment the navigator declines is assigned", () => {
  fakeWindow();
  const release = setFragmentNavigator(() => false);
  navigateToFragment("#a=notes.md");
  expect(assigned).toEqual(["#a=notes.md"]);
  release();
});

test("a stale release leaves the navigator that replaced it", () => {
  fakeWindow();
  const seen: string[] = [];
  const first = setFragmentNavigator(() => true);
  const second = setFragmentNavigator((hash) => { seen.push(hash); return true; });
  first();
  navigateToFragment("#c=conversation_b");
  second();
  expect(seen).toEqual(["#c=conversation_b"]);
  expect(assigned).toEqual([]);
});
