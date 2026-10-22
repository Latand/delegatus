import { beforeEach, describe, expect, test } from "bun:test";

import { createCuePlayer, distantIntervalMs, TYPING_VOICES, type CueContext, type CuePrefs, type CueTransport, type EventStartRequest, type TypingStartRequest } from "./cuePlayer";
import type { AudioCue, CueRequest } from "./cues";
import { createFakeTimers } from "./fakeTimers.fixture";

/** A transport that records what it was asked to play and can refuse, the way a locked graph does. */
function recorder(options: { refuse?: boolean } = {}) {
  const typing: TypingStartRequest[] = [];
  const events: EventStartRequest[] = [];
  const cut: string[] = [];
  const transport: CueTransport = {
    startTyping(request) {
      if (options.refuse) return null;
      typing.push(request);
      return { stop: () => undefined };
    },
    startEvent(request) {
      if (options.refuse) return null;
      events.push(request);
      return { cut: () => void cut.push(request.sound) };
    },
  };
  return { transport, typing, events, cut, finish: (index: number) => typing[index]!.onEnded() };
}

let prefs: CuePrefs;
let context: CueContext & { owner: boolean };

beforeEach(() => {
  prefs = { cuesEnabled: true, cueVolume: 1, typingEnabled: true };
  context = { hidden: false, phone: false, voiceCall: false, owner: true, ownsEvents: () => context.owner };
});

function player(sink = recorder(), extra: { onPriorityCue?: (cue: AudioCue) => void } = {}) {
  const timers = createFakeTimers(10_000_000);
  const cues = createCuePlayer({ transport: sink.transport, prefs: () => prefs, context: () => context, timers, pick: () => 0, ...extra });
  return { cues, sink, timers };
}

describe("de-duplication on a stable event identity", () => {
  test("one logical event is considered once, however many times it is observed", () => {
    const { cues, sink, timers } = player();
    expect(cues.play({ cue: "your-move", eventId: "attention:req-7" })).toBe("scheduled");
    expect(cues.play({ cue: "your-move", eventId: "attention:req-7" })).toBe("deduped");
    timers.advance(10_000);
    expect(sink.events.map((e) => e.sound)).toEqual(["your-move"]);
  });

  test("a muted event is spent, so nothing floods out after the unmute", () => {
    const { cues, sink, timers } = player();
    prefs.cuesEnabled = false;
    expect(cues.play({ cue: "fault", eventId: "f1" })).toBe("disabled");
    prefs.cuesEnabled = true;
    expect(cues.play({ cue: "fault", eventId: "f1" })).toBe("deduped");
    timers.advance(60_000);
    expect(sink.events).toEqual([]);
  });

  test("a blocked typing call is spent too", () => {
    const { cues } = player(recorder({ refuse: true }));
    expect(cues.play({ cue: "typing", eventId: "tool:a:1" })).toBe("blocked");
    expect(cues.play({ cue: "typing", eventId: "tool:a:1" })).toBe("deduped");
  });

  test("the identity memory is bounded and evicts the oldest first", () => {
    const sink = recorder();
    const cues = createCuePlayer({ transport: sink.transport, prefs: () => prefs, context: () => context, timers: createFakeTimers(), dedupeCapacity: 2 });
    cues.play({ cue: "typing", eventId: "a" });
    cues.play({ cue: "typing", eventId: "b" });
    cues.play({ cue: "typing", eventId: "c" });
    expect(cues.play({ cue: "typing", eventId: "c" })).toBe("deduped");
    expect(cues.play({ cue: "typing", eventId: "a" })).not.toBe("deduped");
  });
});

describe("staleness (§6.1)", () => {
  test("an event whose own time is 2 minutes old is absorbed silently, and spent", () => {
    const { cues, timers } = player();
    const now = timers.now();
    expect(cues.play({ cue: "step", eventId: "s1", occurredAt: now - 120_000 })).toBe("stale");
    expect(cues.play({ cue: "step", eventId: "s1", occurredAt: now })).toBe("deduped");
    expect(cues.play({ cue: "step", eventId: "s2", occurredAt: now - 119_000 })).toBe("scheduled");
  });

  test("a source may name its own bound: a deploy sounds up to 5 minutes", () => {
    const { cues, timers } = player();
    expect(cues.play({ cue: "released", eventId: "d1", occurredAt: timers.now() - 4 * 60_000, maxAgeMs: 5 * 60_000 })).toBe("scheduled");
    expect(cues.play({ cue: "released", eventId: "d2", occurredAt: timers.now() - 5 * 60_000, maxAgeMs: 5 * 60_000 })).toBe("stale");
  });

  test("what is observed live carries no clock and is never stale", () => {
    const { cues } = player();
    expect(cues.play({ cue: "reply", eventId: "r1" })).toBe("scheduled");
  });
});

