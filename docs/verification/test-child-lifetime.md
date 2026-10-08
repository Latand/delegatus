# Test child lifetime

## CPU investigation

The real `stageHostGeneration.ts` fixture was run in adopt mode in fresh
temporary home, config, cache, state and temp directories, against an absent
runtime socket and a closed Viewer control port. The parent exited normally.
Identity-bound cleanup found zero owned survivors after each experiment.

| Experiment | CPU seconds in a 2-second sample |
| --- | ---: |
| Startup held at the real refresh barrier | 0.07 |
| Startup settled, original final unresolved promise | 3.06 |
| Same fixture with a referenced idle timer | 0.01 |

Tracing from process birth under Bun 1.4.0 recorded 163,074 `epoll_pwait2`
calls and 218,780 `futex` calls during a bounded run. A separate syscall
trace showed repeated `epoll_pwait2` calls with `{tv_sec=0, tv_nsec=0}`,
each returning zero events. Attaching to an already running process was
refused by the host's ptrace policy. A CPU profile taken with a referenced
exit timer removed the spin itself, so its startup samples were not used to
attribute the idle loop.

The cause is the fixture's unresolved top-level promise after its substituted
startup scheduler has left no referenced event source. Bun keeps polling its
empty event loop. The fixture now holds a real sleep timer. This reproduces
while the parent is alive too; orphaning prolongs it indefinitely. The loop
is in the proof fixture, so no product startup behavior changes in this fix.

The actual-fixture regression was red before the fix: 1,480 CPU milliseconds
in a 1-second idle window, against a 200-millisecond ceiling. The test always
terminates its recorded child and asserts its start identity is gone.

## Earlier investigations

Project-scoped and cross-project transcript searches covered the five phrases
requested in the brief, then exact identifier and phrase variants. Search
results that dropped common query terms were retried with quoted terms.
Opened generation-close discussions from the earlier stage-recovery work
reported 13 of 44 assertions failing on both branch and base; they did not
establish that all spawned fixtures had exited. The current helper still
registered a generation only after its first report. The new readiness and
parent-death regressions reproduced that gap before the fix.

Prior gate discussions used shared flock slots and an 8 GiB systemd scope.
The current wrapper likewise provided a memory cap, without a supervisor tied
to the caller's life. The merger still invoked the machine's older scope-only
wrapper. Both publication and merger paths now use the repository runner.

An opened memory from the transport retry review documented a hanging helper
holding stdout/stderr after its direct Git parent timed out. Current test
comparison likewise killed a process-group number after its root exited,
which missed separately detached descendants. The new service retains every
owned descendant in a kernel cgroup and waits for service shutdown. The
exact orphan-fixture phrase returned no earlier relevant fix beyond this
task. No prior source established the CPU cause; the measurements above do.

## Ownership and runner checks

Node's actual `ChildProcess.spawn` primitive and Bun's actual `Bun.spawn` are
registered synchronously by the test preload. Imported aliases, fork/execFile
and product helpers exercised in the test process share that registration.
Each record carries PID, start identity and boot epoch. Native subprocess
handles remain available for ordinary teardown. The Linux service retains the tree through hard runner death; portable runs also retain the ledger in an independent guardian. It authorizes a signal only
after the recorded start identity is still live; argv never grants authority.

Linux heavy gates now run as transient systemd services in the existing
slot wrapper. `KillMode=control-group`, `TimeoutStopSec=2s` and `RuntimeMaxSec`
cover detached children and an unavailable supervisor. The service checks
the caller's start identity every 100 milliseconds. Normal command exit
checks its owned cgroup for survivors and fails before systemd reaps them.
Per-file comparison uses the same runner on head and base. Stage prompts
prescribe that path; the merger's tests and privacy gate use it too. Linux
refuses admission without the user manager. Direct and nested Bun test runners
re-enter a private service before loading test modules, preserving their exact
command line. Admission checks the command PID and real cgroup. The service
also watches the redirecting test process, including an unreaped zombie.
Linux starts no polling guardian.

Fixture parent binding uses the existing kernel start-identity probes on
Linux and macOS. Windows uses process creation FILETIME in the same backend.
A dead or unverifiable parent ends the fixture; PID reuse cannot renew its
lifetime. Blocking barriers check the binding inside their wait. The
macOS/Windows runner fallback uses the independent guardian; these platforms
have no Linux service cgroup and were not executed on this Linux machine.

Actual-fixture checks cover a stall before the first report, normal parent
exit before the report, and hard parent death. Actual gate-path checks cover
normal exit with a survivor, Bun's test timeout, TERM cancellation, wrapper
SIGKILL, test-process SIGKILL, and the runner deadline. Three more checks cover
a nested direct test exiting, receiving TERM or receiving KILL after a
short-lived helper detached a descendant between observations. Each check is bounded,
retains recovery identities, verifies zero owned survivors, and preserves
unrelated same-argv fixture and/or detached sleep bystanders before cleaning
up those bystanders itself.

The normal pre-push survivor guard caught a served-build verification leak:
the server was signalled without awaiting exit, and its background migration
worker and authentication helper survived it. The verifier now waits for a
bounded stop and, inside a Linux gate, runs the served probe in its own existing
containment service, bound to the verifier identity. The real built Viewer
loads 23 modules and answers GET / with 200, with no outer-run survivors. A
synthetic slow-shutdown server with a detached worker is reaped before success
is returned, while an unrelated same-argv worker survives. Per-run ownership
descriptors are excluded from baseline cache inputs, and the cache version
invalidates results from earlier containment semantics. Both regressions
failed against the earlier behavior and pass after the fixes.

The third and final review reproduced a slow exact-unit stop being cut short
by a forced wrapper exit, followed by an incorrect success report. New
regressions were red for delayed and failed stops. Shutdown now allows the
existing five-second stop budget plus the two-second service grace, and a
forced or unsuccessful wrapper exit rejects verification. Eight verifier
tests pass, including delayed stop, failed stop with bounded watchdog cleanup,
and the direct Linux CLI entering its own containment before probing. Every
case checks dead server and worker identities and a live same-argv bystander.
Linux admission without a reachable user manager is refused. The executable
negative-control fixture now links the full verifier dependency graph while
keeping the intentionally broken build synthetic; all three named controls
pass. The review budget was exhausted before this final correction, which
received a focused self-review and the regressions above.

A later hook attempt stopped at an unnamed merger teardown case during
filtered flaky confirmation. Its original diagnostic had been discarded by
that retry. An isolated real Bun hook reproduced the parser error: Bun emits
a line-less unnamed JUnit case for hook failures. The comparison now preserves
the hook message as a blocking diagnostic, including ownership-survivor
names, and never retries it as a named assertion. The executable comparison
regression was red before this correction and passes afterward. A subsequent
merger file run passed all 40 tests; its fresh head/base comparison reports
zero new failures and one fixed test. These observations do not attribute
the earlier hook failure to a guessed cause.

