# Memory quality: what agents write, what reaches them, what changes, and a benchmark to measure it

Status: analysis and design, no product change. Written 2026-10-16 against
`main` at `02f9301fc`; every `file:line` is from that commit. Live records
were read once, read-only, at 2026-10-16 12:28 UTC (section 3.1 says how).
Projects other than this repository are named by letter and kind, as in
`docs/design/role-memory-to-prompts.md`: A is this repository, B an ERP
customization on a shared stand, C a bot and web-app product, D a dispatching
web application. Learned rules are named by id and described in other words;
no rule text is quoted, because rule texts stay on this machine.

## Originating requirement

Operator, 2026-10-16 about 12:14 UTC, by voice, in Russian, in a call with
Voice Delegatus. The operator's own words, from the call record (the account
the operator named is redacted):

> А мы можем как-то запустить агента... вот можно было бы... какого-нибудь я
> не знаю опуса на [аккаунте] для того чтобы он проанализировал знаешь что? Я
> бы хотел, чтобы он проанализировал то, как сейчас память записывается, какие
> фрагменты памяти записываются. Насколько оно правильно... ну, правильные
> факты записываются агентами. Насколько вот, то есть эта цель понять,
> насколько инструкция про запись памяти влияет на то, что они записывают и
> что бы можно было подправить, чтобы отправля... чтобы делать более
> правильную память. То есть нам нужно, я не знаю, что-то вроде бенчмарка для
> памяти, который мы вот убираем. Мы же куратор памяти тоже работает, это всё
> влияет на то, как работал агент. То есть проанализировать, например, промпт,
> который был доставлен, то есть, соответственно, какие фрагменты памяти
> пошли, и условно, какие после этого агент делал ошибки и... То есть я вот не
> знаю... надо как-то придумать, как это анализировать. Но это очень важно,
> чтобы выйти на этот уровень абстракции, чтобы... улучшать как бы учиться,
> как учиться

The voice gateway rendered it as this directive, which the pinned
specification quotes verbatim:

> Разработай и проведи анализ текущей системы записи памяти агентами в
> Delegatus. Нужно понять, насколько точно и полезно записываются факты и
> фрагменты памяти, как инструкции по записи памяти влияют на результат и как
> работа куратора памяти сказывается на поведении агентов. По возможности
> проанализируй связку: какой промпт и какие фрагменты памяти были доставлены
> агенту, что он сделал после этого и какие ошибки допустил. Предложи
> практичный бенчмарк для оценки качества памяти и план улучшений,
> позволяющий измерять, помогает ли корректировка инструкций и куратора
> агентам учиться эффективнее. Ожидаемый результат — понятная методика оценки
> с критериями и примером анализа, а также конкретные выводы о том, что
> следует улучшить в записи, отборе и использовании памяти.

Where the rendering differs from the words: it adds "usefulness", "selection
and use" and a written plan; the operator asked for correctness of what is
written, the effect of the write instruction, the curator's effect, the
prompt-to-error trace, "something like a benchmark", and a way to learn how
to learn. This design covers both. It also drops the engine and account the
operator named for the analysis; that was a staffing choice for the seat and
changes nothing in the method. The default answer to "should we build this"
is no: the requirement asks for an analysis and a method, so this document
builds no product code and proposes changes only where the data shows a
defect, each with the metric that would prove it.

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
| Curator | A scheduled curator conversation calls `curate_rules` read and apply (`src/lib/mcp/server.ts:3400`, guard `src/lib/memory/curation/guard.ts:12-34`, apply `curation/apply.ts:51`); brief and checklist in `curation/brief.ts:1-16`; due at 10 new lessons or 6 hours (`roleTypes.ts:12-13`, `curation/store.ts:113`) | Every active rule accounted for; operator-kept rules stay | 69 passes since 2026-10-12 23:08 UTC (64 succeeded, 4 failed, 1 launching); 697 curator rewrites |
| Retention on write | `appendRule` and `retainRules` (`roleConsolidate.ts:59-100`): a word-for-word repeat merges; over 10 000 code points (`roleTypes.ts:11`) the head of the leaving order goes, never-curated rules first (`roleConsolidate.ts:50-56`) | No model; nothing deleted | 25 rules archived for budget |
| Operator | The rules window: remove, return, revert (`src/app/api/role-memory/route.ts`) | Operator authority | 3 history entries |
| History and egress | Versions as archived rows (`roleStore.ts:230-249`); scope history capped at the last 500 non-pass entries (`roleStore.ts:37-43`); every stored text is a known value for the publication gate and the relays (`roleStore.ts:541-745`) | Fails closed | 864 version rows; the busiest scope holds 440 history entries |

