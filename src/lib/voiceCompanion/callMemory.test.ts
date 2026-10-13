import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CallMemory, boundedSummary, memoryBlock, summaryInput, type SummaryInput, type CallSummarizer } from "./callMemory";
import { summaryText, type CallSummary } from "./callMemoryTypes";
import { CompanionTranscriptRecords } from "./transcriptRecord";
import { CompanionStorage } from "./storage";
import { CompanionAdmission } from "./admission";
import { CompanionLiveSessions } from "./liveSession";
import { FakeLiveProvider, delegationCreated, backendResponse, functionCall } from "./fakeProvider";
import { fixtureBoardReads } from "./boardReads.fixture";
import { MemoryProfileError } from "@/lib/memory/profile";
import { codexVoiceStart, codexVoiceThread } from "./codexProvider";
import { liveInstructions, liveSessionConfiguration } from "./sessionConfig";
import { OWNER_HISTORY_PRIVACY } from "@/lib/externalRelay/ownerHistory";

const root = fs.mkdtempSync(path.join(os.tmpdir(),"call-memory-"));
let sequence = 0;
beforeEach(() => { const directory = path.join(root,String(++sequence)); process.env.LLV_STATE_DIR = path.join(directory,"state"); process.env.XDG_CONFIG_HOME = path.join(directory,"config"); });
afterAll(() => fs.rmSync(root,{ recursive: true, force: true }));
const answer = { asked: ["Review the build."], done: ["Passed the request on."], decided: ["Keep the current layout."], open: ["Wait for the report."] };
const result = (value: unknown = answer) => ({ answer: value, durationMs: 25, inputTokens: 1000, outputTokens: 120, model: "fixture-haiku" });
function harness(backend: "api" | "codex" = "api", model: CallSummarizer = async () => result(), deadline = 1000) {
  let now = Date.UTC(2026,9,13,10);
  const storage = new CompanionStorage(() => now); storage.updateSettings({ enabled: true, backend });
  const admission = new CompanionAdmission(storage,{ recipient: () => null, reports: () => [], send: async () => { throw new Error("unexpected send"); } },() => now);
  const provider = new FakeLiveProvider(); if (backend === "codex") Object.defineProperty(provider,"backend",{ value: "codex" });
  const memory = new CallMemory(storage,admission.records,model,() => now,deadline);
  const service = new CompanionLiveSessions(storage,admission,fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }),provider,
    { memory, key: () => "synthetic-credential", timers: false, now: () => now, closeTimeoutMs: 10,
      ownerHistory: async () => ({ available: true, title: "private title sentinel", chat: "private-sentinel", timeZone: "UTC", start: "2026-10-13T00:00:00Z", end: "2026-10-14T00:00:00Z", oldestStoredAt: null,
        messages: [{ messageId: 1, sentAt: "2026-10-13T09:00:00Z", author: { name: "private member sentinel", username: null }, fromAssistant: false, topicId: null, replyToMessageId: null, text: "private message sentinel", media: null, truncated: false }], nextCursor: null, privacy: OWNER_HISTORY_PRIVACY }) });
  return { storage, admission, provider, memory, service, advance: (ms: number) => { now += ms; }, now: () => now };
}
const start = (h: ReturnType<typeof harness>, startedBy: { operator: true } | { memberId: string } = { operator: true }) => h.service.start({ project: "fixture", locale: "en", sdp: "v=0\r\n", startedBy });
function speech(h: ReturnType<typeof harness>, id: string, count = 1) {
  for (let n = 0; n < count; n++) h.admission.record(id,{ id: `operator-${n}`, kind: "utterance", atMs: n * 1000, data: { text: `Review step ${n}.`, final: true } });
  h.admission.record(id,{ id: "voice", kind: "reply", atMs: 6000, data: { text: "I passed the request on.", final: true } });
}
for (const backend of ["api","codex"] as const) test(`${backend}: finished call is stored and the next call gets bounded memory in both contexts`, async () => {
  const h = harness(backend); const call = await start(h); speech(h,call.sessionId);
  await h.service.close(call.sessionId); await h.memory.drain();
  const stored = h.admission.records.summary(call.sessionId)!;
  expect(stored.state).toBe("final"); expect(stored.asked).toEqual(answer.asked);
  const second = await start(h); const block = h.provider.sessions.at(-1)!.memory!;
  expect(block).toContain(answer.decided[0]); expect(block.length).toBeLessThanOrEqual(2400);
  expect(liveInstructions("en","Fixture",block)).toEndWith(block);
  expect(liveSessionConfiguration("en","Fixture",block).instructions).toEndWith(block);
  expect(codexVoiceThread(".",true,block).developerInstructions).toEndWith(block);
  expect(codexVoiceStart("fixture","en","v=0",undefined,undefined,block).prompt).toEndWith(block);
  if (backend === "api") { h.provider.replay(second.providerId,delegationCreated("next-delegation",100)); await h.service.drain(second.sessionId); expect(h.provider.requests.at(-1)!.input[0]).toEqual({ role: "developer", content: block }); }
  await h.service.close(second.sessionId);
});
test("whole sentences and whole calls obey size, age and count bounds", async () => {
  const h = harness();
  const lists = boundedSummary({ asked: Array(8).fill("A".repeat(160)), done: ["too long "+"B".repeat(160)], decided: ["Keep it."], open: Array(8).fill("C".repeat(160)) },[]);
  expect(summaryText(lists).length).toBeLessThanOrEqual(600); expect(lists.asked.length).toBeLessThanOrEqual(4); expect(lists.done).toEqual([]); expect(lists.decided).toEqual(["Keep it."]);
  for (let n = 0; n < 8; n++) { const call = h.admission.create({ project: "fixture",locale: "en",startedBy: { operator: true } }); speech(h,call.id); h.admission.emit(call.id,{ type: "session.closed",reason: "operator",incomplete: false }); h.admission.retire(call.id); h.memory.trigger(call.id); await h.memory.drain(); h.advance(1000); }
  const rows = h.memory.list({ operator: true }); expect(rows).toHaveLength(5);
  const maximum: CallSummary = { ...rows[0].summary, asked:["A".repeat(160)],done:["D".repeat(80)],decided:["C".repeat(160)],open:["O".repeat(160)] };
  expect(summaryText(maximum).length).toBe(600);
  const capped = memoryBlock(Array.from({length:7},(_,at) => ({ sessionId:`maximum-${at}`,summary:{ ...maximum,endedAt:h.now()-at*1000 } })),h.now());
  expect(capped.length).toBeLessThanOrEqual(2400); expect(capped).toContain("Still open: "+"O".repeat(160));
  expect((capped.match(/Asked:/gu) ?? []).length).toBeLessThanOrEqual(5);
  const block = memoryBlock(rows,h.now()); expect(block.length).toBeLessThanOrEqual(2400); expect(block).not.toMatch(/AM|PM/);
  h.advance(8 * 86400_000); expect(h.memory.list({ operator: true })).toEqual([]); expect(h.memory.retained({ operator:true })).toBe(8); h.memory.clear({ operator:true }); expect(h.memory.retained({ operator:true })).toBe(0);
});
for (const backend of ["api","codex"] as const) test(`${backend}: private history and the triggering operator turn never reach summarizer or stored notes`, async () => {
  const inputs: SummaryInput[] = [];
  const h = harness(backend,async input => { inputs.push(input); return result({ asked: [input.text.slice(0,150)], done: [],decided: [],open: [] }); });
  const call = await start(h); speech(h,call.sessionId);
  h.provider.replay(call.providerId,{ type: "session.input_transcript.delta",event_id: "private-ask",delta: "Read private-sentinel today.",start_ms: 7000,end_ms: 8000 },delegationCreated("private-delegation",9000));
  if (backend === "api") { h.provider.responder = (_request,index) => backendResponse(`answer-${index}`,index === 0 ? [functionCall("history","relay_owner_history",{ action: "messages",chat: "private-sentinel",from: null,to: null,cursor: null,limit: null })] : []); await h.service.drain(call.sessionId); }
  else { await h.service.drain(call.sessionId); await h.provider.callTool(call.providerId,"relay_owner_history",{ action: "messages",chat: "private-sentinel",from: null,to: null,cursor: null,limit: null },"history","native-private-turn"); }
  h.admission.record(call.sessionId,{ id: "private-reply",kind: "reply",atMs: 9500,data: { final: true,text: "private title sentinel, private member sentinel: private message sentinel" } });
  await h.service.close(call.sessionId); await h.memory.drain();
  expect(inputs).toHaveLength(1); expect(inputs[0].privateOmitted).toBe(true); expect(inputs[0].text).toContain("Review step");
  for (const text of [inputs[0].text,JSON.stringify(h.admission.records.summary(call.sessionId))]) { expect(text).not.toContain("sentinel"); expect(text).not.toContain("Read private"); }
});
test("a transport drop and restart recover journal speech", async () => {
  const h = harness(); const call = await start(h); speech(h,call.sessionId); h.provider.disconnect(call.providerId);
  await new Promise(resolve => setTimeout(resolve,30)); await h.memory.drain(); expect(h.admission.records.summary(call.sessionId)?.state).toBe("final");
  const orphan = h.admission.create({ project: "fixture",locale: "en",authority: "live-model",startedBy: { operator: true } }); speech(h,orphan.id);
  await h.service.recover(); await h.memory.drain(); expect(h.admission.records.summary(orphan.id)?.state).toBe("final");
});
test("five-minute checkpoints are incremental and final follows a held checkpoint", async () => {
  const inputs: SummaryInput[] = []; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = harness("codex",async input => { inputs.push(input); if (inputs.length === 1) await held; return result(); });
  const call = await start(h); speech(h,call.sessionId,4); h.advance(300001); h.memory.checkpoint(call.sessionId);
  await new Promise(resolve => setTimeout(resolve,0)); await h.service.close(call.sessionId); release(); await h.memory.drain();
  expect(inputs).toHaveLength(2); expect(inputs[1].previous?.state).toBe("checkpoint"); expect(inputs[1].text).not.toContain("Review step"); expect(h.admission.records.summary(call.sessionId)?.state).toBe("final");
});
test("failure codes retry on mint up to three attempts and preserve a good checkpoint", async () => {
  for (const code of ["account","timeout","invalid"] as const) {
    let requests = 0;
    const h = harness("codex",async () => { requests++; if (requests > 1) throw new MemoryProfileError(code); return result(); });
    const call = await start(h); speech(h,call.sessionId,4); h.advance(300001); h.memory.checkpoint(call.sessionId); await h.memory.drain();
    await h.service.close(call.sessionId); await h.memory.drain(); expect(h.admission.records.summary(call.sessionId)?.state).toBe("checkpoint");
    for (let n = 0; n < 3; n++) { const next = await start(h); await h.memory.drain(); await h.service.close(next.sessionId); }
    expect(h.admission.records.summary(call.sessionId)?.attempts).toBe(3); expect(h.memory.block({ operator: true })).toContain(answer.asked[0]);
    const beforeRecovery = requests;
    const recovered = new CallMemory(h.storage,new CompanionTranscriptRecords(),async () => { requests++; throw new MemoryProfileError(code); },h.now);
    recovered.recover(); await recovered.drain(); expect(requests).toBe(beforeRecovery); expect(recovered.records.summary(call.sessionId)?.attempts).toBe(3);
  }
});
test("an unanswered summarizer never holds close or start; timeout is durable", async () => {
  const h = harness("codex",() => new Promise(() => {}),40); const call = await start(h); speech(h,call.sessionId);
  await h.service.close(call.sessionId); const next = await start(h); await h.service.close(next.sessionId); await h.memory.drain();
  expect(h.admission.records.summary(call.sessionId)?.code).toBe("timeout");
});
test("owner isolation, clearing during a request, tombstones and disabled memory", async () => {
  let resolve!: (value: ReturnType<typeof result>) => void;
  const h = harness("codex",() => new Promise(done => { resolve = done; })); const owner = { memberId: "member-one" };
  const call = await start(h,owner); speech(h,call.sessionId); await h.service.close(call.sessionId); await new Promise(done => setTimeout(done,0));
  expect(h.memory.list({ memberId: "member-two" })).toEqual([]); expect(() => h.memory.clear({ memberId: "member-two" },call.sessionId)).toThrow("SESSION_UNAVAILABLE");
  h.memory.clear(owner,call.sessionId); resolve(result()); await h.memory.drain(); expect(h.admission.records.summary(call.sessionId)?.state).toBe("cleared");
  expect(h.admission.records.read(call.sessionId).entries.some(row => row.kind === "utterance")).toBe(true);
  h.memory.trigger(call.sessionId); await h.memory.drain(); expect(h.memory.block(owner)).toBe("");
  h.storage.updateSettings({ callMemory: false }); const next = await start(h,owner); speech(h,next.sessionId); await h.service.close(next.sessionId); await h.memory.drain(); expect(h.admission.records.summary(next.sessionId)).toBeNull(); expect(h.provider.sessions.at(-1)?.memory).toBeUndefined();
  h.storage.updateSettings({ callMemory: true }); h.memory.clear(owner); await h.service.recover(); expect(h.admission.records.summary(next.sessionId)?.state).toBe("cleared");
});
test("summary answers mask installation credentials and local paths", async () => {
  const held = ["held","secret","body"].join("-");
  const h = harness("codex",async () => result({ asked: [`Use ${held} and ~/private/notes.`], done: [],decided: [],open: [] }));
  process.env.OPENAI_API_KEY = held;
  try { const call = await start(h); speech(h,call.sessionId); await h.service.close(call.sessionId); await h.memory.drain(); const text = JSON.stringify(h.admission.records.summary(call.sessionId)); expect(text).not.toContain(held); expect(text).not.toContain("~/private"); }
  finally { delete process.env.OPENAI_API_KEY; }
});
test("unknown private-read correlation keeps nothing and rejects malformed answers", () => {
  expect(summaryInput([{ id: "history",kind: "tool",atMs: 1,order: 0,data: { name: "relay_owner_history",status: "done" } }]).text).toBe("");
  for (const value of [null,[],{ ...answer,extra: [] },{ ...answer,asked: [1] }]) expect(() => boundedSummary(value,[])).toThrow("invalid");
});

