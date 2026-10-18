# Pipeline revalidation: main-thread audit L5

Status: implementation and equivalence checks complete; the paced 0.1 ms
acceptance threshold remains unmet. See the measurement below.

## Scope

The six sites pinned by [L5](main-thread-blocking-audit.md#l5-pipeline-revalidation-timers-read-the-row-revision)
use `pipelineRecordRevalidator` in `src/lib/pipelines/revalidation.ts`:
review repair, stage input preparation, provisioning, publication admission,
remote actions and review ingress. An unchanged revision skips the decoder,
clone and predicate. The activation fingerprint is serialized only on the
first check and after a change. Flow fingerprints and spawn receipts remain
independent checks on every tick.

One operation owns one revision token and one prepared statement reference.
Provisioning owns one per admitted job. Clearing the existing timer releases
these closures; no process-wide payload cache or observer is added. The fixed
SQL statement reads hot and archive row revisions through their primary keys,
and the worktree-recovery collection revision through its primary key. It
loads no JSON. Database identity, the active restoration marker and the legacy
alias file signature prevent reuse across replacement or decoder changes.
Statements are rebound after an inode change.

No schema or write path changes. Existing row producers are collection import,
replacement, bounded patch, controller checkpoint and mutation persistence in
`src/lib/state/sqliteStateStore.ts`; their upserts advance `row_revision`.
Archive moves use the existing companion transaction. The decoder's project
authority comes from `project-aliases.json` and `worktree_recovery`; their file
signature and collection revision invalidate the same reader. Full reads retain
`findPipelineRecord`'s hot-first, archive-fallback behavior.

The seventh 50 ms timer, in `settlePendingStageGit`, also checks other
pipelines' branch ownership and retains its existing predicate. It is outside
the six pinned sites. L2's archive cache, L4's role memory, L1's runtime-host
work and L6's sweeps are unchanged. The lane incorporated main's L0b
instrumentation at `c8e74873` and adapted its timer-label test to the shared
validator and per-job provisioning validators.

## Verification

Before implementation, the isolated baseline passed all four engine files:
`src/lib/pipelines/remoteActions.test.ts` (43),
`src/lib/pipelines/engine.activation.test.ts` (76),
`src/lib/pipelines/engine.provisioning.test.ts` (86), and
`src/lib/pipelines/engine.publication.test.ts` (24): 229 tests.

`src/lib/pipelines/revalidation.test.ts` counts the production decode seam and
the collection's decode hook. Cases cover unchanged ticks, unrelated writes,
peer-process updates, deletion/recreation, archive movement, both project alias
sources, malformed records, predicate and external-authority failures,
same-revision database replacement, an active swap marker, fresh-process
initialization and the exact production SQL query plan. Disabling the revision
guard caused five of these cases to fail, including the zero-decode assertion;
the guard was restored before verification.

All commands run in a scratch export through the provided `gate-slot.sh`, with
private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, `CODEX_HOME` and `LLV_STATE_DIR`,
and a closed Viewer control endpoint. No test uses the serving installation.
The required hosted contexts (`typecheck`, `privacy-publication`,
`privacy-tracker-audit`, `runtime-gate`) have no run for this local branch.
Local checks are reported separately; no push or pull request was made.

## Measurement

The first measurement preceded source edits, using a read-only `VACUUM INTO`
copy of `state.sqlite`. The largest hot row is 583,727 UTF-8 bytes among 247
hot rows. Five initial batches of 200 original P2 calls had medians
2.056–2.393 ms, at load 5.14–5.32. Ancillary project alias inputs were then
copied for the paired comparison; both variants use the same copy and those
same inputs. The published evidence contains only aggregate measurements,
source hashes and a row digest.

The final comparison runs the original P2 expression,
`JSON.stringify(findPipelineRecord(id)).length`, and the new monitored
validator on that largest row. Both return the same serialized length. It
records CPU time, wall time and system load, with six paired runs, the audit's
300 ms spacing and a 10 ms loop observer. One hundred untimed paired calls
warm both paths. This measures steady operation; the first validation still
decodes and evaluates the predicate once. Tight-loop figures are diagnostic
and do not establish the paced acceptance threshold.

Final run: 2026-10-18T19:47:34.642Z, Bun 1.4.0, source based on
`c8e74873`, load 8.27–8.29. The admitted process had
`cpu.max = 60000 20000` (three CPUs). No second benchmark or check ran
concurrently in this lane. The copy and row digest agree between both variants;
source hashes and every sample are in
[`evidence/perf/pipeline-revalidation.json`](../../evidence/perf/pipeline-revalidation.json).

| Case | Median wall, ms | Range, ms |
| --- | ---: | ---: |
| Original P2, six paced calls | 4.705 | 3.479–5.103 |
| Unchanged monitored validator, six paced calls | 0.141 | 0.114–0.254 |

All six paced unchanged samples exceed 0.1 ms. The criterion remains unmet.
The final tight-loop diagnostic has five batch medians of 0.009–0.013 ms and
p95 values of 0.012–0.022 ms; its largest individual outlier is 0.776 ms.
Those figures establish the removal of repeated payload work and do not replace
the paced result. The first validation in a fresh process is 6.468 ms, including
the initial decode; it is outside the unchanged-tick claim.

Local verification: 277 tests pass in the four engine files, the new
revalidation file,
`src/lib/mainThreadInstrumentation.test.ts`, `src/lib/pipelines/store.reads.test.ts`,
and `src/lib/state/sqliteStateStore.readCache.test.ts`; full TypeScript checking
passes. The publication gate is also run on the staged files and final commit.

## Reproduce

Use a scratch export with the candidate's matching dependencies. Choose `P`
under the stage's supplied scratch directory and set `GATE` to its provided
gate wrapper. Make the data copy before changing source. The production input
is opened read-only; all subsequent work uses the copy.

```sh
mkdir -p "$P/state" "$P/home" "$P/xdg" "$P/tmp" "$P/codex"
python3 -I - "$HOME/.config/delegatus/state/state.sqlite" "$P/state/state.sqlite" <<'COPY'
import sqlite3, sys
source = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
source.execute("VACUUM INTO ?", (sys.argv[2],))
source.close()
COPY
for file in project-aliases.json project-remotes.json worktree-map.json; do
  if [ -f "$HOME/.config/delegatus/state/$file" ]; then
    cp -p "$HOME/.config/delegatus/state/$file" "$P/state/$file"
  fi
done
# Save the TypeScript below as probe.ts in the scratch export.
env HOME="$P/home" XDG_CONFIG_HOME="$P/xdg" TMPDIR="$P/tmp" \
  CODEX_HOME="$P/codex" LLV_STATE_DIR="$P/state" NODE_ENV=production \
  LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 \
  bash "$GATE" bun ./probe.ts
```

```ts
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import { findPipelineRecord } from "./src/lib/pipelines/store";
import { pipelineRecordRevalidator } from "./src/lib/pipelines/revalidation";
const db = new Database(process.env.LLV_STATE_DIR + "/state.sqlite", { readonly: true });
const row = db.query<{row_key:string,value_json:string}, []>("SELECT row_key,value_json FROM state_rows WHERE collection='pipelines' ORDER BY length(value_json) DESC LIMIT 1").get()!;
const rows=db.query<{n:number},[]>("SELECT count(*) n FROM state_rows WHERE collection='pipelines'").get()!.n; db.close();
let chars=0;
const validate=pipelineRecordRevalidator(row.row_key, current=>{chars=JSON.stringify(current).length;});
const before=()=>JSON.stringify(findPipelineRecord(row.row_key)).length;
const after=()=>{validate();return chars;};
let last=performance.now(),maxGap=0;
const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last-10);last=now;},10);
for(let i=0;i<100;i++) { before(); after(); }
const pairs=[];
for(let run=0;run<6;run++) {
  const pair:Record<string,unknown>={};
  for(const [name,fn] of [["before",before],["after",after]] as const) {
    await Bun.sleep(300); maxGap=0; last=performance.now();
    const cpu=process.cpuUsage();const started=performance.now();const result=fn();const wallMs=performance.now()-started;const used=process.cpuUsage(cpu);
    await Bun.sleep(80);
    pair[name]={wallMs,maxLoopGapMs:maxGap,cpuMs:(used.user+used.system)/1000,load:os.loadavg(),result};
  }
  pairs.push(pair);
}
clearInterval(timer);
const group=fs.readFileSync("/proc/self/cgroup","utf8").trim().split("::")[1];
const cpuMax=fs.readFileSync("/sys/fs/cgroup"+group+"/cpu.max","utf8").trim();
console.log(JSON.stringify({cpuMax,sourceBase:"c8e748731896f50a59349d4829b4d8cb97a6d916",case:"P2-paced",at:new Date().toISOString(),bun:Bun.version,rowBytes:Buffer.byteLength(row.value_json),rowSha256:crypto.createHash("sha256").update(row.value_json).digest("hex"),hotRows:rows,pairs}));
```
