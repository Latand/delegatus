import { afterAll, beforeEach, expect, test } from "bun:test";

import {
  CONTEXT_AUTO_STORAGE_KEY,
  CONTEXT_ENTER_AFTER_MS,
  CONTEXT_EXIT_AFTER_MS,
  CONTEXT_TYPING_QUIET_MS,
  ContextModeController,
  initialContextModeState,
  nextContextDeadline,
  pressContextToggle,
  setContextAuto,
  stepContextMode,
  turnReading,
  type ContextModeInputs,
  type ContextModeState,
} from "./composerContextMode";

const base: ContextModeInputs = {
  reading: "idle", supported: true, autoEnabled: true,
  lastEditAt: null, composing: false, dictating: false, inFlight: false,
};

/** Runs the reducer the way the controller does: at each instant given, with
    the reading that holds from that instant on. */
function run(steps: Array<[at: number, patch: Partial<ContextModeInputs>]>, from: ContextModeState = initialContextModeState()) {
  let state = from;
  let inputs = base;
  for (const [at, patch] of steps) {
    inputs = { ...inputs, ...patch };
    state = stepContextMode(state, inputs, at);
  }
  return { state, inputs };
}

test("the turn axis reads running for a turn that is still being interrupted", () => {
  expect(turnReading("running")).toBe("running");
  expect(turnReading("interrupt_requested")).toBe("running");
  expect(turnReading("idle")).toBe("idle");
  expect(turnReading("unknown")).toBe("unknown");
  expect(turnReading(undefined)).toBe("unknown");
});

test("the first reading is adopted with no delay", () => {
  expect(run([[0, { reading: "running" }]]).state.shown).toBe("context");
  expect(run([[0, { reading: "idle" }]]).state.shown).toBe("normal");
});

test("a running turn that lasts under 400 ms leaves the mode normal", () => {
  const { state } = run([
    [0, { reading: "idle" }],
    [100, { reading: "running" }],
    [100 + CONTEXT_ENTER_AFTER_MS - 1, { reading: "running" }],
    [100 + CONTEXT_ENTER_AFTER_MS - 1, { reading: "idle" }],
  ]);
  expect(state.shown).toBe("normal");
  expect(state.candidate).toBeNull();
});

test("a running turn that holds for 400 ms turns context on", () => {
  const { state } = run([
    [0, { reading: "idle" }],
    [100, { reading: "running" }],
    [100 + CONTEXT_ENTER_AFTER_MS, { reading: "running" }],
  ]);
  expect(state.shown).toBe("context");
  expect(state.debouncedTurn).toBe("running");
});

test("an idle gap under 2 500 ms keeps context and records no boundary", () => {
  const held = run([
    [0, { reading: "running" }],
    [1_000, { reading: "idle" }],
    [1_000 + CONTEXT_EXIT_AFTER_MS - 1, { reading: "idle" }],
    [1_000 + CONTEXT_EXIT_AFTER_MS - 1, { reading: "running" }],
  ]);
  expect(held.state.shown).toBe("context");
  expect(held.state.debouncedTurn).toBe("running");
});

test("2 500 ms of idle returns the mode to normal and clears the override", () => {
  const { state } = run([
    [0, { reading: "running" }],
    [10, { reading: "running" }],
    [1_000, { reading: "idle" }],
    [1_000 + CONTEXT_EXIT_AFTER_MS, { reading: "idle" }],
  ]);
  expect(state.shown).toBe("normal");
  expect(state.override).toBeNull();
});

test("an unknown reading holds the mode and cancels a pending candidate", () => {
  const { state } = run([
    [0, { reading: "idle" }],
    [100, { reading: "running" }],
    [200, { reading: "unknown" }],
    [10_000, { reading: "unknown" }],
  ]);
  expect(state.shown).toBe("normal");
  expect(state.candidate).toBeNull();
  const inContext = run([[0, { reading: "running" }], [50, { reading: "unknown" }], [60_000, { reading: "unknown" }]]);
  expect(inContext.state.shown).toBe("context");
});

test("a flip due while the last edit is 1 000 ms old lands at 1 500 ms, not earlier", () => {
  const armed = run([[0, { reading: "idle" }], [1_000, { reading: "running", lastEditAt: 1_000 }]]);
  const due = 1_000 + CONTEXT_ENTER_AFTER_MS;
  const atDue = stepContextMode(armed.state, armed.inputs, due);
  expect(atDue.debouncedTurn).toBe("running");
  expect(atDue.shown).toBe("normal");
  expect(nextContextDeadline(atDue, armed.inputs, due)).toBe(1_000 + CONTEXT_TYPING_QUIET_MS);
  expect(stepContextMode(atDue, armed.inputs, 1_000 + CONTEXT_TYPING_QUIET_MS - 1).shown).toBe("normal");
  expect(stepContextMode(atDue, armed.inputs, 1_000 + CONTEXT_TYPING_QUIET_MS).shown).toBe("context");
});

