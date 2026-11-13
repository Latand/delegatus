# Claude input evidence with admission contained

Send a decision and two follow-ups through the existing composer. This first
slice keeps the existing admission policy: seat follow-ups show their queued
state while Claude is busy. The existing single ordinary-operator join remains
bounded. Both follow-ups reaching the next tool boundary together is the next
slice's acceptance, described in `docs/design/claude-native-queued-send.md`.

For Claude Code 2.1.323, each newly written input now has a broker-owned UUID
persisted with its original operation, payload and writer/process binding before
stdin. A result that combines inputs settles their original receipts with one
stable turn owner. An early queued replay retains its evidence until the result
establishes that owner. An idle-origin input's exact replay can acknowledge its
already-established initial owner. A content match cannot acknowledge another
native input.

The broker keeps `supportsQueuedSend=false`. Its reserved `nativeQueuedSend`
request cannot activate multi-input admission in this slice. Missing and other
CLI versions retain the existing contained path. Native proof reading and the
write-intent fence remain active when adopting an existing native record, even
when the current CLI version cannot produce new native evidence. A historical
binary that does not understand these records is an unsupported downgrade.

## Reproduce in isolation

Use the installed CLI binary with the repository's native fixture. It obtains
the actual version through `--version`, starts a loopback Messages API on port 0,
and supplies synthetic responses and authentication. It copies no login state.
Run from a source export with the checkout's installed dependencies. Give each
command fresh `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` beneath the
stage scratch root; set `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1` and
`LLV_GATE_RUNNER=off`. Set `LLV_TEST_STARTUP_HOME` to the private `HOME`,
as the publication test consumer does. Bind `LLV_CLAUDE_BINARY` to the installed executable for
the native file. Run one file at a time:

```sh
bash "$GATE" bun test --timeout=60000 src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts
bash "$GATE" bun test --timeout=60000 src/lib/runtime/claudeStreamBrokerHost.test.ts
bash "$GATE" bun test --timeout=60000 src/lib/runtime/sendSettlement.test.ts
bash "$GATE" bun test --timeout=60000 src/lib/runtime/claudeMessageProvenance.test.ts
bash "$GATE" bun test --timeout=60000 src/lib/runtime/structuredDeliveryQueue.test.ts
bash "$GATE" bun test --timeout=60000 src/lib/runtime/structuredDeliveryQueue.progress.test.ts
bash "$GATE" bun test --timeout=60000 src/lib/runtime/structuredDelivery.integration.test.ts
bash "$GATE" bun test --timeout=60000 src/lib/runtime/structuredDeliveryRebind.test.ts
bash "$GATE" bun test --timeout=60000 src/lib/runtime/runtimeImageStore.test.ts
bash "$GATE" bun test --timeout=60000 src/lib/monitor/seatTickSources.test.ts
```

`GATE` names the installation's pinned, unmodified `scripts/gate-slot.sh`.
Long campaigns use its recorded execution and one terminal `wait_for_check`.
Each lifecycle file still runs through its own owned wrapper. Complete the
specified typecheck, changed-file lint, full-file publication privacy scan and
unmodified pre-push hook on the final commit. Checks run against scratch state;
no existing host, installation, provider or conversation is a fixture.

## Evidence and recovery contract

