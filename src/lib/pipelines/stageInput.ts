import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";

import { renderStagePrompt } from "./prompts";
import type { EffectivePipelineRole, Pipeline, PipelineStage } from "./types";

/** Compose the launch message before spawn admission. The shared UI renderer
    remains pure; only this server path materializes oversized input parts. */
export function composeStageInput(
  pipeline: Pipeline,
  stage: PipelineStage,
  role: EffectivePipelineRole,
  previousOutput: string,
): string {
  const inline = renderStagePrompt(pipeline, stage, role, previousOutput);
  if (Buffer.byteLength(inline, "utf8") <= MAX_STRUCTURED_TEXT_BYTES) return inline;

  const specification = pipeline.spec?.trim() || "No separate pinned specification was supplied.";
  const artifacts: Array<{ label: string; file: string; text: string }> = [];
  const artifact = (label: string, text: string) => {
    const digest = crypto.createHash("sha256").update(text).digest("hex");
    const file = path.resolve(statePath("pipeline-stage-inputs", `${label.replaceAll(" ", "-")}-${digest}.md`));
    const part = { label, file, text };
    artifacts.push(part);
    return part;
  };
  const previousFile = previousOutput ? artifact("previous output", previousOutput) : null;
  const render = (headBytes: number, specFile: ReturnType<typeof artifact> | null) => renderStagePrompt(
    specFile ? { ...pipeline, spec: artifactReference(specFile, headBytes) } : pipeline, stage, role,
    previousFile ? artifactReference(previousFile, headBytes) : previousOutput,
  );
  const fit = (specFile: ReturnType<typeof artifact> | null) => {
    let prompt = "";
    /* Count every substituted reference, labels and UTF-8 bytes too. Tight
       prompts retain a smaller head, while both full inputs stay on disk. */
    for (const headBytes of [512, 128, 32, 4]) {
      prompt = render(headBytes, specFile);
      if (Buffer.byteLength(prompt) <= MAX_STRUCTURED_TEXT_BYTES) break;
    }
    return prompt;
  };
  let prompt = fit(null);
  const specFile = Buffer.byteLength(prompt) > MAX_STRUCTURED_TEXT_BYTES && pipeline.spec?.trim()
    ? artifact("specification", pipeline.spec) : null;
  if (specFile) prompt = fit(specFile);
  if (Buffer.byteLength(prompt, "utf8") > MAX_STRUCTURED_TEXT_BYTES) {
    const withoutRelay = (text: string) => text.split("{{task}}").join(pipeline.task).split("{{prev.output}}").join("").trim();
    const promptBytes = Buffer.byteLength(withoutRelay(stage.prompt));
    const scaffoldBytes = role.roleId && role.promptScaffold ? Buffer.byteLength(withoutRelay(role.promptScaffold)) : 0;
    const specBytes = Buffer.byteLength(specification);
    const framingBytes = Buffer.byteLength(renderStagePrompt(pipeline, stage, role, "")) - promptBytes - scaffoldBytes - specBytes;
    throw new Error(`stage ${stage.id} input cannot fit the ${MAX_STRUCTURED_TEXT_BYTES}-byte bound: prompt=${promptBytes} bytes; role scaffold=${scaffoldBytes} bytes; previous output=${Buffer.byteLength(previousOutput)} bytes; specification=${specBytes} bytes; framing=${framingBytes} bytes. Shorten the stage prompt or role scaffold.`);
  }
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

