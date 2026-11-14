# Finished agents stay idle after completion-notice delivery uncertainty

For a spawned child with launcher notifications enabled, finish one turn while
the launcher is busy. If its completion notice cannot be confirmed, inspect
that notice's delivery receipt and pending completion-notice obligation. The
child must remain idle. A deliberate `send_message` still warns its sender
when arrival is uncertain.

## Cause

`spawn_agent` records the launcher and enables notifications by default.
`recordSpawnTurnEnded` in `src/lib/runtime/serverConsumers.ts` records one
completion-notice obligation per child turn. The sweep in
`src/lib/spawnNotice/sweep.ts` assigns a stable key from
`seatMessageKeys.spawn`; `src/lib/spawnNotice/production.ts` supplies the child
as the admitted author and delivers to the launcher with `steer-or-queue`.

An unverified host answer terminalizes that send as uncertain in
`src/lib/runtime/structuredDeliveryQueue.ts`. Controller settlement, receipt
resolution and settlement mirrors call `recordSendFailureNotice` in
`src/lib/runtime/sendFailureNotice.ts`. Previously, its admitted sender check
also accepted automatic completion notices. The resulting delivery warning
went back to the finished child through `sweepSendFailureNotices` as a normal
send with delivery authorship. An idle structured host starts a turn for such
a user message. Its end produces another completion notice with a new key.
Per-notice coalescing and retry limits cannot bound a chain of new turn keys.

The feedback edge became possible in `3dc80bb538` (#3667, 2026-11-05), which
added sender failure notices and their settlement hooks. Completion notices
already existed in `815fd5f4ef`. The busy Claude native delivery path was added
in `c1fe831963` (#3993, 2026-11-14).

Pipeline stages and designated seats have container membership. The
`recordSpawnTurnEnded` membership guard excludes them from these automatic
completion notices, including ordinary seat-to-seat relays. A separate,
uncontained child spawned by a seat was exposed.

## Change

The sender-warning writer excludes the automatic completion-notice namespace
using the original operation owner's durable `clientMessageId`. The existing
bounded warning sweep also cancels pending or failed automatic sender alarms
persisted by an older version before resolving a recipient or sending input.
It preserves their original reason and text.

The controller's existing pre-actuation fence also checks an already-admitted
warning by its exact message key, admitted delivery authorship and recipient.
An indexed alarm lookup resolves the original automatic notice before the
startup queue can send, even when the bounded sweep has not reached that alarm.
Cancellation persists this suppression; retention keeps it while the admitted
warning lacks a terminal delivery projection. Already-actuated warnings still
use the queue's existing reconciliation and uncertainty rules.

Child authorship and the original delivery record remain intact. Uncertain
completion notices retain their reason and existing same-key reconciliation;
late confirmation settles the original notice without another input write.
A genuinely lost notice remains surfaced as a failed completion obligation
and failed delivery receipt. Deliberate MCP sends retain sender warnings.
One detail follows the current code rather than the diagnostic shorthand:
receipt settlement can normalize the host's timeout detail to the existing
`SEND_UNVERIFIED_REASON`. The retained delivery reason and same-key behavior
remain intact; this change does not promise verbatim host error text.

The shared write path is `recordSendFailureNotice`, called by the structured
delivery controller, the wait reader in `recordWait.ts`, and receipt resolution
and settlement mirrors in `sendSettlement.ts`. All read the admitted operation owner; no caller-supplied
message text chooses the exemption. The namespace producer is
`spawnNoticeMessageId`, shared with the seat channel through
`src/lib/orchestrator/seatDeliveryKeys.ts`. Existing warning records contain
the original operation ID, allowing the sweep to consult the same durable
owner without a schema change. The sweep retains its 32-record dispatch page
and existing retry/deadline behavior. No timer or polling loop is added.
No performance gain is claimed.

The warning's producer is the existing alarm sweep, and its consumers are the
structured controller's normal send and grouped-send settlement fences. Native
queue commands retain their existing handling. The optional suppression field
defaults to absent for older rows; the decoder accepts both writer versions.
The alarm writer, sweep, cancellation and retention keep the same collection
and message key. The new SQLite index uses syntax supported by SQLite 3.39.

## Tests

The regression and controls are in `src/lib/runtime/sendSettlement.test.ts`.
They use real completion-notice stores and sweeps, registry reservations,
delivery queue, runtime journal and settlement, with fake engine hosts:

- A busy launcher receives the report but loses confirmation. Repeated
  delivery and notice passes must produce exactly one completion notice and
  zero new child turns. Late receipt evidence reconciles the original key.
- A deliberate uncertain send still starts exactly one sender-warning turn.
- A fresh process retires both pending and failed automatic sender alarms
  created from real persisted warning records, retaining their reasons. The
  admitted-warning cases drain real journal effects before the sweep, after
  cancellation, and beyond the normal alarm-retention window. No child turn
  starts, and the journal retains a terminal warning receipt.
- A notice that never reaches its recipient becomes a visible failed
  completion obligation and delivery receipt without waking the child.

`src/lib/spawnNotice/sweep.test.ts` also covers contained children, opt-out,
same-key retries, coalescing, and terminal completion-notice failures.
`src/lib/state/sqliteStateStore.bounded.test.ts` verifies the exact warning-key
index lookup, existing-store upgrade, missing and hostile keys, and its query
plan through retained history.
All checks run in scratch exports with private `HOME`, `XDG_CONFIG_HOME`,
`TMPDIR`, `LLV_STATE_DIR`, and a closed-loopback `LLV_VIEWER_CONTROL_URL`,
through the repository gate wrapper. These exercise Viewer delivery and
settlement components and the journal as a library; they do not start the
production runtime-host listener. No runtime-host source or runtime pin changes.

## False uncertainty: established mechanism and separate repair

The preceding isolated diagnosis reproduced the following mechanism on pinned
main and on #4032 at `3c5b1c484376`: a native input written during an active
Claude turn has disposition `queued-next-turn`. Its exact replay persists
consumption with `nativeConsumed.turnId = null`. In
`src/lib/runtime/claudeStreamBrokerHost.ts`, the replay handler resolves a
pending delivery only when that evidence names a turn. A follower therefore
awaits its owning result even though its input has arrived. Meanwhile, the
confirmation timer starts immediately after the input write; its default
budget is 30 seconds. A sufficiently long incumbent turn can outlast it.
The isolated probe used a 300 ms budget and later reconciled a combined result
without another input write.

The current source and #4032 diff corroborate that distinction. #4032 restores
native admission for an idle-origin input's late replay and adjusts receipt
readers. Its change does not assign a turn ID to the busy follower replay or
defer that follower's confirmation timer, so the reproduced condition remains.
This evidence is handed to the separate broker/receipt repair lane associated
with #4032; the remaining busy-follower confirmation fix belongs there. This
change leaves the broker's admission and receipt paths untouched.

The original incident's exact native frames and the production frequency of
this condition remain unestablished. The evidence demonstrates a reproducible
explanation for arrival preceding confirmation timeout; it does not prove
that every observed timeout used this branch.