The runner regressions now verify the entire owning test cgroup after each
probe, including transports outside the inner service. A controlled hard-kill
case holds the real systemd transport for one second after its unit ends.
Without the scope drain, Bun reports one passing assertion case while the
outer guard detects two surviving transport members and fails. With the
drain, all nine runner cases pass with 53 assertions, retain the same-argv
bystanders and leave the kernel-owned scope empty of probe children. The
gate now preserves that survivor line when the command exit disagrees with
a green JUnit report; its executable regression was red before the correction
and passes afterward. Membership reads inspect only the verified owned
cgroup and never authorize a kill by command line.

Head and baseline allocate different process identities. The comparison key
normalizes the identity list for the same survivor diagnostic while displayed
evidence retains every concrete PID and start token. A new survivor still
blocks; an intentional survivor on both sides is reported as pre-existing.
Both regressions pass, and the full comparison suite passes 42 tests with
221 assertions.

The next publication attempt reached native Codex verification, whose private
environment had dropped the user manager connection. Earlier opened design
discussions established that existing host allowlists carry those connection
variables; no earlier fix for this verifier failure was found. An executable
regression through the real verifier was red with the same bus error, then
green after preserving only the manager connection. Application state stays
private, unrelated ambient values and old admission tokens are excluded, and
each named native test now runs separately with a five-minute bound.

The admitted native run exposed another shutdown boundary: its CLI exited
before its MCP launcher and server finished closing. An isolated real-file
sample identified both survivors inside the verified owning cgroup. Kernel
containment reaped them, but the standing guard correctly failed the run.
Test teardown now keeps its runner alive for at most two seconds while
kernel-owned descendants finish shutdown. Persistent descendants fail with
their identities named and are reaped by the service. This reads only the
verified owning cgroup and never signals an observed process by argv.
The transient-tail and persistent-orphan regressions were red, then green;
the persistent case preserves an identical-argv bystander. Spawn ownership
and teardown pass all six tests with 27 assertions. The actual native
response-injection file then passes all six cases and its enclosing guard,
with zero owned survivors among the 55 recorded sample identities.

The next native gate found a direct CLI helper whose stop method sent KILL
and returned before process exit. The ownership hook reaped it and failed
teardown despite two passing assertions cases. That helper now awaits the
shared bounded stop in every finally block. Its real installed-CLI regression
passes both cases with 31 assertions and a clean enclosing guard. Searches
found the earlier installed-CLI test precedent, with no earlier cleanup fix.

A later native campaign timed out in the unchanged oversized replay test.
Its exact focused case also times out on the merge base in fresh isolation,
with the same four assertions reached. Opened prior investigations document
that timeout on clean main. The production source and test match the merge
base. This is a confirmed inherited native-check failure; publication evidence
distinguishes it from the cleanup defects above.

The final helper comparison exposed a completed, green baseline JUnit report
whose enclosing service found survivors. That is a completed ownership
failure, so repairing it on head now reports FIXED with concrete identities.
It remains a blocking NEW failure when introduced on head. Unexpected exits
and genuinely incomplete reports retain the stricter baseline gate error.
The actual helper comparison was red before the correction; the executable
regression and all 43 comparison tests now pass with 225 assertions.

## Teardown signal audit

The follow-up review reproduced a wrong kill by recycling an owned child's PID
in a private user/PID namespace, then starting an unrelated process with the
same argv at that number. The old resource absence assertion sent KILL to the
historical number. Service containment cannot authorize that signal.

Historical resource PID files now support assertions only. Recovery selects
current members of the verified owning test service and revalidates their
captured start/boot identities through the shared signal helper. A process
outside that service receives no signal even when its argv matches. Private
tmux servers capture their start/boot identity before any readiness or exit
wait. Ordinary Node/Bun children retain their original handles.

| File | Teardown disposition |
| --- | --- |
| `src/lib/resources.test.ts` | The quiet absence assertion and three descendant recovery paths send no historical-PID signals; recovery uses verified service membership and the shared identity signal. |
| `src/lib/agent/codexSpawnPolicy.test.ts` | Native app-server and resume seed retain child handles; tmux captures the server identity before waits and uses bounded TERM/KILL cleanup after C-d. |
| `src/lib/tmux.test.ts` | Each private server identity is captured before readiness; both successful session shutdown and recovery await bounded identity cleanup. |
| `src/lib/viewerWorkerLifecycle.test.ts` | Worker identity is captured while reported alive; parent cleanup uses its handle and waits for exit. |
| `src/lib/accounts/migration/coordinatorTurnAuthority.test.ts` | Parent handles and original child identities are retained; the unreaped-child fault signal is fenced, and teardown waits for parent reaping. |
| `src/lib/runtime/structuredHostRetirement.test.ts` | Root and descendant identities replace the PID-only teardown list. |
| `src/lib/selfUpdate/actions.test.ts` | Bootstrap tree ownership precedes a named one-second report wait; launcher identity and parent handle replace historical-PID teardown. |
| `src/lib/telegram/connector.test.ts` | Recovery uses the connector identity captured in the spawn callback and awaits bounded cleanup. |
| `src/lib/flows/exec.test.ts` | Sleeper handles replace PID-only signals; final teardown waits for every retained handle. |
| `src/lib/flows/engine.test.ts` | Reviewer cleanup retains and awaits the original child handle. |
| `src/lib/pipelines/engine.test.ts` | Release fault injection uses the original child handle; every fixture teardown awaits its exit. |
| `src/lib/scanner/filesResponseWorker.test.ts` | Mid-build fault injection captures the live identity; every shutdown waits for that identity to be reaped before returning. |
| `scripts/owned-runner.integration.test.ts` | Hard-kill fault injection uses the shared identity signal; recovery already retains original identities. |
| `src/lib/testing/fixtureProcess.ts` | Shared bounded cleanup checks the recorded start/boot identity before TERM and KILL; report failure stops a registered tree before its root. |
| `src/lib/runtime/cpuPlacement.scope.test.ts` | Private tmux server identity is captured before scope/readiness assertions; pane, agent, descendant and orphan identities are captured while alive. Cleanup awaits bounded identity-checked TERM/KILL for every record. |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | Sidebar browser server identity is captured before connecting. After Playwright closes its handles, recovery awaits bounded identity-checked cleanup before recording the process as closed. |

The remaining direct destructive PID calls in test files have original-identity
fences in the runner/verifier, generation-lifetime, startup and native host
checks. Two injected product signal ports in resource and structured-host
control tests are called behind their product ownership checks. Zero-signal
probes and intentional self-termination grant no teardown authority. JavaScript
native campaign and package helpers retain child handles or use the reviewed
identity-bound stop helper. The executable source audit scans test files
independently of the launch inventory, rejects an unfenced destructive PID
call, and includes a synthetic historical-PID negative control.

Bounded executable regressions recycle a real PID under `unshare -Urpf
--mount-proc` without changing host PID allocation. Identical-argv bystanders
survive the real resource absence helper, both identity signals, bounded identity
cleanup, tree cleanup, process cleanup and a late original-handle KILL. Separate
checks cover changed boot epochs, TERM-resistant escalation, and a stalled
report with a real child tree and a same-argv bystander. The installed native
Codex policy suite and both private tmux shell cases pass. The real runner's
six termination cases and three nested-runner cases preserve their bystanders
and leave their owning cgroups empty.

