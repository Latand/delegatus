import { agentRegistry, readOnlyConversationLookupFromSnapshot, type RegistryConversation } from "@/lib/agent/registry";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { projectAliasResolver } from "@/lib/projects/aliases";
import { projectForCwd } from "@/lib/scanner/describe";
import { prototypeWorld } from "@/lib/prototypeReview/world";
import { indexSessionTitles, overrideForEntry, readSessionTitles } from "@/lib/session/titleStore";
import { SecretRequestError, type SecretRequester } from "./types";

type CallerConversation = {
  project: string | null;
  launcher?: string | null;
  role: string | null;
  title: string | null;
  engine: string;
  model: string | null;
};

type CallerStage = NonNullable<SecretRequester["stage"]> & { project: string; source: string | null };
export interface SecretCallerWorld {
  conversation(id: string): CallerConversation | null;
  stages(id: string): CallerStage[];
  seat(project: string): string | null;
  canonical(project: string): string;
}

export function secretCallerWorld(): SecretCallerWorld {
  const registry = readOnlyConversationLookupFromSnapshot(agentRegistry().readOnlySnapshot());
  let pipelines: ReturnType<typeof loadPipelinesForList> | undefined;
  let titles: ReturnType<typeof indexSessionTitles> | undefined;
  return {
    canonical: projectAliasResolver(),
    seat: prototypeWorld.orchestrator,
    conversation(id) {
      const conversation = registry.conversation(id as RegistryConversation["id"]);
      if (!conversation) return null;
      const generation = conversation.generations.at(-1);
      const profile = generation?.launchProfile;
      const customTitle = generation && overrideForEntry({
        conversationId: conversation.id, engine: conversation.engine, path: generation.path,
      }, titles ??= indexSessionTitles(readSessionTitles()), [id], [
        ...conversation.generations.map(item => item.path), ...conversation.continuityPaths,
      ]);
      return {
        project: conversation.projectOwnership?.project ?? (profile?.cwd ? projectForCwd(profile.cwd) : null),
        launcher: conversation.launcher?.conversationId,
        role: conversation.agentRole,
        title: customTitle?.title ?? profile?.title ?? null,
        engine: conversation.engine,
        model: profile?.model ?? null,
      };
    },
    stages(id) {
      pipelines ??= loadPipelinesForList();
      return pipelines.flatMap(pipeline => pipeline.runs.flatMap(run => {
        if (pipeline.cursor?.stageId !== run.stageId) return [];
        const attempt = run.attempts.findLast(attempt => !attempt.historical);
        if (attempt?.conversationId !== id || !["spawning", "running", "reviewing", "committing"].includes(attempt.state)) return [];
        return [{
          pipelineId: pipeline.id,
          stageId: run.stageId,
          taskId: pipeline.taskIds[0] ?? null,
          source: pipeline.srcConversationId,
          project: pipeline.project,
        }];
      }));
    },
  };
}

/** The caller id comes from capability attribution. Walk only server-written launch links. */
export function authorizeSecretCaller(id: string, world: SecretCallerWorld = secretCallerWorld()): {
  project: string; requester: SecretRequester;
} {
  const caller = world.conversation(id);
  if (!caller?.project) throw new SecretRequestError("secret_caller_not_allowed");
  const project = world.canonical(caller.project);
  const seatId = world.seat(project);
  const seat = seatId ? world.conversation(seatId) : null;
  if (!seatId || !seat) throw new SecretRequestError("secret_caller_not_allowed");

  const stageFor = (conversationId: string) => {
    const stages = world.stages(conversationId);
    return stages.length === 1 && world.canonical(stages[0].project) === project ? stages[0] : undefined;
  };
  const belongsToSeat = (conversationId: string, depth: number, seen: ReadonlySet<string>): boolean => {
    const entry = world.conversation(conversationId);
    if (!entry?.project || world.canonical(entry.project) !== project || entry.role === "owner-relay") return false;
    if (conversationId === seatId) return true;
    if (depth === 4 || seen.has(conversationId)) return false;
    const next = new Set([...seen, conversationId]);
    if (entry.launcher && belongsToSeat(entry.launcher, depth + 1, next)) return true;
    const source = stageFor(conversationId)?.source;
    return !!source && belongsToSeat(source, depth + 1, next);
  };

  if (!belongsToSeat(id, 0, new Set())) throw new SecretRequestError("secret_caller_not_allowed");
  const stage = id === seatId ? undefined : stageFor(id);
  return {
    project,
    requester: {
      conversationId: id,
      role: id === seatId ? "orchestrator" : stage ? "stage" : caller.role ?? "agent",
      title: caller.title,
      engine: caller.engine,
      model: caller.model,
      seat: { conversationId: seatId, title: seat.title },
      ...(stage && { stage: { pipelineId: stage.pipelineId, stageId: stage.stageId, taskId: stage.taskId } }),
    },
  };
}
