import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { activeDrain } from "@/lib/selfUpdate/drain";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { mergeOnReviewEnabled } from "@/lib/projects/settings";
import { effectiveSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { ledgerDeployments } from "@/lib/runtime/deploymentLedger";
import { repoDirForProject, viewerOwnProjectKeys, type SeatTickSources } from "@/lib/monitor/seatTickSources";
import { createTask } from "@/lib/tasks/commands";
import { loadTasksByIds, mutateTasksFile } from "@/lib/tasks/store";
import { pipelineDeliveryLookup } from "@/lib/pipelines/store";
import { createPipelineFromRequest } from "@/lib/pipelines/engine";
import type { CreatePipelineRequest } from "@/lib/pipelines/types";
import { MAX_STAGE_PROMPT_LENGTH } from "@/lib/pipelines/limits";
import { productionReleaseController, releaseRequestDigest, ReleaseValidationRefusal, type ReleasePorts } from "./run";
import { releaseCut, type ReleaseChange, type ReleaseDeployment } from "./policy";
import { RELEASE_DEFAULTS } from "./settings";
import { SEAT_TICK_WAKE_INTERVAL_MS } from "@/lib/monitor/seatTick";

async function command(file: string, args: string[], cwd?: string): Promise<string> {
  return (await promisify(execFile)(file, args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}
/** Fetch before selecting: version order is independent of tagger clocks and backfills. */
export async function latestReleaseTag(repoDir: string, run: typeof command = command) {
  await run("git", ["fetch", "origin", "main", "--tags"], repoDir);
  const lines = (await run("git", ["for-each-ref", "--sort=-version:refname", "--format=%(refname:short) %(creatordate:unix)", "refs/tags/v*"], repoDir)).split("\n");
  const line = lines.find(line => /^v\d+\.\d+\.\d+ \d+$/.test(line));
  if (!line) throw new Error("release waits for an existing version tag");
  const [name, timestamp] = line.split(" ");
  return { name, version: name.slice(1), at: Number(timestamp) * 1000 };
}
async function registryHasRelease(packageName: string, version: string): Promise<boolean> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok && response.status !== 404) throw new Error("release registry status is unreadable");
  return response.ok && (await response.json() as { version?: string }).version === version;
}
/** A tag alone cannot prove publication, and an unrelated cut cannot supersede this run. */
export async function supersedingReleaseTag(repoDir: string, saved: { cut: string; lastTag: string }, run: typeof command = command,
  published: typeof registryHasRelease = registryHasRelease): Promise<string | null> {
  const old = saved.lastTag.slice(1).split(".").map(BigInt);
  await run("git", ["fetch", "origin", "main", "--tags"], repoDir);
  const lines = (await run("git", ["for-each-ref", "--sort=-version:refname", "--format=%(refname:short)", "refs/tags/v*"], repoDir)).split("\n");
  const candidates = lines.filter(name => /^v\d+\.\d+\.\d+$/.test(name)).filter(name => {
    const next = name.slice(1).split(".").map(BigInt);
    for (let index = 0; index < old.length; index++) {
      if (next[index] !== old[index]) return next[index] > old[index];
    }
    return false;
  });
  if (candidates.length === 0) return null;
  const pkg = JSON.parse(await run("git", ["show", "origin/main:package.json"], repoDir));
  for (const name of candidates) {
    const version = name.slice(1);
    const revision = await run("git", ["rev-parse", `${name}^{commit}`], repoDir);
    try { await run("git", ["merge-base", "--is-ancestor", saved.cut, revision], repoDir); }
    catch (error) { if ((error as { code?: number }).code === 1) continue; throw error; }
    if (await published(pkg.name, version)) return name;
  }
  return null;
}
export async function changesSinceRelease(repoDir: string, tag: string, cut: string, run: typeof command = command): Promise<ReleaseChange[]> {
  const git = (...args: string[]) => run("git", args, repoDir);
  const changes: ReleaseChange[] = [];
  const commits = (await git("log", "--first-parent", "--format=%H %s", `${tag}..${cut}`)).split("\n").filter(Boolean);
  for (const line of commits) {
    const space = line.indexOf(" "); const sha = line.slice(0, space); const subject = line.slice(space + 1);
    if (!/(\(#\d+\)|Merge pull request #\d+)/.test(subject)) continue;
    const files = (await git("diff", "--name-only", `${sha}^`, sha)).split("\n").filter(Boolean);
    changes.push({ subject, files });
  }
  return changes;
}
/** `bun` is the host bridge in a container, just as it is for the capture agent.
    Never infer host tools from the image's filesystem or dev dependencies. */
export async function captureTools(repoDir: string, run: typeof command = command): Promise<{ missing: string[]; chrome: string | null }> {
  const probe = String.raw`
    const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
    const executable = p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };
    const missing = ["pdftocairo"].filter(tool => !Bun.which(tool));
    let chrome = process.env.CHROME_BIN || ["/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(executable);
    if (!chrome) { try { chrome = require("playwright-core").chromium.executablePath(); } catch {} }
    if (!chrome || !executable(chrome)) {
      if (!process.env.CHROME_BIN) {
        const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");
        try { chrome = fs.readdirSync(cache).filter(dir => /^chromium-/.test(dir)).sort((a,b) => b.localeCompare(a, undefined, {numeric:true})).flatMap(dir => ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win/chrome.exe"].map(p => path.join(cache, dir, p))).find(executable); } catch {}
      }
    }
    if (!chrome || !executable(chrome)) { missing.push("Chrome"); chrome = null; }
    console.log(JSON.stringify({ missing, chrome }));
  `;
  const value = JSON.parse(await run("bun", ["-e", probe], repoDir)) as { missing: string[]; chrome: string | null };
  if (!Array.isArray(value.missing) || value.missing.some(tool => !["pdftocairo", "Chrome"].includes(tool))
    || value.chrome !== null && typeof value.chrome !== "string" || !value.chrome && !value.missing.includes("Chrome")) throw new Error("capture tools could not be read");
  return value;
}
type ReleaseCheckVerdict = "green" | "red" | "pending";
interface ReleaseChecks {
  runs: { check_runs: { name: string; status: string; conclusion: string | null }[] };
  statuses: { statuses: { context: string; state: string }[] };
}
function checkVerdict(name: string, { runs, statuses }: ReleaseChecks): ReleaseCheckVerdict {
  const run = runs.check_runs.find(c => c.name === name);
  const status = statuses.statuses.find(c => c.context === name);
  if (run?.conclusion && !["success", "neutral", "skipped"].includes(run.conclusion) || status && ["failure", "error"].includes(status.state)) return "red";
  return run?.status === "completed" && ["success", "neutral", "skipped"].includes(run.conclusion ?? "") || status?.state === "success" ? "green" : "pending";
}
async function readReleaseChecks(repo: string, sha: string, run: typeof command): Promise<ReleaseChecks> {
  const runs = JSON.parse(await run("gh", ["api", `repos/${repo}/commits/${sha}/check-runs?per_page=100`]));
  const statuses = JSON.parse(await run("gh", ["api", `repos/${repo}/commits/${sha}/status?per_page=100`]));
  return { runs, statuses };
}
/** Only this known PR-only context can use merge evidence. Unknown contexts
    still wait on the release SHA, including a newly required push check. */
async function mergedRuntimeVerdict(repo: string, sha: string, run: typeof command): Promise<ReleaseCheckVerdict> {
  const workflow = Bun.YAML.parse(await run("gh", ["api", `repos/${repo}/contents/.github/workflows/bun-runtime.yml?ref=${sha}`,
    "--header", "Accept: application/vnd.github.raw+json"])) as { on?: string | string[] | Record<string, unknown>; jobs?: Record<string, { name?: string }> };
  const events = typeof workflow.on === "string" ? [workflow.on] : Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on ?? {});
  const job = workflow.jobs?.["runtime-gate"];
  // Read the definition at each checked revision: restoring a push trigger
  // restores the requirement for a run on that revision, even before it starts.
  if (events.includes("push") || !events.includes("pull_request") || !job || job.name && job.name !== "runtime-gate") return "pending";
  const pulls = JSON.parse(await run("gh", ["api", `repos/${repo}/commits/${sha}/pulls?per_page=100`])) as {
    merged_at?: string | null; merge_commit_sha?: string; base?: { ref?: string; repo?: { full_name?: string } }; head?: { sha?: string };
  }[];
  const head = pulls.find(p => p.merged_at && p.merge_commit_sha === sha && p.base?.ref === "main"
    && p.base.repo?.full_name?.toLowerCase() === repo.toLowerCase())?.head?.sha;
  if (!head || !/^[a-f0-9]{40}$/.test(head)) return "pending";
  // Branch protection applies at merge time; also require the actual PR gate
  // so direct pushes and missing, pending or failed PR evidence cannot pass.
  return checkVerdict("runtime-gate", await readReleaseChecks(repo, head, run));
}
export async function requiredReleaseChecks(repo: string, commits: string[], run: typeof command = command): Promise<ReleaseCheckVerdict> {
  const branch = JSON.parse(await run("gh", ["api", `repos/${repo}/branches/main`])) as { protection?: { required_status_checks?: { contexts?: string[]; checks?: { context: string }[] } } };
  const required = [...new Set([...(branch.protection?.required_status_checks?.contexts ?? []), ...(branch.protection?.required_status_checks?.checks?.map(c => c.context) ?? [])])];
  let pending = false;
  for (const sha of [...new Set(commits)]) {
    const checks = await readReleaseChecks(repo, sha, run);
    for (const name of required) {
      let verdict = checkVerdict(name, checks);
      if (name === "runtime-gate" && !checks.runs.check_runs.some(c => c.name === name) && !checks.statuses.statuses.some(c => c.context === name)) {
        verdict = await mergedRuntimeVerdict(repo, sha, run);
      }
      if (verdict === "red") return "red";
      if (verdict === "pending") pending = true;
    }
  }
  return pending ? "pending" : "green";
}
export async function createReleasePipeline(request: CreatePipelineRequest, key: string, create = createPipelineFromRequest): Promise<string> {
  const digest = releaseRequestDigest(request);
  const result = await create(request, undefined, { creationRequest: { key, digest } });
  if (result.pipeline) return result.pipeline.id;
  // Only an oversized prompt's structured validation refusal proves this payload
  // cannot be admitted by a competing seat. A status or error string proves nothing.
  if (result.status === 400 && request.stages.some((stage, index) => typeof stage.prompt === "string"
    && stage.prompt.trim().length > MAX_STAGE_PROMPT_LENGTH
    && result.violations?.some(violation => violation.field === `stages[${index}].prompt`))) {
    throw new ReleaseValidationRefusal(digest, result.error ?? "release prompt refused");
  }
  throw new Error(result.error ?? "release pipeline refused");
}
export function releaseControllerForSources(sources: SeatTickSources) {
  const ports: ReleasePorts = {
    now: sources.now, settings: project => sources.settings(project).release,
    observe: async (project, frozenCut) => {
      const repoDir = repoDirForProject(project, sources);
      if (!repoDir) throw new Error("release repository is unavailable");
      const seat = sources.seatFor(project).active;
      const src = seat ? sources.registry().conversation(seat.conversationId as never)?.generations.at(-1)?.path : null;
      if (!src) throw new Error("release waits for an active seat transcript");
      const git = (...args: string[]) => command("git", args, repoDir);
      const tag = await latestReleaseTag(repoDir);
      const main = await git("rev-parse", "origin/main");
      const { name, version, at } = tag;
      const setting = { ...RELEASE_DEFAULTS, ...sources.settings(project).release };
      const isAncestor = async (a: string, b: string) => {
        try { await git("merge-base", "--is-ancestor", a, b); return true; }
        catch (error) { if ((error as { code?: number }).code === 1) return false; throw error; }
      };
      const ledger = viewerOwnProjectKeys().includes(project) ? ledgerDeployments(Number.MAX_SAFE_INTEGER) : null;
      const deployments: ReleaseDeployment[] = [];
      for (const d of ledger?.state === "ok" ? ledger.value : []) {
        if (d.phase === "succeeded" && d.terminal && await isAncestor(d.revision, main)) deployments.push({ revision: d.revision, at: Date.parse(d.updatedAt) });
      }
      const cut = frozenCut ? { revision: frozenCut } : await releaseCut(deployments, isAncestor, sources.now());
      const changes = cut ? await changesSinceRelease(repoDir, name, cut.revision) : [];
      const pkg = JSON.parse(await git("show", "origin/main:package.json"));
      const registryHasTag = await registryHasRelease(pkg.name, version);
      const repo = await command("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], repoDir);
      return { repoDir, src, policy: { now: sources.now(), enabled: setting.enabled, requested: false,
        tickEnabled: effectiveSeatTickSettings(sources.settings(project), sources.now(), SEAT_TICK_WAKE_INTERVAL_MS).enabled,
        mergeEnabled: mergeOnReviewEnabled(project),
        live: sources.pipelines().some(p => canonicalOrchestratorProject(p.project) === project && p.state !== "closed"
          && !(p.state === "completed" && p.merge?.state === "merged") && /^(Release\s+(Delegatus|\d)|Реліз\s)/i.test(p.task)),
        mainVersion: pkg.version, lastTag: { name, version, at }, registryHasTag,
        checks: await requiredReleaseChecks(repo, [main, ...(cut ? [cut.revision] : [])]), hold: null,
        draining: !!activeDrain(), deploying: ledger?.state === "ok" && !!ledger.value[0] && !ledger.value[0].terminal,
        tools: (await captureTools(repoDir)).missing, minChanges: setting.minChanges, minGapHours: setting.minGapHours, changes, deployments, isAncestor } };
    },
    taskDone: (project, id) => loadTasksByIds(new Set([id])).some(task => task.id === id
      && canonicalOrchestratorProject(task.project) === project && task.status === "done"),
    supersedingTag: async (project, run) => {
      const repoDir = repoDirForProject(project, sources);
      if (!repoDir) throw new Error("release repository is unavailable");
      return supersedingReleaseTag(repoDir, run);
    },
    task: (project, run, adopted) => {
      if (adopted) {
        const existing = sources.tasks().find(t => t.id === adopted && canonicalOrchestratorProject(t.project) === project && t.status !== "done");
        if (!existing) throw new Error("requested release task is unavailable");
        return existing.id;
      }
      const outcome = mutateTasksFile(state => {
        const result = createTask(state.tasks, { project, text: run.request!.task, details: run.request!.spec, icon: "rocket", color: "amber", placement: "unplaced", findingKey: run.key, clientRequestId: run.key }, state.recentCreates, { allowBoardOverflow: true });
        return { state: result.ok && !result.replay ? { tasks: result.tasks, recentCreates: result.recentCreates } : undefined, result };
      });
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome.task.id;
    },
    create: createReleasePipeline,
    lookup: key => pipelineDeliveryLookup({ requestKey: key })?.id ?? null,
    pipeline: id => {
      const lane = [...sources.pipelines(), ...sources.archivedPipelines()].find(p => p.id === id);
      return lane ? { state: lane.state, merged: lane.merge?.state === "merged",
        declined: !!lane.decisionAnswers?.some(a => a.stageId === "publish" && /не випускати|decline|do not release/i.test(a.answer)) } : null;
    },
  };
  return productionReleaseController(ports);
}
