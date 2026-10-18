import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { deepFreeze } from "@/lib/deepFreeze";
import type { Pipeline } from "@/lib/pipelines/types";
import { readAttribution, type ReadTotals } from "@/lib/readAttribution";
import { TASKS_FILE, loadTasksForList, mutateTasks } from "@/lib/tasks/store";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import type { BoardTask } from "@/lib/tasks/types";
import { closeAgentRegistryForTests } from "@/lib/agent/registry";
import { resetPresenceForTest, upsertPresence } from "@/lib/view/presenceStore";
import type { PresencePayloadV1 } from "@/lib/view/types";

import { AttentionValidationError, readAttentionFile } from "./store";
import {
  ATTENTION_ARRIVAL_TIMEOUT_MS,
  answerAttentionRequest,
  attentionForDevice,
  attentionNotices,
  attentionRecordsForSurface,
  autoFollowEligible,
  awaitAttentionArrival,
  noticeCapableViewOpen,
  raiseAttentionRequest,
  resolveDirectedAttentionDevice,
  resolveDirectedAttentionView,
} from "./service";
import { AttentionRequestError, validateAttentionCreate, validateAttentionEvent } from "./validation";
import { FOLLOW_HOLD_MS, OFFER_TTL_MS, RETURN_WINDOW_MS, type FocusFrame, type ReturnPoint } from "./types";

let sandbox = "";
let previousStateDir: string | undefined;

const T0 = new Date("2026-07-01T10:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const DEVICE = "device-desktop";

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-attention-service-"));
  process.env.LLV_STATE_DIR = sandbox;
  /* Presence decides who a request is offered to, so a view left over from
     another test would answer this one's question for it. */
  resetPresenceForTest();
});

afterEach(() => {
  resetPresenceForTest();
  /* The process-wide registry is opened on the first test's state directory;
     each test deletes its own, so the next one must reopen it. */
  closeAgentRegistryForTests();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const frame: FocusFrame = { project: "demo", rect: { x: 0, y: 0, w: 600, h: 780 }, boardRevision: 4 };

function raise(overrides: Record<string, unknown> = {}) {
  return raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: "/tmp/reviewer.jsonl" },
    frameAtCreation: frame,
    intent: "show",
    reason: "The reviewer finished with request-changes.",
    ...overrides,
  }, { now: T0, id: "attention_1" });
}

const whereIWas: ReturnPoint = {
  deviceId: DEVICE,
  mode: "scheme",
  camera: { x: 120, y: 340, zoom: 0.55 },
  focusedPath: "/tmp/what-i-was-reading.jsonl",
  capturedAt: T0.toISOString(),
};

test("ask, accept, land, and go back — the whole loop at one device", () => {
  raise();

  /* Raised, but nothing has rendered it, so there is nothing to answer yet. */
  expect(attentionForDevice(DEVICE, { now: T0 }).offer).toBeNull();

  answerAttentionRequest("attention_1", { kind: "offer", deviceId: DEVICE }, { now: T0 });
  const offered = attentionForDevice(DEVICE, { now: T0 });
  expect(offered.offer!.status).toBe("actionable");
  expect(offered.offer!.request.intent).toBe("show");

  answerAttentionRequest("attention_1", { kind: "accept", deviceId: DEVICE }, { now: T0 });
  answerAttentionRequest("attention_1", {
    kind: "arrive",
    deviceId: DEVICE,
    returnPoint: whereIWas,
    resolution: "exact",
  }, { now: T0 });

  const following = attentionForDevice(DEVICE, { now: T0 });
  expect(following.offer!.status).toBe("following");
  expect(following.offer!.returnAvailable).toBe(true);
  /* Return restores the exact viewport captured before the move — mode, camera
     and focused path — and it is recorded against this device, not the seat. */
  expect(following.offer!.request.returnPoints).toEqual([whereIWas]);

  const returned = answerAttentionRequest("attention_1", { kind: "return", deviceId: DEVICE, via: "control" }, { now: T0 });
  expect(returned.ok).toBe(true);
  expect(attentionForDevice(DEVICE, { now: T0 }).offer).toBeNull();
});

