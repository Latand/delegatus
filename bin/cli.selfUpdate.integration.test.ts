import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  ADMISSION_LOG, BROKEN_HOST, STUB_HOST, STUB_NEXT, WORK_STARTED, availablePort, children, cleanTerminalEnv, git, install, perimeterRemains, pointerFile,
  protectedInstall, readRecord, recordFile, registerSelfUpdateCleanup, release, request, roots, served, serviceShown, socketAnswers, start, stateText, until, version,
  type LauncherRecord,
} from "./__fixtures__/cli-self-update";

/*
 * #2007: the launcher's half of self-update, driven through the real
 * `bin/cli.mjs`. The install is a git checkout whose `next` and runtime host
 * are stubs committed into the repository, so every release worktree carries
 * them too: a stub answers with the directory it runs from, which is how the
 * test tells which release serves. Every child here is one the test started
 * (the CLI) or one the CLI started; the test signals only the CLI, by the
 * handle it spawned.
 */

registerSelfUpdateCleanup();

/** A launcher a fake service manager started detached belongs to no child
    handle of this test. The manager records the process it started: that is
    the bootstrap, which forwards a signal to the launcher it handed off to.
    Signalling only the recorded launcher makes the bootstrap start its own in
    its place, and that one outlives the file. Stop the bootstrap and wait for
    it, the recorded launcher and the children they supervise. */
async function stopManagedLauncher(pidFile: string, state: string): Promise<void> {
  const { isAlive, readStartIdentity } = await import("../src/lib/selfUpdate/pid");
  let pid: number;
  try { pid = Number(readFileSync(pidFile, "utf8")); } catch { return; }
  const identity = readStartIdentity(pid);
  let record: LauncherRecord | null = null;
  try { record = readRecord(state); } catch { /* the launcher never wrote one */ }
  const owned = [pid, record?.launcher.pid, record?.web.pid, record?.runtimeHost.pid].filter((entry): entry is number => !!entry);
  if (identity && isAlive(pid)) process.kill(pid, "SIGTERM");
  await until(() => owned.every(entry => !isAlive(entry)) || (identity !== null && isAlive(pid) && readStartIdentity(pid) !== identity), 10_000);
}
test("relaunch replaces launcher, web and host under the same supervisor PID", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  });
  const next = release(fixture, "whole-install");
  writeFileSync(before.releasePointer, JSON.stringify({ sha: next.sha, dir: next.dir, checkoutHead: fixture.first }));
  writeFileSync(before.requestFile, JSON.stringify({ requestId: "whole-install", role: "relaunch", target: next.sha }));
  const after = await until(() => {
    const record = readRecord(fixture.state);
    const launcher = record.launcher as typeof record.launcher & { requestId?: string; revision?: string; state?: string };
    return launcher.requestId === "whole-install" && launcher.state === "healthy" && launcher.revision === next.sha
      && record.web.state === "healthy" && record.web.revision === next.sha.slice(0, 7)
      && record.runtimeHost.state === "healthy" && record.runtimeHost.revision === next.sha.slice(0, 7) ? record : null;
  });
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(readlinkSync(`/proc/${after.launcher.pid}/cwd`)).toBe(next.dir);
  expect(after.web.pid).not.toBe(before.web.pid);
  expect(after.runtimeHost.pid).not.toBe(before.runtimeHost.pid);
  expect(after.web.revision).toBe(next.sha.slice(0, 7));
  expect(after.runtimeHost.revision).toBe(next.sha.slice(0, 7));
  expect(existsSync(`/proc/${before.web.pid}`)).toBe(false);
  expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(false);
  expect(await served(port)).toBe(next.dir);
  expect(child.exitCode).toBeNull();
}, 30_000);

test("a competing startup preserves the owner's in-flight relaunch trial", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  const next = release(fixture, "slow-trial");
  writeFileSync(path.join(next.dir, "node_modules", ".bin", "next"), "await Bun.sleep(4000);\n" + STUB_NEXT(false));
  const pointer = JSON.stringify({ ...next, checkoutHead: fixture.first });
  writeFileSync(before.releasePointer, pointer);
  writeFileSync(before.requestFile, JSON.stringify({ role: "relaunch", requestId: "owned-trial", target: next.sha, rollbackPointer: null }));
  const trialFile = before.requestFile.replace("request-", "trial-");
  await until(() => existsSync(trialFile) && readRecord(fixture.state).web.state === "starting");
  const intent = readFileSync(trialFile, "utf8");
  const competitor = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(await availablePort())], {
    cwd: fixture.checkout, env: fixture.env, stdio: "ignore",
  });
  children.add(competitor);
  await until(() => competitor.exitCode !== null);
  expect(competitor.exitCode).toBe(1);
  expect(existsSync(before.releasePointer)).toBe(true);
  expect(readFileSync(before.releasePointer, "utf8")).toBe(pointer);
  expect(readFileSync(trialFile, "utf8")).toBe(intent);
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.web.revision === next.sha.slice(0, 7)
      && !existsSync(trialFile) ? record : null;
  });
  expect(after.launcher.pid).toBe(child.pid!);
  expect(after.runtimeHost.revision).toBe(next.sha.slice(0, 7));
  expect(await served(port)).toBe(next.dir);
}, 30_000);

test("a trial persistence failure leaves the serving processes untouched", async () => {
  const fixture = install();
  const { child, port } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  const next = release(fixture, "unwritable-trial");
  writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
  mkdirSync(before.requestFile.replace("request-", "trial-"));
  writeFileSync(before.requestFile, JSON.stringify({ requestId: "unwritable-trial", role: "relaunch", target: next.sha, rollbackPointer: null }));
  await until(() => !existsSync(before.requestFile));
  await Bun.sleep(250);
  expect(existsSync(`/proc/${before.web.pid}`)).toBe(true);
  expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(true);
  expect(readRecord(fixture.state).launcher.pid).toBe(before.launcher.pid);
  expect(await served(port)).toBe(fixture.checkout);
  expect(child.exitCode).toBeNull();
}, 30_000);

for (const failure of ["web", "host", "launcher", "startup"] as const) {
  test(`relaunch rolls back ${failure} failure and restores the exact pointer`, async () => {
    const fixture = install();
    const old = release(fixture, "serving");
    const rawPointer = `${JSON.stringify({ ...old, checkoutHead: fixture.first }, null, 3)}\n`;
    mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
    writeFileSync(pointerFile(fixture), rawPointer);
    const { port, child } = await start(fixture);
    const before = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
    });
    const next = release(fixture, "broken-trial", {
      broken: failure === "web", brokenHost: failure === "host",
      ...(failure === "launcher" ? { launcher: 'throw new Error("fixture load failure");' } : {}),
    });
    // --version loads successfully; normal startup reaches this module later.
    if (failure === "startup") rmSync(path.join(next.dir, "bin", "oomPolicy.mjs"));
    writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
    writeFileSync(before.requestFile, JSON.stringify({ requestId: `rollback-${failure}`, role: "relaunch", target: next.sha, rollbackPointer: rawPointer }));
    const after = await until(() => {
      const record = readRecord(fixture.state);
      const launcher = record.launcher as typeof record.launcher & { requestId?: string; error?: { kind: string } };
      return launcher.requestId === `rollback-${failure}` && launcher.error?.kind === "fell-back"
        && record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
    });
    expect(readFileSync(before.releasePointer, "utf8")).toBe(rawPointer);
    expect(after.launcher.pid).toBe(before.launcher.pid);
    expect(after.web.revision).toBe(old.sha.slice(0, 7));
    expect(after.runtimeHost.revision).toBe(old.sha.slice(0, 7));
    expect(await served(port)).toBe(old.dir);
    if (failure === "launcher") {
      expect(after.web.pid).toBe(before.web.pid);
      expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
    }
    expect(child.exitCode).toBeNull();
  }, 40_000);
}

test("relaunch without a saved pointer rolls back to the release currently serving web", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  const serving = release(fixture, "web-already-updated");
  writeFileSync(before.releasePointer, JSON.stringify({ ...serving, checkoutHead: fixture.first }));
  request(before, "web", "web-before-relaunch");
  await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.web.revision === serving.sha.slice(0, 7);
  });
  const next = release(fixture, "failed-followup", { broken: true });
  writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
  writeFileSync(before.requestFile, JSON.stringify({ requestId: "followup-relaunch", role: "relaunch", target: next.sha }));
  const after = await until(() => {
    const record = readRecord(fixture.state);
    const launcher = record.launcher as typeof record.launcher & { requestId?: string; error?: { kind: string } };
    return launcher.requestId === "followup-relaunch" && launcher.error?.kind === "fell-back"
      && record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  });
  expect(existsSync(before.releasePointer)).toBe(true);
  expect(JSON.parse(readFileSync(before.releasePointer, "utf8"))).toEqual({ sha: serving.sha, dir: serving.dir });
  expect(after.web.revision).toBe(serving.sha.slice(0, 7));
  expect(after.runtimeHost.revision).toBe(serving.sha.slice(0, 7));
  expect(await served(port)).toBe(serving.dir);
  expect(child.exitCode).toBeNull();
}, 30_000);

test("rollback retains the cold-restart readiness budget for the previous release", async () => {
  const fixture = install();
  writeFileSync(path.join(fixture.checkout, "node_modules", ".bin", "next"),
    'if (process.env.LLV_LAUNCHER_TRIAL) await Bun.sleep(16000);\n' + STUB_NEXT(false));
  git(fixture.checkout, "add", "-f", ".");
  git(fixture.checkout, "commit", "-m", "cold rollback fixture");
  fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  const old = release(fixture, "cold-serving");
  const rawPointer = JSON.stringify({ ...old, checkoutHead: fixture.first });
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), rawPointer);
  const { child, port } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  const next = release(fixture, "cold-broken", { broken: true });
  writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
  writeFileSync(before.requestFile, JSON.stringify({ requestId: "cold-rollback", role: "relaunch", target: next.sha, rollbackPointer: rawPointer }));
  const after = await until(() => {
    const record = readRecord(fixture.state);
    const launcher = record.launcher as typeof record.launcher & { requestId?: string; error?: { kind: string } };
    return launcher.requestId === "cold-rollback" && launcher.error?.kind === "fell-back" && record.web.state === "healthy" ? record : null;
  }, 25_000);
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(after.web.revision).toBe(old.sha.slice(0, 7));
  expect(readFileSync(before.releasePointer, "utf8")).toBe(rawPointer);
  expect(await served(port)).toBe(old.dir);
  expect(child.exitCode).toBeNull();
}, 30_000);

for (const shape of ["socket", "manual-port", "manual-no-port", "manual-standalone", "foreign-port"] as const) for (const matchingIdentity of [true, false]) {
test(`a recovery Viewer takeover requires its start identity, shape=${shape}, matching=${matchingIdentity}`, async () => {
  const fixture = install();
  const port = await availablePort();
  const installId = createHash("sha256").update(path.resolve(fixture.checkout)).digest("hex").slice(0, 16);
  const socket = path.join(fixture.state, `runtime-host-${installId}.sock`);
  const orphanCwd = shape === "foreign-port" ? fixture.root : shape === "manual-standalone" ? path.join(fixture.checkout, "dist", "standalone") : fixture.checkout;
  mkdirSync(orphanCwd, { recursive: true });
  const orphan = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "node_modules", ".bin", "next"), "--port", String(port)], {
    cwd: orphanCwd,
    env: { ...fixture.env, PORT: ["manual-no-port", "manual-standalone"].includes(shape) ? undefined : String(port), ...(shape === "socket" ? { LLV_RUNTIME_HOST_SOCKET: socket } : { LLV_STATE_OWNER: "viewer" }) }, stdio: "ignore",
  });
  children.add(orphan);
  await until(() => orphan.pid && existsSync(`/proc/${orphan.pid}/stat`));
  await Bun.sleep(200);
  expect(await served(port)).toBe(orphanCwd);
  const stat = readFileSync(`/proc/${orphan.pid}/stat`, "utf8");
  const startIdentity = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const base = path.join(fixture.state, "self-update");
  mkdirSync(base, { recursive: true });
  writeFileSync(path.join(base, `adopt-${installId}.json`), JSON.stringify({ pid: orphan.pid, startIdentity: matchingIdentity ? startIdentity : "0", port, socket, installRoot: fixture.checkout }));
  const child = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(port)], {
    cwd: fixture.checkout, env: fixture.env, stdio: "ignore",
  });
  children.add(child);
  if (!matchingIdentity || shape === "foreign-port") {
    await until(() => child.exitCode !== null);
    expect(child.exitCode).toBe(1);
    expect(orphan.exitCode).toBeNull();
    expect(await served(port)).toBe(orphanCwd);
    return;
  }
  const record = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  });
  expect(record.web.pid).not.toBe(orphan.pid);
  expect(orphan.signalCode).toBeNull();
  expect(orphan.exitCode).toBe(0);
  expect(await served(port)).toBe(fixture.checkout);
}, 30_000);
}

test("recovery takeover retires its recorded Viewer after the listener closes during shutdown", async () => {
  const fixture = install();
  const port = await availablePort();
  const socket = path.join(fixture.state, "runtime-host-fixture.sock");
  const entry = path.join(fixture.checkout, "node_modules", ".bin", "next");
  writeFileSync(entry, STUB_NEXT(false).replace("server.stop(true); process.exit(0);", "server.stop(true); setInterval(() => {}, 1_000);"));
  const orphan = spawn(process.execPath, ["--bun", entry], {
    cwd: fixture.checkout, env: { ...fixture.env, PORT: String(port), LLV_RUNTIME_HOST_SOCKET: socket }, stdio: "ignore",
  });
  children.add(orphan);
  await Bun.sleep(200);
  expect(await served(port)).toBe(fixture.checkout);
  const pid = orphan.pid!;
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const adopt = path.join(fixture.state, "adopt.json");
  writeFileSync(adopt, JSON.stringify({ pid, startIdentity: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19], port, socket }));
  const { ensureWebPortFree } = await import("./launcher-adoption.mjs");
  expect(await ensureWebPortFree({ adopt }, port, socket)).toBe(true);
  await Bun.sleep(100);
  expect(existsSync(`/proc/${pid}/stat`)).toBe(false);
}, 20_000);

