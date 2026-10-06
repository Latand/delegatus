# Self-update: apply green merges automatically — design

## Originating requirement

Operator, 2026-09-28, in the orchestrator conversation of this project,
verbatim:

> «Зроби, щоб Delegatus оновлювався сам після зелених мерджів»

In English: "Make Delegatus update itself after green merges."

The orchestrator answered the operator in the same conversation before this
lane started, and the operator did not object: the switch is off by default;
when it is on and `main` has a new commit whose checks are all green, Delegatus
installs it itself, at a moment when that breaks nothing; while work is
running the update waits, and the Update window shows what it is waiting for;
every automatic update is recorded, and a failure rolls back as a manual one
does and turns the switch off with the reason.

The pinned specification adds: the setting is visible in the Update dialog in
English and Ukrainian; "disturbs nothing" is defined from the real release
succession (what restarts, what survives, what must be idle: running pipeline
stages, live agent turns, an operator typing, an update or deployment already
in progress); prefer waiting over interrupting, bound the wait and say why it
waits; the dialog and the update history show an automatic update as such;
checkout installs whose HEAD moved past the release pointer are left alone;
managed installs keep their behaviour unless the same rule applies cleanly.

The originating requirement above is retained. The current delivery contract
is the section below. The original design and implementation sketches that
follow are historical: #2430 delivered bounded drain and #2495 delivered the
coherent launcher apply described in [self-update-every-install.md](self-update-every-install.md).
Those sketches preserve the original reasoning and evidence; their 24-hour
notice, separate manual restarts, and deferred drain policy are superseded.

## Current drain and apply contract

- A selected green automatic target starts a durable drain cohort and holds
  new admission immediately. Work already admitted keeps its custody and can
  finish. The hold covers new pipeline stages, automatic flow rounds, seat
  sends and structured delivery; queued work remains durable.
- The cohort records its target, identity and start time. A newer green tip
  does not replace an owned target. Restart recovery restores the same cohort
  and hold from durable records. An unreadable custody record remains held
  for repair.
- The Update surface shows the actual blockers: running turns and stages,
  operator activity, another update or restart, insufficient memory, and
  unreadable activity. Normal admission still requires the quiet probes,
  fresh green authorization, and the launcher's final checks.
- After **six hours** blocked, a Needs-you decision offers **Deploy now** and
  **Keep waiting**. Replies are operator-only and fenced by the cohort id.
  Keep waiting preserves the hold and waits for normal quiet admission.
  Deploy now permits admission despite activity blockers; it still refuses
  another update/restart, unreadable activity or insufficient memory, and
  retains every green, authentication and health gate. The bound itself
  never forces an interruption. Work that starts after the request is filed
  was never let go and refuses the admission. A refused admission keeps the
  cohort, the decision and the cumulative wait. It puts the previous release
  pointer back while the candidate's directory stays, so the next tick
  publishes the same build again without an install or a build (and without
  waiting for build memory) and then admits the same cohort again.
- Once admitted, the transaction owns custody independently of the automatic
  setting. Turning the switch off stops future admission; accepted work keeps
  its hold through handoff, crashes and rollback until verified settlement.
- A capable checkout or package launcher applies one relaunch request, moving
  the launcher, Viewer and runtime host together. Success requires coherent
  serving identities and health. Rollback retains custody until the prior
  release is coherently serving and verified. The legacy two-request path is
  reserved for launchers without relaunch support; prerequisite actions are
  described in [the install contract](self-update-every-install.md).

The implementation is in `src/lib/selfUpdate/{service,auto,drain,apply}.ts`,
with the launcher handoff in `bin/{launcher-relaunch,self-update-supervisor}.mjs`.
The six-hour bound is `DRAIN_NOTICE_MS` in `drain.ts`.

## Summary of the original decisions (historical, superseded)

- **Green** is read from the pull request that produced the target commit,
  because CI here runs only on pull requests and a commit on `main` carries no
  checks of its own. The target is green when it is the merge commit of a
  merged pull request into the tracked branch, its tree equals the tree of that
  pull request's head, and every check reported on that head has finished with
  none red, the branch's required contexts among them. This is the auto-merge
  runner's rule (`docs/design/merge-policy-and-task-finishing.md` §4.3),
  read through GitHub's public REST API without credentials. Without GitHub,
  without checks, or when GitHub cannot be read, nothing is applied.
- **Quiet** means: no agent turn is live on any engine, no pipeline stage is
  running, no one has touched a Delegatus page for 10 minutes, and no update,
  restart or build is in progress. The rule must hold on two probes a minute
  apart. Web restarts first and the runtime host second, each only when the
  install is quiet.
- **The wait** never interrupts running work. Admission is held briefly while
  the launcher rechecks a restart. Durable queued work resumes after the
  handoff; an incoming write receives a retry response.
  After 24 hours the
  dialog says so, and the orchestrator seat of the install's own project gets
  a signal. On this host, stretches without ten quiet minutes reached 22 hours.
- **The setting** is `<state>/self-update/auto.json`, written only by the web
  process through an operator-only route, and shown as a switch card at the top
  of the Update dialog.
- **Recording** reuses the manual path's own record: the automatic path drives
  the same step runner and the same restart requests, and each run is tagged
  `auto`. A bounded history file lists builds and restarts with who started
  them.
- **Rollback** is the launcher's fallback, the same one a manual restart gets.
  The automatic path then also puts the release pointer back, and turns itself
  off with the reason.
- **Managed installs** keep today's behaviour. There, one deployment couples the
  build and the switch, so a quiet moment at request time does not hold at
  promotion time.
- The launcher checks the final quiet and green authorization before consuming
  an automatic request. Manual restarts keep their existing path.

## Prior work consulted

`search_transcripts` was run for "auto-apply self-update", the quote itself,
"автооновлення", "runtime host restart drops agents structured host survive",
"engine hosts live in Viewer processes", "restart web interrupted agents turn
self-update", "required checks green commit statuses check-runs main",
"\"Restart web\"" and "required checks", project-scoped and unscoped. The hits
were the operator's request and the orchestrator's reply quoted above, plus
unrelated lanes. Nothing earlier designed or discussed automatic updates or
how to read "green" for a commit on `main`. Two existing designs are built
on, and each was checked against current `main`:

- `docs/design/self-update.md` (#2007): the checkout install's step runner,
  release pointer and launcher restart requests. That document lists
  "automatic restart after update", "rollback" and "pruning" as deferred.
  Rollback and pruning come back into scope here for an unattended install.
- `docs/design/merge-policy-and-task-finishing.md` §4.3: "never red, and never
  before the checks have arrived", implemented in `src/lib/forge/autoMerge.ts`.

## What the code and this host say today

Read from the checkout at `ab10f34b9`. Host observations were read-only: files
under the state directory, `/proc`, and anonymous GitHub reads.

| fact | where |
| --- | --- |
| The install checks every 60 minutes, and only after something opened the Update surface. The poll timer is armed by `ensureChecked` and by a finished check; the constructor arms nothing | `src/lib/selfUpdate/instance.ts:21`, `src/lib/selfUpdate/service.ts:131-141,270-286`, `src/lib/selfUpdate/routes.ts:249-261` |
| A check is `git ls-remote` against `CANONICAL_REMOTE` (or `LLV_SELF_UPDATE_REMOTE`), then a fetch into `refs/self-update/tip`. It reports `behind`, `ahead`, `diverged` or `equal`, and offers an update for `behind` and `diverged` | `src/lib/selfUpdate/git.ts:12,118-160`, `src/lib/selfUpdate/checkState.ts:210` |
| "Update" in a checkout runs five steps (fetch, checkout, install, build, ready) in a release directory of its own. `ready` publishes the release pointer. No process is restarted | `src/lib/selfUpdate/steps.ts:122-223`, `src/lib/selfUpdate/service.ts:317-330` |
| A step command has no time limit. `abort()` exists but nothing calls it | `src/lib/selfUpdate/steps.ts:235-253` |
| The pointer counts only while the checkout's HEAD equals the `checkoutHead` recorded when it was published. A checkout moved by hand wins | `src/lib/selfUpdate/release.ts:32-43`, `bin/self-update-supervisor.mjs:87-101` |
| A restart is a request file the web process writes. The launcher polls it every 500 ms, stamps the entry's `requestId`, and restarts that one child from the pointer | `src/lib/selfUpdate/launcher.ts:144-151`, `bin/self-update-supervisor.mjs:181-208`, `bin/cli.mjs:1240-1245` |
| Web restart: SIGTERM, SIGKILL after 2 s, start from the pointer, then readiness (90 s) and a page-and-chunk probe. On failure the previous release is started again and the record says `fell-back` | `bin/cli.mjs:76,874-902,1192-1229`, `bin/self-update-supervisor.mjs:221-235` |
| Runtime host restart: the same stop, start from the pointer, readiness = socket answers and the fence names the new PID, fallback to the previous release, crash backoff after that | `bin/cli.mjs:594-612,727-757` |
| A runtime host that crashes later is restarted from whatever the pointer names at that moment | `bin/cli.mjs:628-645,678-682` |
| **Engine processes are children of the web process.** Claude is spawned `detached` with piped stdio from the web process, and a restarted web process adopts it again with `--resume` | `src/lib/runtime/claudeStreamBrokerHost.ts:699-702,787,795-801`, `src/lib/runtime/registry.ts:532,648`, `src/lib/viewerInstrumentation.ts:961-969` |
| Observed on this host: the web process's children include every `claude` CLI; the runtime host has none | `/proc` |
| The runtime host never signals engine hosts. On SIGTERM it closes its socket server, journal and fence | `src/runtime-host/main.ts:341-353,368-381` ("Engine hosts live in Viewer processes and are never signalled") |
| A web restart severs live turns, and the next web process repairs them. It records `viewer-restart` obligations for severed orchestrator turns and queues continuation turns for interrupted Codex turns. No turn in flight means no obligation and no continuation | `src/lib/runtime/startup.ts:349-368,626-651,1246-1260` |
| When the runtime host is replaced, the web process rebinds its delivery queue and keeps the hosts it holds | `src/lib/runtime/startup.ts:1217-1222` |
| The runtime host's snapshot gives every session's turn axis (`idle`, `running`, `interrupt_requested`, `unknown`) and host axis (`registering`, `hosted`, `recovering`, `unhosted`, `conflict`, `dead`) | `src/lib/runtime/contracts.ts:54-70`, `src/lib/runtime/client.ts:101`, used the same way at startup: `src/lib/runtime/startup.ts:896-899` |
| A pipeline's cursor is `pending`, `spawning`, `running`, `reviewing` or `committing` | `src/lib/pipelines/types.ts:520,525,788`, `src/lib/pipelines/store.ts:1139` |
| Every open page posts presence every 10 s. `lastInteractionAt` moves on `pointerdown`, `keydown`, `touchstart` and `wheel`. The record is mirrored to the state directory and dropped 120 s after the page's last heartbeat | `src/hooks/useViewPresence.ts:299`, `src/lib/view/presenceStore.ts:33-34,244-268` |
| A composer's pending sends and draft attachments live in the page's `sessionStorage`, so a server restart loses neither | `src/components/TmuxComposer.tsx:1081-1177` |
| Background controllers start from one function, and only in the process that owns the release | `src/lib/viewerInstrumentation.ts:391-407,940-973` |
| The dialog's copy tells the operator the **runtime host** restart drops agents and interrupts turns, which the two rows above contradict | `src/lib/i18n/en.ts:4675,4701`, `src/lib/i18n/uk.ts:4565,4591` |
| **CI runs only on pull requests.** Every workflow that reports checks triggers on `pull_request` or `pull_request_target`, and none on a push to `main`. The newest `main` commit had 0 check runs and 0 statuses when read | `.github/workflows/*.yml` |
| `main`'s branch protection requires exactly two contexts, `privacy-publication` and `privacy-tracker-audit` (`strict`). An anonymous `GET /repos/<r>/branches/main` returns them | read 2026-09-28 |
| The newest merged pull request's head had 11 check runs, all completed (9 success, 2 skipped). The combined-status endpoint for the same head answered `state: "pending"` with an empty `statuses` list | read 2026-09-28 |
| For the two newest merge commits on `main`, `GET /repos/<r>/commits/<sha>/pulls` returned the merged pull request, its `merge_commit_sha` equalled the commit, and the commit's tree equalled the tree of the pull request's head | read 2026-09-28 |
| The anonymous REST limit is 60 requests an hour per address | `GET /rate_limit`, 2026-09-28 |
| Release directories are never pruned. There were 14 on this host (4.6 GB counted once across hard links), with 28 GB free on the shared disk | `du`, `df` |
| **The live install's update is wedged.** The persisted record shows `fetch` running since 15:45 UTC, about two hours at the time of reading, with an empty step log and no git process alive. `busy` stays `update`, which also disables the manual Update button | `<state>/self-update/state.json`, `/proc` |
| Idle windows. From pipeline stage attempts over the 7 days to 2026-09-28: 34 gaps of 10 minutes or more with no stage running. Stretches without such a gap reached 22.4 h, 15.2 h, 13.8 h and 12.3 h. Stages are only part of the load (seat turns and the operator's own conversations add more), so real quiet is rarer | pipeline records, read-only |

## 1. What "green" means for the target commit

### 1.1 The target

The target is the tip the check found, and only when the relation is `behind`
(the installed revision is an ancestor of the tip). `diverged` and `ahead` are
left alone (§8). The automatic path never walks back to an older green commit
when the tip is not green. The next merge on top gets a verdict of its own,
and with `strict` protection its pull request's checks ran on a tree that
already contains the earlier commit.

### 1.2 Why green is read from the pull request

A commit on `main` has no checks here, so reading checks on the target itself
would mean either "never green" or, through the combined status, a
permanent `pending`. The checks that vouch for the code on `main` ran on the
pull request that produced it. The rule makes sure they ran on **the same
code** by comparing trees. With `strict` protection the head had to be up to
date with `main`, so a squash or merge commit's tree equals the head's tree.
When the trees differ (an admin override, a non-strict merge, a direct push),
nothing vouches for the exact tree on `main`, and the target is not green.

### 1.3 The reads

`src/lib/selfUpdate/green.ts` (new) reads `<owner>/<name>` of the remote with
`githubRepositoryOfRemote` (`src/lib/forge/workLinks.ts:128`). It makes these
anonymous `fetch` calls to `https://api.github.com`, with
`Accept: application/vnd.github+json`, a 15 s timeout and no credentials:

1. `GET /repos/<r>/commits/<target>/pulls`. It keeps the one pull request with
   `merged_at` set, `base.ref` equal to the tracked branch and
   `merge_commit_sha` equal to the target. None: `no-pull-request`.
2. `GET /repos/<r>/commits/<head>`, which gives `commit.tree.sha`, compared with
   `git rev-parse <target>^{tree}` in the checkout (the check already fetched
   the target into `refs/self-update/tip`). Different: `untested-tree`.
3. `GET /repos/<r>/commits/<head>/check-runs?per_page=100` and
   `GET /repos/<r>/commits/<head>/statuses?per_page=100`, following `Link`
   pagination. The combined `/status` endpoint is never used: it answers
   `pending` for a commit with no statuses at all.
4. `GET /repos/<r>/branches/<branch>` for
   `protection.required_status_checks.contexts`, cached 30 minutes as the
   merge runner caches it (`src/lib/forge/autoMerge.ts:233`). An unprotected
   branch has none.

Check runs and statuses are mapped onto the rollup shape (`name`, `status`,
`conclusion`, `startedAt`, and `context`, `state` for a status) and folded with
the merge runner's own `rollupChecks` (`src/lib/forge/autoMerge.ts:149-178`).
There is one classification of green and red in the repository, and the
self-update module does not have to import the pipeline store that
`autoMerge.ts` imports. So the build moves `checkOf`, `rollupChecks` and the
`RED`/`GREEN` sets into `src/lib/forge/checkRollup.ts`, and `autoMerge.ts`
re-exports them.

### 1.4 The verdict

| verdict | when | final for this target? |
| --- | --- | --- |
| `green` | at least one check; every check finished; none red; every required context present | yes |
| `red` | any check concluded `FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, or a status `error`/`failure`. A red check that protection does not require still counts | yes |
| `no-checks` | the head has no check run and no status | yes |
| `no-pull-request`, `untested-tree` | §1.3 steps 1 and 2 | yes |
| `pending` | a check has not finished, or a required context is missing | re-read at each check. It becomes `checks-timeout` 90 minutes after the first read (`MERGE_WAIT_LIMIT_MS`, `autoMerge.ts:37`) |
| `unknown` | network failure, timeout, a 403/429 rate limit, a 404 (a private repository without credentials), or an answer that does not parse | re-read at the next check, or at `x-ratelimit-reset` when GitHub named one |
| `unavailable` | the remote is not on github.com (a path, another forge, a GitHub Enterprise host) | until the remote changes |

"Required checks green" in the specification is read as "every check green,
the required ones included". Read literally, "required" means only the two
privacy gates here, so a pull request whose tests failed could be merged and
then installed automatically. The operator asked for *green merges*, and the
auto-merge runner already set the same bar.

**Without GitHub** (`unavailable`), the switch is shown disabled with the
remote named. **Without checks** (`no-checks`), a tip is never applied, and
the dialog says so. This matches "a repository without CI never merges
automatically" (merge policy §4.3). **When GitHub cannot be read**
(`unknown`), nothing is applied and GitHub's own words are shown with the
time of the next try. `unknown` never counts as green.

Final verdicts are cached per target in `auto.json` (the last eight) for the
waiting display. The build boundary and both restart admissions bypass that
cache and the required-context cache. A changed or unreadable check defers the
apply. These additional reads can meet GitHub's anonymous rate limit; a limit
response is an `unknown` verdict and waits for a later try.

## 2. What an update restarts, what survives, and the quiet rule

### 2.1 The succession in a checkout install

| part | how an update restarts it | what ends | what survives |
| --- | --- | --- | --- |
| **web** (`next start` from the release directory) | request file → `restartWeb` (`bin/cli.mjs:1192`): SIGTERM, SIGKILL after 2 s, start from the pointer, readiness plus page-and-chunk probe, fallback to the previous release | every engine process of every engine, since their stdio belongs to the web process; with them any turn in flight. Also the in-process controllers (pipeline controller, seat tick, Telegram poller, sweeps), open pages' event streams, any HTTP request in flight (a send, a voice upload), and the self-update service's memory | every conversation (adopted again by id), the runtime host and its durable queue, pipelines, tasks and the board (the state store), composer state in the open page |
| **runtime host** | request file → `createRuntimeHostSupervisor.restart` (`bin/cli.mjs:727`): SIGTERM (`stop()` closes the socket server, journal and fence), SIGKILL after 2 s, start from the pointer, readiness, fallback | the host socket for a few seconds. Every web→host call in that gap fails: runtime snapshots, sends, operation appends, agent MCP calls that go through the host. A host still draining long polls when the 2 s run out is killed, and its journal is recovered as after a crash | every engine process (never signalled), the journal and durable queue (recovered by the next generation), the web process, which rebinds its delivery queue on the new generation |
| **launcher** (`bin/cli.mjs`) | only when the operator restarts Delegatus itself | all children stop as in a normal shutdown | the next launch reads the installed release; a running launcher keeps the version it started as |

Two consequences shape the rule:

- The web restart is the one that cuts agent turns. The dialog's current copy
  says the opposite (§7.4 corrects it).
- Publishing a release already changes what runs next. Once the pointer names
  the new build, a runtime host that crashes restarts onto it
  (`bin/cli.mjs:628-645`). This happens today with every manual build, and
  the automatic path does not make it worse: the time between build and apply
  is the same wait the operator's own button-press leaves.

### 2.2 The rule

`src/lib/selfUpdate/quiet.ts` (new) answers `probeQuiet(now)` →
`{ quiet, blockers }` from four sources, all read in the web process:

1. **No update activity.** The snapshot's `busy` is `null`, no restart
   request of either trigger is outstanding, and the launcher record shows
   both processes `healthy`.
2. **No live agent turn.** The runtime host's snapshot
   (`RuntimeHostClient.snapshot` with a 10 s timeout) has no session whose
   `turn` is `running` or `interrupt_requested`, and none whose `host` is
   `registering` or `recovering`. This covers every engine the host runs
   (Claude, Codex, Copilot), orchestrator seats, deputies, flows and ad-hoc
   conversations alike. A snapshot that cannot be read is a blocker
   ("cannot read what agents are doing").

   A session row is only a claim, because the host that would close a turn is
   the one that can die with it. Each claiming row is therefore judged on the
   record `agent_activity` answers for its conversation
   (`agentLivenessSnapshot`, read by `turnEvidenceReader` in
   `src/lib/selfUpdate/instance.ts`), with `livenessRecordIsLive` as the one
   predicate both surfaces use (#2515):

   - a row whose host is gone never counts, whether its turn was left open or
     had settled; it is reported in `blockers.discounted`;
   - a row counts while its host is alive, while a launch is inside its
     five-minute grace, while its registry row records a process that still
     answers, while a headless reviewer its flow round records answers under
     its exact start identity (`headlessReviewerProcess`), and whenever a host in
     this Viewer holds an active turn for it;
   - a conversation with no transcript to read is judged on its registry row
     alone (`conversationRegistryHost`): a row with no live host releases it at
     once;
   - a row with neither a record nor a registry row is unresolved. It counts
     for five minutes from the first probe that saw it
     (`UNRESOLVED_TURN_GRACE_MS`) and is reported in `blockers.unresolved`
     for as long as it exists;
   - evidence that cannot be read counts.

   A fallback transcript path resolves its canonical owner through the same
   registry generations, continuity paths and aliases as the liveness read.
   That owner's recorded process and current Viewer host remain evidence even
   when the transcript was deleted or the registry's status word lags. Each
   probe reads the journal before judging stages, so a journal artifact path
   also supplies a stage's missing binding. Cached readings include both the
   conversation id and the effective artifact path.

   The rows themselves are corrected at the source: once a minute the
   delivery controller publishes the registry's verdict over a session row
   that still claims an open turn for a conversation the registry proves
   hostless (`settleHostlessSessions` in
   `src/lib/runtime/structuredDeliveryController.ts`). The sweep runs in the
   Viewer, which is the only process that publishes projections, and stays out
   of startup: each ended row costs one keyed session read. A sweep makes at
   most 64 reads. Rows not read yet go first, and what is left of the batch
   reads again the rows read longest ago, so a session row that a late write
   reopens after its first reading is closed on a later sweep. A launch can
   take the conversation while the sweep waits on its read or on its write,
   so the sweep reads the registry row again after the session row, and its
   write names the revision of the session row it read
   (`expectedSessionRevision`). The journal compares that revision inside the
   transaction that records the event and refuses a row that moved, so the
   new owner's `hosted`/`running` row and its active turn stay as written and
   keep blocking the restart. Settlement uses `append-session-fenced`, an RPC
   whose handler requires that revision and enforces it in the journal's
   transaction. During web-first succession, an older runtime host rejects
   the method and the sweep leaves the row as published. It retries after host
   succession on the same socket; it never retries through ordinary `append`
   or caches a capability across host generations.
   Historical alias ids are read under their canonical owner's hostless proof,
   so their journal rows settle even when they carry no artifact path.
3. **No running pipeline stage.** No pipeline in state `running` has a cursor
   in `spawning`, `running`, `reviewing` or `committing`
   (`loadPipelinesForList`). This adds the controller's own work between
   turns: a spawn's setup (up to 5 minutes) and a stage's commit and push.
   `pending` does not block: a pending stage has nothing in flight and may
   wait hours for an account. Only pipelines in state `running` count, so the
   stale `running` attempts left on closed pipelines (five on this host) never
   block. A `running` or `reviewing` stage is judged on the same evidence and
   the same `livenessRecordIsLive` predicate as a turn. It counts while its
   conversation's host is alive, while a launch is inside its grace, while a
   process its registry row records still answers, and while the headless
   reviewer its flow round records answers under the exact start identity
   saved there, with or without a transcript to read. A recorded pid that still
   answers with an absent or unreadable start identity keeps the stage and
   turn counted as `unproven`, including bound rounds. A missing pid adds no
   process evidence to a bound conversation's verdict. Journal and flow owner
   ids follow the same registry aliases, even when the journal has no artifact
   path. A turn no process owns
   that did not settle (open, or with no readable turn state) releases the
   stage at once: nothing is left to finish it, and the engine replaces the
   attempt after the restart. That covers a host that is gone and a transcript
   that aged out of its launch grace with no host ever recorded. A turn no
   process owns that did settle leaves the controller a verdict to read, so it
   holds the stage for five minutes from the first probe that saw it and is
   counted in `blockers.settled` for as long as it lasts. A registry row that
   proves the host gone releases the stage when the transcript cannot be read,
   and a conversation nothing resolves holds it for the same five minutes
   (`blockers.unresolved`). A `reviewing` stage also asks about the reviewer
   of its flow's newest round, because the attempt takes that round's binding
   only on the pipeline's next pass: a live reviewer there, or a launch that
   has started and names no conversation yet, keeps the stage counted. A
   stored round may record its headless process before it names a
   conversation. That process then answers for the round
   (`headlessRoundProcess`): while it answers under the saved start identity
   the stage counts for as long as it runs, and once the pid is gone or
   answers under another start identity the round has no owner, whatever
   launch marker is left beside it. A pid with no saved identity proves
   nothing and keeps the stage counted.
   Process ownership follows the recorded reviewer across `needs_decision`
   and `paused`, including when the attempt still names the previous round.
   It also follows the reviewer into `relaying`: the flow can read findings
   before that process exits. A relay waiting for admission discounts only
   its next action after checking existing owners. A live or unproven owner
   keeps the stage counted; a settled dead owner needs no collection grace
   for an action already held, and an unresolved owner retains the same
   five-minute diagnostic bound. An undispatched action with no owners
   leaves the drain quiet.
   The review attempt remains bound to its reviewer during findings relay and
   fixing. The stage also reads its implementer through the same liveness
   evidence, including legacy flows that only name a transcript path and parked
   fixing continuations. A live implementer keeps the stage protected after
   the reviewer dies; proven absence releases it, with the existing five-minute
   bound for settled or unresolved owners. An accepted relay keeps custody
   before any implementer turn starts, until the flow controller records
   settlement or clears the attempt through its bounded delivery retry path.
   The admission fence includes implementer binding and relay settlement so
   either changing during an awaited probe invalidates that probe.

   The same headless process verdict is projected into `agent_activity` and
   used when a transcript cannot be read. A bound reviewer's proven death or
   replaced start identity releases its turn and stage immediately, even with
   a fresh `starting` registry marker. A current live or unproven replacement
   process remains protected. An unproven recorded reviewer does not age out
   through the grace intended for launches with no process evidence.
4. **No operator activity.** No presence record (`listPresence`) has
   `lastInteractionAt` in the last 10 minutes. Presence covers every signed-in
   member, desktop and phone. A closed page drops out after 120 s.

The install is **quiet** when there are no blockers. A restart is requested
only when two probes at least 60 s apart were both quiet. The web process then
holds new admission, refreshes green, and makes one more quiet probe. The
launcher repeats both reads before consuming the automatic request.

### 2.3 Why this is safe

- **Engines.** With no turn in flight, an engine process holds nothing that its
  conversation needs. The next web process adopts it again by id. Startup
  records interruption obligations only for severed turns and queues
  continuations only for interrupted ones (`startup.ts:349-368,626-651`), so
  a quiet restart creates neither, and no paid "continue" turn follows.
- **Controllers.** The pipeline controller, the seat tick and the other sweeps
  keep their state in the store and are started again by the next web process
  (`startCurrentReleaseControllers`). Rule 3 keeps a spawn setup or a stage
  commit from being cut halfway.
- **The operator.** Rule 4 means no send, recording or dialog is in flight
  from a person. What an open page holds stays in the page. A page that stays
  open across the restart is told to reload (§7.5).
- **The runtime host.** Its restart signals no engine. The few seconds in which
  host calls fail matter only to a turn or a send in flight, and rules 2 and 4
  exclude both.
- **Two probes a minute apart** keep the restart out of the one-second gap
  between two turns of a sequence (a stage settling and the next one
  spawning, a flow between rounds, a seat relaying a message).

The admission gate stays in the state directory through the restart. The
proxy defers new writes, the pipeline and seat controllers pause their ticks,
and structured delivery leaves new turns in its durable queue. Work already
admitted before the gate is checked by the final quiet reads. If it began, the
launcher discards the request and releases the gate; the next quiet window can
try again. A gate has a five-minute upper bound if the launcher disappears.

### 2.4 Original order: web first, then the runtime host (historical)

Each restart waits for its own quiet moment. Web goes first because:

1. It matches the managed succession, which promotes web and then hands the
   host over. "New web, old host" is the transitional state every managed
   deployment already goes through.
2. It matches the manual guidance the dialog already gives
   (`selfUpdate.applied.none`: "Restart web, then the runtime host").
3. If web fails, the automatic path stops before touching the host.

The cost is that the web restart replaces the very process that runs the
automatic path. §4 is written so that the next process carries on from the
files on disk.

## 3. The wait and its bound

The current [drain and apply contract](#current-drain-and-apply-contract)
holds new admission as soon as a green target owns a cohort. Existing admitted
work finishes under that cohort's custody. Blockers remain visible while the
hold is active.

After six hours blocked, the operator chooses Deploy now or Keep waiting in
Needs-you. The decision is fenced by the cohort identity and preserves the
security and health checks described above. Keep waiting retains the hold;
the bound alone takes no disruptive action. A newer tip cannot silently
replace the cohort's owned target.

The original design used a 24-hour notice, based on an observed 22.4-hour busy
stretch, and deferred drain. #2430 superseded that policy with immediate drain
and the six-hour operator decision.

## 4. The original automatic run (historical, superseded)

### 4.1 Where it runs

`src/lib/selfUpdate/auto.ts` holds the durable setting and request helpers;
the decision loop is in the service. The loop starts from
`startCurrentReleaseControllers` through a new loader,
`loadSelfUpdateAuto: () => import("@/lib/selfUpdate/auto")`. Only the process
that owns the release runs it: never a lane's `next build`, an MCP stdio
process or the runtime host. While the setting is on, the service schedules
its own check at boot, and the poll interval becomes 15 minutes
(`pollMinutes` in the snapshot follows, so the footer says so). A check is one
`git ls-remote`, and the GitHub reads happen only for a new tip. While a built
target waits, the loop probes every 60 seconds. When the setting is off and
nothing is outstanding, the loop does nothing, and the install behaves exactly
as today.

### 4.2 Level-triggered on facts, so a restart in the middle loses nothing

Each tick reads facts from disk and from the processes, and never trusts
memory:

- the setting and its `off` reason (`auto.json`);
- the mode decision and the check slice;
- the green verdict for the target;
- the runner's state;
- the pointer (`installed`);
- the launcher record: each process's `revision`, `state`, `error` and
  `requestId`;
- the outstanding restart request, if any, persisted in `state.json` before
  the request file is written;
- the quiet probe;
- `MemAvailable`.

| facts | action |
| --- | --- |
| setting off, or availability not `available` (§8) | nothing |
| check `update-available`, relation `behind`, no verdict for the tip or verdict `pending`/`unknown` due | read green (§1) |
| tip `green`, not built (`installed.sha ≠ tip`), nothing busy, ≥ 4 GB available | start the runner on the tip with `trigger: "auto"` |
| built, web does not serve it, no request outstanding | probe; when quiet twice (§2.2), persist the request, then `requestRestart(record, "web")` |
| web serves it, the runtime host does not | the same for `"runtime-host"` |
| both serve it | write the history entry, clear the wait clock, prune (§6.3) |
| an outstanding request whose role's record entry carries its `requestId` and is `healthy` with no error | settled: history entry, then the next row applies |
| … carries it with `error.kind: "fell-back"`, or `state: "failed"` | failure (§5) |
| outstanding past its deadline (web 5 min, host 3 min) and never taken | failure: "the launcher did not take the restart request" |
| outstanding, but the launcher record is a new one (its launcher PID changed: Delegatus was restarted whole) | drop the request and read the facts again. If both processes now serve the target, the update was applied by that restart |

The operator may act at any point: press Update, restart web or the host by
hand, or turn the switch off. Each of these only changes the facts, and the
next tick follows them. When the operator restarts by hand onto a target the
automatic path built, the history says it was the operator.

### 4.3 Deadlines, and why the step runner gets them

A step that never returns wedges both paths, and that happens today on this
host. The runner gets per-step deadlines for both triggers: fetch 10 min,
checkout 5 min, install 20 min, build 45 min. A local install and build took
about 10 minutes. At the deadline the runner calls `abort()`, which signals
the step's own process group only (`steps.ts:251`, recorded PID and start
identity). It then settles the step as failed with a new
`StepFailure` `{ kind: "timeout", minutes }` even if the awaited promise never
resolves, and ignores a late resolution through a run generation counter.
The runner also checks the recorded child process while a command is pending.
If that process has gone away without settling the step, the same web process
marks the step `interrupted` and offers retry. This covers a dead child before
the deadline without touching any other process.

### 4.4 Deferrals and failures

Three step failures mean "not now" and leave the setting on. The next check
tries again (the runner's `retry()` resumes at the failed step):
`remote-moved` (a newer tip exists), `memory` (the 4 GB guard), and
`interrupted` (the web process went away mid-build). Every other failure turns
the setting off (§5): an exit code, `head-mismatch`, `build-id-missing`,
`timeout`, a restart that fell back or failed, or a request never taken.

Automatic builds run their commands at a lower CPU priority
(`os.setPriority(pid, 10)` right after each spawn), so a build does not take
the machine from the agents' own test runs. Manual builds are unchanged.

## 5. Failure and rollback

The rollback is the launcher's fallback, the same for both triggers. A web or
host restart whose new release does not come up starts the release it
replaced again (`bin/cli.mjs:1217-1223,744-756`). A build that fails never
moved the pointer and restarted nothing. The automatic path then does two
things a person at the dialog would do:

1. **It puts the release pointer back** on the release the web ran when the
   automatic web restart was requested. That rollback target is recorded in
   `state.json` with the request: the pointer that named the running release,
   or "no pointer" when the web ran the checkout itself, in which case the
   pointer file is removed. Without this step, a runtime host crash hours
   later would restart onto the release that just failed
   (`bin/cli.mjs:628-645`), with nobody watching. The manual path keeps
   today's behaviour (Deferred).
2. **It turns the setting off** with the reason:
   `off: { at, target, stage: "build" | "restart-web" | "restart-host",
   reason }`. The reason is the step failure, the launcher's `fell-back`
   detail, or the deadline. The dialog shows it until the operator turns the
   switch on again. Turning it on clears the reason and may retry the same
   target. The seat tick signal names the failure once:
   `self-update: automatic updates turned off — <reason>`.

When web succeeded and the host fell back, the install runs the new web on the
old host, the state a manual restart leaves in the same case. The pointer goes
back, and the dialog's web block offers "Restart web", which now restarts onto
the previous release.

## 6. Recording and history

### 6.1 The run is recorded like a manual one

The automatic path drives the same `UpdateRunner` and the same
`requestRestart`. The step logs, the persisted `UpdateState`, the launcher
record and the dialog's step list are the manual path's own. `UpdateState`
gains `trigger: "operator" | "auto"`. The Update section says "Started
automatically" on a run the automatic path began.

### 6.2 History

`<state>/self-update/history.jsonl` (new) gets one line per finished build and
per settled restart, from either trigger:
`{ at, by: "operator" | "auto", kind: "build" | "restart-web" |
"restart-host", target, from, outcome: "done" | "failed" | "fell-back",
detail }`. Restart outcomes are written by whichever web process sees the
request settle: the manual path's pending restart moves from memory
(`service.ts:125`) into `state.json` for this. The snapshot carries the last
20 entries. When the file passes 1 000 lines, it is rewritten with the last
500.

### 6.3 Pruning, now that nobody presses the button

With updates arriving by themselves, release directories pile up on a shared
disk (14 of them, 4.6 GB, in the facts table). After an automatic apply settles, release directories under
`releasesDir` are removed except the ones web and the runtime host run, the
pointer's, the rollback target's, and the newest remaining one. Removal is
`git worktree remove --force <dir>` from the checkout, followed by
`git worktree prune`. A directory that is not a registered worktree of this
checkout is never touched, and nothing is removed by an ad-hoc recursive
delete. Manual-only installs keep today's behaviour (Deferred).

## 7. The setting and the dialog

### 7.1 Storage

`<state>/self-update/auto.json`, beside `state.json` and `managed.json`,
written atomically (temp file and rename) by the web process only:

```json
{
  "version": 1,
  "enabled": false,
  "changedAt": null,
  "off": null,
  "green": {},
  "waitingSince": null,
  "waitingTarget": null,
  "lastBlockers": null,
  "quietSince": null,
  "noticeAt": null
}
```

A missing or unreadable file reads as off. The outstanding request and its
rollback target live in `state.json` as `autoPending`,
`autoRollbackPointer` and `autoRollbackCaptured`, beside the update they
belong to. They are written synchronously before the request file.

### 7.2 Route

`POST /api/self-update/auto` with `{ enabled: boolean }` goes through the same
operator gate as every mutating self-update route (`rejectCrossOrigin`, then
`requireOperatorAuthority`, `src/lib/selfUpdate/routes.ts:213-218`), so an
agent cannot turn it on. It answers 202 with the snapshot, or 409
`auto-unavailable` with the availability reason. Turning it off stops at the
next phase boundary. A build in progress finishes as a built release that the
operator can restart onto by hand, and a restart already requested completes.

### 7.3 Snapshot

```ts
auto: {
  availability: "available" | "managed" | "packaged" | "launcher-upgrade" | "not-github" | "hand-managed" | "diverged";
  enabled: boolean;
  off: { at: string; target: string; stage: "build" | "restart-web" | "restart-host"; reason: AutoOffReason } | null;
  phase: "idle" | "checks" | "not-green" | "building" | "waiting" | "restarting-web" | "restarting-host";
  target: Revision | null;
  green: GreenVerdict | null;
  blockers: { turns: number; stages: number; operatorActiveAt: string | null; busy: boolean; memoryMb: number | null; unreadable: string | null } | null;
  waitingSince: string | null;
  longWait: boolean;
};
update: UpdateState & { trigger: "operator" | "auto" | null };
history: HistoryEntry[];
```

### 7.4 Dialog

A new card, `data-section="auto"`, sits full width under the header on both
layouts, above the columns on desktop and before the process blocks on the
phone. It has one switch row, reusing `ProjectSettingRow` with
`variant="inline"` (`src/components/ProjectSettingRow.tsx:11`; 44 px target on
coarse pointers through its `sheet` sizing), and one state line under it.
Blockers go in a short list under the state line. The danger line for an `off`
reason uses the dialog's existing `ERROR_LINE` style. A "History" card
(`data-section="history"`) goes last in the left column on desktop and last
on the phone: one row per entry, with time, "automatic" or "by you", what
happened, and the SHA in mono.

Copy (new keys under `selfUpdate.auto.*` and `selfUpdate.history.*`,
Ukrainian plurals in `one`/`few`/`many`/`other`):

| state | English | Українська |
| --- | --- | --- |
| label | Update automatically | Оновлювати автоматично |
| off | Off. Updates wait for you to press Update. | Вимкнено. Оновлення чекають, поки ви натиснете «Оновити». |
| on, nothing to do | On. Green merges to {branch} are built and installed when nothing is running. | Увімкнено. Зелені мерджі в {branch} збираються й ставляться, коли нічого не працює. |
| checks pending | Waiting for the checks of {sha}: {done} of {total} finished. | Чекаю на перевірки {sha}: завершено {done} з {total}. |
| red | {sha} is not installed: {check} failed on its pull request. | {sha} не ставлю: перевірка {check} у його пул-реквесті не пройшла. |
| no checks | {sha} is not installed: no checks ran on its pull request. | {sha} не ставлю: у його пул-реквесті не запускалася жодна перевірка. |
| no pull request | {sha} is not installed: it did not come from a merged pull request. | {sha} не ставлю: він з'явився не з мерджу пул-реквесту. |
| untested tree | {sha} is not installed: its code differs from what the checks tested. | {sha} не ставлю: його код відрізняється від того, що перевіряли. |
| checks timeout | {sha} is not installed: its checks did not finish in 90 min. | {sha} не ставлю: перевірки не завершилися за 90 хв. |
| unknown | Could not read the checks of {sha}: {detail}. Next try at {time}. | Не вдалося прочитати перевірки {sha}: {detail}. Наступна спроба о {time}. |
| building | Building {sha} automatically. | Збираю {sha} автоматично. |
| waiting | {sha} is built. Waiting for a quiet moment since {time}: | {sha} зібрано. Чекаю на тиху хвилину з {time}: |
| blocker: turns | {count} agent turn running / {count} agent turns running | працює {count} хід агента / ходи / ходів / ходу агентів |
| blocker: stages | {count} pipeline stage running / stages | працює {count} етап пайплайна / етапи / етапів / етапу |
| blocker: operator | you were active {minutes} min ago | ви були активні {minutes} хв тому |
| blocker: busy | an update or restart is in progress | триває оновлення або перезапуск |
| blocker: memory | less than 4 GB of free memory ({mb} MB) | вільної пам'яті менше 4 ГБ ({mb} МБ) |
| blocker: unreadable | cannot read what agents are doing: {detail} | не вдається прочитати, що роблять агенти: {detail} |
| long wait | Has waited over 24 h. It installs at the next quiet moment; to install it now, restart web and then the runtime host. | Чекає понад 24 год. Поставиться в найближчу тиху хвилину; щоб поставити зараз, перезапустіть веб, а потім runtime host. |
| restarting web | Restarting web onto {sha}… | Перезапускаю веб на {sha}… |
| restarting host | Restarting the runtime host onto {sha}… | Перезапускаю runtime host на {sha}… |
| applied | Installed {sha} automatically at {time}. | {sha} поставлено автоматично о {time}. |
| turned off | Turned off at {time}: {reason}. Turn it on to resume. | Вимкнено о {time}: {reason}. Увімкніть, щоб продовжити. |
| reason: build | {sha} did not build: the {step} step failed | {sha} не зібрався: крок «{step}» не пройшов |
| reason: timeout | the {step} step did not finish in {minutes} min | крок «{step}» не завершився за {minutes} хв |
| reason: web fell back | web did not start on {sha}, so {old} runs again | веб не запустився на {sha}, тож знову працює {old} |
| reason: host fell back | the runtime host did not start on {sha}, so {old} runs again | runtime host не запустився на {sha}, тож знову працює {old} |
| reason: not taken | the launcher did not take the restart request | лаунчер не прийняв запит на перезапуск |
| unavailable: managed | Not available on a managed install: each update is a deployment you start. | Недоступно для керованої інсталяції: кожне оновлення — це розгортання, яке запускаєте ви. |
| unavailable: launcher upgrade | Restart Delegatus from the terminal to upgrade its launcher before enabling automatic updates. | Перезапустіть Delegatus із термінала, щоб оновити лаунчер перед увімкненням автооновлень. |
| unavailable: not GitHub | Not available: checks can only be read from a GitHub remote, and this install tracks {remote}. | Недоступно: перевірки можна прочитати лише з GitHub, а ця інсталяція стежить за {remote}. |
| paused: hand-managed | Paused: the checkout moved since Delegatus last updated it, so it is updated by hand. Update once from this window to resume. | Призупинено: чекаут змінився після останнього оновлення з Delegatus, тож його оновлюють вручну. Оновіть один раз із цього вікна, щоб продовжити. |
| paused: diverged | Paused: this checkout has commits that are not on {branch}. | Призупинено: у цьому чекауті є коміти, яких немає в {branch}. |
| started automatically (Update card) | Started automatically. | Запущено автоматично. |
| history heading | History | Історія |
| history: by | automatic / by you | автоматично / вручну |
| history rows | Built {sha} · Web → {sha} · Runtime host → {sha} · failed · fell back | Зібрано {sha} · Веб → {sha} · Runtime host → {sha} · не вдалося · повернуто попередню |

Corrections to existing copy, because the new card explains restarts and must
not contradict the cards beside it:

| key | now | becomes (en / uk) |
| --- | --- | --- |
| `selfUpdate.process.hostWarning` | the runtime host restart "drops the agents it supervises" | Restarting the runtime host pauses message delivery for a few seconds; agents keep running. / Перезапуск runtime host на кілька секунд зупиняє доставку повідомлень; агенти продовжують працювати. |
| `selfUpdate.confirm.text` | "stops every agent it supervises…" | For a few seconds nothing is delivered and the board shows the runtime as unavailable. Agents keep running. / Кілька секунд нічого не доставляється, а дошка показує runtime недоступним. Агенти продовжують працювати. |
| new `selfUpdate.process.webWarning` (web block) | — | Restarting web ends the agent turns in progress; their conversations are picked up again when it is back. / Перезапуск вебу обриває ходи агентів, що тривають; розмови підхопляться, коли він повернеться. |
| `selfUpdate.update.note` with the setting on | "Nothing restarts until you choose to." | This builds the new version. With automatic updates on, web and the runtime host restart onto it at the next quiet moment. / Це збирає нову версію. Коли автооновлення увімкнене, веб і runtime host перезапустяться на неї в найближчу тиху хвилину. |

### 7.5 A page open across an automatic restart

The Viewer is one page, and Next only handles version skew on navigation
(`deploymentId` triggers a hard reload when a navigation response comes from
another build), so a page left open keeps its old client code against the new
server. The presence answer (`POST /api/view/presence`) gains `serving`, the
short SHA of the release the answering web process runs, read once per
process. `useViewPresence` keeps the first value it sees. When a later answer
differs, the Viewer shows one row with the existing sentence and button
(`selfUpdate.reconnect.newVersion`, `selfUpdate.reconnect.reload`) on desktop
and phone. No page reloads by itself.

### 7.6 Rendered evidence

No new driver. The build adds:

- a `self-update-auto` case to `scripts/capture-board-geometry.ts`. It serves
  fixture snapshots through the read-only Update API in an isolated browser,
  opens the dialog, and measures overflow and clipped controls at 1440 and
  390, in English and Ukrainian. The frames cover off, waiting with three
  blockers, long wait, web fallback and managed-unavailable; the DOM tests
  cover the other states. No capture can issue a restart;
- one `describe` block each in the kanban and phone browser drivers for the
  reload row of §7.5.

## 8. Install modes

| install | automatic updates |
| --- | --- |
| checkout, pointer valid or never published, relation `behind` | available |
| checkout whose HEAD moved since the pointer was published (`checkoutHead` in the pointer file differs from HEAD) | left alone, "paused: hand-managed". An Update from the dialog republishes the pointer at the current HEAD, and the switch resumes by itself |
| checkout `diverged` or `ahead` | left alone, "paused: diverged". Installing the remote tip would stop running the local commits |
| remote not on github.com | "not available: not GitHub" (§1.4) |
| managed (Docker, runtime-host deployments) | today's behaviour, the switch disabled with its reason. One deployment builds the image and then promotes web and hands the host over within minutes. A quiet moment at request time does not hold at promotion, and there is no gate that makes promotion wait for quiet. The web promotion there also releases structured hosts with interruption obligations (`src/lib/viewerInstrumentation.ts:936-939,992-997`), so it cuts turns just like a checkout web restart. Applying the rule cleanly needs a "promote when quiet" phase in the deployment coordinator (Deferred) |
| packaged, or unsupported | no switch: the dialog shows only its existing message |

## 9. State ownership, processes and sockets

- Everything that writes state runs in the web process under
  `LLV_STATE_OWNER=viewer`, from `startCurrentReleaseControllers` or an
  operator request. That covers `auto.json`, `state.json`, `history.jsonl`,
  the pointer on rollback and the prune. The loop starts after the release
  fence activated this process (`viewerInstrumentation.ts:940-973`), so a
  build, a test or a second process never runs it. No import, migration or
  first-boot step is added, so nothing new needs
  `assertStateStartupMutation`. Every module reads the state directory on
  first use, after the module has loaded (#1905).
- No new process, listener or socket is added. GitHub reads are outbound
  `fetch` calls, the quiet probe uses the existing runtime-host client, and
  the presence change adds one field to an existing answer. The rule "a
  failing socket write is a connection event" has nothing new to cover.
- The launcher advertises `launcher.autoAdmission: 1` in its record only when
  it checks `autoGateId` and calls the final admission endpoint before either
  restart. The web service refuses to enable or issue an automatic request
  without that exact capability. A manual web or host update leaves the
  already-running launcher on its old code, so the dialog asks the operator
  to restart Delegatus from the terminal once. The web service never restarts
  the launcher itself. Presence heartbeats still reach the authenticated route
  while admission is held, so typing during the final GitHub read blocks the
  restart; other new work remains held by the gate.

## 10. Test plan

Every test runs by path, under an isolated `LLV_STATE_DIR` (and `HOME`/`TMPDIR`
under the test temp root where a checkout is cloned):

```
LLV_STATE_DIR="$(mktemp -d)/state" bun test <the files below>
```

No run sweeps `src/lib/agent/` or `src/app/api/runtime/`. No test reaches the
live runtime host, the live launcher record or the network: GitHub is a fake
`fetch`, and the runtime snapshot, pipelines and presence are injected. No lane
turns the switch on for the live install or restarts it. The operator does
that from the dialog.

1. `src/lib/forge/checkRollup.test.ts` (moved cases, plus REST shapes): a
   REST check run (`status: "completed"`, `conclusion: "skipped"`) is green; a
   status `error` is red; newest run per name wins; and `autoMerge.test.ts`
   still passes unchanged.
2. `src/lib/selfUpdate/green.test.ts` (new). Fixtures are trimmed REST answers
   holding only the fields read, with no logins, emails or avatars. Cases:
   merged, equal tree, all green → `green`; a head with no statuses (combined
   `pending`) but green check runs → `green`; a red non-required check →
   `red` naming it; skipped and neutral pass; one in progress → `pending`,
   and 90 minutes after the first read → `checks-timeout`; a required context
   absent → `pending`; no merged pull request → `no-pull-request`; a
   `merge_commit_sha` for another commit → `no-pull-request`; different trees
   → `untested-tree`; zero checks → `no-checks`; 403 with
   `x-ratelimit-remaining: 0` → `unknown` with the reset time; 404 →
   `unknown`; a path remote and a non-GitHub host → `unavailable`;
   pagination over 100 check runs; a normal cached read stays cached, while a
   fresh admission read bypasses it and refreshes required contexts.
3. `src/lib/selfUpdate/quiet.test.ts` (new). A `running`, an
   `interrupt_requested`, a `registering` and a `recovering` session each
   block. `idle`, `unhosted`, `dead`, and `unknown` on a hosted session do
   not. A running pipeline with each cursor state: `spawning`, `running`,
   `reviewing` and `committing` block, `pending` does not. A closed pipeline
   with a stale running attempt does not. Presence 9 minutes old blocks, 11
   minutes old does not. A snapshot read that throws blocks with its message.
   An outstanding request and a launcher entry in `starting` block.
4. `src/lib/selfUpdate/auto.test.ts` (new), sequences on a fake clock. Off → nothing. Green and not
   built → build with `trigger: "auto"`. Built and busy → wait with the
   blockers and `waitingSince`. One quiet probe → no request; two probes 60 s
   apart → a web request persisted **before** the request file exists. A fresh
   service over the same files (the new web process) with the record's web
   entry carrying the request id, healthy, on the target → host request once
   quiet again. Host settled → history entry and prune call. Web `fell-back`
   → setting off with the reason, pointer restored to the recorded rollback
   target, pointer file removed when that target was the checkout, no host
   request. Host `fell-back` → off, pointer restored. A request not taken in
   5 min → off. A new launcher PID → request dropped, facts re-read. A newer
   green tip while waiting → rebuild, `waitingSince` unchanged. 24 h waiting →
   `longWait` and one `noticeAt`. `remote-moved`, `memory` and `interrupted`
   leave the setting on. Hand-managed, diverged, managed and not-GitHub →
   the matching availability and no action. The operator restarting by hand
   onto an automatically built target → the history says "operator".
5. `src/lib/selfUpdate/steps.test.ts` (extended). A `run` that never resolves
   → the step fails `timeout` at its deadline, `abort` is called once, a late
   resolution changes nothing, and `retry` works after it. The automatic
   trigger lowers the priority of the spawned PID, and the manual one does
   not.
6. `src/lib/selfUpdate/routes.test.ts` (extended). `POST /api/self-update/auto`
   refuses a cross-origin request and a caller presenting an agent capability;
   `{enabled: true}` in checkout mode writes `auto.json` and answers 202;
   managed → 409 `auto-unavailable`; turning on clears `off`; a malformed
   body → 400.
7. `src/lib/selfUpdate/history.test.ts` (new). Append, the bounded read of 20,
   the rewrite at 1 000 lines, and a torn last line is skipped.
8. `src/lib/monitor/seatTickSources.test.ts` (extended). The signal appears
   for the install's own project only: once after 24 h, and once for an `off`
   reason.
9. `src/lib/viewerInstrumentation.test.ts` (extended). The new loader is
   called from `startCurrentReleaseControllers`, and a failure in it is logged
   without stopping the other controllers.
10. `src/components/selfUpdate/SelfUpdateView.dom.test.tsx` (extended). The
    auto card in every state of §7.4 in both languages; the switch disabled
    with the reason when unavailable; the history rows; the corrected host
    and web warnings.
11. The presence route's test and `useViewPresence`'s test (extended).
    `serving` is answered; a change shows the reload row once.
12. Rendered evidence (§7.6) at 1440 and 390, en and uk, attached as
    `evidence/**/*.json` geometry with the frames.

`bun scripts/privacy-publication-gate.ts --base <merge-base>` runs before the
push. Fixtures are re-read by hand for identities.

## 11. File fence for the build

`src/lib/forge/checkRollup.ts` (new, moved out of `autoMerge.ts`),
`src/lib/forge/autoMerge.ts` (re-export only), `src/lib/selfUpdate/{green,quiet,auto,history}.ts`
(new), `src/lib/selfUpdate/{service,instance,routes,steps,types}.ts`,
`src/app/api/self-update/auto/route.ts` (new),
`src/lib/viewerInstrumentation.ts` (one loader),
`src/lib/monitor/seatTickSources.ts` (one signal),
`src/app/api/view/presence/route.ts` and `src/hooks/useViewPresence.ts`
(`serving`), the reload row's component,
`src/components/selfUpdate/SelfUpdateView.tsx`, `src/lib/i18n/{en,uk}.ts`,
the tests above, the driver cases, `CHANGELOG.md` (`[Unreleased]` → Added). No
change to `bin/`, `src/runtime-host/`, `Dockerfile` or `package.json`.

The work can land as one pull request in three commits: reading (checkRollup,
green, quiet, with their tests), the automatic path (service, auto, history,
route, deadlines, rollback, prune, signal), and the surface (dialog, copy,
reload row, evidence).

## Original deferred list (historical)

- **Drain was delivered by #2430.** Immediate admission hold, durable cohort
  custody and the six-hour operator choice follow the
  [current contract](#current-drain-and-apply-contract).
- **Interrupting at the bound.** The specification prefers waiting.
- **Managed installs.** They need a "promote when quiet" phase inside the
  runtime host's deployment coordinator, which holds a built, health-checked
  candidate until §2.2 holds. That touches the release succession itself and
  deserves its own design.
- **Walking back to the newest green ancestor** when the tip is not green.
  The next green merge carries the same code.
- **Authenticated GitHub reads** (private repositories, a higher rate limit),
  and forges other than github.com.
- **The long-wait Needs-you item was delivered by #2430.** It carries the
  Deploy now / Keep waiting decision under the current drain contract.
- **Restoring the pointer after a manual restart falls back**, and **pruning
  on manual-only installs.** Both are the operator's to see today. They could
  share the automatic path's code later.
- **Reloading an idle page by itself** after an update.
- **An MCP read of the automatic state** for orchestrators
  (`deployment_status`).
- **The launcher updating itself** (unchanged from `self-update.md`).

## Validation against the requirement

"Make Delegatus update itself after green merges": with the switch on, a
checkout install notices a new commit on its branch within 15 minutes. It
installs the commit only when the merged pull request that produced it passed
every check on the same code, builds it without touching what runs, and moves
web and then the runtime host onto it at the next moment when no agent turn,
pipeline stage, person or update is in flight. It records what it did as the
manual path records it, marked automatic. A failure falls back as a manual
restart does, puts the pointer back, and turns the switch off with the reason.

The measured cost is lag. On a heavily used install the next quiet moment can
be most of a day away. The design says so in the dialog and to the
orchestrator, and leaves running work alone. Managed installs keep
their button, for the reason in §8.
