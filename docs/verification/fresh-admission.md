# Fresh admission delivery

## Lane-base trace

Base: `f41fdc45` (the fetched main revision at the start of the lane).

`src/lib/runtime/structuredMessageDelivery.ts:2203` kicks a newly committed
pending operation with `true`. `src/lib/runtime/structuredDeliveryController.ts:2111`
passes that flag to `drainWithRetry`, which calls `drainAfterAdmission` at
`:1499`. In `src/lib/runtime/structuredDeliveryQueue.ts:981`, admission waits
for the preceding general drain. Its replacement drain reaches the mandatory
`await this.port.nativeQueueReconcile?.()` at `:1012`, before listing effects
and starting the recipient's delivery lane.

The sweep implementation at
`src/lib/runtime/structuredDeliveryController.ts:1026` enumerates registered
hosts and starts native reconciliation for each eligible conversation. The
evidence promises are detached (`:1078`–`:1091`). The awaited dependency covers
the sweep setup and the preceding general pass. These two source files match
the measured serving
revision `9bd47eaa` at these seams. This establishes the dependency to remove;
it does not attribute all of the historical delay to it.

Adjacent open changes inspected before implementation: native consumption
proof in #3523, mid-turn settlement in #3524, spawn receipts in #3519 and
legacy native replay in #3355. Their production changes are outside the
fresh-admission dispatch seam; retain the existing replay parser.

## Change and contracts

The admitting message path supplies the journal's recipient id as an optional
second kick argument. The controller uses it to start a scoped pass; legacy
boolean kicks and observer kicks retain their previous general-pass behavior.
The process-wide signal forwards both arguments across bundle realms. Custom
kick callbacks may continue to ignore the optional argument.
Keyed kicks preserve the general retry timer and its failure backoff: a
recipient's pass cannot replace maintenance owed to other recipients.

The scoped pass uses the same target lane and `drainTarget` as a general pass.
It reads all pending effects and retained boundaries for that recipient, so
earlier messages and controls keep their existing order and priority. It does
not update whole-queue absence or retry bookkeeping. A competing pass marks
the recipient's wake owed; the lane owner restarts it after releasing the lane.
The watchdog uses this path for due queued sends to bound recipients, including
an unreadable keyed listing, while retaining the existing migration wake for
work the general listing proved was not yet in the runtime journal.

General absence cleanup considers only lanes that existed before the listing
started. A stale cached fallback cannot release an in-flight lane or replace
the validated listing used to recognize pre-journal work. Fresh native
handoffs schedule the existing general maintenance after their target pass.
Recipient revocation, host binding, durable settlement and journal dispatch
claims stay in the shared target drain; native adds retain their prepared claim
and binding checks in `NativeQueueExecutor`.

`StructuredDeliveryQueuePort.effectsForConversation` supplies the optional
recipient reader; `effects` keeps its general interface. The production
controller routes scoped reads directly through
`RuntimeHostClient.effectBatch`; general reads keep `DeliveryEffectPages` and
its fallback behavior. The recovery-read proxy preserves the optional key and
the abort signal. The socket handler validates the key; `RuntimeJournal` uses
an additive partial index over recipient and event sequence. Existing readers
and writers retain their defaults and record formats. A listener predating
the optional key may return global pages: the queue advances the original
cursor and filters each page locally before draining.

No composer, spawn, engine-host delivery evidence or settlement code changes.

## Verification procedure

Use a tracked-source export with its own dependencies. Each child process
builds its environment with `checkEnvironment(process.env)`, followed by
`isolatedEnvironment(createGateSandbox(), ...)`. This isolates `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR`, `LLV_STATE_DIR` and the account homes, and pins
the Viewer control URL to a closed port. Admit one sequential campaign through
`scripts/gate-slot.sh`; it runs the following commands against the export:

```sh
bun test --timeout=60000 src/lib/runtime/structuredDelivery.freshAdmission.test.ts
bun node_modules/typescript/bin/tsc --noEmit --incremental false
```

The test fixture calls the production `bindStructuredDeliveryQueue` builder.
It uses the real registry, socket client, runtime request handler, journal,
delivery progress store and native executor. The engine transport and the
barrier holding the general listing are synthetic. Counts are taken before
the fake engine's own deduplication. A separate child process restarts the
controller against the same durable journal to check completed-send replay.
Clocks and operation ids are fixed for correctness assertions; bounded awaits
detect blocked work without imposing another product latency target.

Run each of the four required cases separately with `-t`. In a separate
export, replace the single keyed dispatch call
`await this.drainPass(true, conversationId);` with
`await this.drainAfterAdmission(true);` and repeat each case: each must fail.
Also test each recovery mutation separately: remove the validated-general-read
condition from absence cleanup; compare unlisted progress against the latest
attempt instead of the validated listing; remove the fresh-native maintenance
retry. Each must fail its corresponding focused case. Run the four required
cases with the same final test file copied onto the original lane base.