Store totals: 1,731 rule rows (228 active, 136 merged, 1,367 archived, of
which 864 are earlier versions and 350 were archived by the curator as
task-specific), 1,339 request rows, 102 scope rows.

### 1.2 Learned rules: selection and delivery

| Reader | Selection | Delivery | What the agent sees |
| --- | --- | --- | --- |
| Pipeline stage of a non-clean role | Text-free selector set by the engine (`roleStage.ts:30-33`; `src/lib/pipelines/engine.ts:739`, `:6239`, `:6781`); a stage is clean when its role is reviewer, verifier, issue-reporter or curator, or it carries a fail edge (`src/lib/memory/eligibility.ts:11-27`) | Rendered from SQLite at every engine start (`src/lib/memory/roleLaunch.ts:33-42`): Claude `--append-system-prompt` (`src/lib/runtime/structuredSpawn.ts:1949`, `claudeStreamBrokerHost.ts:923`), Codex `developerInstructions` (`structuredSpawn.ts:2020`, `codexAppServerHost.ts:1620-1626`); also on adoption (`startup.ts:1907`, `:2309`) and account migration (`accounts/migration/provider.ts:376`, `:512`) | Every active rule of four scopes, whole, best-ranked first (`roleStore.ts:109-111`, `:180-192`): role here, role everywhere, project, machine. A header with counts, a notice, then one line per rule with its id (`roleRender.ts:47-58`). No relevance selection. |
| Orchestrator seat, board maintainer | Selector set at spawn by role (`src/lib/agent/registry.ts:6257-6275`) | Same channels | Same four scopes with a seat or maintainer notice (`roleRender.ts:14-16`) |
| Reviewer, verifier, issue-reporter, curator, any gated stage | None; the launch is marked clean, which also turns off engine memory (`src/lib/agent/spawnPolicy.ts:531-534`, `codexAppServerHost.ts:1489-1490`) and the shared-memory hook (`src/lib/memory/controller.ts:52`) | n/a | Nothing |
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
| `search_memory` on demand | None: a derived index over engine memories, instructions and skills (`memory-index.sqlite`; `src/lib/memory/index.ts`) | The agent queries; opening a hit records `opened` (`src/lib/mcp/server.ts:3413`) | 1,869 opened hits since 2026-10-02. Index: 6,099 Codex references, 759 Claude references, 355 preferences, 333 skills, 293 project facts |
| Injection into operator turns | Same index | `UserPromptSubmit` hook (`spawnPolicy.ts:490`, `codexAppServerHost.ts:1466`) → `offerForHook` (`controller.ts:22-193`): operator-originated turns only, launch briefs and agent deliveries skipped (`:86-95`), clean conversations skipped (`:52`), per-project switch and a judged selection (`injection.ts:25`) | October: 348 judged turns, 323 with no match, 178 with no candidate, 683 skipped, 13 failed. 23 items injected ever, into 13 conversations; 2 opened, 0 cited (`memory_offers`, `index.ts:142`, `:845`) |

Pipeline stages receive nothing by injection: their turns are machine
deliveries. In practice this path reaches seats only, and rarely.

### 1.4 Engine-side file memory