test("declining is terminal and is reported as a refusal rather than as silence", () => {
  raise();
  answerAttentionRequest("attention_1", { kind: "offer", deviceId: DEVICE }, { now: T0 });

  answerAttentionRequest("attention_1", { kind: "decline", deviceId: DEVICE }, { now: T0 });

  expect(readAttentionFile().requests[0]!.state).toBe("declined");
  expect(attentionForDevice(DEVICE, { now: T0 }).live).toEqual([]);
});

test("the return control collapses after its window while the record stays put", () => {
  raise();
  answerAttentionRequest("attention_1", { kind: "offer", deviceId: DEVICE }, { now: T0 });
  answerAttentionRequest("attention_1", { kind: "accept", deviceId: DEVICE }, { now: T0 });
  answerAttentionRequest("attention_1", { kind: "arrive", deviceId: DEVICE, returnPoint: whereIWas, resolution: "exact" }, { now: T0 });

  const after = attentionForDevice(DEVICE, { now: later(RETURN_WINDOW_MS + 1) });

  expect(after.offer!.returnAvailable).toBe(false);
  /* It collapses to a conversation line that still restores it, so the point
     itself must survive the control disappearing. */
  expect(after.offer!.request.returnPoints).toEqual([whereIWas]);
  expect(answerAttentionRequest("attention_1", { kind: "return", deviceId: DEVICE, via: "control" }, { now: later(RETURN_WINDOW_MS + 1) }).ok).toBe(true);
});

/** Drive one request all the way to `following` at this device. */
function followAt(id: string, now = T0) {
  answerAttentionRequest(id, { kind: "offer", deviceId: DEVICE }, { now });
  answerAttentionRequest(id, { kind: "accept", deviceId: DEVICE }, { now });
  answerAttentionRequest(id, {
    kind: "arrive",
    deviceId: DEVICE,
    returnPoint: { ...whereIWas, capturedAt: now.toISOString() },
    resolution: "exact",
  }, { now });
}

test("a follow the operator never closes stops being this device's only offer", () => {
  raise();
  followAt("attention_1");

  /* The whole defect, at the surface it is felt on. `following` admits no event
     but Return, so an operator who walks away instead leaves this request live
     forever; as the oldest live entry it is what the device renders, and the
     request raised after it never reaches a screen at all. */
  const second = raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: "/tmp/verifier.jsonl" },
    frameAtCreation: frame,
    intent: "show",
    reason: "The verifier is blocked on you.",
  }, { now: later(RETURN_WINDOW_MS + 1), id: "attention_2" });

  /* Raising it is what collapses the stale follow: one speaker, and its way
     back had already gone. */
  expect(second.superseded).toEqual(["attention_1"]);

  /* And it reaches the screen — the device renders it exactly as the polling
     surface does, and the record moves pending → offered. */
  answerAttentionRequest("attention_2", { kind: "offer", deviceId: DEVICE }, { now: later(RETURN_WINDOW_MS + 1) });

  const view = attentionForDevice(DEVICE, { now: later(RETURN_WINDOW_MS + 1) });
  expect(view.offer!.request.id).toBe("attention_2");
  expect(view.offer!.status).toBe("actionable");
});

test("a follow is bounded even when nothing is ever raised after it", () => {
  raise();
  followAt("attention_1");

  /* Nothing supersedes it, nobody presses Return: the clock is the only thing
     left, and without it this record is live for the life of the file. */
  const view = attentionForDevice(DEVICE, { now: later(FOLLOW_HOLD_MS) });

  expect(view.expired).toEqual(["attention_1"]);
  expect(view.offer).toBeNull();
  expect(view.live).toEqual([]);
  /* Ended as what it was: seen, agreed to, and never closed. */
  expect(readAttentionFile().requests[0]!.expiredCause).toBe("follow-elapsed");
});

test("an operator still mid-handoff keeps the return control, and the newer request waits", () => {
  raise();
  followAt("attention_1");

  const second = raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: "/tmp/verifier.jsonl" },
    frameAtCreation: frame,
    intent: "show",
    reason: "The verifier is blocked on you.",
  }, { now: later(RETURN_WINDOW_MS - 1), id: "attention_2" });

  /* Inside the window the way back is still the operator's, so nothing takes it
     from them — the newer request queues rather than evicting a live handoff. */
  expect(second.superseded).toEqual([]);
  answerAttentionRequest("attention_2", { kind: "offer", deviceId: DEVICE }, { now: later(RETURN_WINDOW_MS - 1) });

  const view = attentionForDevice(DEVICE, { now: later(RETURN_WINDOW_MS - 1) });
  expect(view.offer!.request.id).toBe("attention_1");
  expect(view.offer!.returnAvailable).toBe(true);

  /* And it is a wait, not a loss: the moment the control collapses the newer
     request is what this device is shown. */
  const after = attentionForDevice(DEVICE, { now: later(RETURN_WINDOW_MS) });
  expect(after.offer!.request.id).toBe("attention_2");
});

