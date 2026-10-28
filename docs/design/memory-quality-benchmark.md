# Memory quality: what agents write, what reaches them, what changes, and a benchmark to measure it

Status: analysis and design, no product change. Written 2026-10-16 against
`main` at `02f9301fc`; every `file:line` is from that commit. Live records
were read once, read-only, at 2026-10-16 12:28 UTC (section 3.1 says how); that
export was not kept. A second read-only export at 14:19 UTC re-ran the script
in the appendix, which applies the 12:28:42 cutoff to every field a later
update can overwrite; the appendix says what that run reproduced and which
figures no later read can reproduce.
Projects other than this repository are named by letter and kind, as in
`docs/design/role-memory-to-prompts.md`: A is this repository, B an ERP
customization on a shared stand, C a bot and web-app product, D a dispatching
web application. Learned rules are named by id and described in other words;
no rule text is quoted, because rule texts stay on this machine.

## Originating requirement

Operator, 2026-10-16 about 12:14 UTC, by voice in Russian during a call with
the voice companion. The gateway restated the call the same day as a written
directive, and the pinned specification of this lane carries that directive.
The original wording is private operator speech, so this document paraphrases
it in English and keeps its date and provenance (the call record and the
pinned specification, both held on this machine). The requirement:

1. Analyse how agents here write memory today: how accurate and how useful
   the written facts and fragments are.
2. Show how the instructions for writing memory change what is written.
3. Show how the memory curator's work changes agent behaviour.
4. Where possible, trace for an agent which prompt and which memory fragments
   it was given, what it did afterwards and which errors it made.
5. Propose a practical benchmark for memory quality and an improvement plan
   that can measure whether adjusting the instructions or the curator helps
   agents learn more efficiently.
6. Deliver a clear method with criteria and a worked example, and concrete
   conclusions on what to improve in writing, selecting and using memory.

The call also named the idea behind this: a benchmark for memory that includes the
curator's effect, so that the system can learn how to learn. The written
directive adds the words usefulness and "selection and use", and asks for a
written plan; this design covers both renderings. The call suggested a
particular engine and account for the analysis; that was a staffing choice for
the seat and changes nothing in the method. The default answer to "should we
build this" is no: the requirement asks for an analysis and a method, so this
document builds no product code and proposes changes only where the data shows
a defect, each with the metric that would prove it.

## 0. Earlier work this builds on

`search_transcripts` (project-scoped, then unscoped) for the benchmark, the
curator and delivered rules, and `search_memory` for memory quality, found the
seat conversation that started this lane and the designs below; the memory
index held nothing on memory quality.

| Earlier work | What it settled | What it left open |
| --- | --- | --- |
| `docs/design/role-memory.md` (2026-10-07) | Stage-end lessons, three scopes, injection, clean reviewers | Usefulness counting (its slice 3) |
| `docs/design/role-memory-curation.md` (2026-10-11) | Rewrite by id, four levels, the curator's seven checks | Any check that a curated rule helps |
| `docs/design/lessons-from-review-findings.md` (2026-10-12) | Fix rounds name their findings; `tasks` counts recurrence; a probe of lesson answers by wording | Effect on later findings |
| `docs/design/orchestrator-role-memory.md` (2026-10-12) | Seats and maintainers read and write rules | Whether seat rules land at the right level |
| `docs/design/role-memory-to-prompts.md` (2026-10-15) | Inventory of 243 rules; universal classes moved into the shipped prompts (variant 4) | "What to measure to know it worked" (§5.8), not yet measured |
| `docs/design/rrsi-lessons.md` (2026-09-24) | Reviewer pass rate is a judge score the harness can move; measure the noise band first; observational credit misleads | Applied to scaffolds only; memory had no per-attempt record |
| `docs/design/agent-memory.md` (2026-10-02) | Shared recall memory and its offer ledger | Offer usefulness at scale |
| `evidence/role-memory-curation/curator-eval.json` | One run of the curator on 12 synthetic boundary cases, all passed | Repeat runs, real cases |

What is new here: a reconstruction of the exact rules each stage received,
checked against this stage's own block (3.1), and with it the first join of
delivered rules, agent behaviour and review findings.

## 1. Inventory: every memory path an agent here writes or receives

Four stores reach agents: learned rules (Delegatus role memory), shared recall
memory, and each engine's own file memory. Three more stores hold memory-like
text that reaches no stage agent; they are listed last for completeness.

### 1.1 Learned rules: writing

| Path | Write path | Guard | Observed volume (to 2026-10-16 12:28 UTC) |
| --- | --- | --- | --- |
| Stage lesson | An accepted `stage_report` answer carries `lessonRequest` (`src/lib/mcp/bindings.ts:2557`, built by `lessonRequestForReport`, `src/lib/memory/roleStage.ts:45-53`, text in `roleRender.ts:88-109`). The agent answers with `leave_lesson` (`bindings.ts:2564-2580` → `roleStage.ts:127-155` → `roleStore.ts:261-326`) | Exactly one of `none`, `lesson`, `rewrite`, `problem` (`roleTypes.ts:21`); 20–300 code points (`roleTypes.ts:15-20`); fixed identifiers refused (`roleStage.ts:74-79`); a lesson naming a concrete file or defect refused (`roleProblems.ts:11`); clean roles refused (`roleStage.ts:112`, `:138`) | 1,339 requests: 616 lessons, 145 rewrites, 554 none, 22 problems, 2 open |
| Fix-round lesson | Same call; when the attempt was activated by a fail edge, the request quotes up to five handed findings and asks for the class (`roleStage.ts:35-42`, `roleRender.ts:72-85`) | As above; `none` must say why the class cannot recur (stated in the text; the server does not check it) | 566 fix-round requests |
| Problem report | `leave_lesson` with `problem` stores the report on the request row; the seat tick offers it on the agenda (`roleProblems.ts:77`, `src/lib/monitor/seatTickSources.ts:659`) | Writes no rule | 22 |
| Seat rule | The designated seat calls `leave_lesson` unasked (`bindings.ts:2571-2577` → `roleStage.ts:158-176`) | Designation checked server-side; same text guards | 70 written, 48 active |
| Curator | A scheduled curator conversation calls `curate_rules` read and apply (`src/lib/mcp/server.ts:3400`, guard `src/lib/memory/curation/guard.ts:12-34`, apply `curation/apply.ts:51`); brief and checklist in `curation/brief.ts:1-16`; due at 10 new lessons or 6 hours (`roleTypes.ts:12-13`, `curation/store.ts:113`) | Every active rule accounted for; operator-kept rules stay | 69 passes since 2026-10-12 23:08 UTC (state at the cutoff: 64 succeeded, 4 failed, 1 still launching; the last one ended 20 minutes later); 697 curator rewrites |
| Retention on write | `appendRule` and `retainRules` (`roleConsolidate.ts:59-100`): a word-for-word repeat merges; over 10 000 code points (`roleTypes.ts:11`) the head of the leaving order goes, never-curated rules first (`roleConsolidate.ts:50-56`) | No model; nothing deleted | 25 rules archived for budget, 20 of them never curated (3.2) |
| Operator | The rules window: remove, return, revert (`src/app/api/role-memory/route.ts`) | Operator authority | 3 history entries |
| History and egress | Versions as archived rows (`roleStore.ts:230-249`); scope history keeps every curator-pass entry plus the last 500 entries of any kind (`keepHistory`, `roleStore.ts:39-42`; curator entries inside the window use its slots); every stored text is a known value for the publication gate and the relays (`roleStore.ts:541-745`) | Fails closed | 864 version rows; the busiest scope holds 440 history entries, 25 of them curator passes |

Store totals: 1,731 rule rows (228 active, 136 merged, 1,367 archived, of
which 864 are earlier versions and 350 were archived by the curator as
task-specific), 1,339 request rows, 102 scope rows.

### 1.2 Learned rules: selection and delivery

| Reader | Selection | Delivery | What the agent sees |
| --- | --- | --- | --- |
| Pipeline stage of a non-clean role | Text-free selector set by the engine (`roleStage.ts:30-33`; `src/lib/pipelines/engine.ts:739`, `:6239`, `:6781`); a stage is clean when its role is reviewer, verifier, issue-reporter or curator, or it carries a fail edge (`src/lib/memory/eligibility.ts:11-27`) | Rendered from SQLite at every engine start (`src/lib/memory/roleLaunch.ts:33-42`): Claude `--append-system-prompt` (`src/lib/runtime/structuredSpawn.ts:1949`, `claudeStreamBrokerHost.ts:923`), Codex `developerInstructions` (`structuredSpawn.ts:2020`, `codexAppServerHost.ts:1620-1626`); also on adoption (`startup.ts:1907`, `:2309`) and account migration (`accounts/migration/provider.ts:376`, `:512`) | Every active rule of four scopes, whole, best-ranked first (`roleStore.ts:109-111`, `:180-192`): role here, role everywhere, project, machine. A header with counts, a notice, then one line per rule with its id (`roleRender.ts:47-58`). No relevance selection. |
| Orchestrator seat, board maintainer | Selector set at spawn by role (`src/lib/agent/registry.ts:6257-6275`) | Same channels | Same four scopes with a seat or maintainer notice (`roleRender.ts:14-16`) |
| Reviewer, verifier, issue-reporter, curator, any gated stage | None; the launch is marked clean, which also turns off engine memory (`src/lib/agent/spawnPolicy.ts:531-534`, `codexAppServerHost.ts:1489-1490`) and the shared-memory hook (`src/lib/memory/controller.ts:51-53`) | n/a | Nothing |
| A role agent spawned outside a pipeline (for example a builder the seat spawns) | No code path sets the selector: the setters are `engine.ts:739`, `:6239`, `:6781`, `registry.ts:6269`, `:6274` and `roleLaunch.ts:28`. `role-memory-to-prompts.md` §1.7 states the opposite; the code at `02f9301fc` does not support it | n/a | No learned rules, and no lesson request (it reports no stage) |

Sizes at the snapshot, from the reconstruction in 3.1 (bytes of rule lines;
tokens are an estimate at four bytes per token, no tokenizer was run):

| Reader in project A | Rules (role here / role everywhere / project / machine) | Bytes | ≈ tokens |
| --- | --- | ---: | ---: |
| builder | 73 (26 / 24 / 7 / 16) | 17,469 | 4,400 |
| orchestrator seat | 46 (4 / 19 / 7 / 16) | 10,936 | 2,700 |
| architect | 43 (10 / 10 / 7 / 16) | 10,122 | 2,500 |
| prod-auditor | 33 (5 / 5 / 7 / 16) | 7,277 | 1,800 |
| visual critic (ungated) | 24 (0 / 1 / 7 / 16) | 5,181 | 1,300 |
| merger, maintainer | 23 (0 / 0 / 7 / 16) | 4,897 | 1,200 |

### 1.3 Shared recall memory

| Path | Write | Selection and delivery | Observed |
| --- | --- | --- | --- |
| `search_memory` on demand | None: a derived index over engine memories, instructions and skills (`memory-index.sqlite`; `src/lib/memory/index.ts`) | The agent queries; opening a hit records `opened` (`src/lib/mcp/server.ts:3413`) | 1,869 opened hits since 2026-10-02 (1,867 from searches, 2 from injections). Index at the snapshot read, a derived and rebuilt table with no history: 6,099 Codex references, 759 Claude references, 355 preferences, 333 skills, 293 project facts |
| Injection into operator turns | Same index | `UserPromptSubmit` hook (`spawnPolicy.ts:490`, `codexAppServerHost.ts:1466`) → `offerForHook` (`controller.ts:22-193`): operator-originated turns only: agent deliveries and machine launch briefs skipped, later human submissions eligible (`:85-96`); clean conversations skipped (`:51-53`), per-project switch and a judged selection (`injection.ts:25`) | October: 348 judged turns, 323 with no match, 178 with no candidate, 683 skipped, 13 failed, read once from the index's running monthly counters (`memory_injection_activity`, `index.ts:666-686`), which carry no time per event and so cannot be re-read for a cutoff (the same counters read at 14:26 UTC held 350, 325, 188, 689 and 15). 23 items injected up to the cutoff, into 13 conversations; 2 opened, 0 cited (`memory_offers` rows carry their own time, `index.ts:142`, `:845`; query in the appendix) |

Which pipeline-stage turns can receive an injection, by the code at
`controller.ts:51-96`:

| Turn of a stage conversation | Injection |
| --- | --- |
| The stage's launch brief: it arrives with operator origin, but the receipt names the pipeline or flow membership (or a delegated depth, a launcher, a maintenance run) | Skipped (`:85-94`) |
| Later machine and agent deliveries (relays, wakes, stage handovers) | Skipped (`:88`, `:96`) |
| A later human submission to the stage (operator origin, not a spawn message) | Eligible (`:85`, `:89`); `controller.test.ts:720-726` drives an operator follow-up to a builder into selection |
| Any turn of a clean role (reviewer, verifier, issue-reporter, curator, gated stage) | Skipped (`:51-53`) |

So the code admits injection into non-clean stages after a human follow-up.
Over the queried sample, no stage received one: the 23 injected offers up to
the snapshot went to 13 conversations, and none of them is a stage attempt in
the 1,058 pipeline records (they are conversations outside the pipeline
records; query in the appendix). The pattern holds for that sample and
for that date range.

### 1.4 Engine-side file memory

