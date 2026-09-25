import { describe, expect, test } from "bun:test";

import type { AttentionDismissalMark } from "@/lib/attention/dismissalTypes";
import type { FileEntry, PendingQuestion, StuckDelivery, WaitingInput } from "@/lib/types";

import { BRIDGE_ASK_TTL_SECONDS } from "@/lib/bridge/types";

import { advanceAttentionCycle, attentionExpiries, attentionId, attentionReason, buildAttentionQueue, nextAttention, STALLED_ATTENTION_TTL, stalledAttention } from "./attention";

const NOW = 1_800_000_000;

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW - 60,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

function question(toolUseId: string, askedAt: number): PendingQuestion {
  return {
    kind: "question",
    toolUseId,
    transcriptPath: "/t",
    pid: 1,
    paneTarget: null,
    askedAt: new Date(askedAt * 1000).toISOString(),
  };
}

function waiting(since: number): WaitingInput {
  return { since, screenTail: "❯ 1. Yes", target: "llv:0.0", menu: null };
}

function owed(sinceSeconds: number, state: StuckDelivery["state"] = "held"): StuckDelivery {
  return { since: new Date(sinceSeconds * 1000).toISOString(), attempts: 1, state };
}

const HALF_HOUR = 30 * 60;

describe("attentionId", () => {
  test("precedence: question > waiting > owed message > null; a wall and a stall raise nothing", () => {
    const both = entry({
      path: "/q",
      activity: "stalled",
      proc: "running",
      pendingQuestion: question("toolu_1", NOW - 10),
      rateLimit: { source: "pane", accountId: null, window: null, resetAt: NOW + 60 },
      waitingInput: waiting(NOW - 20),
    });
    expect(attentionId(both, NOW)).toBe("toolu_1");
    const limited = entry({
      path: "/limited",
      activity: "stalled",
      rateLimit: { source: "pane", accountId: null, window: null, resetAt: NOW + 60 },
      waitingInput: waiting(NOW - 20),
    });
    expect(attentionId(limited, NOW)).toBe(`/limited:waiting:${NOW - 20}`);
    const wait = entry({ path: "/w", activity: "stalled", waitingInput: waiting(NOW - 20), stuckDelivery: owed(NOW - 2 * HALF_HOUR) });
    expect(attentionId(wait, NOW)).toBe(`/w:waiting:${NOW - 20}`);
    const delivery = entry({ path: "/d", stuckDelivery: owed(NOW - 2 * HALF_HOUR) });
    expect(attentionId(delivery, NOW)).toBe(`/d:delivery:${NOW - 2 * HALF_HOUR}`);
    const stalled = entry({ path: "/s", activity: "stalled", proc: "running", mtime: NOW - 300 });
    expect(attentionId(stalled, NOW)).toBeNull();
    expect(attentionId(entry({ path: "/idle" }), NOW)).toBeNull();
    expect(attentionId(entry({ path: "/live", activity: "live" }), NOW)).toBeNull();
  });

  /* docs/design/needs-attention.md §3, reason 4: the wall lifts on its own
     clock and nothing waits on the operator. */
  test("a rate-limited live conversation raises nothing", () => {
    const limited = entry({
      path: "/limited",
      activity: "live",
      proc: "running",
      rateLimit: { source: "pane", accountId: "main", window: "session", resetAt: NOW + 900 },
    });

    expect(attentionId(limited, NOW)).toBeNull();
    expect(attentionReason(limited, NOW)).toBeNull();
    expect(buildAttentionQueue([limited], NOW)).toEqual([]);
  });

  /* The toast seen-set and push-sent.json entries carry ids in the historical
     inline format; the shared helper must reproduce it byte for byte. */
  test("id strings are byte-identical to the historical inline derivation", () => {
    const q = entry({ path: "/a", pendingQuestion: question("toolu_abc", NOW) });
    expect(attentionId(q, NOW)).toBe(q.pendingQuestion!.toolUseId);
    const w = entry({ path: "/b", waitingInput: waiting(NOW - 33.7) });
    expect(attentionId(w, NOW)).toBe(`${w.path}:waiting:${Math.floor(w.waitingInput!.since)}`);
    const d = entry({ path: "/c", stuckDelivery: owed(NOW - HALF_HOUR - 0.9) });
    expect(attentionId(d, NOW)).toBe(`${d.path}:delivery:${Math.floor(NOW - HALF_HOUR - 0.9)}`);
  });
});

