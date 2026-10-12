# Lessons from review findings: a fix round leaves the rule its role needed, and recurring classes rise

Status: implementation specification, updated with the operator's problem-routing
addition of 2026-10-12 06:00 UTC. Code read at main `a8e005428`. Records read
read-only from the operator's `state.sqlite` at 2026-10-12 05:57 UTC.

## Originating requirement

Operator, 2026-10-12 05:45 UTC (08:45 Kyiv), orchestrator seat chat, by voice,
in Russian, after the night's throughput audit. Verbatim, the part about
defects (the message opens with an unrelated question about stalled agents):

> Второй момент: повтор не выправлен неоральных дефектов. Если ты думаешь, что
> матрица проверок поможет, то это, скорее всего, нужно класть в память,
> потому что. Именно в память. Ну, типа, по идее должно быть. То есть в нашей
> памяти которую они оставляют. То есть если они часто это делают, почему они
> не сохраняют тогда в память-то? Что касается локальных проверок, да, тоже
> проблема. Не знаю, как это улучшить. Конфликты мы уже закрываем. Можешь, в
> принципе, да, можешь, наверное, даже не в память, а в шаблоны ролей. Это
> вставить, но по идее память как раз она должна первостепенно наполняться
> подобными вещами, а потом при желании мы можем обновлять роли, если это
> подходит для всей роли.

The evidence behind it: the audit of the night 2026-10-11→12 (lane 461e87de,
`docs/audits/pr-throughput-2026-10-12.md` on its branch) measured review plus
the fixes that followed at **75.055 lane-hours, 20.75 %** of the night after
known command spans are removed. Its fail verdicts held 149 finding
occurrences, 121 of them behaviour or correctness defects in 53 failing rounds.
The recurring classes it names: an incomplete rendered matrix (missing widths,
themes or languages), contract shapes left unvalidated, edge cases at seams
(restart, identity, stale state).

Two older requirements still bind and this design keeps both. 2026-10-11, the
curation design's originating requirement: memory was «забита, и слишком
много», full of notes about one task; rules must be abstract and must be
rewritten, grouped and consolidated. 2026-10-07: «Какое абстрактное правило …
записать, чтобы такой класс ошибок больше не ловился».

The default answer to "should we build this" is no. The operator asks in so
many words why agents who keep hitting the same class of defect do not put it
in memory, and says memory comes first, role templates later and by choice.
So the question here is the smallest change that makes a repaired finding
leave a rule, keeps that rule, and shows the operator which rules recur.

## 0. Was this solved before

- `search_transcripts` for the lesson request, recurring findings and the
  curator (project-scoped, then unscoped) and `search_memory` for role memory
  and fix stages. The memory index had nothing. The transcripts hold the
  operator message above, the role-memory and curation lanes, and nothing
  that measured the lesson flow.