test("a checkpoint finishing after a private read discards its tainted input and rebuilds from the safe prefix", async () => {
  const inputs: SummaryInput[] = []; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = harness("codex",async input => { inputs.push(input); if (inputs.length === 1) await held; return result({ asked:[input.text.slice(-150)],done:[],decided:[],open:[] }); });
  const call = await start(h); speech(h,call.sessionId,4); h.advance(300001); h.memory.checkpoint(call.sessionId);
  await new Promise(resolve => setTimeout(resolve,0));
  h.admission.record(call.sessionId,{ id:"private-question",kind:"utterance",atMs:300002,data:{ text:"Read private-sentinel.",final:true } });
  h.admission.record(call.sessionId,{ id:"private-delegation",kind:"delegation",atMs:300003,data:{ delegationId:"private-turn" } });
  h.admission.record(call.sessionId,{ id:"private-read",kind:"tool",atMs:300004,data:{ name:"relay_owner_history",status:"done",delegationId:"private-turn" } });
  h.admission.record(call.sessionId,{ id:"private-answer",kind:"reply",atMs:300005,data:{ text:"private message sentinel",final:true } });
  await h.service.close(call.sessionId); release(); await h.memory.drain();
  expect(inputs).toHaveLength(2); expect(inputs[1].text).not.toContain("sentinel"); expect(JSON.stringify(h.admission.records.summary(call.sessionId))).not.toContain("sentinel");
  expect(h.admission.records.summary(call.sessionId)?.state).toBe("final");
});
test("cold readers retain summary updates, journal permissions and clear tombstones", async () => {
  const h = harness("codex"); const call = await start(h); speech(h,call.sessionId); await h.service.close(call.sessionId); await h.memory.drain();
  const records = new CompanionTranscriptRecords(); expect(records.summary(call.sessionId)?.state).toBe("final");
  const file = path.join(process.env.LLV_STATE_DIR!,"voice-companion","transcripts",`${call.sessionId}.jsonl`);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600); expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  const cold = new CallMemory(h.storage,records,async () => { throw new Error("cleared summary regenerated"); },h.now); cold.clear({ operator:true });
  cold.trigger(call.sessionId); await cold.drain(); expect(new CompanionTranscriptRecords().summary(call.sessionId)?.state).toBe("cleared");
});
test("unreadable memory never prevents a new call or terminates its watchdog", async () => {
  const h = harness("codex"); const call = await start(h); speech(h,call.sessionId); await h.service.close(call.sessionId); await h.memory.drain();
  const file = path.join(process.env.LLV_STATE_DIR!,"voice-companion","transcripts",`${call.sessionId}.jsonl`); const entries = fs.readFileSync(file,"utf8").trim().split("\n").map(line => JSON.parse(line));
  entries.find(row => row.kind === "summary").data.asked = null;
  fs.writeFileSync(file,entries.map(row => JSON.stringify(row)).join("\n")+"\n");
  expect(h.memory.block({ operator:true })).toBe(""); const second = await start(h); expect(h.provider.sessions.at(-1)?.memory).toBeUndefined(); await h.service.close(second.sessionId);
});