| Engine | Written by | Who loads it | Observed |
| --- | --- | --- | --- |
| Claude auto memory, per repository (`agent-memory.md` §1.2) | The Claude seat of this repository, on its own judgement or on request | Every non-clean Claude conversation of this repository, pipeline worktrees included, loads the `MEMORY.md` index (first 200 lines or 25 KB). Both of the two Claude account homes here hold a symbolic link for this repository's memory directory, created 2026-10-01, and both resolve to one directory in the operator's native Claude home (same inode, one shared index); the engine memory of this repository is therefore the same for either account. Turned off only for clean launches (`spawnPolicy.ts:531-534`) | Index 8,620 bytes (last modified 2026-10-16 08:13 UTC), 50 topic files (31 feedback, 11 reference, 8 project) plus an imported subtree. This stage received the index in its own context: seat-only directives (deploying, cutting releases, the worker cap) arrive in a read-only architect stage |
| Codex native memories | Codex background generation, turned off here (`generate_memories = false`) | Every Codex launch with the feature on and `use_memories = true`; all Codex account homes link one memory folder of the operator's main home; clean launches pass `memories = false` (`codexAppServerHost.ts:1489-1490`) | A summary of 11,302 bytes injected into the developer instructions of every non-clean Codex conversation, last modified 2026-10-01 |

The curator never reads either of them, and neither is versioned, levelled,
or excluded from roles it does not concern.

### 1.5 Memory-like text that reaches no stage agent

- The seat's monitor note (`seat_tick_settings`) and rotation digest: seat
  continuity, described in `orchestrator-role-memory.md` §1.1.
- The memory profile (`src/app/api/role-memory/profile/route.ts`,
  `docs/design/memory-profile.md`): an operator-facing summary of what agents
  start with.
- Voice call memory (`src/lib/voiceCompanion/callMemory.ts`,
  `docs/design/voice-call-memory.md`): summaries the voice companion reads.

Open pull request #2930 (routing MCP writes through the Viewer) lists
`leave_lesson` and `curate_rules` among the writes it moves; it changes which
process executes the write and leaves the rows and the paths above as they are.

## 2. Evaluation method: criteria and how each is measured

A memory item is a learned rule, an engine memory entry or an injected recall
item. Each criterion below has a unit, a deterministic part where one exists,
a judged part where it cannot be avoided, and its data source. "Judged" means a
fresh clean agent (or the operator, for the calibration sample) answers a
fixed question with the evidence in front of it; every judged metric reports
its sample size and its agreement on a repeated sample.

| # | Criterion | Unit and question | Deterministic part | Judged part | Source today |
| --- | --- | --- | --- | --- | --- |
| 1 | Accuracy | Rule. Was it true when written, and is it true now? Grades: true, stale, wrong | Names a path, script, flag, tool or id that does not exist at HEAD (grep); contradicts a stored rule the curator marked `contradicted` | Read the code and instructions at the write commit and at HEAD | Rule rows and versions; git |
| 2 | Usefulness | Delivered item × attempt. Did the item change what the agent did, and did that change help? | Paired counterfactual replay with and without the item over an identical brief (section 4.1): incremental effect = outcome with the item minus outcome without it; the attempt cites the id | Behaviour signature in the diff or transcript, judged blind to the condition. Overlap with the brief, the pinned specification or the role prompt is recorded as a confounding label (`overlap = none, brief, spec, prompt`) and never zeroes the score | Replay; transcripts; briefs |
| 3 | Scope fit | Rule. Do all readers of its scope act on it? | Count of readers per scope and their roles, from the delivery ledger | Which roles act on it; is the level the narrowest true one (`role-memory-curation.md` §3.0) | Ledger; rule rows |
| 4 | Duplication and contradiction | Pair of items delivered together | Shingle overlap ≥ 0.5 between delivered items; identical class across learned rules, prompts and engine memory | Same class or opposite asks | Ledger; prompts; engine memory |
| 5 | Delivery relevance | Attempt. Share of delivered items that bear on its task | Lexical overlap of each item with the brief and the changed paths (a pre-filter only) | Per item: bears on this task, yes or no | Ledger; briefs; diffs |
| 6 | Compliance | Delivered item that bears on the task. Did the agent follow it? | The item's check appears in the transcript (command, probe, test) | Followed, partly, ignored | Transcripts; diffs |
| 7 | Recurrence | Finding class. Rate per review round before and after an item for it entered delivery | Finding counts per lane and round; `tasks` per rule; a rewrite of the same rule by a later task | Class assignment of each finding; attribution: delivered and ignored, delivered but too narrow, absent, not memorizable | Verdicts; requests; ledger |
| 8 | Cost | Engine start. Bytes and estimated tokens of learned rules and engine memory delivered; curator minutes per pass | Exact bytes; pass durations | — | Ledger; pass rows |
| 9 | Curator effect | Pass. Rule set and behaviour before and after | Counts, bytes per role block, compression index, task-specific share, `tasks ≥ 2` share, budget evictions | Sampled disposition accuracy (was `in-instructions` true for every reader? was `task-specific` true?) | Scope history `before`, pass rows |
| 10 | Write precision | Written rule. Share that survives the curator as a general rule | Final disposition | Calibration sample of curator dispositions | Rule rows |
| 11 | Self-assessment accuracy | `none` answer. Was its claim ("my rules covered this") true? | The next review of the same lane failed | Did a finding fall in a class the agent said was covered? | Requests; verdicts |

Two rules govern every reading of these metrics. First, an outcome a reviewer
judges (pass rate, findings per round) is a score the harness itself can move;
it is context, and no change is credited on it alone (`rrsi-lessons.md` §2).
Second, compliance carries no causal claim: an agent that follows an item
shows compliance (criterion 6), and usefulness comes only from the paired
replay. A reminder of something the brief already asks for can still raise
compliance, so it scores positive when the pair shows a benefit (the item
present, the step performed; the item absent, the step missed on the same
brief) and stays unmeasured when no pair exists. Overlap with the brief is a
label that tells a reader what the replay has to control for. Case 8 below
is the unmeasured kind.

## 3. Worked example on real data

### 3.1 Data and method

- **Snapshot.** One read-only open of the live `state.sqlite` with
  `bun:sqlite` `readonly`, exporting the `role_memory`,
  `role_memory_curation`, `pipelines` and `pipelines_archive` rows to the
  stage's scratch directory at 2026-10-16 12:28:42 UTC (the read took 443 ms).
  The same for `memory-index.sqlite` (counts only) and
  `board_maintenance_runs`. Nothing was written. `curate_rules` read was
  refused to this stage (`CURATE_CALLER`: only the live curator may call it,
  `guard.ts:13-34`), so the store was read through the snapshot. The snapshot
  was removed with the stage's scratch directory. The appendix gives the export
  and the script. A second export at 14:19 UTC (digests in the appendix), run
  through the script, reproduced every figure here that a cutoff can restore; it
  also showed that the first version of the script was not cutoff-safe (it gave
  50 rules with work from two or more tasks where this document says 49),
  which is why the script now filters merge, split and version links by the
  cutoff. The appendix lists the figures that are point-in-time reads and
  cannot be reproduced.
- **Transcripts.** `conversation_messages` for each case's stages,
  `search_transcripts` for rule-id citations and for the requirement.
- **What each attempt received.** Nothing records the rule ids delivered to
  an attempt (section 4.4). They were reconstructed from the scope histories:
  start from each scope's current active list and walk its history backwards
  to the attempt's start, replacing the list with `before` at a curator entry
  and undoing `added` and `archived` at an agent entry; a rule's text at that
  time is the earliest version row changed after it. Check: the reconstruction
  for this stage's own start gives 10, 10, 7 and 16 rules with the same first
  ids, in the same order, as the block this stage received; for the merger,
  prod-auditor and research-architect attempts of 3.3 the counts equal those
  the reviewing stage re-derived (17, 38 and 58 ids, same order).
- **Regimes.** The lesson request changed three times. Boundaries are dated
  from the records themselves (deploy records for these days are incomplete):
  R0, the first wording, to 2026-10-11 11:29 UTC (first rewrite 11:39);
  R1, "most stages do neither", to 2026-10-12 23:15 (first request carrying
  a task id, the marker of the fix-round wording; the first curator pass ran
  at 23:08); R2, fix-round wording, problem reports and the curator, to
  2026-10-15 14:57 (variant 4 role prompts installed, which moved the universal
  memory classes into the shipped prompts); R3 after that. A regime is a period,
  not an experiment: the curator and the problem-report path begin inside R1 and
  R2, variant 4 prompts begin R3, and task mix and models were not held fixed.
- **Finding classes.** A keyword pass with Unicode-aware word starts, six
  classes, English terms and Ukrainian stems, written out in the appendix
  script. Over the 811 reviewer findings on builder lanes since 2026-10-10 it
  tags 724; 351 of the 811 are written in Ukrainian, and 32 of those stay
  untagged.

### 3.2 What the store-level numbers show

**Lesson answers by wording (observation).** Fix-round answers that wrote or
rewrote a rule, with 95 % Wilson intervals:

| Regime | Fix-round requests | Wrote or rewrote | Fix-round rules later archived as task-specific |
| --- | ---: | --- | --- |
| R0 | 83 | 82 (99 %, 93–100) | 124 of 152 (82 %, 75–87) |
| R1 | 194 | 103 (53 %, 46–60) | 39 of 80 (49 %, 38–60) |
| R2 | 206 | 201 (98 %, 94–99) | 39 of 135 (29 %, 22–37) |
| R3 | 83 | 82 (99 %, 93–100) | 2 of 47 so far; 14 of 47 evicted for budget |

The rule cohorts are original fix-round rules: split descendants and version
rows are excluded (appendix). The regimes differ in more than the wording
(3.1 lists the concurrent changes), so the table records rates by period;
older cohorts also had longer to meet a curator pass.

*First-pass requests* are stage requests that were not activated by a fail
edge and whose lane had no finished reviewer verdict when the attempt started.
773 requests were not activated by a fail edge; 113 of them follow a review
(later retries, and stages with fix-like names that no fail edge activated),
so the first-pass cohort is the other 660. They answered `none` in 5 % (R0,
5 of 99), 67 % (R1, 143 of 215), 62 % (R2, 164 of 264) and 82 % (R3, 67 of
82); the reason given is almost always that existing rules already cover the
work (a keyword reading: R2 150 of 164, R3 58 of 67).

**Self-assessment (observation).** A builder in the first-pass cohort answers
its request before any review of its lane. Of those answers that claimed
existing rules cover the work and were followed by a review, the next review
failed in 49 of 103 (48 %, 38–57) in R1, 65 of 112 (58 %, 49–67) in R2 and
32 of 40 (80 %, 65–90) in R3 (R0: 1 of 4). Counting every request that no fail
edge activated would add 11 such builder answers that came after earlier
reviews (R0 2, R1 7, R2 2).

**Retention (observation).** Rules written by agents reach the curator
within about two days (median life of a rule archived as task-specific: 47.8
hours; as in-instructions: 48.1 hours). Budget archives are two populations:

| Population (query in the appendix) | Rules | Median life | p90 |
| --- | ---: | ---: | ---: |
| `kind = rule`, no `versionOf`, `reason = budget`, `changedAt` ≤ T | 25 | 0.45 hours | 3.6 hours |
| of those, never curated before the archive (`curatedAt` absent or not earlier than `changedAt`) | 20 | 0.33 hours | 1.2 hours |
| of those, curated before the archive (the end of the leaving order) | 5 | 3.6 hours | |

All 25 sit in the builder scope of project A: 20 archived on 2026-10-15 and 5
on 2026-10-16 (never-curated ones: 16 and 4). With the scope at its bound and
curated rules at the protected end, each new lesson pushed out the previous
uncurated one (`roleConsolidate.ts:50-72`); the five curated rules left only
after the uncurated ones ran out. One such append is visible in case 2.

**Recurrence (observation).** 49 of 228 active rules carry work from two or
more tasks (30 from two, 19 from three or more); `lessons-from-review-findings.md`
counted 4 such rules on 2026-10-12.

**Curator rewrites (observation).** Of 136 active rules rewritten at least
once, 11 (8 %) had a compressed form at first writing (three or more slashes
or two or more semicolons) and 73 (54 %) have it now; slashes per hundred
characters rose from 0.12 to 0.93, while mean length stayed near 240 code
points against a 300 cap (13 of the 228 active rules sit exactly at the cap).
37 active rules have six or more earlier versions; one machine rule has had 15
texts in under four days.

**Delivered bytes around curator passes (observation),** builder in project A:

| Time (UTC) | Rules | Bytes |
| --- | ---: | ---: |
| 2026-10-12 23:56, before the first pass for A | 107 | 28,885 |
| 2026-10-13 00:25, after it | 64 | 14,847 |
| 2026-10-15 14:56, variant 4 prompts installed | 103 | 24,763 |
| 2026-10-16 09:59, before the post-variant-4 pass | 97 | 23,844 |
| 2026-10-16 10:25, after it (77 rules archived as already in the prompts) | 67 | 15,820 |
| 2026-10-16 12:28, snapshot | 73 | 17,469 |

Bytes are the UTF-8 length of the rule lines of all four scopes joined by
newlines. The curator's own target is 16,000 bytes for a role's four scopes
(`curation/brief.ts:7`); the builder in project A exceeded it for most of R2
and R3.

**Outcomes (context only; no change is credited on them).** First review of
builder lanes failed in project A (lanes since 2026-10-10, first review of
each): R0 38 of 71 (54 %, 42–65), R1 40 of 78 (51 %, 40–62), R2 58 of 98
(59 %, 49–68), R3 19 of 23 (83 %, 63–93); in the other projects R0 4 of 4, R1
21 of 42 (50 %), R2 26 of 56 (46 %), R3 17 of 25 (68 %). Task mix, models and
the reviewer's own prompt (variant 4 gave it more judging blocks) changed with
the regimes. These numbers show no detectable improvement and could not show
one if it existed.

**Saturation (observation).** For 702 of the 724 tagged findings (97.0 %),
the builder whose work was reviewed had received at least one rule of the
same class. Keyword classes are too coarse to separate "delivered and
ignored" from "absent": a builder receives 60 to 100 rules and some rule
always mentions tests, states or restarts. Attribution needs the judged
labels of criterion 7.

