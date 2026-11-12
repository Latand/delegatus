import fs from "node:fs";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { ForgeAppWriteRefused, type ForgeAppWriter } from "./appWrite";
import { githubReadBackoff } from "./githubReadFailure";
import type { ForgeCacheFile } from "./cache";
import { landedPullRequests } from "./landedPullRequests";
import { isMergeBatchHead, parseMergeBatchTitle } from "./mergeBatchTitle";
import { normalizeWorkLinkInput, workLinkKey, MAX_WORK_LINKS, boundedRepository, type ForgeCacheView, type StoredWorkLink } from "./workLinks";

/** One durable outcome per lane and issue; no provider text is retained. */
export type IssueDelivery = {
  repository: string; number: number; mode: "close" | "part";
  pr: number; batch?: number; at: string;
  state: "pending" | "closed" | "already-closed" | "noted" | "reopened" | "skipped" | "refused";
  reason?: "not-an-issue" | "other-base" | "app-permission" | "github-unavailable";
  failures?: number; retryAt?: string;
};
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
export function isIssueDelivery(value: unknown): value is IssueDelivery {
  if (!value || typeof value !== "object") return false;
  const row = value as IssueDelivery;
  return boundedRepository(row.repository) && positive(row.number) && positive(row.pr) && (row.batch === undefined || positive(row.batch))
    && ["close", "part"].includes(row.mode) && date(row.at)
    && ["pending", "closed", "already-closed", "noted", "reopened", "skipped", "refused"].includes(row.state)
    && (row.reason === undefined || ["not-an-issue", "other-base", "app-permission", "github-unavailable"].includes(row.reason))
    && (row.failures === undefined || (Number.isSafeInteger(row.failures) && row.failures >= 0))
    && (row.retryAt === undefined || date(row.retryAt));
}
export const issueDeliveryFinal = (row: IssueDelivery) => row.state !== "pending";
const canonical = (repo: string, cache: ForgeCacheView) => (cache.repository(repo)?.canonical ?? repo).toLowerCase();
const titleReference = (text: string) => {
  const line = text.split(/\r?\n/, 1)[0]!.trim();
  return /^(?:Issue\s+)?((?:[\w.-]+\/[\w.-]+)?#\d+)(?=$|[\s:–—-])/i.exec(line)?.[1]
    ?? /\((#\d+)\)$/.exec(line)?.[1] ?? null;
};
type PullRequestOf = (lane: Pipeline) => { repository: string; number: number } | null;

/** Pure creation rule. A cache-known PR can only name a predecessor. */
export function creationIssueLinks(lane: Pipeline, options: {
  repository: string | null; cache: ForgeCacheView | (() => ForgeCacheView);
  lanes: readonly Pipeline[] | (() => readonly Pipeline[]);
  predecessorId?: string; predecessor?: (id: string) => Pipeline | null; pullRequestOf: PullRequestOf;
}): StoredWorkLink[] {
  const { repository } = options;
  if (!repository) return [];
  const raw = titleReference(lane.task);
  if (!raw && !options.predecessorId) return [];
  const cache = typeof options.cache === "function" ? options.cache() : options.cache;
  const lanes = () => typeof options.lanes === "function" ? options.lanes() : options.lanes;
  const repo = canonical(repository, cache);
  const normalized = raw ? normalizeWorkLinkInput(raw, { repository, kindOf: (r, n) => cache.repository(r)?.pr(n) ? "pr" : cache.repository(r)?.isIssue(n) ? "issue" : null }) : null;
  const link = normalized?.ok ? normalized.link : null;
  const predecessor = options.predecessorId ? (options.predecessor ? options.predecessor(options.predecessorId) : lanes().find(p => p.id === options.predecessorId))
    : link?.kind === "pr" ? lanes().find(p => p.taskIds.some(id => lane.taskIds.includes(id)) && (() => {
      const pr = options.pullRequestOf(p);
      return pr?.number === link.number && canonical(pr.repository, cache) === canonical(link.repository, cache);
    })()) : undefined;
  const links = (predecessor?.workLinks ?? []).filter(l => l.kind !== "pr" && canonical(l.repository, cache) === repo).map(l => ({ ...l }));
  if (link && link.kind !== "pr" && canonical(link.repository, cache) === repo && !links.some(l => l.number === link.number)) {
    links.push({ ...link, addedAt: lane.createdAt, addedBy: "agent" });
  }
  return links.slice(0, MAX_WORK_LINKS);
}

/** Lane links override task markers. Tasks themselves never store partials. */
export function deliveredIssues(lane: Pipeline, tasks: readonly Pick<BoardTask, "id" | "workLinks">[], repository: string, cache: ForgeCacheView): StoredWorkLink[] {
  const links = new Map<string, StoredWorkLink>();
  for (const link of [...tasks.filter(t => lane.taskIds.includes(t.id)).flatMap(t => t.workLinks ?? []), ...(lane.workLinks ?? [])]) {
    const repo = canonical(link.repository, cache);
    if (link.kind === "pr" || cache.repository(repo)?.pr(link.number) || repo !== canonical(repository, cache)) continue;
    links.set(workLinkKey(repo, link.number), { ...link, repository: repo });
  }
  return [...links.values()];
}

export type LaneLanding = { repository: string; pr: number; batch?: number; at: string };
// Retain one derived index, replaced with the immutable forge snapshot. Warm
// controller ticks never rescan the entire retained PR history.
let landingMemo: { data: ForgeCacheFile; index: Map<string, LaneLanding> } | undefined;
function landingIndex(data: ForgeCacheFile): ReadonlyMap<string, LaneLanding> {
  if (landingMemo?.data === data) return landingMemo.index;
  const index = new Map(landedPullRequests(data).map(p => [workLinkKey(p.repository, p.number), {
    repository: p.repository, pr: p.number, at: p.at, ...(p.batch ? { batch: p.batch } : {}),
  }]));
  landingMemo = { data, index };
  return index;
}

/** One index per sweep, shared with the Done projector. */
export function laneLanding(lane: Pipeline, cache: ReadonlyMap<string, LaneLanding>, prOf: PullRequestOf): LaneLanding | null {
  const pr = prOf(lane);
  if (!pr) return null;
  const found = cache.get(workLinkKey(pr.repository, pr.number));
  if (found) return found;
  return lane.merge?.state === "merged" && date(lane.merge.mergedAt)
    ? { repository: pr.repository, pr: pr.number, at: lane.merge.mergedAt } : null;
}

/** Called by the sole sweep slot, after the Viewer has taken its release fence.
 * Invalid state refuses settlement instead of resetting the rollout boundary. */
export function issueDeliverySince(now: number, file = statePath("issue-delivery.json")): string {
  try {
    const row = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!date(row.since)) throw new Error("Invalid issue delivery boundary");
    return row.since;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const since = new Date(now).toISOString();
    writeJsonDurably(file, { since });
    return since;
  }
}

export interface IssueDeliveryPorts {
  now(): number;
  since(): string;
  loadPipelines(): readonly Pipeline[];
  loadTasks(ids: ReadonlySet<string>): readonly BoardTask[];
  repositoryOf(lane: Pipeline): string | null;
  pullRequestOf: PullRequestOf;
  cache(): { data: ForgeCacheFile; view: ForgeCacheView };
  run(args: string[]): Promise<string>;
  write: ForgeAppWriter;
  mutate(id: string, change: (live: Pipeline) => boolean): Promise<boolean>;
  inspectTitle(title: string): Promise<boolean>;
  prepareRead?(): Promise<void>;
}
class DeliveryChanged extends Error {}
const keyOf = (row: Pick<IssueDelivery, "repository" | "number">) => workLinkKey(row.repository, row.number);
const json = async (ports: IssueDeliveryPorts, route: string, extra: string[] = []) => JSON.parse(await ports.run(["api", route, ...extra]));
const notFound = (error: unknown) => /\b404\b/.test(String((error as { stderr?: unknown })?.stderr ?? error));

/** Independent of publication, merge and task completion. At most ten issues
 * incur I/O per pass. Each production gh call has a 30 second deadline. */
export async function sweepIssueDelivery(ports: IssueDeliveryPorts): Promise<void> {
  return withViewerOperation("forge.sweep", async () => {
    const since = Date.parse(ports.since());
    await ports.prepareRead?.();
    const lanes = ports.loadPipelines();
    const snapshot = ports.cache();
    const identity = (row: Pick<IssueDelivery, "repository" | "number">) => workLinkKey(canonical(row.repository, snapshot.view), row.number);
    const landings = landingIndex(snapshot.data);
    const prOf: PullRequestOf = lane => {
      const pr = ports.pullRequestOf(lane);
      return pr ? { ...pr, repository: canonical(pr.repository, snapshot.view) } : null;
    };
    // Read only tasks belonging to a landed lane in this rollout.
    const landed = lanes.flatMap(lane => {
      const repository = ports.repositoryOf(lane);
      if (!repository) return [];
      const landing = laneLanding(lane, landings, prOf);
      return landing && Date.parse(landing.at) >= since ? [{ lane, landing, repository }] : [];
    });
    const tasks = ports.loadTasks(new Set(landed.flatMap(({ lane }) => lane.taskIds)));
    const taskIndex = new Map(tasks.map(task => [task.id, task]));
    const candidates = landed.flatMap(({ lane, landing, repository }) => deliveredIssues(lane, lane.taskIds.flatMap(id => taskIndex.get(id) ?? []), repository, snapshot.view).map(link => ({ lane, landing, link })));
    // Full deliveries settle first so a partial cannot undo a full close.
    candidates.sort((a, b) => Number(!!a.link.part) - Number(!!b.link.part));
    let work = 0;
    for (const { lane, landing, link } of candidates) {
      const key = keyOf(link);
      const held = lane.issueDelivery?.find(row => identity(row) === key);
      if (held && (issueDeliveryFinal(held) || (held.retryAt && Date.parse(held.retryAt) > ports.now()))) continue;
      if (work++ >= 10) break;
      const mode = link.part ? "part" : "close";
      // Revalidate after every await, including credential minting. No store
      // lock is held across a network call and detached links confer no write.
      const current = () => {
        const live = ports.loadPipelines().find(p => p.id === lane.id);
        const repo = live && ports.repositoryOf(live);
        if (!live || !repo || canonical(repo, snapshot.view) !== canonical(landing.repository, snapshot.view)) throw new DeliveryChanged();
        const pr = ports.pullRequestOf(live);
        if (!pr || pr.number !== landing.pr || canonical(pr.repository, snapshot.view) !== canonical(landing.repository, snapshot.view)) throw new DeliveryChanged();
        const links = deliveredIssues(live, ports.loadTasks(new Set(live.taskIds)), repo, snapshot.view);
        if (!links.some(l => keyOf(l) === key && !!l.part === (mode === "part"))) throw new DeliveryChanged();
        const row = live.issueDelivery?.find(r => identity(r) === key);
        if (row && issueDeliveryFinal(row)) throw new DeliveryChanged();
        return live;
      };
      let receipt: IssueDelivery = { repository: link.repository, number: link.number, mode, pr: landing.pr, ...(landing.batch ? { batch: landing.batch } : {}), at: new Date(ports.now()).toISOString(), state: "pending", failures: held?.failures ?? 0 };
      const save = async () => { await ports.mutate(lane.id, live => {
        current();
        live.issueDelivery = [...(live.issueDelivery ?? []).filter(row => identity(row) !== key), { ...receipt }];
        return true;
      }); };
      const read = async (route: string, extra: string[] = []) => { current(); const result = await json(ports, route, extra); current(); return result; };
      const write = async (args: string[]) => { current(); await ports.write(args, receipt.repository, () => { current(); }); current(); };
      try {
        await save(); current();
        let primary = await read(`repos/${receipt.repository}/pulls/${receipt.batch ?? receipt.pr}`);
        // A runner batch receipt may precede the forge cache. Its verified
        // landing commit identifies the integration PR without scanning history.
        if (!primary.merged_at && !receipt.batch && lane.merge?.mergeCommit) {
          const associated = await read(`repos/${receipt.repository}/commits/${lane.merge.mergeCommit}/pulls?per_page=100`);
          if (!Array.isArray(associated)) throw new Error("Invalid landing PRs");
          const batch = associated.find(p => p.merged_at && isMergeBatchHead(p.head?.ref ?? "") && parseMergeBatchTitle(p.title).includes(receipt.pr));
          if (batch) { receipt.batch = batch.number; primary = await read(`repos/${receipt.repository}/pulls/${receipt.batch}`); }
        }
        if (!primary.merged_at) continue;
        if (receipt.batch && (!isMergeBatchHead(primary.head?.ref ?? "") || !parseMergeBatchTitle(primary.title).includes(receipt.pr))) throw new Error("Batch membership unconfirmed");
        if (!date(primary.merged_at) || !primary.base?.ref || !primary.base?.repo?.default_branch) throw new Error("Invalid landing record");
        if (Date.parse(primary.merged_at) < since) continue;
        if (primary.base.ref !== primary.base.repo.default_branch) {
          receipt.state = "skipped"; receipt.reason = "other-base"; await save(); continue;
        }
        const route = `repos/${receipt.repository}/issues/${receipt.number}`;
        let issue;
        try { issue = await read(route); } catch (error) {
          if (!notFound(error)) throw error;
          receipt.state = "skipped"; receipt.reason = "not-an-issue"; await save(); continue;
        }
        if (issue.pull_request) { receipt.state = "skipped"; receipt.reason = "not-an-issue"; await save(); continue; }
        if (!["open", "closed"].includes(issue.state)) throw new Error("Invalid issue state");
        if (mode === "close" && issue.state === "closed") { receipt.state = "already-closed"; await save(); continue; }
        let reopened = false;
        const fullDelivered = () => ports.loadPipelines().some(p => p.issueDelivery?.some(r => identity(r) === key && r.mode === "close" && ["closed", "already-closed"].includes(r.state)));
        if (mode === "part" && issue.state === "closed" && !fullDelivered()) {
          const [owner, name] = receipt.repository.split("/");
          const result = await read("graphql", ["-f", "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{closer{... on PullRequest{number repository{nameWithOwner}}}}}}}}}", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${receipt.number}`]);
          if (result.errors || !result.data?.repository?.issue?.timelineItems?.nodes) throw new Error("Issue closer unavailable");
          const closer = result.data.repository.issue.timelineItems.nodes.at(-1)?.closer;
          if (closer && [receipt.pr, receipt.batch].includes(closer.number) && canonical(closer.repository?.nameWithOwner ?? "", snapshot.view) === receipt.repository && !fullDelivered()) {
            await write(["api", route, "--method", "PATCH", "-f", "state=open"]);
            const verified = await read(route);
            if (verified.state !== "open") throw new Error("Reopen unconfirmed");
            reopened = true;
          }
        }
        const target = receipt.batch ? `#${receipt.batch} (carrying #${receipt.pr})` : `#${receipt.pr}`;
        let note = `Landed in ${target}.`;
        if (mode === "part") {
          const titled = receipt.batch ? await read(`repos/${receipt.repository}/pulls/${receipt.pr}`) : primary;
          const title = typeof titled.title === "string" ? titled.title : "";
          const safe = title && await ports.inspectTitle(title); current();
          note = `Part of this issue landed in ${target}${safe ? `: ${title}` : "."}`;
        }
        // gh 2.45 emits one JSON page per line with --jq @json.
        current();
        const rawComments = await ports.run(["api", `${route}/comments?since=${encodeURIComponent(primary.merged_at)}&per_page=100`, "--paginate", "--jq", "@json"]);
        current();
        const pages = rawComments.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
        if (!pages.length || !pages.every(Array.isArray)) throw new Error("Invalid comments");
        if (!pages.flat().some(c => c.body === note && date(c.created_at) && Date.parse(c.created_at) >= Date.parse(primary.merged_at))) {
          await write(["api", `${route}/comments`, "--method", "POST", "-f", `body=${note}`]);
        }
        if (mode === "close") {
          await write(["api", route, "--method", "PATCH", "-f", "state=closed", "-f", "state_reason=completed"]);
          const verified = await read(route);
          if (verified.state !== "closed" || verified.state_reason !== "completed") throw new Error("Close unconfirmed");
          receipt.state = "closed";
        } else receipt.state = reopened ? "reopened" : "noted";
        await save();
      } catch (error) {
        if (error instanceof DeliveryChanged) continue;
        const failures = (held?.failures ?? 0) + 1;
        const refused = error instanceof ForgeAppWriteRefused;
        receipt = { ...receipt, state: refused || failures >= 3 ? "refused" : "pending", failures,
          reason: refused ? "app-permission" : "github-unavailable", retryAt: new Date(ports.now() + githubReadBackoff(failures)).toISOString() };
        try { await save(); } catch (changed) { if (!(changed instanceof DeliveryChanged)) throw changed; }
      }
    }
  });
}

export function issueDeliverySeatSignals(lanes: readonly Pipeline[], project: string, resolve: (key: string) => string = key => key): Array<{ id: string; label: string; actionable: true }> {
  return lanes.filter(p => resolve(p.project) === project).flatMap(p => (p.issueDelivery ?? []).filter(r => r.state === "refused").map(r => ({
    id: `issue-delivery:${p.id}:${keyOf(r)}`, actionable: true as const,
    label: `Issue ${r.repository}#${r.number} delivery from PR #${r.pr} needs attention: ${r.reason}.`,
  })));
}

/** Own issue links keep a completed lane hot for at most thirty days. */
export function issueDeliveryHoldsArchive(lane: Pipeline, now: number): boolean {
  return lane.state === "completed" && !!lane.closedAt && now - Date.parse(lane.closedAt) < 30 * 86400_000
    && (lane.workLinks ?? []).some(l => l.kind !== "pr" && !lane.issueDelivery?.some(r => keyOf(r) === keyOf(l) && issueDeliveryFinal(r)));
}
