import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CodexLiveProvider, selectVoiceAccount } from "./codexProvider";
import { procBackend } from "@/lib/proc";
import { fixtureBoardReads } from "./boardReads.fixture";
import { CompanionStorage } from "./storage";
import { CompanionAdmission } from "./admission";
import { CompanionLiveSessions } from "./liveSession";
import type { LiveProvider } from "./provider";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";

const roots: string[] = [];
const stateDirectory = process.env.LLV_STATE_DIR;
afterEach(() => { process.env.LLV_STATE_DIR = stateDirectory; for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function gone(pid: number) { try { process.kill(pid, 0); return procBackend.processExited(pid); } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } }
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("fixture deadline"); await Bun.sleep(10); }
}
async function releaseHolder(root: string) {
  if (!fs.existsSync(root)) return;
  fs.writeFileSync(path.join(root, "release-holder"), "ready");
  const file = path.join(root, "holder-pid");
  if (fs.existsSync(file)) await until(() => gone(Number(fs.readFileSync(file, "utf8"))));
}
function fixture(mode = "sdp") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-codex-")); roots.push(root);
  const binary = path.join(root, "codex");
  fs.writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${path.join(import.meta.dir, "codexProvider.fixture.mjs")}' "$@"\n`, { mode: 0o700 });
  const provider = new CodexLiveProvider({ accounts: () => [{ id: "account-a", kind: "managed", authPresent: true, home: root }],
    observations: () => [], bindings: () => [], recordObservation: () => {},
    environment: { ...process.env, LLV_CODEX_BINARY: binary, VOICE_STUB_ROOT: root, VOICE_STUB_MODE: mode, OPENAI_API_KEY: "synthetic", OTHER_API_KEY: "synthetic" } });
  return { root, binary, provider };
}
function sessions(root: string, provider: CodexLiveProvider, apiProvider?: Pick<LiveProvider, "hangup">) {
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true, monthlyCapUsd: 0 });
  storage.providerKey = () => { throw new Error("API key read on subscription path"); };
  const admission = new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("slice 1 is read-only"); }, reports: () => [] });
  const reads = fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] });
  return { storage, admission, service: new CompanionLiveSessions(storage, admission, reads, provider, { timers: false, closeTimeoutMs: 50, apiProvider }) };
}

test("a Codex-backed service recovers an old API call through its API provider", async () => {
  const f = fixture();
  const hangups: string[] = [];
  const { storage, admission, service } = sessions(f.root, f.provider, { hangup: async (id, key) => {
    expect(key).toBe("synthetic-credential"); hangups.push(id);
    if (hangups.length === 1) throw new Error("PROVIDER_ERROR");
  } });
  storage.providerKey = () => "synthetic-credential";
  const old = admission.create({ project: "fixture", locale: "en", authority: "live-model" });
  storage.change(document => { Object.assign(document.sessions[old.id], { providerId: "old_api_call", remoteOpen: true }); });
  await service.recover();
  expect(storage.read().sessions[old.id]).toMatchObject({ closed: true, remoteOpen: true });
  await service.recover();
  expect(hangups).toEqual(["old_api_call", "old_api_call"]);
  expect(storage.read().sessions[old.id].remoteOpen).toBe(false);
  await service.recover();
  expect(hangups).toHaveLength(2);
});

test("a start answering after the operator close timeout reaps its minted call", async () => {
  const f = fixture();
  const { storage, service } = sessions(f.root, f.provider);
  const pending = service.start({ project: "fixture", locale: "en", sdp: "v=0", requestId: "close-during-start" });
  void pending.catch(() => {});
  try {
    await until(() => fs.existsSync(path.join(f.root, "ack")));
    const pid = Number(fs.readFileSync(path.join(f.root, "pid"), "utf8"));
    await service.closeRequest("close-during-start");
    expect(Object.values(storage.read().sessions)[0].closed).toBe(true);
    expect(gone(pid)).toBe(false);
    fs.writeFileSync(path.join(f.root, "sdp"), "ready");
    await expect(pending).rejects.toThrow("PROVIDER_ERROR");
    expect(gone(pid)).toBe(true);
    await expect(f.provider.attach("voice_thread", "", () => {}, () => {})).rejects.toThrow("PROVIDER_ERROR");
    expect(Object.values(storage.read().sessions)[0]).toMatchObject({ closed: true, remoteOpen: false, backend: "codex" });
    await service.recover();
    expect(gone(pid)).toBe(true);
  } finally { fs.writeFileSync(path.join(f.root, "sdp"), "ready"); await pending.catch(() => {}); await f.provider.hangup("voice_thread", ""); }
}, 15000);

