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
