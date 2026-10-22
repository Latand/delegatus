# Maintaining software with the GPT-6 family: what Delegatus should adopt

Status: research, no product change. Written 2026-10-20 against `main` at
`41cf07a04`; `origin/main` was still at that commit when the document was
finished (checked 2026-10-20 15:55Z). Every `file:line` below is from that
commit. The one open pull request that touches a file cited here is #3128
(the pre-push touched-test gate); nothing below depends on its diff.

## Originating requirement

Operator, 2026-10-20 about 15:40Z, orchestrator seat chat, in Ukrainian. The
pinned specification forbids copying, translating or excerpting the message
into a published file, so it is paraphrased: read the OpenAI developer blog
post "Maintaining software with the GPT-6 family", think about how its
practices could be used in Delegatus, and do the work on Fable. The pinned
acceptance adds: observe the post first and quote nothing unread; summarise
its practices, model roles, tool features and numbers; map each onto
Delegatus as it is today with `file:line` evidence across the role table,
pipelines, the gate and CI, board maintenance, memory curation and the Codex
integration; rank at most eight proposals with one recommended first step;
list open questions for a decision form; end with a short Ukrainian summary.

The default answer to "should we build this" is no. The requirement asks for
research and proposals, so this document builds nothing and every proposal
below says what it would measure before it is worth building.

## 0. Earlier answers

`search_transcripts`, project-scoped then unscoped, for the post's title and
for "dead code cleanup flaky tests CI minutes maintenance lane"; `search_memory`
for "maintenance dead code flaky CI cost per finding model effort comparison".

| Hit | What it settles |
| --- | --- |
| The seat conversation of 2026-10-20 | Only the operator's request itself; nobody had read the post before this lane. |
| `search_memory` | Nothing on the topic. |
| Transcripts on "flaky" and "maintenance" | The gate's FLAKY classification lines in stage reports, the board-maintenance timer design, and the checks-under-five-minutes lane; none of them is a maintenance pass over the code. |

Three existing documents already cover parts of what the post describes and
are reused below rather than re-derived: `docs/design/model-analysis-2026-10.md`
(a model/effort comparison method over pipeline records),
`docs/design/memory-quality-benchmark.md` (an offline replay harness for
delivered instructions, designed and not built) and
`docs/design/checks-under-five-minutes.md` (the CI and pre-push measurement
with its cut list). Issue #1761 (open) is the CI audit the post's third
prompt would produce; #2226 (open) lists 25 test cases red on `main` outside
CI; #1355 (open) asks for Viewer-owned scheduled agent runs.

## 1. The post, as read

### 1.1 Provenance

- URL: `https://developers.openai.com/blog/maintaining-software-with-the-gpt-6-family`.
- Fetched 2026-10-20 15:52Z with `curl` into this stage's scratch directory:
  HTTP 200, 418,843 bytes of HTML. The article body was extracted from the
  `<article>` element (12,416 characters after stripping markup) and read in
  full. The page's own metadata dates it 14 Oct 2026; its description reads
  "How OpenAI's Core Experimentation team uses Codex to remove unused code,
  clean up stale experiments, and improve CI."
- Links inside the article: only the OpenAI careers page and the Statsig
  home page. Codex, GPT-6 and the prompts are not linked to any further page,
  so no linked page was needed to understand it and none was read.
- Every claim about the post below names the section heading it comes from.
  The post has an untitled introduction and five headed sections: "Removing
  unused code", "Tracking down stale experiments", "Improving cost
  effectiveness with GPT-6.1 Sol", "Other ideas to try", and "Start small,
  review, and expand".

### 1.2 What the post says, section by section

**Introduction.** Coding agents made the team build faster and raised its
maintenance load (unused code, finished experiments, broken tests). GPT-6
Astra "helped us build and maintain software faster, and GPT-6.1 Sol
delivered similar results at a lower cost". The post covers finding cleanup
opportunities, gathering evidence, and preparing changes for review.

**Removing unused code.** Before agents, dead-code removal rested on static
analysis plus runtime logging and still caused incidents (reflection,
code paths kept for incident mitigation). With GPT-5.6 Sol in Codex, the
author gave an area and "clear validation criteria" and let the model write
the static analysis and remove the code; those prompts were "easier to
develop and maintain than our existing static analysis systems, with similar
reliability". GPT-6 Astra was then given a deliberately short, ambiguous
prompt (quoted "typos and all") that invited it to check chat threads, the
feature-flag platform "or any other source you need" to confirm non-use.
Astra "looked at past PRs, gathered context from Slack threads, and inspected
internal project trackers", "read production performance profiling tables to
confirm the deleted lines were never reached", and "explained its rationale
for each deletion, which accelerated our reviews". Five engineers ran
variations part-time over two weeks: more than 1,400 pull requests merged,
over 800k lines deleted, reviews "fanned out to various teams with context on
each affected project". Named wins: one container image 3.31 GB to 1.72 GB
(48 %), about 400 visual snapshot variants removed from a test suite.

