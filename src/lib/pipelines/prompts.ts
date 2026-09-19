import type { EffectivePipelineRole, Pipeline, PipelineStage } from "./types";
import { pipelineStageSandbox } from "./stageSandbox";

const RELAY_PLACEHOLDER = "{{prev.output}}";

function replaceAll(source: string, token: string, value: string): string {
  return source.split(token).join(value);
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
    ? ["", "Previous stage output (relayed by the controller; the prompt above did not place {{prev.output}}):", relayed]
    : [];
  const declaredOutputs = stage.outputs?.length ? stage.outputs.map((output) => `\`${output}\``).join(", ") : null;
  const access = role.access === "read-only"
    ? declaredOutputs
      ? `Access: read-only. Inspect and validate freely. You may write only these declared worktree outputs: ${declaredOutputs}. Do not commit, stage, push, edit any other repository path, or mutate production.`
      : "Access: read-only. Inspect and validate freely. Do not edit, stage, commit, push, or otherwise mutate the repository or production."
    : "Access: read-write. Work only inside this pipeline's dedicated worktree and commit-ready scope.";
  const hostAccess = pipelineStageSandbox(stage) === "restricted"
    ? "Host access: restricted. This stage runs inside the engine sandbox."
    : "Host access: full. Network, SSH, GitHub CLI, and the pipeline worktree are available.";
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
    "Pipeline nesting is forbidden. Never create or start another pipeline from this stage.",
    "",
    /* One completion channel, one fallback (#1797): asking for the call AND an
       unconditional fenced block let a stage treat the block as the real answer
       and skip the call, which is where every unreadable-verdict park fell. The
       engine still reads the block exactly as before when no report arrived. */
    "Report this stage's completion with the Viewer MCP tool stage_report: { verdict, findings: [{ severity: P0 | P1 | P2 | P3, text }], summary }. That call is the only way to complete this stage.",
    "The server resolves your conversation to this stage's attempt and reads the head, the branch's pull request and the declared outputs itself, so claim none of them.",
    "The call records your intent. The stage settles when this turn ends, so you may keep working after it, and calling again before then replaces the report.",
    "Use pass when the stage contract is complete, fail for a retryable stage failure, and needs_decision when operator judgment is required. Pass carries no findings, so use fail or needs_decision when findings describe unresolved work.",
    "",
    "Fallback, only when the stage_report call returned an error or the tool is absent from this session: quote that error, then end the turn with one fenced JSON object as the final block, with nothing after it.",
    "```json",
    '{"status":"pass","findings":[],"confidence":0.9}',
    "```",
    "In that block the status uses the same vocabulary, and any prose terminal marker must agree with it: APPROVE=pass, REQUEST_CHANGES=fail, COMMENT=needs_decision, NO FINDINGS agrees with pass.",
  ].join("\n");
}