/* The row still says «Stalled»; the rule no longer raises needs-you
   (docs/design/needs-attention.md §3, reason 7). */
describe("stalledAttention", () => {
  test("TTL boundary: in at 2h, out just past it, and never an attention id", () => {
    const inside = entry({ path: "/in", activity: "stalled", proc: "running", mtime: NOW - STALLED_ATTENTION_TTL });
    expect(stalledAttention(inside, NOW)).toBe(true);
    expect(attentionId(inside, NOW)).toBeNull();
    const outside = entry({ path: "/out", activity: "stalled", proc: "running", mtime: NOW - STALLED_ATTENTION_TTL - 1 });
    expect(stalledAttention(outside, NOW)).toBe(false);
  });

  test("a stalled session without a live process is not stalled", () => {
    expect(stalledAttention(entry({ path: "/dead", activity: "stalled", proc: null }), NOW)).toBe(false);
    expect(stalledAttention(entry({ path: "/done", activity: "stalled", proc: "done" }), NOW)).toBe(false);
    expect(stalledAttention(entry({ path: "/killed", activity: "stalled", proc: "killed" }), NOW)).toBe(false);
  });
});

/* docs/design/needs-attention.md §4: one named reason per conversation. */
describe("attentionReason", () => {
  const ASK = { id: "lane-4-blocked", at: new Date((NOW - 900) * 1000).toISOString() };

  test("names each kept reason, with its id and its start", () => {
    expect(attentionReason(entry({ path: "/seat", bridgeAsk: ASK }), NOW)).toMatchObject({ kind: "decision", id: "lane-4-blocked", since: NOW - 900, raisedAt: NOW - 900, dismissal: null });
    const asked = entry({ path: "/q", pendingQuestion: { ...question("toolu_q", NOW - 60), questions: [{ question: "Which unit stays?", header: " Unit ", multiSelect: false, options: [] }] } });
    expect(attentionReason(asked, NOW)).toMatchObject({ kind: "question", id: "toolu_q", since: NOW - 60, header: "Unit" });
    const plan = entry({ path: "/p", pendingQuestion: { ...question("toolu_p", NOW - 30), kind: "plan" } });
    expect(attentionReason(plan, NOW)).toMatchObject({ kind: "plan", id: "toolu_p", header: null });
    expect(attentionReason(entry({ path: "/w", waitingInput: waiting(NOW - 20) }), NOW)).toMatchObject({ kind: "permission", id: `/w:waiting:${NOW - 20}` });
    expect(attentionReason(entry({ path: "/d", stuckDelivery: owed(NOW - HALF_HOUR) }), NOW)).toMatchObject({
      kind: "delivery", id: `/d:delivery:${NOW - HALF_HOUR}`, since: NOW - HALF_HOUR, raisedAt: NOW,
    });
  });

  test("an owed message asks at thirty minutes and not at twenty-nine", () => {
    const early = entry({ path: "/d", stuckDelivery: owed(NOW - 29 * 60) });
    expect(attentionReason(early, NOW)).toBeNull();
    expect(attentionReason(early, NOW + 60)).toMatchObject({ kind: "delivery" });
  });

  test("a record the server already calls uncertain asks at once, from its admission", () => {
    const uncertain = entry({ path: "/d", stuckDelivery: owed(NOW - 60, "delivery-uncertain") });
    expect(attentionReason(uncertain, NOW)).toMatchObject({ kind: "delivery", since: NOW - 60, raisedAt: NOW - 60 });
  });

  test("a stalled turn with a question open is a question", () => {
    const quiet = entry({ path: "/q", activity: "stalled", proc: "running", mtime: NOW - 400, pendingQuestion: question("toolu_q", NOW - 500) });
    expect(attentionReason(quiet, NOW)?.kind).toBe("question");
  });
});