test("a growing segment keeps its order and is included when a later checkpoint sees its final", async () => {
  const inputs: SummaryInput[] = []; const h = harness("codex",async input => { inputs.push(input); return result(); });
  const call = await start(h); speech(h,call.sessionId,4);
  h.admission.record(call.sessionId,{ id:"growing",kind:"utterance",atMs:299000,data:{ text:"Keep the later decision.",final:false } },false);
  h.advance(300001); h.memory.checkpoint(call.sessionId); await h.memory.drain(); expect(inputs[0].text).not.toContain("later decision");
  h.admission.record(call.sessionId,{ id:"growing",kind:"utterance",atMs:299000,data:{ text:"Keep the later decision.",final:true } });
  await h.service.close(call.sessionId); await h.memory.drain(); expect(inputs[1].text).toContain("later decision");
});

test("recovery repairs the crash gap after a closed journal and before summary admission, but leaves legacy calls alone", async () => {
  const h = harness("codex"); const call = await start(h); speech(h,call.sessionId); await h.service.close(call.sessionId); await h.memory.drain();
  const file = path.join(process.env.LLV_STATE_DIR!,"voice-companion","transcripts",`${call.sessionId}.jsonl`);
  const entries = fs.readFileSync(file,"utf8").trim().split("\n").map(line => JSON.parse(line));
  fs.writeFileSync(file,entries.filter(row => row.kind !== "summary").map(row => JSON.stringify(row)).join("\n")+"\n");
  const legacy = h.admission.create({ project:"fixture",locale:"en" }); speech(h,legacy.id); h.admission.emit(legacy.id,{ type:"session.closed",reason:"operator",incomplete:false }); h.admission.retire(legacy.id);
  const recovered = new CallMemory(h.storage,new CompanionTranscriptRecords(),async () => result(),h.now);
  recovered.recover(); await recovered.drain(); expect(recovered.records.summary(call.sessionId)?.state).toBe("final"); expect(recovered.records.summary(legacy.id)).toBeNull();
});

