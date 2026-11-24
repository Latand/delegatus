# Phase 1 provisioning verification

Issue #4290. The controller checkpoints a checkout plan before Git changes the repository, gives its toolchain worker bounded write authority, and consumes the verified receipt before the first stage can start.

## Base layout and CPU

The unchanged base was `d1c9dc0c99aa3cc36fc89e11f4e8dccb9324948d`. The baseline inventory measured 110 pipeline test files calling the full entry. The pre-push plan selected the following files under Bun on Linux. The lane evidence retains the exact selected paths.

| Change sampled | General test files | Independent privacy tests |
| --- | ---: | ---: |
| Base engine transition | 97 | 11 |
| Base Git module | 1 | 11 |
| Base scheduler path | 0 | 0 |
| Candidate provisioning module | 1 | 11 |
| Candidate publication module | 1 | 11 |
| Candidate shipping changes before recovery and measurement checks | 130 | 11 |
| Candidate shipping changes with those checks | 133 | 11 |
| Candidate scheduler pass module | 0 | 0 |
| Candidate controller job registry | 0 | 11 |

Activation and settlement still use the engine selection. The base performed toolchain setup in process. Three unchanged-base runs of the named cold fixture under Bun 1.3.3 used 0.96, 0.85 and 0.93 driver CPU seconds and took 6.86, 5.46 and 5.85 seconds wall time. These are focused fixture samples. The declaration, setup, process tree and independent privacy verdict of the full hook are outside their accounting.

## Regression evidence

The base reads in `src/lib/pipelines/engine.ts:11533`, `src/lib/pipelines/git.ts:804` and `src/lib/pipelines/lockedDependencies.ts:583` establish the original order. The old scoped controller could hold a callback after checkout creation and shared its result only at apply. The production worker's metadata request now has a durable step with an independent deadline.