test("an open composition holds the flip until it closes, then the quiet window applies", () => {
  const armed = run([[0, { reading: "idle" }], [10, { reading: "running", composing: true }], [900, { reading: "running", composing: true }]]);
  expect(armed.state.debouncedTurn).toBe("running");
  expect(armed.state.shown).toBe("normal");
  const closed = { ...armed.inputs, composing: false, lastEditAt: 5_000 };
  expect(stepContextMode(armed.state, closed, 5_000 + CONTEXT_TYPING_QUIET_MS - 1).shown).toBe("normal");
  expect(stepContextMode(armed.state, closed, 5_000 + CONTEXT_TYPING_QUIET_MS).shown).toBe("context");
});

test("dictation holds the flip and the flip lands when it ends", () => {
  const armed = run([[0, { reading: "idle" }], [10, { reading: "running", dictating: true }], [900, { reading: "running", dictating: true }]]);
  expect(armed.state.shown).toBe("normal");
  expect(stepContextMode(armed.state, { ...armed.inputs, dictating: false }, 1_000).shown).toBe("context");
});

test("an injection in flight holds the flip until its answer", () => {
  const armed = run([[0, { reading: "idle" }], [10, { reading: "running", inFlight: true }], [900, { reading: "running", inFlight: true }]]);
  expect(armed.state.shown).toBe("normal");
  expect(stepContextMode(armed.state, { ...armed.inputs, inFlight: false }, 1_000).shown).toBe("context");
});

test("a voice send in flight holds the mode across a debounced boundary in either direction", () => {
  const exit = run([[0, { reading: "running" }], [100, { reading: "running", inFlight: true }], [200, { reading: "idle", inFlight: true }], [200 + CONTEXT_EXIT_AFTER_MS + 500, { reading: "idle", inFlight: true }]]);
  expect(exit.state.shown).toBe("context");
  expect(stepContextMode(exit.state, { ...exit.inputs, inFlight: false }, 200 + CONTEXT_EXIT_AFTER_MS + 600).shown).toBe("normal");

  const enter = run([[0, { reading: "idle" }], [100, { reading: "idle", inFlight: true }], [200, { reading: "running", inFlight: true }], [200 + CONTEXT_ENTER_AFTER_MS + 500, { reading: "running", inFlight: true }]]);
  expect(enter.state.shown).toBe("normal");
  expect(stepContextMode(enter.state, { ...enter.inputs, inFlight: false }, 200 + CONTEXT_ENTER_AFTER_MS + 600).shown).toBe("context");
});

test("a manual press holds across a short idle gap and clears at the next boundary", () => {
  let { state } = run([[0, { reading: "running" }]]);
  state = pressContextToggle(state, true);
  expect(state.shown).toBe("normal");
  ({ state } = run([
    [1_000, { reading: "idle" }],
    [1_000 + CONTEXT_EXIT_AFTER_MS - 1, { reading: "idle" }],
  ], state));
  expect(state.override).not.toBeNull();
  ({ state } = run([[10_000, { reading: "idle" }], [10_000 + CONTEXT_EXIT_AFTER_MS, { reading: "idle" }]], state));
  expect(state.override).toBeNull();
  expect(state.shown).toBe("normal");
  const next = run([[20_000, { reading: "running" }], [20_000 + CONTEXT_ENTER_AFTER_MS, { reading: "running" }]], state);
  expect(next.state.shown).toBe("context");
});

test("with auto off the mode stays manual across boundaries", () => {
  const off = { autoEnabled: false };
  let state = pressContextToggle(initialContextModeState(), false);
  expect(state.shown).toBe("context");
  ({ state } = run([
    [0, { ...off, reading: "running" }],
    [10_000, { ...off, reading: "idle" }],
    [20_000, { ...off, reading: "idle" }],
  ], state));
  expect(state.shown).toBe("context");
  state = pressContextToggle(state, false);
  ({ state } = run([[30_000, { ...off, reading: "running" }], [40_000, { ...off, reading: "running" }]], state));
  expect(state.shown).toBe("normal");
});

test("switching auto on and off keeps what is displayed", () => {
  let state = pressContextToggle(initialContextModeState(), false);
  state = setContextAuto(state, true);
  expect(state.shown).toBe("context");
  expect(state.override).toBeNull();
  state = setContextAuto(state, false);
  expect(state.shown).toBe("context");
  expect(state.manual).toBe("context");
});

test("a host that cannot inject is never entered by auto, and a mode already shown is left only by the rule", () => {
  const blind = run([[0, { reading: "running", supported: false }], [1_000, { reading: "running", supported: false }]]);
  expect(blind.state.shown).toBe("normal");
  const shown = run([[0, { reading: "running" }], [50, { reading: "running", supported: false }]]);
  expect(shown.state.shown).toBe("context");
  const left = run([[1_000, { reading: "idle", supported: false }], [1_000 + CONTEXT_EXIT_AFTER_MS, { reading: "idle", supported: false }]], shown.state);
  expect(left.state.shown).toBe("normal");
});

