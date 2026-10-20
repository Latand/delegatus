# Prototype Telegram destination attribution

## Incident: 2026-10-20

Read-only investigation on 2026-10-20, after merging `origin/main` at
`41cf07a04`. The investigation copied the installation's state database and
its WAL, relay JSON files, and user service journal into stage scratch before
querying them. It initialized no application store against live state and sent
no Telegram message.

The journal commands used `journalctl --user`, first scoped to
`delegatus.service`, then across the user journal, with the inclusive search
window 11:50–12:10 UTC. Searches used `grep -a` on the copies. The journal
contains the resend invocation at 12:00:36 UTC, but no destination selection
snapshot, `answered_by`, or `no_target` diagnostic in this window. Performance
telemetry naming relay operations does not contain their target settings.

Review timestamps below come from copied `state_rows` records in `tasks` and
`seat-decisions`. The original publication response in the publishing stage's
transcript preserves the initial post outcome, which the resend subsequently
replaced in the task record.

| Caller and operation | UTC timestamp | Stored outcome |
| --- | --- | --- |
| Seat form without a task | 11:42:17.826 | sent |
| Stage review created | 11:56:38.908 | publication created |
| Stage review initial Telegram attempt | 11:56:48.440 | failed / no_target |
| Seat resend of that stage review | 12:00:36.675 | failed / no_target |
| Seat form without a task | 12:09:04.316 | failed / no_target |
| Seat form without a task | 13:24:04.206 | sent |
| Seat form with a task | 15:07:02.890 | sent |

The relay JSON snapshot copied at 15:42:23.178 UTC has an unpaused pairing with
three enabled targets: two
answered by the service and one configured owner-tier target answered by this
installation. Settings at the failed attempts remain unknown.
The request, conversation and run ledgers retain execution history, without
the historical `enabled` / `answered_by` target lists. Relay settings writes
replace `external-relay/relays.json` (`src/lib/externalRelay/store.ts`,
`updateRelayStore`); the retained SQLite backups do not archive this file.

**Attribution limit:** the exact failed condition cannot be recovered. At each
failure, `no_target` means the selector found a matching unpaused pairing but
no enabled target answered by this installation. An empty list, disabled
targets, and service-owned targets all produced that same code. The missing
evidence is the target list at each selection, or a timestamped history of its
changes. The reported morning group-binding recreation therefore cannot be
established as the cause. The 12:09 seat failure also rules out treating caller
kind alone as an explanation of this incident.

## Shared path and durable diagnostics

Publication and resend both call `postPrototypeReviewToTelegram`, then
`TelegramBotService.sendOwnerReview`. Each attempt calls
`ownerReviewDestination`, which reads relay settings and calls
`selectOwnerDestination`. Caller identity is not an input to this selector.
A fresh resend key selects again; the existing regression covers a target
returning between a failed stage publication and stage/seat resends.

Settings producers are pairing, target refresh, clone setup and settings
updates. `mergeRelayTargets` keeps local configuration while replacing the
service's `answered_by` value. Selection consumers include owner history,
Telegram publication and review sending; their selection order and top-level
reason codes stay the same.

A failed review now retains `reason: no_target` with `destinationDetail`:

| Detail | Condition among targets of unpaused matching pairings |
| --- | --- |
| `no_destination` | No targets |
| `destination_disabled` | Every target disabled |
| `service_only` | Every target answered by the service, with at least one enabled |
| `not_answered_by_owner` | Mixed targets, with no enabled target answered by this installation |

The service captures this allowlisted result at the refusing selection.
The post writer persists it in task and seat rounds. Review reads and the
resend HTTP/MCP response preserve it; local Telegram metadata is excluded from
cross-installation task replicas by `prototypeTaskWire`. A successful resend
replaces the failed post and clears its detail. Existing saved posts without
the optional detail remain readable.

Focused tests use frozen time, isolated state and a fake transport. They cover
stage/seat delivery, resend replay, each detail, refusal recovery, and a target
returning after refusal but before the writer records it. The latter catches
the old second-read diagnostic race, which could replace `no_target` with
`destination_unavailable`. No routing or transport defect was demonstrated by
the historical evidence; this change makes the next refusal attributable.