### 3.3 Cases

Fifteen narratives from 2026-10-15 and 2026-10-16. Twelve are complete traces
(cases 1, 2, 3, 6a, 6b, 8, 9, 10, 11, 12, 13 and 15; case 11 covers two seats
and case 6 two stages), each with the same five fields: the prompt, the
delivered memory (counts as role here / role everywhere / project / machine,
UTF-8 bytes of the rule lines, and a digest), the action, the error and the
attribution. The digest is the first eight hex digits of the SHA-256 of the
ordered rule ids, one per line, in render order; the appendix script prints it,
so a reader can check a block without the rule texts. That digest covers the
ids only: two blocks with one digest list the same rules, not the same text.
Where a claim depends on text, the script also prints a content digest (ids and
the texts in force at the attempt's start); cases 1 and 2 give both. "Relevant" ids are the
stage author's judgement of which delivered rules bear on the task; no second
judge has checked them, which is what criterion 5's calibration sample is for.
Zero is stated where a clean role receives nothing by design. Four narratives
(4, 5, 7, 14) are supporting observations and do not claim a full trace; case
7 has no builder trace and case 14 is an aggregate over passes. Conversation
ids and transcript paths stay in the lane's final handoff.

**Case 1. Builder, first attempt, project A, 2026-10-16 09:27–09:37, UI theme change.**

- *Prompt.* A `build` stage brief with the pinned specification of the theme
  change; the stored scaffold carries the rendered-work block.
- *Delivered.* 97 rules (36/41/5/15), 23,714 B, digest `c7475016` (content `13c2f9fb`). Relevant:
  `r_90146d0a76745b43` (which stylesheet rule wins, checked by computed style
  in a built page) and `r_77fc7abe32501e22` (states of prototype controls, hover
  and disabled among them).
- *Action.* Implemented the theme rules and answered `none`, saying it
  followed the existing interface and evidence rules.
- *Error.* The first review (09:39–09:48) returned three P2 findings, each a
  state colour lost to a broader theme rule that wins on precedence.
- *Attribution.* Delivered and not followed; the self-assessment was wrong.
  The first rule's text at that time was its fifth version, compressed by the
  curator and merged with an unrelated class about unlocking controls.

**Case 2. Fix rounds 1 and 2, same lane, 09:50 and 10:09.**

- *Prompt.* A fix brief quoting the three findings (round 1) and the one
  finding of the second review (round 2), each with the fix-round lesson
  request.
- *Delivered.* Round 1: the same 97 rule ids as case 1 (id digest `c7475016`)
  with different text in one of them: 23,809 B against 23,714 B, because
  `r_ac39458a8661f4a5` was rewritten between the two starts (205 to 300 UTF-8
  bytes; content digest `13c2f9fb` becomes `6ff468d8`). Round 2: 97 rules,
  23,844 B, id digest `6c974345` (content `f1ac6939`), which now holds
  `r_04f612d544543a78`. Relevant in both: `r_90146d0a76745b43`.
- *Action.* Round 1 fixed the three findings and wrote a new lesson,
  `r_04f612d544543a78`, for the same class as `r_90146d0a76745b43`, narrower
  (theme overrides of shared classes, listing states). The append brought the
  scope to 9,885 characters and archived another uncurated lesson,
  `r_5feb7b7ab235de28` (written by another lane at 09:01), for budget. Round 2
  fixed the next finding and rewrote `r_04f612d544543a78` to name the
  disabled state.
- *Error.* The second review (09:59–10:07) found the same class again: a
  disabled control lost its dimming on hover, because the disabled mark was an
  attribute the hover guard did not check. The visual critique after round 2
  (10:14–10:19) passed.
- *Attribution.* The new rule was too narrow for its own lane, and writing it
  beside the delivered rule left one class under two ids; a rewrite of the
  delivered rule would have kept one rule per class.

**Case 3. Reviewer, same lane, two rounds (09:39 and 09:59).**

- *Prompt.* The reviewer scaffold with the rendered-work judging block, the
  pinned specification and the pull request head.
- *Delivered.* None by design: a clean role, 0 rules, 0 B, no engine memory.
- *Action.* Reported each instance with file, line and the specificity that
  decided it: three findings, then one.
- *Error.* None observed; the passing visual critique after round 2 agrees
  with the second review.
- *Attribution.* Not applicable to a role that reads no memory. The reviewer is
  where this class is caught, nothing in memory reaches it, and nothing measures
  whether the builder rules reduce what it finds.

**Case 4. Builders across four parallel lanes, project D, 2026-10-15.** One
lane's build stage wrote `r_3ca29b40107fdd35` (scroll regions that end on a
whole row) at 14:56. Another lane's next stage received it six minutes later
(that lane's delivered role-scope count grew from 9 to 22 over the
afternoon). In that lane the third review found a case the rule did not name (a row that
grows without the row count changing); that lane's fix rounds rewrote the
rule twice (20:31, 20:55), so it now carries two tasks. Explanation: delivered
but too narrow; the rewrite path captured the recurrence as designed.

**Case 5. Fix rounds and a visual critic, project D, same day.**
`r_3bdd7090036c28e8` (layout audit: clipped rows and the placement of a "more
below" row), written by an architect on 2026-10-12, was rewritten by two
lanes' fix rounds (16:28, 20:09). At 20:32 the visual critic found the "more
below" row detached from the cards by an empty band. Explanation: recurrence
after two rewrites; the critic was gated (it carries a fail edge) and clean,
so it never reads the rule it enforces.

**Case 6a. Architect, project A, 2026-10-15 09:49–09:59, feasibility research (Codex).**

- *Prompt.* A `research` stage brief: assess the feasibility of a platform
  target and write the findings as a design document.
- *Delivered.* 58 rules (23/19/0/16), 13,823 B, digest `cf882d56`, plus the
  Codex native summary (11,302 B). Relevant: none; no delivered rule names the
  class below.
- *Action.* Wrote the document and answered `none`: existing rules already
  require keeping CI evidence apart from assumptions.
- *Error.* Two statements called a CI run final-head evidence for a head the
  run had not tested (found in 6b).
- *Attribution.* Absent item: a CI run proves only the head it ran on.

**Case 6b. Verifier, same lane, 2026-10-15 09:59–10:06.**

- *Prompt.* Verify the document claim by claim against the code and the raw
  CI logs.
- *Delivered.* None by design (clean role).
- *Action.* Confirmed the 15 subsystem assessments and the CI boundaries,
  found two P3 statements wrong with a reproduction command each, and failed
  the stage.
- *Error.* None by the verifier.
- *Attribution.* Not applicable to the verifier. The verify stage has no fail
  edge, so its findings were handed to no fix round and no lesson request: there
  is no write path from this finding to memory (improvement item 11).

**Case 7. Verifier, project B, 2026-10-15, integration test on the stand
(supporting observation, no builder trace).** The builder's third attempt
answered `none`; its delivered set is not traced here. The verifier found one
P1 (an ordinary role could read a credential and modify scripts run with
elevated rights) and five P2. Since 2026-10-12 23:15, 8 of 8 verifier findings
and 4 of 4 prod-auditor findings were never handed to a fix round, against 1 of
541 reviewer findings, 6 of 240 visual-critic findings and 6 of 11 builder
findings. Explanation: the gap is real and small in volume.

**Case 8. Prod-auditor, project A, 2026-10-16 07:58–08:41, pause audit after a deploy.**

- *Prompt.* An audit brief that named the journal window and the
  like-for-like comparison.
- *Delivered.* 38 rules (10/8/5/15), 8,472 B, digest `e16a6528`. Relevant:
  `r_6aea5f42f89e67c3`, which prescribes the method the audit used (a 30–60
  minute journal window, the named incident classes, the live agent count,
  like-for-like windows).
- *Action.* Followed the method and returned `fail` as its verdict on the
  product, with no findings listed.
- *Error.* None attributable to the agent.
- *Attribution.* Compliance is observed. The brief already asked for the same
  steps, which makes the rule's incremental effect confounded, and a single
  attempt cannot separate them: the marginal usefulness of
  `r_6aea5f42f89e67c3` is unmeasured. A paired replay (M0 without the rule
  against M1 with it, same brief) would measure it (criterion 2).

**Case 9. Merger, project C, 2026-10-16 12:21–12:34.**

- *Prompt.* Merge four pinned pull requests; the project names no batch
  procedure.
- *Delivered.* 17 rules (0/0/1/16), 3,311 B, digest `905f8539`. Relevant: 3 of
  17: `r_24934cc3be59bdf7` (reading remerge diffs), `r_3986fe67f42f4484`
  (stashing a single file), `r_6bc50caa81fca4b8` (publication checks). The
  project rule `r_764a5411c68e0370` restates the first working rule; the other
  13 are browser and tool quirks.
- *Action.* A plain squash of each pull request after checking the pinned
  head, the green CI of that head and the parent chain, then a conflict read of
  the three open pull requests with `merge-tree` and `blame`; answered `none`.
  That is the default the variant 4 merger prompt introduced.
- *Error.* None observed.
- *Attribution.* None. The seat rule that had taught seats to authorize batch
  merges in briefs (`r_6fe87b303f22729a`) was archived as stale on 2026-10-15
  16:15: a prompt change made a memory rule obsolete and the curator noticed
  within 90 minutes.

**Case 10. Orchestrator seat, project A, 2026-10-16 12:10.**

- *Prompt.* An operator request about how interface actions behave.
- *Delivered.* 45 rules (4/19/6/16), 10,620 B, digest `18bd39bb`,
  reconstructed at the write time. A seat's block is rendered at its engine
  start, which nothing records, so this is the reading at the write. Relevant:
  none of the 45 says which roles read memory, and the seat notice and pointer
  do not either (`roleRender.ts:14-15`).
- *Action.* Wrote `r_4dccc4825132f0f9` (interface actions show their result at
  once and roll back on failure) at project level, then told the operator that
  every agent of the project reads it and that reviewers and visual critics
  will treat a violation as a finding.
- *Error.* A level wider than its readers (it belongs to the roles that build
  or judge interfaces) and a false statement about enforcement: reviewers and
  gated critics are clean and never receive it (`eligibility.ts:11-27`), while
  the maintainer and the merger, which never build an interface, do.
- *Attribution.* Absent information: nothing in the seat's block names the
  clean roles. A curator pass at 12:40 UTC (after the snapshot) moved the rule
  to the builder scope.

**Case 11. Two orchestrator seats, 2026-10-16 11:27–11:41.**

- *Prompt.* The operator had an unrequested signature line removed from chat
  replies in project C. Each seat's own turn that led to its write sits in its
  private transcript and is summarised here, with the event as the shared
  trigger.
- *Delivered.* Seat of project A at 11:27:44: 43 rules (4/19/5/15), 10,058 B,
  digest `6d921096`. Seat of project C at 11:36:26: 36 rules (2/19/0/15), 8,278
  B, digest `6b7dde40`. Both reconstructed at the write. Relevant: none held a
  rule of this class.
- *Action.* The first seat wrote `r_1a8d29fbc0bb6a22` (change only the visible
  behaviour that was asked for) at this repository's project level at 11:27.
  At 11:36 the second wrote `r_764a5411c68e0370`, the same class, at project C's
  level, and at 11:41 a machine rule on placing every rule at its true scope
  (`r_674896c8a12c8d0e`).
- *Error.* One class written twice at two project levels within nine minutes;
  both project rules restate the first working rule every stage already
  receives, and by the level test the class is either a machine rule or
  already in the prompts.
- *Attribution.* Absent visibility across projects: the seats cannot see each
  other's scopes, and the curator can only find the duplicate after the fact (a
  pass at 12:40–12:45 UTC moved the machine rule and `r_1a8d29fbc0bb6a22` to
  broader role scopes).

**Case 12. Board maintainer, project A, run 2026-10-16 12:13:41–12:25:50.**

- *Prompt.* The board-maintenance brief of the three-hourly slot, delivered as
  a machine launch.
- *Delivered.* 23 rules (0/0/7/16), 4,897 B, digest `58478c4b`: seven about
  this repository's server internals and interface, sixteen tool quirks.
  Relevant to board maintenance: 0 of 23 on the author's reading; one borderline
  candidate (`r_1a8d29fbc0bb6a22`, on unrequested output) would make it 1.
- *Action.* 14 `update_task` writes on 12 tasks (11 text edits, 4 status
  changes, 14 detail updates), no task created or closed.
- *Error.* None recorded: the run succeeded with no failure.
- *Attribution.* None; the cost is the bytes. The run repeats every three
  hours (eight a day for project A).

**Case 13. Curator pass, project A, 2026-10-16 10:00:05–10:21:26, after variant 4.**

- *Prompt.* The curator brief over the 28 scopes of project A, with the list of
  rules the shipped prompts now state.
- *Delivered.* None by design (clean role); the brief carries the rule set
  as its input.
- *Action.* Five calls, 83 changes: it checked, rule by rule, that each reader's
  prompt carries the principle, kept the rules whose readers lack it, archived 77
  rules as already in the prompts, sent one rule to the seat as a problem,
  rewrote 3 and moved 2, and repaired `r_46e5b2eaa551fac1`, which an agent
  rewrite at 10:12 had stripped of its trigger.
- *Error.* One stated assumption that the data does not yet support: interface
  work runs in the builder's frontend or prototype variants, the only ones that
  receive the rendered-work block (`src/lib/roles/registry.ts:138`). Measured:
  28 of the 190 builder attempts since variant 4 received that block.
- *Attribution.* A careful pass with one untested assumption; criterion 9's
  disposition sample would test it. The builder block in project A fell from
  23.8 KB to 15.8 KB and was back at 17.5 KB two hours later.