The standing guard exposed three pre-existing signal-without-wait boundaries
while checking the wider audit: migration parent, flow reviewer and response
worker teardown. Each initially passed its assertions and failed the survivor
guard; bounded exit/reap waits fix them, and their reruns pass. All checks use
private state, a finite command deadline, two assigned CPUs and the standard
8 GiB gate memory cap. Native macOS/Windows and the packed production campaign
were not rerun in this correction. The wider native runtime hook was attempted
under a 30-minute total deadline; it completed both runtime rehearsals and
several native queue/app-server files before that deadline ended the run.
Containment reaped every recorded identity and scope. Earlier verification
limits remain in force.

The wider comparison also reproduced inherited five-second merger-fixture
failures while nested commands waited for shared gate admission. Their bisect
children were retained by the test service and reaped when the run ended. The
preload scope guard and the service guard reported the same identity set twice;
only the added hook diagnostic was classified as new. Comparison now retains a
single ownership failure when both guards name the exact same PID/start set.
Distinct identities and unrelated hook failures still block. Bounded regressions
cover inherited comparison, differing start identities, and the actual service
survivor/cleanup paths. This changes reporting only; survivor admission and
termination remain enforced by the service.

## Process-launch audit

The audit searched test files and fixture/probe helpers throughout the repository
in `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` for Node
spawn/fork/exec primitives, their aliases, namespace calls and Bun spawn calls.
It also follows helper basenames referenced by tests, including subprocess
script paths which are string literals rather than module imports. The independent reference search includes dynamic imports and
primitives passed to higher-order helpers such as `promisify(execFile)`;
requiring a primitive to be the direct callee misses these launches. Calls
inside generated scripts inherit runner containment too. The tables record
each source file with real launch wiring, including the verification helpers.
A local function merely named spawn and type-only imports are excluded. Tests
that substitute launch ports remain covered whenever the real primitive is called.

Disposition **owned**: the preload now records the real handle before spawn
returns, and the runner contains descendants from fork time. Existing local
cleanup stays in place. Disposition **contained helper**: a separately launched
helper stays in the owning run's cgroup; its parent does not need to receive a
readiness report to establish ownership. Disposition **synchronous**: the
caller waits for the command; the runner contains any descendants if the
synchronous call or its parent is interrupted.

The reconciled census contains 254 files: 167 with asynchronous primitives and
87 with only synchronous primitives. These dispositions describe the verified
Linux path.

The executable AST primitive-reference scan reconciles the helper census and
explicit companion exclusions below. It covers JavaScript imports and Bun
calls as well as TypeScript, dynamic imports and higher-order primitive
references. The regression discovers the real package smoke from its test's
script path and deliberately removes that JavaScript row to prove that a
missing helper is detected independently of row totals.

Run standalone verification or capture helpers through `scripts/gate-slot.sh`
with isolated HOME/config/state/temp and `LLV_OWNED_RUN_TIMEOUT_MS` set for the
campaign. A test caller already supplies this service. The JavaScript native
Codex helpers' version probes have five-second timeouts; their imported fixture and
Playwright launch children remain in the same owning service, including setup
failures before local finally blocks. Native campaign execution was not
repeated for this inventory correction.

