# Viewer worker idle costs

The initial baseline is `917189ae562def76980341620987479ab2813cfc`.
Current main `e7507d58863450a1f45b1a93d2b27a059ca13c6e` was merged without
rebasing before final checks; its test-hook isolation change leaves the measured
worker implementations identical.
The comparison uses an immutable synthetic registry with 7,098 conversations
and 560 transcript files. It does not copy account credentials or act on live
processes. Raw samples and separate baseline/candidate source fingerprints are in
`evidence/viewer-idle-workers.json`.

## Confirmed causes

| Cause on main | Regression observed before the fix | Change |
| --- | --- | --- |
| `src/lib/accounts/migration/controller.ts:242` always submits the complete catalog; `src/lib/accounts/migration/coordinator.ts:351` assembles and walks the registry | Two identical polls submit both files twice | Remember acknowledged file inputs, reconcile only changed paths, and revisit 32 registry contexts per poll |
| `src/lib/accounts/migration/controller.ts:49` opens a global reservation compaction mutation on every migration tick | An idle tick calls `compactDeliveryReservations` | Keep compaction at startup and reservation writes |
| `src/lib/accounts/migration/quotaController.ts:348` writes observations and an evaluation even when the cached reading is identical | A second identical reading advances the SQLite revision | Preserve fresh probes and skip an identical durable observation when no policy sustain window needs evaluation |
| `src/lib/reaperRuntime.ts:1017` invokes failure backfill from the inventory process; `src/lib/runtime/structuredSpawn.ts:1084` reaches the release-owner guard at `src/lib/agent/registry.ts:5876` | A real sidecar process without serving-release activation reports the same refusal after restart | Pass `repairFailures: false` from the sidecar; retain its other launch/deadline convergence |
| `src/lib/scanner/filesResponseWorker.ts:27` and `:283` retire by post-build RSS and time since the last build | A healthy projection loses its resident process; a normal cache interval forks again | Retain one worker for the Viewer generation; release event-loop references between builds |
| `src/lib/scanner/filesResponseWorker.ts:204` hashes every environment value; `:216` records retirement only in diagnostics | An unrelated environment change replaces the child; retirement produces no log | Match launch/cwd/storage roots and log the reason, PID and diagnostic RSS at retirement |

The implementation consumes existing keyed registry reads. It changes neither
`registry.ts` nor `sqliteRegistryStore.ts`. The separate registry write lane
remains responsible for the cost of a real mutation over retained history.
The operation-name union in `src/lib/viewerLoopMonitor.ts` is shared with
the MCP transport lane; this change adds only `controller.account-migration`.
Registry helpers, the SQLite store, MCP routing and the task store are unchanged.

The scanner's link/native-observation phase also used a registry-wide read on
unchanged inputs (`src/lib/scanner/index.ts:501` → `links.ts:533`). Its red test
blocks that read after startup and shows the repeated recovery. The sidecar
now tells that phase whether inventory changed. Workflow/pipeline deadlines,
question routing and task admission still run with the complete live catalog.
Callers that omit the optional flag keep the previous full-recovery behaviour.
The controller also retains one shared immutable title projection; new input,
a different registry owner or an unreadable projection evicts it. Custom title
overrides are read every pass, so a rename still reaches notifications without
a new registry-wide title projection.
The only production producer of the new flag is `AccountMigrationController`.
The other direct consumers are the scanner retirement test, native subagent
detection tests and pipeline CPU admission tests. They omit the flag and keep
the default full link recovery. Inventory callers outside the controller omit
`incrementalInventory` and retain their existing result shape and recovery.

Idle board repair also submitted two empty registry mutations
(`coordinator.ts:829`, `:859` on main). The idle-cycle regression fails on its
first empty placement mark; empty plan and convergence lists now skip writers.
The task phases opened mutation leases even without admissions or assignment
changes (`scanner/index.ts:556`, `controller.ts:171`). They now preflight the
existing immutable task list, then recompute under the existing writer lease
when work exists. The scanner admission has asynchronous state admission; its
peer-lock test also removes membership and proves the next pass repairs it.
No task store, schema or admission contract changes here.