| Engine | Written by | Who loads it | Observed |
| --- | --- | --- | --- |
| Claude auto memory, per repository (`agent-memory.md` §1.2) | The Claude seat of this repository, on its own judgement or on request | Every non-clean Claude conversation of this repository, pipeline worktrees included, that runs under the account home holding the notes loads the `MEMORY.md` index (first 200 lines or 25 KB); one of the two Claude account homes here holds memory directories. Turned off only for clean launches (`spawnPolicy.ts:531-534`) | Index 8,620 bytes, 50 topic files (31 feedback, 11 reference, 8 project) plus an imported subtree. This stage received the index in its own context: seat-only directives (deploying, cutting releases, the worker cap) arrive in a read-only architect stage |
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
| 2 | Usefulness | Delivered item × attempt. Did the item change what the agent did? | Counterfactual replay with and without the item (section 4.1); the attempt cites the id | Behaviour signature in the diff or transcript, scored only when the brief, the pinned specification and the role prompt did not already ask for it | Replay; transcripts; briefs |
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
Second, compliance is not proof of value: an item the brief already demanded
scores zero usefulness however faithfully it was followed (case 8 below).

## 3. Worked example on real data

### 3.1 Data and method

- **Snapshot.** One read-only open of the live `state.sqlite` with
  `bun:sqlite` `readonly`, exporting the `role_memory`,
  `role_memory_curation`, `pipelines` and `pipelines_archive` rows to the
  stage's scratch directory at 2026-10-16 12:28:42 UTC (the read took 443 ms).
  The same for `memory-index.sqlite` (counts only) and
  `board_maintenance_runs`. Nothing was written. `curate_rules` read was
  refused to this stage (`CURATE_CALLER`: only the live curator may call it,
  `guard.ts:13-34`), so the store was read through the snapshot.
- **Transcripts.** `conversation_messages` for each case's stages,
  `search_transcripts` for rule-id citations and for the requirement.
- **What each attempt received.** Nothing records the rule ids delivered to
  an attempt (section 4.4). They were reconstructed from the scope histories:
  start from each scope's current active list and walk its history backwards
  to the attempt's start, replacing the list with `before` at a curator entry
  and undoing `added` and `archived` at an agent entry; a rule's text at that
  time is the earliest version row changed after it. Check: the reconstruction
  for this stage's own start gives 10, 10, 7 and 16 rules with the same first
  ids, in the same order, as the block this stage received.
- **Regimes.** The lesson request changed three times. Boundaries are dated
  from the records themselves (deploy records for these days are incomplete):
  R0, the first wording, to 2026-10-11 11:29 UTC (first rewrite 11:39);
  R1, "most stages do neither", to 2026-10-12 23:15 (first request carrying
  a task id, the marker of the fix-round wording; the first curator pass ran
  at 23:08); R2, fix-round wording, problem reports and the curator, to
  2026-10-15 14:57 (variant 4 role prompts installed, which moved the universal
  memory classes into the shipped prompts); R3 after that.
- **Finding classes.** A keyword pass with Unicode-aware boundaries in English
  and Ukrainian (appendix). It tags 711 of 799 reviewer findings on builder
  lanes since 2026-10-10; 352 of the 799 are written in Ukrainian.

### 3.2 What the store-level numbers show

**Lesson answers by wording (observation).** Fix-round answers that wrote or
rewrote a rule, with 95 % Wilson intervals:

| Regime | Fix-round requests | Wrote or rewrote | Fix-round rules later archived as task-specific |
| --- | ---: | --- | --- |
| R0 | 83 | 82 (99 %, 93–100) | 124 of 152 (82 %, 75–87) |
| R1 | 194 | 103 (53 %, 46–60) | 39 of 80 (49 %, 38–60) |
| R2 | 206 | 201 (98 %, 94–99) | 39 of 135 (29 %, 22–37) |
| R3 | 83 | 82 (99 %, 93–100) | 2 of 47 so far; 14 of 47 evicted for budget |

First attempts answered `none` in 8 % (R0), 69 % (R1), 65 % (R2) and 82 % (R3)
of requests; the reason given is almost always that existing rules already
cover the work (R2: 181 of 203; R3: 69 of 80).

**Self-assessment (observation).** A builder's first attempt answers its
request before any review. Of first attempts that answered "existing rules
cover it" and were reviewed, the next review failed in 52 of 110 (47 %,
38–57) in R1, 66 of 112 (59 %, 50–68) in R2 and 33 of 41 (80 %, 66–90) in
R3.

