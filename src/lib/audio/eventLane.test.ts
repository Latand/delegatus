import { describe, expect, test } from "bun:test";

import { createEventLane, type LaneRequest } from "./eventLane";
import { createFakeTimers } from "./fakeTimers.fixture";
import type { EventSoundId } from "./synth";

/*
 * The timing rules of docs/design/sound-redesign.md §6.1–§6.2 on a fake
 * clock. Times below are seconds after the first request; each play is
 * recorded with the clock it started at, and a cut with the clock it was cut.
 */

function harness(lengths: Partial<Record<EventSoundId, number>> = {}) {
  const timers = createFakeTimers(0);
  const plays: { sound: EventSoundId; at: number; n: number; cutAt: number | null }[] = [];
  const lane = createEventLane({
    timers,
    lengthMs: (sound) => (lengths[sound] ?? defaultLength(sound)) * 1000,
    start(sound, n) {
      const play = { sound, at: timers.now() / 1000, n, cutAt: null as number | null };
      plays.push(play);
      return { cut: () => { play.cutAt = timers.now() / 1000; } };
    },
  });
  /** Issue requests at their times (seconds), then run everything out. */
  const run = (requests: Array<[number, EventSoundId, Omit<LaneRequest, "sound">?]>, tail = 120) => {
    let clock = 0;
    for (const [at, sound, extra] of [...requests].sort((a, b) => a[0] - b[0])) {
      timers.advance(at * 1000 - clock);
      clock = at * 1000;
      lane.request({ sound, ...extra });
    }
    timers.advance(tail * 1000);
    return plays.map((play) => ({ ...play, at: +play.at.toFixed(2) }));
  };
  return { lane, timers, plays, run };
}

function defaultLength(sound: EventSoundId): number {
  return { "your-move": 1.6, fault: 1.3, reply: 1.0, released: 2.2, landed: 1.8, launched: 0.45, step: 0.5 }[sound];
}

describe("the event lane (§6.2)", () => {
  test("S7 arriving mid-S6 plays right after it", () => {
    const plays = harness().run([[0, "your-move"], [0.5, "fault"]]);
    /* S6 leaves its 3 s window at 3, plays 1.6 s; S7 (3.5) queues behind it
       and starts 150 ms after S6 ends. */
    expect(plays.map((p) => [p.sound, p.at])).toEqual([["your-move", 3], ["fault", 4.75]]);
  });

  test("S5 arriving mid-S4 plays after the landing", () => {
    const plays = harness().run([[0, "landed"], [5.5, "released"]]);
    expect(plays.map((p) => [p.sound, p.at])).toEqual([["landed", 5], ["released", 6.95]]);
  });

  test("S6 arriving mid-S4 cuts it, and S4 replays once in full", () => {
    const plays = harness().run([[0, "landed"], [2.5, "your-move"]]);
    expect(plays.map((p) => [p.sound, p.at, p.cutAt])).toEqual([
      ["landed", 5, 5.5],
      ["your-move", 5.5, null],
      ["landed", 7.25, null],
    ]);
  });

  test("a replayed sound cut again is gone", () => {
    const plays = harness({ landed: 5 }).run([[0, "landed"], [2.5, "your-move"], [7.3, "your-move", { obligation: "b" }]]);
    /* The replay starts at 7.25; the second S6 waits out its 5 s gap (from
       5.5) and cuts the replay at 10.5, which does not come back. */
    expect(plays.map((p) => p.sound)).toEqual(["landed", "your-move", "landed", "your-move"]);
    expect(plays[2]!.cutAt).toBe(10.5);
  });

  test("S3 arriving mid-S6 is dropped, and so is S9", () => {
    expect(harness().run([[0, "your-move"], [1.5, "step"]]).map((p) => p.sound)).toEqual(["your-move"]);
    expect(harness().run([[0, "your-move"], [3.1, "launched"]]).map((p) => p.sound)).toEqual(["your-move"]);
  });

  test("a cut S3 is gone", () => {
    const plays = harness({ step: 5 }).run([[0, "step"], [0.5, "your-move"]]);
    /* S3 plays at 2 and is cut at 3.5 when S6 leaves its window; no replay. */
    expect(plays.map((p) => [p.sound, p.at, p.cutAt])).toEqual([["step", 2, 3.5], ["your-move", 3.5, null]]);
  });

  test("a queued play older than 15 s is dropped", () => {
    const plays = harness({ "your-move": 20 }).run([[0, "your-move"], [1, "landed"]]);
    expect(plays.map((p) => p.sound)).toEqual(["your-move"]);
  });

  test("the queue holds one pending play per class, merged", () => {
    const plays = harness({ "your-move": 8 }).run([[0, "your-move"], [3.5, "landed", { pipeline: "a" }], [12, "landed", { pipeline: "b" }]]);
    /* The first landing leaves the gate at 8.5 while S6 holds the lane until
       11 and queues; the second waits out S4's 8 s gap and plays at 16.5. */
    expect(plays.map((p) => [p.sound, p.at, p.n])).toEqual([["your-move", 3, 1], ["landed", 11.15, 1], ["landed", 16.5, 1]]);
  });

  test("clear() empties the queue: mute, the master switch, a call connecting", () => {
    const h = harness({ "your-move": 10 });
    h.lane.request({ sound: "your-move" });
    h.timers.advance(3500);
    h.lane.request({ sound: "fault" });
    h.timers.advance(3000);
    expect(h.plays.map((p) => p.sound)).toEqual(["your-move"]);
    h.lane.clear();
    h.timers.advance(60_000);
    expect(h.plays.map((p) => p.sound)).toEqual(["your-move"]);
  });

  test("a transport that cannot play leaves the lane free", () => {
    const timers = createFakeTimers(0);
    let allowed = false;
    const started: EventSoundId[] = [];
    const lane = createEventLane({
      timers,
      start(sound) {
        if (!allowed) return null;
        started.push(sound);
        return { cut() {} };
      },
    });
    lane.request({ sound: "released" });
    expect(lane.playing()).toBeNull();
    allowed = true;
    lane.request({ sound: "released" });
    expect(started).toEqual(["released"]);
  });
});