**Case 14. Curator, first passes, 2026-10-12 23:08 to 2026-10-13 06:34
(supporting observation, aggregate).** The
builder block in project A fell from 107 rules (28.9 KB) to 64 (14.8 KB); the
two passes for A archived 269 rules as task-specific and reviewed 250 rules
archived earlier for budget. Afterwards the larger passes for A rewrote 46
to 104 rules each (six passes between 2026-10-12 23:57 and 2026-10-14 11:03), which is where
the compression in 3.2 comes from. Explanation: the curator removes task
narration well and degrades readability in the rules it keeps.

**Case 15. Architect, this audit stage, 2026-10-16 12:25.**

- *Prompt.* The pinned specification of this lane.
- *Delivered.* 43 learned rules (10/10/7/16), 10,122 B, digest `cd006dd5`, and
  the 8.6 KB engine memory index. Relevant: 6 learned rules
  (`r_10c7007bb5ccc09e`, `r_c41ebf5f9ffb8872`, `r_b941c97ebc4393ab`,
  `r_6bc50caa81fca4b8`, `r_674896c8a12c8d0e`, `r_a7edff278adff2c0`) and one
  engine memory entry (how to run the privacy gate by hand); 37 learned rules
  bear on prototypes, browsers, servers or deployment.
- *Action.* `r_10c7007bb5ccc09e` led to reading the voice call record, which
  showed the rendering had dropped one of the operator's constraints;
  `r_c41ebf5f9ffb8872` led to one read-only snapshot.
- *Error.* The first keyword pass used ASCII word boundaries and English terms
  only, which `r_b941c97ebc4393ab` warns against: 131 of the 351 Ukrainian
  findings fell into the untagged bucket (32 after the pass was redone with
  Unicode word starts and Ukrainian stems).
- *Attribution.* Delivered, relevant, and followed late. The engine memory
  index also carried a superseded pair (an older note puts operator questions in
  chat, a newer one forbids asking in chat prose) and directives meant for the
  seat.

### 3.4 Before and after

1. **Lesson-request wording, R0 → R1 → R2 (whole store).** Observed: the
   fix-round write rate was 99 % under the first wording, 53 % when the
   wording became "most stages do neither", and 98 % when it named the findings
   and asked for their class; the share of fix-round rules the curator later
   judged task-specific was 82 % (R0) and 29 % (R2). These are cohort
   differences and they are facts. They do not isolate the wording: R2 also
   introduced the curator and the problem-report path, the task and model mix
   changed between regimes, older cohorts had longer to meet a curator pass,
   and the judge of "task-specific" is the curator, itself a model. No paired
   replay and no concurrent A/B has run, so the effect of the instruction alone,
   and its size, is unmeasured. The write-side replay of 4.1 and the A/B of
   4.3 are the designs that would measure it; criterion 10's calibration sample
   would make the judge's part a measurement.
2. **The first curator passes (project A builder block).** 28.9 KB → 14.8 KB
   in one night; rules with two or more tasks behind them went from 4
   (2026-10-12) to 49 (now). Review outcomes cannot show the effect (3.2).
3. **Variant 4 prompts and the in-instructions sweep.** 23.8 KB → 15.8 KB;
   12 lanes of project A started a builder attempt after that pass ended
   (10:21:26 UTC) and 2 of them had been reviewed by the cutoff, so outcomes
   cannot show an effect.
4. **Rule-level, within a lane (cases 2 and 4).** In both, the class recurred
   after its rule entered delivery, and the rule was rewritten to cover the
   new instance. These are the only before/after comparisons whose units match
   (same class, same scope, minutes apart), and they show rules that are
   too narrow when written.

### 3.5 What the analysis supports

Observed:

- Write rate and the task-specific share of what is written differ by regime,
  and the wording is one of several concurrent changes (3.4.1); the effect of
  the instruction alone is unmeasured.
- A first-pass request is answered before any review of its lane, and its
  typical answer ("my rules covered it") is followed by a failed review in
  48–80 % of cases (R1 to R3).
- In the builder scope of project A, a full scope evicted each new uncurated
  lesson within minutes (20 never-curated evictions, median 0.33 hours; 25
  evictions in all, median 0.45 hours, five of them curated rules that left
  after the uncurated ones ran out).
- Fix rounds write new rules for classes a delivered rule already names
  (case 2), and rewrites keep a class under one id when they happen (case 4).
- Delivery is whole-scope: a builder in project A starts with about 17–24 KB
  of rules; a maintainer or merger starts with 23 rules of which 0 to 3 bear on
  its work.
- The roles that judge (reviewer, verifier, gated critics) read nothing; rules
  written to prevent their findings reach only the builder.
- Seats place rules at levels wider than their readers and describe their
  reach wrongly (cases 10, 11).
- Curator rewrites compress rules: the compressed share rose from 8 % to 54 %.
- Engine memory reaches stages ungoverned: the seat's Claude index reaches
  every non-clean Claude stage of this repository under either account home
  (both homes link one shared directory), and an unrefreshed Codex summary
  reaches every Codex stage.
- Nothing records which rules an attempt received; reconstruction works only
  while scope history lasts, and the busiest scope keeps every curator-pass
  entry plus the last 500 entries of any kind and gains 36 to 141 entries on a
  full day.

Inferred:

- In the cases traced, a delivered rule that was ignored or too narrow
  explains more errors (cases 1, 2, 4, 5) than an absent rule (case 6a). If the
  judged attribution sample confirms it, more rules will not help, while
  fewer, plainer and better-targeted ones might; the replay benchmark decides.
- Readability likely matters for compliance: the rule case 1 ignored had been
  compressed and merged with an unrelated class.
- Usefulness of a delivered rule is unmeasured everywhere in this document.
  Compliance (case 8) and overlap with a brief are recorded; the paired replay
  of 4.1 is the only design here that separates a rule's effect from them.

## 4. A practical benchmark

### 4.1 Offline replay set

Built from fix rounds, where the failure, the delivered rules and the rule
written afterwards are all on record.

- **Item.** A builder first attempt that failed review with a finding of a
  class later written into a rule. Frozen inputs: the base commit, the brief,
  the pinned specification, the role scaffold as rendered, the learned-rule
  block as delivered (reconstructed today, from the ledger of 4.4 later). The
  engine memory files are a controlled factor, set below. Hidden oracle: the finding, its
  reproduction (most findings carry file, line and a command or probe), and
  the rule written after it.
- **Conditions.** M0 no learned rules; M1 the block as delivered; M2 the
  candidate block (new curator output or new write instruction); M3 M1 plus
  the rule written after the failure. M3 against M1 measures the most a rule
  can do for that item; M0 against M1 measures the block as a whole.
- **Checks.** Deterministic first: the finding's reproduction turned into a
  test, a computed-style probe or a query that goes red on the failing head
  and green on the fixed one. Judged second: a clean reviewer judge, blind to
  the condition, asked only whether the finding's class is present; k = 2 per
  item, with the disagreement rate reported as the noise band.
- **Engine memory is a controlled factor, switched off apart from the learned
  block.** The files a Claude or Codex stage loaded are unversioned, and
  nothing captured them at any failed attempt (1.4), so their content at that
  attempt cannot be recovered. The historical replay therefore runs every arm
  with engine memory off. It measures what learned rules do without engine
  memory and differs from the recorded production run by that factor; every
  result states this. The clean launch flag cannot do it, because at the pinned
  code `cleanMemory` also removes the treatment: `learnedRulesForLaunchProfile`
  returns nothing for a clean profile (`roleLaunch.ts:34-35`), Claude drops its
  appended system prompt (`claudeStreamBrokerHost.ts:923`) and Codex drops its
  developer instructions (`codexAppServerHost.ts:1620`). An M1 or M3 arm
  launched that way would receive no rules. The replay launcher needs two
  independent settings: engine memory off (for Claude `autoMemoryEnabled:
  false` in the settings file and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the
  environment, the two things `spawnPolicy.ts:531-534` sets for a clean launch;
  for Codex the `memories` feature off, `codexAppServerHost.ts:1489-1490`),
  and the frozen block delivered through the channel production uses (Claude
  `--append-system-prompt`, Codex `developerInstructions`) with `cleanMemory`
  false. That is a replay-only launch option that does not exist today.
  Acceptance, before any paid run: a no-model dry run builds the launch
  arguments, the settings file and the Codex configuration for M0, M1 and M3
  without starting an engine and asserts that engine memory is disabled in all
  three arms, that M0 carries no learned block, that M1 carries exactly the
  reconstructed ids and texts, and that M3 carries M1 plus the one added rule,
  each matching the manifest's digests. That dry run has not been written or
  run. A prospective experiment closes the gap: from the day the ledger of
  4.4.1 ships, each engine start stores a private copy of the engine memory
  files it loaded, keyed by hash, and later items replay with the files as
  received.
- **The frozen first message.** What a builder is shown first is not the
  stored `definition.prompt`. `renderStagePrompt` (`src/lib/pipelines/prompts.ts:45-141`)
  builds it: the stage template with `{{task}}` and `{{prev.output}}` expanded,
  where the relayed text is the attempt's persisted `input`
  (`prompts.ts:57-72`; `engine.ts:7149-7156`), then the pinned task and
  specification, the role scaffold, the branch, base and delivery lines, the
  worker limit and the test-command guidance resolved at launch
  (`resolveStageTestGuidance`, a machine-local value). For a message over
  32,000 bytes, `composeStageInput` (`stageInput.ts:26-100`;
  `structuredContent.ts:40`) delivers file references with short excerpts instead of the
  specification or the relay. The bundle holds the complete rendered message
  with every substitution made and the test guidance fixed to one text, its byte
  length and SHA-256, and a flag when the original launch exceeded the inline
  limit and so delivered excerpts and files; the replay delivers the inline
  form and the report says so.
- **Recoverable inputs, validation and the pilot manifest.** Historical items
  need five inputs: the base commit (resolves in the repository's object
  store), the brief and the pinned specification (on the pipeline record), the
  rendered scaffold (on the attempt), and the learned block (reconstructed
  from scope history while the attempt lies inside the retained window, 4.4.2).
  The appendix script counts the candidates at the snapshot: 210 builder lanes
  whose first review failed, 144 whose fix round wrote or rewrote a rule, 136
  with all five inputs present (32 rendered-state, 78 contract-or-seam, 26
  evidence-or-claim). Presence is not enough, so the validation pass of the
  appendix (no model call, no cost) assembles each message offline and drops an
  item when the base commit does not resolve, a `{{...}}` placeholder remains,
  a template that places `{{prev.output}}` has an empty persisted input (a root
  stage has none and needs none), or the message names a URL, a pull request, an
  issue or a `gh` call whose content is not frozen into the bundle. Run on the
  14:19 UTC export, 74 of the 136 candidates pass; the 62 that fail all name a
  live reference, and none fails on a placeholder, a missing relay or a missing
  base. The pilot takes the lowest SHA-256 of the pipeline id in each stratum
  among the items that pass (4, 3, 3). Three of the ten items first drawn
  (digest `3c6e4d3937fb`) name a pull request and were replaced by the next
  lowest hash in their stratum; the validated manifest of ten has digest
  `a330fd597223`. Its messages are 8.8 to 35.1 KB; one exceeds the inline
  limit because it carries a relayed design of about 24 KB, which the first
  version of the bundle (base object, prompt, specification, scaffold) would
  have left out. A byte comparison of an assembled message with the first user
  message recorded in the original transcript was not run in this pass.
- **Retained input bundle.** A private directory outside any checkout holds,
  per pilot item: the pipeline id, stage and attempt, a git bundle of the base
  commit, the complete rendered first message and its digest, the specification,
  the scaffold, the ordered rule ids with their texts at that time, the finding
  texts, and a frozen copy of anything the message references that can change
  (a pull request's text and diff at the attempt's start). Missing-input policy:
  an item that fails validation is dropped and replaced by the next lowest hash
  in its stratum, and the number dropped is reported with the results.
- **Size.** Pilot: 10 items (four rendered-state, three contract or seam,
  three evidence or claim) from the validated manifest above, conditions M1 and M3 with
  engine memory off, two runs each: 40 builder runs. Full set: 30 items over
  three projects and all four conditions. Run under the project's worker cap,
  in scratch exports, never against live state.
- **Write-side replay (cheap, run first).** For instruction changes to the
  lesson request: freeze a fix round's context up to its `stage_report`, then
  replay only the lesson turn under each candidate request text. Score the
  answer deterministically (identifiers, length, level against the class map,
  rewrite of a delivered same-class rule when one exists) and by judge
  (general, accurate against the code at that commit, would have caught the
  finding). One turn per item, so 50 items × 2 texts × 2 runs is affordable.
  Whether the engines can fork a stored conversation for one turn needs a
  probe before this is built.
- **Curator replay.** Extend `src/lib/memory/curation/curator.eval.test.ts`
  (12 synthetic cases, one recorded run) with frozen copies of real scopes
  and a labelled disposition per rule; report agreement and stability over
  k = 3 runs.

#### Build the free input bundle

Run the offline exporter against a state directory whose repositories still
contain the recorded base commits. Choose a new output directory outside every
checkout and outside the source state directory; its parent must already exist:

```sh
bun scripts/memory-replay.ts --state-dir "$STATE_DIR" --output "$PRIVATE_EXPORT/replay"
```

This command makes no model calls and starts no engine. It opens `state.sqlite`
read-only, uses `VACUUM INTO` for a consistent private snapshot, and reads the
`pipelines`, `pipelines_archive` and `role_memory` collections from that snapshot.
It keeps `source.sqlite` and its SHA-256 with the export. The source database and
repository refs are never changed. The output directory and files have private
permissions. The command prints only eligible, dropped and pilot counts.
The checkout and source-state checks resolve the output parent's real path,
including symlinks, before creating the export.

