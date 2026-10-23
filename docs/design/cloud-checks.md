# Pipeline checks in Codex Cloud

Status: proposed, 2026-10-23. Documentation only; no runner or publication
behavior changes here.

Origin: Codex Cloud (GPT-6.1 Sol), result 29, based on `adce5764`.
The exported diff's SHA-256 was verified before applying it to the pipeline's
main snapshot, `f348d75b`; the claims below were checked against that snapshot.

The operator requests that pipeline stage checks and pre-push gates run in
Codex Cloud so the rented gate server can be retired. Recommend cloud execution
of deterministic check plans, local privacy enforcement, and a locally verified
receipt before a lane is accepted for review or delivery. Cloud upload and
successful publication must become distinct states. An agent saying “passed”
is never a gate verdict.

## Current behavior and constraints

Sources read for this proposal: [remote runner design](remote-gate-runner.md),
`scripts/gate-runner/{client,serve,env-classes}.ts`, `scripts/gate-slot.sh`,
`scripts/local-gate.ts`, `scripts/local-gate-tests.ts`, `.githooks/pre-push`,
`src/lib/pipelines/{publication,git,gateBudget}.ts`, `test-preload.ts`,
`scripts/owned-runner.ts` and `src/lib/testing/portableTestAdmission.ts`.

Today the hook executes `local-gate.ts pre-push`. It scans privacy locally and
runs admitted checks concurrently, cancelling and awaiting the peer on refusal.
The SSH client can ship a captured working tree as a Git bundle, scans that
capture before transfer, and requires the server to reproduce its tree ID.
A missing end record after a remote start yields exit 75, never success;
subsequent commands fall back locally for 30 minutes. Browser evidence can be
returned through a bounded output map. Builds and board geometry capture are
not generally dispatched by that client.

The gate plan includes types, changed-file ESLint, touched tests, scoped Linux
checks, pinned Bun checks for both Viewer and runtime host, native Codex checks,
and supply-chain checks where selected. Browser tests are explicitly selected
stage checks, not automatically all part of pre-push. No-change pushes still
scan commits; prose-only changes skip compiler and executable checks. Touched
tests run head first, sample failing assertions on the merge base, and preserve
NEW, PRE-EXISTING, flaky and runner-error distinctions. They currently allow
up to eight head files, five minutes per file and fifteen minutes per comparison
run; complete matching baseline samples alone qualify for the 24-hour cache.

Publication in `git.ts` installs frozen dependencies, validates the accepted
head, adds locally loaded role-memory privacy inputs, and invokes Git push with
the full hook. The hook receives a deadline one minute before the publication
budget ends. `gateBudget.ts` selects 15 minutes ordinarily or 25 for the named
pipeline engine/publication families. `publicationDeadlineOnly` distinguishes
capacity failures from assertions, privacy refusals and failed cleanup. Existing
ownership fences and remote-head reconciliation must survive this change.

### Cloud observations on 2026-10-23

The supplied measurements on 2026-10-23 are 5 CPUs, 17 GB RAM, no user systemd,
a read-only cgroup hierarchy, Chromium at the system executable location,
`playwright-core` present, npm registry reachable, Playwright CDN blocked, and
no sudo. These describe one measured container; allocation and tool availability
must be checked for each run.

