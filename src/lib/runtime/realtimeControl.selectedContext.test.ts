import { beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { captureSelectedContext, type SelectedContextRef } from "@/lib/selection/selectedContext";

import { executeRealtimeControl } from "./realtimeControl";
import { resetVoiceViewBindings, voiceSelectedContext } from "./voiceViewBinding";

/**
 * #844 §2/§4 at the realtime admission boundary: the utterance and the card it
 * points at are admitted together, against the window the call was opened from.
 * The speech is written ONLY if the reference is accepted — an utterance whose
 * "that one" cannot be resolved must not reach the agent pointing at nothing.
 */

/* The admission clock is the SERVER clock (a body-supplied `now` would be an
   untrusted way to defeat the staleness rule), so the fixture captures against
   the same wall clock the control plane reads. */
const NOW = Date.now();
const DESK = { viewSessionId: "vs-desk-1", deviceId: "dev-desk" };
const PHONE = { viewSessionId: "vs-phone-1", deviceId: "dev-phone" };
const LIVE_PERSONA = {
  variant: "modality" as const,
  personaId: `voice_persona_${"d".repeat(46)}`,
};

function reference(identity: { viewSessionId: string; deviceId: string }, card = "conversation_atlas_a"): SelectedContextRef {
  return captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: "fixtures/projects/atlas/worker-a.jsonl", selectedPaths: [] },
    cards: [{ path: "fixtures/projects/atlas/worker-a.jsonl", conversationId: card, label: "Worker A" }],
    identity,
    revision: 1,
    now: NOW,
  });
}

function hostFor(spoken: string[]) {
  return {
    async startRealtimeWebRtc() {
      return {
        sdp: "v=0\r\nanswer",
        realtimeSessionId: "live-1",
        persona: LIVE_PERSONA,
      };
    },
    async appendRealtimeSpeech(text: string) {
      spoken.push(text);
    },
    async stopRealtime() {},
    currentRealtimeSessionId() {
      return "live-1";
    },
  };
}

const OPERATOR = { operator: true };
const PEER = { caller: { kind: "session" as const, realtimeSessionId: "live-1" }, operator: false };

async function start(host: ReturnType<typeof hostFor>, view: unknown) {
  return executeRealtimeControl(
    { action: "start", conversationId: "conversation_voice", sdp: "v=0\r\noffer\r\n", view },
    () => host,
    OPERATOR,
  );
}

beforeEach(() => resetVoiceViewBindings());

test("starting a call binds it to the window that opened it", async () => {
  const spoken: string[] = [];
  const host = hostFor(spoken);
  expect((await start(host, DESK)).status).toBe(200);

  const result = await executeRealtimeControl(
    { action: "appendSpeech", conversationId: "conversation_voice", text: "look at that one", selectedContext: reference(DESK) },
    () => host,
    PEER,
  );
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ ok: true, selectedContext: { state: "selected", conversationId: "conversation_atlas_a" } });
  expect(spoken).toEqual(["look at that one"]);
  expect(voiceSelectedContext("conversation_voice")?.reference).toMatchObject({ conversationId: "conversation_atlas_a" });
});

test("an utterance from another device is refused with a typed error and never spoken", async () => {
  const spoken: string[] = [];
  const host = hostFor(spoken);
  await start(host, DESK);

  const result = await executeRealtimeControl(
    { action: "appendSpeech", conversationId: "conversation_voice", text: "look at that one", selectedContext: reference(PHONE) },
    () => host,
    PEER,
  );
  expect(result.status).toBe(409);
  expect(result.body).toMatchObject({ error: expect.stringContaining("different device"), code: "ambiguous" });
  expect(spoken).toEqual([]);
  expect(voiceSelectedContext("conversation_voice")).toBeNull();
});

test("an utterance carrying no reference is spoken unchanged — voice without a selection still works", async () => {
  const spoken: string[] = [];
  const host = hostFor(spoken);
  await start(host, DESK);

  const result = await executeRealtimeControl(
    { action: "appendSpeech", conversationId: "conversation_voice", text: "status please" },
    () => host,
    PEER,
  );
  expect(result.status).toBe(200);
  expect(spoken).toEqual(["status please"]);
  expect(voiceSelectedContext("conversation_voice")).toBeNull();
});

test("an explicit empty selection is admitted and readable, distinct from never having spoken one", async () => {
  const spoken: string[] = [];
  const host = hostFor(spoken);
  await start(host, DESK);
  const empty = captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: null, selectedPaths: [] },
    cards: [],
    identity: DESK,
    revision: 2,
    now: NOW,
  });
  const result = await executeRealtimeControl(
    { action: "appendSpeech", conversationId: "conversation_voice", text: "anything running?", selectedContext: empty },
    () => host,
    PEER,
  );
  expect(result.status).toBe(200);
  expect(voiceSelectedContext("conversation_voice")?.reference.state).toBe("none");
});