test("overlapping starts retain one launcher while recovery adoption waits", async () => {
  const fixture = install();
  const port = await availablePort();
  const installId = createHash("sha256").update(path.resolve(fixture.checkout)).digest("hex").slice(0, 16);
  const socket = path.join(fixture.state, `runtime-host-${installId}.sock`);
  const stopping = path.join(fixture.root, "orphan-stopping");
  const orphanEntry = path.join(fixture.root, "orphan.mjs");
  writeFileSync(orphanEntry, 'import { writeFileSync } from "node:fs";\n' + STUB_NEXT(false).replace(
    'const stop = () => { server.stop(true); process.exit(0); };',
    `const stop = () => { writeFileSync(${JSON.stringify(stopping)}, "stopping"); setTimeout(() => { server.stop(true); process.exit(0); }, 1500); };`));
  const orphan = spawn(process.execPath, ["--bun", orphanEntry], {
    cwd: fixture.checkout, env: { ...fixture.env, PORT: String(port), LLV_RUNTIME_HOST_SOCKET: socket }, stdio: "ignore",
  });
  children.add(orphan);
  await Bun.sleep(200);
  expect(await served(port)).toBe(fixture.checkout);
  const stat = readFileSync(`/proc/${orphan.pid}/stat`, "utf8");
  const startIdentity = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const base = path.join(fixture.state, "self-update");
  mkdirSync(base, { recursive: true });
  writeFileSync(path.join(base, `adopt-${installId}.json`), JSON.stringify({ pid: orphan.pid, startIdentity, port, socket }));
  const launch = (onPort: number) => {
    const child = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(onPort)], {
      cwd: fixture.checkout, env: fixture.env, stdio: "ignore",
    });
    children.add(child);
    return child;
  };
  const first = launch(port);
  await until(() => existsSync(stopping));
  const second = launch(await availablePort());
  await until(() => second.exitCode !== null);
  expect(second.exitCode).toBe(1);
  const record = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  });
  expect(record.launcher.pid).toBe(first.pid!);
  expect(first.exitCode).toBeNull();
  expect(await served(port)).toBe(fixture.checkout);
}, 30_000);

test("one service restart runs the installed launcher and its admission-capable supervisor while checkout HEAD stays old", async () => {
  const fixture = install({ oldSupervisor: true });
  const initial = await start(fixture);
  const oldRecord = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  });
  expect(oldRecord.launcher.autoAdmission).toBeUndefined();
  initial.child.kill("SIGTERM");
  await new Promise<void>((resolve) => initial.child.once("exit", () => resolve()));

  const next = release(fixture, "admission-launcher", { upgradeSupervisor: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: next.sha, dir: next.dir, checkoutHead: fixture.first }));
  const restarted = await start(fixture);
  const record = await until(() => {
    const current = readRecord(fixture.state);
    return current.web.state === "healthy" && current.runtimeHost.state === "healthy" ? current : null;
  });
  expect(record.launcher.autoAdmission).toBe(1);
  expect(record.launcher.pid).not.toBe(restarted.child.pid);
  expect(record.checkout).toBe(fixture.checkout);
  expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(fixture.first);
  expect(await served(restarted.port)).toBe(next.dir);

  request(record, "web", "after-launcher-handoff");
  const afterRequest = await until(() => {
    const current = readRecord(fixture.state);
    return current.web.requestId === "after-launcher-handoff" && current.web.state === "healthy" ? current : null;
  });
  expect(afterRequest.web.revision).toBe(next.sha.slice(0, 7));
  expect(afterRequest.runtimeHost.pid).toBe(record.runtimeHost.pid);
  /* systemd's control-group kill reaches both processes; the bootstrap also
     forwards its signal, so the launcher may see SIGTERM twice. */
  process.kill(record.launcher.pid, "SIGTERM");
  restarted.child.kill("SIGTERM");
  await new Promise<void>((resolve) => restarted.child.once("exit", () => resolve()));
  expect(restarted.child.exitCode).toBe(0);
  expect(existsSync(`/proc/${record.web.pid}`)).toBe(false);
  expect(existsSync(`/proc/${record.runtimeHost.pid}`)).toBe(false);
  expect(readdirSync(path.join(fixture.state, "self-update")).some((name) => name.startsWith("launcher-"))).toBe(false);
}, 60_000);

test("release handoff forwards argv, environment and signals, and the marker prevents another handoff", async () => {
  const fixture = install();
  const probeFile = path.join(fixture.root, "probe.json");
  const signalFile = path.join(fixture.root, "signal.txt");
  const probe = `// delegatus-checkout-launcher-v2\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.LLV_TEST_PROBE_FILE, JSON.stringify({ argv: process.argv.slice(2), marker: process.env.LLV_LAUNCHER_REEXEC, checkout: process.env.LLV_LAUNCHER_CHECKOUT, value: process.env.LLV_TEST_VALUE, cwd: process.cwd() }));\nprocess.on("SIGTERM", () => { writeFileSync(process.env.LLV_TEST_SIGNAL_FILE, "SIGTERM"); process.exit(0); });\nsetInterval(() => {}, 1000);\n`;
  const next = release(fixture, "probe-launcher", { launcher: probe });
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: next.sha, dir: next.dir, checkoutHead: fixture.first }));

  const marked = version(fixture, { LLV_LAUNCHER_REEXEC: "1" });
  expect(marked.status).toBe(0);
  expect(marked.stdout.trim()).toBe("0.0.0");
  expect(existsSync(probeFile)).toBe(false);

  const child = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", "47123"], {
    cwd: fixture.checkout,
    env: { ...fixture.env, LLV_TEST_PROBE_FILE: probeFile, LLV_TEST_SIGNAL_FILE: signalFile, LLV_TEST_VALUE: "forwarded" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const observed = await until(() => existsSync(probeFile) ? JSON.parse(readFileSync(probeFile, "utf8")) : null);
  expect(observed).toEqual({ argv: ["--no-open", "--port", "47123"], marker: "1", checkout: fixture.checkout, value: "forwarded", cwd: fixture.checkout });
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  expect(readFileSync(signalFile, "utf8")).toBe("SIGTERM");
  expect(child.exitCode).toBe(0);
}, 30_000);

test("missing and invalid release pointers use the checkout launcher", () => {
  const fixture = install();
  expect(version(fixture)).toMatchObject({ status: 0, stdout: "0.0.0\n" });
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: "a".repeat(40), dir: path.join(fixture.root, "missing"), checkoutHead: fixture.first }));
  expect(version(fixture)).toMatchObject({ status: 0, stdout: "0.0.0\n" });
});

test("an older handoff protocol keeps the checkout supervisor as fallback", () => {
  const fixture = install();
  const legacy = release(fixture, "legacy-launcher", { launcher: "// delegatus-checkout-launcher-v1\nprocess.stdout.write('legacy\\n');\n" });
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: legacy.sha, dir: legacy.dir, checkoutHead: fixture.first }));
  expect(version(fixture)).toMatchObject({ status: 0, stdout: "0.0.0\n" });
});

test("the one-time file checkout links against an older checkout and retains its own launcher fallback", async () => {
  const fixture = install({ oldSupervisor: true, oldServerRuntime: true });
  const checkoutCli = path.join(fixture.checkout, "bin", "cli.mjs");
  writeFileSync(checkoutCli, "import './server-runtime.mjs';\nprocess.stdout.write('old launcher\\n');\n");
  git(fixture.checkout, "add", "bin/cli.mjs");
  git(fixture.checkout, "commit", "--amend", "--quiet", "--no-edit");
  fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  const next = release(fixture, "bootstrap-release", {
    launcher: readFileSync(path.resolve("bin", "cli.mjs"), "utf8"),
    upgradeSupervisor: true,
    upgradeServerRuntime: true,
  });
  writeFileSync(path.join(fixture.checkout, "bin", "cli-checkout.mjs"), git(fixture.checkout, "show", "HEAD:bin/cli.mjs") + "\n");
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: next.sha, dir: next.dir, checkoutHead: fixture.first }));
  expect(version(fixture).stdout.trim()).toBe("old launcher");

  git(fixture.checkout, "checkout", next.sha, "--", "bin/cli.mjs");
  expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(fixture.first);
  expect(version(fixture, { LLV_LAUNCHER_REEXEC: "1" }).stdout.trim()).toBe("old launcher");
  expect(version(fixture).stdout.trim()).toBe("0.0.0");
  rmSync(pointerFile(fixture));
  expect(version(fixture).stdout.trim()).toBe("old launcher");
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: next.sha, dir: next.dir, checkoutHead: fixture.first }));
  const running = await start(fixture);
  const record = await until(() => {
    const current = readRecord(fixture.state);
    return current.web.state === "healthy" && current.runtimeHost.state === "healthy" ? current : null;
  });
  expect(record.launcher.autoAdmission).toBe(1);
  expect(record.checkout).toBe(fixture.checkout);
  expect(await served(running.port)).toBe(next.dir);
}, 60_000);

test("a hand-moved checkout runs its current launcher instead of the saved old one", () => {
  const fixture = install();
  const checkoutCli = path.join(fixture.checkout, "bin", "cli.mjs");
  writeFileSync(checkoutCli, "process.stdout.write('old launcher\\n');\n");
  git(fixture.checkout, "add", "bin/cli.mjs");
  git(fixture.checkout, "commit", "--amend", "--quiet", "--no-edit");
  fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  const next = release(fixture, "current-launcher", { launcher: readFileSync(path.resolve("bin", "cli.mjs"), "utf8") });
  writeFileSync(path.join(fixture.checkout, "bin", "cli-checkout.mjs"), git(fixture.checkout, "show", "HEAD:bin/cli.mjs") + "\n");
  git(fixture.checkout, "checkout", next.sha, "--", "bin/cli.mjs");
  expect(version(fixture).stdout.trim()).toBe("old launcher");

  git(fixture.checkout, "checkout", "--quiet", "--force", "--detach", next.sha);
  expect(version(fixture)).toMatchObject({ status: 0, stdout: "0.0.0\n" });
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: next.sha, dir: next.dir, checkoutHead: fixture.first }));
  expect(version(fixture)).toMatchObject({ status: 0, stdout: "0.0.0\n" });
});

test.each([0, 1])("a release launcher exiting %i before recording itself falls back to a healthy checkout launcher", async (exitCode) => {
  const fixture = install();
  const broken = release(fixture, "broken-launcher", { launcher: `// delegatus-checkout-launcher-v2\nprocess.exit(${exitCode});\n` });
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: broken.sha, dir: broken.dir, checkoutHead: fixture.first }));
  const running = await start(fixture);
  const record = await until(() => {
    const current = readRecord(fixture.state);
    return current.web.state === "healthy" && current.runtimeHost.state === "healthy" ? current : null;
  });
  expect(running.output()).toContain("installed launcher could not start");
  expect(record.launcher.pid).toBe(running.child.pid as number);
  expect(await served(running.port)).toBe(broken.dir);
  expect(await socketAnswers(record.socket)).toBe(true);
}, 60_000);

test("a one-shot team command keeps the release launcher's exit result", () => {
  const fixture = install();
  const broken = release(fixture, "team-command", { launcher: "// delegatus-checkout-launcher-v2\nprocess.exit(1);\n" });
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ sha: broken.sha, dir: broken.dir, checkoutHead: fixture.first }));
  const result = spawnSync(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "team", "status"], {
    cwd: fixture.checkout, env: fixture.env, encoding: "utf8", timeout: 5_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain("using the checkout launcher");
});

test("saved checkout launcher handles a group signal once and finishes shutdown", async () => {
  const fixture = install();
  const started = path.join(fixture.root, "backup-started");
  const stopped = path.join(fixture.root, "backup-stopped");
  const checkoutCli = path.join(fixture.checkout, "bin", "cli.mjs");
  const savedLauncher = `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, "started");
process.once("SIGTERM", () => setTimeout(() => {
  writeFileSync(${JSON.stringify(stopped)}, "stopped");
  process.exit(0);
}, 200));
setInterval(() => {}, 1000);
`;
  writeFileSync(checkoutCli, savedLauncher);
  git(fixture.checkout, "add", "bin/cli.mjs");
  git(fixture.checkout, "commit", "--amend", "--quiet", "--no-edit");
  writeFileSync(path.join(fixture.checkout, "bin", "cli-checkout.mjs"), savedLauncher);
  copyFileSync(path.resolve("bin", "cli.mjs"), checkoutCli);
  const child = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs")], {
    cwd: fixture.checkout, env: fixture.env, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  await until(() => existsSync(started));
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  expect(child.exitCode).toBe(0);
  expect(readFileSync(stopped, "utf8")).toBe("stopped");
}, 10_000);

test("a checkout records both children, and a restart request moves each one onto the published release", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null; });
  expect(before.checkout).toBe(fixture.checkout);
  expect(before.web.revision).toBe(fixture.first.slice(0, 7));
  expect(await served(port)).toBe(fixture.checkout);

  const next = release(fixture, "second");
  writeFileSync(before.releasePointer, JSON.stringify({ sha: next.sha, dir: next.dir, checkoutHead: fixture.first }));

  request(before, "web", "restart-web-1");
  const afterWeb = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-web-1" && record.web.state === "healthy" && record.web.pid !== before.web.pid ? record : null;
  });
  expect(afterWeb.web.revision).toBe(next.sha.slice(0, 7));
  expect(afterWeb.web.error).toBeNull();
  expect(await served(port)).toBe(next.dir);
  /* The old web process is gone; the CLI and the host carried on. */
  expect(existsSync(`/proc/${before.web.pid}`)).toBe(false);
  expect(child.exitCode).toBeNull();
  expect(afterWeb.runtimeHost.pid).toBe(before.runtimeHost.pid);

  request(afterWeb, "runtime-host", "restart-host-1");
  const afterHost = await until(() => {
    const record = readRecord(fixture.state);
    return record.runtimeHost.requestId === "restart-host-1" && record.runtimeHost.state === "healthy" && record.runtimeHost.pid !== before.runtimeHost.pid ? record : null;
  });
  expect(afterHost.runtimeHost.revision).toBe(next.sha.slice(0, 7));
  expect(readlinkSync(`/proc/${afterHost.runtimeHost.pid}/cwd`)).toBe(next.dir);
  expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(false);
  expect(afterHost.web.pid).toBe(afterWeb.web.pid);

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  /* A clean stop takes the record with it: nothing names a gone launcher. */
  expect(readdirSync(path.join(fixture.state, "self-update")).some((name) => name.startsWith("launcher-"))).toBe(false);
}, 60_000);