**Retention (observation).** Rules written by agents reach the curator
within about two days (median life of a rule archived as task-specific: 47.8
hours; as in-instructions: 52.2 hours). Rules archived for budget lived a
median 0.4 hours (p90 3.6 hours), 25 of them, all in the builder scope of
project A, 20 archived on 2026-10-15 and 5 on 2026-10-16: with the scope
at its bound and curated rules at the protected end, each new lesson pushed out the previous uncurated one
(`roleConsolidate.ts:50-72`). One such append is visible in case 2.

**Recurrence (observation).** 49 of 228 active rules carry work from two or
more tasks (30 from two, 19 from three or more); `lessons-from-review-findings.md`
counted 4 such rules on 2026-10-12.

**Curator rewrites (observation).** Of 136 active rules rewritten at least
once, 11 (8 %) had a compressed form at first writing (three or more slashes
or two or more semicolons) and 73 (54 %) have it now; slashes per hundred
characters rose from 0.12 to 0.93, while mean length stayed near 240 code
points against a 300 cap (39 rules sit at the cap). 37 active rules have six
or more earlier versions; one machine rule has had 14 texts in four days.

**Delivered bytes around curator passes (observation),** builder in project A:

| Time (UTC) | Rules | Bytes |
| --- | ---: | ---: |
| 2026-10-12 23:56, before the first pass for A | 107 | 28,885 |
| 2026-10-13 00:25, after it | 64 | 14,847 |
| 2026-10-15 14:56, variant 4 prompts installed | 103 | 24,763 |
| 2026-10-16 09:59, before the post-variant-4 pass | 97 | 23,844 |
| 2026-10-16 10:25, after it (77 rules archived as already in the prompts) | 67 | 15,820 |
| 2026-10-16 12:28, snapshot | 73 | 17,469 |

The curator's own target is 16,000 bytes for a role's four scopes
(`curation/brief.ts:7`); the builder in project A exceeded it for most of R2
and R3.

**Outcomes (context only; no change is credited on them).** First review of
builder lanes failed in project A: R0 29 of 61 (48 %, 36–60), R1 22 of 55 (40 %, 28–53), R2 37 of
65 (57 %, 45–68), R3 9 of 12 (75 %, 47–91); in the other projects 49 %, 53 %
and 53 %. Task mix, models and the reviewer's own prompt (variant 4 gave it
more judging blocks) changed with the regimes. These numbers show no
detectable improvement and could not show one if it existed.

**Saturation (observation).** For 682 of the 711 tagged findings (95.9 %),
the builder whose work was reviewed had received at least one rule of the
same class. Keyword classes are too coarse to separate "delivered and
ignored" from "absent": a builder receives 60 to 100 rules and some rule
always mentions tests, states or restarts. Attribution needs the judged
labels of criterion 7.

### 3.3 Cases

Fifteen cases from 2026-10-15 and 2026-10-16, covering every role the
specification names. Delivered counts are role here / role everywhere /
project / machine.

**Case 1. Builder, first attempt, project A, 2026-10-16 09:27, UI theme change.**
The stage ran on a builder scaffold carrying the rendered-work block.
Delivered: 97 rules (36/41/5/15, about 24 KB). Two bore directly on the defect class:
`r_90146d0a76745b43` (which stylesheet rule wins, checked by computed style
in a built page) and `r_77fc7abe32501e22` (states of prototype controls, hover and
disabled among them). Done: implemented the theme rules and answered `none`, saying it followed
the existing interface and evidence rules. Errors: the
first review returned three P2 findings, each a state colour lost to a
broader theme rule that wins on precedence. Explanation: delivered and not
followed; the self-assessment was wrong. The first rule's text at that time
was its fifth version, compressed by the curator and merged with an unrelated
class about unlocking controls.

**Case 2. Fix round 1 and 2, same lane, 09:50 and 10:09.** The request quoted
the three findings. Done: fixed them and wrote a new lesson,
`r_04f612d544543a78`, for the same class as `r_90146d0a76745b43`, narrower
(theme overrides of shared classes, listing states). The append brought the
scope to 9,885 characters and archived another uncurated lesson,
`r_5feb7b7ab235de28`, for budget. The second review found the same class
again: a disabled control lost its dimming on hover, because the disabled mark
was an attribute the hover guard did not check. Fix round 2 rewrote
`r_04f612d544543a78` to name that state. Explanation: the new rule was too
narrow for its own lane; a rewrite of the delivered rule would have kept one
rule per class. The visual critique after round 2 passed.

