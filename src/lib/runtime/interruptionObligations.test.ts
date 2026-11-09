import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";

import {
  accountGuardObligationStore,
  interruptionContinuationText,
  interruptionObligationStore,
  initializeRecipientInterruptionIndex,
  recipientInterruptionEvidence,
  recipientInterruptionObligationStore,
  restartCutProposal,
  type InterruptionObligationInput,
} from "./interruptionObligations";

import { createHash } from "node:crypto";

const permissionRefusals = process.platform !== "win32" && process.getuid?.() !== 0;
let directory = "";
beforeEach(() => { setSystemTime(new Date("2026-10-07T00:05:00.000Z")); directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-interruption-obligations-")); });
afterEach(() => {
  setSystemTime();
  fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(`${directory}.account-guard-pending`, { recursive: true, force: true });
  fs.rmSync(`${directory}.pending.jsonl.write-locks`, { recursive: true, force: true });
});

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

test("recipient cuts require initialization and read all matching reasons without unrelated records, cold and warm", async () => {
  const obligations = path.join(directory, "recipient-cuts");
  const store = interruptionObligationStore(obligations);
  const own = ["viewer-release", "viewer-restart", "account-guard"].map((reason, n) => store.record({
    ...releaseCut, reason: reason as InterruptionObligationInput["reason"], turnRef: `own-${n}`, hostKey: `claude:own-${n}`, owner: null,
  }).obligation);
  for (let n = 0; n < 49; n++) store.record({ ...releaseCut, conversationId: `conversation_unrelated-${n}`,
    turnRef: `other-${n}` });
  expect(() => recipientInterruptionEvidence(obligations, [releaseCut.conversationId])).toThrow("incomplete");
  await initializeRecipientInterruptionIndex(obligations);
  const read = fs.readFileSync;
  const visited: string[] = [];
  const spy = spyOn(fs, "readFileSync").mockImplementation(((filename: unknown, ...args: unknown[]) => {
    if (String(filename).startsWith(obligations + path.sep)) visited.push(path.basename(String(filename)));
    return Reflect.apply(read, fs, [filename, ...args]);
  }) as typeof read);
  try {
    const cold = recipientInterruptionEvidence(obligations, [releaseCut.conversationId]);
    const warm = recipientInterruptionEvidence(obligations, [releaseCut.conversationId]);
    expect(cold.records.map(row => row.id).sort()).toEqual(own.map(row => row.id).sort());
    expect(warm).toEqual(cold);
    expect(visited.sort()).toEqual(own.flatMap(row => [`${row.id}.json`, `${row.id}.json`]).sort());
    console.info(JSON.stringify({ case: "recipient cuts", coldRows: 3, warmRows: 3, unrelatedRows: 49 }));
  } finally { spy.mockRestore(); }
  // A fresh interpreter consumes the completed artifact without initializing.
  const child = Bun.spawnSync([process.execPath, "-e", `
    const { recipientInterruptionEvidence } = await import("./src/lib/runtime/interruptionObligations.ts");
    console.log(JSON.stringify(recipientInterruptionEvidence(process.argv[1], [process.argv[2]])));
  `, obligations, releaseCut.conversationId], { cwd: process.cwd(), env: process.env });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString()).records.map((row: { id: string }) => row.id).sort()).toEqual(own.map(row => row.id).sort());
});