/* Where the key the Viewer gates on comes from. The first three reach it
   through the launcher's environment; the last three are a key the Viewer
   picks for itself from the key file, which the launcher never handed it. */
const KEY_SOURCES = ["LLV_TOKEN", "DELEGATUS_TOKEN", "generated", "links-grants", "links-public-address", "phone-access-after-start"] as const;

for (const tokenSource of KEY_SOURCES) {
  for (const { broken, automatic } of [
    { broken: false, automatic: false },
    { broken: true, automatic: false },
    { broken: false, automatic: true },
  ]) {
    test(`token-protected web restart uses ${tokenSource}, fallback=${broken}, automatic=${automatic}`, async () => {
      const fixture = install({ tokenProtected: true });
      const env = fixture.env as Record<string, string | undefined>;
      delete env.LLV_TOKEN;
      delete env.DELEGATUS_TOKEN;
      const fromEnvironment = tokenSource === "LLV_TOKEN" || tokenSource === "DELEGATUS_TOKEN";
      const fromKeyFile = !fromEnvironment && tokenSource !== "generated";
      const token = fromKeyFile ? randomBytes(16).toString("hex") : "fixture-update-access";
      const config = path.join(env.XDG_CONFIG_HOME as string, "delegatus");
      if (fromEnvironment) env[tokenSource] = token;
      if (fromKeyFile) {
        mkdirSync(path.join(fixture.state, "links"), { recursive: true });
        mkdirSync(config, { recursive: true });
        writeFileSync(path.join(config, "token"), `${token}\n`, { mode: 0o600 });
      }
      if (tokenSource === "links-grants") writeFileSync(path.join(fixture.state, "links", "grants.json"), "{}\n");
      if (tokenSource === "links-public-address") {
        writeFileSync(path.join(fixture.state, "links", "self.json"), JSON.stringify({ publicUrl: "https://board.example.test" }));
      }
      const running = await start(fixture, tokenSource === "generated" ? ["--hostname", "0.0.0.0"] : []);
      const before = await until(() => {
        const record = readRecord(fixture.state);
        return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
      });
      const url = `http://127.0.0.1:${running.port}/`;
      if (tokenSource === "phone-access-after-start") {
        /* The phone-access button: the gate comes on in a Viewer whose
           launcher started before the choice was made. */
        expect((await fetch(url)).status).toBe(200);
        writeFileSync(path.join(config, "phone-access"), "tailscale\n");
      }
      expect((await fetch(url)).status).toBe(401);
      const next = release(fixture, "token-update", { broken });
      writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
      if (automatic) {
        writeFileSync(path.join(fixture.state, "self-update", "auto-admission.json"), JSON.stringify({
          id: "token-update-gate", until: Date.now() + 30_000,
        }));
        writeFileSync(before.requestFile, JSON.stringify({
          requestId: "restart-token-protected-web", role: "web", autoGateId: "token-update-gate",
        }));
      } else request(before, "web", "restart-token-protected-web");
      const after = await until(() => {
        const record = readRecord(fixture.state);
        return record.web.requestId === "restart-token-protected-web"
          && record.web.pid !== before.web.pid && ["healthy", "failed"].includes(record.web.state) ? record : null;
      });
      expect(after.web.state).toBe("healthy");
      expect(after.web.revision).toBe((broken ? fixture.first : next.sha).slice(0, 7));
      if (broken) expect(after.web.error).toMatchObject({ kind: "fell-back", revision: next.sha.slice(0, 7) });
      else expect(after.web.error).toBeNull();
      expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
      expect(await socketAnswers(before.socket)).toBe(true);
      expect(running.child.exitCode).toBeNull();
      expect((await fetch(url)).status).toBe(401);
      if (tokenSource !== "generated") {
        const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(broken ? fixture.checkout : next.dir);
      }
      if (fromKeyFile) {
        expect(stateText(fixture.state)).not.toContain(token);
        expect(running.output()).not.toContain(token);
      }
    }, 60_000);
  }
}

/* A key no header can carry: the probe goes out without it and is refused.
   The process that refused it is up and gating, so the restart ends with the
   release that served before still serving, never with no web. */
for (const invalidCharacter of ["\n", "\r", "\u0100", "\u0436", "\u00e9"] as const) {
  test(`a key the probe cannot send keeps the previous release serving and stays out of diagnostics (${JSON.stringify(invalidCharacter)})`, async () => {
    const fixture = install({ tokenProtected: true });
    const token = `fixture-prefix${invalidCharacter}fixture-suffix`;
    fixture.env.LLV_TOKEN = token;
    /* The dialog shows this record's text as written, so the launcher writes
       it in the operator's language. */
    const language = invalidCharacter === "\u0436" ? "uk" : "en";
    (fixture.env as Record<string, string | undefined>).LLV_LANG = language;
    const running = await start(fixture);
    const before = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
    });
    const url = `http://127.0.0.1:${running.port}/`;
    expect((await fetch(url)).status).toBe(401);
    const next = release(fixture, "malformed-token-update");
    writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
    request(before, "web", "restart-malformed-token");

    const after = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.requestId === "restart-malformed-token" && record.web.pid !== before.web.pid && ["healthy", "failed"].includes(record.web.state) ? record : null;
    });
    expect(after.web.state).toBe("healthy");
    expect(after.web.revision).toBe(fixture.first.slice(0, 7));
    expect(after.web.error).toMatchObject({ kind: "fell-back", revision: next.sha.slice(0, 7) });
    expect(after.web.error?.detail).toContain("GET / answered 401");
    expect(after.web.pid).not.toBe(before.web.pid);
    expect(existsSync(`/proc/${after.web.pid}`)).toBe(true);
    /* Still up and still gating. */
    expect((await fetch(url)).status).toBe(401);
    expect(stateText(fixture.state)).not.toContain(token);
    expect(running.output()).not.toContain(token);
    expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
    expect(await socketAnswers(before.socket)).toBe(true);
    expect(running.child.exitCode).toBeNull();

    /* With nothing new published the restarted release is the one that was
       serving, so a refusal keeps it without a second start. */
    writeFileSync(before.releasePointer, JSON.stringify({ sha: fixture.first, dir: fixture.checkout, checkoutHead: fixture.first }));
    request(after, "web", "restart-malformed-token-again");
    const again = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.requestId === "restart-malformed-token-again" && record.web.pid !== after.web.pid && ["healthy", "failed"].includes(record.web.state) ? record : null;
    });
    expect(again.web.state).toBe("healthy");
    expect(again.web.error?.kind).toBe("message");
    expect(again.web.error?.text).toBe(language === "uk"
      ? "перевірка готовності не пройшла автентифікацію (GET / answered 401), тому лишився реліз, що працював до перезапуску"
      : "the readiness probe could not authenticate (GET / answered 401), so the release serving before the restart was kept");
    expect((await fetch(url)).status).toBe(401);
    expect(stateText(fixture.state)).not.toContain(token);
    expect(running.output()).not.toContain(token);
  }, 60_000);
}

test("a key with a tab inside is sent, and the restart moves onto the new release", async () => {
  const fixture = install({ tokenProtected: true });
  const token = "fixture-prefix\tfixture-suffix";
  fixture.env.LLV_TOKEN = token;
  const running = await start(fixture);
  const before = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  });
  const next = release(fixture, "tab-token-update");
  writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
  request(before, "web", "restart-tab-token");
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-tab-token" && record.web.pid !== before.web.pid && ["healthy", "failed"].includes(record.web.state) ? record : null;
  });
  expect(after.web.state).toBe("healthy");
  expect(after.web.error).toBeNull();
  expect(after.web.revision).toBe(next.sha.slice(0, 7));
  expect((await fetch(`http://127.0.0.1:${running.port}/`)).status).toBe(401);
  expect(stateText(fixture.state)).not.toContain(token);
  expect(running.output()).not.toContain(token);
}, 60_000);

test("a release whose web does not start gives way to the one it replaced, and says so", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  const broken = release(fixture, "broken", { broken: true });
  writeFileSync(before.releasePointer, JSON.stringify({ sha: broken.sha, dir: broken.dir, checkoutHead: fixture.first }));

  request(before, "web", "restart-web-broken");
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-web-broken" && record.web.state === "healthy" && record.web.error ? record : null;
  });
  expect(after.web.error).toMatchObject({ kind: "fell-back", revision: broken.sha.slice(0, 7) });
  expect(after.web.revision).toBe(fixture.first.slice(0, 7));
  expect(await served(port)).toBe(fixture.checkout);
  expect(child.exitCode).toBeNull();
}, 60_000);

test("a web restart whose new and previous releases both fail leaves the web failed and the runtime host serving", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null; });
  expect(await socketAnswers(before.socket)).toBe(true);
  const broken = release(fixture, "broken-web", { broken: true });
  const healthy = release(fixture, "healthy-web");
  writeFileSync(before.releasePointer, JSON.stringify({ sha: broken.sha, dir: broken.dir, checkoutHead: fixture.first }));
  /* The package root's own web fails too, so the fallback does not come up either. */
  const rootNext = path.join(fixture.checkout, "node_modules", ".bin", "next");
  writeFileSync(rootNext, STUB_NEXT(true));

  request(before, "web", "restart-web-both-broken");
  const failed = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-web-both-broken" && record.web.state === "failed" ? record : null;
  });
  expect(failed.web.error?.kind).toBe("message");
  expect(existsSync(`/proc/${before.web.pid}`)).toBe(false);
  /* The launcher, the host process and its endpoint carried on, and stay up. */
  await Bun.sleep(1_500);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  const stillFailed = readRecord(fixture.state);
  expect(stillFailed.web.state).toBe("failed");
  expect(stillFailed.runtimeHost).toMatchObject({ state: "healthy", pid: before.runtimeHost.pid });
  expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(true);
  expect(await socketAnswers(before.socket)).toBe(true);

  /* The next explicit web restart is still taken, and moves only the web. */
  writeFileSync(before.releasePointer, JSON.stringify({ sha: healthy.sha, dir: healthy.dir, checkoutHead: fixture.first }));
  request(stillFailed, "web", "restart-web-recovered");
  const recovered = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-web-recovered" && record.web.state === "healthy" ? record : null;
  });
  expect(recovered.web.error).toBeNull();
  expect(recovered.web.revision).toBe(healthy.sha.slice(0, 7));
  expect(await served(port)).toBe(healthy.dir);
  expect(recovered.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(await socketAnswers(before.socket)).toBe(true);
  expect(child.exitCode).toBeNull();
}, 60_000);

test("the serving web is recovered with backoff after an unexpected exit", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  // Signal exactly the child recorded by this test's own launcher.
  process.kill(before.web.pid!, "SIGTERM");
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.web.pid !== before.web.pid ? record : null;
  });
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(await served(port)).toBe(fixture.checkout);
  expect(child.exitCode).toBeNull();
}, 30_000);

for (const intervening of ["none", "runtime-host", "relaunch"] as const) {
test(`a foreign port owner is left alone and recovery survives ${intervening}`, async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  process.kill(before.web.pid!, "SIGTERM");
  await until(() => !existsSync(`/proc/${before.web.pid}`));
  const foreign = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("foreign") });
  try {
    request(before, "web", "foreign-port");
    const refused = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.requestId === "foreign-port" && record.web.error?.kind === "port-in-use" ? record : null;
    });
    expect(refused.runtimeHost.pid).toBe(before.runtimeHost.pid);
    expect(await served(port)).toBe("foreign");
    expect(child.exitCode).toBeNull();
    if (intervening === "runtime-host") {
      request(before, "runtime-host", "intervening-host");
      await until(() => {
        const record = readRecord(fixture.state);
        return record.runtimeHost.requestId === "intervening-host" && record.runtimeHost.state === "healthy";
      });
    }
    if (intervening === "relaunch") {
      const next = release(fixture, "failed-preflight", { launcher: 'throw new Error("fixture preflight failure");' });
      writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
      writeFileSync(before.requestFile, JSON.stringify({ role: "relaunch", requestId: "intervening-relaunch", target: next.sha }));
      await until(() => {
        const record = readRecord(fixture.state);
        const launcher = record.launcher as typeof record.launcher & { requestId?: string; error?: { kind: string } };
        return launcher.requestId === "intervening-relaunch" && launcher.error?.kind === "fell-back";
      });
    }
  } finally { foreign.stop(true); }
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.web.pid !== before.web.pid ? record : null;
  });
  if (intervening !== "runtime-host") expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(await served(port)).toBe(fixture.checkout);
}, 30_000);
}

