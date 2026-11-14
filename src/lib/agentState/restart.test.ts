import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import type { AgentRegistryEntry } from "@/lib/agent/registry";
import type { AgentProjection, AgentStateMetrics } from "./model";
import type { StructuredHostRetirementReport } from "@/lib/runtime/structuredHostRetirement";
import { FIXTURE_CONVERSATION, type FixtureEngine } from "./testFixture";
import { processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";

interface FixtureAnswer { port: number; ready: boolean; native?: ProcessIdentity; entry: AgentRegistryEntry; projection: AgentProjection; metrics: AgentStateMetrics; report: StructuredHostRetirementReport }
const children: ChildProcess[] = [], roots: string[] = [];
const natives: ProcessIdentity[] = [];
afterEach(async () => {
  for (const child of children.splice(0).reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  for (const identity of natives.splice(0)) {
    if (processIdentityStatus(identity) === "alive") process.kill(identity.pid, "SIGKILL");
    for (let attempt = 0; attempt < 100 && processIdentityStatus(identity) === "alive"; attempt++) await Bun.sleep(5);
    expect(processIdentityStatus(identity)).not.toBe("alive");
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function start(role: string, root: string, engine: FixtureEngine, ...args: string[]) {
  const child = spawn(process.execPath, [path.join(import.meta.dir, "restart.fixture.ts"), role, root, engine, ...args], {
    env: { ...process.env, LLV_STATE_DIR: path.join(root, "state"), HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_RUNTIME_HOST_SOCKET: "", LLV_RUNTIME_EVENTS: "0" },
    stdio: ["pipe", "pipe", "pipe"], detached: true,
  });
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", data => { stderr += String(data); });
  const queued: unknown[] = [], readers: Array<(value: unknown) => void> = [];
  const lines = readline.createInterface({ input: child.stdout! });
  lines.on("line", line => { const value: unknown = JSON.parse(line); const reader = readers.shift(); if (reader) reader(value); else queued.push(value); });
  return { child, send: (line: string) => child.stdin!.write(`${line}\n`), next: () => new Promise<FixtureAnswer>((resolve, reject) => {
    if (queued.length) { resolve(queued.shift() as FixtureAnswer); return; }
    const timer = setTimeout(() => reject(new Error(`fixture ${role} did not answer: ${stderr}`)), 15_000);
    readers.push(value => { clearTimeout(timer); resolve(value as FixtureAnswer); });
  }) };
}
test("Claude tool output converges after the real broker owner exits and native completion arrives", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "central-broker-restart-")); roots.push(root);
  for (const dir of ["state", "home", "config"]) fs.mkdirSync(path.join(root, dir));
  const owner = start("broker-owner", root, "claude");
  const checkpoint = await owner.next();
  expect(checkpoint.ready).toBeTrue();
  natives.push(checkpoint.native!);
  expect(processIdentityStatus(checkpoint.native!)).toBe("alive");
  const exited = once(owner.child, "exit"); owner.child.kill("SIGTERM"); await exited;
  fs.writeFileSync(path.join(root, "allow-terminal"), "go");
  const deadline = performance.now() + 7000;
  while (!fs.existsSync(path.join(root, "terminal-written"))) {
    if (performance.now() > deadline) throw new Error("native terminal handshake expired");
    await Bun.sleep(5);
  }
  const successor = start("successor", root, "claude");
  const repaired = await successor.next();
  expect(repaired.entry.structuredHost!.activeTurnRef).toBeNull();
  expect(repaired.projection.facts.turn).toMatchObject({ determined: true, value: { state: "closed", nativeId: "succession-native-prompt" } });
  expect(repaired.metrics.registryTranscriptDivergencesTotal).toBe(1);
  const stopped = once(successor.child, "exit"); successor.child.kill("SIGTERM"); await stopped;
  const restarted = start("successor", root, "claude");
  const replayed = await restarted.next();
  expect(replayed.entry.structuredHost!.activeTurnRef).toBeNull();
  expect(replayed.metrics.registryTranscriptDivergencesTotal).toBe(1);
}, 30000);
for (const engine of ["codex", "claude", "copilot"] as FixtureEngine[]) {
  test(`${engine}: successor scheduler repairs an ownerless native completion, survives restart, and retires only after the idle bound`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "central-restart-")); roots.push(root);
    for (const dir of ["state", "home", "config"]) fs.mkdirSync(path.join(root, dir));
    const native = start("native", root, engine), socket = await native.next();
    const owner = start("owner", root, engine, String(native.child.pid), String(socket.port));
    expect((await owner.next()).ready).toBe(true);
    const exited = once(owner.child, "exit"); owner.child.kill("SIGTERM"); await exited;
    native.send("end"); expect(await native.next()).toMatchObject({ ended: true, starts: 1 });
    const successor = start("successor-unpublished", root, engine);
    const repaired = await successor.next();
    expect(repaired.entry.structuredHost!.activeTurnRef).toBeNull();
    expect(repaired.projection.verdict.state).toBe("unowned");
    expect(repaired.projection.facts.turn).toMatchObject({ determined: true, value: { state: "closed" } });
    expect(repaired.metrics.registryTranscriptDivergencesTotal).toBe(1);
    expect(repaired.metrics.registryTranscriptDivergencesCurrent).toBe(0);
    expect(repaired.metrics.pendingProjectionPublications).toBe(1);
    successor.send("recent");
    expect((await successor.next()).report.retired).toHaveLength(0);
    const stopped = once(successor.child, "exit"); successor.child.kill("SIGTERM"); await stopped;
    const restarted = start("successor", root, engine);
    const replayed = await restarted.next();
    expect(replayed.metrics.registryTranscriptDivergencesTotal).toBe(1);
    expect(replayed.metrics.pendingProjectionPublications).toBe(0);
    expect(replayed.projection.conversationId).toBe(FIXTURE_CONVERSATION);
    restarted.send("protect");
    const protectedWork = await restarted.next();
    expect(protectedWork.report.retired).toHaveLength(0);
    expect(protectedWork.report.refused.length).toBeGreaterThan(0);
    expect(protectedWork.projection.facts.turn).toMatchObject({ determined: true, value: { state: "closed" } });
    expect(native.child.exitCode).toBeNull();
    restarted.send("retire");
    const retirement = (await restarted.next()).report;
    expect(retirement.failed).toEqual([]);
    expect(retirement.refused).toEqual([]);
    expect(retirement.retired).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "native.jsonl"))).toBe(true);
    expect(native.child.exitCode !== null || native.child.signalCode !== null).toBe(true);
    restarted.send("cycle");
    expect((await restarted.next()).metrics.unownedHosts).toBe(0);
  }, 45_000);
}
