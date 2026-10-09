import { captureProcessIdentity, type ProcessIdentity } from "@/lib/processIdentity";
import { signalFixtureIdentity, stopFixtureIdentity, stopFixtureProcess } from "@/lib/testing/fixtureProcess";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { AgentRegistry, type ConversationObservation } from "@/lib/agent/registry";
import { setBoardFileForTests } from "@/lib/board/store";
import { procBackend } from "@/lib/proc";
import { activityVerdict, transcriptTurnResult } from "@/lib/scanner/activity";
import type { FileEntry } from "@/lib/types";

import { advanceConversationMigration, reconcileMigrationInventory } from "./coordinator";
import { emptyLaunchProfile, type SuccessorProviderPort } from "./contracts";

type Engine = "claude" | "codex";

const sandboxes: string[] = [];
/** Original start/boot identities, registered before readiness waits. */
const startedIdentities: ProcessIdentity[] = [];
const startedChildren: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  setBoardFileForTests(null);
  for (const child of startedChildren.splice(0)) await stopFixtureProcess(child);
  for (const identity of startedIdentities.splice(0).reverse()) await stopFixtureIdentity(identity);
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandboxRegistry(): { registry: AgentRegistry; sandbox: string } {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-turn-authority-"));
  sandboxes.push(sandbox);
  setBoardFileForTests(path.join(sandbox, "board.json"));
  return { registry: new AgentRegistry(path.join(sandbox, "registry.json")), sandbox };
}

function observation(engine: Engine, pathname: string, state: "busy" | "terminal"): ConversationObservation {
  return {
    engine,
    path: pathname,
    accountId: "limited",
    launchProfile: emptyLaunchProfile({ cwd: path.dirname(pathname), project: "repo" }),
    turn: {
      state,
      source: "lifecycle",
      terminalAt: state === "terminal" ? "2026-09-01T10:00:01.000Z" : null,
    },
    observedAt: "2026-09-01T10:00:02.000Z",
  };
}

function countingProvider(successorPath: string): SuccessorProviderPort & { created: number } {
  const port = {
    virtualSource: true as const,
    created: 0,
    async create(input: Parameters<SuccessorProviderPort["create"]>[0]) {
      port.created += 1;
      return {
        operationId: input.operationId,
        nativeId: path.basename(successorPath, ".jsonl"),
        path: successorPath,
        continuityPaths: [],
        historyHash: "history-successor",
        host: { kind: "codex-app-server" as const, identity: "host-successor", epoch: 1, verifiedAt: "2026-09-01T10:01:00.000Z" },
      };
    },
    async verify() {},
  };
  return port;
}

