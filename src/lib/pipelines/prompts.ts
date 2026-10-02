import { memoryKillText, type AgentMemoryKill } from "@/lib/runtime/agentMemoryState";
import type { EffectivePipelineRole, Pipeline, PipelineDecisionAnswer, PipelineStage } from "./types";
import { pipelineStageSandbox } from "./stageSandbox";

const RELAY_PLACEHOLDER = "{{prev.output}}";

export function pipelineDeliveryGuidance(pipeline: Pipeline): string[] {
  if (pipeline.delivery?.publish !== "disabled") return [];
  return [
    `Delivery target ${pipeline.delivery.target.branch} is owned by ${pipeline.delivery.ownerId} at epoch ${pipeline.delivery.epoch}. ${pipeline.delivery.disposition === "comparison" ? "This is a comparison lane." : "This lane's publication claim has been released."} Do not push to that branch. Delegatus publication is disabled for this lane.`,
    "This instruction is guidance; your host tools and network access are unchanged. Local tests and commits remain available.",
  ];
}

function replaceAll(source: string, token: string, value: string): string {
  return source.split(token).join(value);
}

/** Persist this input with the new attempt so launch replay is byte-stable. */
export function renderDecisionInput(previousInput: string | null, decision: PipelineDecisionAnswer): string {
  return [
    previousInput ?? "",
    `Decision continuation for stage ${decision.stageId}, settled attempt ${decision.attempt}:`,
    "Question / prior result:", decision.question,
    "Answer:", decision.answer,
    /* agent-prompt-contract.md N5: an answer that replaced a spec item lost to
       the pinned specification rendered below it. */
    "Where the answer differs from the brief or the pinned specification, the answer governs. Continue the stage from where the prior attempt stopped and report the final result with stage_report.",
  ].filter(Boolean).join("\n\n");
}