- **The MVP already asked for exactly this.** Role memory's first request
  (#2609, `docs/design/role-memory.md` §2.4, deployed 2026-10-10 06:51 UTC)
  told a fix round: "Look first at the findings you were handed or found
  yourself: which rule, followed from the start, would have prevented each
  class?" and "leaving at least one lesson is better".
- **#2726 turned that around.** The curation design's slice A
  (`docs/design/role-memory-curation.md` §3.3, deployed with `4de73e57` on
  2026-10-11 11:27–11:30 UTC) made `none` the default ("Most stages do
  neither"), allowed one answer per attempt where the MVP took up to three,
  and reduced the handed findings to a severity count with a caution: "They
  make a lesson only when a rule, followed from the start, would have
  prevented that class of finding on other tasks too." That wording answered
  the operator's complaint that memory was full of task notes; the operator
  had not been asked about fix rounds.
- **#2768 built the curator** (`src/lib/memory/curation/`): it reads every
  scope, merges one class, generalises, ranks and archives with reasons, and is
  due at ten new lessons or six hours. It merged at 2026-10-12 02:50 UTC.
  Production is held on `0ef6ec49` by incident 1389bf5c, and `0ef6ec49` does
  not contain it: no curator pass has ever run on this machine (the
  `role_memory_curation` collection holds no row).

## 1. What the records show

### 1.1 Window and method

Every lesson request role memory recorded: 346 requests from 2026-10-10 06:52
to 2026-10-12 05:29 UTC (about 47 hours), all four projects that ran pipelines,
each joined to its pipeline attempt in `pipelines` and `pipelines_archive` to
learn its role and whether a fail edge activated it (a fix round). Every
request's pipeline was found. The store was opened with `bun:sqlite`
`readonly`; nothing was written. The probe is in the appendix.

### 1.2 Requests and answers

Every request was answered; none was left open. By day, all roles:

| Day (UTC) | Requests | lesson | rewrite | none |
| --- | ---: | ---: | ---: | ---: |
| 2026-10-10 | 92 | 86 | 0 | 6 |
| 2026-10-11 | 223 | 144 | 10 | 69 |
| 2026-10-12 (to 05:29) | 31 | 10 | 4 | 17 |

By role, first attempt against fix round, whole window:

| Role · attempt | Requests | lesson | rewrite | none |
| --- | ---: | ---: | ---: | ---: |
| builder · fix round | 142 | 105 | 9 | 28 |
| builder · first attempt | 146 | 94 | 3 | 49 |
| architect · fix round | 6 | 3 | 0 | 3 |
| architect · first attempt | 35 | 24 | 2 | 9 |
| merger, prod-auditor, visual-critic | 17 | 14 | 0 | 3 |

Split at the deploy that changed the wording (2026-10-11 11:29:52 UTC):

| | Requests | lesson (rules written) | rewrite | none |
| --- | ---: | ---: | ---: | ---: |
| builder fix rounds, MVP wording | 81 | 80 (146 rules) | 0 | 1 |
| builder fix rounds, #2726 wording | 61 | 25 (25 rules) | 9 | 27 |
| builder first attempts, MVP wording | 94 | 85 | 0 | 9 |
| builder first attempts, #2726 wording | 52 | 9 | 3 | 40 |
| every request, MVP wording | 207 | 196 (343 rules) | 0 | 11 |
| every request, #2726 wording | 139 | 44 (44 rules) | 14 | 81 |

Every builder fix round in the window was handed ranked findings: 292
findings over 142 requests (P1 89, P2 149, P3 54). Across fix rounds of every
role: 331 findings, median 2 per round, 90th percentile 5, most 10.

### 1.3 What the fix agents saw

Read from the transcripts of the fix rounds themselves (`conversation_messages`,
the `stage_report` tool result). Under the MVP, a fix round with two findings
read:

> This attempt was handed 2 findings from stage review (P1 ×1, P2 ×1). Start
> there. Write one to three lessons. … Look first at the findings you were
> handed or found yourself: which rule, followed from the start, would have
> prevented each class? … leaving at least one lesson is better.

Under #2726, the fix round on 2026-10-11 22:55 UTC whose single finding was an
incomplete rendered matrix read, as its whole guidance on findings:

> Did this stage show that a learned rule you were given is wrong, too narrow
> or unclear, or teach an abstract rule that changes what an agent does on a
> different task? Most stages do neither; then call leave_lesson with none and
> one line saying why.
> This attempt was handed 1 finding from stage review (P3 ×1). They make a
> lesson only when a rule, followed from the start, would have prevented that
> class of finding on other tasks too.

It answered none: "The finding was a narrow evidence-matrix gap fixed by
widening one loop; no learned rule was wrong and no new cross-task rule
emerged." The request never named the finding; the agent had it in its
prompt and filed it as one loop on one task.

### 1.4 Why fix rounds answer none

All 30 fix-round `none` lines written under the #2726 wording (27 builder, 3
architect), sorted by the reason they give:

| Reason given | Lines |
| --- | ---: |
| existing rules, instructions or guidance already cover it, and nothing more | 16 |
| the finding was specific to this task, prototype, card, helper or component, and nothing more | 4 |
| both | 10 |
| why the class cannot recur on another task | 0 |

Three of them, verbatim: "The finding was a one-branch omission in a single
component; no learned rule was wrong and nothing generalises beyond that
code." "The finding was a UI title length at one width; existing rules on
measuring in the driver already cover it, and no learned rule proved wrong."
"Existing validation and regression guidance already covers this fix."

Both reasons are the request's own words played back. "Covered by existing
guidance" is offered for a defect that happened while that guidance was in
the agent's start instructions, which shows the guidance did not catch it.
"Specific to this component" is offered for the classes the audit names
(a matrix missing a width, a missed branch at an edge).

### 1.5 What was left did not stay

- **222 rules left the injected text for the bound**, every one uncurated:
  180 from the builder role scope of this project and 42 from this project's
  scope. Their median life was **5.2 hours**. Of the 178 rules fix rounds
  wrote, 110 were evicted (median life 5.6 h, 90th percentile 15.3 h) and 68
  are active.
- **No two lessons were word-identical**: 0 of 401 rule rows merged as a
  duplicate. `sameRule` (`roleConsolidate.ts:36`) joins only identical words
  and symbols, so a class written again in other words is a new rule that
  pushes an older one out.
- **The curator never ran** (section 0), so nothing merged a class, ranked
  it, or kept it.
- **Rewrites, the one path that ties two lanes to one rule, were rare**:
  14 agent rewrites, 10 rules, 5 of them by a lane of a different task than the
  rule's author; 9 refined a rule the same task had written in an earlier
  round. Today 4 of 164 active rules carry the work of two or more tasks.
- **A rewrite keeps its place in the leaving order**
  (`roleStore.ts:256-273`; curation design §3.4), so a rule rewritten because
  its class came back is as close to eviction as on the day it was written.
  The duplicate path does the opposite: a repeat moves an uncurated rule to
  the end (`roleConsolidate.ts:83`).

### 1.6 The classes recur across tasks

A keyword pass over the fix-round findings and the rules fix rounds wrote
(approximate; patterns in the appendix). Tasks are distinct board tasks;
138 builder lanes ran for 98 tasks, 28 tasks had more than one lane.

| Class | Findings handed to fix rounds | Tasks they came from | Rules fix rounds wrote on it | Of those, evicted | Still active |
| --- | ---: | ---: | ---: | ---: | ---: |
| rendered matrix (width, theme, language, screenshot) | 101 | 23 | 10 | 4 | 6 |
| contract shape (schema, shape, validation, payload) | 40 | 25 | 8 | 5 | 3 |
| seam (restart, stale, identity, race, recovery, replay) | 107 | 47 | 53 | 41 | 12 |

The matrix and contract classes came back on more than twenty tasks each and
left fewer than one rule per two tasks. The seam class was written down 53
times, by 34 tasks, and 41 of those rules were evicted before a curator could
merge them.

### 1.7 Attempts that were never asked

Of 177 builder fix-round attempts started between the MVP deploy and 05:57
UTC, 36 got no request: 24 failed without an accepted report (restarts, host
loss), 10 settled `needs_decision` without one, 2 are running. A request rides on an
accepted `stage_report`; those attempts are out of this design's reach
(Deferred).

## 2. Why so few lessons are left, and why they do not help

1. **The request talks fix rounds out of it.** Since #2726 a fix round reads
   the same text as every other stage: none is the default, and the findings
   appear as a severity count with a caution. Fix-round lessons fell from 80
   of 81 answers to 25 of 61, while rewrites rose to 9. The none lines repeat
   the request: "existing guidance covers it" and "specific to this task".
   Nothing asks why the class will not come back.
2. **What is left is evicted before it can recur.** Each class is written in
   new words, nothing merges near-repeats, the curator has not run, and a
   rewrite does not refresh a rule's place. Recurring and one-off rules leave
   in the order they were written, about five hours after.
3. **Nothing counts a recurrence.** A rule records the one lane that wrote it.
   The curator's read, the rules window and the stage card cannot tell a rule
   two tasks needed from one that a single task needed, so neither the curator
   nor the operator can promote it.

The pinned premise "so few lessons are left" holds only for the #2726 wording.
Under the MVP nearly every fix round left a rule, and memory still lost them.
Fixing the wording alone would refill the scope at the old rate and evict it
at the old rate. The design addresses all three causes.

## 3. Design

The findings and recurrence changes stay inside `src/lib/memory/`, the MCP
tools, and one line of the rules window. The later problem-routing addition
also uses the existing seat-tick signal source and delivery identity. No pipeline engine file changes (lanes
022c8be9 and 3bceb7d6 hold those): the request is still built from the
pipeline record that `roleStage.ts` already reads.

### 3.1 The fix-round lesson request

**When.** The request for an attempt activated by a fail edge whose source
attempt carries findings. `handedFindings` (`roleStage.ts:33-40`) returns the
findings themselves, `{ stageId, findings: { severity, text }[] }`, where it
returned their severities: `rankedFindings` first, then the unranked
`findings` strings of an older verdict with severity `unranked`. Any other request (a first
attempt, a fix round with no findings) keeps today's lesson guidance
(`roleRender.ts:70-86`), "Most stages do neither" included, with the same two
problem-routing sentences added to every eligible request.

**Each finding is quoted by its opening:** the first line, cut at the end of
its first sentence or at 140 code points with "…", most severe first, at most
five; more read "- and N more, in your prompt". The quote goes back to an
agent that already holds the finding in its prompt; it leaves no machine.

**The text**, replacing the first five lines for a fix round. The example has
three invented findings; the lines from "No lesson may be about a task" on
are today's, plus one sentence.

```text
Your stage report is recorded. This attempt was handed 3 findings from stage review:
- P1: A failed successor can pass the promotion gate.
- P2: The decision row never shows what is being decided at 390 px in Ukrainian.
- P2: The new endpoint accepts a request without its required field.
Each one reached review because the first attempt missed a check. Name each finding's class, such as an incomplete matrix of widths, themes or languages, a contract shape left unvalidated, or an edge case at a seam (a restart, an identity, stale state), and the rule an agent of your role needed before the first review to catch that class on any task.
Then do exactly one of these, once, for the class most likely to come back:
- rewrite: a rule you were given names this class and the finding happened anyway, so the rule is too narrow, unclear or easy to skip. Give its id and a text that would have caught this, keeping every condition it had. The earlier text is kept and can be restored.
- lesson: no rule you were given names this class. Write one: when it applies, and the check to run before the first review. Name the class, never this task's file, component or screen.
- none: only with the reason this class cannot come back on another task: it came from this specification alone, the finding was not a defect, or a gate every task runs now catches it (name the gate). "Existing rules cover it" is no reason: the finding shows they did not.
No lesson may be about a task. What happened on this task alone (a pull request, commit, lane, id, incident, or one module's quirk) belongs in your stage report; leave_lesson refuses it and stores nothing. A mistake made in one file is a class when it can be made in another.
Every agent of a level reads all its rules: choose the narrowest true level:
- role: only that role acts on it, in its own kind of work on this project; yours unless you name another. Reviewers and verifiers take no rules, so their own know-how has no memory scope.
- role on every project: only that role acts on it, in any repository. Leave it under role; the curator alone widens it to role:*:<roleId> after checking other projects.
- project: every role working on this project acts on it alike: this repository's gates, tools and layout.
- machine: every role acts on it alike in any repository on this machine: its tools, operating system and environment.
A rule that some roles need belongs under those roles. The curator widens a rule only when all readers of the wider level act on it.
rule: imperative, at most 300 characters. why: one line, at most 160 characters, saying what happened here; it stays on the record and agents never see it. Each needs at least 16 letters or digits.
Write no names of people, accounts, emails, tokens, ids or absolute paths. Keep a rule's text out of commits, pull requests, issues, tasks and reports; name it by its id. Then end your turn: the stage itself is complete.
```

What each part answers:

- The quoted openings name the findings, so the agent classifies what it just
  fixed; a severity count gave it nothing to classify (1.3).
- "before the first review" is the audit's recommendation (give builders the
  matrix and the seams before the first review), turned into the question a
  rule must answer.
