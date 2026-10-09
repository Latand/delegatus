import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";

import * as registryModule from "@/lib/agent/registry";
import { AgentRegistry } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { captureProcessIdentity, systemBootEpoch, type ProcessIdentity } from "@/lib/processIdentity";
import { noteSessionTargets, resetResourcesForTests, type StructuredHostKillRef } from "@/lib/resources";

import { ownFixtureTree, stopFixtureTree, signalFixtureIdentity } from "@/lib/testing/fixtureProcess";

import { POST } from "./route";

/**
 * Every kill here runs against a process tree this file spawned itself: a
 * detached `sh` leading its own process group with two sleeping children under
 * it — the same shape as a host's shell wrapper plus its descendants. No test
 * in this file may reach a real agent host, and every ref is session-less, so
 * nothing here opens the registry or the runtime either.
 */
const fixtures: ChildProcess[] = [];
const ownedIdentities: ProcessIdentity[] = [];

function spawnFixtureTree(): { pid: number; startIdentity: string } {
  const child = ownFixtureTree(spawn("/bin/sh", ["-c", "sleep 30 & sleep 30 & wait"], { detached: true, stdio: "ignore" }));
  fixtures.push(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error("fixture tree did not start");
  const startIdentity = procBackend.processIdentity(pid);
  if (startIdentity === null) throw new Error("fixture tree has no process identity");
  return { pid, startIdentity };
}

async function settle(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

function ref(over: Partial<StructuredHostKillRef> & Pick<StructuredHostKillRef, "pid">): StructuredHostKillRef {
  return {
    kind: "structured",
    startIdentity: "0:unmatched",
    engine: "claude",
    /* No session id: an orphaned host, the class that has no registry row to
       retire — which is exactly what keeps this test off the registry. */
    sessionId: null,
    conversationId: null,
    seat: false,
    turnBusy: false,
    owned: false,
    lastActiveAt: null,
    ...over,
    bootEpoch: over.bootEpoch === undefined ? systemBootEpoch() : over.bootEpoch,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/hosts", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  for (const identity of ownedIdentities.splice(0)) signalFixtureIdentity(identity, "SIGKILL");
  for (const child of fixtures.splice(0)) await stopFixtureTree(child);
  resetResourcesForTests();
});

test("retrying a partial kill uses durable survivors and retires only after the child is gone", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = process.cwd();
  const artifactPath = `/sessions/${sessionId}.jsonl`;
  let childPid = 0;
  const parentScript = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
    "console.log(child.pid);",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const root = ownFixtureTree(spawn(process.execPath, ["-e", parentScript], { detached: true, stdio: ["ignore", "pipe", "ignore"] }));
  fixtures.push(root);
  await new Promise<void>((resolve, reject) => {
    root.once("error", reject);
    root.stdout!.once("data", chunk => { childPid = Number(String(chunk).trim()); resolve(); });
  });
  if (!root.pid || !Number.isSafeInteger(childPid) || childPid <= 1) throw new Error("fixture tree did not start");
  const rootIdentity = captureProcessIdentity(root.pid);
  const childIdentity = captureProcessIdentity(childPid);
  ownedIdentities.push(rootIdentity, childIdentity);
  if (!rootIdentity || !childIdentity) throw new Error("fixture identities could not be captured");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-resource-retry-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const registrySpy = spyOn(registryModule, "agentRegistry").mockReturnValue(registry);
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key, artifactPath, cwd, accountId: "test", status: "live", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: `stdio:${root.pid}`, process: rootIdentity,
      eventCursor: 1, protocolVersion: "fixture", writerClaimEpoch: 1, activeTurnRef: null,
      pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: null, pendingAction: null,
  });
  const target = `structured:codex:${sessionId}`;
  noteSessionTargets([{ target, ref: ref({
    pid: root.pid, startIdentity: rootIdentity.startIdentity!, bootEpoch: rootIdentity.bootEpoch!,
    engine: "codex", sessionId, seat: false, turnBusy: false,
  }) }]);
  const originalKill = process.kill.bind(process);
  let refuseChild = true;
  const signalSpy = spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === childPid && refuseChild && (signal === "SIGTERM" || signal === "SIGKILL")) {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    }
    return originalKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill);
  try {
    const first = await POST(post({ action: "kill", target, intent: "row" }));
    expect(first.status).toBe(500);
    expect(procBackend.pidAlive(root.pid)).toBeFalse();
    expect(procBackend.processIdentity(childPid)).toBe(childIdentity.startIdentity);
    expect(registry.readOnlySnapshot().entries[`codex:${sessionId}`]?.structuredTerminationSurvivors).toContainEqual(childIdentity);

    refuseChild = false;
    const retry = await POST(post({ action: "kill", target, intent: "row" }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, target });
    expect(procBackend.pidAlive(childPid)).toBeFalse();
    expect(registry.readOnlySnapshot().entries[`codex:${sessionId}`]).toMatchObject({
      status: "dead", structuredHost: null, structuredTerminationSurvivors: [],
    });
  } finally {
    signalSpy.mockRestore();
    registrySpy.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

test("a target outside the last snapshot is refused before any signal", async () => {
  const tree = spawnFixtureTree();
  noteSessionTargets([]);

  const response = await POST(post({ action: "kill", target: `structured:pid:${tree.pid}`, intent: "row" }));

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("refresh") });
  expect(procBackend.pidAlive(tree.pid)).toBeTrue();
});

test("a listed target naming the viewer's own process chain is still refused", async () => {
  const identity = procBackend.processIdentity(process.pid) ?? "viewer";
  noteSessionTargets([{ target: "structured:pid:viewer", ref: ref({ pid: process.pid, startIdentity: identity }) }]);

  const response = await POST(post({ action: "kill", target: "structured:pid:viewer", intent: "row" }));

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("viewer") });
});

