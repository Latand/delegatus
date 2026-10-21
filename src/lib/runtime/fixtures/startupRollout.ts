import "@/lib/testing/fixtureLifetime";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { beginCodexFeatureFixture } from "@/lib/agent/codexSpawnPolicyTestFixtures";
import { RuntimeJournal } from "@/runtime-host/journal";
import { CodexAppServerHost } from "../codexAppServerHost";
import { adoptStructuredHostsAtStartup } from "../startup";
import { bindStructuredDeliveryQueue } from "../structuredDeliveryController";
import { StartupRowRetries, startupRowNotice } from "../startupRowRetries";
import { loadTasks, mutateTasks } from "@/lib/tasks/store";
import { statePath } from "@/lib/configDir";
import { createHash } from "node:crypto";
import type { RuntimeHostClient } from "../client";

const [mode, directory, reason] = process.argv.slice(2);
if (!mode || !directory) throw new Error("startup rollout fixture needs a mode and private directory");
const sessionId = "25300000-0000-0000-0000-000000000078";
const key = { engine: "codex" as const, sessionId };
const keyId = `codex:${sessionId}`;
const at = "2026-10-19T00:00:00.000Z";
if (mode === "engine") {
  let input = "";
  process.stdin.on("end", () => process.exit(0));
  process.stdout.on("error", () => process.exit(0));
  process.stdin.on("data", chunk => {
    input += chunk;
    let end: number;
    while ((end = input.indexOf("\n")) >= 0) {
      const request = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
      if (typeof request.id !== "number") continue;
      const reply = (result: unknown) => process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      switch (request.method) {
        case "initialize": reply({ userAgent: "fixture" }); break;
        case "account/read": reply({ account: { type: "chatgpt", planType: "pro" } }); break;
        case "config/read": reply({ config: { mcp_servers: {} } }); break;
        case "mcpServerStatus/list": reply({ data: [{ name: "viewer", tools: { stage_report: {} } }], nextCursor: null }); break;
        case "model/list": reply({ data: [] }); break;
        case "thread/resume":
          fs.appendFileSync(path.join(directory, "attempts"), "resume\n");
          process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32000,
            message: reason === "missing" ? "no rollout found for thread id fixture" : "temporary service failure" } })}\n`);
          break;
        default: process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32601, message: "unavailable" } })}\n`);
      }
    }
  });
} else {
  beginCodexFeatureFixture();
  Date.now = () => Number(process.argv[5] ?? Date.parse(at));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = {
    readSession: async (identity: Parameters<RuntimeJournal["readSession"]>[0]) => journal.readSession(identity),
    snapshot: async () => journal.snapshot(), append: async (event: Parameters<RuntimeJournal["append"]>[0]) => journal.append(event),
    command: async (command: Parameters<RuntimeJournal["executeOperation"]>[0]) => journal.executeOperation(command),
    operationStatus: async (id: string) => journal.operationResult(id),
    effectBatch: async (kinds: Parameters<RuntimeJournal["effectBatch"]>[1], after: number) => journal.effectBatch(100, kinds, after),
  } as RuntimeHostClient;
  if (!registry.readOnlySnapshot().entries[keyId]) {
    const artifactPath = path.join(directory, `${sessionId}.jsonl`);
    const launchProfile = emptyLaunchProfile({ cwd: directory });
    registry.reconcileConversations([{ engine: "codex", path: artifactPath, accountId: null, launchProfile,
      turn: { state: "busy", source: "lifecycle", terminalAt: null }, observedAt: at }]);
    registry.upsert({ key, artifactPath, cwd: directory, accountId: null, launchProfile, status: "live", host: null,
      claimEpoch: 0, claimOwner: null, pendingAction: "handoff", structuredHost: { kind: "codex-app-server",
        endpoint: "stdio:released", process: null, eventCursor: 0, protocolVersion: "0.162.1",
        writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
    if (mode === "legacy" || mode === "refused-notice") {
      const id = `startup-quarantine-${createHash("sha256").update(keyId).digest("hex").slice(0, 32)}`;
      mutateTasks(tasks => ({ tasks: [...tasks, { id, project: "dir-fixture", text: "Legacy missing-rollout quarantine",
        status: "inbox", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at,
        ...(mode === "refused-notice" ? { prototypeReviews: [{ id: "notice-decision", taskId: id, project: "dir-fixture",
          title: "Pending decision fixture", createdAt: at, source: { conversationId: null },
          publicationKey: "notice-decision", inputDigest: "fixture", variants: [], decision: { chosen: [], comment: "",
            at, delivery: { state: "pending" as const, clientMessageId: "notice-decision", conversationId: null, text: "fixture" } } }] } : {}),
      }], result: undefined }), statePath("tasks.json"));
      if (mode === "legacy") {
        const retries = new StartupRowRetries(`${registry.filename}.startup-retries`);
        let row = await retries.failed(keyId, "missing-rollout", 0);
        row = await retries.failed(keyId, "missing-rollout", row.nextAt);
        row = await retries.failed(keyId, "missing-rollout", row.nextAt);
        await startupRowNotice(registry.readOnlySnapshot().entries[keyId]!, row);
      }
    }
  }
  if (mode === "resolve-notice") {
    mutateTasks(tasks => ({ tasks: tasks.map(task => ({ ...task,
      prototypeReviews: task.prototypeReviews?.map(round => ({ ...round, ...(round.decision ? {
        decision: { ...round.decision, delivery: { ...round.decision.delivery, state: "sent" as const } },
      } : {}) })),
    })), result: undefined }), statePath("tasks.json"));
  }
  const timers: number[] = [];
  try {
    await adoptStructuredHostsAtStartup({ registry, client, orchestratorSeats: () => [],
      refreshTranscriptState: async () => {}, resolveCodexOwner: () => null, resolveClaudeOwner: () => null,
      adoptClaude: async () => [], pipelineEvidence: () => ({ settled: new Set(), deferred: new Set() }),
      schedule: (_callback, delay) => { timers.push(delay); return {}; },
      adoptCodexHost: async (id, options) => {
        try {
          return await CodexAppServerHost.adopt(id, { ...options, mcpServers: [],
            readProtocolVersion: () => "0.162.1", requestTimeoutMs: 2000,
            spawnProcess: (_binary, _args, settings) => spawn(process.execPath,
              [import.meta.filename, "engine", directory, reason], settings) });
        } catch (error) {
          if (mode === "replaced") {
            const current = registry.readOnlySnapshot().entries[keyId]!;
            registry.upsert({ ...current, status: "live", claimOwner: "replacement-writer", claimEpoch: current.claimEpoch + 1,
              structuredHost: { ...current.structuredHost!, writerClaimEpoch: current.claimEpoch + 1, endpoint: "fixture:replacement" } });
          }
          throw error;
        }
      },
    });
    const retries = new StartupRowRetries(`${registry.filename}.startup-retries`);
    await retries.load([keyId]);
    console.log(JSON.stringify({ retry: retries.get(keyId), entry: registry.readOnlySnapshot().entries[keyId], timers,
      tasks: loadTasks(statePath("tasks.json")), attempts: fs.existsSync(path.join(directory, "attempts"))
        ? fs.readFileSync(path.join(directory, "attempts"), "utf8").trim().split("\n").length : 0 }));
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null }); journal.close(); registry.close();
  }
}
