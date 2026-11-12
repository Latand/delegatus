# Temporary data retention: implementation and validation

The implementation is prepared for review. The continuation decision on
2026-11-12 authorizes review and publication with the incident below disclosed:
the two Docker prune operations match the approved daily policy. The original
no-live-deletion acceptance cannot be certified for the earlier test attempts.

## Validation incident

A timer test mocked the original attempt-sweep request and allowed its newly added
maintenance continuation to launch a real helper. Isolating HOME and the state
directory left the host Docker daemon shared. Two isolated checkpoints record
completed attempts, each issuing these commands successfully:

```
docker builder prune -f --filter until=336h
docker image prune -a -f --filter until=336h
```

All times below are UTC on 2026-11-12. Checkpoints record attempt start times,
two completed commands and zero command errors for each attempt. They do not
record individual command start/end times or stdout/stderr.

| Attempt start | Exact live command | Retained output / result |
|---|---|---|
| 07:21:14.178Z | `docker builder prune -f --filter until=336h` | stdout/stderr unavailable; checkpoint completed without command error; reclaimed bytes unknown |
| 07:21:14.178Z | `docker image prune -a -f --filter until=336h` | stdout/stderr unavailable; checkpoint completed without command error; image deletions unknown |
| 07:44:26.064Z | `docker builder prune -f --filter until=336h` | stdout/stderr unavailable; checkpoint completed without command error; daemon event at 07:44:26.224706604Z: `Type=builder Action=prune reclaimed=0` |
| 07:44:26.064Z | `docker image prune -a -f --filter until=336h` | stdout/stderr unavailable; checkpoint completed without command error; image deletions unknown |

`until=336h` is the approved fourteen-day filter; only image pruning uses `-a`.
The retained event query ended at 07:47:19.590559Z and returned one builder event.
The image-deletion query returned zero retained events. These observations cannot
reconstruct the missing output from either attempt. The image inventory changed
from 79 images / 27.01 GB at the first audit
to 77 / 26.30 GB at read-back; retained image-deletion events are empty, and
concurrent machine activity prevents attribution of that change. The requested
no-live-deletion condition therefore cannot be certified. Containers and volumes
have no removal command in this change; their observed counts remained 76 and 50.
The observer was never installed. Evidence, journals and releases were exercised
only in fixture directories.

The corrected code refuses the default Docker runner in test and fixture
contexts before locking or writing a checkpoint. Tests inject a fixture runner;
an explicit dry-run makes zero calls. The original test context and physical
temp root remain pinned even if a fixture changes NODE_ENV or TMPDIR. Retention
ledger opens, discovery namespaces, replayed candidates and removal fences reject
paths outside that root, including symlink escapes. Safety errors fail the test
instead of becoming ordinary retained-candidate reports. Test workers also force
Docker dry-run, timer shutdown cancels maintenance, and the timer test awaits its
mocked maintenance call. A real production-worker fixture proves zero Docker
calls and fixture-only ledger writes. No live Docker command was rerun during
this continuation; the timestamped machine inventory below remains the earlier
read-only observation.

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
commands; success and refusal both wait one day. Tests execute the filtered
commands with a fixture-owned executable through an injected runner. The parallel lane's
PR #3894 remains open, so
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

Before this continuation, the latest eleven files reported **503 passed, one
pre-existing failure**, with 2,892 assertions. Continuation checks are listed below. The bundled byte-request case in
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
The original committed-text privacy and commit-hook receipts are retained.
The continuation adds its own receipts below.


## Continuation verification

The original transcript was reopened to recover the exact launched commands,
including earlier lint, privacy, commit and static-check launchers. Their complete
argv, timestamps, launcher exit statuses and retained output are handed over in
`earlier-recovered-checks.json` alongside `check-inventory.json` and `checks/`.
A recorder launcher's exit is separate from the terminal test verdict; the test
counts and exits above come from the recorded checks. This recovery also confirms
the two daily checkpoints: 07:21:14.178Z and 07:44:26.064Z, each with
`state=complete commands=2 errors=0`. Prune stdout/stderr remain unavailable.

All continuation checks use the same installed wrapper, one test file per owned
runner, private HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR, a closed Viewer
control URL and `LLV_GATE_RUNNER=off`. The command launcher also sets DOCKER_HOST
to a nonexistent socket below the fixture root. No live Docker request, deletion
or observer installation occurred during this continuation.

The final PR body is this complete report, including the incident and installation
command. A GitHub read-back found no PR for this branch; #3894 belongs to the
parallel lane. The pipeline publisher must create this branch's PR and read back
its full body. The builder commits locally under the controller's no-push rule.

