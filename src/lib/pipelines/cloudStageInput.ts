import type { MemoryEngineStart } from "@/lib/memory/deliveryLedger";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";
import type { StagePromptContext } from "./prompts";
import type { EffectivePipelineRole, Pipeline, PipelineStage } from "./types";

/** Render with the local composer; learned rules remain an intentional private
 * instruction block, not part of the scrubbed task and relayed output. */
export async function composeCloudStageInput(
  pipeline: Pipeline, stage: PipelineStage, role: EffectivePipelineRole, previousOutput: string,
  context?: StagePromptContext, start?: MemoryEngineStart,
): Promise<string[]> {
  // The hosted transport also uses the split/framing helpers in operator
  // scripts. Resolve state-owning composition modules only when composing.
  const { composeStageText } = await import("./stageInput");
  const { stageMemoryForLaunch } = await import("@/lib/memory/roleStage");
  const { learnedRulesForLaunchProfile } = await import("@/lib/memory/roleLaunch");
  const { withCurrentRoleMemory } = await import("@/lib/memory/privacy");
  const { handoffDigest } = { ...pipeline.inputContext, ...context };
  if ((pipeline.srcConversationId || pipeline.srcPath) && !handoffDigest?.trim()) {
    throw new Error("A source conversation requires a handoff digest; raw transcripts are not accepted.");
  }
  return withCurrentRoleMemory(async () => {
    const prompt = await composeStageText(pipeline, stage, role, previousOutput, context);
    const profile = stageMemoryForLaunch(pipeline, stage, role.roleId);
    const memory = await learnedRulesForLaunchProfile({ ...profile, learnedRules: profile.learnedRules ?? undefined }, start);
    return splitCloudInput([memory, prompt].filter(Boolean).join("\n\n"));
  });
}

/** Cut only between Unicode code points. Concatenation recovers every byte. */
export function splitCloudInput(text: string): string[] {
  const bytes = Buffer.from(text);
  const turns: string[] = [];
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(offset + MAX_STRUCTURED_TEXT_BYTES - 256, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    turns.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return turns;
}

/** Leave framing inside the same structured-text envelope as each part. */
export function cloudInputTurn(turns: readonly string[], index: number): string {
  return turns.length === 1 ? turns[index]! :
    `Input part ${index + 1}/${turns.length}. ${index + 1 < turns.length ? "Acknowledge only; wait for all parts before working." : "All parts delivered; now carry out the complete input."}\n\n${turns[index]}`;
}
