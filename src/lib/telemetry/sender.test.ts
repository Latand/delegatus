import { beforeEach, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendInstallPing, maySend, scheduleInstallPing, type PingPorts } from "./sender";
import { installPingId, preferences, updatePreferences, telemetryFile, telemetryStatus } from "./store";
import { GET } from "@/app/api/telemetry/route";
import { ensureSelf } from "@/lib/links/self";
import type { LauncherRecord } from "@/lib/selfUpdate/launcher";
import { foldDelegatusEnvironment } from "../../../bin/envAlias.mjs";

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
test("resolved Docker service.env opt-outs suppress the sender for both production services", async () => {
  for (const optOut of ["DELEGATUS_TELEMETRY=0", "DO_NOT_TRACK=1", "LLV_TELEMETRY=0"]) {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ping-compose-env-"));
    const envFile = path.join(fixtureDir, "service.env");
    fs.writeFileSync(envFile, `${optOut}\n`);
    const cleanEnv = { ...process.env };
    for (const key of ["DELEGATUS_TELEMETRY", "LLV_TELEMETRY", "DO_NOT_TRACK", "DELEGATUS_ENV_FILE", "LLV_ENV_FILE"]) delete cleanEnv[key];
    const configResult = Bun.spawnSync(["docker", "compose", "--profile", "*", "config", "--format", "json"], {
      cwd: process.cwd(),
      env: { ...cleanEnv, DELEGATUS_ENV_FILE: envFile },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      expect(configResult.exitCode).toBe(0);
      const config = JSON.parse(configResult.stdout.toString()) as { services: Record<string, { environment: Record<string, string> }> };
      for (const serviceName of ["viewer", "runtime-host"]) {
        const fixture = harness();
        updatePreferences({ enabled: true });
        const serviceEnv = { ...config.services[serviceName]!.environment };
        foldDelegatusEnvironment(serviceEnv, () => {});
        fixture.ports.env = { ...fixture.ports.env, ...serviceEnv };
        await sendInstallPing(fixture.ports);
        expect(fixture.requests, `${optOut} in ${serviceName}`).toHaveLength(0);
      }
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
});
test("an empty resolved Docker service.env keeps the default-on sender", async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ping-compose-default-"));
  const envFile = path.join(fixtureDir, "service.env");
  fs.writeFileSync(envFile, "");
  const cleanEnv = { ...process.env };
  for (const key of ["DELEGATUS_TELEMETRY", "LLV_TELEMETRY", "DO_NOT_TRACK", "DELEGATUS_ENV_FILE", "LLV_ENV_FILE"]) delete cleanEnv[key];
  const configResult = Bun.spawnSync(["docker", "compose", "--profile", "*", "config", "--format", "json"], {
    cwd: process.cwd(), env: { ...cleanEnv, DELEGATUS_ENV_FILE: envFile }, stdout: "pipe", stderr: "pipe",
  });
  try {
    expect(configResult.exitCode).toBe(0);
    const config = JSON.parse(configResult.stdout.toString()) as { services: Record<string, { environment: Record<string, string> }> };
    const serviceEnv = { ...config.services.viewer!.environment };
    foldDelegatusEnvironment(serviceEnv, () => {});
    const fixture = harness();
    fixture.ports.env = { ...fixture.ports.env, ...serviceEnv };
    await sendInstallPing(fixture.ports);
    expect(fixture.requests).toHaveLength(1);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
test("shell Docker opt-outs override service.env and viewer-test stays disabled", async () => {
  for (const shell of [{ DELEGATUS_TELEMETRY: "0" }, { LLV_TELEMETRY: "0" }, { DO_NOT_TRACK: "1" }]) {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ping-compose-shell-"));
    const envFile = path.join(fixtureDir, "service.env");
    fs.writeFileSync(envFile, "DELEGATUS_TELEMETRY=1\nDO_NOT_TRACK=0\n");
    const cleanEnv = { ...process.env };
    for (const key of ["DELEGATUS_TELEMETRY", "LLV_TELEMETRY", "DO_NOT_TRACK", "DELEGATUS_ENV_FILE", "LLV_ENV_FILE"]) delete cleanEnv[key];
    const configResult = Bun.spawnSync(["docker", "compose", "--profile", "*", "config", "--format", "json"], {
      cwd: process.cwd(), env: { ...cleanEnv, DELEGATUS_ENV_FILE: envFile, ...shell }, stdout: "pipe", stderr: "pipe",
    });
    try {
      expect(configResult.exitCode).toBe(0);
      const config = JSON.parse(configResult.stdout.toString()) as { services: Record<string, { environment: Record<string, string> }> };
      for (const serviceName of ["viewer", "runtime-host"]) {
        const fixture = harness();
        updatePreferences({ enabled: true });
        const serviceEnv = { ...config.services[serviceName]!.environment };
        foldDelegatusEnvironment(serviceEnv, () => {});
        fixture.ports.env = { ...fixture.ports.env, ...serviceEnv };
        await sendInstallPing(fixture.ports);
        expect(fixture.requests, `${JSON.stringify(shell)} in ${serviceName}`).toHaveLength(0);
      }
      const viewerTestEnv = { ...config.services["viewer-test"]!.environment };
      foldDelegatusEnvironment(viewerTestEnv, () => {});
      const testFixture = harness();
      testFixture.ports.env = { ...testFixture.ports.env, ...viewerTestEnv };
      await sendInstallPing(testFixture.ports);
      expect(testFixture.requests).toHaveLength(0);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
});
test("viewer-test stays disabled with inherited telemetry override aliases and positive shell overrides", async () => {
  const inputs = [
    { file: "DELEGATUS_TELEMETRY_OVERRIDE=1\n" },
    { file: "LLV_TELEMETRY_OVERRIDE=1\n" },
    { file: "", shell: { DELEGATUS_TELEMETRY_OVERRIDE: "1" } },
    { file: "", shell: { LLV_TELEMETRY_OVERRIDE: "1" } },
  ];
  for (const input of inputs) {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ping-viewer-test-"));
    const envFile = path.join(fixtureDir, "service.env");
    fs.writeFileSync(envFile, input.file);
    const cleanEnv = { ...process.env };
    for (const key of ["DELEGATUS_TELEMETRY", "LLV_TELEMETRY", "DELEGATUS_TELEMETRY_OVERRIDE", "LLV_TELEMETRY_OVERRIDE", "DO_NOT_TRACK", "DELEGATUS_ENV_FILE", "LLV_ENV_FILE"]) delete cleanEnv[key];
    const configResult = Bun.spawnSync(["docker", "compose", "--profile", "*", "config", "--format", "json"], {
      cwd: process.cwd(), env: { ...cleanEnv, DELEGATUS_ENV_FILE: envFile, ...input.shell }, stdout: "pipe", stderr: "pipe",
    });
    try {
      expect(configResult.exitCode).toBe(0);
      const config = JSON.parse(configResult.stdout.toString()) as { services: Record<string, { environment: Record<string, string> }> };
      const fixture = harness();
      updatePreferences({ enabled: true });
      const testEnv = { ...config.services["viewer-test"]!.environment };
      foldDelegatusEnvironment(testEnv, () => {});
      fixture.ports.env = { ...fixture.ports.env, ...testEnv };
      await sendInstallPing(fixture.ports);
      expect(fixture.requests, JSON.stringify(input)).toHaveLength(0);
      expect(fs.existsSync(telemetryFile("id")), JSON.stringify(input)).toBe(false);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
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

test("notice acknowledgement in another process preserves a confirmed opt-out", async () => {
  const ready = path.join(root, "notice-write-ready");
  const release = path.join(root, "notice-write-release");
  const env = { ...process.env, LLV_STATE_DIR: root };
  const childCode = `
    import fs from "node:fs";
    import { NextRequest } from "next/server";
    import { PUT } from "./src/app/api/telemetry/route.ts";
    const ready = ${JSON.stringify(ready)};
    const release = ${JSON.stringify(release)};
    const rename = fs.renameSync.bind(fs);
    fs.renameSync = (from, to) => {
      fs.writeFileSync(ready, "ready");
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 5);
      return rename(from, to);
    };
    const response = await PUT(new NextRequest("http://localhost/api/telemetry", {
      method: "PUT", headers: { "Content-Type": "application/json", Host: "localhost" },
      body: JSON.stringify({ noticeDismissed: true }),
    }));
    if (!response.ok) throw new Error("Notice acknowledgement failed: " + response.status);
  `;
  const child = Bun.spawn(["bun", "-e", childCode], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(5);
  const readySeen = fs.existsSync(ready);
  const disable = readySeen ? Bun.spawnSync(["bun", "-e", `
      import { NextRequest } from "next/server";
      import { PUT } from "./src/app/api/telemetry/route.ts";
      const response = await PUT(new NextRequest("http://localhost/api/telemetry", {
        method: "PUT", headers: { "Content-Type": "application/json", Host: "localhost" },
        body: JSON.stringify({ enabled: false }),
      }));
      if (!response.ok) throw new Error("Opt-out failed: " + response.status);
    `], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }) : null;
  fs.writeFileSync(release, "go");
  const childExit = await child.exited;
  const childError = await new Response(child.stderr).text();
  expect(readySeen, "notice writer reached its atomic commit").toBe(true);
  expect(disable?.exitCode).toBe(0, disable?.stderr.toString());
  expect(childExit).toBe(0, childError);
  expect(await (await GET()).json()).toMatchObject({ enabled: false, noticeDismissed: true });
  expect(preferences()).toEqual({ enabled: false, noticeDismissed: true });
  expect(telemetryStatus()).toMatchObject({ enabled: false, noticeDismissed: true });
  const fixture = harness(); await sendInstallPing(fixture.ports);
  expect(fixture.requests).toHaveLength(0);
  expect(fs.existsSync(telemetryFile("id"))).toBe(false);
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