test("recovery reaps a Codex call retained by this provider before clearing remoteOpen", async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, "sdp"), "ready");
  const first = sessions(f.root, f.provider);
  const session = await first.service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  const pid = Number(fs.readFileSync(path.join(f.root, "pid"), "utf8"));
  const recovered = sessions(f.root, f.provider);
  const hangup = f.provider.hangup.bind(f.provider);
  let attempts = 0;
  f.provider.hangup = async (...args) => { if (++attempts === 1) throw new Error("PROVIDER_ERROR"); await hangup(...args); };
  try {
    await recovered.service.recover();
    expect(recovered.storage.read().sessions[session.sessionId].remoteOpen).toBe(true);
    expect(gone(pid)).toBe(false);
    await Promise.all([recovered.service.recover(), recovered.service.recover()]);
    expect(gone(pid)).toBe(true);
    expect(attempts).toBe(2);
    expect(recovered.storage.read().sessions[session.sessionId]).toMatchObject({ closed: true, remoteOpen: false });
    await expect(f.provider.attach(session.providerId, "", () => {}, () => {})).rejects.toThrow("PROVIDER_ERROR");
    await recovered.service.recover();
    expect(attempts).toBe(2);
  } finally { f.provider.hangup = hangup; await first.service.close(session.sessionId); await hangup(session.providerId, ""); }
}, 15000);

test("start waits for the SDP notification after the RPC acknowledgement", async () => {
  const f = fixture(); let settled = false;
  const pending = f.provider.create("", "en", "v=0\n", "Fixture", "fixture").finally(() => { settled = true; });
  try {
    await until(() => fs.existsSync(path.join(f.root, "ack")));
    await Bun.sleep(80); expect(settled).toBe(false);
    fs.writeFileSync(path.join(f.root, "sdp"), "ready");
    expect(await pending).toEqual({ id: "voice_thread", sdp: "v=0\r\nanswer\r\n" });
  } finally { await f.provider.hangup("voice_thread", ""); await pending.catch(() => {}); }
});

test("a timed-out Codex hangup can recover after reaping and admit a new start", async () => {
  const f = fixture("hangup-timeout"); fs.writeFileSync(path.join(f.root, "sdp"), "ready");
  const { storage, service } = sessions(f.root, f.provider);
  const session = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  const pid = Number(fs.readFileSync(path.join(f.root, "pid"), "utf8"));
  const scratch = path.join(f.root, "state/scratch/voice-codex");
  const callDirectory = path.join(scratch, fs.readdirSync(scratch)[0]);
  try {
    await service.close(session.sessionId);
    expect(storage.read().sessions[session.sessionId]).toMatchObject({ closed: true, remoteOpen: true });
    expect(gone(pid)).toBe(true);
    const holderPid = Number(fs.readFileSync(path.join(f.root, "holder-pid"), "utf8"));
    expect(gone(holderPid)).toBe(false);
    expect(fs.existsSync(callDirectory)).toBe(true);
    await expect(f.provider.attach(session.providerId, "", () => {}, () => {})).rejects.toThrow("PROVIDER_ERROR");
    fs.writeFileSync(path.join(f.root, "release-holder"), "ready");
    await until(() => gone(holderPid));
    await service.recover();
    expect(storage.read().sessions[session.sessionId]).toMatchObject({ closed: true, remoteOpen: false });
    expect(fs.existsSync(callDirectory)).toBe(false);
    const next = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    await service.close(next.sessionId);
    expect(storage.read().sessions[next.sessionId]).toMatchObject({ closed: true, remoteOpen: false });
  } finally {
    await releaseHolder(f.root);
    await service.close(session.sessionId);
    await f.provider.hangup(session.providerId, "").catch(() => {});
  }
}, 20000);

test.each(["closed", "overflow"])("a background Codex hangup after %s handles its reap timeout", async trigger => {
  const f = fixture(`hangup-timeout-${trigger}`); fs.writeFileSync(path.join(f.root, "sdp"), "ready");
  const call = await f.provider.create("", "en", "v=0");
  try {
    fs.writeFileSync(path.join(f.root, "notify-close"), "ready");
    await until(() => fs.existsSync(path.join(f.root, "holder-pid")));
    await expect(f.provider.hangup(call.id, "")).rejects.toThrow("PROVIDER_ERROR");
    await expect(f.provider.attach(call.id, "", () => {}, () => {})).rejects.toThrow("PROVIDER_ERROR");
    const holderPid = Number(fs.readFileSync(path.join(f.root, "holder-pid"), "utf8"));
    expect(gone(holderPid)).toBe(false);
    fs.writeFileSync(path.join(f.root, "release-holder"), "ready");
    await until(() => gone(holderPid));
    await f.provider.hangup(call.id, "");
  } finally {
    await releaseHolder(f.root);
    await f.provider.hangup(call.id, "").catch(() => {});
  }
}, 15000);