for (const source of ["argument", "environment"] as const) {
test(`web recovery consumes operator rotation once from ${source}`, async () => {
  const fixture = install();
  const log = path.join(fixture.root, "rotation-log");
  writeFileSync(path.join(fixture.checkout, "node_modules", ".bin", "next"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, String(process.env.LLV_ROTATE_OPERATOR_SPAWN_CAPABILITY) + "\\n");\n` + STUB_NEXT(false));
  const env = source === "environment" ? { ...fixture.env, LLV_ROTATE_OPERATOR_SPAWN_CAPABILITY: "1" } : fixture.env;
  const { port } = await start({ ...fixture, env }, source === "argument" ? ["--new-operator-token"] : []);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  process.kill(before.web.pid!, "SIGTERM");
  await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" && record.web.pid !== before.web.pid ? record : null; });
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["1", "undefined"]);
  expect(await served(port)).toBe(fixture.checkout);
}, 30_000);
}

test("a second launcher preserves the live launcher's record and children", async () => {
  const fixture = install();
  const first = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  const second = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(await availablePort())], {
    cwd: fixture.checkout, env: fixture.env, stdio: "ignore",
  });
  children.add(second);
  await until(() => second.exitCode !== null);
  expect(second.exitCode).toBe(1);
  const after = readRecord(fixture.state);
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(after.web.pid).toBe(before.web.pid);
  expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(await served(first.port)).toBe(fixture.checkout);
}, 30_000);

test("a host restart whose new and previous releases both fail is retried by the backoff, never left down", async () => {
  const fixture = install();
  const { child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.runtimeHost.state === "healthy" ? record : null; });
  const broken = release(fixture, "broken-host", { brokenHost: true });
  writeFileSync(before.releasePointer, JSON.stringify({ sha: broken.sha, dir: broken.dir, checkoutHead: fixture.first }));
  /* The package root's own host fails too, for as long as the restart takes. */
  const rootHost = path.join(fixture.checkout, "dist", "runtime-host.mjs");
  writeFileSync(rootHost, BROKEN_HOST);

  request(before, "runtime-host", "restart-host-both-broken");
  const failed = await until(() => {
    const record = readRecord(fixture.state);
    return record.runtimeHost.requestId === "restart-host-both-broken" && record.runtimeHost.state === "failed"
      && record.runtimeHost.error?.kind === "message" ? record : null;
  });
  /* The restart's own summary: both releases were tried. */
  expect(failed.runtimeHost.error?.kind).toBe("message");
  expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(false);

  /* A backoff attempt that fails before readiness is recorded as failed with
     its own exit, never left reading "starting" under a PID that is gone. */
  const retried = await until(() => {
    const record = readRecord(fixture.state);
    return record.runtimeHost.pid !== failed.runtimeHost.pid && record.runtimeHost.state === "failed" ? record : null;
  }, 15_000);
  expect(retried.runtimeHost.error).toMatchObject({ kind: "exit", code: 3 });
  expect(existsSync(`/proc/${retried.runtimeHost.pid}`)).toBe(false);

  /* The previous release can start again: the backoff finds it without anyone asking. */
  writeFileSync(rootHost, STUB_HOST);
  const back = await until(() => {
    const record = readRecord(fixture.state);
    return record.runtimeHost.state === "healthy" && record.runtimeHost.pid !== before.runtimeHost.pid ? record : null;
  }, 30_000);
  expect(back.runtimeHost.revision).toBe(fixture.first.slice(0, 7));
  expect(readlinkSync(`/proc/${back.runtimeHost.pid}/cwd`)).toBe(fixture.checkout);
  expect(child.exitCode).toBeNull();
}, 60_000);

for (const broken of [false, true]) {
  test(`a packaged install relaunches all processes and rolls back=${broken}`, async () => {
    const fixture = install();
    const next = release(fixture, "npm-package", { broken });
    writeFileSync(path.join(next.dir, "package.json"), JSON.stringify({ name: "delegatus-cli", version: "0.0.1" }));
    mkdirSync(path.join(next.dir, "dist", "standalone"), { recursive: true });
    writeFileSync(path.join(next.dir, "dist", "standalone", "server.js"), STUB_NEXT(broken));
    renameSync(path.join(fixture.checkout, ".git"), path.join(fixture.root, "saved-git"));
    const running = await start(fixture);
    const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" ? r : null; });
    expect(before.checkout).toBeNull();
    writeFileSync(before.releasePointer, JSON.stringify({ kind: "package", version: "0.0.1", baseVersion: "0.0.0", dir: next.dir, sha: next.sha }));
    writeFileSync(before.requestFile, JSON.stringify({ requestId: "package-relaunch", role: "relaunch", target: next.sha, rollbackPointer: null }));
    const after = await until(() => { const r = readRecord(fixture.state);
      return r.launcher.requestId === "package-relaunch" && r.launcher.state === "healthy" && r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null;
    }, 100_000);
    expect(after.launcher.pid).toBe(before.launcher.pid);
    expect(after.web.pid).not.toBe(before.web.pid);
    expect(after.runtimeHost.pid).not.toBe(before.runtimeHost.pid);
    expect(await served(running.port)).toBe(broken ? fixture.checkout : next.dir + "/dist/standalone");
    if (broken) { expect(after.launcher.error?.kind).toBe("fell-back"); expect(existsSync(before.releasePointer)).toBe(false); }
    else expect(after.launcher.revision).toBe(next.sha);
  }, 120_000);
}

// Uses two exported, built revisions. Every process and listener belongs to
// this fixture; the operator's install and fixed ports are never consulted.
test.skipIf(process.env.LLV_SELF_UPDATE_REHEARSAL !== "1")("real built revisions apply, roll back, and re-adopt a recovery Viewer", async () => {
  const firstDir = process.env.LLV_REHEARSAL_FIRST!;
  const nextDir = process.env.LLV_REHEARSAL_NEXT!;
  for (const directory of [firstDir, nextDir]) {
    if (!directory || !path.resolve(directory).startsWith("/var/tmp/")) throw new Error("Rehearsal builds must be isolated exports");
    expect(existsSync(path.join(directory, ".next", "BUILD_ID"))).toBe(true);
    expect(existsSync(path.join(directory, "dist", "runtime-host.mjs")) || existsSync(path.join(directory, "src", "runtime-host", "main.ts"))).toBe(true);
  }
  const root = mkdtempSync("/var/tmp/delegatus-real-apply-"); roots.push(root);
  const first = git(firstDir, "rev-parse", "HEAD");
  const target = git(nextDir, "rev-parse", "HEAD");
  expect(first).not.toBe(target);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(LLV_|DELEGATUS_|NEXT_|__NEXT_|GIT_)/.test(key)
    && !["PORT", "HOSTNAME", "NODE_ENV", "TMPDIR"].includes(key)));
  const token = "fixture-rehearsal-access-key";
  const state = path.join(root, "state");
  const env = { ...clean, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
    TMPDIR: path.join(root, "tmp"), LLV_STATE_DIR: state, LLV_BUN_EXECUTABLE: process.execPath, LLV_TOKEN: token, LLV_DEBUG: "1", NODE_ENV: "production" as const };
  for (const directory of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.TMPDIR, state]) mkdirSync(directory, { recursive: true });
  const fixture = { root, checkout: firstDir, first, state, env };
  const running = await start(fixture);
  const readHealthy = () => { const r = readRecord(state); return r.launcher.state === "healthy" && r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; };
  let record = await until(readHealthy, 120_000);
  const { UnixRuntimeHostClient } = await import("../src/lib/runtime/client");
  const health = async (r: LauncherRecord) => {
    const answer = await new UnixRuntimeHostClient(r.socket).runtimeHostHealth();
    expect(answer.pid).toBe(r.runtimeHost.pid!);
    const page = await fetch(`http://127.0.0.1:${running.port}/`, { headers: { authorization: `Bearer ${token}` } });
    expect(page.status).toBe(200);
    expect((await page.text()).includes("/_next/static/")).toBe(true);
  };
  await health(record);
  const oldWeb = record.web.pid;
  const oldHost = record.runtimeHost.pid;
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const applyDirectory = path.join(state, "self-update");
  const apply = new ApplyController(applyDirectory);
  apply.begin(record as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord, target, "operator");
  apply.patch({ state: "ready" });
  const pointer = JSON.stringify({ sha: target, dir: nextDir, checkoutHead: first });
  writeFileSync(record.releasePointer, pointer);
  apply.send(record as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord);
  record = await until(() => { const r = readHealthy(); return r?.launcher.requestId === apply.current!.requestId && r.launcher.revision === target ? r : null; }, 150_000);
  expect(record.web.pid).not.toBe(oldWeb); expect(record.runtimeHost.pid).not.toBe(oldHost);
  expect(record.web.revision).toBe(target.slice(0, 7)); expect(record.runtimeHost.revision).toBe(target.slice(0, 7));
  await health(record);
  const settled = await fetch(`http://127.0.0.1:${running.port}/api/self-update`, { headers: { authorization: `Bearer ${token}` } });
  expect(settled.status).toBe(200);
  expect((await settled.json()).processes.runtimeHost.state).toBe("healthy");
  expect(JSON.parse(readFileSync(path.join(applyDirectory, "apply.json"), "utf8")).state).toBe("done");

  const brokenDir = path.join(root, "broken");
  git(root, "clone", "--shared", nextDir, brokenDir);
  // Compiled artifacts represent a deliberately broken candidate at the
  // same revision. The rollback restores the exact serving pointer bytes.
  const { cpSync, symlinkSync } = await import("node:fs");
  symlinkSync(path.join(nextDir, "node_modules"), path.join(brokenDir, "node_modules"));
  symlinkSync(path.join(nextDir, ".next"), path.join(brokenDir, ".next"));
  cpSync(path.join(nextDir, "dist"), path.join(brokenDir, "dist"), { recursive: true });
  writeFileSync(path.join(brokenDir, "dist", "runtime-host.mjs"), "process.exit(3);\n");
  writeFileSync(record.releasePointer, JSON.stringify({ sha: target, dir: brokenDir, checkoutHead: first }));
  writeFileSync(record.requestFile, JSON.stringify({ role: "relaunch", requestId: "real-rollback", target, rollbackPointer: pointer }));
  record = await until(() => { const r = readHealthy(); return r?.launcher.requestId === "real-rollback" && r.launcher.error?.kind === "fell-back" ? r : null; }, 150_000);
  expect(readFileSync(record.releasePointer, "utf8")).toBe(pointer);
  expect(readlinkSync(`/proc/${record.launcher.pid}/cwd`)).toBe(nextDir);
  await health(record);

  // Suspend only our recorded supervisor while replacing its owned child
  // with a manually started recovery process. Adoption runs after resume.
  const supervisor = record.launcher.pid;
  process.kill(supervisor, "SIGSTOP");
  let orphan: ReturnType<typeof spawn> | null = null;
  try {
    process.kill(record.web.pid!, "SIGTERM");
    await until(() => { try { return readFileSync(`/proc/${record.web.pid}/stat`, "utf8").includes(") Z "); } catch { return true; } }, 20_000);
    orphan = spawn(process.execPath, ["--bun", path.join(nextDir, "node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(running.port)], {
      cwd: nextDir, env: { ...env, PORT: String(running.port), HOSTNAME: "127.0.0.1", LLV_STATE_OWNER: "viewer", LLV_RUNTIME_HOST_SOCKET: record.socket }, stdio: "ignore",
    });
    children.add(orphan);
    await until(() => { try { return existsSync(`/proc/${orphan!.pid}`) && orphan!.exitCode === null; } catch { return false; } });
    const { readStartIdentity } = await import("./self-update-supervisor.mjs");
    const adopted = record.requestFile.replace(/request-([^/]+)\.json$/, "adopt-$1.json");
    writeFileSync(adopted, JSON.stringify({ pid: orphan.pid, startIdentity: readStartIdentity(orphan.pid!), port: running.port, socket: record.socket }));
    // Require this recovery web to answer before allowing takeover.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${running.port}/`, { headers: { authorization: `Bearer ${token}` } })).status === 200) break; } catch { /* recovery boot */ }
      await Bun.sleep(100);
    }
    expect((await fetch(`http://127.0.0.1:${running.port}/`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  } finally { process.kill(supervisor, "SIGCONT"); }
  const orphanPid = orphan!.pid;
  record = await until(() => { const r = readHealthy(); return r && r.web.pid !== orphanPid && !existsSync(`/proc/${orphanPid}`) ? r : null; }, 120_000);
  expect(record.launcher.pid).toBe(supervisor); expect(record.web.revision).toBe(target.slice(0, 7));
  await health(record);

  // A first-party manual launch has no launcher record or inherited socket.
  // Opening its Update dialog must publish custody before Start launcher.
  const exited = new Promise(resolve => running.child.once("exit", resolve));
  running.child.kill("SIGTERM"); await exited;
  const manual = spawn(process.execPath, ["--bun", path.join(nextDir, "node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(running.port)], {
    cwd: nextDir, env: { ...env, PORT: undefined, HOSTNAME: "127.0.0.1", LLV_STATE_OWNER: "viewer" }, stdio: "ignore",
  }); children.add(manual);
  const manualDeadline = Date.now() + 60_000;
  while (Date.now() < manualDeadline) {
    try { if ((await fetch(`http://127.0.0.1:${running.port}/api/self-update`, { headers: { authorization: `Bearer ${token}` } })).status === 200) break; } catch { /* manual boot */ }
    await Bun.sleep(100);
  }
  const { cliRuntimeHostConfig } = await import("./server-runtime.mjs");
  const manualConfig = cliRuntimeHostConfig(nextDir, { env });
  expect(JSON.parse(readFileSync(path.join(state, "self-update", `adopt-${manualConfig.installId}.json`), "utf8"))).toMatchObject({ pid: manual.pid, installRoot: nextDir });
  const restarted = spawn(process.execPath, ["--bun", path.join(nextDir, "bin", "cli.mjs"), "--no-open", "--port", String(running.port)], { cwd: nextDir, env, stdio: "ignore" }); children.add(restarted);
  await until(() => !existsSync(`/proc/${manual.pid}`), 30_000);
  record = await until(readHealthy, 120_000);
  expect(record.web.pid).not.toBe(manual.pid);
  await health(record);
}, 480_000);


// A first upgrade can roll back to a launcher that predates this protocol.
// The optional local source fixture is the exact base checkout, never a live install.
const legacySource = process.env.LLV_REHEARSAL_LEGACY;
for (const shape of ["checkout", "checkout-published", "package"] as const) for (const form of ["posix", "powershell"] as const)
for (const failure of ["host", "web", "import"] as const) (legacySource ? test : test.skip)(`legacy terminal no-intent ${shape}/${form} restores prior after ${failure}`, async () => {
  const { installAction } = await import("../src/lib/selfUpdate/actions");
  const { isAlive } = await import("../src/lib/selfUpdate/pid");
  const fixture = install();
  for (const name of readdirSync(path.join(fixture.checkout, "bin"))) {
    const source = path.join(legacySource!, "bin", name); if (existsSync(source)) copyFileSync(source, path.join(fixture.checkout, "bin", name));
  }
  if (shape !== "package") {
    git(fixture.checkout, "add", "-f", "."); git(fixture.checkout, "commit", "-m", "legacy terminal fixture"); fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  } else {
    writeFileSync(path.join(fixture.checkout, "package.json"), JSON.stringify({ name: "delegatus-cli", type: "module", version: "0.0.0" }));
    mkdirSync(path.join(fixture.checkout, "dist", "standalone"), { recursive: true }); writeFileSync(path.join(fixture.checkout, "dist", "standalone", "server.js"), STUB_NEXT(false));
    renameSync(path.join(fixture.checkout, ".git"), path.join(fixture.root, "saved-git"));
  }
  const priorRelease = shape === "checkout-published" ? release(fixture, "legacy-prior") : null;
  if (priorRelease) {
    mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
    writeFileSync(pointerFile(fixture), JSON.stringify({ ...priorRelease, checkoutHead: fixture.first }));
  }
  const newer = install(); const candidate = release(newer, "terminal-candidate", { brokenHost: failure === "host" });
  if (shape === "package") {
    writeFileSync(path.join(candidate.dir, "package.json"), JSON.stringify({ name: "delegatus-cli", type: "module", version: "0.0.1" }));
    mkdirSync(path.join(candidate.dir, "dist", "standalone"), { recursive: true }); writeFileSync(path.join(candidate.dir, "dist", "standalone", "server.js"), STUB_NEXT(false));
  } else git(fixture.checkout, "fetch", candidate.dir, candidate.sha);
  const running = await start(fixture);
  let record = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  writeFileSync(record.releasePointer, JSON.stringify(shape !== "package" ? { ...candidate, checkoutHead: fixture.first }
    : { ...candidate, kind: "package", version: "0.0.1", baseVersion: "0.0.0" }));
  if (shape !== "package") {
    request(record, "web", "old-web-only");
    record = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.web.revision === candidate.sha.slice(0, 7) ? r : null; });
  } else {
    // The packaged old CLI has no pointer protocol. A recovery Viewer runs B
    // beside its old host; retain the genuine old launcher's custody record.
    process.kill(record.launcher.pid, "SIGSTOP");
    process.kill(record.web.pid!, "SIGTERM"); await until(() => !isAlive(record.web.pid!));
    const recovery = spawn(process.execPath, ["--bun", path.join(candidate.dir, "dist", "standalone", "server.js")], {
      cwd: path.join(candidate.dir, "dist", "standalone"), env: { ...fixture.env, PORT: String(running.port) }, stdio: "ignore" }); children.add(recovery);
    // The recovery Viewer has read its script once it answers. A process that
    // merely exists may still read the file after the rewrite below and file
    // a failed attempt the launcher under test never made.
    for (const deadline = Date.now() + 20_000; ; await Bun.sleep(25)) {
      if (await served(running.port).catch(() => null) === path.join(candidate.dir, "dist", "standalone")) break;
      if (Date.now() > deadline) throw new Error("The recovery Viewer never answered");
    }
  }
  if (failure === "import") writeFileSync(path.join(candidate.dir, "bin", "cli.mjs"), 'throw new Error("terminal candidate import failed");\n' + readFileSync(path.join(candidate.dir, "bin", "cli.mjs"), "utf8").replace(/^#![^\n]*\n/, ""));
  if (failure === "web") writeFileSync(path.join(candidate.dir, shape === "package" ? "dist/standalone/server.js" : "node_modules/.bin/next"), STUB_NEXT(true));
  const failedAttempts = path.join(candidate.dir, "failed-attempts");
  const failingEntry = path.join(candidate.dir, failure === "host" ? "dist/runtime-host.mjs" : failure === "import" ? "bin/cli.mjs" : shape === "package" ? "dist/standalone/server.js" : "node_modules/.bin/next");
  writeFileSync(failingEntry, `(await import("node:fs")).appendFileSync(${JSON.stringify(failedAttempts)}, "attempt" + String.fromCharCode(10));\n` + readFileSync(failingEntry, "utf8").replace(/^#![^\n]*\n/, ""));
  expect(existsSync(path.join(path.dirname(record.requestFile), "apply.json"))).toBe(false);
  const action = await installAction({ mode: shape === "package" ? "package" : "checkout", reason: null, record: { ...record, installRoot: fixture.checkout, port: running.port } as never },
    { cgroup: () => "", ready: () => true, argv: () => [], env: fixture.env, platform: form === "posix" ? "linux" : "win32" });
  expect(action?.id).toBe("restart-terminal");
  const closed = new Promise(resolve => running.child.once("exit", resolve)); running.child.kill("SIGTERM");
  if (shape === "package") process.kill(record.launcher.pid, "SIGCONT");
  await Promise.race([closed, Bun.sleep(2000)]);
  if (running.child.exitCode === null && running.child.signalCode === null) { running.child.kill("SIGKILL"); await closed; }
  if (record.runtimeHost.pid && isAlive(record.runtimeHost.pid)) { process.kill(record.runtimeHost.pid, "SIGTERM"); await until(() => !isAlive(record.runtimeHost.pid!)); }
  for (const child of children) if (child !== running.child && child.exitCode === null && child.signalCode === null) {
    const done = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await done;
  }
  // Execute both displayed forms; the PowerShell form is interpreted only
  // by PowerShell itself, including its encoded-script and exit semantics.
  const child = spawn(form === "posix" ? "sh" : process.env.LLV_TEST_PWSH ?? "pwsh", form === "posix" ? ["-c", action!.command!]
    : ["-NoProfile", "-Command", action!.command!], { cwd: fixture.checkout, env: cleanTerminalEnv(fixture), stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
  let output = ""; child.stderr?.on("data", value => { output += value; });
  const exit = await Promise.race([new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }), Bun.sleep(8000).then(() => null)]);
  expect(exit).toBe(1); expect(output).toContain("prior release");
  const after = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  try {
    if (priorRelease) expect(JSON.parse(readFileSync(record.releasePointer, "utf8")).sha).toBe(priorRelease.sha);
    else expect(existsSync(record.releasePointer)).toBe(false);
    expect(readFileSync(failedAttempts, "utf8").trim().split("\n")).toHaveLength(1);
    expect(await socketAnswers(after.socket)).toBe(true);
    expect(await served(running.port)).toBe((priorRelease?.dir ?? fixture.checkout) + (shape === "package" ? "/dist/standalone" : ""));
    expect(after.web.revision).toBe(after.runtimeHost.revision);
    const environment = readFileSync(`/proc/${after.web.pid}/environ`, "utf8").split("\0");
    expect(environment).toContain(`HOME=${fixture.env.HOME}`); expect(environment).toContain(`LLV_STATE_DIR=${fixture.state}`); expect(environment).toContain(`XDG_CONFIG_HOME=${fixture.env.XDG_CONFIG_HOME}`);
  } finally { if (isAlive(after.launcher.pid)) process.kill(after.launcher.pid, "SIGTERM"); await until(() => !isAlive(after.launcher.pid)); }
}, 90_000);

for (const priorPublished of [false, true]) for (const failure of ["host", "web", "import"] as const) (legacySource ? test : test.skip)(`a legacy ready pointer without an apply intent restores prior custody after ${failure} failure (prior published=${priorPublished})`, async () => {
  const { SelfUpdateService } = await import("../src/lib/selfUpdate/service");
  const { readRevision } = await import("../src/lib/selfUpdate/git");
  const { readStartIdentity } = await import("../src/lib/selfUpdate/pid");
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { idleUpdate } = await import("../src/lib/selfUpdate/types");
  const fixture = install();
  for (const name of readdirSync(path.join(fixture.checkout, "bin"))) {
    const source = path.join(legacySource!, "bin", name);
    if (existsSync(source)) copyFileSync(source, path.join(fixture.checkout, "bin", name));
  }
  git(fixture.checkout, "add", "-f", "."); git(fixture.checkout, "commit", "-m", "legacy ready-pointer fixture");
  fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  const candidateFixture = install();
  const candidate = release(candidateFixture, `ready-broken-${failure}`, { brokenHost: failure === "host" });
  git(fixture.checkout, "fetch", candidate.dir, candidate.sha);
  const prior = priorPublished ? release(fixture, "prior-published") : { sha: fixture.first, dir: fixture.checkout };
  if (priorPublished) {
    const installId = path.basename(pointerFile(fixture)).slice("release-".length, -".json".length);
    const destination = path.join(fixture.env.XDG_CACHE_HOME!, "delegatus", "self-update", installId, "releases", prior.sha.slice(0, 12));
    mkdirSync(path.dirname(destination), { recursive: true });
    git(fixture.checkout, "worktree", "move", prior.dir, destination); prior.dir = destination;
  }
  const priorPointer = priorPublished ? JSON.stringify({ ...prior, checkoutHead: fixture.first }) : null;
  if (priorPointer) { mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true }); writeFileSync(pointerFile(fixture), priorPointer); }
  const running = await start(fixture);
  let record = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  writeFileSync(record.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  // Old code can switch just the web before the new Viewer owns any apply intent.
  writeFileSync(record.requestFile, JSON.stringify({ role: "web", requestId: "legacy-web-only", requestedAt: new Date().toISOString() }));
  record = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.web.revision === candidate.sha.slice(0, 7) ? r : null; });
  expect(record.runtimeHost.revision).toBe(prior.sha.slice(0, 7));
  const unexpectedStart = path.join(candidate.dir, "unexpected-start");
  if (failure === "import") writeFileSync(path.join(candidate.dir, "bin", "cli.mjs"),
    `if (!process.argv.includes("--version")) (await import("node:fs")).writeFileSync(${JSON.stringify(unexpectedStart)}, "candidate started"); throw new Error("fixture import failure");\n`
      + readFileSync(path.join(candidate.dir, "bin", "cli.mjs"), "utf8").replace(/^#![^\n]*\n/, ""));
  if (failure === "web") writeFileSync(path.join(candidate.dir, "node_modules", ".bin", "next"), STUB_NEXT(true));
  const directory = path.dirname(record.requestFile);
  const managerDir = path.join(fixture.root, "manager"); mkdirSync(managerDir);
  const manager = path.join(managerDir, "systemctl");
  writeFileSync(manager, `#!${process.execPath} --bun
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("show")) { process.stdout.write(${JSON.stringify(serviceShown(fixture))}); process.exit(0); }
const record = JSON.parse(readFileSync(${JSON.stringify(recordFile(fixture.state))}, "utf8"));
const directory = ${JSON.stringify(directory)};
const intent = JSON.parse(readFileSync(directory + "/apply.json", "utf8"));
const drain = JSON.parse(readFileSync(directory + "/auto-drain.json", "utf8"));
if (intent.state !== "switching" || intent.requestId !== drain.id) process.exit(9);
writeFileSync(${JSON.stringify(path.join(fixture.root, "recovery-custody.json"))}, JSON.stringify({ requestId: intent.requestId, state: intent.state, drain: drain.id }));
// A service restart stops the recorded bootstrap, which forwards to its
// installed-launcher child. Both PIDs belong to this fixture.
const bootstrapPid = ${JSON.stringify(running.child.pid)};
process.kill(bootstrapPid, "SIGTERM");
const deadline = Date.now() + 5000;
while (Date.now() < deadline) { try { process.kill(bootstrapPid, 0); } catch { break; } await Bun.sleep(25); }
const launcher = spawn(process.execPath, ["--bun", ${JSON.stringify(path.join(fixture.checkout, "bin", "cli.mjs"))}, "--no-open", "--port", ${JSON.stringify(String(running.port))}], { cwd: ${JSON.stringify(fixture.checkout)}, detached: true, stdio: "ignore", env: process.env });
writeFileSync(${JSON.stringify(path.join(managerDir, "launcher.pid"))}, String(launcher.pid));
launcher.unref();
`, { mode: 0o700 });
  expect(existsSync(path.join(directory, "apply.json"))).toBe(false);
  let restarting: Promise<void> | undefined;
  let recoveryOutput = "";
  let recoveryHelper: ReturnType<typeof spawn> | undefined;
  const runner = { state: idleUpdate(), start: async () => {}, retry: async () => {}, restore(state: ReturnType<typeof idleUpdate>) { this.state = state; }, logPath: () => "" };
  const service = new SelfUpdateService({
    now: () => Date.now(), env: fixture.env, dir: directory, remote: "https://example.invalid/project.git", branch: "main", pollMinutes: 60, bun: process.execPath,
    mode: async () => ({ mode: "checkout", reason: null, record: readRecord(fixture.state) as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord }),
    check: async () => ({ ok: false, error: "fixture", installed: null }), describe: readRevision,
    createRunner: () => runner, requestRestart: () => "unused", processAlive: (pid, identity) => readStartIdentity(pid) === identity, processIdentity: (pid) => readStartIdentity(pid),
    hostHealth: async () => { const r = readRecord(fixture.state); return await socketAnswers(r.socket) ? { pid: r.runtimeHost.pid!, startIdentity: readStartIdentity(r.runtimeHost.pid!)!, hostEpoch: 1 } : null; },
    requestDeployment: async () => { throw new Error("unused"); }, readDeployment: async () => null,
    findDeploymentByIdempotencyKey: async () => null, releaseTarget: () => null, prepareCheckRepo: async () => { throw new Error("unused"); },
    buildEnv: () => ({}), web: { pid: record.web.pid!, port: running.port, startedAt: "" },
    install: { action: () => ({ id: "restart-service", button: true, unit: "fixture.service" }), entry: () => path.join(prior.dir, "bin", "cli.mjs"), run: (action, recovery) => {
      if (recovery) {
        restarting = (async () => {
          const { runInstallAction, unitRunsLauncher } = await import("../src/lib/selfUpdate/actions");
          // What the manager shows proves the service, here and in the helper.
          const owner = { root: fixture.checkout };
          runInstallAction(action, args => {
            const command = args.slice(args.indexOf("--") + 1);
            const helper = spawn(command[0]!, command.slice(1), { cwd: fixture.checkout, env: { ...fixture.env, PATH: managerDir + path.delimiter + fixture.env.PATH }, stdio: "pipe" }); children.add(helper); recoveryHelper = helper;
            // The recovery must outlive the Viewer that requested it.
            helper.stderr?.on("data", chunk => { recoveryOutput += String(chunk); });
          }, recovery, owner, (unit, root, pid) => unitRunsLauncher(unit, root, pid, { show: () => serviceShown(fixture) }));
        })();
        return;
      }
      restarting = (async () => {
        const closed = new Promise(resolve => running.child.once("exit", resolve)); running.child.kill("SIGTERM"); await closed;
        const child = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(running.port)], { cwd: fixture.checkout, env: fixture.env, stdio: "ignore" });
        children.add(child);
      })();
    } },
  });
  try {
    const { postInstallAction } = await import("../src/lib/selfUpdate/routes");
    const { setSelfUpdateServiceForTests } = await import("../src/lib/selfUpdate/instance");
    const { NextRequest } = await import("next/server");
    setSelfUpdateServiceForTests(service);
    const response = await postInstallAction(new NextRequest("http://localhost/api/self-update/install-action", { method: "POST", headers: { origin: "http://localhost", host: "localhost", "sec-fetch-site": "same-origin" } }));
    await response.json();
    if (failure === "import") {
      expect(response.status).toBe(503);
      // The action itself must finish owned recovery, without a second restart.
      const settled = readRecord(fixture.state);
      expect(recoveryOutput).toBe("");
      expect(recoveryHelper?.exitCode).toBe(0);
      expect(existsSync(path.join(directory, path.basename(record.requestFile).replace(/^request/, "recovery")))).toBe(false);
      expect(settled.web.revision).toBe(settled.runtimeHost.revision);
      expect(settled.web.revision).toBe(prior.sha.slice(0, 7));
      expect(await served(running.port)).toBe(prior.dir);
      expect(await socketAnswers(settled.socket)).toBe(true);
      expect(restarting).toBeDefined();
      const intent = JSON.parse(readFileSync(path.join(directory, "apply.json"), "utf8"));
      expect(intent).toMatchObject({ state: "failed", rolledBack: true, launcherPid: record.launcher.pid, launcherIdentity: record.launcher.startIdentity });
      expect(JSON.parse(readFileSync(path.join(fixture.root, "recovery-custody.json"), "utf8"))).toEqual({ requestId: intent.requestId, state: "switching", drain: intent.requestId });
      expect(existsSync(unexpectedStart)).toBe(false);
      expect(existsSync(path.join(directory, "auto-drain.json"))).toBe(false);
      expect(new ApplyController(directory).observe(settled as never, await socketAnswers(settled.socket))).toBeNull();
      expect(existsSync(record.releasePointer) ? JSON.parse(readFileSync(record.releasePointer, "utf8")).sha : null).toBe(priorPublished ? prior.sha : null);
      return;
    }
    expect(response.status).toBe(202);
    await restarting;
    const intent = JSON.parse(readFileSync(path.join(directory, "apply.json"), "utf8"));
    expect(intent.rollbackPointer ? JSON.parse(intent.rollbackPointer).sha : null).toBe(priorPublished ? prior.sha : null);
    expect(intent.rollbackWebRevision).toBe(prior.sha.slice(0, 7));
    expect(intent.rollbackHostRevision).toBe(prior.sha.slice(0, 7));
    record = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy"
      && r.web.revision === prior.sha.slice(0, 7) && r.runtimeHost.revision === prior.sha.slice(0, 7) ? r : null; }, 60_000);
    expect(existsSync(record.releasePointer) ? JSON.parse(readFileSync(record.releasePointer, "utf8")).sha : null).toBe(priorPublished ? prior.sha : null);
    expect(await served(running.port)).toBe(prior.dir);
    const cold = new ApplyController(directory);
    expect(cold.observe(record as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord, await socketAnswers(record.socket))).toBe("failed");
    expect(cold.current).toMatchObject({ rolledBack: true, state: "failed" });
  } finally {
    const { setSelfUpdateServiceForTests } = await import("../src/lib/selfUpdate/instance"); setSelfUpdateServiceForTests(null); service.stop(); await restarting;
    // The import-failure branch leaves the launcher its fake manager started.
    await stopManagedLauncher(path.join(managerDir, "launcher.pid"), fixture.state);
  }
}, 90_000);

(legacySource ? test : test.skip)("actual legacy bootstrap rollback settles the apply and seat receipt", async () => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { activeDrain, writeDrain } = await import("../src/lib/selfUpdate/drain");
  const fixture = install();
  for (const name of readdirSync(path.join(fixture.checkout, "bin"))) {
    const source = path.join(legacySource!, "bin", name);
    if (existsSync(source)) copyFileSync(source, path.join(fixture.checkout, "bin", name));
  }
  git(fixture.checkout, "add", "-f", "."); git(fixture.checkout, "commit", "-m", "legacy launcher fixture");
  fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  const candidateFixture = install(); const candidate = release(candidateFixture, "broken-new-host", { brokenHost: true });
  const running = await start(fixture);
  const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  expect(Object.keys(before.launcher).sort()).toEqual(["autoAdmission", "pid", "startIdentity"]);
  const directory = path.dirname(before.requestFile);
  const controller = new ApplyController(directory);
  writeFileSync(path.join(directory, "deployments.json"), JSON.stringify([{ deploymentId: "legacy-seat", idempotencyKey: "legacy-key", phase: "queued", terminal: false, revisionNumber: 1 }]));
  controller.begin(before as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord, candidate.sha, "seat", "legacy-seat");
  controller.patch({ state: "switching", externalRestart: true, switchedAt: new Date().toISOString() });
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  const trial = before.requestFile.replace("request-", "trial-");
  writeFileSync(trial, JSON.stringify({ requestId: controller.current!.requestId, target: candidate.sha, rollbackPointer: null,
    previousEntry: path.join(fixture.checkout, "bin", "cli.mjs"), state: "starting", at: controller.current!.startedAt }));
  writeDrain(path.join(directory, "auto-drain.json"), { id: controller.current!.requestId, target: candidate.sha, since: controller.current!.startedAt, until: Date.now() + 600_000, persistent: true });
  const closed = new Promise(resolve => running.child.once("exit", resolve)); running.child.kill("SIGTERM"); await closed;
  const restarted = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(running.port)],
    { cwd: fixture.checkout, env: fixture.env, stdio: "ignore" }); children.add(restarted);
  const after = await until(() => { const r = readRecord(fixture.state); return r.launcher.pid !== before.launcher.pid
    && r.web.state === "healthy" && r.runtimeHost.state === "healthy" && r.web.revision === fixture.first.slice(0, 7) ? r : null; }, 60_000);
  expect(JSON.parse(readFileSync(trial, "utf8")).state).toBe("rolled-back");
  expect(existsSync(before.releasePointer)).toBe(false); expect(await served(running.port)).toBe(fixture.checkout);
  const healthy = await socketAnswers(after.socket);
  const cold = new ApplyController(directory);
  expect(cold.observe(after as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord, healthy)).toBe("failed");
  expect(cold.current).toMatchObject({ state: "failed", rolledBack: true });
  expect(JSON.parse(readFileSync(path.join(directory, "deployments.json"), "utf8"))[0]).toMatchObject({ phase: "rolled-back", terminal: true });
  expect(activeDrain(path.join(directory, "auto-drain.json"))).toBeNull(); expect(existsSync(trial)).toBe(false);
}, 90_000);

