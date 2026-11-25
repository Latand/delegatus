import { describe, expect, test } from "bun:test";

import { authorizedManagerSeats, deputyPrincipal, type DeputyPrincipalSources, type ManagerAuthoritySources, type ManagerConversationFacts } from "./authority";
import type { OrchestratorDeputy } from "./deputies";
import type { OrchestratorRevocation, OrchestratorSeat } from "./seats";

function seat(overrides: Partial<OrchestratorSeat> & { conversationId: string; project: string; seatEpoch: number }): OrchestratorSeat {
  return {
    path: null,
    mandate: "m",
    promptVersion: null,
    predecessorConversationId: null,
    state: "active",
    intent: { clientRequestId: "req_0000001", mode: "spawn", launchId: null, error: null },
    designatedAt: "2026-07-29T00:00:00.000Z",
    activatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

const LIVE: ManagerConversationFacts = { superseded: false, hasGeneration: true, project: null };

function sources(overrides: Partial<ManagerAuthoritySources>): ManagerAuthoritySources {
  return {
    activeSeats: () => [],
    revocations: () => [],
    conversationFacts: () => LIVE,
    resolveAlias: (id) => id,
    ...overrides,
  };
}

const ids = (sourcesValue: ManagerAuthoritySources) => authorizedManagerSeats(sourcesValue).map((entry) => entry.conversationId);

test("an active seat with live registry facts is authorized", () => {
  const value = sources({ activeSeats: () => [seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 1 })] });
  expect(ids(value)).toEqual(["conversation_a"]);
});

test("no active seat grants no manager authority", () => {
  expect(ids(sources({}))).toEqual([]);
});

test("fails closed when the registry does not know the conversation at all", () => {
  const value = sources({
    activeSeats: () => [seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 1 })],
    conversationFacts: () => null,
  });
  expect(ids(value)).toEqual([]);
});

test("fails closed on a missing generation and on a superseded conversation", () => {
  const seats = () => [seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 1 })];
  expect(ids(sources({ activeSeats: seats, conversationFacts: () => ({ ...LIVE, hasGeneration: false }) }))).toEqual([]);
  expect(ids(sources({ activeSeats: seats, conversationFacts: () => ({ ...LIVE, superseded: true }) }))).toEqual([]);
});

test("fails closed on a cross-project identity: seat project contradicts durable ownership", () => {
  const value = sources({
    activeSeats: () => [seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 1 })],
    conversationFacts: () => ({ ...LIVE, project: "proj-b" }),
  });
  expect(ids(value)).toEqual([]);
});

test("fails closed when two projects claim the same conversation", () => {
  const value = sources({
    activeSeats: () => [
      seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 1 }),
      seat({ conversationId: "conversation_a", project: "proj-b", seatEpoch: 2 }),
    ],
  });
  expect(ids(value)).toEqual([]);
});

test("revocation kills the seat it names; re-designation at a newer epoch survives (ABA)", () => {
  const revocation: OrchestratorRevocation = { project: "proj-a", conversationId: "conversation_a", seatEpoch: 3, revokedAt: "2026-07-29T00:00:00.000Z" };
  /* A stale seat at the revoked epoch (a predecessor returning from pause, or
     a re-adopted transcript replaying an old file) stays dead. */
  expect(ids(sources({
    activeSeats: () => [seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 3 })],
    revocations: () => [revocation],
  }))).toEqual([]);
  /* The operator deliberately re-designating the same conversation mints a
     strictly newer epoch, which is alive again. */
  expect(ids(sources({
    activeSeats: () => [seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 4 })],
    revocations: () => [revocation],
  }))).toEqual(["conversation_a"]);
});

test("identity survives migration: seats and revocations compare by canonical alias", () => {
  const alias = (id: string) => (id === "conversation_old" ? "conversation_new" : id);
  expect(authorizedManagerSeats(sources({
    activeSeats: () => [seat({ conversationId: "conversation_old", project: "proj-a", seatEpoch: 1 })],
    resolveAlias: alias,
  }))).toEqual([{ conversationId: "conversation_new", path: null, project: "proj-a" }]);
});

