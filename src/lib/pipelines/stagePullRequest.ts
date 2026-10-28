import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { performanceSpans } from "@/lib/performanceSpans";
import { engineForgeWriteEnv } from "@/lib/git/agentForgeCredentials";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { canonicalSensitiveText } from "@/lib/privacy/canonicalText";
import { staticSensitiveClasses } from "@/lib/privacy/staticDetectors";
import { mailboxPattern } from "@/lib/privacy/mailbox";
import type { ExecPort, ExecResult } from "@/lib/workflows/provision";
import { pipelinePublicationTextSafe } from "./git";
import { pipelineArtifactsDir } from "./store";
import type { Pipeline, PipelineStageAttempt } from "./types";

export type PullRequestTextRefusal = { part: "title" | "body" | "title/body"; check: string; kind: string; line?: number };
export type StagePullRequestResult = { ok: true } | { ok: false; error: string; inspection?: true; privacy?: PullRequestTextRefusal };

function isFinalBudgetFix(attempt: PipelineStageAttempt): boolean {
  return attempt.activatedBy?.edge === "fail" && attempt.activatedBy.budgetSpent === true;
}

export function stagePullRequestProducer(pipeline: Pipeline, attempt: PipelineStageAttempt): PipelineStageAttempt {
  return isFinalBudgetFix(attempt) || attempt.effectiveRole.access !== "read-only" ? attempt : pipeline.runs.flatMap(run => run.attempts)
    .filter(a => !a.historical && a.effectiveRole.access !== "read-only" && (a.report?.summary || a.output))
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0] ?? attempt;
}

function refused(part: PullRequestTextRefusal["part"], check: string, kind: string, line?: number): StagePullRequestResult {
  return { ok: false, privacy: { part, check, kind, ...(line ? { line } : {}) },
    error: `pull request publication privacy gate refused ${part} [redacted]: ${check} (${kind})`
      + (line ? `; decoded line ${line}` : "")
      + (part.includes("title") ? "; the title comes from the pipeline task; the seat must correct that task line" : "") };
}

/** No detector output or matched value is copied into a refusal. */
export async function inspectPullRequestText(part: PullRequestTextRefusal["part"], text: string): Promise<StagePullRequestResult> {
  if (!text.trim() || (part !== "title/body" && text.length > (part === "title" ? 120 : 60 * 1024))) return refused(part, "size", "size");
  const decoded = canonicalSensitiveText(text, true);
  if (decoded.error) return refused(part, "canonicalSensitiveText", "decode");
  const view = decoded.text.normalize("NFKC");
  const lines = new Map<string, number>();
  const lineAt = (offset: number) => view.slice(0, offset).split("\n").length;
  const classes = staticSensitiveClasses(view, (kind, start, end) => {
    const contentStart = start + (view.slice(start, end).match(/^\s*/)?.[0].length ?? 0);
    if (!lines.has(kind)) lines.set(kind, lineAt(contentStart));
  });
  if (classes.size) {
    const kind = [...classes].sort()[0];
    return refused(part, "staticSensitiveClasses", kind === "home_path" ? "absolute-path" : kind.replaceAll("_", "-"), lines.get(kind));
  }
  const mailbox = mailboxPattern(true).exec(view);
  if (mailbox) return refused(part, "mailboxPattern", "email", lineAt(mailbox.index));
  if (await pipelinePublicationTextSafe(text) === null) return refused(part, "pipelinePublicationTextSafe", "known-value");
  return { ok: true };
}

// Parse only the gate's fixed class vocabulary, never arbitrary stdout/stderr.
const repositoryClasses = ["configuration_error", "credential", "email_address", "home_path", "inspection_error",
  "known_value", "media_live_source", "private_network", "provenance_invalid", "provenance_missing",
  "resource_identifier", "tool_unavailable", "transcript_content", "unsafe_path"];
const repositoryClassNames: Record<string, string> = { home_path: "absolute-path", email_address: "email", known_value: "known-value" };
function repositoryRefusal(part: "title" | "body", output: string): StagePullRequestResult {
  const kinds = repositoryClasses.filter(kind => new RegExp(`^${kind}: [1-9][0-9]*$`, "m").test(output))
    .map(kind => repositoryClassNames[kind] ?? kind.replaceAll("_", "-"));
  const content = kinds.filter(kind => !["configuration-error", "inspection-error", "tool-unavailable"].includes(kind));
  // A reported content finding stays decisive even beside an inspection error.
  return content.length ? refused(part, "repository publication privacy gate", content.join(", "))
    : { ok: false, inspection: true, error: `pull request publication privacy gate inspection-error for ${part}` };
}

