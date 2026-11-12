# Temporary data retention: implementation and validation

The implementation is prepared for review. Publication needs an operator decision
because validation crossed the lane's prohibition on live cleanup.

## Validation incident

A timer test mocked the original attempt-sweep request and allowed its newly added
maintenance continuation to launch a real helper. Isolating HOME and the state
directory left the host Docker daemon shared. Two isolated checkpoints record
completed attempts, each issuing these commands successfully:

```
docker builder prune -f --filter until=336h
docker image prune -a -f --filter until=336h
```

The attempts began at 07:21:14Z and 07:44:26Z on 2026-11-12. Retained Docker events
show the later builder prune reclaimed 0 bytes. Earlier command output was not
retained. The image inventory changed from 79 images / 27.01 GB at the first audit
to 77 / 26.30 GB at read-back; retained image-deletion events are empty, and
concurrent machine activity prevents attribution of that change. The requested
no-live-deletion condition therefore cannot be certified. Containers and volumes
have no removal command in this change; their observed counts remained 76 and 50.
The observer was never installed. Evidence, journals and releases were exercised
only in fixture directories.

The corrected code forces default Docker calls in test and fixture contexts to dry-run, forces
test workers to dry-run as a second guard, cancels maintenance after its timer is
stopped, and makes the timer test await its mocked maintenance call. Real adapter
tests supply a fixture-owned Docker executable. The full temp-sweep file now passes
82 tests with no surviving helper. This incident remains disclosed for the
operator's publication decision.

## Operator installation

From a checkout of the reviewed commit, run exactly this one command:

```sh
sudo /usr/bin/python3 -I scripts/install-release-observer.py --releases-dir "$HOME/.cache/delegatus/self-update/bb38046574072bf9/releases"
```

The installer copies the fixed observer into a root-owned executable, pins the
physical release directory, and validates a sudoers rule allowing that executable
with no arguments. The observer uses isolated Python with bytecode writes disabled.
It reads procfs and returns release-scoped holders and uncertainty. It accepts no
removal operation. Release deletion keeps the existing unprivileged gated remover
and its active, rollback, in-flight, newest-release, process and checkout fences.
Without a complete observer result, releases remain protected.

## Read-only dry run

Observed 2026-11-12T09:17:21.910Z through 2026-11-12T09:20:44.348Z. The audit command
opened live databases read-only and wrote its ledgers and report below its private
TMPDIR. This audit itself issued no prune, sudo, quarantine, claim or removal.
The incident above concerns the earlier timer tests.

| Class | Entries | Allocated GB | Policy-due GB | Verified dispatch sample |
|---|---:|---:|---:|---|
| Lane and recorded-check evidence | 17,079 | 46.79 | 4.92 | 1 would remove / 3 checked |
| Agent evidence | 8,115 | 20.65 | 3.19 | 1 would remove / 6 checked |
| Host event journals | 18,457 | 36.15 | 16.23 | 0 would remove / 7 checked |
| Automatic evidence copies | 969 | 57.55 | 0.00 | Ownerless adoption grace starts on rollout |

GB means 10^9 allocated bytes. Hardlinks count once per candidate; sums across
candidates exceed unique freed blocks. Every listed class had zero unmeasured
entries. Policy-due bytes still require fresh dispatch fences. The bounded dispatch
sample classified 2 candidates totalling 81,920 bytes as would remove. Changed
authority/protection, live references and changing or incomplete checkout
inventories retained the remaining 14 sampled entries, including three inspection
errors. It performed zero removals. The total policy-due amount is 24.33 GB;
the verified sample is an explicit lower bound and grants no
permission to bypass those fences for the remaining policy-due data.

Of the automatic copies, 679 ownerless copies / 45.78 GB enter a seven-day adoption
grace period. Other copies follow their known lane or host; open owners stay kept.
The audit preserved 167 worktree-backup directories / 1.54 GB. It counted 55 release
directories / 83.55 GB per path; 372 unreadable-process observations prevent a
complete release-removal verdict until the fixed observer is installed. Existing
active, rollback, newest and serving protections also remain.