For the latency comparison, use two exports: the original lane base and the
changed production source, both carrying the same final test file and the same
dependencies. Run this selected case in separate isolated processes, in order
base, changed, base, changed:

```sh
LLV_FRESH_ADMISSION_MEASURE=1 bun test --timeout=60000 src/lib/runtime/structuredDelivery.freshAdmission.test.ts -t 'synthetic admission to dispatch measurement'
```

Each invocation creates 20 fresh fixtures, one at a time. The general listing
is held until 50 ms after the enqueue acknowledgement on both revisions, and
both wait for the entire held general pass before ending each sample. Timing
starts after the real runtime handler commits the command and ends at entry
to the fake idle engine's `send`. This measures admission to dispatch for an
idle non-native recipient. The full file separately verifies native dispatch
without a preceding native sweep. Record all 40 samples per revision, batch
load averages, logical CPU count and cgroup limits. Quantiles use nearest rank.
This synthetic hold establishes the local effect of the removed dependency;
it supports no claim about production latency. The seat checks the existing
under-five-second free-recipient target after deployment.

## Recorded result

Production source and final test file: `11f30f85d`. Original base: `f41fdc45`.
The measurement completed on 2026-10-30 at 22:57 UTC. Raw samples, source
SHA-256 hashes, individual command exits and completion timestamps are in
[`fresh-admission.json`](fresh-admission.json).

The final focused file passed 14 tests with 281 assertions; the optional
measurement case was skipped in that invocation and passed in all four
measurement processes. Each of the four required cases passed alone. Reverting
the keyed dispatch call made each fail alone; the three recovery mutations
also failed their selected cases. The same final test file on the original
base failed all four required cases. Full tracked-source typecheck passed.
Normal commit hooks ran privacy and ESLint on every changed TypeScript file,
with zero introduced errors. No whole-directory suite or build was run.

Admission to dispatch, milliseconds; 40 samples per revision:

| Revision | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Original base | 56.584 | 62.356 | 74.317 |
| Keyed fresh pass | 8.555 | 25.865 | 44.044 |

Conditions: Bun 1.4.0 on Linux, 24 logical CPUs, an effective cgroup quota of
3 CPUs and a 14 GiB memory limit, one fixture at a time, the same dependencies
and 50 ms synthetic general-listing hold on both revisions. Start-of-batch OS
load averages ranged from 16.23 to 16.81 over one minute, 14.39 to 14.44 over
five minutes and 14.84 to 14.86 over fifteen minutes. End-of-batch observations
are retained in the raw record. These results establish removal of the local
wait under those conditions. Production acceptance remains with the seat after
deployment. This lane performed no deployment.

## Publication repair

The shared native contract gate found two failures in
`src/lib/runtime/structuredDelivery.integration.test.ts`: delayed successor
cleanup followed by path-only rollback delivery, and late discarded-successor
cleanup after a committed retarget. On the accepted revision `2e3f41c3`, the
tests awaited an unkeyed kick at lines 4290 and 4634. The general pass could
finish while the independent fresh recipient pass was still running, so their
engine-write assertions and journal teardown ran too early. Both original
tests failed on the accepted revision and passed on `f41fdc45` under the same
isolated conditions.

The repair makes those tests await their recipient's fresh pass. Their
path-only enqueue requests and every pre-existing assertion remain. Additional
checks bind the exact engine write and delivered journal receipt to the admitted
operation id, and verify the host projection after completion. The retarget
case also verifies that cleanup restored the committed projection before
admission, so admission cannot hide a cleanup failure.

Both the repaired head and the original production base, carrying the same
final test file, passed these outcomes:

| Case | Cleanup / republish | After the delivery pass |
| --- | --- | --- |
| Rollback with delayed publication | Source path restored after the delayed successor publication drains | Source session key and path retained; one matching source-host write; admitted operation delivered |
| Late discarded successor after retarget | Committed session key and path restored before admission | Same committed key and path retained; one matching committed-host write; admitted operation delivered |

Each full integration file passed 66 tests and 550 assertions. The two-case
selection passed 14 assertions on each variant, and each case passed alone on
the repaired head. The unchanged accepted tests still failed both cases as a
red control. The fresh-admission file passed 14 tests and 281 assertions, with
its optional benchmark skipped; tracked-source typecheck passed. Normal commit
hooks passed privacy and changed-file ESLint. Checks ran by explicit file path
through the gate wrapper with production isolation builders.

Delivery production code is unchanged by the repair. Its hashes and the
benchmark source still match the original measurement record. The comparison
inputs, asserted outcomes and command results are retained in
[`fresh-admission-publication-repair.json`](fresh-admission-publication-repair.json).

Main advanced to `7577ca6fa` with an unrelated task-status note change and was
merged by merge commit. On that combined tracked-source tree, both cleanup
contracts passed again with all 14 assertions, the inherited task-status file
passed 22 tests, and typecheck passed. The integration test hash is identical
to the base/head comparison. No hook was bypassed; publication remains with
the pipeline controller.
