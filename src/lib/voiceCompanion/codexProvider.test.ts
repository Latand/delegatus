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
import type { QuotaObservation } from "@/lib/accounts/migration/quotaPolicy";
import { durableQuotaObservation } from "@/lib/accounts/migration/quotaController";
import { selectHeadlessAccount } from "@/lib/accounts/headlessSelection";

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
function fixture(mode = "sdp", now?: () => number, picks: { accounts?: string[]; recorded?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-codex-")); roots.push(root);
  const binary = path.join(root, "codex");
  fs.writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${path.join(import.meta.dir, "codexProvider.fixture.mjs")}' "$@"\n`, { mode: 0o700 });
  const observations: QuotaObservation[] = [];
  const accounts = { ids: picks.accounts ?? ["account-a"] };
  // `recorded` hands the pick what this provider recorded, as the registry would.
  const options = { accounts: () => accounts.ids.map(id => ({ id, kind: "managed" as const, authPresent: true, home: root })),
    observations: () => picks.recorded ? observations.map(observation => durableQuotaObservation(observation, "fixture")) : [], bindings: () => [], recordObservation: (observation: QuotaObservation) => { observations.push(observation); }, now,
    environment: { ...process.env, LLV_CODEX_BINARY: binary, VOICE_STUB_ROOT: root, VOICE_STUB_MODE: mode, OPENAI_API_KEY: "synthetic", OTHER_API_KEY: "synthetic" } };
  // `fresh` is the provider a restarted Viewer builds: it knows only what was recorded.
  return { root, binary, provider: new CodexLiveProvider(options), fresh: () => new CodexLiveProvider(options), observations, accounts };
}
function sessions(root: string, provider: CodexLiveProvider, apiProvider?: Pick<LiveProvider, "hangup">, options: { now?: () => number; limitGraceMs?: number; limitTailMs?: number } = {}) {
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const storage = new CompanionStorage(options.now); storage.updateSettings({ enabled: true, monthlyCapUsd: 0 });
  storage.providerKey = () => { throw new Error("API key read on subscription path"); };
  const admission = new CompanionAdmission(storage, { recipient: () => null, send: async () => { throw new Error("slice 1 is read-only"); }, reports: () => [] }, options.now);
  const reads = fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] });
  return { storage, admission, service: new CompanionLiveSessions(storage, admission, reads, provider, { timers: false, closeTimeoutMs: 50, apiProvider, now: options.now, limitGraceMs: options.limitGraceMs, limitTailMs: options.limitTailMs ?? 20 }) };
}
let notices = 0;
/** One app-server notification, delivered by the stub after the call's SDP. */
function notify(root: string, method: string, params: unknown) {
  fs.writeFileSync(path.join(root, `notify-${String(++notices).padStart(4, "0")}.json`), JSON.stringify({ method, params }));
}
/** The usage of a call this file started on Codex. */
function codexUsage(storage: CompanionStorage, id: string) {
  const usage = storage.usageFor(id);
  if (usage.backend !== "codex") throw new Error("not a Codex call");
  return usage;
}
const wire = (root: string) => fs.readFileSync(path.join(root, "wire"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });

test("usage carries the call's seconds on the server clock, the plan type and both windows, and keeps sparse updates' earlier values", async () => {
  let clock = Date.UTC(2026, 9, 11, 12);
  const now = () => clock;
  const f = fixture("sdp", now); fs.writeFileSync(path.join(f.root, "sdp"), "ready");
  const { storage, admission, service } = sessions(f.root, f.provider, undefined, { now });
  const session = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  try {
    expect(storage.usageFor(session.sessionId)).toEqual({ backend: "codex", callSeconds: 0, callFinal: false, planStartPercent: 10,
      plan: { type: "pro", primary: { usedPercent: 10, resetsAt: 2000000000, windowMinutes: 300 }, secondary: null, limitReached: false, observedAt: clock } });
    notify(f.root, "account/rateLimits/updated", { rateLimits: { planType: "pro", primary: { usedPercent: 23, resetsAt: 2000000100, windowDurationMins: 300 },
      secondary: { usedPercent: 77, resetsAt: 2000600000, windowDurationMins: 10080 }, rateLimitReachedType: null } });
    await until(() => codexUsage(storage, session.sessionId).plan?.primary?.usedPercent === 23);
    clock += 252_400;
    expect(storage.usageFor(session.sessionId)).toMatchObject({ callSeconds: 252, callFinal: false, planStartPercent: 10,
      plan: { type: "pro", primary: { usedPercent: 23, windowMinutes: 300 }, secondary: { usedPercent: 77, resetsAt: 2000600000, windowMinutes: 10080 } } });
    // A rolling update leaves out what it does not carry; it never clears it.
    notify(f.root, "account/rateLimits/updated", { rateLimits: { planType: null, primary: { usedPercent: 24, resetsAt: 2000000100, windowDurationMins: 300 }, secondary: null } });
    await until(() => codexUsage(storage, session.sessionId).plan?.primary?.usedPercent === 24);
    expect(codexUsage(storage, session.sessionId).plan).toMatchObject({ type: "pro", secondary: { usedPercent: 77 } });
    expect(f.observations.at(-1)!.limits).toMatchObject({ plan: "pro", session: { usedPercent: 24 }, weekly: { usedPercent: 77 } });
    await service.close(session.sessionId);
    // A confirmed hang-up of a call on the plan has no reservation to report as kept.
    expect(admission.events(session.sessionId, 0).filter(row => row.type === "session.closed")).toEqual([expect.objectContaining({ reason: "operator", incomplete: false })]);
    clock += 10_000;
    const ended = codexUsage(storage, session.sessionId);
    expect(ended).toMatchObject({ callSeconds: 252, callFinal: true, planStartPercent: 10, plan: { primary: { usedPercent: 24 } } });
    expect(storage.settings().lastCodexSession).toEqual({ seconds: 252.4, endedAt: clock - 10_000, plan: ended.plan });
  } finally { await service.close(session.sessionId); await f.provider.hangup("voice_thread", ""); }
});

const assistant = (root: string, method: "delta" | "done", text: string) => notify(root, `thread/realtime/transcript/${method}`, { threadId: "voice_thread", role: "assistant", ...(method === "delta" ? { delta: text } : { text }) });
const spokenTexts = (root: string) => wire(root).filter(row => row.method === "thread/realtime/appendSpeech").map(row => row.params!.text);
const closures = (admission: CompanionAdmission, id: string) => admission.events(id, 0).filter(row => row.type === "session.closed");
const UK_LIMIT = "Ліміт плану Codex вичерпано, тож мушу завершити розмову.";