for (const broken of [false, true]) (legacySource ? test : test.skip)(`actual legacy package terminal handoff settles rollback=${broken}`, async () => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { installAction } = await import("../src/lib/selfUpdate/actions");
  const fixture = install();
  for (const name of readdirSync(path.join(fixture.checkout, "bin"))) {
    const source = path.join(legacySource!, "bin", name); if (existsSync(source)) copyFileSync(source, path.join(fixture.checkout, "bin", name));
  }
  writeFileSync(path.join(fixture.checkout, "package.json"), JSON.stringify({ name: "delegatus-cli", type: "module", version: "0.0.0" }));
  mkdirSync(path.join(fixture.checkout, "dist", "standalone"), { recursive: true });
  writeFileSync(path.join(fixture.checkout, "dist", "standalone", "server.js"), STUB_NEXT(false));
  renameSync(path.join(fixture.checkout, ".git"), path.join(fixture.root, "saved-git"));
  const candidateFixture = install(); const candidate = release(candidateFixture, "package-handoff", { brokenHost: broken });
  writeFileSync(path.join(candidate.dir, "package.json"), JSON.stringify({ name: "delegatus-cli", type: "module", version: "0.0.1" }));
  mkdirSync(path.join(candidate.dir, "dist", "standalone"), { recursive: true }); writeFileSync(path.join(candidate.dir, "dist", "standalone", "server.js"), STUB_NEXT(false));
  const running = await start(fixture);
  const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  const record = { ...before, installRoot: fixture.checkout } as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord;
  const controller = new ApplyController(path.dirname(before.requestFile)); controller.begin(record, candidate.sha, "operator"); controller.patch({ state: "ready", externalRestart: true });
  writeFileSync(before.releasePointer, JSON.stringify({ kind: "package", version: "0.0.1", baseVersion: "0.0.0", dir: candidate.dir, sha: candidate.sha }));
  writeFileSync(before.requestFile.replace("request-", "trial-"), JSON.stringify({ requestId: controller.current!.requestId, target: candidate.sha,
    rollbackPointer: null, previousEntry: path.join(fixture.checkout, "bin", "cli.mjs"), state: "starting", at: controller.current!.startedAt }));
  const action = await installAction({ mode: "package", reason: null, record }, { cgroup: () => "", ready: () => true, argv: () => [], env: fixture.env });
  const closed = new Promise(resolve => running.child.once("exit", resolve)); running.child.kill("SIGTERM"); await closed;
  const child = spawn("sh", ["-c", `exec ${action!.command!}`], { cwd: fixture.checkout, env: cleanTerminalEnv(fixture), stdio: "ignore" }); children.add(child);
  const after = await until(() => { const r = readRecord(fixture.state); return r.launcher.pid !== before.launcher.pid && r.web.state === "healthy" && r.runtimeHost.state === "healthy"
    && (broken ? !existsSync(before.releasePointer) : r.launcher.requestId === controller.current!.requestId) ? r : null; }, 60_000);
  expect(await served(running.port)).toBe((broken ? fixture.checkout : candidate.dir) + "/dist/standalone");
  const cold = new ApplyController(path.dirname(before.requestFile)); expect(cold.observe(after as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord, await socketAnswers(after.socket))).toBe(broken ? "failed" : "done");
  expect(cold.current).toMatchObject({ state: broken ? "failed" : "done", rolledBack: broken });
}, 90_000);

