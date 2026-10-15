import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { RuntimeJournal } from "@/runtime-host/journal";
import { RuntimeHost } from "@/runtime-host/host";
import { serveRuntimeHost } from "@/runtime-host/socket";
import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { productionDeps } from "@/lib/selfUpdate/instance";
import { probeQuiet } from "@/lib/selfUpdate/quiet";
import type { Snapshot } from "@/lib/selfUpdate/types";
import { defaultPipelinePorts } from "./engine";
import { publishTitleUpdate } from "@/lib/session/titleEvents";

test.each([false, true])("production activity and owner admission preserve alias rows with an old host: %s", async legacy => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-alias-"));
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"));
  const host = new RuntimeHost(journal);
  const socketPath = path.join(root, "host.sock");
  const server = serveRuntimeHost(socketPath, { handle: request => host.handle(legacy && request.method === "snapshot"
    ? { ...request, params: { voiceBodiesFor: [] } } : request) });
  const prior = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
  try {
    await once(server, "listening");
    const client = new UnixRuntimeHostClient(socketPath);
    for (const [firstTurn, lastTurn, active] of [["running", "idle", true], ["idle", "running", null]] as const) {
      for (const [id, turn] of [["a-legacy-slot", firstTurn], ["published-session", lastTurn]] as const) {
        journal.append({ scope: { type: "session", id }, kind: "session-status",
          payload: { conversationId: "published-session", sessionKey: { engine: "codex", sessionId: id },
            hostKind: "codex-app-server", host: "hosted", turn, attentionIds: [] },
        });
      }
      const full = await client.snapshot();
      expect(full.sessions.map(row => row.sessionKey.sessionId)).toEqual(["a-legacy-slot", "published-session"]);
      expect(full.sessions.map(row => row.turn)).toEqual([firstTurn, lastTurn]);
      expect(await defaultPipelinePorts().conversationAgentActive("published-session")).toBe(active);
      expect((await client.readSnapshot("activity", ["published-session"])).sessions.map(row => row.turn))
        .toEqual(full.sessions.map(row => row.turn));

      const quiet = { ...productionDeps().quiet!, pipelines: () => [], flows: () => [], seats: () => [],
        presence: () => [], registryHealth: () => [], memoryAvailableMb: () => 8_192 };
      const status = { busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot;
      const expected = await probeQuiet(status, { ...quiet, runtimeSnapshot: async () => full }, 1_000, true);
      expect(expected.blockers.unreadable).toBeNull();
      expect(expected.blockers.turns).toBe(1);
      const owners = await quiet.runtimeSnapshot();
      expect(owners.sessions.map(row => [row.sessionKey.sessionId, row.turn]))
        .toEqual(full.sessions.map(row => [row.sessionKey.sessionId, row.turn]));
      expect(await probeQuiet(status, quiet, 1_000, true)).toEqual(expected);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (prior === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET; else process.env.LLV_RUNTIME_HOST_SOCKET = prior;
    journal.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production pipeline ports share narrow evidence and refresh dead evidence after adoption; titles use metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-reads-"));
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"));
  const host = new RuntimeHost(journal);
  const requests: Array<{ kind?: string; ids?: string[] }> = [];
  const server = serveRuntimeHost(path.join(root, "host.sock"), { handle: request => {
    if (request.method === "snapshot") {
      const read = request.params?.snapshotRead as { kind?: string; conversationIds?: string[] } | undefined;
      requests.push({ kind: read?.kind, ids: read?.conversationIds });
    }
    return host.handle(request);
  } });
  const prior = process.env.LLV_RUNTIME_HOST_SOCKET;
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(root, "host.sock");
  const publish = (state: "hosted" | "dead" | "conflict", turn: "idle" | "running" = "idle", attentionIds: string[] = []) => journal.append({
    scope: { type: "session", id: "conversation_example" }, kind: "session-status",
    payload: { conversationId: "conversation_example", sessionKey: { engine: "codex", sessionId: "session" },
      hostKind: "codex-app-server", host: state, turn, attentionIds },
  });
  try {
    await once(server, "listening");
    publish("dead");
    const ports = defaultPipelinePorts();
    expect(await ports.conversationAgentActive("conversation_example")).toBe(false);
    publish("hosted", "running");
    expect(await ports.conversationAgentActive("conversation_example")).toBe(true);
    expect(await ports.conversationAgentActive("conversation_example")).toBe(true);
    expect(requests).toEqual([
      { kind: "activity", ids: undefined }, { kind: "activity", ids: undefined },
    ]);
    expect(await ports.conversationAgentActive("absent")).toBeNull();
    expect(await ports.runtimeHostEpoch!()).toBe(journal.snapshot().runtime.hostEpoch);
    expect(await ports.runtimeHostEpoch!()).toBe(journal.snapshot().runtime.hostEpoch);
    expect(requests.filter(request => request.kind === "metadata")).toHaveLength(0);
    expect(requests.filter(request => request.kind === "activity")).toHaveLength(2);
    const metadataOnly = defaultPipelinePorts();
    expect(await metadataOnly.runtimeHostEpoch!()).toBe(journal.snapshot().runtime.hostEpoch);
    expect(await metadataOnly.runtimeHostEpoch!()).toBe(journal.snapshot().runtime.hostEpoch);
    expect(requests.filter(request => request.kind === "metadata")).toHaveLength(0);
    expect(requests.filter(request => request.kind === "activity")).toHaveLength(3);
    publish("dead");
    // Epoch-first reads preserve the pass's original activity observation.
    expect(await metadataOnly.conversationAgentActive("conversation_example")).toBe(true);
    expect(await defaultPipelinePorts().conversationAgentActive("conversation_example")).toBe(false);
    publish("hosted");
    const idle = defaultPipelinePorts();
    expect(await idle.conversationAgentActive("conversation_example")).toBeNull();
    expect(await idle.conversationTurnInterrupted!("conversation_example")).toBe("idle");
    publish("hosted", "idle", ["attention"]);
    expect(await defaultPipelinePorts().conversationAgentActive("conversation_example")).toBe(true);
    expect(await defaultPipelinePorts().conversationTurnInterrupted!("conversation_example")).toBeNull();
    publish("conflict");
    expect(await defaultPipelinePorts().conversationAgentActive("conversation_example")).toBe(false);
    expect(await defaultPipelinePorts().conversationTurnInterrupted!("conversation_example")).toBeNull();
    const before = journal.snapshot();
    await publishTitleUpdate("conversation:conversation_example", true);
    expect(journal.snapshot().filesRevision).toBe(before.filesRevision + 1);
    expect(journal.replay(before.snapshotSeq).events.map(event => event.kind)).toEqual(["title.updated", "files.revision"]);
    expect(requests.at(-1)?.kind).toBe("metadata");
    expect(requests.every(request => request.kind !== undefined)).toBe(true);
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(await defaultPipelinePorts().conversationAgentActive("conversation_example")).toBeNull();
    expect(await defaultPipelinePorts().runtimeHostEpoch!()).toBeNull();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (prior === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET; else process.env.LLV_RUNTIME_HOST_SOCKET = prior;
    journal.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
