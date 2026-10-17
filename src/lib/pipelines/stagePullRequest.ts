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

type Result = { ok: true } | { ok: false; error: string };

/** Called under the settlement's lane lock and cancellation fence, outside
 * the state mutation lease. Discovery recovers a create whose reply was lost. */
export async function ensureStagePullRequest(pipeline: Pipeline, attempt: PipelineStageAttempt, exec: ExecPort, acceptedHead = pipeline.lastPassedCommit): Promise<Result> {
  const delivery = pipeline.delivery;
  if (!delivery || delivery.publish !== "enabled" || !delivery.active || delivery.disposition !== "owner"
    || delivery.ownerId !== pipeline.id || acceptedHead === pipeline.baseRef) return { ok: true };
  const repository = githubRepositoryOfRemote(delivery.target.remote);
  if (!repository) return { ok: false, error: "the delivery remote has no supported pull request service" };
  const branch = delivery.target.branch.replace(/^refs\/heads\//, "");
  const find = async (): Promise<number | null> => {
    const read = await exec("gh", ["pr", "list", "--repo", repository, "--head", branch, "--base", pipeline.baseBranch,
      "--state", "open", "--limit", "2", "--json", "number,headRefName,baseRefName,state,headRefOid,isCrossRepository"], pipeline.worktreeDir,
      undefined, { timeoutMs: 30_000 });
    if (read.code !== 0) throw new Error("the delivery pull request lookup failed");
    const rows = JSON.parse(read.stdout);
    if (!Array.isArray(rows) || rows.length > 1) throw new Error("the delivery pull request is ambiguous");
    if (!rows.length) return null;
    const pr = rows[0];
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 || pr.headRefName !== branch || pr.baseRefName !== pipeline.baseBranch
      || pr.state !== "OPEN" || pr.isCrossRepository !== false || pr.headRefOid !== acceptedHead
      || (delivery.target.pr !== undefined && delivery.target.pr !== pr.number)) throw new Error("the delivery pull request does not match the accepted branch and head");
    return pr.number;
  };
  try {
    let number = await find();
    if (number === null) {
      if (delivery.target.pr !== undefined) return { ok: false, error: "the linked pull request is not open on the delivery branch" };
      const producer = attempt.effectiveRole.access !== "read-only" ? attempt : pipeline.runs.flatMap(run => run.attempts)
        .filter(a => a.effectiveRole.access !== "read-only" && (a.report?.summary || a.output))
        .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0] ?? attempt;
      const body = producer?.report?.summary?.trim() || producer?.output?.trim() || "";
      const title = pipeline.task.split("\n").map(line => line.trim()).find(Boolean)?.slice(0, 120) ?? "";
      const text = `${title}\n${body}`;
      const decoded = canonicalSensitiveText(text, true);
      if (!body || body.length > 60 * 1024 || decoded.error || await pipelinePublicationTextSafe(text) === null
        || staticSensitiveClasses(decoded.text).size || mailboxPattern(true).test(decoded.text)) {
        return { ok: false, error: "the stage summary or title was refused by the publication privacy gate" };
      }
      const directory = await fs.mkdtemp(path.join(pipelineArtifactsDir(pipeline.id), "pull-request-"));
      try {
        const bodyFile = path.join(directory, "body.md");
        const titleFile = path.join(directory, "title.txt");
        await fs.writeFile(bodyFile, body, { mode: 0o600 });
        await fs.writeFile(titleFile, title, { mode: 0o600 });
        const gate = path.join(pipeline.worktreeDir, "scripts", "privacy-publication-gate.ts");
        try {
          await fs.access(gate);
          const checked = await exec("bun", [gate, "--require-known-values", "--paths", bodyFile, titleFile], pipeline.worktreeDir,
            { LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: path.join(pipeline.worktreeDir, "scripts", "privacy-known-value-fingerprints.json") }, { timeoutMs: 60_000 });
          if (checked.code !== 0) return { ok: false, error: "the repository publication privacy gate refused the pull request text" };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const created = await exec("gh", ["pr", "create", "--repo", repository, "--title", title, "--body-file", bodyFile,
          "--base", pipeline.baseBranch, "--head", branch], pipeline.worktreeDir, engineForgeWriteEnv(), { timeoutMs: 60_000 });
        // A timeout/status is no proof of whether creation landed. Read the
        // branch again before either acceptance or a future create retry.
        number = await find();
        if (number === null) return { ok: false, error: created.code === 0
          ? "the forge answered without a linked delivery pull request" : "the delivery pull request could not be opened" };
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
    delivery.target.pr = number;
    return { ok: true };
  } catch { return { ok: false, error: "the delivery pull request could not be verified; the stage cannot pass without it" }; }
}