test("a call closed with remembering off stays out of restart recovery after re-enabling", async () => {
  let requests = 0; const h = harness("codex",async () => { requests++; return result(); });
  const call = await start(h); speech(h,call.sessionId); h.storage.updateSettings({callMemory:false}); await h.service.close(call.sessionId); await h.memory.drain();
  h.storage.updateSettings({callMemory:true}); await h.service.recover(); h.memory.retry({operator:true}); await h.memory.drain(); expect(requests).toBe(0); expect(h.admission.records.summary(call.sessionId)).toBeNull();
});

test("checkpoint cadence uses its saved time even when the covered speech was much earlier", async () => {
  let requests = 0; const h = harness("codex",async () => { requests++; return result(); });
  const call = await start(h); speech(h,call.sessionId,4); h.advance(300001); h.memory.checkpoint(call.sessionId); await h.memory.drain();
  for(let at=0;at<4;at++) h.admission.record(call.sessionId,{id:`later-${at}`,kind:"utterance",atMs:300100+at*1000,data:{text:`Later request ${at}.`,final:true}});
  h.advance(15000); h.memory.checkpoint(call.sessionId); await h.memory.drain(); expect(requests).toBe(1);
  h.advance(300001); h.memory.checkpoint(call.sessionId); await h.memory.drain(); expect(requests).toBe(2);
  await h.service.close(call.sessionId); await h.memory.drain();
});