The proven headless current-Cloud path uses the hosted app-server WebSocket:
`initialize`, `initialized`, `thread/start`, then `turn/start`. Select
`gpt-6.1-sol` with `allowProviderModelFallback: false`. The tested full-access
launch sets `approvalPolicy: "never"` and `sandbox: "danger-full-access"` on
`thread/start`, then `sandboxPolicy: { type: "dangerFullAccess" }` on
`turn/start`. Thread creation uses `serviceName: "codex_cloud"`, an
`environments` entry containing the privately resolved environment configuration
and working directory, and `deferredEnvironment: true`. Keep credentials and
routing values in private configuration. Correlate notifications by the returned
thread and turn IDs because the socket also carries unrelated notifications.
Results are readable through `thread/read`, `thread/turns/list` and
`thread/items/list`; exported diffs carry SHA-256. This desktop-protocol spike
establishes launch feasibility; its stability as a public automation interface
remains unverified. The [app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes the general RPC lifecycle; the hosted launch fields above come from
the dated spike.

An isolated probe bypassed the owned-runner preload and recorded **198 passing
and 2 failing unit tests**. Both failures reported a missing SQLite index.
Typecheck exited 0. Chromium executed the existing kanban browser driver;
the collected output had 104 passes, 19 failures and 2 skips before an
environment interruption, with no final exit record. This proves browser
execution is feasible. It supplies no complete browser verdict or full gate
parity result, and dedicated process-lifetime suites were not run there.

PR #3278's portable no-systemd mode is merged in this snapshot. In
`scripts/owned-runner.ts`, ordinary Linux invocation selects `--portable` when
the user manager is unavailable outside an agent signal sandbox.
`admitPortableTestRunner` now admits Linux and warns about best-effort cleanup.
The runner binds `LLV_PORTABLE_TEST_RUNNER_PID` to the actual command PID;
`test-preload.ts` accepts that binding while retaining private state and child
ownership. Container plans use `DELEGATUS_AGENT_CPU=off` to avoid the separate
gate-slot CPU-placement refusal, and `LLV_GATE_RUNNER=off` to prevent SSH
dispatch. Keep the preload enabled for new runs. Existing integration cases in
`scripts/owned-runner.integration.test.ts` cover missing/unreachable managers,
direct/runner/gate entry paths, cancellation, deadlines and parent loss. Rerun
them in Cloud before granting check authority; the earlier bypass probe did
not exercise the merged mode.

Portable process ledgers and guardians have weaker containment than
kernel-owned cgroups: detached descendants may escape observation between
polls. Use a disposable environment per run with provider teardown as the final
boundary. Unproven teardown or failed cleanup prevents acceptance. Tests
requiring systemd need an explicitly named compatible local/CI check in the
aggregate, with missing coverage recorded as required work.

## Privacy and source transfer

The fingerprint list must never leave the originating host. Neither hashes in
that list nor raw known values, role memory, credentials, private configuration,
privacy findings or logs containing matched values may enter a cloud prompt,
checkout, archive, cache, transcript or artifact. Local privacy uses trusted
scanner code and trusted current inputs, scans immutable outgoing content and
commit metadata with `--require-known-values --check-commits`, and retains its
existing refusal text and exit behavior locally. Only an opaque local receipt ID
and pass/fail category may be shared; the privacy evidence and catalog digest
remain local.

There is a blocking source-layout conflict: the current repository tracks
`scripts/privacy-known-value-fingerprints.json`, and `git.ts` imports it.
An ordinary clone of the lane, a full-history bundle, or deletion after clone
already transfers the list. Excluding one file from a tarball while fetching
normal history is also insufficient. The current hosted CI uses the committed
catalog, which conflicts with a literal host-only rule for new cloud transfers.
Existing exposure cannot be undone by this design; no claim of retroactive
secrecy is made.

Before any new cloud upload, implement a host-built sanitized execution mirror:

1. Freeze original head H, tree T, selected merge base B and required comparison
   history. Run local privacy on the exact outgoing source and metadata. No
   upload is allowed while that result is missing, red or incomplete.
2. Construct a separate Git object graph with no original object alternates,
   remote, credentials or fetch fallback. Remove the catalog from every supplied
   revision and replace imports with a documented inert test fixture where
   needed. Audit all reachable objects, commit messages and generated fixtures.
   Do not forward original commits whose trees retain the catalog.
3. Record locally the original-to-execution revision mapping, projection version,
   allowed changed paths and canonical source-manifest SHA-256. Compare all
   non-projected bytes and file modes. Push only this sanitized lane branch to
   the cloud source. Pin its execution head E and projected base EB.
4. Cloud checks attest E and EB; the host verifies their mapping to H, T and B.
   It must not claim that E is the original Git head. Tests covering privacy,
   catalog imports or changed projection paths remain required locally against
   the original tree. A projection change invalidates prior results.

This is more work than a normal lane clone, but meets the literal no-transfer
requirement. An alternative is moving the catalog out of tracked source and
rewriting all history reachable by the cloud checkout, with corresponding local
loading and CI policy changes. A shallow clone is acceptable only after proving
its entire reachable object graph and required base are clean. Resolving this
conflict is required work in slice 1.

## Proposed execution and publication protocol

Use a host-side coordinator and a trusted versioned check harness. The model
starts or explains work; it does not decide pass/fail, choose weaker checks or
mint authoritative receipts. Stage development can stay local. Cloud stage
checks and publication reuse the same immutable plan and evidence contract.

1. Under the existing lane ownership fence, freeze H/T/B, resolve changed paths
   and selected checks locally, and generate a random attempt ID. Include the
   planner/harness versions, dependency lock digest, tool pins, projection
   version, browser selection and resource/deadline policy in the plan digest.
2. Complete local privacy before the first push needed to start cloud work.
   Upload the sanitized lane branch with a narrowly scoped staging-upload
   capability. This state means `uploaded, unchecked`; it cannot advance review,
   merge or delivery. Generic `LLV_SKIP_HOOKS=1` is not the implementation.
   Ordinary manual pushes retain full local gates unless using this verified
   coordinator path. Retry uploads idempotently and reconcile ambiguous writes.
3. Launch cloud runs pinned to E, never a moving branch name alone. Bootstrap
   verifies actual files against the source manifest before and after frozen
   install; refuse unexpected mutations. Pin Bun from the repository, Node,
   native Codex fixtures and browser version. Record actual tool identities.
   Use the installed Chromium through `CHROME_BIN` and `playwright-core`;
   downloading a browser from the blocked Playwright CDN is unavailable in the
   measured environment. Verify the installed version against the plan and
   route incompatible browser cases to the named local/CI check.
   Cache dependency downloads by lock digest, platform and tool version, never
   live state, secrets or mutable check results shared between lanes.
4. Execute the immutable selected plan using repository gate logic. Every check
   receives private HOME, XDG config/cache, TMPDIR and LLV_STATE_DIR before
   imports. Use a closed Viewer control endpoint and a short browser temp root.
   Retain preload and ownership cleanup. Set remote-runner dispatch off to
   prevent recursive SSH calls. Do not run broad suites against host state.
5. Read every page of the three thread result APIs, correlate attempt, thread,
   turn and command item IDs, and await terminal command records. Persist
   bounded raw logs plus structured results through a coordinator-controlled
   artifact channel. Missing items, truncated evidence or disconnected streams
   produce `no-verdict`; a completed model turn alone proves nothing.
6. Verify receipts locally, then rerun privacy if source or private inputs changed.
   Recheck original head, tree, base policy and lane ownership immediately before
   acceptance. Any source change invalidates the receipt. Final target writes
   use existing publication fences and remote confirmation. Uploading first
   requires an explicit new publication state; existing `remote: published`
   cannot double as checked/accepted.

For an ordinary destination already holding H, acceptance need not push again;
confirm its exact head. For a separate delivery destination, push original H
only after aggregate acceptance and local privacy. Where the destination itself
would transfer the catalog to cloud storage, the same host-only rule applies:
use the sanitized destination or resolve catalog/history migration first.

### Receipt and trust contract

A versioned receipt carries attempt/lane correlation, H/T/B mapping reference,
E/EB, plan and source-manifest SHA-256, lock and tool digests, assigned shard,
start/end times, exact command argv, working directory relative to the checkout,
exit code or signal, timeout/cancellation reason, test classification counts,
cleanup outcome and artifact names/sizes/SHA-256. Include explicit selected,
executed, deferred and missing checks. No absolute paths or private environment
values enter public evidence. The host combines this with its local privacy
receipt; cloud cannot overwrite that half.

Exit 0 is necessary for an ordinary check but insufficient for aggregate success.
A comparator may exit 0 with pre-existing failures; retain its full structured
classification and base evidence. A missing runtime prerequisite must not be
laundered into PRE-EXISTING. Exit 75 denotes no verdict; timeout and signal codes
remain distinct. Named assertions, privacy refusal and cleanup failure remain
decisive even if another shard times out. Required CI enforcement, including
media OCR and existing runtime contexts, remains in force.

SHA-256 verifies byte integrity. Authenticating test execution needs independent
command evidence in addition to the exported diff checksum.
Accept only artifacts bound to coordinator-owned run/command records, retrieved
through authenticated transport and verified against expected attempt and plan.
A signing credential must never be given to lane code. If the provider cannot
supply a sufficiently independent command-result channel, treat cloud output
as advisory and run decisive checks locally or in trusted CI. Lane code can
also modify its own harness: pin orchestration and completeness validation to a
trusted revision, record candidate harness tests separately, and retain the
same repository-code trust assumptions as existing gates without allowing the
candidate to declare its required checks away.

Check-only runs must leave source clean. A repair diff is a separate candidate:
verify its export SHA-256, bounds, paths, symlinks and local privacy before
applying; then create a new H and rerun. Never attach old green results to a
model's repaired output. Return browser frames and JSON through bounded,
allowlisted artifact paths, reject traversal/symlinks/oversize archives, verify
checksums locally, and inspect frames before making rendered-evidence claims.

## Parallelism, deadlines and cost

Start with at most three independent cloud runs per lane: types/lint; touched
and scoped Linux tests; selected browser drivers. A fourth runtime/native or
supply-chain shard may replace one of those slots when selected; queue extra
shards. Runtime build and its consumers stay together. Each shard gets its own
disposable environment; three processes sharing one 5-CPU container are not
three independent allocations. If the provider shares resources, use one
heavy shard per container and measure before raising concurrency.

Within the 5-CPU/17-GB observation, start at two test-file workers, one browser
at a time, and no overlapping build. Make the comparator worker bound explicit
in the cloud plan instead of silently inheriting eight workers. Keep head-first
comparison, assertion filtering, fresh repetitions and cache validity rules.
Browser selection covers the existing kanban, conversation-window and phone
drivers (`src/components/kanban/kanbanBoard.browser.test.tsx`,
`src/components/conversation/conversationWindow.browser.test.tsx` and
`src/components/mobile/issue1671Evidence.browser.test.tsx`), with required
English/Ukrainian and light/dark cases. Board geometry
(`scripts/capture-board-geometry.ts`) remains local initially; move it only
after its production build and evidence contract are demonstrated in cloud.

The coordinator owns a global cap, initially two active lanes and six cloud
runs. A bounded fair queue prevents one lane's repairs from starving others.
Record queue time separately from execution; cancel superseded attempts. Reuse
an exact complete receipt for identical plan inputs, not merely the same branch
name. Partial successes may be reused only while every input and cleanup proof
still matches; the aggregate always lists all required checks.

Keep the existing 15/25-minute execution budgets and one-minute publication
pack margin. Preserve five-minute file and fifteen-minute comparison bounds.
Cloud admission may wait outside execution time as local CPU admission does,
but impose a separate 10-minute provisioning/queue ceiling. Give bootstrap at
most three minutes within the execution budget. All shards share the attempt's
execution deadline; retries do not reset it. An explicit caller deadline wins.
Allow at most 30 seconds for cancellation/cleanup acknowledgement; otherwise
quarantine and tear down that environment, retain no pass, and reconcile before
retry. These are initial policy values, to be confirmed by measurement.

Use `publicationDeadlineOnly` semantics for capacity retries: 1, 5 and 15
minutes, then park. Add structured cloud reasons rather than relying solely on
new log prefixes. Red tests do not become transient because transport also
failed. A moved head cancels the old attempt and starts a new budgeted attempt
under the existing lane policy.

No cloud price or subscription allowance was measured for this design. Track
per attempt: provisioning/queue/execution time, model input/output tokens,
reported billing or quota units, artifact storage/transfer, retries and local
CPU/privacy time. If rates are available, cost per accepted head is the sum of
those priced units divided by accepted heads, including failed attempts. If
only quota consumption is exposed, report quota per accepted head instead of
inventing a currency estimate. Compare this with the actual rented-server bill
and measured local fallback cost over the same week. A near-zero marginal
subscription charge still consumes scarce task capacity. Keep prompts short,
run deterministic batches per shard, reuse verified results, and stop obsolete
runs to control consumption. Warn at 80% of a configured daily allowance; at
100%, queue or use bounded local fallback, never weaken checks.

## Failures and fallback

Before any cloud start, unavailable transport, clean-source preparation failure,
failed portable-mode preflight or exhausted quota can select the existing local
gate with SSH dispatch disabled. It still uses normal local admission and isolation.
A privacy refusal stops immediately; it is never a reason to transfer elsewhere.
After cloud start, lost connectivity yields no verdict and requires cancellation
or terminal-state reconciliation before a local retry. Do not leave duplicate
heavy work running indefinitely. A hard cleanup failure blocks acceptance and
requires container teardown.

Use one bounded local fallback at a time. If local capacity or required tools
are unavailable, park with the missing check and retry policy rather than
reprovisioning the rented server implicitly. A real red result goes through the
producer's existing repair path. Unsupported systemd, native or browser cases
must run in an explicitly named compatible local/CI environment and join the
same aggregate. Whole-container OOM, bootstrap failures and missing artifacts
are infrastructure failures, never green. A remote write with a lost reply
keeps its ownership fence until its outcome is reconciled.

## Variants and recommendation

| Variant | Benefit | Trade-off |
| --- | --- | --- |
| Cloud stage evidence, full local pre-push | Smallest trust change; immediate experiments after privacy/source isolation | Duplicates heavy work and may not remove local load |
| Cloud deterministic shards plus local privacy and verifier | Reuses stage results for publication, supports several runs per lane, removes rented runner | Needs sanitized source, two-phase publication, portable cleanup and authenticated receipts |
| One cloud run executes the entire non-private gate | Simpler aggregation and fewer task starts | Longer tail, less parallelism, more retry waste; runtime dependencies still need proof |
| Existing trusted CI as final heavy gate, cloud advisory | Established check authority; useful fallback where provider evidence is insufficient | CI queue latency and quota; stage feedback may duplicate execution |

Recommend deterministic cloud shards as the target, with advisory shadow runs
first and trusted CI/local checks for unsupported cases. Retire the rented
runner only after parity and fallback prove it unnecessary. Do not rent a new
server as an implicit fallback. Keep the fingerprint list local throughout
bootstrap.

## Delivery slices and acceptance criteria

1. **Privacy-safe source and portable-mode verification.** Specify and test the
   source projection, trusted local scanner, opaque receipt and source
   mapping. Exercise the merged #3278 runner with its preload enabled in the
   measured Cloud environment, including nested admission, timeouts, recorded
   detached children and parent loss. Record the remaining discovery limit and
   prove environment teardown; kernel containment cases require a compatible
   local/CI check. Acceptance: cloud object graph, caches, prompts and artifacts
   contain no catalog or known-value inputs;
   failure before privacy pass transfers nothing; both head/base work without
   systemd or writable cgroups; unsupported containment is an explicit refusal.
   Resolve the hosted CI catalog conflict before claiming host-only compliance.
2. **Advisory coordinator and evidence.** Implement durable attempts, pinned
   plans, thread pagination/reconnection and authenticated command artifacts.
   Run types/lint, touched tests and existing browser drivers on sanitized lane
   branches. Acceptance: missing final records, forged summaries, wrong head,
   stale base, truncated logs, checksum mismatch, replay and changed source all
   fail closed. Negative controls induce a type error, lint error, new assertion
   and browser failure; each names its check. No publication behavior changes.
3. **Parity and resource calibration.** Compare cloud and local results for at
   least 20 representative heads across prose-only, no-change, engine, browser,
   runtime/native and dependency changes. Include pre-existing assertion samples,
   two concurrent lanes, cold installs, OOM, lost transport and quota exhaustion.
   Acceptance: no unexplained missing checks or NEW/PRE-EXISTING discrepancies;
   all required rendered artifacts validate; cleanup and fallback are bounded;
   measured P95 fits applicable execution budgets. Record per-head cost/quota,
   local CPU reduction and peak memory; do not substitute SSH-era measurements.
4. **Publication integration.** Add uploaded/unchecked, checking, accepted and
   refused states under existing fences. Let the hook verify exact receipts
   and perform local privacy, preserving manual-push behavior and CI requirements.
   Acceptance: head movement, projection change, changed private inputs, crash
   after upload, lost push reply and restart never authorize a stale head;
   unchecked upload cannot advance a lane; capacity retry and repair behavior
   match current policy. A catalog/import change exercises its required local
   checks. Both Viewer and runtime host are verified on a Bun-pin change.
5. **Retire rented execution.** Observe seven consecutive days with cloud as
   primary, zero SSH gate dispatches, successful local/CI fallback drills and
   complete evidence for every accepted head. Inventory callers of
   `scripts/gate-slot.sh`, direct test/build commands and browser drivers so
   stage agents cannot keep using the old server unnoticed. Disable discovery
   of `gate-runner.json` with a clear migration diagnostic, remove the active
   file from the real machine configuration location (not sandbox HOME), and
   remove SSH-specific overrides from launch environments. Preserve gate-slot
   local admission. Reconcile/cancel all remote jobs, export required sanitized
   evidence, revoke dedicated access and destroy remote caches/workdirs before
   terminating rental billing. Acceptance: no process or workflow depends on
   SSH dispatch, no outstanding job or artifact exists only there, and rollback
   to local gates works without the server. In a later cleanup remove obsolete
   client/server/provisioning code and tests, update `AGENTS.md` and
   `CONTRIBUTING.md`, and mark the remote-runner design superseded. Retain
   historical design evidence.

This sequence changes code in later implementation work. This document leaves
runner behavior and publication policy at their current implementation.

## Operator questions

1. Allow unchecked uploads? Recommend sanitized staging after local privacy,
   blocked from delivery until verified; alternatively keep full local pre-push.
2. Resolve tracked fingerprints and CI? Recommend a sanitized mirror plus local
   enforcement; alternatively migrate the catalog and reachable history first.
3. Set initial concurrency? Recommend three runs per lane, two lanes and two
   test workers per container; alternatively start with one full gate per lane.
4. Grant Cloud authority? Recommend authenticated command records and a local
   verifier; retain advisory status until that channel passes negative controls.
5. Set outage and spending limits? Recommend bounded retries, one local fallback
   and a hard daily allowance chosen after parity measurements; otherwise park.
6. End the rental when? Recommend slice 5's seven-day window and fallback drill;
   earlier retirement keeps local/CI decisive until Cloud meets acceptance.