**Tracking down stale experiments.** Harder than dead code because the code
still runs and eligibility can change; their earlier deterministic analysis
plus database queries had "many false negatives". The author brainstormed
with Astra and had it write the prompt for a new thread. That prompt's
safeguards are the reusable part: verify the live configuration; check git
history and overlapping PRs; preserve production behaviour, operational
safeguards and kill switches; ignore SDK fallbacks and local overrides; one
small draft PR per cleanup, linking the configuration console in the
summary. The author commented on the PRs, then asked Astra to fold those
comments into a new prompt for the whole codebase, and to add
prioritisation. The resulting `/goal` prompt asks for every stale, constant,
abandoned or fully shipped flag, config, experiment and layer, including
indirect usages (enums, wrappers, aliases, dynamically assembled names,
cross-service consumers), each object's cloud resource and CPU cost from
production telemetry, and a markdown report "grouping all verified
candidates into parallelizable ownership/file workstreams, including
production values, evidence, owners, callsites, and observed evaluation or
CPU costs", with "Do not modify live configurations or services". The report
led to the removal of hundreds of experiments and flags. The worked example:
a years-old flag that mapped onto every other feature flag caused CPU
fan-out; Astra measured it but "raised the finding for human review because
the flag had been explicitly marked as 'Permanent'"; after review it was
removed with an estimated 0.42 % CPU saving in the main affected service.

**Improving cost effectiveness with GPT-6.1 Sol.** The same stale-experiment
prompt was run on three model/effort combinations over subdirectories of
"over 6,000 files and 1 million lines of code in Python, TypeScript, Go and
Rust", and the author reviewed the findings. The chart's figures:

| Combination | API cost | Findings | Cost per finding |
| --- | ---: | ---: | ---: |
| GPT-6 Astra Ultra | $109.06 | 142 | $0.77 |
| GPT-6.1 Sol Ultra | $15.12 | 131 | $0.12 |
| GPT-6.1 Sol Medium | $5.27 | 86 | $0.06 |

"Costs use standard API pricing and include research subagents and the
follow-up turns Codex ran automatically while working toward each goal."
Sol Ultra produced "92% as many findings as GPT-6 Astra Ultra at 14% of the
API cost". The discrepancies on Ultra were mostly "constant feature flags
used as dependencies in other feature flags", which Astra caught and Sol
missed. The method the post draws from this: find the error patterns of the
cheaper model, write prompt corrections for them, and "revisit prompts when
new models are released" because corrections go stale.

**Other ideas to try.** Three short prompts, each labelled for GPT-6.1 Sol
Medium, with the advice to raise effort "for broader audits if the results
are promising":

1. Flaky tests: look at recent CI runs, find flaky tests, "try a fix and if
   successful put up a PR"; the job is "clear fixes to simple issues, not to
   exhaustively fix every flaky test". Written as a `/goal` prompt.
2. Agentic context: look through recent Codex sessions for one `AGENTS.md`
   instruction that "appears to have misdirected an agent or caused
   unnecessary work"; replay that session's prompt twice from the same
   repository snapshot and model, once unchanged and once with only that
   instruction removed or fixed; compare "task quality, agent behavior, tool
   calls, token usage, runtime, and cost".
3. CI load: list ideas to relieve CI load in a table "ranked by estimated CI
   minutes saved per day based on this repo's CI run history". Following up
   on that prompt landed about 30 CI PRs; median CI completion fell from
   roughly 10 minutes to 4.5, the 90th percentile from 12.5 to 6; one missing
   mock cut a 63-test suite from 592.6 s to 29.8 s with all tests retained.

**Start small, review, and expand.** More than 1,400 maintenance PRs merged
from GPT-6 proposals, with faster tests, smaller images and lower CPU. "Some
proposals added more complexity than their expected benefit justified, so
prioritization and measurement remained an important part of our workflow."
The recommended ramp: one small task (unused code, a stale flag, a flaky
test); ask Codex to find an instance, gather evidence and propose a small
draft PR; compare models and efforts on that small task "since a cheaper
configuration may be enough"; then a subdirectory or well-scoped project,
folding code-review feedback into the next prompt at each step; then the
whole codebase.

### 1.3 Practices, roles and features in plain words

| Practice | Section | New, or generally known? |
| --- | --- | --- |
| Evidence-gathering replaces analysis tooling: the agent reads PR history, trackers, chat and production profiles to prove non-use, and explains each deletion | Removing unused code | Known in outline; the new part is trusting a maintained prompt over a maintained static-analysis system and reporting "similar reliability". |
| Prompt safeguards as the contract: live config, git history and overlapping PRs, kill switches kept, SDK fallbacks ignored, one small draft PR each, console link in the summary | Tracking down stale experiments | A reusable checklist; the "one small draft PR per cleanup" and "do not modify live configurations" lines are the operational core. |
| Report first, then fan out: a whole-repository audit produces a markdown report grouped into parallelisable ownership workstreams with evidence, owners, call sites and measured cost | Tracking down stale experiments | The pattern that makes hundreds of removals reviewable. |
| A flagged "Permanent" object is raised for human review, with the cost measured, rather than removed | Tracking down stale experiments | The judgement rule the post holds up as the model's merit; Delegatus has the same rule in words (detectors are hints, the human decides). |
| Fixed-task model/effort comparison with cost per accepted finding; discrepancy classes become prompt corrections; prompts are revisited at each model release | Improving cost effectiveness | The most transferable method. The numbers are theirs; the method is cheap to copy. |
| Three recurring maintenance prompts for a cheap model at medium effort, effort raised only when results are promising | Other ideas to try | Known individually; the instruction-replay A/B is the least common one. |
| Start small, review, incorporate feedback into the prompt, expand | Start small, review, and expand | Known; the post is explicit that prioritisation and measurement stayed necessary because some proposals added complexity. |