function writeTranscript(pathname: string, records: Record<string, unknown>[], ageSeconds = 0): void {
  fs.writeFileSync(pathname, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  if (ageSeconds > 0) {
    const at = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(pathname, at, at);
  }
}

/** The scanner's own entry for a transcript: activity comes from the real
    activity projection, never from a word the test chose. */
function scannedEntry(engine: Engine, pathname: string): FileEntry {
  const stat = fs.statSync(pathname);
  const root = engine === "codex" ? "codex-sessions" : "claude-projects";
  const verdict = activityVerdict(root, pathname, stat.mtimeMs / 1000, stat.size);
  return {
    path: pathname,
    root,
    name: path.basename(pathname),
    project: "repo",
    title: path.basename(pathname),
    engine,
    kind: "session",
    fmt: engine,
    parent: null,
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
    activity: verdict.state,
    activityReason: verdict.reason,
    derivationComplete: verdict.complete,
    proc: null,
    pid: null,
    model: "model",
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

/** A structured host row. `alive` backs it with this test process, whose start
    identity verifies; otherwise the recorded identity matches no process. A
    `process` given outright is recorded as it is. */
function registerStructuredHost(
  registry: AgentRegistry,
  engine: Engine,
  sessionId: string,
  pathname: string,
  options: { alive: boolean; activeTurnRef: string | null; process?: { pid: number; startIdentity: string } },
): void {
  const identity = procBackend.processIdentity(process.pid);
  if (!identity) throw new Error("expected this process to have a start identity");
  registry.upsert({
    key: { engine, sessionId },
    artifactPath: pathname,
    cwd: path.dirname(pathname),
    accountId: "limited",
    status: "live",
    host: null,
    structuredHost: {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      endpoint: "stdio:host",
      process: options.process ?? { pid: process.pid, startIdentity: options.alive ? identity : `${identity}:gone` },
      eventCursor: 1,
      protocolVersion: "v1",
      writerClaimEpoch: 1,
      activeTurnRef: options.activeTurnRef,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "test-owner",
    pendingAction: null,
  });
}

/** A transcript whose last record ends the PREVIOUS turn: what the file holds
    between a host taking the next turn and the CLI journaling its prompt. */
function previousTurnEnded(engine: Engine): Record<string, unknown>[] {
  return engine === "codex"
    ? [
        { type: "event_msg", timestamp: "2026-09-01T10:00:00.000Z", payload: { type: "task_started", turn_id: "turn-previous" } },
        { type: "event_msg", timestamp: "2026-09-01T10:00:01.000Z", payload: { type: "task_complete", turn_id: "turn-previous" } },
      ]
    : [
        { type: "user", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "go" }] } },
        {
          type: "assistant",
          timestamp: "2026-09-01T10:00:01.000Z",
          message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
        },
      ];
}

describe.each(["claude", "codex"] as const)("a %s host inside a turn outranks the transcript's previous terminal record", (engine) => {
  function fixture(host: { alive: boolean; activeTurnRef: string | null }) {
    const { registry, sandbox } = sandboxRegistry();
    const pathname = path.join(sandbox, `${engine}-source.jsonl`);
    writeTranscript(pathname, previousTurnEnded(engine));
    registry.reconcileConversations([observation(engine, pathname, "terminal")]);
    const conversation = registry.conversationForPath(pathname)!;
    const sessionId = conversation.generations[0]!.id;
    registerStructuredHost(registry, engine, sessionId, pathname, host);
    registry.requestConversationReseat(conversation.id, "healthy");
    return { registry, sandbox, pathname, conversationId: conversation.id, sessionId };
  }

  test("the reseat waits while the live host holds an active turn, and proceeds once the host reports it over", async () => {
    const { registry, sandbox, pathname, conversationId, sessionId } = fixture({ alive: true, activeTurnRef: "turn-next" });
    const stat = fs.statSync(pathname);
    expect(transcriptTurnResult(pathname, stat.size, stat.mtimeMs, engine).turn.state).toBe("terminal");
    const provider = countingProvider(path.join(sandbox, "successor.jsonl"));

    await advanceConversationMigration(conversationId, registry, provider);

    expect(provider.created).toBe(0);
    expect(registry.conversation(conversationId)?.migration?.phase).not.toBe("committed");
    expect(registry.conversation(conversationId)?.generations).toHaveLength(1);

    registerStructuredHost(registry, engine, sessionId, pathname, { alive: true, activeTurnRef: null });
    await advanceConversationMigration(conversationId, registry, provider);

    expect(provider.created).toBe(1);
    expect(registry.conversation(conversationId)?.migration?.phase).toBe("committed");
  });

  test("a host row whose process is gone holds nothing open: the terminal transcript releases the reseat", async () => {
    const { registry, sandbox, conversationId } = fixture({ alive: false, activeTurnRef: "turn-next" });
    const provider = countingProvider(path.join(sandbox, "successor.jsonl"));

    await advanceConversationMigration(conversationId, registry, provider);

    expect(provider.created).toBe(1);
    expect(registry.conversation(conversationId)?.migration?.phase).toBe("committed");
  });
});

/** A real process that has exited and that nobody has collected. The shell
    starts it, prints its pid and replaces itself with a `sleep` that never
    waits, so once the child is stopped it stays unreaped until the test ends
    its parent. Its identity is recorded while it still runs, as a host's is. */
async function exitedUnreapedProcess(): Promise<{ pid: number; startIdentity: string }> {
  const parent = spawn("sh", ["-c", "sleep 300 & echo $!; exec sleep 300"], { stdio: ["ignore", "pipe", "ignore"] });
  startedChildren.push(parent);
  startedIdentities.push(captureProcessIdentity(parent.pid!));
  const pid = await new Promise<number>((resolve, reject) => {
    let out = "";
    parent.stdout!.on("data", (chunk) => {
      out += String(chunk);
      if (out.includes("\n")) resolve(Number(out.trim()));
    });
    parent.once("error", reject);
    parent.once("exit", () => reject(new Error("the parent exited before naming its child")));
  });
  const identity = captureProcessIdentity(pid);
  startedIdentities.push(identity);
  const startIdentity = procBackend.processIdentity(pid);
  if (!startIdentity) throw new Error("expected the child to have a start identity");
  signalFixtureIdentity(identity, "SIGKILL");
  const deadline = Date.now() + 5_000;
  while (!procBackend.processExited(pid)) {
    if (Date.now() > deadline) throw new Error("the child never reached its exited state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { pid, startIdentity };
}

/* A host that exited keeps its pid and start identity until its parent
   collects it. An inventory read in that window sees the row's process verify
   and its turn still named, though nothing can end that turn any more. */
describe.skipIf(process.platform === "win32").each(["claude", "codex"] as const)(
  "a %s host that exited and is not yet reaped holds nothing open",
  (engine) => {
    test("the terminal transcript releases the reseat while the exited host's identity still verifies", async () => {
      const { registry, sandbox } = sandboxRegistry();
      const pathname = path.join(sandbox, `${engine}-unreaped.jsonl`);
      writeTranscript(pathname, previousTurnEnded(engine));
      registry.reconcileConversations([observation(engine, pathname, "terminal")]);
      const conversation = registry.conversationForPath(pathname)!;
      const exited = await exitedUnreapedProcess();
      registerStructuredHost(registry, engine, conversation.generations[0]!.id, pathname, {
        alive: true,
        activeTurnRef: "turn-next",
        process: exited,
      });
      registry.requestConversationReseat(conversation.id, "healthy");
      const provider = countingProvider(path.join(sandbox, "successor.jsonl"));

      expect(procBackend.processIdentity(exited.pid)).toBe(exited.startIdentity);
      expect(procBackend.pidAlive(exited.pid)).toBe(true);
      expect(procBackend.processExited(process.pid)).toBe(false);
      await advanceConversationMigration(conversation.id, registry, provider);

      expect(provider.created).toBe(1);
      expect(registry.conversation(conversation.id)?.migration?.phase).toBe("committed");
    });
  },
);

/** A turn that opened and never closed: what a session that died mid-turn
    leaves behind, and what a resumed host has not appended to yet. */
function turnLeftOpen(engine: Engine): Record<string, unknown>[] {
  return engine === "codex"
    ? [{ type: "event_msg", timestamp: "2026-09-01T10:00:00.000Z", payload: { type: "task_started", turn_id: "turn-previous" } }]
    : [
        { type: "user", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "go" }] } },
        {
          type: "assistant",
          timestamp: "2026-09-01T10:00:01.000Z",
          message: { role: "assistant", model: "claude-opus-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu-one", name: "Read", input: {} }] },
        },
      ];
}