| Cut | Baseline | Candidate evidence |
| --- | --- | --- |
| Hold the first check-ignore reply after Git exits | On the design base the checkout existed at the expected SHA and no first attempt existed. The outstanding callback held the lane and no durable step appeared. The warm campaign reproduced the stall for all three 60 s observations. | The held dependency reply timed out under Checking dependency inputs. The source integration control retained the cutoff across forward and backward live clock jumps, adopted the planned SHA after origin moved and observed one add, one attempt and one actual first child. The late reply made no second transition. |
| Hold a payload scan after both Git replies | At `61c8bfd06` the lane advanced to its first attempt without exposing a barrier after the payload child exited. The regression failed to reach the requested hold. | At `3bbae25f3` the real worker reported scan completion and waited. The controller persisted Validating the sealed graph, held its claim at one millisecond before the cutoff and named the step in its interruption at the cutoff. The replacement claim kept the already linked graph, dispatched zero additional adds and recorded one attempt and one actual child. |
| Independent native cache owner, restarted controller | Source controls. Pre-v1 has no v1 cache-wait timestamp or cutoff. | A new process probed halfway through the 180 s window and preserved the original wait timestamp, physical identity and cutoff. Release one millisecond before the deadline allowed launch. Holding the fence at expiry parked with `cache-holder-unclaimed`, preserved the external lock and recorded zero attempts. Explicit retry after release reused the checkout and launched once. |
| Matching source tools and no Bun lockfile | At `41a5a88a6` the leased worker parked with `private-install-unverified`. | At `245c57928` the worker borrowed the matching tools and the receipt allowed launch. Separate controls forced ordinary copy and introduced empty and populated foreign trees before publish. The inode and bytes of each foreign tree were preserved. |
| Legacy exclusion and an expired v1 slot | At `245c57928` the due slot kept its original claim. The cache contention case also lacked a worker claim for the physical fence. Both targeted assertions failed. | At `55e8d68a8` the due-only selection revoked the expired slot with zero Git dispatches on that lane while a peer advanced. The native contender proved a live v1 holder using its recorded descriptor, device, inode and current claim. |
| Controller dies before Git registers the checkout | The design-base program has no pre-registration add slot or native add fence. | A real detached Git writer kept its add fence after the owning Viewer fixture died. A fresh controller waited at the original admission time, started a same-repository peer and adopted the one checkout after the native writer exited. |
| Refuse state admission after checkout verification | The design's base probe recorded a second fetch and add after a 20.5 ms admission refusal. | An independent SQLite writer forced the read-back apply step to stay pending. A fresh process used the original planned SHA after origin moved and recorded one first attempt and zero further adds. |
| Lose the permit reply after native cache acquisition | Source-helper control. The base has no separate provisioning helper. | An independent lock probe observed native cache custody through the deadline and reacquired it while the reply remained held. The retry adopted the checkout, completed one install and ignored the late reply. |
| Live detached legacy-form frozen installer on a slotless checkout | The old reader's existing-directory check is its readiness predicate. | The candidate recorded the installer's PID and start token, admitted zero private scratch writes and launched after the writer exited and handoff comparison verified the original inode. An unreadable working directory on an unrelated process did not prevent the real private install. |
| Checkout-relative write custody on Linux | The old Bun command used the checkout name and its tree need only exist on a later read. | Bun 1.4.0 resolved a `file:` dependency and workspace member from their checkouts. In-place retry finished once. Replacements introduced before or during either the first install or its rerun retained their device, inode and contents. The lane recorded `private-install-unverified`, wrote zero readiness markers on the replacement and admitted zero launches. |
| Legacy writer appears between toolchain receipt and apply | At `77f9bf828` the lane reached running with no provisioning slot while a possible installer had an unreadable cwd. | At `f722ae26c` a fresh census at consume recorded `private-install-writer-live (working-directory)` and no attempt. A new complete observation after the process exited let the original checkout launch once. |
| Close from another process with a permit in flight | The design base has no v1 permit protocol. | With the 50 ms control poll held, close before dispatch sent a correlated stop frame and permitted zero cache writes. Close after the committed `open-cache` admission allowed that single effect. Both paths retired the cleanup slot, kept the lane closed and started zero stages. |
| Live foreign claim and a backwards wall-clock step | At `f722ae26c` resetting wall time while the predecessor was alive renewed its wait. The fixture did not reach running after the original 10 s cutoff. | At `61c8bfd06` the new controller took the monotonic cutoff on first observation, held the original token at 9,999 ms and acquired a new claim at 10,000 ms. It preserved the interrupted record's original times and launched once without signalling the foreign process. |
| Guardian missing or early EOF before ready | Source-only controls. Pre-v1 does its preparation in the Viewer. | The normal source supervisor recorded `startingToolchain (toolchain-start-failed)` with zero dispatches. Restoring the guardian allowed the same checkout inode to reach one running attempt. |
| A real pre-v1 reader against a saved candidate plan | Both runs used the design-base engine with only the subprocess driver copied into its source export. | After origin moved, pre-v1 used the saved SHA, made one failed probe on the already registered checkout and performed zero fetches. It launched with or without a partial private tree. The partial case kept its bytes and had no install receipt. The candidate then retired its leftover slot with one first attempt. |

The focused suite at `77f9bf828` exercised the queued and direct pinned/followed controls. The broad source run had 39 passes and one fixture setup failure. Its pre-v1 export lacked the subprocess driver. The corrected export passed the two version-pair cases at `f722ae26c`. The consume and dispatch ordering cases passed in the same five-case run. The opt-in warm campaign was skipped during this focused suite. The later exact-source run passed 32/32 across the three provisioning suites. Earlier recovery fixtures passed 17/17 at `e4209533f` and the minimum SQLite 3.39.4 check passed in the later combined run.

The board and phone browser drivers used the production list projection on fictional lanes. Forty-eight first-screen results passed at 390, 768 and 1440 px across English, Ukrainian, light and dark. The minimum observed text contrast was 5.56:1. The open board advanced the age and cleared the step at running. The lane evidence retains screenshots and text-range geometry.

## Seven-stage warm contention

