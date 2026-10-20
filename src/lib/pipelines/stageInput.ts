import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { storedLessonRevision, RoleMemoryRefusal } from "@/lib/memory/roleStore";
import { withCurrentRoleMemory, withoutStoredLessonsAsync } from "@/lib/memory/privacy";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";

import { prepareControllerArtifactDirectory, protectExistingControllerArtifacts } from "./controllerArtifacts";
import { effectiveWorkerLimit } from "@/lib/operator/workerLimit";
import { renderStagePrompt } from "./prompts";
import { resolveStageTestGuidance } from "./testGuidance";
import type { EffectivePipelineRole, Pipeline, PipelineStage } from "./types";
import { realExec, type ExecPort } from "@/lib/workflows/provision";

/** Compose the launch message before spawn admission. The shared UI renderer
    remains pure; this server path materializes oversized parts, falling back
    to the complete rendered prompt when substitutions or framing do not fit.
    `reserveBytes` stays free for what dispatch adds (role memory's pointer to
    its learned rules). A stored lesson the inputs quote (a report relayed as
    the previous output) is withheld from the message and from every file. */
export async function composeStageInput(
  pipeline: Pipeline,
  stage: PipelineStage,
  role: EffectivePipelineRole,
  previousOutput: string,
  worktreeDir: string = pipeline.worktreeDir,
  exec: ExecPort = realExec,
  reserveBytes = 0,
): Promise<string> {
  return withCurrentRoleMemory(() => composeCurrentStageInput(pipeline, stage, role, previousOutput, worktreeDir, exec, reserveBytes));
}

async function composeCurrentStageInput(
  pipeline: Pipeline, stage: PipelineStage, role: EffectivePipelineRole, previousOutput: string,
  worktreeDir: string, exec: ExecPort, reserveBytes: number,
): Promise<string> {
  const revision = storedLessonRevision();
  const assertPrivacy = () => {
    if (storedLessonRevision() !== revision) throw new RoleMemoryRefusal("LESSON_PRIVACY_UNAVAILABLE", "Role-memory privacy changed; nothing was sent");
  };
  const limit = MAX_STRUCTURED_TEXT_BYTES - reserveBytes;
  const workerLimit = effectiveWorkerLimit(pipeline.project).value;
  const testGuidance = resolveStageTestGuidance();
  const inline = await withoutStoredLessonsAsync(renderStagePrompt(pipeline, stage, role, previousOutput, workerLimit, testGuidance));
  if (Buffer.byteLength(inline, "utf8") <= limit) {
    await protectExistingControllerArtifacts(worktreeDir, exec);
    assertPrivacy();
    return inline;
  }

  const directory = await prepareControllerArtifactDirectory(worktreeDir, exec);

  const artifacts: Array<{ label: string; file: string; text: string }> = [];
  const artifact = async (label: string, text: string) => {
    const digest = crypto.createHash("sha256").update(text).digest("hex");
    const file = path.join(directory, `${label.replaceAll(" ", "-")}-${digest}.md`);
    const part = { label, file, text: await withoutStoredLessonsAsync(text) };
    artifacts.push(part);
    return part;
  };
  const previousFile = previousOutput ? await artifact("previous output", previousOutput) : null;
  const render = (headBytes: number, specFile: Awaited<ReturnType<typeof artifact>> | null) => withoutStoredLessonsAsync(renderStagePrompt(
    specFile ? { ...pipeline, spec: artifactReference(specFile, headBytes) } : pipeline, stage, role,
    previousFile ? artifactReference(previousFile, headBytes) : previousOutput,
    workerLimit,
    testGuidance,
  ));
  const fit = async (specFile: Awaited<ReturnType<typeof artifact>> | null) => {
    let prompt = "";
    /* Count every substituted reference, labels and UTF-8 bytes too. Tight
       prompts retain a smaller head, while both full inputs stay on disk. */
    for (const headBytes of [512, 128, 32, 4]) {
      prompt = await render(headBytes, specFile);
      if (Buffer.byteLength(prompt) <= limit) break;
    }
    return prompt;
  };
  let prompt = await fit(null);
  const specFile = Buffer.byteLength(prompt) > limit && pipeline.spec?.trim()
    ? await artifact("specification", pipeline.spec) : null;
  if (specFile) prompt = await fit(specFile);
  if (Buffer.byteLength(prompt, "utf8") > limit) {
    // Preserve the original renderer's bytes, including every substitution,
    // role instruction, access fence and completion contract. The reference
    // replaces the whole message; unused part references need no files.
    artifacts.length = 0;
    const fullPrompt = await artifact("stage prompt", inline);
    prompt = `Read the complete stage prompt below and carry out all of its instructions.\n${artifactReference(fullPrompt, 512)}`;
  }
  assertPrivacy();
  for (const { file, text } of artifacts) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return prompt;
}

function artifactReference(part: { label: string; file: string; text: string }, headBytes: number): string {
  const bytes = Buffer.from(part.text, "utf8");
  let end = Math.min(headBytes, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `Full ${part.label} file: ${part.file}\nRead the full file before working. Head excerpt:\n${bytes.subarray(0, end).toString("utf8")}\n[Excerpt ends; the file contains the full text.]`;
}