Model roles in the post: GPT-5.6 Sol for a well-specified area with
validation criteria; GPT-6 Astra for the ambiguous, evidence-heavy first
pass and for writing the prompts themselves; GPT-6.1 Sol Ultra for broad
audits at a fraction of the cost; GPT-6.1 Sol Medium for the recurring
small prompts. Tool and API features named: Codex `/goal` prompts (the
"follow-up turns Codex ran automatically while working toward each goal"),
"research subagents" counted in the cost, draft pull requests, and the
team's feature-flag console, chat and tracker as evidence sources. No API
endpoint, SDK or parameter is named in the post.

## 2. Delegatus today, area by area

Each row says what Delegatus already does, what it does differently, and
what is missing against the post.

### 2.1 Role registry and role table

| Fact | Where |
| --- | --- |
| Thirteen frozen role ids: orchestrator, reviewer, verifier, builder, architect, cleaner, prod-auditor, deployer, merger, maintainer, curator, issue-reporter, visual-critic | `src/lib/roles/types.ts:1-15` |
| Shipped runtimes: orchestrator claude/opus/high; reviewer codex/gpt-6.1-sol/xhigh; verifier sol/high; builder sol/high; architect claude/opus/xhigh; cleaner codex/gpt-6-luna/medium; prod-auditor sol/xhigh; deployer sol/medium; merger sol/high; maintainer sol/medium; curator sol/high; issue-reporter claude/claude-sonnet-5-5/high; visual-critic claude/opus/high | `src/lib/roles/defaults.ts:228,255,271,283,297,309,319,334,347,364,372,381,389` |
| Variants: builder trivial/frontend/docs on Sonnet 5.5 high, apply-fixes on Luna high, reviewer trivial on Luna high; precedence trivial > domain fixes > domain > apply-fixes | `src/lib/roles/paramConfig.ts:12-22,45-57` |
| Codex effort scales from `models_cache.json`: gpt-6 and gpt-6.1 astra/sol run low…xhigh, max, ultra; luna stops at max | `src/lib/agent/efforts.ts:7-8,35-47` |
| Per-role Codex service tier, validated against the account catalog before launch | `src/lib/roles/types.ts:25`, `src/lib/accounts/codexServiceTiers.ts:11`, `docs/design/codex-service-tier.md` |
| The seat's sizing rule: trivial / normal / design, with the row and effort for each, and "Sonnet never orchestrates, architects or reviews above size=trivial" | `src/lib/orchestrator/prompt.ts:656-659` |
| Cost classes by model and effort rank, used for sizing hints | `src/lib/roles/costHints.ts:26-44` |
| Fresh-launch Codex default is gpt-6.1-sol | `src/lib/agent/models.ts:102` |

Already does: the post's model roles are the role table's rows. GPT-6.1 Sol
is the default Codex model and the row for every Codex role except the
cleaner; medium effort is already the row for the three housekeeping roles
(maintainer, deployer, cleaner), which is the post's "Sol Medium for the
recurring small prompts". Astra is selectable per launch and per stage.

