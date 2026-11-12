# Claude queued-send containment

Issue #2741 follows the queued-send admission enabled by #2694. The broker
allocated a turn slot for each input and shifted one slot per result. Claude
can echo several inputs before one result, leaving an already-consumed input
as a phantom active turn. Subsequent interrupt-active sends then wait behind
that turn. The installed CLI can also combine two queued payloads into one
canonical replay frame. That frame's UUID alone cannot identify every input.

The urgent repair set Claude's `supportsQueuedSend` to `false`. The existing
`StructuredDeliveryQueue` keeps queue and steer-or-queue operations in the
journal while Claude is active or awaiting permission. Each input is written
only after idle, confirmed under its original operation, and completed by its
own result boundary. Permission answers and explicit interrupts keep their
existing control path. An explicit operator interrupt-active replacement
passes queued agent follow-ups, including across the incumbent's transition
back to idle. The follow-up stays in its original journal slot until the
replacement reaches its terminal boundary. Native batching remains deferred
pending authoritative per-input identity evidence tracked in #2742.

The later operator-send path (#3822) also declares
`acceptsInputDuringTurn=true`: an ordinary operator `interrupt-active` send
can join a running turn at a tool boundary, one pending input at a time,
without interrupting its tool. A turn awaiting permission retains the wait.
Agent `queue` and `steer-or-queue` follow-ups retain the containment above.
The historical replacement/interrupt evidence below predates that change.

## Reproduce the current installed-CLI checks

Resolve the installed Claude binary before isolating HOME. Export the source
to a scratch directory, make dependencies available there, and run the one
explicit test file through the gate runner:

```sh
CLAUDE=$(command -v claude)
mkdir -p "$RUN/home" "$RUN/config" "$RUN/tmp" "$RUN/state"
cd "$EXPORT"
LLV_GATE_RUNNER=off LLV_OWNED_RUN_TIMEOUT_MS=720000 \
bash "$GATE" --record "$LOG" env \
HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/config" \
TMPDIR="$RUN/tmp" LLV_STATE_DIR="$RUN/state" \
LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 LLV_CLAUDE_BINARY="$CLAUDE" \
bun test --timeout=60000 src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts
```

`EXPORT` and each fresh `RUN` live under the caller's scratch directory.
`GATE` is the caller's pinned gate wrapper (or `scripts/gate-slot.sh` for an
ordinary checkout); `LOG` is a fresh recorder path. Wait for its terminal
receipt before starting another check. The fixture supplies synthetic auth
and all model responses through a loopback port-0 API; it uses no account or
paid inference. Opting out of `LLV_CLAUDE_BINARY` skips these native tests.

## CLI 2.1.322 identity and lifecycle verification

The 2026-11-12 continuation preserves `supportsQueuedSend=false`.
The installed-CLI file checks the real broker, `StructuredDeliveryQueue`,
`RuntimeJournal`, file delivery ledger and event projection. Its native
protocol probe writes two additional synthetic inputs at the transport seam;
that probe deliberately claims no broker receipts for those inputs.

The current replay sequence is seed, standalone queued input, then a combined
two-input replay. Exact text, order and UUID assertions replace the stale
two-replay shape expectation. Caller-supplied UUIDs survive in terminal
`user_message_uuids`: the seed result identifies the seed, and the batch result
identifies both queued inputs. This is positive protocol evidence.

The broker still writes no caller UUID in `send()` and `acceptResult()` reads
only singular `user_message_uuid`, alongside the existing echo-based delivery
confirmation. No durable per-input/result-array binding exists. Its current
guard refuses a third direct send while one input already waits behind the
incumbent. The guarded-delivery case asserts that refusal writes no bytes and
creates no ledger row, then verifies one successful retry after idle.
Enabling admission alone therefore cannot meet #2742's native-batch identity
and lifecycle acceptance. Native batching remains deferred.

The running-tool regression now expects one successful result for the
incumbent plus its joined operator input. It checks the successful tool result,
both original ledger entries, the follow-up's incumbent turn receipt, zero
interrupt controls, one completed turn, and idle broker/journal state. A
bounded filesystem handshake observes the actual tool start and releases it
after the follow-up reaches stdin.

The lifecycle cases retain three delayed follow-ups, including an image,
through completion, explicit interruption, permission allow/deny/cancel and
a real CLI restart. Restart closes and reopens the journal, resumes the same
CLI session, and compares original queued receipts before delivery. Two
batches preserve operation order, distinct confirmations, image bytes and
stored references, and idempotent replay across replacement queue executors.
These cases verify contained serial delivery. They do not establish native
parallel admission, restart of an ambiguous native batch, or receipt ownership
for every member of such a batch.

## 2026-11-12 command ledger

Production source in these exports is the unchanged `f9571ba01c` baseline.
The final native test is committed as `50c09e8501`. Bun is 1.4.0 and the
installed CLI is 2.1.322. Remote main advanced to `aae7208f2d` during the
continuation; the broker, queue and native-test blobs were unchanged there.