test("recipient cut writers maintain settlement, deletion and guard consumers after initialization", async () => {
  const obligations = path.join(directory, "recipient-writers");
  await initializeRecipientInterruptionIndex(obligations);
  const store = interruptionObligationStore(obligations);
  const cut = store.record(releaseCut).obligation;
  const before = recipientInterruptionEvidence(obligations, [cut.conversationId]);
  store.update(cut.id, { state: "discharged", resolution: "the original message resumed the turn" });
  const settled = recipientInterruptionEvidence(obligations, [cut.conversationId]);
  expect(settled.revision).not.toBe(before.revision);
  expect(settled.records).toMatchObject([{ id: cut.id, state: "discharged" }]);
  const guard = accountGuardObligationStore(obligations);
  const guardCut = (await guard.record({ ...releaseCut, reason: "account-guard", turnRef: "guard-recipient" })).obligation;
  expect((await conversationCuts(guard, cut.conversationId)).map(row => row.id)).toEqual([guardCut.id]);
  expect(recipientInterruptionEvidence(obligations, [cut.conversationId]).records).toHaveLength(2);
  await guard.update(guardCut.id, { state: "delivered" });
  expect(await conversationCuts(guard, cut.conversationId)).toEqual([]);
  expect(recipientInterruptionEvidence(obligations, [cut.conversationId]).records).toHaveLength(2);
  expect(store.withdraw(cut.id)).toBe(true);
  expect(recipientInterruptionEvidence(obligations, [cut.conversationId]).records.map(row => row.id)).toEqual([guardCut.id]);
});

for (const corruption of ["source", "pointer", "manifest", "retarget", "delete", "unknown-state"] as const) test(
  `recipient cuts refuse ${corruption} evidence and reconcile only through initialization`, async () => {
    const obligations = path.join(directory, "recipient-incomplete");
    const cut = interruptionObligationStore(obligations).record(releaseCut).obligation;
    await initializeRecipientInterruptionIndex(obligations);
    const file = path.join(obligations, `${cut.id}.json`);
    const root = `${obligations}.account-guard-pending`;
    const pointer = path.join(`${root}.conversations`, createHash("sha256").update(cut.conversationId).digest("hex"), `${cut.id}.json`);
    if (corruption === "source") fs.writeFileSync(file, "{");
    if (corruption === "pointer") fs.rmSync(pointer);
    if (corruption === "manifest") fs.writeFileSync(path.join(root, "recipient-ready"), JSON.stringify({ version: 99 }));
    if (corruption === "retarget") fs.writeFileSync(file, JSON.stringify({ ...cut, conversationId: "conversation_retargeted" }));
    if (corruption === "delete") fs.rmSync(file);
    if (corruption === "unknown-state") fs.writeFileSync(file, JSON.stringify({ ...cut, state: "unknown" }));
    expect(() => recipientInterruptionEvidence(obligations, [cut.conversationId])).toThrow("incomplete");
    if (corruption === "source" || corruption === "unknown-state") {
      await expect(initializeRecipientInterruptionIndex(obligations)).rejects.toThrow();
      fs.writeFileSync(file, JSON.stringify(cut));
    }
    await initializeRecipientInterruptionIndex(obligations);
    expect(recipientInterruptionEvidence(obligations, [cut.conversationId]).records).toHaveLength(
      corruption === "retarget" || corruption === "delete" ? 0 : 1);
    if (corruption === "retarget") expect(recipientInterruptionEvidence(obligations, ["conversation_retargeted"]).records).toMatchObject([{ id: cut.id }]);
  });

test("recipient cut initialization refuses unreadable legacy records and active fallback claims", async () => {
  const obligations = path.join(directory, "recipient-legacy");
  const cut = interruptionObligationStore(obligations).record(releaseCut).obligation;
  const source = path.join(obligations, `${cut.id}.json`);
  fs.writeFileSync(source, "{");
  await expect(initializeRecipientInterruptionIndex(obligations)).rejects.toThrow();
  expect(() => recipientInterruptionEvidence(obligations, [cut.conversationId])).toThrow("incomplete");
  fs.writeFileSync(source, JSON.stringify(cut));
  const claim = `${obligations}.pending.jsonl.claim-fixture`;
  fs.writeFileSync(claim, JSON.stringify(cut) + "\n");
  await expect(initializeRecipientInterruptionIndex(obligations)).rejects.toThrow("incomplete");
  fs.rmSync(claim);
  await initializeRecipientInterruptionIndex(obligations);
  expect(recipientInterruptionEvidence(obligations, [cut.conversationId]).records).toEqual([cut]);
});