Docker's final read-only inventory reports 77 images / 26.30 GB and 267 build-cache
records / 10.34 GB. Docker reports 14.05 GB and 4.005 GB reclaimable respectively;
these are upper bounds without the fourteen-day filter. The daemon decides the
age-filtered result when the daily job runs. Containers and volumes stay outside
its command set.

## What changed

A bounded retention ledger discovers lane, agent and recorded-check evidence,
automatic legacy copies and journals. Evidence follows a seven-day finish clock;
journals follow the last event write and require a dead session and an existing
transcript. Empty expired evidence folders also retire. Keep markers, unknown
owners, open lanes, preservation records, indirect paths and incomplete inventories
retain their data. Both quarantine and removal recheck identity, authority,
protection and checkout inventories; restart tests replay real writer output. Due pages admit
at most 128 entries under their deadline; young rows schedule at expiry and leave
room for later eligible work. Unretired domains, scopes, survivors and pending exit
records keep their host data, including when its lane is closed. Automatic copies
recheck both the source and copy ownership rows at each removal fence.
Large copy manifests use a bounded ownership-header reader, tested with the real
copy writer beyond the recorded-check envelope limit.

The daily Docker checkpoint survives restart and records an attempt before its two
commands; success and refusal both wait one day. Tests cover the real adapter with
a fixture-owned executable. PR #3894 remains open, so
`src/lib/runtime/attemptTempFilesystem.ts` and `attemptTempRetention.ts` are unchanged.
The base advanced in UI tests and merge-queue auto-refresh work; its shared
pipeline-store diff leaves the retention reader and retirement-claim APIs unchanged. No speed improvement is claimed.

## Checks and limits

Every test file below ran separately through the installed `scripts/gate-slot.sh`
recorder, with one `wait_for_check` and its terminal exit. Each final run had private
HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR plus a closed Viewer control URL.
Commands were executed in scratch exports. The installed gate wrapper was from
`34b741354731`; the comparison base was `c39bd873b1163f25cf2a5e1e489600b14103e476`.
Here `G COMMAND` means `bash "$GATE_SLOT" --record "$LOG" COMMAND`, with
`LLV_GATE_RUNNER=off` and an owned-run deadline of five or ten minutes. The table's
test commands are exact after that wrapper. Private roots in audit and lint replay
commands are represented by variables; log names identify each run. The retained
command ledger carries the resolved wrapper, environment and scratch paths.

The latest eleven files report **503 passed, one pre-existing failure**, with
2,892 assertions. The bundled byte-request case in
`src/lib/selfUpdate/retentionWorker.test.ts` fails identically on base and head:
31 pass, 1 fail, 85 assertions, unresolved Telegram aliases during `Bun.build`.
The source and bundled read-only observer case passes. The initial two temp-sweep
teardown failures led to the incident and were corrected; the initial marker-race
and lint failures were also corrected. All attempts are retained below. Earlier audit reports are superseded by the final dry run above.

