import path from "node:path";
import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, type RegistryConversation } from "@/lib/agent/registry";
import { buildPipeline, loadPipelines, savePipelines } from "@/lib/pipelines/store";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { drainHeldDeliveries } from "@/lib/accounts/migration/coordinator";
import type { RuntimeHostClient } from "./client";
import { deliverHeldStructuredMessage } from "./structuredMessageDelivery";
import { StructuredRecoveryHeldForUpdateError } from "./structuredRecovery";

export function stageRecipient(registry: AgentRegistry, conversation: RegistryConversation, existing?: Pipeline) {
  const generation = conversation.generations.at(-1)!;
  const role = { roleId: null, engine: "codex" as const, model: null, effort: null,
    access: "read-write" as const, promptScaffold: null };
  const pipeline = existing ?? buildPipeline({ id: "dead-stage-fixture", task: "Stage delivery", project: "fixture",
    repoDir: "/repo", stages: [{ id: "build", kind: "run", prompt: "Build", next: null, effectiveRole: role }],
    srcPath: null, srcConversationId: null, now: new Date().toISOString() });
  if (!existing) {
    pipeline.state = "running";
    pipeline.cursor!.state = "running";
    const attempt: PipelineStageAttempt = { n: 1, state: "running", effectiveRole: role,
      launchId: "stage-fixture-launch", conversationId: conversation.id, sessionId: generation.id,
      agentPath: generation.path, paneId: null, flowId: null, startedAt: new Date().toISOString(),
      completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null };
    pipeline.runs[0]!.attempts = [attempt];
  }
  registry.rememberMembership(conversation.id, { kind: "pipeline", containerId: pipeline.id,
    role: "builder", slot: "build:1", stageId: "build", stageOrder: 0, round: 1, parentConversationId: null });
  savePipelines([...loadPipelines().filter(row => row.id !== pipeline.id), pipeline]);
  const key = { engine: conversation.engine, sessionId: generation.id };
  registry.upsert({ key, artifactPath: generation.path, cwd: "/repo", accountId: generation.accountId,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "fixture" }), status: "dead", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: "fixture:stage", process: {
      ...captureProcessIdentity(process.pid), startIdentity: "previous-process" },
      eventCursor: 1, protocolVersion: "test", writerClaimEpoch: 1, activeTurnRef: null,
      pendingAttention: [], activeFlags: [] }, claimEpoch: 1, claimOwner: null, pendingAction: null });
  return { pipeline, key, generation };
}

export function stageFollowup(registry: AgentRegistry, conversationId: ViewerConversationId) {
  const held = registry.holdDelivery(conversationId, "Follow up on stage work", "stage-followup-key", "text", [], null,
    { operationId: "stage-followup-operation", kind: "send", policy: "queue", turnId: null });
  let commands = 0, recoveries = 0;
  const client = { readSession: async () => null, operationStatus: async () => null,
    command: async () => { commands++; throw new Error("unexpected command"); } } as unknown as RuntimeHostClient;
  const dependencies = { enabled: () => true, registry: () => registry, client: () => client, progress: null,
    kick: () => {}, recover: async () => { recoveries++; throw new StructuredRecoveryHeldForUpdateError(); } };
  const drain = (now = Date.now()) => drainHeldDeliveries(conversationId, {
    deliver: async ({ delivery, path: pathname, clientMessageId }) => await deliverHeldStructuredMessage({
      conversationId, path: pathname, deliveryId: delivery.id, clientMessageId, text: delivery.text,
      command: delivery.command,
    }, dependencies) ?? "delivery-uncertain",
  }, registry, { now: () => now });
  return { held, client, dependencies, drain, commands: () => commands, recoveries: () => recoveries };
}

export function isolatedStageRegistry(directory: string) {
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const conversation = registry.ensureConversation("codex", "/sessions/stage-fixture.jsonl", null);
  stageRecipient(registry, conversation);
  return { registry, conversation };
}