for (const backend of ["api","codex"] as const) test(`${backend}: a truncated journal cannot summarize or recall an unknown private-history boundary`, async () => {
  const inputs: SummaryInput[] = [];
  const h = harness(backend,async input => { inputs.push(input); return result({ asked:[input.text],done:[],decided:[],open:[] }); });
  const call = await start(h); speech(h,call.sessionId);
  h.admission.record(call.sessionId,{ id:"growing-private-reply",kind:"reply",atMs:7000,data:{ final:true,text:"near-capacity private message sentinel" } },false);
  const file = path.join(process.env.LLV_STATE_DIR!,"voice-companion","transcripts",`${call.sessionId}.jsonl`);
  const currentBytes = fs.statSync(file).size;
  const filler = { id:"capacity-fill",kind:"tool" as const,atMs:7000,data:{ name:"ordinary_tool",status:"done",result:"" },order:h.admission.records.read(call.sessionId).entries.length };
  const overhead = Buffer.byteLength(JSON.stringify(filler)+"\n");
  const growingBytes = Buffer.byteLength(JSON.stringify(h.admission.records.read(call.sessionId).entries.at(-1))+"\n");
  filler.data.result = "x".repeat(4*1024*1024-8192-80-currentBytes-overhead-growingBytes);
  h.admission.record(call.sessionId,filler);
  expect(fs.statSync(file).size).toBeLessThan(4*1024*1024);
  h.admission.record(call.sessionId,{ id:"history-running",kind:"tool",atMs:8000,data:{ name:"relay_owner_history",status:"running",delegationId:"private-turn" } });
  h.admission.record(call.sessionId,{ id:"history-done",kind:"tool",atMs:8001,data:{ name:"relay_owner_history",status:"done",delegationId:"private-turn" } });
  h.admission.record(call.sessionId,{ id:"private-reply",kind:"reply",atMs:8002,data:{ final:true,text:"near-capacity private message sentinel" } });
  await h.service.close(call.sessionId); await h.memory.drain();
  expect(h.admission.records.read(call.sessionId).truncated).toBe(true);
  expect(inputs).toEqual([]);
  expect(JSON.stringify(h.admission.records.summary(call.sessionId))).not.toContain("sentinel");
  expect(h.memory.block({ operator:true })).not.toContain("sentinel");
  const next = await start(h); expect(h.provider.sessions.at(-1)?.memory ?? "").not.toContain("sentinel"); await h.service.close(next.sessionId);
});

