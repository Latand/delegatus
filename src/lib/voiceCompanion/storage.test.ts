import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-storage-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
delete process.env.OPENAI_API_KEY;
const { CompanionStorage } = await import("./storage");
const { configFilePath } = await import("@/lib/configDir");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("settings are off by default; saving a key returns availability and writes owner-only", () => {
  const storage = new CompanionStorage();
  expect(storage.settings()).toMatchObject({ enabled: false, keySource: "missing" });
  expect(storage.settings()).not.toHaveProperty("backend");
  storage.saveKey("synthetic-provider-credential");
  expect(fs.statSync(configFilePath("openai-api-key")).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(storage.settings())).not.toContain("synthetic-provider-credential");
  expect(storage.settings().keySource).toBe("file");
  process.env.OPENAI_API_KEY = "env-test";
  expect(storage.settings().keySource).toBe("env");
  expect(storage.providerKey()).toBe("env-test");
  expect(() => storage.saveKey("replacement")).toThrow("KEY_FROM_ENV");
  delete process.env.OPENAI_API_KEY;
});

test("the cap includes reservations, deduplicates usage, survives restart and rolls to the next UTC month", () => {
  let now = Date.parse("2026-10-06T10:00:00Z");
  const storage = new CompanionStorage(() => now);
  storage.updateSettings({ monthlyCapUsd: 1, enabled: true });
  storage.reserve("session-a", 0.75);
  storage.reserve("session-a", 0.75);
  expect(() => storage.reserve("session-b", 0.5)).toThrow("CAP_REACHED");
  storage.settle("session-a", 0.5);
  storage.settle("session-a", 0.5);
  expect(new CompanionStorage(() => now).settings().usageUsd).toBe(0.5);
  storage.reserve("session-b", 0.5);
  storage.settle("session-b", null);
  expect(storage.settings()).toMatchObject({ usageUsd: 1, reservedUsd: 0, incomplete: true });
  expect(() => storage.reserve("session-c", 0.01)).toThrow("CAP_REACHED");
  now = Date.parse("2026-11-01T00:00:00Z");
  expect(storage.settings()).toMatchObject({ usageUsd: 0, reservedUsd: 0, incomplete: false });
});

test("malformed state fails closed instead of losing reservations or session authority", async () => {
  const { statePath } = await import("@/lib/configDir");
  const storage = new CompanionStorage();
  const document = storage.read();
  for (const field of ["charges", "sessions"] as const) {
    fs.writeFileSync(statePath("voice-companion.json"), JSON.stringify({ ...document, [field]: [] }));
    expect(() => storage.read()).toThrow("COMPANION_STATE_UNAVAILABLE");
  }
  fs.writeFileSync(statePath("voice-companion.json"), JSON.stringify(document));
});

test("a demo stored by an earlier build reads as off, the real voice stays on, and the next write drops the field; no update selects a backend", () => {
  const file = path.join(process.env.LLV_STATE_DIR!, "voice-companion.json");
  const stored = (backend: string, enabled: boolean) => fs.writeFileSync(file, JSON.stringify({ version: 1, settings: { enabled, backend, monthlyCapUsd: 20 }, charges: {}, sessions: {} }));
  stored("demo", true);
  const storage = new CompanionStorage();
  expect(storage.settings()).toMatchObject({ enabled: false, monthlyCapUsd: 20 });
  expect(storage.settings()).not.toHaveProperty("backend");
  storage.updateSettings({ monthlyCapUsd: 25 });
  const written = JSON.parse(fs.readFileSync(file, "utf8")) as { settings: Record<string, unknown> };
  expect(written.settings).toEqual({ enabled: false, monthlyCapUsd: 25 });
  stored("official-realtime", true);
  expect(storage.settings()).toMatchObject({ enabled: true });
  expect(storage.settings()).not.toHaveProperty("backend");
  stored("something-else", true);
  expect(() => storage.settings()).toThrow("COMPANION_STATE_UNAVAILABLE");
  stored("official-realtime", false);
  for (const update of [{ backend: "demo" }, { enabled: true, backend: "demo" }, { backend: "official-realtime" }]) {
    expect(() => storage.updateSettings(update as never)).toThrow("INVALID_SETTINGS");
  }
  expect(storage.settings().enabled).toBe(false);
});

