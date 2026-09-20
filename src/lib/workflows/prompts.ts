import type { Round } from "@/lib/reviewHistory/types";

import type { Workflow } from "./types";

/**
 * Prompt templates for workflow stages (W12). Wording changes happen here
 * without touching the state machine that delivers them. All kickoffs are
 * English, composed per stage from the task brief, the stage scope and the
 * prior stages' STAGE_DONE notes.
 */

/** Prior stages' done notes as a handoff block, oldest first. */
function priorNotes(wf: Workflow, uptoIndex: number): string[] {
  const notes: string[] = [];
  for (const run of wf.stageRuns) {
    if (run.index >= uptoIndex || !run.doneAt) continue;
    const stage = wf.template.stages[run.index];
    const owner = stage?.kind === "implement" ? stage.scope : `stage ${run.index + 1}`;
    notes.push(`- Stage ${run.index + 1} (${owner}): ${run.doneNote || "done, no note left"}`);
  }
  if (!notes.length) return [];
  return ["Notes from the stages already finished in this worktree:", ...notes, ""];
}

function verifyLines(wf: Workflow): string[] {
  return wf.template.verify
    ? [`Before declaring the stage done, verify your work: run \`${wf.template.verify}\` and get it green.`]
    : ["Before declaring the stage done, verify your work with the project's own build/test commands."];
}

export function stageKickoff(wf: Workflow, stageIndex: number): string {
  const stage = wf.template.stages[stageIndex];
  const scope = stage?.kind === "implement" ? stage.scope : "";
  return [
    `You are stage ${stageIndex + 1} of workflow "${wf.name}", running in the dedicated worktree ${wf.worktreeDir} on branch ${wf.branch}.`,
    "",
    "Task brief:",
    wf.task.trim(),
    "",
    `Your scope for this stage: ${scope}`,
    "Stay inside that scope — other stages own the rest of the work.",
    "",
    ...priorNotes(wf, stageIndex),
    ...verifyLines(wf),
    "Commit your work in this worktree; later stages and the final PR build on your commits.",
    "",
    "When the stage is complete, end your final assistant message with a line that starts exactly with:",
    "STAGE_DONE: <one-line note for the next stage>",
    "Do not print the STAGE_DONE marker now and never quote it at the start of a line when acknowledging these instructions — print it only when the stage is actually complete. The note travels to the next stage's kickoff, so state where the contract lives and what the next stage should build on.",
  ].join("\n");
}

/** Kickoff of the dedicated fixer (W5): cheap hands that apply findings. */
export function fixerKickoff(wf: Workflow): string {
  const reviewIndex = wf.template.stages.length - 1;
  return [
    `You are the fixer of workflow "${wf.name}", running in the dedicated worktree ${wf.worktreeDir} on branch ${wf.branch}.`,
    "",
    "Task brief:",
    wf.task.trim(),
    "",
    ...priorNotes(wf, reviewIndex),
    "The implementation stages above are finished. A review loop starts now: a fresh reviewer examines the full workflow diff each round and its findings arrive here as messages.",
    "",
    "For each finding, apply the fix or argue against it. Respond to every finding with:",
    "FIXED",
    "or",
    "REJECTED — <reason>",
    "Give concrete arguments for rejections because the next reviewer is fresh and blind to previous discussion.",
    "",
    ...verifyLines(wf),
    "Commit the fixes you apply. When every finding is addressed and the work is reviewable again, end your final assistant message with a line that starts exactly with:",
    "REVIEW_READY: <one-line note>",
    "Do not print the REVIEW_READY marker now and never quote it at the start of a line when acknowledging these instructions — print it only after addressing a round's findings.",
  ].join("\n");
}

/** PR body (W7): task brief + stage notes + rounds summary + the footer. */
export function prBody(wf: Workflow, rounds: Round[]): string {
  const stageLines = wf.stageRuns
    .filter((run) => run.doneAt)
    .map((run) => {
      const stage = wf.template.stages[run.index];
      const owner = stage?.kind === "implement" ? stage.scope.split(/[.:\n]/)[0] : "review loop";
      return `- Stage ${run.index + 1} (${owner}): ${run.doneNote || "done"}`;
    });
  const roundLines = rounds.map(
    (round) =>
      `- Round ${round.n}: ${round.verdict ?? "no verdict"}${round.findingsCount != null ? ` (${round.findingsCount} findings)` : ""}`,
  );
  return [
    "## Task",
    "",
    wf.task.trim(),
    "",
    "## Stages",
    "",
    ...(stageLines.length ? stageLines : ["- (no stage notes recorded)"]),
    "",
    "## Review rounds",
    "",
    ...(roundLines.length ? roundLines : ["- (no review rounds recorded)"]),
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n");
}