| File | Async launch sites | Disposition |
| --- | --- | --- |
| `bin/__fixtures__/cli-self-update.ts` | 50, 240, 281 | contained helper |
| `bin/cli.exposure.integration.test.ts` | 262, 284, 317, 336, 355, 389, 417, 444, 469, 496 | owned |
| `bin/cli.selfUpdate.coldRecovery.integration.test.ts` | 100 | owned |
| `bin/cli.selfUpdate.divergedApply.integration.test.ts` | 116, 153 | owned |
| `bin/cli.selfUpdate.integration.test.ts` | 82, 221, 234, 262, 288, 300, 376, 480, 506, 862, 1017, 1042, 1053, 1101, 1130, 1230, 1239, 1317, 1354, 1468, 1477, 1520, 1747, 1791 | owned |
| `bin/launcher-credentials.test.ts` | 211, 229, 230, 265, 266, 290, 303, 310, 341, 374, 388 | owned |
| `bin/launcher-relaunch.test.ts` | 116, 184 | owned |
| `bin/mcp-server.test.ts` | 27, 77, 133, 327, 741, 783, 830, 906 | owned |
| `bin/server-runtime.test.ts` | 201, 262, 302 | owned |
| `scripts/audit-with-retry.test.ts` | 68 | owned |
| `scripts/bootstrap-runtime-host.test.ts` | 111 | owned |
| `scripts/braces-patch.test.ts` | 66 | owned |
| `scripts/capture-board-geometry.ts` | 368, 996, 2392, 4168 | contained helper; existing rendered-evidence driver, immediate returned handles and bounded server readiness/stop. Test imports and driver runs execute in the owning service |
| `scripts/capture-mobile-v2.ts` | 1301 | contained helper; existing rendered-evidence driver. Test imports do not start the server; an explicit capture owns the server handle and browser and closes both in finally under the runner deadline |
| `scripts/demo-capture.ts` | 578, 709 | contained helper; shared rendered-evidence server handles, isolated fixture home, finally cleanup and five-second TERM grace. The owning service supplies the outer KILL deadline |
| `scripts/fixtures/detachedChildParent.fixture.ts` | 5 | contained helper |
| `scripts/fixtures/nestedTestRunner.fixture.ts` | 7 | contained helper |
| `scripts/fixtures/ownedRunner.fixture.ts` | 9, 14 | contained helper |
| `scripts/gate-slot.test.ts` | 37, 53, 55 | owned |
| `scripts/install-mcp.test.ts` | 30, 82, 173 | owned |
| `scripts/local-gate-tests.test.ts` | 16, 32, 39, 116, 187, 204, 205, 209, 272, 285, 289, 316, 328, 329, 331, 332, 334, 378, 407, 536, 561 | owned |
| `scripts/newcomer-install.mjs` | 67 | contained helper; synchronous installers have 120-second deadlines, readiness is bounded, the launched CLI is stopped through its original handle in finally. Its standalone installation campaign is outside a test run |
| `scripts/npm-package-smoke.mjs` | 109, 485, 520 | contained helper; commands have a 30-second handle timeout, startup/restart waits 30 seconds, observation 60 seconds, and the caller has a 150-second deadline. Direct and CLI server handles stop with bounded TERM/KILL; runtime-host restart pins the fence start identity. The owning service contains descendants on interruption |
| `scripts/npm-package-smoke.test.ts` | 32, 34, 61 | owned |
| `scripts/owned-runner.integration.test.ts` | 56, 59, 64, 106, 108 | owned |
| `scripts/owned-runner.ts` | 27, 29, 56, 88, 98 | contained helper; immediate original handles, private service capability, finite command and service deadlines, two-second cgroup TERM/KILL bound; portable limitations stated below |
| `scripts/privacy-publication-gate.test.ts` | 448, 955, 2175, 2282, 2559, 2572, 2587, 2608, 2682, 2970, 3603, 3778, 3822, 3872, 3922, 3971, 4018, 4065, 4112, 4158, 4203, 4745 | owned |
| `scripts/privacy-test-process.ts` | 22 | owned helper; existing 20-second deadline and finally join retained |
| `scripts/probe-realtime-v3.ts` | 230, 276 | contained helper |
| `scripts/rebuild.test.ts` | 104 | owned |
| `scripts/runtime-host-viewer-adapter.test.ts` | 105, 256, 518, 596, 698, 976, 1049, 1261, 1338 | owned |
| `scripts/verify-viewer-runtime.test.ts` | 121, 139 | owned |
| `scripts/verify-viewer-runtime.ts` | 200, 244, 383 | contained helper; direct Linux CLI enters containment, served probe owns a nested service and rejects unconfirmed shutdown |
| `src/app/api/agent/snapshot/standalone.integration.test.ts` | 385 | owned |
| `src/app/api/files/route.test.ts` | 521, 894, 3925 | owned |
| `src/app/api/runtime/hosts/route.test.ts` | 31, 88, 92 | owned |
| `src/app/api/spawn/route.test.ts` | 2421, 2561 | owned |
| `src/app/servedPayloadSecrets.test.ts` | 104 | owned |
| `src/components/LogFeed.prependAnchor.dom.test.tsx` | 324 | owned |
| `src/components/team/passkey.browser.test.ts` | 98, 112 | owned |
| `src/lib/accounts/accountMutation.callers.test.ts` | 130 | owned |
| `src/lib/accounts/accountMutation.fixture.ts` | 12 | contained helper; bounded readiness and cleanup retained, generated child now binds to runner |
| `src/lib/accounts/accountMutation.test.ts` | 39, 120, 181, 231, 247, 283, 318, 352, 389, 486 | owned |
| `src/lib/accounts/accountsStore.sqlite.test.ts` | 100 | owned |
| `src/lib/accounts/claude.test.ts` | 287, 590, 663 | owned |
| `src/lib/accounts/claudeLoginIdentity.test.ts` | 164, 179, 290 | owned |
| `src/lib/accounts/claudeProvider.test.ts` | 118, 364, 386, 438 | owned |
| `src/lib/accounts/codex.test.ts` | 153, 162, 302, 388 | owned |
| `src/lib/accounts/copilotLogin.test.ts` | 204 | owned |
| `src/lib/accounts/manager.interprocess.test.ts` | 76, 100, 204, 270, 310, 330, 369 | owned |
| `src/lib/accounts/migration/coordinatorTurnAuthority.test.ts` | 212 | owned |
| `src/lib/accounts/projectBindings.interprocess.test.ts` | 43 | owned |
| `src/lib/agent/cli.integration.test.ts` | 70 | owned |
| `src/lib/agent/cli.test.ts` | 84, 194, 206, 214, 221, 224, 532, 669 | owned |
| `src/lib/agent/codexSpawnPolicy.test.ts` | 100, 178, 355, 429 | owned |
| `src/lib/agent/ephemeral.probe.test.ts` | 57 | owned |
| `src/lib/agent/identityWaveMigration.test.ts` | 976 | owned |
| `src/lib/agent/registry.sqlite.test.ts` | 475, 951, 961, 999, 1009, 1046, 1119, 1134, 1169, 1199, 1222, 1243, 1625, 1709, 1906, 1921 | owned |
| `src/lib/agent/registry.sqliteOnly.test.ts` | 305 | owned |
| `src/lib/agent/registry.test.ts` | 1774 | owned |
| `src/lib/agent/spawnPolicy.test.ts` | 60, 92 | owned |
| `src/lib/board/store.sqlite.test.ts` | 76 | owned |
| `src/lib/board/store.test.ts` | 77, 135, 221 | owned |
| `src/lib/boardMaintenance/store.test.ts` | 18, 23 | owned |
| `src/lib/externalRelay/store.test.ts` | 54, 96 | owned |
| `src/lib/flows/decisions.test.ts` | 17, 132 | owned |
| `src/lib/flows/engine.test.ts` | 29, 1090, 1184, 1272 | owned |
| `src/lib/flows/exec.test.ts` | 219, 257 | owned |
| `src/lib/flows/store.test.ts` | 190 | owned |
| `src/lib/links/boardSync.test.ts` | 50, 120, 122, 133, 135, 168 | owned |
| `src/lib/links/pairing.test.ts` | 25 | owned |
| `src/lib/mcp/bindings.test.ts` | 4221, 4258 | owned |
| `src/lib/mcp/conversationAction.integration.test.ts` | 97 | owned |
| `src/lib/mcp/ownedChildren.runnerFixture.ts` | 33 | contained helper |
| `src/lib/mcp/ownedFixtureChildren.test.ts` | 18 | owned |
| `src/lib/mcp/rolePresets.test.ts` | 259 | owned |
| `src/lib/mcp/server.test.ts` | 172, 297, 877, 884, 917, 969, 1020, 1042, 1048, 1091, 1150, 1221, 1252, 1273, 1289, 1341, 1361, 1377, 1428, 1445, 1451, 1504, 1521, 1528, 1579, 1595, 1618, 1676, 1694, 1710, 1717 | owned |
| `src/lib/mcp/stdio.integration.test.ts` | 143, 196, 590 | owned |
| `src/lib/mcp/taskPosition.integration.test.ts` | 166 | owned |
| `src/lib/mcp/writerConcurrency.test.ts` | 68, 221 | owned |
| `src/lib/memory/controller.test.ts` | 79, 100 | owned |
| `src/lib/memory/hook.test.ts` | 33, 47, 72, 91, 113, 150, 198 | owned |
| `src/lib/memory/index.test.ts` | 248 | owned; fresh-process memory queries retain the Bun handle and await output and exit |
| `src/lib/monitor/seatTickController.test.ts` | 826 | owned |
| `src/lib/pipelines/engine.test.ts` | 4026, 4056, 5096, 5450, 5452, 7622, 7623, 7624, 7626, 7627, 7628, 9436, 10521, 13682, 13702, 13733, 13754, 13802, 16616, 16653, 16708, 16818, 16863, 17003, 17033, 17158, 17328, 17355, 17515, 18278, 19189, 19206, 20520 | owned |
| `src/lib/pipelines/fixtures/generationParent.ts` | 7 | contained helper |
| `src/lib/pipelines/fixtures/stageHostGeneration.ts` | 63, 76 | contained helper |
| `src/lib/pipelines/git.test.ts` | 110, 864, 2378, 2436 | owned |
| `src/lib/pipelines/parkedPublication.test.ts` | 14, 43, 526, 675, 726, 1000, 1051 | owned |
| `src/lib/pipelines/severedStageRetry.test.ts` | 108 | owned |
| `src/lib/pipelines/stageHostGenerationClose.integration.test.ts` | 91, 154, 209 | owned; registration before readiness, named deadline and identity cleanup |
| `src/lib/pipelines/stageHostGenerationIdle.integration.test.ts` | 19 | owned |
| `src/lib/pipelines/stageHostGenerationLifetime.integration.test.ts` | 36, 64, 67 | owned |
| `src/lib/pipelines/stageInput.restricted.probe.test.ts` | 70 | owned |
| `src/lib/pipelines/store.test.ts` | 102, 124, 165, 877 | owned |
| `src/lib/pipelines/terminalReap.test.ts` | 425, 493 | owned |
| `src/lib/pipelines/worktreeSweep.test.ts` | 69, 123, 129, 201, 753 | owned |
| `src/lib/proc/darwinArgv.test.ts` | 91 | owned |
| `src/lib/proc/windows.test.ts` | 45 | owned |
| `src/lib/processGroup.test.ts` | 159 | owned |
| `src/lib/prototypeReview/decision.integration.test.ts` | 97 | owned; the decision-stop child retains its Bun handle and its exit is awaited |
| `src/lib/resourceViewerTree.test.ts` | 150, 153 | owned |
| `src/lib/resources.structuredHosts.test.ts` | 221, 382, 423, 494 | owned |
| `src/lib/resources.test.ts` | 518, 563, 617, 1750, 1926, 2051, 2138, 2600, 3329, 3334, 3337 | owned |
| `src/lib/resources.truth.test.ts` | 107 | owned |
| `src/lib/runtime/agentMemory.scope.test.ts` | 9, 19 | owned |
| `src/lib/runtime/agentMemory.test.ts` | 241 | owned |
| `src/lib/runtime/claudeStreamBrokerHost.test.ts` | 782, 858, 2276, 2351 | owned |
| `src/lib/runtime/cpuPlacement.scope.test.ts` | Node spawn plus synchronous systemd, tmux and gate probes | owned; private units contain detached fixtures, original PID/start/boot identities are captured while alive and bounded cleanup is awaited |
| `src/lib/runtime/codexAppServerHost.injectCli.test.ts` | 43, 62 | owned |
| `src/lib/runtime/codexAppServerHost.injectResponses.test.ts` | 90 | owned |
| `src/lib/runtime/codexAppServerHost.test.ts` | 5043 | owned |
| `src/lib/runtime/codexHistoryReader.test.ts` | 402, 502, 505 | owned |
| `src/lib/runtime/codexSteerDelivery.integration.test.ts` | 62 | owned |
| `src/lib/runtime/fixtures/nativeCodexRuntime.ts` | 167 | contained helper |
| `src/lib/runtime/fixtures/ownedHostProcess.ts` | 11 | contained helper; identity before spawn event, named deadline, bounded handle cleanup and parent binding |
| `src/lib/runtime/fixtures/releaseHandoverIncumbent.ts` | 50 | contained helper |
| `src/lib/runtime/fixtures/seatSuccessorHost.ts` | 30 | contained helper |
| `src/lib/runtime/handoffQueueStore.test.ts` | 98 | owned |
| `src/lib/runtime/hostlessSessionSettlement.test.ts` | 36, 293, 363 | owned |
| `src/lib/runtime/nativeCodexQueue.test.ts` | 60 | owned |
| `src/lib/runtime/nativeQueueCompaction.integration.test.ts` | 221 | owned |
| `src/lib/runtime/nativeQueueHost.integration.test.ts` | 82 | owned |
| `src/lib/runtime/permissionGuard.test.ts` | 82 | owned |
| `src/lib/runtime/releaseInterruption.test.ts` | 415 | owned |
| `src/lib/runtime/runtimeImageStore.test.ts` | 453, 489 | owned |
| `src/lib/runtime/severedHostReap.test.ts` | 51 | owned |
| `src/lib/runtime/startup.test.ts` | 2474, 2580, 2600 | owned |
| `src/lib/runtime/startupFinalization.integration.test.ts` | 282, 519, 600 | owned |
| `src/lib/runtime/structuredDelivery.integration.test.ts` | 41, 4327 | owned |
| `src/lib/runtime/structuredDeliveryRebind.test.ts` | 189, 648 | owned |
| `src/lib/runtime/structuredHostControl.test.ts` | 80, 90 | owned |
| `src/lib/runtime/structuredHostRetirement.test.ts` | 231 | owned |
| `src/lib/runtime/structuredMessageDelivery.test.ts` | 562 | owned |
| `src/lib/runtime/structuredSpawn.integration.test.ts` | 4685, 4778, 4903, 5148 | owned |
| `src/lib/scanner/discover.test.ts` | 40 | owned |
| `src/lib/scanner/observe.singleFlight.test.ts` | 134 | owned |
| `src/lib/scanner/process.test.ts` | 47, 52, 59 | owned |
| `src/lib/scanner/projectDirectories.test.ts` | 101 | owned |
| `src/lib/scanner/roots.claudeTasks.test.ts` | 55, 91 | owned |
| `src/lib/selfUpdate/actions.test.ts` | 218, 315 | owned |
| `src/lib/selfUpdate/pid.test.ts` | 68 | owned |
| `src/lib/selfUpdate/quietDeadHosts.test.ts` | 48, 327, 346, 393, 494, 571, 606, 629, 650, 684, 746, 762, 812, 847, 903, 976, 1016, 1052, 1090, 1116, 1141, 1194, 1276, 1289 | owned |
| `src/lib/selfUpdate/snapshotIdentity.test.ts` | 34 | owned |
| `src/lib/selfUpdate/workEvidence.test.ts` | 544, 620; synchronous Git and mkdir | owned; HTTP clients retain Bun handles and existing finally cleanup; the runner contains cancellation and detached descendants |
| `src/lib/session/titleStore.interprocess.test.ts` | 32 | owned |
| `src/lib/state/buildPhaseGuard.test.ts` | 133 | owned |
| `src/lib/state/durability.test.ts` | 60, 69, 366, 423 | owned |
| `src/lib/state/diskPressure.test.ts` | 420, 544; forwarded synchronous namespace-reader probes | owned; reader handles and exit promises are retained, parallel fixture children stay in the owning service |
| `src/lib/state/hotStateStores.sqlite.test.ts` | 41, 118, 235, 284, 367, 444, 808, 862, 870 | owned |
| `src/lib/state/stateLeaseRecovery.test.ts` | 168 | owned |
| `src/lib/tasks/store.sqlite.test.ts` | 65 | owned |
| `src/lib/telegram/connector.test.ts` | 241, 609 | owned |
| `src/lib/telemetry/sender.test.ts` | 67, 96, 119, 158, 235, 239 | owned |
| `src/lib/tempSweep.test.ts` | 100, 101, 102, 213 | owned |
| `src/lib/testing/fixtureProcess.test.ts` | Node spawn and private-namespace spawnSync | owned; original-handle, start/boot, real PID reuse, descendant and stalled-report regressions preserve same-argv bystanders within three/seven-second deadlines |
| `src/lib/testing/testChildren.test.ts` | 11, 12, 13, 42, 44 | owned |
| `src/lib/viewerWorkerLifecycle.test.ts` | 44, 66 | owned |
| `src/runtime-host/deploymentProxy.test.ts` | 74, 510, 591 (`promisify(execFile)`) | owned; preload records before spawn returns, promises are awaited, curl has 3/5-second per-transfer bounds and the runner contains cancellation |
| `src/runtime-host/hostRehearsalRun.ts` | 173, 489 | contained helper; shared runtime-host rehearsal starts original handles immediately, bounds readiness/exercise/shutdown, and runs inside the verification service |
| `src/runtime-host/hostRollback.test.ts` | 252, 278 | owned |
| `src/runtime-host/journal.test.ts` | 2201, 2306, 2371, 3957 | owned |
| `src/runtime-host/mcpProbeStdioTransport.ts` | 70 | contained helper |
| `src/runtime-host/mcpRuntimeRelease.test.ts` | 78, 120, 175, 280, 318 | owned |
| `src/runtime-host/runtimeHostFence.test.ts` | 60, 115, 124 | owned |
| `src/runtime-host/runtimeHostStartup.test.ts` | 175 | owned |
| `test-preload.ts` | 19 | contained helper |