`manifest.json` lists all eligible items, rejection reasons, and the deterministic
4/3/3 pilot chosen by SHA-256 of pipeline ids. A short stratum remains short;
the exporter does not silently fill it from another one. Each `items/<id>/`
contains `base.bundle` and `input.json`: the resolved base commit, brief, pinned
specification, substituted scaffold, full first message, byte count, inline-limit
flag, ordered historical rule ids and texts, reconstructed rule lines, the current learned-rule wrapper and hashes.
The renderer is the current checkout's `renderStagePrompt`, with the attempt's
frozen definition and scaffold, worker limit 30, and one fixed test-guidance
string. It is a reproducible replay input, not proof of byte identity with the
historical launch. The replay uses the full inline message even when the flag
says the historical launch would have spilled into files.

`oracle/<id>.json` separately retains matching findings, their verbatim text as
reproduction evidence, and the rules at their actual write times. A request's
`at` is when the lesson was requested, not when it was written; new rules use
`createdAt`, and rewrites use the matching attempt's retained revision provenance.
Reproductions are neither inferred nor executed. Turn them into red/green checks
before paid replay. Give the builder only its item directory: the oracle and
source snapshot contain answers and must remain hidden.

The exporter implements the historical four-scope reconstruction from the
appendix, including text versions. It rejects missing inputs, unavailable base
objects, missing relays, unresolved placeholders, live references, unmatched
finding/rule classes, unavailable write provenance, and attempts outside the
retained scope history. Scope succession or transfers recorded as moves are
rejected because the four-scope reconstruction cannot establish their delivered
order. A later archive, merge or rewrite without a saved pre-change order also
drops the item with `scope order unavailable`; the exporter does not guess where
a removed or reordered rule belonged. Saved `before` lists restore the exact
order. This exporter does not yet consume the delivery ledger or reproduce
swarm selections; use it for historical four-scope cohorts described here.
It does not build a replay launcher or claim that engine memory has been disabled
in an actual run. Keep the export private and outside version control.

The fixture-backed test is `scripts/memory-replay.test.ts`; it creates synthetic
SQLite records and a disposable repository, and checks the git bundle, historical
text, oracle separation, rejection cases and unchanged source database.

### 4.2 Online metrics from existing records

Computed weekly from the store and the pipeline records, each with n and an
interval. The first seven need only the export in the appendix and the
definitions below; the last three need judging and the ledger of 4.4.

| Metric | Definition | Value now |
| --- | --- | --- |
| Fix-round write rate | lesson or rewrite ÷ fix-round requests | R3: 82 of 83 |
| Write precision | written rules not archived as task-specific, stale, problem or no-reader ÷ written rules, after one curator pass | R2 fix rounds: 95 of 135 |
| None-claim accuracy | first-pass builder requests (3.2) answering "covered" whose next review passed ÷ those reviewed | R3: 8 of 40 |
| Budget evictions of never-curated rules | count and median life, population of the appendix | 20, 0.33 hours (25 and 0.45 hours with the 5 curated rules) |
| Recurrence capture | active rules with `tasks ≥ 2` | 49 of 228 |
| Role block bytes | per role and project at each engine start | builder A 17.5 KB |
| Compression index | share of active rules with ≥3 slashes or ≥2 semicolons | 77 of 228 |
| Delivery relevance | judged share of delivered items bearing on the task, 10 attempts per role per week | needs the ledger |
| Finding attribution | judged label per finding: delivered and ignored, too narrow, absent, not memorizable; 20 findings per week | needs the ledger |
| Curator disposition accuracy | judged sample of 20 dispositions per week | not measured |

### 4.3 A/B protocol for a change to write instructions or the curator

- **Hold fixed:** engine, model and effort per role; role scaffolds; the
  project; the curator brief (when testing the write side) or the write text
  (when testing the curator); the replay items.
- **Write side, live.** Assign the request text by a hash of the pipeline id,
  so both arms run in the same weeks on the same task mix. Primary metric:
  write precision. Guard metrics: write rate, none-claim accuracy, role block
  bytes. Detecting a fall in the task-specific share from 29 % to 15 % at
  α = 0.05 and power 0.8 needs about 135 fix-round rules per arm: about a
  week of fix rounds at the R2 rate (51 rules a day), plus two days for the
  curator to judge them. Both arms write into the same scopes, so the
  curator is held at one brief for the test's length.
- **Delivery side.** A live split contaminates: both arms read the same
  scopes. Use the replay (4.1) for anything that changes what is delivered.
  Detecting an avoid-rate change from 25 % to 50 % needs about 55 runs per
  arm by the unpaired bound; pairing by item lowers it.
- **Curator.** Replay on frozen scope copies; primary metric: disposition
  agreement with the labelled set; guards: bytes per role block, compression
  index, rules lost (must be zero).
- **What counts as an improvement:** the primary metric moves past its
  interval in the pre-registered direction, no guard regresses beyond its
  noise band, and the replay agrees in direction. A reviewer pass rate alone
  never counts.

### 4.4 Instrumentation missing today

1. **A delivery ledger.** `learnedRulesForLaunchProfile`
   (`src/lib/memory/roleLaunch.ts:33-42`) returns text and records nothing.
   It should append one row per engine start to `role_memory` (or a sibling
   collection): conversation, attempt when known, the scope revisions, the
   ordered rule ids, bytes, and the hashes of the engine memory files loaded.
   Ids only, so the egress rules are untouched. A hash cannot recover the
   engine memory files' content, so the ledger also stores a private copy of
   each distinct file version, keyed by that hash, outside the checkout.
2. **History that lasts.** Historical observation at the analysis cutoff: `keepHistory` kept every curator-pass entry and
   the last 500 entries of any kind (`roleStore.ts:39-42`); curator entries
   inside the window use its slots, so 500 ordinary entries followed by 10 pass
   entries leave 490 of the ordinary ones. The builder scope of project A holds
   440 entries after six days, 25 of them curator passes, and gains 36 to 141 on
   a full day. About 60 more entries (one to two days) fill the window; after
   that the oldest agent entries drop, starting on 2026-10-10, and the delivered
   sets of R0 and R1 can be rebuilt only at the curator-pass boundaries that
   survive, not between them. The ledger removes the dependency. This stage's snapshot lived in its scratch
   directory and is gone with it; until the ledger ships, the retained input bundle of 4.1 is
   built from a read-only snapshot taken before that scope passes 500 entries
   and kept outside any checkout; it is the benchmark's frozen input for R0
   and R1.
   Current code now retains 10,000 ordinary changes independently of curator
   records (`roleStore.ts`, `ROLE_MEMORY_HISTORY_LIMIT`) and has a delivery
   ledger. The 500-entry limit and six-day counts above describe the historical
   snapshot, not the current retention policy. The free exporter above still
   uses retained scope history and rejects gaps.
3. **Finding to rule link.** `leave_lesson` in a fix round should record which
   handed findings its answer addresses, so attribution and recurrence stop
   depending on keyword classes.
4. **Scaffold blocks per attempt.** Which conditional blocks (rendered work,
   tests, server) the attempt's scaffold carried, as booleans on the attempt;
   case 13's question is answered by it.
5. **Curator pass bytes.** Pass rows carry counts; adding the per-role block
   bytes before and after makes criterion 9 a lookup.
6. **Replay ledger.** Reuse the run ledger of the role evaluation harness
   (`evals/roles/`, `scripts/role-eval.ts`) for replay runs.

## 5. Conclusions and improvement plan

Ordered by expected value per cost. Each item names the metric that shows it
worked; none should ship without its metric being computable first.

| # | Change | Where | Metric that shows it worked |
| --- | --- | --- | --- |
| 1 | Delivery ledger and lasting history (4.4.1, 4.4.2) | `roleLaunch.ts`, `roleStore.ts` | Delivered sets reconstructable for 100 % of attempts; this is the precondition for criteria 3, 5, 6 and 7 |
| 2 | Stop evicting a lesson nobody has curated: while a scope is over its bound, keep never-curated lessons until one curator pass has seen them, and run the pass early when a scope crosses 90 % | `roleConsolidate.ts:59-72`, curation trigger | Budget evictions of never-curated rules: 20 → 0 (population of the appendix); no scope over its bound after a pass |
| 3 | Move the request of a first-pass stage to where the agent knows something: ask what the stage corrected on its own way, and drop the "covered" answer | `roleRender.ts:91-95` | None-claim accuracy rises above 50 %, or that request is retired; write precision of its rules holds |
| 4 | In a fix round, list the ids of the two or three delivered rules nearest to each handed finding and ask for a rewrite when one names the class | `roleStage.ts:35-42`, `roleRender.ts:72-85` | Share of fix-round lessons later merged into a rule the same attempt had received (needs the ledger) falls; rewrite share rises; replay M3 avoid rate holds |
| 5 | A readability floor for curator rewrites: split before compressing; no slash chains; one class per rule | `curation/brief.ts:7` | Compression index back under 10 %; replay compliance on rewritten rules at least equal to the original texts |
| 6 | Tell seats who reads what: the seat notice names the clean roles and the level test, and a rule meant to be enforced at review goes to the reviewer prompt through the existing promotion step | `roleRender.ts:14-15`; promotion in `role-memory-to-prompts.md` §5.3 | Seat rules archived for level or no-reader fall; findings whose class has a builder rule and no reviewer block, counted per week |
| 7 | Narrow delivery for roles that cannot use it: the maintainer reads its own role scopes and the machine rules marked for every role; merger and deployer the same | `roleStore.ts:109-111` | Judged delivery relevance for maintainer and merger above 50 %, from 0–20 % |
| 8 | Govern engine memory for stages: turn off Claude auto memory and Codex `use_memories` for pipeline stages, keep them for seats, and let the curator read the seat's notes as candidates | `spawnPolicy.ts:531-534`, `codexAppServerHost.ts:1489-1490` | The prospective experiment of 4.1 (engine memory captured per start) shows no loss without it; 8.6 KB (Claude) or 11.3 KB (Codex) less per stage start |
| 9 | Build the write-side replay, then the delivery pilot (4.1) | evaluation harness | Noise band measured; the first instruction change tested before it ships |
| 10 | Calibrate the curator: weekly sample of 20 dispositions, judged | curator pass rows | Disposition accuracy reported with an interval; the case 13 assumption tested |
| 11 | Let a failing verifier or prod-auditor stage leave a lesson request with its findings for the role it judged | `roleStage.ts:35-53` | Findings never handed to a lesson request: 12 since 2026-10-12 → 0 |

## Deferred — not currently justified

- **Per-task selection of rules (retrieval or a judge at start).** Whole-scope
  delivery wastes bytes on some roles; item 7 addresses the worst of it with a
  rule, and the ledger will show whether relevance needs a model.
- **A live A/B on delivered rules.** Both arms read the same scopes; the
  replay does this without contamination.
- **Retiring rules for disuse.** The operator's rule of 2026-10-02 stands:
  usefulness ranks, it never deletes.
- **Token counts in a provider tokenizer.** It would send rule text out and
  may cost money; bytes are exact and enough for comparison.
- **A model judging each lesson at write time.** The curator does it in bulk;
  item 10 measures how well.
- **A memory scope shared by several roles, or a tool level.** Proposed in
  `role-memory-to-prompts.md` §5.1–5.2; their effect is measurable only after
  item 1.

## Decisions for the operator

None blocks this document. The seat may put these in a form; the
recommendation is first.

1. Which improvement goes first: items 1 and 2 together (recommended), item
   3, or item 8.
2. Engine memory for pipeline stages: off for stages and kept for seats
   (recommended), kept as is, or off everywhere.
3. The replay pilot of 40 builder runs, which spends paid model runs: build
   and validate the retained input bundle now at no cost (4.1), then run the
   pilot with engine memory switched off in both arms once the operator
   approves the spend (recommended), wait for the ledger and the prospective
   experiment, or skip.

## Validation against the requirement

| Requirement | Where |
| --- | --- |
| How memory is written now, which fragments, how correct | 1.1, 3.2, cases 1, 2, 4, 10, 11, 14 |
| How the write instruction affects what is written | 3.2 wording table, 3.4.1 |
| The curator's effect on agents | 3.2 bytes table, cases 13, 14, 3.4.2–3 |
| Delivered prompt → memory items → actions → errors | 3.1 method, 3.3 (twelve complete traces) |
| A benchmark for memory | 2, 4.1–4.3 |
| A way to measure whether changes help agents learn | 4.3, 5 (a metric per item) |
| What to improve in writing, selection and use | 5 |
| Read-only, nothing private in the document | 3.1; the requirement paraphrased, rules by id, cases by role and date, projects by letter |

## Appendix: reproducing every number

Every aggregate in sections 1 to 4 comes from the export and the script
below, except the point-in-time reads named under "Point-in-time reads that
no later read can reproduce", which are marked non-reproducible. A second reader needs no choice
beyond the project keys.

**Cutoff.** `T = 2026-10-16T12:28:42Z`. Records stamped after `T` are ignored.
The script compares epoch milliseconds, because as text `…12:28:42.582Z` sorts
before `…12:28:42Z` and one request after the cutoff would slip in (the
1,340th request).

**The store is not append-only.** Request rows are written once. Four other
kinds are overwritten in place, and the script restores each to its state at
`T` from a field that survives:

| Record | What is overwritten | How the script restores the state at `T` |
| --- | --- | --- |
| Curation pass | `state`, `endedAt`, `counts` when the pass ends (one pass was claimed at 12:26:02 and ended at 12:48:32, so a later read shows it succeeded) | Pass state at `T` from its own `endedAt` |
| Scope | `active`, `revision` (the `history` list only grows) | Walks `history` backwards from the current list |
| Rule | `reason`, `changedAt`, `curatedAt`, `state`; a curator pass restamps `changedAt` of every rule it keeps; `mergedFrom`, `splitFrom` and `versions` links | A disposition counts only when `changedAt <= T`, which is correct when no rule that was inactive at `T` was touched afterwards: the script prints that count and it must be 0 (it was 0 at 14:19 UTC; 188 rules had been touched after `T`, none of them inactive at `T`). Merge, split and version links are kept only if the linked row was made by `T` |
| Pipeline | Attempts are updated while they run | Only attempts started or completed by `T` are read; a verdict is set once, at completion |

**Input provenance and digests.** One read-only open of the Viewer's
`state.sqlite` (the file under the Viewer's state directory) with `bun:sqlite`
in `readonly` mode, per read. The 12:28 UTC export (443 ms) was not kept, and
the figures of this document come from it. The second export, at 14:19:06 UTC,
was run through the script below and reproduced every line of the expected
output table, including the pass states and the count of rules with two or
more tasks, which the first version of the script got wrong (50 rather than
49) because it followed merge and split links written after `T`. Of the case
blocks of 3.3 only those of cases 1 and 2 were re-run on it. Its files, by the first
twelve hex digits of their SHA-256: `role_memory.json` `a1df9f9b48a6`,
`role_memory_curation.json` `a9d8d8881c76`, `pipelines.json` `fead0e6c80f0`,
`pipelines_archive.json` `7f2cedb413f7`. It lived in the stage's scratch
directory and was removed with it, so those digests prove what was run and
cannot be re-checked here. Retention rule for any later use of this method:
write the export once to a private directory outside any checkout, record its
SHA-256 and time next to every figure derived from it, and re-run the script on
that file, never on the live store. The export files hold rule and prompt text
and stay private; the script prints counts, ids and hashes only.

```ts
// export.ts: bun export.ts <path to state.sqlite> <private output dir>
import { Database } from "bun:sqlite";
import fs from "node:fs";
const db = new Database(process.argv[2], { readonly: true });
for (const c of ["role_memory", "role_memory_curation", "pipelines", "pipelines_archive"]) {
  const rows = (db.query("select value_json v from state_rows where collection=?").all(c) as { v: string }[]).map(r => JSON.parse(r.v));
  fs.writeFileSync(`${process.argv[3]}/${c}.json`, JSON.stringify(rows));
}
db.close();
```

The shared-recall offer figures (1.3) come from a read-only open of
`memory-index.sqlite`. Offers carry their own time, so these reproduce for any
cutoff:

```sql
select channel, outcome, count(*) offers, count(distinct conversation_id) conversations
from memory_offers where at <= '2026-10-16T12:28:42.000Z' group by channel, outcome;
-- inject: 23 offers (2 opened, 21 without an outcome), 13 conversations; search: 1,867 offers, all opened
-- opened hits, by the time they were opened: select channel, count(*) from memory_offers
--   where outcome = 'opened' and outcome_at <= '2026-10-16T12:28:42.000Z' group by channel  -- 2 and 1,867
```

The 13 injected conversations were matched against the stage attempts of the
1,058 pipeline records (`attempts[].conversationId`); none matched.

**Point-in-time reads that no later read can reproduce.** The October counters
of judged, skipped, no-match, no-candidate and failed turns (1.3) are monthly
totals in `memory_injection_activity` (`index.ts:666-686`), incremented in
place with no time per event. They were read once, at the snapshot (348, 683,
323, 178, 13). The same counters at 14:26 UTC read 350, 689, 325, 188 and 15,
and no query can recover the values at `T`; treat the 1.3 figures as a reading
of that moment, usable for scale only. The same holds for the index
composition (6,099 Codex references and so on): the index is a derived table
that is rebuilt, with no history. The sizes of the engine memory files (1.4)
are file metadata read at the snapshot.

**Claude file-memory inventory (1.4).** Metadata only, no file is opened:
`stat` on `projects/<repository key>/memory` under each configured Claude
account home, then `stat -L` on the link target and on its `MEMORY.md`.
Result: both homes hold a symbolic link created on 2026-10-01 whose target is
one directory in the operator's native Claude home (same inode, same 8,620-byte
index, index last modified 2026-10-16 08:13 UTC). Each home also holds 22 to
24 memory directories for other repositories.

**Script.** `PROJECT_A` is the `project` field of this repository's pipelines.
`TRACES` is a JSON list of `[label, project key, role, ISO time]` rows for the
traced attempts of 3.3 (the time is each attempt's `startedAt`, or the write
time for a seat). Run `PROJECT_A=… TRACES='[…]' bun memory-analysis.ts <dir>`.