test("call usage shows observed spend while live and only complete settlement is final; settings use persisted close time", async () => {
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  let now = Date.parse("2026-10-10T07:00:00Z");
  const storage = new CompanionStorage(() => now);
  const { CompanionAdmission } = await import("./admission");
  const admission = new CompanionAdmission(storage, { recipient: () => null, reports: () => [], send: async () => { throw new Error("unused"); } }, () => now);
  const session = admission.create({ project: "usage", locale: "en", startedBy: { operator: true } });
  storage.reserve(session.id, 1);
  expect(storage.usageFor(session.id)).toEqual({ callUsd: 0, callFinal: false, callIncomplete: false, month: "2026-10", monthUsd: 0, monthCapUsd: 20 });
  storage.observe(session.id, 0.2);
  expect(storage.usageFor(session.id)).toMatchObject({ callUsd: 0.2, monthUsd: 0.2, callFinal: false });
  storage.change(document => { document.sessions[session.id].usage = { seconds: 30, responses: { backend: { usd: 0.001, complete: true,
    tokens: { input: 100, cached: 10, cacheWrite: 20, output: 200 }, responseId: "response_fixture" } } }; });
  storage.settle(session.id, 0.3);
  expect(storage.usageFor(session.id)).toMatchObject({ callUsd: 0.3, callFinal: true, callIncomplete: false });
  now += 40_000;
  admission.emit(session.id, { type: "session.closed", reason: "operator" });
  admission.retire(session.id);
  // Settings read no transcript bytes, including when the journal is damaged.
  const transcriptFile = path.join(root, "state", "voice-companion", "transcripts", `${session.id}.jsonl`);
  const transcriptBytes = fs.readFileSync(transcriptFile);
  fs.writeFileSync(transcriptFile, "damaged transcript");
  expect(storage.settings().lastSession).toEqual({ usd: 0.3, seconds: 30, endedAt: now, incomplete: false });
  fs.writeFileSync(transcriptFile, transcriptBytes);
  const incomplete = admission.create({ project: "usage", locale: "en" });
  storage.reserve(incomplete.id, 0.5);
  storage.settle(incomplete.id, null);
  expect(storage.usageFor(incomplete.id)).toMatchObject({ callUsd: 0.5, callFinal: false, callIncomplete: true, monthUsd: 0.8 });
  now = Date.parse("2026-11-01T00:00:00Z");
  expect(storage.usageFor(session.id)).toMatchObject({ callUsd: 0.3, month: "2026-11", monthUsd: 0 });
});

test("stored session authority and backend token details reject malformed data", async () => {
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
  const storage = new CompanionStorage();
  const { CompanionAdmission } = await import("./admission");
  const admission = new CompanionAdmission(storage, { recipient: () => null, reports: () => [], send: async () => { throw new Error("unused"); } });
  const session = admission.create({ project: "valid", locale: "en", startedBy: { memberId: "m_fixture" } });
  const valid = storage.read();
  const file = path.join(root, "state", "voice-companion.json");
  for (const patch of [{ startedBy: { memberId: "m_fixture", cookie: "forbidden" } }, { startedBy: { operator: false } },
    { currentProject: 0 }, { reportWatermarks: { valid: -1 } }, { spokenReports: [1] },
    { usage: { seconds: 0, responses: { r: { complete: true, usd: 0, tokens: { input: 1, cached: 1, cacheWrite: 1, output: 0 } } } } }]) {
    const document = structuredClone(valid);
    Object.assign(document.sessions[session.id], patch);
    fs.writeFileSync(file, JSON.stringify(document));
    expect(() => storage.read()).toThrow("COMPANION_STATE_UNAVAILABLE");
  }
  fs.writeFileSync(file, JSON.stringify(valid));
  expect(storage.read().sessions[session.id].startedBy).toEqual({ memberId: "m_fixture" });
});
