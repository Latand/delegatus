import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { CompanionStorage, type StoredSession } from "./storage";
import { CompanionTranscriptRecords } from "./transcriptRecord";
import { CallMemory } from "./callMemory";
import type { CallSummary } from "./callMemoryTypes";

const root = fs.mkdtempSync(path.join(os.tmpdir(),"voice-retention-"));
let sequence = 0;
const now = Date.UTC(2026,9,13,10);
const day = 86400_000;
beforeEach(() => { process.env.LLV_STATE_DIR = path.join(root,String(++sequence)); });
afterAll(() => fs.rmSync(root,{ recursive: true,force: true }));
const session = (id: string, endedAt = now): StoredSession => ({ id, project: "fixture", locale: "en", createdAt: endedAt-60_000,
  endedAt, startedBy: { memberId: "member-one" }, closed: true, generation: 1, seq: 0, inputs: [], events: [], proposals: {} });
const summary = (): CallSummary => ({ version: 1, state: "final", through: 1, startedAt: now-60_000, endedAt: now, projects: ["Fixture"],
  asked: ["Review the build."], done: [], decided: ["Keep the current layout."], open: [], privateOmitted: false,
  model: "fixture-haiku", durationMs: 20, inputTokens: 100, outputTokens: 40, attempts: 1 });
function journal(records: CompanionTranscriptRecords, call: StoredSession): void {
  records.begin(call,"fixture",{},now);
  const start = records.read(call.id).entries[0];
  records.put(call.id,{ ...start,data: { ...start.data,memoryVersion: 1 } },true);
  records.put(call.id,{ id: "speech",kind: "utterance",atMs: 1000,data: { text: "Review the build.",final: true } },true);
  records.put(call.id,{ id: "end",kind: "session_end",atMs: 60_000,data: { endedAt: call.endedAt } },true);
  records.finish(call.id);
}

test("every state change prunes closed call history while preserving open, remote and held calls and monthly accounting", () => {
  const storage = new CompanionStorage(() => now);
  const release = storage.hold("held");
  storage.change(document => {
    document.settings.monthlyCapUsd = 2;
    for (let n = 0; n < 1000; n++) {
      const id = `closed-${n}`;
      document.sessions[id] = { ...session(id,now-n*1000), inputs: [{ itemId: "speech", text: "A".repeat(2000),final: true }] };
      document.charges[id] = { month: "2026-10",usd: 0.001,reserved: false,incomplete: n === 900 };
    }
    document.sessions.ancient = session("ancient",now-31*day);
    document.sessions.open = { ...session("open",now-40*day),closed: false };
    document.sessions.remote = { ...session("remote",now-40*day),remoteOpen: true };
    document.sessions.held = session("held",now-40*day);
    document.sessions.reserved = session("reserved",now-40*day);
    document.charges.reserved = { month: "2026-10",usd: 0.1,reserved: true,incomplete: false };
  });
  const document = storage.read();
  expect(Object.keys(document.sessions)).toHaveLength(54);
  expect(document.sessions["closed-49"]).toBeDefined(); expect(document.sessions["closed-50"]).toBeUndefined(); expect(document.sessions.ancient).toBeUndefined();
  for (const id of ["open","remote","held","reserved"]) expect(document.sessions[id]).toBeDefined();
  expect(Object.keys(document.charges).length).toBeLessThanOrEqual(101);
  expect(storage.settings().usageUsd).toBeCloseTo(1,8); expect(storage.settings().reservedUsd).toBeCloseTo(0.1,8); expect(storage.settings().incomplete).toBe(true);
  expect(() => storage.reserve("over-cap",1)).toThrow("CAP_REACHED");
  expect(new CompanionStorage(() => now).settings().usageUsd).toBeCloseTo(1,8);
  const bytes = fs.statSync(statePath("voice-companion.json")).size;
  for (let n = 1000; n < 1100; n++) storage.change(next => {
    const id = `new-${n}`;
    next.sessions[id] = { ...session(id,now+1000+n), inputs: [{ itemId: "speech", text: "A".repeat(2000),final: true }] };
    next.charges[id] = { month: "2026-10",usd: 0.001,reserved: false,incomplete: false };
  });
  expect(fs.statSync(statePath("voice-companion.json")).size).toBeLessThan(bytes+2000);
  expect(storage.settings().usageUsd).toBeCloseTo(1.1,8);
  release(); storage.change(() => {}); expect(storage.read().sessions.held).toBeUndefined();
  expect(new CompanionStorage(() => now+31*day).settings().usageUsd).toBe(0);
});

test("closure time, including legacy close events, determines the count and age windows", () => {
  const storage = new CompanionStorage(() => now);
  storage.change(document => {
    const recent = { ...session("long-call"),createdAt: now-40*day };
    document.sessions[recent.id] = recent;
    const legacy = { ...session("legacy"),createdAt: now-40*day, seq: 1 };
    delete legacy.endedAt;
    legacy.events = [{ version: 1, sessionId: "legacy",eventId: "end",seq: 1,generation: 1,atMs: 40*day,type: "session.closed",reason: "operator",incomplete: false }];
    document.sessions.legacy = legacy;
    document.sessions.boundary = session("boundary",now-30*day);
    document.sessions.expired = session("expired",now-30*day-1);
  });
  expect(Object.keys(storage.read().sessions).sort()).toEqual(["boundary","legacy","long-call"]);
});

