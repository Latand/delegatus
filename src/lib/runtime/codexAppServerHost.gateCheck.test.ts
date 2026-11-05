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

// Every subprocess is owned by this explicit-file runner and gets only isolated state.
test.skipIf(process.platform !== "linux")("a restarted Viewer waits on the retained stage root with a different or absent TMPDIR", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gc-"));
  const originalRoot = path.join(directory, "stage"), replacementRoot = path.join(directory, "viewer");
  for (const root of [originalRoot, replacementRoot]) fs.mkdirSync(root);
  fs.chmodSync(directory, 0o700);
  const descriptor = path.join(directory, "descriptor.json"), result = path.join(directory, "result.json");
  const log = path.join(originalRoot, "check.log"), ticket = `${log}.gate`;
  fs.mkdirSync(ticket); fs.writeFileSync(log, "stage check finished\n");
  const recorder = cpuOwnerIdentity(process.pid);
  fs.writeFileSync(path.join(ticket, "owner.json"), JSON.stringify(recorder));
  fs.writeFileSync(path.join(ticket, "completion.json"), JSON.stringify({ recorder, directoryIdentity: physical(ticket), deadlineUptimeMs: custodyClock() + 60_000 }));
  fs.writeFileSync(path.join(ticket, "exit"), "37\n");
  const config = { socket: path.join(directory, "rpc.sock"), directory, log, result, events: path.join(directory, "events") };
  fs.writeFileSync(descriptor, JSON.stringify(config));
  const children: ReturnType<typeof spawn>[] = [];
  const launch = (mode: string, temporaryRoot?: string) => {
    const env = { ...process.env, TMPDIR: temporaryRoot };
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

    const rootBinding = path.join(directory, "gate-root.json");
    const savedBinding = fs.readFileSync(rootBinding, "utf8");
    fs.writeFileSync(rootBinding, JSON.stringify({ ...JSON.parse(savedBinding), root: replacementRoot }));
    fs.unlinkSync(result);
    const substituted = launch("host", replacementRoot);
    const substitutedAnswer = JSON.parse(await substituted.line);
    expect(await substituted.closed, substituted.errors()).toBe(0);
    expect(substitutedAnswer.success).toBe(false);
    expect(substitutedAnswer.contentItems[0].text).toContain("root=null");

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
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

for (const fault of ["none", "identity", "root", "root-symlink", "malformed", "symlink", "hardlink", "relative", "unknown", "owner-changed"] as const)
test.skipIf(process.platform === "win32")(`callback root binding survives a new reader and refuses ${fault} proof`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gb-")); fs.chmodSync(root, 0o700);
  const launchRoot = path.join(root, "stage-root"), foreignRoot = path.join(root, "foreign-root");
  fs.mkdirSync(launchRoot); fs.mkdirSync(foreignRoot);
  const socket = path.join(root, "rpc.sock"), filename = path.join(root, "gate-root.json");
  const server = net.createServer(connection => connection.end());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600);
  const owner = { endpoint: `codex-unix:${socket}`, process: captureProcessIdentity(process.pid) };
  const readEnv = spyOn(procBackend, "readEnvVar").mockReturnValue(fault === "unknown" ? null : launchRoot);
  let restoreProof = () => {};
  try {
    expect(gateTool.socketGateCheckRoot(owner, launchRoot)).toBe(launchRoot);
    expect(fs.statSync(filename).mode & 0o077).toBe(0);
    if (fault === "identity") { const saved = JSON.parse(fs.readFileSync(filename, "utf8")); fs.writeFileSync(filename, JSON.stringify({ ...saved, identity: "stale" })); }
    if (fault === "root") { const saved = JSON.parse(fs.readFileSync(filename, "utf8")); fs.writeFileSync(filename, JSON.stringify({ ...saved, root: foreignRoot })); }
    if (fault === "root-symlink") {
      fs.renameSync(launchRoot, `${launchRoot}.retained`);
      fs.symlinkSync(foreignRoot, launchRoot, "dir");
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
    expect(gateTool.socketGateCheckRoot(fault === "owner-changed" ? owner : structuredClone(owner))).toBe(fault === "none" ? launchRoot : null);
    expect(readEnv.mock.calls).toHaveLength(["identity", "malformed", "symlink", "hardlink", "relative"].includes(fault) ? 0 : 1);
  } finally {
    restoreProof(); readEnv.mockRestore();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