test("a writer exiting between the durable cut and its pointer leaves recipient reads refused until startup reconciliation", async () => {
  const obligations = path.join(directory, "recipient-writer-exit");
  await initializeRecipientInterruptionIndex(obligations);
  const child = Bun.spawnSync([process.execPath, "-e", `
    import fs from "node:fs";
    const { interruptionObligationStore } = await import("./src/lib/runtime/interruptionObligations.ts");
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(to).includes(".conversations/")) process.exit(17);
      return rename(from, to);
    };
    interruptionObligationStore(process.argv[1]).record(JSON.parse(process.argv[2]));
  `, obligations, JSON.stringify(releaseCut)], { cwd: process.cwd(), env: process.env });
  expect(child.exitCode).toBe(17);
  expect(() => recipientInterruptionEvidence(obligations, [releaseCut.conversationId])).toThrow("incomplete");
  await initializeRecipientInterruptionIndex(obligations);
  expect(recipientInterruptionEvidence(obligations, [releaseCut.conversationId]).records).toMatchObject([{ state: "owed" }]);
});

test("recipient cut writers never scan unrelated cuts or fallback journals", async () => {
  const obligations = path.join(directory, "recipient-scoped-writer");
  const global = interruptionObligationStore(obligations);
  const other = global.record({ ...releaseCut, conversationId: "conversation_other" }).obligation;
  await initializeRecipientInterruptionIndex(obligations);
  const own = recipientInterruptionObligationStore(obligations, [releaseCut.conversationId]);
  const read = fs.readFileSync;
  const scan = fs.readdirSync;
  let unrelatedReads = 0, journalScans = 0;
  const reader = spyOn(fs, "readFileSync").mockImplementation(((filename: unknown, ...args: unknown[]) => {
    if (path.basename(String(filename)) === `${other.id}.json`) unrelatedReads++;
    return Reflect.apply(read, fs, [filename, ...args]);
  }) as typeof read);
  const scanner = spyOn(fs, "readdirSync").mockImplementation(((folder, ...args) => {
    if (String(folder) === obligations || String(folder) === path.dirname(obligations)) journalScans++;
    return Reflect.apply(scan, fs, [folder, ...args]);
  }) as typeof scan);
  try {
    const cut = own.record(releaseCut).obligation;
    expect(own.record(releaseCut).created).toBe(false);
    expect(own.update(cut.id, { state: "submitted" })?.state).toBe("submitted");
    expect(own.list()).toMatchObject([{ id: cut.id, state: "submitted" }]);
    expect(own.withdraw(cut.id)).toBe(true);
    expect(own.list()).toEqual([]);
    expect(unrelatedReads).toBe(0);
    expect(journalScans).toBe(0);
  } finally { reader.mockRestore(); scanner.mockRestore(); }
});

test("a failed cut update keeps its original record and refuses the incomplete projection", async () => {
  const obligations = path.join(directory, "recipient-rollback");
  const store = interruptionObligationStore(obligations);
  const cut = store.record(releaseCut).obligation;
  await initializeRecipientInterruptionIndex(obligations);
  const rename = fs.renameSync;
  const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === path.join(obligations, `${cut.id}.json`)) throw new Error("fixture refused canonical publication");
    return rename(from, to);
  });
  try {
    expect(() => store.update(cut.id, { state: "delivered" })).toThrow("canonical publication");
    expect(() => recipientInterruptionEvidence(obligations, [cut.conversationId])).toThrow("incomplete");
  } finally { spy.mockRestore(); }
  await initializeRecipientInterruptionIndex(obligations);
  expect(recipientInterruptionEvidence(obligations, [cut.conversationId]).records).toEqual([cut]);
});

