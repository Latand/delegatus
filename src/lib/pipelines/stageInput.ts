import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";

import { CONTROLLER_ARTIFACT_DIRECTORY, prepareControllerArtifactDirectory } from "./controllerArtifacts";
import { renderStagePrompt } from "./prompts";
import type { EffectivePipelineRole, Pipeline, PipelineStage } from "./types";

/** Compose the launch message before spawn admission. The shared UI renderer
    remains pure; only this server path materializes oversized input parts. */
export function composeStageInput(
  pipeline: Pipeline,
  stage: PipelineStage,
  role: EffectivePipelineRole,
  previousOutput: string,
  worktreeDir: string = pipeline.worktreeDir,
): string {
  const inline = renderStagePrompt(pipeline, stage, role, previousOutput);
  if (Buffer.byteLength(inline, "utf8") <= MAX_STRUCTURED_TEXT_BYTES) return inline;

  excludeControllerArtifacts(worktreeDir);

  const specification = pipeline.spec?.trim() || "No separate pinned specification was supplied.";
  const artifacts: Array<{ label: string; file: string; text: string }> = [];
  const artifact = (label: string, text: string) => {
    const digest = crypto.createHash("sha256").update(text).digest("hex");
    const file = path.resolve(worktreeDir, CONTROLLER_ARTIFACT_DIRECTORY, `${label.replaceAll(" ", "-")}-${digest}.md`);
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

/** Keep private controller handoffs readable in the worktree while ensuring
    Git status and ordinary `git add -A` never treat them as stage changes. */
function excludeControllerArtifacts(worktreeDir: string): void {
  let excludeFile: string;
  try {
    excludeFile = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
      cwd: worktreeDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Unit fixtures can compose input against a directory that is not a Git
    // worktree. Real pipeline worktrees always are, and take the guarded path.
    if (fs.existsSync(path.join(worktreeDir, ".git"))) {
      throw new Error(`cannot protect pipeline stage input artifacts in ${worktreeDir}`);
    }
    return;
  }
  const rule = "/.artifacts/pipeline-stage-inputs/";
  const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
  prepareControllerArtifactDirectory(worktreeDir);
  if (existing.split(/\r?\n/).includes(rule)) return;
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true, mode: 0o700 });
  fs.appendFileSync(excludeFile, `${existing && !existing.endsWith("\n") ? "\n" : ""}${rule}\n`, { encoding: "utf8", mode: 0o600 });
}

function artifactReference(part: { label: string; file: string; text: string }, headBytes: number): string {
  const bytes = Buffer.from(part.text, "utf8");
  let end = Math.min(headBytes, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `Full ${part.label} file: ${part.file}\nRead the full file before working. Head excerpt:\n${bytes.subarray(0, end).toString("utf8")}\n[Excerpt ends; the file contains the full text.]`;
}