for (const trigger of ["operator", "auto"] as const) test(`same-PID rollback keeps ${trigger} custody until a cold snapshot proves coherent serving`, async () => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { SelfUpdateService } = await import("../src/lib/selfUpdate/service");
  const { readStartIdentity, isAlive } = await import("../src/lib/selfUpdate/pid");
  const { activeDrain } = await import("../src/lib/selfUpdate/drain");
  const { initialAuto, writeAuto } = await import("../src/lib/selfUpdate/auto");
  const { idleUpdate } = await import("../src/lib/selfUpdate/types");
  const fixture = install();
  const running = await start(fixture);
  let record = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  const candidate = release(fixture, "broken-web", { broken: true });
  const directory = path.join(fixture.state, "self-update");
  const apply = new ApplyController(directory);
  apply.begin(record as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord, candidate.sha, trigger);
  writeFileSync(record.releasePointer, JSON.stringify({ sha: candidate.sha, dir: candidate.dir, checkoutHead: fixture.first }));
  apply.send(record as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord);
  record = await until(() => { const r = readRecord(fixture.state); return r.launcher.requestId === apply.current!.requestId && r.launcher.error?.kind === "fell-back" && r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; }, 60_000);
  expect(record.launcher.pid).toBe(apply.current!.launcherPid);
  if (trigger === "auto") writeAuto(path.join(directory, "auto.json"), { ...initialAuto(), enabled: true,
    drain: { id: apply.current!.requestId, target: { sha: candidate.sha, short: candidate.sha.slice(0, 7), version: "", date: "" }, since: apply.current!.startedAt, overranAt: null, blockers: null, admitted: true } });
  const coherent = structuredClone(record) as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord;
  let observed = coherent;
  const snapshot = async () => {
    const service = new SelfUpdateService({
      now: () => Date.now(), env: fixture.env, dir: directory, remote: "https://example.invalid/project.git", branch: "main", pollMinutes: 60, bun: process.execPath,
      mode: async () => ({ mode: "checkout", reason: null, record: observed }),
      check: async () => ({ ok: false, error: "fixture", installed: null }),
      describe: async (_repo, sha) => ({ sha, short: sha.slice(0, 7), version: "", date: "" }),
      createRunner: () => ({ state: idleUpdate(), restore() {}, logPath: () => "" }) as never,
      requestRestart: () => "unused", processAlive: (pid, identity) => isAlive(pid) && readStartIdentity(pid) === identity, processIdentity: (pid) => readStartIdentity(pid),
      hostHealth: async () => ({ pid: coherent.runtimeHost.pid!, startIdentity: readStartIdentity(coherent.runtimeHost.pid!)!, hostEpoch: 1 }),
      requestDeployment: async () => { throw new Error("unused"); }, readDeployment: async () => null, findDeploymentByIdempotencyKey: async () => null,
      releaseTarget: () => null, prepareCheckRepo: async () => { throw new Error("unused"); }, buildEnv: () => ({}),
      web: { pid: coherent.web.pid!, port: running.port, startedAt: "" },
    });
    try { return await service.snapshot(); } finally { service.stop(); }
  };
  // A stopped launcher cannot race the deliberately degraded observations.
  process.kill(record.launcher.pid, "SIGSTOP");
  try {
    for (const role of ["web", "runtimeHost"] as const) for (const fault of ["identity", "mixed", "failed"] as const) {
      observed = structuredClone(coherent);
      if (fault === "identity") observed[role].startIdentity = "wrong-identity";
      if (fault === "mixed") observed[role].revision = candidate.sha.slice(0, 7);
      if (fault === "failed") observed[role].state = "failed";
      await snapshot();
      expect(new ApplyController(directory).current?.state).toBe("switching");
      expect(activeDrain(path.join(directory, "auto-drain.json"))).not.toBeNull();
    }
    observed = coherent;
    // Rejection also needs healthy prior serving evidence.
    writeFileSync(`${record.requestFile}.result.json`, JSON.stringify({ requestId: apply.current!.requestId, state: "rejected" }));
    process.kill(record.runtimeHost.pid!, "SIGTERM");
    await until(() => !isAlive(record.runtimeHost.pid!) ? true : null);
    await snapshot();
    expect(new ApplyController(directory).current?.state).toBe("switching");
    expect(activeDrain(path.join(directory, "auto-drain.json"))).not.toBeNull();
    rmSync(`${record.requestFile}.result.json`);
    await snapshot();
    expect(new ApplyController(directory).current?.state).toBe("switching");
    expect(activeDrain(path.join(directory, "auto-drain.json"))).not.toBeNull();
  } finally { process.kill(record.launcher.pid, "SIGCONT"); }
  record = await until(() => { const r = readRecord(fixture.state); return r.runtimeHost.state === "healthy" && r.runtimeHost.pid !== coherent.runtimeHost.pid ? r : null; });
  observed = record as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord;
  coherent.runtimeHost = observed.runtimeHost;
  process.kill(record.launcher.pid, "SIGSTOP");
  try {
    process.kill(record.web.pid!, "SIGTERM");
    await until(() => !isAlive(record.web.pid!) ? true : null);
    await snapshot();
    expect(new ApplyController(directory).current?.state).toBe("switching");
    expect(activeDrain(path.join(directory, "auto-drain.json"))).not.toBeNull();
  } finally { process.kill(record.launcher.pid, "SIGCONT"); }
  record = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.web.pid !== coherent.web.pid ? r : null; });
  observed = record as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord;
  coherent.web = observed.web;
  await snapshot();
  expect(new ApplyController(directory).current).toMatchObject({ state: "failed", rolledBack: true });
  expect(activeDrain(path.join(directory, "auto-drain.json"))).toBeNull();
}, 90_000);

