On the starting main revision `223b57148`, an isolated reproduction with
Claude Code 2.1.302 and Codex 0.166.0 expired an accepted follow-up while its
recipient was still working. The real CLIs ran behind the production structured
hosts, controller, admission handlers, runtime socket, SQLite journal and
registry. Credential-free local model providers held the incumbent responses
open. A frozen application clock advanced the turn age; these were simulated
31- and 91-minute turns, with no corresponding wall-clock wait.

| Observation on main | What it establishes |
| --- | --- |
| With the lagging checkpoint, both CLI recurrence cases fail at 31 minutes: the receipt becomes `failed`. | Admission age can fence a follow-up before its recipient's boundary. |
| Host health reports an active turn while the fixture's registry checkpoint remains idle. | Settlement trusts a checkpoint that can disagree with the real host. This fixture deliberately omits the independent checkpoint binding; it does not establish why a particular production checkpoint lagged. |
| Claude takes an unexpired follow-up after its incumbent response finishes. | The next boundary works while the original operation remains actionable. The queue deliberately retains Claude inputs until idle to preserve one canonical receipt per input. |
| Codex receives exactly one `turn/steer` RPC before the incumbent response is completed. | This host can hand steering to the engine during an active turn. The model sees it at the engine's subsequent processing boundary. |
| The safety observer labels an overdue event wait as `wake-lost`. | That phase alone cannot establish a lost engine input. Its due time was a safety-pass deadline. A deterministic queue recurrence covers the classification. |

Main's ordinary deadline is ten minutes after admission. A registry checkpoint
that declares an active turn extends it to sixty minutes after admission.
Neither admission-based cutoff describes the end of a longer live turn. The
incident's `settlement-window` is consistent with settlement seeing no active
turn in its checkpoint; this reproduction does not identify the particular
production checkpoint failure.

The reproduction proves the delivery defect under a lagging checkpoint and
shows why fencing that operation prevents the later boundary from consuming it.
It does not prove that Claude supports a separate mid-tool steering control.
The broker declares no such control, and ordinary sends preserve the incumbent
tool use. No performance improvement is claimed.

Issue #3637's phase-measurement diff was read before changing the overlapping
queue, controller and progress files. Its instrumentation remains separate.
This work uses the existing admission, phase history, journal and canonical
engine-echo evidence; it adds no competing timing observer.

The queue renews a persisted `turn-boundary` deadline after observing a running
recipient. Settlement independently reads the registered host, or the keyed
runtime session under a matching live writer and generation, before fencing an
aged send. Fresh running-turn evidence keeps the original operation pending
for any turn duration. Its renewed window also gives the queue time to act
after that turn ends, including across a process restart. A delayed ordinary
checkpoint cannot shorten that window. Explicit workflow cutoffs retain their
authority. Unavailable evidence retains the existing bounded settlement and
resend guidance.

A host state change wakes delivery independently of status publication. The
drain still checks its writer, generation, receipt and controls before engine
actuation. Repeated safety observations of an event wait retain `awaiting-turn`.
The existing journal fence, native operation identity and engine echo still own
exactly-once delivery; this work introduces no automatic resend of a failed
original operation.

Terminal failures create durable sender obligations from the admitted
`MessageOrigin`. Sender identity is never recovered from message text. A seat
receives an actionable monitor item, and the sender receives a delivery notice
through the ordinary message path. Notice text and key are persisted before
dispatch. Recovery looks up that original key, accepts a matching terminal
receipt, and never resends a fenced notice. Missing recipients and terminal
notice failures remain visible to the seat. The operator's existing composer
continues to show the original terminal receipt. The MCP acceptance answer
explicitly reports `deliveryConfirmed: false` until arrival is confirmed.

The shared paths are:

| Record | Producers and defaults | Consumers and recovery |
| --- | --- | --- |
| Send policy and origin | MCP sends, composer admission, held-delivery replay and native admissions retain their existing policy/default and server-attributed origin. | Queue dispatch, native hosts, recipient evidence and receipt settlement keep the same operation identity and fence. |
| Progress deadline | Admission and recovery use the ordinary deadline; a live queue observation and settlement can renew `turn-boundary`. | The progress store persists the added policy without a schema migration. Receipt readers can read it without owning the store. Existing deadline displays accept it. Explicit cutoffs are checked separately. |
| Failure obligation | Queue terminal projection, receipt settlement and terminal backfill insert once per operation. The Viewer initializes the additive state collection under its release ownership. | A bounded asynchronous sweep dispatches stable notice keys independently of slow settlements; seat signals read pending or failed obligations. The decoder accepts every stored state. Settled records are pruned after fourteen days, one bounded page per sweep. |

Checks use a scratch export with the consumer's frozen dependency install.
Each explicit test file receives fresh HOME, config, temp and state roots and a
closed Viewer control endpoint through `checkEnvironment`,
`createGateSandbox` and `isolatedEnvironment`.

Notice-key recovery uses the registry's bounded message-key index. Canonical
arrivals retire pending or failed alarms without replaying either input.

The native recurrence is `src/lib/runtime/deliveryLongTurn.native.test.ts`.
Enable both engines with `LLV_NATIVE_LONG_TURN_TEST=1` and explicit
`LLV_NATIVE_CLAUDE_BINARY` / `LLV_NATIVE_CODEX_BINARY` executable paths. The
existing native runtime gate also runs the Codex cases for its pinned executable
through `NATIVE_CODEX_QUEUE_TEST_BINARY`.

Verification results are recorded in the stage report after the final checks.
