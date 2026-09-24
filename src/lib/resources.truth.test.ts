import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import type { ResourceObservation } from "@/lib/resourceCollector";
import { resourceWorkerRequestProblem } from "@/lib/resourceWorkerRequest";
import { overlayResourceSessionTitles } from "@/lib/session/titleProjection";
import type { FileEntry, ResourceSession, ResourcesPayload } from "@/lib/types";

import {
  buildResourceSnapshot,
  createResourcesReader,
  lastResourceBuildDiagnostic,
  parseResourcesFixture,
  resetResourcesForTests,
  resourceWorkerFileHandoff,
  resourceWorkerFileSnapshot,
  type CollectedResources,
  type StructuredHostRecord,
} from "./resources";

/*
 * #2110: the resources tool served a session table last collected on
 * 2026-09-20 as if it were current. Two things were wrong: every collection
 * since then failed, and the fallback that served the old rows said nothing
 * about their age. These tests hold both.
 */

const SESSION_ID = ["11111111", "2222", "4333", "0444", "555555555555"].join("-");
const COPILOT_SESSION_ID = ["21111111", "2222", "4333", "0444", "555555555555"].join("-");
const CLAUDE_PATH = `/home/user/.claude/projects/proj/${SESSION_ID}.jsonl`;
const COPILOT_PATH = `/home/user/.copilot/session-state/${COPILOT_SESSION_ID}/events.jsonl`;
const PHASES = { systemMemory: 0, readFiles: 0, readHosts: 0, ppidMap: 0, processMemory: 0, attach: 0, serialization: 0 };

let stateDir = "";
let cwd = "";
const previousState = process.env.LLV_STATE_DIR;
const children: ChildProcess[] = [];

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-resources-truth-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "llv-resources-truth-cwd-"));
  process.env.LLV_STATE_DIR = stateDir;
  resetResourcesForTests();
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  setAgentRegistryForTests(null);
  resetResourcesForTests();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function file(over: Partial<FileEntry> & Pick<FileEntry, "path">): FileEntry {
  return {
    root: "claude-projects",
    name: over.path,
    project: "proj",
    title: "Auto derived",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_700,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...over,
  } as FileEntry;
}

/** A conversation the way a spawn leaves it: a launch profile with a cwd, which
    is what makes the title overlay attach project metadata to its transcript. */