- The three example classes are the audit's. They are worded for any
  repository: a width, theme and language matrix exists wherever there is UI.
- `rewrite` comes first and is tied to the reason most none lines gave: a rule
  that "covers" a class that recurred was not enough, so the class is fixed in
  that rule, under one id (3.3, 3.4).
- `none` keeps its place, one line of at most 160 characters, and now has to
  say why the class cannot come back. The three reasons are the only ones
  that hold on another task. The server does not judge the line (3.2).
- The task-narration guard and the four level lines are today's, word for
  word. The added sentence ("A mistake made in one file is a class…") answers
  the "single component" none lines without loosening the guard: the guard
  still refuses identifiers and still sends one module's invariant to the
  report.
- One answer per attempt stays (`MAX_LESSONS_PER_ATTEMPT`, `roleTypes.ts:17`):
  "the class most likely to come back" picks one. A lane with several rounds
  leaves one per round.

### 3.2 `leave_lesson`

The operator's later instruction separates general behaviour from concrete
problems. A rule is an imperative that changes what an agent does on a different
task. An observed project defect, inconsistency or documentation/specification
mismatch is answered with `problem: { statement, evidence }`: a short statement
of at most 300 code points and evidence of at most 1000. It consumes the request
once and writes no rule. The request explains this distinction in two sentences
and offers problem alongside rewrite, lesson and none. Agents report the problem;
the designated project seat decides whether to propose a task or issue and asks
the operator before creating it.

