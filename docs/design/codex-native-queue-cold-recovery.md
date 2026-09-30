# Codex native queue cold recovery

Verification date: 2026-09-30. Baseline: `ce8abf18b7c07af31f8f7e36e66045b7a5bf41c4`.
This closes the native-queue compatibility deferral in
[active-turn steering validation](active-turn-steering-validation.md).

## Reproduction before the change

The existing real-CLI integration cases reproduce both failures on installed
Codex 0.159.0. The same cases pass on an isolated npm-installed 0.154.0 binary.

```sh
NATIVE_CODEX_QUEUE_TEST_BINARY="$CLI" bun test \
  src/lib/runtime/nativeQueueHost.integration.test.ts \
  -t 'recovery \((small|large)\)'
```

| Baseline CLI | Pass | Fail | Observed failure |
| --- | ---: | ---: | --- |
| 0.154.0 | 2 | 0 | Both cold-recovery cases complete |
| 0.159.0 | 0 | 2 | Small: 60-second delivery deadline; large: `thread/resume` timeout |

The small case resumes a living CLI, then waits for canonical proof of the
original queued client message. The large fixture additionally withheld the
resume reply until native emitted `turn/started`. A retained paused queue cannot
produce that event before the client receives resume and requests start, so
the fixture barrier deadlocked adoption. Removing that barrier alone would
leave the small case's production delivery failure intact.

An initial attempt could not load `zod` (0 pass, 1 fail, 1 loader error).
`bun install --frozen-lockfile` resolved that environment prerequisite before
the baseline comparison above.

## Exact behavior observed between versions

A bounded raw JSON-RPC probe used a credential-free loopback Responses server,
one held active turn and one queued text input. Each CLI generation used the
same private Codex home. The probe stopped only its recorded child, resumed
the saved thread in a new child, observed for 12 seconds, listed the queue,
and explicitly started a retained head when present. The retained driver is
`scripts/probe-native-codex-queue.mjs`; repeat each cell under the isolated
environment below with `bun scripts/probe-native-codex-queue.mjs "$CLI" SIGTERM`
or `SIGKILL`. This table records the fresh fix-round comparison.

| Signal / CLI | Resume snapshot | Queue after 12 seconds | Provider requests | Native start events |
| --- | --- | --- | ---: | --- |
| SIGTERM / 0.154.0 | Idle; previous turn interrupted | Empty | 2 | Recovered `turn/started` |
| SIGTERM / 0.159.0 | Idle; previous turn interrupted | Original queued client remains | 1 | None |
| SIGKILL / 0.154.0 | Idle; previous turn interrupted | Empty | 2 | Recovered `turn/started` |
| SIGKILL / 0.159.0 | Idle; previous turn interrupted | Empty | 2 | Recovered `turn/started` |

On 0.159.0, `thread/queue/start` naming the retained submission returns a turn
with `status: "inProgress"`, delivers the original client identity and raises
the provider request count to 2. The unchanged baseline integration deadline
also shows the retained 0.159.0 entry still lacks delivery after 60 seconds.
The compatibility change is cold-resume automatic dispatch: the installed CLI
can resume an interrupted thread as idle while leaving its native queue
paused. Delegatus previously assumed cold resume would dispatch it.

These are bounded observations. They establish the failed cold-resume contract
and a working recovery operation without claiming every Codex shutdown mode
or a specific eventual dispatch time.

Protocol and source cross-checks:

- Both binaries generated experimental TypeScript with
  `"$CLI" app-server generate-ts --experimental --out "$TYPES"` under private
  homes. `ThreadQueueListResponse`, `QueuedSubmission` and the queue-start
  request/response types retain the same contract. Resume adds unrelated
  plugin/collaboration fields; no new queue-resume parameter is needed.
- Read-only SQLite schema inspection of the probe homes found the same
  `queue_1.sqlite` tables: `queued_items` and `queued_thread_revisions`, with
  the same columns. This is evidence about queue storage, not a claim that
  every history file is unchanged.
- [0.159.0 stdio transport](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/app-server-transport/src/transport/stdio.rs)
  registers SIGTERM and routes it through connection closure and bounded
  cleanup. [0.154.0 stdio transport](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server-transport/src/transport/stdio.rs)
  has no such handler. The fresh SIGKILL comparison recovered automatically
  on both versions. An earlier 0.159.0 SIGKILL probe recorded a retained head;
  these bounded runs establish shutdown-sensitive behavior and do not isolate
  one universal cause or guarantee the result of every kill timing.
- The [native queue service](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/ext/queue/src/service.rs)
  skips automatic wake/dispatch for an internally interrupted agent; its
  explicit start uses `start_turn_if_idle`. The public idle snapshot therefore
  does not guarantee automatic dispatch. The same service guards exist in
  [0.154.0](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/ext/queue/src/service.rs).
  The version difference in the table is established by the executable probe.

## Production impact