**Case 3. Reviewer, same lane, two rounds.** Clean: no learned rules, no
engine memory. Its scaffold carries the rendered-work judging block. It reported
each instance with file, line and the specificity that decided it. The
reviewer is where this class is caught; nothing in memory reaches it, and
nothing measures whether the builder rules reduce what it finds.

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

**Case 6. Architect and verifier, project A, 2026-10-15, feasibility research.**
Architect on Codex. Delivered: 58 rules (23/19/0/16) plus the Codex summary.
It answered `none`: existing rules already require keeping CI evidence apart
from assumptions. The verifier then found two P3 statements that called a CI
run final-head evidence for a head the run had not tested. No delivered rule
names the class (a CI run proves only the head it ran on), and the verify
stage has no fail edge, so its findings were handed to no fix round and no
lesson request. Explanation: absent item, and no write path from this
finding to memory.

**Case 7. Verifier, project B, 2026-10-15, integration test on the stand.** The
builder's third attempt answered `none`. The verifier found one P1 (an
ordinary role could read a credential and modify scripts run with elevated
rights) and five P2. Since 2026-10-12 23:15, 8 verifier findings and 4
prod-auditor findings were never handed to a fix round, against 1 of 541
reviewer findings and 6 of 240 visual-critic findings. Explanation: the gap
is real and small in volume.

**Case 8. Prod-auditor, project A, 2026-10-16 07:58, pause audit after a deploy.**
Delivered: 38 rules (10/8/5/15). `r_6aea5f42f89e67c3` prescribes the exact
method the audit used (a 30–60 minute journal window, the named incident
classes, the live agent count, like-for-like windows), and the audit followed
it. The brief itself named the window and the like-for-like comparison.
Explanation: compliant, with zero measurable marginal value; this is why
usefulness (criterion 2) requires the counterfactual. The audit's `fail` was
its verdict on the product, and the agent made no error.

**Case 9. Merger, project C, 2026-10-16 12:21.** Delivered: 17 rules (0/0/1/16).
Judged relevant to merging: 3 of 17 (one on reading remerge diffs, one on
stashing a single file, one on publication checks); the project rule restates
the first working rule, and the rest are browser and tool quirks. It merged
with a plain squash because the project names no batch procedure, the default the variant 4 merger prompt
introduced. The seat rule that had taught seats to authorize that in briefs
(`r_6fe87b303f22729a`) was archived as stale on 2026-10-15 16:15.
Explanation: a prompt change made a memory rule obsolete and the curator
noticed within 90 minutes.

**Case 10. Orchestrator seat, project A, 2026-10-16 12:10.** On an operator
request the seat wrote `r_4dccc4825132f0f9` (interface actions show their
result at once and roll back on failure) at project level, then told the
operator that every agent of the project reads it and that reviewers and
visual critics will treat a violation as a finding. Observed: reviewers and
gated critics are clean and never receive it (`eligibility.ts:11-27`);
the maintainer and the merger, which never build an interface, do. Errors: a
level wider than its readers (it belongs to the roles that build or judge
interfaces) and a false statement to the operator about enforcement.
Explanation: the seat's model of who reads memory is wrong, and nothing in
its block says which roles are clean.

**Case 11. Two orchestrator seats, 2026-10-16 11:27–11:41.** After the
operator had an unrequested signature line removed from chat replies in
project C, a seat of this repository wrote `r_1a8d29fbc0bb6a22` (change only
the visible behaviour that was asked for) at this repository's project level
at 11:27. At 11:36 the seat of project C wrote `r_764a5411c68e0370`, the same
class, at project C's level, and at 11:41 a machine rule on placing every rule
at its true scope (`r_674896c8a12c8d0e`). Both project rules restate the first
working rule every stage already receives. Explanation: one class written
twice at two project levels within nine minutes, by seats that cannot see each
other's scopes; by the level test it is either a machine rule or already in
the prompts, and the curator can only find it after the fact.