test("an error before SDP and non-subscription auth refuse and reap the process", async () => {
  for (const [mode, code] of [["error", "PROVIDER_ERROR"], ["limit", "CODEX_LIMIT_REACHED"], ["auth", "CODEX_AUTH_REQUIRED"]]) {
    const f = fixture(mode);
    await expect(f.provider.create("", "en", "v=0", "Fixture", "fixture")).rejects.toMatchObject({ message: code, ...(mode === "limit" ? { resetsAt: 2000000000 } : {}) });
    const pid = Number(fs.readFileSync(path.join(f.root, "pid"), "utf8"));
    expect(gone(pid)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(f.root, "env"), "utf8")).filter((key: string) => /_API_KEY$/i.test(key))).toEqual([]);
  }
});

test("a realtime error in the SDP stdout chunk refuses and reaps the call", async () => {
  const f = fixture("sdp-error"); fs.writeFileSync(path.join(f.root, "sdp"), "ready");
  try {
    await expect(f.provider.create("", "en", "v=0", "Fixture", "fixture")).rejects.toThrow("PROVIDER_ERROR");
    expect(gone(Number(fs.readFileSync(path.join(f.root, "pid"), "utf8")))).toBe(true);
  } finally { await f.provider.hangup("voice_thread", ""); }
});

test("capacity honours project bindings and never falls back to the legacy home", () => {
  const now = Date.now();
  const accounts = [ { id: "legacy", kind: "legacy" as const, home: "/legacy", authPresent: true },
    { id: "account-a", kind: "managed" as const, home: "/managed/a", authPresent: true },
    { id: "account-b", kind: "managed" as const, home: "/managed/b", authPresent: true },
    { id: "signed-out", kind: "managed" as const, home: "/managed/c", authPresent: false } ];
  const observation = (accountId: string, usedPercent: number, resetsAt: number): DurableQuotaObservation => ({ engine: "codex", accountId, authenticated: true,
    observedAt: new Date(now).toISOString(), authCheckedAt: new Date(now).toISOString(), bootId: "fixture", limits: { session: { usedPercent, resetsAt, windowMinutes: 300 }, weekly: null, capturedAt: now / 1000, plan: "pro" },
    provenance: { source: "live", reason: null, staleSince: null } });
  const reset = Math.floor(now / 1000) + 3600;
  const exhausted = [observation("account-a", 100, reset), observation("account-b", 100, reset + 100)];
  expect(() => selectVoiceAccount(accounts, exhausted, [], "fixture", now)).toThrow("CODEX_LIMIT_REACHED");
  try { selectVoiceAccount(accounts, exhausted, [], "fixture", now); } catch (error) { expect(error).toMatchObject({ resetsAt: reset }); }
  expect(() => selectVoiceAccount([accounts[0]!], [], [], "fixture", now)).toThrow("NO_CODEX_ACCOUNT");
  const available = [observation("account-a", 30, reset), observation("account-b", 10, reset)];
  expect(selectVoiceAccount(accounts, available, [], "fixture", now).id).toBe("account-b");
  expect(selectVoiceAccount(accounts, available, [{ engine: "codex", accountId: "account-a", project: "fixture", createdAt: new Date(now).toISOString() }], "fixture", now).id).toBe("account-a");
});

test("Codex tool calls use the session registry and reuse the read ledger across turns", async () => {
  const f = fixture("tools");
  fs.writeFileSync(path.join(f.root, "sdp"), "ready");
  process.env.LLV_STATE_DIR = path.join(f.root, "state");
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true, monthlyCapUsd: 0 });
  storage.providerKey = () => { throw new Error("API key read on subscription path"); };
  let storeReads = 0;
  const reads = fixtureBoardReads({ tasks: () => [{ id: "task_fixture", project: "fixture", text: "Review the plan", status: "inbox" }], pipelines: () => [], activity: async () => [], messages: async () => [] });
  const original = reads.read.bind(reads); reads.read = (...args) => { storeReads++; return original(...args); };
  const admission = new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("slice 1 is read-only"); }, reports: () => [] });
  const service = new CompanionLiveSessions(storage, admission, reads, f.provider, { timers: false, closeTimeoutMs: 50 });
  let session: Awaited<ReturnType<typeof service.start>> | undefined;
  try {
    session = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    await until(() => fs.readFileSync(path.join(f.root, "wire"), "utf8").includes('"id":"end_request","result"'));
    await service.drain(session.sessionId);
    const replies = fs.readFileSync(path.join(f.root, "wire"), "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => String(row.id).startsWith("request_"));
    expect(storeReads).toBe(1);
    expect(JSON.parse(replies[0].result.contentItems[0].text).speech).toContain("Review the plan");
    expect(JSON.parse(replies[1].result.contentItems[0].text)).toMatchObject({ repeated: true, readSecondsAgo: 0 });
    const endReply = fs.readFileSync(path.join(f.root, "wire"), "utf8").trim().split("\n").map(line => JSON.parse(line)).find(row => row.id === "end_request");
    expect(JSON.parse(endReply.result.contentItems[0].text)).toMatchObject({ status: "ending", speech: "The conversation is ending." });
    expect(admission.events(session.sessionId, 0).filter(row => row.type === "tool.called")).toHaveLength(3);
    expect(storage.settings().usageUsd).toBe(0);
    await until(() => admission.events(session!.sessionId, 0).some(row => row.type === "session.closed" && row.reason === "tool"));
  } finally { if (session) await service.close(session.sessionId); await f.provider.hangup("voice_thread", ""); }
  expect(gone(Number(fs.readFileSync(path.join(f.root, "pid"), "utf8")))).toBe(true);
});