The existing request row retains the problem and its server-resolved project.
The seat tick projects it as an actionable signal in its existing agenda,
including when the board has no other work. A confirmed landing is credited on
the original problem row before seat succession resets the general agenda
history, so trimming that history never re-offers an old delivered problem. Its
delivery ledger credits only complete delivered items, keeps unseen items across
seat succession and retries delivery failures. There is no separate problem queue,
no age cutoff and no task creation on this path. Problems remain recorded when a
project has no designated seat or ticking is disabled. Statement and evidence are
bounded and redacted for the wake; a summarized item points to
`seat_tick_settings verbose:true problemId=<report-id>` for the full local
report. Reads stay available after delivery and match the observed report
identity: Undo or replacement returns null for the old report.

A proposed lesson or rewrite naming a concrete file path or describing a
specific broken/mismatched behaviour is refused with `LESSON_IS_PROBLEM` and a
hint to answer problem with evidence. Machine rules tied to this project's facts
are refused with `LESSON_WRONG_LEVEL`, directing the agent to a narrower generic
rule or a problem report. These structural checks leave the request open; they
do not attempt to judge every possible wording. Privacy checks retain their hints
and publication protection.

The curator can apply `problem: [{ id, statement, evidence, note }]` to a
misfiled active rule. The same transaction archives it with reason `problem` and
retains the report on that rule, routed by its original source project even from
the machine scope. Each curator transfer has its own episode identity, so a later transfer after
Undo is offered again even when timestamps match. The curator's existing pass
history records the disposition.
Undo restores the earlier rule and removes the transferred report from pending
agenda projection; delivery already made cannot be recalled. Operator-kept rules
retain their existing protection. Nothing deletes a rule silently. The brief tells
the curator to transfer concrete problems before applying the remaining checks.

The tool's existing answers and refusals keep their contracts; problem is a
fourth mutually exclusive answer.
A fix round's `none` is accepted and recorded like any other; nothing refuses
an unconvincing line (detectors are hints, the agent judges, the curator and
the operator read the record). Two texts change:

- the tool description (`server.ts:3331`): "with none (the default)" becomes
  "with none (usual for a stage that was handed no findings; on a fix round,
  only with why the finding's class cannot come back on another task)";
- the schema's `none` description (`server.ts:3899`): "One line: why this
  stage taught nothing; on a fix round, why the finding's class cannot come
  back on another task."

The lesson request row (`LessonRequestRow`, `roleTypes.ts`) gains
`taskId?: string | null`, which `lessonRequestForReport`
(`roleStage.ts:42-51`) fills from the pipeline's first board task
(`pipeline.taskIds[0]`, null for a lane without one) when it records the
request. Nothing else writes it.

### 3.3 Recurrence: the tasks behind a rule

A class recurs when two different tasks put it into one rule. Every path
that joins two lessons into one rule already leaves a record that does not
change afterwards:

| How the second task reaches the rule | Record it leaves today |
| --- | --- |
| a stage rewrites it by id | that stage's request row, `rewrote: <id>` |
| a stage writes the same words (`sameRule`) | that stage's request row lists the incoming rule, which is `state: merged`, `mergedInto` the survivor |
| the curator merges rules | the sources, `state: merged`, `mergedInto`; the survivor's `mergedFrom` |
| the curator splits a rule | each new part's `splitFrom` |

**`ruleTasks(rule)`** is a pure function in `roleStore.ts` over the store
snapshot. The rule's lineage is the rule and, recursively with a seen set,
every rule merged into it, every rule in its `mergedFrom` and the rule it was
split from. Its tasks are the distinct `taskId ?? "pipeline:" + pipelineId` of
every request row whose `ruleIds` or `rewrote` names a rule of that lineage.
One index from rule id to task keys, built per read, serves every rule.

The request rows carry it because no later writer changes them once the
answer is recorded. A rule's `revisedBy` can change: a curator call that
moves or reorders a rule replaces it with `{ by: "curator" }` and saves no version when the text
is unchanged (`curation/apply.ts:176`), which would drop the task of the
stage that rewrote it.

A request recorded before `taskId` existed counts as its lane, so when a
later lane of the same task rewrites a rule written then, that one task
counts twice. Only rules written before the change can over-count, and only
where a task ran a second lane (28 of 98 tasks did). Read this way, today's
store holds 4 active rules from two or more tasks, 1 of them in a role
scope.

`projectView` (`roleStore.ts:413`) puts the count on every rule it shows,
`RuleView.tasks` (`roleTypes.ts:153`), with one index of `mergedInto` built per
call. The curator's read (`curation/read.ts:44`) spreads the same view, so each
entry it pages carries `tasks` with no further change.

**A role-template candidate** is an active rule in a role scope
(`role:<project>:<role>` or `role:*:<role>`) whose `tasks` is two or more. It
is computed from the record each time it is read: nothing is stored, nothing is
promoted, and a candidate stops being one when the curator archives it.

No `class` label is added to a lesson. The data shows why one would not join
anything: 401 rules, 0 written twice in the same words. Free-text labels
would match no better. The join is the agent's choice to rewrite the rule
that names the class, and the curator's merge.

### 3.4 Keeping a recurring rule

An agent rewrite of a rule that is neither curated nor kept by the operator
moves it to the end of its scope's leaving order, as a duplicate already does
(`roleConsolidate.ts:83`), before the bound is applied (`roleStore.ts:267`).
A curated or operator-kept rule keeps the place the curator or the operator
gave it, as on the duplicate path. The scope's history records the rewrite as
today; its active list records the new order.