**Case 12. Board maintainer, project A, runs through 2026-10-16.** Delivered:
23 rules (0/0/7/16): seven about this repository's server internals and
interface, sixteen tool quirks. Judged relevant to board maintenance: 0 of 23.
About 4.9 KB per run, several runs a day per project.

**Case 13. Curator pass, project A, 2026-10-16 10:00–10:21, after variant 4.**
The prompt release came with a list of rules the shipped prompts now state.
The curator checked, rule by rule, that each reader's prompt carries the
principle, kept the rules whose readers lack it, sent one rule to the seat as
a problem, and repaired `r_46e5b2eaa551fac1`, which an agent rewrite at 10:12
had stripped of its trigger. It archived 77 rules as already in the prompts
and stated one assumption: interface work runs in the builder's frontend or
prototype variants, the only ones that receive the rendered-work block
(`src/lib/roles/registry.ts:138`). Measured: 28 of the 191 builder attempts
since variant 4 received that block. The builder block in project A fell from
23.8 KB to 15.8 KB and was back at 17.5 KB two hours later. Explanation: a
careful pass whose one assumption the data does not yet support; criterion 9's
disposition sample would test it.

**Case 14. Curator, first passes, 2026-10-12 23:08 to 2026-10-13 06:34.** The
builder block in project A fell from 107 rules (28.9 KB) to 64 (14.8 KB); the
two passes for A archived 269 rules as task-specific and reviewed 250 rules
archived earlier for budget. Afterwards the larger passes for A rewrote 46
to 104 rules each (six passes between 2026-10-12 23:57 and 2026-10-14 11:03), which is where
the compression in 3.2 comes from. Explanation: the curator removes task
narration well and degrades readability in the rules it keeps.

**Case 15. Architect, this stage, 2026-10-16 12:25.** Delivered: 43 learned
rules (10/10/7/16) and the 8.6 KB engine memory index. Judged relevant: 6
learned rules (`r_10c7007bb5ccc09e`, `r_c41ebf5f9ffb8872`,
`r_b941c97ebc4393ab`, `r_6bc50caa81fca4b8`, `r_674896c8a12c8d0e`,
`r_a7edff278adff2c0`) and one engine memory entry (how to run the privacy gate
by hand); 37 learned rules bear on prototypes, browsers, servers or
deployment. Changed behaviour: `r_10c7007bb5ccc09e` led to reading the voice
call record, which showed the rendering had dropped one of the operator's
constraints; `r_c41ebf5f9ffb8872` led to one read-only snapshot. Error: the
first keyword pass used ASCII word boundaries and English terms, which
`r_b941c97ebc4393ab` warns against; 141 of the 352 Ukrainian findings fell
into the untagged bucket (41 after the pass was redone). Explanation:
delivered, relevant, and followed late. The engine memory index also carried a superseded pair (an
older note puts operator questions in chat, a newer one forbids asking in
chat prose) and directives meant for the seat.

### 3.4 Before and after

1. **Lesson-request wording, R0 → R1 → R2 (whole store).** "Most stages do
   neither" cut fix-round writing from 99 % to 53 %; naming the findings and
   asking for their class brought it back to 98 %, and the share of fix-round
   rules the curator later judged task-specific fell from 82 % (R0) to 29 %
   (R2). The instruction moves both what is written and how general it is.
   The judge is the curator, itself a model; criterion 10's calibration
   sample is what would make this a measurement.
2. **The first curator passes (project A builder block).** 28.9 KB → 14.8 KB
   in one night; rules with two or more tasks behind them went from 4
   (2026-10-12) to 49 (now). Review outcomes cannot show the effect (3.2).
3. **Variant 4 prompts and the in-instructions sweep.** 23.8 KB → 15.8 KB;
   with 12 builder lanes reviewed since in project A, outcomes cannot show an
   effect.
4. **Rule-level, within a lane (cases 2 and 4).** In both, the class recurred
   after its rule entered delivery, and the rule was rewritten to cover the
   new instance. These are the only before/after comparisons whose units match
   (same class, same scope, minutes apart), and they show rules that are
   too narrow when written.

### 3.5 What the analysis supports

Observed:

- The write instruction controls the write rate and, with the curator as
  judge, the generality of what is written (3.4.1).
