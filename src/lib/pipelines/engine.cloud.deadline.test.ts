import { expect, test, savePipelines, path } from "./engine.fixture";

import { roleMemoryCollection } from "@/lib/memory/roleStore";

import { setCodexCloudEnvironmentId } from "@/lib/projects/settings";

import { createHostedCloudStageClient } from "./cloudHostedClient";
import { EventEmitter } from "node:events";
import { stubCloudBackend } from "./cloudEnvironment.fixture";
import type WebSocket from "ws";

import { composeStageText } from "./stageInput";
import { learnedRulesForLaunchProfile } from "@/lib/memory/roleLaunch";

import { spyOn } from "bun:test";
import { deadlineChild, deadlineReport, heldCloudAcknowledgement, superviseCloudDeadline } from "./fixtures/cloudDeadline";

import { taskId, stage, lane, attempt, fixture, step, submitted } from "./engine.cloud.fixture";

for (const expired of [false, true]) for (const size of [4_000, 70_000]) {
  const name = `the Cloud runtime enforces the remaining stage deadline: expired=${expired} size=${size}`;
  test(name, async () => {
    const budgetMs = expired ? 12_123 : 90_123;
    if (!deadlineChild(name)) return superviseCloudDeadline(import.meta.path, name, expired, budgetMs);
    const { h } = await fixture({ accountId: "fixture", stages: [{ ...stage, role: { roleId: "builder" }, access: "read-write" }] });
    await step(h);
    const backend = stubCloudBackend({ repository: "sample/project", ref: "main" });
    const { roleMemoryCollection } = await import("@/lib/memory/roleStore");
    const { memoryDeliveries } = await import("@/lib/memory/deliveryLedger");
    const collection = roleMemoryCollection(true)!;
    const scope = collection.get("s:machine"), existing = collection.get("r:r_cloud_runtime_fixture");
    const rule = "Keep receipt ownership until the matching operation reaches completion";
    collection.boundedPatch(2, tx => {
      tx.put({ kind: "scope", scope: "machine", revision: 1, active: ["r_cloud_runtime_fixture"], history: [] });
      tx.put({ kind: "rule", id: "r_cloud_runtime_fixture", scope: "machine", rule, why: "", state: "active", hints: [],
        source: { project: lane().project, pipelineId: lane().id, stageId: "review", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
        createdAt: "2026-10-14T00:00:00Z", changedAt: "2026-10-14T00:00:00Z" });
    });
    const acknowledgement = heldCloudAcknowledgement();
    const originalNow = h.ports.now;
    // Keep the durable thirty-minute deadline, but start this controller job
    // with only a bounded remainder. The production timer itself is unchanged.
    h.ports.now = () => {
      const deadline = lane().runs[0]?.attempts.at(-1)?.cloud?.deadlineAt;
      return deadline ? new Date(Date.parse(deadline) - budgetMs).toISOString() : originalNow();
    };
    const realTimer = globalThis.setTimeout;
    let armed = 0;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      const handle = realTimer(callback, ms);
      if (ms === budgetMs) { armed++; deadlineReport("armed"); }
      return handle;
    }) as typeof setTimeout);
    try {
      const record = lane();
      record.spec = "Acceptance 界🙂\n".repeat(4000);
      record.inputContext = { taskDetails: rule + "\n" + "Accepted detail 界🙂. ".repeat(size), handoffDigest: "Keep the accepted API stable." };
      record.delivery!.target.remote = "https://github.com/sample/project.git";
      record.baseBranch = "main";
      savePipelines([record]);
      setCodexCloudEnvironmentId(record.project, "asenvcfg_fixture");
      const threadId = `00000000-0000-0000-0000-${String(size).padStart(12, "0")}`;
      const environment = { environmentId: "ccarenv_fixture", environmentConfigId: "asenvcfg_fixture", cwd: "/workspace/project" };
      const frames: { method?: string; params?: { input?: { text: string }[] } }[] = [];
      let turnNumber = 0, acknowledged = 0;
      let crossed = false;
      class Socket extends EventEmitter {
        readyState = 1;
        send(value: string, done?: (error?: Error) => void) {
          const frame = JSON.parse(value); frames.push(frame); done?.();
          if (frame.id === undefined) return;
          if (frame.method === "turn/start") expect(turnNumber).toBe(acknowledged);
          const turn = { id: `input_${turnNumber}`, status: "completed", model: stage.model };
          const result = frame.method === "thread/start" || frame.method === "thread/read"
            ? { model: stage.model, thread: { id: threadId, ephemeral: false, environments: [environment] } }
            : frame.method === "command/exec" ? { exitCode: 0, stdout: lane().lastPassedCommit, stderr: "" }
            : frame.method === "turn/start" ? { turn: { ...turn, id: `input_${++turnNumber}` } }
            : frame.method === "thread/turns/list" ? { data: [turn], nextCursor: null } : {};
          const answer = () => {
            if (frame.method === "thread/turns/list") acknowledged++;
            this.emit("message", Buffer.from(JSON.stringify({ id: frame.id, result })));
          };
          if (frame.method === "thread/turns/list" && !crossed) {
            crossed = true; acknowledgement.hold(answer);
          } else queueMicrotask(answer);
        }
        terminate() { this.readyState = 3; this.emit("close"); }
      }
      const sockets: Socket[] = [];
      h.ports.cloudClient = createHostedCloudStageClient({
        ...backend.dependencies,
        socket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; },
      });
      if (expired) {
        for (let index = 0; index < 4 && !attempt()?.cloud?.error; index++) await step(h);
        expect(attempt().cloud?.error).toBe("Codex Cloud operation timed out");
        expect(attempt().cloud?.taskId).toBeNull();
        expect(attempt().cloud?.submissionUnresolved).toBe(true);
        expect(attempt().cloud?.fallback).toBeUndefined();
        expect(h.spawnInputs).toHaveLength(0);
      } else await submitted(h, threadId);
      expect(armed).toBe(1);
      expect(crossed).toBe(true);
      expect(sockets.every(socket => socket.readyState === 3)).toBe(true);
      const sent = frames.filter(frame => frame.method === "turn/start").map(frame => frame.params!.input![0]!.text);
      if (expired) {
        expect(sent).toHaveLength(1);
        expect(acknowledged).toBe(0);
        deadlineReport("done");
        return;
      }
      expect(sent.length).toBeGreaterThan(1);
      expect(acknowledged).toBe(turnNumber - 1);
      expect(sent.every(text => Buffer.byteLength(text) <= 32000)).toBe(true);
      const body = sent.map(text => text.slice(text.indexOf("\n\n") + 2)).join("");
      expect(crossed).toBe(true);
      if (size === 70_000) expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024);
      const local = await composeStageText(lane(), lane().stages[0]!, attempt().effectiveRole, attempt().input ?? "");
      expect(local).not.toContain(rule);
      const memory = await learnedRulesForLaunchProfile({ learnedRules: { project: record.project, roleId: "builder" } });
      expect(memory).toContain(rule);
      expect(body.slice(0, `${memory}\n\n${local}`.length)).toBe(`${memory}\n\n${local}`);
      const receipt = memoryDeliveries().find(row => row.delivery.conversationId === threadId);
      expect(receipt).toBeDefined();
      expect(receipt!.delivery.attempt).toEqual({ pipelineId: record.id, stageId: "review", attempt: 1 });
      deadlineReport("done");
    } finally {
      timer.mockRestore();
      acknowledgement.close();
      backend.stop();
      collection.boundedPatch(2, tx => {
        if (scope) tx.put(scope); else tx.delete("s:machine");
        if (existing) tx.put(existing); else tx.delete("r:r_cloud_runtime_fixture");
      });
    }
  }, 180_000);
}
