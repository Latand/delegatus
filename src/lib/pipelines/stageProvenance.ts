import type { ExecPort } from "@/lib/workflows/provision";

import { pipelineWorktreeChanges } from "./git";
import { pathIsDeclaredOutput } from "./stageAccess";
import type { Pipeline, PipelineStageProvenance } from "./types";

/** The forge read is the only remote call a completion report makes. Bound it,
    and treat anything it cannot answer as "no pull request observed", which
    still accepts the report: a forge outage says nothing about the stage's own
    work. The caller runs this before it takes the pipeline mutation, so the
    bound is what keeps one unanswered connection off the report's latency. */
const PULL_REQUEST_LOOKUP_TIMEOUT = "10s";
const MAX_UNCOMMITTED_PATHS = 20;

type PullRequest = NonNullable<PipelineStageProvenance["pullRequest"]>;

function headOf(worktreeDir: string, exec: ExecPort): string | null {
  const head = exec("git", ["rev-parse", "HEAD"], worktreeDir);
  const sha = head.code === 0 ? head.stdout.trim() : "";
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/** Every path the worktree knows under the stage's declared outputs, tracked
    and untracked alike, so a report can say whether what the stage promised to
    produce is actually there. */
function declaredOutputPresence(
  worktreeDir: string,
  declaredOutputs: readonly string[],
  exec: ExecPort,
): PipelineStageProvenance["outputs"] {
  if (declaredOutputs.length === 0) return [];
  const known = exec(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...declaredOutputs],
    worktreeDir,
  );
  const paths = known.code === 0 ? known.stdout.split("\0").filter(Boolean) : [];
  return declaredOutputs.map((output) => ({
    path: output,
    present: paths.some((candidate) => pathIsDeclaredOutput(candidate, [output])),
  }));
}

function pullRequestOf(worktreeDir: string, branch: string, exec: ExecPort): PullRequest | null {
  if (!branch) return null;
  const listed = exec(
    "timeout",
    [
      "--signal=KILL", PULL_REQUEST_LOOKUP_TIMEOUT,
      "gh", "pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "url,number,state",
    ],
    worktreeDir,
  );
  if (listed.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(listed.stdout.trim() || "[]");
  } catch {
    return null;
  }
  const first = Array.isArray(parsed) ? parsed[0] : null;
  if (!first || typeof first !== "object") return null;
  const record = first as Record<string, unknown>;
  if (typeof record.url !== "string" || !Number.isSafeInteger(record.number) || typeof record.state !== "string") return null;
  return { url: record.url, number: record.number as number, state: record.state };
}

/**
 * What the server itself can see about a stage attempt's work (graph slice 2).
 *
 * The completion call carries a verdict, findings and a summary; everything an
 * agent could otherwise assert about its own work — which commit it left, what
 * it published, whether it produced what the stage declared — is read here
 * instead, so the record on the attempt states what the server saw. No read
 * refuses the report: a field the server could not read is `null`, which
 * describes the read itself.
 */
export function collectStageProvenance(
  pipeline: Pick<Pipeline, "worktreeDir" | "branch">,
  declaredOutputs: readonly string[],
  exec: ExecPort,
): PipelineStageProvenance {
  const changes = pipelineWorktreeChanges(pipeline, exec, MAX_UNCOMMITTED_PATHS);
  return {
    head: headOf(pipeline.worktreeDir, exec),
    branch: pipeline.branch,
    uncommitted: changes.ok ? changes.paths : null,
    pullRequest: pullRequestOf(pipeline.worktreeDir, pipeline.branch, exec),
    outputs: declaredOutputPresence(pipeline.worktreeDir, declaredOutputs, exec),
  };
}