- The first-attempt request is answered before review, and its typical answer
  ("my rules covered it") is followed by a failed review in 47–80 % of cases.
- In the builder scope of project A, a full scope evicted each new uncurated
  lesson within minutes (25 evictions, median 0.4 hours).
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
  every Claude stage of this repository under the seat's account home, and an
  unrefreshed Codex summary reaches every Codex stage.
- Nothing records which rules an attempt received; reconstruction works only
  while scope history lasts, and the busiest scope keeps the last 500 entries
  and gains 36 to 141 a day.

Inferred:

- In the cases traced, a delivered rule that was ignored or too narrow
  explains more errors (cases 1, 2, 4, 5) than an absent rule (case 6). If the
  judged attribution sample confirms it, more rules will not help, while
  fewer, plainer and better-targeted ones might; the replay benchmark decides.
- Readability likely matters for compliance: the rule case 1 ignored had been
  compressed and merged with an unrelated class.

## 4. A practical benchmark

### 4.1 Offline replay set

Built from fix rounds, where the failure, the delivered rules and the rule
written afterwards are all on record.

- **Item.** A builder first attempt that failed review with a finding of a
  class later written into a rule. Frozen inputs: the base commit, the brief,
  the pinned specification, the role scaffold as rendered, the learned-rule
  block as delivered (reconstructed today, from the ledger of 4.4 later), and
  the engine memory files as they were. Hidden oracle: the finding, its
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
- **Size.** Pilot: 10 items (four rendered-state, three contract or seam,
  three evidence or claim), two projects, conditions M1 and M3, two runs each:
  40 builder runs. Full set: 30 items over three projects and all four
  conditions. Run under the project's worker cap, in scratch exports, never
  against live state.
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

### 4.2 Online metrics from existing records

Computed weekly from the store and the pipeline records, each with n and an
interval. The first seven need only the export in the appendix and the
definitions below; the last three need judging and the ledger of 4.4.

| Metric | Definition | Value now |
| --- | --- | --- |
| Fix-round write rate | lesson or rewrite ÷ fix-round requests | R3: 82 of 83 |
| Write precision | written rules not archived as task-specific, stale, problem or no-reader ÷ written rules, after one curator pass | R2 fix rounds: 95 of 135 |
| None-claim accuracy | first attempts answering "covered" whose next review passed ÷ those reviewed | R3: 8 of 41 |
| Budget evictions of never-curated rules | count and median life | 25, 0.4 hours |
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
   Ids only, so the egress rules are untouched.
2. **History that lasts.** `keepHistory` keeps curator entries and the last
   500 others (`roleStore.ts:37-43`). The builder scope of project A holds 440
   entries after six days; once it passes 500, the agent entries of the first
   days drop and the delivered sets of R0 and R1 can no longer be rebuilt. The
   ledger removes the dependency. This stage's snapshot lived in its scratch
   directory and is gone with it; until the ledger ships, a read-only
   snapshot taken before that scope passes 500 entries (one to two days at
   the observed rate) and kept outside any checkout is the benchmark's frozen
   input for R0 and R1.
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
| 2 | Stop evicting a lesson nobody has curated: while a scope is over its bound, keep never-curated lessons until one curator pass has seen them, and run the pass early when a scope crosses 90 % | `roleConsolidate.ts:59-72`, curation trigger | Budget evictions of never-curated rules: 25 → 0; no scope over its bound after a pass |
| 3 | Move the first-attempt request to where the agent knows something: ask what the stage corrected on its own way, and drop the "covered" answer | `roleRender.ts:91-95` | None-claim accuracy rises above 50 %, or the first-attempt request is retired; write precision of first-attempt rules holds |
| 4 | In a fix round, list the ids of the two or three delivered rules nearest to each handed finding and ask for a rewrite when one names the class | `roleStage.ts:35-42`, `roleRender.ts:72-85` | Share of fix-round lessons later merged into a rule the same attempt had received (needs the ledger) falls; rewrite share rises; replay M3 avoid rate holds |
| 5 | A readability floor for curator rewrites: split before compressing; no slash chains; one class per rule | `curation/brief.ts:7` | Compression index back under 10 %; replay compliance on rewritten rules at least equal to the original texts |
| 6 | Tell seats who reads what: the seat notice names the clean roles and the level test, and a rule meant to be enforced at review goes to the reviewer prompt through the existing promotion step | `roleRender.ts:14-15`; promotion in `role-memory-to-prompts.md` §5.3 | Seat rules archived for level or no-reader fall; findings whose class has a builder rule and no reviewer block, counted per week |
| 7 | Narrow delivery for roles that cannot use it: the maintainer reads its own role scopes and the machine rules marked for every role; merger and deployer the same | `roleStore.ts:109-111` | Judged delivery relevance for maintainer and merger above 50 %, from 0–20 % |
| 8 | Govern engine memory for stages: turn off Claude auto memory and Codex `use_memories` for pipeline stages, keep them for seats, and let the curator read the seat's notes as candidates | `spawnPolicy.ts:531-534`, `codexAppServerHost.ts:1489-1490` | Replay M1 with and without engine memory shows no loss; 8.6 KB (Claude) or 11.3 KB (Codex) less per stage start |
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
3. The replay pilot of 40 builder runs: run after item 1 ships (recommended),
   run now on the snapshot, or skip.

