import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  interruptionContinuationText,
  interruptionObligationStore,
  restartCutProposal,
  type InterruptionObligationInput,
} from "./interruptionObligations";

let directory = "";
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-interruption-obligations-")); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

const releaseCut: InterruptionObligationInput = {
  conversationId: `conversation_${["00000000", "0000", "4000", "8000", "000000001835"].join("-")}` as `conversation_${string}`,
  engine: "claude",
  hostKey: `claude:${["18350000", "0000", "4000", "8000", "000000000100"].join("-")}`,
  path: "/transcripts/cut.jsonl",
  owner: { pid: 4242, startIdentity: "engine-start" },
  claimEpoch: 3,
  turnRef: "turn-7",
  boundary: "viewer-release:abc",
  reason: "viewer-release",
  checkpoint: { lastEventKind: "tool-call", lastEventAt: Date.parse("2026-09-19T11:16:07.000Z") },
  seat: null,
  recordedAt: "2026-09-19T11:16:20.000Z",
};

test("the obligation id is derived from the cut, so separate processes agree on one key", () => {
  const first = interruptionObligationStore(directory).record(releaseCut);
  /* A second store instance stands in for a successor process. */
  const again = interruptionObligationStore(directory).record({ ...releaseCut, recordedAt: "2026-09-19T11:17:00.000Z" });
  expect(first.created).toBe(true);
  expect(again.created).toBe(false);
  expect(again.obligation.id).toBe(first.obligation.id);
  expect(interruptionObligationStore(directory).list()).toHaveLength(1);
});

test("a boot that finds the released turn severed records no second obligation", () => {
  const store = interruptionObligationStore(directory);
  const released = store.record(releaseCut).obligation;
  const severed = store.record({
    ...releaseCut,
    owner: null,
    turnRef: null,
    boundary: "viewer-restart:1789816567000",
    reason: "viewer-restart",
  });
  expect(severed.created).toBe(false);
  expect(severed.obligation.id).toBe(released.id);
});

test("a later cut of the same conversation owes its own continuation", () => {
  const store = interruptionObligationStore(directory);
  const released = store.record(releaseCut).obligation;
  store.update(released.id, { state: "delivered", resolvedAt: "2026-09-19T11:20:00.000Z", resolution: "delivered" });
  const later = store.record({
    ...releaseCut,
    owner: { pid: 5151, startIdentity: "engine-restarted" },
    turnRef: "turn-9",
    boundary: "viewer-release:def",
    checkpoint: { lastEventKind: "tool-call", lastEventAt: Date.parse("2026-09-19T12:00:00.000Z") },
    recordedAt: "2026-09-19T12:00:05.000Z",
  });
  expect(later.created).toBe(true);
  expect(later.obligation.id).not.toBe(released.id);
});

test("the continuation names the deployment and the way back to a stage verdict", () => {
  const obligation = interruptionObligationStore(directory).record(releaseCut).obligation;
  const text = interruptionContinuationText(obligation);
  expect(text).toContain("A Viewer deployment interrupted your turn");
  expect(text).toContain("tool-call at 2026-09-19T11:16:07.000Z");
  expect(text).toContain("Run long commands in the foreground");
  expect(text).toContain("stage_report");
});

test("a record appended to the pending journal while an import runs is kept for the next read", () => {
  const obligations = path.join(directory, "obligations");
  const pendingJournal = `${obligations}.pending.jsonl`;
  /* Records a release could not write to the directory, built by a scratch
     store and appended the way the incumbent's fallback appends them. */
  const scratch = interruptionObligationStore(path.join(directory, "scratch"));
  const first = scratch.record(releaseCut).obligation;
  const second = scratch.record({
    ...releaseCut,
    hostKey: `codex:${["18350000", "0000", "4000", "8000", "000000000101"].join("-")}`,
    engine: "codex",
    turnRef: "turn-8",
  }).obligation;
  fs.appendFileSync(pendingJournal, `${JSON.stringify(first)}\n`);

  let appended = false;
  const successor = interruptionObligationStore(obligations, {
    afterPendingRead: () => {
      if (appended) return;
      appended = true;
      /* The incumbent's demotion appends while the successor imports. */
      fs.appendFileSync(pendingJournal, `${JSON.stringify(second)}\n`);
    },
  });
  successor.list();
  expect(appended).toBe(true);
  expect(interruptionObligationStore(obligations).list().map((obligation) => obligation.id).sort())
    .toEqual([first.id, second.id].sort());
});

