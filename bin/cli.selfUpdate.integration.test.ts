import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  STUB_NEXT, availablePort, children, git, install, pointerFile, readRecord, registerSelfUpdateCleanup, release, request, served, socketAnswers, start, until, version,
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