test("a snapshot resolves each relevant alias once and a later decision reads a new revocation", () => {
  let resolutions = 0;
  const revocations: OrchestratorRevocation[] = [
    ...Array.from({ length: 100 }, (_, index) => ({
      project: "project-a", conversationId: `conversation_older-${index}`, seatEpoch: 1,
      revokedAt: "2026-10-01T00:00:00.000Z",
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      project: "project-a", conversationId: `conversation_peer-${index % 5}`, seatEpoch: 2,
      revokedAt: "2026-10-01T00:00:30.000Z",
    })),
  ];
  const value = sources({
    activeSeats: () => [seat({ conversationId: "conversation_a", project: "project-a", seatEpoch: 2 }),
      seat({ conversationId: "conversation_b", project: "project-b", seatEpoch: 2 })],
    revocations: () => revocations,
    withAliases: read => read(id => { resolutions++; return id === "conversation_old" ? "conversation_a" : id; }),
  });
  expect(ids(value)).toEqual(["conversation_a", "conversation_b"]);
  // 2 active seats + 5 unique peer revocations at epoch >= 2; all 100 epoch-1 rows skipped.
  expect(resolutions).toBe(7);
  revocations.push({ project: "project-a", conversationId: "conversation_old", seatEpoch: 2, revokedAt: "2026-10-01T00:01:00.000Z" });
  resolutions = 0;
  expect(ids(value)).toEqual(["conversation_b"]);
  expect(resolutions).toBe(8);
});

test("conflicting multi-project seats skip revocation scans and caller-scoped minEpoch prunes unrelated history", () => {
  let revocationReads = 0;
  let resolutions = 0;
  const conflict = sources({
    activeSeats: () => [
      seat({ conversationId: "conversation_a", project: "proj-a", seatEpoch: 1 }),
      seat({ conversationId: "conversation_a", project: "proj-b", seatEpoch: 2 }),
    ],
    revocations: () => { revocationReads++; return []; },
    resolveAlias: id => id,
  });
  expect(authorizedManagerSeats(conflict, "conversation_a")).toEqual([]);
  expect(revocationReads).toBe(0);

  const history: OrchestratorRevocation[] = Array.from({ length: 50 }, (_, index) => ({
    project: "proj-old", conversationId: `conversation_hist_${index}`, seatEpoch: index + 1,
    revokedAt: "2026-10-01T00:00:00.000Z",
  }));
  const scoped = sources({
    activeSeats: () => [
      seat({ conversationId: "conversation_old_seat", project: "proj-old", seatEpoch: 1 }),
      seat({ conversationId: "conversation_fresh_seat", project: "proj-fresh", seatEpoch: 51 }),
    ],
    revocations: () => history,
    resolveAlias: id => { resolutions++; return id === "conversation_alias" ? "conversation_fresh_seat" : id; },
  });
  expect(authorizedManagerSeats(scoped, "conversation_fresh_seat")).toEqual([
    { conversationId: "conversation_fresh_seat", path: null, project: "proj-fresh" },
  ]);
  // Only the 2 active seats resolved; all 50 revocations with epoch < 51 skipped.
  expect(resolutions).toBe(2);
  history.push({ project: "proj-fresh", conversationId: "conversation_alias", seatEpoch: 51, revokedAt: "2026-10-01T00:01:00.000Z" });
  resolutions = 0;
  expect(authorizedManagerSeats(scoped, "conversation_fresh_seat")).toEqual([]);
  expect(resolutions).toBe(3);
});

test("a named caller checks only its canonical claim, skipping history when no active seat matches", () => {
  const a = seat({ project: "proj-a", conversationId: "conversation_old", seatEpoch: 5 });
  const b = seat({ project: "proj-b", conversationId: "conversation_b", seatEpoch: 2 });
  const revocations: OrchestratorRevocation[] = [];
  let decisions = 0, historyReads = 0;
  const checked: string[] = [];
  const value = sources({
    activeSeats: () => [a, b],
    revocations: () => { historyReads++; return revocations; },
    conversationFacts: id => { checked.push(id); return LIVE; },
    resolveAlias: () => { throw Error("unexpected separate alias read"); },
    withAliases: read => {
      decisions++;
      return read(id => id === "conversation_old" ? "conversation_a" : id);
    },
  });

  expect(authorizedManagerSeats(value, "conversation_worker")).toEqual([]);
  expect(authorizedManagerSeats(value, "conversation_old")).toEqual([]);
  expect(historyReads).toBe(0);
  expect(checked).toEqual([]);
  expect(authorizedManagerSeats(value, "conversation_a")).toEqual([
    { conversationId: "conversation_a", project: "proj-a", path: null },
  ]);
  expect(checked).toEqual(["conversation_a"]);
  revocations.push({ project: a.project, conversationId: "conversation_old", seatEpoch: 5, revokedAt: a.designatedAt });
  expect(authorizedManagerSeats(value, "conversation_a")).toEqual([]);
  expect(ids(value)).toEqual(["conversation_b"]);
  expect(decisions).toBe(5);
});

