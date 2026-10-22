import { describe, expect, test } from "bun:test";

import { createFocusOwner, EVENT_TAB_KEY, type FocusOwnerStorage } from "./focusOwner";

/** One device's localStorage, shared by the tabs on it. */
function deviceStorage() {
  const values = new Map<string, string>();
  const storage: FocusOwnerStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
  return { storage, values };
}

function tabs() {
  const { storage, values } = deviceStorage();
  let now = 1_000_000;
  const tab = (tabId: string) => createFocusOwner({ storage: () => storage, now: () => now, tabId });
  return { a: tab("a"), b: tab("b"), values, advance: (ms: number) => { now += ms; } };
}

describe("one device, one sound per event", () => {
  test("only the most recently focused tab plays event sounds", () => {
    const { a, b } = tabs();
    a.claim();
    expect(a.owns()).toBe(true);
    expect(b.owns()).toBe(false);
    b.claim();
    expect(a.owns()).toBe(false);
    expect(b.owns()).toBe(true);
  });

  test("with no key at all, the first tab with a sound to play claims it", () => {
    const { a, b } = tabs();
    expect(b.owns()).toBe(true);
    expect(a.owns()).toBe(false);
  });

  test("a closed owner tab stops silencing the others at pagehide", () => {
    const { a, b, values } = tabs();
    a.claim();
    expect(b.owns()).toBe(false);
    a.release();
    expect(values.has(EVENT_TAB_KEY)).toBe(false);
    expect(b.owns()).toBe(true);
  });

  test("a crashed owner tab (no pagehide) stops silencing the others after 90 s", () => {
    const { a, b, advance } = tabs();
    a.claim();
    advance(89_000);
    expect(b.owns()).toBe(false);
    advance(2_000);
    expect(b.owns()).toBe(true);
    expect(a.owns()).toBe(false);
  });

  test("an open owner keeps its key fresh with the 30 s refresh", () => {
    const { a, b, advance } = tabs();
    a.claim();
    for (let i = 0; i < 6; i++) {
      advance(30_000);
      a.refresh();
    }
    expect(b.owns()).toBe(false);
  });

  test("a tab that is not the owner neither refreshes nor removes the key", () => {
    const { a, b, values, advance } = tabs();
    a.claim();
    const held = values.get(EVENT_TAB_KEY);
    advance(10_000);
    b.refresh();
    b.release();
    expect(values.get(EVENT_TAB_KEY)).toBe(held!);
  });

  test("an unreadable key is void; no storage means every tab plays", () => {
    const { a, values } = tabs();
    values.set(EVENT_TAB_KEY, "{not json");
    expect(a.owns()).toBe(true);
    expect(createFocusOwner({ storage: () => null, now: () => 0, tabId: "x" }).owns()).toBe(true);
  });
});