A title overlay resolved each entry's working directory again despite holding
a projected project (`session/titleProjection.ts:305` on main). A warm-overlay
regression observes two resolver calls for two entries with the same directory
on main, and one on the change. Resolving each distinct working directory once per overlay, against one
current resolution-state key, removes that per-entry state read while keeping
project alias changes visible. Sidecar startup also prepares its read owner
through the existing registry API (`controller.ts:346` on main omitted it);
its regression observes zero preparation calls on main and one on the change.

## Behaviour and bounds

The inventory cursor retains one input and context per currently scanned path.
A removed path is evicted after a successful complete pass. An incomplete scan
or failed phase acknowledges nothing. A fresh process replays its first
inventory. Account collection or active engine-routing changes invalidate file inputs.
Cursor order follows sorted paths, independently of activity sorting. A
registry-only host, alias, membership, receipt or delivered-message change is revisited within
`ceil(catalog size / 32)` polls. Pending transcript reads share that same
round-robin window, and the cursor advances by the number of catalog paths
visited. More than 32 pending reads therefore rotate fairly while ordinary
context checks continue. Normal transcript changes take the next pass.
Provider forks include the source thread's catalog path and current owner in
their context signature. A source admitted during reconciliation leaves its
fork pending for the next cursor visit, so the fork observation is reconsidered.
Known paths use conversation/receipt-scoped snapshots. A newly discovered path
can still require one complete snapshot to recover an unindexed pending
launch profile; that existing cold recovery path is kept for correctness.
Registry writes use asynchronous admission with the inventory operation label.

Quota probes, migration advancement, workflow/pipeline deadlines, question
routing and process reaping keep their existing periodic checks. Cached quota
readings can leave the registry untouched; a fresh authentication timestamp,
changed credit evidence, sign-out or active sustain window still commits.
An idle sidecar with no open launch or starting entry opens no spawn hygiene
writer. Pending launches still use the existing convergence and busy retry.
A restarted quota process records its boot identity again. Context signatures
are captured immediately after inventory, before later awaited phases; a change
made by one of those phases remains visible to the next cursor pass.

The files worker remains serial and shared across server bundles. Explicit
shutdown/drain, a different launch or storage root, protocol failure, output
limit, timeout, pipe failure and process exit still retire it. Every such
retirement logs its cause. The old RSS and idle environment overrides no longer
select a retirement policy. Request deadlines and wire limits are unchanged.

## Reproduction

Run in a clean source export with dependencies installed from the lockfile.
Name a private HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR for every run.
Keep HOME and XDG_CONFIG_HOME beneath the declared temp root, including in
production worker children. Isolate the provider homes as well. Never point a
measurement at an operator installation.

Use the same driver in clean main and changed-source exports, each with
lockfile dependencies. The driver is new, so copy it to the baseline export.
`GATE_SLOT` names the installed `scripts/gate-slot.sh` wrapper. Keep the parent
`TMPDIR` supplied by the stage; create every run below it:

```sh
benchmarkRoot=$(mktemp -d "$TMPDIR/viewer-worker-benchmark-XXXXXX")
FIXTURE="$benchmarkRoot/fixture"
cp "$HEAD_EXPORT/scripts/benchmark-viewer-workers.ts" "$BASE_EXPORT/scripts/benchmark-viewer-workers.ts"
sample() {
  sourceRoot=$1
  mode=$2
  runRoot=$(mktemp -d "$benchmarkRoot/sample-XXXXXX")
  mkdir -p "$runRoot/home" "$runRoot/config" "$runRoot/state"
  (
    cd "$sourceRoot"
    env -u LLV_STATE_OWNER HOME="$runRoot/home" XDG_CONFIG_HOME="$runRoot/config" \
      LLV_STATE_DIR="$runRoot/state" TMPDIR="$runRoot" NODE_ENV=production \
      CODEX_HOME="$runRoot/home/codex" LLV_CODEX_HOME="$runRoot/home/codex" \
      CLAUDE_CONFIG_DIR="$runRoot/home/claude" LLV_CLAUDE_HOME="$runRoot/home/claude" \
      LLV_AGENT_REGISTRY_SQLITE=sqlite LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 \
      bash "$GATE_SLOT" bun scripts/benchmark-viewer-workers.ts "$mode" "$FIXTURE" 65000
  )
}
sample "$HEAD_EXPORT" prepare
for repetition in 1 2 3; do
  sample "$BASE_EXPORT" migration
  sample "$HEAD_EXPORT" migration
  sample "$BASE_EXPORT" files
  sample "$HEAD_EXPORT" files
done
```

