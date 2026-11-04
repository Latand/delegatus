# Owner relay store contention

An owner request keeps its execution and answer while local relay persistence
waits for a busy store. Owner custody writes allow 60 seconds of asynchronous
lock acquisition. Admission retains the service request's absolute deadline.
A service lease lost during execution moves the answer to the existing durable,
keyed owner delivery path. It does not start another agent. Service tools still
close when their lease is lost, and delivery still checks current owner authority.

## Incident observation

Read the local journal for 2026-11-04 06:27–06:41 UTC with `journalctl`, filtering
binary-marked records with `grep -a`. The serving source was `3c617726`.
The retained request ledger was inspected read-only, selecting its lifecycle
fields rather than its message content or destination.

| UTC | Primary observation |
| --- | --- |
| 06:28:13.443 | Request execution reservation started. |
| 06:28:54.749 | Owner cancellation cutoff; the journal reports an exception containing `RelayStoreBusy`. |
| 06:28:57 onward | Stop remains pending and retains custody; subsequent attempts back off. |
| 06:37:59 | Last acknowledged service heartbeat, HTTP 200. |
| 06:38:03.993553 | Persisted service request deadline. |
| 06:38:08 | Heartbeat receives HTTP 409, `lease_lost`. |
| 06:39:56.216 | Stop is quarantined with `stop_unconfirmed`; reservation released, failure diagnostic retained. |

The busy exception preceded lease loss by over nine minutes. Heartbeat HTTP
traffic has a separate helper and does not renew a local file-store lease
(`src/lib/externalRelay/relayLeaseTransport.ts`, `InlineRelayLeaseTransport.beat`).
Its later rejection is not evidence that a local heartbeat-store write timed out.
The rejection arrived about four seconds after the fixed service deadline,
following successful renewals throughout the pending stop. This supports service
window expiry as the cause of that rejection.

The typed exception comes from asynchronous file-lock acquisition
(`src/lib/externalRelay/store.ts`, `withFileLockAsync`). The synchronous lock at
the old line 287 throws an ordinary `Error`. The answer record has chain metadata
but no bound conversation, while local launch custody knows the conversation.
`onConversation` therefore failed before `recorder.bindConversation`, at one of
its two asynchronous persistence operations: launch attribution in the run ledger
or chain attribution. At the serving revision these are `runner.ts:929` and
`runner.ts:936`, each with a 5,000 ms deadline. The journal stores no stack or
operation label to distinguish the two. The later admission-confirmation write
at `ownerRun.ts:926` follows this callback and was not reached. The known
conversation, `cancel=kill` and missing first-message proof support the inference
that launch custody failed before successful prompt delivery. The retained
ledger's later `admissionComplete=true` is also written by cancellation.

The owner-run exception handler diagnosed the error and entered stop recovery
(`ownerRun.ts`, `runOwnerAgent`). The ten-minute stop-pending limit then permitted
quarantine (`confirmOwnerStop`, `releaseOwnerStop`). Independently, the runner's
heartbeat failure handler cancelled execution and returned no answer on lease
loss. `ownerFailureAnswer` interpolated the internal diagnostic into the chat
reply. All three mechanisms needed attention.

## Regression procedure

Run each pre-push touched file separately through `scripts/gate-slot.sh`, using
`checkEnvironment` and `isolatedEnvironment(createGateSandbox(), env)` from the
local gate. Keep source exports separate from the checkout and state roots
outside the installation. No live store is used by a test.

`src/lib/externalRelay/runner.contention.test.ts` holds the real ledger lock for
6,100 ms of controlled request time under a live process identity during
launch/renewal, stop confirmation and answer persistence. It requires continuing
heartbeat acknowledgements, one execution, one delivered answer or localized failure, and no leaked internal
exception text. A fourth case loses the service lease during execution, delivers
one keyed answer, then replays the same request in a fresh process without
another send. The four cases fail against the starting main source.

Existing runner cases retain diagnostic, revocation, stop custody, attachment
and receipt checks. Their reply expectations now require short human copy;
diagnostic reasons remain asserted in records and journals.

This change makes no performance claim. It increases tolerance for contention
and removes synchronous waiting from stop confirmation. It changes no runtime
pin or runtime-host input. Hosted tracker audit and runtime check contexts are
observed by publication after the pipeline creates its pull request.

## Added acceptance items 4 and 5: prompt envelope and failure replies