test("reading sweeps the clock, so an unacknowledged request cannot linger as a live card", () => {
  raise();
  answerAttentionRequest("attention_1", { kind: "offer", deviceId: DEVICE }, { now: T0 });

  const view = attentionForDevice(DEVICE, { now: later(OFFER_TTL_MS) });

  expect(view.expired).toEqual(["attention_1"]);
  expect(view.offer).toBeNull();
  /* Reported exactly once: the caller writes one conversation line per id. */
  expect(attentionForDevice(DEVICE, { now: later(OFFER_TTL_MS + 1) }).expired).toEqual([]);
});

test("the root identity is resolved server-side, never taken from the caller", () => {
  const { request } = raise();

  expect(request.requestedBy.rootId).toStartWith("root_");
  expect(attentionForDevice(DEVICE, { now: T0 }).rootId).toBe(request.requestedBy.rootId);
});

test("a journal event is evidence on a request, never a request — and never moves the view", () => {
  /* #686 terminal events mark candidates; the root agent decides whether to
     raise one. There is no door here a journal event can come through on its
     own, which is what keeps D4 intact. */
  expect(() => validateAttentionCreate({
    origin: "journal",
    target: { kind: "conversation", path: "/tmp/a.jsonl" },
    frameAtCreation: frame,
    intent: "show",
    reason: "A stage failed.",
  })).toThrow(AttentionRequestError);

  const { request } = raise({ candidates: [{ eventId: "event_1", kind: "stage-failed" }] });

  /* Carrying the evidence changes nothing about consent: it still starts at
     pending and still needs the operator's yes before anything moves. */
  expect(request.candidates).toEqual([{ eventId: "event_1", kind: "stage-failed" }]);
  expect(request.state).toBe("pending");
  expect(attentionForDevice(DEVICE, { now: T0 }).offer).toBeNull();
});

test("a client cannot expire or supersede somebody else's offer", () => {
  /* A device that could expire another device's offer is a device that can
     silence the agent, so those two events have no HTTP shape at all. */
  expect(() => validateAttentionEvent({ kind: "expire", cause: "ttl" })).toThrow(AttentionRequestError);
  expect(() => validateAttentionEvent({ kind: "supersede", by: "attention_2" })).toThrow(AttentionRequestError);
  expect(validateAttentionEvent({ kind: "accept", deviceId: DEVICE })).toEqual({ kind: "accept", deviceId: DEVICE });
});

test("a request body missing its frame or its reason is refused before it reaches the store", () => {
  expect(() => validateAttentionCreate({ origin: "root-agent", target: { kind: "conversation", path: "/tmp/a.jsonl" }, intent: "show", reason: "x" }))
    .toThrow(AttentionRequestError);
  expect(() => validateAttentionCreate({ origin: "root-agent", target: { kind: "conversation", path: "/tmp/a.jsonl" }, intent: "show", frameAtCreation: frame }))
    .toThrow(AttentionRequestError);
});

test("a phone in a pocket never auto-follows, even where consent exists", () => {
  expect(autoFollowEligible({ visibility: "visible", freshness: "active" })).toBe(true);
  expect(autoFollowEligible({ visibility: "hidden", freshness: "active" })).toBe(false);
  expect(autoFollowEligible({ visibility: "visible", freshness: "background" })).toBe(false);
  expect(autoFollowEligible(null)).toBe(false);
});

test("a conversation target resolves to the durable conversation's current transcript", () => {
  const abandonedFork = "/tmp/sessions/rollout-fork.jsonl";
  const currentPath = "/tmp/sessions/rollout-root.jsonl";
  const conversations = {
    conversationForPath: (artifactPath: string) => artifactPath === abandonedFork || artifactPath === currentPath
      ? { generations: [{ path: "/tmp/sessions/rollout-archived.jsonl" }, { path: currentPath }] } as never
      : null,
    canonicalConversationId: (id: never) => id,
    conversation: () => null,
  };

  const raised = raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: abandonedFork },
    frameAtCreation: frame,
    intent: "open",
    reason: "The root conversation answered.",
  }, { now: T0, id: "attention_fork", conversations });

  expect(raised.request.target).toEqual({ kind: "conversation", path: currentPath });
});

