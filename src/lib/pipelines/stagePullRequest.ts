import fs from "node:fs/promises";
import path from "node:path";
import { engineForgeWriteEnv } from "@/lib/git/agentForgeCredentials";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { canonicalSensitiveText } from "@/lib/privacy/canonicalText";
import { staticSensitiveClasses } from "@/lib/privacy/staticDetectors";
import { mailboxPattern } from "@/lib/privacy/mailbox";
import type { ExecPort } from "@/lib/workflows/provision";
import { pipelinePublicationTextSafe } from "./git";
import { pipelineArtifactsDir } from "./store";
import type { Pipeline, PipelineStageAttempt } from "./types";

export type PullRequestTextRefusal = { part: "title" | "body" | "title/body"; check: string; kind: string; line?: number };
export type StagePullRequestResult = { ok: true } | { ok: false; error: string; privacy?: PullRequestTextRefusal };

export function stagePullRequestProducer(pipeline: Pipeline, attempt: PipelineStageAttempt): PipelineStageAttempt {
  return attempt.effectiveRole.access !== "read-only" ? attempt : pipeline.runs.flatMap(run => run.attempts)
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
  return refused(part, "repository publication privacy gate", kinds.join(", ") || "inspection-error");
}

/** Called under the settlement's lane lock and cancellation fence, outside
 * the state mutation lease. Discovery recovers a create whose reply was lost. */
export async function ensureStagePullRequest(pipeline: Pipeline, attempt: PipelineStageAttempt, exec: ExecPort, acceptedHead = pipeline.lastPassedCommit): Promise<StagePullRequestResult> {
  const delivery = pipeline.delivery;
  if (!delivery || delivery.publish !== "enabled" || !delivery.active || delivery.disposition !== "owner"
    || delivery.ownerId !== pipeline.id || (acceptedHead === pipeline.baseRef && delivery.target.pr === undefined)) return { ok: true };
  const repository = githubRepositoryOfRemote(delivery.target.remote);
  if (!repository) return { ok: false, error: "the delivery remote has no supported pull request service" };
  const branch = delivery.target.branch.replace(/^refs\/heads\//, "");
  const find = async (): Promise<{ ok: true; number: number | null } | Extract<StagePullRequestResult, { ok: false }>> => {
    const linked = delivery.target.pr;
    const fields = "number,headRefName,baseRefName,state,headRefOid,isCrossRepository";
    const args = linked !== undefined
      ? ["pr", "view", String(linked), "--repo", repository, "--json", fields]
      : ["pr", "list", "--repo", repository, "--head", branch, "--base", pipeline.baseBranch,
        "--state", "open", "--limit", "2", "--json", fields];
    const read = await exec("gh", args, pipeline.worktreeDir, undefined, { timeoutMs: 30_000 });
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
    if (mismatches.length) return { ok: false, error: `the delivery pull request differs in ${mismatches.join(", ")}` };
    return { ok: true, number: pr.number };
  };
  try {
    const found = await find();
    if (!found.ok) return found;
    let number = found.number;
    if (number === null) {
      const producer = stagePullRequestProducer(pipeline, attempt);
      const body = producer.report?.summary?.trim() || producer.output?.trim() || "";
      const title = pipeline.task.split("\n").map(line => line.trim()).find(Boolean)?.slice(0, 120) ?? "";
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
            const checked = await Promise.resolve().then(() => exec("bun", [gate, "--require-known-values", "--paths", file], pipeline.worktreeDir,
              { LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: path.join(pipeline.worktreeDir, "scripts", "privacy-known-value-fingerprints.json") }, { timeoutMs: 60_000 }))
              .catch(() => ({ code: 1, stdout: "", stderr: "" }));
            if (checked.code !== 0) return repositoryRefusal(part, checked.stdout);
          }
        }
        const created = await exec("gh", ["pr", "create", "--repo", repository, "--title", title, "--body-file", bodyFile,
          "--base", pipeline.baseBranch, "--head", branch], pipeline.worktreeDir, engineForgeWriteEnv(), { timeoutMs: 60_000 });
        // A timeout/status is no proof of whether creation landed. Read the
        // branch again before either acceptance or a future create retry.
        const recovered = await find();
        if (!recovered.ok) return recovered;
        number = recovered.number;
        if (number === null) return { ok: false, error: created.code === 0
          ? "the forge answered without a linked delivery pull request" : "the delivery pull request could not be opened" };
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
    delivery.target.pr = number;
    return { ok: true };
  } catch { return { ok: false, error: "the delivery pull request could not be verified; the stage cannot pass without it" }; }
}