```ts
// bun memory-analysis.ts <dir with the exports>; read-only on the exports.
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const dir = process.argv[2] ?? ".";
const load = (name: string) => JSON.parse(fs.readFileSync(`${dir}/${name}.json`, "utf8"));
const ms = (s: string) => Date.parse(s);
const T = ms("2026-10-16T12:28:42Z");              // the cutoff; compare epochs, never strings ("…42.5Z" < "…42Z" as text)
const upTo = (s: string) => ms(s) <= T;
const rm = load("role_memory"), curation = load("role_memory_curation");
const pipelines = [...load("pipelines_archive"), ...load("pipelines")];
const rules = rm.filter((r: any) => r.kind === "rule"), requests = rm.filter((r: any) => r.kind === "request");
const scopes = rm.filter((r: any) => r.kind === "scope");
const ruleBy = new Map<string, any>(rules.map((r: any) => [r.id, r]));
const scopeBy = new Map<string, any>(scopes.map((s: any) => [s.scope, s]));
const pipeBy = new Map<string, any>(pipelines.map((p: any) => [p.id, p]));
const roleOf = (s: any) => s.role?.roleId ?? s.effectiveRole?.roleId;
const attemptsOf = (p: any) => p.stages.flatMap((s: any) => (p.runs.find((r: any) => r.stageId === s.id)?.attempts ?? []).map((a: any) => ({ stage: s.id, role: roleOf(s), gate: !!s.onFail, ...a })));
const attemptOf = (r: any) => attemptsOf(pipeBy.get(r.pipelineId)).find((a: any) => a.stage === r.stageId && a.n === r.attempt);
const wilson = (k: number, n: number) => { const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return `${Math.round(100 * (c - m) / d)}–${Math.round(100 * (c + m) / d)}`; };
const pct = (k: number, n: number) => `${k}/${n} (${Math.round(100 * k / n)} %, ${wilson(k, n)})`;
const median = (a: number[]) => { a = [...a].sort((x, y) => x - y); const n = a.length; return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2; };

// ---- what a stage received (section 3.1) -------------------------------------------------
const versions = new Map<string, any[]>();
for (const r of rules) if (r.versionOf) versions.set(r.versionOf, [...(versions.get(r.versionOf) ?? []), r]);
function activeAt(scope: string, t: number): string[] {          // ids in render order
  let set: string[] = [...(scopeBy.get(scope)?.active ?? [])];
  for (const h of [...(scopeBy.get(scope)?.history ?? [])].reverse()) {
    if (ms(h.at) <= t) break;
    if (h.before) { set = [...h.before]; continue; }              // a curator call
    set = set.filter(id => !(h.added ?? []).includes(id));        // undo an append
    for (const id of h.restored ?? []) set = set.filter(x => x !== id);
    for (const id of h.archived ?? []) if (!set.includes(id)) set.unshift(id);
  }
  return set.reverse();
}
const textAt = (id: string, t: number) => ((versions.get(id) ?? []).filter(v => ms(v.changedAt) > t).sort((a, b) => ms(a.changedAt) - ms(b.changedAt))[0] ?? ruleBy.get(id)).rule;
const block = (project: string, role: string | null, t: number) =>   // readable scopes: roleStore.ts:109-111
  [...(role ? [`role:${project}:${role}`, `role:*:${role}`] : []), `project:${project}`, "machine"].flatMap(scope => activeAt(scope, t).map(id => ({ scope, id })));
const bytes = (b: { id: string }[], t: number) => new TextEncoder().encode(b.map(x => `- [${x.id}] ${textAt(x.id, t)}`).join("\n")).byteLength;
const contentDigest = (b: { id: string }[], t: number) => crypto.createHash("sha256").update(b.map(x => `- [${x.id}] ${textAt(x.id, t)}`).join("\n")).digest("hex").slice(0, 8);   // ids AND texts at t
const digest = (b: { id: string }[]) => crypto.createHash("sha256").update(b.map(x => x.id).join("\n")).digest("hex").slice(0, 8);
const projA = process.env.PROJECT_A ?? "";                       // the key of the repository under analysis

// ---- finding classes: a term matches at the start of a word and may continue (a stem) ------
const W = "(?<![\\p{L}\\p{N}])";
const cls = (terms: string) => new RegExp(`${W}(?:${terms})`, "iu");
const CLASSES: Record<string, RegExp> = {
  rendered: cls("viewport|width|theme|dark|light|locale|language|matrix|screenshot|frame|phone|ширин|тем[аиіуо]|темн|світл|мов[аиіуо]|кадр|скріншот|знімк|телефон"),
  contract: cls("contract|shape|schema|validation|payload|контракт|схем|валідац|формат"),
  seam: cls("restart|stale|identity|race|concurren|crash|recover|reload|resume|succession|replay|перезапуск|рестарт|застар|ідентичн|гонк|конкурен|збій|відновл|перезавантаж|поновл|наступн|повтор"),
  tests: cls("test|тест"),
  privacy: cls("privacy|private|приват|конфіденц"),
  hotPath: cls("whole.store|per.tick|blocking|synchronous|cache|unbounded|event.loop|на.тик|блокув|синхрон|кеш|необмежен|цикл.подій"),
};
const classesOf = (text: string) => Object.entries(CLASSES).filter(([, re]) => re.test(text)).map(([k]) => k);
const COVERED = /cover|already|existing|наявн|чинн|вже|охоплю|покрив|достатн/iu;   // a "my rules covered it" answer

// ---- regimes (section 3.1) -------------------------------------------------------------------
const B1 = ms("2026-10-11T11:29:00Z"), B3 = ms("2026-10-15T14:57:00Z");
const B2 = Math.min(...requests.filter((r: any) => r.taskId).map((r: any) => ms(r.at)));   // first request carrying a task id
const regime = (t: string) => ms(t) < B1 ? "R0" : ms(t) < B2 ? "R1" : ms(t) < B3 ? "R2" : "R3";
const kindOf = (r: any) => r.problem ? "problem" : r.rewrote ? "rewrite" : r.ruleIds.length ? "lesson" : r.none ? "none" : "open";
const reqs = requests.filter((r: any) => upTo(r.at));
const fixEdge = (r: any) => attemptOf(r)?.activatedBy?.edge === "fail";
const byRegime = <X>(xs: X[], at: (x: X) => string, f: (x: X) => boolean) => Object.fromEntries(["R0", "R1", "R2", "R3"].map(g => { const m = xs.filter(x => regime(at(x)) === g); return [g, [m.filter(f).length, m.length]]; }));
const show = (title: string, o: Record<string, number[]>) => console.log(title, Object.entries(o).map(([g, [k, n]]) => `${g} ${pct(k, n)}`).join(" · "));

console.log("== store totals");
const rowsAtT = rules.filter((r: any) => upTo(r.createdAt) && !(r.versionOf && !upTo(r.changedAt)));
const active = scopes.flatMap((s: any) => activeAt(s.scope, T));
console.log({ ruleRows: rowsAtT.length, activeAtT: active.length, versionRows: rules.filter((r: any) => r.versionOf && upTo(r.changedAt)).length,
  requests: reqs.length, answers: reqs.reduce((a: any, r: any) => (a[kindOf(r)] = (a[kindOf(r)] ?? 0) + 1, a), {}), failEdgeRequests: reqs.filter(fixEdge).length,
  curatorRewriteEntries: scopes.flatMap((s: any) => s.history).filter((h: any) => h.pass && upTo(h.at)).reduce((n: number, h: any) => n + (h.rewritten ?? []).length, 0),
  passes: curation.filter((p: any) => upTo(p.claimedAt)).length });
// A pass row is overwritten when it ends, so its state at T comes from its own endedAt.
const passStateAtT: Record<string, number> = {};
for (const p of curation.filter((p: any) => p.kind === "pass" && upTo(p.claimedAt))) { const s = p.endedAt && upTo(p.endedAt) ? p.state : "launching"; passStateAtT[s] = (passStateAtT[s] ?? 0) + 1; }
console.log({ passStateAtT });
// Drift guard: rule rows are overwritten in place (reason, changedAt, curatedAt, state), and a curator pass restamps changedAt of
// every rule it keeps. The disposition filters below trust "changedAt <= T" for a rule that was not active at T; that holds only
// if no such rule (archived or merged by T) was touched again after T. The last field must print 0.
const activeAtTSet = new Set(active);
console.log({ ruleRowsTouchedAfterT: rules.filter((r: any) => !upTo(r.changedAt)).length, inactiveAtTButTouchedAfter: rules.filter((r: any) => !r.versionOf && upTo(r.createdAt) && !activeAtTSet.has(r.id) && !upTo(r.changedAt)).length });

console.log("== 3.2 lesson answers by wording");
show("fix-round requests that wrote or rewrote:", byRegime(reqs.filter(fixEdge), (r: any) => r.at, (r: any) => ["lesson", "rewrite"].includes(kindOf(r))));
const fixRules = rules.filter((r: any) => upTo(r.createdAt) && r.source.fixRound && !r.splitFrom && !r.versionOf);   // original rules only
show("fix-round rules archived as task-specific:", byRegime(fixRules, (r: any) => r.createdAt, (r: any) => r.reason === "task-specific" && upTo(r.changedAt)));
show("fix-round rules archived for budget:", byRegime(fixRules, (r: any) => r.createdAt, (r: any) => r.reason === "budget" && upTo(r.changedAt)));
const priorReview = (r: any) => { const a = attemptOf(r); return attemptsOf(pipeBy.get(r.pipelineId)).some((x: any) => x.role === "reviewer" && x.verdict?.status && x.completedAt && ms(x.completedAt) <= ms(a.startedAt)); };
const notFix = reqs.filter((r: any) => !fixEdge(r));                  // not activated by a fail edge: also later retries and stages named like fixes
const firstPass = notFix.filter((r: any) => !priorReview(r));         // and no reviewer verdict had finished in the lane when the attempt started
console.log({ notActivatedByFailEdge: notFix.length, ofThemWithAReviewFinishedEarlier: notFix.length - firstPass.length });
show("first-pass requests answered none:", byRegime(firstPass, (r: any) => r.at, (r: any) => kindOf(r) === "none"));
show("…of which claim existing rules cover it:", byRegime(firstPass.filter((r: any) => kindOf(r) === "none"), (r: any) => r.at, (r: any) => COVERED.test(r.none)));
const selfAssessed: Record<string, number[]> = {};                    // builder, first pass, "covered", then the next review
for (const r of firstPass.filter((r: any) => r.roleId === "builder" && kindOf(r) === "none" && COVERED.test(r.none))) {
  const all = attemptsOf(pipeBy.get(r.pipelineId)), a = attemptOf(r);
  const review = all.filter((x: any) => x.role === "reviewer" && x.verdict?.status && a.completedAt && ms(x.startedAt) >= ms(a.completedAt)).sort((x: any, y: any) => ms(x.startedAt) - ms(y.startedAt))[0];
  if (!review) continue;
  const g = regime(r.at); selfAssessed[g] ??= [0, 0]; selfAssessed[g][1]++; if (review.verdict.status === "fail") selfAssessed[g][0]++;
}
show("next review failed after a first-pass 'covered' answer:", selfAssessed);

console.log("== 3.2 retention and shape");
const budget = rules.filter((r: any) => r.kind === "rule" && !r.versionOf && r.reason === "budget" && upTo(r.changedAt));
const life = (r: any) => (ms(r.changedAt) - ms(r.createdAt)) / 3.6e6;
const neverCurated = budget.filter((r: any) => !(r.curatedAt && ms(r.curatedAt) < ms(r.changedAt)));
console.log({ budgetArchives: budget.length, neverCurated: neverCurated.length, neverCuratedMedianHours: +median(neverCurated.map(life)).toFixed(4),
  curatedBefore: budget.length - neverCurated.length, allMedianHours: +median(budget.map(life)).toFixed(4) });
const lifeOf = (reason: string) => rules.filter((r: any) => !r.versionOf && r.reason === reason && upTo(r.changedAt)).map(life);   // createdAt to the archive, in hours
const p90 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.ceil(0.9 * a.length) - 1];
console.log({ taskSpecific: [lifeOf("task-specific").length, +median(lifeOf("task-specific")).toFixed(1)], inInstructions: [lifeOf("in-instructions").length, +median(lifeOf("in-instructions")).toFixed(1)],
  budgetAll: [budget.length, +median(budget.map(life)).toFixed(2), +p90(budget.map(life)).toFixed(1)], budgetNeverCurated: [neverCurated.length, +median(neverCurated.map(life)).toFixed(2), +p90(neverCurated.map(life)).toFixed(1)],
  budgetCurated: [budget.length - neverCurated.length, +median(budget.filter(r => !neverCurated.includes(r)).map(life)).toFixed(1)] });   // [n, median, p90]
const cp = (s: string) => [...s].length, comp = (t: string) => (t.match(/\//g) ?? []).length >= 3 || (t.match(/;/g) ?? []).length >= 2;
const rewritten = active.filter(id => (ruleBy.get(id).versions ?? []).some((v: string) => upTo(ruleBy.get(v)?.changedAt ?? "9999")));
const firstText = (id: string) => (versions.get(id) ?? []).filter(v => upTo(v.changedAt)).sort((a, b) => ms(a.changedAt) - ms(b.changedAt))[0]?.rule ?? ruleBy.get(id).rule;
console.log({ activeRewrittenAtLeastOnce: rewritten.length, compressedAtFirstWriting: rewritten.filter(id => comp(firstText(id))).length,
  compressedNow: rewritten.filter(id => comp(textAt(id, T))).length, compressedAmongAllActive: active.filter(id => comp(textAt(id, T))).length,
  activeAtCap300: active.filter(id => cp(textAt(id, T)) === 300).length, sixOrMoreVersions: active.filter(id => (ruleBy.get(id).versions ?? []).length >= 6).length });
const slashPer100 = (ts: string[]) => +(100 * ts.reduce((n, x) => n + (x.match(/\//g) ?? []).length, 0) / ts.reduce((n, x) => n + cp(x), 0)).toFixed(2);   // pooled over the rules
const meanLen = (ts: string[]) => Math.round(ts.reduce((n, x) => n + cp(x), 0) / ts.length);
console.log({ slashesPer100CharsFirstText: slashPer100(rewritten.map(firstText)), slashesPer100CharsNow: slashPer100(rewritten.map(id => textAt(id, T))),
  meanLengthFirstText: meanLen(rewritten.map(firstText)), meanLengthNow: meanLen(rewritten.map(id => textAt(id, T))), meanLengthAllActive: meanLen(active.map(id => textAt(id, T))) });
const taskKeys = new Map<string, Set<string>>();
for (const r of reqs) for (const id of [...r.ruleIds, ...(r.rewrote ? [r.rewrote] : [])]) taskKeys.set(id, (taskKeys.get(id) ?? new Set()).add(r.taskId ?? `pipeline:${r.pipelineId}`));
const kids = new Map<string, string[]>(); for (const r of rules) if (!r.versionOf && r.mergedInto && upTo(r.mergedAt ?? r.changedAt)) kids.set(r.mergedInto, [...(kids.get(r.mergedInto) ?? []), r.id]);
const tasksOf = (id: string) => { const keys = new Set<string>(), seen = new Set<string>(), todo = [id];
  while (todo.length) { const c = todo.pop()!; if (seen.has(c)) continue; seen.add(c); for (const k of taskKeys.get(c) ?? []) keys.add(k);
    const row = ruleBy.get(c);   // merge, split and version links are rewritten in place: keep only those made by T
    todo.push(...(kids.get(c) ?? []), ...(row?.mergedFrom ?? []).filter((m: string) => upTo(ruleBy.get(m)?.mergedAt ?? ruleBy.get(m)?.changedAt ?? "9999")),
      ...(row?.splitFrom && upTo(row.createdAt) ? [row.splitFrom] : []), ...(versions.get(c) ?? []).filter(v => upTo(v.changedAt)).map(v => v.id)); }
  return keys.size; };
const tc = active.map(tasksOf); console.log({ tasksAtLeast2: tc.filter(n => n >= 2).length, exactly2: tc.filter(n => n === 2).length, atLeast3: tc.filter(n => n >= 3).length });

console.log("== 3.2 role blocks at the cutoff (bytes of '- [id] text' lines joined by newline)");
for (const role of ["builder", "orchestrator", "architect", "prod-auditor", "visual-critic", "maintainer", "merger"]) { const b = block(projA, role, T); console.log(role, b.length, bytes(b, T)); }

console.log("== 3.2 outcomes and saturation");
const since = ms("2026-10-10T00:00:00Z");
const first: Record<string, [string, boolean]> = {};                 // the first review of each builder lane
for (const p of pipelines) { const all = attemptsOf(p); if (!all.some((a: any) => a.role === "builder")) continue;
  const rev = all.filter((a: any) => a.role === "reviewer" && a.verdict?.status && a.startedAt && upTo(a.startedAt) && ms(a.startedAt) >= since).sort((a: any, b: any) => ms(a.startedAt) - ms(b.startedAt))[0];
  if (rev && all.some((a: any) => a.role === "builder" && a.completedAt && ms(a.completedAt) <= ms(rev.startedAt))) first[p.id] = [rev.startedAt, rev.verdict.status === "fail"]; }
for (const [name, ids] of [["project A", Object.keys(first).filter(id => pipeBy.get(id).project === projA)], ["other", Object.keys(first).filter(id => pipeBy.get(id).project !== projA)]] as const)
  show(`first review failed, ${name}:`, byRegime(ids as string[], id => first[id][0], id => first[id][1]));
let n = 0, uk = 0, tagged = 0, saturated = 0, ukUntaggedAscii = 0, ukUntagged = 0;
const ascii = Object.values(CLASSES).map(re => new RegExp("\\b(?:" + re.source.replace(/^\(\?<!\[\\p\{L\}\\p\{N\}\]\)\(\?:/, "").replace(/\)$/, "").split("|").filter(t => /^[a-z.]+$/.test(t)).join("|") + ")", "i"));
for (const p of pipelines) { const all = attemptsOf(p);
  for (const a of all) { if (a.role !== "reviewer" || !a.completedAt || !upTo(a.completedAt) || ms(a.completedAt) < since || !(a.verdict?.findings ?? []).length) continue;
    const judged = all.filter((x: any) => x.role === "builder" && x.completedAt && ms(x.completedAt) <= ms(a.startedAt)).sort((x: any, y: any) => ms(y.completedAt) - ms(x.completedAt))[0];
    if (!judged) continue;
    const t0 = ms(judged.startedAt), delivered = judged.gate ? [] : block(p.project, "builder", t0);
    const have = new Set(delivered.flatMap(d => classesOf(textAt(d.id, t0))));
    for (const f of a.verdict.findings) { const text = typeof f === "string" ? f : f.text; n++;
      const isUk = /[іїєґ]/i.test(text), c = classesOf(text); if (isUk) { uk++; if (!c.length) ukUntagged++; if (!ascii.some(re => re.test(text))) ukUntaggedAscii++; }
      if (c.length) { tagged++; if (c.some(k => have.has(k))) saturated++; } } } }
const passEnd = ms("2026-10-16T10:21:26Z");   // the post-variant-4 curator pass for project A ended (section 3.3, case 13)
const lanesSince = new Set<string>(), reviewedSince = new Set<string>();
for (const p of pipelines.filter((p: any) => p.project === projA)) { const all = attemptsOf(p);
  if (all.some((a: any) => a.role === "builder" && a.startedAt && ms(a.startedAt) >= passEnd && upTo(a.startedAt))) lanesSince.add(p.id);
  if (all.some((a: any) => a.role === "reviewer" && a.verdict?.status && ms(a.startedAt) >= passEnd && upTo(a.startedAt))) reviewedSince.add(p.id); }
console.log({ lanesWithABuilderAttemptSincePass: lanesSince.size, lanesReviewedSincePass: reviewedSince.size });
console.log({ findings: n, ukrainian: uk, tagged, saturated, ukUntaggedUnicode: ukUntagged, ukUntaggedAsciiEnglishOnly: ukUntaggedAscii });

console.log("== 3.3 delivered blocks of the traced attempts");
for (const [name, project, role, at] of JSON.parse(process.env.TRACES ?? "[]") as [string, string, string, string][]) {
  const b = block(project, role, ms(at)); const n = (f: (s: string) => boolean) => b.filter(x => f(x.scope)).length;
  console.log(name, b.length, `${n(s => s.startsWith("role:") && !s.includes(":*:"))}/${n(s => s.includes(":*:"))}/${n(s => s.startsWith("project"))}/${n(s => s === "machine")}`, bytes(b, ms(at)), digest(b), contentDigest(b, ms(at))); }
console.log("== 4.4 history window of the busiest scope");
const busiest = scopes.map((s: any) => [s.scope, s.history.filter((h: any) => upTo(h.at))] as const).sort((a, b) => b[1].length - a[1].length)[0];
console.log({ entries: busiest[1].length, passEntries: busiest[1].filter((h: any) => h.pass).length, firstEntry: busiest[1][0].at });

console.log("== 4.1 replay candidates (a first review failed and the fix round wrote or rewrote a rule)");
const items: { id: string; stratum: string }[] = []; let failedFirst = 0, wrote = 0;
const firstNonPass = new Map<string, number>(scopes.map((s: any) => [s.scope, Math.min(Infinity, ...s.history.filter((h: any) => !h.pass).map((h: any) => ms(h.at)))]));
for (const p of pipelines) { const all = attemptsOf(p);
  const b1 = all.filter((a: any) => a.role === "builder" && !a.gate && a.startedAt && ms(a.startedAt) >= since).sort((x: any, y: any) => ms(x.startedAt) - ms(y.startedAt))[0]; if (!b1) continue;
  const rev = all.filter((a: any) => a.role === "reviewer" && a.verdict?.status && a.startedAt && ms(a.startedAt) >= ms(b1.completedAt ?? "9999")).sort((x: any, y: any) => ms(x.startedAt) - ms(y.startedAt))[0];
  if (!rev || rev.verdict.status !== "fail" || ms(rev.startedAt) > T) continue; failedFirst++;
  const fix = all.find((a: any) => a.activatedBy?.edge === "fail" && a.role === "builder");
  const rq = fix && requests.find((r: any) => r.pipelineId === p.id && r.stageId === fix.stage && r.attempt === fix.n && upTo(r.at));
  if (!rq || !(rq.ruleIds.length || rq.rewrote)) continue; wrote++;
  let base = false; try { execFileSync("git", ["-C", p.repoDir, "cat-file", "-e", `${p.baseRef}^{commit}`], { stdio: "ignore" }); base = true; } catch {}
  const recoverable = base && !!b1.definition?.prompt && !!p.spec && !!b1.effectiveRole?.promptScaffold && ms(b1.startedAt) >= (firstNonPass.get(`role:${p.project}:builder`) ?? 0);
  if (!recoverable) continue;
  const c = rev.verdict.findings.flatMap((f: any) => classesOf(typeof f === "string" ? f : f.text));
  items.push({ id: p.id, stratum: c.includes("rendered") ? "rendered-state" : c.includes("seam") || c.includes("contract") ? "contract-or-seam" : "evidence-or-claim" }); }
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const quota: Record<string, number> = { "rendered-state": 4, "contract-or-seam": 3, "evidence-or-claim": 3 };
const pilot = Object.keys(quota).flatMap(k => items.filter(i => i.stratum === k).sort((a, b) => sha(a.id).localeCompare(sha(b.id))).slice(0, quota[k]));
console.log({ failedFirst, wroteOrRewrote: wrote, recoverableInputs: items.length, strata: items.reduce((a: any, i) => (a[i.stratum] = (a[i.stratum] ?? 0) + 1, a), {}),
  pilotManifestDigest: sha(pilot.map(i => i.id).sort().join("\n")).slice(0, 12), pilotSize: pilot.length });
fs.writeFileSync(`${dir}/pilot-manifest.json`, JSON.stringify(pilot));   // keep these files outside any checkout
fs.writeFileSync(`${dir}/replay-candidates.json`, JSON.stringify(items));

console.log("== 4.2 write precision, findings never handed to a fix round, rendered-work block");
const r2 = rules.filter((r: any) => upTo(r.createdAt) && r.source.fixRound && !r.splitFrom && !r.versionOf && regime(r.createdAt) === "R2");
console.log({ r2FixRules: r2.length, lostToTaskSpecificStaleOrProblem: r2.filter((r: any) => upTo(r.changedAt) && ["task-specific", "stale", "problem"].includes(r.reason)).length });
const total: Record<string, number> = {}, unhanded: Record<string, number> = {};
for (const p of pipelines) { const all = attemptsOf(p);
  for (const a of all) { if (!a.completedAt || !upTo(a.completedAt) || ms(a.completedAt) < B2 || a.verdict?.status !== "fail" || !(a.verdict.findings ?? []).length) continue;
    const handed = all.some((b: any) => b.activatedBy?.stageId === a.stage && b.activatedBy?.attempt === a.n && b.activatedBy?.edge === "fail");
    total[a.role] = (total[a.role] ?? 0) + a.verdict.findings.length; if (!handed) unhanded[a.role] = (unhanded[a.role] ?? 0) + a.verdict.findings.length; } }
console.log({ findingsByRole: total, neverHandedToAFixRound: unhanded });
let afterV4 = 0, withBlock = 0;
for (const p of pipelines) for (const a of attemptsOf(p)) if (a.role === "builder" && a.startedAt && ms(a.startedAt) >= B3 && upTo(a.startedAt)) { afterV4++; if ((a.effectiveRole?.promptScaffold ?? "").includes("Rendered work (when the work changes what a person sees)")) withBlock++; }
console.log({ builderAttemptsSinceVariant4: afterV4, withRenderedWorkBlock: withBlock });
```

