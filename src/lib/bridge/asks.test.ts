import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { bridgeQuestions, openBridgeAsks, overlayBridgeAsks } from "./asks";
import { BRIDGE_ASK_TTL_SECONDS, type BridgeReportLogV1, type BridgeReportV1 } from "./types";

/**
 * #1168 — the bridge log read as "who is waiting on the operator right now".
 *
 * The gateway is the only consumer that ever drained this log, so a `blocked`
 * or `question` report reached nobody while it was off. These cases pin the
 * derivation the attention queue consumes: every open question of an
 * orchestrator seat, cleared by an answering directive, by the operator
 * resolving it or writing to the seat, by a rotation, or by the clock.
 */

const SEAT = "conversation_manager_a";
const OTHER_SEAT = "conversation_manager_b";
const PROJECT = "repo-project-a";
const OTHER_PROJECT = "repo-project-b";
const NOW = new Date("2026-08-26T12:00:00.000Z");

function report(overrides: Partial<BridgeReportV1> & { seq: number }): BridgeReportV1 {
  return {
    id: `rpt_${overrides.seq}`,
    key: `lane-${overrides.seq}-decide`,
    at: NOW.toISOString(),
    class: "question",
    project: PROJECT,
    targetSeatConversationId: SEAT,
    body: "which base branch should the lane cut from?",
    ...overrides,
  };
}

/** The ids of a seat's open asks, oldest first. */
function ids(asks: Map<string, { id: string }[]>, seat = SEAT): string[] {
  return (asks.get(seat) ?? []).map((ask) => ask.id);
}

function log(reports: BridgeReportV1[], answeredRefs?: number[]): BridgeReportLogV1 {
  return {
    schemaVersion: 1,
    lastSeq: reports.reduce((highest, entry) => Math.max(highest, entry.seq), 0),
    trimmedThroughSeq: 0,
    trimmedThroughByChannel: {},
    reports,
    retired: [],
    ...(answeredRefs ? { answeredRefs } : {}),
  };
}