| Run | Command after the gate wrapper | Exit | Pass / fail / assertions |
|---|---|---:|---:|
| `guard-test.log` | `bun test --timeout=60000 src/lib/retentionTestSafety.test.ts` | 0 | 5 / 0 / 16 |
| `docker-guard.log` | `bun test --timeout=60000 src/lib/dockerCacheRetention.test.ts` | 0 | 10 / 0 / 36 |
| `retention-guard.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 34 / 0 / 118 |
| `production-guard.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 24 / 0 / 50 |
| `worker-guard.log` | `bun test --timeout=60000 src/lib/pipelines/worktreeSweepWorker.test.ts` | 0 | 37 / 0 / 141 |
| `worker-maintenance-guard.log` | `bun test --timeout=60000 src/lib/pipelines/worktreeSweepWorker.test.ts` | 0 | 38 / 0 / 147 |
| `tempsweep-guard.log` | `bun test --timeout=60000 src/lib/tempSweep.test.ts` | 0 | 82 / 0 / 357 |
| `renew-guard.log` | `bun test --timeout=60000 src/lib/retentionTestSafety.test.ts` | 0 | 5 / 0 / 17 |
| `renew-docker.log` | `bun test --timeout=60000 src/lib/dockerCacheRetention.test.ts` | 0 | 10 / 0 / 36 |
| `renew-retention.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 34 / 0 / 118 |
| `renew-production.log` | `bun test --timeout=60000 src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 24 / 0 / 50 |
| `guard-final.log` | `bun test --timeout=60000 src/lib/retentionTestSafety.test.ts` | 0 | 6 / 0 / 19 |
| `maintenance-final.log` | `bun test --timeout=60000 src/lib/pipelines/worktreeSweepWorker.test.ts -t "production maintenance keeps Docker dry"` | 0 | 1 / 0 / 6 |


The latest full-file result for each of twelve files totals **512 passed, one
pre-existing failure and 2,923 assertions**. This combines the eleven-file
earlier campaign above with the renewed Docker, worker and retention results
and the new six-case sandbox guard file. The final filtered production-maintenance
case separately passes with six assertions; it does not add to that full-file total.
Unchanged observer, binding, registry and release results retain their earlier
receipts. No new full suite, build or typecheck was run.

The continuation's plain `git commit --file "$TMPDIR/continuation-commit-message.txt"`
exited 0; normal hooks checked staged whitespace and linted seven TypeScript files,
with zero introduced errors. `git diff --check` exited 0 with zero whitespace
findings. The parallel PR remains open at the final read-back, and both protected
retention implementation files remain unchanged from the lane's starting commit.


| Continuation publication check | Exit | Counts |
|---|---:|---|
| `G bun scripts/privacy-publication-gate.ts --repository "$WORKTREE" --base origin/main --require-known-values --check-commits --added-lines` (`privacy-continuation.log`) | 0 | PASS; 33 changed files across 2 lane commits; 0 findings |

The full final report and installation command are handed to the publisher as
`pr-body.md`. After publication, read back the new PR body and verify it carries
this whole report. PR creation, pre-push checks and the three deletion-review
rounds belong to the remaining pipeline stages.

## Successor refresh and verification

On 2026-11-12, the successor merged `origin/main` at
`2614b079b3f174eb06bb65d9311460ea57aa6fee` with merge commit
`140d902f39e7f1a1fe10922a03652899159a11d3` (10:29:26Z), without conflicts or
rebasing. Typecheck found three errors in the inherited tests: two assignments
to Next.js's readonly `NODE_ENV` declaration and an incompatible `spawnSync`
fixture cast. The successor corrects those test typings without changing their
runtime behavior. Both protected implementation files,
`src/lib/runtime/attemptTempFilesystem.ts` and
`src/lib/runtime/attemptTempRetention.ts`, retain their starting contents.

The commands below ran from a scratch export of the combined tree with those
three fixes. Every test file had its own owned gate runner and fresh private
HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR. The sequential campaign retained
one admission while each file received its own runner, log, exit status and
cleanup. It used Bun 1.4.0, `LLV_GATE_RUNNER=off`, a closed Viewer control URL,
a nonexistent fixture Docker socket and a rejecting fixture Docker executable.
All twelve file-level Docker sentinel logs were empty. No command in this
successor contacted live Docker, installed the observer or deleted live data.
The machine inventory and incident observations earlier in this report retain
their original observation times; they were not rerun.

Each command in the table runs through the installed `scripts/gate-slot.sh`
wrapper. Counts are pass / fail / assertions. The campaign ran from
10:36:55Z through 10:40:14Z. Raw commands, output, time bounds, runner cleanup
receipts and source digests are retained in the successor's `refresh-checks/`
evidence directory.