test("killing a listed host takes the whole tree down and consumes the target", async () => {
  const tree = spawnFixtureTree();
  const target = `structured:pid:${tree.pid}`;
  const descendants = await settle(() => procBackend.ppidMap().size > 0
    && [...procBackend.ppidMap()].filter(([, ppid]) => ppid === tree.pid).length === 2);
  expect(descendants).toBeTrue();
  const children = [...procBackend.ppidMap()].filter(([, ppid]) => ppid === tree.pid).map(([pid]) => pid);
  noteSessionTargets([{ target, ref: ref({ pid: tree.pid, startIdentity: tree.startIdentity }) }]);

  const response = await POST(post({ action: "kill", target, intent: "row" }));

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, target });
  expect(await settle(() => !procBackend.pidAlive(tree.pid))).toBeTrue();
  for (const child of children) {
    expect(await settle(() => !procBackend.pidAlive(child)), `descendant ${child}`).toBeTrue();
  }

  /* The pid is the kernel's to reuse now, so the same POST must not pass again. */
  const replay = await POST(post({ action: "kill", target, intent: "row" }));
  expect(replay.status).toBe(400);
});

test("a live orchestrator seat is only killed when the operator ticks it", async () => {
  const tree = spawnFixtureTree();
  const target = "structured:codex:seat";
  const seat = { target, ref: ref({ pid: tree.pid, startIdentity: tree.startIdentity, engine: "codex", seat: true }) };
  noteSessionTargets([seat]);

  const refused = await POST(post({ action: "kill", target, intent: "all" }));
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: expect.stringContaining("orchestrator seat") });
  expect(procBackend.pidAlive(tree.pid)).toBeTrue();

  const ticked = await POST(post({ action: "kill", target, intent: "all", includeSeat: true }));
  expect(ticked.status).toBe(200);
  expect(await settle(() => !procBackend.pidAlive(tree.pid))).toBeTrue();
});

test("bulk kill refuses a scan-only host whose orchestrator-seat status is unknown", async () => {
  const tree = spawnFixtureTree();
  const target = `structured:pid:${tree.pid}`;
  noteSessionTargets([{
    target,
    ref: ref({
      pid: tree.pid,
      startIdentity: tree.startIdentity,
      seat: null,
      turnBusy: null,
    }),
  }]);

  const response = await POST(post({ action: "kill", target, intent: "all" }));

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("seat status is unknown") });
  expect(procBackend.pidAlive(tree.pid)).toBeTrue();
  expect((await POST(post({ action: "kill", target, intent: "row" }))).status).toBe(200);
});

test("kill idle refuses a host whose idle age cannot be proven at kill time", async () => {
  const tree = spawnFixtureTree();
  const target = `structured:pid:${tree.pid}`;
  /* The snapshot claimed six hours of quiet; nothing on the server can still
     prove it, so the bulk gesture is refused rather than trusted. */
  noteSessionTargets([{
    target,
    ref: ref({
      pid: tree.pid,
      startIdentity: tree.startIdentity,
      lastActiveAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    }),
  }]);

  const response = await POST(post({ action: "kill", target, intent: "idle", idleHours: 2 }));

  expect(response.status).toBe(409);
  expect(procBackend.pidAlive(tree.pid)).toBeTrue();
  /* The row itself is still the operator's to kill explicitly. */
  expect((await POST(post({ action: "kill", target, intent: "row" }))).status).toBe(200);
});

test("an unnamed or out-of-range gesture is refused before the allowlist is consulted", async () => {
  const tree = spawnFixtureTree();
  const target = `structured:pid:${tree.pid}`;
  noteSessionTargets([{ target, ref: ref({ pid: tree.pid, startIdentity: tree.startIdentity }) }]);

  expect((await POST(post({ action: "kill", target, intent: "everything" }))).status).toBe(400);
  expect((await POST(post({ action: "kill", target, intent: "idle" }))).status).toBe(400);
  expect((await POST(post({ action: "kill", target, intent: "idle", idleHours: 0 }))).status).toBe(400);
  expect(procBackend.pidAlive(tree.pid)).toBeTrue();
});

test("a recycled pid fails the process fence instead of killing the new owner", async () => {
  const tree = spawnFixtureTree();
  const target = `structured:pid:${tree.pid}`;
  noteSessionTargets([{ target, ref: ref({ pid: tree.pid, startIdentity: "1:not-this-process" }) }]);

  const response = await POST(post({ action: "kill", target, intent: "row" }));

  expect(response.status).toBe(409);
  expect(procBackend.pidAlive(tree.pid)).toBeTrue();
  /* Its authority is spent: the pid is not the process the snapshot listed. */
  expect((await POST(post({ action: "kill", target, intent: "row" }))).status).toBe(400);
});

test("a pane target cannot be killed through the structured endpoint", async () => {
  noteSessionTargets([{
    target: "agents:4.0",
    ref: { tmuxServerPid: 900, tmuxServerStartIdentity: null, paneId: "%4", panePid: 4_242, paneStartIdentity: null },
  }]);

  const response = await POST(post({ action: "kill", target: "agents:4.0", intent: "row" }));

  expect(response.status).toBe(400);
});

test("a cross-origin kill is refused", async () => {
  const response = await POST(post({ action: "kill", target: "structured:pid:1", intent: "row" }, {
    origin: "https://evil.example",
    "sec-fetch-site": "cross-site",
  }));

  expect(response.status).toBe(403);
});
