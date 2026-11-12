import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { expect, spyOn, test } from "bun:test";
import * as gateTool from "./gateCheckTool";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { cpuOwnerIdentity } from "./signalSandboxContext";
import { custodyClock, physical } from "../recordedChecks/wire";
import * as wire from "../recordedChecks/wire";

// Keep Unix socket addresses short even when the stage scratch path is long.
// The descriptor holds only this test's directory and stays open for its children.
function fixtureSocket(directory: string) {
  const parent = path.join(directory, "socket"); fs.mkdirSync(parent, { mode: 0o700 });
  const descriptor = fs.openSync(directory, "r");
  return { descriptor, filename: path.join(parent, "gate-root.json"),
    socket: process.platform === "linux" ? `/proc/${process.pid}/fd/${descriptor}/socket/rpc.sock` : path.join(parent, "rpc.sock") };
}

// Every subprocess is owned by this explicit-file runner and gets only isolated state.
test.skipIf(process.platform !== "linux")("a restarted Viewer waits on the retained stage root with a different or absent TMPDIR", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gc-"));
  const originalRoot = path.join(directory, "stage"), replacementRoot = path.join(directory, "viewer");
  const scratchRoot = path.join(directory, "scratch"), attemptRoot = path.join(directory, "attempt-temp");
  for (const root of [originalRoot, replacementRoot, scratchRoot, attemptRoot]) fs.mkdirSync(root);
  fs.chmodSync(directory, 0o700);
  const descriptor = path.join(directory, "descriptor.json"), result = path.join(directory, "result.json");
  const address = fixtureSocket(directory), rootBinding = address.filename;
  const log = path.join(attemptRoot, "check.log"), ticket = `${log}.gate`;
  fs.mkdirSync(ticket); fs.writeFileSync(log, "stage check finished\n");
  const recorder = cpuOwnerIdentity(process.pid);
  fs.writeFileSync(path.join(ticket, "owner.json"), JSON.stringify(recorder));
  fs.writeFileSync(path.join(ticket, "completion.json"), JSON.stringify({ recorder, directoryIdentity: physical(ticket), deadlineUptimeMs: custodyClock() + 60_000 }));
  fs.writeFileSync(path.join(ticket, "exit"), "37\n");
  const config = { socket: address.socket, directory, log, result, events: path.join(directory, "events") };
  fs.writeFileSync(descriptor, JSON.stringify(config));
  const children: ReturnType<typeof spawn>[] = [];
  const launch = (mode: string, temporaryRoot?: string) => {
    const env = { ...process.env, TMPDIR: temporaryRoot,
      ...(mode === "engine" && temporaryRoot ? { [gateTool.GATE_CHECK_ROOT_IDENTITY_ENV]: physical(temporaryRoot),
        [gateTool.GATE_CHECK_ROOTS_ENV]: JSON.stringify(gateTool.bindGateCheckRoot(temporaryRoot, [scratchRoot, attemptRoot])) } : {}) };
    const child = spawn(process.execPath, [path.join(import.meta.dir, "fixtures/gateCheckHost.ts"), mode, descriptor], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let errors = ""; child.stderr!.on("data", bytes => { errors += String(bytes); });
    let output = "";
    const line = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fixture readiness timed out: ${errors}`)), 15_000);
      child.stdout!.on("data", bytes => { output += String(bytes); if (output.includes("\n")) { clearTimeout(timer); resolve(output.trim()); } });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => { clearTimeout(timer); if (!output.includes("\n")) reject(new Error(`fixture exited ${code}: ${errors}`)); });
    });
    const closed = new Promise<number | null>(resolve => child.once("close", resolve));
    return { child, line, closed, errors: () => errors };
  };
  try {
    const engine = launch("engine", originalRoot);
    const owner = JSON.parse(await engine.line);
    fs.writeFileSync(descriptor, JSON.stringify({ ...config, owner }));
    const first = launch("host", originalRoot);
    const initial = JSON.parse(await first.line);
    expect(initial.success).toBe(true);
    expect(await first.closed, first.errors()).toBe(0);
    expect(engine.child.exitCode).toBeNull();
    for (const temporaryRoot of [replacementRoot, undefined]) {
      fs.unlinkSync(result);
      const next = launch("host", temporaryRoot);
      const answer = JSON.parse(await next.line);
      expect(await next.closed, next.errors()).toBe(0);
      expect(answer, `replacement TMPDIR ${temporaryRoot ? "differs" : "absent"}`).toEqual(initial);
      expect(JSON.parse(answer.contentItems[0].text)).toMatchObject({ terminal: true, code: 37 });
      expect(engine.child.exitCode).toBeNull();
    }

    fs.unlinkSync(rootBinding);
    fs.unlinkSync(result);
    const recoveredWithoutRecord = launch("host");
    const recoveredAnswer = JSON.parse(await recoveredWithoutRecord.line);
    expect(await recoveredWithoutRecord.closed, recoveredWithoutRecord.errors()).toBe(0);
    expect(recoveredAnswer).toEqual(initial);

    // The engine holds the callback until the new host has bound its root.
    const ready = path.join(directory, "callback-ready"), release = path.join(directory, "callback-release");
    fs.writeFileSync(descriptor, JSON.stringify({ ...config, owner, ready, release }));
    const readyWait = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { watcher.close(); reject(new Error("host did not bind its callback root")); }, 15_000);
      const watcher = fs.watch(directory, () => {
        if (fs.existsSync(ready)) { clearTimeout(timer); watcher.close(); resolve(); }
      });
    });
    fs.unlinkSync(result);
    const held = launch("host", replacementRoot);
    await readyWait;
    const retained = `${originalRoot}.held`;
    fs.renameSync(originalRoot, retained);
    fs.symlinkSync(replacementRoot, originalRoot, "dir");
    // A valid foreign recording proves containment, rather than ticket errors, refuses it.
    const foreignLog = path.join(replacementRoot, "check.log"), foreignDir = `${foreignLog}.gate`;
    fs.mkdirSync(foreignDir); fs.writeFileSync(foreignLog, "foreign recording must stay unread\n");
    fs.writeFileSync(path.join(foreignDir, "owner.json"), JSON.stringify(recorder));
    fs.writeFileSync(path.join(foreignDir, "completion.json"), JSON.stringify({ recorder, directoryIdentity: physical(foreignDir), deadlineUptimeMs: custodyClock() + 60_000 }));
    fs.writeFileSync(path.join(foreignDir, "exit"), "0\n");
    fs.writeFileSync(release, "ready");
    const heldAnswer = JSON.parse(await held.line);
    expect(await held.closed, held.errors()).toBe(0);
    expect(heldAnswer.success).toBe(false);
    expect(heldAnswer.contentItems[0].text).not.toContain("foreign recording");
    fs.unlinkSync(originalRoot); fs.renameSync(retained, originalRoot);
    fs.writeFileSync(descriptor, JSON.stringify({ ...config, owner }));

    const savedBinding = fs.readFileSync(rootBinding, "utf8");
    const savedRoots = JSON.parse(savedBinding);
    fs.writeFileSync(rootBinding, JSON.stringify({ ...savedRoots, additionalRoots: [gateTool.bindGateCheckRoot(replacementRoot)] }));
    fs.writeFileSync(descriptor, JSON.stringify({ ...config, owner, log: foreignLog }));
    fs.unlinkSync(result);
    const extraSubstitution = launch("host", replacementRoot);
    const extraAnswer = JSON.parse(await extraSubstitution.line);
    expect(await extraSubstitution.closed, extraSubstitution.errors()).toBe(0);
    expect(extraAnswer.success).toBe(false);
    expect(extraAnswer.contentItems[0].text).not.toContain("foreign recording");
    fs.writeFileSync(rootBinding, savedBinding);
    fs.writeFileSync(rootBinding, JSON.stringify({ ...JSON.parse(savedBinding), root: replacementRoot,
      physicalRoot: fs.realpathSync(replacementRoot), rootDirectoryIdentity: physical(replacementRoot) }));
    fs.writeFileSync(descriptor, JSON.stringify({ ...config, owner, log: foreignLog, unavailableLaunchEnvironment: true }));
    fs.unlinkSync(result);
    const unverifiable = launch("host", replacementRoot);
    const unverifiableAnswer = JSON.parse(await unverifiable.line);
    expect(await unverifiable.closed, unverifiable.errors()).toBe(0);
    expect(unverifiableAnswer.success).toBe(false);
    expect(unverifiableAnswer.contentItems[0].text).toContain("verified listener's launch TMPDIR or directory identity proof is unavailable or does not match");
    fs.writeFileSync(descriptor, JSON.stringify({ ...config, owner }));

    fs.writeFileSync(rootBinding, JSON.stringify({ ...JSON.parse(savedBinding), root: replacementRoot }));
    fs.unlinkSync(result);
    const substituted = launch("host", replacementRoot);
    const substitutedAnswer = JSON.parse(await substituted.line);
    expect(await substituted.closed, substituted.errors()).toBe(0);
    expect(substitutedAnswer.success).toBe(false);
    expect(substitutedAnswer.contentItems[0].text).toContain("root=null");

    fs.writeFileSync(rootBinding, savedBinding);
    const redirectedRoot = `${originalRoot}.redirected`;
    fs.renameSync(originalRoot, redirectedRoot);
    fs.symlinkSync(replacementRoot, originalRoot, "dir");
    fs.writeFileSync(rootBinding, JSON.stringify({ ...JSON.parse(savedBinding),
      physicalRoot: fs.realpathSync(replacementRoot), rootDirectoryIdentity: physical(replacementRoot) }));
    fs.writeFileSync(descriptor, JSON.stringify({ ...config, owner, log: foreignLog }));
    fs.unlinkSync(result);
    const coordinated = launch("host", originalRoot);
    const coordinatedAnswer = JSON.parse(await coordinated.line);
    expect(await coordinated.closed, coordinated.errors()).toBe(0);
    expect(coordinatedAnswer.success).toBe(false);
    expect(coordinatedAnswer.contentItems[0].text).not.toContain("foreign recording");
    fs.unlinkSync(originalRoot);
    fs.renameSync(redirectedRoot, originalRoot);

    fs.writeFileSync(rootBinding, savedBinding);
    const missingRecordRedirect = `${originalRoot}.missing-record`;
    fs.renameSync(originalRoot, missingRecordRedirect);
    fs.symlinkSync(replacementRoot, originalRoot, "dir");
    fs.unlinkSync(rootBinding);
    fs.writeFileSync(descriptor, JSON.stringify({ ...config, owner, log: foreignLog }));
    fs.unlinkSync(result);
    const missingRecordSubstitution = launch("host", replacementRoot);
    const missingRecordAnswer = JSON.parse(await missingRecordSubstitution.line);
    expect(await missingRecordSubstitution.closed, missingRecordSubstitution.errors()).toBe(0);
    expect(missingRecordAnswer.success).toBe(false);
    expect(missingRecordAnswer.contentItems[0].text).toContain("verified listener's launch TMPDIR or directory identity proof is unavailable or does not match");
    expect(missingRecordAnswer.contentItems[0].text).not.toContain("foreign recording");
    fs.unlinkSync(originalRoot);
    fs.renameSync(missingRecordRedirect, originalRoot);

    fs.writeFileSync(rootBinding, savedBinding);
    const retainedRoot = `${originalRoot}.retained`;
    fs.renameSync(originalRoot, retainedRoot);
    fs.symlinkSync(replacementRoot, originalRoot, "dir");
    fs.unlinkSync(result);
    const redirected = launch("host", replacementRoot);
    const redirectedAnswer = JSON.parse(await redirected.line);
    expect(await redirected.closed, redirected.errors()).toBe(0);
    expect(redirectedAnswer.success).toBe(false);
    expect(redirectedAnswer.contentItems[0].text).toContain("root=null");
    fs.unlinkSync(originalRoot);
    fs.renameSync(retainedRoot, originalRoot);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise<void>(resolve => child.once("close", () => resolve()))));
    fs.closeSync(address.descriptor);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

for (const fault of ["none", "saved-no-env", "coordinated-root-no-env", "identity", "root", "root-symlink", "proof-changed", "malformed", "symlink", "hardlink", "relative", "unknown", "missing-record-no-identity", "missing-record-substituted", "owner-changed"] as const)
test.skipIf(process.platform === "win32")(`callback root binding survives a new reader and refuses ${fault} proof`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gb-")); fs.chmodSync(root, 0o700);
  const launchRoot = path.join(root, "stage-root"), foreignRoot = path.join(root, "foreign-root");
  fs.mkdirSync(launchRoot); fs.mkdirSync(foreignRoot);
  const address = fixtureSocket(root), { socket, filename } = address;
  const server = net.createServer(connection => connection.end());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600);
  const owner = { endpoint: `codex-unix:${socket}`, process: captureProcessIdentity(process.pid) };
  let recovering = false;
  const readEnv = spyOn(procBackend, "readEnvVar").mockImplementation((_pid, name) => {
    if (name === "TMPDIR") return recovering && ["unknown", "saved-no-env", "coordinated-root-no-env"].includes(fault) ? null : launchRoot;
    if (name === gateTool.GATE_CHECK_ROOT_IDENTITY_ENV)
      return recovering && ["unknown", "saved-no-env", "missing-record-no-identity"].includes(fault) ? null
        : recovering && fault === "proof-changed" ? physical(foreignRoot) : physical(launchRoot);
    return null;
  });
  let restoreProof = () => {};
  try {
    const launchBinding = gateTool.bindGateCheckRoot(launchRoot);
    expect(gateTool.socketGateCheckRoot(owner, launchBinding)).toEqual(launchBinding);
    expect(readEnv).not.toHaveBeenCalled();
    expect(fs.statSync(filename).mode & 0o077).toBe(0);
    recovering = true;
    if (fault === "identity") { const saved = JSON.parse(fs.readFileSync(filename, "utf8")); fs.writeFileSync(filename, JSON.stringify({ ...saved, identity: "stale" })); }
    if (fault === "root") { const saved = JSON.parse(fs.readFileSync(filename, "utf8")); fs.writeFileSync(filename, JSON.stringify({ ...saved, root: foreignRoot })); }
    if (fault === "coordinated-root-no-env") {
      const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
      fs.writeFileSync(filename, JSON.stringify({ ...saved, root: foreignRoot, physicalRoot: fs.realpathSync(foreignRoot), rootDirectoryIdentity: physical(foreignRoot) }));
    }
    if (fault === "root-symlink") {
      fs.renameSync(launchRoot, `${launchRoot}.retained`);
      fs.symlinkSync(foreignRoot, launchRoot, "dir");
    }
    if (fault === "missing-record-substituted") {
      fs.renameSync(launchRoot, `${launchRoot}.retained`);
      fs.symlinkSync(foreignRoot, launchRoot, "dir");
      fs.unlinkSync(filename);
    }
    if (fault === "missing-record-no-identity") fs.unlinkSync(filename);
    if (fault === "proof-changed") {
      const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
      fs.writeFileSync(filename, JSON.stringify({ ...saved, physicalRoot: fs.realpathSync(foreignRoot), rootDirectoryIdentity: physical(foreignRoot) }));
    }
    if (fault === "malformed") fs.writeFileSync(filename, "{}");
    if (fault === "symlink") { fs.renameSync(filename, `${filename}.original`); fs.symlinkSync(`${filename}.original`, filename); }
    if (fault === "hardlink") fs.linkSync(filename, `${filename}.link`);
    if (fault === "relative") { const saved = JSON.parse(fs.readFileSync(filename, "utf8")); fs.writeFileSync(filename, JSON.stringify({ ...saved, root: "relative" })); }
    if (fault === "unknown") fs.unlinkSync(filename);
    if (fault === "owner-changed") {
      const read = wire.readEnvelope;
      const readProof = spyOn(wire, "readEnvelope").mockImplementation(filename => {
        const result = read(filename);
        owner.process.startIdentity = "replaced";
        return result;
      });
      restoreProof = () => readProof.mockRestore();
    }
    expect(gateTool.socketGateCheckRoot(fault === "owner-changed" ? owner : structuredClone(owner))).toEqual(fault === "none" ? gateTool.bindGateCheckRoot(launchRoot) : null);
    if (["unknown", "missing-record-no-identity", "missing-record-substituted"].includes(fault)) {
      expect(readEnv.mock.calls.map(call => call[1])).toContain("TMPDIR");
      expect(readEnv.mock.calls.map(call => call[1]).includes(gateTool.GATE_CHECK_ROOT_IDENTITY_ENV))
        .toBe(fault !== "unknown");
    }
  } finally {
    restoreProof(); readEnv.mockRestore();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.closeSync(address.descriptor);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("fresh socket launch keeps its pre-spawn root when listener environment reads are unavailable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gb-")); fs.chmodSync(root, 0o700);
  const launchRoot = path.join(root, "stage-root"); fs.mkdirSync(launchRoot);
  const address = fixtureSocket(root), { socket } = address;
  const server = net.createServer(connection => connection.end());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600);
  const owner = { endpoint: `codex-unix:${socket}`, process: captureProcessIdentity(process.pid) };
  const readEnv = spyOn(procBackend, "readEnvVar").mockReturnValue(null);
  try {
    const binding = gateTool.bindGateCheckRoot(launchRoot);
    expect(gateTool.socketGateCheckRoot(owner, binding)).toEqual(binding);
    expect(readEnv).not.toHaveBeenCalled();
    expect(fs.existsSync(address.filename)).toBe(true);
  } finally {
    readEnv.mockRestore();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.closeSync(address.descriptor);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const fault of ["none", "saved-substitution", "root-substitution", "invalid-proof", "missing-proof"] as const)
test.skipIf(process.platform === "win32")(`multiple launch roots recover and refuse ${fault}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gr-")); fs.chmodSync(root, 0o700);
  const tmp = path.join(root, "tmp"), scratch = path.join(root, "scratch"), attempt = path.join(root, "attempt"), foreign = path.join(root, "foreign");
  for (const directory of [tmp, scratch, attempt, foreign]) fs.mkdirSync(directory);
  const binding = gateTool.bindGateCheckRoot(tmp, [scratch, attempt]);
  const address = fixtureSocket(root), { socket, filename } = address;
  const server = net.createServer(connection => connection.end());
  const proof = JSON.stringify(binding);
  const readEnv = spyOn(procBackend, "readEnvVar").mockImplementation((_pid, name) => {
    if (name === "TMPDIR") return tmp;
    if (name === gateTool.GATE_CHECK_ROOT_IDENTITY_ENV) return physical(tmp);
    if (name === gateTool.GATE_CHECK_ROOTS_ENV) return fault === "invalid-proof" ? "{}" : fault === "missing-proof" ? null : proof;
    return null;
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    fs.chmodSync(socket, 0o600);
    const owner = { endpoint: `codex-unix:${socket}`, process: captureProcessIdentity(process.pid) };
    expect(gateTool.socketGateCheckRoot(owner, binding)).toEqual(binding);
    if (fault === "saved-substitution") {
      const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
      fs.writeFileSync(filename, JSON.stringify({ ...saved, additionalRoots: [gateTool.bindGateCheckRoot(foreign)] }));
    }
    if (fault === "root-substitution") {
      fs.renameSync(attempt, `${attempt}.retained`); fs.symlinkSync(foreign, attempt, "dir");
    }
    expect(gateTool.socketGateCheckRoot(owner)).toEqual(fault === "none" ? binding : null);
    if (fault === "none") {
      fs.unlinkSync(filename);
      expect(gateTool.socketGateCheckRoot(owner)).toEqual(binding);
    }
  } finally {
    readEnv.mockRestore();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.closeSync(address.descriptor);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