describe("the class gate (§6.1)", () => {
  test("seven decisions in 10 s (the audit's burst) are three S6, not seven", () => {
    const plays = harness().run([0, 1.5, 2.5, 4, 6, 8.5, 9.5].map((t, i) => [t, "your-move", { obligation: `task-${i}` }] as [number, EventSoundId, { obligation: string }]));
    expect(plays.map((p) => [p.at, p.n])).toEqual([[3, 3], [8, 2], [13, 2]]);
  });

  test("three lanes landing within 5 s are one S4 carrying all three (two grace notes)", () => {
    const plays = harness().run([[0, "landed", { pipeline: "a" }], [1.2, "landed", { pipeline: "b" }], [4.1, "landed", { pipeline: "c" }]]);
    expect(plays.map((p) => [p.sound, p.n])).toEqual([["landed", 3]]);
  });

  test("S6 is capped at 6 per minute and the rest waits for the minute to free up", () => {
    const requests = Array.from({ length: 10 }, (_, i) => [i * 5.5, "your-move", { obligation: `o${i}` }] as [number, EventSoundId, { obligation: string }]);
    const plays = harness().run(requests, 300);
    const firstMinute = plays.filter((p) => p.at < plays[0]!.at + 60);
    expect(firstMinute).toHaveLength(6);
    expect(plays.reduce((sum, p) => sum + p.n, 0)).toBe(10);
  });

  test("S7 is capped at 3 per minute", () => {
    const requests = Array.from({ length: 6 }, (_, i) => [i * 10.5, "fault"] as [number, EventSoundId]);
    const plays = harness().run(requests, 300);
    expect(plays.filter((p) => p.at < plays[0]!.at + 60)).toHaveLength(3);
  });

  test("S3 over its cap is dropped, not delayed", () => {
    const requests = Array.from({ length: 9 }, (_, i) => [i * 6.1, "step"] as [number, EventSoundId]);
    const plays = harness().run(requests, 300);
    expect(plays).toHaveLength(6);
    expect(plays.at(-1)!.at).toBeLessThan(60);
  });

  test("S9 keeps a 1 s gap; launches inside it play once at its end", () => {
    const plays = harness().run([[0, "launched"], [0.3, "launched"], [0.6, "launched"]]);
    expect(plays.map((p) => [p.at, p.n])).toEqual([[0, 1], [1, 2]]);
  });

  test("S5 has no window: a release sounds at once", () => {
    expect(harness().run([[0, "released"]]).map((p) => p.at)).toEqual([0]);
  });

  test("S8 coalesces replies inside 1.5 s", () => {
    expect(harness().run([[0, "reply"], [1, "reply"], [2, "reply"]]).map((p) => [p.at, p.n])).toEqual([[1.5, 2], [3.5, 1]]);
  });
});

describe("one obligation, one sound", () => {
  test("an obligation heard twice within 10 minutes sounds once", () => {
    const plays = harness().run([[0, "your-move", { obligation: "task-a" }], [120, "your-move", { obligation: "task-a" }]]);
    expect(plays).toHaveLength(1);
  });

  test("the same obligation after 10 minutes sounds again", () => {
    const plays = harness().run([[0, "your-move", { obligation: "task-a" }], [601, "your-move", { obligation: "task-a" }]]);
    expect(plays).toHaveLength(2);
  });

  test("the answer names the obligation already heard", () => {
    const { lane } = harness();
    expect(lane.request({ sound: "your-move", obligation: "t" })).toBe("accepted");
    expect(lane.request({ sound: "your-move", obligation: "t" })).toBe("obligation-heard");
  });
});

describe("a landing supersedes its lane's last step", () => {
  test("S3 still in its window is dropped when its lane lands", () => {
    const plays = harness().run([[0, "step", { pipeline: "p" }], [1, "landed", { pipeline: "p" }]]);
    expect(plays.map((p) => p.sound)).toEqual(["landed"]);
  });

  test("S3 leaving the gate within 10 s after its lane landed is dropped", () => {
    const plays = harness().run([[0, "landed", { pipeline: "p" }], [6, "step", { pipeline: "p" }]]);
    expect(plays.map((p) => p.sound)).toEqual(["landed"]);
  });

  test("another lane's step still sounds", () => {
    const plays = harness().run([[0, "step", { pipeline: "q" }], [1, "landed", { pipeline: "p" }]]);
    expect(plays.map((p) => p.sound)).toEqual(["step", "landed"]);
  });

  test("a step batch keeps the steps of lanes that did not land", () => {
    const plays = harness().run([[0, "step", { pipeline: "p" }], [0.5, "step", { pipeline: "q" }], [1, "landed", { pipeline: "p" }]]);
    expect(plays.map((p) => [p.sound, p.n])).toEqual([["step", 1], ["landed", 1]]);
  });
});