The Linux campaign used Bun 1.4.0, followed main, a valid warm graph, 24 decision lanes and three paused lanes. The scoped flow controller received its production wake signal and watchdog. The observer dated acceptance at return of the create call. The actual fixture child wrote its own timestamp. The runs alternated the unchanged base and the exact `bab08de44` production inputs from 17:29:29 to 17:33:47 UTC on 24 November 2026.

| Pair | Base observation | Candidate first child | Candidate add to attempt / child | Base selection / fetch / add | Candidate selection / fetch / add |
| --- | --- | ---: | --- | --- | --- |
| 1 | No child at 60.019 s | 18.349 s | 17.030 / 17.302 s | 485 / 20 / 19 ms | 540 / 49 / 72 ms |
| 2 | No child at 60.017 s | 17.852 s | 16.605 / 16.871 s | 554 / 21 / 18 ms | 512 / 39 / 66 ms |
| 3 | No child at 60.000 s | 18.097 s | 16.793 / 17.103 s | 492 / 34 / 25 ms | 505 / 42 / 69 ms |

**Pass against the under-60-second fixture target.** Each candidate run recorded one add and one first child. Median was 18.097 s and maximum was 18.349 s, leaving 41.651 s. Each base observation ended with the check-ignore reply held and the lane in provisioning. The earlier campaigns measured 19.023 / 18.141 / 18.846 s and 18.064 / 18.289 / 18.258 s with the same base failure.

| Pair | Toolchain entry to recorded expiry | Expiry detection after deadline | Wait to retry claim | Applying checkout | Consume to actual child |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 10,002 ms | 12 ms | 5,021 ms | 475 ms | 281 ms |
| 2 | 10,005 ms | 14 ms | 5,014 ms | 475 ms | 282 ms |
| 3 | 10,006 ms | 13 ms | 5,022 ms | 485 ms | 323 ms |

The committed observer recorded each expiry while the fault was held. All three named Checking dependency inputs. The four planned state holds were 13, 94, 209 and 445 ms. Actual candidate holds were 20.0 / 111.5 / 221.0 / 445.1 ms, 26.8 / 107.0 / 224.8 / 445.1 ms and 25.6 / 99.5 / 216.6 / 445.1 ms. The fourth hold began at Applying checkout result. The base did not reach apply. Separate CPU admission time for the launch is unknown.

Controller process CPU was 1.729 / 1.821 / 1.800 s on the base and 2.259 / 2.187 / 2.402 s on the candidate. Base observation lasted about 60 s. The candidates completed in about 18 s. The warm receipt was 105 bytes, with zero executable entries and zero CLI links.

| Completed step | Samples | Median | 95th percentile | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Resolving repository | 6 | 196.5 ms | 230 ms | 230 ms |
| Resolving base | 3 | 136 ms | 148 ms | 148 ms |
| Verifying checkout | 9 | 167 ms | 595 ms | 595 ms |
| Creating checkout | 3 | 125 ms | 137 ms | 137 ms |
| Starting toolchain | 6 | 120 ms | 146 ms | 146 ms |
| Checking dependencies | 3 | 164 ms | 201 ms | 201 ms |
| Validating sealed graph | 3 | 71 ms | 71 ms | 71 ms |
| Preparing toolchain | 6 | 83 ms | 131 ms | 131 ms |
| Applying checkout | 3 | 475 ms | 485 ms | 485 ms |

Completed durations run from one committed transition to the next. The nearest-rank 95th percentile equals the maximum at these sample sizes. Three metadata expiries led to three retries and zero parks. The maximum age from first recorded entry to consume was 17.519 s against the six-minute execution cap. No state admission refusal overlapped the expiry commits.

## Earlier cold comparison

Three alternating local runs under Bun 1.4.0 ended at 14:36:35 UTC on 24 November 2026. The candidate was `41a5a88a6`. Each sample used a disposable local bare remote, one suspended peer and an independently observed first child. This fixture exercised a cold checkout.

