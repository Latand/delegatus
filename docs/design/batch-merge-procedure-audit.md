# Batch merge procedure audit

Status: report-only audit, first stage of board task b630f1fd. No product file,
procedure document, role, setting or branch protection was changed. A later
reviewed implementation on the same task owns every change proposed here.

## Originating requirement

Board task created 2026-10-29 and restated by the seat on 2026-11-08. Title,
verbatim:

> Пакетне злиття в CONTRIBUTING: спільний PR і CI GitHub як ворота

The request in the task text, verbatim:

> Узгодити документ і роль агента злиття з робочим способом, а для гілок
> інтеграції дати легкий режим перевірки перед push.

In English: batch merging in CONTRIBUTING should use one shared pull request
with GitHub CI as the gate. Align the document and the merger role with the
method that worked, and give integration branches a light pre-push check
mode. The task text also says three things. The documented procedure resets
every check whenever main moves. Three batches on 29.10 merged nothing. A
fourth batch (shared PR, GitHub CI as the gate, main merged in when it moved)
merged eleven PRs. Section 3 checks these leads against primary records. The
task's durations are not used for any speed or cost claim.

## Observation pin

- Inspected source: `main` at `6011394dd8160d0f61057f99369a7c84ab86d093`,
  committed 2026-11-08T11:27:59Z. The audit worktree's HEAD equals
  `origin/main`. Rechecked at 2026-11-08T13:57:50Z: unchanged.
- Observation window: 2026-11-08 13:42Z to 14:05Z.
- Instruction files read first: `AGENTS.md`, `CONTRIBUTING.md` (batch
  landing, forge writes, local hooks, required checks), `docs/merge-batch.md`.
- Forge (GitHub, read-only, 13:44Z to 14:03Z): main branch protection and its
  required checks, repository rulesets and branch rules, repository merge
  settings, the full open-PR inventory (31 open), PRs #3483, #3494, #3497,
  #3498 and the originals they carried, and the script-made batch PRs #3555,
  #3579, #3581, #3659 and #3666 with their timelines.
- Board records: task b630f1fd (this task), b28cc57e (the 28.10 to 29.10
  merge trains), 4e2d7ca7 (related; contradictory stage rules).
- Transcripts: the train 4 merger conversation (29.10, 11:32Z to 12:28Z), and
  the seat conversation's relay of train 5's final message (29.10, 13:40Z).

Every `file:line` below refers to the pinned revision.

## 1. Answers in brief