test.if(process.platform === "linux")("the leased app-server ends when its Viewer stand-in is killed", async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, "sdp"), "ready");
  const entry = path.join(f.root, "viewer.ts");
  fs.writeFileSync(entry, `import { CodexLiveProvider } from ${JSON.stringify(path.join(import.meta.dir, "codexProvider.ts"))};\nconst provider = new CodexLiveProvider({accounts:()=>[{id:"account-a",kind:"managed",authPresent:true,home:${JSON.stringify(f.root)}}],observations:()=>[],bindings:()=>[]});\nawait provider.create("","en","v=0","Fixture","fixture");\nawait Bun.write(${JSON.stringify(path.join(f.root,"viewer-ready"))},"ready");\nsetInterval(()=>{},1000);\n`);
  const viewer = spawn(process.execPath, [entry], { cwd: path.resolve(import.meta.dir, "../../.."), env: { ...process.env, LLV_STATE_DIR: path.join(f.root,"state"), LLV_CODEX_BINARY: f.binary, VOICE_STUB_ROOT: f.root }, stdio: "ignore" });
  const viewerPid = viewer.pid!;
  try {
    await until(() => fs.existsSync(path.join(f.root, "viewer-ready")));
    const helperPid = Number(fs.readFileSync(path.join(f.root, "pid"), "utf8"));
    expect(gone(helperPid)).toBe(false);
    process.kill(viewerPid, "SIGKILL");
    await until(() => gone(helperPid));
    await until(() => fs.readdirSync(path.join(f.root, "state/helpers")).filter(name => name.endsWith(".json")).length === 0);
    const records = fs.readdirSync(path.join(f.root, "state/helpers")).filter(name => name.endsWith(".json"));
    expect(records).toEqual([]);
  } finally {
    if (!gone(viewerPid)) process.kill(viewerPid, "SIGKILL");
    if (viewer.exitCode === null && viewer.signalCode === null) await new Promise(resolve => viewer.once("exit", resolve));
  }
}, 15000);

test("server selection requires the Codex environment flag and excludes an isolated legacy sign-in", async () => {
  const f = fixture(); process.env.LLV_STATE_DIR = path.join(f.root, "state");
  const previous = process.env.LLV_VOICE_BACKEND;
  const previousHome = process.env.LLV_CODEX_HOME;
  process.env.LLV_CODEX_HOME = path.join(f.root, "legacy");
  fs.mkdirSync(process.env.LLV_CODEX_HOME);
  fs.writeFileSync(path.join(process.env.LLV_CODEX_HOME, "auth.json"), "{}");
  const { companionSessions, setCompanionSessionsForTests } = await import("./server");
  try {
    delete process.env.LLV_VOICE_BACKEND;
    setCompanionSessionsForTests(undefined);
    let service = companionSessions(); service.storage.updateSettings({ enabled: true });
    service.storage.providerKey = () => { throw new Error("API provider selected"); };
    await expect(service.start({ project: "fixture", locale: "en", sdp: "v=0" })).rejects.toThrow("API provider selected");
    process.env.LLV_VOICE_BACKEND = "codex";
    setCompanionSessionsForTests(undefined);
    service = companionSessions();
    await expect(service.start({ project: "fixture", locale: "en", sdp: "v=0" })).rejects.toThrow("NO_CODEX_ACCOUNT");
    expect(Object.values(service.storage.read().sessions).every(row => row.closed && !row.remoteOpen)).toBe(true);
  } finally { process.env.LLV_VOICE_BACKEND = previous; process.env.LLV_CODEX_HOME = previousHome; setCompanionSessionsForTests(undefined); }
});