test("an unrelated write cannot bless a missing recipient pointer", async () => {
  const obligations = path.join(directory, "recipient-partial-write");
  const store = interruptionObligationStore(obligations);
  const cut = store.record(releaseCut).obligation;
  await initializeRecipientInterruptionIndex(obligations);
  fs.rmSync(path.join(`${obligations}.account-guard-pending.conversations`,
    createHash("sha256").update(cut.conversationId).digest("hex"), `${cut.id}.json`));
  store.record({ ...releaseCut, turnRef: "second-cut", boundary: "second-boundary", owner: { pid: 99, startIdentity: "second" } });
  expect(() => recipientInterruptionEvidence(obligations, [cut.conversationId])).toThrow("incomplete");
  await initializeRecipientInterruptionIndex(obligations);
  expect(recipientInterruptionEvidence(obligations, [cut.conversationId]).records).toHaveLength(2);
});

test("recipient initialization preserves unreadable journal input and refuses revoked initialization authority", async () => {
  const obligations = path.join(directory, "recipient-journal");
  const journal = `${obligations}.pending.jsonl`;
  fs.writeFileSync(journal, "{\n");
  await expect(initializeRecipientInterruptionIndex(obligations)).rejects.toThrow();
  expect(fs.readFileSync(journal, "utf8")).toBe("{\n");
  fs.rmSync(journal);
  interruptionObligationStore(obligations).record(releaseCut);
  let checks = 0;
  await expect(initializeRecipientInterruptionIndex(obligations, { assertActive: () => {
    if (++checks >= 4) throw new Error("fixture startup owner replaced");
  } })).rejects.toThrow("owner replaced");
  expect(() => recipientInterruptionEvidence(obligations, [releaseCut.conversationId])).toThrow("incomplete");
  await initializeRecipientInterruptionIndex(obligations);
  expect(recipientInterruptionEvidence(obligations, [releaseCut.conversationId]).records).toHaveLength(1);
});

async function conversationCuts(store: ReturnType<typeof accountGuardObligationStore>, conversationId: string) {
  const cuts: import("./interruptionObligations").InterruptionObligation[] = [];
  for await (const page of store.conversationPages(conversationId)) {
    expect(page.length).toBeLessThanOrEqual(64);
    cuts.push(...page);
  }
  return cuts;
}

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