1. **What is true now.** The committed procedure, `scripts/merge-batch.ts`,
   already lands through one shared batch PR. It reads the required checks
   from main's protection and waits for them on the exact batch head. It also
   pushes its own branch after its own privacy gate, with the pre-push hook
   skipped. What it lacks relative to the requirement: every main movement
   voids the completed validation and reruns the full local gate, with a cap
   of three refreshes. Since the stale-copy fix of 2026-10-31 the script has
   landed multi-PR batches (#3555, #3579, #3581). Trains 4 and 5 on 29.10 did
   not use the script: their integration branches were assembled by hand.
2. **Can one integration PR with hosted required checks keep the final-head
   review, authority, privacy and merge fences while main advances?** Yes,
   under four conditions (section 5). Every content commit is a reviewed patch
   with an unchanged patch-id. Main is taken in only by an automatic rebuild.
   Trusted privacy runs before every push. The merge uses an exact-head match
   under strict protection. Two gaps exist on current main. The script does
   not re-read human change requests before its own merge (F9), and it cannot
   attribute a red hosted `typecheck` (F7). Hosted required checks run no
   touched behaviour tests. An operator decision of 2026-10-12 assigns that
   catch to the batch merger's tests gate (F5).
3. **What a light pre-push mode would need.** No change to `.githooks/pre-push`
   is required. The script's `publish` step already is that mode: trusted
   privacy over the candidate's commits and changed files, then a push with
   hooks skipped. That is the same shape the single-PR engine uses for its base
   updates (F6). Train 4 needed a seat exception only because it pushed a
   hand-built branch through the full hook. The exact hook change, if one is
   ever wanted, is listed under Deferred with its reasons.

## 2. Findings (observed)

**F1. One shared batch PR already exists in the committed procedure.**
CONTRIBUTING names the script as the procedure (`CONTRIBUTING.md:260-271`),
and the merger scaffold sends the merger to it (`src/lib/roles/defaults.ts:361`,
"Merge through the batch procedure the project's instruction files name").
`land` creates one PR from a `merge-batch/<uuid>` branch
(`scripts/merge-batch.ts:981-1009`). It reads required contexts from main's
protection (`:1059-1064`) and polls until they are green on the exact tip
(`:1065-1104`). It merges with `gh pr merge --rebase --match-head-commit`
(`:1092`), maps each landed commit back to its reviewed patch-id
(`:1107-1127`), and closes each unchanged original with a "Landed on main as
<sha> through #B" receipt (`:1129-1137`). The watcher verifies those
receipts (`src/lib/forge/batchLanding.ts:55-87`). The batch title and branch
prefix are a shared contract (`src/lib/forge/mergeBatchTitle.ts:9-31`). The
Docker PR build skips `merge-batch/` heads (`.github/workflows/docker-image.yml:35-46`).

**F2. Every main movement voids the whole validation and reruns the full
local gate, at most three times.** The doctrine is written in three places:
`CONTRIBUTING.md:273-275` ("Every tuple change voids the entire validation"),
`docs/merge-batch.md:122-126` and `:145-147` ("Three refreshes are allowed"),
and the scaffold (`src/lib/roles/defaults.ts:361`). In code, `stale()` clears
the receipt and counts a refresh whenever main moved (`scripts/merge-batch.ts:475-489`).
`refresh()` rebuilds and calls the full `gate()` (`:1011-1020`). `land()`
does the same on `BEHIND`, after a stale read, after a failed publish and
after a failed merge (`:1071`, `:1074`, `:1083`, `:1089`, `:1097`). The end
of `gate()` itself loops back to a full gate when main moved during it
(`:941`). `nextRefresh` throws on the fourth (`:280-285`). The full gate is
frozen install, `tsc`, comparative ESLint, touched tests with a fresh
native-main baseline, confirmation and removal probes, and trusted privacy
(`:340-352`, `:886-947`). Two tests pin this behaviour:
`scripts/merge-batch.test.ts:1376-1383` ("BEHIND rebuilds at most three
times") and `:1385-1403` (four fresh baselines, then "Main moved more than
three times").

**F3. Live branch protection (primary forge read, 13:44Z).** Main requires
four status contexts, `privacy-publication`, `privacy-tracker-audit`,
`runtime-gate` and `typecheck`, with strict up-to-date enforcement, admins
included. It requires no pull-request reviews, applies no push restrictions,
has no linear-history rule and no rulesets, and refuses force pushes. The
repository allows squash, merge-commit and rebase merges. It allows no
auto-merge and no update-branch, and deletes no branches on merge.
`CONTRIBUTING.md:696-700` matches this, so the lead that CONTRIBUTING names
three required checks is superseded on current main.

**F4. The four hosted required checks.** `typecheck` runs `bunx tsc --noEmit`
on every PR to main (`.github/workflows/memory-selection.yml:3-7`, `:17-48`).
`runtime-gate` joins the Bun runtime and native Codex jobs, which run fixed
runtime verdict sets on every PR (`.github/workflows/bun-runtime.yml:29-33`,
`:341-354`). The two privacy checks run on `pull_request_target`, with
whole-file coverage for publication (`.github/workflows/privacy-publication.yml:8`,
`:21`; `.github/workflows/privacy-tracker-audit.yml:12`, `:31`;
`CONTRIBUTING.md:335-337`). None of them
runs the touched tests of a PR or a batch. The full test suite runs nightly on
main only (`.github/workflows/nightly-tests.yml:3-5`).

**F5. An operator decision assigns new-test-failure detection to the batch
tests gate.** In `docs/design/checks-under-five-minutes.md:273-275`
(operator, 2026-10-12), "a new failing test is caught on CI" means the local
pre-push and then the batch merger's tests gate. Section 9 records that no
hosted touched-tests job is added (`:349`), and the protection table keeps the
batch tests gate unchanged (`:284`). The originating requirement names the
reset-on-every-main-move behaviour as the defect. It does not name this
decision.

**F6. The single-PR engine already gates a main-into-branch update on hosted
required checks alone.** A PR that is only behind gets an automatic merge of
the base into its head under the machine identity. A textual conflict goes to
a refresh lane (`src/lib/forge/baseUpdate.ts:44-69`). That commit is pushed
with `--no-verify`, because it "publishes no new text" and "the required
checks on the pushed head gate the merge" (`:71-82`; `CONTRIBUTING.md:204-212`).
No local test rerun follows. The engine squash-merges when the repository
allows it (`src/lib/forge/autoMerge.ts:276-283`), so main otherwise carries
one commit per PR.

**F7. A red hosted check is attributable only through privacy notices.**
`traceRequiredFailure` reads the failed workflow log and accepts only the
privacy gate's notice shapes (`scripts/merge-batch.ts:216-262`, `:1022-1047`).
A red `typecheck` or `runtime-gate` therefore stops the batch with "Red
required check names no batch commit or path; nothing merged". This behaviour
is pinned by `scripts/merge-batch.test.ts:1344`. The local gate runs `tsc`
with bisect attribution before publication (`:633-652`, `:927-935`). So
today a hosted `typecheck` red can follow only from a tree the local `tsc`
never checked, or from an environment difference.

**F8. The push of the script's own branch is already a light pre-push mode.**
Before any push or PR edit, `publish` runs the privacy gate from a detached
checkout of main with main's known-value catalog. It runs once over the
candidate (`--check-commits --require-known-values`) and once over the PR
body (`scripts/merge-batch.ts:956-991`). It then pushes with
`LLV_SKIP_HOOKS=1`, lease-protected after the first push (`:994-997`). That
invocation omits `--added-lines` and `--defer-unavailable-media`. By the
gate's argument handling, it therefore inspects whole changed files and
defers no media (`scripts/privacy-publication-gate.ts:3083-3104`); the hook
inspects added lines (`scripts/local-gate.ts:67-70`). Hosted privacy then runs
on the batch PR as a required check. A hand-pushed integration branch instead
meets the full hook (`.githooks/pre-push:3`, `:47`). That hook plans privacy
plus types, ESLint, touched tests, scoped Linux, runtime and native checks for
the union of every member's changes (`scripts/local-gate.ts:63-144`). Only a
push that changes no file, or only prose, is lighter (`:74`, `:77`;
`CONTRIBUTING.md:494-499`).

**F9. The human change-request fence is not enforced inside the script.** The
scaffold requires that an outstanding human request for changes block every
merge "in every merge state" (`src/lib/roles/defaults.ts:361`). The engine
enforces it with a paginated review read (`src/lib/forge/autoMerge.ts:204-231`).
`scripts/merge-batch.ts` reads neither `reviewDecision` nor reviews: its PR
fields are at `:385-386`, and its pre-merge recheck at `:469-473` compares
state, draft, base and head only. `land` is one blocking command that polls
for up to 240 iterations and merges inside (`:1065-1104`). A request filed
after the merger's own read and before the merge is not seen. The longer
`land` waits, the wider that window.

**F10. A merger run stage is told never to branch or push.** A read-write
pipeline stage receives "Never create or switch branches" and "Never push;
the pipeline publishes", overriding the role scaffold
(`src/lib/pipelines/prompts.ts:117-124`). The script creates and pushes a
`merge-batch/` branch (`scripts/merge-batch.ts:497-502`, `:994-997`), and the
merger fence allows that push (`src/lib/roles/defaults.ts:363`). A merger
launched with `spawn_agent` receives no pipeline branch contract. Trains 1 to
5 were spawned that way (the five launch assignments on board record
b28cc57e). Task 4e2d7ca7 owns this contradiction. This audit
only records that a batch merger must currently be spawned, and that a run
stage cannot follow the procedure.

**F11. The script reads required checks from classic protection only.**
`land` unions `contexts` and `checks` from the branch's classic protection
(`scripts/merge-batch.ts:1059-1064`). The engine also reads active branch
rulesets (`src/lib/forge/autoMerge.ts:286-294`). The repository has no
rulesets today (F3), so the two agree. With a future ruleset check, the script
would wait only for the classic contexts, and GitHub would refuse its merge
call.

**F12. Open work on the same files and the same idea.** Of 31 open PRs, two
touch files this plan would edit, and both merge cleanly with it. #3762
changes another role's scaffold in `src/lib/roles/defaults.ts` (hunk at its
line 185). #3668 (draft) adds a paragraph at `CONTRIBUTING.md:421`. A scratch
`git merge-file` of a planned edit to the batch section and the scaffold's
batch paragraph against both branches exited 0, with both sides present.
#3668 also adds a durable integration batch to the single-PR merge queue
(`src/lib/forge/autoMerge.ts`, `src/lib/pipelines/integration`). It is owned
by task 3d9a87c5 and blocked on a state-format transition. That is the same
idea in another component. This plan stays out of those files.

## 3. Historical leads, checked against primary records

| Lead in the task | Primary record | Status |
| --- | --- | --- |
| Trains 1 to 3 on 29.10 merged nothing | #3483 (train 1, head `integration/reviewed-<uuid>`) merged #3411 and #3472 at 01:13:11Z through a two-parent merge commit, `4c07d35d`, with all four required checks green. Train 2's and train 3's outcomes exist only in seat notes on b28cc57e. | Partly wrong: train 1 merged two PRs, through a hand-built integration PR. |
| Causes of trains 1 to 3 | Seat notes: train 1, two MCP cases that also failed on native main, treated as unattributable; train 2, thirteen cases failing only on stale reviewed test copies; train 3, the refresh cap after main moved four times. Current code: native-main failures are pre-existing (`CONTRIBUTING.md:289-291`); stale copies supply no detector (`docs/merge-batch.md:50-52`, #3527, merged 2026-10-31); the cap is still three (`scripts/merge-batch.ts:280-285`). | The first two causes are fixed on main; the third remains. |
| Train 4 merged eleven PRs through integration PR #3494 with hosted checks green | #3494, head `merge-batch/integration-20261029-4`, title outside the `Merge batch:` format, 80 commits including 11 "Merge reviewed PR #N into integration" merges on `daa116b8`. Created 11:47:10Z, merged 11:58:34Z as merge commit `e317e8d5` (parents `daa116b8`, `aa4ba255`). All four required checks green. GitHub marked all eleven originals MERGED at 11:58:36Z to 11:58:37Z. | Confirmed. It did not go through the script. |
| Main was merged in when it moved | The integration base equals main at merge (`daa116b8`). No main commit landed between assembly (11:35:59Z) and merge. #3498 likewise sits on `e317e8d5`, the main tip when it merged. | Not exercised: no primary record shows a hosted-gated batch surviving main movement. |
| Hosted CI was the whole gate | The train 4 merger's final message: full `tsc` passed locally, one test file passed, the remaining local tests stayed unrun at the forty-minute deadline, and the merge had already happened. The relayed final message of train 5 (#3498) says no local tests ran. | Confirmed: trains 4 and 5 landed without combination test evidence. |
| The push needed `LLV_SKIP_HOOKS=1` | Seat decision, 29.10 11:43Z, in the train 4 conversation: skip hooks for integration-branch pushes only, after a read PASS of the privacy gate against the merge base. Hosted privacy as the undo trigger. | Confirmed as a one-off exception for a hand-built branch (F8). |
| Hosted CI catches cross-PR defects | #3497 (train 5, 8 PRs): hosted `typecheck` FAILURE at 13:11:28Z. The seat attributed it to #3467 by hand, and #3498 replaced it without #3467. | Confirmed for types. The script could not have attributed it (F7). |

Further observations from the same records:

- Every integration merge in #3494 (11) and #3498 (7) equals Git's automatic
  three-way merge of its parents (`git merge-tree --write-tree`), so no
  hand-written resolution entered main. For #3483, #3494 and #3498 the landed
  tree equals the hosted-checked head tree.
- For eight of #3494's members, the merged head equals the reviewed SHA listed
  on b28cc57e. For #3465, #3470 and #3474 no reviewed SHA is on that record.
- Since the stale-copy fix, the script has landed `Merge batch:` PRs #3555
  (seven PRs in its title, 2026-10-31), #3579 (six, 11-01), #3581 (five, 11-02),
  #3659 and #3666. #3581 survived one main-movement refresh and #3666 two,
  each with a full re-gate, inside the cap. Every force push in their
  timelines moved the batch onto a newer main with the same number of batch
  commits (#3581: 5 before and after, at 00:22:46Z on 11-02; #3666: 1, at
  00:27:22Z and 00:40:24Z on 11-05). Each landed as single-parent rebase
  commits, and for #3581 and #3666 the landed tree equals the final
  checked head tree.

## 4. Hypotheses (not established)

- H1. Under strict protection, a batch whose hosted round takes about as long
  as main's merge interval can livelock. The single-PR queue has the same
  property. In the two observations, the last required check finished 9 min
  27 s after #3494's checks started (11:47:17Z to 11:56:44Z) and about
  10 minutes after #3498 opened. Two observations prove nothing about the rate.
- H2. CPU admission dominated the local gate on 29.10: the train 4 merger
  reported its first test file sixth in the CPU queue, and the seat recorded a
  queue 18 to 20 deep at 13:40Z. No measurement separates admission wait from
  execution, so no cost claim follows.
- H3. With main-only refreshes cheap, the existing 240-poll bound of `land`
  allows enough refresh rounds in practice. Untested.

## 5. Fence by fence: one integration PR, hosted gate, main advancing

| Fence | Where it is kept today | Holds with hosted checks gating main-only movement? |
| --- | --- | --- |
| Final-head review | Each listed PR merges only at its reviewed head, rechecked at build, rebuild, stale reads, publish, before the merge and before closing (`scripts/merge-batch.ts:469-473`, `:535`, `:1089`, `:1133`). The batch tip contains only reviewed patches with unchanged stable patch-ids; a conflict or changed patch defers (`:537-550`). Resolutions return to independent review (`:1189-1231`; `docs/merge-batch.md:161-168`). | Yes, if a main-only refresh keeps the rebuild (patch-id check per member). Merging main into an existing branch would add a merge commit that no patch-id check covers. |
| Authority | App installation principal verified before publication and again before the merge (`:445-461`, `:1072`, `:1088`). Machine identity on every batch commit (`:437-443`). Human change requests: merger agent only (F9). | Principal: yes. Human change requests: not inside `land` today; a longer `land` widens the gap. Workstream S4 closes it. |
| Privacy | Trusted privacy over candidate and body before every push (`:988-991`); hosted `privacy-publication` and `privacy-tracker-audit` required on the batch PR (F3, F4). | Yes: `publish` runs on every refresh before its push, and hosted privacy reruns on the new head. |
| Merge | Strict up-to-date protection, required contexts from protection, `--match-head-commit` on the exact tip, landed-patch mapping, receipts (`:1059-1127`). | Yes: every refresh produces a new tip, the merge waits for green on that exact tip, and a rebase of an up-to-date linear branch lands the checked tree. |
| New-failure tests (F5) | The batch tests gate on the merged candidate at the validated main (`:886-913`). | Only for the main SHA it validated. Hosted checks cover types and runtime on later tips (F4). This matches the risk the single-PR engine already accepts after a base update (F6). |

Conditions, all of which the workstream keeps or adds:

- C1. Content: every non-main commit on the batch branch is a member's
  reviewed squash with an unchanged patch-id. A main-only refresh rebuilds;
  it never hand-resolves.
- C2. Privacy: `publish` runs trusted privacy on candidate and body before
  each push, and hosted privacy is required.
- C3. Merge: wait for every required context to be green on the exact current
  tip under strict protection, then merge with `--match-head-commit`.
- C4. Authority: verify the App principal and read human change requests
  immediately before the merge call.

## 6. Keep-list of safety gates

Nothing in this list may be weakened by the implementation:

1. Trusted privacy from a detached checkout of main, with main's known-value
   catalog, over the candidate commits and changed files and over the PR body,
   before every push and PR edit (`scripts/merge-batch.ts:956-991`).
2. Hosted `privacy-publication` and `privacy-tracker-audit` as required checks
   (F3). The local hooks never replace them (`CONTRIBUTING.md:680-681`).
3. The pre-push hook unchanged for every other push, including hand-built
   integration branches. `LLV_SKIP_HOOKS=1` stays reserved for the script's own
   pushes after its privacy gate and for a recorded false positive
   (`CONTRIBUTING.md:677`).
4. Reviewed-head equality for every member, rechecked at each boundary and
   immediately before the merge (`:469-473`, `:1089`).
5. Stable patch-id equality of every member's squash; a conflict or changed
   patch defers that member for the pass (`:537-550`).
6. Machine noreply identity on batch and resolution commits (`:437-443`) and
   the attribution trailer rules (`:182-201`).
7. App installation principal verification before publication and before the
   merge (`:445-461`).
8. Required contexts read from protection; all present, finished and green on
   the exact tip; strict up-to-date (`:265-278`, `:1059-1086`).
9. `gh pr merge --rebase --match-head-commit` and landed-patch mapping before
   any original is closed (`:1092`, `:1107-1127`).
10. "Landed on main as <sha> through #B" receipts and their watcher
    verification (`:1134`; `src/lib/forge/batchLanding.ts:55-87`).
11. The full local gate for every new membership: frozen install, `tsc` with
    bisect attribution, comparative ESLint, touched tests against a fresh
    native-main baseline with confirmation and removal probes (`:886-947`),
    per F5.
12. The append-only attribution log, kept across refreshes (`:900`,
    `docs/merge-batch.md:128-134`).
13. Deferred conflicts resolved only after landing, then sent to independent
    review with `git show --remerge-diff` (`:1139-1231`).
14. The fences of the merger role: push only the owned batch branch and
    fast-forwards of listed branches; never push main or change protection
    (`src/lib/roles/defaults.ts:362-366`).
15. A finite bound on `land` (`MAX_REQUIRED_CHECK_POLLS`, `:281`).

## 7. Smallest implementation workstream

One builder lane on this task, followed by review. Files:
`scripts/merge-batch.ts`, `scripts/merge-batch.test.ts`, `CONTRIBUTING.md`
(batch landing section and the `LLV_SKIP_HOOKS` sentence), `docs/merge-batch.md`
and the merger scaffold in `src/lib/roles/defaults.ts:361`. It touches no
hook, no workflow, no branch protection and no engine file under open change.

**S1. A completed validation survives main-only movement.** Define the
validated membership as the ordered member numbers with their reviewed heads
and immutable patch-ids. When main moves and the rebuild on the new main keeps
that exact membership (no new deferral, culprit or head-moved row), carry the
receipt forward. Append `{ main, tip, at }` to a new `carried` list on the
`Validation` record (`scripts/merge-batch.ts:161`); the name avoids the
existing `RunState.refreshes` count (`:310`). Then `publish` (privacy,
lease push) and let hosted required checks on the new tip gate the merge. A
membership change keeps today's rule: void, rebuild, full `gate()`. Places to
change: `stale()` (`:475-489`), the end of `gate()` (`:941`), `refresh()`
(`:1011-1020`), the `land()` branches at `:1071`, `:1083`, `:1089`, `:1097`,
and `assertValidated` (`:430-435`), which then accepts the latest carried
`{ main, tip }` for the same membership.

**S2. The refresh cap counts membership re-validations only.** `nextRefresh`
(`:280-285`) moves to the membership-change path. Main-only refreshes stay
bounded by the existing `land` poll bound (`:281`, `:1065`). The run record
keeps the count and time of each main-only refresh (S1's `carried`), so a
later measurement of time-to-land after main movement can read it, including
from runs that end before landing.

**S3. A red hosted check after a main-only refresh gets the local
attribution path.** When a required check is red on a carried tip and its log
holds no privacy notice, void the receipt and run the full `gate()` on the
current tuple. Its `tsc` bisect names a culprit as it does today
(`:633-652`, `:927-935`). This counts toward the S2 cap. On a tip the local
gate validated, an unattributable red keeps today's stop (`:1037`), so a red
the local gate cannot reproduce stops at the next poll.

**S4. Human change requests are re-read before the merge.** In the pre-merge
recheck (`:1088-1090`), read each clean member's `reviewDecision` and its
paginated reviews. Apply the engine's rule (`src/lib/forge/autoMerge.ts:204-231`):
latest decisive review per reviewer, bot reviews excluded. A member with an
outstanding human request becomes `culprit review: human change request
outstanding`, one of the existing row forms, and returns to its lane. That is
a membership change (S1). The rule is copied into the script, because
importing the engine module into a script would load its state-owning graph
(`AGENTS.md`, state ownership). De-duplication waits until #3668 settles.

**S5. Text.** Replace the void-on-every-tuple-change sentence in
`CONTRIBUTING.md:273-275`, `docs/merge-batch.md:118-126` and `:145-151`, and
the scaffold's batch paragraph (`src/lib/roles/defaults.ts:361`) with the
membership rule. Main-only movement rebuilds the same reviewed patches, runs
trusted privacy and is gated by the required hosted checks on the new tip. Any
membership change voids the validation. Replace "fail on ... repeated main
movement" with failure at the `land` bound. Add one sentence near
`CONTRIBUTING.md:677`: the script pushes its own batch branch and deferred
resolutions after its trusted privacy gate with hooks skipped, the way the
engine's base update does, and integration branches are published only
through the script. Shipped scaffolds reach every installation without an
upgrade table, because a scaffold override can only be reset to the shipped
text (`src/lib/roles/store.ts:234-263`). The project forbids tests on prompt
phrases (`AGENTS.md`), so S5 adds none.

Tests, all in `scripts/merge-batch.test.ts`, run by path:
`bash scripts/gate-slot.sh bun run test scripts/merge-batch.test.ts`, with
private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR and a closed
LLV_VIEWER_CONTROL_URL (`CONTRIBUTING.md:702-709`).

- T1 (replaces `:1376-1383`). After one completed `gate`, main moves four
  times while `land` waits. Expected: four rebuilds, four candidate and four
  body privacy runs, no further `tsc`, ESLint or test command, four `carried`
  entries, the `refreshes` count still 0, and a merge with
  `--match-head-commit` on the fourth tip once checks are green. Today the
  same input fails with "Main moved more than three times".
- T2 (replaces `:1385-1403`). Main moves during `gate`'s tests step with the
  membership unchanged. Expected: exactly one native-main baseline and a
  receipt carried to the new main. A second variant, where the move turns one
  member into a conflict, expects a full re-gate of the remainder.
- T3. A member's head moves during `land`. Expected: that row is `head-moved`,
  the remainder gets a full re-gate, and the cap counts one.
- T4. A red `typecheck` on a carried tip with no privacy notice. Expected: a
  full re-gate whose `tsc` bisect names the member; that member becomes a
  culprit and the rest lands. The existing `:1344` case, where the red falls on
  the validated tip, stays green unchanged.
- T5. A privacy refusal on a refreshed candidate. Expected: no push and no PR
  edit after the refusal.
- T6. A human `CHANGES_REQUESTED` filed after `gate` on one member, and a bot
  request on another. Expected: the first becomes a culprit row naming the
  review, the remainder is re-gated and lands; the second changes nothing.

Acceptance: T1 to T6 green and every existing test in the file green. The
publication pre-push passes, with its touched-test selection, which includes
this file. A walk-through of the requirement's example: a batch whose main
moves while hosted checks run lands on the latest tip after one local
validation, with privacy before every push and with the hosted required checks
as the gate for each new tip.

## 8. Deferred — not currently justified

- **A hook-level light mode.** It would add, in `scripts/local-gate.ts`
  (`main` near `:942-974` and `plan` at `:74`), a classifier that treats a
  push as having no new content when every commit in its range is either
  reachable from a published ref or an automatic merge commit, with its tree
  equal to `git merge-tree` of its parents and a machine identity. The hook
  would then plan privacy only. Tests would go in `scripts/local-gate.test.ts`
  and `scripts/local-gate.hooks.test.ts`. No caller needs it once integration
  branches are published only by the script (F8). Reachability from local
  remote-tracking refs proves nothing for fork heads. It would also widen the
  hook's skip surface for every branch.
- **Merging main into the batch branch and landing with a merge commit
  (the train 4 shape).** It satisfies strict protection the same way as a
  rebuild (S1), but it skips the patch-id recheck for the merge commit, needs a
  new landed-commit mapping and receipt path, and changes main's
  one-commit-per-PR shape (F6). Merging reviewed heads directly would bring each
  PR's internal history onto main.
- **Dropping the batch tests gate and gating on hosted checks alone, as trains
  4 and 5 did.** That reverses the operator's Decision 2 (F5). It needs the
  operator to name that decision; the originating requirement does not.
- **A hosted touched-tests required check.** Decision 2 did not add one, and
  adding it would change branch protection, which the merger fences forbid.
- **Reading ruleset-required checks in the script (F11).** No ruleset exists
  today; GitHub's own refusal would stop such a merge.
- **A wall-clock bound for `land`** to replace the poll bound. Revisit only if
  H1 or H3 is observed.
- **The merger run-stage contradiction (F10).** Owned by task 4e2d7ca7.
- **Converging with #3668's durable integration in the merge queue.** It is a
  draft owned by task 3d9a87c5. Revisit after it lands.

## 9. Evidence gaps

- No primary record shows a hosted-gated batch surviving main movement:
  #3494 and #3498 saw none, and #3581 and #3666 refreshed under the full
  re-gate. S1's behaviour under real main movement is unobserved until the
  first run after implementation.
- Train 2's and train 3's outcomes, and every train duration, come from seat
  notes only. The merger conversations of trains 1 to 3 were not read. No
  duration is used here.
- For #3465, #3470 and #3474 in #3494, the board record names no reviewed SHA,
  so equality of merged head and reviewed head is unverified for those three.
- Whether any post-fix script run hit the three-refresh cap: an exact-phrase
  transcript search found no record, and a search index proves no absence.
- Train 5's local-test statement comes from its final message as relayed into
  the seat conversation; its own conversation was not opened.
- Hosted round duration rests on two PRs' check timestamps.
- `privacy-tracker-audit` is required with no app binding (`app_id` null in
  the protection record), so any integration posting that context name can
  satisfy it. This is a pre-existing protection setting outside this
  workstream, recorded here for the seat.
