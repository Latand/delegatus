import type { ExecPort } from "@/lib/workflows/provision";
import crypto from "node:crypto";

import { pipelineWorktreeChanges } from "./git";
import { pathIsDeclaredOutput } from "./stageAccess";
import { observeForgePullRequest } from "@/lib/forge/cache";
import { pipelineRepository } from "@/lib/forge/resolve";
import { loadPipelines, withPipelineMutation } from "./store";
import type { Pipeline, PipelineStageProvenance } from "./types";

/** Forge observation runs after durable report acceptance. A timeout or an
    unreadable answer records unknown provenance without changing the verdict. */
const MAX_UNCOMMITTED_PATHS = 20;

type PullRequest = NonNullable<PipelineStageProvenance["pullRequest"]>;

/** Freeze the admitted lane, excluding observer records that this check writes.
    Report sequence and conversation are fenced independently at settlement. */
export function stageProvenanceFence(pipeline: Pipeline): string {
  return crypto.createHash("sha256").update(JSON.stringify({ ...pipeline, stageReports: undefined,
    runs: pipeline.runs.map((run) => ({ ...run, attempts: run.attempts.map((attempt) => ({ ...attempt, report: undefined })) })) })).digest("hex");
}

async function headOf(worktreeDir: string, exec: ExecPort): Promise<string | null> {
  const head = (await exec("git", ["rev-parse", "HEAD"], worktreeDir));
  const sha = head.code === 0 ? head.stdout.trim() : "";
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/** Every path the worktree knows under the stage's declared outputs, tracked
    and untracked alike, so a report can say whether what the stage promised to
    produce is actually there. */
async function declaredOutputPresence(
  worktreeDir: string,
  declaredOutputs: readonly string[],
  exec: ExecPort,
): Promise<PipelineStageProvenance["outputs"]> {
  if (declaredOutputs.length === 0) return [];
  const known = (await exec(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...declaredOutputs],
    worktreeDir,
  ));
  const paths = known.code === 0 ? known.stdout.split("\0").filter(Boolean) : [];
  return declaredOutputs.map((output) => ({
    path: output,
    present: known.code !== 0 ? null : paths.some((candidate) => pathIsDeclaredOutput(candidate, [output])),
  }));
}