/* The dead-turn rule releases a stalled transcript while no host exists, and
   that release is cached against the file's size and mtime. A host that then
   takes a turn has not written yet, so the cached release still matches. */
describe.each(["claude", "codex"] as const)("a %s host inside a turn outranks a composer release cached before it started", (engine) => {
  async function fixture(host: { alive: boolean; activeTurnRef: string | null }) {
    const { registry, sandbox } = sandboxRegistry();
    const pathname = path.join(sandbox, `${engine}-released.jsonl`);
    writeTranscript(pathname, turnLeftOpen(engine), 600);
    registry.reconcileConversations([observation(engine, pathname, "busy")]);
    const conversation = registry.conversationForPath(pathname)!;
    const sessionId = conversation.generations[0]!.id;

    const entry = scannedEntry(engine, pathname);
    expect(entry).toMatchObject({ activity: "stalled", activityReason: "jsonl_turn_stalled" });
    await reconcileMigrationInventory(registry, [entry]);
    const stat = fs.statSync(pathname);
    expect(transcriptTurnResult(pathname, stat.size, stat.mtimeMs, engine).composerReleased).toBe(true);
    expect(registry.conversation(conversation.id)?.turn.state).toBe("idle");

    registerStructuredHost(registry, engine, sessionId, pathname, host);
    registry.requestConversationReseat(conversation.id, "healthy");
    return { registry, pathname, conversationId: conversation.id, sessionId, provider: countingProvider(path.join(sandbox, "successor.jsonl")) };
  }

  test("the reseat waits while the live host holds an active turn, and proceeds once the host reports it over", async () => {
    const { registry, pathname, conversationId, sessionId, provider } = await fixture({ alive: true, activeTurnRef: "turn-next" });

    await advanceConversationMigration(conversationId, registry, provider);

    expect(provider.created).toBe(0);
    expect(registry.conversation(conversationId)?.migration?.phase).not.toBe("committed");
    expect(registry.conversation(conversationId)?.generations).toHaveLength(1);

    registerStructuredHost(registry, engine, sessionId, pathname, { alive: true, activeTurnRef: null });
    await advanceConversationMigration(conversationId, registry, provider);

    expect(provider.created).toBe(1);
    expect(registry.conversation(conversationId)?.migration?.phase).toBe("committed");
  });

  test("a live host at its composer leaves the cached release standing", async () => {
    const { registry, conversationId, provider } = await fixture({ alive: true, activeTurnRef: null });

    await advanceConversationMigration(conversationId, registry, provider);

    expect(provider.created).toBe(1);
    expect(registry.conversation(conversationId)?.migration?.phase).toBe("committed");
  });

  test("a host row whose process is gone holds nothing open: the cached release still frees the reseat", async () => {
    const { registry, conversationId, provider } = await fixture({ alive: false, activeTurnRef: "turn-next" });

    await advanceConversationMigration(conversationId, registry, provider);

    expect(provider.created).toBe(1);
    expect(registry.conversation(conversationId)?.migration?.phase).toBe("committed");
  });
});

