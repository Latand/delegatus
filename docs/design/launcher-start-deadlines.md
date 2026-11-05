# Launcher startup deadlines

Inspect the deployment's own status and error after a failed switch. The
launcher also writes its deadline refusal to stderr, which a service install
keeps in its journal. Retry through the existing update or start action after
addressing that error. A successful late start cannot erase a switch overrun.

The switch budget starts when the Viewer dispatches the launcher transition.
Build admission, installation and compilation retain their existing budgets.
`switchDeadlineAt` is an absolute wall-clock expiry in `apply.json` and the
launcher trial. Exec and cold recovery keep it. Legacy switching intents derive
the expiry from `switchedAt`; legacy trials without an apply use `at`.

At expiry the launcher persists `switchOverrun`, logs the cause and attempts
the existing pointer rollback. The rollback has its own durable absolute
expiry. If it cannot finish, the launcher stops its owned children under the
stop bound and records a terminal refusal. A current launcher exits 75. Refusal releases only the
matching request's drain and automatic admission. A later start may retry;
the refused deployment retains its error.

An older rollback entry has no deadline handler. Before executing such an
entry, the candidate starts a guard and requires its readiness within two
seconds. The guard keeps the absolute rollback expiry across that exec. It
accepts timely health only from the recorded launcher and live serving child
identities. At expiry it records the refusal, ends that exact launcher and
stops its recorded serving children through the existing identity checks. A
replacement owner makes the guard withdraw. Native agent hosts are excluded.

The Viewer reconciles the trial/result into the original deployment ledger.
A matching receipt's `completedAt` distinguishes a timely switch observed late
from a switch that actually overran. A healthy target arriving after expiry
settles failed. A verified rollback settles rolled-back. Both carry the cause.
Cold startup validates that receipt against the accepted issuer and recorded
launcher, then preserves `switchCompletedAt` in the apply. Further cold starts
retain that proof even after their launcher identities change. The Viewer
still verifies the serving generation before releasing the original hold.

The existing `deploy-settled` seat wake consumes that terminal ledger. It needs
a running Viewer and a deliverable seat. The bound for restoring a working
prior generation is ten minutes for the switch, up to twenty seconds to stop
children, then ten minutes for rollback. Notification follows the next seat
check (five minutes by default); the ordinary wake cooldown does not suppress
an unannounced settled deployment. If both generations fail, the journal and
terminal deployment record retain the alarm; a seat wake waits for a Viewer
to run again. There is no claim of out-of-process seat notification.

## Wait inventory

| Process / operation | Bound | At expiry |
|---|---|---|
| Launcher ordinary startup | 10 minutes from controller creation | Stop owned children, log refusal, exit 75 |
| Launcher switch, including optional startup preparation and all readiness work | 10 minutes from persisted switch start | Persist overrun; try rollback |
| Launcher rollback startup | 10 minutes from first rollback | Terminal refusal; current entry exits 75, legacy guard ends its recorded owner |
| Legacy rollback guard readiness | 2 seconds | Refuse rollback if no ready guard exists |
| Temporary web-port and address-bind probes | 2 seconds each, including close completion | Abort the owned listener; reject the probe |
| Adoption of a recorded listener or orphan host | 10 seconds after TERM, 5 seconds after KILL | Refuse takeover if the same identity survives |
| Port retry after adoption | 5-second retry window; each probe bounded at 2 seconds | Return refusal |
| Async launcher load preflight | 30 seconds, then at most 5 seconds for exit | Refuse the candidate |
| Terminal bootstrap load preflight | 30-second child timeout using SIGKILL | Start prior entry on failure |
| Automatic re-admission HTTP request | Existing 20 seconds | Refuse dispatch |
| Launcher child exit | TERM, KILL at 2 seconds, 10-second absolute observation bound | Reject stop |
| Viewer generation retirement completion | 10 seconds | Reject stop |
| Combined launcher child shutdown | 20 seconds | Refuse a switch whose shutdown cannot be verified |
| Runtime host readiness | Existing 30 seconds without progress, 5-minute absolute ceiling; socket probe has a 1-second idle timeout | Stop candidate / rollback |
| Viewer readiness | Existing 90-second file/readiness wait, then 90-second page/chunk wait; individual HTTP attempts bounded | Stop candidate / rollback |
| Terminal bootstrap health verification | Existing `TERMINAL_BOOTSTRAP_TIMEOUT_MS` (990 seconds), with 2-second host and 5-second HTTP probes | Report refusal |
| External service recovery verification | Existing 60-second loop with bounded host and HTTP probes | Report refusal |

