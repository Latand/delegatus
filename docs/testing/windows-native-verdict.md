# Windows native verdict verification

After publication, read the Platform tests run for the pull request's current
head with `gh run list --workflow platform-tests.yml --commit <head>` and
`gh run view <run> --json headSha,jobs`. Require the Windows job to execute and
finish with success or failure within its ten-minute budget. Record its job
start/end, each test step's start/end and the Bun counts from
`gh run view <run> --job <job> --log`. A skipped job does not exercise this fix.
The publisher and subsequent review own this observation; the builder cannot
push this branch. No post-change Windows result is claimed here.

## Diagnosis

The job annotations identify a ten-minute execution timeout. These three real
Windows jobs printed successful Bun summaries, then stayed inside Platform
tests until GitHub cancelled the job:

| Run | Job | Job UTC interval, 2026-11-12 | Bun duration | Counts |
| --- | --- | --- | --- | --- |
| 43177973046 | 131049028258 | 07:54:12–08:04:17 | 23.91s | 211 pass, 14 skip, 0 fail |
| 43177537306 | 131047114043 | 07:54:06–08:04:13 | 25.28s | 211 pass, 14 skip, 0 fail |
| 43179808485 | 131053339452 | 08:04:47–08:14:52 | 22.58s | 211 pass, 14 skip, 0 fail |

Each summary covers 225 tests across 17 files. Read the cause directly with
`gh api repos/{owner}/{repo}/check-runs/<job>/annotations`; all three report
that the job exceeded its maximum execution time of 10m0s. The initiating actor
is a bot; that field alone does not identify a cancellation cause.

The concurrency group remains workflow plus PR merge ref. An actual
supersession, run 43166522035, has a different annotation: a higher-priority
waiting request for the same PR group exists. Its replacement run 43166538728
was created nine seconds later with a different head. The timed-out samples
have explicit timeout evidence. Doc-only runs skip the Windows job through
the scope job.

The last sampled successful native job, run 43138351810 / job 130919139026,
ran 02:02:23–02:08:35 UTC. Its test durations were 24.28s for platform tests,
182.60s for launcher tests, 43.76s for the search worker and 13.64s for the
helper lease. The launcher tests account for most execution time.

Commit e9fcfdb2de introduced an fd-3 timing pipe in the portable runner on every
OS. Only the Linux shell writes the timing marker and closes that descriptor
before exec. On Windows, the unused inherited pipe leaves the supervisor
waiting in `observeCommandExecution` after tests finish. The fix allocates
that channel only for the Linux shell. Native timing remains unknown and the
command's actual exit code supplies the verdict. Windows CI retains both Bun
versions, the existing coverage, concurrency group and ten-minute job budget.
Each lifecycle test file now has its own owned runner and explicit exit log;
the platform/worker file limit is two minutes and the launcher file limit is
four minutes, allowing the observed three-minute launcher execution.

## Builder checks

Checks used scratch exports of base f9571ba01c and the builder's working diff,
Bun 1.4.0, and fresh HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR directories.
Every test file ran separately through the launch-selected installed
`gate-slot.sh` from release 34b741354731 (called `$GATE` below). The recorded
driver preserved each command's log and actual exit status. The base workflow
comparison overlays the new regression test on unchanged base code.

| Revision | Command | Exit | Counts |
| --- | --- | --- | --- |
| Base | `bash "$GATE" bun test bin/server-runtime.test.ts` | 0 | 31 pass, 0 fail |
| Head | `bash "$GATE" bun test scripts/owned-runner.portable.test.ts` | 0 | 2 pass, 0 fail |
| Head | `bash "$GATE" bun test scripts/local-gate.workflows.test.ts` | 0 | 8 pass, 0 fail |
| Head | `bash "$GATE" bun test src/lib/recordedChecks/commandTiming.test.ts` | 0 | 4 pass, 0 fail |
| Head | `bash "$GATE" bun test scripts/ci-platform-scope.test.ts` | 0 | 9 pass, 0 fail |
| Base + regression | `bash "$GATE" bun test scripts/local-gate.workflows.test.ts` | 1 | 4 pass, 4 fail, expected control |
| Base + regression | `bash "$GATE" bun test scripts/owned-runner.portable.test.ts` | 0 | 2 pass, 0 fail on Linux |
| Head | `bash "$GATE" bun test scripts/owned-runner.integration.test.ts` | 0 | 49 pass, 0 fail |
| Final workflow | `bash "$GATE" bun test scripts/local-gate.workflows.test.ts` | 0 | 8 pass, 0 fail (repeat after quoting deadline env values) |
| Working diff | `git diff --check` | 0 | 0 whitespace errors |
| Publication files | `bun scripts/privacy-publication-gate.ts --base f9571ba01c --require-known-values --paths .github/workflows/platform-tests.yml scripts/local-gate.workflows.test.ts scripts/owned-runner.ts scripts/owned-runner.portable.test.ts src/lib/recordedChecks/commandTiming.test.ts docs/testing/windows-native-verdict.md` | 0 | PASS, 0 findings |
| Head | `bash "$GATE" bun node_modules/.bin/eslint scripts/owned-runner.ts scripts/owned-runner.portable.test.ts scripts/local-gate.workflows.test.ts src/lib/recordedChecks/commandTiming.test.ts` | 0 | 4 files, 0 diagnostics |

The final workflow check repeats the earlier eight-case run; privacy and
whitespace checks were repeated after the evidence text was finalized. The
plain commit also runs the repository pre-commit whitespace and ESLint checks.

The portable process regression runs first in the native Windows list under
Bun 1.3.3 and requires exit codes 0 and 7 to reach the caller. Its Linux base
result establishes that Linux does not reproduce the Windows hang. Native
before/after confirmation remains a publication acceptance requirement.

Workflow tests execute the real inline shell bodies against a fixture gate,
requiring one file per invocation, complete successful dispatch and immediate
propagation of exit 17. Removing the per-file workflow change fails all four
new cases on the base. Timing tests preserve Linux marker, setup-refusal and
cancellation behavior and cover an absent native timing channel. The owned
runner integration file covers cleanup, cancellation, deadlines and watchdogs.

Full typechecking, builds and unrelated suites belong to the project's
publication gate. The builder ran the focused files above. `actionlint` was
unavailable; the repository workflow tests parse the YAML and exercise the
modified shell bodies.
