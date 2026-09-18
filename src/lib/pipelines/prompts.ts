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
    "Finish the completed turn with one fenced JSON object as the final block. This block is the only completion authority:",
    "```json",
    '{"status":"pass","findings":[],"confidence":0.9}',
    "```",
    "Use pass when the stage contract is complete, fail for a retryable stage failure, and needs_decision when operator judgment is required.",
    "Pass requires findings to be empty or omitted. Use fail or needs_decision when findings describe unresolved work.",
    "Every prose terminal marker must agree with the JSON status: APPROVE=pass, REQUEST_CHANGES=fail, COMMENT=needs_decision. NO FINDINGS agrees with pass.",
    "Human-readable output may appear before the JSON block. Never place text after the block.",
  ].join("\n");
}