test("a private-history cut immediately hides an older checkpoint from recall and list while replacement is pending", async () => {
  let requests = 0; let rejectReplacement!: (error: Error) => void;
  const h = harness("codex",async input => {
    requests++;
    if (requests === 1) return result({ asked:["PRIVATE_TRIGGER_SENTINEL"],done:[],decided:[],open:[] });
    return new Promise((_,reject) => { rejectReplacement = reject; });
  });
  const call = await start(h); speech(h,call.sessionId,4);
  h.admission.record(call.sessionId,{ id:"private-question",kind:"utterance",atMs:300000,data:{ text:"Read private history.",final:true } });
  h.advance(300001); h.memory.checkpoint(call.sessionId); await h.memory.drain();
  expect(h.memory.block({ operator:true })).toContain("PRIVATE_TRIGGER_SENTINEL");
  h.admission.record(call.sessionId,{ id:"private-delegation",kind:"delegation",atMs:301001,data:{ delegationId:"private-turn",sourceTurn:"private-question" } });
  h.admission.record(call.sessionId,{ id:"private-read",kind:"tool",atMs:301002,data:{ name:"relay_owner_history",status:"done",delegationId:"private-turn",sourceTurn:"private-question" } });
  await h.service.close(call.sessionId); await new Promise(resolve => setTimeout(resolve,0));
  expect(h.memory.block({ operator:true })).not.toContain("PRIVATE_TRIGGER_SENTINEL");
  expect(JSON.stringify(h.memory.list({ operator:true }))).not.toContain("PRIVATE_TRIGGER_SENTINEL");
  expect(h.admission.records.summary(call.sessionId)?.asked.join(" ") ?? "").not.toContain("PRIVATE_TRIGGER_SENTINEL");
  const next = await start(h); expect(h.provider.sessions.at(-1)?.memory ?? "").not.toContain("PRIVATE_TRIGGER_SENTINEL"); await h.service.close(next.sessionId);
  rejectReplacement(new Error("summary unavailable")); await h.memory.drain();
  expect(h.memory.block({ operator:true })).not.toContain("PRIVATE_TRIGGER_SENTINEL");
  expect(JSON.stringify(h.memory.list({ operator:true }))).not.toContain("PRIVATE_TRIGGER_SENTINEL");
});

