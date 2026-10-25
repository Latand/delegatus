# macOS spawn-health verification

Observed on 2026-10-16; comparison base: `02f9301fc323`.

## CI observations

The `darwin-identity` job of [run 38615000367](https://github.com/Latand/delegatus/actions/runs/38615000367/job/116028122958)
records this sequence on 2026-10-14:

```text
18:33:02 (fail) a changed pin stays unreserved after invalid admission [5002.47ms]
18:33:02   ^ this test timed out after 5000ms.
18:33:03 (fail) a changed pin stays unreserved after unknown admission [782.98ms]
18:33:15 error: owned test child guardian did not finish
```

[Run 38759321304](https://github.com/Latand/delegatus/actions/runs/38759321304)
repeats the sequence on 2026-10-15: invalid admission times out at 5001.60 ms,
unknown admission fails at 708.73 ms, and guardian cleanup fails at 15:21:27 UTC.

Discovery used `gh run list --workflow macos-identity.yml --status failure`
and `gh run view <run> --json jobs,headSha,url`. `gh run view --log` returned
empty output for these runs. The primary lines above come from the archive
returned by `gh api repos/{owner}/{repo}/actions/runs/<run>/logs`, in the
`darwin-identity` job text.

## Cause

In the comparison base, `spawnHealth.test.ts:734-742` first dynamically imports
`next/server` and the spawn route inside the first changed-pin rejection test.
Its five-second budget includes that cold module graph as well as admission.
The same file creates file credentials, but its unmocked credential reads reach
`claudeCredentials.ts:69-78`, which launches the macOS Keychain reader before
falling back to the file. Each native call can wait up to two seconds
(`claudeCredentials.ts:20-29`). Repeated catalog, snapshot and validation reads
therefore add platform-dependent work to the first route test.

A Bun test timeout leaves the async body running. The following test can then
replace the shared provider reply and clear account state while that body is
still using them. Its late `finally` can reset the following test's reply.
The CI log also records `killed 1 dangling process` at the timeout, before the
guardian's final wait fails. The cleanup failure is downstream of the timeout;
this change leaves the guardian and its deadline unchanged.

The fix loads the route after sandbox/fetch setup, before individual tests,
and makes the file-backed fixtures use explicit credential ports. Simulated
Keychain uncertainty cases retain their own reader. Real Keychain recognition
remains covered by `claudeCredentials.test.ts` and the native macOS job.

Admission cleanup releases owned gates, clears timers and joins pending
requests before restoring hooks, environment and account state. It closes
fixture registries and also runs from `afterEach`. Reusing the same cleanup
promise makes a late `finally` inert. Deletion and coalesced-refresh barriers
use the same release-and-join discipline.

## Controlled reproduction

All local commands ran in scratch exports with matching frozen dependencies,
isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, and
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. Each heavy command used the installed
`scripts/gate-slot.sh`; tests selected the explicit file path.

The unmodified comparison base passed all 73 tests locally under Bun 1.4.0.
To reproduce slow cold loading deterministically, prepend
`await Bun.sleep(5_100);` to `src/app/api/spawn/route.ts` in each scratch export.
Run `bun test src/lib/accounts/spawnHealth.test.ts --test-name-pattern
"a changed pin stays unreserved after (invalid|unknown) admission"` through the
gate. Only that injected module-load delay differs from the normal export.
The delay is an experiment and is absent from the committed source.

On the base, invalid admission timed out at 5001.01 ms, the following test
received an unexpected accepted launch response, and teardown reported owned
children plus an error between tests. This reproduces the timeout and shared
state corruption without macOS. With the identical injected delay, the fixed export passed both cases
(105.63 ms and 45.38 ms) and teardown; total runtime was 5.50 s because
module setup still waits for the injected delay before starting test budgets. This control establishes the cold-import mechanism; it does
not measure the native Keychain latency of the historical runners.

Failure coverage injects assertion, request and holder errors around a real
account mutation lock, checks timer cancellation and one-time restoration,
then acquires the lock again. A route-level case fails after starting a queued
request, drains it, and immediately exercises the following rejection case.

## Final local checks

The explicit `src/lib/accounts/spawnHealth.test.ts` run passes 77 tests with
zero failures on Bun 1.4.0 and again on Bun 1.3.3, using the same isolation
and owned runner. Both include the failure-cleanup cases above. TypeScript
(`tsc --noEmit --incremental false`), changed-file ESLint and the publication
gate against the comparison base also pass.

Test-source SHA-256: `518e8a728c7e67675e30613ae8c8bf7b22d85eba7f6dcf3614cdb43390f6ed21`.

## Credential uncertainty diagnosis (2026-10-23)

The `darwin-identity` job of [train run 39998260621](https://github.com/Latand/delegatus/actions/runs/39998260621/job/120567496678)
reports 69 passes, seven failures and one filtered test under Bun 1.3.3.
The train's tree is identical to comparison base `800a26ebc10c`
(`f8a417c1a1621cc8177615b44449a69058f87a6c`). This workflow runs on pull
requests; its latest historical main-branch run succeeded, so the merged
train supplies the current main-equivalent failure evidence.
[PR run 40003327841](https://github.com/Latand/delegatus/actions/runs/40003327841)
repeats the seven failures.

At 17:51:12.978 UTC, the train log shows the final assertion at
`src/lib/accounts/spawnHealth.test.ts:212` expecting
`credential store is unavailable` and receiving the generic project-account
unavailable refusal. All four requested-account cases fail there, after their
earlier named-account uncertainty and healthy-fallback checks passed. At
17:51:13.740 UTC, the first unrelated-uncertainty case fails the same way at
line 289; the other two discovery variants follow. Each failing case finishes
in 133–211 ms. This failure is separate from the historical timeout above.
These cases inject credential states through mocks, including simulated
Keychain responses; the log does not establish a live Keychain access failure.

On macOS, `readClaudeCredentials` preserves a denied, locked or timed-out
Keychain read as `unknown`; only status 44 proves the item absent.
`credentialPresence` copies that state into the catalog while setting
`authPresent` to false. The direct spawn caller passes that catalog through
`selectProjectAccount` and `selectHeadlessAccount`, whose authentication filter
removes those candidates. Its early generic refusal therefore bypasses
`selectHealthyClaudeAccount`, which already preserves credential uncertainty.
The platform assumption being corrected is that an unconfirmed Keychain read
can be diagnosed like proven absence. The defect also reproduces on Linux:
the unmodified base has the identical seven failures under Bun 1.4.0.

`src/lib/accounts/manager.ts` now preserves `ClaudeCredentialUnavailableError`
when automatic selection is unavailable and the discovery snapshot contains an
unknown Claude credential inside the project's permitted pool. Named selection,
capacity exhaustion, excluded candidates, unsafe credentials and proven absence
retain their existing checks. The change uses the existing snapshot and adds
no credential read, await, launch or state write. No performance gain is claimed.
The direct consumer is `spawnCommand.ts`, reached by the spawn route and its
board, MCP and scheduled callers; their shared pool and health checks remain
the authority. No schema, persistence contract or workflow changes are needed.

All original assertions remain. Nine additional cases cover unknown, unsafe
and absent credentials across unbound, allowed and excluded pools, asserting
the refusal type and that no provider request occurs. With the original product
code, the two permitted-unknown cases fail and the other seven pass.

Heavy commands below use the installed `scripts/gate-slot.sh` wrapper with
`LLV_GATE_RUNNER=off`; `gate-remote` supplies a scratch checkout and private
HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, with a closed Viewer control URL.

| Command | State | Exit | Result |
| --- | --- | --- | --- |
| `gh run view 39998260621 --log-failed` | Merged train | 0 | Seven failures at the final automatic-selection assertions |
| `gh run view 40003327841 --log-failed` | Later PR | 0 | Same seven failures |
| `gate-remote -- bun test src/lib/accounts/spawnHealth.test.ts` | Unmodified base | 1 | 70 pass, seven fail |
| `gate-remote -- bun test src/lib/accounts/spawnHealth.test.ts -t "automatic Claude credential"` | New regressions, original product code | 1 | Seven pass, two fail |
| `gate-remote -- bun test src/lib/accounts/spawnHealth.test.ts` | Fixed product and tests | 0 | 86 pass, zero fail |
| `gate-remote -- bunx tsc --noEmit --incremental false` | Fixed product and tests | 0 | No diagnostics |
| `gate-remote -- bunx eslint src/lib/accounts/manager.ts src/lib/accounts/spawnHealth.test.ts` | Fixed product and tests | 0 | No diagnostics |
| `bun scripts/privacy-publication-gate.ts --base 800a26ebc10ca2db855d12a71320f75c5f2fb955 --require-known-values --paths src/lib/accounts/manager.ts src/lib/accounts/spawnHealth.test.ts docs/verification/spawn-health-macos.md` | Fixed product, tests and verification note | 0 | Publication privacy passes; repeated by the commit hook |
| `git diff --check` | Final diff | 0 | No whitespace errors |

The fixed source has been exercised on Linux. A new macOS verdict requires
publication and CI; this stage does not push.