The outer startup expiry also bounds awaited preparation and recovery work
whose individual completion is lost. These timers require a running launcher
event loop. No synchronous filesystem or kernel operation can acquire an
independent JavaScript timer guarantee.

## Incident evidence and scope

The accepted read-only audit of 2026-11-05 established this UTC sequence from
the unit journal, recovery snapshots, apply/trial records and deployment ledger:

| Time | Observation |
|---|---|
| 05:19:05.543 | Deployment admitted |
| 05:25:35.178 | Release pointer published |
| 05:25:40.047 / .438 | Switching / trial starting |
| 05:25:43.470 | Last unit output before the gap |
| Snapshot saved 06:19:57 | Replacement launcher image already running, with one accepted web-port socket and relaunching record |
| 07:49:55.083–.125 | Separate recovery agent's restart; journal stop/start took about 39 ms |
| 07:49:55.265 / 07:50:05.774 | Runtime host / Viewer started |
| 07:50:47.791 | Deployment succeeded with no error |
| 07:58:42.869 | Seat received deploy-settled wake |

The best-supported wait was `ensureWebPortFree` → `portFree` → `server.close`,
before either serving child started. There is no saved stack or continuous
HTTP observation proving that wait was the sole cause or that the port served
HTTP during the gap. The saved targeted socket-disconnect attempt's effect is
unproven. The socket handling fix already on the base removes that race; this
change adds deadlines and durable failure reporting.

Surviving shell helpers, stderr readers and native wait owners matched native children still
doing work. The service stop itself was brief. Their cleanup and systemd
KillMode remain outside this change. Retention can hold admission busy and
finished soon after the later busy receipt; an orphaned lock was not established.

## Verification

Run explicit test files individually with isolated home, config, state and
temporary roots. The focused regressions are:

- `bin/launcher-adoption.test.ts`: real accepted connection; lost close
  completion for both probe callers; occupied listener remains available.
- `bin/cli.selfUpdate.deadline.integration.test.ts`: real launcher processes
  with fixture Viewer and runtime-host children; ordinary stuck startup,
  stuck replacement, cold restart without resetting expiry, lost child exit,
  lost retirement, and rollback expiry across another launcher process.
  A prior image with no timer still refuses under its independent guard;
  a missing guard refuses before executing that image.
  An answering fixture Viewer precedes production seat-tick evaluation;
  its delivery adapter records one delivered deploy-settled wake.
- `src/lib/selfUpdate/apply.test.ts`: cold reconciliation, legacy intents,
  immutable expiry, late healthy failure and timely receipt observed late.
- `bin/launcher-relaunch.test.ts`: a terminal preflight that ignores TERM is
  killed at its bound and returns to a verified prior release.
- `bin/launcher-rollback-guard.test.ts`: expiry, timely health, stale parent
  identity and a replacement owner; a protected peer and foreign admission
  hold survive every case.

The integration fixture scales only deadline constants or persists a short
absolute expiry. It retains the production transition and cleanup code.
Disabling the probe deadline, launcher watchdog, stop deadline, durable expiry,
late-health failure or deploy-settled reason must make the corresponding
regression fail. These checks exercise the launcher and the production
reconciliation/wake logic; they do not rehearse the production runtime host.
