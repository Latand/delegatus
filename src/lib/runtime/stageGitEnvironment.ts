import fs from "node:fs/promises";
import path from "node:path";
import type { AgentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { restoreStageGitGuard } from "@/lib/git/stageAttemptGuard";
import { findPipelineRecord } from "@/lib/pipelines/store";
import { realExec } from "@/lib/workflows/provision";

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
  const conversation = conversationId ? registry.conversation(conversationId as ViewerConversationId) : null;
  if (!conversation) return direct();
  const memberships = registry.conversationMemberships(conversation.id)
    .filter(row => row.kind === "pipeline" && row.stageId && Number.isSafeInteger(row.round) && row.round! > 0);
  if (!memberships.length) return direct();
  // Legacy conversations without a native guard retain their existing path.
  // Do not read pipeline history for an unrelated checkout or a fixture.
  const directory = await realExec("git", ["rev-parse", "--absolute-git-dir"], worktree);
  if (directory.code !== 0 || !path.isAbsolute(directory.stdout.trim())) return direct();
  try { await fs.access(path.join(directory.stdout.trim(), "delegatus-stage-owner")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return direct(); throw error; }
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
      || ["passed", "failed", "needs_decision", "skipped"].includes(attempt.state) || attempt.suspension) {
      throw new Error("stage Git rehost cannot prove its original attempt");
    }
    return { launchId: attempt.launchId, identity: JSON.stringify([pipeline.id, member.stageId, member.round, current!.id, attempt.launchId]) };
  };
  const original = resolve();
  const guard = await restoreStageGitGuard(original.launchId, worktree, realExec);
  if (!guard.LLV_STAGE_GIT_RECEIPT || resolve().identity !== original.identity) throw new Error("stage Git rehost lost its original attempt");
  return guard;
}
