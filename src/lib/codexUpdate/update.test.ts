import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateCodex, CHECK_INTERVAL_MS, newer, type UpdateNotice, type UpdatePorts } from "./update";
import { installedTarget, updateDirectory, withCliSwitch, withCodexCliLaunch } from "./installation";
import { codexProcessesPresent, runUpdateCommand } from "./production";
import { isTerminalHighSignalEvent } from "@/lib/lifecycle/vocabulary";
import { runHeadlessCodexOnce } from "@/lib/agent/headless";
import { headlessFixtureTransport, setHeadlessSpawnForTests } from "@/lib/runtime/agentSignalSandbox";
import { spawn } from "node:child_process";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function packageAt(root: string, version: string): string {
  const directory = path.join(root, "node_modules/@openai/codex");
  fs.mkdirSync(path.join(directory, "bin"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "@openai/codex", version }));
  const binary = path.join(directory, "bin/codex.js");
  fs.writeFileSync(binary, "fixture executable", { mode: 0o700 });
  return binary;
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-test-")); roots.push(root);
  const old = packageAt(path.join(root, "original"), "0.163.0");
  const candidate = packageAt(path.join(root, "candidate"), "0.164.0");
  const binary = path.join(root, "bin/codex"); fs.mkdirSync(path.dirname(binary)); fs.symlinkSync(old, binary);
  const notices: UpdateNotice[] = [], calls: string[] = [];
  let now = 0;
  const ports: UpdatePorts = {
    now: () => now, current: () => true,
    compatibilityKey: () => "fixture-v1",
    latest: async () => { calls.push("latest"); return "0.164.0"; },
    version: async file => JSON.parse(fs.readFileSync(path.join(path.dirname(fs.realpathSync(file)), "../package.json"), "utf8")).version,
    install: async () => { calls.push("install"); return candidate; },
    probe: async () => { calls.push("probe"); },
    idle: async () => true,
    report: async notice => { notices.push(structuredClone(notice)); },
  };
  return { root, old, candidate, binary, ports, calls, notices, setNow: (value: number) => { now = value; } };
}