describe("openBridgeAsks", () => {
  test("a blocked or question report opens one ask against its seat, keyed by the caller's key", () => {
    const asks = openBridgeAsks(
      log([report({ seq: 4, key: "lane-4-blocked", class: "blocked", body: "cannot proceed: pick a base" })]),
      { now: NOW },
    );
    expect([...asks.keys()]).toEqual([SEAT]);
    /* #1168 asks for the REPORT KEY, verbatim — not the hash the log derives
       from it, which cannot be spelled back out. */
    expect(asks.get(SEAT)).toEqual([{ id: "lane-4-blocked", at: NOW.toISOString(), seq: 4, body: "cannot proceed: pick a base" }]);
  });

  test("a row written before the log kept keys opens nothing at all", () => {
    /* #1168 asks for `id = the report key`, verbatim, on EVERY emitted item.
       A legacy row has no key to carry and the hashed `id` cannot be spelled
       back out into one, so the row stays out of this projection rather than
       being enqueued under an identity that is not the one the contract names.
       It is bounded damage: keyless rows predate the field, the log's capacity
       retires them, and the seat's next report opens an ask that does comply. */
    const legacy = report({ seq: 4, class: "blocked" });
    delete legacy.key;
    expect(openBridgeAsks(log([legacy]), { now: NOW }).size).toBe(0);

    /* An empty key is no key either — nothing may reach a card under "". */
    expect(openBridgeAsks(log([report({ seq: 5, class: "blocked", key: "" })]), { now: NOW }).size).toBe(0);

    /* …and it takes nothing away from the questions around it. */
    const keyless = report({ seq: 6, class: "blocked" });
    delete keyless.key;
    expect(ids(openBridgeAsks(log([report({ seq: 2, key: "old-ask", class: "blocked" }), keyless]), { now: NOW }))).toEqual(["old-ask"]);
  });

  test("every emitted item carries the report key it was filed under, and nothing else can be one", () => {
    const asks = openBridgeAsks(
      log([
        report({ seq: 1, key: "ask-a", class: "blocked" }),
        report({ seq: 2, key: "ask-b", class: "question", project: OTHER_PROJECT, targetSeatConversationId: OTHER_SEAT }),
      ]),
      { now: NOW },
    );
    expect([...asks.values()].flat().map((ask) => ask.id)).toEqual(["ask-a", "ask-b"]);
    /* The hashed id never leaks in as a substitute. */
    expect([...asks.values()].flat().some((ask) => ask.id.startsWith("rpt_"))).toBe(false);
  });

  test("classes that are not a decision request open nothing", () => {
    for (const reportClass of ["status", "completed", "failed", "review_verdict"] as const) {
      expect(openBridgeAsks(log([report({ seq: 1, class: reportClass })]), { now: NOW }).size).toBe(0);
    }
  });

  test("only the manager's own voice opens an ask on the manager's card", () => {
    /* Legacy rows carry no origin at all and were manager-only by the gate of
       their era, so they still ask. */
    expect(openBridgeAsks(log([report({ seq: 1 })]), { now: NOW }).size).toBe(1);
    expect(openBridgeAsks(log([report({ seq: 1, origin: { kind: "manager", conversationId: SEAT, role: null } })]), { now: NOW }).size).toBe(1);
    /* `bridge_report` is callable from every session: a worker or the gateway
       filing `blocked` must not raise it against the seat's card. */
    for (const origin of [
      { kind: "agent" as const, conversationId: "conversation_builder", role: "builder" },
      { kind: "gateway" as const, conversationId: "conversation_voice", role: null },
      { kind: "unidentified" as const, conversationId: null, role: null },
    ]) {
      expect(openBridgeAsks(log([report({ seq: 2, origin })]), { now: NOW }).size).toBe(0);
    }
  });

  test("a non-manager row does not supersede the manager's standing ask either", () => {
    const asks = openBridgeAsks(
      log([
        report({ seq: 1, key: "manager-ask" }),
        report({ seq: 9, key: "builder-ask", origin: { kind: "agent", conversationId: "conversation_builder", role: "builder" } }),
      ]),
      { now: NOW },
    );
    expect(ids(asks)).toEqual(["manager-ask"]);
  });

  test("an unrouted or quarantined row never opens an ask", () => {
    expect(openBridgeAsks(log([report({ seq: 1, targetSeatConversationId: null })]), { now: NOW }).size).toBe(0);
    expect(openBridgeAsks(log([report({ seq: 2, project: null })]), { now: NOW }).size).toBe(0);
  });

  test("a directive that answered the seq clears the ask", () => {
    const entries = [report({ seq: 7 })];
    expect(openBridgeAsks(log(entries), { now: NOW }).size).toBe(1);
    expect(openBridgeAsks(log(entries, [7]), { now: NOW }).size).toBe(0);
    /* Another report's seq is not this one's answer. */
    expect(openBridgeAsks(log(entries, [6, 8]), { now: NOW }).size).toBe(1);
  });

  test("every open question of a seat is its own ask, oldest first", () => {
    /* The report log ticks each question and the needs-you panel lists each
       one: a second question must not take the first away before anybody
       read it. */
    const asks = openBridgeAsks(
      log([
        report({ seq: 2, key: "old-ask", body: "first question" }),
        report({ seq: 5, key: "new-ask", body: "second question" }),
      ]),
      { now: NOW },
    );
    expect(ids(asks)).toEqual(["old-ask", "new-ask"]);
  });

  test("the manager filing another report does not answer its question", () => {
    for (const reportClass of ["status", "completed", "failed", "review_verdict"] as const) {
      const asks = openBridgeAsks(
        log([
          report({ seq: 2, key: "old-ask", class: "blocked" }),
          report({ seq: 5, key: "moved-on", class: reportClass }),
        ]),
        { now: NOW },
      );
      expect(ids(asks)).toEqual(["old-ask"]);
    }
  });

  test("an answered question leaves, the rest stay", () => {
    const asks = openBridgeAsks(
      log([report({ seq: 2, key: "old-ask" }), report({ seq: 5, key: "new-ask" })], [5]),
      { now: NOW },
    );
    expect(ids(asks)).toEqual(["old-ask"]);
  });

  test("a question the operator resolved stops asking, and undoing it brings it back", () => {
    const entries = [report({ seq: 2, key: "old-ask" }), report({ seq: 5, key: "new-ask" })];
    const resolved = { ...log(entries), resolvedAsks: [{ seq: 2, at: NOW.toISOString(), by: { kind: "operator" as const, surface: "desktop" as const } }] };
    expect(ids(openBridgeAsks(resolved, { now: NOW }))).toEqual(["new-ask"]);
    const states = bridgeQuestions(resolved, { now: NOW });
    expect(states.map((question) => [question.report.seq, question.state])).toEqual([[2, "resolved"], [5, "open"]]);
    expect(states[0]!.resolved?.at).toBe(NOW.toISOString());
    expect(ids(openBridgeAsks({ ...resolved, resolvedAsks: [] }, { now: NOW }))).toEqual(["old-ask", "new-ask"]);
  });

  test("the operator writing to the seat after a question answers it; before it does not", () => {
    const entries = [
      report({ seq: 2, key: "early", at: new Date(NOW.getTime() - 60_000).toISOString() }),
      report({ seq: 5, key: "late", at: NOW.toISOString() }),
    ];
    const wrote = NOW.getTime() - 30_000;
    const asks = openBridgeAsks(log(entries), {
      now: NOW,
      operatorWroteSince: (seat, atMs) => seat === SEAT && wrote >= atMs,
    });
    expect(ids(asks)).toEqual(["late"]);
    const states = bridgeQuestions(log(entries), { now: NOW, operatorWroteSince: (seat, atMs) => seat === SEAT && wrote >= atMs });
    expect(states.map((question) => question.state)).toEqual(["answered", "open"]);
  });

  test("projects keep their own ask", () => {
    const asks = openBridgeAsks(
      log([
        report({ seq: 1, key: "ask-a" }),
        report({ seq: 2, key: "ask-b", project: OTHER_PROJECT, targetSeatConversationId: OTHER_SEAT }),
      ]),
      { now: NOW },
    );
    expect(ids(asks)).toEqual(["ask-a"]);
    expect(ids(asks, OTHER_SEAT)).toEqual(["ask-b"]);
  });

  test("a rotation retires the predecessor's ask the moment its successor speaks", () => {
    /* A project has exactly one designated orchestrator at a time, so the
       project's last word settles which seat is still asking. Without this the
       retired seat keeps a decision request on a card nobody is behind. */
    const rotated = log([
      report({ seq: 3, key: "predecessor-ask", class: "blocked" }),
      report({ seq: 8, key: "successor-status", class: "status", targetSeatConversationId: OTHER_SEAT }),
    ]);
    expect(openBridgeAsks(rotated, { now: NOW }).size).toBe(0);

    /* …and the successor's own decision request lands on the successor's card. */
    const asking = openBridgeAsks(
      log([
        report({ seq: 3, key: "predecessor-ask", class: "blocked" }),
        report({ seq: 8, key: "successor-ask", class: "question", targetSeatConversationId: OTHER_SEAT }),
      ]),
      { now: NOW },
    );
    expect([...asking.keys()]).toEqual([OTHER_SEAT]);
    expect(ids(asking, OTHER_SEAT)).toEqual(["successor-ask"]);
  });

  test("the ask expires on the TTL boundary, not before it", () => {
    const inside = new Date(NOW.getTime() - BRIDGE_ASK_TTL_SECONDS * 1000).toISOString();
    expect(openBridgeAsks(log([report({ seq: 1, at: inside })]), { now: NOW }).size).toBe(1);
    const outside = new Date(NOW.getTime() - BRIDGE_ASK_TTL_SECONDS * 1000 - 1).toISOString();
    expect(openBridgeAsks(log([report({ seq: 1, at: outside })]), { now: NOW }).size).toBe(0);
  });

  test("an unparseable report time opens nothing rather than an ageless ask", () => {
    expect(openBridgeAsks(log([report({ seq: 1, at: "whenever" })]), { now: NOW }).size).toBe(0);
  });

  test("a seat renamed by a conversation alias still resolves", () => {
    const asks = openBridgeAsks(log([report({ seq: 1, key: "aliased-ask", targetSeatConversationId: "conversation_manager_old" })]), {
      now: NOW,
      canonicalConversationId: (id) => (id === "conversation_manager_old" ? SEAT : id),
    });
    expect(ids(asks)).toEqual(["aliased-ask"]);
  });

  test("the ask carries its seq and the report's first line, bounded", () => {
    const ask = openBridgeAsks(log([report({ seq: 1, key: "bounded", body: "a long decision request\nsecond line" })]), { now: NOW }).get(SEAT)![0]!;
    expect(Object.keys(ask).sort()).toEqual(["at", "body", "id", "seq"]);
    expect(ask.body).toBe("a long decision request");
    const long = openBridgeAsks(log([report({ seq: 1, key: "long", body: "x".repeat(400) })]), { now: NOW }).get(SEAT)![0]!;
    expect(long.body!.length).toBeLessThanOrEqual(240);
  });
});