for (const [name, reading, recordedPercent] of [
  ["a window at 100%", { planType: "pro", primary: { usedPercent: 100, resetsAt: 2000000100, windowDurationMins: 300 }, secondary: null, rateLimitReachedType: "rate_limit_reached" }, 100],
  // The windows still have room; only the marker says the account is out.
  ["only the reached marker", { planType: "pro", primary: { usedPercent: 10, resetsAt: 2000000100, windowDurationMins: 300 }, secondary: null, rateLimitReachedType: "workspace_member_usage_limit_reached" }, 10],
] as const) test(`a limit mid-call (${name}) is said once after the voice is free, the call stops with reason limit once it is voiced, and the next pick avoids the account`, async () => {
  const f = fixture("sdp", undefined, { accounts: ["account-a", "account-b"], recorded: true }); fs.writeFileSync(path.join(f.root, "sdp"), "ready");
  const { storage, admission, service } = sessions(f.root, f.provider, undefined, { limitGraceMs: 10_000 });
  const session = await service.start({ project: "fixture", locale: "uk", sdp: "v=0" });
  const pid = Number(fs.readFileSync(path.join(f.root, "pid"), "utf8"));
  try {
    expect(f.observations.at(-1)!.accountId).toBe("account-a");
    notify(f.root, "account/rateLimits/updated", { rateLimits: reading });
    notify(f.root, "account/rateLimits/updated", { rateLimits: reading });
    await until(() => spokenTexts(f.root).length > 0);
    await Bun.sleep(150);
    // Sent, not yet voiced: the call waits for the sentence to end.
    expect(closures(admission, session.sessionId)).toEqual([]);
    expect(wire(f.root).some(row => row.method === "thread/realtime/stop")).toBe(false);
    assistant(f.root, "done", UK_LIMIT);
    await until(() => closures(admission, session.sessionId).length > 0);
    expect(closures(admission, session.sessionId)).toEqual([expect.objectContaining({ reason: "limit", incomplete: false })]);
    const requests = wire(f.root).filter(row => row.method?.startsWith("thread/realtime/"));
    const spoken = requests.filter(row => row.method === "thread/realtime/appendSpeech");
    expect(spoken.map(row => row.params!.text)).toEqual([UK_LIMIT]);
    expect(requests.findIndex(row => row.method === "thread/realtime/stop")).toBeGreaterThan(requests.indexOf(spoken[0]!));
    expect(storage.usageFor(session.sessionId)).toMatchObject({ backend: "codex", callFinal: true, plan: { limitReached: true, primary: { usedPercent: recordedPercent } } });
    await until(() => gone(pid));
    // The recorded observation keeps the percentages it read, and says the limit is reached.
    expect(durableQuotaObservation(f.observations.at(-1)!, "fixture")).toMatchObject({ accountId: "account-a", limitReached: true, limits: { session: { usedPercent: recordedPercent, resetsAt: 2000000100 } } });
    // Workers pick from the same record.
    const recorded = f.observations.map(observation => durableQuotaObservation(observation, "fixture"));
    expect(selectHeadlessAccount([{ id: "account-a", authPresent: true }, { id: "account-b", authPresent: true }], recorded, null, [], Date.now())).toEqual({ kind: "available", accountId: "account-b" });
    // With no other account the next start is refused before any process starts, by this provider and by a restarted Viewer's.
    f.accounts.ids = ["account-a"];
    await expect(f.provider.create("", "en", "v=0", "Fixture", "fixture")).rejects.toMatchObject({ message: "CODEX_LIMIT_REACHED" });
    await expect(f.fresh().create("", "en", "v=0", "Fixture", "fixture")).rejects.toMatchObject({ message: "CODEX_LIMIT_REACHED" });
    expect(Number(fs.readFileSync(path.join(f.root, "pid"), "utf8"))).toBe(pid);
    // With another, the next start runs on it.
    f.accounts.ids = ["account-a", "account-b"];
    const restarted = f.fresh();
    try {
      await restarted.create("", "en", "v=0", "Fixture", "fixture");
      expect(f.observations.at(-1)!.accountId).toBe("account-b");
    } finally { await restarted.hangup("voice_thread", ""); }
  } finally { await service.close(session.sessionId); await f.provider.hangup("voice_thread", ""); }
});

test("a limit while the voice answers a backing turn waits for that answer, drops later reports, and says its sentence once", async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, "sdp"), "ready");
  const { admission, service } = sessions(f.root, f.provider, undefined, { limitGraceMs: 10_000 });
  const session = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  const reached = { rateLimits: { planType: "pro", primary: { usedPercent: 100, resetsAt: 2000000100, windowDurationMins: 300 }, secondary: null, rateLimitReachedType: "rate_limit_reached" } };
  try {
    notify(f.root, "turn/started", { threadId: "voice_thread", turn: { id: "turn_backing" } });
    assistant(f.root, "delta", "The open tasks are");
    notify(f.root, "account/rateLimits/updated", reached);
    // The failed turn would say the board could not be read; after the limit it says nothing.
    notify(f.root, "turn/completed", { threadId: "voice_thread", turn: { id: "turn_backing", status: "failed" } });
    notify(f.root, "account/rateLimits/updated", reached);
    await until(() => fs.readdirSync(f.root).filter(name => /^notify-\d+\.json$/.test(name)).length === 0);
    await Bun.sleep(150);
    expect(spokenTexts(f.root)).toEqual([]);
    assistant(f.root, "done", "The open tasks are two.");
    await until(() => spokenTexts(f.root).length > 0);
    await Bun.sleep(150);
    expect(closures(admission, session.sessionId)).toEqual([]);
    assistant(f.root, "done", "The Codex plan limit is reached, so I have to end the call now.");
    await until(() => closures(admission, session.sessionId).length > 0);
    expect(closures(admission, session.sessionId)).toEqual([expect.objectContaining({ reason: "limit", incomplete: false })]);
    expect(spokenTexts(f.root)).toEqual(["The Codex plan limit is reached, so I have to end the call now."]);
  } finally { await service.close(session.sessionId); await f.provider.hangup("voice_thread", ""); }
});