/* docs/design/needs-attention.md §5: a dismissal hides what started at or
   before it, and something newer comes back. */
describe("dismissals", () => {
  const mark = (atSeconds: number, reasonId: string | null = null): AttentionDismissalMark => ({
    at: new Date(atSeconds * 1000).toISOString(),
    by: { kind: "operator", surface: "desktop" },
    reasonId,
  });

  test("hides a reason that started at or before it, and keeps it named", () => {
    const asked = entry({ path: "/q", pendingQuestion: question("toolu_q", NOW - 60), attentionDismissal: mark(NOW - 60) });
    const reason = attentionReason(asked, NOW);
    expect(reason).toMatchObject({ kind: "question", id: "toolu_q" });
    expect(reason?.dismissal?.by).toEqual({ kind: "operator", surface: "desktop" });
    expect(attentionId(asked, NOW)).toBeNull();
    expect(buildAttentionQueue([asked], NOW)).toEqual([]);
  });

  test("a newer question comes back", () => {
    const again = entry({ path: "/q", pendingQuestion: question("toolu_next", NOW - 10), attentionDismissal: mark(NOW - 60) });
    expect(attentionId(again, NOW)).toBe("toolu_next");
    expect(attentionReason(again, NOW)?.dismissal).toBeNull();
  });

  test("an owed message is dismissed from when it began to ask", () => {
    const delivery = entry({ path: "/d", stuckDelivery: owed(NOW - 2 * HALF_HOUR), attentionDismissal: mark(NOW - HALF_HOUR - 1) });
    /* It began to ask at admission + 30 min, one second after the dismissal. */
    expect(attentionId(delivery, NOW)).toBe(`/d:delivery:${NOW - 2 * HALF_HOUR}`);
    expect(attentionId({ ...delivery, attentionDismissal: mark(NOW - HALF_HOUR) }, NOW)).toBeNull();
  });

  test("an undated question is compared by the id that was on screen", () => {
    const undated = entry({ path: "/q", mtime: NOW - 5, pendingQuestion: { ...question("toolu_q", NOW), askedAt: "sometime" } });
    expect(attentionId({ ...undated, attentionDismissal: mark(NOW - 100) }, NOW)).toBe("toolu_q");
    expect(attentionId({ ...undated, attentionDismissal: mark(NOW - 100, "toolu_q") }, NOW)).toBeNull();
    expect(attentionId({ ...undated, attentionDismissal: mark(NOW - 100, "toolu_other") }, NOW)).toBe("toolu_q");
  });

  test("a stale card's dismissal does not hide the question asked after it was drawn", () => {
    /* The card still shows toolu_q1. It was answered and toolu_q2 asked at
       NOW - 3; the tap lands at NOW, naming the question it drew. */
    const next = entry({ path: "/q", pendingQuestion: question("toolu_q2", NOW - 3), attentionDismissal: mark(NOW, "toolu_q1") });
    expect(attentionId(next, NOW)).toBe("toolu_q2");
    expect(attentionReason(next, NOW)?.dismissal).toBeNull();
    /* The question it drew stays cleared. */
    expect(attentionId({ ...next, pendingQuestion: question("toolu_q1", NOW - 60) }, NOW)).toBeNull();
  });

  test("a dismissal of one reason does not hide a message that turned uncertain after it", () => {
    /* Owed since NOW - 300, uncertain since a moment ago; a question was
       cleared at NOW - 180, while the message still asked nothing. */
    const uncertain = entry({ path: "/d", stuckDelivery: owed(NOW - 300, "delivery-uncertain"), attentionDismissal: mark(NOW - 180, "toolu_q1") });
    expect(attentionId(uncertain, NOW)).toBe(`/d:delivery:${NOW - 300}`);
    /* A dismissal of that message itself keeps covering it. */
    expect(attentionId({ ...uncertain, attentionDismissal: mark(NOW - 60, `/d:delivery:${NOW - 300}`) }, NOW)).toBeNull();
  });

  test("a dismissal whose own time does not parse covers nothing", () => {
    const asked = entry({ path: "/q", pendingQuestion: question("toolu_q", NOW - 60), attentionDismissal: { at: "never", by: { kind: "operator" } } });
    expect(attentionId(asked, NOW)).toBe("toolu_q");
  });

  test("an agent's dismissal is attributed as the agent", () => {
    const asked = entry({
      path: "/q",
      pendingQuestion: question("toolu_q", NOW - 60),
      attentionDismissal: { at: new Date(NOW * 1000).toISOString(), by: { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" } },
    });
    expect(attentionReason(asked, NOW)?.dismissal?.by).toEqual({ kind: "manager", conversationId: "conversation_seat", role: "orchestrator" });
  });
});

describe("buildAttentionQueue", () => {
  test("a stalled turn is not queued; a question is, with its reason", () => {
    const files = [
      entry({ path: "/old-stall", activity: "stalled", proc: "running", mtime: NOW - 7000 }),
      entry({ path: "/fresh-q", pendingQuestion: question("toolu_q", NOW - 5) }),
    ];
    const queue = buildAttentionQueue(files, NOW);
    expect(queue.map((item) => item.file.path)).toEqual(["/fresh-q"]);
    expect(queue[0]).toMatchObject({ tier: "blocked", reason: { kind: "question" } });
  });

  test("FIFO inside a segment: oldest wait first", () => {
    const files = [
      entry({ path: "/newer", waitingInput: waiting(NOW - 10) }),
      entry({ path: "/oldest", pendingQuestion: question("toolu_o", NOW - 900) }),
      entry({ path: "/mid", waitingInput: waiting(NOW - 100) }),
    ];
    const queue = buildAttentionQueue(files, NOW);
    expect(queue.map((item) => item.file.path)).toEqual(["/oldest", "/mid", "/newer"]);
  });

  test("id breaks ties on equal since", () => {
    const files = [
      entry({ path: "/b", waitingInput: waiting(NOW - 50) }),
      entry({ path: "/a", waitingInput: waiting(NOW - 50) }),
    ];
    const queue = buildAttentionQueue(files, NOW);
    expect(queue.map((item) => item.id)).toEqual([`/a:waiting:${NOW - 50}`, `/b:waiting:${NOW - 50}`]);
  });

  test("project filter narrows, omitting it keeps all projects", () => {
    const files = [
      entry({ path: "/p1", project: "alpha", waitingInput: waiting(NOW - 10) }),
      entry({ path: "/p2", project: "beta", waitingInput: waiting(NOW - 20) }),
    ];
    expect(buildAttentionQueue(files, NOW).length).toBe(2);
    const alpha = buildAttentionQueue(files, NOW, "alpha");
    expect(alpha.map((item) => item.file.path)).toEqual(["/p1"]);
    expect(alpha[0]!.project).toBe("alpha");
  });

  test("since sources: askedAt for questions, since for waiting, admission for an owed message", () => {
    const files = [
      entry({ path: "/q", pendingQuestion: question("toolu_s", NOW - 111) }),
      entry({ path: "/w", waitingInput: waiting(NOW - 222) }),
      entry({ path: "/d", stuckDelivery: owed(NOW - HALF_HOUR - 333) }),
    ];
    const bySince = new Map(buildAttentionQueue(files, NOW).map((item) => [item.file.path, item.since]));
    expect(bySince.get("/q")).toBe(NOW - 111);
    expect(bySince.get("/w")).toBe(NOW - 222);
    expect(bySince.get("/d")).toBe(NOW - HALF_HOUR - 333);
  });
});

/* #1168 — the orchestrator's own `blocked`/`question` bridge reports. The
   gateway used to be the only thing that ever read them, so with the voice
   channel off "I need a decision" reached the operator as prose and nothing
   else. The server stamps the open ask onto the seat's entry; the queue turns
   it into a first-class hard block, and owns the clock that retires it. */
describe("bridge asks", () => {
  const ASK = { id: "lane-4-blocked", at: new Date((NOW - 900) * 1000).toISOString() };

  test("an open ask is a blocked item keyed by the report key, dated by the report", () => {
    const seat = entry({ path: "/seat", bridgeAsk: ASK });
    expect(attentionId(seat, NOW)).toBe("lane-4-blocked");
    expect(buildAttentionQueue([seat], NOW)).toMatchObject([
      { id: "lane-4-blocked", tier: "blocked", since: NOW - 900, project: "demo" },
    ]);
  });

  test("the ask outranks the seat's own local prompt", () => {
    const seat = entry({
      path: "/seat",
      bridgeAsk: ASK,
      pendingQuestion: question("toolu_local", NOW - 10),
      activity: "stalled",
      proc: "running",
    });
    expect(attentionId(seat, NOW)).toBe("lane-4-blocked");
    expect(buildAttentionQueue([seat], NOW)[0]!.since).toBe(NOW - 900);
  });

  test("it sorts by its own age among the other hard blocks", () => {
    const files = [
      entry({ path: "/stall", activity: "stalled", proc: "running", mtime: NOW - 7000 }),
      entry({ path: "/fresh-q", pendingQuestion: question("toolu_q", NOW - 5) }),
      entry({ path: "/seat", bridgeAsk: ASK }),
    ];
    const queue = buildAttentionQueue(files, NOW);
    expect(queue.map((item) => item.file.path)).toEqual(["/seat", "/fresh-q"]);
    expect(queue.map((item) => item.tier)).toEqual(["blocked", "blocked"]);
  });

  test("the project filter keeps the seat inside its own project queue", () => {
    const files = [
      entry({ path: "/seat", project: "alpha", bridgeAsk: ASK }),
      entry({ path: "/other", project: "beta", bridgeAsk: { ...ASK, id: "lane-9-blocked" } }),
    ];
    expect(buildAttentionQueue(files, NOW, "alpha").map((item) => item.id)).toEqual(["lane-4-blocked"]);
  });

  test("re-reading the same ask yields the same single item", () => {
    const seat = entry({ path: "/seat", bridgeAsk: ASK });
    const first = buildAttentionQueue([seat], NOW);
    const second = buildAttentionQueue([entry({ path: "/seat", bridgeAsk: { ...ASK } })], NOW);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
  });

  test("no ask leaves an otherwise quiet seat out of the queue", () => {
    expect(buildAttentionQueue([entry({ path: "/seat" })], NOW)).toEqual([]);
    expect(buildAttentionQueue([entry({ path: "/seat", bridgeAsk: null })], NOW)).toEqual([]);
  });

  /* The expiry has to bind HERE, on the live clock, and not only on the server
     that stamped the ask: /api/files serves a cached projection, and nothing in
     the bridge log moves when a report merely gets old. */
  test("the ask ages out of the queue on the TTL boundary, not before it", () => {
    const filed = NOW - BRIDGE_ASK_TTL_SECONDS;
    const seat = entry({ path: "/seat", bridgeAsk: { id: "lane-4-blocked", at: new Date(filed * 1000).toISOString() } });
    expect(buildAttentionQueue([seat], NOW).map((item) => item.id)).toEqual(["lane-4-blocked"]);
    expect(attentionId(seat, NOW + 1)).toBeNull();
    expect(buildAttentionQueue([seat], NOW + 1)).toEqual([]);
  });

  test("an expired ask falls through to the seat's own signal rather than hiding it", () => {
    const seat = entry({
      path: "/seat",
      bridgeAsk: { id: "lane-4-blocked", at: new Date((NOW - BRIDGE_ASK_TTL_SECONDS - 1) * 1000).toISOString() },
      pendingQuestion: question("toolu_local", NOW - 10),
    });
    expect(buildAttentionQueue([seat], NOW)).toMatchObject([
      { id: "toolu_local", tier: "blocked", since: NOW - 10 },
    ]);
  });

  test("an unparseable ask time enqueues nothing on its own account", () => {
    const seat = entry({ path: "/seat", bridgeAsk: { id: "lane-4-blocked", at: "whenever" } });
    expect(buildAttentionQueue([seat], NOW)).toEqual([]);
  });

  test("the ask's own expiry is one of the ticks the queue schedules, and an owed message's half hour another", () => {
    const filed = NOW - 900;
    const files = [
      entry({ path: "/seat", bridgeAsk: { id: "lane-4-blocked", at: new Date(filed * 1000).toISOString() } }),
      entry({ path: "/stall", activity: "stalled", proc: "running", mtime: NOW - 60 }),
      entry({ path: "/d", stuckDelivery: owed(NOW - 60) }),
    ];
    expect(attentionExpiries(files).sort((a, b) => a - b)).toEqual([
      filed + BRIDGE_ASK_TTL_SECONDS,
      NOW - 60 + HALF_HOUR,
    ].sort((a, b) => a - b));
    /* An unparseable time schedules nothing: there is no moment to wake for. */
    expect(attentionExpiries([entry({ path: "/seat", bridgeAsk: { id: "x", at: "whenever" } })])).toEqual([]);
  });
});

describe("nextAttention", () => {
  const queue = buildAttentionQueue(
    [
      entry({ path: "/1", waitingInput: waiting(NOW - 300) }),
      entry({ path: "/2", waitingInput: waiting(NOW - 200) }),
      entry({ path: "/3", waitingInput: waiting(NOW - 100) }),
    ],
    NOW,
  );
  const ids = queue.map((item) => item.id);

  test("cycles forward and wraps", () => {
    expect(nextAttention(queue, null, 1)?.id).toBe(ids[0]);
    expect(nextAttention(queue, ids[0]!, 1)?.id).toBe(ids[1]);
    expect(nextAttention(queue, ids[2]!, 1)?.id).toBe(ids[0]);
  });

  test("cycles backward and wraps", () => {
    expect(nextAttention(queue, ids[0]!, -1)?.id).toBe(ids[2]);
    expect(nextAttention(queue, ids[1]!, -1)?.id).toBe(ids[0]);
    expect(nextAttention(queue, null, -1)?.id).toBe(ids[2]);
  });

  test("vanished current id falls back to the next-oldest remaining item", () => {
    expect(nextAttention(queue, "gone:id", 1)?.id).toBe(ids[0]);
    expect(nextAttention(queue, "gone:id", -1)?.id).toBe(ids[2]);
  });

  test("empty queue yields null", () => {
    expect(nextAttention([], null, 1)).toBeNull();
    expect(nextAttention([], "toolu_x", -1)).toBeNull();
  });
});

describe("advanceAttentionCycle", () => {
  const files = [
    entry({ path: "/alpha-old", project: "alpha", waitingInput: waiting(NOW - 400) }),
    entry({ path: "/beta-mid", project: "beta", waitingInput: waiting(NOW - 300) }),
    entry({ path: "/alpha-new", project: "alpha", waitingInput: waiting(NOW - 200) }),
  ];
  const global = buildAttentionQueue(files, NOW);
  const alpha = buildAttentionQueue(files, NOW, "alpha");

  test("one pointer serves both the project-scoped keys and the global Next", () => {
    const pointer = { current: null as string | null };
    /* N inside project alpha lands on its oldest item… */
    expect(advanceAttentionCycle(pointer, alpha, 1)?.file.path).toBe("/alpha-old");
    /* …and the global Next continues FROM that id instead of restarting:
       the next-oldest global item is beta's. */
    expect(advanceAttentionCycle(pointer, global, 1)?.file.path).toBe("/beta-mid");
    /* Back on the project queue, the pointer id (beta) is absent, so the
       id-anchored fallback serves the project head — never a stale echo. */
    expect(advanceAttentionCycle(pointer, alpha, 1)?.file.path).toBe("/alpha-old");
    expect(pointer.current).toBe(alpha[0]!.id);
  });

  test("queue mutation during cycling: an answered item drops out and the pointer follows ids", () => {
    const pointer = { current: null as string | null };
    expect(advanceAttentionCycle(pointer, global, 1)?.file.path).toBe("/alpha-old");
    expect(advanceAttentionCycle(pointer, global, 1)?.file.path).toBe("/beta-mid");
    /* The item under the pointer is answered elsewhere: the rebuilt queue no
       longer holds its id, so the next advance serves the queue head. */
    const rebuilt = buildAttentionQueue([files[0]!, files[2]!], NOW);
    expect(advanceAttentionCycle(pointer, rebuilt, 1)?.file.path).toBe("/alpha-old");
    /* A neighbor vanishing does NOT move the pointer off a surviving id:
       cycling continues from it. */
    expect(advanceAttentionCycle(pointer, rebuilt, 1)?.file.path).toBe("/alpha-new");
  });

  test("reverse direction walks the same pointer backward", () => {
    const pointer = { current: null as string | null };
    expect(advanceAttentionCycle(pointer, global, -1)?.file.path).toBe("/alpha-new");
    expect(advanceAttentionCycle(pointer, global, -1)?.file.path).toBe("/beta-mid");
    expect(advanceAttentionCycle(pointer, global, 1)?.file.path).toBe("/alpha-new");
  });

  test("an empty queue serves nothing and leaves the pointer untouched", () => {
    const pointer = { current: global[0]!.id };
    expect(advanceAttentionCycle(pointer, [], 1)).toBeNull();
    expect(advanceAttentionCycle(pointer, [], -1)).toBeNull();
    expect(pointer.current).toBe(global[0]!.id);
  });
});

describe("a launch that failed before it ran (#2170)", () => {
  const failedLaunch = (overrides: Partial<FileEntry> = {}) => entry({
    path: "spawn:launch-1",
    conversationId: "conversation_1",
    spawn: {
      launchId: "launch-1",
      clientAttemptId: "attempt-1",
      accountId: "default",
      state: "failed",
      initialMessage: "failed",
      retrySafe: true,
      error: "No healthy Claude account is available. Re-login Main in Accounts and retry.",
      admittedAt: (NOW - 30) * 1000,
    },
    ...overrides,
  });

  test("the operator's own failed launch needs them, from the moment it was admitted", () => {
    const reason = attentionReason(failedLaunch(), NOW);
    expect(reason).toMatchObject({
      kind: "launch",
      id: "spawn:launch-1:launch-failed",
      since: NOW - 30,
      clocked: true,
      header: "No healthy Claude account is available. Re-login Main in Accounts and retry.",
      dismissal: null,
    });
    expect(buildAttentionQueue([failedLaunch()], NOW).map((item) => item.id)).toEqual(["spawn:launch-1:launch-failed"]);
  });

  test("a launch still starting, one that succeeded, and a delegated one ask nothing", () => {
    const starting = failedLaunch();
    starting.spawn = { ...starting.spawn!, state: "starting" };
    expect(attentionReason(starting, NOW)).toBeNull();
    const stage = failedLaunch({ durableLineage: { kind: "spawn", role: "builder", depth: 0, parentConversationId: null, reviewsConversationId: null, memberships: [{ kind: "pipeline", containerId: "pipe-1", role: "builder", slot: "s", stageId: "build", stageOrder: 0, round: null, parentConversationId: null }] } });
    expect(attentionReason(stage, NOW)).toBeNull();
    const child = failedLaunch({ durableLineage: { kind: "spawn", role: null, depth: 1, parentConversationId: "conversation_parent", reviewsConversationId: null, memberships: [] } });
    expect(attentionReason(child, NOW)).toBeNull();
  });

  test("a dismissal made after the failure clears it", () => {
    const dismissed = failedLaunch({ attentionDismissal: { at: new Date(NOW * 1000).toISOString(), by: { kind: "operator" } } });
    expect(attentionId(dismissed, NOW)).toBeNull();
  });
});