/** The three record shapes the CLI stamps `stop_sequence` on by itself. */
const cliAuthoredStops: { name: string; record: Record<string, unknown> }[] = [
  { name: "a server_error API error", record: { isApiErrorMessage: true, error: "server_error" } },
  { name: "an unknown API error", record: { isApiErrorMessage: true, error: "unknown" } },
  { name: "a synthetic record that is no API error", record: {} },
];

function claudeOpenTurnEndingOn(extra: Record<string, unknown>): Record<string, unknown>[] {
  return [
    { type: "user", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    {
      type: "assistant",
      timestamp: "2026-09-01T10:00:01.000Z",
      message: { role: "assistant", model: "claude-opus-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu-one", name: "Read", input: {} }] },
    },
    { type: "user", timestamp: "2026-09-01T10:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-one", content: "ok" }] } },
    {
      type: "assistant",
      timestamp: "2026-09-01T10:00:03.000Z",
      ...extra,
      message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence", stop_sequence: "", content: [{ type: "text", text: "API Error: fixture" }] },
    },
  ];
}

describe.each(cliAuthoredStops)("a Claude turn ending on $name stays open on both axes", ({ record }) => {
  test("the activity projection and the migration projection read the same open turn", () => {
    const { sandbox } = sandboxRegistry();
    const pathname = path.join(sandbox, "claude-open.jsonl");
    writeTranscript(pathname, claudeOpenTurnEndingOn(record));
    const stat = fs.statSync(pathname);

    const migration = transcriptTurnResult(pathname, stat.size, stat.mtimeMs, "claude", true).turn;
    const activity = transcriptTurnResult(pathname, stat.size, stat.mtimeMs, "claude", false).turn;

    expect(migration).toEqual({ state: "busy", source: "assistant", terminalAt: null });
    expect(activity).toEqual(migration);
    expect(activityVerdict("claude-projects", pathname, stat.mtimeMs / 1000, stat.size)).toMatchObject({
      state: "live",
      reason: "jsonl_turn_open",
    });
  });

  test("a live host keeps the reseat waiting on it", async () => {
    const { registry, sandbox } = sandboxRegistry();
    const pathname = path.join(sandbox, "claude-hosted.jsonl");
    writeTranscript(pathname, claudeOpenTurnEndingOn(record));
    registry.reconcileConversations([observation("claude", pathname, "busy")]);
    const conversation = registry.conversationForPath(pathname)!;
    registerStructuredHost(registry, "claude", conversation.generations[0]!.id, pathname, { alive: true, activeTurnRef: "turn-retrying" });
    expect(registry.requestConversationReseat(conversation.id, "healthy").migration?.phase).toBe("waiting-turn");
    const provider = countingProvider(path.join(sandbox, "successor.jsonl"));

    await reconcileMigrationInventory(registry, [scannedEntry("claude", pathname)]);
    await advanceConversationMigration(conversation.id, registry, provider);

    expect(registry.conversation(conversation.id)?.turn.state).toBe("busy");
    expect(provider.created).toBe(0);
    expect(registry.conversation(conversation.id)?.migration?.phase).toBe("waiting-turn");
  });

  /* The retry that never came. No process and no registered host can append
     to the file, so once it has aged past the stall threshold the turn is
     released the way every other dead open turn is. */
  test("with no host left, the stalled turn releases the reseat", async () => {
    const { registry, sandbox } = sandboxRegistry();
    const pathname = path.join(sandbox, "claude-abandoned.jsonl");
    writeTranscript(pathname, claudeOpenTurnEndingOn(record), 600);
    registry.reconcileConversations([observation("claude", pathname, "busy")]);
    const conversation = registry.conversationForPath(pathname)!;
    expect(registry.requestConversationReseat(conversation.id, "healthy").migration?.phase).toBe("waiting-turn");
    const provider = countingProvider(path.join(sandbox, "successor.jsonl"));

    const entry = scannedEntry("claude", pathname);
    expect(entry).toMatchObject({ activity: "stalled", activityReason: "jsonl_turn_stalled" });
    await reconcileMigrationInventory(registry, [entry]);
    await advanceConversationMigration(conversation.id, registry, provider);

    expect(provider.created).toBe(1);
    expect(registry.conversation(conversation.id)?.migration?.phase).toBe("committed");
  });
});