**Pilot validation (4.1).** Run after the analysis script, on the same
directory, with `REPO` set to a checkout of the commit under analysis. It
renders each candidate's first message with the engine's own function and
applies the checks of 4.1.

```ts
// bun validate-pilot.ts <dir with the exports and replay-candidates.json>; REPO is a checkout of the commit under analysis.
// Offline: no model call. Run with HOME, XDG_CONFIG_HOME and LLV_STATE_DIR pointing at scratch directories.
// Writes the complete rendered first messages to <dir>/bundle/ (private: they hold briefs and specifications).
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const dir = process.argv[2];
const { renderStagePrompt } = await import(`${process.env.REPO}/src/lib/pipelines/prompts.ts`);
const load = (n: string) => JSON.parse(fs.readFileSync(`${dir}/${n}.json`, "utf8"));
const pipes = new Map<string, any>([...load("pipelines_archive"), ...load("pipelines")].map((p: any) => [p.id, p]));
const candidates = load("replay-candidates") as { id: string; stratum: string }[];
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const quota: Record<string, number> = { "rendered-state": 4, "contract-or-seam": 3, "evidence-or-claim": 3 };
const LIVE_REF = /https?:\/\/\S+|(?:pull request|PR|issue)s? #\d+|gh (?:pr|issue) \w+/i;
const INLINE_LIMIT = 32_000;
function check(id: string) {
  const p = pipes.get(id);
  const attempts = p.runs.flatMap((r: any) => r.attempts.map((a: any) => ({ stage: r.stageId, ...a })));
  const stageOf = (sid: string) => p.stages.find((s: any) => s.id === sid);
  const b1 = attempts.filter((a: any) => a.effectiveRole?.roleId === "builder" && !stageOf(a.stage)?.onFail).sort((x: any, y: any) => Date.parse(x.startedAt) - Date.parse(y.startedAt))[0];
  const d = b1.definition, template = String(d.prompt ?? "");
  const bound = { ...stageOf(b1.stage), prompt: template, ...(d.role ? { role: d.role } : {}), ...(d.sandbox ? { sandbox: d.sandbox } : {}), ...(d.outputs ? { outputs: d.outputs } : {}), effectiveRole: b1.effectiveRole };
  const input = b1.input ?? "";
  const rendered: string = renderStagePrompt(p, bound, b1.effectiveRole, input, 30, "frozen test guidance");
  let baseOk = false; try { execFileSync("git", ["-C", p.repoDir, "cat-file", "-e", `${p.baseRef}^{commit}`], { stdio: "ignore" }); baseOk = true; } catch {}
  const reasons: string[] = [];
  if (!baseOk) reasons.push("base commit missing");
  if (/\{\{[^}]*\}\}/.test(rendered)) reasons.push("unresolved placeholder");
  if (template.includes("{{prev.output}}") && !input.trim()) reasons.push("relay missing");
  if (LIVE_REF.test(rendered)) reasons.push("live reference");
  return { id, reasons, rendered, bytes: Buffer.byteLength(rendered), relayBytes: Buffer.byteLength(input), spilled: Buffer.byteLength(rendered) > INLINE_LIMIT, digest: sha(rendered).slice(0, 12) };
}
const chosen: ReturnType<typeof check>[] = [], dropped: { id: string; stratum: string; reasons: string[] }[] = [];
for (const [stratum, n] of Object.entries(quota)) {
  const ordered = candidates.filter(c => c.stratum === stratum).sort((a, b) => sha(a.id).localeCompare(sha(b.id)));
  let kept = 0;
  for (const c of ordered) { if (kept === n) break; const r = check(c.id); if (r.reasons.length) { dropped.push({ id: c.id.slice(0, 8), stratum, reasons: r.reasons }); continue; } chosen.push(r); kept++; }
}
fs.mkdirSync(`${dir}/bundle`, { recursive: true });
for (const r of chosen) fs.writeFileSync(`${dir}/bundle/${r.id.slice(0, 8)}.message.txt`, r.rendered);
console.log(JSON.stringify({ eligible: chosen.length, dropped, manifestDigest: sha(chosen.map(r => r.id).sort().join("\n")).slice(0, 12),
  items: chosen.map(r => ({ id: r.id.slice(0, 8), bytes: r.bytes, relayBytes: r.relayBytes, exceedsInlineLimit: r.spilled, messageDigest: r.digest })) }, null, 1));
// the same check over every recoverable candidate
const tally: Record<string, number> = {}, passing: Record<string, number> = {}; let ok = 0;
for (const c of candidates) { const rs = check(c.id).reasons; for (const r of rs) tally[r] = (tally[r] ?? 0) + 1; if (!rs.length) { ok++; passing[c.stratum] = (passing[c.stratum] ?? 0) + 1; } }
console.log(JSON.stringify({ candidates: candidates.length, passing: ok, passingByStratum: passing, failures: tally }));
```

**Expected output** (lines of the script's output, cutoff `T`):

| Section | Output |
| --- | --- |
| Store totals | 1,731 rule rows, 228 active, 864 version rows, 1,339 requests (616 lesson, 145 rewrite, 554 none, 22 problem, 2 open), 566 fix-round requests, 697 curator rewrite entries, 69 passes (64 succeeded, 4 failed, 1 launching at `T`); drift guard 0 |
| Fix-round requests that wrote or rewrote | R0 82/83, R1 103/194, R2 201/206, R3 82/83 |
| Fix-round rules archived as task-specific | R0 124/152, R1 39/80, R2 39/135, R3 2/47; for budget R3 14/47 |
| First-pass requests answered none | 773 requests not activated by a fail edge, 113 of them after a finished review; first-pass R0 5/99, R1 143/215, R2 164/264, R3 67/82; "covered" claims 5, 141, 150, 58 |
| Next review failed after a first-pass "covered" answer | R1 49/103, R2 65/112, R3 32/40 (R0 1/4) |
| Retention | Median life from creation to archive: 350 rules archived as task-specific 47.8 h, 90 as in-instructions 48.1 h. Budget archives: 25 in all (median 0.45 h, p90 3.6 h), 20 never curated (median 0.33 h, p90 1.2 h), 5 curated before eviction (median 3.6 h) |
| Shape of active rules | 136 rewritten at least once, 11 compressed at first writing, 73 now, 77 of all 228; slashes per hundred characters 0.12 at first writing, 0.93 now (pooled over those 136 rules); mean length 242 then 233 code points (239 over all 228 active); 13 at the 300-point cap; 37 with six or more versions; 49 with two or more tasks (30 with exactly two) |
| Role blocks, project A | builder 73 rules 17,469 B; seat 46, 10,936 B; architect 43, 10,122 B; prod-auditor 33, 7,277 B; visual critic 24, 5,181 B; maintainer and merger 23, 4,897 B |
| First review failed, project A | R0 38/71, R1 40/78, R2 58/98, R3 19/23; other projects R0 4/4, R1 21/42, R2 26/56, R3 17/25 |
| Lanes since the post-variant-4 pass | 12 lanes of project A started a builder attempt after 2026-10-16 10:21:26 UTC; 2 had a reviewer verdict by `T` |
| Findings | 811 reviewer findings on builder lanes since 2026-10-10 (351 Ukrainian); 724 tagged; 702 of them in a class the builder's block also held; 32 Ukrainian findings untagged by the Unicode classifier, 131 by an ASCII, English-only pass |
| Delivered blocks | see the digest column of the trace table in 3.3 |
| History of the busiest scope | 440 entries, 25 of them curator passes, first entry 2026-10-10 |
| Replay candidates | 210 builder lanes whose first review failed; 144 whose fix round wrote or rewrote a rule; 136 with all five inputs present (32 rendered-state, 78 contract-or-seam, 26 evidence-or-claim); first draw of 10, digest `3c6e4d3937fb` |
| Pilot validation | 74 of 136 pass (17 rendered-state, 42 contract-or-seam, 15 evidence-or-claim); the 62 failures are all live references; 3 of the first ten replaced; 10 eligible, manifest digest `a330fd597223` |
| Write precision, R2 | 135 fix-round rules, 40 lost to task-specific, stale or problem, so 95 survive |
| Findings never handed to a fix round | reviewer 1 of 541, visual critic 6 of 240, verifier 8 of 8, prod-auditor 4 of 4 |
| Rendered-work block | 28 of 190 builder attempts since 2026-10-15 14:57 |

**Definitions the script fixes.**

- *Regime* by the request's or attempt's own timestamp: R0 before
  2026-10-11 11:29 UTC, R1 until the first request that carries a task id
  (2026-10-12 23:15:40), R2 until 2026-10-15 14:57, R3 after.
- *Fix-round request*: the stage attempt it answers was activated by a `fail`
  edge. A request that was not activated by a fail edge also includes later
  retries and stages with fix-like names. *First pass* is a request not
  activated by a fail edge whose lane had no reviewer attempt with a verdict
  finished when the attempt started.
- *Original fix-round rules* (the cohorts 152, 80, 135, 47): rules whose source
  is a fix round, excluding `splitFrom` descendants and version rows
  (`versionOf`).
- *"Covered" answer*: the `none` line matches
  `cover|already|existing|наявн|чинн|вже|охоплю|покрив|достатн`
  (case-insensitive, Unicode). It is a keyword claim; 1 to 20 % of `none`
  lines match no pattern and are not counted as covered.
- *Next review* of a self-assessment: the earliest reviewer attempt with a
  verdict that started after the builder attempt completed.
- *Judged builder attempt* of a review: the latest builder attempt completed
  before the review started. *First review of a lane*: the earliest reviewer
  attempt with a verdict, among attempts starting since 2026-10-10.
- *Finding classes*: the six regular expressions in the script; a term matches
  at the start of a word (no letter or digit before it) and may continue as a
  stem. The Ukrainian stems are written out in the script.
- *Saturation*: a finding is saturated when the judged builder attempt's
  reconstructed block held a rule whose text at that time falls in one of the
  finding's classes. A gated builder stage receives nothing.
- *Never-curated budget archive*: `kind = rule`, no `versionOf`,
  `reason = budget`, `changedAt <= T`, and no `curatedAt` earlier than
  `changedAt`. The script prints both populations.
- *Replay candidates*: the lane's first builder attempt outside a gate, its
  first following review failed, and the first fail-edge builder attempt
  answered with a lesson or a rewrite. *Inputs present* means the base commit
  resolves in the repository's object store, the brief, the pinned
  specification and the rendered scaffold are stored on the pipeline record,
  and the attempt started at or after the scope's first retained non-pass
  history entry. Stratum by the first review's finding classes: any
  `rendered`, else any `seam` or `contract`, else the rest. The first draw
  takes the lowest SHA-256 of the pipeline id in each stratum (4, 3, 3). The
  pilot takes the same draw among the candidates that pass the validation
  pass (4.1), in the same order.
- *Bytes* of a block: UTF-8 bytes of the `- [id] text` lines of all four
  scopes joined by newlines (header, notices and pointers excluded).