| Existing owner | First-slice behavior |
| --- | --- |
| `FileClaudeDeliveryLedger` | Existing queued/delivered records remain readable. Versioned native intents precede stdin; one fsynced result record carries the whole ordered batch. Cold loading and positive observers sync the same descriptor they read before acknowledging proof. Normal delivered markers retain existing image retirement for proven, closed inputs; the image collector replays the same proof and retains unknown versions or missing proof. |
| `ClaudeStreamBrokerHost.sendNative` | Reuses the production image/parts builder, preserves the original entry and UUID, rechecks authorization, process/writer, attention and boundary arrival after asynchronous persistence, and records proven zero-byte refusals before allowing retry. |
| `claudeNativeDelivery.ts` | Validates session, process, writer, UUID syntax, bounded unique ordered membership and original batch owner. Main-session result boundaries own turns; a replay leaves queued ownership unresolved. |
| `readClaudeTranscriptUsers` | Retains canonical UUID, session, prompt subject and validated `mergedSendUuids`; normalizes queued prompt attachments through the existing protocol reader. Tool results, summaries and other subjects cannot supply native prompt membership. |
| `confirmedSend.ts` | One typed reader joins native proof to the original generation, content digest and bound batch members. The boolean compatibility projection supports arrival observers. Receipt settlement retains the typed turn owner. |
| Queue, controller, send settlement and wake observer | Pass that owner through the existing journal transition and confirmed-delivery arbitration. Explicit discard and migration cancellation retain their existing fences. A missing journal cannot manufacture native receipt settlement. |
| Message provenance | The original ledger retains member authorship, image ranges and selected context. Validated merged metadata identifies its original native inputs. A result-only proof grants no exclusive canonical UUID to several entries. |

Unknown evidence versions, conflicting membership, an unresolved write intent,
partial stdin failure or missing exact proof keep the original input fenced.
Malformed merged identity also excludes a row from legacy text inference in both
transcript adoption and original-key receipt reconciliation.
They authorize no duplicate stdin write. A proven no-write outcome permits the
same input UUID to survive a writer replacement; an uncertain outcome does not.
Errors and interruption record an observed terminal boundary without
blanket-confirming all attempted inputs. Exact consumed evidence remains
separate. New native writes stop when input evidence becomes uncertain.

The event store is still the projection owner. Proof is durable before its
terminal event is published. Adoption restores a missing terminal event once;
reopening an already-projected boundary adds no event and writes no input.
Images stay referenced in the original ledger entries during uncertainty.
Closed and zero-byte entries release their in-memory payload; original payloads
remain in the ledger. A deadline ends the caller's wait while the actual append
retains its serialized lane. Controls bypass that lane, and queued stream data
has a byte bound. An expired, unstarted dispatch performs no actuation.

After a verified terminal boundary, new unwritten inputs may proceed from idle;
previous attempted inputs remain unconfirmed and cannot be replayed. An
unresolved intent or a protocol inconsistency keeps the stronger fence.
The change makes no performance claim.

## Parallel integration and remaining acceptance

This branch merges #3934's ordered-delivery verification and extends its native
fixture and receipt path. It introduces no replacement queue or receipt store.

#3975 was re-read at `5cfc6042187b8e58ba9c248a18fa9b06fffc145e`. It requires joint integration at these method boundaries:

- Initialize its turn timestamps and prompt anchor in both the legacy send path
  and `sendNative`; retain the stable batch owner.
- Set its `agentStateDeliveredNativePromptId` from the verified native boundary.
  Derive its successor anchor in `finishResultTurn` from the next unresolved
  batch. A later replay cannot replace the incumbent anchor.
- Its `reconcileAgentStateTerminal` must require owned native boundary evidence
  when native inputs are outstanding. A singular synthetic result supplies no
  such evidence. Delivery settlement still requires its independent input proof.
- Preserve `settleClaudeWorkBeforeDemotion` and `releaseClaudeHostForDemotion`,
  including their foreground/background custody, terminal-event wait, artifact
  identity and writer/turn CAS. The controller
  changes here are confined to typed receipt confirmation and queue wiring.

The next slice enables verified native admission, two pending writes, active
seat composition and the narrower in-flight barrier. It must prove the full
operator decision/two-message case during a held tool, both arrival passes,
Viewer/host restart cuts and the joint #3975 path. The feed projection of merged
canonical rows belongs with that admission, using the retained original member
provenance; it must add no whole-transcript scan to the feed request path.
Rendered queued, uncertain and delivered acceptance in both languages and themes also belongs to that slice.
This first slice leaves the originating mid-turn admission task open.

## Initial regression evidence