describe("Codex CLI automatic updates", () => {
  test("no newer version spends one durable daily check", async () => {
    const work = fixture(); work.ports.latest = async () => { work.calls.push("latest"); return "0.163.0"; };
    await updateCodex(work.binary, work.ports); await updateCodex(work.binary, work.ports);
    expect(work.calls).toEqual(["latest"]); expect(installedTarget(work.binary)).toBe(work.old); expect(work.notices).toEqual([]);
    work.setNow(CHECK_INTERVAL_MS); await updateCodex(work.binary, work.ports); expect(work.calls).toHaveLength(2);
  });
  test("newer, compatible and idle switches the link and retains one-step rollback", async () => {
    const work = fixture(); await updateCodex(work.binary, work.ports);
    expect(work.calls).toEqual(["latest", "install", "probe"]);
    expect(installedTarget(work.binary)).toBe(work.candidate); expect(fs.existsSync(work.old)).toBeTrue();
    expect(work.notices.map(row => row.line)).toEqual(["Codex CLI 0.164.0: updated"]);
    await updateCodex(work.binary, work.ports, true);
    expect(installedTarget(work.binary)).toBe(work.old);
    expect(work.notices.at(-1)?.line).toBe("Codex CLI 0.163.0: rolled back; rejected release held");
    work.setNow(CHECK_INTERVAL_MS * 2); await updateCodex(work.binary, work.ports);
    expect(installedTarget(work.binary)).toBe(work.old); expect(work.calls).toHaveLength(4);
  });
  test("agents running keep the proven candidate pending until a later idle check", async () => {
    const work = fixture(); work.ports.idle = async () => false;
    await updateCodex(work.binary, work.ports);
    expect(installedTarget(work.binary)).toBe(work.old); expect(work.notices).toEqual([]);
    work.ports.idle = async () => true; await updateCodex(work.binary, work.ports);
    expect(installedTarget(work.binary)).toBe(work.candidate); expect(work.calls).toEqual(["latest", "install", "probe"]);
  });
  test.each([false, true])("a waiting candidate is reprobed after compatibility changes (refused=%s)", async refused => {
    const work = fixture(); work.ports.idle = async () => false; await updateCodex(work.binary, work.ports);
    work.ports.compatibilityKey = () => "fixture-v2";
    work.ports.probe = async () => { work.calls.push("new probe"); if (refused) throw new Error("new contract refuses"); };
    work.ports.idle = async () => true; await updateCodex(work.binary, work.ports);
    expect(work.calls).toEqual(["latest", "install", "probe", "new probe"]);
    expect(installedTarget(work.binary)).toBe(refused ? work.old : work.candidate);
    expect(work.notices.at(-1)?.failed).toBe(refused);
  });
  test.each(["registry latest", "installed version", "isolated install", "candidate version", "compatibility probe", "idle switch"])("%s failure keeps CLI and reports the failing check once", async check => {
    const work = fixture(); const fail = async (): Promise<never> => { throw new Error("private diagnostic withheld"); };
    if (check === "registry latest") work.ports.latest = fail;
    if (check === "installed version") work.ports.version = fail;
    if (check === "isolated install") work.ports.install = fail;
    if (check === "candidate version") { const version = work.ports.version; work.ports.version = file => file === work.candidate ? fail() : version(file); }
    if (check === "compatibility probe") work.ports.probe = fail;
    if (check === "idle switch") work.ports.idle = fail;
    await updateCodex(work.binary, work.ports); await updateCodex(work.binary, work.ports);
    expect(installedTarget(work.binary)).toBe(work.old); expect(work.notices).toHaveLength(1);
    expect(work.notices[0]?.line).toContain(`${check} failed; current CLI kept`);
    expect(work.notices[0]?.line).not.toContain("private diagnostic");
  });
  test.each(["probe", "idle"] as const)("a changed executable during %s is never overwritten or undone", async point => {
    const work = fixture(), other = packageAt(path.join(work.root, "other"), "0.165.0");
    const replace = () => { fs.unlinkSync(work.binary); fs.symlinkSync(other, work.binary); };
    if (point === "probe") work.ports.probe = async () => replace();
    else work.ports.idle = async () => { replace(); return true; };
    await updateCodex(work.binary, work.ports);
    expect(installedTarget(work.binary)).toBe(other); expect(work.notices.at(-1)?.failed).toBeTrue();
  });
  test("rollback preserves a second writer's replacement", async () => {
    const work = fixture(); await updateCodex(work.binary, work.ports);
    const other = packageAt(path.join(work.root, "other"), "0.165.0");
    fs.unlinkSync(work.binary); fs.symlinkSync(other, work.binary);
    await updateCodex(work.binary, work.ports, true);
    expect(installedTarget(work.binary)).toBe(other); expect(work.notices.at(-1)?.failed).toBeTrue();
  });
  test("rollback refuses a retained package changed by another installer", async () => {
    const work = fixture(); await updateCodex(work.binary, work.ports);
    fs.writeFileSync(path.join(path.dirname(work.old), "../package.json"), JSON.stringify({ version: "0.166.0" }));
    await updateCodex(work.binary, work.ports, true);
    expect(installedTarget(work.binary)).toBe(work.candidate); expect(work.notices.at(-1)?.failed).toBeTrue();
  });
  test("daily checks admit a subsequent release after holding the rolled-back release", async () => {
    const work = fixture(); await updateCodex(work.binary, work.ports); await updateCodex(work.binary, work.ports, true);
    const next = packageAt(path.join(work.root, "next"), "0.165.0");
    work.ports.latest = async () => "0.165.0"; work.ports.install = async () => next; work.setNow(CHECK_INTERVAL_MS);
    await updateCodex(work.binary, work.ports);
    expect(installedTarget(work.binary)).toBe(next); expect(work.notices.at(-1)?.line).toBe("Codex CLI 0.165.0: updated");
  });
  test("a waiting next release preserves the last installed version's rollback target", async () => {
    const work = fixture(); await updateCodex(work.binary, work.ports);
    const next = packageAt(path.join(work.root, "next"), "0.165.0");
    work.ports.latest = async () => "0.165.0"; work.ports.install = async () => next; work.setNow(CHECK_INTERVAL_MS);
    work.ports.idle = async () => false; await updateCodex(work.binary, work.ports);
    expect(installedTarget(work.binary)).toBe(work.candidate);
    work.ports.idle = async () => true; await updateCodex(work.binary, work.ports, true);
    expect(installedTarget(work.binary)).toBe(work.old);
  });
  test("release demotion during the final await prevents the switch", async () => {
    const work = fixture(); let current = true; work.ports.current = () => current;
    work.ports.idle = async () => { current = false; return true; };
    await updateCodex(work.binary, work.ports);
    expect(installedTarget(work.binary)).toBe(work.old); expect(work.notices).toEqual([]);
  });
  test("rollback also waits for agents, and completes on the next scheduled pass", async () => {
    const work = fixture(); await updateCodex(work.binary, work.ports);
    work.ports.idle = async () => false; await updateCodex(work.binary, work.ports, true);
    expect(installedTarget(work.binary)).toBe(work.candidate);
    work.ports.idle = async () => true; await updateCodex(work.binary, work.ports);
    expect(installedTarget(work.binary)).toBe(work.old);
  });
  test("a failed seat report is retained for idempotent replay", async () => {
    const work = fixture(); work.ports.report = async () => { throw new Error("seat journal busy"); };
    await expect(updateCodex(work.binary, work.ports)).rejects.toThrow("seat report pending");
    expect(installedTarget(work.binary)).toBe(work.candidate);
    work.ports.report = async notice => { work.notices.push(notice); };
    await updateCodex(work.binary, work.ports);
    expect(work.notices.map(row => row.line)).toEqual(["Codex CLI 0.164.0: updated"]);
  });
  test("unknown regular executable is preserved and reported", async () => {
    const work = fixture(); fs.unlinkSync(work.binary); fs.writeFileSync(work.binary, "unknown install");
    await updateCodex(work.binary, work.ports);
    expect(fs.readFileSync(work.binary, "utf8")).toBe("unknown install");
    expect(work.notices[0]?.line).toContain("installed location failed");
  });
  test("corrupt durable state refuses instead of resetting the daily budget", async () => {
    const work = fixture(); fs.mkdirSync(updateDirectory(work.binary));
    fs.writeFileSync(path.join(updateDirectory(work.binary), "state.json"), "broken");
    await expect(updateCodex(work.binary, work.ports)).rejects.toThrow(); expect(work.calls).toEqual([]);
  });
  test("an unwritable install reports a skip and preserves bytes", async () => {
    const work = fixture(), original = fs.accessSync;
    const access = spyOn(fs, "accessSync").mockImplementation((file, mode) => {
      if (file === path.dirname(work.binary)) throw Object.assign(new Error("not writable"), { code: "EACCES" });
      return original(file, mode);
    });
    try { await updateCodex(work.binary, work.ports); }
    finally { access.mockRestore(); }
    expect(installedTarget(work.binary)).toBe(work.old); expect(work.notices[0]?.failed).toBeTrue();
  });
  test("disk exhaustion before the link rename keeps the installed CLI", async () => {
    const work = fixture(), original = fs.symlinkSync;
    const link = spyOn(fs, "symlinkSync").mockImplementation((target, file, type) => {
      if (String(file).endsWith("next-link")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return original(target, file, type);
    });
    try { await updateCodex(work.binary, work.ports); }
    finally { link.mockRestore(); }
    expect(installedTarget(work.binary)).toBe(work.old); expect(work.notices[0]?.line).toContain("idle switch failed");
  });
  test("a throw after committed rename recovers the outcome without switching twice", async () => {
    const work = fixture(), original = fs.renameSync;
    let switches = 0;
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      original(from, to);
      if (to === work.binary) { switches++; throw new Error("post-commit failure"); }
    });
    try { await expect(updateCodex(work.binary, work.ports)).rejects.toThrow("recovery"); }
    finally { rename.mockRestore(); }
    expect(installedTarget(work.binary)).toBe(work.candidate); expect(work.notices).toEqual([]);
    await updateCodex(work.binary, work.ports);
    expect(switches).toBe(1); expect(work.notices[0]?.line).toBe("Codex CLI 0.164.0: updated");
    await updateCodex(work.binary, work.ports, true); expect(installedTarget(work.binary)).toBe(work.old);
  });
  test("recovery retains the immediate predecessor before production pruning and rollback", async () => {
    const work = fixture(), versions = path.join(work.root, "versions"); fs.mkdirSync(versions);
    const original = packageAt(path.join(versions, "0.163.0"), "0.163.0");
    const first = packageAt(path.join(versions, "0.164.0"), "0.164.0");
    const second = packageAt(path.join(versions, "0.165.0"), "0.165.0");
    fs.unlinkSync(work.binary); fs.symlinkSync(original, work.binary);
    const ownedFile = path.join(versions, "owned.json"); fs.writeFileSync(ownedFile, JSON.stringify([path.join(versions, "0.163.0")]));
    const production = (await import("./production")).productionUpdatePorts({ bun: process.execPath, probeFile: "unused", scratch: path.join(work.root, "scratch"), versionsDirectory: versions, current: () => true, report: async () => {} });
    work.ports.prune = production.prune;
    work.ports.install = async version => {
      const target = version === "0.164.0" ? first : second, owned = JSON.parse(fs.readFileSync(ownedFile, "utf8")) as string[];
      if (!owned.includes(path.join(versions, version))) fs.writeFileSync(ownedFile, JSON.stringify([...owned, path.join(versions, version)]));
      return target;
    };
    await updateCodex(work.binary, work.ports);
    work.setNow(CHECK_INTERVAL_MS);
    work.ports.latest = async () => "0.165.0";
    const originalRename = fs.renameSync;
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      originalRename(from, to);
      if (to === work.binary && fs.realpathSync(work.binary) === second) throw new Error("committed rename then crash");
    });
    try { await expect(updateCodex(work.binary, work.ports)).rejects.toThrow("recovery"); }
    finally { rename.mockRestore(); }
    expect(fs.existsSync(path.join(versions, "0.164.0"))).toBeTrue();
    await updateCodex(work.binary, work.ports);
    expect(installedTarget(work.binary)).toBe(second);
    await updateCodex(work.binary, work.ports, true);
    expect(installedTarget(work.binary)).toBe(first);
  });
  test("launches and the idle switch use the same admission", async () => {
    const work = fixture(); let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const launch = withCodexCliLaunch(work.binary, async () => { entered(); await hold; });
    await ready;
    let switched = false;
    const update = withCliSwitch(work.binary, () => { switched = true; });
    expect(switched).toBeFalse(); release(); await launch; await update; expect(switched).toBeTrue();
  });
  test("a second process's launch blocks the switch until initialization ends", async () => {
    const work = fixture();
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "update.fixture.ts"), work.root, "hold-launch", "0"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const diagnostic = new Response(child.stderr).text();
    let pending: Promise<void> | undefined;
    try {
      const reader = child.stdout.getReader();
      const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toBe("ready\n"); reader.releaseLock();
      let idleChecks = 0; work.ports.idle = async () => { idleChecks++; return true; };
      pending = updateCodex(work.binary, work.ports);
      const queue = path.join(updateDirectory(work.binary), "switch.write-locks");
      const deadline = Date.now() + 5_000;
      while (fs.readdirSync(queue).length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      expect(fs.readdirSync(queue).length).toBeGreaterThanOrEqual(2);
      expect(idleChecks).toBe(0); expect(installedTarget(work.binary)).toBe(work.old);
      child.stdin.write("release"); child.stdin.end(); expect(await child.exited, await diagnostic).toBe(0);
      await pending; expect(installedTarget(work.binary)).toBe(work.candidate); expect(idleChecks).toBe(1);
    } finally {
      child.stdin.end(); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited;
      await pending;
    }
  });
  test("headless Codex waits for switch admission and promotion waits for the running process", async () => {
    const work = fixture(), started = path.join(work.root, "started"), release = path.join(work.root, "release");
    fs.writeFileSync(work.old, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv;fs.writeFileSync(${JSON.stringify(started)},'started');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);fs.writeFileSync(a[a.indexOf('--output-last-message')+1],'ready');\n`, { mode: 0o700 });
    const previousTransport = headlessFixtureTransport(); setHeadlessSpawnForTests(spawn);
    const launch = () => runHeadlessCodexOnce({ key: `headless-${path.basename(work.root)}`, cwd: path.join(work.root, "cwd"), prompt: "fixture", model: null, effort: null, account: null,
      artifactDir: path.join(work.root, "artifacts"), timeoutMs: 10_000, sandbox: "read-only", runtime: { command: work.binary } });
    let running!: Promise<Awaited<ReturnType<typeof launch>>>;
    try {
      await withCliSwitch(work.binary, async () => {
        running = launch();
        const queue = path.join(updateDirectory(work.binary), "switch.write-locks"), deadline = Date.now() + 5_000;
        while (fs.readdirSync(queue).length < 2 && Date.now() < deadline) await Bun.sleep(5);
        expect(fs.readdirSync(queue).length).toBeGreaterThanOrEqual(2);
        expect(fs.existsSync(started)).toBeFalse();
      });
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(started) && Date.now() < deadline) await Bun.sleep(5);
      expect(fs.existsSync(started)).toBeTrue();
      let idleChecks = 0; work.ports.idle = async () => { idleChecks++; return false; };
      await updateCodex(work.binary, work.ports);
      expect(installedTarget(work.binary)).toBe(work.old); expect(idleChecks).toBe(1);
      fs.writeFileSync(release, "go"); expect((await running).status).toBe("done");
      work.ports.idle = async () => true; await updateCodex(work.binary, work.ports);
      expect(installedTarget(work.binary)).toBe(work.candidate);
    } finally {
      fs.writeFileSync(release, "go"); setHeadlessSpawnForTests(previousTransport);
      if (running) await running;
    }
  });
  test("daily budget and pending candidate survive real process replacement", async () => {
    const work = fixture();
    const child = async (mode: string, now: number) => {
      const process = Bun.spawn([Bun.which("bun")!, path.join(import.meta.dir, "update.fixture.ts"), work.root, mode, String(now)], { stdout: "pipe", stderr: "pipe" });
      const [exit, output] = await Promise.all([process.exited, new Response(process.stderr).text()]); expect(exit, output).toBe(0);
    };
    await child("busy", 0); await child("idle", 1); await child("idle", CHECK_INTERVAL_MS - 1);
    expect(installedTarget(work.binary)).toBe(work.candidate);
    expect(fs.readFileSync(path.join(work.root, "calls"), "utf8").trim().split("\n")).toEqual(["latest", "install", "probe", "Codex CLI 0.164.0: updated"]);
    await child("rollback", CHECK_INTERVAL_MS); expect(installedTarget(work.binary)).toBe(work.old);
  });
  test("a new process rechecks a waiting candidate under its changed compatibility contract", async () => {
    const work = fixture();
    for (const mode of ["busy", "new-contract"]) {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "update.fixture.ts"), work.root, mode, "0"], { stdout: "pipe", stderr: "pipe" });
      const [exit, diagnostic] = await Promise.all([child.exited, new Response(child.stderr).text()]); expect(exit, diagnostic).toBe(0);
    }
    expect(fs.readFileSync(path.join(work.root, "calls"), "utf8").trim().split("\n")).toEqual(["latest", "install", "probe", "probe", "Codex CLI 0.164.0: updated"]);
    expect(installedTarget(work.binary)).toBe(work.candidate);
  });
});

test("semantic versions and seat event routing", () => {
  expect(newer("0.164.0", "0.99.0")).toBeTrue(); expect(newer("0.163.0", "0.164.0")).toBeFalse();
  expect(() => newer("latest", "0.164.0")).toThrow(); expect(isTerminalHighSignalEvent("codex_cli_updated")).toBeTrue();
  expect(isTerminalHighSignalEvent("codex_cli_update_failed")).toBeTrue();
});
test("process inventory includes native, wrappers and subagents; unknown inventory refuses", () => {
  for (const output of ["S codex codex app-server", "R node node /fixture/bin/codex.js app-server", "Sl codex-linux codex-linux exec"]) expect(codexProcessesPresent(output)).toBeTrue();
  expect(codexProcessesPresent("S bash bash -c echo codex\nR ps ps -A\nZ codex [codex] <defunct>")).toBeFalse();
  expect(() => codexProcessesPresent("")).toThrow();
  expect(() => codexProcessesPresent("unreadable")).toThrow();
});
test("the bounded command runner handles success and refusal without inherited credentials", async () => {
  expect(await runUpdateCommand(process.execPath, ["-e", "process.stdout.write('ok')"], { NODE_ENV: "test" }, 5000)).toBe("ok");
  await expect(runUpdateCommand(process.execPath, ["-e", "process.exit(23)"], { NODE_ENV: "test" }, 5000)).rejects.toThrow("exit 23");
  await expect(runUpdateCommand("/fixture/missing-command", [], { NODE_ENV: "test" }, 5000)).rejects.toThrow("could not start");
});