| Pair | Base first child | Candidate first child | Base selection / fetch / add | Candidate selection / fetch / add |
| --- | ---: | ---: | --- | --- |
| 1 | 352.939 ms | 461.318 ms | 66 / 25 / 18 ms | 63 / 29 / 25 ms |
| 2 | 372.271 ms | 483.256 ms | 64 / 21 / 27 ms | 58 / 31 / 19 ms |
| 3 | 361.348 ms | 684.717 ms | 63 / 25 / 18 ms | 83 / 47 / 31 ms |

Medians were 361.348 ms and 483.256 ms. Maxima were 372.271 ms and 684.717 ms. Driver CPU medians were 0.28 s and 0.25 s. Driver accounting omits separately admitted processes.

## Controller cost

The seeded driver in `scripts/measure-pipeline-controller.ts` ran 600 passes with one dirty edit per simulated second, 30 graph-bearing open lanes, 232 retained closed lanes and 796 archive rows. Each completed base/candidate pair used the same seed digest. No pass exceeded 15 s. The 250 ms warm phase and 100 ms timer-delay targets were exceeded in the following runs.

| Pair | Side | Main-thread CPU | Median / max phase | Max sync slice / timer delay | Decoded rows / bytes | Logical read bytes |
| --- | --- | ---: | --- | --- | --- | ---: |
| 1 | Base | 29.130 s | 92.941 / 330.779 ms | 53.938 / 133.095 ms | 629 / 78,469,866 | 710,873,292 |
| 1 | Candidate | 32.000 s | 99.811 / 253.991 ms | 38.043 / 101.393 ms | 629 / 78,469,866 | 713,344,793 |
| 2 | Base | 28.050 s | 88.552 / 288.605 ms | 37.403 / 113.200 ms | 629 / 78,469,866 | 710,877,292 |
| 2 | Candidate | 32.140 s | 100.095 / 261.147 ms | 53.750 / 177.850 ms | 629 / 78,469,866 | 713,343,443 |

| 3 | Base | 25.530 s | 79.854 / 157.468 ms | 41.367 / 80.337 ms | 629 / 78,469,866 | 710,791,824 |
| 3 | Candidate | 26.290 s | 83.831 / 234.906 ms | 35.217 / 95.791 ms | 629 / 78,469,866 | 713,292,437 |
| 10× retained | Base | 24.910 s | 79.457 / 342.460 ms | 39.681 / 121.567 ms | 629 / 78,469,866 | 739,981,088 |
| 10× retained | Candidate | 23.970 s | 75.508 / 266.617 ms | 46.063 / 115.804 ms | 629 / 78,469,866 | 742,455,608 |

The 2,400 scheduler selections per sample decoded 0.262 rows and 32,696 bytes per selection at both history sizes. The larger fixture kept the same 30 open lanes and multiplied retained closed rows from 232 to 2,320, with 796 archive rows in both cases. The archived rows stayed on the same store path. The two original-scale pairs ran from 15:55:07 to 16:00:57 UTC. After the recorded run was interrupted, the third pair and the tenfold pair completed from 16:47:23 to 16:52:42 UTC under the same shared gate with the measurement observer on the candidate.

| Side | Original-scale driver CPU median and range | Driver wall median and range | 10× driver CPU / wall |
| --- | --- | --- | --- |
| Base | 48.086 s, 42.896–48.313 s | 82.084 s, 69.996–87.157 s | 57.918 / 87.717 s |
| Candidate | 53.064 s, 44.049–53.243 s | 89.288 s, 75.181–91.821 s | 58.563 / 86.979 s |

The original-scale candidate consumed more CPU in all three pairs. The original-scale worst phase was 330.779 ms on base and 261.147 ms on candidate. The largest candidate timer delay was 177.850 ms. One candidate maximum synchronous slice was 53.750 ms, above the 50 ms target. The seeded driver has no Git or child actuation. Its CPU numbers cover that controller workload. The separate touched-file comparator measures publication checks.

## Focused touched-file comparator