Differently: effort is fixed per role row, and the sizing rule chooses the
row by the task's size class. The post's rule is effort by promise ("start
at medium, raise for broader audits if results are promising") on one task
over time, which no row expresses. No role runs at `ultra`, the effort both
of the post's broad audits used; the scale is present (`efforts.ts:43`) but
unused by any row and unmeasured here.

Missing: a role whose job is code maintenance. The cleaner recovers a dirty
checkout (`defaults.ts:306-313`), the maintainer tends the board and may not
touch files (`defaults.ts:362-368`), the curator tends memory. A dead-code or
stale-mechanism audit today is an architect (`mode=architecture-audit`) or
prod-auditor stage composed by hand.

### 2.2 Pipelines: stage graph, review loops, budgets

| Fact | Where |
| --- | --- |
| One to eight `run` stages in one worktree; `next` is the pass edge, `onFail` the fail edge; cycles only on fail edges | `docs/pipelines.md:3,86` |
| Review loop: fresh reviewer each round, fix stage is a builder in apply-fixes mode on the light row, `maxRounds` fixed at creation (three by default, at most nine), `onExhausted` advance / stop-after-fix / park | `docs/review-loop.md:1-60`, `src/lib/pipelines/failEdgeBudget.ts:51-98` |
| Rounds are counted from durable activation records; a retry spends no round; a spent budget hands findings on once | `src/lib/pipelines/failEdgeBudget.ts:39-65,88-98` |
| Which roles may be stages: cleaner, prod-auditor, deployer, merger and visual-critic are; maintainer, curator and issue-reporter are not | `src/lib/pipelines/roles.ts:12-23` |
| Pipeline nesting is forbidden; only the seat composes lanes | the stage brief's controller instruction, and `SPAWN_DENIED_ROLE_IDS` at `src/lib/agent/spawnAdmission.ts:36` |
| Child subagents: `allowSubagents` exists on `spawn_agent` (`src/lib/mcp/server.ts:4030`) and the spawn route (`src/lib/agent/spawnCommand.ts:400-424`); a pipeline stage carries no such field; Codex `multi_agent` is off for every launch without the grant | `src/lib/runtime/codexAppServerHost.ts:1500-1502`, `docs/design/codex-subagent-permission.md` |
| Token usage is stored per hour with project, role, pipeline and stage, and priced per model and tier for comparison | `src/lib/activity/tokenStore.ts:39-43`, `src/lib/activity/tokenPrices.ts:5-12,55-58` |

Already does: the lane is the post's "one small draft PR per cleanup": one
worktree, one branch, one PR, a review loop with a bounded budget, and the
fix round on a cheaper model. The seat's "size the lane first" rule is the
post's "compare models and efforts for that small task" at the granularity of
size classes. Token and cost attribution per pipeline and stage exist, so a
cost per lane and per finding is computable from records that already exist
(`tokenStore.ts:40` keys rows by pipeline and stage; `tokenPrices.ts:55-58`
prices the GPT-6 family at standard, flex, fast and ultrafast tiers; the
design is explicit that on a subscription this is a comparison figure, never
spend).

Differently: the post's audit produced one report and then hundreds of
PRs. Delegatus has no "report, then fan out" primitive. A report stage can
write a markdown file as a declared output, and the seat then creates one
lane per workstream by hand, which is what the mandate asks of it anyway.
The post's "research subagents" ran inside one Codex thread; here a
read-only stage runs single-agent unless the launcher grants subagents,
and a pipeline stage cannot be granted them at all.

Missing: nothing structural for the first pilot. For a whole-repository
pass, a way to create N sibling lanes from one report without the seat
typing each is the gap (proposal 7, deferred).

### 2.3 The pre-push gate and CI

| Fact | Where |
| --- | --- |
| Pre-push runs `scripts/local-gate.ts pre-push` | `.githooks/pre-push:10` |
| Touched tests: branch first; only files failing on the branch are run on the merge base; a failure confirmed on both sides is PRE-EXISTING; up to three confirmation reruns per side within a five-minute shared budget; FLAKY sites are logged and dropped from the blocking set | `scripts/local-gate-tests.ts:44-45,55-137,435-442` |
| The FLAKY classification is a log line; nothing stores it beyond the push's output | `scripts/local-gate-tests.ts:437` (the only writer) |
| Merge-required CI: privacy-publication (p50 5.2 min) and privacy-tracker-audit (0.6 min); the required set p50 5.3 min, p90 5.8 min for pull-request heads on 11–12 Oct 2026 | `docs/design/checks-under-five-minutes.md:104-116` |
| The same design measured the local pre-push at 25–35 minutes per push, 14 of 25 minutes waiting for admission on the small scenario, and listed its cut list C1–C10 | `docs/design/checks-under-five-minutes.md:37-59` |
| Test files in `src` and `scripts`: 2,120 (`find … -name "*.test.ts*"`, this commit) | counted for this document |
| #1761 (open): per-workflow durations, flake rate, ten slowest and ten flakiest, a deletion classification, a merge-path policy, and the cuts | issue body |
| #2226 (open): 25 test cases red on `main` that no workflow runs; it cites #1761's finding that 92 % of test files run in no workflow | issue body |
| No dead-code tooling: `package.json` scripts, `scripts/*.ts` and the ESLint config name no unused-export or dead-file checker | `package.json:30-48`; grep over `scripts/` and the ESLint config for knip, ts-prune, depcheck and unused-export rules returned nothing |
| One manual repository cleanup inventory, 2026-09-21: 3,094 tracked files, 62,254,260 bytes at the baseline, with a per-candidate disposition table | `docs/repository-cleanup.md:1-18` |
| One manual duplicated-mechanisms audit, 2026-10-11, six families with `file:line` and a ranked slice list | `docs/design/duplicate-mechanisms-2026-10.md` |

Already does: the flaky-test problem the post's first prompt targets is
already detected at every push (three reruns per side) and already has an
issue with a method (#1761) and a red list (#2226). The CI-minutes problem the
post's third prompt targets was measured on 11–12 Oct 2026 and the required
checks are already at the post's post-optimisation level (p50 5.3 min
against their 4.5). The remaining cost here is the local pre-push, which the
post has no counterpart for.

Differently: both audits (cleanup inventory, duplicate mechanisms) were
one-off lanes with a human-readable table, which is the post's "report"
pattern done once each. Neither was turned into a prompt that is re-run.

Missing: a durable record of flaky confirmations across pushes (today a
lane's report is the only trace), and a CI run-duration history inside
Delegatus (the design pulled it ad hoc through the forge CLI; nothing in
`src/lib` reads workflow-run durations). Any dead-code pass would start from
zero tooling, which is exactly the situation the post's first section
describes.

### 2.4 Board maintenance and the seat tick

| Fact | Where |
| --- | --- |
| Board maintenance: a maintainer run on the seat tick, at most once per interval, default 3 hours, off by default | `src/lib/monitor/seatTickSettings.ts:417-418`, `docs/design/board-maintainer.md:96-120` |
| Memory curation: a curator run, default every 6 hours, on by default | `src/lib/monitor/seatTickSettings.ts:401-402` |
| The maintenance brief carries the previous run's card summary, changes, questions and left-alone list, then says the record is history and every decision is confirmed from current state | `src/lib/boardMaintenance/text.ts:57-76` |
| The maintainer may not edit files; writes go through `create_task` and `update_task` only | `src/lib/roles/defaults.ts:366` |
| #1355 (open): Viewer-owned cron-style agent runs per project, loud when a run does not start | issue body |

Already does: Delegatus already has the post's "incorporate the last run's
outcome into the next prompt" loop, built in, for board hygiene: every
maintenance brief carries the previous run's record. The timer, the
once-per-interval claim and the settled-run wake are the machinery a
recurring code-maintenance prompt would need.

Differently: the two timers are hard-wired to one role each. There is no
third slot, and the generic scheduler is still an open issue (#1355).

Missing: a recurring code-maintenance run. Until the audit prompt is stable
(proposal 1), a seat-created lane on request is enough; the timer is the
last step, not the first.

### 2.5 Memory curation and learned rules

| Fact | Where |
| --- | --- |
| Stage-end lessons through `leave_lesson`; rules injected per role, project and machine | `docs/design/role-memory.md`, `docs/design/role-memory-curation.md` |
| The curator's seven checks: task-specific, current against code and instructions, readers, level, duplicates, contradictions, general and ranked | `src/lib/memory/curation/brief.ts:6-12` |
| The curator writes only through `curate_rules`, reads the repository to judge currency, and may transfer a concrete defect to the seat's agenda as a `problem` | `src/lib/mcp/server.ts:3672`, `src/lib/memory/curation/brief.ts:14-27` |
| A curator evaluation fixture: fifteen invented rules in an isolated store, run only under `LLV_CURATOR_EVAL=1` | `src/lib/memory/curation/curator.eval.test.ts:13-39` |
| The offline replay set M0…M3 (no rules / delivered block / candidate block / delivered plus the rule written after the failure), judged by a deterministic reproduction then a blind reviewer; its no-model dry run "has not been written or run" | `docs/design/memory-quality-benchmark.md` §4.1 |
| Its improvement plan ranks the replay harness ninth and curator calibration tenth, each with a metric | `docs/design/memory-quality-benchmark.md` §5 |
| What to measure after the role prompts were rewritten from memory: lessons that repeat a prompt block, copy groups after curation, characters a builder reads before its brief, reviewer findings per round by class | `docs/design/role-memory-to-prompts.md` §5.8 |

Already does: the post's second prompt (find one instruction that
misdirected an agent, replay with and without it, compare) is already
designed here, in more rigour than the post, for learned rules: the replay
set, the four conditions, the blind judge and the noise band. The curator
already judges every rule against the current code and instruction files
(check 2), which is the post's "revisit prompts when new models are
released" applied continuously to memory.

Differently: the curator judges by reading, never by replay, and it judges
learned rules, not `AGENTS.md` or the role scaffolds. The post's replay is a
cheap two-run A/B; the designed harness here is a 40-item pilot behind a
spend decision.

Missing: the replay launcher itself (engine memory off plus a frozen
instruction block delivered through the production channel), and any run
of it. The post's version is a strict subset of what §4.1 designs, so the
cheapest path to both is one tool (proposal 5).

### 2.6 Codex integration

| Fact | Where |
| --- | --- |
| Installed Codex CLI 0.162.1; its app-server protocol was generated into scratch for this document (`codex app-server generate-ts`, empty config home) | run 2026-10-20 15:54Z |
| The protocol carries thread goals: `thread/goal/set` with `objective`, `status` and `tokenBudget`; a goal has `tokensUsed`, `timeUsedSeconds` and a status of active, paused, blocked, usageLimited, budgetLimited or complete; the server notifies on goal updates | generated `v2/ThreadGoalSetParams.ts`, `v2/ThreadGoal.ts`, `v2/ThreadGoalStatus.ts`, `v2/ThreadGoalUpdatedNotification.ts` |
| `codex features list` with an empty config home on 0.162.1: `goals stable true`, `multi_agent stable true`, `multi_agent_v2 stable false`, `memories stable false` | run 2026-10-20 15:58Z |
| Delegatus keeps `goals` on its single-agent feature allowlist, so a denied launch leaves it enabled, and disables `multi_agent` with `agents.enabled=false` unless subagents were granted | `src/lib/agent/codexSpawnPolicy.ts:9-18`, `src/lib/runtime/codexAppServerHost.ts:1486-1502` |
| No Delegatus code calls the goal methods; the launch profile's `goal` field is Delegatus's own `AgentGoal` and is `null` on every fresh launch | `src/lib/accounts/migration/contracts.ts:86`, `src/lib/agent/cli.ts:419,455,497` |
| Model catalog and service tiers are read from each account's `models_cache.json`; an explicit tier that the catalog does not offer refuses the launch | `src/lib/agent/ephemeral.ts:105-130`, `src/lib/accounts/codexServiceTiers.ts:11`, `docs/design/codex-service-tier.md` §Decision summary |
| The model/effort comparison method over pipeline records: attempt pass rate, first-review pass, rounds to pass, tokens, with a 30-lane floor before any role change; monetary cost was unmeasured when it was written | `docs/design/model-analysis-2026-10.md:11-19,116-124` |

Already does: the structured host is the post's Codex, with the same models,
effort ladders and tiers, read from the real catalog rather than guessed. The
model-analysis method is the post's comparison done over hundreds of lanes
instead of three runs, with stricter thresholds.

Differently: the post's unit of comparison is cost per accepted finding on
one fixed prompt and snapshot; the model analysis compares pass rates over
heterogeneous lanes and says itself that it "does not establish a causal
ranking". The post's `/goal` loop lets Codex keep taking turns towards an
objective under a token budget; Delegatus's loop is the stage graph, where a
turn ends with `stage_report` and the server decides what runs next. The two
loops would compete inside one stage unless the goal is set to complete at
the report.

Missing: nothing is needed from the Codex integration for the first three
proposals. The thread-goal feature is a possible later experiment
(proposal 6), to be probed against a stub before any design.

## 3. Ranked proposals

Rank is expected benefit for this installation divided by cost and risk.
Size: trivial (a prompt or a seat practice), normal (one lane, no shared
contract changed), design (a document first). "Do not" names the trap the
post itself warns about or the Delegatus rule it would break.

### P1. One maintenance pilot lane on one subdirectory, report first, no deletions (recommended first step)

- Outcome the operator sees: a markdown report in `docs/audits/` listing
  every dead-code and stale-mechanism candidate in one chosen subdirectory,
  grouped into workstreams, each with evidence (import-graph reachability
  from page, layout and route entries; last commit that touched it; whether
  any test, script, workflow or runtime string references it; for UI,
  whether a mounted surface has a caller that opens it), an owner (none here:
  the lane that would delete it) and a risk note; nothing deleted.
- What changes in Delegatus: nothing in code. The seat creates one pipeline
  with a read-only first stage (architect `mode=architecture-audit` or
  prod-auditor, codex/gpt-6.1-sol, effort medium) whose declared output is
  the report, and the post's safeguards translated: verify by reading the
  current tree and the import graph; check git history and open PRs; keep
  anything an instruction file, a workflow, a privacy manifest or a runtime
  string names; one workstream per removal set; a form for the operator at
  the end. The seat then creates one `size=trivial` lane per accepted
  workstream (builder Sonnet 5.5 high, fix row Luna, reviewer per Q4 below),
  one PR each, through the ordinary review loop and the gate.
- Size: trivial for the product, normal for the seat (one audit lane plus
  N small lanes).
- Risk: low for the report; medium for deletions that touch a runtime path
  (dynamic imports, string-named routes, MCP tool names, privacy manifests).
  The review loop and the pre-push gate are the fence; the reviewer row for
  runtime-touching deletions should be the normal reviewer, not the trivial
  one.
- Benefit and how it is measured: accepted findings over findings (the
  operator and reviewer accept or reject each workstream); tracked files and
  bytes removed against the 2026-09-21 baseline in `docs/repository-cleanup.md`;
  test files removed; pre-push `tsc` and touched-test seconds before and
  after on the same scenario as `checks-under-five-minutes.md` §2.2; cost per
  accepted finding from the token store (`tokenStore.ts:39-43`, prices in
  `tokenPrices.ts`) for the audit stage.
- Dependencies: none. The report stage is a declared output; the lanes are
  ordinary.
- Do not: run a whole-repository pass first (the post ramped from one task
  to a subdirectory to the repository); delete anything from the audit lane
  itself; add a knip-style tool before the prompt has shown what it misses;
  name a new role for this until the prompt has been re-run at least twice.

### P2. The fixed-task model and effort comparison, with cost per accepted finding

- Outcome: a table like the post's, for this repository: the same audit
  prompt and the same subdirectory snapshot run at three combinations, with
  findings, accepted findings, tokens and the comparison price, and a list of
  the discrepancy classes (what the cheaper arm missed).
- What changes: nothing in code. Three sibling read-only lanes from one
  `baseRef`, the same prompt, different stage runtime (`effort` and `model`
  are per-stage fields already). The seat judges findings once, blind to the
  arm, against the union. Cost reads from the activity token store, keyed by
  pipeline and stage, priced by `tokenPrices.ts`; the report says the figure
  is a comparison at published API prices, not spend, as the price module
  itself does.
- Size: normal (three lanes and one judging pass; a short results section
  appended to P1's report).
- Risk: low. Subscription windows are the real cost (three audits of one
  subdirectory); `account_limits` before launch.
- Benefit and measure: cost per accepted finding per arm; the discrepancy
  classes become lines in the audit prompt, which is the post's method for
  letting the cheaper arm reach the stronger one. Decision rule set before
  the run: the cheapest arm whose accepted findings are at least 90 % of the
  best arm's becomes the default for P1's re-runs.
- Dependencies: P1's prompt and subdirectory. `ultra` effort has never been
  launched through Delegatus on this machine; if an arm uses it, the first
  launch is itself a check of `efforts.ts:43`.
- Do not: change any role-table row from this (the model analysis floor of
  30 lanes stands); compare arms on different snapshots or prompts; count
  findings without accepting them.

### P3. A flaky and red-on-main test sweep as a lane, fed by what the gate already prints

- Outcome: the simple flaky tests fixed on a controlled clock or deleted
  with the reason stated, one PR per file group; a list of what was left
  alone and why.
- What changes: a lane prompt in the post's shape ("clear fixes to simple
  issues, not exhaustively"), fed by three sources that exist: the FLAKY
  lines in recent pipeline publication outputs (`local-gate-tests.ts:437`),
  the #2226 list, and CI reruns read through the forge CLI. Builder
  `mode=diagnose` first, then the ordinary review loop. The #1761 rule
  binds: no test is weakened to pass; a timing test moves to a fake clock or
  an injected deadline, or goes.
- Size: normal.
- Risk: low to medium: a "fix" that widens a timeout is the known trap and
  the reviewer's first check.
- Benefit and measure: FLAKY confirmations per week in publication outputs;
  cases on #2226 still red; wall-clock timeouts in CI reruns per week; touched-
  test seconds for the files changed.
- Dependencies: none for the first pass. For a recurring pass, a durable
  record of FLAKY sites (one line per push into a journal the seat can
  query) is a small gate change; it is deliberately not part of this
  proposal until one manual pass shows the lines are enough.
- Do not: sweep whole directories against live state (AGENTS.md's first
  damage rule); run more than one heavy file at a time outside
  `scripts/gate-slot.sh`.

### P4. "Lane-minutes saved per day" ranking for the pre-push and CI, from records

- Outcome: a table of candidate cuts ranked by minutes saved per day,
  computed from this installation's records, the post's third prompt with
  the right denominator: here the cost is local pre-push time per lane
  (25–35 minutes measured on 2026-10-12) and admission waits, since the
  merge-required CI is already at 5.3 minutes p50.
- What changes: nothing in code. One read-only lane reads attempt
  `startedAt`/`completedAt` and the publication outputs of the last 14 days'
  pipelines, and the pull-request check timings through the forge CLI, and
  ranks C1–C10 of `checks-under-five-minutes.md` plus anything new by
  estimated minutes per day.
- Size: normal.
- Risk: low; it ranks, it changes nothing.
- Benefit and measure: pre-push p50/p90 per push before and after each landed
  cut, on the same scenario; admission wait share.
- Dependencies: #3128 (open) changes the touched-test gate's behaviour at
  high load; the ranking should be taken after it lands or state its base.
- Do not: rank by CI minutes alone (the post's denominator) when the queue
  here is local; spend the ranking lane on a Docker-queue change the design
  already deferred.

### P5. One replay launcher for instructions: learned rules first, then one `AGENTS.md` or scaffold line

- Outcome: an answer to "did this instruction help or misdirect", from two
  runs of the same stage prompt on the same snapshot and model, differing in
  one instruction, compared on verdict, findings, tool calls, tokens,
  runtime and comparison price.
- What changes: the replay-only launch option the memory benchmark names
  and says does not exist (engine memory off in both arms plus a frozen
  instruction block delivered through `--append-system-prompt` for Claude and
  `developerInstructions` for Codex, with `cleanMemory` false), its no-model
  dry run, and a results table. The post's version (one instruction, two
  runs) is the first use; the §4.1 M0…M3 pilot is the second.
- Size: design (it is item 9 of `memory-quality-benchmark.md` §5 and a spawn
  policy change; `spawnPolicy.ts` and `codexAppServerHost.ts` are shared
  paths).
- Risk: medium. A launch option that disables engine memory must never leak
  into ordinary launches; the dry run must assert the three arms' arguments
  before any paid run.
- Benefit and measure: the noise band (two runs of the same arm), then the
  delta of one instruction; later, the §5.8 metrics of
  `role-memory-to-prompts.md`.
- Dependencies: the delivery ledger (benchmark §4.4.1) for historical items;
  not needed for a prospective two-run replay.
- Do not: edit `AGENTS.md` or a scaffold from a single pair of runs; run
  the pilot's 40 items before the operator approves the spend (benchmark
  "Decisions for the operator", item 3).

### P6. Probe Codex thread goals for audit stages, against a stub, before any design

- Outcome: a one-page note saying whether `thread/goal/set` with an
  objective and a token budget makes an audit stage keep working towards
  "every candidate in this subdirectory" without re-prompting, and what it
  does to the stage completion contract.
- What changes: nothing in the product. A scratch probe starts the
  structured host against a port-0 stub model with egress closed, sets a
  goal, and records what the stub receives and when the goal reports
  complete, budgetLimited or usageLimited.
- Size: design (the host is a critical runtime path; three review rounds
  apply to any change that follows).
- Risk: the goal loop and the stage loop would both decide "what next"; a
  goal that is not complete when `stage_report` is called is an open
  question the probe must answer before any design.
- Benefit and measure: findings per audit and tokens per audit with and
  without a goal on P2's fixed task; the post reports costs that "include
  … the follow-up turns Codex ran automatically", so the comparison must
  count those turns.
- Dependencies: P1 and P2, for a task to compare on.
- Do not: enable it on reviewer, verifier or any read-only role before the
  probe; grant subagents to a pipeline stage to get "research subagents"
  (no stage field exists, and `multi_agent` is off by policy).

### P7. The report-then-fan-out step as a seat practice, and the recurring run only after the prompt is stable

- Outcome: after P1 and P2, the audit prompt lives at
  `docs/maintenance/prompts/` as a versioned text with a changelog line per
  model release and per discrepancy class folded in; the seat re-runs it on
  the next subdirectory on request, and only once the accepted-finding rate
  holds over two runs is a recurring slot considered (#1355, or a third
  seat-tick timer beside maintenance and curation).
- What changes: a document and a seat practice now; a timer later, through
  the open issue's design. *Outdated in part (2026-10-20, orchestrator
  mandate v58): the seat practice (report first, ramp, arms compared, one lane
  per accepted workstream, a re-run on a role's model change) is now a bullet
  in every installation's mandate.*
- Size: trivial now; design later.
- Risk: low now. The later timer carries the post's own warning: proposals
  that add complexity beyond their benefit need prioritisation and
  measurement to be thrown out, and a recurring run without an accept gate
  would flood the board.
- Benefit and measure: accepted-finding rate per re-run; findings per
  workstream that reviewers reject.
- Dependencies: P1, P2; for the timer, #1355.
- Do not: build the timer first; wire a code-maintenance prompt into the
  board maintainer, whose fences forbid file edits and whose job is the
  board.

## 4. Open questions for the operator

Each is form-ready: options first, recommendation marked. None blocks P1
except Q1.

1. **Where does the first pilot run?** (a) one `src/components/` subtree
   (UI handlers and overlays are where unreached code hides; the import-graph
   rule already exists for it) **(recommended)**; (b) `scripts/` and
   `evidence/` (the 2026-09-21 inventory's method applies and the privacy
   manifests make deletions visible); (c) the test suite via P3 first.
2. **Which arms for P2?** (a) gpt-6.1-sol medium, gpt-6.1-sol xhigh,
   gpt-6-astra xhigh **(recommended)**: the two efforts every Codex row
   already uses, plus the stronger model at the same effort; (b) add
   gpt-6.1-sol ultra and gpt-6-astra ultra, the post's arms, accepting that
   `ultra` has never been launched here and costs subscription windows;
   (c) one arm only, the default row, and no comparison.
3. **Who reviews deletion lanes?** (a) the normal reviewer row
   (gpt-6.1-sol xhigh) for any lane that touches `src/` and the trivial row
   (gpt-6-luna high) for tests, scripts, docs and evidence **(recommended)**;
   (b) trivial row everywhere; (c) normal row everywhere.
4. **How far does the ramp go in this cycle?** (a) P1 and P2 on one
   subdirectory, then decide **(recommended)**; (b) P1, P2 and P3 in
   parallel lanes now; (c) straight to a whole-repository report.
5. **Replay launcher now or later?** (a) later, after P1–P3 have numbers
   **(recommended)**; (b) now, as the benchmark's item 9, with its dry run
   before any paid run.

## 5. Deferred — not currently justified

- A `maintainer`-style role for code maintenance (a fourteenth role id).
  The architect's audit mode and the prod-auditor cover the report stage;
  a role is justified only when the prompt has stabilised across re-runs.
- A knip- or ts-prune-style unused-export checker in the gate. The post's
  team replaced such tooling with prompts and reported similar reliability;
  adding the tool first would decide the question before the pilot measures
  it.
- A stored CI run-duration history inside Delegatus. The forge CLI answers
  the question ad hoc, and the merge-required set is already under six
  minutes.
- A "create N sibling lanes from one report" primitive. One report has not
  yet produced N workstreams here.
- Wiring the audit prompt into the board-maintenance timer or a new
  seat-tick timer (#1355). Last step, after the accept rate holds.
- Granting Codex subagents to pipeline stages. No stage field exists, and
  the subagent audit shows why the policy is strict; the post's "research
  subagents" are a cost line, not a prerequisite.
- Changing any role-table default from the post's numbers. They are another
  codebase's numbers; the model analysis floor stands.

## 6. Validation against the requirement

| Acceptance item | Where |
| --- | --- |
| 1. Observe first; quote nothing unread; mark each claim with its section | §1.1 provenance; §1.2 by section; no linked page was needed |
| 2. Practices, techniques, model roles, tool features and numbers, new versus known | §1.2, §1.3, the cost table |
| 3. Mapping with `file:line` across role table, pipelines, gate and CI, board maintenance, memory curation, Codex integration | §2.1–§2.6, each with does / differs / missing |
| 4. At most eight ranked proposals with outcome, change, size, risk, benefit and measure, dependencies, do-nots, one recommended | §3, P1 marked |
| 5. Open questions with options and a recommendation | §4 |
| 6. Written here, repository-relative paths, no identities, English with a Ukrainian summary | this file; §7 |

What this document could not verify: the post's figures are reported, not
reproduced; `ultra` effort and thread goals were never launched through
Delegatus on this machine, so P2's option (b) and P6 start from unknowns the
proposals name as their first step.

## 7. Короткий підсумок українською

Пост OpenAI (14.10.2026) описує, як команда чистила мертвий код і застарілі
експерименти агентами Codex: спершу одна мала задача, потім підкаталог, потім
увесь репозиторій; агент збирає докази (історія PR, трекери, профілі
продакшену), пише звіт, згрупований у паралельні робочі потоки, і по одному
малому PR на кожне видалення. Ключові числа: понад 1 400 PR і 800 тис.
видалених рядків за два тижні; GPT-6.1 Sol Ultra дав 92 % знахідок Astra
Ultra за 14 % вартості; медіана CI впала з ~10 до 4,5 хв.

Що пропоную для Delegatus, за пріоритетом:

1. **P1 (перший крок).** Одна пілотна лінія на одному підкаталозі: етап
   «звіт без видалень» на Sol medium з доказами реального використання, далі
   форма оператору, далі по одній trivial-лінії на кожен прийнятий потік.
2. **P2.** Той самий промпт на тому самому зрізі на трьох моделях/зусиллях;
   рахуємо вартість на прийняту знахідку з наявного обліку токенів і
   переносимо «що пропустила дешевша модель» у промпт.
3. **P3.** Лінія прибирання нестабільних і червоних тестів із FLAKY-рядків
   гейта та #2226; прості виправлення, без послаблення тестів.
4. **P4.** Рейтинг скорочень за «хвилини лінії на день» для локального
   pre-push, бо обов'язковий CI уже ~5 хв.
5. **P5.** Один інструмент повторного запуску для інструкцій (спершу
   learned rules, потім один рядок AGENTS.md), як уже спроєктовано в
   memory-quality-benchmark.
6. **P6.** Лише проба Codex thread goals на стабі перед будь-яким дизайном.
7. **P7.** Версіонований промпт аудиту як практика сіту; таймер — тільки
   коли частка прийнятих знахідок стабільна.

Питання до форми: де пілот (рекомендую `src/components/`), які три
варіанти для порівняння, хто рев'юїть видалення, скільки кроків у цьому
циклі, коли будувати повторний запуск інструкцій.
