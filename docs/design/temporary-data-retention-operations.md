# Seven-day temporary data retention

Run the ordinary Viewer to schedule retention. Set `LLV_TEMP_SWEEP=dry-run` to
observe candidates without removing them; `off` stops these passes. No installation
or deletion is performed by the audit command described in the delivery report.

The decisions of 2026-11-12 set expendable lane and agent evidence to seven days
after termination, host journals to seven days after their last write when the
session is dead and its transcript exists, and ownerless legacy automatic copies
to seven days after adoption. An unknown termination clock retains data.

## Ownership and dispatch

The existing scratch remover and its ledger remain separate. The new bounded
ledger records directory discovery positions, exact candidate identities, adoption
clocks, agent-directory bindings and per-candidate refusal reasons. A restarted
helper resumes those positions. Each tick discovers a bounded page and visits a
bounded due page. It runs in the leased sweep helper, outside the Viewer loop.
The due page admits at most 128 entries under the tick deadline; young entries
schedule their next visit at expiry, and open or unknown owners wait an hour.
They therefore leave the due queue available to expired entries.
Completed checkout inventories survive ticks for at most ten minutes under their
directory-version checks, with at most 128 retained checkouts. Dispatch always
revalidates the observed directories. Cold work can progress across ticks.

Evidence writers are `materializeStructuredHostAccess` (lane and agent folders),
`retainRecordedEvidence` (recorded-check folders), `preserveAttemptEvidence`
(automatic copies), and `backupWorktree` (preservation records). Consumers include
artifact readers, recorded-check readers and the worktree backup verifier. The
new reader grants no authority from a folder name alone: it re-reads the lane or
spawn receipt, host entry, membership and process identities. Agent directory
hashes are recovered through bounded receipt-key pages, including archived rows.
The keyed registry readers are additive; existing writers, copies, defaults and
cascades retain their contracts.

Lane evidence is considered one direct child at a time. `worktree`,
`worktree-backup.json`, preservation folders and Git data are excluded. Keep
markers in ancestors or descendants retain a candidate. Unknown paths, symlinks,
mount boundaries and incomplete walks retain data. A durable journal precedes
quarantine. Identity, authority, protection and the checkout inventory are checked
again before quarantine and before removal, including recovery after a restart.
Lane removal claims use the existing pipeline retirement fence. A missing owner
binding never becomes an orphan during journal recovery.
Agent evidence also requires its host to be finished when a closed lane owns it.
Automatic copies recheck both their source and copy ownership rows at dispatch.

## Daily Docker cleanup

A separate maintenance request records its attempt before calling exactly
`docker builder prune -f --filter until=336h` and
`docker image prune -a -f --filter until=336h`. Success and refusal both wait a day
before another attempt. The checkpoint survives restarts. Dry-run issues neither
command. Containers and volumes have no removal path here.

## Old releases

The operator installs a fixed observer with one sudo command. The installer copies
the observer into a root-owned directory, pins the allowed release directory in a
root-owned configuration, validates a sudoers fragment and permits only that
fixed executable with no arguments. The observer reads procfs and emits bounded
holder and uncertainty records. It accepts no code or removal operation. The
ordinary retention helper sends the configured directory on stdin. A missing,
refused, malformed or partial observation preserves the original uncertainty.

The existing gated release remover remains responsible for active, rollback,
in-flight and newest-release protections, checkout checks, two process scans,
identity checks and unprivileged removal. The observer grants no root deletion.
Installation is an operator action after publication. Validation must keep the
operator's live data untouched; test workers force Docker requests to dry-run
and fixture markers retain that guard under production mode because state-directory
isolation leaves the host daemon shared. The validation
report records an earlier violation of this boundary and the corrected tests.