Before implementation, the new original-receipt and combined-replay cases failed:
exit 1, 0 pass, 2 fail, 1 assertion. The first complete native-file run after
implementation reported exit 1, 27 pass, 1 fail, 410 assertions. Its new busy-case
fixture read the ledger immediately after receiving a raw result, before the
asynchronous proof was durable; the fixture now waits for durable proof. The
initial receipt and combined-replay regressions passed in that run. Failed logs
remain retained alongside the final verification ledger.

## Verification ledger

All commands below use the isolated source export and the pinned wrapper above;
each test file has its own owned runner. The retained command ledger includes
failed runs, their actual exits, assertion counts and terminal cleanup receipts.
The initial installed-CLI file contained twenty loopback CLI cases and thirty
protocol, durable-reader and recovery controls.

The source campaign before the final mixed-record guard was:

| Command after the wrapper | Exit | Pass / fail | Assertions |
| --- | ---: | ---: | ---: |
| `bunx tsc --noEmit` | 0 | zero diagnostics | — |
| `bunx eslint` with the 14 changed TypeScript paths | 0 | zero diagnostics | — |
| `bun test --timeout=60000 src/lib/runtime/claudeStreamBrokerHost.test.ts` | 0 | 208 / 0 | 3560 |
| `bun test --timeout=60000 src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts` | 0 | 50 / 0 | 743 |
| `bun test --timeout=60000 src/lib/runtime/sendSettlement.test.ts` | 0 | 152 / 0 | 1280 |
| `bun test --timeout=60000 src/lib/runtime/runtimeImageStore.test.ts` | 0 | 43 / 0 | 143 |
| `bun test --timeout=60000 src/lib/runtime/structuredDeliveryQueue.test.ts` | 0 | 201 / 0 | 593 |
| `bun test --timeout=60000 src/lib/runtime/structuredDelivery.integration.test.ts` | 0 | 80 / 0 | 712 |
| `bun test --timeout=60000 src/lib/monitor/seatTickSources.test.ts` | 0 | 167 / 0 | 1056 |
| `bun test --timeout=60000 src/lib/runtime/claudeMessageProvenance.test.ts` | 1 | 15 / 2 | 35 |
| `bun test --timeout=60000 src/lib/runtime/structuredDeliveryRebind.test.ts` | 1 | 24 / 3 | 152 |

The two red files were repeated with identical isolation on baseline
`4931ed1da00ca71aa3dba8ca939c7cc662bcc27e` and again on
`6eaa47de1e`: provenance exits 1 with 14 pass, 2 fail and 25 assertions;
rebind exits 1 with 24 pass, 3 fail and 152 assertions. Their same named failures
are pre-existing: custom mandate classification in active/history provenance;
startup interruption-obligation import busy; watchdog startup versus awaiting-host;
and startup projection writer acquisition. They are retained as baseline notes.
No change to those unrelated behaviors is included here.

Earlier campaigns also retained these unsuccessful outcomes: typecheck exit 2
with three diagnostics, then exit 2 with one fixture MIME diagnostic; native
45/3 and 49/1; broker 205/1 in two diagnostic runs; settlement 150/2 and 151/1.
The repaired fixtures await the projected terminal boundary, clone immutable
registry snapshots before hostile mutations and retain a literal image MIME.
The broker recovery diagnostic led to restoring uncertainty refresh after exact
late proof. A staged whitespace check initially exited 2 for an extra EOF blank
line; its corrected rerun exited 0 with zero diagnostics.

The final unmodified pre-push hook must run once on the resulting implementation
commit. Its final-commit verdict and publication status are recorded in the stage
handover rather than embedded into a self-referencing commit.

After the final mixed-record guard and the main hotfix merge, the renewed
commands completed as follows:

| Command after the wrapper | Exit | Pass / fail | Assertions |
| --- | ---: | ---: | ---: |
| `bun test --timeout=60000 src/lib/runtime/claudeStreamBrokerHost.test.ts` | 0 | 208 / 0 | 3560 |
| `bun test --timeout=60000 src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts` | 0 | 50 / 0 | 743 |
| `bun test --timeout=60000 src/lib/runtime/sendSettlement.test.ts` | 0 | 152 / 0 | 1282 |
| `bun test --timeout=60000 src/lib/runtime/structuredDeliveryQueue.progress.test.ts` | 0 | 38 / 0 | 301 |
| `bun test --timeout=60000 src/lib/monitor/seatTickSources.test.ts` | 0 | 167 / 0 | 1056 |

The final-commit hook also renews types, lint and its normal scoped checks.
Main was refreshed and merged through `dd8686ee44`; #3934 and #3975 remained
open at the heads recorded above. The source changes make no admission claim.

The first full-file privacy run exited 1: synthetic UUID literals in five test
files and the object label for the computed prompt field matched generic
resource/transcript detectors. The fixtures now build the same fixed UUID bytes
from their components, and the reader computes the prompt field before its
object. No publication rule or detector was changed.

The first implementation hook exited 0, with zero new failures and 23
pre-existing failures in its broader comparator. Its canonical environment
dropped the undeclared CLI opt-in. To include the installed CLI cases in the
final hook, explicitly name `LLV_CLAUDE_BINARY` in `LLV_GATE_CHECK_ENV`; name
`LLV_EVIDENCE_DIR` and `LLV_NATIVE_EVIDENCE_RUN` there to retain its native frames.
The hook stays unmodified. These declared inputs are part of its check key.
Its CLI integration helpers still see private empty credential directories,
while the native queue fixture supplies its own loopback API and synthetic
authentication. The final handover verifies that the native evidence files
were actually produced, alongside the hook exit.

## Close and pending proof

Native stream closure retains the foreground owner while already captured
frames drain through bounded persistence. Receipt proof keeps the original pipe
and process binding after exit; new dispatch and controls require a live process.
Writer-claim fencing applies to both. Bytes received after the pipe closes
supply no evidence. Release joins this drain before final cleanup.

Two initial close/persistence regressions exited 1: 0 pass, 2 fail, 4 assertions
and 208 filtered tests. They failed before the proof writer was reached. The
first repaired control run exited 0: 4 pass, 0 fail, 38 assertions and 208
filtered tests. The full file also covers process exit while the pipe remains
live, post-close replay rejection, lost writer ownership and successor replay
with zero additional writes. The final source campaign and hook renew these
checks after this lifecycle change.

## Evidence-slice review regressions

Run the existing native queue file with the installed binary and isolated
directories as above. The `native-evidence-review-omitted` and
`native-evidence-review-invalid` cases alter only terminal membership from
real CLI frames. They require the incumbent's terminal event, subsequent
ordered delivery exactly once, and the original journal receipts. The
`native-evidence-review-legacy` case restores an old queued row with an
explicit idle fence, then verifies its original receipt after CLI adoption.

A top-level terminal frame bound to the current writer, session and singular
incumbent input can now record `native-turn-boundary`. This record closes the
turn independently of delivery membership. It confirms no input. Missing
echoes retain their original uncertainty and write fences; already-written
followers with unknown membership prevent new input writes. Unwritten queued
operations may progress after a proven safe boundary. Restoring the ledger
replays this terminal event under its original result UUID. An exact late
incumbent replay may still settle its original receipt without closing a
subsequent turn.

The file ledger's native working index retires closed and proven no-write
entries. Active intent allocation is limited to three inputs. An 8 KiB
negative lookup filter per cached conversation avoids retaining historical
payloads or proofs; a possible historical match reads the authoritative
ledger asynchronously. The cache retains at most eight conversations. Filter
matches confer no receipt or write authority. The 128-batch regression checks
retirement, old operation/result replay, conflicting identity refusal and
recovery in a new process. No performance improvement is claimed.

These changes retain `supportsQueuedSend=false`. Enabling native admission,
the complete Viewer restart matrix, rendered fallback and integration with
the agent-state lane remain the second slice of
`docs/design/claude-native-queued-send.md`.