This changes one sentence of the curation design (§3.4, "keeps the rule's id,
place and curatedAt") for uncurated rules only. With it, a class that keeps
coming back keeps its rule; a rule nobody needed again leaves first. The
start block renders the scope last-to-leave first (`learnedRulesBlock`,
`roleStore.ts:180-192`), so a refreshed rule also moves to the top of what the
next builder reads.

### 3.5 Promotion: the curator proposes, the operator promotes

The ten-lesson trigger and the six-hour pass stay as built
(`curation/store.ts:86-106`, `CURATION_NEW_LESSONS = 10`). Fix-round rewrites
and lessons already count toward it. Three sentences change in the curator's
brief (`curation/brief.ts`):

- checklist 5, Duplicates, gains: "Rules that different tasks wrote about one
  class of finding are one class: merge them into one rule of that class that
  keeps every condition. tasks counts the tasks behind each rule."
- checklist 7, General and ranked, gains: "Rank a rule backed by more tasks
  above one backed by fewer."
- the closing instruction gains: "…and the ids of role rules whose tasks is two
  or more, as candidates for that role's template."

So the curator is the one that sees recurrence across tasks and turns it into
one role-level rule: merged, generalised to its class, ranked first, at the
narrowest true level (a builder practice stays under the builder; the curator
alone widens to `role:*:builder` after reading other projects, as built). It
writes memory only, reversibly, as every curator operation does.

**Promotion into a role template stays a separate, explicit step**: the
operator, in the existing role presets, copies a candidate into the role's
scaffold when it fits the whole role, and may then delete it from memory in
the rules window. Nothing promotes on a count.

Until production carries #2768, no curator runs. The request (3.1), the
refresh (3.4) and the count (3.3) work without it: rewrites join lanes into one
rule, the rule stays, and the count shows.

### 3.6 What the operator sees

The rules window's rule row already has a provenance line: kept or unreviewed,
author or reviser, "fix round", "merged from N rules"
(`LearnedRules.tsx:178`). It gains one more item when `tasks` is two or more:
"from N tasks" / «з N задач» (`roleMemory.tasks` in `en.ts` and `uk.ts`;
genitive plural, the same form for every N from 2). In a role section it marks
a role-template candidate. Nothing else is added: no list, filter, badge or
button. The existing driver cases "role memory: rules window and the rule
line" and "role memory curation: reversible window"
(`src/components/mobile/issue1671Evidence.browser.test.tsx`) gain a fixture
rule with three tasks and render it.

### 3.7 Privacy

- Lessons keep their privacy hints and a rewrite carries them too. Email-shaped
  values gain a local hint alongside the existing static detector hints. The
  separate guard steers concrete paths to problem. Rule and why stay in the known-values file the publication
  gate reads, rewritten texts included (unchanged path).
- The quoted findings go only to the attempt that received them and reach no
  egress. `RuleView.tasks` is a count; task ids, lane ids and conversation ids
  stay on the server.
- The curator's final message names ids, never text, as today.

### 3.8 Files

| File | Change |
| --- | --- |
| `src/lib/memory/roleRender.ts` | `HandedFindings` carries findings; the fix-round request (3.1) |
| `src/lib/memory/roleStage.ts` | `handedFindings` returns findings with the unranked fallback; `taskId` on the request |
| `src/lib/memory/roleTypes.ts` | `LessonRequestRow.taskId?`, `RuleView.tasks?` |
| `src/lib/memory/roleStore.ts` | `recordLessonRequest` keeps `taskId`; `ruleTasks`; `tasks` in `view`; rewrite refresh (3.4) |
| `src/lib/memory/curation/brief.ts` | three sentences (3.5) |
| `src/lib/mcp/server.ts` | `leave_lesson` description and `none` description (3.2) |
| `src/components/roleMemory/LearnedRules.tsx`, `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` | one provenance item (3.6) |
| `src/lib/memory/roleProblems.ts` | bounded problem input, structural misfiling guard, projection and durable delivery credit |
| `src/lib/memory/curation/apply.ts` | transactional problem transfer and existing pass Undo |
| `src/lib/mcp/bindings.ts`, `src/lib/mcp/server.ts` | problem answers, curator transfer schema and complete report reads |
| `src/lib/monitor/seatTickSources.ts`, `src/lib/monitor/seatTick.ts`, `src/lib/monitor/types.ts`, `src/lib/monitor/seatTickController.ts` | memory problems as existing actionable signals; shared signal version helper; delivery credit before seat succession |
| `src/lib/monitor/report.ts` | a summarized problem points to its full local report |

## 4. Options weighed

| Question | Chosen | Not chosen, and why |
| --- | --- | --- |
| How the request names a finding's class | quote each finding's opening; the agent names the class | the reviewer tags a class in `stage_report` (a schema change in the engine the fenced lanes hold, and a vocabulary that would have to grow); a server keyword classifier (a growing pattern list that judges prose; the keyword table in 1.6 is approximate on purpose) |
| What makes a none acceptable | the request asks for a non-recurrence reason; the server records it | refuse a none that says "existing rules cover it" (a pattern refusal on prose; detectors are hints) |
| How recurrence is detected | tasks across a rule's lineage, read from the request rows, plus `taskId` on them | a `class` label grouped by equal text (0 of 401 lessons repeated their words); text similarity or embeddings (a model call or a dependency on the write path, heavier than the problem) |
| How a recurring rule survives the bound | an agent rewrite refreshes its place | a new leaving tier for rules from two or more tasks (a second ordering rule beside the curator's); raising the 10 000 bound (operator answer 1, 2026-10-11) |
| Who promotes | the curator merges and ranks in memory; the operator copies into the template | promote on a count into `role:*` or the template (the operator: «потом при желании мы можем обновлять роли») |
| Where the operator sees it | one item on the existing rule line | a candidates list, filter or "promote" button (no new UI while the existing line can carry a count) |

## 5. Tests

Every file runs by path through `bash scripts/gate-slot.sh bun test <file>`
with HOME, `XDG_CONFIG_HOME`, TMPDIR and `LLV_STATE_DIR` under a private
temporary root, never the operator's state.

**The new wording** (`src/lib/mcp/leaveLesson.test.ts`, through the MCP service
as the file already does):

1. A fix round handed three findings gets a request that quotes each opening
   with its severity, most severe first; asks for the rule needed "before the
   first review"; lists rewrite before lesson; states the three none reasons
   and that "Existing rules cover it" is no reason; and still carries the
   task-narration line and the four level lines word for word.
2. Seven findings: five quoted, "- and 2 more, in your prompt". A finding of
   300 characters is cut at 140 code points with "…"; one with two sentences
   is cut after the first.
3. A source verdict with unranked findings only quotes them as `unranked`.
4. A first attempt, and a fix round handed no findings, retain today's lesson guidance
   ("Most stages do neither"), with the added problem-routing sentences.

**A justified none** (same file): a fix round answers none with a reason that
names its gate; the answer is accepted, the request row records the line,
`stageLessons` shows it under the attempt, and no rule is written. A none that
gives no non-recurrence reason is also accepted: the server judges no prose.

**Recurrence across two lanes** (`src/lib/memory/roleReviewLessons.test.ts`, with two
pipelines linked to two different tasks):

5. Lane A's fix round leaves a role lesson; lane B's fix round rewrites it.
   `projectView` shows one active rule in the builder scope with `tasks: 2`,
   and exactly one rule in role scopes has `tasks` of two or more: one
   promotion candidate.
6. Lane B instead writes the same words: the duplicate merges, and the
   survivor has `tasks: 2`: still exactly one candidate.
7. Control: lanes A and A′ of one task rewrite the same rule: `tasks: 1`, no
   candidate. A request row stored without `taskId` counts its lane.
8. Refresh: in a scope at its bound, an uncurated rule rewritten by a second
   task outlives a newer single-task rule when the next lesson arrives; a
   curated rule rewritten the same way keeps its place.

**The curator** (`src/lib/memory/curation/reviewLessons.test.ts`):

9. After a cross-task rewrite as in 5, a curator call that moves the rule to
   another scope without editing it keeps `tasks: 2`.
10. A curator merge of two rules written by two tasks leaves one rule with
    `tasks: 2`, and an undo of the pass restores two rules with one task each.
11. A scope read pages `tasks` on every active entry, and the brief carries the
    three sentences of 3.5.

An optional model case for `curator.eval.test.ts` (run only with
`LLV_CURATOR_EVAL=1`): two builder rules of one class from two tasks, in
different words, end as one rule ranked first.

**Privacy detectors still hint** (`roleReviewLessons.test.ts`): a fix-round lesson and a fix-round
rewrite whose texts carry an email-shaped and a home-path-shaped value,
generated at run time, are stored with their hints and are not refused; the
rewritten text appears in the known-values file.

**The rule line** (`src/components/roleMemory/LearnedRules.render.test.tsx`):
"from 2 tasks" / «з 2 задач» appears for `tasks: 2`, nothing for `tasks: 1` or
absent. The driver cases of 3.6 render the window at 1440, 1000 and 390 px, in
Ukrainian and English, light and dark, and measure the provenance line: no
horizontal overflow and no clipped text.

**Problem routing**: through the MCP service, a problem answer consumes its
request, stores statement and evidence without a rule, and reaches the designated
seat's wake agenda. Delivery failure keeps it owed; a complete landing credits it
once, including after seat succession. A path-specific rule is steered to problem,
and a machine rule tied to the current project is refused without consuming the
request. Generic conditional practices remain admissible. A curator transfer from
machine scope reaches the rule author's project, archives with reason `problem`,
and Undo restores the rule and removes the report from projection. Invalid or
stale curator calls transfer nothing. A new transfer after Undo remains owed
even with an equal timestamp; summarized wakes name a full report that can be
read after delivery and never resolve an old identity to a replacement report.

Before the first commit the build stage runs the pre-commit privacy check
over each whole test file it touches; a file whose old fixtures fail the
current detectors takes its new tests in a sibling file.

## 6. Rollout and how we will know

Nothing here deploys. Production stays on `0ef6ec49` until incident 1389bf5c
clears; the next verified deploy carries this change and #2768 together.

Two days after that deploy, the probe in the appendix answers:

- fix-round answers by kind: lesson plus rewrite against none (under the MVP
  wording, 80 of 81; under #2726, 34 of 61);
- the share of fix-round none lines that give a non-recurrence reason;
- the median life of rules that left for the bound, against 5.2 hours;
- active rules with `tasks` of two or more, against 4 today (1 in a role
  scope);
- curator passes run, and how many rules they merged across tasks.

The audit's number moves later and less directly: review-plus-fix residence
per lane on the next audited night, against 75 lane-hours.

## 7. Validation against the requirement

| The operator said | This design |
| --- | --- |
| «повтор … дефектов» | 1.6: three classes, each from 23 to 47 tasks |
| «если они часто это делают, почему они не сохраняют тогда в память-то?» | 1.2–1.5: they did under the MVP and lost it within hours; since #2726 the request talks them out of it. 3.1 asks a fix round for the class it fixed; 3.4 keeps it |
| «матрица проверок … нужно класть в память. Именно в память» | the request's first example class is the width, theme and language matrix, and its question is the check to run before the first review |
| «память … должна первостепенно наполняться подобными вещами» | fix rounds, the stages that carry review findings, get the request that asks for them; one-off stages keep "most stages do neither" |
| «а потом при желании мы можем обновлять роли, если это подходит для всей роли» | 3.5: the curator merges and ranks, the rule line shows "from N tasks", the operator promotes by hand in role presets |
| 2026-10-11: memory full of notes about one task | the narration guard and the levels stay word for word; one answer per attempt; rewrite before lesson, so a recurring class is one rule |

## Deferred — not currently justified

- **A class field on findings or lessons**, filled by the reviewer or the
  fixer. Free text never joined two lessons (0 of 401); a fixed vocabulary
  would grow; the reviewer's verdict schema belongs to the engine the fenced
  lanes hold.
- **Refusing an unconvincing none.** Detectors are hints; the line is on the
  record for the curator and the operator.
- **Feeding none lines and raw findings to the curator.** Its read is bounded
  at 24 KB a page. Wait for the after-deploy none share (section 6).
- **More than one lesson per fix round.** One per attempt is the 2026-10-11
  design; several rounds give several.
- **A candidates list, filter or "promote to template" button.** The rule
  line carries the count; role presets remain where a template changes.
- **Automatic promotion** into `role:*:<role>` or a template on a count.
- **A separate leaving tier for rules from several tasks.** The refresh in 3.4
  first; revisit if recurring rules still leave for the bound.
- **Backfilling `taskId`** on the 346 stored request rows. They count as
  lanes; the over-count of 3.3 is bounded to them.
- **Lesson requests for attempts that settle without an accepted report**
  (36 of 177 fix rounds). That path is the pipeline engine's.
- **Seeding the three audit classes as rules by hand.** Memory has no
  operator write path for a new rule, and the first fix rounds after the
  deploy write or rewrite them; rules on all three already existed and still
  did not prevent recurrence, which is what 3.1 and 3.4 address.

## Notes

- The pinned premise that few lessons are left is true only after #2726; the
  larger loss is eviction without curation (1.5).
- The class counts in 1.6 come from keyword patterns and are approximate;
  every other number is an exact count of stored records.
- The curator from #2768 is on main and not in production; it has never run.
- 9 of the 14 rewrites refined a rule the same task wrote in an earlier round;
  only 5 joined two tasks.
- No pipeline engine file changes, so the fenced lanes 022c8be9 and 3bceb7d6
  cannot conflict with this work.

## Appendix: the probe

Read-only, with Bun, given the path of the operator's `state.sqlite`. It
prints the tables of 1.2 and 1.5; 1.4 and 1.6 add the patterns below to the
same rows.

```ts
import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { readonly: true });
const rows = (c: string) => (db.query("select value_json v from state_rows where collection=?").all(c) as { v: string }[]).map(r => JSON.parse(r.v));
const pipelines = new Map<string, any>();
for (const c of ["pipelines_archive", "pipelines"]) for (const p of rows(c)) if (p?.id) pipelines.set(p.id, p);
const memory = rows("role_memory");
const answer = (q: any) => q.rewrote ? "rewrite" : q.ruleIds?.length ? "lesson" : q.none !== null ? "none" : "open";
for (const q of memory.filter(r => r.kind === "request")) {
  const p = pipelines.get(q.pipelineId);
  const attempt = p?.runs?.find((r: any) => r.stageId === q.stageId)?.attempts?.find((a: any) => a.n === q.attempt && !a.historical);
  const fixRound = attempt?.activatedBy?.edge === "fail";
  console.log(q.at, q.roleId, fixRound ? "fix" : "first", answer(q), p?.taskIds?.[0] ?? `pipeline:${q.pipelineId}`);
}
for (const r of memory.filter(r => r.kind === "rule" && !r.versionOf && r.reason === "budget"))
  console.log("evicted", r.scope.split(":")[0], r.source.fixRound ? "fix" : "first", (Date.parse(r.changedAt) - Date.parse(r.createdAt)) / 3.6e6);
```

Patterns used in 1.4 and 1.6, case-insensitive; those of 1.6 match on word
boundaries, those of 1.4 anywhere in the line:

- covered: `existing|already|cover` and their Ukrainian counterparts
  (`достатн|чинні|наявні|вже`);
- task-specific: `specific|this (prototype|card|section|helper|component)|one-(word|branch)|narrow|single` and `цього прототипу|специфічн`;
- rendered matrix: `viewports?|390 ?px|1440|widths?|themes?|dark|locales?|ukrainian|languages?|matrix|screenshots?`;
- contract shape: `contract|shapes?|schemas?|validat\w*|zod|payloads?`;
- seam: `restart\w*|reboot\w*|stale|identity|race\w*|concurren\w*|crash\w*|recover\w*|reload\w*|resum\w*|succession|replay\w*`.