test("a limit sentence the voice never gets to still ends the call with reason limit at the bound", async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, "sdp"), "ready");
  const { admission, service } = sessions(f.root, f.provider, undefined, { limitGraceMs: 300 });
  const session = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  try {
    assistant(f.root, "delta", "Still speaking");
    notify(f.root, "account/rateLimits/updated", { rateLimits: { planType: "pro", primary: { usedPercent: 100, resetsAt: 2000000100, windowDurationMins: 300 }, secondary: null } });
    await until(() => closures(admission, session.sessionId).length > 0);
    expect(closures(admission, session.sessionId)).toEqual([expect.objectContaining({ reason: "limit", incomplete: false })]);
    expect(spokenTexts(f.root)).toEqual([]);
  } finally { await service.close(session.sessionId); await f.provider.hangup("voice_thread", ""); }
});

test("a realtime error after the limit still closes the call with reason limit", async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, "sdp"), "ready");
  const { admission, service } = sessions(f.root, f.provider, undefined, { limitGraceMs: 5_000 });
  const session = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
  try {
    notify(f.root, "account/rateLimits/updated", { rateLimits: { planType: "pro", primary: { usedPercent: 100, resetsAt: 2000000100, windowDurationMins: 300 }, secondary: null } });
    await until(() => wire(f.root).some(row => row.method === "thread/realtime/appendSpeech"));
    notify(f.root, "thread/realtime/error", { threadId: "voice_thread", message: "exceeded retry limit, last status: 429 Too Many Requests" });
    await until(() => admission.events(session.sessionId, 0).some(row => row.type === "session.closed"));
    const events = admission.events(session.sessionId, 0);
    expect(events.filter(row => row.type === "session.closed")).toMatchObject([{ reason: "limit" }]);
    expect(events.filter(row => row.type === "error")).toEqual([]);
    expect(wire(f.root).filter(row => row.method === "thread/realtime/appendSpeech").map(row => row.params!.text)).toEqual(["The Codex plan limit is reached, so I have to end the call now."]);
  } finally { await service.close(session.sessionId); await f.provider.hangup("voice_thread", ""); }
});

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
  // A recorded reached limit holds the account out of the pick while its windows still have room.
  const reached = (accountId: string, at = now): DurableQuotaObservation => ({ ...observation(accountId, 10, reset), observedAt: new Date(at).toISOString(), authCheckedAt: new Date(at).toISOString(), limitReached: true });
  expect(selectVoiceAccount(accounts, [observation("account-a", 30, reset), reached("account-b")], [], "fixture", now).id).toBe("account-a");
  expect(() => selectVoiceAccount(accounts, [reached("account-a"), reached("account-b")], [], "fixture", now)).toThrow("CODEX_LIMIT_REACHED");
  expect(() => selectVoiceAccount(accounts.slice(0, 2), [reached("account-a")], [], "fixture", now)).toThrow("CODEX_LIMIT_REACHED");
  // A later reading that says the limit is no longer reached restores the account.
  expect(selectVoiceAccount(accounts.slice(0, 2), [{ ...reached("account-a"), limitReached: false }], [], "fixture", now).id).toBe("account-a");
  // So does the selector's freshness horizon: a stale mark proves nothing.
  expect(selectVoiceAccount(accounts.slice(0, 2), [reached("account-a", now - 5 * 60_000 - 1)], [], "fixture", now).id).toBe("account-a");
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