describe("typing has its own pool (S1)", () => {
  test("three voices, then a burst is dropped; a finished voice frees a place", () => {
    const { cues, sink } = player();
    const outcomes = Array.from({ length: 5 }, (_, i) => cues.play({ cue: "typing", eventId: `t${i}` }));
    expect(outcomes).toEqual(["played", "played", "played", "dropped", "dropped"]);
    expect(TYPING_VOICES).toBe(3);
    sink.finish(0);
    expect(cues.play({ cue: "typing", eventId: "t9" })).toBe("played");
  });

  test("a full typing pool never holds back an event sound", () => {
    const { cues, sink, timers } = player();
    for (let i = 0; i < 3; i++) cues.play({ cue: "typing", eventId: `t${i}` });
    cues.play({ cue: "released", eventId: "deploy" });
    timers.advance(1);
    expect(sink.events.map((e) => e.sound)).toEqual(["released"]);
  });

  test("a slice plays at the routine gain × volume, staggered and panned as asked", () => {
    const { cues, sink } = player();
    prefs.cueVolume = 0.4;
    cues.play({ cue: "typing", eventId: "t1", pan: 3, delayMs: 220 });
    expect(sink.typing[0]).toMatchObject({ src: "/audio/cues/tool-tick-1.mp3", gain: 0.2, pan: 1, delaySeconds: 0.22, distant: false });
  });

  test("«Agent typing» off, a hidden tab and a connected call each silence it", () => {
    for (const set of [() => { prefs.typingEnabled = false; }, () => { context.hidden = true; }, () => { context.voiceCall = true; }]) {
      prefs = { cuesEnabled: true, cueVolume: 1, typingEnabled: true };
      context = { hidden: false, phone: false, voiceCall: false, owner: true, ownsEvents: () => context.owner };
      set();
      const { cues, sink } = player();
      expect(cues.play({ cue: "typing", eventId: "t" })).toBe("disabled");
      expect(cues.play({ cue: "distant-typing", eventId: "d", agentsOffScreen: 3 })).toBe("disabled");
      expect(sink.typing).toEqual([]);
    }
  });

  test("a phone keeps S1 for the conversation it shows", () => {
    context.phone = true;
    const { cues } = player();
    expect(cues.play({ cue: "typing", eventId: "t" })).toBe("played");
  });
});

describe("distant typing (S2)", () => {
  test("its pace is one slice every clamp(8/√n, 3, 8) seconds", () => {
    expect(distantIntervalMs(1)).toBe(8000);
    expect(distantIntervalMs(4)).toBe(4000);
    expect(distantIntervalMs(7)).toBeCloseTo(3024, 0);
    expect(distantIntervalMs(8)).toBe(3000);
    expect(distantIntervalMs(26)).toBe(3000);
    expect(distantIntervalMs(0)).toBe(8000);
  });

  test("one agent off screen murmurs at most every 8 s, one room away", () => {
    const { cues, sink, timers } = player();
    expect(cues.play({ cue: "distant-typing", eventId: "d1", agentsOffScreen: 1 })).toBe("played");
    timers.advance(7_000);
    expect(cues.play({ cue: "distant-typing", eventId: "d2", agentsOffScreen: 1 })).toBe("dropped");
    timers.advance(1_000);
    expect(cues.play({ cue: "distant-typing", eventId: "d3", agentsOffScreen: 1 })).toBe("played");
    expect(sink.typing.every((request) => request.distant)).toBe(true);
    expect(Math.abs(sink.typing[0]!.pan)).toBeLessThanOrEqual(0.3);
  });

  test("eight or more agents off screen murmur every 3 s", () => {
    const { cues, timers } = player();
    cues.play({ cue: "distant-typing", eventId: "d1", agentsOffScreen: 8 });
    timers.advance(2_999);
    expect(cues.play({ cue: "distant-typing", eventId: "d2", agentsOffScreen: 8 })).toBe("dropped");
    timers.advance(1);
    expect(cues.play({ cue: "distant-typing", eventId: "d3", agentsOffScreen: 8 })).toBe("played");
  });

  test("it is skipped within 1 s of S1: the near layer already said it", () => {
    const { cues, timers } = player();
    cues.play({ cue: "typing", eventId: "t1" });
    timers.advance(900);
    expect(cues.play({ cue: "distant-typing", eventId: "d1", agentsOffScreen: 3 })).toBe("dropped");
    timers.advance(200);
    expect(cues.play({ cue: "distant-typing", eventId: "d2", agentsOffScreen: 3 })).toBe("played");
  });

  test("a phone never plays it", () => {
    context.phone = true;
    const { cues } = player();
    expect(cues.play({ cue: "distant-typing", eventId: "d", agentsOffScreen: 3 })).toBe("disabled");
  });
});