/* Codex has one projection, and it closes a turn on a lifecycle record only.
   An error event inside a turn is neither a lifecycle record nor a tool, so
   the defect has no Codex form. These hold on the code as it was. */
describe("a Codex turn that reported an error and has not ended stays open", () => {
  const records = [
    { type: "event_msg", timestamp: "2026-09-01T10:00:00.000Z", payload: { type: "task_started", turn_id: "turn-one" } },
    { type: "event_msg", timestamp: "2026-09-01T10:00:01.000Z", payload: { type: "stream_error", message: "fixture: retrying" } },
    { type: "event_msg", timestamp: "2026-09-01T10:00:02.000Z", payload: { type: "error", message: "fixture: server error" } },
  ];

  test("both projections read the open turn", () => {
    const { sandbox } = sandboxRegistry();
    const pathname = path.join(sandbox, "codex-open.jsonl");
    writeTranscript(pathname, records);
    const stat = fs.statSync(pathname);

    const migration = transcriptTurnResult(pathname, stat.size, stat.mtimeMs, "codex", true).turn;

    expect(migration).toEqual({ state: "busy", source: "lifecycle", terminalAt: null });
    expect(transcriptTurnResult(pathname, stat.size, stat.mtimeMs, "codex", false).turn).toEqual(migration);
  });

  test("a live host keeps the reseat waiting on it", async () => {
    const { registry, sandbox } = sandboxRegistry();
    const pathname = path.join(sandbox, "codex-hosted.jsonl");
    writeTranscript(pathname, records);
    registry.reconcileConversations([observation("codex", pathname, "busy")]);
    const conversation = registry.conversationForPath(pathname)!;
    registerStructuredHost(registry, "codex", conversation.generations[0]!.id, pathname, { alive: true, activeTurnRef: "turn-one" });
    expect(registry.requestConversationReseat(conversation.id, "healthy").migration?.phase).toBe("waiting-turn");
    const provider = countingProvider(path.join(sandbox, "successor.jsonl"));

    await reconcileMigrationInventory(registry, [scannedEntry("codex", pathname)]);
    await advanceConversationMigration(conversation.id, registry, provider);

    expect(provider.created).toBe(0);
    expect(registry.conversation(conversation.id)?.migration?.phase).toBe("waiting-turn");
  });

  test("with no host left, the stalled turn releases the reseat", async () => {
    const { registry, sandbox } = sandboxRegistry();
    const pathname = path.join(sandbox, "codex-abandoned.jsonl");
    writeTranscript(pathname, records, 600);
    registry.reconcileConversations([observation("codex", pathname, "busy")]);
    const conversation = registry.conversationForPath(pathname)!;
    expect(registry.requestConversationReseat(conversation.id, "healthy").migration?.phase).toBe("waiting-turn");
    const provider = countingProvider(path.join(sandbox, "successor.jsonl"));

    await reconcileMigrationInventory(registry, [scannedEntry("codex", pathname)]);
    await advanceConversationMigration(conversation.id, registry, provider);

    expect(provider.created).toBe(1);
    expect(registry.conversation(conversation.id)?.migration?.phase).toBe("committed");
  });
});