| File | Synchronous launch sites | Disposition |
| --- | --- | --- |
| `bin/agent-binaries.test.ts` | 75, 93 | synchronous |
| `bin/envAlias.test.ts` | 65, 121 | synchronous |
| `bin/install-cpu-placement.test.ts` | 37, 42 | synchronous; isolated installer queries are awaited and the runner contains interrupted descendants |
| `bin/launcher-custody.test.ts` | 73 | synchronous |
| `bin/self-update-supervisor.test.ts` | 27 | synchronous |
| `bin/skillLinks.test.ts` | 18 | synchronous |
| `docs/screenshots/issue-499/deepen-to-evidence-revision.test.ts` | 34, 55, 69, 105, 149 | synchronous |
| `docs/screenshots/issue-499/depth-one-evidence.test.ts` | 33, 42, 51, 72, 88, 92 | synchronous |
| `docs/screenshots/issue-499/evidence.test.ts` | 93, 108 | synchronous |
| `evals/roles/controls.test.ts` | 16 | synchronous |
| `evals/roles/graders/behavior.ts` | 14 | synchronous; credential-free sandbox evaluator has a 10-second command timeout; the owning service contains interrupted descendants |
| `evals/roles/lifecycle.test.ts` | 116 | synchronous |
| `evals/roles/runner.ts` | 26, 50, 352, 353, 360 | synchronous; eval subprocesses have a 240-second timeout; Git/archive operations run in the owning service when exercised by tests |
| `scripts/ci-platform-scope.test.ts` | 120 | synchronous |
| `scripts/deploy-checkout.test.ts` | 6 | synchronous |
| `scripts/docker-image-scope.test.ts` | 77, 162, 168 | synchronous |
| `scripts/dockerfile-permissions.test.ts` | 56 | synchronous |
| `scripts/eslint-changes.test.ts` | 13 | synchronous |
| `scripts/harness-ledger.ts` | 673, 796 | synchronous |
| `scripts/local-gate-tests.ts` | 158, 198 | synchronous |
| `scripts/local-gate.test.ts` | 126, 141, 145, 161, 167, 179, 180, 181, 183, 193, 194, 196, 204, 214, 215, 220, 221, 222, 223, 225, 287, 296, 303 | synchronous |
| `scripts/merge-batch.test.ts` | 222, 303 | synchronous |
| `scripts/package-revision.mjs` | 17 | synchronous; finite Git HEAD probe used by package verification; the calling test service supplies interruption and the outer deadline |
| `scripts/privacy-media-workflow.test.ts` | 46, 77 | synchronous |
| `scripts/publish-workflow.test.ts` | 189, 328 | synchronous |
| `scripts/supply-chain-check.test.ts` | 14 | synchronous |
| `scripts/verify-bun-runtime-controls.ts` | 14 | synchronous; negative-control launches remain contained, synthetic build links verifier dependencies |
| `scripts/verify-native-codex-delivery.mjs` | 132 | synchronous; installed Codex version probe has a five-second timeout. The separately imported native runtime fixture owns its handle; browser/runtime close in finally, 30-second scenario waits, owning verification service supplies interruption and the outer deadline |
| `scripts/verify-native-codex-injection-races.mjs` | 96 | synchronous; installed Codex version probe has a five-second timeout. Imported native runtime fixture owns its handle; browser/runtime close in finally, 30-second scenario waits, owning verification service supplies interruption and the outer deadline |
| `scripts/verify-native-codex-runtime.test.ts` | 33 | synchronous |
| `src/app/api/artifact/route.test.ts` | 143 | synchronous |
| `src/app/api/pipelines/route.test.ts` | 24 | synchronous |
| `src/components/Viewer.switching.dom.test.tsx` | 299 | synchronous |
| `src/components/kanban/issue1695BrowserHarness.ts` | 26, 320, 324 | synchronous |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | 6709, 11921, 12068 | synchronous |
| `src/components/mobile/issue1671Evidence.browser.test.tsx` | 8387 | synchronous; ffmpeg fixture generation is awaited, browser handles are owned by the shared browser harness and test service |
| `src/lib/accounts/claudeCredentials.test.ts` | 97, 127 | synchronous |
| `src/lib/agent/spawnCommand.contention.test.ts` | 92, 155, 226 | synchronous |
| `src/lib/agent/transcript.test.ts` | 36, 40 | synchronous |
| `src/lib/attention/landing.test.ts` | 42 | synchronous |
| `src/lib/boardMaintenance/run.test.ts` | 245 (dynamic import), 248 (`git` helper) | synchronous; caller waits for Git init/commit/branch in an isolated repository, and the runner contains descendants on deadline or cancellation |
| `src/lib/flows/git.test.ts` | 19, 20, 46 | synchronous |
| `src/lib/forge/autoMerge.test.ts` | 258, 292, 336, 375, 406 | synchronous |
| `src/lib/issueReports/store.test.ts` | 64 | synchronous; isolated race helper has a 60-second deadline and stays in the owning service |
| `src/lib/git/agentForgeCredentials.test.ts` | 70, 87, 88, 89, 119, 120, 413, 419, 435, 438 | synchronous |
| `src/lib/git/agentHistoryGuard.test.ts` | 46, 130 | synchronous |
| `src/lib/git/codexShellPolicy.test.ts` | 69 | synchronous |
| `src/lib/links/self.test.ts` | 338, 561, 732 | synchronous |
| `src/lib/links/taskSync.test.ts` | 387, 389, 475 | synchronous |
| `src/lib/mcp/callCost.test.ts` | 577 | synchronous |
| `src/lib/mcp/compactAnswers.test.ts` | 38 | synchronous |
| `src/lib/mcp/spawnRecovery.integration.test.ts` | 251 | synchronous |
| `src/lib/mcp/workLinks.test.ts` | 21 | synchronous |
| `src/lib/onboarding/healthCheck.test.ts` | 342, 346, 357, 365 | synchronous |
| `src/lib/orchestrator/seatProjectIdentity.test.ts` | 22 | synchronous |
| `src/lib/pipelines/controllerArtifacts.test.ts` | 22, 129 | synchronous |
| `src/lib/pipelines/remoteActions.test.ts` | 75, 155, 212, 663, 721 | synchronous |
| `src/lib/pipelines/stageInput.test.ts` | 18, 142, 183, 211, 268 | synchronous |
| `src/lib/projects/succession.test.ts` | 55 | synchronous |
| `src/lib/prototypeReview/fences.test.ts` | 103 | synchronous; private FIFO creation is awaited and runner-contained |
| `src/lib/reaperRuntime.test.ts` | 1654, 1655, 1656, 1658, 1659, 1660, 1696, 1697, 1698, 1700, 1701, 1702, 1704, 1705 | synchronous |
| `src/lib/review/extraction.test.ts` | 73 | synchronous |
| `src/lib/reviewHistory/reader.test.ts` | 546 | synchronous |
| `src/lib/runtime/agentPublicationIdentity.test.ts` | 20, 107 | synchronous |
| `src/lib/runtime/codexStructuredUserText.compact.test.ts` | 82 | synchronous |
| `src/lib/runtime/codexSubagentDetection.test.ts` | 484 | synchronous |
| `src/lib/runtime/integrationTestHome.ts` | 73, 101, 102 | synchronous |
| `src/lib/runtime/pipelineStageHostAccess.integration.test.ts` | 36 | synchronous |
| `src/lib/runtime/sendSettlement.test.ts` | 1558, 1666 | synchronous |
| `src/lib/scanner/describe.test.ts` | 661, 701, 726 | synchronous |
| `src/lib/search/projectScope.test.ts` | 30, 31 | synchronous |
| `src/lib/selfUpdate/auto.test.ts` | 39, 114, 517, 551, 725, 807, 864, 913, 1615 | synchronous |
| `src/lib/selfUpdate/package.test.ts` | 35 | synchronous |
| `src/lib/stateOwnership.entryPoints.test.ts` | 63, 87 | synchronous |
| `src/lib/stateOwnership.test.ts` | 98 | synchronous |
| `src/lib/tasks/ghostSettlement.test.ts` | 122 | synchronous |
| `src/lib/telegram/bot/service.test.ts` | 654 | synchronous |
| `src/lib/telegram/fixtures/releaseConnector.ts` | 49; generated supervisor spawn at 36 | synchronous helper; generated supervisor retains the connector handle and writes its product ownership record, caller cleanup checks its original identity and the owning service contains the detached connector |
| `src/lib/telegram/packaging.test.ts` | 72, 149, 183, 213, 302, 369, 447, 468 | synchronous |
| `src/lib/telegram/vendorPagination.test.ts` | 64 | synchronous |
| `src/lib/tempDirs.test.ts` | 88 | synchronous |
| `src/lib/tmux.test.ts` | 647, 647, 663, 691, 759, 783 | synchronous |
| `src/lib/workflows/engine.test.ts` | 169, 580, 602 | synchronous |
| `src/lib/workflows/provision.test.ts` | 68, 96 | synchronous |
| `src/runtime-host/candidateContainer.test.ts` | 94, 204, 344 | synchronous |
| `src/runtime-host/canonicalMirror.test.ts` | 109 | synchronous |
| `src/runtime-host/deploymentAdapter.test.ts` | 48 | synchronous |

