import { beforeEach, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendInstallPing, maySend, scheduleInstallPing, type PingPorts } from "./sender";
import { installPingId, updatePreferences, telemetryFile, telemetryStatus } from "./store";
import { ensureSelf } from "@/lib/links/self";
import type { LauncherRecord } from "@/lib/selfUpdate/launcher";

let root: string;
const old = process.env.LLV_STATE_DIR;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ping-test-")); process.env.LLV_STATE_DIR = root; });
afterEach(() => { if (old === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = old; fs.rmSync(root, { recursive: true, force: true }); });
function harness() {
  const requests: { url: string; init: RequestInit }[] = [];
  let date = new Date("2026-09-30T23:59:00Z");
  const ports: PingPorts = {
    env: { NODE_ENV: "production", LLV_STATE_OWNER: "viewer" }, now: () => date,
    fetch: (async (url, init) => { requests.push({ url: String(url), init: init! }); return new Response(null, { status: 204 }); }) as typeof fetch,
    mode: { env: {}, readRecord: () => null, alive: () => true, deploymentsEnabled: async () => true }, os: "linux", arch: "x64",
  };
  return { ports, requests, date: (value: string) => { date = new Date(value); } };
}
test("defaults send exactly five fields once per UTC day, stable across restarts and concurrent sends", async () => {
  const fixture = harness();
  await Promise.all([sendInstallPing(fixture.ports), sendInstallPing(fixture.ports)]);
  await sendInstallPing(fixture.ports);
  expect(fixture.requests).toHaveLength(1);
  const body = JSON.parse(fixture.requests[0]!.init.body as string);
  expect(Object.keys(body).sort()).toEqual(["arch", "id", "kind", "os", "v"]);
  expect(body).toMatchObject({ os: "linux", arch: "x64", kind: "docker" });
  expect(body.id).toBe(installPingId());
  expect(body.id).not.toBe(ensureSelf()!.installId);
  expect(fixture.requests[0]!.url).toBe("https://delegatus.org/api/ping");
  expect(fixture.requests[0]!.init.signal).toBeInstanceOf(AbortSignal);
  expect(fixture.requests[0]!.init.redirect).toBe("error");
  fixture.date("2026-10-01T00:00:00Z");
  await sendInstallPing(fixture.ports);
  expect(fixture.requests).toHaveLength(2);
  expect(JSON.parse(fixture.requests[1]!.init.body as string).id).toBe(body.id);
});
for (const env of [{ DELEGATUS_TELEMETRY: "0" }, { LLV_TELEMETRY: "0" }, { DO_NOT_TRACK: "1" }, { LLV_STATE_OWNER: "runtime-host" }, { LLV_STATE_OWNER: "mcp" }, { LLV_STATE_OWNER: "" }, { NODE_ENV: "development" }, { NODE_ENV: "test" }, { NEXT_PHASE: "phase-production-build" }, { NEXT_PHASE: "phase-development-server" }, { CI: "true" }, { BUN_TEST: "1" }]) {
  test(`no request or identity when disabled: ${JSON.stringify(env)}`, async () => {
    const fixture = harness(); Object.assign(fixture.ports.env, env);
    await sendInstallPing(fixture.ports);
    expect(fixture.requests).toHaveLength(0);
    expect(fs.existsSync(telemetryFile("id"))).toBe(false);
  });
}
test("the switch persists and environment always wins", async () => {
  const fixture = harness(); updatePreferences({ enabled: false });
  await sendInstallPing(fixture.ports); expect(fixture.requests).toHaveLength(0);
  updatePreferences({ enabled: true }); fixture.ports.env = { ...fixture.ports.env, DO_NOT_TRACK: "1" };
  expect(telemetryStatus(fixture.ports.env)).toMatchObject({ enabled: false, locked: true });
  await sendInstallPing(fixture.ports); expect(fixture.requests).toHaveLength(0);
  fixture.ports.env = { NODE_ENV: "production", LLV_STATE_OWNER: "viewer" }; await sendInstallPing(fixture.ports); expect(fixture.requests).toHaveLength(1);
});
test("an opt-out while the mode probe runs prevents the send", async () => {
  const fixture = harness(); fixture.ports.mode.deploymentsEnabled = async () => { updatePreferences({ enabled: false }); return true; };
  await sendInstallPing(fixture.ports); expect(fixture.requests).toHaveLength(0);
});
test("network failures consume the daily claim, with no retry", async () => {
  const fixture = harness(); let attempts = 0;
  fixture.ports.fetch = (async () => { attempts++; throw new Error("offline"); }) as unknown as typeof fetch;
  await expect(sendInstallPing(fixture.ports)).rejects.toThrow("offline");
  await sendInstallPing(fixture.ports); expect(attempts).toBe(1);
});
for (const checkout of [null, "/srv/example-checkout"]) {
  test(`launcher provenance selects ${checkout ? "checkout" : "packaged"}`, async () => {
    const fixture = harness(); fixture.ports.mode.env = { LLV_SELF_UPDATE_RECORD: "record" };
    fixture.ports.mode.readRecord = () => ({ checkout } as LauncherRecord);
    await sendInstallPing(fixture.ports);
    expect(JSON.parse(fixture.requests[0]!.init.body as string).kind).toBe(checkout ? "checkout" : "packaged");
  });
}
test("unknown mode and corrupt settings or identity fail closed", async () => {
  const fixture = harness(); fixture.ports.mode.deploymentsEnabled = async () => null;
  await sendInstallPing(fixture.ports); expect(fixture.requests).toHaveLength(0);
  fixture.ports.mode.deploymentsEnabled = async () => true;
  fs.mkdirSync(telemetryFile("."), { recursive: true });
  fs.writeFileSync(telemetryFile("id"), "bad");
  await expect(sendInstallPing(fixture.ports)).rejects.toThrow("Invalid telemetry id");
  fs.writeFileSync(telemetryFile("preferences.json"), "{}");
  await expect(sendInstallPing(fixture.ports)).rejects.toThrow("Invalid telemetry preferences");
  expect(fixture.requests).toHaveLength(0);
});
test("a positive variable never overrides a saved opt-out", () => {
  updatePreferences({ enabled: false });
  expect(telemetryStatus({ DELEGATUS_TELEMETRY: "1" }).enabled).toBe(false);
  expect(maySend({ LLV_STATE_OWNER: "viewer", NODE_ENV: "production" })).toBe(true);
});

test("first send waits one minute; polling is one minute and unrefed", async () => {
  let sends = 0;
  let delayed: (() => void) | null = null;
  let periodic: (() => void) | null = null;
  let unrefs = 0;
  const timer = { unref: () => { unrefs++; } };
  const timers = {
    setTimeout: ((callback: () => void, ms: number) => { expect(ms).toBe(60_000); delayed = callback; return timer; }),
    setInterval: ((callback: () => void, ms: number) => { expect(ms).toBe(60_000); periodic = callback; return timer; }),
  } as unknown as Parameters<typeof scheduleInstallPing>[1];
  scheduleInstallPing(async () => { sends++; }, timers);
  expect(sends).toBe(0); expect(periodic).toBeNull();
  (delayed as unknown as () => void)();
  expect(sends).toBe(1); expect(unrefs).toBe(2);
  (periodic as unknown as () => void)(); expect(sends).toBe(2);
});
test("request aborts at the five-second timeout", async () => {
  const fixture = harness();
  fixture.ports.fetch = (async (_url: unknown, init: RequestInit) => new Promise((_, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as unknown as typeof fetch;
  await expect(sendInstallPing(fixture.ports)).rejects.toThrow();
}, 7000);
