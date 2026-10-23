import { describe, expect, test } from "bun:test";

import { createSoundCaptionStore, MAX_CAPTIONS, RESUME_MIN_MS, VISIBLE_MS, type CueCaption } from "./captions";
import { createFakeTimers } from "./fakeTimers.fixture";

const caption = (subject: string): CueCaption => ({ what: "reply", subject, target: null });

function harness() {
  const timers = createFakeTimers(0);
  let hidden = false;
  const listeners = new Set<() => void>();
  const store = createSoundCaptionStore({
    timers,
    visibility: { hidden: () => hidden, subscribe: (onChange) => { listeners.add(onChange); return () => listeners.delete(onChange); } },
  });
  const push = (subject: string, sound: "reply" | "step" = "reply", batch = 1) => store.push({ sound, batch, captions: [caption(subject)] });
  const subjects = () => store.snapshot().map((item) => item.captions[0]!.subject);
  const setHidden = (value: boolean) => {
    hidden = value;
    for (const listener of listeners) listener();
  };
  return { store, timers, push, subjects, setHidden };
}

describe("sound caption store: the countdown", () => {
  test("a toast stays 2000 ms and then leaves", () => {
    const { timers, push, subjects } = harness();
    push("a");
    timers.advance(VISIBLE_MS - 1);
    expect(subjects()).toEqual(["a"]);
    timers.advance(1);
    expect(subjects()).toEqual([]);
  });

  test("each toast keeps its own deadline", () => {
    const { timers, push, subjects } = harness();
    push("a");
    timers.advance(700);
    push("b");
    timers.advance(1300);
    expect(subjects()).toEqual(["b"]);
    timers.advance(700);
    expect(subjects()).toEqual([]);
  });

  test("one timer serves the whole stack, and none is left when it empties", () => {
    const { timers, push, store } = harness();
    push("a");
    push("b");
    push("c");
    expect(timers.pending()).toBe(1);
    timers.advance(5000);
    expect(store.snapshot()).toEqual([]);
    expect(timers.pending()).toBe(0);
  });

  test("one play carries its batch size and every caption", () => {
    const { store } = harness();
    store.push({ sound: "step", batch: 3, captions: [caption("a"), caption("b")] });
    const [item] = store.snapshot();
    expect([item!.sound, item!.n, item!.captions.map((entry) => entry.subject)]).toEqual(["step", 3, ["a", "b"]]);
  });
});

describe("sound caption store: the bound", () => {
  test("a fifth toast removes the oldest at once, and the order is arrival order", () => {
    const { timers, push, subjects } = harness();
    for (const name of ["a", "b", "c", "d"]) {
      push(name);
      timers.advance(300);
    }
    expect(subjects()).toEqual(["a", "b", "c", "d"]);
    expect(MAX_CAPTIONS).toBe(4);
    push("e");
    expect(subjects()).toEqual(["b", "c", "d", "e"]);
  });

  test("the survivors keep their own deadlines after an eviction", () => {
    const { timers, push, subjects } = harness();
    push("a");
    timers.advance(300);
    push("b");
    timers.advance(300);
    push("c");
    timers.advance(300);
    push("d");
    push("e");
    timers.advance(1500);
    expect(subjects()).toEqual(["c", "d", "e"]);
  });
});

