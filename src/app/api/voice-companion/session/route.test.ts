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

test("a mint whose SDP answer or session id echoes the credential is refused, hung up, and stored and answered nowhere", async () => {
  for (const echo of ["sdp", "id", "piece"] as const) {
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const f = fixture();
    const key = "synthetic-credential";
    f.provider.answer = () => echo === "id" ? { id: `live_${key}`, sdp: "v=0\r\ns=-\r\n" }
      : { sdp: `v=0\r\ns=${echo === "sdp" ? key : key.slice(2, 19)}\r\na=ice-pwd:Xc8fT2vQm9pLr4sWd7yZa1bN\r\n` };
    const answer = await POST(request({ action: "start", project: "fixture", locale: "en", sdp: "v=0", requestId: `echo-${echo}` }));
    const body = await answer.text();
    expect(answer.status, echo).toBeGreaterThanOrEqual(400);
    for (const surface of [body, fs.readFileSync(path.join(root, "state", "voice-companion.json"), "utf8")]) {
      expect(surface, echo).not.toContain(key);
      expect(surface, echo).not.toContain(key.slice(2, 19));
    }
    expect(f.provider.hangups, echo).toHaveLength(1);
    expect(f.provider.attached, echo).toBe(0);
    expect((await POST(request({ action: "start", project: "fixture", locale: "en", sdp: "v=0", requestId: `echo-${echo}` }))).status, `${echo} retry`).toBeGreaterThanOrEqual(400);
    expect(f.provider.sessions, `${echo}: a retry mints nothing more`).toHaveLength(1);
  }
  // A real negotiation answer, its own ICE password included, passes unchanged.
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  const f = fixture();
  const sdp = "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\na=ice-ufrag:Kq3L\r\na=ice-pwd:Xc8fT2vQm9pLr4sWd7yZa1bN\r\na=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51\r\n";
  f.provider.answer = () => ({ sdp });
  const answer = await POST(request({ action: "start", project: "fixture", locale: "en", sdp: "v=0", requestId: "plain" }));
  expect(answer.status).toBe(201);
  expect((await answer.json()).sdp).toBe(sdp);
  await f.service.close(Object.values(f.service.storage.read().sessions)[0].id);
});

function restartedService(provider: FakeLiveProvider, now: () => number = Date.now) {
  const storage = new CompanionStorage(now);
  const service = new CompanionLiveSessions(storage, new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("unexpected"); }, reports: () => [] }, now),
    new CompanionBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }), provider, { key: () => "synthetic-credential", timers: false, closeTimeoutMs: 20, now });
  setCompanionSessionsForTests(service);
  return { storage, service };
}

test("a mint whose answer was lost keeps its reservation and blocks every new paid session, across a restart, until it is reconciled", async () => {
  const f = fixture();
  f.provider.createFailures = ["lost"];
  const first = await POST(request({ action: "start", project: "fixture", locale: "en", sdp: "v=0", requestId: "lost-answer" }));
  expect(first.status).toBeGreaterThanOrEqual(400);
  expect(await first.json()).toEqual({ code: "MINT_UNCERTAIN" });
  // The same service, then a restarted one, mint nothing more while the first may be open.
  expect(await (await POST(request({ action: "start", project: "fixture", locale: "en", sdp: "v=0", requestId: "same-service" }))).json()).toEqual({ code: "MINT_UNCERTAIN" });
  let now = Date.now();
  const restarted = restartedService(f.provider, () => now);
  await restarted.service.recover();
  const second = await POST(request({ action: "start", project: "fixture", locale: "en", sdp: "v=0", requestId: "after-restart" }));
  expect(await second.json()).toEqual({ code: "MINT_UNCERTAIN" });
  expect(f.provider.sessions).toHaveLength(1);
  expect(f.provider.hangups).toHaveLength(0);
  const [row] = Object.values(restarted.storage.read().sessions);
  expect(row).toMatchObject({ closed: true, remoteOpen: true, mintUncertain: true });
  expect(restarted.storage.read().charges[row.id]).toMatchObject({ reserved: false, incomplete: true });
  expect(restarted.storage.read().charges[row.id].usd).toBeGreaterThanOrEqual(0.27);
  expect(restarted.storage.settings().incomplete).toBe(true);
  // Once a provider session that never got its answer cannot still be running, the next Talk mints.
  now += 5 * 60_000 + 1;
  const third = await POST(request({ action: "start", project: "fixture", locale: "en", sdp: "v=0", requestId: "reconciled" }));
  expect(third.status).toBe(201);
  expect(f.provider.sessions).toHaveLength(2);
  expect(restarted.storage.read().sessions[row.id]).toMatchObject({ remoteOpen: false });
  expect(restarted.storage.read().sessions[row.id].mintUncertain).toBeUndefined();
  expect(restarted.storage.read().charges[row.id]).toMatchObject({ reserved: false, incomplete: true });
  await POST(request({ action: "close", sessionId: (await third.json()).sessionId }));
});

test("a restart between the provider creating a session and its id being recorded mints nothing more", async () => {
  const f = fixture();
  f.provider.createFailures = ["hang"];
  void f.service.start({ project: "fixture", locale: "en", sdp: "v=0", requestId: "never-answered" }).catch(() => undefined);
  for (let waited = 0; waited < 50 && f.provider.sessions.length === 0; waited += 1) await new Promise(resolve => setTimeout(resolve, 2));
  expect(f.provider.sessions).toHaveLength(1);
  restartedService(f.provider);
  const answer = await POST(request({ action: "start", project: "fixture", locale: "en", sdp: "v=0", requestId: "new-tab" }));
  expect(await answer.json()).toEqual({ code: "MINT_UNCERTAIN" });
  expect(f.provider.sessions).toHaveLength(1);
});

test("a mint the provider refused outright leaves no barrier and no charge", async () => {
  const f = fixture();
  f.provider.createFailures = ["refused"];
  const refused = await POST(request({ action: "start", project: "fixture", locale: "en", sdp: "v=0", requestId: "refused" }));
  expect(await refused.json()).toEqual({ code: "PROVIDER_ERROR" });
  const [row] = Object.values(f.service.storage.read().sessions);
  expect(row).toMatchObject({ closed: true, remoteOpen: false });
  expect(f.service.storage.read().charges[row.id]).toMatchObject({ reserved: false, usd: 0 });
  const next = await POST(request({ action: "start", project: "fixture", locale: "en", sdp: "v=0", requestId: "next" }));
  expect(next.status).toBe(201);
  expect(f.provider.sessions).toHaveLength(1);
  await POST(request({ action: "close", sessionId: (await next.json()).sessionId }));
});