| Run | Command after the gate wrapper | Exit | Pass / fail / assertions |
|---|---|---:|---:|
| `audit-1.log` | `bun scripts/temporary-data-dry-run.ts "$LIVE_STATE" "$TMPDIR/report.json"` | 0 | 4 policy classes + inventories |
| `audit-2.log` | `bun scripts/temporary-data-dry-run.ts "$LIVE_STATE" "$TMPDIR/report.json"` | 0 | 4 policy classes + inventories |
| `audit-custody.log` | `bun scripts/temporary-data-dry-run.ts "$LIVE_STATE" "$TMPDIR/report.json"` | 0 | 4 policy classes + inventories |
| `audit-delivery.log` | `bun scripts/temporary-data-dry-run.ts "$LIVE_STATE" "$TMPDIR/report.json"` | 0 | 4 policy classes + inventories |
| `audit-final.log` | `bun scripts/temporary-data-dry-run.ts "$LIVE_STATE" "$TMPDIR/report.json"` | 0 | 4 policy classes + inventories |
| `audit-handover.log` | `bun scripts/temporary-data-dry-run.ts "$LIVE_STATE" "$TMPDIR/report.json"` | 0 | 4 policy classes + inventories |
| `final-test-0.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 30 / 0 / 104 |
| `final2-test-0.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 31 / 0 / 106 |
| `final2-test-1.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 15 / 0 / 28 |
| `final2-test-2.log` | `bun test --timeout=60000 src/lib/runtime/attemptEvidenceBinding.test.ts` | 0 | 8 / 0 / 9 |
| `final2-test-3.log` | `bun test --timeout=60000 src/lib/agent/registry.temporaryData.test.ts` | 0 | 2 / 0 / 9 |
| `final2-test-4.log` | `bun test --timeout=60000 src/lib/dockerCacheRetention.test.ts` | 0 | 5 / 0 / 22 |
| `final2-test-5.log` | `bun test --timeout=60000 src/lib/selfUpdate/releaseObserver.test.ts` | 0 | 6 / 0 / 17 |
| `final2-test-6.log` | `bun test --timeout=60000 src/lib/pipelines/worktreeSweepWorker.test.ts` | 0 | 37 / 0 / 141 |
| `final2-test-7.log` | `bun test --timeout=60000 src/lib/tempSweep.test.ts` | 1 | 82 / 1 / 357 |
| `lint-1.log` | `bun node_modules/.bin/eslint <changed TypeScript files>` | 1 | 2 errors; 1 warnings |
| `lint-2.log` | `bun node_modules/.bin/eslint <changed TypeScript files>` | 0 | 0 errors; 1 warnings |
| `lint-custody.log` | `bun node_modules/.bin/eslint src/lib/runtime/temporaryDataProduction.ts src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 0 errors; 0 warnings |
| `lint-final.log` | `bun node_modules/.bin/eslint <changed TypeScript files>` | 0 | 0 errors; 1 warnings |
| `lint-scheduling.log` | `bun node_modules/.bin/eslint src/lib/runtime/temporaryDataRetention.ts src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 0 errors; 0 warnings |
| `tail-test-0.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 17 / 0 / 33 |
| `tail-test-1.log` | `bun test --timeout=60000 src/lib/selfUpdate/retention.test.ts` | 0 | 135 / 0 / 1144 |
| `test-binding-1.log` | `bun test --timeout=60000 src/lib/runtime/attemptEvidenceBinding.test.ts` | 0 | 8 / 0 / 9 |
| `test-custody-final.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 19 / 0 / 40 |
| `test-docker-1.log` | `bun test --timeout=60000 src/lib/dockerCacheRetention.test.ts` | 0 | 5 / 0 / 22 |
| `test-docker-context.log` | `bun test --timeout=60000 src/lib/dockerCacheRetention.test.ts` | 0 | 8 / 0 / 30 |
| `test-observer-1.log` | `bun test --timeout=60000 src/lib/selfUpdate/releaseObserver.test.ts` | 0 | 6 / 0 / 14 |
| `test-observer-final.log` | `bun test --timeout=60000 src/lib/selfUpdate/releaseObserver.test.ts` | 0 | 7 / 0 / 20 |
| `test-owner-fences.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 24 / 0 / 50 |
| `test-policy-final.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 18 / 0 / 34 |
| `test-policy-renewed.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 18 / 0 / 34 |
| `test-production-1.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 15 / 0 / 28 |
| `test-queue-final.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 34 / 0 / 118 |
| `test-queue-proof.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 34 / 0 / 118 |
| `test-registry-1.log` | `bun test --timeout=60000 src/lib/agent/registry.temporaryData.test.ts` | 0 | 2 / 0 / 9 |
| `test-retention-1.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataRetention.test.ts` | 1 | 22 / 2 / 68 |
| `test-retention-2.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 24 / 0 / 72 |
| `test-retention-3.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 28 / 0 / 98 |
| `test-retentionworker-base.log` | `bun test --timeout=60000 src/lib/selfUpdate/retentionWorker.test.ts` | 1 | 31 / 1 / 85 |
| `test-sweepworker-1.log` | `bun test --timeout=60000 src/lib/pipelines/worktreeSweepWorker.test.ts` | 0 | 36 / 0 / 137 |
| `test-tempsweep-1.log` | `bun test --timeout=60000 src/lib/tempSweep.test.ts` | 1 | 82 / 1 / 357 |
| `test-tempsweep-base-1.log` | `bun test --timeout=60000 src/lib/tempSweep.test.ts` | 0 | 82 / 0 / 357 |
| `verified-test-0.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 33 / 0 / 116 |
| `verified-test-1.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 16 / 0 / 30 |
| `verified-test-2.log` | `bun test --timeout=60000 src/lib/runtime/attemptEvidenceBinding.test.ts` | 0 | 8 / 0 / 9 |
| `verified-test-3.log` | `bun test --timeout=60000 src/lib/agent/registry.temporaryData.test.ts` | 0 | 3 / 0 / 11 |
| `verified-test-4.log` | `bun test --timeout=60000 src/lib/dockerCacheRetention.test.ts` | 0 | 7 / 0 / 27 |
| `verified-test-5.log` | `bun test --timeout=60000 src/lib/selfUpdate/releaseObserver.test.ts` | 0 | 7 / 0 / 20 |
| `verified-test-6.log` | `bun test --timeout=60000 src/lib/pipelines/worktreeSweepWorker.test.ts` | 0 | 37 / 0 / 141 |
| `verified-test-7.log` | `bun test --timeout=60000 src/lib/tempSweep.test.ts` | 0 | 82 / 0 / 357 |
| `verified-test-8.log` | `bun test --timeout=60000 src/lib/runtime/attemptTempRetention.test.ts` | 0 | 134 / 0 / 927 |
| `verified-test-9.log` | `bun test --timeout=60000 src/lib/selfUpdate/retentionWorker.test.ts` | 1 | 31 / 1 / 85 |

Additional checks:

| Command | Exit | Counts |
|---|---:|---|
| Python AST parse of `scripts/delegatus-release-holders.py` and `scripts/install-release-observer.py` (three runs) | 0 each | 2 files each |
| `python3 -c 'import ast,pathlib; files=["scripts/delegatus-release-holders.py","scripts/install-release-observer.py"]; [ast.parse(pathlib.Path(f).read_text()) for f in files]; print("2 files parsed")'` | 0 | 2 files |
| `/usr/bin/python3 -IB -c 'import sys; assert sys.dont_write_bytecode and sys.flags.isolated'` | 0 | 1 assertion, 2 flag conditions |
| `/usr/sbin/visudo -cf "$TMPDIR/release-observer.sudoers"` (two runs) | 0 each | 1 rule each |
| `docker events --since 2026-11-12T07:15:00Z --until <read-time> --filter event=prune --format '{{json .}}'` | 0 | 1 retained builder event; 0 reclaimed bytes |
| `docker system df --format '{{json .}}'` | 0 | 4 classes |
| `docker events --since 2026-11-12T07:15:00Z --until <read-time> --filter type=image --filter event=delete --format '{{json .}}'` | 0 | 0 retained events |
| `git diff --check` | 0 | 0 whitespace findings |
| `git commit --file "$TMPDIR/commit-message.txt"` | 0 | 27 files linted; 0 introduced errors; staged whitespace passed |
| `G bun scripts/privacy-publication-gate.ts --repository "$WORKTREE" --base origin/main --require-known-values --paths <six final code/report files>` | 0 | 6 files; 0 findings |
| First privacy launcher (quoting error before gate execution) | 1 | 0 files inspected |
| `bun scripts/privacy-publication-gate.ts --repository "$WORKTREE" --base origin/main --require-known-values --paths <all 31 changed files>` | 0 | 31 files; 0 findings |

Final ESLint inspected all changed TypeScript files with zero errors and one
existing `_completedHandoff` warning, also present in the base source. Full-suite,
full-build and full-typecheck commands were outside this stage's check allowance;
the publication gate remains the publisher's check. The public-text privacy gate passed with zero findings over all 31 changed files.
The six later-changed source/report files also passed a renewed privacy scan.
Final committed-text privacy and commit-hook receipts accompany the stage report.