test("the server starts a call on the API by default and on Codex when the settings choose it, with the operator's voice, no key and never a legacy sign-in", async () => {
  const f = fixture(); process.env.LLV_STATE_DIR = path.join(f.root, "state");
  const previous = { home: process.env.LLV_CODEX_HOME, key: process.env.OPENAI_API_KEY, binary: process.env.LLV_CODEX_BINARY, root: process.env.VOICE_STUB_ROOT, mode: process.env.VOICE_STUB_MODE, backend: process.env.LLV_VOICE_BACKEND };
  process.env.LLV_CODEX_HOME = path.join(f.root, "legacy");
  fs.mkdirSync(process.env.LLV_CODEX_HOME);
  fs.writeFileSync(path.join(process.env.LLV_CODEX_HOME, "auth.json"), "{}");
  delete process.env.OPENAI_API_KEY; delete process.env.LLV_VOICE_BACKEND;
  Object.assign(process.env, { LLV_CODEX_BINARY: f.binary, VOICE_STUB_ROOT: f.root, VOICE_STUB_MODE: "sdp" });
  const { companionSessions, setCompanionSessionsForTests } = await import("./server");
  const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
  const noKey = () => { throw new Error("API key read on the subscription path"); };
  try {
    setCompanionSessionsForTests(undefined);
    let service = companionSessions(); service.storage.updateSettings({ enabled: true });
    // The API is the default backend: its start reads the key.
    service.storage.providerKey = () => { throw new Error("API provider selected"); };
    await expect(service.start({ project: "fixture", locale: "en", sdp: "v=0" })).rejects.toThrow("API provider selected");
    service.storage.updateSettings({ backend: "codex" });
    service.storage.providerKey = noKey;
    // Only the legacy home is signed in: the call is refused, never started on it.
    await expect(service.start({ project: "fixture", locale: "en", sdp: "v=0" })).rejects.toThrow("NO_CODEX_ACCOUNT");
    expect(Object.values(service.storage.read().sessions).every(row => row.closed && !row.remoteOpen)).toBe(true);
    const managed = createManagedCodexAccount("fixture");
    fs.mkdirSync(managed.home, { recursive: true }); fs.writeFileSync(path.join(managed.home, "auth.json"), "{}");
    fs.writeFileSync(path.join(f.root, "sdp"), "ready");
    setCompanionSessionsForTests(undefined);
    service = companionSessions(); service.storage.providerKey = noKey;
    expect(service.storage.settings().keySource).toBe("missing");
    const session = await service.start({ project: "fixture", locale: "en", sdp: "v=0" });
    expect(session.sdp).toBe("v=0\r\nanswer\r\n");
    expect(wire(f.root).find(row => row.method === "thread/realtime/start")?.params).toMatchObject({ version: "v3", voice: "cove", transport: { type: "webrtc" } });
    expect(JSON.parse(fs.readFileSync(path.join(f.root, "env"), "utf8")).filter((key: string) => /_API_KEY$|^OPENAI_/i.test(key))).toEqual([]);
    await service.close(session.sessionId);
    expect(service.storage.read().sessions[session.sessionId]).toMatchObject({ closed: true, remoteOpen: false, backend: "codex" });
  } finally {
    for (const [name, value] of [["LLV_CODEX_HOME", previous.home], ["OPENAI_API_KEY", previous.key], ["LLV_CODEX_BINARY", previous.binary], ["VOICE_STUB_ROOT", previous.root], ["VOICE_STUB_MODE", previous.mode], ["LLV_VOICE_BACKEND", previous.backend]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    setCompanionSessionsForTests(undefined);
    await f.provider.hangup("voice_thread", "");
  }
});
