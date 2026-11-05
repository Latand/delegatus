import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import path from "node:path";
import { migrationDeliveryFixture } from "@/test-helpers/migrationDelivery";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import type { PipelineStageAttempt } from "@/lib/pipelines/types";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import type { EngineHost } from "./engineHost";
import { NativeCodexQueue } from "./nativeCodexQueue";
import { NATIVE_QUEUE_CAPABILITY } from "./codexCapabilityFlags";

for (const transport of ["host", "native"] as const) {
  for (const change of ["ordinary", "after-journal", "during-prepare"] as const) {
    test(`format rollback retains unsupported input at ${transport} dispatch: ${change}`, async () => {
      const f = migrationDeliveryFixture(), previous = process.env.LLV_STATE_DIR;
      process.env.LLV_STATE_DIR = f.root;
      let writes = 0, expose = false, changed = false, busy = false;
      const now = new Date().toISOString(), stageId = "integration-resolve";
      const p = buildPipeline({ id: "format-owner", task: "Format dispatch", project: "fixture", repoDir: f.root,
        stages: [{ id: stageId, kind: "run", prompt: "Build", next: null,
          effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
        srcPath: null, srcConversationId: null, now });
      p.state = "running"; p.cursor!.state = "running";
      p.runs[0]!.attempts.push({ n: 1, state: "running", effectiveRole: p.stages[0]!.effectiveRole,
        launchId: null, conversationId: f.conversation.id, sessionId: f.key.sessionId,
        agentPath: f.conversation.generations.at(-1)!.path, paneId: null, flowId: null,
        startedAt: now, completedAt: null, output: null, verdict: null, error: null } as PipelineStageAttempt);
      savePipelines([p]);
      const filename = path.join(f.root, "state.sqlite");
      const upgrade = () => {
        if (changed) return;
        changed = true;
        const db = new Database(filename);
        try {
          db.transaction(() => {
            db.query("UPDATE state_collections SET schema_version=6 WHERE collection IN ('pipelines','pipelines_archive')").run();
            db.query("UPDATE state_collections SET revision=revision+1 WHERE collection='pipelines'").run();
            db.query("UPDATE state_rows SET value_json=?,row_revision=(SELECT revision FROM state_collections WHERE collection='pipelines') WHERE collection='pipelines' AND row_key=?")
              .run(JSON.stringify({ ...p, adoptedCreationRequests: [{ key: "retained-key", digest: "retained-digest" }] }), p.id);
          })();
        } finally { db.close(); }
      };
      f.registry.rememberMembership(f.conversation.id, { kind: "pipeline", containerId: p.id, role: "builder",
        slot: `${stageId}:1`, stageId, stageOrder: 0, round: 1, parentConversationId: null });
      const send = f.host.send.bind(f.host);
      (f.host as EngineHost).send = async (entry, _first, authorize) => {
        if (change === "during-prepare") upgrade();
        authorize?.();
        writes++;
        return send(entry);
      };
      if (transport === "native") {
        const health = f.host.health.bind(f.host);
        f.host.health = async () => ({ ...await health(), status: busy ? "active" : "idle", activeTurnRef: busy ? "busy-turn" : null,
          activeFlags: [NATIVE_QUEUE_CAPABILITY] });
        Object.assign(f.host, { nativeQueue: {
          queue: new NativeCodexQueue({ rpc: async (method, params) => {
            if (method === "thread/queue/list") return { data: [], nextCursor: null };
            writes++;
            return { queuedSubmission: { id: "native-one", clientUserMessageId: params.clientUserMessageId, input: params.input } };
          } }, f.key.sessionId),
          prepare: async (_entry: unknown, version: { text: string }) => {
            if (change === "during-prepare") upgrade();
            return [{ type: "text" as const, text: version.text }];
          },
          evidence: async () => null,
          sendWithdrawn: async () => { writes++; return { turnId: "native-turn" }; },
        } });
        f.client.nativeQueueRead = async id => f.journal.nativeQueueRead(id);
        f.client.nativeQueueTransition = async (id, update) => f.journal.nativeQueueTransition(id, update);
        f.journal.append({ scope: `session:${f.conversation.id}`, kind: "session-status", payload: {
          conversationId: f.conversation.id, sessionKey: f.key, hostKind: "codex-app-server", host: "hosted", turn: "idle",
          activeTurnId: null, accountId: "account-a", capabilities: { steer: true, structuredAttention: true, nativeQueue: true },
        } });
      }
      const effects = f.client.effectBatch.bind(f.client);
      f.client.effectBatch = async (...args) => expose ? effects(...args) : [];
      f.client.readSession = async lookup => f.journal.readSession(lookup);
      f.client.command = async command => f.journal.executeOperation(command);
      const bind = () => bindStructuredDeliveryQueue([{ key: f.key, host: f.host }], { registry: f.registry, client: f.client,
        watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
      try {
        await bind();
        const held = f.registry.holdDelivery(f.conversation.id, "continue retained input", "format-send", "text", [], null,
          { operationId: "format-send", kind: "send", policy: "queue", turnId: null });
        f.registry.beginDeliveryAttempt(held.id, held.generationId!);
        f.journal.executeOperation({ kind: "send", operationId: "format-send", idempotencyKey: "format-send",
          conversationId: f.conversation.id, text: "continue retained input", policy: "queue" });
        await bindStructuredDeliveryQueue([], { client: null });
        if (change === "after-journal") upgrade();
        expose = true; busy = transport === "native" && change === "after-journal";
        await bind(); await kickStructuredDeliveryQueue();
        if (change !== "ordinary") expect(writes).toBe(0);
        await bindStructuredDeliveryQueue([], { client: null });
        busy = false; await bind(); await kickStructuredDeliveryQueue();
        expect(writes).toBe(change === "ordinary" ? 1 : 0);
        expect(f.journal.operationResult("format-send")).not.toBeNull();
        if (changed) {
          const db = new Database(filename, { readonly: true });
          try { expect(JSON.parse((db.query("SELECT value_json FROM state_rows WHERE collection='pipelines' AND row_key=?")
            .get(p.id) as { value_json: string }).value_json).adoptedCreationRequests).toEqual([{ key: "retained-key", digest: "retained-digest" }]); }
          finally { db.close(); }
        }
      } finally {
        await f.cleanup();
        if (previous === undefined) delete process.env.LLV_STATE_DIR;
        else process.env.LLV_STATE_DIR = previous;
      }
    });
  }
}
