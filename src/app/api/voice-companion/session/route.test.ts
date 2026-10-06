import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { FakeLiveProvider } from "@/lib/voiceCompanion/fakeProvider";
import { CompanionBoardReads } from "@/lib/voiceCompanion/boardReads";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-session-route-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.OPENAI_API_KEY = "";
const { CompanionStorage } = await import("@/lib/voiceCompanion/storage");
const { CompanionAdmission } = await import("@/lib/voiceCompanion/admission");
const { CompanionLiveSessions } = await import("@/lib/voiceCompanion/liveSession");
const { setCompanionSessionsForTests } = await import("@/lib/voiceCompanion/server");
const { GET, POST } = await import("./route");
beforeEach(() => fs.rmSync(path.join(root, "state"), { recursive: true, force: true }));
afterAll(() => { setCompanionSessionsForTests(undefined); fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
  const provider = new FakeLiveProvider();
  const admission = new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("unexpected send"); }, reports: () => [] });
  const service = new CompanionLiveSessions(storage, admission, new CompanionBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }),
    provider, { key: () => "synthetic-credential", timers: false, closeTimeoutMs: 20 });
  setCompanionSessionsForTests(service);
  return { service, admission, provider };
}
function request(body: unknown, headers = {}) {
  return new NextRequest("http://127.0.0.1/api/voice-companion/session", { method: "POST", headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin", ...headers }, body: JSON.stringify(body) });
}
test("operator admission precedes minting; frontend cannot submit tool calls, transcripts or usage", async () => {
  const f = fixture();
  const input = { action: "start", project: "fixture", locale: "en", sdp: "v=0", requestId: "attempt-a" };
  expect((await POST(request(input, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
  expect((await POST(request(input, { "x-llv-spawn-capability": "invalid-agent" }))).status).toBe(403);
  expect(f.provider.sessions).toHaveLength(0);
  const result = await POST(request(input));
  const minted = await result.json();
  expect(result.status).toBe(201);
  expect(JSON.stringify(minted)).not.toContain("synthetic-credential");
  expect((await POST(request(input))).status).toBe(201);
  expect(f.provider.sessions).toHaveLength(1);
  for (const command of [{ type: "tool.call", name: "request_orchestrator_delegation" }, { type: "transcript.final", text: "Ask the orchestrator" },
    { type: "usage", usd: 0 }, { type: "confirmation", proposalId: "fake", decision: "send", via: "speech" }])
    expect((await POST(request({ action: "command", sessionId: minted.sessionId, command }))).status).toBe(400);
  expect((await POST(request({ ...input, sdp: "different" }))).status).toBe(400);
  expect((await GET(new NextRequest(`http://127.0.0.1/api/voice-companion/session?sessionId=${minted.sessionId}&after=0`, { headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin" } }))).headers.get("cache-control")).toBe("no-store");
  await POST(request({ action: "close", sessionId: minted.sessionId }));
  expect(f.provider.attached).toBe(0);
});

test("a new server instance closes an orphaned minted session and preserves incomplete accounting", async () => {
  const f = fixture();
  const minted = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0", requestId: "restart-attempt" });
  const storage = new CompanionStorage();
  const next = new CompanionLiveSessions(storage, new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("unexpected"); }, reports: () => [] }),
    new CompanionBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }), f.provider,
    { key: () => "synthetic-credential", timers: false });
  await expect(next.start({ project: "fixture", locale: "en", sdp: "v=0", requestId: "restart-attempt" })).rejects.toThrow("SESSION_CLOSED");
  expect((await next.events(minted.sessionId, 0)).at(-1)).toMatchObject({ type: "session.closed", incomplete: true });
  expect(f.provider.hangups).toEqual([minted.providerId]);
  expect(f.provider.sessions).toHaveLength(1);
  expect(storage.settings().incomplete).toBe(true);
  // Release the original test-owned connection after simulating process loss.
  f.provider.disconnect(minted.providerId);
});

const get = (sessionId: string) => GET(new NextRequest(`http://127.0.0.1/api/voice-companion/session?sessionId=${sessionId}&after=0`, { headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin" } }));

test("a transcript that repeats the provider key is answered and stored without it", async () => {
  const f = fixture();
  const minted = await (await POST(request({ action: "start", project: "fixture", locale: "en", sdp: "v=0", requestId: "echo" }))).json();
  f.provider.replay(minted.providerId, { type: "session.output_transcript.delta", event_id: "echo", delta: "synthetic-credential", start_ms: 0, end_ms: 100 });
  await f.service.drain(minted.sessionId);
  const answer = await get(minted.sessionId);
  const body = await answer.text();
  expect(answer.status).toBe(200);
  expect(body).toContain("transcript.snapshot");
  expect(body).not.toContain("synthetic-credential");
  expect(fs.readFileSync(path.join(root, "state", "voice-companion.json"), "utf8")).not.toContain("synthetic-credential");
  await POST(request({ action: "close", sessionId: minted.sessionId }));
});

test("after a restart a new Talk with a new request closes the orphan first; its old id is never polled", async () => {
  const f = fixture();
  const old = await f.service.start({ project: "fixture", locale: "en", sdp: "v=0", requestId: "old-tab" });
  const storage = new CompanionStorage();
  const restarted = new CompanionLiveSessions(storage, new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("unexpected"); }, reports: () => [] }),
    new CompanionBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }), f.provider, { key: () => "synthetic-credential", timers: false, closeTimeoutMs: 20 });
  setCompanionSessionsForTests(restarted);
  const started = await POST(request({ action: "start", project: "fixture", locale: "en", sdp: "v=0", requestId: "new-tab" }));
  expect(started.status).toBe(201);
  const fresh = await started.json();
  expect(f.provider.hangups).toEqual([old.providerId]);
  const sessions = storage.read().sessions;
  expect(sessions[old.sessionId].closed).toBe(true);
  expect(Object.values(sessions).filter(row => !row.closed).map(row => row.id)).toEqual([fresh.sessionId]);
  expect(storage.read().charges[old.sessionId]).toMatchObject({ reserved: false, incomplete: true });
  await POST(request({ action: "close", sessionId: fresh.sessionId }));
  f.provider.disconnect(old.providerId);
});