The isolated workload used the same Bun 1.4.0 runtime and installed dependency graph, one file worker and fresh state, cache, HOME and TMPDIR per run. The base selected `src/lib/pipelines/engine.controllerPass.coldProvisioning.test.ts`. The candidate at `77f9bf828` selected `src/lib/pipelines/provisioningJob.integration.test.ts`. Each invocation used `bun scripts/local-gate-tests.ts --admitted --base <base> <file>`. The shared lock delayed admission by 673.239 s before the paired workload began. Local CPU service admission inside each comparator is tabulated.

| Pair | Base tree CPU / wall / admission | Candidate tree CPU / wall / admission |
| --- | --- | --- |
| 1 | 36.585 s / 56.180 s / 49 ms | 65.698 s / 60.153 s / 41 ms |
| 2 | 33.990 s / 53.719 s / 49 ms | 68.277 s / 61.558 s / 61 ms |
| 3 | 36.391 s / 55.493 s / 53 ms | 75.221 s / 66.774 s / 51 ms |

The six runs started at 16:52:42 UTC and finished at 16:58:36 UTC. The owning cgroup's user-plus-system CPU median was 36.391 s for the base (33.990–36.585 s) and 68.277 s for the candidate (65.698–75.221 s). Wall medians were 55.493 s (53.719–56.180 s) and 61.558 s (60.153–66.774 s). Each comparator completed one file process with zero failures, confirmation runs or extra base samples. Independent privacy tests were outside these explicit file runs.

The candidate took more CPU in all three pairs. Its file runs fresh controllers, native Git writers and the leased dependency helper. The base file includes unrelated stop-read controls. The planner shows a narrower selection for the moved transition. These focused runs establish zero CPU reduction for that measured pair of files. The 66.774 s candidate maximum leaves 773.226 s of the 14-minute check window after reserving the one-minute pack margin. That residual excludes the other hook steps. Full hook duration, whole-plan comparator CPU, actual pack margin and a complete proxy for per-file guardian launch counts are unknown. The operator's test scope restricts local execution to the named or edited files.

## Release and reversal

- #4295 recovers an unheld index lock during stage Git. Phase 1 keeps the stage Git entry points and moves initial checkout verification under its own custody.
- #4353 retires a killed structured setup receipt during retry-stage. The new provisioning retry case applies to a lane with no stage attempt.
- #4198 recovers lost structured publication replies after launch reservation. Phase 1 returns to the original first-stage admission and its launch reservation.
- Stop the current provisioning controller before new effects become eligible in the successor. Before starting pre-v1 with an admitted, unconsumed add, independently prove writer exit or verify a durable park that pre-v1 skips. Pre-v1 can accept an existing partial in-place installation.

The production build and installed tarball at `41a5a88a6` exercised the same offline Git/package fixture with private state, isolated ports and Bun 1.4.0. The built verifier loaded 39 server modules and answered GET / with 200. The serving worker resolved from `.next/server/provision-toolchain-worker.js`, emitted ready and consumed the graph at the planned SHA. The supplied-tarball `--mcp-assets` path also consumed a cold receipt through its standalone Viewer. At 16:59 UTC, the same archived tarball passed the supplied-package smoke and a disposable copy missing only the packaged worker refused the served lane at `startingToolchain (toolchain-start-failed)`. The built-layout controls refused an absent bundle and an omitted worker route-trace entry.

The `candidate-gate` image built the `f722ae26c` source and ran the disposable provisioning rehearsal without external network access. At 17:08 UTC its serving bundle emitted ready under `bun-container` 1.4.0. The Viewer consumed a cold graph with a receipt under the planned worktree SHA. Removing the bundle returned `ENOENT` at the trace check. Removing just its file entry from the trace returned the distinct omission refusal. Both controls ended before a Viewer or install was admitted. The next compiled run at 17:26 UTC repeated the positive and both image controls with the clock and explicit dispatch-stop changes. The final `bab08de44` production inputs repeated the cold receipt and both image controls. A separate isolated run in the same image passed both the held payload-scan case and the lost cache-permit case using the compiled worker and `bun-container`. The rehearsals exercised the provisioning leg of candidate verification. The runtime-host succession and performance legs were outside this phase's local execution.

