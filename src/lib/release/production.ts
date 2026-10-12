import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { activeDrain } from "@/lib/selfUpdate/drain";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { mergeOnReviewEnabled } from "@/lib/projects/settings";
import { effectiveSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { ledgerDeployments } from "@/lib/runtime/deploymentLedger";
import { repoDirForProject, viewerOwnProjectKeys, type SeatTickSources } from "@/lib/monitor/seatTickSources";
import { createTask } from "@/lib/tasks/commands";
import { mutateTasksFile } from "@/lib/tasks/store";
import { pipelineDeliveryLookup } from "@/lib/pipelines/store";
import { createPipelineFromRequest } from "@/lib/pipelines/engine";
import { productionReleaseController, releaseRequestDigest, type ReleasePorts } from "./run";
import { releaseCut, type ReleaseChange, type ReleaseDeployment } from "./policy";
import { RELEASE_DEFAULTS } from "./settings";
import { SEAT_TICK_WAKE_INTERVAL_MS } from "@/lib/monitor/seatTick";

async function command(file: string, args: string[], cwd?: string): Promise<string> {
  return (await promisify(execFile)(file, args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}
/** `bun` is the host bridge in a container, just as it is for the capture agent.
    Never infer host tools from the image's filesystem or dev dependencies. */
export async function captureTools(repoDir: string, run: typeof command = command): Promise<{ missing: string[]; chrome: string | null }> {
  const probe = String.raw`
    const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
    const executable = p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };
    const missing = ["tesseract", "pdftocairo"].filter(tool => !Bun.which(tool));
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
  if (!Array.isArray(value.missing) || value.missing.some(tool => !["tesseract", "pdftocairo", "Chrome"].includes(tool))
    || value.chrome !== null && typeof value.chrome !== "string" || !value.chrome && !value.missing.includes("Chrome")) throw new Error("capture tools could not be read");
  return value;
}
export async function requiredReleaseChecks(repo: string, commits: string[]): Promise<"green" | "red" | "pending"> {
  const branch = JSON.parse(await command("gh", ["api", `repos/${repo}/branches/main`])) as { protection?: { required_status_checks?: { contexts?: string[]; checks?: { context: string }[] } } };
  const required = [...new Set([...(branch.protection?.required_status_checks?.contexts ?? []), ...(branch.protection?.required_status_checks?.checks?.map(c => c.context) ?? [])])];
  let pending = false;
  for (const sha of [...new Set(commits)]) {
    const runs = JSON.parse(await command("gh", ["api", `repos/${repo}/commits/${sha}/check-runs?per_page=100`])) as { check_runs: { name: string; status: string; conclusion: string | null }[] };
    const statuses = JSON.parse(await command("gh", ["api", `repos/${repo}/commits/${sha}/status?per_page=100`])) as { statuses: { context: string; state: string }[] };
    for (const name of required) {
      const run = runs.check_runs.find(c => c.name === name);
      const status = statuses.statuses.find(c => c.context === name);
      if (run?.conclusion && !["success", "neutral", "skipped"].includes(run.conclusion) || status && ["failure", "error"].includes(status.state)) return "red";
      if (!(run?.status === "completed" && ["success", "neutral", "skipped"].includes(run.conclusion ?? "") || status?.state === "success")) pending = true;
    }
  }
  return pending ? "pending" : "green";
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
      await git("fetch", "origin", "main", "--tags");
      const main = await git("rev-parse", "origin/main");
      const tagLines = (await git("for-each-ref", "--sort=-creatordate", "--format=%(refname:short) %(creatordate:unix)", "refs/tags/v*")).split("\n");
      const tagLine = tagLines.find(line => /^v\d+\.\d+\.\d+ \d+$/.test(line));
      if (!tagLine) throw new Error("release waits for an existing version tag");
      const [name, timestamp] = tagLine.split(" ");
      const version = name.slice(1); const at = Number(timestamp) * 1000;
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
      const changes: ReleaseChange[] = [];
      if (cut) {
        const commits = (await git("log", "--first-parent", "--format=%H %s", `${name}..${cut.revision}`)).split("\n").filter(Boolean);
        for (const line of commits) {
          const space = line.indexOf(" "); const sha = line.slice(0, space); const subject = line.slice(space + 1);
          if (!/(\(#\d+\)|Merge pull request #\d+)/.test(subject)) continue;
          const files = (await git("diff", "--name-only", `${sha}^`, sha)).split("\n").filter(Boolean);
          changes.push({ subject, files });
        }
      }
      const pkg = JSON.parse(await git("show", "origin/main:package.json"));
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${version}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok && response.status !== 404) throw new Error("release registry status is unreadable");
      const registryHasTag = response.ok && (await response.json() as { version?: string }).version === version;
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
    create: async (request, key) => {
      const result = await createPipelineFromRequest(request, undefined, { creationRequest: { key, digest: releaseRequestDigest(request) } });
      if (!result.pipeline) throw new Error(result.error ?? "release pipeline refused");
      return result.pipeline.id;
    },
    lookup: key => pipelineDeliveryLookup({ requestKey: key })?.id ?? null,
    pipeline: id => {
      const lane = [...sources.pipelines(), ...sources.archivedPipelines()].find(p => p.id === id);
      return lane ? { state: lane.state, merged: lane.merge?.state === "merged",
        declined: !!lane.decisionAnswers?.some(a => a.stageId === "publish" && /не випускати|decline|do not release/i.test(a.answer)) } : null;
    },
  };
  return productionReleaseController(ports);
}
