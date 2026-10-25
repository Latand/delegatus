import { AgentRegistry } from "@/lib/agent/registry";
import { expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { statePath } from "@/lib/configDir";
import { hostExitText, observeHostExit, readHostExit, recordHostExit, recordHostStop, withHostStopOrigin } from "./hostExit";
import { terminateStructuredHostTree } from "./structuredHostControl";

for (const mode of ["delegatus", "external"] as const) test(`real host exit persists ${mode} sender and signal across a reader restart`, async () => {
  const child = spawn(process.execPath, ["-e", 'setInterval(()=>{},1000); process.stdout.write("ready\\n")'], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  try {
    await once(child.stdout!, "data");
    const identity = captureProcessIdentity(child.pid!);
    expect(identity.startIdentity).not.toBeNull();
    observeHostExit(child, identity);
    if (mode === "delegatus") {
      const result = await terminateStructuredHostTree({ kind: "structured", pid: child.pid!, startIdentity: identity.startIdentity!,
        bootEpoch: identity.bootEpoch!, engine: "codex", sessionId: "exit-fixture", conversationId: null, seat: false,
        turnBusy: false, owned: false, lastActiveAt: null }, {
        stopOrigin: { path: "retirement", operationId: "retirement-fixture-operation" },
        terminateOwnedHost: async () => false,
        retireRegistryEntry: () => true,
        processGroupId: () => null,
        ppidMap: () => new Map([[child.pid!, 0]]),
        signal: (pid, signal) => {
          expect(readHostExit(identity)?.stop).toMatchObject({ path: "retirement", operationId: "retirement-fixture-operation", signal });
          process.kill(pid, signal);
        },
      });
      expect(result.ok).toBe(true);
    } else child.kill("SIGKILL");
    const [code, signal] = await closed;
    expect(code).toBeNull();
    expect(signal).toBe(mode === "delegatus" ? "SIGTERM" : "SIGKILL");
    const evidence = readHostExit(identity)!;
    expect(evidence.exit).toMatchObject({ code: null, signal });
    expect(evidence.stop?.path ?? null).toBe(mode === "delegatus" ? "retirement" : null);
    const text = hostExitText(evidence);
    expect(text).toContain(`exit: signal ${signal}; `);
    expect(text).toContain(mode === "delegatus" ? "stopped by retirement (retirement-fixture-operation)" : "no Delegatus stop recorded");
    // A new OS process has no in-memory evidence, and must read the same receipt.
    const reader = Bun.spawn([process.execPath, "-e", `import { readHostExit } from ${JSON.stringify(import.meta.path.replace(/\.test\.ts$/, ".ts"))}; console.log(JSON.stringify(readHostExit(${JSON.stringify(identity)})))`],
      { env: process.env, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(reader.stdout).text();
    expect(await reader.exited).toBe(0);
    expect(JSON.parse(output)).toEqual(evidence);
    // Late failure cleanup cannot relabel an external death.
    recordHostStop(identity, "SIGKILL", "late-failure-cleanup");
    expect(readHostExit(identity)).toEqual(evidence);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
});

test("exit receipts retain the latest stop operation and first numeric exit in fixed slots", () => {
  const process = { pid: 2147483000, startIdentity: "fixture-host-exit-bounded", bootEpoch: "fixture-boot" };
  const directory = statePath("host-exits");
  const beforeFiles = new Set(fs.existsSync(directory) ? fs.readdirSync(directory) : []);
  withHostStopOrigin({ path: "recovery", operationId: "recovery-fixture-operation" }, () => recordHostStop(process, "SIGTERM", "fallback"));
  withHostStopOrigin({ path: "kill-action", operationId: "kill-fixture-operation" }, () => recordHostStop(process, "SIGKILL", "fallback"));
  const before = readHostExit(process)!;
  expect(before.stop).toMatchObject({ path: "kill-action", operationId: "kill-fixture-operation", signal: "SIGKILL" });
  recordHostExit(process, 23, null);
  for (let i = 0; i < 20; i++) {
    recordHostStop(process, "SIGKILL", "escalation");
    recordHostExit(process, 23, null);
    recordHostExit(process, null, "SIGKILL");
  }
  expect(readHostExit(process)).toMatchObject({ stop: before.stop, exit: { code: 23, signal: null } });
  expect(hostExitText(readHostExit(process))).toBe("exit: code 23; stopped by kill-action (kill-fixture-operation)");
  expect(fs.readdirSync(directory).filter(file => !beforeFiles.has(file))).toHaveLength(2);
});

for (const sqliteMode of ["off", "sqlite"] as const) test(`retired ${sqliteMode} host rows retain their exit identity after reopening`, () => {
  const process = { pid: 2147482999, startIdentity: "fixture-retired-host", bootEpoch: "fixture-boot" };
  const key = { engine: "codex" as const, sessionId: `retired-exit-${sqliteMode}` };
  const registry = new AgentRegistry(statePath(`host-exit-${sqliteMode}.json`), undefined, undefined, { sqliteMode });
  try {
    registry.upsert({ key, artifactPath: "fixtures/exit.jsonl", cwd: "fixtures", accountId: null, status: "dead", host: null,
      claimEpoch: 1, claimOwner: null, pendingAction: null, structuredHost: { kind: "codex-app-server", process, exitProcess: process,
        endpoint: "stdio:fixture", eventCursor: 0, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
    recordHostExit(process, 23, null);
    expect(registry.terminateStructuredHost(key, process)).toBe(true);
    registry.close();
    const reopened = new AgentRegistry(registry.filename, undefined, undefined, { sqliteMode });
    try {
      const entry = reopened.readOnlySnapshot().entries[`codex:${key.sessionId}`]!;
      expect(entry.structuredHost).toBeNull();
      expect(entry.hostExitProcess).toEqual(process);
      expect(readHostExit(entry.hostExitProcess)?.exit).toMatchObject({ code: 23, signal: null });
    } finally { reopened.close(); }
  } finally { registry.close(); }
});

test("a failed receipt write leaves no temporary record and the exit observer can retry", () => {
  const process = { pid: 2147482997, startIdentity: "fixture-exit-write-failure", bootEpoch: "fixture-boot" };
  const directory = statePath("host-exits");
  fs.mkdirSync(directory, { recursive: true });
  const before = new Set(fs.readdirSync(directory));
  const sync = spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("fixture sync refused"); });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => recordHostStop(process, "SIGTERM", "fixture-stop")).not.toThrow();
    expect(() => recordHostExit(process, null, "SIGKILL")).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(statePath("host-exits")).filter(file => !before.has(file))).toEqual([]);
  } finally { sync.mockRestore(); log.mockRestore(); }
  recordHostExit(process, null, "SIGKILL");
  expect(readHostExit(process)?.exit).toMatchObject({ code: null, signal: "SIGKILL" });
  expect(readHostExit(process)?.stop).toBeNull();
});