describe("sound caption store: hold and resume", () => {
  test("a held toast never expires, however long it is held", () => {
    const { store, timers, push, subjects } = harness();
    push("a");
    timers.advance(500);
    store.hold(true);
    timers.advance(60_000);
    expect(subjects()).toEqual(["a"]);
    expect(timers.pending()).toBe(0);
  });

  test("leaving resumes the countdown from what was left", () => {
    const { store, timers, push, subjects } = harness();
    push("a");
    timers.advance(500);
    store.hold(true);
    timers.advance(10_000);
    store.hold(false);
    timers.advance(1499);
    expect(subjects()).toEqual(["a"]);
    timers.advance(1);
    expect(subjects()).toEqual([]);
  });

  test("a toast almost out when the pointer leaves still gets 1000 ms", () => {
    const { store, timers, push, subjects } = harness();
    push("a");
    timers.advance(1900);
    store.hold(true);
    store.hold(false);
    timers.advance(RESUME_MIN_MS - 1);
    expect(subjects()).toEqual(["a"]);
    timers.advance(1);
    expect(subjects()).toEqual([]);
  });

  test("a toast pushed during a hold waits with the rest and then gets its full 2000 ms", () => {
    const { store, timers, push, subjects } = harness();
    push("a");
    timers.advance(500);
    store.hold(true);
    timers.advance(5000);
    push("b");
    timers.advance(5000);
    expect(subjects()).toEqual(["a", "b"]);
    store.hold(false);
    timers.advance(1499);
    expect(subjects()).toEqual(["a", "b"]);
    timers.advance(1);
    expect(subjects()).toEqual(["b"]);
    timers.advance(499);
    expect(subjects()).toEqual(["b"]);
    timers.advance(1);
    expect(subjects()).toEqual([]);
  });

  test("hover and focus hold apart: leaving one while the other stays keeps the stack open", () => {
    const { store, timers, push, subjects } = harness();
    push("a");
    store.hold(true, "pointer");
    store.hold(true, "focus");
    store.hold(false, "pointer");
    timers.advance(10_000);
    expect(subjects()).toEqual(["a"]);
    store.hold(false, "focus");
    timers.advance(2000);
    expect(subjects()).toEqual([]);
  });

  test("repeating a hold changes nothing", () => {
    const { store, timers, push, subjects } = harness();
    push("a");
    timers.advance(1200);
    store.hold(true);
    timers.advance(500);
    store.hold(true);
    store.hold(false);
    store.hold(false);
    timers.advance(999);
    expect(subjects()).toEqual(["a"]);
    timers.advance(1);
    expect(subjects()).toEqual([]);
  });
});

describe("sound caption store: a hidden tab holds the countdown", () => {
  test("toasts wait while the document is hidden and resume, with the floor, when it shows", () => {
    const { timers, push, subjects, setHidden } = harness();
    push("a");
    timers.advance(1500);
    setHidden(true);
    timers.advance(60_000);
    expect(subjects()).toEqual(["a"]);
    setHidden(false);
    timers.advance(RESUME_MIN_MS - 1);
    expect(subjects()).toEqual(["a"]);
    timers.advance(1);
    expect(subjects()).toEqual([]);
  });

  test("a sound that plays in a hidden tab is still on screen when the operator looks back", () => {
    const { timers, push, subjects, setHidden } = harness();
    setHidden(true);
    push("a");
    timers.advance(30_000);
    expect(subjects()).toEqual(["a"]);
    setHidden(false);
    timers.advance(VISIBLE_MS);
    expect(subjects()).toEqual([]);
  });

  test("showing the tab does not resume a toast the pointer still holds", () => {
    const { store, timers, push, subjects, setHidden } = harness();
    push("a");
    store.hold(true);
    setHidden(true);
    setHidden(false);
    timers.advance(10_000);
    expect(subjects()).toEqual(["a"]);
    store.hold(false);
    timers.advance(2000);
    expect(subjects()).toEqual([]);
  });
});

describe("sound caption store: clear, remove and subscribers", () => {
  test("clear empties the stack and stops the timer", () => {
    const { store, timers, push } = harness();
    push("a");
    push("b");
    store.clear();
    expect(store.snapshot()).toEqual([]);
    expect(timers.pending()).toBe(0);
  });

  test("remove takes one toast and leaves the others counting", () => {
    const { store, timers, push, subjects } = harness();
    push("a");
    push("b");
    store.remove(store.snapshot()[0]!.id);
    expect(subjects()).toEqual(["b"]);
    timers.advance(2000);
    expect(subjects()).toEqual([]);
  });

  test("subscribers hear every change, and the snapshot keeps its identity between changes", () => {
    const { store, timers, push } = harness();
    let heard = 0;
    const stop = store.subscribe(() => { heard += 1; });
    const empty = store.snapshot();
    expect(store.snapshot()).toBe(empty);
    push("a");
    const one = store.snapshot();
    expect(store.snapshot()).toBe(one);
    expect(one).not.toBe(empty);
    timers.advance(2000);
    expect(heard).toBe(2);
    stop();
    push("b");
    expect(heard).toBe(2);
  });
});
