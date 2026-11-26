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
import { FileRuntimeEventStore } from "./eventStore";
import { validCodexRequestReceipt } from "./codexRequestReceipt";
import { RuntimeJournal } from "../../runtime-host/journal";
import { projectEngineHostEvent } from "./engineHostEvents";

for (const completion of ["after-reconnect", "during-handover", "dispatch-before-handover", "refused-dispatch-before-handover", "deadline", "changed-ticket", "native-resolved", "native-confirmed", "turn-ended"] as const)
test.skipIf(process.platform !== "linux")(`a pending callback survives a real Viewer restart: ${completion}`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gw-"));
  fs.chmodSync(directory, 0o700);
  const stageRoot = path.join(directory, "stage"), viewerRoot = path.join(directory, "viewer");
  fs.mkdirSync(stageRoot); fs.mkdirSync(viewerRoot);
  const log = path.join(stageRoot, "check.log"), ticket = `${log}.gate`;
  fs.mkdirSync(ticket); fs.writeFileSync(log, "retained result\n");
  const recorder = cpuOwnerIdentity(process.pid), deadlineUptimeMs = custodyClock() + 60_000;
  fs.writeFileSync(path.join(ticket, "owner.json"), JSON.stringify(recorder));
  fs.writeFileSync(path.join(ticket, "completion.json"), JSON.stringify({ recorder, directoryIdentity: physical(ticket), deadlineUptimeMs }));
  const descriptor = path.join(directory, "descriptor.json");
  // The engine is native-faithful: it never confirms an answered dynamic tool
  // call, except where a case opts into a late confirmation.
  const refused = completion === "refused-dispatch-before-handover";
  const config = { socket: path.join(directory, "rpc.sock"), directory, log: refused ? path.join(directory, "foreign.log") : log,
    result: path.join(directory, "result.json"), events: path.join(directory, "events"),
    stop: path.join(directory, "stop"), count: path.join(directory, "count"), noReplay: true, duplicate: true,
    ...(completion === "native-confirmed" ? { confirmResolution: true } : {}) };
  fs.writeFileSync(descriptor, JSON.stringify(config));
  const children: ReturnType<typeof spawn>[] = [];
  const launch = (mode: string, root: string) => {
    const child = spawn(process.execPath, [path.join(import.meta.dir, "fixtures/gateCheckHost.ts"), mode, descriptor], {
      env: { ...process.env, TMPDIR: root, [gateTool.GATE_CHECK_ROOT_IDENTITY_ENV]: physical(root) }, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let errors = "", output = "";
    child.stderr!.on("data", bytes => { errors += String(bytes); });
    const line = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fixture timed out: ${errors}`)), 20_000);
      child.stdout!.on("data", bytes => { output += String(bytes); if (output.includes("\n")) { clearTimeout(timer); resolve(output.trim()); } });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); if (!output.includes("\n")) reject(new Error(`fixture exit ${code}: ${errors}`)); });
    });
    const closed = new Promise<number | null>(resolve => child.once("close", resolve));
    return { child, line, closed, errors: () => errors };
  };
  const stored = () => new FileRuntimeEventStore(config.events).load("gate-reconnect-thread");
  try {
    const engine = launch("engine", stageRoot), owner = JSON.parse(await engine.line);
    fs.writeFileSync(descriptor, JSON.stringify({ ...config, owner }));
    const first = launch(completion === "dispatch-before-handover" || refused ? "crash-dispatch" : "hold", stageRoot);
    // A refusal needs no recording, so it may reach dispatch before the holder reports.
    expect(await first.line).toEqual(refused ? expect.stringMatching(/^(held|dispatched)$/) : "held");
    const pending = stored().find(event => event.kind === "attention" && event.codexReceipt?.gateWait);
    expect(pending?.kind).toBe("attention");
    if (pending?.kind !== "attention") throw new Error("pending receipt absent");
    expect(validCodexRequestReceipt(pending.codexReceipt)).toBe(true);
    expect(pending.codexReceipt?.identity).toMatchObject({ threadId: "gate-reconnect-thread", turnId: "gate-reconnect-turn", requestId: "gate-wait" });
    expect(pending.codexReceipt?.dispatch).toBeUndefined();
    expect(fs.existsSync(config.result)).toBe(false);
    if (refused) expect(pending.codexReceipt?.gateWait?.runId).toBeUndefined();
    if (completion === "dispatch-before-handover") fs.writeFileSync(path.join(ticket, "exit"), "37\n");
    else fs.writeFileSync(config.stop, "detach");
    expect(await first.closed, first.errors()).toBe(0);
    expect(engine.child.exitCode).toBeNull();
    if (completion === "during-handover" || completion === "native-confirmed") fs.writeFileSync(path.join(ticket, "exit"), "37\n");
    if (completion === "changed-ticket") fs.writeFileSync(path.join(ticket, "completion.json"), JSON.stringify({ recorder, directoryIdentity: physical(ticket), deadlineUptimeMs: deadlineUptimeMs + 1000 }));
    fs.writeFileSync(descriptor, JSON.stringify({ ...config, owner,
      ...(completion === "native-resolved" ? { resolveWait: true } : {}),
      ...(completion === "turn-ended" ? { turnEnded: true } : {}),
      ...(completion === "deadline" ? { nowUptime: deadlineUptimeMs + wire.CUSTODY_CLEANUP_MS } : {}) }));
    const storedBefore = stored().filter(event => event.kind === "session-status").length;
    const next = launch(completion === "native-resolved" ? "resolved" : completion === "turn-ended" ? "retired" : "host", viewerRoot);
    if (completion === "after-reconnect") {
      // Completion follows adoption: the successor must have restored the wait.
      const adoption = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { watcher.close(); reject(new Error("successor did not adopt")); }, 15_000);
        const read = () => {
          if (stored().filter(event => event.kind === "session-status").length > storedBefore) { clearTimeout(timer); watcher.close(); resolve(); }
        };
        const watcher = fs.watch(config.events, read);
        read();
      });
      await adoption;
      expect(fs.existsSync(config.result)).toBe(false);
      fs.writeFileSync(path.join(ticket, "exit"), "37\n");
    }
    if (completion === "turn-ended") {
      // The native turn ended during the handover, so its callback is gone: the
      // restored wait retires instead of holding the host's attention set.
      expect(await next.line).toBe("retired");
      expect(await next.closed, next.errors()).toBe(0);
      expect(fs.existsSync(config.count)).toBe(false);
      const retired = stored().filter(event => event.kind === "attention-resolved" && event.codexReceipt?.gateWait);
      expect(retired).toHaveLength(1);
      expect(retired[0]).toMatchObject({ resolution: "host-restarted",
        codexReceipt: { recovery: { outcome: "callback-unavailable", reason: "resumed-without-callback" } } });
      expect(stored().map(event => projectEngineHostEvent("conversation", "codex:gate-reconnect-thread", event))
        .filter(event => event?.kind === "attention" || event?.kind === "attention-resolved")).toEqual([]);
      // The recorder's verdict stays retrievable by run id with no waiter.
      fs.writeFileSync(path.join(ticket, "exit"), "37\n");
      const runId = pending.codexReceipt!.gateWait!.runId!;
      const retained = await gateTool.runGateCheckTool({ log, reason: "read retained run" }, gateTool.bindGateCheckRoot(stageRoot), new AbortController().signal, runId);
      expect(JSON.parse(retained.contentItems[0].text)).toMatchObject({ runId, terminal: true, code: 37 });
      return;
    }
    if (completion === "native-resolved") {
      expect(await next.line).toBe("resolved");
      expect(await next.closed, next.errors()).toBe(0);
      expect(fs.existsSync(config.result)).toBe(false);
      expect(fs.existsSync(config.count)).toBe(false);
      expect(stored().some(event => event.kind === "attention" && event.codexReceipt?.dispatch)).toBe(false);
      expect(stored().some(event => event.kind === "attention-resolved" && event.codexReceipt?.serverResolution?.outcome === "server-resolved")).toBe(true);
      return;
    }
    const result = JSON.parse(await next.line);
    expect(await next.closed, next.errors()).toBe(0);
    expect(fs.readFileSync(config.count, "utf8")).toBe("1");
    const runId = pending.codexReceipt!.gateWait!.runId!;
    // The host's own reply is terminal: native Codex sends no confirmation.
    const settled = stored().filter(event => event.kind === "attention-resolved" && event.codexReceipt?.gateWait);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ resolution: "answered", codexReceipt: { serverResolution: { outcome: "answered" } } });
    if (refused) {
      expect(result.success).toBe(false);
      expect(result.contentItems[0].text).toContain("outside this stage's temporary root");
      expect(settled[0].kind === "attention-resolved" && settled[0].codexReceipt?.gateWait?.result).toEqual(result);
    } else if (completion === "changed-ticket") {
      expect(result.success).toBe(false);
      expect(result.contentItems[0].text).toContain(runId);
      expect(result.contentItems[0].text).toContain("run identity changed");
    } else {
      expect(result.success).toBe(true);
      expect(JSON.parse(result.contentItems[0].text)).toMatchObject(completion === "deadline"
        ? { runId, outcome: "unknown", terminal: false, reason: expect.stringContaining("expired") }
        : { runId, terminal: true, code: 37 });
    }
    const dispatch = stored().find(event => event.kind === "attention" && event.codexReceipt?.dispatch);
    expect(dispatch?.kind === "attention" && validCodexRequestReceipt(dispatch.codexReceipt)).toBe(true);
    // Reopen both durable readers using the writer's actual events.
    let journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
    for (const event of stored()) {
      const projected = projectEngineHostEvent("conversation", "codex:gate-reconnect-thread", event);
      if (projected) journal.append(projected);
    }
    journal.close();
    journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
    // The automatic wait never becomes operator attention, so the session's
    // attention set stays empty and idle continuation and retirement can hold.
    try {
      const snapshot = journal.snapshot();
      expect(snapshot.attentions).toEqual([]);
      expect(snapshot.sessions.flatMap(session => session.attentionIds)).toEqual([]);
    } finally { journal.close(); }
    // Later processes adopt the settled wait: by reconciliation alone, then
    // with the native callback replayed. Neither writes a second response.
    const dispatches = () => stored().filter(event => event.kind === "attention" && event.codexReceipt?.dispatch).length;
    const dispatchedBefore = dispatches();
    for (const replay of [false, true]) {
      fs.writeFileSync(descriptor, JSON.stringify({ ...config, owner, ...(replay ? { forceReplay: true } : {}) }));
      const duplicate = launch("host", viewerRoot);
      expect(JSON.parse(await duplicate.line)).toEqual(result);
      expect(await duplicate.closed, duplicate.errors()).toBe(0);
      expect(fs.readFileSync(config.count, "utf8"), `replay=${replay}`).toBe("1");
    }
    expect(dispatches()).toBe(dispatchedBefore);
    expect(stored().filter(event => event.kind === "attention-resolved" && event.codexReceipt?.gateWait)).toHaveLength(1);
    if (completion !== "changed-ticket" && !refused) {
      fs.writeFileSync(path.join(ticket, "exit"), "37\n");
      const retained = await gateTool.runGateCheckTool({ log, reason: "read retained run" }, gateTool.bindGateCheckRoot(stageRoot), new AbortController().signal, runId);
      expect(JSON.parse(retained.contentItems[0].text)).toMatchObject({ runId, terminal: true, code: 37 });
    }
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise<void>(resolve => child.once("close", () => resolve()))));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);

// Every subprocess is owned by this explicit-file runner and gets only isolated state.
test.skipIf(process.platform !== "linux")("a restarted Viewer waits on the retained stage root with a different or absent TMPDIR", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gc-"));
  const originalRoot = path.join(directory, "stage"), replacementRoot = path.join(directory, "viewer");
  for (const root of [originalRoot, replacementRoot]) fs.mkdirSync(root);
  fs.chmodSync(directory, 0o700);
  const descriptor = path.join(directory, "descriptor.json"), result = path.join(directory, "result.json");
  const rootBinding = path.join(directory, "gate-root.json");
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
    const env = { ...process.env, TMPDIR: temporaryRoot,
      ...(mode === "engine" && temporaryRoot ? { [gateTool.GATE_CHECK_ROOT_IDENTITY_ENV]: physical(temporaryRoot) } : {}) };
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
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

for (const fault of ["none", "saved-no-env", "coordinated-root-no-env", "identity", "root", "root-symlink", "proof-changed", "malformed", "symlink", "hardlink", "relative", "unknown", "missing-record-no-identity", "missing-record-substituted", "owner-changed"] as const)
test.skipIf(process.platform === "win32")(`callback root binding survives a new reader and refuses ${fault} proof`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gb-")); fs.chmodSync(root, 0o700);
  const launchRoot = path.join(root, "stage-root"), foreignRoot = path.join(root, "foreign-root");
  fs.mkdirSync(launchRoot); fs.mkdirSync(foreignRoot);
  const socket = path.join(root, "rpc.sock"), filename = path.join(root, "gate-root.json");
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
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("fresh socket launch keeps its pre-spawn root when listener environment reads are unavailable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gb-")); fs.chmodSync(root, 0o700);
  const launchRoot = path.join(root, "stage-root"); fs.mkdirSync(launchRoot);
  const socket = path.join(root, "rpc.sock");
  const server = net.createServer(connection => connection.end());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600);
  const owner = { endpoint: `codex-unix:${socket}`, process: captureProcessIdentity(process.pid) };
  const readEnv = spyOn(procBackend, "readEnvVar").mockReturnValue(null);
  try {
    const binding = gateTool.bindGateCheckRoot(launchRoot);
    expect(gateTool.socketGateCheckRoot(owner, binding)).toEqual(binding);
    expect(readEnv).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "gate-root.json"))).toBe(true);
  } finally {
    readEnv.mockRestore();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
