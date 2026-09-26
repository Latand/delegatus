# ADR 0002 — A seat's deputy speaks as its seat

- Status: accepted
- Date: 2026-09-26
- Design: `docs/design/ghost-seat.md` §4 (rules 1 to 4), slice 1

## Context

The operator asked for a side ask to be answered while the orchestrator seat is
busy, by "the orchestrator's parallel self": a fork of the seat's conversation,
with all of the seat's permissions, that does one job and disappears. Every
session already holds the whole Delegatus MCP surface, so what "the seat's
permissions" changes is the attribution label: whether a report reaches the
project's Telegram chat in the orchestrator's shape, whether a directive to the
seat is a self-relay, which project a tick setting resolves to, and who owns a
lane it creates.

The label is decided from durable designation records alone
(`authorizedManagerSeats`), and exactly one conversation per project can hold it.
Giving a second conversation that label is the one hard-to-reverse decision in
the design: from then on, a conversation that is not the seat can speak as the
seat.

## Decision

**A live deputy of the seat is attributed as the seat.** `callerAttributionFrom`
labels a caller that `deputyPrincipal` maps to a seat as `manager`, with
`conversationId` set to the seat's id and `via: { deputy: <its own id> }`. Every
surface that reads the label then treats the deputy as the seat with no change
of its own.

Four rules travel with it and are not separable from it:

1. **A deputy is never a seat.** The seats file, the seat epoch and
   `authorizedManagerSeats` are untouched. The deputy's record lives in its own
   file beside the seats file (`state/orchestrator-deputies.json`). The seats
   reader refuses a schema it does not know, so a version bump there would make
   an older build read every seat as absent; a separate file costs a rollback
   nothing. `deputyPrincipal` answers only while the record is live (not ended,
   before its 15-minute expiry) and its seat is still the project's active seat
   **at the same epoch**, with no revocation at or above that epoch. A rotation
   always mints a newer epoch, so every deputy of the old one loses its
   authority at once.
2. **Attribution keeps both ids.** The seat's id is what surfaces act on; the
   deputy's own id rides in `via.deputy`, and every durable row keeps it (the
   report's `origin`, the tick settings' `setBy`, a pause or resume actor, a
   dismissal's `by`), so nothing it did is unattributable.
3. **What it creates is the seat's.** A lane created with the deputy's own
   transcript as `src` records the seat as `srcConversationId`, so the seat can
   answer the lane's decisions after the deputy is gone, and the deputy as
   `srcDeputyConversationId`.
4. **Only the operator and the voice gateway start one.** Starting a deputy
   hands out the seat's authority, so the ghost route refuses every other
   caller, and the gateway's ask stays an agent's message.
5. **Two things it may not do.** `deploy_exact_sha` is refused with
   `deputy_cannot_deploy`, and `rotate_orchestrator` (and the rotation route
   itself) with `deputy_cannot_rotate`: the one gated operation and the one
   identity change are not for a five-minute self.

## Consequences

- With no deputy records every path is byte-identical to before: the branch in
  attribution is reached only for a conversation a record names.
- A deputy that misreads the seat's work is bounded by the note it starts with,
  by the revision every task and pipeline write carries, and by the note the
  seat receives when it ends.
- Reverting the decision is deleting the deputy file: every deputy is then an
  ordinary agent, and the seat is exactly what it was.