function restartInput(turnRef: string, lastEventAt: number | null, recordedAt: string) {
  return {
    conversationId: "conversation_restart-cut" as const,
    engine: "claude" as const,
    hostKey: "claude:session-restart-cut",
    path: "/tmp/session-restart-cut.jsonl",
    owner: null,
    claimEpoch: 3,
    turnRef,
    boundary: "viewer-restart:turn",
    reason: "viewer-restart" as const,
    recordedAt,
    checkpoint: { lastEventKind: lastEventAt === null ? null : "tool-call", lastEventAt },
    seat: null,
    answeredBy: "a pipeline stage: its controller retries the attempt",
  };
}

test("a restart record found again with newer work moves its checkpoint and its time, and keeps its state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-interruption-restart-"));
  try {
    const store = interruptionObligationStore(path.join(directory, "obligations"));
    const first = store.record(restartInput("T2", 20, "2026-10-07T00:00:20.000Z"));
    expect(first.created).toBe(true);
    const again = store.record(restartInput("T2", 100, "2026-10-07T00:01:40.000Z"));
    expect(again.created).toBe(false);
    expect(store.list()).toEqual([{
      ...first.obligation,
      checkpoint: { lastEventKind: "tool-call", lastEventAt: 100 },
      recordedAt: "2026-10-07T00:01:40.000Z",
    }]);
    expect(store.list()[0]).toMatchObject({ state: "discharged", resolution: "a pipeline stage: its controller retries the attempt" });
    /* The same evidence found once more leaves the record as written. */
    store.record(restartInput("T2", 100, "2026-10-07T00:05:00.000Z"));
    expect(store.list()[0]!.recordedAt).toBe("2026-10-07T00:01:40.000Z");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("two restart records that differ in turn are two cuts, whatever their times", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-interruption-restart-"));
  try {
    const store = interruptionObligationStore(path.join(directory, "obligations"));
    store.record(restartInput("T2", 100, "2026-10-07T00:01:40.000Z"));
    /* The transcript has not moved: the new turn has echoed nothing yet. */
    const next = store.record(restartInput("T3", 100, "2026-10-07T00:02:00.000Z"));
    expect(next.created).toBe(true);
    expect(store.list().map(({ turnRef }) => turnRef)).toEqual(["T2", "T3"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a withdrawn restart record is gone, and the same cut found again is recorded anew", () => {
  const store = interruptionObligationStore(directory);
  const owed = { ...restartInput("T1", 1_000, "2026-10-07T00:00:00.000Z"), answeredBy: undefined };
  const first = store.record(owed);
  expect(first.obligation.state).toBe("owed");
  expect(store.withdraw(first.obligation.id)).toBe(true);
  expect(store.withdraw(first.obligation.id)).toBe(false);
  expect(interruptionObligationStore(directory).list()).toEqual([]);
  const again = store.record(owed);
  expect(again).toMatchObject({ created: true, obligation: { id: first.obligation.id, state: "owed" } });
});

test("a restart record is a proposal only while its row is unclaimed and nothing has answered it", () => {
  const store = interruptionObligationStore(directory);
  const witness = store.record(restartInput("T1", 1_000, "2026-10-07T00:00:00.000Z")).obligation;
  const owed = store.record({ ...restartInput("T2", 2_000, "2026-10-07T00:00:01.000Z"), answeredBy: undefined }).obligation;
  const row = { hostKey: witness.hostKey, claimEpoch: 3 };
  expect(restartCutProposal(witness, row)).toBe(true);
  expect(restartCutProposal(owed, row)).toBe(true);
  /* A successor took the row. */
  expect(restartCutProposal(owed, { ...row, claimEpoch: 4 })).toBe(false);
  expect(restartCutProposal(store.update(owed.id, { state: "submitted" })!, row)).toBe(false);
  expect(restartCutProposal(store.update(owed.id, { state: "discharged", resolution: "a newer message already resumed the conversation" })!, row)).toBe(false);
  expect(restartCutProposal(store.record(releaseCut).obligation, { hostKey: releaseCut.hostKey, claimEpoch: 3 })).toBe(false);
});