## Reproduction

- The warm campaign is the opt-in case in `src/lib/pipelines/engine.controllerPass.coldProvisioning.test.ts`. Set `LLV_WARM_PROVISION_CAMPAIGN=1` and select `seven-stage warm provisioning` by name. The fixture uses the real scoped controller, a local remote and a loopback dependency package.
- The seeded controller driver is `bun scripts/measure-pipeline-controller.ts` with `AUDIT_SEEDED=1`, an owned `AUDIT_RUN`, and `AUDIT_CLOSED_MULTIPLIER` set to 1 or 10. Each pass records logical bytes, phase and CPU time, decoded rows, and selection count. Run the same fixture on exported base and candidate trees, in alternating order under the shared gate.
- The regression entry is `bun test src/lib/pipelines/provisioningJob.integration.test.ts`. Use a clean exported pre-v1 tree with `fixtures/provisionControllerProcess.ts` copied into its pipelines fixtures directory and set `LLV_PROVISION_LEGACY_TREE` to that export for the actual version-pair cases.
- The built release verifier is `bun scripts/verify-viewer-runtime.ts`. The installed control is `bun scripts/npm-package-smoke.mjs --mcp-assets` with the archived tarball argument. The candidate provisioning rehearsal uses `bun-container --no-env-file scripts/verify-provisioning-release.mjs` from the candidate image without network access.

## Remaining unknowns

- The built and installed Viewer smoke drivers exercise normal HTTP admission and missing assets. The held metadata and cache-permit controls through their serving Viewers remain unverified because those drivers have no supervisor-reply barrier. The container fault replay used the source controller fixture with the shipped worker. A synchronous spawn refusal also remains unverified.
- The retained check-ignore and sealed-payload cases exercise both metadata reply cuts on source. The largest warm graph, the final validation cutoff on that graph and three pairs for a plain warm start, an ordinary cold frozen install and a peer held in preparation are unmeasured. The recorded fixture used a small single-package receipt.
- The cache wait proof covers the v1 holder and both outcomes for an unclaimed external holder across restart. A full pool with a fifth due lane, six FIFO same-repository lanes, detached Git maintenance and a forced stripe collision remain unverified. The seeded cost fixture has no live pool or native writer, so oldest due age, pool maxima, active lease-hold attribution and dirty-acknowledgment counts are unknown.
- The real owner-loss tests cover the pre-registration writer and refused apply. Remaining cuts include crash before the launcher starts, the launcher's 60–65 s bound while its Viewer is gone, an initializing registration, an escaped descendant, and suspension past the rollback deferral. Live owners with revoked write authority, inconclusive foreign ownership, changed PID start identity, the other restart wall-clock and stale timer cuts, the six-minute cutoff and a dropped wake lack a dedicated paired verdict. Recovery during an outage at the expiry write, gross and net detection delay during that outage, the successful apply reply lost after commit, and independent delivery-target advances in a version pair are also unverified.
- Linux tests covered a live legacy-form installer on a slotless checkout, an unrelated unreadable cwd and a possible writer with an unreadable cwd. The initial combined suite observed an incomplete process identity from the busy machine during a copy-only case. The copy tests now use a fixed observation, while the production integration cases still use the actual census. The real upgrade cuts with the old Viewer killed both before and after directory creation, incomplete enumeration, portable snapshot staleness and expiry of the legacy census wait have no end-to-end result. Focused adapter controls for incomplete enumeration, failed process identity and elapsed observation allowed zero writes.
- The Linux bound-write cases use Bun 1.4.0. A native macOS no-replace and stripe run needs a macOS host. Unsupported binding, filesystems without atomic no-replace publication and cancellation after a private staging directory exists still need production-entry results. The in-flight-close test observes the supervisor sending a stop frame, counts actual writes and proves native exit. The other install, publish and link effects still need separate admission-versus-close evidence.
- The repository's whole-program typecheck belongs to CI. A consented measurement on a reviewed desktop release belongs to deployment. This run used private stores and a fixture first child.