test("a withdrawn restart record the directory refused leaves the pending journal, and the other pending records stay", () => {
  const obligations = path.join(directory, "obligations");
  fs.mkdirSync(obligations);
  fs.chmodSync(obligations, 0o500);
  try {
    const store = interruptionObligationStore(obligations);
    const withdrawn = store.record(restartInput("T1", 1_000, "2026-10-07T00:00:00.000Z")).obligation;
    const kept = store.record(restartInput("T2", 2_000, "2026-10-07T00:00:01.000Z")).obligation;
    expect(fs.readdirSync(obligations)).toEqual([]);
    expect(store.withdraw(withdrawn.id)).toBe(true);
    expect(store.withdraw(withdrawn.id)).toBe(false);
    expect(store.list().map(({ id }) => id)).toEqual([kept.id]);
    fs.chmodSync(obligations, 0o700);
    expect(interruptionObligationStore(obligations).list().map(({ id }) => id)).toEqual([kept.id]);
    expect(fs.readdirSync(obligations)).toEqual([`${kept.id}.json`]);
  } finally {
    fs.chmodSync(obligations, 0o700);
  }
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

test("withdrawal sees a fresh import claim and its importer preserves the other records", () => {
  const obligations = path.join(directory, "obligations");
  const scratch = interruptionObligationStore(path.join(directory, "scratch"));
  const first = scratch.record(releaseCut).obligation;
  const kept = scratch.record({ ...releaseCut, turnRef: "another-turn" }).obligation;
  fs.writeFileSync(`${obligations}.pending.jsonl`, [first, kept].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const observer = interruptionObligationStore(obligations);
  const importer = interruptionObligationStore(obligations, {
    afterPendingRead() {
      expect(observer.list().map((record) => record.id).sort()).toEqual([first.id, kept.id].sort());
      expect(observer.withdraw(first.id)).toBe(true);
      expect(observer.list().map((record) => record.id)).toEqual([kept.id]);
    },
  });
  expect(importer.list().map((record) => record.id)).toEqual([kept.id]);
  expect(interruptionObligationStore(obligations).list().map((record) => record.id)).toEqual([kept.id]);
  /* An explicit new observation can record the cut again; an older import
     cannot restore the withdrawn copy over it. */
  expect(observer.record(releaseCut).created).toBe(true);
});

test("a fresh import claim keeps a discharge recorded before publication", () => {
  const obligations = path.join(directory, "obligations");
  const record = interruptionObligationStore(path.join(directory, "scratch")).record(releaseCut).obligation;
  fs.writeFileSync(`${obligations}.pending.jsonl`, JSON.stringify(record) + "\n");
  const observer = interruptionObligationStore(obligations);
  const importer = interruptionObligationStore(obligations, {
    afterPendingRead() {
      expect(observer.update(record.id, { state: "discharged", resolution: "the turn already ended" }))
        .toMatchObject({ state: "discharged" });
    },
  });
  expect(importer.list()).toEqual([{ ...record, state: "discharged", resolution: "the turn already ended" }]);
  expect(observer.list()).toEqual(importer.list());
});


test("the guard pending index backfills legacy cuts, imports the fallback journal and survives restart", async () => {
  const obligations = path.join(directory, "guard-obligations");
  const seed = interruptionObligationStore(path.join(directory, "seed"));
  const owed = seed.record({ ...releaseCut, reason: "account-guard", turnRef: "guard-owed" }).obligation;
  const submitted = { ...seed.record({ ...releaseCut, reason: "account-guard", turnRef: "guard-submitted" }).obligation,
    state: "submitted" as const, operationId: "continuation" };
  const journal = seed.record({ ...releaseCut, reason: "account-guard", turnRef: "guard-journal" }).obligation;
  fs.mkdirSync(obligations);
  fs.writeFileSync(path.join(obligations, `${owed.id}.json`), JSON.stringify(owed));
  fs.writeFileSync(path.join(obligations, `${submitted.id}.json`), JSON.stringify(submitted));
  fs.writeFileSync(`${obligations}.pending.jsonl`, JSON.stringify(journal) + "\n");
  const guard = accountGuardObligationStore(obligations);
  expect((await guard.list()).map(row => row.id).sort()).toEqual([owed.id, submitted.id, journal.id].sort());
  const replay = await guard.record({ ...releaseCut, reason: "account-guard", turnRef: "guard-owed" });
  expect(replay.created).toBe(false);
  await guard.update(owed.id, { state: "delivered", resolvedAt: new Date().toISOString() });
  // A synchronous peer must maintain the same index after it is initialized.
  const peer = interruptionObligationStore(obligations);
  const fresh = peer.record({ ...releaseCut, reason: "account-guard", turnRef: "guard-new" }).obligation;
  peer.update(submitted.id, { state: "delivered", resolvedAt: new Date().toISOString() });
  expect((await accountGuardObligationStore(obligations).list()).map(row => row.id).sort()).toEqual([journal.id, fresh.id].sort());
  peer.withdraw(journal.id);
  expect((await accountGuardObligationStore(obligations).list()).map(row => row.id)).toEqual([fresh.id]);
});

test("guard recovery pages bound record reads and eventually visit every pending cut", async () => {
  const obligations = path.join(directory, "guard-obligations");
  const guard = accountGuardObligationStore(obligations);
  const ids: string[] = [];
  for (let count = 0; count < 130; count++) ids.push((await guard.record({ ...releaseCut,
    reason: "account-guard", turnRef: `guard-${count}` })).obligation.id);
  const visited: string[] = [];
  let after = "";
  for (;;) {
    let reads = 0;
    const read = fs.readFileSync;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((filename: unknown, ...args: unknown[]) => {
      if (String(filename).startsWith(obligations + path.sep)) reads++;
      return Reflect.apply(read, fs, [filename, ...args]);
    }) as typeof read);
    const { obligations: page, nextCursor } = await accountGuardObligationStore(obligations).page(after).finally(() => spy.mockRestore());
    expect(page.length).toBeLessThanOrEqual(64);
    expect(reads).toBeLessThanOrEqual(64);
    visited.push(...page.map(row => row.id));
    if (!nextCursor) break;
    after = nextCursor;
  }
  expect(visited).toEqual(ids.sort());
});


test.skipIf(!permissionRefusals)("the guard keeps a refused directory cut durable in the pending journal", async () => {
  const obligations = path.join(directory, "guard-refused");
  fs.mkdirSync(obligations, { mode: 0o500 });
  const guard = accountGuardObligationStore(obligations);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const cut = await guard.record({ ...releaseCut, reason: "account-guard", turnRef: "journal-cut" });
    expect(cut.created).toBe(true);
    expect(fs.readFileSync(`${obligations}.pending.jsonl`, "utf8")).toContain(cut.obligation.id);
    expect(await guard.list()).toMatchObject([{ id: cut.obligation.id, state: "owed" }]);
    expect((await conversationCuts(guard, cut.obligation.conversationId)).map(row => row.id)).toEqual([cut.obligation.id]);
    fs.chmodSync(obligations, 0o700);
    const restarted = accountGuardObligationStore(obligations);
    expect((await restarted.list()).map(row => row.id)).toEqual([cut.obligation.id]);
    expect((await restarted.record({ ...releaseCut, reason: "account-guard", turnRef: "journal-cut" })).created).toBe(false);
    await restarted.update(cut.obligation.id, { state: "delivered", resolvedAt: new Date().toISOString() });
    expect(await restarted.list()).toEqual([]);
  } finally { fs.chmodSync(obligations, 0o700); errors.mockRestore(); }
});

test("a crash leaving an index pointer before publication or after settlement owes no extra continuation", async () => {
  const obligations = path.join(directory, "guard-crash");
  const guard = accountGuardObligationStore(obligations);
  const cut = await guard.record({ ...releaseCut, reason: "account-guard", turnRef: "finished-cut" });
  await guard.update(cut.obligation.id, { state: "delivered", resolvedAt: new Date().toISOString() });
  const index = `${obligations}.account-guard-pending`;
  const settledPointer = path.join(index, `${cut.obligation.id}.json`);
  const missingPointer = path.join(index, "interruption-continuation-missing.json");
  fs.writeFileSync(settledPointer, JSON.stringify({ id: cut.obligation.id }));
  fs.writeFileSync(missingPointer, JSON.stringify({ id: "interruption-continuation-missing" }));
  expect(await accountGuardObligationStore(obligations).list()).toEqual([]);
  expect(fs.existsSync(settledPointer)).toBe(false);
  expect(fs.existsSync(missingPointer)).toBe(false);
});


test.each(permissionRefusals ? ["permissions", "partial contents"] : ["partial contents"])("a guard cut stays indexed across temporary unreadability from %s", async failure => {
  const obligations = path.join(directory, "guard-unreadable");
  const guard = accountGuardObligationStore(obligations);
  const cut = await guard.record({ ...releaseCut, reason: "account-guard", turnRef: "temporarily-unreadable" });
  const filename = path.join(obligations, `${cut.obligation.id}.json`);
  const original = fs.readFileSync(filename, "utf8");
  if (failure === "permissions") fs.chmodSync(filename, 0o000);
  else fs.writeFileSync(filename, "{");
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await guard.list()).toEqual([]);
    fs.chmodSync(filename, 0o600);
    fs.writeFileSync(filename, original);
    expect((await accountGuardObligationStore(obligations).list()).map(row => row.id)).toEqual([cut.obligation.id]);
  } finally { fs.chmodSync(filename, 0o600); errors.mockRestore(); }
});


