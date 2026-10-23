# Automatic releases

## Originating requirement

The operator, 2026-10-12 about 08:05 Kyiv time, to the Delegatus orchestrator
seat (Russian), verbatim:

> «Я думаю, пора опять релиз запускать. И вообще, нужен какой-то механизм,
> чтобы это автоматически делалось, ну, с каким-то количеством обновлений или
> с каким-то характером обновлений, чтобы у нас запускался агент, который делал
> бы релиз, писал бы changelog правильно и так далее, и так далее.»

An earlier request on the same subject, 2026-10-02, to the seat (Ukrainian),
recorded in the seat's memory: «ти забуваєш робити релізи … потрібна логіка і
прийняття рішення тобою коли робити і паблішити реліз».

Acceptance, from the pinned specification (design only; the build follows the
operator's answers):

- **Trigger.** A rule over the amount and kind of change since the last tag,
  justified from the last three releases and the PRs between them. Each PR is
  classified as user-visible, internal or docs, and the doc says which evidence
  is reliable.
- **Blockers.** Never release while main's required checks are red, a
  production incident is open or a known regression sits on main (today's
  #2714 before #2762), a release is already in flight, or the merge setting or a
  project setting disables releases. Say how each is detected.
- **The release agent.** A pipeline on a «release» board task: changelog from
  merged PRs, grouped for users, public-safe; version bump; release PR; review;
  merge; tag; watch `publish.yml`; verify npm, Docker and the install check;
  report. Reuse existing roles. Decide whether the first automatic releases
  need an operator «go» and how that relaxes.
- **Where the controller lives** (seat tick wake item or its own timer) and how
  the operator turns it off or sets thresholds: one setting, consistent with
  the worker-limit settings work (lane 443238cf).
- At most five operator questions, each with a recommendation.

## Status

Decided. The operator answered the four questions of §10 on 2026-10-12 (about
09:00Z, through the questionnaire on this task), and this document carries those
answers: a release at 30 user-visible changes and at most two a day, a «go»
asked every time until the operator switches it off, only what production has
run for 6 hours, and the README screenshots retaken in every release. The
options that were not chosen are kept under Deferred.

## Summary

- **Trigger.** When the release cut holds at least `minChanges` (30 by default)
  user-visible PRs since the last tag, and at least `minGapHours` (12 by
  default) have passed since that tag, so at most two releases fall in a day.
  The seat or the operator can ask for a release now, which skips the count and
  the gap and keeps every blocker. Replayed over 2026-10-01 to 2026-10-12 the
  rule gives eight releases of 30 or 31 user-visible PRs each, 14 to 63 hours
  apart.
- **The cut.** A release carries what production on this machine has served for
  6 hours with no rollback past it. The tag goes on the reviewed head of a
  release branch (changelog, version, README text and pictures) that starts at
  that verified revision; the release PR then merges into main as any other PR
  does.
- **Classification.** Paths decide the trigger: a PR that touches only docs,
  tests, scripts, CI or the landing site is internal. Against the changelog
  headings of the last three releases (225 PRs) this marks user-visible PRs
  with 94% precision and 98% recall. Labels are unused (0 of 295 merged PRs)
  and title prefixes appear on 16%. The release agent reads every PR body and
  has the final word.
- **Blockers.** Read from state Delegatus already keeps: the release setting and
  the merge setting, the seat tick switch, the deployment ledger (a rollback
  outstanding, a deployment running), GitHub's required contexts for main and
  the cut, the npm registry for the last tag, the controller's own record, an
  explicit hold, the self-update drain, and the tools the screenshot capture
  needs.
- **The agent.** One pipeline on a release task: `prepare` (builder) →
  `capture` (builder) → `shots` (visual critic, one round) → `shots-fix`
  (builder) → `review` (reviewer, one round) → `fix` (builder) → `publish`
  (deployer). The merge setting lands the PR when the lane completes.
- **The pictures.** Every release retakes the eight README frames with the
  existing driver from the release's own build, a visual critic judges them,
  and one fix round follows. A release branch never changes product source.
- **The go.** The deployer asks before it pushes the tag, every time. The
  answer «Випустити й більше не питати» switches the setting to publish without
  asking; the same setting switches the question back on.
- **Controller.** A `launchIfDue` hook in the seat tick check, beside board
  maintenance. It needs no new timer and no decision from the seat.
- **Setting.** One per-project `release` object on the seat tick settings row,
  changed in the tick panel or through `seat_tick_settings` (agents give a
  reason). Off for every project until turned on.

## 1. How releases happen today

### 1.1 The procedure

The seat cuts releases by hand under a standing rule in its monitor note: «a
minor once a day when main is green with user-visible changes; a patch at once
for user-facing breakage». A release is a pipeline whose builder writes the
`CHANGELOG.md` section, bumps `package.json` and refreshes `README.md`; a
reviewer checks it; the PR merges; someone pushes an annotated `v*` tag on the
merge commit. The tag starts three workflows:

| Workflow | On a tag | What it proves |
| --- | --- | --- |
| `.github/workflows/publish.yml` | verifies an annotated tag equal to `package.json`, audits dependencies, packs, runs the hermetic gate, publishes with OIDC, then polls the registry for version, `latest` dist-tag and integrity | npm carries the version |
| `.github/workflows/docker-image.yml` | builds `linux/amd64` and `linux/arm64`, tags `X.Y.Z`, `X.Y` and `latest` (lines 70–75) | GHCR carries the image |
| `.github/workflows/macos-newcomer.yml` | waits up to ten minutes for the exact npm version (line 60), installs it on a clean macOS runner and rehearses a first start | a newcomer can install it |

`docs/RELEASING.md` §Package release (line 175) still describes a manual
`npm publish`, which `publish.yml` replaced.

### 1.2 The last three releases

| Release | Tag (Kyiv) | PRs since the previous tag | Release PR open → merged | What the release PR also had to do |
| --- | --- | --- | --- | --- |
| 1.9.0 | 2026-10-01 12:18 | 9 | #2393, 1 h 21 min | nothing |
| 1.10.0 | 2026-10-06 16:04 | 121 | #2547, 2 h 38 min | bump two dependencies the supply-chain audit flagged when `package.json` changed |
| 1.11.0 | 2026-10-10 19:09 | 95 | #2580, 88 h 55 min | audit the 1.10.0 section, bump three dependencies, recapture eight README screenshots, merge main twice (17 and 69 new PRs), three lanes and twelve agent runs |

What the history shows:

1. **The seat forgets.** After 1.9.0 nothing was released for five days while
   121 PRs merged; the operator had already said on 2026-10-02 that the seat
   forgets releases.
2. **Chasing main makes a release slow.** #2580 stayed open almost four days.
   Main moved under it, each refresh merged main and extended the section, and
   the release waited on merge batches and on deploys that failed to build.
3. **Every version bump meets the audit.** The pre-push supply-chain gate runs
   when `package.json` changes, and both of the last two release PRs had to fix
   high advisories in main's own lockfile before they could publish.
4. **The macOS check races npm.** For 1.11.0 its tag run started beside
   `publish.yml`, gave up waiting for the version, and an agent re-ran the
   failed job by hand after npm showed it.
5. **A tag can carry code production never ran.** The 1.11.0 tag sat two
   commits past the revision production served at that moment.
6. **Changelog quality needs a reviewer.** The 1.11.0 review found two claims
   the code no longer supported; the audit inside #2580 rewrote five 1.10.0
   entries that spoke in internal terms and moved two misfiled ones.

### 1.3 The pace of change

Merged PRs on main per Kyiv day, and how many the path rule of §2 calls
user-visible:

| Day | 10-01 | 10-02 | 10-03 | 10-04 | 10-05 | 10-06 | 10-07 | 10-08 | 10-09 | 10-10 | 10-11 | 10-12 (to 10:27) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| All | 15 | 56 | 15 | 23 | 5 | 22 | 21 | 16 | 37 | 20 | 54 | 16 |
| User-visible | 11 | 45 | 12 | 17 | 5 | 21 | 21 | 15 | 33 | 18 | 46 | 15 |

Main is 78 commits past `v1.11.0` today, two days after it.

### 1.4 Today's incident, as release input

PR #2714 merged 2026-10-11 and production served it from 16:28Z. Keyed registry reads
stalled (#2760, #2761), and the seat rolled production back to the previous
revision at 18:35Z. The fix is #2762, still open. The seat's tick reason holds
«do not deploy main» and its 1.12.0 card waits for #2762. In the deployment
ledger (2026-10-08 to now, 17 successful deployments) this is the only
deployment that moved production backwards.

## 2. Classifying a change

**Ground truth.** The changelog sections for 1.9.0, 1.10.0 and 1.11.0 cite
every PR in their ranges, each under Added, Changed, Fixed or Security
(user-visible) or under Maintainer notes (internal). That gives 225 labelled PRs
to measure each kind of evidence against.

**The PR list.** Batch-merged PRs are *closed* on GitHub, so `gh pr list
--state merged` misses them. Every first-parent commit on main since `v1.10.0`
names its PR in the subject (`… (#N)`, or `Merge pull request #N`), and most
commit messages (69 of the 78 since `v1.11.0`) carry the PR's description. So
`git log --first-parent <last tag>..<cut>` is the list, and `gh pr view N` reads
every PR, closed or merged.

| Evidence | Coverage | Agreement with the changelog | Verdict |
| --- | --- | --- | --- |
| GitHub labels | 0 of 295 PRs merged since 2026-09-30 carry any label | none to measure | unreliable: never applied |
| Conventional title prefix | 36 of 225 | `fix:` marked 18 user-visible and 9 internal PRs | unreliable: rare and ambiguous |
| Board task colour, icon, priority | tasks have no type field (`src/lib/tasks/types.ts`); the seat picks colour and icon per card, and coral marks bugs and features alike | not measurable per PR: batch-merged PRs reach tasks only through lanes | unreliable |
| Paths touched (rule below) | every PR | 192 called user-visible: 180 are (94% precision); 184 user-visible PRs: 180 found (98% recall); 33 called internal: 29 are (88%) | reliable enough to trigger |
| PR title and body | every PR | the changelog writers of 1.10.0 and 1.11.0 wrote each entry from them | the most reliable; it needs a reader, so the release agent uses it |

**The path rule.** A PR is *internal* when every file it touches matches one of
`docs/**`, `evidence/**`, `*.md` other than `README.md`, `*.txt`, `**/*.test.*`,
`**/__fixtures__/**`, `**/*.fixture.*`, `scripts/**`, `.github/**`,
`.githooks/**`, `security/**`, `landing/**` or `README.md`. Any other file makes
it a *user-visible candidate*. Release PRs (subject `Release <version>…`, or a PR
the controller recorded as its own) are excluded. A *docs* PR is the internal
subset whose files are all documentation; the trigger treats docs and internal
alike, and the release agent may still list a user-facing doc change.

The misses are understandable and harmless for a trigger: merger and deploy
tooling under `src/lib` reads as user-visible (12 PRs), and a setup script or
probe that users do notice reads as internal (4 PRs). The release agent corrects
both when it writes the section.

## 3. The trigger

### 3.1 The rule

The controller starts a release when every blocker of §4 is clear and either:

- **Amount.** The cut (§3.2) holds at least `minChanges` (default 30)
  user-visible PRs since the last release tag, counted by the path rule of §2,
  and at least `minGapHours` (default 12) have passed since that tag; or
- **Request.** The seat, the operator or an agent asked for a release now
  through the tool (§7). A request skips the count and the gap; it keeps every
  blocker and the cut rule.

Two tags are never less than 12 hours apart under the amount rule, so at most
two automatic releases fall in any 24 hours.

**Kind of change.** The amount rule needs no finer kind than user-visible; the
kinds the operator named become:

- *User-facing breakage fixed* → the seat asks for a release now. This is the
  seat's existing «patch at once» rule, moved from its note into one tool call.
- *Security or privacy fix* → the same request. History gives no reason to
  detect these automatically: outside release PRs, none of the 474 commits since
  `v1.5.0` cites an advisory, and every advisory of the last two releases was
  found by the release's own audit (§5.2).
- *Internal-only or docs-only range* → no release, however long it grows.

**The version** is decided by the release agent after it reads the PRs: minor
when the section has Added or Changed entries, patch when it has only Fixed or
Security. A breaking change in the 1.x series stops the release with
`needs_decision`; a major version is never automatic.

**Justification.** The count and the gap are the operator's choice (Q1, option
B). Replayed over the merges on main from `v1.9.0` (2026-10-01 12:18) to
2026-10-12, with each PR counted six hours after it merged to stand in for the
soak of §3.2, the rule releases eight times: on 10-02, 10-04, 10-06, 10-07,
10-09, 10-10, 10-11 and 10-12, each time with 30 or 31 user-visible PRs. The
shortest interval is 13.8 hours and the longest 63 hours, from 10-04 to 10-06,
across the quietest day of the period (5 user-visible merges on 10-05). The
12-hour gap never bound in those twelve days; it caps a day that brings 60 or
more user-visible merges, and the busiest day so far brought 46. In the same
period the seat released twice by hand, with 121 and 95 PRs.

What the count buys:

- **A section a reviewer can check.** Thirty user-visible PRs is a quarter of
  1.10.0's range, whose section needed an audit afterwards, and a third of
  1.11.0's, whose review found two claims the code no longer supported.
- **Fewer fixed costs.** Every release pays for a lane of two to four hours,
  the screenshot stages included (§5.5). A daily rule would have released
  eleven times in the period, with sections of 5 to 54 PRs.
- **No release for a trickle.** A day with five user-visible merges does not
  publish a version by itself.

What it costs: a quiet stretch waits. At this project's pace 30 user-visible
PRs gather in 14 to 63 hours; a range that never reaches the count is released
when the seat or the operator asks (Deferred: a maximum wait). The replay leaves
out the lane's own duration, the blockers and the wait for a deployment to
become the cut; each of them only delays a release. Users are not pushed to
restart with each release: automatic updates are off by default for installs
(`docs/design/self-update-auto.md`), so a release shows as an available update.

Rules considered:

| Rule | What it would have done 10-01…10-12 | Verdict |
| --- | --- | --- |
| **30 user-visible PRs, at most one release per 12 hours** | eight releases of 30–31 user-visible PRs, 14–63 hours apart | chosen by the operator (Q1, option B) |
| daily with at least one user-visible PR | eleven releases, each carrying 5–54 user-visible PRs | this design's first recommendation (Q1, option A); more releases, each paying the lane's fixed cost |
| any user-facing fix | about ten releases a day (a third of PRs are fixes) | unworkable |
| security PR, automatic | never (0 of 474) | nothing to detect; the request covers it |
| weekly | one release, on 10-08, carrying 154 PRs | a section larger than 1.10.0's 121 PRs, which already needed a later audit (Q1, option C) |

### 3.2 The cut: what a release contains

A release carries the newest main revision that production on this machine
has served for at least 6 hours and that every later successful deployment
still contains. In the ledger's terms: walk successful deployments of main
commits newest first; the cut is the revision of the newest one that finished
at least 6 hours ago and is an ancestor of every successful deployment after
it, the serving one included.

Why:

- **It catches the regression nobody has named yet.** #2714 broke production
  about two hours after its deploy (deployed 16:28Z, issue opened 18:31Z,
  rolled back 18:35Z). A 6-hour soak would have kept it out of any release,
  with or without anyone setting a hold.
- **It ends the chase.** The release branch starts at the cut and never merges
  main before review, so a release lane is as short as #2393 and #2547 were,
  however fast main moves.
- **It tags what was run.** 1.11.0 was tagged on two commits production had not
  served.

Today the cut is `0ef6ec49` (served since 2026-10-11 18:35Z): 53 PRs past
`v1.11.0`, 45 of them user-visible candidates, with #2714 and the PRs after it
left for the next release. Under §3.1 a release is due: the count is 45 of 30
and the last tag is more than a day old. The rollback blocker (§4) holds it
until a deployment containing #2714 and its fix has served.

Between 2026-10-09 and 2026-10-11 production took a new deployment one to six
hours apart during the day, so the cut trails main by the 6-hour soak plus the
wait for the next deployment. A project with no deployment ledger has
no cut, and the release setting is not offered there (Deferred).

**Where the tag goes.** The release branch is created from the cut (`baseRef` in
`CreatePipelineRequest`, `src/lib/pipelines/types.ts:1190`), so its commits sit
directly on the cut and the PR diff is exactly what the release adds: the
changelog, the version, the README text and the retaken pictures. R is the
branch's reviewed head, and the annotated tag goes on R. The diff from the cut
to R stays inside the release paths of §5.4, so the product source the tag
ships is the source production served; a dependency moved for the audit (§5.2)
is the one exception, and the changelog names it. Merges here are squash
(`mergeMethod`, `src/lib/forge/autoMerge.ts:181`), so R itself never becomes an
ancestor of main; the squash commit brings the changelog and version to main.
Nothing
depends on a tag being reachable from main: `publish.yml` checks out the tag;
checkout installs follow `refs/heads/main` (`src/lib/selfUpdate/git.ts:69`);
packaged installs follow the npm `latest` version
(`src/lib/selfUpdate/package.ts:35`); no code runs `git describe`. The next
release's range `git log <last tag>..<next cut>` lists exactly the commits after
the previous cut.

## 4. Blockers

Each blocker is read when the cheaper checks before it pass, in this order. A
blocker makes the controller wait and say why; it never closes anything.

| # | Blocker | How it is detected | Today |
| --- | --- | --- | --- |
| 1 | Releases are off | the project's `release.enabled` is false and no request is pending (§7) | off: nothing is configured |
| 2 | The seat tick is off for the project | `effectiveSeatTickSettings(...).enabled` false, as board maintenance checks (`src/lib/boardMaintenance/run.ts:216`) | on |
| 3 | The merge setting is off | `mergeOnReviewEnabled(project)` false (`src/lib/projects/settings.ts:173`): a release PR could not land | on |
| 4 | A release is in flight | (a) the controller's record holds a live release pipeline, or its PR is not merged yet; (b) main's `package.json` version is above the newest `v*` tag (merged, untagged); (c) the newest tag's version is absent from npm (`registryRevision`, `src/lib/selfUpdate/package.ts:35`) | clear |
| 5 | Main's required checks are red | the branch protection's required contexts (`requiredContexts`, `src/lib/forge/autoMerge.ts:193`; today `privacy-publication` and `privacy-tracker-audit`) read on main's head and on the cut; any failure blocks, pending waits | green on `aaf82e17` |
| 6 | A production incident is open: a rollback is outstanding | a successful deployment of a main commit since the last tag whose revision the serving revision does not contain. It clears when a later successful deployment contains that revision | **blocked**: `05d66b73` (#2714) is not in the serving `0ef6ec49` |
| 7 | A known regression or incident without a rollback | an explicit `release.hold` with a reason, set and cleared through the tool by the seat, the operator or an agent; the record names who and when | none |
| 8 | No verified cut | no deployment qualifies under §3.2 (production changed within the soak, or the project has no ledger) | the cut exists |
| 9 | A deployment is running, or an automatic update drains | a non-terminal latest deployment; `activeDrain()`; both as board maintenance (`run.ts:221`, `run.ts:224`) | clear |
| 10 | The screenshot capture cannot run on this machine | the lookups the capture driver and the publication gate make themselves: `tesseract` and `pdftocairo` on the Viewer's PATH, and a Chrome (`CHROME_BIN`, the system Chrome, or the Playwright browser the repository's drivers use) | **blocked**: `tesseract` is not on PATH; `pdftocairo` and a Playwright Chrome are present |
| 11 | The publisher at the release cut cannot satisfy the macOS workflow's receipt contract | inspect the publisher workflow from the immutable release ref and the current default-branch macOS consumer; require the publisher to upload the `release-receipt` artifact with the exact tag and commit revision the consumer reads | **blocked for the recorded cut in §3.2**: its `publish.yml` has no receipt producer, while the current `macos-newcomer.yml` requires that artifact |

Why these signals:

- **Rollback (6)** is exact and costs one ledger read and a few `git
  merge-base --is-ancestor` calls. It names today's case without anyone writing
  anything, and it stays set until the fix has actually served, which is when
  the seat's own note releases its hold.
- **The hold (7)** covers what the ledger cannot see: a regression the operator
  chose to live with, or one on another surface. The seat already records
  incidents in its tick reason; the hold makes that one tool call that the
  controller can read. The instruction for it goes into the
  `seat_tick_settings` tool description, with at most a short pointer in the
  mandate, because the mandate sits a few bytes under its budget.
- **Open GitHub issues** are left out: #2760 and #2761 carry no label, and
  open issues are many and mixed (Deferred).
- **The soak (8)** is the safety net for both: an unnoticed regression either
  surfaces inside six hours and turns into 6 or 7, or the release ships what
  ran six hours cleanly.
- **The capture tools (10)** are checked before the lane starts because the
  capture is the third stage: without the check a release would write its
  changelog for an hour, fail at the first screenshot, and try again 12 hours
  later. The driver refuses a frame whose raster the gate could not read
  (`tool_unavailable`, `scripts/privacy-publication-gate.ts:1732`), so a missing
  OCR tool can never be skipped. The 1.11.0 capture ran with a private copy of
  `tesseract` outside PATH.
- **The workflow receipt (11)** is checked before the operator is asked to
  approve a tag. A tag push runs the `publish.yml` carried by that tag; the
  `workflow_run` macOS consumer comes from the default branch and downloads
  the publisher run's `release-receipt` artifact. Checking only the current
  default branch misses an older release cut. The recorded cut proves the
  failure case: its `.github/workflows/publish.yml` has no
  receipt producer, and the current `.github/workflows/macos-newcomer.yml`
  downloads `release-receipt` and reads its `tag` and `revision` files. The
  controller checks this before creating the lane and repeats the check in
  preflight immediately before approval. It holds such a cut before any tag or
  publish action. It waits for a production-soaked cut whose publisher
  satisfies the consumer contract; it never bypasses the six-hour soak or
  dispatches a recovery workflow to compensate for an incompatible cut.

A blocker that keeps a due release waiting for 24 hours wakes the seat once per
blocker episode (§6.3), so a forgotten hold or a red main does not stall
releases silently.

## 5. The release pipeline

### 5.1 Task and lane

When a release is due the controller:

1. Creates a board task (rocket icon, amber, like the release cards so far),
   text in the operator's language: «Реліз Delegatus (після 1.11.0)» and one line
   on what it carries and why it is due. A request may name an existing task for
   the controller to adopt, as the seat's 1.12.0 card would be.
2. Creates the pipeline with `createPipelineFromRequest`
   (`src/lib/pipelines/engine.ts:10398`), the way the onboarding health check
   creates one from Viewer code (`src/lib/onboarding/healthCheck.ts:515`):
   `taskIds` and `finishesTask` set to that task, `baseBranch: "main"`,
   `baseRef: <cut>`, `autoStart: true`, and a creation key
   `release:<project>:<cut>` so a restart or a second tick replays the same
   lane.
3. Records `{ pipelineId, taskId, cut, lastTag, trigger, startedAt }` (§6.2).

Stages, from a template in code; engines and models come from the role table:

| Stage | Role | Does |
| --- | --- | --- |
| `prepare` | builder, `docs` domain | writes the section, picks the version, bumps `package.json`, updates README text, clears the audit, runs the checks, pushes; the engine opens the PR «Release X.Y.Z» |
| `capture` | builder, `frontend` domain | builds the release branch and retakes the eight README frames with the existing driver, reads them, commits the vectors and their provenance |
| `shots` | visual critic, read-only, `maxRounds: 1`, on fail → `shots-fix`, exhausted → advance | judges the README as a reader sees it: every frame and its caption |
| `shots-fix` | builder, `apply-fixes` mode, `frontend` domain | fixes every visual finding by changing how the picture is taken or what the README says, and retakes |
| `review` | reviewer, `maxRounds: 1`, on fail → `fix`, exhausted → advance | checks coverage, accuracy against the code at the cut, public safety, version kind, README consistency, and that the diff stays inside the release paths |
| `fix` | builder, `apply-fixes` mode, `docs` domain | fixes every finding; its verdict is pass unless it is blocked |
| `publish` | deployer | validates, asks for the go, tags R, watches the three workflows, verifies, reports |

The pass edges run `prepare` → `capture` → `shots` → `review` → `publish`. Each
of the two checks has a fail edge to its own fix stage with one round and
`onExhausted: "advance"` (`PipelineFailEdge`, `src/lib/pipelines/types.ts:91`):
the findings go to the fix stage once, and when that fix passes the lane follows
the check's own pass edge without running the check again. That is the
operator's standing review budget: one review, one fix, no re-check. Each fix
stage's pass edge names its check, as the fix stages of today's lanes do.

The pictures come before the review so that the reviewer reads the release as
it will be tagged, the driver and seed changes of the screenshot stages
included, and so that a capture the driver refuses stops the lane before a
reviewer is spent on it.

When the lane completes, the merge setting lands the PR (required checks only,
squash), and the task moves to Done on the merge. A conflict or a refused
merge takes the existing path: the lane's unmerged-PR wake to the seat.

### 5.2 `prepare`: what the builder is told

The controller's brief carries the facts, so the agent does not rediscover them:
the last tag, the cut with its deploy time and soak, the trigger, and the PR
list of `git log --first-parent <last tag>..<cut>` with each subject and its
path class.

The agent:

- Reads every PR's title and body (`gh pr view N`, closed or merged) and the
  code at the cut wherever an entry states a number, a default or a limit.
- Writes `## [X.Y.Z] — <date>` under Added, Changed, Fixed, Security and
  Maintainer notes, in the existing section style: plain language for a user,
  what changes on the screen or on the install, related PRs grouped into one
  entry, each entry linked to its PRs. No task, lane or conversation ids, no
  account names or handles, no paths outside the repository, no internal
  vocabulary (runtime host, settlement, journal, admission). Entries in
  `[Unreleased]` whose PRs are inside the range move into the section; the rest
  stay.
- Picks the version (§3.1), bumps `package.json`, adds the compare link.
- Updates `README.md` text only where an entry changes what the README says.
  The pictures belong to the next stage.
- Clears the audit the version bump triggers: a high advisory is fixed by moving
  the advised package to its first fixed release in the pin and the lockfile, as
  #2547 and #2580 did, and named under Security. An advisory whose fix needs code
  changes stops the stage with `fail`, and the seat runs that fix as an ordinary
  lane.
- Runs the privacy publication gate, `git diff --check`, and the changelog
  parser tests `src/lib/selfUpdate/changelog.test.ts` and
  `changelogMarkup.test.ts` by path under isolated state; the pre-push hook
  runs the rest.
- When nothing in the range is user-visible after reading the bodies, reports
  `fail` with that reason. Only a requested release can come to this, because
  the amount rule starts at 30 candidates; the seat that asked closes the lane
  (§5.5).

### 5.3 `capture`, `shots`, `shots-fix`: the README pictures

The README shows eight frames from `docs/media/readme/`: the board, the
orchestrator, a conversation, a pipeline, the card menu, the accounts dialog,
and the board and a conversation on a phone. One driver makes them all,
`scripts/capture-readme-media.ts`, from an invented home seeded by
`scripts/readme-demo-state.ts`. It serves the production build of the checkout
on a port the OS assigns and takes each shot twice: a PNG for review, kept
outside the repository, and a vector SVG, which is what the README uses and
what the publication gate admits. It already refuses a shot whose required text
is missing or whose forbidden text shows, runs the gate's text classifier and
its raster inspection with OCR on every frame, and keeps a vector only when
Chrome renders it back to what its PNG shows. It writes `provenance.json` with
each file's hash and the hashes of the driver and the seed. Nothing new is
needed to take the pictures.

The release branch starts at the cut, so the build the driver serves is the
release's own code, and the pictures show the product as it is released.

**`capture`** (builder). Its brief:

- Check the tools first (Chrome, `pdftocairo`, `tesseract`) and end with `fail`
  naming a missing one.
- Run `bun run build`, then `bun scripts/capture-readme-media.ts`, one at a
  time through `scripts/gate-slot.sh`, with a private HOME, XDG, TMPDIR and
  `LLV_STATE_DIR`, the Viewer control URL on a closed port, Chrome through a
  wrapper that records its PID, and `LLV_README_EVIDENCE_DIR` in the stage's
  scratch so two lanes never share review frames.
- When the driver refuses a shot because the screen moved (a renamed label, a
  control in a new place, a panel of a new size), update that shot's definition
  or the demo seed, run `scripts/capture-readme-media.test.ts` by path, and
  capture again. Never loosen a privacy check, the render-back limit, or a
  required text the README caption still promises.
- Read all eight review PNGs before committing. Commit the vectors,
  `provenance.json` and any driver or seed change; push. Close every browser by
  its recorded PID.
- The set of shots stays as it is. A new or a dropped picture is the seat's
  task (Deferred).

**`shots`** (visual critic, read-only). The brief is the one the 1.11.0 check
ran under this role on 2026-10-07: look only at the README as a reader would.
Render each committed vector to a PNG at its native size, look at every frame,
and report anything ugly (clipping, overlap, text sliced mid-word, half-loaded
states, inconsistent sizes), anything a reader should not see (ids, paths,
handles, account names, debug text), any picture that does not show what its
caption says, and any README sentence that names a control the product no
longer has. The frames exist in one language and theme, English and dark, which
is what the README shows. Pass when there is nothing to report. That check
found seven things in 1.11.0: two frames where a window sliced the screen
behind it into half-words, a cut column, one setting spelled four ways across
frames, an unlabelled number, a pill overlapping a row, and one README sentence
naming a button by the wrong label.

**`shots-fix`** (builder). Fixes each finding by changing how the picture is
taken (viewport, crop, the steps before the shot, the demo seed) or what the
README says, captures again under the same isolation, and reads the frames
again before pushing.

**A release branch never changes product source.** In 1.11.0 the fix round for
the pictures also changed `src/components/LogFeed.tsx`. Under §3.2 that would
put code into the tag that production never served. So when a frame shows a
defect of the product itself:

- *Cosmetic* (the screen is readable and true): the frame stays as taken, and
  the stage names the defect in its summary. The seat reads it in the
  `release-settled` wake and runs the fix as an ordinary lane; the next release
  retakes the picture.
- *Broken* (unreadable, half-loaded, or something a reader must not see that
  the seed cannot remove): the stage ends blocked, the lane parks, and the
  release waits for the seat (§5.5).

### 5.4 `publish`: the deployer

The deployer role (`src/lib/roles/defaults.ts:272`) already has the semantics this
step needs: it validates without mutating, lists each mutating step, and stops
with `needs_decision` until a quoted operator go names them. Its brief:

- R (the reviewed head of the release branch), the version, the PR, and the
  steps it may take: push the annotated tag `vX.Y.Z` (message «Delegatus X.Y.Z»)
  on R, then wait and verify.
- Validation first, by one read-only command, `scripts/release-verify.ts
  --preflight --cut <cut> --tag vX.Y.Z`: the tag is absent locally and on the
  remote; `package.json` at R says X.Y.Z; npm has no X.Y.Z; the frames match
  `provenance.json` (each file's hash, the driver's and the seed's); and the
  diff from the cut to R touches only the **release paths**: `CHANGELOG.md`,
  `package.json`, `bun.lock`, `patches/**`, `README.md`, `docs/media/readme/**`
  and `scripts/**`. Those are what the last three release PRs changed, less the
  product file of 1.11.0. A file outside them ends the stage with `fail`.
- The same read-only preflight inspects `.github/workflows/publish.yml` at the
  immutable release ref and `.github/workflows/macos-newcomer.yml` on the
  current default branch. It must prove that the tag's publisher uploads the
  `release-receipt` artifact containing the exact tag and checked-out commit,
  and that the macOS workflow triggered by that publisher run downloads and
  validates those fields before installing the exact npm version. A missing,
  malformed or mismatched producer/consumer contract blocks the release
  before the go prompt and before any mutating step. Run this check when
  deciding whether to create the release lane, then repeat it immediately
  before asking for the go so a changed default-branch consumer cannot race
  the approval. The recorded cut in §3.2 must fail preflight because its
  publisher cannot create the artifact required by the current macOS
  consumer. Do not copy the default-branch workflow into a frozen cut or rely
  on a manual dispatch: GitHub runs a pushed-tag workflow from the pushed ref,
  while `workflow_run` uses the default-branch workflow definition.
- **The go.** The setting asks before publishing by default, every time. The
  stage stops with `needs_decision` and the version, the PR and the step list.
  The seat wakes on the decision as for any lane, asks the operator in chat with
  the PR link (its README view shows the retaken pictures) and suggested replies
  «Випустити 1.12.0», «Випустити й більше не питати» and «Не випускати», and
  answers the decision quoting the operator. «Більше не питати» also sets
  `askBeforePublish: false`, with the operator's words as the reason. From then
  on the brief quotes the setting's record (who turned asking off and when) as
  the standing go, until someone switches the question back on (§7). The role's
  safety fence names only a go quoted by the spawning seat, so its wording gains
  this second source.
- After the push, the same command waits and verifies: `scripts/release-verify.ts
  --tag vX.Y.Z` finds the three runs for the tag's commit, waits up to 90
  minutes, and prints one verdict: npm shows X.Y.Z as `latest`; the GHCR image
  index for `X.Y.Z`, `X.Y` and `latest` holds `linux/amd64` and `linux/arm64`
  and the three tags resolve to one digest; the macOS install run succeeded. It
  is read-only and can be run again after an interruption. In 1.11.0 an agent
  polled these runs turn by turn for 45 minutes through two Viewer restarts.
- Never retags, never republishes, never deletes a tag. A failed workflow ends
  the stage with `fail`, the failing step and its log excerpt. The recovery is
  the seat's: dispatch `publish.yml` with the existing tag (it skips a version
  that exists), or a patch release.
- Reports in the card's language, for example «Реліз 1.12.0 опубліковано: npm
  1.12.0, Docker 1.12.0 / 1.12 / latest (amd64, arm64), перевірка встановлення
  macOS пройшла».

Identity: the tag push is a push, which in a declared App repository goes out as
the Delegatus GitHub App (CONTRIBUTING.md, «GitHub writes from launched
agents»). A workflow rerun, a dispatch and `gh release create` are kinds the App
does not cover (CONTRIBUTING.md:97) and would run under a person's credentials.
The design avoids the rerun by fixing the race at its root (§8 slice 2) and
leaves dispatches to the seat.

### 5.5 Failure, decline and timing

| Outcome | What happens next |
| --- | --- |
| Published, PR merged | the record settles `published`; the seat gets one wake and reports one line, with any product defect the pictures showed |
| Declined at the go | the lane closes without merging; the cut is not offered again; the next attempt waits `minGapHours` from the decline |
| A stage failed or ended blocked (the capture refused, a broken frame, a file outside the release paths, a failed workflow) | the lane parks as any lane does and its own wake reaches the seat, which retries the stage or closes the lane; a closed lane settles `failed` with the stage and reason, and the next attempt waits `minGapHours` unless asked |
| Waiting on the go | the release stays in flight (blocker 4); its decision shows in Needs you |

Expected duration, from start to published, two to four hours:

| Stage | Time | Measured where |
| --- | --- | --- |
| `prepare` | 30–60 min | #2393 and #2547 took 1 h 21 min and 2 h 38 min from open to merge for 9 and 121 PRs; a release now reads about 30 |
| `capture` | 20–40 min | the 1.11.0 fix round built, retook all eight frames, ran its tests and pushed through the full hook in 40 min, seven fixes included |
| `shots` and `shots-fix` | 10–50 min | the same round; nothing to fix when the critic passes |
| `review` and `fix` | 10–30 min | the 1.11.0 review and its fix took 12 min (15:35Z to 15:47Z) for two findings |
| `publish` | about 50 min after the go | 1.11.0: tag at 16:09Z, Docker done at 16:54Z |

The 1.11.0 lane that retook the pictures ran 2 h 52 min on 2026-10-07 (07:50Z
to 10:42Z), with a merge of main and a changelog extension in its first stage.
At eight releases in twelve days the screenshot stages add roughly four to
twelve hours of agent time over that period.

**What the retakes add to the repository.** One set of eight vectors is 9.3 MB
of text, 1.6 MB compressed. A retake of a screen that did not change costs far
less than that once Git stores it against the previous one. Measured by
compressing each version of the board frame after its predecessor: its four
retakes on 2026-09-24 and 2026-09-28 added 2–5 KB each, and the two retakes
after larger changes to the screen (2026-09-25 and the 1.11.0 redesign) added
49 KB and 121 KB. So a release with an unchanged interface adds tens of
kilobytes for the eight frames, and a redesign adds what a hand retake would
have.

## 6. Where the controller lives

### 6.1 Options

| Option | How | Trade-off |
| --- | --- | --- |
| A. A seat tick wake item | the tick computes «a release is due» and wakes the seat; the seat creates the lane | no launch code, and the seat's judgment. But it hands the decision back to the actor the operator said forgets releases (2026-10-02) and who left 121 PRs unreleased for five days. Wakes are skipped while the seat is busy or its host is gone (a 13-hour silence on 2026-10-09). The seat's note is at 15,988 of 16,000 characters, and the release procedure would live in it |
| **B. A `launchIfDue` hook in the seat tick check** | `release.reconcile(project)` and `release.launchIfDue(input)` run in `runSeatTickCheck` next to board maintenance (`src/lib/monitor/seatTickController.ts:1645`, `:1923`, wired at `:2151`) | deterministic, independent of the seat's attention, and it inherits what the tick already has: the per-project check every five minutes (`src/lib/monitor/seatTick.ts:141`), the on/off switch, the drain hold, the deployment wait, restart safety and the journal. The pipeline engine owns the lane's lifecycle, so the controller stays small |
| C. Its own timer | a separate interval in the Viewer | duplicates the tick's scheduling, switches and fences, and gains nothing |

**Chosen: B.** The seat still hears about releases through wake items (§6.3) and
through the decision, merge and stall wakes every lane already raises. Like
board maintenance it waits for a seat, because the go and every failure are
relayed by the seat.

### 6.2 The controller's record

A small per-project store, `release-runs.json` under `statePath`, written
atomically: the live run (pipeline, task, cut, last tag, trigger, start), the
last ten settled runs with their outcome, a pending request `{ at, by, why,
taskId? }`, and the hold `{ reason, at, by }`. The settled outcome and the
time it settled drive the next eligibility. Board maintenance's own store
(`src/lib/boardMaintenance/store.ts`) is the pattern; the launch, observe and
archive code around it is not needed, because a pipeline already carries all of
that.

`reconcile` reads the live run's pipeline: `completed` with the PR merged →
`published`; `completed` with the merge blocked → stays live (the lane's
unmerged-PR wake owns it); parked on a failed or blocked stage → stays live
(the lane's own wake reaches the seat); `closed` → `declined` when the go was
refused, `failed` otherwise, with the last stage and its reason.
A done bound task settles an otherwise live record as `completed` with reason
`task-done`, including a record that never obtained a pipeline id. A newer stable
`v*` tag containing the frozen cut and present on npm settles it as `superseded`,
recording the tag as its reason. Both paths clear only that run's pending request;
a later request survives. They free the slot without starting a failure cooldown.
The next evaluation fetches tags and uses the highest stable version for the
change range and tag gap; holds, the six-hour soak and publication approval still
apply.

### 6.3 Wake items for the seat

- `release-settled`: published, failed, declined, completed or superseded, one per run, the
  way `maintenance-settled` works (`src/lib/monitor/seatTick.ts:1297`). A
  published run's item also carries any product defect the screenshot stages
  named (§5.3).
- `release-blocked`: a release has been due for 24 hours and a blocker still
  holds it; one per blocker kind and episode, naming the blocker.

## 7. The setting

One object on the project's seat tick settings row, beside `maintenance` and
`autoRotate` (`src/lib/monitor/seatTickSettings.ts:87–103`):

```ts
release?: {
  enabled: boolean;          // false: no automatic releases
  askBeforePublish: boolean; // default true: the deployer stops for the go
  minChanges: number;        // 1–500, default 30
  minGapHours: number;       // 1–720, default 12
  updatedAt: string;
  setBy: SeatTickSettingsActor;
  why: string | null;        // required from any caller but the operator's own UI
} | null;
```

Absent reads as off. Turning releases on writes the defaults: 30 changes, 12
hours, and the question asked every time. `askBeforePublish` becomes false only
on the operator's word: the answer «Випустити й більше не питати», which the
seat relays with the operator's words as the reason, or the operator's own
click on the checkbox. The tool accepts that change only from the project's
seat or the operator's own session, the rule `role_presets` already applies to
its writes. Either route sets it back to true. The soak (6 hours) is a
constant, and the screenshot stages are part of every release with no switch
(Deferred).

**Agents** use the existing tool: `seat_tick_settings` gains `release: {
enabled?, askBeforePublish?, minChanges?, minGapHours?, why }`, and two actions
on the same object, `requestNow: true` and `hold: "<reason>" | null`, each with
`why`. A read answers the setting, the last release, the cut, the count since
the last tag against the threshold (today «45 of 30»), what the release waits
on, and when the gap ends.

**The operator** uses the tick panel (`src/components/orchestrator/SeatTickBody.tsx`),
which already holds the auto-rotation and board maintenance sections: a
«Релізи» section with the same switch, a «Питати перед публікацією» checkbox, a
line «Коли набереться [30] змін · не частіше ніж раз на [12] год» with two
compact number fields, the last release, the count so far and what the next
release waits on, and the hold with a Clear button when one is set. On a phone
the tick sheet carries the same section. No new panel or route.

**Consistency with lane 443238cf.** That design keeps one stored place per
setting, lets the operator edit in an existing surface without typing a reason,
requires agents to give one, records who changed what and when, and offers no
new panel. The release setting does the same. It has one level, because a
release belongs to a repository with its own publish workflow; a machine-wide
default would turn releases on for repositories that have none. Its
surface is the seat's tick panel, where that design also put the per-project
level (the seat header).

**Turning it off:** the panel switch, telling the seat (one tool call), or
turning the project's tick off, which pauses releases with everything else the
tick runs.

**Mandate.** Line 463 of `src/lib/orchestrator/prompt.ts` («The project's own
release step runs only when the operator has turned releases on for this
project, in their message or as a standing line in your monitor note») becomes
a line no longer than it, pointing at the setting and at `requestNow`; the hold
instruction lives in the tool description. The seat's RELEASE paragraph leaves
its monitor note.

## 8. Build plan

**Slice 1: the controller (no UI).**

- `src/lib/release/policy.ts`, pure: `classifyPaths(files, subject)`,
  `releaseCut(deployments, isAncestor, now)`, `releaseState(input)` →
  `due | not-due | blocked | in-flight` with reason, cut, counts and blockers.
- `src/lib/release/store.ts` (§6.2) and `src/lib/release/run.ts`
  (`productionReleaseController(sources)` with `reconcile` and `launchIfDue`),
  `src/lib/release/stages.ts` (the seven stages of §5.1 with their briefs and
  edges).
- The `release` setting and answer in `seatTickSettings.ts` and
  `seatTickSettingsAnswer.ts`; the tool field in the MCP schema and binding.
- Wiring in `seatTickController.ts`; the two wake items in `seatTick.ts`.
- Mandate line, tool description, deployer fence wording.
- Tests: `policy.test.ts` with this ledger as a fixture (`05d66b73` rolled back →
  blocked; a later deployment containing it → clears; the cut moves only after
  6 hours); the count (29 waits, 30 is due) and the gap (11 hours waits, 12 is
  due, a request skips both); an internal-only range; red and pending required
  contexts; a merged untagged version and a tag missing from npm; the hold; the
  drain; a missing capture tool; the merge setting and the tick switch off.
  `stages.test.ts`: the template validates as a pipeline, both checks carry a
  one-round `advance` fail edge to their own fix stage, and the pass path ends
  at `publish`. `run.test.ts`: two ticks create one lane, a restart replays the
  creation key, each outcome settles once, the cool-down after decline and
  failure, «більше не питати» turns the question off and the setting turns it
  back on. The settings persistence test, the MCP schema parity test,
  `prompt.test.ts` and `handoffDigest.test.ts`.

**Slice 2: release mechanics in the repository.**

- `scripts/release-verify.ts`, read-only, in two modes: `--preflight` (tag,
  version, npm, provenance of the frames, release paths) and the wait for the
  three workflows; tests over recorded `gh`, npm and registry answers. A
  workflow-compatibility regression reads the actual publisher at the
  historical cut in §3.2 and the current default-branch macOS consumer, proves
  that the producer is missing the required receipt, and asserts preflight
  refuses before a tag or publish action. A matching producer/consumer pair
  must pass this compatibility check. Keep this regression read-only: it never
  creates or pushes tags, dispatches workflows, or publishes packages. Retain
  the preflight case that a product file in the diff turns red.
- `macos-newcomer.yml` runs for a release after `publish.yml` succeeds
  (`workflow_run` on «Publish to npm», `completed`, success only) and keeps its
  PR and dispatch triggers; `scripts/publish-workflow.test.ts` follows.
- `docs/RELEASING.md` §Package release rewritten to the real procedure: cut,
  release branch, README pictures, tag, workflows, verification, recovery by
  dispatching `publish.yml` with the existing tag. The capture driver itself
  needs no change.

**Slice 3: the panel section.** `SeatTickBody.tsx` and the phone sheet, uk and
en strings; rendered evidence through the existing seat tick browser case at
1440 and 390 px, uk and en, light and dark, ending with the visual critic.

**Rollout.** The setting is off everywhere. Before the first automatic release
the operator installs the OCR tool this machine lacks, once, in their own
terminal, because it needs root: `sudo apt install tesseract-ocr
tesseract-ocr-eng tesseract-ocr-ukr`, the packages the privacy workflows
install. Until then blocker 10 holds every release and says why. The seat then
turns the setting on for Delegatus with the operator's answers as the reason,
adopts the open 1.12.0 card with the first request, and replaces its RELEASE
paragraph with one line.

## 9. Validation against the requirement

| The operator asked for | The design |
| --- | --- |
| «чтобы это автоматически делалось» | the tick starts releases when due; nobody has to remember |
| «с каким-то количеством обновлений» | 30 user-visible PRs since the last tag and at most one release per 12 hours, both settable |
| «или с каким-то характером обновлений» | user-visible versus internal decides; breakage and security fixes go out at once on a request; the kind sets minor or patch |
| «запускался агент, который делал бы релиз» | one pipeline on a release task, visible and reviewable on the board |
| «писал бы changelog правильно» | sections written from every PR body for users, checked by an independent reviewer against the code, and kept to about 30 user-visible PRs |
| «и так далее» | version, README text and pictures, the audit, the tag, three workflows verified, a report; never a regression production rolled back, never on red checks |

The operator's answers of 2026-10-12 are each in the design: 30 changes and a
12-hour gap (§3.1, §7), the question asked every time with its switch (§5.4,
§7), the verified cut (§3.2), and the retake of the README pictures in every
release (§5.3).

With the verified cut, the brief's last steps change order: the tag goes on the
reviewed head of the release branch, publication follows, and the PR merges
when the lane completes. The brief's order (merge, then tag the merge commit)
belongs to releasing main's tip, which the operator did not choose.

## 10. Operator decisions

The four questions below were published as a questionnaire on this task's
prototype review on 2026-10-12, each with a recommendation. The operator
answered all four the same day at about 09:00Z, with no comment. The build
reads the answers here; `read_prototype_review` on the task holds the original
record. No question is open.

**Q1. How often should Delegatus release by itself?**
- A (recommended): at most once a day, when at least one change users can see
  has landed since the last release.
- B: once 30 user-visible changes have gathered, at most twice a day.
- C: once a week.

**Answer: B.** Release when 30 user-visible changes have accumulated since the
last tag, at most twice a day; the orchestrator's «release now» for breakage
and security fixes stays. In the design: `minChanges` 30 and `minGapHours` 12
(§3.1, §7).

**Q2. Should automatic releases wait for your go before the tag is pushed?**
- A (recommended): ask each time in the orchestrator's chat, with an answer
  «Випустити й більше не питати» that switches to publishing without asking.
- B: ask for the first two releases, then publish without asking.
- C: never ask; publish and report.

**Answer: A.** In the design: `askBeforePublish` is true by default, the
question is asked before every tag, and that one answer or the panel checkbox
turns it off and on (§5.4, §7).

**Q3. What should a release contain?**
- A (recommended): what production on this machine has served for 6 hours
  with no rollback. The tag goes on a release branch on top of that version,
  and newer merges wait for the next release.
- B: main's tip at the moment of the release, as 1.11.0 did, held back only by
  the blockers.

**Answer: A.** In the design: the cut of §3.2.

**Q4. Should automatic releases recapture the README screenshots?**
- A (recommended): no. The README text is updated with each release;
  screenshots are refreshed when you ask, as their own task.
- B: yes, every release recaptures them, which adds a capture stage, a visual
  check and a fix round.

**Answer: B.** In the design: the `capture`, `shots` and `shots-fix` stages of
§5.3 in every release, blocker 10 for the tools the capture needs, and the rule
that a release branch never changes product source.

## Deferred — not currently justified

Options the operator did not choose (2026-10-12):

- **A daily release with at least one user-visible change (Q1, option A), and
  a weekly release (Q1, option C).** Both remain reachable through the setting:
  `minChanges` 1 with `minGapHours` 24 or 168.
- **Asking for the first two releases only (Q2, option B), and never asking
  (Q2, option C).** The operator turns the question off with one answer when
  they choose to.
- **Releasing main's tip (Q3, option B).** It keeps 1.11.0's way and relies on
  the blockers alone. The tag would belong on the squash commit, which exists
  only after the lane completes, so the controller would have to start the
  publish step itself once the PR merged.
- **Text-only README updates, with screenshots as their own task (Q4, option
  A).**

Scope cut by this design:

- **A maximum wait for a quiet stretch.** A range that stays under 30
  user-visible PRs is never released by the amount rule. At this project's pace
  30 gather in 14 to 63 hours, and the seat's request covers a quiet week. Add
  a third number when a range has waited a week unreleased.
- **Skipping the retake when no screen changed, or keeping unchanged frames
  byte for byte.** The frames carry relative times, so every retake rewrites
  them; a rewrite of an unchanged frame costs a few kilobytes (§5.5). The
  operator asked for a retake in every release.
- **A switch for the screenshot stages, or leaving them out of a requested
  patch release.** A requested release already waits six hours for the soak;
  the retake adds under an hour and a half to that.
- **Choosing new README shots, or dropping one, inside a release.** The capture
  retakes the set the README has. In 1.11.0 a builder added the eighth frame
  inside the release; here that is the seat's task.
- **Fixing a product defect inside the release.** The pictures can show one
  (§5.3). The fix is an ordinary lane, so the tag keeps to what production ran.
- **A `skipped` outcome for a range with nothing user-visible.** The first
  draft had one for a threshold of one change. At 30 candidates the amount rule
  cannot reach it, and a requested release that finds nothing is closed by the
  seat that asked.
- **Detecting security or regression fixes from PR text.** No commit outside a
  release PR cited an advisory since `v1.5.0`; recognizing a regression fix from
  prose is a guess. The seat's request covers both.
- **A `regression` label or open issues as a blocker.** No PR or issue in the
  period carries a label; the rollback signal and the hold cover the cases.
- **Board task colour or icon as classification.** Free-form per card.
- **Releases for projects without a deployment ledger, and other projects'
  procedures.** No verified cut exists there; the setting is not offered.
- **A machine-wide default for the release setting.** Releases belong to a
  repository.
- **GitHub Release entries.** The repository's Releases page still shows 1.5.0
  as the latest; `gh release create` is not a kind the App covers, so it would
  run under a person's credentials. Adding it is a decision about the App's
  permissions.
- **A dedicated releaser role.** Builder, visual critic, reviewer and deployer
  cover it.
- **A configurable soak.** A constant until a release shows six hours is wrong.
- **Closing a release that waits days for the go.** It stays in Needs you.
- **Deprecating a bad npm version.** A bad release is fixed by a patch.
- **An automatic hold from the production auditor or the issue reporter.** The
  seat sets it.
- **A merge freeze during a release.** The cut makes it unnecessary.
- **Announcing releases to users** (Telegram, the landing page).

## Notes

- The seat's 1.12.0 card waits for #2762. This design's blocker 6 says the same
  thing for the same reason, so the hand release can proceed as the seat
  planned until the controller ships.
- `tesseract` is not installed on this machine, and the capture cannot run
  without it. Installing it needs root, so it is the operator's one step before
  the first automatic release (§8, Rollout).
- A requested patch release runs the same pipeline. After a breakage fix
  merges, the earliest tag comes after the deploy, six hours of soak, and a
  lane of two to four hours.
- The replay of §3.1 counts a PR six hours after its merge. The real cut also
  waits for the next deployment, so real releases fall somewhat later than the
  replayed ones.
- The ledger used here starts on 2026-10-08; older deployments were made before
  the checkout deploy recorded them.
- Numbers in §2 and §1.3 come from main at `aaf82e17` and the changelog there.
  Two PRs merged while this document was revised (main at `212d9780`). Every
  line this design cites still holds there except `baseRef` in
  `src/lib/pipelines/types.ts`, which moved from line 1190 to 1194.