Before this fix, production using Codex 0.159.0 can leave queued messages
delayed indefinitely after a cold runtime-host restart: an active conversation
has pending native submissions, its old CLI ends, and the replacement reports
idle with those submissions still retained and no automatic turn start.
The fresh comparison retained the queue on 0.159.0 after SIGTERM and recovered
it automatically after SIGKILL. The original host integration case covers
Delegatus's own release/adopt path. EOF-only cleanup also retained the queue
in earlier raw probes on both versions.

The observed messages are retained in Codex and in Delegatus's journal; no
payload loss was observed. Before the fix, explicit native start can release
the delay. Deliberate interruptions and blocking attention are separate pause
conditions and remain respected. Production impact is inferred from the real
CLI probes and the production adapter exercised by the tests. No live
conversation or deployed runtime was inspected or restarted.

## Recovery and CI

After native queue discovery on adoption, Delegatus starts only a fresh
observed head when resume explicitly reported idle, no live start won the
resume/list race, and no blocking attention exists. A previously recorded
live interruption is captured before cold history reconciliation and preserves
the operator's pause. A terminal interruption inferred from history carries
`interruptionSource: "history"` durably, so a failed adoption does not turn it
into a pause on the next attempt. Existing untagged events retain their pause
meaning. Fresh thread creation does not run recovery.

Recovery names the exact native submission ID. Codex arbitrates idle state
atomically, so an auto-dispatch race cannot consume a different head. No input
is re-added, no mutation is retried, and delivery still requires canonical
proof. A refusal is tolerated only when a fresh read shows removal or a live
turn; a retained idle head with a refusal, or an uncertain reply, fails adoption
and preserves the original operation for later reconciliation.

The registry already takes its per-conversation operation lock and writer
claim before calling `adopt`; this change uses that ownership boundary.
The separate `native-codex-runtime` CI job runs the complete existing driver
against both 0.154.0 and 0.159.0. The manual large-image campaign also covers
both versions. The native job also asserts that its running Bun equals the
Dockerfile pin, which remains 1.4.0. The fixtures check queue/history/injection
behavior directly; version-string assertions have been removed. The CI
matrix defines the two verified versions; additional versions remain unverified.
No timeout was increased and recovery contains no version branch.

## Files changed

- `src/lib/runtime/codexAppServerHost.ts`: idle-head recovery and pause/race guards.
- `src/lib/runtime/codexAppServerHost.test.ts`: recovery, pauses, buffered starts,
  list races, refusal evidence and lost-acknowledgement regressions; failed
  adoption retries against shared memory and reopened file ledgers.
- `src/lib/runtime/engineHost.ts`: optional history origin for interruptions.
- `src/lib/runtime/nativeQueueHost.integration.test.ts`: replace the auto-start
  dependent resume barrier with a queue-read barrier. An empty queue waits for
  the real automatic `turn/started` and coalesces it with resume; a retained
  head releases resume immediately for host recovery. Both real CLI paths keep
  image/content proof and original mutation counts, with no new timer.
- `src/lib/runtime/nativeCodexQueue.test.ts`,
  `src/lib/runtime/codexHistoryReader.test.ts`: remove exact-version assertions
  and pin-specific test names; retain behavior assertions.
- `src/lib/runtime/codexAppServerHost.injectResponses.test.ts`,
  `src/lib/runtime/codexAppServerHost.injectCli.test.ts`: remove another native
  runner pin assertion and a pin-specific test name uncovered by the full
  installed-version run. Injection behavior assertions remain intact.
- `scripts/verify-native-codex-runtime.ts`: remove the obsolete pin-only hint.
- `.github/workflows/bun-runtime.yml`, `scripts/bun-runtime-workflow.test.ts`:
  full native runner matrix and workflow verification.
- `scripts/probe-native-codex-queue.mjs`: retained, bounded raw protocol probe
  for both shutdown signals, with a credential-free environment and cleanup
  limited to the children it started.
- `docs/design/native-codex-runtime.md`, this report: current recovery and evidence.

## Verification commands and results

All runs used fresh `mktemp -d /tmp/codex-queue-…` roots, with private
`LLV_STATE_DIR`, `XDG_CONFIG_HOME`, `TMPDIR`, `CODEX_HOME` and `HOME`. The native
driver further constructs a credential-free child environment and runs its
named files in 29 sequential batches. The real-CLI runner invocations and
runtime-host rehearsal were sequential, and uptime was checked between them.
TypeScript and touched-file lint briefly overlapped in isolated environments;
both finished before the runtime-host rehearsal. No process was selected by
name or port.

To repeat with either absolute fixture executable:

```sh
scratch="$(mktemp -d /tmp/codex-queue-check-XXXXXX)"
mkdir -p "$scratch"/{state,config,tmp,codex,home}
export LLV_STATE_DIR="$scratch/state" XDG_CONFIG_HOME="$scratch/config"
export TMPDIR="$scratch/tmp" CODEX_HOME="$scratch/codex" HOME="$scratch/home"
```