Additional launch wiring checked by text and imports:

| File | Result |
| --- | --- |
| `src/lib/mcp/ownedFixtureChildren.ts` | Receives existing handles; immediate registration and handle cleanup retained. The preload owns them before any caller can await. |
| `src/lib/testing/testChildren.ts` | Wraps the real Node primitive and both Bun overloads before spawn returns; supplies the parent identity even without options. |
| `scripts/local-gate-tests.ts` | Per-file comparison launches the kernel-owned runner and removes the old post-exit group-number kill. |
| `scripts/verify-native-codex-runtime.ts` | Preserves the existing manager connection for nested containment, with one named file per process and a five-minute bound. |
| `src/lib/runtime/codexAppServerHost.injectCli.test.ts` | The direct CLI helper now awaits bounded handle termination in every finally block. |
| `src/lib/runtime/claudeStreamBrokerHost.integration.test.ts` | Generated launchers and product launch ports remain inside their test service. |
| `src/lib/runtime/codexAppServerHost.integration.test.ts` | Generated launchers and product launch ports remain inside their test service. |
| `src/lib/runtime/copilotAcpHost.integration.test.ts` | Calls a product launch port; the preload owns real process creation. |
| `src/app/api/spawn/route.binding.test.ts` | A local function calls the route, without a subprocess primitive. |
| `src/lib/monitor/seatTickSources.test.ts` | The named spawn creates synthetic records, without a child process. |
| `src/lib/pipelines/resolveDecision.test.ts` | A substituted launch callback creates synthetic records. |
| `src/lib/pipelines/stageCompletion.test.ts` | A substituted launch callback creates synthetic records. |
| `src/lib/telegram/reportRunner.test.ts` | A substituted launch port creates synthetic reports. |