test("a settled guard receipt takes precedence over its older copy in a fresh import claim", async () => {
  const obligations = path.join(directory, "guard-claim");
  const guard = accountGuardObligationStore(obligations);
  const cut = (await guard.record({ ...releaseCut, reason: "account-guard", turnRef: "claimed-cut" })).obligation;
  fs.writeFileSync(`${obligations}.pending.jsonl.claim-fixture`, JSON.stringify(cut) + "\n");
  await guard.update(cut.id, { state: "delivered", resolvedAt: new Date().toISOString() });
  expect(await accountGuardObligationStore(obligations).list()).toEqual([]);
  expect((await accountGuardObligationStore(obligations).page("")).obligations).toEqual([]);
});


test("guard ticks advance a bounded native directory cursor without listing every pending name", async () => {
  const obligations = path.join(directory, "guard-native-cursor");
  const store = accountGuardObligationStore(obligations);
  const ids: string[] = [];
  for (let n = 0; n < 193; n++) ids.push((await store.record({ ...releaseCut, reason: "account-guard",
    conversationId: `conversation_cursor_${n}`, turnRef: `guard-${n}` } as never)).obligation.id);
  const list = fs.readdirSync;
  let pendingLists = 0;
  const spy = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]) === `${obligations}.account-guard-pending`) pendingLists++;
    return Reflect.apply(list, fs, args);
  }) as typeof list);
  const visited: string[] = [];
  try {
    for (let pages = 0; ; pages++) {
      expect(pages).toBeLessThan(6);
      const result = await store.scanPage();
      expect(result.obligations.length).toBeLessThanOrEqual(64);
      visited.push(...result.obligations.map(row => row.id));
      result.acknowledge();
      if (!result.nextCursor) break;
    }
    expect(pendingLists).toBe(0);
    expect(visited.sort()).toEqual(ids.sort());
  } finally { spy.mockRestore(); }
});

