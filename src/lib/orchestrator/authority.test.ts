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
      ask: { text: "add a task", images: 0, sender: null },
      artifactPath: "/t/ghost.jsonl",
      forkRecordCount: 40,
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