Referenced production and operational companions are explicitly excluded from
the 254-file test/helper census. They remain reconciled by the independent
reference scan. Their execution by a test is contained by the same service;
this disposition does not change their production process contract.

| File | Exclusion / test ownership |
| --- | --- |
| `bin/claude-provider-launch.mjs` | Production provider launcher; test invocations stay in the test service, original child handle signals |
| `bin/cli.mjs` | Public CLI entry point; package tests invoke it inside their owning service; production supervision is outside fixture cleanup |
| `bin/forge-app-token.mjs` | Forge authentication command; subprocesses exercised by tests stay in the service; production credential flow is outside the fixture audit |
| `bin/launcher-adoption.mjs` | Production release adoption; probes and signals are product behavior tested in the owning service |
| `bin/launcher-credentials.mjs` | Production credential/ACL probes; test calls are contained, no independently launched long-lived test helper |
| `bin/launcher-relaunch.mjs` | Production release relaunch; test executions are contained, live operator handoff is outside the fixture audit |
| `bin/launcher-service-proof.mjs` | Production service proof probes; test invocations are contained synchronous queries |
| `bin/mcp-server.mjs` | Public MCP launcher; test process stays in the owning service and uses original bundle handles |
| `bin/oomPolicy.mjs` | Production service-policy queries; synchronous probes inside contained tests |
| `bin/provision-telegram-connector.mjs` | Operator connector installer; test invocations contained, live installation outside the fixture audit |
| `bin/self-update-supervisor.mjs` | Production release metadata and bounded identity probes; imported by tests, no independent long-lived fixture |
| `bin/tailscale.mjs` | Operator tunnel utility; test queries contained, live networking outside the fixture audit |
| `bin/windows-process-identity.mjs` | Production kernel identity probes; bounded synchronous PowerShell commands, native execution outside this Linux run |
| `scripts/bootstrap-runtime-host.ts` | Operator bootstrap command; real test invocation contained by runner, deployment is outside fixture cleanup |
| `scripts/ci-platform-scope.ts` | CI scope query; synchronous Git calls exercised by tests in their service |
| `scripts/cutover-shared-claude-projects.ts` | Operator cutover command referenced in tests; live migration outside the fixture audit |
| `scripts/docker-image-scope.cjs` | CI image scope query; synchronous Git commands contained when called by tests |
| `scripts/eslint-changes.ts` | Publication lint tool; original bounded process handles inside gate service |
| `scripts/local-gate.ts` | Publication entry point; launches the shared gate-slot runner, isolated per-file tests and bounded checks |
| `scripts/merge-batch.ts` | Operational merge command; test-invoked tools contained, live forge writes outside fixture cleanup |
| `scripts/prepack.mjs` | Package builder; its async build handles are operational packaging, excluded from the test/helper census. Package smoke uses npm pack with scripts disabled; an explicit prepack campaign runs under the gate deadline |
| `scripts/privacy-publication-gate.ts` | Publication scanner; bounded synchronous tools contained by the gate, no long-lived fixture |
| `scripts/rollback-runtime-host.ts` | Operator rollback command; contained rehearsal calls, deployment outside fixture cleanup |
| `scripts/runtime-host-viewer-adapter.ts` | Production deployment adapter; real regression invocation contained by runner, live deployment outside fixture cleanup |
| `scripts/supply-chain-check.ts` | Publication dependency checks; synchronous bounded audit commands inside gate service |
| `src/lib/accounts/claudeCredentials.ts` | Product credential helpers exercised by tests; actual process primitive calls contained by preload/service |
| `src/lib/agent/cli.ts` | Product CLI queries exercised by tests; bounded calls contained by preload/service |
| `src/lib/proc/windows.ts` | Product process backend; bounded synchronous probes, native Windows execution outside this Linux run |
| `src/lib/pipelines/worktreeSweep.ts` | Product worktree-maintenance Git port; awaited commands have a 120-second timeout and test executions stay in the owning service; live worktree maintenance is outside fixture cleanup |
| `src/lib/runtime/cpuPlacement.ts` | Product CPU-placement port; synchronous systemd queries have five-second timeouts and test executions stay in the owning service; live agent placement is outside fixture cleanup |
| `src/lib/processIdentity.ts` | Product boot identity probes; bounded synchronous sysctl on macOS, contained test calls |
| `src/lib/resources.ts` | Product resource commands exercised by tests; actual primitive calls contained by preload/service |
| `src/lib/runtime/claudeStreamBrokerHost.ts` | Product structured host launch port; test calls captured before spawn returns and service owns descendants |
| `src/lib/runtime/codexAppServerHost.ts` | Product structured host launch port; test calls captured before spawn returns and service owns descendants |
| `src/lib/runtime/copilotAcpHost.ts` | Product structured host launch port; test calls captured before spawn returns and service owns descendants |
| `src/lib/selfUpdate/git.ts` | Product revision queries; synchronous test calls contained, no long-lived fixture |
| `src/lib/workflows/provision.ts` | Product workflow provisioning; real test primitive calls contained by preload/service |
| `src/runtime-host/main.ts` | Production runtime-host entry point; fixture/rehearsal/test launches contained by owning service |