describe("event sounds (S3–S9) and the context", () => {
  test("a hidden desktop tab still plays event sounds", () => {
    context.hidden = true;
    const { cues, sink, timers } = player();
    cues.play({ cue: "landed", eventId: "l1" });
    timers.advance(5_000);
    expect(sink.events.map((e) => e.sound)).toEqual(["landed"]);
  });

  test("a hidden phone plays nothing", () => {
    context.phone = true;
    context.hidden = true;
    const { cues } = player();
    expect(cues.play({ cue: "your-move", eventId: "y" })).toBe("disabled");
  });

  test("a tab that does not own the device's event sounds plays none", () => {
    context.owner = false;
    const { cues, sink, timers } = player();
    expect(cues.play({ cue: "your-move", eventId: "y" })).toBe("dropped");
    timers.advance(10_000);
    expect(sink.events).toEqual([]);
    /* Its own typing still plays. */
    expect(cues.play({ cue: "typing", eventId: "t" })).toBe("played");
  });

  test("during a call, S3 and S9 are off and S4–S8 play 6 dB down", () => {
    context.voiceCall = true;
    const { cues, sink, timers } = player();
    expect(cues.play({ cue: "step", eventId: "s" })).toBe("disabled");
    expect(cues.play({ cue: "launched", eventId: "l" })).toBe("disabled");
    cues.play({ cue: "your-move", eventId: "y" });
    timers.advance(3_000);
    expect(sink.events).toEqual([{ sound: "your-move", volume: 0.5, pan: 0, batch: 1 }]);
  });

  test("a call that connects while a sound waits in its window keeps S3 out", () => {
    const { cues, sink, timers } = player();
    cues.play({ cue: "step", eventId: "s" });
    context.voiceCall = true;
    timers.advance(2_000);
    expect(sink.events).toEqual([]);
  });

  test("a mute that arrives while a sound waits in its window wins", () => {
    const { cues, sink, timers } = player();
    cues.play({ cue: "your-move", eventId: "y" });
    prefs.cuesEnabled = false;
    timers.advance(3_000);
    expect(sink.events).toEqual([]);
  });

  test("the volume scales every event sound", () => {
    prefs.cueVolume = 0.4;
    const { cues, sink, timers } = player();
    cues.play({ cue: "released", eventId: "d" });
    timers.advance(1);
    expect(sink.events[0]!.volume).toBeCloseTo(0.4, 6);
  });

  test("S6 and S7 duck the music when they start; results do not", () => {
    const ducked: AudioCue[] = [];
    const { cues, timers } = player(recorder(), { onPriorityCue: (cue) => ducked.push(cue) });
    cues.play({ cue: "released", eventId: "d" });
    cues.play({ cue: "fault", eventId: "f" });
    timers.advance(60_000);
    expect(ducked).toEqual(["fault"]);
  });

  test("clearQueue forgets what waits behind the playing sound", () => {
    const { cues, sink, timers } = player();
    cues.play({ cue: "released", eventId: "d" });
    timers.advance(100);
    cues.play({ cue: "reply", eventId: "r" });
    timers.advance(1_600);
    cues.clearQueue();
    timers.advance(60_000);
    expect(sink.events.map((e) => e.sound)).toEqual(["released"]);
  });

  test("the settings preview plays at once, outside the lane", () => {
    const { cues, sink } = player();
    const request: CueRequest = { cue: "step", eventId: "preview:1", preview: true };
    expect(cues.play(request)).toBe("played");
    expect(sink.events.map((e) => e.sound)).toEqual(["step"]);
  });

  test("a device that refuses audio degrades silently, event after event", () => {
    const { cues, timers } = player(recorder({ refuse: true }));
    for (let i = 0; i < 5; i++) expect(() => cues.play({ cue: "your-move", eventId: `y${i}` })).not.toThrow();
    expect(() => timers.advance(120_000)).not.toThrow();
  });
});