test("a conversation target with no durable owner is left exactly as raised", () => {
  const unknown = "/tmp/sessions/rollout-unknown.jsonl";
  const conversations = {
    conversationForPath: () => null,
    canonicalConversationId: (id: never) => id,
    conversation: () => null,
  };

  const raised = raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: unknown },
    frameAtCreation: frame,
    intent: "show",
    reason: "An unregistered transcript still has a card.",
  }, { now: T0, id: "attention_unknown", conversations });

  expect(raised.request.target).toEqual({ kind: "conversation", path: unknown });
});

/* ── Who the request is put in front of ─────────────────────────────────── */

function view(overrides: Partial<PresencePayloadV1> = {}): PresencePayloadV1 {
  return {
    schemaVersion: 1,
    viewSessionId: "view-1",
    deviceId: DEVICE,
    device: { kind: "desktop", browser: "chrome" },
    visibility: "visible",
    sequence: 1,
    inputSequence: 1,
    project: "demo",
    mode: "scheme",
    viewport: { width: 1_600, height: 900, dpr: 2 },
    camera: { x: 10, y: 20, zoom: 0.6, worldRect: { x: 0, y: 0, width: 100, height: 80 } },
    focusedPath: "/tmp/reviewer.jsonl",
    selectedPaths: [],
    visiblePaths: [],
    board: { renderedRevision: 4, durableRevision: 4, sync: "current" },
    ...overrides,
  };
}

test("a request names the desktop views that are open when it is raised", () => {
  /* The operator's symptom: the agent's tool answers synchronously and then
     speaks about what it asked for, so an `offeredTo` that only fills in on some
     browser's next poll told every caller that nobody was there. */
  upsertPresence(view(), T0.getTime());

  const raised = raise().request;

  expect(raised.offeredTo).toEqual([DEVICE]);
  /* Naming the device is not agreeing on its behalf: the request is still
     waiting for a surface to render it. */
  expect(raised.state).toBe("pending");
  expect(raised.acknowledgedBy).toBeUndefined();
});

test("the phone is never named: it cannot render an offer and cannot move its board", () => {
  upsertPresence(view({ viewSessionId: "view-phone", deviceId: "device-phone", device: { kind: "mobile", browser: "safari" } }), T0.getTime());

  expect(raise().request.offeredTo).toEqual([]);
});

test("a desktop reading the history list is not named: there is no board to move", () => {
  /* The silent failure this offer exists to remove, reappearing one level up. A
     board controller is registered by the scheme board and the phone's focus
     view and by nothing else, so a desktop sitting in the list has no camera and
     no anchors: the handoff finds no controller, resolves `lost`, and NOTHING
     ON SCREEN MOVES. Naming it anyway means the request is accepted, the agent
     is told which desktop is watching, and the operator is shown nothing. */
  upsertPresence(view({ viewSessionId: "view-list", deviceId: "device-list", mode: "list" }), T0.getTime());

  expect(raise().request.offeredTo).toEqual([]);
});

test("a desktop on the overview is still named: landing there opens a project and mounts a board", () => {
  /* Not symmetric with the list, and the difference is the whole point. A
     handoff from the overview OPENS the target's project, which mounts the
     board, and the handoff already waits for that board to publish. The list is
     the mode the operator chose INSTEAD of a board, so no wait can produce one. */
  upsertPresence(view({ viewSessionId: "view-overview", deviceId: DEVICE, mode: "overview", project: null, camera: null }), T0.getTime());

  expect(raise().request.offeredTo).toEqual([DEVICE]);
});

test("a backgrounded or long-silent view is not somewhere the operator can be taken", () => {
  upsertPresence(view({ viewSessionId: "view-hidden", deviceId: "device-hidden", visibility: "hidden" }), T0.getTime());
  /* Visible, but last heard from long enough ago that it may be a laptop that
     was shut. */
  upsertPresence(view({ viewSessionId: "view-stale", deviceId: "device-stale" }), T0.getTime() - 120_000);

  expect(raise().request.offeredTo).toEqual([]);
});