Each heavy run used the pinned wrapper, a fresh recorder log, and a fresh
isolated environment from the reproduction above. The stage invoked the
wrapper from its checkout and added `--cwd "$EXPORT"` to each `bun test`
command. Only one file ran per command, and heavy commands ran sequentially.
Every retained test log has a runner banner, file summary, assertion count,
actual terminal exit and cleanup receipt. Queue admission time precedes the
test budget. No build, typecheck, full suite, live recovery or UI change ran.

For the broker run, the exact test-name filter was:

```sh
B='review: an operator send|ordinary operator send|confirmation budget|ledgered pre-actuation|same-text turn|restart transcript reconciliation|missing replay confirmation|written queued input|file delivery ledger|a write aimed|a background result|uses explicit control messages|retires control attention'
```

In the table, `N` is
`src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts` and `H` is
`src/lib/runtime/claudeStreamBrokerHost.test.ts`. Commands expand those paths;
`CLAUDE` is resolved before isolating HOME. Native runs additionally set
`LLV_CLAUDE_BINARY="$CLAUDE"`.

| Run / retained log | Command after wrapper and isolated environment | Budget | Exit | Test / assertion counts |
|---|---|---:|---:|---|
| Earlier unchanged-main baseline: `native-baseline.log` | `bun test --timeout=60000 --cwd "$EXPORT" "$N"` | 180 s | 1 | 2 pass, 2 fail, 52 assertions |
| Earlier scratch UUID investigation: `identity-probe.log` | `LLV_IDENTITY_PROBE="$PROBE_FRAMES" bun test --timeout=60000 --cwd "$EXPORT" "$N" -t combined-replay` | 180 s | 1 | 0 pass, 1 fail, 3 filtered, 2 assertions |
| Corrected expectations: `native-1.log` | `bun test --timeout=60000 --cwd "$EXPORT" "$N"` | 240 s | 0 | 5 pass, 0 fail, 83 assertions |
| Added lifecycle cases: `native-2.log` | Same native command | 720 s | 1 | 10 pass, 1 fail, 332 assertions |
| Final native file: `native-3.log` | Same native command | 720 s | 0 | 11 pass, 0 fail, 375 assertions |
| Focused broker regressions: `broker.log` | `bun test --timeout=60000 --cwd "$EXPORT" "$H" -t "$B"` | 300 s | 0 | 30 pass, 0 fail, 161 filtered, 2,285 assertions |

The final native and focused broker runs total 41 passing tests, zero failures
and 2,660 assertions. Native execution took 35.25 seconds after admission;
the broker selection took 11.94 seconds. These are check durations, without a
performance claim. Both completed owned-process cleanup.

The earlier UUID investigation temporarily bypassed the pending-input guard
in its scratch export. Its old shape assertion failed on the standalone
queued replay before the combined replay. The committed probe instead
injects native frames at the test's transport seam and leaves source
admission intact. The original two baseline failures were stale replay and
two-result expectations. The intermediate lifecycle failure checked an
interrupt receipt before the short drain pass reached its control effect;
the final case drives subsequent controller passes before asserting it.
Those failed runs remain evidence, with their counts, rather than passing
receipts. Snapshots of the intermediate and final native tests accompany
the continuation logs.

Additional checks used the source-export tools or Git in the stage checkout.
Tool processes isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR;
privacy also set `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE` to the checkout's
committed fingerprint file:

| Command | Exit | Counts / result |
|---|---:|---|
| `bun node_modules/eslint/bin/eslint.js "$N"` (two runs) | 0 each | 0 errors, 0 warnings |
| `bun "$EXPORT/scripts/privacy-publication-gate.ts" --repository "$CHECKOUT" --require-known-values --paths "$N" docs/verification/claude-queued-send-containment.md` | 0 | 2 files, 0 findings; `privacy-1.log` |
| `bun "$EXPORT/scripts/privacy-publication-gate.ts" --repository "$CHECKOUT" --require-known-values --check-commits --added-lines --base origin/main` | 0 each | 0 findings; `privacy-2.log` and final `privacy-final.log`; publication range uses merge-base `f9571ba01c` |
| `git diff --check` (repeated during editing) | 0 each | 0 whitespace errors |
| `cmp "$COMMITTED_NATIVE" "$EXPORT/$N"` | 0 | 1 byte-identical committed/exported test file; `COMMITTED_NATIVE` was populated with `git show HEAD:src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts` |
| `git diff --exit-code f9571ba01c -- src/lib/runtime/claudeStreamBrokerHost.ts src/lib/runtime/structuredDeliveryQueue.ts` | 0 | 2 unchanged production paths |
| `claude --version` | 0 | 1 binary: 2.1.322 |
| `bun --version` | 0 | 1 runtime: 1.4.0 |
| `git ls-remote origin refs/heads/main` | 0 | 1 remote ref |
| `git fetch origin main` | 0 | Main refreshed; 0 changed paths in the broker/queue/native-test comparison |
| `gh issue view 2742 --json state,title,body,comments` | 0 | 1 open issue, 0 comments |
| `gh pr list --state open --limit 50 --json number,title,headRefName` | 0 | Open-PR inventory read; no overlapping native-batching change identified |
| `gh pr list --state open --limit 100 --json number,title,headRefName` | 0 | Refreshed inventory: 41 open PRs |
| `gh pr view 3926 --json files --jq '.files[].path'` | 0 | 5 files, 0 overlapping paths |
| `gh pr view 3929 --json files --jq '.files[].path'` and the same command for 3930 | 0 each | 2 newer PRs inspected, 0 overlapping paths |
| Plain `git commit` for the native tests | 0 | Pre-commit whitespace and ESLint passed; 0 introduced errors |
| Plain `git commit` for this verification document | 0 | Pre-commit whitespace passed; 0 code files to lint |
| Final `git status --short` | 0 | 0 uncommitted changes |