## Validation against the requirement

| Requirement | Where |
| --- | --- |
| How memory is written now, which fragments, how correct | 1.1, 3.2, cases 1, 2, 4, 10, 11, 14 |
| How the write instruction affects what is written | 3.2 wording table, 3.4.1 |
| The curator's effect on agents | 3.2 bytes table, cases 13, 14, 3.4.2–3 |
| Delivered prompt → memory items → actions → errors | 3.1 method, 3.3 cases 1–15 |
| A benchmark for memory | 2, 4.1–4.3 |
| A way to measure whether changes help agents learn | 4.3, 5 (a metric per item) |
| What to improve in writing, selection and use | 5 |
| Read-only, nothing private in the document | 3.1; rules by id, cases by role and date, projects by letter |

## Appendix: the probe

Read-only, with Bun, given the path of the operator's `state.sqlite`. The
export:

```ts
import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { readonly: true });
const rows = (c: string) => (db.query("select value_json v from state_rows where collection=?").all(c) as { v: string }[]).map(r => JSON.parse(r.v));
const memory = rows("role_memory"), passes = rows("role_memory_curation");
const pipelines = [...rows("pipelines_archive"), ...rows("pipelines")];
db.close();
```

What a stage received at time `T` (checked against this stage's own block):

```ts
function activeAt(scopeRow, T) {
  let set = [...scopeRow.active];
  for (const h of [...scopeRow.history].sort((a, b) => b.at.localeCompare(a.at))) {
    if (h.at <= T) break;
    if (h.before) { set = [...h.before]; continue; }          // a curator call
    set = set.filter(id => !(h.added ?? []).includes(id));    // undo an append
    for (const id of h.restored ?? []) set = set.filter(x => x !== id);
    for (const id of h.archived ?? []) if (!set.includes(id)) set.unshift(id);
  }
  return set.reverse();                                        // render order
}
// text at T: the earliest version row of the rule whose changedAt > T, else the rule's text
// readable scopes: role:<P>:<R>, role:*:<R>, project:<P>, machine (roleStore.ts:109-111)
```

Finding classes, with Unicode-aware boundaries (`u` flag; the lookbehind is
`(?<![\p{L}\p{N}])`): rendered states (viewport, width, theme, dark, light,
locale, language, matrix, screenshot, frame, and the Ukrainian stems for
width, theme, dark, light, language, frame, screenshot, phone); contract
(contract, shape, schema, validation, payload, and Ukrainian stems); seam
(restart, stale, identity, race, concurrency, crash, recover, reload, resume,
succession, replay, and Ukrainian stems); tests; privacy; hot path (whole
store, per tick, blocking, synchronous, cache, unbounded, event loop).

A regime is assigned by the request's or attempt's own timestamp against the
boundaries in 3.1. A lesson answer is `problem`, `rewrite`, `lesson` or `none`
in that order of precedence, as in `lessons-from-review-findings.md`'s probe.
A builder lane's first review is the earliest reviewer attempt with a verdict
in the pipeline; the builder attempt a review judged is the latest builder
attempt completed before the review started.