Repeat each pair three times. The driver copies the same seed into each run;
its preparation record identifies the seed hash, bytes and counts. The files
experiment uses the real 60-second idle threshold with two builds separated by
65 seconds. Respawns/hour is the observed replacement count divided by the
observed interval, extrapolated to an hour. It is not an hour-long load test.
Linux logical read bytes come from `/proc/<pid>/io` (`rchar`), so page-cache
hits still count. CPU includes the process's threads. Migration CPU/minute uses the production 60-second quiet interval after each
pass: total warm CPU multiplied by 60,000 divided by the sum of 60,000 plus each
measured pass duration. The six cycles run consecutively; this normalization
models the quiet intervals. Per-scheduled-minute CPU is retained separately.

The inventory measurement uses the production shared registry instance. Quota probes, OS process reaping, controller task reconciliation and routing
are stubbed; task admission and migration reconciliation run for real. Those exclusions are part
of the workload definition; the numbers do not claim a whole-Viewer or
production worker CPU reduction. Cold, settling and changed-file samples remain in the
raw output, including slower samples. The files worker projects the fixture
through its real child entry point and production response code.

## Verification

Regression tests run by explicit file path, in isolated state, through the
owned gate and documented baseline comparator. The controller tests cover
64-path context progress with one persistent incomplete read, 70 persistent
incomplete reads, and late provider-source admission after a fork was already
acknowledged. The fork test exercises the real inventory coordinator and
checks that its transcript bytes remain unchanged while ownership converges.
Quota refusal/race and reaper checks remain in their explicit-path runs. The
files-worker tests retain delta delivery across explicit retirement and recovery
after a child dies mid-build.

## Before and after

Three paired runs; six steady-state idle migration passes per run. MB means
decimal bytes. Values below are medians of run averages; cold, settling, and
one-file delta samples remain beside the steady-state samples in the evidence.
The raw records include baseline and candidate source fingerprints. The
candidate fingerprint covers the final controller implementation.

| Identical synthetic workload | Pinned baseline | Candidate |
| --- | ---: | ---: |
| Migration CPU per modeled minute | 1,522.02 ms | 247.38 ms |
| Migration logical reads per idle cycle | 48.444 MB | 2.688 MB |
| Inventory paths submitted, unchanged scan | 560 | 32 |
| Inventory paths submitted, one changed file | 560 | 33 |
| Files worker CPU per minute at the measured interval | 1,246.86 ms | 744.31 ms |
| Files worker reads for the second build | 132.093 MB | 46.704 MB |
| Files worker respawns/hour, extrapolated | 53.19 | 0 |
| Files worker observed replacements, three intervals | 3 | 0 |

Migration CPU run averages span 1,417–1,909 ms on the baseline and 196–275 ms
on the candidate. This is a scoped synthetic measurement. Its remaining controller
phases still account for reads; it does not claim zero idle I/O. The seed is
7,754,833 bytes; its SHA-256, raw samples, source hashes, and resource bounds
are in the evidence.

The baseline comparator reports zero new failures across 17 scoped Linux test
files, with the same three pre-existing files-route assertions seen on the
pinned baseline. The focused controller suite passes 22 tests with the three
new deterministic regressions. TypeScript and changed-file ESLint pass.
Publication privacy is checked on the final changed files and commit before
publication. No production deployment or production performance claim is part
of this verification.