| Run | Command after the gate wrapper | Exit | Counts |
|---|---|---:|---|
| `types` | `bunx tsc --noEmit` | 2 | 3 diagnostics in lane tests |
| `types-fixed` | `bunx tsc --noEmit` | 0 | 0 diagnostics |
| `touched-tests` | `/usr/bin/python3 "$TMPDIR/retention-refresh/campaign.py"` | 1 | 0 test files; launcher syntax error before execution, corrected |
| `test-00` | `bun test --timeout=60000 src/lib/agent/registry.temporaryData.test.ts` | 0 | 3 / 0 / 11 |
| `test-01` | `bun test --timeout=60000 src/lib/dockerCacheRetention.test.ts` | 0 | 10 / 0 / 36 |
| `test-02` | `bun test --timeout=60000 src/lib/pipelines/worktreeSweepWorker.test.ts` | 0 | 38 / 0 / 147 |
| `test-03` | `bun test --timeout=60000 src/lib/retentionTestSafety.test.ts` | 0 | 6 / 0 / 19 |
| `test-04` | `bun test --timeout=60000 src/lib/runtime/attemptEvidenceBinding.test.ts` | 0 | 8 / 0 / 9 |
| `test-05` | `bun test --timeout=60000 src/lib/runtime/attemptTempRetention.test.ts` | 0 | 134 / 0 / 927 |
| `test-06` | `bun test --timeout=60000 src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 24 / 0 / 50 |
| `test-07` | `bun test --timeout=60000 src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 34 / 0 / 118 |
| `test-08` | `bun test --timeout=60000 src/lib/selfUpdate/releaseObserver.test.ts` | 0 | 7 / 0 / 20 |
| `test-09` | `bun test --timeout=60000 src/lib/selfUpdate/retention.test.ts` | 0 | 135 / 0 / 1,144 |
| `test-10` | `bun test --timeout=60000 src/lib/tempSweep.test.ts` | 0 | 82 / 0 / 357 |
| `test-11` | `bun test --timeout=60000 src/lib/selfUpdate/retentionWorker.test.ts` | 1 | 31 / 1 / 85 |
| `touched-tests-fixed` | `/usr/bin/python3 "$TMPDIR/retention-refresh/campaign.py"` (corrected), the twelve explicit paths above | 1 | 512 / 1 / 2,923 |
| `main-retention-worker` | `bun test --timeout=60000 src/lib/selfUpdate/retentionWorker.test.ts` on `2614b079` | 1 | 31 / 1 / 85 |

All **eleven touched test files pass: 481 tests and 2,838 assertions**. The
additional worker file fails only
`the bundled retention entry performs a real byte request under the pinned runtime`.
Its fresh main comparison has the same failure, counts and unresolved Telegram
module aliases during `Bun.build`. This is a pre-existing baseline failure.
No new test failure remains. Typecheck is green after the three fixture fixes.

| Additional command | Exit | Counts |
|---|---:|---|
| `bun node_modules/.bin/eslint` with all 29 changed TypeScript paths (complete argv in `refresh-checks/lint/command.json`) | 0 | 29 files; 0 errors; 1 existing warning |
| `python3 -c 'import ast,pathlib; files=["scripts/delegatus-release-holders.py","scripts/install-release-observer.py"]; [ast.parse(pathlib.Path(f).read_text()) for f in files]; print("2 files parsed")'` | 0 | 2 files |
| `/usr/bin/python3 -IB -c 'import sys; assert sys.dont_write_bytecode and sys.flags.isolated; print("1 assertion, 2 flag conditions")'` | 0 | 1 assertion; 2 flag conditions |
| `/usr/sbin/visudo -cf "$TMPDIR/retention-refresh/release-observer.sudoers"` | 0 | 1 fixture rule |
| `git diff --check` | 0 | 0 whitespace findings |
| `bun scripts/privacy-publication-gate.ts --repository "$WORKTREE" --base origin/main --require-known-values --paths` with all 33 changed paths (complete argv in `refresh-checks/privacy-files/command.json`) | 0 | 33 files; 0 findings |

The `_completedHandoff` lint warning is also present in main's
`src/lib/agent/registry.ts`. The static Python and sudoers checks perform no
installation. Worktree-backup preservation, dry-run behavior,
restart recovery, authority revocation and the Docker guard all pass in the
renewed file-level results above.

The publisher must carry the incident disclosure, the timestamped read-only
dry-run report and the exact sudo installation command above into the PR body.
The successor commits locally; the pipeline owns publication, PR creation,
published-body read-back and the remaining deletion-review rounds.