| Command | 0.154.0 pass/fail | 0.159.0 pass/fail |
| --- | --- | --- |
| Baseline cold command above | 2/0 | 0/2 |
| `bun scripts/verify-native-codex-runtime.ts "$CLI"` (final) | 1,054/0, 29 batches | 1,054/0, 29 batches |
| First fixed cold command above | Not run separately | 2/0 |
| `LLV_CODEX_BINARY="$CLI" bun test src/lib/runtime/codexAppServerHost.injectResponses.test.ts` | 6/0 | 6/0 |

CLI-independent checks and intermediate results:

- `bun test src/lib/runtime/codexAppServerHost.test.ts scripts/bun-runtime-workflow.test.ts`:
  final 169/0. Earlier runs: 167/1 (the fake refusal omitted a JSON-RPC error
  code), then 168/0 before adding the retained-refusal regression.
- First fixed full 0.154.0 driver: 1,053/0. Self-review then tightened refusal
  handling and added one regression; the final full run above supersedes it.
- First full installed-version run after recovery: 822/6 across 11 batches.
  All six failures asserted 0.154.0 in the Responses injection fixture; none
  reached its behavior checks. That additional pin assertion is now replaced,
  and its behavior checks pass on installed 0.159.0.
- `bun install --frozen-lockfile`: passed.
- `bun node_modules/typescript/bin/tsc --noEmit`: passed, exit 0.
- `bun run lint -- scripts/bun-runtime-workflow.test.ts scripts/verify-native-codex-runtime.ts src/lib/runtime/codexAppServerHost.ts src/lib/runtime/codexAppServerHost.test.ts src/lib/runtime/codexHistoryReader.test.ts src/lib/runtime/nativeCodexQueue.test.ts src/lib/runtime/nativeQueueHost.integration.test.ts src/lib/runtime/codexAppServerHost.injectResponses.test.ts src/lib/runtime/codexAppServerHost.injectCli.test.ts`:
  passed, 0 errors and 4 pre-existing unused-variable warnings.
- `bun scripts/verify-runtime-host.ts --runtime "$(command -v bun)"`: passed
  under Bun 1.4.0. Two isolated generations completed succession in 507 ms;
  listener and runtime socket each answered 27/27 polls over 15 seconds, with
  13 abandoned peers on each. Docker operations were recorded by the rehearsal's
  stub. No live runtime host, container or stable port was used.
- `bun run privacy:check`: passed with known-value fingerprints and commit
  checks enabled. The same gate is repeated after committing to check the
  Delegatus author/committer and attribution trailer as publication surfaces.
- `git diff --check` and staged diff review: passed.

## Review fixes and fresh verification

The reviewer reproduced a second-adoption failure: the first failed recovery
had already appended an interrupted terminal event from resume history, which
the next adoption read as an operator pause. Before the fix, both new retry
cases (refused and uncertain start) made zero starts on their second adoption.
The history origin now survives the ledger. Retry coverage includes a reopened
file store, while the existing deliberate-pause scenario still makes no start.

The real large-image case again exercises native automatic dispatch around
resume. Its read-only barrier handles notifications arriving on either side
of the reply and releases an observed retained queue without waiting for an
automatic start. The fresh 0.154.0 case coalesced one real native start with
resume. No timeout was lengthened and the barrier adds no timer.

Both full native runners passed 1,057/0 across 29 sequential batches. The
0.154.0 large case observed one coalesced automatic start; 0.159.0 observed one
retained idle resume and completed through host recovery. All four raw probes
in the comparison table above ran under fresh isolated roots, one at a time.

- Final focused host/workflow/large-race check: 152/0 (23 unrelated cases
  filtered); the final 0.154.0 barrier again coalesced one real automatic start.
- `bun node_modules/typescript/bin/tsc --noEmit`: exit 0.
- Touched-file lint, including the retained probe and event type: exit 0,
  four pre-existing unused-variable warnings.
- Runtime-host rehearsal under the pinned Bun 1.4.0: passed; succession in
  1,007 ms, listener and private socket each answered 27/27 polls over 15 s,
  with 13 abandoned peers on each. Docker calls were stubbed.
- `bun run privacy:check`: passed with known-value fingerprints and commit
  checks enabled; staged diff review and whitespace checks passed.

## Unverified

Hosted CI and its manual 20-repetition-per-version campaign have not run.
The reviewer found no required-status rules; this local fix round adds the
missing interpreter assertion and does not change repository merge policy.
Deployment, operator conversations, real-provider authentication/inference
and other CLI/platform versions are unverified. The local provider is a
Responses stub and the integration authentication/catalog answers are
synthetic; queue mutations, history, persistence, native IDs and cold adoption
execute in the real binaries. No pull request or deployment is part of this task.