/* The controller, with a clock in hand. */
let clock = 0;
let timers: Array<{ at: number; run: () => void; live: boolean }> = [];

function controllerAt() {
  timers = [];
  clock = 0;
  return new ContextModeController({
    now: () => clock,
    setTimer: (callback, ms) => {
      const timer = { at: clock + ms, run: callback, live: true };
      timers.push(timer);
      return timer as never;
    },
    clearTimer: (timer) => {
      (timer as unknown as { live: boolean }).live = false;
    },
  });
}

function advance(to: number) {
  for (;;) {
    const due = timers.filter((timer) => timer.live && timer.at <= to).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    clock = due.at;
    due.live = false;
    due.run();
  }
  clock = to;
}

function memoryStorage(): Storage {
  const rows = new Map<string, string>();
  return {
    get length() { return rows.size; },
    clear: () => rows.clear(),
    getItem: (key) => rows.get(key) ?? null,
    key: (index) => [...rows.keys()][index] ?? null,
    removeItem: (key) => { rows.delete(key); },
    setItem: (key, value) => { rows.set(key, String(value)); },
  };
}

beforeEach(() => {
  Object.assign(globalThis, { localStorage: memoryStorage(), sessionStorage: memoryStorage() });
});

afterAll(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
  delete (globalThis as Record<string, unknown>).sessionStorage;
});

test("the controller enters context 400 ms after the turn starts running, from its own timer", () => {
  const controller = controllerAt();
  controller.reset("card-a", true);
  controller.feed({ reading: "idle", supported: true });
  expect(controller.getSnapshot().shown).toBe("normal");
  advance(1_000);
  controller.feed({ reading: "running" });
  advance(1_399);
  expect(controller.getSnapshot().shown).toBe("normal");
  advance(1_400);
  expect(controller.getSnapshot().shown).toBe("context");
  expect(controller.getSnapshot().announcement).toBe("on");
  expect(controller.getSnapshot().followsAgent).toBe(true);
});

test("the controller holds a due flip behind typing and lands it from a timer", () => {
  const controller = controllerAt();
  controller.reset("card-a", true);
  controller.feed({ reading: "idle", supported: true });
  advance(1_000);
  controller.feed({ reading: "running" });
  advance(1_200);
  controller.noteEdit();
  advance(1_400);
  expect(controller.getSnapshot().shown).toBe("normal");
  advance(1_200 + CONTEXT_TYPING_QUIET_MS - 1);
  expect(controller.getSnapshot().shown).toBe("normal");
  advance(1_200 + CONTEXT_TYPING_QUIET_MS);
  expect(controller.getSnapshot().shown).toBe("context");
});

test("a composition holds the flip until compositionend", () => {
  const controller = controllerAt();
  controller.reset("card-a", true);
  controller.feed({ reading: "idle", supported: true });
  advance(100);
  controller.setComposing(true);
  controller.feed({ reading: "running" });
  advance(20_000);
  expect(controller.getSnapshot().shown).toBe("normal");
  controller.setComposing(false);
  advance(20_000 + CONTEXT_TYPING_QUIET_MS);
  expect(controller.getSnapshot().shown).toBe("context");
});

test("a press is never deferred, clears the announcement and holds until the boundary", () => {
  const controller = controllerAt();
  controller.reset("card-a", true);
  controller.feed({ reading: "running", supported: true });
  expect(controller.getSnapshot().shown).toBe("context");
  controller.noteEdit();
  controller.press();
  expect(controller.getSnapshot().shown).toBe("normal");
  expect(controller.getSnapshot().followsAgent).toBe(false);
  expect(controller.getSnapshot().announcement).toBeNull();
});

test("with auto off the mode is manual and survives a remount of the same conversation", () => {
  const first = controllerAt();
  first.reset("card-a", true);
  first.feed({ reading: "idle", supported: true });
  first.setAuto(false);
  expect(localStorage.getItem(CONTEXT_AUTO_STORAGE_KEY)).toBe("0");
  first.press();
  expect(first.getSnapshot().shown).toBe("context");
  first.dispose();

  const second = controllerAt();
  second.reset("card-a");
  second.feed({ reading: "idle", supported: true });
  expect(second.getSnapshot().autoEnabled).toBe(false);
  expect(second.getSnapshot().shown).toBe("context");

  const other = controllerAt();
  other.reset("card-b");
  expect(other.getSnapshot().shown).toBe("normal");
});

test("the controller's timer is cleared on dispose", () => {
  const controller = controllerAt();
  controller.reset("card-a", true);
  controller.feed({ reading: "idle", supported: true });
  advance(10);
  controller.feed({ reading: "running" });
  expect(timers.some((timer) => timer.live)).toBe(true);
  controller.dispose();
  expect(timers.some((timer) => timer.live)).toBe(false);
});