test("journal-owned summaries survive removal of their state row, retain owner isolation and can be forgotten", () => {
  const storage = new CompanionStorage(() => now); const records = new CompanionTranscriptRecords(); const call = session("remembered");
  journal(records,call); records.writeSummary(call.id,summary(),now);
  storage.change(document => { document.sessions[call.id] = call; });
  storage.change(document => { delete document.sessions[call.id]; });
  const memory = new CallMemory(new CompanionStorage(() => now),new CompanionTranscriptRecords(),undefined,() => now);
  expect(memory.block({ memberId: "member-one" })).toContain("Keep the current layout.");
  expect(memory.list({ memberId: "member-two" })).toEqual([]);
  expect(() => memory.clear({ memberId: "member-two" },call.id)).toThrow("SESSION_UNAVAILABLE");
  memory.clear({ memberId: "member-one" },call.id); expect(memory.retained({ memberId: "member-one" })).toBe(0);
  expect(records.summary(call.id)?.state).toBe("cleared");
});

test("an interrupted summary recovers from journal metadata after its state record is removed", async () => {
  const storage = new CompanionStorage(() => now); const records = new CompanionTranscriptRecords(); const call = session("recoverable");
  journal(records,call);
  const memory = new CallMemory(storage,records,async () => ({ answer: { asked: ["Review the build."],done: [],decided: [],open: [] },
    durationMs: 10,inputTokens: 100,outputTokens: 40,model: "fixture-haiku" }),() => now);
  memory.recover(); await memory.drain(); expect(records.summary(call.id)?.state).toBe("final");
});

test("a pending summary still commits when a later state change prunes its closed call", async () => {
  const storage = new CompanionStorage(() => now); const records = new CompanionTranscriptRecords(); const call = session("pending-summary");
  journal(records,call); storage.change(document => { document.sessions[call.id] = call; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const memory = new CallMemory(storage,records,async () => { await held; return { answer: { asked: ["Review the build."],done: [],decided: [],open: [] },
    durationMs: 10,inputTokens: 100,outputTokens: 40,model: "fixture-haiku" }; },() => now);
  memory.trigger(call.id); await new Promise(resolve => setTimeout(resolve,0));
  expect(records.summary(call.id)?.pending).toBe(true);
  storage.change(document => { for (let n = 0; n < 51; n++) { const id = `later-${n}`; document.sessions[id] = session(id,now+1000+n); } });
  expect(storage.read().sessions[call.id]).toBeUndefined();
  release(); await memory.drain(); expect(records.summary(call.id)?.state).toBe("final");
  expect(memory.block({ memberId: "member-one" })).toContain("Review the build.");
});

test("journal retention finds calls absent from state and never removes an open or remote call", () => {
  const records = new CompanionTranscriptRecords();
  for (let n = 0; n < 60; n++) {
    const call = session(`journal-${n}`,now+n); journal(records,call); records.writeSummary(call.id,{ ...summary(),endedAt: call.endedAt! },now);
  }
  const remote = { ...session("remote",now-40*day),remoteOpen: true };
  // Seed remote and open records directly: they are protected by state, even if
  // a local close event has arrived before the provider confirms its hangup.
  records.put(remote.id,{ id: "start",kind: "session_start",atMs: 0,data: { createdAt: remote.createdAt,project: "fixture",locale: "en",startedBy: { operator: true } } },true);
  records.put(remote.id,{ id: "end",kind: "session_end",atMs: 1000,data: { endedAt: remote.endedAt } },true);
  const open = { ...session("open",now-40*day),closed: false };
  records.put(open.id,{ id: "start",kind: "session_start",atMs: 0,data: { createdAt: open.createdAt } },true);
  records.put("legacy-journal",{ id: "start",kind: "session_start",atMs: 0,data: { createdAt: now-40*day } },true);
  records.put("legacy-journal",{ id: "end",kind: "session_end",atMs: 1000,data: { endedAt: now-40*day } },true);
  records.finish("legacy-journal");
  expect(records.sessions().some(row => row.id === "legacy-journal")).toBe(false);
  records.prune({ remote,open },now);
  expect(records.read("legacy-journal").entries).toHaveLength(0);
  expect(records.summary("journal-9")).toBeNull(); expect(records.summary("journal-10")?.state).toBe("final");
  expect(records.read(remote.id).entries).toHaveLength(2); expect(records.read(open.id).entries).toHaveLength(1);
  records.prune({ remote,open },now+31*day);
  expect(records.summary("journal-59")).toBeNull(); expect(records.read(remote.id).entries).toHaveLength(2);
});