The 07:31 UTC incident was inspected through the journal and read-only JSON
records under the external-relay state directory. The earlier request started
at 07:25:29.153 and finished at 07:29:04.876. Its reply started at 07:31:01.927.
Both records name the same native agent conversation. The latter explicitly
records `chain.continued=true` and `promptBytes=55601`; its direct parent is a
bot answer containing 3,190 UTF-8 bytes, and the new message contains 30 bytes.
The matching chain has the same requester, owner-tier authority and Claude
engine. Its anchors include the earlier request, bot answer and new reply.
This proves chain resolution succeeded. The chain's broken state follows the
413 continuation refusal at 07:31:08; it did not cause a fresh launch.

Static context changed between those requests: `owner_instructions` grew from
5,526 to 14,964 JSON bytes. The continuation refreshed the static sections
alongside unseen context and exceeded the receiver's 32,000-byte text bound.
No chain resolver or live record was changed during this investigation.

Structured owner prompt builders now measure the fully composed, escaped UTF-8 text against
`MAX_STRUCTURED_TEXT_BYTES`. They shorten optional quoted history and remove
the oldest context first, then reduce optional memory, documents and service
context. The current message and its direct parent remain whole. Oversized
mandatory content is refused before dispatch. Cursors acknowledge only complete
retained messages; shortened quotations stay eligible for a later direct reply.
An accepted answer is recorded with its native conversation and text hash.
Only a matching bot answer in that same conversation is omitted on continuation,
which sends the new message without re-quoting it. A replaced conversation or
edited answer retains its full direct reply context; fresh conversation reset
clears the witness. Existing records without a witness retain their context.

The regression exercises a long answer with sources followed by a short owner
reply: one launch, one continuation in the same conversation, and only the new
message in that continuation. Additional tests cover escaped Unicode, every
structured owner prompt builder, quote caps, retained cursors, oversized mandatory input, and one
short localized failure without dispatch. All runtime exceptions keep their
diagnostic in the journal and answer record; chat failure replies contain only
the human line, including envelope failures and store contention.

The separate legacy CLI tool-loop result budget remains 64 KiB. The 32,000-byte
guard applies to structured owner launches and continuations at their actual
receiver boundary; this change does not reduce that CLI protocol's data budget.

## Resumed-stage verification

The incident window was read again through the user service journal on
2026-11-04, with `--utc` and `grep -a`. This confirmed the first busy exception
at 06:28:54, the 409 at 06:38:08 and quarantine at 06:39:56. The serving revision's
two attribution deadlines are `src/lib/externalRelay/runner.ts:929` and
`src/lib/externalRelay/runner.ts:936`; the asynchronous lock throws at
`src/lib/externalRelay/store.ts:316` and `src/lib/externalRelay/store.ts:339`.
The original journal cannot distinguish the two attribution writes.

The seven incident regressions were rerun in separate source exports under
`scripts/gate-slot.sh bun test --timeout=60000` with explicit file paths and
fresh gate isolation. All seven passed with the fix, and all seven failed on
starting main `a8d0fe23` with the same regression file. Conversation, prompt,
late-delivery and store checks passed individually. The conversation restart
case also checks that the production writer's accepted-answer witness survives
the real reader in a new process. No test used the installation's state.

| Touched test file under `src/lib/externalRelay/` | Final result |
| --- | --- |
| `runner.contention.test.ts` | 7 pass; 7 fail on starting main. |
| `conversations.test.ts` | 29 pass, including the added restart assertion. |
| `prompt.test.ts` | 16 pass. |
| `ownerLateDelivery.test.ts` | 26 pass. |
| `store.test.ts` | 11 pass. |
| `runner.test.ts` | 320 pass, 4 skip, 5 pre-existing prompt-hash failures. |

Only the five failing runner cases were sampled on starting main, in isolation.
All five failed there with identical expected and actual values: all 102 diff
lines match the branch sample. Current `origin/main` was refreshed after the
checks; its relay source files have no changes from starting main.

The final typecheck (`bunx tsc --noEmit`), publication privacy scan with required
fingerprints and commit inspection, and changed-file ESLint check passed. The
compiler correction keeps the completion receipt in shared state for both claim
settlement and final chain attribution; all seven incident regressions passed
again afterward. Publication owns the pre-push hook and hosted tracker/runtime
contexts. The required critical-relay reviews remain with the pipeline.