async function pullRequestOf(worktreeDir: string, branch: string, exec: ExecPort): Promise<{ pullRequest: PullRequest | null; pullRequestState: "observed" | "absent" | "unknown" }> {
  if (!branch) return { pullRequest: null, pullRequestState: "unknown" };
  const listed = (await exec(
    "gh",
    [
      "pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "url,number,state",
    ],
    worktreeDir,
  ));
  if (listed.code !== 0) return { pullRequest: null, pullRequestState: "unknown" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(listed.stdout.trim());
  } catch {
    return { pullRequest: null, pullRequestState: "unknown" };
  }
  const first = Array.isArray(parsed) ? parsed[0] : null;
  if (Array.isArray(parsed) && parsed.length === 0) return { pullRequest: null, pullRequestState: "absent" };
  if (!first || typeof first !== "object") return { pullRequest: null, pullRequestState: "unknown" };
  const record = first as Record<string, unknown>;
  if (typeof record.url !== "string" || !Number.isSafeInteger(record.number) || typeof record.state !== "string") return { pullRequest: null, pullRequestState: "unknown" };
  return { pullRequest: { url: record.url, number: record.number as number, state: record.state }, pullRequestState: "observed" };
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
export async function collectStageProvenance(
  pipeline: Pick<Pipeline, "worktreeDir" | "branch">,
  declaredOutputs: readonly string[],
  exec: ExecPort,
): Promise<PipelineStageProvenance> {
  const checkedOut = await exec("git", ["branch", "--show-current"], pipeline.worktreeDir);
  const branch = checkedOut.code === 0 && checkedOut.stdout.trim() ? checkedOut.stdout.trim() : pipeline.branch;
  const changes = await pipelineWorktreeChanges(pipeline, exec, MAX_UNCOMMITTED_PATHS);
  const head = await headOf(pipeline.worktreeDir, exec);
  const outputs = await declaredOutputPresence(pipeline.worktreeDir, declaredOutputs, exec);
  const forge = await pullRequestOf(pipeline.worktreeDir, branch, exec);
  return {
    state: checkedOut.code === 0 && checkedOut.stdout.trim() && head && changes.ok
      && outputs.every((output) => output.present !== null) && forge.pullRequestState !== "unknown" ? "complete" : "unknown",
    head, branch, uncommitted: changes.ok ? changes.paths : null, ...forge, outputs,
  };
}

/** Pending intent is durable. Observation is attached only to the same report
    sequence and conversation, including when its turn has already settled. */
export async function settlePendingStageProvenance(ports: Pick<import("./engine").PipelinePorts, "exec" | "now">): Promise<void> {
  for (const pipeline of loadPipelines()) for (const run of pipeline.runs) for (const attempt of run.attempts) {
    const report = attempt.report;
    if (report?.provenance.state !== "pending") continue;
    const abort = new AbortController();
    const currentLane = () => loadPipelines().find((item) => item.id === pipeline.id);
    const matches = (current: Pipeline | undefined) => current !== undefined
      && report.provenanceFence !== undefined && stageProvenanceFence(current) === report.provenanceFence;
    const revalidate = () => {
      const current = currentLane();
      const attempts = current?.runs.find((item) => item.stageId === run.stageId)?.attempts;
      if (!matches(current) || attempts?.find((item) => item.n === attempt.n)?.report?.seq !== report.seq
        || attempts?.at(-1)?.n !== attempt.n || current?.cursor?.stageId !== run.stageId) abort.abort();
    };
    const watch = setInterval(revalidate, 50);
    const exec: ExecPort = async (command, args, cwd, env, options) => {
      revalidate();
      if (abort.signal.aborted) return { code: null, stdout: "", stderr: "provenance superseded" };
      return await ports.exec(command, args, cwd, env, { ...options, signal: abort.signal, timeoutMs: command === "gh" ? 10_000 : 5_000 });
    };
    let provenance: PipelineStageProvenance;
    try { provenance = await collectStageProvenance(pipeline, report.provenance.outputs.map((output) => output.path), exec); }
    catch { provenance = { ...report.provenance, state: "unknown", pullRequestState: "unknown" }; }
    finally { clearInterval(watch); }
    revalidate();
    if (abort.signal.aborted) provenance = { ...report.provenance, state: "unknown", pullRequestState: "unknown" };
    await withPipelineMutation((pipelines, persist) => {
      const current = pipelines.find((item) => item.id === pipeline.id);
      const candidate = current?.runs.find((item) => item.stageId === run.stageId)?.attempts.find((item) => item.n === attempt.n);
      if (!current || candidate?.conversationId !== attempt.conversationId || candidate.report?.seq !== report.seq) return;
      if (!matches(current) || current.runs.find((item) => item.stageId === run.stageId)?.attempts.at(-1)?.n !== attempt.n
        || current.cursor?.stageId !== run.stageId) provenance = { ...report.provenance, state: "unknown", pullRequestState: "unknown" };
      candidate.report = { ...candidate.report, provenance };
      current.stageReports = current.stageReports?.map((entry) => entry.seq === report.seq
        ? { ...entry, provenanceState: provenance.state, provenanceAt: ports.now() } : entry);
      persist();
      const repository = provenance.pullRequest ? pipelineRepository(current) : null;
      if (repository && provenance.pullRequest) {
        try { observeForgePullRequest(repository, provenance.pullRequest, provenance.branch, ports.now()); }
        catch { /* The cache sweep retries an optional cache write. */ }
      }
    });
  }
}