test("guard pages retain bounded names until acknowledgement and reload partial durable effects", async () => {
  const obligations = path.join(directory, "guard-page-retry");
  const store = accountGuardObligationStore(obligations);
  for (let n = 0; n < 65; n++) await store.record({ ...releaseCut, reason: "account-guard", turnRef: `retry-${n}` });
  const first = await store.scanPage();
  expect(first.obligations.length).toBeGreaterThan(0);
  expect(first.obligations.length).toBeLessThanOrEqual(64);
  const settled = first.obligations[0]!.id;
  await store.update(settled, { state: "delivered", resolvedAt: "2026-01-01T00:00:00.000Z" });
  const retry = await store.scanPage();
  expect(retry.obligations.map(row => row.id)).toEqual(first.obligations.slice(1).map(row => row.id));
  retry.acknowledge();
  const next = await store.scanPage();
  expect(next.obligations.length).toBeGreaterThan(0);
  expect(next.obligations.every(row => !first.obligations.some(prior => prior.id === row.id))).toBe(true);
  // A stale acknowledgement cannot discard a later page.
  first.acknowledge();
  expect((await store.scanPage()).obligations).toEqual(next.obligations);
  next.acknowledge();
});

test("conversation lookup preserves ordinary terminal witnesses across fresh stores and timestamp ties", async () => {
  const obligations = path.join(directory, "guard-conversation-index");
  const store = accountGuardObligationStore(obligations);
  const one = (await store.record({ ...releaseCut, reason: "account-guard", turnRef: "one" })).obligation;
  const two = (await store.record({ ...releaseCut, reason: "account-guard", turnRef: "two" })).obligation;
  expect(two.recordedAt).toBe(one.recordedAt);
  await store.update(one.id, { state: "discharged", resolution: "a newer cut", resolvedAt: one.recordedAt });
  expect((await conversationCuts(accountGuardObligationStore(obligations), one.conversationId)).map(row => row.id)).toEqual([two.id]);
  expect((await store.record({ ...releaseCut, reason: "account-guard", turnRef: "one" })).created).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(obligations, `${one.id}.json`), "utf8")).state).toBe("discharged");
  expect(interruptionObligationStore(obligations).list().find(row => row.id === one.id)?.state).not.toBe("owed");
});