describe("overlayBridgeAsks", () => {
  function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
    return {
      root: "claude-projects",
      name: overrides.path,
      project: PROJECT,
      title: overrides.path,
      engine: "claude",
      kind: "session",
      fmt: "claude",
      parent: null,
      mtime: 0,
      size: 0,
      activity: "idle",
      proc: null,
      pid: null,
      model: null,
      pendingQuestion: null,
      waitingInput: null,
      ...overrides,
    };
  }

  test("the ask lands on the seat's own entry and nowhere else", () => {
    const files = [
      entry({ path: "/seat.jsonl", conversationId: SEAT }),
      entry({ path: "/worker.jsonl", conversationId: "conversation_worker" }),
      entry({ path: "/unregistered.jsonl" }),
    ];
    overlayBridgeAsks(files, openBridgeAsks(log([report({ seq: 3, key: "seat-ask" })]), { now: NOW }));
    expect(files[0]!.bridgeAsk?.id).toBe("seat-ask");
    expect(files[1]!.bridgeAsk).toBeUndefined();
    expect(files[2]!.bridgeAsk).toBeUndefined();
  });

  test("a retired round never gets the ask back after the projection demoted it", () => {
    /* Terminal supersedence and migration both blank a conversation's live
       attention fields earlier in the files projection because the successor
       carries the live card. An ask stamped afterwards would be the one signal
       that outlived that demotion and would re-raise a dead round. */
    const files = [
      entry({
        path: "/retired.jsonl",
        conversationId: SEAT,
        supersededBy: { conversationId: "conversation_manager_next", path: "/next.jsonl", at: NOW.toISOString(), reason: "rotation" },
      }),
      entry({ path: "/archived.jsonl", conversationId: SEAT, migratedTo: "/successor.jsonl" }),
    ];
    overlayBridgeAsks(files, openBridgeAsks(log([report({ seq: 3, key: "seat-ask" })]), { now: NOW }));
    expect(files[0]!.bridgeAsk).toBeUndefined();
    expect(files[1]!.bridgeAsk).toBeUndefined();
  });

  test("re-reading the same log stamps the same ask, never a second one", () => {
    const files = [entry({ path: "/seat.jsonl", conversationId: SEAT })];
    const asks = openBridgeAsks(log([report({ seq: 3, key: "seat-ask" })]), { now: NOW });
    overlayBridgeAsks(files, asks);
    const first = files[0]!.bridgeAsk;
    overlayBridgeAsks(files, openBridgeAsks(log([report({ seq: 3, key: "seat-ask" })]), { now: NOW }));
    expect(files[0]!.bridgeAsk).toEqual(first!);
  });
});