test("two tabs on one machine are one place to be taken", () => {
  upsertPresence(view({ viewSessionId: "view-a" }), T0.getTime());
  upsertPresence(view({ viewSessionId: "view-b" }), T0.getTime());

  expect(raise().request.offeredTo).toEqual([DEVICE]);
});

test("a device offered at creation may answer the request without any further ceremony", () => {
  upsertPresence(view(), T0.getTime());
  raise();

  /* The seeded list is the same list the machine checks, so the surface that was
     named can take the request through its whole life. */
  answerAttentionRequest("attention_1", { kind: "offer", deviceId: DEVICE }, { now: T0 });
  expect(attentionForDevice(DEVICE, { now: T0 }).offer!.status).toBe("actionable");
  expect(readAttentionFile().requests[0]!.offeredTo).toEqual([DEVICE]);

  const accepted = answerAttentionRequest("attention_1", { kind: "accept", deviceId: DEVICE, via: "auto-follow" }, { now: T0 });
  expect(accepted.ok).toBe(true);
});

test("an operator command still names its own device and nothing else", () => {
  /* An operator command is their own act on one surface; presence must never
     widen it, because the first named device is the one recorded as having
     accepted it. */
  upsertPresence(view({ viewSessionId: "view-other", deviceId: "device-elsewhere" }), T0.getTime());

  const raised = raiseAttentionRequest({
    origin: "operator",
    target: { kind: "conversation", path: "/tmp/reviewer.jsonl" },
    frameAtCreation: frame,
    intent: "show",
    reason: "Take me to the reviewer.",
    offeredTo: [DEVICE],
  }, { now: T0, id: "attention_operator" }).request;

  expect(raised.offeredTo).toEqual([DEVICE]);
  expect(raised.acknowledgedBy).toBe(DEVICE);
});

/* ── #873: the immediate directed handoff ───────────────────────────────── */

test("resolving the directed device: nobody movable is an explicit null, never a guess", () => {
  /* Nothing at all. */
  expect(resolveDirectedAttentionDevice(T0)).toBeNull();
  /* A phone is chat-only, a hidden tab is not being watched, and the history
     list has no board to move — each is excluded for the same reason the old
     offer path excluded it, so "who may be moved" cannot drift from "who was
     this directed at". */
  upsertPresence(view({ viewSessionId: "view-phone", deviceId: "device-phone", device: { kind: "mobile", browser: "safari" } }), T0.getTime());
  upsertPresence(view({ viewSessionId: "view-hidden", deviceId: "device-hidden", visibility: "hidden" }), T0.getTime());
  upsertPresence(view({ viewSessionId: "view-list", deviceId: "device-list", mode: "list" }), T0.getTime());
  expect(resolveDirectedAttentionDevice(T0)).toBeNull();
});

test("two active desks resolve deterministically: the latest interaction wins", () => {
  upsertPresence(view({ viewSessionId: "view-older", deviceId: "device-older" }), T0.getTime() - 5_000);
  upsertPresence(view({ viewSessionId: "view-newer", deviceId: "device-newer" }), T0.getTime());

  expect(resolveDirectedAttentionDevice(T0)).toBe("device-newer");
  /* Same answer on every read: ambiguity is settled by the record, not by
     iteration order. */
  expect(resolveDirectedAttentionDevice(T0)).toBe("device-newer");
});

test("a directed request is born accepted for exactly one device — no pending, no offer, no competitor", () => {
  upsertPresence(view(), T0.getTime());
  upsertPresence(view({ viewSessionId: "view-second", deviceId: "device-second" }), T0.getTime());

  const { request } = raise({ directedAt: DEVICE });

  expect(request.state).toBe("accepted");
  expect(request.acknowledgedBy).toBe(DEVICE);
  /* The desktop followed on its own; nothing was pressed. */
  expect(request.acceptedVia).toBe("auto-follow");
  /* One device on the record: the second active desk is named nowhere, so no
     surface can render it a competing offer. */
  expect(request.offeredTo).toEqual([DEVICE]);
  expect(attentionForDevice("device-second", { now: T0 }).offer).toBeNull();
});

test("a directed raise supersedes the same root's earlier unanswered ask", () => {
  raise();
  const second = raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: "/tmp/verifier.jsonl" },
    frameAtCreation: frame,
    intent: "show",
    reason: "The verifier is blocked on you.",
    directedAt: DEVICE,
  }, { now: later(1_000), id: "attention_2" });

  expect(second.superseded).toEqual(["attention_1"]);
  expect(readAttentionFile().requests.find((entry) => entry.id === "attention_1")!.state).toBe("superseded");
});

