import fs from "node:fs/promises";
import path from "node:path";
import type { AgentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { restoreStageGitGuard } from "@/lib/git/stageAttemptGuard";
import { findPipelineRecord } from "@/lib/pipelines/store";
import { realExec } from "@/lib/workflows/provision";

/** The stable code a send carries when its only route was restarting the host
 * of a stage attempt that has already settled. */
export const STAGE_ATTEMPT_SETTLED_CODE = "stage_attempt_settled";
/** Every refusal text starts with this, so a settled record can be recognized. */
export const STAGE_ATTEMPT_SETTLED_PREFIX = "stage attempt already settled";
const SETTLED_ATTEMPT_STATES: ReadonlySet<string> = new Set(["passed", "failed", "needs_decision", "skipped"]);
const LIVE_ATTEMPT_STATES: ReadonlySet<string> = new Set(["spawning", "running", "reviewing", "committing"]);

/** The rehost refusal for an attempt that proved its identity and has settled.
 * Its message stays the rehost refusal every other path already records; a
 * send reports `refusal`, which names what to do instead. Nothing was started
 * or stopped when this is thrown, so a send that receives it was never
 * delivered and may be sent again elsewhere. */
export class StageAttemptSettledError extends Error {
  readonly code = STAGE_ATTEMPT_SETTLED_CODE;
  constructor(readonly refusal: string) {
    super("stage Git rehost cannot prove its original attempt");
    this.name = "StageAttemptSettledError";
  }
}

function settledAttemptRefusal(pipelineId: string, stageId: string, state: string,
  successorConversationId: string | null): string {
  const action = state === "needs_decision" ? "pipeline_action resolve-decision or retry-stage" : "pipeline_action retry-stage";
  const instead = successorConversationId ? `Send to its live attempt ${successorConversationId}, or use ${action}` : `Use ${action}`;
  return `${STAGE_ATTEMPT_SETTLED_PREFIX} (${state}); its host is not restarted for new messages. ${instead} on pipeline ${pipelineId} stage ${stageId}`;
}

/** The durable attempt a pipeline conversation's rehost must still name, or
 * null when the conversation has no native stage guard to restore. Throws
 * when the membership exists and no longer proves a restartable attempt. */
async function stageRehostResolver(registry: AgentRegistry, conversationId: string | undefined,
  worktree: string): Promise<(() => { launchId: string; identity: string }) | null> {
  const conversation = conversationId ? registry.conversation(conversationId as ViewerConversationId) : null;
  if (!conversation) return null;
  const memberships = registry.conversationMemberships(conversation.id)
    .filter(row => row.kind === "pipeline" && row.stageId && Number.isSafeInteger(row.round) && row.round! > 0);
  if (!memberships.length) return null;
  // Legacy conversations without a native guard retain their existing path.
  // Do not read pipeline history for an unrelated checkout or a fixture.
  const directory = await realExec("git", ["rev-parse", "--absolute-git-dir"], worktree);
  if (directory.code !== 0 || !path.isAbsolute(directory.stdout.trim())) return null;
  try { await fs.access(path.join(directory.stdout.trim(), "delegatus-stage-owner")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const resolve = () => {
    const current = registry.conversation(conversation.id);
    const rows = current ? registry.conversationMemberships(current.id)
      .filter(row => row.kind === "pipeline" && row.stageId && Number.isSafeInteger(row.round) && row.round! > 0) : [];
    if (rows.length !== 1) throw new Error("stage Git rehost has missing or ambiguous pipeline membership");
    const member = rows[0];
    const pipeline = findPipelineRecord(member.containerId);
    const attempt = pipeline?.runs.find(run => run.stageId === member.stageId)?.attempts.find(row => row.n === member.round);
    if (!pipeline || pipeline.worktreeDir !== worktree || !attempt?.launchId || !attempt.conversationId
      || registry.canonicalConversationId(attempt.conversationId as ViewerConversationId) !== current!.id
      || attempt.suspension) {
      throw new Error("stage Git rehost cannot prove its original attempt");
    }
    if (SETTLED_ATTEMPT_STATES.has(attempt.state)) {
      const successor = pipeline.runs.find(run => run.stageId === member.stageId)?.attempts
        .filter(row => row.n > member.round! && LIVE_ATTEMPT_STATES.has(row.state) && row.conversationId
          && registry.canonicalConversationId(row.conversationId as ViewerConversationId) !== current!.id).at(-1);
      throw new StageAttemptSettledError(settledAttemptRefusal(pipeline.id, member.stageId!, attempt.state,
        successor?.conversationId ?? null));
    }
    return { launchId: attempt.launchId, identity: JSON.stringify([pipeline.id, member.stageId, member.round, current!.id, attempt.launchId]) };
  };
  resolve();
  return resolve;
}

/** A resume that will be refused its stage binding must learn that before it
 * stops the process the row still records (#3811): the stop is final, and a
 * refused resume then leaves the stage with no host at all. Reads only. */
export async function assertStageGitRehostProvable(registry: AgentRegistry, conversationId: string | undefined,
  worktree: string): Promise<void> {
  await stageRehostResolver(registry, conversationId, worktree);
}

/** Refuses, before anything is reserved or stopped, a rehost whose stage
 * attempt has settled. Every other answer, including the refusals the rehost
 * itself raises later, is left to the path that restarts the host. */
export async function assertStageAttemptNotSettled(registry: AgentRegistry, conversationId: string | undefined,
  worktree: string): Promise<void> {
  try {
    await stageRehostResolver(registry, conversationId, worktree);
  } catch (error) {
    if (error instanceof StageAttemptSettledError) throw error;
  }
}

/** A resume or account migration has a new host operation id. Its durable
 * conversation membership still names the original stage attempt. Resolve
 * that attempt before restoring; a worktree owner alone grants no binding. */
export async function stageGitEnvironment(registry: AgentRegistry, conversationId: string | undefined,
  launchId: string | null | undefined, worktree: string): Promise<Record<string, string>> {
  const direct = async () => {
    const guard = await restoreStageGitGuard(launchId, worktree, realExec);
    if (!guard.LLV_STAGE_GIT_RECEIPT) return guard;
    const receipt = launchId ? registry.spawnReceipt(launchId) : null;
    if (!conversationId || !receipt
      || registry.canonicalConversationId(receipt.conversationId) !== registry.canonicalConversationId(conversationId as ViewerConversationId)
      || (receipt.cwd ?? receipt.launchProfile.cwd) !== worktree) throw new Error("stage Git rehost cannot prove its launch conversation");
    return guard;
  };
  const resolve = await stageRehostResolver(registry, conversationId, worktree);
  if (!resolve) return direct();
  const original = resolve();
  const guard = await restoreStageGitGuard(original.launchId, worktree, realExec);
  if (!guard.LLV_STAGE_GIT_RECEIPT || resolve().identity !== original.identity) throw new Error("stage Git rehost lost its original attempt");
  return guard;
}
