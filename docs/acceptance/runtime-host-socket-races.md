# Runtime-host test socket races

The failure belongs to the test harness. Both fence contenders still use the
real `RuntimeHostFence`; product runtime-host and launcher code is unchanged.

## CI evidence and diagnosis

Read with `gh run view <run> --log`, selecting attempt 1 where the run had been
rerun:

| Platform-tests run | Observed failure |
| --- | --- |
| 36488214565 | Fence reclamation: `ECONNREFUSED`, 85 ms |
| 36551690581 | CLI ready-socket: child exits on `OperatorStateUnderTestError` importing its inbox; fence case passes |
| 36591496979, attempt 1 | Fence reclamation: `ECONNREFUSED`, 95 ms; CLI case passes |

The fence fixture already publishes its outcome after the listen callback.
A syscall trace of a failing repetition showed successful `bind`, `listen` and
`connect` before Bun reported `ECONNREFUSED`. The fixture ended the accepted
socket immediately, racing the client's connection setup. Waiting for the
client's connected probe eliminated the failure in the measured sample.
The product socket handler waits for an incoming request frame already.
The launcher catches connection errors as unsuccessful readiness probes.

The CLI fixture had the same immediate-ending peer. Its child also narrowed
`TMPDIR` to a sibling of its config directory. On CI, whose temp root is outside
`/tmp`, that leaves the inbox classified as operator state. If the socket probe
misses and the child finishes importing first, the CLI reports the child exit
instead of the expected owner mismatch. A separate child importing the real
`inboxDir()` reproduced that refusal with the old environment.

## Fix locations

- `src/runtime-host/runtimeHostFence.test.ts:28`: send a probe only from the
  client's `connect` event.
- `src/runtime-host/fixtures/runtimeHostFenceContender.ts:44`: consume the probe
  before replying and ending the socket.
- `src/runtime-host/fixtures/runtimeHostFenceLegacyNullIdentity.ts:28` and `:50`:
  apply the same handshake to both legacy listeners used by the shared reader.
- `src/runtime-host/runtimeHostFence.test.ts:43`: query each legacy endpoint once
  after the outcome barrier. Only `ENOENT` and `ECONNREFUSED` mean absent;
  unexpected errors propagate. Remove the two-second absent-endpoint retry loop.
- `bin/server-runtime.test.ts:172`: make the sandbox itself the child's temp root
  so its home, config and state remain inside it.
- `bin/server-runtime.test.ts:191`: keep the incumbent peer open until the CLI
  destroys its connected probe.

No added readiness sleeps, connection retries or increased deadlines.

## Repetition evidence

Four concurrent test processes were restricted to two CPUs. Every invocation
ran one explicit test-file path and one test-name filter, with its own fresh
state, config and temp directories. Both sides used the same worker count and
CPU affinity. The shared host's other load varied. Raw Linux traces and logs
were inspected locally; the public record contains aggregate counts only.

| Case | Bun | Before failures | After failures |
| --- | --- | --- | --- |
| Stale fence reclamation | CI 1.3.3 | 72/200 | 0/200 |
| CLI ready-socket, `/tmp` roots | CI 1.3.3 | 0/200 | 0/200 |
| CLI ready-socket, CI-shaped path aliases | CI 1.3.3 | 0/200 | 0/200 |
| Real inbox import, CI-shaped child environment | CI 1.3.3 | 20/20 | 0/20 |
| Legacy listener, unchanged baseline | Pinned 1.4.0 | 0/200 | 0/200 |

The CLI flake did not recur in the end-to-end repetition samples. Its
environment defect was independently reproduced through the actual inbox
resolution, without weakening the state guard. An intermediate conversion of
the reader alone, with the legacy fixture still ending immediately, failed
200/200 repetitions in teardown: the probe remained unread. Updating both
legacy listeners to consume it produced the final 0/200 result. The final
single-probe scan also removes the old two-second cost of the absent endpoint.

The machine-readable counts and durations are in
`evidence/runtime-host/socket-races.json`.

To repeat, use Bun 1.3.3 for the CI cases and Bun 1.4.0 for the legacy case.
For each of 200 invocations, create an independent `/tmp` sandbox with
`mktemp -d`, create its `state`, `config` and `tmp` subdirectories, set
`LLV_STATE_DIR`, `XDG_CONFIG_HOME` and `TMPDIR` to those directories, and run
`taskset -c 0,1 bun test <file> --test-name-pattern <case>`. Schedule four such
invocations concurrently, collect every exit status, and count all failures.
The CI-path variant presents each fresh sandbox through a unique worktree
symlink outside `/tmp`, removed after that invocation. Baseline copies retain
the original test/fixture bodies and resolve their imports to this checkout.

## Checks and boundaries

- Both complete files: 32/32 passing under CI Bun 1.3.3 and pinned Bun 1.4.0.
- Touched-file ESLint: zero errors, one pre-existing unused-import warning.
  The baseline ESLint 10 config crashes loading `react/display-name`; applying
  the separate lint lane's `@eslint/compat` adapter to the unchanged project
  config retains every rule and completes. ESLint 9 with the unchanged config
  independently gives the same result. No lint configuration/dependency changes
  belong to this patch.
- TypeScript: `node node_modules/typescript/bin/tsc --noEmit --incremental false`
  passes. An initial Bun-driven compiler run was stopped by its recorded PID
  after prolonged resource use; the completed check uses TypeScript's Node
  interpreter.
- Privacy-publication gate and `git diff --check`: pass.
- Runtime-host behavior and Bun pins are unchanged, so the product runtime-host
  rehearsal is not required by this change.
- All sockets and ports belong to these test sandboxes. No live runtime host,
  stable listener, conversation, journal or runtime-delivery source was touched.

Self-review: the fix stays in the two test files and their existing fixtures.
It uses the existing outcome barriers and socket events, adds no helper module
or driver, and preserves both singleton ownership and owner-mismatch assertions.