function spawnedConversation(): void {
  const registry = new AgentRegistry(path.join(stateDir, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd, role: "worker", title: "Lane" });
  const receipt = registry.beginSpawn("claude", cwd, profile);
  registry.completeSpawn(receipt.launchId, {
    key: { engine: "claude", sessionId: SESSION_ID },
    artifactPath: CLAUDE_PATH,
    cwd,
    accountId: "default",
    launchProfile: profile,
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  setAgentRegistryForTests(registry);
}

function sleeper(): { pid: number; startIdentity: string } {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  children.push(child);
  const pid = child.pid!;
  const startIdentity = procBackend.processIdentity(pid);
  if (!startIdentity) throw new Error("sleeper has no start identity");
  return { pid, startIdentity };
}

function copilotHost(pid: number, startIdentity: string): StructuredHostRecord {
  return {
    id: `copilot:${COPILOT_SESSION_ID}`,
    engine: "copilot",
    sessionId: COPILOT_SESSION_ID,
    pid,
    startIdentity,
    bootEpoch: null,
    cwd,
    path: COPILOT_PATH,
    conversationId: null,
    title: "Copilot lane",
    role: "builder",
    model: null,
    stage: null,
    seat: false,
    turnBusy: false,
    owned: true,
  };
}

describe("the collector request the Viewer builds is one the worker accepts (#2110)", () => {
  test("the title overlay's project metadata was the key that refused every request", () => {
    spawnedConversation();
    /* What readResourceFileSnapshot handed over before the fix: the worker
       projection, overlaid in place. */
    const overlaid = resourceWorkerFileSnapshot([file({ path: CLAUDE_PATH })], () => null);
    overlayResourceSessionTitles(overlaid as FileEntry[]);
    expect(Object.keys(overlaid[0]!)).toContain("projectName");
    const request = { type: "collect", fresh: true, files: overlaid, identityEpoch: null, hosts: [] };
    expect(resourceWorkerRequestProblem(request)).toBe("files[0] unexpected key projectName");

    const handedOver = resourceWorkerFileHandoff([file({ path: CLAUDE_PATH })]);
    expect(handedOver[0]!.title).toBe("Lane");
    expect(handedOver[0]!.conversationId).toStartWith("conversation_");
    expect(resourceWorkerRequestProblem({ ...request, files: handedOver })).toBeNull();
  });

  test("a Copilot transcript and a Copilot host are admitted, an unknown engine is named", () => {
    const { pid, startIdentity } = sleeper();
    const files = resourceWorkerFileHandoff([file({ path: COPILOT_PATH, engine: "copilot", root: "copilot-sessions" as FileEntry["root"] })]);
    const request = { type: "collect", fresh: false, files, identityEpoch: null, hosts: [copilotHost(pid, startIdentity)] };
    expect(resourceWorkerRequestProblem(request)).toBeNull();
    expect(resourceWorkerRequestProblem({ ...request, files: [{ ...files[0], engine: "gemini" }] })).toBe("files[0] engine gemini");
    expect(resourceWorkerRequestProblem({ ...request, hosts: [{ ...request.hosts[0], engine: "gemini" }] })).toBe("hosts[0] engine gemini");
  });

  test("the real worker completes a collection over a spawned conversation and a Copilot host", async () => {
    spawnedConversation();
    const { pid, startIdentity } = sleeper();
    const entries = [
      file({ path: CLAUDE_PATH }),
      file({ path: COPILOT_PATH, engine: "copilot", root: "copilot-sessions" as FileEntry["root"], title: "Copilot lane" }),
    ];
    const reader = createResourcesReader(buildResourceSnapshot, () => null, Date.now, lastResourceBuildDiagnostic, {
      initial: null,
      readFiles: async () => resourceWorkerFileHandoff(entries),
      readHostRecords: async () => [copilotHost(pid, startIdentity)],
    });

    const read = await reader.read(true);

    expect(read.diagnostic.failure).toBeUndefined();
    expect(read.diagnostic).toMatchObject({ status: "complete", cache: { status: "miss" } });
    expect(read.payload.sessionsStale).toBe(false);
    expect(read.payload.sessions.find((session) => session.panePid === pid)).toMatchObject({
      kind: "structured",
      engine: "copilot",
      title: "Copilot lane",
    });
  }, 30_000);

  test("a request that drifts from the contract is refused before spawn and logged with its cause", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const reader = createResourcesReader(buildResourceSnapshot, () => null, Date.now, lastResourceBuildDiagnostic, {
        initial: null,
        readFiles: async () => [{ ...resourceWorkerFileHandoff([file({ path: CLAUDE_PATH })])[0]!, projectName: "proj" }],
        readHostRecords: async () => [],
      });
      const read = await reader.read(true);
      expect(read.diagnostic).toMatchObject({ status: "failed", degradedReason: "collector-crash", failure: { cause: "worker-input" } });
      expect(read.diagnostic.failure?.message).toContain("files[0] unexpected key projectName");
      const logged = errors.mock.calls.map((call) => String(call[0])).find((line) => line.startsWith("[resources] collection"));
      expect(logged).toContain("collector-crash, worker-input");
      expect(logged).toContain("files[0] unexpected key projectName");
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the session table carries its own capture time (#2110)", () => {
  const row: ResourceSession = {
    target: "structured:claude:lane", panePid: 4_100, kind: "structured", path: CLAUDE_PATH, engine: "claude",
    title: "Lane", project: "proj", activity: "idle", lastActiveAt: "2026-09-20T08:00:00.000Z", cwd: "/repo",
    rssBytes: 1_024, swapBytes: 0, procCount: 1,
  };
  const diagnostic = { fresh: true, status: "complete" as const, durationMs: 0, phases: PHASES };
  const DAY = 86_400_000;

  function inProcessReader(options: {
    clock: { now: number };
    build: () => ResourcesPayload;
    initial?: ResourceObservation<CollectedResources> | null;
  }) {
    return createResourcesReader(async () => options.build(), () => null, () => options.clock.now, () => diagnostic, {
      inProcess: true,
      collectorId: "in-process:test",
      initial: options.initial ?? null,
      persist: () => true,
    });
  }

  test("a refresh that fails serves the earlier rows stamped with their capture time and stale", async () => {
    const clock = { now: Date.parse("2026-09-20T10:39:02.000Z") };
    let fail = false;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const reader = inProcessReader({ clock, build: () => {
        if (fail) throw new Error("collector exploded");
        return { system: null, sessions: [row] };
      } });

      const first = await reader.read(true);
      expect(first.payload).toMatchObject({ sessions: [row], sessionsCapturedAt: "2026-09-20T10:39:02.000Z", sessionsStale: false });

      fail = true;
      clock.now += 4 * DAY;
      const fallback = await reader.read(true);
      expect(fallback.diagnostic).toMatchObject({ status: "failed", degradedReason: "collector-crash" });
      expect(fallback.payload).toMatchObject({ sessions: [row], sessionsCapturedAt: "2026-09-20T10:39:02.000Z", sessionsStale: true });
      /* The polled read that follows keeps serving the failure's stamp too. */
      const polled = await reader.read();
      expect(polled.payload.sessionsStale).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  test("a durable capture from days ago is stale even before its revalidation fails", async () => {
    const completedAt = Date.parse("2026-09-20T10:39:02.000Z");
    const clock = { now: completedAt + 4 * DAY };
    const reader = inProcessReader({
      clock,
      build: () => new Promise<never>(() => {}) as never,
      initial: {
        generation: 2_106,
        startedAt: completedAt - 1_000,
        completedAt,
        collectorId: "worker:earlier-process",
        value: { payload: { system: null, sessions: [row] }, diagnostic, hostCount: 1, treeCount: 1, targets: [] },
      },
    });

    const read = await reader.read();
    expect(read.diagnostic.cache.status).toBe("durable");
    expect(read.payload).toMatchObject({ sessions: [row], sessionsCapturedAt: "2026-09-20T10:39:02.000Z", sessionsStale: true });
  });

  test("a capture inside the cache window is current", async () => {
    const clock = { now: 1_000_000 };
    const reader = inProcessReader({ clock, build: () => ({ system: null, sessions: [row] }) });
    await reader.read(true);
    clock.now += 60_000;
    expect((await reader.read()).payload).toMatchObject({ sessionsCapturedAt: new Date(1_000_000).toISOString(), sessionsStale: false });
  });

  test("with no collection at all the empty table is marked stale", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const reader = inProcessReader({ clock: { now: 1_000 }, build: () => { throw new Error("no collector"); } });
      const read = await reader.read(true);
      expect(read.payload).toMatchObject({ sessions: [], sessionsCapturedAt: null, sessionsStale: true });
    } finally {
      errors.mockRestore();
    }
  });
});

test("a fixture may list rows, the table's stamp and the Viewer section", () => {
  const fixture = {
    system: { ramTotal: 10, ramAvailable: 5, swapTotal: 2, swapUsed: 1, capturedAt: "2100-01-02T12:00:00.000Z" },
    sessions: [{
      target: "structured:claude:lane", panePid: 4_100, kind: "structured", path: null, engine: "copilot", title: "Lane",
      project: null, activity: "idle", lastActiveAt: null, cwd: null, rssBytes: 1, swapBytes: 0, procCount: 1,
    }],
    sessionsCapturedAt: "2100-01-01T12:00:00.000Z",
    sessionsStale: true,
    viewer: {
      actionable: false, capturedAt: "2100-01-02T12:00:00.000Z", rssBytes: 3, swapBytes: 0, procCount: 2,
      processes: [
        { pid: 10, role: "server", name: "next", rssBytes: 2, swapBytes: 0, procCount: 1 },
        { pid: 11, role: "worker", name: "filesResponse.worker", rssBytes: 1, swapBytes: 0, procCount: 1 },
      ],
    },
  };
  expect(parseResourcesFixture(JSON.stringify(fixture))).toEqual(fixture as ResourcesPayload);
  expect(() => parseResourcesFixture(JSON.stringify({ ...fixture, viewer: { ...fixture.viewer, actionable: true } }))).toThrow("viewer");
  expect(() => parseResourcesFixture(JSON.stringify({ ...fixture, sessionsStale: "yes" }))).toThrow("sessionsStale");
});