export function renderStagePrompt(
  pipeline: Pipeline,
  stage: PipelineStage,
  role: EffectivePipelineRole,
  previousOutput: string,
): string {
  let body = replaceAll(stage.prompt, "{{task}}", pipeline.task);
  body = replaceAll(body, RELAY_PLACEHOLDER, previousOutput);
  let roleScaffold = role.promptScaffold ? replaceAll(role.promptScaffold, "{{task}}", pipeline.task) : null;
  if (roleScaffold) roleScaffold = replaceAll(roleScaffold, RELAY_PLACEHOLDER, previousOutput);
  /* The controller persists the predecessor's output on the attempt whether or
     not the author placed the placeholder (#1678): a prompt that never names it
     used to render nothing, and the stage truthfully reported a missing input.
     A prompt or scaffold that places the relay keeps sole control of where. */
  const relayPlaced = stage.prompt.includes(RELAY_PLACEHOLDER) || (role.promptScaffold?.includes(RELAY_PLACEHOLDER) ?? false);
  const relayed = previousOutput.trim();
  const relaySection = !relayPlaced && relayed
    ? ["", "Relayed by the controller (a previous stage's output, or the answer to this stage's earlier question):", relayed]
    : [];
  const declaredOutputs = stage.outputs?.length ? stage.outputs.map((output) => `\`${output}\``).join(", ") : null;
  const access = role.access === "read-only"
    ? declaredOutputs
      ? `Access: read-only. Inspect and validate freely. You may write only these declared worktree outputs: ${declaredOutputs}. Do not commit, stage, push, edit any other repository path, or mutate production.`
      : "Access: read-only. Inspect and validate freely. Do not edit, stage, commit, push, or otherwise mutate the repository or production."
    : "Access: read-write. Work only inside this pipeline's dedicated worktree and commit-ready scope.";
  const hostAccess = pipelineStageSandbox(stage) === "restricted"
    ? "Host access: restricted. This stage runs inside the engine sandbox."
    : "Host access: full. Network, SSH, installed command-line tools and the pipeline worktree are available.";
  /* The reviewer's scaffold reviews "the commits since the pipeline's base
     commit" when its brief names no change; this line names that commit. */
  const baseLine = pipeline.baseRef
    ? [`This pipeline's worktree started from commit ${pipeline.baseRef}${pipeline.baseBranch ? ` on ${pipeline.baseBranch}` : ""}.`]
    : [];
  const roleContext = role.roleId
    ? [
        `Role preset: ${role.roleId} (${role.engine}${role.model ? `/${role.model}` : ""}${role.effort ? `, ${role.effort}` : ""}).`,
        ...(roleScaffold ? ["", "Role prompt scaffold:", roleScaffold] : []),
      ]
    : [];
  return [
    body.trim(),
    ...relaySection,
    "",
    "Pinned task:",
    pipeline.task,
    "",
    "Pinned specification and acceptance criteria:",
    pipeline.spec?.trim() || "No separate pinned specification was supplied.",
    "",
    ...roleContext,
    access,
    hostAccess,
    ...baseLine,
    ...pipelineDeliveryGuidance(pipeline),
    "Pipeline nesting is forbidden. Never create or start another pipeline from this stage.",
    "",
    /* One completion channel, one fallback (#1797): asking for the call AND an
       unconditional fenced block let a stage treat the block as the real answer
       and skip the call, which is where every unreadable-verdict park fell. The
       engine still reads the block exactly as before when no report arrived.
       One vocabulary (agent-prompt-contract.md §2.1): the markers a brief may
       still ask for are retired here, where every stage reads it last. */
    "Report this stage's completion with the Delegatus MCP tool stage_report: { verdict, findings: [{ severity: P0 | P1 | P2 | P3, text }], summary, blocked?, blockedReason? }. That call is the only way to complete this stage, and it replaces any other ending the brief above asks for (REVIEW_READY, VERDICT: APPROVE, VERDICT: REQUEST_CHANGES, NO FINDINGS): write none of them.",
    "For a blocked fix stage, return fail with blocked:true and a non-empty blockedReason (at most 2000 characters) in stage_report or the fallback JSON. Set blocked only when you cannot proceed: cannot build, cannot run required checks, or a handed finding is impossible within the specification. Otherwise omit blocked or set it false; the fixer returns pass unless blocked.",
    "The server resolves your conversation to this stage's attempt and reads the head, the branch's pull request and the declared outputs itself, so claim none of them.",
    "The call records your intent. The stage settles when this turn ends, so you may keep working after it, and calling again before then replaces the report.",
    "Verdicts: pass when the stage's contract is complete; notes that block nothing go in the summary. fail when the work is not done: for a review, one finding per defect the fix stage must address; for any other stage, what stopped it. needs_decision when only the operator can unblock the stage: put the question, what you tried, the options and your recommendation in the summary and attach no findings, because findings on a stage with a fail edge send it to the fix stage.",
    "",
    "Fallback, only when the stage_report call returned an error or the tool is absent from this session: quote that error, then end the turn with one fenced JSON object as the final block, with nothing after it.",
    "```json",
    '{"status":"pass","findings":[]}',
    "```",
    "Its status uses the same three words. In the block each finding is a string that starts with its severity, such as \"P1 — what is wrong and where\"; the block has no summary key, so write the summary as prose above it.",
  ].join("\n");
}

export function renderOutOfMemoryRetryInput(previousInput: string | null, attempt: number, kill: Pick<AgentMemoryKill, "limitBytes" | "limit">): string {
  return [previousInput ?? "", `The previous attempt of this stage (attempt ${attempt}) was ${memoryKillText(kill)}. Its changes are still in this worktree; continue from them. Keep memory-heavy commands (benchmarks, browsers, large test runs) within the limit: smaller inputs, or one at a time.`].filter(Boolean).join("\n\n");
}

/** A cut attempt keeps its worktree and receives a durable recovery note. */
export function renderCutRetryInput(previousInput: string | null, n: number, reason: string): string {
  return `${previousInput ?? ""}\n\nAttempt ${n} was cut by ${reason}. Its changes remain in this worktree. Continue from them, keeping uncommitted work, and report when the stage is complete.`;
}