test("a directed handoff must name its device", () => {
  expect(() => raise({ directedAt: "" })).toThrow(AttentionValidationError);
});

test("the arrival wait resolves once the view lands, with the return point already captured", async () => {
  raise({ directedAt: DEVICE });
  const landing = setTimeout(() => {
    answerAttentionRequest("attention_1", { kind: "arrive", deviceId: DEVICE, returnPoint: whereIWas, resolution: "exact" });
  }, 20);
  try {
    const outcome = await awaitAttentionArrival("attention_1", { pollMs: 5, timeoutMs: 1_000 });

    expect(outcome.kind).toBe("arrived");
    if (outcome.kind === "arrived") {
      expect(outcome.request.state).toBe("following");
      expect(outcome.request.returnPoints).toEqual([whereIWas]);
    }
  } finally {
    clearTimeout(landing);
  }
});

test("an arrival the operator already returned from still counts as the arrival it was", async () => {
  raise({ directedAt: DEVICE });
  answerAttentionRequest("attention_1", { kind: "arrive", deviceId: DEVICE, returnPoint: whereIWas, resolution: "exact" });
  answerAttentionRequest("attention_1", { kind: "return", deviceId: DEVICE, via: "control" });

  const outcome = await awaitAttentionArrival("attention_1", { pollMs: 5, timeoutMs: 50 });

  expect(outcome.kind).toBe("arrived");
  if (outcome.kind === "arrived") expect(outcome.request.state).toBe("returned");
});

test("a handoff nobody completes is closed as lost within its bound — nothing is left to navigate later", async () => {
  raise({ directedAt: DEVICE });

  const outcome = await awaitAttentionArrival("attention_1", { pollMs: 5, timeoutMs: 40 });

  expect(outcome).toMatchObject({ kind: "failed", code: "HANDOFF_TIMEOUT" });
  const stored = readAttentionFile().requests[0]!;
  expect(stored.state).toBe("expired");
  expect(stored.expiredCause).toBe("lost");
  /* Closed means closed: a later arrive is refused, so no poll can turn the
     failure the caller was told into a surprise navigation. */
  expect(answerAttentionRequest("attention_1", { kind: "arrive", deviceId: DEVICE, returnPoint: whereIWas, resolution: "exact" }).ok).toBe(false);
});

test("a view that found nowhere to land is an explicit lost target", async () => {
  raise({ directedAt: DEVICE });
  answerAttentionRequest("attention_1", { kind: "abandon", deviceId: DEVICE });

  const outcome = await awaitAttentionArrival("attention_1", { pollMs: 5, timeoutMs: 200 });

  expect(outcome).toMatchObject({ kind: "failed", code: "TARGET_LOST" });
});

test("an aborted wait closes the request rather than leaving it in flight", async () => {
  raise({ directedAt: DEVICE });
  const controller = new AbortController();
  controller.abort();

  const outcome = await awaitAttentionArrival("attention_1", { pollMs: 5, timeoutMs: 5_000, signal: controller.signal });

  expect(outcome).toMatchObject({ kind: "failed", code: "HANDOFF_ABORTED" });
  expect(readAttentionFile().requests[0]!.state).toBe("expired");
});

test("the default wait stays far inside the MCP transport's own deadline", () => {
  expect(ATTENTION_ARRIVAL_TIMEOUT_MS).toBeLessThan(30_000);
});

/* ── The phone's notices (docs/design/needs-attention.md §6) ─────────────── */

test("only a phone open: a notice-capable view, and no view a handoff could move", () => {
  upsertPresence(view({ viewSessionId: "phone", deviceId: "device-phone", device: { kind: "mobile", browser: "safari" }, mode: "mobile-focus", viewport: { width: 390, height: 844, dpr: 3 } }), T0.getTime());
  expect(resolveDirectedAttentionView(T0)).toBeNull();
  expect(noticeCapableViewOpen(T0)).toBe(true);
});