test("a guard cut refused by the directory replays its durable pending witness", async () => {
  const obligations = path.join(directory, "guard-replay-journal");
  const store = accountGuardObligationStore(obligations);
  const first = await store.record({ ...releaseCut, reason: "account-guard", turnRef: "guard-journal" });
  fs.appendFileSync(`${obligations}.pending.jsonl`, `${JSON.stringify(first.obligation)}\n`);
  fs.unlinkSync(path.join(obligations, `${first.obligation.id}.json`));
  const replay = await store.record({ ...releaseCut, reason: "account-guard", turnRef: "guard-journal" });
  expect(replay.created).toBe(false);
  expect(replay.obligation).toEqual(first.obligation);
  expect((await conversationCuts(store, first.obligation.conversationId)).map(row => row.id)).toContain(first.obligation.id);
});


test("a conversation pointer cannot return or discharge another conversation's cut", async () => {
  const { createHash } = await import("node:crypto");
  const obligations = path.join(directory, "guard-foreign-pointer");
  const store = accountGuardObligationStore(obligations);
  const own = (await store.record({ ...releaseCut, reason: "account-guard", turnRef: "own" })).obligation;
  const other = (await store.record({ ...releaseCut, conversationId: "conversation_other", reason: "account-guard", turnRef: "other" })).obligation;
  const pointers = path.join(`${obligations}.account-guard-pending.conversations`, createHash("sha256").update(own.conversationId).digest("hex"));
  fs.writeFileSync(path.join(pointers, `${other.id}.json`), JSON.stringify({ id: other.id }));
  expect((await conversationCuts(store, own.conversationId)).map(row => row.id)).toEqual([own.id]);
  expect(interruptionObligationStore(obligations).list().find(row => row.id === other.id)?.state).toBe("owed");
});


test("guard replay uses its cut identity index without scanning pending history", async () => {
  const obligations = path.join(directory, "guard-cut-identity");
  const store = accountGuardObligationStore(obligations);
  const input = { ...releaseCut, reason: "account-guard" as const, owner: { pid: 123, startIdentity: "fixture-owner" }, turnRef: "same-turn" };
  const first = await store.record(input);
  for (let n = 0; n < 130; n++) await store.record({ ...input, turnRef: `other-${n}` });
  const read = fs.readdirSync;
  let historyScans = 0;
  const scan = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]).startsWith(`${obligations}.account-guard-pending`)) historyScans++;
    return Reflect.apply(read, fs, args);
  }) as typeof read);
  try {
    const replay = await store.record({ ...input, boundary: "another-observation-of-the-same-cut" });
    expect(replay.created).toBe(false);
    expect(replay.obligation.id).toBe(first.obligation.id);
    expect(historyScans).toBe(0);
  } finally { scan.mockRestore(); }
  expect((await conversationCuts(store, first.obligation.conversationId)).length).toBe(131);
});


test("cut deduplication retains legacy pid/start equality across boot metadata", () => {
  for (const startIdentity of [null, "start"]) {
    for (const bootEpoch of [undefined, null, "boot-current", "boot-earlier"]) {
      const store = interruptionObligationStore(fs.mkdtempSync(path.join(directory, "matrix-")));
      const owner = { pid: 42, startIdentity, bootEpoch: "boot-current" };
      const input = { ...releaseCut, owner };
      store.record(input);
      const sameOwner = { pid: 42, startIdentity, bootEpoch };
      expect(store.record({ ...input, owner: sameOwner }).created).toBe(false);
      const changedStart = { pid: 42, startIdentity: "other", bootEpoch };
      expect(store.record({ ...input, owner: changedStart }).created).toBe(true);
      const changedPid = { pid: 43, startIdentity, bootEpoch };
      expect(store.record({ ...input, owner: changedPid }).created).toBe(true);
      expect(store.record({ ...input, owner: null }).created).toBe(true);
    }
  }
});