test("a call opened with no window binding refuses every reference", async () => {
  const spoken: string[] = [];
  const host = hostFor(spoken);
  await start(host, undefined);
  const result = await executeRealtimeControl(
    { action: "appendSpeech", conversationId: "conversation_voice", text: "look at that one", selectedContext: reference(DESK) },
    () => host,
    PEER,
  );
  expect(result.status).toBe(409);
  expect(result.body).toMatchObject({ code: "unbound" });
  expect(spoken).toEqual([]);
});

test("hanging up releases the binding, so a later utterance cannot ride the dead call", async () => {
  const spoken: string[] = [];
  const host = hostFor(spoken);
  await start(host, DESK);
  await executeRealtimeControl(
    { action: "appendSpeech", conversationId: "conversation_voice", text: "look at that one", selectedContext: reference(DESK) },
    () => host,
    PEER,
  );
  await executeRealtimeControl({ action: "stop", conversationId: "conversation_voice" }, () => host, OPERATOR);
  expect(voiceSelectedContext("conversation_voice")).toBeNull();
});


/* ------------------------------------------------------------------ *
 * The handoff report (#1629): which work the last utterance became.
 * ------------------------------------------------------------------ */

const UTTERANCE = { id: "a".repeat(32), sequence: 1 };
const HANDOFF = { handoffId: "handoff-1", itemId: "item-1", userBidiTurnId: "bidi-1" };

async function publish(host: ReturnType<typeof hostFor>, body: Record<string, unknown>) {
  return executeRealtimeControl(
    { conversationId: "conversation_voice", ...body },
    () => host,
    PEER,
  );
}

test("a handoff report completes the utterance it names", async () => {
  const host = hostFor([]);
  await start(host, DESK);
  await publish(host, { action: "selectedContext", selectedContext: reference(DESK), utterance: UTTERANCE });

  const recorded = await publish(host, { action: "handoff", utterance: UTTERANCE, handoff: HANDOFF });
  expect(recorded.status).toBe(200);
  expect(recorded.body).toEqual({ ok: true, handoff: HANDOFF });
  expect(voiceSelectedContext("conversation_voice")?.handoff).toEqual(HANDOFF);
});

test("a handoff report naming nothing is refused before it reaches the ledger", async () => {
  /* Not a 409: a report that names no utterance and no handoff is a malformed
     request, and answering it with the ledger's "you have moved on" would send
     the client looking for a race that is not there. */
  const host = hostFor([]);
  await start(host, DESK);
  await publish(host, { action: "selectedContext", selectedContext: reference(DESK), utterance: UTTERANCE });

  for (const body of [
    { action: "handoff", utterance: UTTERANCE },
    { action: "handoff", utterance: UTTERANCE, handoff: {} },
    { action: "handoff", utterance: UTTERANCE, handoff: { handoffId: "" } },
    { action: "handoff", handoff: HANDOFF },
    { action: "handoff", utterance: { id: "not-hex", sequence: 1 }, handoff: HANDOFF },
    { action: "handoff", utterance: { id: UTTERANCE.id, sequence: 0 }, handoff: HANDOFF },
  ]) {
    const refused = await publish(host, body);
    expect(refused.status).toBe(400);
  }
  expect(voiceSelectedContext("conversation_voice")?.handoff).toBeNull();
});

test("a handoff from a caller with no live session credential is refused", async () => {
  const host = hostFor([]);
  await start(host, DESK);
  await publish(host, { action: "selectedContext", selectedContext: reference(DESK), utterance: UTTERANCE });

  const anonymous = await executeRealtimeControl(
    { action: "handoff", conversationId: "conversation_voice", utterance: UTTERANCE, handoff: HANDOFF },
    () => host,
    { operator: false },
  );
  expect(anonymous.status).toBe(409);
  expect(anonymous.body.code).toBe("unbound");
  expect(voiceSelectedContext("conversation_voice")?.handoff).toBeNull();
});

test("a malformed utterance identity does not make an ordinary reference unpublishable", async () => {
  /* The identity is ordering evidence and authorizes nothing. A client that sends a
     broken one still had something on screen, and refusing the reference would
     trade a weaker ordering guarantee for no reference at all. */
  const host = hostFor([]);
  await start(host, DESK);
  const published = await publish(host, {
    action: "selectedContext",
    selectedContext: reference(DESK),
    utterance: { id: "not-hex", sequence: "second" },
  });
  expect(published.status).toBe(200);
  expect(voiceSelectedContext("conversation_voice")?.reference).toEqual(reference(DESK));
  expect(voiceSelectedContext("conversation_voice")?.utteranceId).toBeNull();
});
