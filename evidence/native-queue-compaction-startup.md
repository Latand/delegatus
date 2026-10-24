# Native queue compaction startup verification

Verification date: 2026-10-23. The complete file is
`src/lib/runtime/nativeQueueCompaction.integration.test.ts`.

## Cause and repair

The publication refusal reports `initialize timed out`, before the native
queue recovery assertions execute. This fixture supplied
`requestTimeoutMs: 1000` to the real app-server. The production default in
`src/lib/runtime/codexAppServerHost.ts` is 30 seconds. A two-second startup
delay reproduces the same refusal on main and the refused head in every trial.
Ordinary whole-file runs pass on both revisions.

The fixture now uses the production RPC deadline and a 60-second whole-test
bound. Every assertion, polling predicate and cleanup statement is unchanged.
The missing-evidence case still preserves both entries; canonical evidence
still settles only the dispatched entry; the undispatched entry remains
queued; recovery still writes nothing to the engine. A byte comparison against
main confirmed the only changes are the RPC override, explanatory comment and
whole-test bound. The source repair matches the overlapping publication repair
in `dc1ef2c09`, whose actual diff was read before editing.

## Procedure

All observations used Bun 1.4.0 and `gate-remote`, one call at a time. Main and
the refused head ran from disposable detached clones with the same origin.
Every trial created fresh private HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and
TMPDIR beneath the runner's private temporary root, with LLV_VIEWER_CONTROL_URL
set to a closed loopback port. The repository preload, child supervision and
fixture's isolated local Responses backend remained enabled. No live state or
external model service was used.

Each remote shell loop executed this command with the chosen fixture binary,
printed a result line per trial and ended with an explicit completed-run count:

```sh
setsid env HOME="$TRIAL/home" XDG_CONFIG_HOME="$TRIAL/config" \
  LLV_STATE_DIR="$TRIAL/state" TMPDIR="$TRIAL/tmp" \
  LLV_VIEWER_CONTROL_URL="$CLOSED_CONTROL_URL" \
  NATIVE_CODEX_QUEUE_TEST_BINARY="$CODEX_FIXTURE" \
  bun test src/lib/runtime/nativeQueueCompaction.integration.test.ts </dev/null
```

No test-name filter was used. Startup-control wrappers delayed only the actual
`app-server --enable realtime_conversation` launch. Version, feature and schema
probes forwarded immediately, and the wrapper then used `exec` with unchanged
arguments. The delayed control waited two seconds; the stuck control withheld
startup for 45 seconds, beyond the production RPC deadline. These controls
changed only scratch wrappers, never product source or the test assertions.

## Whole-file outcomes

Main was fetched before the comparison: `f348d75bd0012871867ebc63908a69b7b9e65b1c`.
The refused head is `5dea4d29`. Their test file bytes are identical.
The fixed test blob is `bb8229a29f23e5f29c0ac92a33fa7d118777714b`.

| Revision / startup | Codex | Runs | Whole-file exit codes |
| --- | --- | ---: | --- |
| Main, ordinary | 0.162.1 | 3 | 0, 0, 0 |
| Refused head, ordinary | 0.162.1 | 3 | 0, 0, 0 |
| Main, two-second delay | 0.162.1 | 3 | 1, 1, 1: `initialize timed out` |
| Refused head, two-second delay | 0.162.1 | 3 | 1, 1, 1: `initialize timed out` |
| Fixed, ordinary | 0.154.0 | 3 | 0, 0, 0 |
| Fixed, ordinary | 0.159.0 | 3 | 0, 0, 0 |
| Fixed, ordinary | 0.162.1 | 3 | 0, 0, 0 |
| Fixed, ordinary | 0.163.0 | 3 | 0, 0, 0 |
| Fixed, two-second delay | 0.162.1 | 3 | 0, 0, 0 |
| Fixed, stuck startup | 0.162.1 | 1 | 1: expected `initialize timed out` |

Every successful whole-file observation reports two passed tests, zero failed
tests and 37 assertions. Every delayed-start reproduction reports one passed
registry test and one failed real-Codex test at initialization. All completed
loop counts match their requested trial counts.

The stuck-start control also reports one passed registry test and one failed
real-Codex test, at the production RPC deadline. Supervised cleanup completes
within the whole-test bound. Across this source-blob campaign, main and the
refused head each have three ordinary passes and three expected delayed-start
failures. The fixed source has 15 passes and one expected timeout-control
failure. Final committed-head confirmations are reported separately in the
stage summary.