test("restart completes a closed checkpoint from its journal tail, including journal-only ownership", async () => {
  const inputs: SummaryInput[] = [];
  const h = harness("codex",async input => { inputs.push(input); return result({ asked:[input.text.slice(-100)],done:[],decided:[],open:[] }); });
  const call = await start(h); speech(h,call.sessionId,4); h.advance(300001); h.memory.checkpoint(call.sessionId); await h.memory.drain();
  expect(h.admission.records.summary(call.sessionId)?.state).toBe("checkpoint");
  h.admission.record(call.sessionId,{ id:"later-decision",kind:"utterance",atMs:301000,data:{ text:"Keep the new decision.",final:true } });
  h.admission.emit(call.sessionId,{ type:"session.closed",reason:"operator",incomplete:false }); h.admission.retire(call.sessionId);
  expect(h.admission.records.summary(call.sessionId)?.state).toBe("checkpoint");
  h.storage.change(document => { delete document.sessions[call.sessionId]; });
  const records = new CompanionTranscriptRecords();
  const recovered = new CallMemory(h.storage,records,async input => { inputs.push(input); return result({ asked:[input.text.slice(-100)],done:[],decided:[],open:[] }); },h.now);
  recovered.recover(); await recovered.drain();
  expect(records.summary(call.sessionId)?.state).toBe("final"); expect(records.summary(call.sessionId)?.asked.join(" ")).toContain("new decision");
  expect(recovered.block({ operator:true })).toContain("new decision"); expect(inputs.at(-1)?.text).toContain("new decision");
});
