import { describe, expect, test } from "bun:test";
import { autoRotationStep, type AutoRotationAttempt, type SeatContextUsage } from "./seatAutoRotation";
import { defaultSeatTickSettings, effectiveSeatTickSettings } from "./seatTickSettings";
import { AUTO_ROTATE_COOLDOWN_MS } from "./seatTick";
import { emptySeatTickState, type SeatTickSeatInput } from "./types";

const NOW = Date.parse("2026-10-09T03:00:00Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const actor = { kind: "gateway", conversationId: null, project: null, seatEpoch: null } as const;
const settings = effectiveSeatTickSettings({ ...defaultSeatTickSettings("fixture"), autoRotate: {
  enabled: true, thresholdPercent: 60, updatedAt: at(0), setBy: actor, why: null,
} }, NOW, AUTO_ROTATE_COOLDOWN_MS);
const seat: SeatTickSeatInput = { conversationId: "conversation_fixture", seatEpoch: 1, path: "/srv/fixture.jsonl", designatedAt: at(-60), turn: "idle", activity: null, mandateCarriesTickContract: true };
const usage: SeatContextUsage = { engine: "claude", model: "opus", tokens: 610_000, windowTokens: 1_000_000, estimated: false };
const base = { settings, seat, state: emptySeatTickState(), pendingSeat: false, usage, now: NOW, drainHeld: false, authIncidentOpen: false };
const busy = { ...seat, turn: "busy", activity: { lifecycle: "running", turnState: "busy" } } as SeatTickSeatInput;
const attempt = (state: AutoRotationAttempt["state"], minutes: number): AutoRotationAttempt => ({ id: "fixture-attempt", seatEpoch: 1, conversationId: seat.conversationId,
  startedAt: at(minutes), tokens: 610_000, windowTokens: 1_000_000, thresholdPercent: 60, state, told: { report: true, card: true } });

describe("context auto-rotation decision", () => {
  test("absent setting is off and leaves state untouched", () => {
    const state = { ...base.state, autoRotation: { lastAttempt: attempt("failed", -10) } };
    const result = autoRotationStep({ ...base, state, settings: effectiveSeatTickSettings(defaultSeatTickSettings("fixture"), NOW, AUTO_ROTATE_COOLDOWN_MS) });
    expect(result).toEqual({ kind: "none", detail: null, next: state.autoRotation });
    expect(result.next).toBe(state.autoRotation);
  });
  test.each([
    [seat, "rotate"], [busy, "wait"], [{ ...seat, turn: "busy", activity: null }, "wait"],
    [{ ...seat, turn: "busy", activity: { lifecycle: "waiting", turnState: "idle" } }, "rotate"],
    [{ ...seat, turn: "unknown" }, "wait"], [{ ...seat, turn: "terminal" }, "rotate"],
  ] as const)("turn %j yields %s", (value, expected) => expect(autoRotationStep({ ...base, seat: value as SeatTickSeatInput }).kind).toBe(expected));
  test("outstanding wake fences an otherwise idle seat", () => {
    expect(autoRotationStep({ ...base, state: { ...base.state, outstandingWake: { conversationId: seat.conversationId } as never } }).kind).toBe("wait");
  });
  test("one nudge after fifteen minutes, withheld with wakes off, scoped to the epoch", () => {
    const state = { ...base.state, autoRotation: { overSince: { seatEpoch: 1, at: at(-14) } } };
    expect(autoRotationStep({ ...base, seat: busy, state }).kind).toBe("wait");
    const nudged = autoRotationStep({ ...base, seat: busy, state, now: NOW + 60_000 });
    expect(nudged.kind).toBe("nudge");
    expect(autoRotationStep({ ...base, seat: busy, state: { ...state, autoRotation: nudged.next }, now: NOW + 5 * 60_000 }).kind).toBe("wait");
    expect(autoRotationStep({ ...base, seat: busy, state, settings: { ...settings, enabled: false }, now: NOW + 60_000 }).kind).toBe("wait");
    const nextEpoch = { ...busy, seatEpoch: 2 };
    const nextState = { ...state, autoRotation: { ...nudged.next, overSince: { seatEpoch: 2, at: at(-15) } } };
    expect(autoRotationStep({ ...base, seat: nextEpoch, state: nextState }).kind).toBe("nudge");
  });
  test("estimates wait, compaction clears the episode, equality triggers", () => {
    expect(autoRotationStep({ ...base, usage: { ...usage, tokens: 1_500_000, estimated: true } }).kind).toBe("wait");
    const state = { ...base.state, autoRotation: { overSince: { seatEpoch: 1, at: at(-15) }, nudged: { seatEpoch: 1, at: at(-5) } } };
    const below = autoRotationStep({ ...base, state, usage: { ...usage, tokens: 590_000 } });
    expect(below.kind).toBe("none"); expect(below.next?.overSince).toBeUndefined(); expect(below.next?.nudged).toBeUndefined();
    expect(autoRotationStep({ ...base, usage: { ...usage, tokens: 600_000 } }).kind).toBe("rotate");
  });
  test.each(["rotated", "failed", "superseded"] as const)("%s attempt enforces a persistent sixty-minute cooldown", state => {
    const row = { ...base.state, autoRotation: { lastAttempt: attempt(state, -59) } };
    expect(autoRotationStep({ ...base, state: row }).kind).toBe("wait");
    expect(autoRotationStep({ ...base, state: row, now: NOW + 60_000 }).kind).toBe("rotate");
  });
  test.each([{ pendingSeat: true }, { seat: { ...seat, path: null } }, { authIncidentOpen: true }, { drainHeld: true }])("fence %j creates no attempt", override => {
    const result = autoRotationStep({ ...base, ...override });
    expect(result.kind).toBe("wait"); expect(result.next?.lastAttempt).toBeUndefined();
  });
  test("unknown windows cannot trigger", () => {
    const result = autoRotationStep({ ...base, usage: { ...usage, engine: "codex", windowTokens: null } });
    expect(result.kind).toBe("none"); expect(result.detail).toContain("no context window");
  });
});
