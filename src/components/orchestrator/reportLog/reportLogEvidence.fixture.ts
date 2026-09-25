import { reportCardRefs, type ReportLogCard } from "@/lib/bridge/reportCardRefs";
import type { ReportLogEntry, ReportLogPage } from "@/lib/bridge/reportLog";
import type { BridgeReportClass } from "@/lib/bridge/types";

/*
 * The orchestrator report log's evidence data (#2146), served by the kanban
 * and the phone fixtures alike: 46 invented reports across all six classes,
 * long bodies and short, `#123` and `owner/repo#12` references, SHAs that stay
 * plain text, and card ids the fixture's board knows. Newest first, paged by
 * seq exactly as the route pages them.
 */

const MIN = 60_000;

const BODIES: Array<[BridgeReportClass, string]> = [
  ["status", "Where the release stands: search is merged and deployed (#2149), upload is in review round 2 with one P2 left (the progress bar does not reach 100% on a slow link), favicon waits behind the builder cap, and the passkey fallback is parked on your answer about the domain. Production runs 91be3d07 and answers 200 on every route. Nothing else is waiting on you; I check the upload lane again when its reviewer settles and report only if it fails or needs a decision."],
  ["blocked", "The upload lane cannot finish until the storage question is settled: the builder measured 38 MB for a five-minute recording, which is over the 25 MB attachment limit, and the reviewer refuses a silent truncation. Either raise the limit for recordings to 100 MB (one config line and a migration note), or keep 25 MB and have the composer refuse longer recordings with a clear message. I keep p-upload parked and the other two lanes running until you pick one."],
  ["completed", "Deployed main 7c41e09a to production: the report log beside the orchestrator chat (#2146) and the Bridge reports switch. Health 200, both routes answer, the seat reads bridgeReports:true."],
  ["review_verdict", "Review round 2 on #2151: APPROVE. The fix for the stuck composer holds on the phone at 390; one P3 left as issue #2160 (a hint line that wraps on uk)."],
  ["question", "The upload card t-upload wants a size limit before it can ship. 25 MB like the attachments, or 100 MB for recordings? I keep the lane parked until you answer."],
  ["blocked", "Lane p-upload cannot push: the pre-push gate flags a fixture path under $HOME. I need you to approve rewriting the fixture or to allow LLV_SKIP_HOOKS for this one push."],
  ["failed", "Build of 3f0d2c71 failed on tsc: src/lib/forge/autoMerge.ts(684,5) Property 'setting' is missing. The lane is back with its builder; no deploy until it is green."],
  ["status", "Three lanes running: search (review round 1), upload (build), favicon (queued behind the builder cap)."],
  ["completed", "Merged #2149 (search results keep their scroll position) after green checks; the task t-search moved to Done."],
  ["completed", "Звіти оркестратора тепер видно поруч із чатом. Перевірив на телефоні й на десктопі, обидві мови, світла і темна теми."],
  ["review_verdict", "Review round 1 on #2152: REQUEST_CHANGES, two findings. The empty state repeats the title, and the older-entries control is under 44 px on the phone. Sent back to the builder."],
  ["status", "Queue is quiet: nothing waiting on you, one lane in review."],
  ["failed", "Deploy of 91be3d07 stopped at verify-candidate: the runtime host did not take the fence within 60 s. Production still serves 7c41e09a. Retrying once after the host restart."],
  ["question", "Should the nightly digest skip weekends? It ran on Saturday with nothing to say."],
  ["completed", "Deployed 91be3d07 after the retry. The fence moved in 4 s this time; the earlier timeout was the old host holding its lease through a slow shutdown, filed as #2163."],
  ["blocked", "The GitHub token for acme/atlas expired at 09:00; pushes and PR reads fail with 401. Renew it and I resume the three lanes where they stopped."],
  ["status", "Token renewed, all three lanes resumed from their last stage."],
  ["completed", "Lane p-search finished: PR #2149 open with green checks, review passed. Waiting for the merge setting, which is off for this project."],
  ["review_verdict", "Round 3 on acme/atlas#88: APPROVE with a note. The migration is reversible and the backup restores; the only open item is a log line that prints a full path, fixed in the same PR."],
  ["failed", "The favicon lane's builder crashed twice on an out-of-memory kill while four builds ran at once. I cut the builder cap to three and restarted it."],
  ["completed", "Favicon lane done, PR #2147. The new icon renders at 16, 32 and 180 px in both schemes."],
  ["question", "Two tasks describe the same bug (t-search and an older card). Merge them into t-search, or keep both?"],
];

function seededReports(now: number): ReportLogEntry[] {
  const entries: ReportLogEntry[] = [];
  let seq = 1_180;
  /* Oldest first: 46 reports over three days, the newest a few minutes ago. */
  for (let index = 0; index < 46; index += 1) {
    const [reportClass, body] = BODIES[(45 - index) % BODIES.length]!;
    seq += 1 + (index % 3 === 0 ? 1 : 0);
    const minutesAgo = Math.round((45 - index) * (index < 30 ? 95 : 21)) + 4;
    entries.push({ seq, at: new Date(now - minutesAgo * MIN).toISOString(), class: reportClass, body, cards: [] });
  }
  return entries.reverse();
}

let seeded: { now: number; entries: ReportLogEntry[] } | null = null;

/**
 * The page the route would answer for `url`, over the seeded reports.
 * `knownCards` are the ids the fixture's board holds.
 */
export function reportLogFixturePage(url: URL, options: {
  project: string;
  github: string | null;
  enabled: boolean;
  knownCards: ReadonlyMap<string, ReportLogCard["kind"]>;
  empty?: boolean;
}): ReportLogPage {
  seeded ??= { now: Date.now(), entries: seededReports(Date.now()) };
  const all = options.empty ? [] : seeded.entries;
  const revision = `fixture:${all[0]?.seq ?? 0}`;
  const base = { ok: true as const, project: options.project, bridgeReports: options.enabled, github: options.github, revision };
  const beforeRaw = url.searchParams.get("before");
  const before = beforeRaw === null ? Number.POSITIVE_INFINITY : Number(beforeRaw);
  if (url.searchParams.get("since") === revision && beforeRaw === null) return { ...base, unchanged: true, entries: [], nextBefore: null };
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 30) || 30));
  const older = all.filter((entry) => entry.seq < before);
  const entries = older.slice(0, limit).map((entry) => ({ ...entry, cards: reportCardRefs(entry.body, options.knownCards) }));
  return { ...base, entries, nextBefore: older.length > limit ? entries.at(-1)!.seq : null };
}
