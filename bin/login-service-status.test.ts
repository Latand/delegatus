import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { inspectLoginService } from "./login-service-status.mjs";
import { serviceCommand } from "./service-manager.mjs";
import { runDoctor } from "./doctor.mjs";
import { formatDoctor, runDoctorCommand } from "./doctor-command.mjs";
import type { DoctorHost, ReasonCode } from "../src/lib/doctor/contracts";

const NOW = Date.UTC(2026, 10, 11);
function fixture(platform: NodeJS.Platform = "linux") {
  const host: DoctorHost = { platform, home: path.resolve("fixture-home"), arch: "arm64", env: {}, now: () => NOW, inspect: async () => "absent", viewer: async () => "reachable" };
  return host;
}

for (const [output, reason, state] of [
  ["LoadState=not-found", "SERVICE_NOT_INSTALLED", "degraded"],
  ["LoadState=loaded\nUnitFileState=disabled\nActiveState=inactive", "SERVICE_DISABLED", "degraded"],
  ["LoadState=loaded\nUnitFileState=enabled\nActiveState=inactive", "SERVICE_NOT_RUNNING", "degraded"],
  ["LoadState=loaded\nUnitFileState=enabled\nActiveState=activating\nSubState=auto-restart\nNRestarts=2", "SERVICE_RESTARTING", "degraded"],
  ["LoadState=loaded\nUnitFileState=enabled\nActiveState=failed\nNRestarts=5", "SERVICE_FAILED", "degraded"],
  ["LoadState=loaded\nUnitFileState=enabled\nActiveState=active", "SERVICE_RUNNING", "available"],
  ["unrecognized future output", "SERVICE_UNAVAILABLE", "unknown"],
] as const) test(`Linux doctor ${reason} is bounded, optional and localized`, async () => {
  const host = fixture();
  const calls: string[][] = [];
  host.loginService = signal => inspectLoginService(host, signal, async (command, args) => {
    expect(command).toBe("systemctl"); calls.push(args);
    return { code: 0, stdout: output, stderr: "private output ignored" };
  });
  const report = await runDoctor({ host });
  expect(report.capabilities.at(-1)).toMatchObject({ id: "service.login", reason, state, timedOut: false });
  expect(calls).toEqual([["--user", "show", "delegatus.service", "--property=LoadState,UnitFileState,ActiveState,SubState,NRestarts"]]);
  for (const lang of ["en", "uk"] as const) {
    const text = formatDoctor(report, lang);
    expect(text).not.toContain("undefined"); expect(text).not.toContain("private"); expect(text).not.toContain(host.home);
    expect(await runDoctorCommand([], { lang, run: async () => ({ ...report, capabilities: [report.capabilities.at(-1)!] }), log: () => {} })).toBe(0);
  }
  const json: string[] = [];
  await runDoctorCommand(["--json"], { run: async () => report, log: line => json.push(line) });
  expect(JSON.parse(json[0]).capabilities.at(-1).reason).toBe(reason);
});

for (const [status, output, reason] of [
  [0, '{ "PID" = 123; "LastExitStatus" = 0; }', "SERVICE_RUNNING"],
  [0, '{ "LastExitStatus" = 1; }', "SERVICE_RESTARTING"],
  [0, '{ "LastExitStatus" = 0; }', "SERVICE_NOT_RUNNING"],
  [0, "changed output", "SERVICE_UNAVAILABLE"],
  [1, "", "SERVICE_NOT_RUNNING"],
] as const) test(`macOS doctor ${reason}, status ${status}`, async () => {
  const host = fixture("darwin"); host.inspect = async file => file.endsWith(".plist") ? "present" : "absent";
  const calls: string[][] = [];
  const result = await inspectLoginService(host, new AbortController().signal, async (command, args) => {
    expect(command).toBe("launchctl"); calls.push(args);
    return { code: status, stdout: output, stderr: "" };
  });
  expect(result[1]).toBe(reason);
  expect(calls.length).toBe(status ? 1 : 2);
});

test("unsupported hosts and absent Mac agent spawn no command", async () => {
  const run: typeof serviceCommand = async () => { throw new Error("must not run"); };
  for (const platform of ["win32", "darwin"] as const) {
    const host = fixture(platform);
    expect((await inspectLoginService(host, new AbortController().signal, run))[1]).toBe(platform === "darwin" ? "SERVICE_NOT_INSTALLED" : "SERVICE_UNAVAILABLE");
  }
  const host = fixture(); host.env.LLV_DOCKER_NSENTER_SHIMS = "1";
  expect((await inspectLoginService(host, new AbortController().signal, run))[1]).toBe("SERVICE_UNAVAILABLE");
});

test("a real hung manager stub is aborted and reaped within the doctor deadline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "login-doctor-"));
  try {
    const commands = path.join(root, "commands"); await mkdir(commands);
    const pidFile = path.join(root, "pid");
    await writeFile(path.join(commands, "systemctl"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const host = fixture(); host.env.PATH = commands;
    let invocation: ReturnType<typeof serviceCommand> | undefined;
    host.loginService = signal => inspectLoginService(host, signal, (...args) => { invocation = serviceCommand(...args); return invocation; });
    const start = performance.now();
    const report = await runDoctor({ host });
    expect(report.capabilities.at(-1)).toMatchObject({ reason: "PROBE_TIMEOUT", timedOut: true });
    expect(performance.now() - start).toBeLessThan(2500);
    expect(invocation).toBeDefined();
    await invocation?.catch(() => {});
    // execFile's callback follows close; the owned stub must be reaped too.
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing manager and a refused manager are unavailable", async () => {
  for (const missing of [true, false]) {
    const host = fixture();
    const run: typeof serviceCommand = async () => {
      if (missing) throw Object.assign(new Error("private path"), { code: "ENOENT" });
      return { code: 1, stdout: "", stderr: "private manager error" };
    };
    expect((await inspectLoginService(host, new AbortController().signal, run))[1] as ReasonCode).toBe("SERVICE_UNAVAILABLE");
  }
});