test("no view at all is neither", () => {
  expect(resolveDirectedAttentionView(T0)).toBeNull();
  expect(noticeCapableViewOpen(T0)).toBe(false);
  /* A phone the operator put away does not count either. */
  upsertPresence(view({ viewSessionId: "phone", deviceId: "device-phone", device: { kind: "mobile", browser: "safari" }, visibility: "hidden" }), T0.getTime());
  expect(noticeCapableViewOpen(T0)).toBe(false);
});

test("the phone reads the root agent's recent requests as notices, newest first, and answers none of them", () => {
  raise({ delivery: "notice", offeredTo: [] });
  raiseAttentionRequest({
    origin: "root-agent",
    raisedBy: { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" },
    target: { kind: "pipeline", pipelineId: "lane-1" },
    frameAtCreation: frame,
    intent: "open",
    reason: "The lane needs a decision.",
    contextLabel: "review stage",
    offeredTo: [],
    delivery: "notice",
  }, { now: later(60_000), id: "attention_2" });

  const notices = attentionRecordsForSurface({ now: later(120_000), records: { pipelines: () => [], tasks: () => [] } }).notices;
  expect(notices.map((notice) => notice.id)).toEqual(["attention_2"]);
  /* The second superseded the first: one root, one speaker. */
  expect(notices[0]).toEqual({
    id: "attention_2",
    reason: "The lane needs a decision.",
    target: { kind: "pipeline", pipelineId: "lane-1" },
    contextLabel: "review stage",
    raisedBy: { kind: "manager", role: "orchestrator" },
    createdAt: later(60_000).toISOString(),
  });
  /* Read, never answered: the record is where it was. */
  expect(readAttentionFile().requests.find((request) => request.id === "attention_2")).toMatchObject({ state: "pending", revision: 0 });
});

test("a notice ends with its record's clock, and a refused one is never shown", () => {
  raise({ delivery: "notice", offeredTo: [] });
  const file = readAttentionFile();
  expect(attentionNotices(file, later(OFFER_TTL_MS - 1)).map((notice) => notice.id)).toEqual(["attention_1"]);
  expect(attentionNotices(file, later(OFFER_TTL_MS + 1))).toEqual([]);
  const declined = { ...file, requests: file.requests.map((request) => ({ ...request, state: "declined" as const })) };
  expect(attentionNotices(declined, T0)).toEqual([]);
});


test.each([20, 200])("production attention reads decode only the two named alias-target tasks with %i unrelated tasks", async (count) => {
  const task = (id: string, findingKey?: string): BoardTask => ({ id, project: "demo", status: "inbox", text: id,
    placement: "unplaced", assignments: [], ...(findingKey ? { findingKey } : {}), createdAt: T0.toISOString(), updatedAt: T0.toISOString() });
  // Deliberately reverse the requested order: the response keeps store order.
  raise({ target: { kind: "task", taskId: "task-second" } });
  raiseAttentionRequest({ origin: "operator", target: { kind: "task", taskId: "task-first" },
    frameAtCreation: frame, intent: "show", reason: "Read the task" }, { now: T0, id: "attention_2" });
  mutateTasks(() => ({ tasks: [task("task-first", "finding-first"), ...Array.from({ length: count }, (_, i) => task(`task-unrelated-${i}`)), task("task-second", "finding-second")], result: null }));
  const aliasesFile = path.join(path.dirname(TASKS_FILE), "project-aliases.json");
  const priorAliases = fs.existsSync(aliasesFile) ? fs.readFileSync(aliasesFile) : null;
  fs.writeFileSync(aliasesFile, JSON.stringify({ schemaVersion: 1, aliases: { "demo-legacy": "demo" }, displayNames: {} }));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      const { readAttribution } = await import("./src/lib/readAttribution");
      const { attentionForDevice } = await import("./src/lib/attention/service");
      let decoded = 0;
      const original = readAttribution.sync.bind(readAttribution);
      readAttribution.sync = (...args) => {
        const result = original(...args);
        if (args[0] === "state.json" && result && typeof result === "object" && String(result.id).startsWith("task-")) decoded++;
        return result;
      };
      const response = attentionForDevice("device-desktop", { now: new Date("2026-07-01T10:00:00.000Z"), filePath: process.env.ATTENTION_FIXTURE });
      console.log(JSON.stringify({ decoded, ids: response.records?.tasks.map(row => row.id) }));
    `], { env: { ...process.env, LLV_STATE_DIR: path.dirname(TASKS_FILE), ATTENTION_FIXTURE: path.join(sandbox, "attention.json") },
      stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, err }).toEqual({ exit: 0, err: "" });
    expect(JSON.parse(out)).toEqual({ decoded: 2, ids: ["task-first", "task-second"] });
  } finally {
    if (priorAliases === null) fs.rmSync(aliasesFile, { force: true });
    else fs.writeFileSync(aliasesFile, priorAliases);
  }
  loadPipelinesForList();
  // Frozen readers remain valid after the attention projection has run.
  const frozen = loadTasksForList();
  const before = JSON.stringify(frozen);
  let decoded = 0;
  const original = readAttribution.sync.bind(readAttribution);
  const hook = spyOn(readAttribution, "sync").mockImplementation(<T>(reader: string, work: () => T, connection = 0, bytes = 0, sampleIo = true, counters?: ReadTotals) => {
    const result = original(reader, work, connection, bytes, sampleIo, counters);
    if (reader === "state.json" && result && typeof result === "object" && "id" in result
      && String(result.id).startsWith("task-")) decoded++;
    return result;
  });
  try {
    const response = attentionForDevice(DEVICE, { now: T0 });
    expect(response.records?.tasks.map(row => row.id)).toEqual(["task-first", "task-second"]);
    expect(decoded).toBe(2);
    expect(JSON.stringify(frozen)).toBe(before);
  } finally { hook.mockRestore(); }
});

test("attention task records match the full reader's ownership projection for duplicate findings", () => {
  const finding = (id: string, count: number, createdAt: string): BoardTask => ({
    id, project: "demo", status: "inbox", text: id, placement: "unplaced", assignments: [],
    findingKey: "finding:duplicate", finding: { count, lastSeenAt: createdAt }, createdAt, updatedAt: createdAt,
  });
  const older = finding("task-older", 1, "2026-07-01T09:00:00.000Z");
  const newer = finding("task-newer", 2, "2026-07-01T09:30:00.000Z");
  mutateTasks(() => ({ tasks: [older, newer], result: null }));
  raise({ target: { kind: "task", taskId: older.id } });
  raiseAttentionRequest({ origin: "operator", target: { kind: "task", taskId: newer.id },
    frameAtCreation: frame, intent: "show", reason: "Read the duplicate finding" }, { now: T0, id: "attention_2" });

  const expected = loadTasksForList().filter(task => task.id === older.id || task.id === newer.id);
  const response = attentionForDevice(DEVICE, { now: T0 }).records?.tasks;
  expect(expected).toMatchObject([
    { id: older.id, findingKey: "finding:duplicate", finding: { count: 3, lastSeenAt: newer.createdAt } },
    { id: newer.id },
  ]);
  expect(expected[1]).not.toHaveProperty("findingKey");
  expect(response).toEqual(expected);
});

test("attention surface reads frozen records in store order, caps tasks, and never changes its rows", () => {
  const tasks = deepFreeze(Array.from({ length: 10 }, (_, index): BoardTask => ({
    id: `task-${index}`, project: "demo", status: "inbox", text: "Read this task",
    placement: "unplaced", assignments: [], createdAt: T0.toISOString(), updatedAt: T0.toISOString(),
  })));
  const ids = tasks.map(task => task.id).reverse();
  const pipelines = deepFreeze([{ id: "pipeline-frozen", taskIds: ids, createdAt: T0.toISOString() } as Pipeline]);
  const before = JSON.stringify({ tasks, pipelines });
  const records = { pipelines: () => pipelines, tasks: (wanted: ReadonlySet<string>, limit: number) => {
    expect([...wanted]).toEqual(ids);
    expect(limit).toBe(8);
    return tasks;
  } };
  for (let pass = 0; pass < 2; pass++) {
    const read = attentionRecordsForSurface({ now: T0, records }).records;
    expect(read?.tasks.map(task => task.id)).toEqual(tasks.slice(0, 8).map(task => task.id));
    expect(read?.pipelines).toEqual(pipelines);
    expect(JSON.stringify({ tasks, pipelines })).toBe(before);
  }
  expect(attentionRecordsForSurface({ now: T0, records: {
    pipelines: () => [], tasks: () => { throw new Error("unexpected task read"); },
  } }).records).toBeNull();
  expect(() => attentionRecordsForSurface({ now: T0, records: {
    pipelines: () => pipelines, tasks: () => { throw new Error("task store unavailable"); },
  } })).toThrow("task store unavailable");
});