const INSPECTION_BUDGET_MS = 60_000;
async function available(file: string): Promise<string> {
  return fs.access(file, fs.constants.R_OK).then(() => "available").catch(error =>
    (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable");
}

/** Inspect the complete diagnostic with the publication rules before retaining
 * a bounded tail. Unsafe diagnostics retain only the fixed refusal class. */
async function diagnosticTail(stderr: string): Promise<string> {
  if (!stderr.trim()) return "no stderr";
  const safe = await inspectPullRequestText("title/body", stderr);
  return safe.ok ? stderr.trim().slice(-1_000) : `[redacted: ${safe.privacy?.kind ?? "inspection-error"}]`;
}

async function inspectRepositoryText(part: "title" | "body", file: string, gate: string, titleFile: string,
  bodyFile: string, pipeline: Pipeline, exec: ExecPort, timing: HeadRetryTiming): Promise<StagePullRequestResult> {
  const fingerprints = path.join(pipeline.worktreeDir, "scripts", "privacy-known-value-fingerprints.json");
  const inputs = Object.fromEntries(await Promise.all(Object.entries({ gate, fingerprints, title: titleFile,
    body: bodyFile, worktree: pipeline.worktreeDir }).map(async ([name, input]) => [name, await available(input)])));
  const started = timing.now();
  let checked: ExecResult;
  let spawn = "none";
  try {
    checked = await exec("bun", [gate, "--require-known-values", "--paths", file], pipeline.worktreeDir,
      { LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: fingerprints }, { timeoutMs: INSPECTION_BUDGET_MS });
  } catch (error) {
    const failure = error as { code?: unknown; signal?: unknown; stderr?: unknown } | null;
    const code = failure?.code;
    spawn = typeof code === "string" && ["ENOENT", "EACCES", "EAGAIN", "ETIMEDOUT"].includes(code) ? code : "exception";
    checked = { code: typeof code === "number" && Number.isSafeInteger(code) ? code : null, stdout: "",
      signal: typeof failure?.signal === "string" && /^SIG[A-Z0-9]+$/.test(failure.signal) ? failure.signal as NodeJS.Signals : null,
      stderr: [error instanceof Error ? error.message : "subprocess threw", typeof failure?.stderr === "string" ? failure.stderr : ""].join("\n") };
  }
  if (checked.code === 0 && !checked.signal && Object.values(inputs).every(value => value === "available")) return { ok: true };
  const elapsedMs = Math.max(0, Math.round(timing.now() - started));
  // A killed/timed-out child has no trustworthy completed content verdict.
  const result = checked.code === null || checked.signal || spawn !== "none"
    ? { ok: false as const, inspection: true as const, error: `pull request publication privacy gate inspection-error for ${part}` }
    : repositoryRefusal(part, checked.stdout);
  if (result.ok) return result;
  const cause = Object.values(inputs).some(value => value !== "available") ? "missing-input"
    : spawn === "ETIMEDOUT" || /^command timed out after [0-9]+ms/.test(checked.stderr) ? "timeout"
    : checked.signal ? "signal" : checked.code === null || spawn !== "none" ? "spawn" : "exit";
  return { ...result, error: `${result.error}; gate diagnostic ${JSON.stringify({ cause, exit: checked.code,
    signal: /^SIG[A-Z0-9]+$/.test(checked.signal ?? "") ? checked.signal : null, spawn,
    elapsedMs, budgetMs: INSPECTION_BUDGET_MS, inputs, stderrTail: await diagnosticTail(checked.stderr) })}` };
}

const HEAD_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 14_000];
const HEAD_RETRY_BUDGET_MS = 30_000;
type HeadRetryTiming = { now(): number; sleep(ms: number): Promise<void> };

/** Called under the settlement's lane lock and cancellation fence, outside
 * the state mutation lease. Discovery recovers a create whose reply was lost. */
export async function ensureStagePullRequest(pipeline: Pipeline, attempt: PipelineStageAttempt, exec: ExecPort, acceptedHead = pipeline.lastPassedCommit,
  timing: HeadRetryTiming = { now: () => performance.now(), sleep }): Promise<StagePullRequestResult> {
  const delivery = pipeline.delivery;
  if (!delivery || delivery.publish !== "enabled" || !delivery.active || delivery.disposition !== "owner"
    || delivery.ownerId !== pipeline.id || (acceptedHead === pipeline.baseRef && delivery.target.pr === undefined)) return { ok: true };
  const repository = githubRepositoryOfRemote(delivery.target.remote);
  if (!repository) return { ok: false, error: "the delivery remote has no supported pull request service" };
  const branch = delivery.target.branch.replace(/^refs\/heads\//, "");
  const refresh = isFinalBudgetFix(attempt);
  // Only this attempt's accepted publication can explain a temporarily stale
  // PR head. Review checks and older publication receipts keep refusing at once.
  const operation = delivery.operation;
  const justPublished = pipeline.publishedCommit === acceptedHead && operation?.sha === acceptedHead
    && operation.epoch === delivery.epoch && operation.state === "settled" && operation.passedStage === true
    && operation.requestKey === `pass:${pipeline.cursor?.stageId}:${attempt.n}`
    && operation.result?.ok === true && operation.result.remote === "published";
  type Found = { ok: true; number: number | null; body?: string; title?: string } | (Extract<StagePullRequestResult, { ok: false }> & { retryHead?: true });
  const readOnce = async (timeoutMs: number): Promise<Found> => {
    const linked = delivery.target.pr;
    const fields = "number,headRefName,baseRefName,state,headRefOid,isCrossRepository" + (refresh ? ",body,title" : "");
    const args = linked !== undefined
      ? ["pr", "view", String(linked), "--repo", repository, "--json", fields]
      : ["pr", "list", "--repo", repository, "--head", branch, "--base", pipeline.baseBranch,
        "--state", "open", "--limit", "2", "--json", fields];
    const read = await exec("gh", args, pipeline.worktreeDir, undefined, { timeoutMs });
    if (read.code !== 0) return { ok: false, error: "the delivery pull request lookup failed" };
    const rows = linked !== undefined ? [JSON.parse(read.stdout)] : JSON.parse(read.stdout);
    if (!Array.isArray(rows) || rows.length > 1) return { ok: false, error: "the delivery pull request is ambiguous" };
    if (!rows.length) return { ok: true, number: null };
    const pr = rows[0];
    // A linked PR is addressed in the delivery repository. Its base can differ
    // from a successor lane's base, which is commonly the PR's own head branch.
    const mismatches = [
      !Number.isSafeInteger(pr?.number) || pr.number < 1 || (linked !== undefined && pr.number !== linked) ? "number" : null,
      pr?.state !== "OPEN" ? `state (expected OPEN, received ${["CLOSED", "MERGED"].includes(pr?.state) ? pr.state : "unknown"})` : null,
      pr?.headRefName !== branch ? "headRefName" : null,
      pr?.headRefOid !== acceptedHead ? "headRefOid" : null,
      pr?.isCrossRepository !== false ? "isCrossRepository (expected same repository)" : null,
      linked === undefined && pr?.baseRefName !== pipeline.baseBranch ? "baseRefName" : null,
    ].filter(Boolean);
    if (mismatches.length) return { ok: false, error: `the delivery pull request differs in ${mismatches.join(", ")}`,
      ...(mismatches.length === 1 && mismatches[0] === "headRefOid" ? { retryHead: true } : {}) };
    return { ok: true, number: pr.number, body: pr.body, title: pr.title };
  };
  const find = async (): Promise<Found> => {
    let found = await readOnce(30_000);
    if (found.ok || !found.retryHead || !justPublished) return found;
    // The retry deadline covers both asynchronous sleeps and every gh read.
    // The settlement executor revalidates its cancellation/ownership fence
    // before each read; the controller's mutation lease is never held here.
    return withViewerOperation("pipelines.controller-job", () => performanceSpans.wait("pipeline.pull-request", async () => {
      const deadline = timing.now() + HEAD_RETRY_BUDGET_MS;
      for (const delay of HEAD_RETRY_DELAYS_MS) {
        if (deadline - timing.now() <= delay) break;
        await timing.sleep(delay);
        const remaining = deadline - timing.now();
        if (remaining <= 0) break;
        found = await readOnce(remaining);
        if (found.ok || !found.retryHead) return found;
      }
      return found;
    }));
  };
  try {
    const found = await find();
    if (!found.ok) return { ok: false, error: found.error };
    let number = found.number;
    if (number !== null && attempt.pullRequestInspection) attempt.error = attempt.pullRequestInspection.detail;
    if (refresh && number !== null && (typeof found.body !== "string" || typeof found.title !== "string")) {
      delivery.target.pr = number;
      attempt.error = `pull request publication privacy gate inspection-error: existing PR inputs ${JSON.stringify({
        body: typeof found.body === "string" ? "available" : "missing", title: typeof found.title === "string" ? "available" : "missing" })}`;
      delete attempt.pullRequestInspection;
      return { ok: true };
    }
    if (number === null || refresh) {
      const producer = stagePullRequestProducer(pipeline, attempt);
      const summary = producer.report?.summary?.trim() || producer.output?.trim() || "";
      const update = `## Latest pipeline result\n\nHead: \`${acceptedHead}\`\n\n**Last fix was not re-reviewed: review budget spent.**\n\n`
        + `Fix stage report (supersedes earlier head, checks and review-status statements):\n\n${summary}\n\n---\n\n`;
      // Preserve the producer's description and attribution footer byte for
      // byte. The exact prefix also recovers a lost edit acknowledgement.
      if (refresh && number !== null && found.body!.startsWith(update)) {
        delivery.target.pr = number;
        return { ok: true };
      }
      const body = refresh ? update + (number === null ? "" : found.body!) : summary;
      const title = found.title ?? pipeline.task.split("\n").map(line => line.trim()).find(Boolean)?.slice(0, 120) ?? "";
      for (const [part, value] of [["title", title], ["body", body]] as const) {
        const inspected = await inspectPullRequestText(part, value);
        if (!inspected.ok) return inspected;
      }
      // Keep every original combined check: a match can span both parts.
      const combined = await inspectPullRequestText("title/body", `${title}\n${body}`);
      if (!combined.ok) return combined;
      const directory = await fs.mkdtemp(path.join(pipelineArtifactsDir(pipeline.id), "pull-request-"));
      try {
        const bodyFile = path.join(directory, "body.md");
        const titleFile = path.join(directory, "title.txt");
        await fs.writeFile(bodyFile, body, { mode: 0o600 });
        await fs.writeFile(titleFile, title, { mode: 0o600 });
        const gate = path.join(pipeline.worktreeDir, "scripts", "privacy-publication-gate.ts");
        const hasGate = await fs.access(gate).then(() => true).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        });
        if (hasGate) {
          for (const [part, file] of [["title", titleFile], ["body", bodyFile]] as const) {
            const checked = await inspectRepositoryText(part, file, gate, titleFile, bodyFile, pipeline, exec, timing);
            if (!checked.ok) {
              if (checked.inspection) {
                // A create may have landed independently, or a final fix may
                // already have a PR. Re-read its identity after the failure.
                const existing = await find();
                if (existing.ok && existing.number !== null) {
                  delivery.target.pr = existing.number;
                  attempt.error = checked.error;
                  delete attempt.pullRequestInspection;
                  return { ok: true };
                }
              }
              return checked;
            }
          }
        }
        const creating = number === null;
        const written = await exec("gh", creating
          ? ["pr", "create", "--repo", repository, "--title", title, "--body-file", bodyFile,
            "--base", pipeline.baseBranch, "--head", branch]
          : ["api", "-X", "PATCH", `repos/${repository}/pulls/${number}`, "-F", `body=@${bodyFile}`],
        pipeline.worktreeDir, engineForgeWriteEnv(), { timeoutMs: 60_000 });
        // A timeout/status is no proof of whether a write landed. Read the
        // branch and, for a refresh, the body before accepting or retrying.
        const recovered = await find();
        if (!recovered.ok) return { ok: false, error: recovered.error };
        number = recovered.number;
        if (number === null) return { ok: false, error: written.code === 0
          ? "the forge answered without a linked delivery pull request" : "the delivery pull request could not be opened" };
        if (refresh && recovered.body !== body)
          return { ok: false, error: "the delivery pull request body refresh could not be verified; the stage cannot pass without it" };
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
    delivery.target.pr = number;
    delete attempt.pullRequestInspection;
    return { ok: true };
  } catch { return { ok: false, error: refresh
    ? "the delivery pull request body refresh could not be verified; the stage cannot pass without it"
    : "the delivery pull request could not be verified; the stage cannot pass without it" }; }
}