test.each(["restart-terminal", "start-launcher"] as const)("the actual %s command carries state and config from a clean shell", async actionId => {
  const { installAction } = await import("../src/lib/selfUpdate/actions");
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const fixture = install();
  // Quotes, spaces and shell expansion characters must remain literal paths.
  fixture.state = path.join(fixture.root, "state ' with $(literal) spaces");
  fixture.env.LLV_STATE_DIR = fixture.state;
  fixture.env.XDG_CONFIG_HOME = path.join(fixture.root, "config ' with $(literal) spaces");
  mkdirSync(fixture.state, { recursive: true });
  const running = await start(fixture);
  const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  const candidate = release(fixture, "terminal-context");
  const record = before as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord;
  const apply = new ApplyController(path.dirname(before.requestFile));
  apply.begin(record, candidate.sha, "operator"); apply.patch({ state: "ready", externalRestart: true });
  writeFileSync(before.releasePointer, JSON.stringify({ sha: candidate.sha, dir: candidate.dir, checkoutHead: fixture.first }));
  const decision = actionId === "restart-terminal"
    ? { mode: "checkout" as const, reason: null, record: { ...record, launcher: { ...record.launcher, relaunch: undefined } } }
    : { mode: "unsupported" as const, reason: "no-launcher" as const, record: null, installRoot: fixture.checkout };
  const action = await installAction(decision, { cgroup: () => "", ready: () => true, argv: () => [], env: { ...fixture.env, PORT: String(running.port), HOSTNAME: "127.0.0.1" } });
  expect(action?.id).toBe(actionId);
  const closed = new Promise(resolve => running.child.once("exit", resolve)); running.child.kill("SIGTERM"); await closed;
  let adopted: ReturnType<typeof spawn> | null = null;
  if (actionId === "start-launcher") {
    const { readStartIdentity } = await import("../src/lib/selfUpdate/pid");
    adopted = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "node_modules", ".bin", "next")], {
      cwd: fixture.checkout, env: { ...fixture.env, PORT: String(running.port), LLV_RUNTIME_HOST_SOCKET: before.socket }, stdio: "ignore",
    });
    children.add(adopted);
    await until(() => { try { return readStartIdentity(adopted!.pid!) && true; } catch { return false; } });
    await until(() => { try { return existsSync(`/proc/${adopted!.pid}/environ`); } catch { return false; } });
    await Bun.sleep(150);
    writeFileSync(before.requestFile.replace("request-", "adopt-"), JSON.stringify({ pid: adopted.pid, startIdentity: readStartIdentity(adopted.pid!), port: running.port, socket: before.socket }));
  }
  const child = spawn("sh", ["-c", `exec ${action!.command!}`], { cwd: fixture.checkout, env: cleanTerminalEnv(fixture), stdio: "ignore" }); children.add(child);
  const after = await until(() => { const r = readRecord(fixture.state); return r.launcher.pid !== before.launcher.pid && r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  expect(await served(running.port)).toBe(candidate.dir);
  expect(after.releasePointer).toBe(before.releasePointer);
  if (adopted) expect(adopted.exitCode !== null || adopted.signalCode !== null).toBe(true);
  expect(new ApplyController(path.dirname(before.requestFile)).current?.requestId).toBe(apply.current!.requestId);
  const webEnvironment = readFileSync(`/proc/${after.web.pid}/environ`, "utf8").split("\0");
  expect(webEnvironment).toContain(`HOME=${fixture.env.HOME}`);
  expect(webEnvironment).toContain(`XDG_CONFIG_HOME=${fixture.env.XDG_CONFIG_HOME}`);
  expect(webEnvironment).toContain(`LLV_STATE_DIR=${fixture.state}`);
}, 45_000);