/* docs/design/ghost-seat.md §4: a deputy speaks for its seat only while that
   seat holds the project at the same epoch, the record is live, and nothing
   revoked the seat. */
describe("deputyPrincipal", () => {
  const NOW = Date.parse("2026-09-26T12:05:00.000Z");
  const SEAT = seat({ conversationId: "conversation_seat", project: "proj-a", seatEpoch: 7, path: "/t/seat.jsonl" });

  function deputy(overrides: Partial<OrchestratorDeputy> = {}): OrchestratorDeputy {
    return {
      askId: "deputy_1",
      clientRequestId: "ask-1",
      project: "proj-a",
      seatConversationId: "conversation_seat",
      seatEpoch: 7,
      seatPath: "/t/seat.jsonl",
      deputyConversationId: "conversation_ghost",
      ask: { text: "add a task", images: 0, sender: null, origin: { kind: "operator" } },
      artifactPath: "/t/ghost.jsonl",
      forkRecordCount: 40,
      forkBytes: 4096,
      state: "active",
      startedAt: "2026-09-26T12:00:00.000Z",
      expiresAt: "2026-09-26T12:15:00.000Z",
      activatedAt: "2026-09-26T12:00:05.000Z",
      endedAt: null,
      outcome: null,
      touched: { taskIds: [], pipelineIds: [], conversationIds: [] },
      result: null,
      note: null,
      error: null,
      ...overrides,
    };
  }

  function principalSources(overrides: Partial<DeputyPrincipalSources> = {}): DeputyPrincipalSources {
    return {
      deputies: () => [deputy()],
      activeSeat: (project) => (project === "proj-a" ? SEAT : null),
      revocations: () => [],
      now: () => NOW,
      ...overrides,
    };
  }

  test("a live deputy resolves to its seat", () => {
    expect(deputyPrincipal("conversation_ghost", principalSources())).toEqual({
      project: "proj-a",
      seatConversationId: "conversation_seat",
      seatPath: "/t/seat.jsonl",
      seatEpoch: 7,
      deputyConversationId: "conversation_ghost",
      askId: "deputy_1",
    });
    expect(deputyPrincipal("conversation_other", principalSources())).toBeNull();
  });

  test("not after a rotation: the seat moved to a newer epoch or another conversation", () => {
    expect(deputyPrincipal("conversation_ghost", principalSources({ activeSeat: () => ({ ...SEAT, seatEpoch: 8 }) }))).toBeNull();
    expect(deputyPrincipal("conversation_ghost", principalSources({ activeSeat: () => ({ ...SEAT, conversationId: "conversation_next", seatEpoch: 8 }) }))).toBeNull();
    expect(deputyPrincipal("conversation_ghost", principalSources({ activeSeat: () => null }))).toBeNull();
  });

  test("not after the record ended", () => {
    const ended = () => [deputy({ state: "ended", endedAt: "2026-09-26T12:03:00.000Z", outcome: "done" })];
    expect(deputyPrincipal("conversation_ghost", principalSources({ deputies: ended }))).toBeNull();
  });

  test("not at or after expiry", () => {
    expect(deputyPrincipal("conversation_ghost", principalSources({ now: () => Date.parse("2026-09-26T12:15:00.000Z") }))).toBeNull();
    expect(deputyPrincipal("conversation_ghost", principalSources({ deputies: () => [deputy({ expiresAt: "not a date" })] }))).toBeNull();
  });

  test("never when the seat is revoked at its epoch or later", () => {
    const revoked: OrchestratorRevocation = { project: "proj-a", conversationId: "conversation_seat", seatEpoch: 7, revokedAt: "2026-09-26T12:04:00.000Z" };
    expect(deputyPrincipal("conversation_ghost", principalSources({ revocations: () => [revoked] }))).toBeNull();
    const older: OrchestratorRevocation = { ...revoked, seatEpoch: 6 };
    expect(deputyPrincipal("conversation_ghost", principalSources({ revocations: () => [older] }))).not.toBeNull();
  });
});