Long-lived fixture entry points with no spawn call of their own also bind to the recorded originating runner: `stageHostGeneration.ts`, `stateLeaseOwner.fixture.ts`, `releaseHandoverIncumbent.ts`, `seatSuccessorHost.ts`, `codexSeatSuccessor.ts`, `nativeCodexRuntime.ts`, `packagedRollback.ts`, `fakeClaudePermissionCli.ts`, and the three `claude-stream-json-*` fixtures. The runtime image writer and structured image admission writer check that identity inside their bounded blocking barriers. MCP fixtures inherit it through their shared barrier helper. Intended adoption can outlast an intermediate generation while the originating test run is alive. A zombie runner has already ended and cannot retain fixture ownership.

## Platform containment contract

Two independent reviews reproduced a detached descendant escaping the portable guardian between observations of its short-lived parent. The portable branch provides identity-safe cleanup of recorded processes with bounded interruption and cleanup, but cannot establish ownership of every descendant at birth. Its empty ledger performs no host-wide scans. Linux runs use their service cgroup instead of this guardian.

The accepted contract keeps the strong lifetime guarantee on Linux and refuses Linux admission when native containment is unavailable. macOS and Windows continue with the portable guardian as best effort, with one warning per owning run that a detached descendant can escape between guardian polls. Both the slot wrapper and direct test preload use the same policy; nested runners inherit the warning marker. The marker never enables portable admission on Linux.

The policy regression was written first and failed before the implementation. Parameterized macOS and Windows policy tests check permitted admission and a single explicit warning; a Linux policy test checks refusal even with an inherited marker. The actual Linux gate refusal and service lifetime regressions remain in place. Native macOS and Windows execution was unavailable on this Linux machine; policy coverage does not establish native execution coverage. The accepted portable limitation requires no further containment review rounds.


After the platform decision, fresh isolated runs passed all six slot/admission
checks, all nine actual Linux runner lifetime cases, all three real-fixture
lifetime cases and the idle-CPU regression (19 tests across four named files).
The lifetime probes again preserved same-argv bystanders and the enclosing
ownership checks reported zero survivors. The final incremental typecheck
passed after giving the synthetic policy environments the project's required
NODE_ENV field. No further independent review round was started; the shared
policy, inherited warning marker, Linux refusal and documentation received a
focused read-only self-review.


## Identity-safe teardown follow-up

The package smoke no longer signals a historical process-group number. It
stops the original ChildProcess handle with bounded TERM then KILL and does
nothing after exit. Runtime-host restart uses the start identity published by
the private host fence and refuses a mismatch immediately before signalling;
a reboot cannot span the running smoke process. Shutdown checks use that same
identity, so a recycled PID cannot be mistaken for a surviving owned host.

The runtime-host route, scanner, structured-host control, resource collector,
flow, account-login and Codex policy regressions now register their local root identity before
readiness and use the shared fixture-tree cleanup. It validates the recorded
root, current ancestry and each member's PID/start/boot identity, then retains
those identities for bounded escalation. An exited root authorizes no new
walk or group signal. Detached children reported by the fixture are retained
by their identities. The bootstrap and deployment-adapter SSH/Git shims record
the sleeping child's identity while its parent is alive; cleanup no longer
uses its name to authorize a kill. The kernel service owns forks missed by
local cleanup and handles cancellation or hard-kill paths.

Bounded regressions exercise the real smoke stop and shared tree stop against
exited/reused roots, TERM-resistant children and a surviving same-argv
bystander. The actual runner and stage fixture lifetime matrix remains the
standing coverage for interrupted owned descendants.


Resource-fixture group queries remain diagnostic filters. Signals now target
only individually captured PID/start/boot identities whose current cgroup is
the admitted test service. A command line or a historical group number grants
no kill authority. The real two-service regression confirms that cleanup
removes its own group and preserves the same-argv group in a separate service.
The scanner stamp regression also removes any inherited host stamp from its
bare fixture environment, so a launched agent can exercise that assertion.


Follow-up validation ran one named file per service with private state and a
finite deadline. Actual runner lifetime (9), real pre-report lifetime (3),
spawn ownership/kernel teardown (6), idle CPU (1), fixture-tree cleanup (3),
smoke signal authority (3), package bins (1) and inventory discovery (5) pass.
Affected route (11), scanner (4), structured control (35), resource collector
(10), account login (14, one native skip), bootstrap (6), deployment adapter
(34), flows (40) and installed Codex policy (17) pass. The resource head/base
gate reports zero new failures and one flaky diagnostic case, with failures
on base during confirmation. An initial separate head run had a timeout/exit
diagnostic mismatch which did not recur in the comparison head. TypeScript,
changed-file ESLint, whitespace and merge-base diff/commit/body privacy pass.
The packed production-server campaign and full native Codex campaign were
not repeated; the real cleanup functions, package entry points and actual
runner matrix supply this correction's bounded coverage. A read-only review
checked signal authority, bounds, failure paths, inventory reconciliation and
public evidence; it started no additional independent review round.
