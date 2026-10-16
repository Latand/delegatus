# macOS spawn-health timeout

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
