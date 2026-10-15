# Seat continuity across a Viewer restart

A dead Viewer can leave a Claude stdio engine alive with an open tool turn.
Startup records the existing interruption obligation before the adopter ends
that orphan tree. The capture rechecks the Viewer owner, native identity,
claim epoch, current generation and seat epoch after reading the transcript.
A surviving native callback owner retains its existing stream.

| Defect | Change | Regression |
| --- | --- | --- |
| D1 | Secure the seat's durable interruption obligation before orphan termination or adoption | `startup.test.ts`: a real surviving process recorded by a Claude host row; its first signal sees the obligation; one continuation arrives. Live or unknown owners, changed claims, seat rotation and supersedence prevent stale capture |
| D2 | Require delivery evidence to discharge a cut. Pending and unknown newer messages keep it owed. A proven unexecuted send releases the original continuation under its stable key | `startup.test.ts`: queued, delivering, uncertain, unverified failure, fenced failure and delivered cases, including a fresh registry boot and deferred recovery |
| D3 | Publish ready hosts and drain their work while contested hosts stay deferred. Retry adoption and transcript reads for the deferred rows | `startup.handoverRetry.test.ts`: production Codex attachment repeatedly fails while the adopted Claude seat executes either a pending send or an owed continuation; the contested send remains queued |
| D4 | Check revocation and current designation before fresh send and explicit retry admission. Recheck after runtime, recovery and registry waits. Return 409 with the current successor | `structuredMessageDelivery.test.ts`, `http.test.ts`, `http.retryProgress.test.ts`: real seat rotation with no conversation supersedence; id and path sends, retry races, zero fresh operations, and preservation of an already bound operation |

Recipient checks use the existing designation store and its alias and epoch
rules. Historical conversations retain their identity. Existing outbox failure
reasons and the single retry action retain their existing behavior.

The controller keeps contested recipients deferred after it publishes ready
hosts. Their next adoption pass uses the existing ownership checks and bounded
backoff. Pending interruption obligations use that same deferral to observe
the newer delivery's outcome. Startup work is attributed as `runtime.startup`.

## Verification

All commands run through the required owned gate wrapper, one heavy command at
a time, with private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR values.
Only explicit test file paths are selected. Tests and builds run in scratch
exports. The retained check results and source digests are in
`evidence/seat-restart/readings.json`.

No performance improvement is claimed. This change modifies startup ordering
and recipient admission. It changes neither the runtime-host listener nor the
Bun pin. The runtime-host succession rehearsal is still included in validation.

The final regression selection passes all 25 cases. The same tests on the base
produce 18 failures and seven passing control cases. The full delivery and HTTP
selection passes 234 cases. Startup, handover and controller files pass 149
cases and retain three assertion failures reproduced on the base. Their names
and both observations are retained in the readings. The historical transcript
refresh case passed its isolated replay and the final full-file selection after
one earlier default five-second timeout.

The full release-interruption file passes 133 cases. The explicit designation,
controller and outbox files pass 68 cases. Type checking, changed-file ESLint
and the runtime-host succession rehearsal pass. Publication privacy is checked
on the staged files and committed branch before pushing.