for (const shape of ["checkout", "package"] as const) for (const alias of ["LLV_TOKEN", "DELEGATUS_TOKEN"] as const)
for (const actionId of ["start-launcher", "restart-terminal"] as const) for (const rollback of [false, true])
test(`private terminal custody ${shape}/${alias}/${actionId}, rollback=${rollback}`, async () => {
  const { installAction } = await import("../src/lib/selfUpdate/actions");
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { f, candidate, key } = await protectedInstall(shape, alias);
  const running = await start(f);
  const before = await until(() => { const r = readRecord(f.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  await perimeterRemains(running.port, key);
  const apply = new ApplyController(path.dirname(before.requestFile));
  apply.begin(before as never, candidate.sha, "operator"); apply.patch({ state: "ready", externalRestart: true });
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, ...(shape === "package" ? { kind: "package", baseVersion: "0.0.0", version: "0.0.1" } : { checkoutHead: f.first }) }));
  if (rollback) writeFileSync(path.join(candidate.dir, "bin/cli.mjs"), 'throw new Error("synthetic load failure");\n' + readFileSync(path.join(candidate.dir, "bin/cli.mjs"), "utf8").replace(/^#![^\n]*\n/, ""));
  const decision = actionId === "restart-terminal"
    ? { mode: shape, reason: null, record: { ...before, launcher: { ...before.launcher, relaunch: undefined } } }
    : { mode: "unsupported", reason: "no-launcher", record: null, installRoot: f.checkout };
  const action = await installAction(decision as never, { cgroup: () => "", ready: () => true, argv: () => [], env: { ...f.env, PORT: String(running.port) } });
  expect(action?.id).toBe(actionId);
  expect(Boolean(action?.command?.includes(key))).toBe(false);
  const clean = cleanTerminalEnv(f);
  expect(clean.LLV_TOKEN === undefined && clean.DELEGATUS_TOKEN === undefined).toBe(true);
  const exited = new Promise(resolve => running.child.once("exit", resolve));
  if (actionId === "start-launcher" && rollback) {
    // A real admitted request survives a killed launcher. The cold entrypoint
    // must roll it back before serving, using its original owner and request.
    process.kill(before.launcher.pid, "SIGSTOP"); apply.send(before as never);
    running.child.kill("SIGKILL"); await exited;
    const { isAlive } = await import("../src/lib/selfUpdate/pid");
    for (const role of [before.web, before.runtimeHost]) if (role.pid && isAlive(role.pid)) process.kill(role.pid, "SIGTERM");
    await until(() => !isAlive(before.web.pid!) && !isAlive(before.runtimeHost.pid!));
  } else { running.child.kill("SIGTERM"); await exited; }
  const child = spawn("sh", ["-c", `exec ${action!.command!}`], { cwd: f.checkout, env: clean, stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
  let output = ""; child.stdout!.on("data", bytes => output += bytes); child.stderr!.on("data", bytes => output += bytes);
  const after = await until(() => { const r = readRecord(f.state); return r.launcher.pid !== before.launcher.pid && r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  await perimeterRemains(running.port, key);
  expect(after.releasePointer).toBe(before.releasePointer); expect(after.socket).toBe(before.socket);
  expect(after.web.revision).toBe(after.runtimeHost.revision);
  if (!rollback) expect(after.web.revision).toBe(candidate.sha.slice(0, 7));
  if (rollback) expect(after.web.revision).toBe(shape === "checkout" ? f.first.slice(0, 7) : null);
  for (const entry of [after.launcher, after.web, after.runtimeHost]) {
    expect(readFileSync(`/proc/${entry.pid}/cmdline`, "utf8").includes(key)).toBe(false);
  }
  expect(output.includes(key)).toBe(false);
}, 60000);


test.each(["gate-expired", "new-work", "launcher-changed"] as const)("resident relaunch fences the last awaited load preflight: %s", async change => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { beginRestartGate, restartGateFile } = await import("../src/lib/selfUpdate/restartGate");
  const { writeDrain } = await import("../src/lib/selfUpdate/drain");
  const { f, key } = await protectedInstall("checkout", "LLV_TOKEN");
  const running = await start(f);
  const before = await until(() => { const r = readRecord(f.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  const candidate = release(f, "dispatch-load-fence");
  const entered = path.join(f.root, "load-entered"), released = path.join(f.root, "load-released");
  const entry = path.join(candidate.dir, "bin", "cli.mjs");
  writeFileSync(entry, `if (process.argv.includes("--version")) { const fs = await import("node:fs"); fs.writeFileSync(${JSON.stringify(entered)}, String(process.pid)); while (!fs.existsSync(${JSON.stringify(released)})) await Bun.sleep(5); }\n`
    + readFileSync(entry, "utf8").replace(/^#![^\n]*\n/, ""));
  const dir = path.dirname(before.requestFile), apply = new ApplyController(dir);
  const gateFile = restartGateFile(before.requestFile), gateId = beginRestartGate(gateFile)!;
  apply.begin(before as never, candidate.sha, "auto", undefined, { autoGateId: gateId });
  writeDrain(path.join(dir, "auto-drain.json"), { id: apply.current!.requestId, target: candidate.sha, since: apply.current!.startedAt, until: Date.now() + 600000, persistent: true });
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: f.first }));
  apply.send(before as never, gateId);
  const originalApply = readFileSync(path.join(dir, "apply.json"), "utf8"), originalRequest = readFileSync(before.requestFile, "utf8");
  await until(() => existsSync(entered));
  if (change === "gate-expired") { const gate = JSON.parse(readFileSync(gateFile, "utf8")); writeFileSync(gateFile, JSON.stringify({ ...gate, until: 0 })); }
  // A turn or a stage that starts now is filed in the Viewer's database, with
  // the registry in sqlite: no file the launcher reads names it. The files an
  // open turn writes move as well, and say nothing about new work.
  const admissions = () => readFileSync(path.join(f.state, ADMISSION_LOG), "utf8").trim().split("\n");
  expect(admissions()).toEqual(["request filed"]);
  expect(existsSync(path.join(f.state, "agent-registry.json"))).toBe(false);
  for (const name of ["state.sqlite", "state.sqlite-wal", "runtime-events-fixture.sqlite-wal"]) writeFileSync(path.join(f.state, name), `event ${change}`);
  if (change === "new-work") writeFileSync(path.join(f.state, WORK_STARTED), "");
  if (change === "launcher-changed") { const r = readRecord(f.state); r.launcher.startIdentity = "foreign-custody"; writeFileSync(recordFile(f.state), JSON.stringify(r)); }
  const finalGate = readFileSync(gateFile, "utf8"), finalOwner = readFileSync(recordFile(f.state), "utf8");
  writeFileSync(released, "");
  await until(() => {
    const r = readRecord(f.state);
    try { if (JSON.parse(readFileSync(`${before.requestFile}.result.json`, "utf8")).state === "rejected") return true; } catch { /* no refusal yet */ }
    return r.web.pid !== before.web.pid || r.runtimeHost.pid !== before.runtimeHost.pid;
  });
  let refusal;
  try { refusal = JSON.parse(readFileSync(`${before.requestFile}.result.json`, "utf8")); } catch { /* a stale dispatch produces no refusal */ }
  expect(refusal?.state).toBe("rejected");
  // The Viewer was asked again once the load check was over, with the request
  // already taken, and its answer decided the dispatch.
  expect(admissions().slice(0, 2)).toEqual(["request filed", "request taken"]);
  if (change === "new-work") expect(refusal.detail).toBe("The Viewer did not admit the relaunch after the launcher load check");
  expect(readFileSync(path.join(dir, "apply.json"), "utf8")).toBe(originalApply);
  expect(readFileSync(before.requestFile, "utf8")).toBe(originalRequest);
  expect(readFileSync(gateFile, "utf8")).toBe(finalGate); expect(readFileSync(recordFile(f.state), "utf8")).toBe(finalOwner);
  const after = readRecord(f.state);
  expect(after.web.pid).toBe(before.web.pid); expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
  await perimeterRemains(running.port, key);
}, 30000);

test("a refused relaunch keeps both children through the Viewer's settlement and every later poll", async () => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { beginRestartGate, restartGateFile } = await import("../src/lib/selfUpdate/restartGate");
  const fixture = install();
  const running = await start(fixture);
  const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  const candidate = release(fixture, "refused-relaunch");
  // Each load check announces itself and waits to be let through.
  const gate = path.join(fixture.root, "load"), entry = path.join(candidate.dir, "bin", "cli.mjs");
  writeFileSync(entry, `if (process.argv.includes("--version")) { const fs = await import("node:fs"); let attempt = 0; while (fs.existsSync(${JSON.stringify(gate)} + "-entered-" + attempt)) attempt++;
    fs.writeFileSync(${JSON.stringify(gate)} + "-entered-" + attempt, ""); while (!fs.existsSync(${JSON.stringify(gate)} + "-released-" + attempt)) await Bun.sleep(5); }\n`
    + readFileSync(entry, "utf8").replace(/^#![^\n]*\n/, ""));
  const dir = path.dirname(before.requestFile), apply = new ApplyController(dir);
  const trialFile = before.requestFile.replace("request-", "trial-"), receipt = `${before.requestFile}.result.json`;
  const gateId = beginRestartGate(restartGateFile(before.requestFile))!;
  apply.begin(before as never, candidate.sha, "auto", undefined, { autoGateId: gateId }); apply.patch({ state: "ready" });
  expect(existsSync(before.releasePointer)).toBe(false);
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  apply.send(before as never, gateId);
  // Work the admission never saw starts during the first load check. The
  // Viewer files it in its database, and the launcher learns of it by asking
  // the Viewer again once the load check is over.
  await until(() => existsSync(`${gate}-entered-0`));
  writeFileSync(path.join(fixture.state, WORK_STARTED), "");
  writeFileSync(`${gate}-released-0`, "");
  await until(() => { try { return JSON.parse(readFileSync(receipt, "utf8")).detail === "The Viewer did not admit the relaunch after the launcher load check"; } catch { return false; } });
  expect(readFileSync(path.join(fixture.state, ADMISSION_LOG), "utf8").trim().split("\n").slice(0, 2)).toEqual(["request filed", "request taken"]);
  expect(readRecord(fixture.state).web.pid).toBe(before.web.pid); expect(readRecord(fixture.state).runtimeHost.pid).toBe(before.runtimeHost.pid);
  // That work ends, and the retained request is admitted to a second load check.
  rmSync(path.join(fixture.state, WORK_STARTED));
  await until(() => !existsSync(trialFile) || existsSync(`${gate}-entered-1`));
  // The request is offered again. The Viewer settles the refusal and restores
  // the pointer while that second load check is still running.
  await until(() => existsSync(`${gate}-entered-1`));
  expect(new ApplyController(dir).observe(readRecord(fixture.state) as never, true)).toBe("failed");
  expect(JSON.parse(readFileSync(path.join(dir, "apply.json"), "utf8"))).toMatchObject({ state: "failed", admissionRefused: true });
  expect(existsSync(before.releasePointer)).toBe(false);
  writeFileSync(`${gate}-released-1`, "");
  // Five polling intervals: a launcher that still owned a trial would roll it
  // back here, stopping the Viewer and the runtime host.
  await until(() => !existsSync(trialFile) && !existsSync(before.requestFile));
  await Bun.sleep(2_500);
  const after = readRecord(fixture.state);
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(after.web.pid).toBe(before.web.pid); expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(existsSync(`/proc/${before.web.pid}`)).toBe(true); expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(true);
  expect(after.web.state).toBe("healthy"); expect(after.runtimeHost.state).toBe("healthy");
  expect(after.launcher.error ?? null).toBeNull();
  expect(existsSync(trialFile)).toBe(false); expect(existsSync(before.requestFile)).toBe(false);
  expect(existsSync(before.releasePointer)).toBe(false);
  expect(existsSync(`${gate}-entered-2`)).toBe(false);
  expect(await served(running.port)).toBe(fixture.checkout);
  expect(running.child.exitCode).toBeNull();
}, 60_000);

test("journal traffic during the load check does not refuse a relaunch", async () => {
  const { ApplyController } = await import("../src/lib/selfUpdate/apply");
  const { beginRestartGate, restartGateFile } = await import("../src/lib/selfUpdate/restartGate");
  const fixture = install();
  const running = await start(fixture);
  const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  // A turn that is already running has its record in the state database and
  // its journal beside it.
  for (const name of ["runtime-events-fixture.sqlite", "state.sqlite"]) writeFileSync(path.join(fixture.state, name), "admitted");
  const candidate = release(fixture, "journal-traffic");
  const entered = path.join(fixture.root, "load-entered"), released = path.join(fixture.root, "load-released"), entry = path.join(candidate.dir, "bin", "cli.mjs");
  writeFileSync(entry, `if (process.argv.includes("--version")) { const fs = await import("node:fs"); fs.writeFileSync(${JSON.stringify(entered)}, ""); while (!fs.existsSync(${JSON.stringify(released)})) await Bun.sleep(5); }\n`
    + readFileSync(entry, "utf8").replace(/^#![^\n]*\n/, ""));
  const apply = new ApplyController(path.dirname(before.requestFile));
  const gateId = beginRestartGate(restartGateFile(before.requestFile))!;
  apply.begin(before as never, candidate.sha, "auto", undefined, { autoGateId: gateId }); apply.patch({ state: "ready" });
  writeFileSync(before.releasePointer, JSON.stringify({ ...candidate, checkoutHead: fixture.first }));
  apply.send(before as never, gateId);
  await until(() => existsSync(entered));
  // Every event of that turn moves these while the load check runs.
  for (const name of ["runtime-events-fixture.sqlite", "runtime-events-fixture.sqlite-wal", "state.sqlite", "state.sqlite-wal"]) writeFileSync(path.join(fixture.state, name), "event");
  writeFileSync(released, "");
  const after = await until(() => {
    const r = readRecord(fixture.state);
    return r.launcher.requestId === apply.current!.requestId && r.launcher.state === "healthy" && r.web.state === "healthy" && r.runtimeHost.state === "healthy"
      && r.web.revision === candidate.sha.slice(0, 7) && r.runtimeHost.revision === candidate.sha.slice(0, 7) ? r : null;
  });
  expect(JSON.parse(readFileSync(`${before.requestFile}.result.json`, "utf8"))).toMatchObject({ requestId: apply.current!.requestId, state: "done" });
  // The Viewer admitted the same work twice: before the request was taken,
  // and after the load check that the traffic ran through.
  expect(readFileSync(path.join(fixture.state, ADMISSION_LOG), "utf8").trim().split("\n")).toEqual(["request filed", "request taken"]);
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(await served(running.port)).toBe(candidate.dir);
}, 60_000);

// The helper's protocol is the one-time upgrade of a launcher that predates
// relaunch, so the settled outcome needs that launcher: the rehearsal source.
for (const outcome of ["refused", "settled"] as const) (outcome === "refused" || legacySource ? test : test.skip)(`a service recovery plan names protected custody and holds no access key: ${outcome}`, async () => {
  const { SelfUpdateService } = await import("../src/lib/selfUpdate/service");
  const { readRevision } = await import("../src/lib/selfUpdate/git");
  const { readStartIdentity } = await import("../src/lib/selfUpdate/pid");
  const { idleUpdate } = await import("../src/lib/selfUpdate/types");
  const { runInstallAction, unitRunsLauncher } = await import("../src/lib/selfUpdate/actions");
  let f: ReturnType<typeof install>, candidate: ReturnType<typeof release>, key: string;
  if (outcome === "refused") ({ f, candidate, key } = await protectedInstall("checkout", "LLV_TOKEN"));
  else {
    f = install({ tokenProtected: true });
    for (const name of readdirSync(path.join(f.checkout, "bin"))) {
      const source = path.join(legacySource!, "bin", name); if (existsSync(source)) copyFileSync(source, path.join(f.checkout, "bin", name));
    }
    git(f.checkout, "add", "-f", "."); git(f.checkout, "commit", "-m", "legacy service fixture"); f.first = git(f.checkout, "rev-parse", "HEAD");
    candidate = release(install(), "recovery-candidate"); git(f.checkout, "fetch", candidate.dir, candidate.sha);
    key = randomBytes(16).toString("hex"); f.env.LLV_TOKEN = key;
  }
  // The serving Viewer answers the key it was given and nothing else.
  const gateHolds = async (port: number) => {
    if (outcome === "refused") return perimeterRemains(port, key);
    for (const [credential, status] of [[null, 401], ["wrong-synthetic-key", 401], [key, 200]] as const) {
      const response = await fetch(`http://127.0.0.1:${port}/`, { headers: credential ? { authorization: `Bearer ${credential}` } : {}, signal: AbortSignal.timeout(2000) });
      expect(response.status === status).toBe(true); await response.body?.cancel();
    }
  };
  const running = await start(f);
  const record = await until(() => { const r = readRecord(f.state); return r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null; });
  await gateHolds(running.port);
  // The candidate cannot load, so the action must restore the prior release.
  writeFileSync(path.join(candidate.dir, "bin", "cli.mjs"), 'throw new Error("fixture import failure");\n');
  writeFileSync(record.releasePointer, JSON.stringify({ ...candidate, checkoutHead: f.first }));
  const directory = path.dirname(record.requestFile);
  const planFile = path.join(directory, path.basename(record.requestFile).replace(/^request/, "recovery"));
  const custody = path.join(f.state, `launcher-custody-${path.basename(record.requestFile).slice("request-".length, -".json".length)}`);
  // The service manager restarts the unit under the unit's own environment.
  const managerDir = path.join(f.root, "manager"); mkdirSync(managerDir);
  const serviceEnv = path.join(f.root, "service-env.json"); writeFileSync(serviceEnv, JSON.stringify(f.env), { mode: 0o600 });
  writeFileSync(path.join(managerDir, "systemctl"), `#!${process.execPath} --bun
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("show")) { process.stdout.write(${JSON.stringify(serviceShown(f))}); process.exit(0); }
const bootstrapPid = ${JSON.stringify(running.child.pid)};
process.kill(bootstrapPid, "SIGTERM");
const deadline = Date.now() + 5000;
while (Date.now() < deadline) { try { process.kill(bootstrapPid, 0); } catch { break; } await Bun.sleep(25); }
const launcher = spawn(process.execPath, ["--bun", ${JSON.stringify(path.join(f.checkout, "bin", "cli.mjs"))}, "--no-open", "--port", ${JSON.stringify(String(running.port))}], { cwd: ${JSON.stringify(f.checkout)}, detached: true, stdio: "ignore", env: JSON.parse(readFileSync(${JSON.stringify(serviceEnv)}, "utf8")) });
writeFileSync(${JSON.stringify(path.join(managerDir, "launcher.pid"))}, String(launcher.pid));
launcher.unref();
`, { mode: 0o700 });
  let plan = "", helper: ReturnType<typeof spawn> | undefined, helperOutput = "";
  const runner = { state: idleUpdate(), start: async () => {}, retry: async () => {}, restore(state: ReturnType<typeof idleUpdate>) { this.state = state; }, logPath: () => "" };
  const service = new SelfUpdateService({
    now: () => Date.now(), env: f.env, dir: directory, remote: "https://example.invalid/project.git", branch: "main", pollMinutes: 60, bun: process.execPath,
    mode: async () => ({ mode: "checkout", reason: null, record: readRecord(f.state) as unknown as import("../src/lib/selfUpdate/launcher").LauncherRecord }),
    check: async () => ({ ok: false, error: "fixture", installed: null }), describe: readRevision,
    createRunner: () => runner, requestRestart: () => "unused", processAlive: (pid, identity) => readStartIdentity(pid) === identity, processIdentity: (pid) => readStartIdentity(pid),
    hostHealth: async () => { const r = readRecord(f.state); return await socketAnswers(r.socket) ? { pid: r.runtimeHost.pid!, startIdentity: readStartIdentity(r.runtimeHost.pid!)!, hostEpoch: 1 } : null; },
    requestDeployment: async () => { throw new Error("unused"); }, readDeployment: async () => null,
    findDeploymentByIdempotencyKey: async () => null, releaseTarget: () => null, prepareCheckRepo: async () => { throw new Error("unused"); },
    buildEnv: () => ({}), web: { pid: record.web.pid!, port: running.port, startedAt: "" },
    install: { action: () => ({ id: "restart-service", button: true, unit: "fixture.service" }), entry: () => path.join(f.checkout, "bin", "cli.mjs"), run: (action, recovery) => {
      if (!recovery) throw new Error("the candidate was never meant to start");
      plan = readFileSync(recovery.file, "utf8");
      if (outcome === "refused") throw new Error("the service manager refused the transient unit");
      runInstallAction(action, args => {
        // The transient unit has the manager's environment: no key, no state
        // directory, and a home outside the install.
        const command = args.slice(args.indexOf("--") + 1), env = cleanTerminalEnv(f);
        helper = spawn(command[0]!, command.slice(1), { cwd: f.checkout, env: { ...env, PATH: managerDir + path.delimiter + env.PATH }, stdio: ["ignore", "pipe", "pipe"] }); children.add(helper);
        helper.stderr?.on("data", chunk => { helperOutput += String(chunk); });
      }, recovery, { root: f.checkout }, (unit, root, pid) => unitRunsLauncher(unit, root, pid, { show: () => serviceShown(f) }));
    } },
  });
  try {
    const result = await service.performInstallAction();
    // The plan says where the credentials are held and holds none of them.
    for (const secret of [key, "probe.", "authorization", "Bearer", "x-llv-internal-service"]) expect(plan.includes(secret)).toBe(false);
    expect(JSON.parse(plan)).toMatchObject({ unit: "fixture.service", root: f.checkout, custody: true, requestFile: record.requestFile });
    expect(existsSync(planFile)).toBe(false);
    expect(result).toMatchObject({ ok: false, status: 503 });
    const intent = JSON.parse(readFileSync(path.join(directory, "apply.json"), "utf8"));
    if (outcome === "refused") {
      expect((result as { detail?: string; error?: string }).detail ?? (result as { error?: string }).error).toContain("not accepted");
      // The apply is still open, so its custody stays, private to this user.
      expect(intent.state).toBe("switching");
      expect(statSync(custody).mode & 0o077).toBe(0); expect(statSync(path.join(custody, "environment.json")).mode & 0o077).toBe(0);
      expect(readRecord(f.state).launcher.pid).toBe(record.launcher.pid);
    } else {
      // The helper proved the restarted Viewer's gate with the held key, from
      // an environment that carried none, and the settlement released it.
      expect(helperOutput).toBe(""); expect(helper?.exitCode).toBe(0);
      expect(intent).toMatchObject({ state: "failed", rolledBack: true });
      expect(existsSync(custody)).toBe(false);
      const settled = readRecord(f.state);
      expect(settled.launcher.pid).not.toBe(record.launcher.pid);
      expect(settled.web.revision).toBe(f.first.slice(0, 7)); expect(settled.runtimeHost.revision).toBe(f.first.slice(0, 7));
      expect(existsSync(record.releasePointer)).toBe(false);
    }
    await gateHolds(running.port);
    // Outside the protected custody directory no state file holds the key.
    const outside = readdirSync(f.state, { withFileTypes: true }).filter(entry => path.join(f.state, entry.name) !== custody)
      .map(entry => entry.isDirectory() ? stateText(path.join(f.state, entry.name)) : entry.isFile() ? readFileSync(path.join(f.state, entry.name), "utf8") : "").join("\n");
    expect(outside.includes(key)).toBe(false);
  } finally { service.stop(); await stopManagedLauncher(path.join(managerDir, "launcher.pid"), f.state); }
}, 120_000);

test("a recovery helper that cannot take its plan removes it", async () => {
  const fixture = install();
  const control = path.join(fixture.state, "self-update"); mkdirSync(control, { recursive: true });
  const planFile = path.join(control, "recovery-fixture.json");
  for (const plan of [{ requestId: "absent", requestFile: path.join(control, "request-fixture.json"), unit: "fixture.service", root: fixture.checkout, custody: false }, { unit: "not a unit" }, "not a plan"]) {
    writeFileSync(planFile, typeof plan === "string" ? plan : JSON.stringify(plan));
    const run = spawnSync(process.execPath, ["--bun", path.resolve("bin/launcher-relaunch.mjs"), "--recover-service", planFile], { env: cleanTerminalEnv(fixture), encoding: "utf8", timeout: 30_000 });
    expect(run.status).toBe(1);
    expect(existsSync(planFile)).toBe(false);
  }
});
