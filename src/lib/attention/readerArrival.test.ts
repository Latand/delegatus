import { expect, test } from "bun:test";

import { applyAttentionEvent, expiryFrom } from "./machine";
import type { AttentionRequestV1 } from "./types";
import { AttentionRequestError, validateAttentionEvent } from "./validation";

/* The `reader` resolution (#1695): the arrival a kanban board reports for an
   `open` once the conversation's reader is on screen and settled. The record
   takes it like any other arrival; the validator names it exactly. */

const T0 = new Date("2026-09-14T10:00:00.000Z");

const point = {
  deviceId: "device-a",
  mode: "scheme",
  camera: null,
  focusedPath: null,
  capturedAt: T0.toISOString(),
} as const;

test("an arrive event may carry the reader resolution, and nothing it does not name", () => {
  const event = validateAttentionEvent({ kind: "arrive", deviceId: "device-a", returnPoint: point, resolution: "reader" });
  expect(event).toEqual({ kind: "arrive", deviceId: "device-a", returnPoint: point, resolution: "reader" });
  expect(() => validateAttentionEvent({ kind: "arrive", deviceId: "device-a", returnPoint: point, resolution: "readers" })).toThrow(AttentionRequestError);
});

test("a reader arrival puts the record into following with that resolution", () => {
  const accepted: AttentionRequestV1 = {
    id: "attention_reader",
    createdAt: T0.toISOString(),
    requestedBy: { rootId: "root_fixed" },
    origin: "root-agent",
    target: { kind: "conversation", path: "/tmp/empty.jsonl" },
    frameAtCreation: { project: "demo", rect: { x: 0, y: 0, w: 600, h: 780 }, boardRevision: 4 },
    intent: "open",
    zoom: "inspect",
    reason: "The reviewer has a question.",
    state: "pending",
    stateChangedAt: T0.toISOString(),
    expiresAt: expiryFrom(T0),
    offeredTo: [],
    returnPoints: [],
    revision: 0,
  };
  const offered = applyAttentionEvent(accepted, { kind: "offer", deviceId: "device-a" }, { now: T0 });
  if (!offered.ok) throw new Error(offered.reason);
  const taken = applyAttentionEvent(offered.request, { kind: "accept", deviceId: "device-a" }, { now: T0 });
  if (!taken.ok) throw new Error(taken.reason);
  const arrived = applyAttentionEvent(taken.request, { kind: "arrive", deviceId: "device-a", returnPoint: point, resolution: "reader" }, { now: T0 });
  expect(arrived.ok).toBe(true);
  if (!arrived.ok) return;
  expect(arrived.request.state).toBe("following");
  expect(arrived.request.resolution).toBe("reader");
});