The inherited run also passed 5 focused broker tests (186 filtered,
64 assertions, exit 0) with this exact filter:

```sh
bun test --timeout=60000 "$H" -t 'Claude queued-send containment|ordinary operator send|written queued input|queues ordinary active-turn|confirmation budget'
```

Its report privacy scan ran twice, exit 0 each, zero findings. The earlier
logs are retained under `queue-verification`; continuation logs are under
`queue-continuation` in the lane's retained evidence directory.

## Historical containment evidence

All tests used explicit isolated HOME, XDG_CONFIG_HOME, TMPDIR and
LLV_STATE_DIR roots and the owned gate runner. No production state, account
credentials or transcript excerpts were used. Controls targeted fixture-owned
processes.

- Original broker reproduction: several per-input replay echoes followed by
  one result left an already-confirmed input active in all four completion,
  interruption and permission variants.
- Final containment regression with the unchanged base broker: all five
  cases failed because a second input reached stdin during the incumbent
  turn. With containment, all five passed through the real broker,
  `StructuredDeliveryQueue`, `RuntimeJournal` and engine-event projection.
- Separately, the operator-predecessor interruption finding was base-green and
  head-red: both reported cases passed at historical base
  `efd43fc7ccb47b40b0ced4d17393c1ffd7fbcafb` and failed at reviewed pre-fix
  head `9d133060fb66968fa8f8ffb9f1fd5fd8337936f1`. The integrated repair's
  16-case regression passes at `9607fef77d31d76e80af5c4a57865b54e8b5bd9a`.
- The final cases cover two batches, three pending follow-ups per batch,
  queued images, a replacement executor, idempotent operation replay,
  permission answer and expiration, explicit interruption, and a subsequent
  interrupt-active image send from idle. Reopened delivery records retain
  each original payload and canonical confirmation under its original ID.
- The operator-replacement regression covers `queue` and `steer-or-queue`
  predecessors from agent, operator, and absent-origin legacy operations. The
  message-origin schema accepts operator and agent origins; absent origin is
  retained for legacy operations, while `system` is rejected by its parser.
  Each combination runs with an active incumbent and with a fresh permission
  request awaiting a response. Claude continues to declare
  `supportsQueuedSend=false`.
- Each case queues two original sends (text and image) before an explicit
  operator `interrupt-active` replacement. It verifies one interruption
  control, then checks that the first user stdin frame after the incumbent
  result is the replacement. Both queued receipts and payloads remain intact
  through the replacement's terminal boundary. The two sends then deliver once
  each, with their original images, and operation replay remains idempotent
  across replacement queue executors.
- Installed Claude CLI 2.1.284, using synthetic authentication and responses
  from a loopback port-0 Messages API: three direct inputs produced a seed
  replay and a combined two-payload replay. Only the seed receipt was
  confirmed; the combined frame did not falsely confirm either queued input.
- With the real queue admission path, three pending operations and a subsequent
  send produced four input writes, four distinct canonical confirmations,
  four result boundaries, zero interrupt requests, and idle broker/journal
  state. The native cases passed without a real provider or account.

The native test is opt-in:

```sh
sandbox=$(mktemp -d)
mkdir -p "$sandbox/home" "$sandbox/config" "$sandbox/tmp" "$sandbox/state"
HOME="$sandbox/home" XDG_CONFIG_HOME="$sandbox/config" \
TMPDIR="$sandbox/tmp" LLV_STATE_DIR="$sandbox/state" \
LLV_CLAUDE_BINARY="$(command -v claude)" \
bash scripts/gate-slot.sh bun test src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts
```

Focused verification also runs
`src/lib/runtime/claudeStreamBrokerHost.test.ts` and
`src/lib/runtime/structuredDeliveryQueue.test.ts` by explicit path, types with
`bunx tsc --noEmit`, and `bun run privacy:check`.

## Limits

This contains future queue admission. It does not mutate, migrate or replay
inputs already handed to a live CLI, clear an existing phantom turn, or repair
ambiguous native-batch receipts. The original receipt/image records remain
intact. Existing affected hosts require a separately authorized operational
recovery. Native protocol evidence is specific to the installed CLI version;
subscription/provider behavior and other CLI versions were not exercised.
