# Role memory layers: a larger store in levels, role-wide rules for every role, write-quality checks, and selection under one hard maximum

Status: design with decisions recorded on 2026-10-22; slice 1 implements
frozen whole-scope delivery and shadow measurement. The research was written against
`main` at `f5fd6a2c0`; file and line references are to that commit. Revised
twice the same day after critiques: when the second revision was finished
`main` stood at `ee990fcfc`, four commits later, and none of them touches a
file cited here. Live
records were read read-only at 2026-10-21 21:08:15 UTC (the cutoff `T`): the
`role_memory` and `role_memory_curation` collections of the state database,
the memory delivery ledger, the pipeline records of the pilot's lanes, the
conversation-path rows of the agent registry and, for two counts, the stage
transcripts those rows point at. The first revision read the same collections
and the ledger once more at 22:37:23 UTC and rolled that export back to `T`;
the second read them at 2026-10-22 00:03:27 UTC for counts that depend only
on records no later write changes (§1.1). Every export lived in a stage's
scratch directory and went with it. Projects
other than this repository are named by letter and kind, as in
`docs/design/memory-quality-benchmark.md`: A is this repository, B an ERP
customization, C a bot and web-app product, D a dispatching web application,
E a thesis repository, F a plain folder. No rule text, rule id, conversation
id, path or person appears here; examples are invented.

## Originating requirement

Operator, 2026-10-21 20:16 UTC, by voice in Russian, in this repository's
orchestrator seat conversation, with a screenshot of the learned-rules window
of another project: one role scope at 9 814 of 10 000 characters, two project
rules, sixteen machine rules, three rules that had left. The words are
private operator speech held on this machine, and the pinned specification
marks them for agents only, so this document gives a dated paraphrase in its
own words:

1. Research how memory behaves now and improve it.
2. Memory could use more tokens and more layers.
3. Where possible, roles should write memory that holds for the role in every
   project, beyond the one they work in.
4. Find a way to check that agents write what the operator means, and that it
   is useful.
5. Three kinds of memory at 10 000 characters each feels too small; a larger
   memory could hold several levels of abstraction.
6. Later, combine memory with Jev and measure how well Jev picks the part of
   memory to inject. The per-scope limit could then be relaxed, but some
   overall maximum must stay. Jev would cut the volume injected.

The default answer to "should we build this" is no unless the requirement
demands it. It asks for research and a design, so this document builds
nothing; it measures, weighs options, recommends the smallest change for each
line, and keeps what it cuts under "Deferred".

Earlier operator decisions still bind. They are paraphrased here with their
dates; the documents named hold them:

- 2026-10-02: nothing is deleted for disuse; at most it ranks lower
  (`docs/design/role-memory.md`, opening section).
- 2026-10-07: reviewers stay clean; the first bound was 10 000 characters
  per scope (`docs/design/role-memory.md`).
- 2026-10-11: no cap on the number of rules, 10 000 characters per scope; a
  new lesson is active at once; a curator on the seat tick; a role keeps
  rules that hold across projects (`docs/design/role-memory-curation.md`,
  "Originating requirement").
- 2026-10-16: rule budgets may be raised if more volume is needed, amount
  unknown (`docs/design/memory-source-switch.md`, requirement 5 and §5).

## 0. Earlier work and earlier answers

`search_transcripts`, project-scoped first and then unscoped, in five
phrasings (Russian and English: more tokens and levels of abstraction with
Jev; the 10 000-character limit; raising the rule budget; Jev picking
relevant memory; selection of learned rules), and `search_memory` for role
memory bounds, layers and selection. `search_memory` returned nothing. The
hits opened:

| Hit (title, date) | What it settles |
| --- | --- |
| Seat conversation of this repository ("You are the Orchestrator. Mode: standard…"), 2026-10-21 20:16–20:17 UTC | The request above, and the seat's launch note for this lane. That note says the role-on-every-project level exists only for the orchestrator and the maintainer; §2.1 corrects it from the code. |
| Same seat line, 2026-10-16 18:08 UTC | The seat's report of the one-memory design: no budget rise was needed then, because the lessons lost had been evicted before the curator saw them; the orchestrator alone could go from 16 to 24 KB. |

| Earlier design | What it settled | What this design changes |
| --- | --- | --- |
| `docs/design/role-memory.md` (2026-10-07) | Stage-end lessons, scopes, the 10 000 bound, clean reviewers; "per-stage selection of rules" deferred because a scope was small enough to inject whole | The deferral's premise no longer holds (§1.3–1.4); selection returns (§5) |
| `docs/design/role-memory-curation.md` (2026-10-11) | Four levels (§3.0), leaving order (§3.2), the curator's checklist (§3.6), `role:*:<role>` written only by curator moves | Writers may target `role:*:<role>` behind a visibility gate (§2) |
| `docs/design/orchestrator-role-memory.md` (2026-10-12) | Seats and maintainers read four scopes; the seat writes | Unchanged; the seat gets the same new level |
| `docs/design/lessons-from-review-findings.md` (2026-10-12) | Fix rounds name their findings; `tasks` counts recurrence | Fix-round rewrites become the pilot's grounded labels (§5.5) |
| `docs/design/role-memory-to-prompts.md` (2026-10-15) | Universal classes moved into role prompts; §5.1 multi-role scopes, §5.2 tool scopes, §5.3 promotion flow | Promotion is the top of the layer stack (§3.4); §5.1–5.2 stay deferred |
| `docs/design/memory-quality-benchmark.md` (2026-10-16) | Criteria, replay design, eleven improvements; whole-scope delivery wastes bytes on some roles | Its item 4 (nearest rules in fix rounds) and item 10 (curator calibration) feed §5–6 |
| `docs/design/memory-delivery-ledger.md` | One private ledger row per engine start with ordered rule ids | Records selections (§5.4) |
| `docs/design/memory-source-switch.md` §5 (2026-10-16) | No stage budget rise until a week shows curated rules archived for budget | That trigger has fired: 163 curated rules left for budget in a week (§1.4) |
| `docs/research/memory-selection.md` (2026-10-02) | Grounded Jev filters better than FTS on operator messages; automatic injection stays off below 90 % precision | Its request shape and ledger discipline are reused for stage launches (§5.2, §5.5) |

## 1. Evidence from this machine

### 1.1 Method

One read-only `bun:sqlite` open of each database, inside one read
transaction for the state database (148 ms). Rule rows, scope rows, request
rows and curator pass rows were exported to the stage's scratch directory
(5 348 memory rows, 327 curation rows, export digest `4da5596a28c8`), with the
2 575 rows of the delivery ledger. Aggregates come from scripts in the same
directory; the appendix defines each count. Rule text was read only inside
the stages for the blind samples (§1.6) and the pilot (§5.5); none of it is
reproduced here.

**The revision's re-measurement.** The first stage's scratch directory,
with its exports, its Jev scores and its judgement keys, was removed when
that stage settled. Its scripts survive verbatim in its own transcript and
were replayed. A second read-only export at 22:37:23 UTC held 5 380 memory
rows and 2 617 ledger rows (the ledger's first row is still its first
sequence, so nothing had been evicted). Between `T` and that read the store
took 13 scope-history entries, all agent writes and no curator pass: 11 new
rules, 2 agent rewrites and 1 budget archive. Undoing exactly those (dropping
rows created after `T`, restoring the two rewritten rules to the text their
new version rows hold, marking the budget-archived rule active again) and
keeping ledger rows written up to `T` gives 5 348 memory rows and 2 575
ledger rows, the counts of the first export. The rolled-back export
reproduces the first stage's blind draw label for label (148 of 148), its
pilot case building drop for drop (324 rewrite requests, 107 eligible lanes)
and the SHA-256 of its pilot request plan (`10de650580cc`), so every request
body the pilot sent, pool and brief included, is byte-identical. What it
cannot rebuild is anything computed from the Jev answers, which were never
stored outside that scratch directory.

**The second revision's read.** A third read-only export at 2026-10-22
00:03:27 UTC (5 403 memory rows, 329 curation rows, 2 647 ledger rows, the
ledger's first row still its first sequence; export digest `94dd758833c2`)
supplied the counts of §4.2 and §5.4. They use only records no later write
changes: ledger rows up to `T` with their rule ids and text hashes, the texts
of rules and of their version rows, and the curator pass entries of scope
history, which `keepHistory` never trims
(`src/lib/memory/roleStore.ts:48-51`). So they needed no rollback. The
probes of §4.3, §5.1 and §5.4 ran on synthetic rules in a scratch export of
this commit, against its own `renderLearnedRulesSelection` and
`retainRules`.

### 1.2 Scope fill against the bound

112 scope rows, 34 with active rules, 437 active rules (395 distinct texts),
mean length 252 code points, 26 at the 300-point cap. The bound is
`ROLE_MEMORY_BOUND = 10_000` code points per scope
(`src/lib/memory/roleTypes.ts:11`), counted on the rendered `- [id] rule`
lines.

| Level | Scopes with rules | Active rules | Code points | Fullest scope | Scopes at ≥ 90 % |
| --- | ---: | ---: | ---: | ---: | ---: |
| Role on this project | 25 | 275 | 79 452 | 9 889 | 4 |
| Role on every project | 7 | 144 | 36 893 | 9 983 | 3 |
| Project | 1 | 2 | 590 | 590 | 0 |
| Machine | 1 | 16 | 3 607 | 3 607 | 0 |

The fullest scopes:

| Scope | Rules | Code points | Of the bound |
| --- | ---: | ---: | ---: |
| builder, every project | 42 | 9 983 | 99.8 % |
| orchestrator, every project | 37 | 9 912 | 99 % |
| builder, A | 33 | 9 889 | 99 % |
| builder, B | 34 | 9 848 | 98 % |
| architect, every project | 37 | 9 768 | 98 % |
| builder, C | 32 | 9 337 | 93 % |
| builder, D | 31 | 9 336 | 93 % |
| orchestrator, A | 24 | 6 850 | 69 % |
| architect, A | 18 | 5 381 | 54 % |
| every other scope (25) | 1–16 | ≤ 4 263 | ≤ 43 % |

The project level is nearly empty: one scope in the machine holds rules, and
project A holds none. The curator raises a rule to a project only when every
role there acts on it (`src/lib/memory/curation/brief.ts`, check 4), and
writers chose it for 43 of 601 lessons last week (§1.5).

### 1.3 What each start receives

The delivery ledger covers 2 575 engine starts from 2026-10-16 23:11 to
2026-10-21 21:08 UTC (4.91 days); 1 539 carried rules, 1 036 were clean or
role-free and carried none. Bytes are the UTF-8 size of the rendered block.

| Role and engine | Starts | Median bytes | p90 bytes | Median rules |
| --- | ---: | ---: | ---: | ---: |
| builder, Codex | 779 | 22 851 | 24 435 | 87 |
| builder, Claude | 249 | 23 147 | 24 471 | 87 |
| orchestrator, Claude | 249 | 14 713 | 17 996 | 53 |
| architect, Claude | 84 | 14 924 | 17 663 | 56 |
| architect, Codex | 14 | 17 113 | 19 713 | 63 |
| maintainer, Codex | 76 | 3 407 | 4 317 | 12 |
| prod-auditor, Codex | 74 | 6 339 | 8 613 | 25 |
| visual-critic, Claude | 11 | 6 312 | 7 425 | 23 |

The curator's brief sets a target of 16 000 bytes for a role's four scopes
(`src/lib/memory/curation/brief.ts`, check 7); nothing enforces it, and a
builder start receives 43 % more at the median. The only enforced ceiling is
`LEARNED_RULES_MAX_BYTES = 120_000` (`src/lib/memory/roleLaunch.ts:14`), an
argument-length safety limit that no start approaches. Claude starts also
load the engine's own memory index, a median 9 012 bytes for builders; Codex
starts loaded none in this window.

### 1.4 What the bound pushed out

`retainRules` archives curated rules with the reason `budget` while a scope
is over its bound (`src/lib/memory/roleConsolidate.ts:60`).

| | Count |
| --- | ---: |
| Rules archived for budget, ever | 185, all between 2026-10-15 and 2026-10-21 |
| per day, 15th to 21st | 20, 7, 16, 23, 18, 40, 61 |
| by scope | builder A 143, builder C 23, builder B 11, builder D 7, builder on every project 1 |
| curated before they left | 163 (the bound now removes rules the curator kept) |
| never curated | 22 |
| written by a fix round | 134; first-pass stages 36; seats 15 |
| backed by two or more tasks | 9 |
| life from writing to archive | median 16.4 h, p10 1.0 h, p90 123 h |
| lessons of the last 7 days archived for budget | 154 of 601 (26 %) |

Builder A gains 27 to 46 rules a day and loses 18 to 49 to all reasons
(history of the last eight days): the scope runs at its bound and churns.
The trigger `docs/design/memory-source-switch.md` §5.5 named for raising a
stage budget, "a week shows a curated rule archived for budget", has fired
163 times. No curator drop "for room" is recorded.

Curator, last 7 days: 121 passes (94 succeeded, 27 failed), median 10.0
minutes, p90 16.8; 314 rewrites, 86 merges, 121 moves, 52 splits, 219
archives, 6 returns. Of the 1 409 original rule rows ever written: 437
active, 420 archived as task-specific, 205 merged as duplicates, 185 budget,
102 in instructions, 15 stale, 12 in code, 12 problems, 11 duplicate
archives, 8 contradicted, 1 no reader, 1 deleted; 1 377 more rows are earlier
versions of rewritten rules.

### 1.5 Who writes, how often, at which level

Lesson requests in the 7 days to the cutoff, by the answer given:

| Role | Requests | Lesson | Rewrite | Problem | None |
| --- | ---: | ---: | ---: | ---: | ---: |
| builder | 1 280 | 453 | 230 | 29 | 565 |
| architect | 103 | 63 | 8 | 7 | 23 |
| prod-auditor | 85 | 5 | 0 | 2 | 77 |
| visual-critic | 11 | 9 | 0 | 1 | 1 |
| merger | 2 | 0 | 0 | 0 | 2 |

Seats wrote 116 rules in the same week. The level each of the 601 stage and
seat lessons was written at (read from the scope history entry that added
it): role on this project 537 (89 %), project 43, machine 21. That count
leaves out 57 more lessons stages and seats wrote that week which later
became merge survivors (the curator merged other rules into them); with
them, 590 of 658 writes were at role-on-this-project level (90 %), the frame
of the write sample in §1.6. Curator split parts and imports are not writes
and are left out of both counts. No writer can
target "role on every project": `leave_lesson` accepts `role`, `project` and
`machine` (`src/lib/mcp/server.ts:4251`), and the request tells agents to
leave a role-wide rule under `role` and lets the curator alone widen it
(`src/lib/memory/roleRender.ts:108`).

Where those 601 lessons are now: 238 active (147 in role-on-this-project
scopes, 62 widened by the curator to role on every project, 29 elsewhere), 75
merged into an existing rule, 154 archived for budget, 94 as task-specific,
21 as already in instructions, 19 for other reasons.

### 1.6 Generic or project-specific: two blind samples

**First sample: what the stores hold.** 148 rules drawn by SHA-256 order
from five strata of the store at `T`: 60 active rules of
role-on-this-project scopes, 30 active rules of role-on-every-project
scopes, all 16 machine rules, both project rules, and 40 rules from a fifth,
conditional stratum. That stratum's frame was the 497 rules created in the 7
days to `T` whose first scope-history addition was a role-on-this-project
scope, after four exclusions: rules already drawn into the active strata,
curator split parts, merge survivors (rules carrying `mergedFrom`) and
imports. Each rule was judged at its text at `T`, which for 15 of the 40 was
no longer the text its writer wrote (14 of the 15 had been rewritten by the
curator, 1 only by another agent). The judge saw only the rule text under a
random label, in label order; scope, role, project and state were hidden and
joined afterwards. One judge, that stage's agent. The judge had seen the
architect scopes in its own start block, so a few architect rules were
recognisable.

**Second sample: what writers write.** Because the fifth stratum describes
surviving current texts with recent active rules partly removed, the
revision drew a uniform sample of writes. Frame: every rule a stage or seat
wrote in the 7 days to `T` whose first scope-history addition was a
role-on-this-project scope, in any later state, merge survivors and rules
also drawn by the first sample included; only curator split parts and
imports are left out, since nobody wrote them as lessons. That is 590 rules
(494 from stages, 96 from seats). 60 were drawn by SHA-256 order and each was
judged at its original text: the text of its earliest version row when it
had been rewritten (26 of the 60), its own text otherwise. Same blinding,
same classes; the judge was the revision stage's agent. On the 8 rules both
samples judged at an identical text the two judges gave the same class to 7;
in the one disagreement the earlier judge said project-specific and the
later said principle, so the second sample may lean towards "holds across
projects".

Classes: **U** principle (names no tool, product, file or project concept;
holds for that kind of role in any repository); **T** tool practice (names a
general tool or runtime and nothing a single project owns); **D** harness
practice (names Delegatus mechanics every project on this machine shares:
stages, seats, publication, the gate wrapper); **P** project-specific (names a
project's files, scripts, gates, product surfaces, domain terms or team). A P
rule whose general core survives without its project terms is also marked
splittable. U, T and D together are "holds across projects".

| Stratum | n | U | T | D | P (splittable) | Holds across projects [95 % Wilson] |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Active, role on this project | 60 | 24 | 10 | 5 | 21 (9) | 65 % [52–76] |
| Active, role on every project | 30 | 15 | 10 | 4 | 1 (1) | 97 % [83–99] |
| Active, machine | 16 | 1 | 14 | 1 | 0 | 100 % [81–100] |
| Active, project | 2 | 0 | 2 | 0 | 0 | 2 of 2 |
| First sample, conditional recent stratum (text at `T`) | 40 | 20 | 7 | 5 | 8 (3) | 80 % [65–90] |
| Second sample, role-on-this-project writes of the last 7 days (original text) | 60 | 34 | 14 | 5 | 7 (4) | 88 % [78–94] |

By writer role, over the first sample's 100 role-on-this-project rules:
builder 48 of 60 hold across projects, orchestrator 13 of 21, architect 8 of
13, prod-auditor 1 of 5. In the second sample: builder 46 of 48, seats 4 of
8, architect 3 of 4; by origin, stage writes 49 of 52 and seat writes 4 of 8.
Of the second sample's 7 project-specific writes, 5 are active, 1 left for
budget and 1 as stale; of its 53 that hold across projects, 20 are active,
13 left for budget, 9 were archived as task-specific, 9 merged or archived as
duplicates and 2 as already in code or instructions.
The 80 % of the conditional stratum is a statement about current texts of
rules that survived those exclusions; the 88 % of the second sample is the
one this design uses for what writers produce, with its one judge and its
possible lean.

### 1.7 Copies, citations and stage length

- **Copies.** 32 rule texts are held by more than one role's scope (74
  rows): the curator's "copy under each role" split for rules that several
  roles, short of every role, act on. No reader receives one twice.
- **Citations.** In 245 sampled stage transcripts of starts that carried
  rules, 34 (14 %) name a delivered rule id anywhere in the agent's own text
  or tool calls, 18 (7 %) outside a `leave_lesson` call; 39 of 19 042
  delivered ids were named. Agents follow rules without naming them, so
  citation alone cannot count use.
- **Stage length.** Model requests per stage conversation, same sample:
  Claude median 70 (p25 36, p75 118; n = 69), Codex median 88 (p25 58,
  p75 135; n = 176). Each request re-reads the start block from cache.

### 1.8 What the evidence supports

Observed:

- The binding limit is the stored scope. Builder scopes in four projects and
  three role-on-every-project scopes sit at 93–100 % of the bound. A quarter
  of last week's lessons left for budget; of all 185 budget archives, 163 had
  been curated and 134 came from fix rounds, after a median 16 hours.
- Delivery is whole-scope and above the curator's own target: a builder
  start carries about 23 KB and 87 rules.
- Writers file role-wide knowledge as project knowledge: of a uniform sample
  of last week's role-on-this-project writes, judged at the text each writer
  wrote, 53 of 60 hold across projects (88 % [78–94], one judge): stage
  writes 49 of 52, seat writes 4 of 8 (too few seat writes to say more).
  Two thirds of the active role-on-this-project rules do. The curator widens
  slowly (62 of 601 in a week) into a scope that is itself full.
- The curator's widening is accurate: 1 of 30 sampled role-on-every-project
  rules is project-specific.
- Machine rules are nearly all tool practices (14 of 16).

Inferred, with no measurement behind it yet:

- A larger store would keep the curated rules the bound now removes; whether
  agents do better with them is unmeasured. In the benchmark's traced cases
  the errors came mainly from delivered rules that were ignored or too narrow
  (`docs/design/memory-quality-benchmark.md` §3.5), so delivering more text
  has no measured benefit; delivering better-targeted text might.

## 2. Scope structure

### 2.1 What exists

Every role with a role id already reads four scopes: its role on this
project, its role on every project (`role:*:<role>`), the project and the
machine (`readableScopes`, `src/lib/memory/roleStore.ts:118`). The seat's
launch note was wrong on this point: builders, architects, critics and the
rest read their role-on-every-project scope today, and 144 active rules sit
there. What exists only for the curator is the write: a stage or a seat
writes `role`, `project` or `machine`, and the curator moves a rule to
`role:*:<role>` after reading the same role's rules in other projects
(`docs/design/role-memory-curation.md` §3.6, check 4). The rules window shows
that scope inside the role column under "Every project"
(`src/components/roleMemory/LearnedRules.tsx:320-323`), which is why the
operator's screenshot shows three columns.

Clean roles stay clean: reviewer, verifier, issue reporter and curator read
and write nothing (`CLEAN_ROLE_IDS`, `src/lib/memory/eligibility.ts:11`), and
so does any stage with a fail edge (`isReviewGate`,
`src/lib/roles/sizing.ts:34`). The pinned specification lists reviewer and
verifier among its examples of memory-eligible roles; the operator's
2026-10-07 rule governs, and this design keeps them clean. Their know-how
reaches them through their prompts (§3.4).

### 2.2 Options

| Option | What changes | For | Against |
| --- | --- | --- | --- |
| A. Curator widens only (today) | Nothing | No new path for project facts to reach other projects | 89 % of lessons land project-scoped; four projects' builder scopes fill with the same practices in different words; the widened scope is full anyway |
| B. Writer chooses "role on every project", gated | `leave_lesson` gains the level; a rule's current text reaches other projects only after the curator or the operator approves that text; a project-term hint at write time | Matches what writers produce (88 % of last week's role-here writes judged generic, one judge); one copy of a practice where four projects keep four today; the gate keeps an unreviewed project fact, or an unreviewed rewrite, inside its own project | One more choice in the lesson request; a curator pass per new or rewritten role-wide text before it travels |
| C. Every role lesson goes to "every project" by default; the curator demotes | Writers stop choosing between the two role levels | Simplest request | 12 % of last week's role-here writes (7 of 60; half of the seats' writes) are project-specific and would sit in the wrong scope until demoted; the gate would hold most of the scope back from other projects |
| D. Multi-role scopes (`roles:<a>+<b>`) | A scope read by a set of roles | Collapses 74 copy rows to 32 | Answers which roles read a rule, a question this requirement does not ask; deferred |

### 2.3 Earlier recommendation: option B (superseded)

Decision 1 in §7.3 retains curator-only role-wide writes. The agent-write
proposal below records the evaluated alternative; its visibility machinery,
project vocabulary and agent writes are excluded from implementation.

**The level.** `leave_lesson`'s `lesson.scope` gains `"every-project"`,
stored under `role:*:<role>` for the writer's role or the named `role`. The
seat may use it for the orchestrator and the maintainer. The tool keeps one
answer per request (`MAX_LESSONS_PER_ATTEMPT = 1`,
`src/lib/memory/roleTypes.ts:20`).

**How a writer decides.** The lesson request's level paragraph
(`src/lib/memory/roleRender.ts:106-111`) becomes:

```text
Choose the narrowest true level by who acts on the rule and where:
- every-project: only your role (or the role you name) acts on it, and it would change what that role does in a repository that has none of this project's files, commands, gates, product terms, domain or people. A rule about a general tool qualifies when it names the tool as its condition ("When a stage drives a browser, ...").
- role: only that role acts on it, and it depends on something this project owns: its paths, scripts, checks, deploy, product surfaces, domain terms or team.
- project: every role working on this project acts on it alike.
- machine: every role acts on it alike in any repository on this machine.
A rule written or rewritten for every project reaches other projects once the curator has approved that text; until then only agents of the project that wrote that text read it.
```

**What keeps a project fact out.** Four layers, none of which refuses on a
pattern alone:

1. **The writer's test** above, phrased as a counterfactual repository.
2. **A project-term hint at write time.** For an `every-project` lesson the
   server compares the rule's words with the writer's project vocabulary: the
   path segments and file stems of the repository's tracked files at the
   attempt's base, plus the project's name and aliases, minus every term that
   also occurs in another project's tracked paths. A match returns a hint
   ("names `<term>`, which only this project has") and stores the rule with
   that hint, as `rulePrivacyHints` does today; the agent may rewrite it at
   once. The vocabulary is computed once per project per day, bounded at
   5 000 terms, owned by the role-memory module. `assertGenericRule`
   (`src/lib/memory/roleProblems.ts:12`) keeps refusing file paths and
   defect statements at every level, as now.
3. **A visibility gate on the current text.** `curatedAt` and
   `keptByOperatorAt` cannot carry this gate: an agent rewrite keeps the id
   and spreads both markers into the new text (`versionedRule`,
   `src/lib/memory/roleStore.ts:255-262`, called from the rewrite path at
   :321), so a curated rule rewritten from another project would travel
   unreviewed. `revisedBy` cannot name the text's writer either: a curator
   pass replaces it on every rule it touches
   (`src/lib/memory/curation/apply.ts:207`), and curator Undo replaces it
   with the operator's own revision, which carries no source (:288). So a
   rule gains two optional fields, each keyed to the SHA-256 of a rule text,
   the hash the delivery ledger records (`roleStore.ts:210-212`):

   - `approved: { hash, at, by }`: the curator or the operator approved that
     text;
   - `writtenBy: { hash, projects }`: agents of these projects wrote that
     text (more than one only when a lesson from another project merged into
     it as a duplicate).

   When the block is rendered for a reader in project P, a rule in
   `role:*:<role>` is included when `approved.hash` equals the hash of its
   current text, or when `writtenBy.hash` equals it and P is one of
   `writtenBy.projects`, compared through `canonicalProject` so that a
   project whose key moved still matches. Neither test reads `revisedBy`.
   What each write path does to the two fields:

   | Write path | Text in force afterwards | `approved` | `writtenBy` |
   | --- | --- | --- | --- |
   | Agent or seat lesson, new rule | the new text | none | its hash, the writer's project |
   | Lesson merged as a duplicate into an existing rule (`appendRule`, `src/lib/memory/roleConsolidate.ts:80`) | unchanged | unchanged | the writer's project added when `writtenBy.hash` matches the target's text; otherwise set to that hash and that project |
   | Agent or seat rewrite (`roleStore.ts:321`) | the new text | spread from the old text, so it no longer matches | set by the rewrite path to the new hash and the rewriter's project |
   | Curator pass: every rule it leaves active in a scope it partitions, text edited or not (rank, move, merge target, split part, return) | as the pass leaves it | that text's hash, set where `curatedAt` is set (`apply.ts:207-210`) | unchanged |
   | Curator Undo (`revertCuratorPass`, `apply.ts:288`) | the text before the pass | the value before the pass | the value before the pass |
   | Operator Return (`restoreRule`, `roleStore.ts:383`) | unchanged | that text's hash | unchanged |
   | Operator Revert (`revertRule`, :412) | the earlier text | that text's hash | unchanged |
   | Operator delete (`deleteRule`, :364) | archived, read by nobody | unchanged | unchanged |
   | Budget archive; succession of a project key | unchanged | unchanged | unchanged |

   Undo needs no lookup for these fields. A pass keeps every field of each
   rule it partitions, apart from `rule`, `why` and `hints`, as
   `prior.fields` in its scope history entry (`apply.ts:200-209`), and Undo
   writes those fields back with the earlier text, overriding only
   `versions`, `changedAt` and `revisedBy` (:288); `approved` and
   `writtenBy` come back as they were before the pass. The sequence the
   critique traced: project P writes a role-wide rule; project Q rewrites it,
   so `writtenBy` names Q at the new hash and the old `approved` no longer
   matches; a pass approves Q's text, by rank alone or with an edit; Undo
   restores Q's text with the stale `approved` and with `writtenBy` naming Q
   at that text's hash. The text renders for Q and for no other project, P
   included, as it did before the pass, and nothing approves it. Version rows
   keep each replaced text together with the two fields it had.

   An agent rewrite approves nothing, so between the rewrite and the next pass
   other projects receive nothing for that rule; giving them the last
   approved text instead is deferred. The rewrite path's readability check
   and its closest-id suggestions (`roleStore.ts:306-317`) read through the
   same gate, so an agent can rewrite only a role-wide text its own start
   could show.

   **A row may lack either field.** One written before this change lacks
   both; one restored by the Undo of the first pass that wrote `approved`
   lacks `approved` again. Each missing field falls back on its own. A
   missing `approved` falls back to the store's own test of whether the text
   in force awaits curation (`roleStore.ts:493-498`), which ignores undone
   passes: the rule is approved when that test says it does not, or when the
   operator kept it and no agent revised it afterwards. A missing
   `writtenBy` is derived from the record, first match wins:
   `revisedBy.source.project` when the latest revision is an agent's; when it
   is an operator Revert or a curator Undo that names a version
   (`revertedTo`), the same derivation applied to that version row, which
   keeps the revision that wrote its text; when it is the operator revision
   of an Undo whose pass changed no text, the same derivation applied to the
   `revisedBy` in that pass's `prior` entry for the rule, the entry whose
   `revertedAt` equals the revision's time (entries of passes are never
   trimmed, `roleStore.ts:48-51`); `source.project` when the rule was never
   revised. When nothing resolves, no project reads that text until a pass
   approves it. A pass that partitions a rule without `writtenBy` writes the
   derived value into the row and into the rule's `prior` entry, so the
   derivation drains with the next pass over each scope and an Undo of that
   pass restores what it derived.

   A new role-wide lesson is therefore active at once for its own project
   (the operator's 2026-10-11 answer) and travels after the curator approves
   it; a rewrite of an approved rule stays with its writer's project until
   its own text is approved.
4. **Curator demotion.** Check 4 of the curator's checklist gains one
   sentence: a rule in `role:*:<role>` that names anything one project owns
   moves to `role:<source project>:<role>`, or splits into a general part
   there and a project part here. Hinted rules are read first. The `move`
   and `split` operations exist (`src/lib/memory/curation/apply.ts:21`).

The monthly blind sample (§6) measures what gets through: project-specific
share of `role:*` rules, 3 % today, target at most 5 %.

**Expected effect.** If the 65 % of role-on-this-project rules that hold
across projects moved to the role's every-project scope, builder role-here
scopes would drop to about a third of their bound, and `role:*:builder`
would need room for the general part of four projects' builder rules (about
25 000 code points before the curator merges what the four projects say
alike). §4 sizes the bounds for that.

## 3. Layers of abstraction

### 3.1 Options

| Option | Shape | For | Against |
| --- | --- | --- | --- |
| L0. Flat (today) | One list per scope; the curator merges by "keep every condition" | Nothing to build | Merges compress: 54 % of rewritten rules carry slash or semicolon chains (`memory-quality-benchmark.md` §3.2); principle and quirk compete for one bound |
| L1. A layer field on each rule | `layer`, one of principle, practice or specific, set by the writer as a hint and by the curator authoritatively; scopes unchanged | Layer is independent of who reads (scope); selection and bounds can treat layers differently; no new scope keys for old code to misread | One field, one curator check |
| L2. A scope per layer | `principle:<role>`, `practice:<role>:<project>`, … | Bounds per layer for free | Multiplies scope keys and reads; old releases treat an unknown key as a project (`role-memory-curation.md` §2) |
| L3. L1 plus a parent link | A practice or specific names one principle it serves (`parent`); a principle lists its children | Specifics render under their principle and need not restate the reason; the curator sees a class and its instances together | A link to maintain on merge and split |

### 3.2 Recommendation: L3

- **Principle**: names no tool, product, file or project; one sentence of at
  most 200 code points; holds for the role in any repository. Lives in
  `role:*:<role>` or `machine`. In the first blind sample 40 % of active
  role-here and 50 % of active role-wide rules were of this kind, and in the
  second 34 of 60 of last week's role-here writes.
- **Practice**: a trigger and a check ("When X, do Y before Z"); may name a
  general tool as its trigger; at most 300 code points. Lives at any level.
- **Specific**: a fact a practice needs in one project or one tool version
  (a command, a gate's budget, a quirk). Lives in `role:<project>:<role>`,
  `project:<project>` or `machine`.

`parent` is optional and points at one principle readable by the same
reader. Rendering puts each principle first with its selected children
indented under it; a child whose parent is not delivered renders alone.

### 3.3 Consolidation keeps each layer at its level

The curator's checklist gains a "Layer" check between Level and Duplicates:

1. A principle that names a tool, product, file or project term is rewritten
   as a practice, or split into a principle and a practice.
2. A practice with no trigger is rewritten with one.
3. A specific whose tool, command or project fact is gone is `stale` (check 2
   already covers the evidence).
4. Merges happen within one layer. Two practices that state one class merge;
   a practice is never merged into its principle, it is linked to it.
5. Before compressing a merged rule past 300 code points the curator splits
   it (benchmark item 5).
6. A principle with no children and backed by one task after two passes is
   reconsidered as a practice.

The server's check on `apply` gains two structural tests: a `parent` must
name an active principle readable by every reader of the child's scope, and
a principle must fit 200 code points. Which layer a rule belongs to stays
the curator's judgement.

### 3.4 The top of the stack flows into prompts

A principle that every reader of a role acts on, backed by two or more tasks
in two or more projects, is the candidate for that role's shipped prompt
through the existing promotion flow (`role-memory-to-prompts.md` §5.3). On
merge the next curator pass archives it as `in-instructions`. That is how the
clean roles learn, and it keeps the always-on principle layer small: memory
holds the levels below the prompt.

## 4. Bounds

### 4.1 Today

| Limit | Value | Enforced by |
| --- | --- | --- |
| One scope's rendered lines | 10 000 code points, a target | `retainRules` archives rules a curator has seen until the scope fits and stops when only unseen lessons remain (`src/lib/memory/roleConsolidate.ts:60-73`; the constant's comment calls it a target, `roleTypes.ts:10`); a curator pass cannot leave a scope above it (`curation/apply.ts:188`) |
| A role's four scopes | 16 000 bytes | the curator brief only; builders start with 23 KB |
| One start's block | 120 000 bytes | `renderLearnedRulesSelection` (`src/lib/memory/roleRender.ts:36`), never reached |
| Orchestrator four-scope target after an import trigger | 24 000 bytes | the curator brief (`fourScopeTarget`, `src/lib/memory/roleTypes.ts:166`) |

### 4.2 Store targets (what a scope keeps active)

With selection (§5) the store and the start block stop being one number. The
store target becomes curation pressure, and the start budget becomes what an
agent reads.

| Scope | Today | Proposed | Why |
| --- | ---: | ---: | --- |
| Role on every project | 10 000 | 30 000 | Receives the general part of four projects' role rules (§2.3) |
| Role on this project | 10 000 | 20 000 | Keeps the curated rules the bound removed last week (163) with room to churn |
| Project | 10 000 | 15 000 | Nearly empty today; no evidence for more |
| Machine | 10 000 | 15 000 | 36 % full; tool practices grow with tools |

In tokens, at about four bytes per token for English rule text: 30 000 code
points are about 7 500 tokens, 20 000 about 5 000, 15 000 about 3 750. At its
targets a builder's pool is 80 000 code points (about 300 rules at today's
mean length, about 20 000 tokens), under the conditions below; only the
selector reads it, against 23 000 bytes delivered whole today. The curator
reads a scope in 24 KB pages, so a 30 000-point scope adds one or two pages
per pass; pass time is not measured at that size. The rule that only curated
rules leave for budget (`docs/design/memory-delivery-ledger.md`) stays.

**These values are targets, as today's 10 000 is.** `retainRules` archives
only rules a curator pass has seen and stops when none is left
(`roleConsolidate.ts:60-73`), and the start snapshot applies the same routine
(`roleStore.ts:208`). So at any start a scope holds at most the larger of its
target and the lines of its rules no pass has seen (its unseen lines), and
the pool a selector reads is at most the sum of those four maxima. A
successful pass cannot leave a scope above its target (`apply.ts:188`), so
the pool exceeds the sum of the targets only while one scope's unseen
lessons alone exceed its target. Nothing in the store prevents that: in a
probe of this commit's `retainRules`, 100 distinct unseen 300-point lessons
in one scope with a 20 000 target all stay, 32 399 code points, and four
such scopes under the four proposed targets keep 129 596 with no budget
archive.

How large the unseen part is in practice, from the ledger rows to `T` and
the curator pass history (§1.1, appendix): in the 1 028 builder starts, the
scope with the most unseen lines held a median 921 code points of them, p90
4 482, at most 6 661; all four scopes together held a median 1 092, p90
4 905, at most 7 271. In the 1 539 starts with rules, no delivered
scope exceeded today's 10 000 (the largest held 9 998), and no other role's
unseen lines exceeded 2 627 in total. The unseen part is set by the write
rate and the time between successful passes, so larger targets should leave
it about this size.

**When the size and cost figures hold.** The 80 000-point pool, and the
pool-based token and Jev figures of §4.4 and §5.5, hold while no scope's
unseen lessons exceed its target. In the window above they reached at most
6 661 against the smallest proposed target of 15 000. A scope passes its
target on unseen lessons alone only when its project's curator fails for as
long as it takes to write a target's worth: about 72 lessons of today's mean
length for a 20 000 role-here scope, 1.6 to 2.7 days of builder A's 27 to 46
a day. The delivered block's figures do not depend on
this: the hard maximum caps every start (§4.3).

**An over-target pool.** Nothing is withheld from the candidates to make a
pool fit. Every active rule that passes the visibility gate is a candidate
from the first start after it was written; under selection that is what the
operator's 2026-10-11 "active at once" means, the same footing every other
active rule has. In modes `whole` and `no-brief` an unseen lesson is the last
kind of rule a cut removes, the newest last of all (§5.1). The selectors
differ only in what a large pool costs. BM25 runs locally in linear time and
reads any pool. Jev reads a pool of at most 120 000 code points of candidate
lines, one and a half times the nominal pool; a larger pool takes the `bm25`
row of §5.1 with the reason `jev-pool`, which caps Jev's spend per launch at
about $0.0026 (the pilot's median $0.00059 per case at a 27 285-point pool,
scaled by pool size, brief repeats included). The delivered block stays under
the same 24 000-byte maximum whatever the pool holds.

### 4.3 The start budget and one hard maximum

These delivery bounds begin in slice 4. Slice 1 retains current whole-scope
delivery and its existing 120 000-byte argument guard.

- **Always-on**: the role's principles, the machine's principles and rules
  the operator kept, walked in curator rank order and added while their
  lines stay within 3 000 code points; a rule that does not fit becomes a
  candidate for selection.
- **Selected**: practices and specifics chosen per launch (§5), filling up
  to 9 000 code points.
- **One hard maximum per launch: 24 000 bytes** of rendered block for every
  role and engine, enforced in `renderLearnedRulesSelection` on every path:
  selected, fallback, seats, maintainers. The 120 000-byte argument limit
  remains an outer safety net. The selected-delivery maximum covers the seat's
  p90 start today (17 996) and the builder's median (22 851).
- **The always-on set is reserved first.** The renderer receives the
  always-on ids as protected, and no pack or cut on any path removes one
  (§5.1). They always fit: 3 000 code points of rule lines are at most
  12 000 UTF-8 bytes, since a code point takes at most four, and the rest of
  the block (heading, notice, scope headings, pointer) is at most 1 427
  bytes for any role today, the seat's, which has the longest notice and
  pointer (759 for a builder, 771 for the longest stage role title). In a probe of this commit's renderer, an always-on set at its
  3 000-point cap written in four-byte characters rendered to at most 11 534
  bytes for a builder, a seat, a maintainer and a visual critic, so at least
  12 466 bytes are left for other rules under the revised maximum.
- **What each number counts.** A budget in code points (the store targets,
  always-on, selected) counts the rule lines exactly as the renderer writes
  them, `- [<id>] <rule>` (`ruleLine`, `src/lib/memory/roleConsolidate.ts:19-21`),
  joined by newlines into one list (`scopeChars`, :24-26), across scopes
  for the always-on and selected sets; with today's 18-character ids that is
  the rule's own length plus 23 per rule plus one per separator. It leaves
  out the block's heading, notice, scope headings and closing pointer. The
  hard maximum counts the UTF-8 bytes of the whole block as the engine
  receives it, all of those included, which is the ledger's `bytes`. On the
  pilot's pools (§5.5) the heading, notice, scope headings and pointer added
  about 730 bytes, and UTF-8 bytes exceeded code points by under 0.1 %, so a
  start at the always-on and selected ceilings (12 000 code points) is about
  12 750 bytes. In text of two or more bytes per code point the byte test of
  the pack (§5.1) stops the selection before its 9 000 points.

### 4.4 What a start costs, per engine

Tokens are estimated at four bytes per token; no provider tokenizer was run.
Prices are the repository's own table (`src/lib/activity/tokenPrices.ts`,
read 2026-10-18): Claude Opus 5.5 input $4 per million, cache write ×1.25 for
five minutes or ×2 for an hour, cache read $0.20; Codex `gpt-6.1-sol`
standard $2 input and $0.10 cached, Fast $4 and $0.20. Work on a subscription
is billed by plan, so these are API-equivalent figures, the same proxy the
repository uses to weigh account limits. The block is written to cache once
and read back on each later request: Claude 70 requests and Codex 88 at the
median (§1.7).

| Block | Claude Opus 5.5 per stage (5-min / 1-hour write) | Codex standard per stage | Codex Fast per stage |
| --- | --- | ---: | ---: |
| Builder today, about 22.9 KB | $0.107 / $0.125 | $0.061 | $0.122 |
| Hard maximum, 24 000 bytes | $0.113 / $0.131 | $0.064 | $0.128 |
| Selected start at its ceilings, about 12 750 bytes | $0.060 / $0.070 | $0.034 | $0.068 |

At last week's builder volume (about 991 Codex and 317 Claude stage
conversations a week, starts from the ledger divided by 1.12 starts per
conversation), whole-scope builder blocks cost about $61 (Codex standard) and
$34–40 (Claude) a week; selected starts at their ceilings about $34 and
$19–22. Selection
itself costs about $0.0006 per launch at today's pool (§5.5), about $1.2 a
week for every start that carries rules, and about $3 a week at a pool two and
a half times larger. Those pool figures hold under the conditions of §4.2; a
pool over 120 000 code points skips Jev, so no launch spends more than about
$0.0026 on it. The block figures in the table hold for any pool.

- **Context.** 24 000 bytes is about 6 000 tokens: 0.6 % of Claude's 1M
  window and under 3 % of the 272 000 tokens past which OpenAI prices a
  prompt higher.
- **Cache.** The block sits in Claude's appended system prompt and Codex's
  developer instructions, both inside the cached prefix, so a smaller block
  lowers every later request's read. A block that changes between engine
  starts of one attempt would break the cache; the delivered block, text
  included, is frozen per attempt (§5.4).
- **Latency.** Not measured end to end. Jev answered in 462 ms median and
  605 ms p95 per request in the pilot; a launch's batches run in parallel, so
  selection adds about half a second at the median. No claim is made for the
  prefill time saved.

## 5. Selection

### 5.1 One delivery policy

One setting, `memory.delivery`, takes one of three values: `whole` (today's
delivery, the default until slice 4 is accepted, and the rollback), `bm25`
and `jev`. A separate shadow switch (slice 1) computes and records
selections beside a `whole` delivery and delivers none of them. The terms
every row of the table uses:

- **Candidates**: the active rules of the reader's four scopes that pass the
  visibility gate (§2.3), seen by a curator or not and however many there
  are (§4.2), minus the always-on set.
- **Always-on**: rules the operator kept and, once layers exist (§3), the
  principles of the role's every-project scope and of the machine, walked in
  curator rank order and added while their lines stay within 3 000 code
  points; one that does not fit is a candidate. Their ids are protected in
  the render.
- **Curator rank**: the order `learnedRulesSnapshot` renders today
  (`roleStore.ts:196-212`): scopes in reader order (role here, role on every
  project, project, machine) and, within a scope, the order its row keeps
  (operator-kept, then curated, then awaiting curation). A rule's rank is
  its scope's position, then its position in the scope.
- **Brief**: the pipeline task, specification and stage prompt, cut and
  redacted as in §5.2.
- **Pack**: walk an ordered list once; add a rule when the selected lines,
  measured as in §4.3, stay within 9 000 code points and the block rendered
  with the always-on set, the rules already added and this one stays within
  24 000 bytes; skip a rule that fails either test and keep walking. One
  order gives one result, and no cut follows a pack.
- **Render**: always-on and chosen rules grouped by scope in curator rank
  order, so scores decide membership and never the text's order, through
  `renderLearnedRulesSelection` with a 24 000-byte ceiling and the always-on
  ids protected.
- **Cut**: only the rows that pack nothing (`whole`, `no-brief`,
  `selector-error`) can render more than 24 000 bytes before the cut. Today's
  cut pops the last rule of the scope with the most bytes, whatever it is
  (`src/lib/memory/roleRender.ts:40-47`); that removes always-on principles
  once rule text takes two or more bytes per code point (probe below), and
  removes the newest lessons first, because each scope lists them last. The
  cut becomes: never a protected rule; first rules a curator has seen that the
  operator did not keep, the lowest-ranked of the scope whose such lines have
  the most bytes (today's choice, narrowed to them); then kept rules beyond
  the always-on cap, chosen the same way; then rules no curator has seen,
  oldest first. Up to its last step that is the store's own leaving order
  (`leavingOrder` and `retainRules`, `roleConsolidate.ts:51-73`), so the
  newest lesson is the last line any cut removes. The cut always ends at or
  below 24 000 bytes, because the protected set alone fits (§4.3).

**Probe of the cut and the pack.** A scratch export of this commit,
synthetic rules with distinct texts and 18-character ids: thirteen 200-point
principles in the machine scope (2 911 code points, inside the always-on
cap) and nine curated 300-point practices in each other scope (8 747 code
points as one list). This historical probe used the originally proposed
20 000-byte maximum. Today's cut at 20 000 bytes keeps all 40 rules in
one-byte text (12 377 bytes) and drops 1, 5 and 6 principles in two-, three-
and four-byte text (the critique's own mix of texts dropped two). With the
pack and the cut above, on those cases and on a second set whose reader
scope holds 100 unseen 300-point lessons, for a builder, a seat and a
maintainer reader, in `whole` mode and in a selected mode, all thirteen
principles stayed in all 48 cases, no block exceeded 19 871 bytes, and every
`whole` cut kept the newest unseen lesson.

| Case | What is packed, in which order | Reason on the ledger row |
| --- | --- | --- |
| Mode `whole` | No selector runs and no 9 000 budget applies: every candidate and the always-on set in curator rank order; the cut above brings the block within 24 000 bytes | `whole` |
| No brief (seats, maintainers), any mode | As `whole` | `no-brief` |
| Mode `bm25` | Candidates by BM25 score of brief against rule, highest first; equal scores, including every rule that scores 0, in curator rank order, then by id. No threshold: BM25 scores are not probabilities, so the pack fills toward 9 000 | `bm25` |
| Mode `bm25`, no candidate shares a term with the brief | The same row, whose order is then curator rank order | `bm25-no-match` |
| Mode `jev`, every batch answered with a probability for every candidate within 3 seconds | Candidates with probability at least 0.3, highest first; equal probabilities in curator rank order, then by id. Rules below 0.3 are never added, so the pack can stop short of 9 000 | `jev` |
| Mode `jev`, any batch refused, failed, timed out, malformed or missing a candidate; no key; the key's own limit reached; Delegatus's monthly selection cap spent; the candidates' lines above 120 000 code points (§4.2) | The `bm25` row over all candidates. Scores of two selectors are never mixed | `jev-` and the cause (`jev-pool` for the last), then `bm25` |
| The selection code itself throws | The `whole` row | `selector-error` |
| A later engine start of an attempt with a frozen block (§5.4) | Nothing is packed: the frozen block, whatever the mode is now | `frozen` |

Rollback is the first row: switching the setting to `whole` stops both
selectors for every attempt that has not yet frozen its block, and attempts
already frozen finish on the block they started with. Every row ends in the
same render under the same 24 000 bytes with the always-on set whole, and
none blocks a launch. The
reason is on the start's ledger row and in a status line the Memory page
shows.

### 5.2 The Jev request

The shape follows the grounded arm of `docs/research/memory-selection.md`
(the offer inside its own question, explicit criteria, rubric examples
written without tuning to labels), reframed for a stage launch:

- `state`: the task ("an agent of role R is about to start the work in
  brief; decide for each proposed rule whether it should be given at the
  start"), the role, the project letter, the brief (pipeline task up to
  2 000 characters, specification up to 8 000, the stage prompt up to 3 000),
  and a rubric with three invented examples. Text passes the classifier's
  redaction (`redactForClassifier`, `src/lib/asks/jev.ts`) and the harness's
  credential-line filter.
- `questions`: one `noul` question per rule, keyed by an opaque hash: "The
  proposed learned rule should be given to the agent at the start of this
  work", with the rule text.
- Model `typesafe/jev-1.13`, endpoint and price as in `src/lib/asks/jev.ts`.

This sends rule text and stage briefs to OpenRouter and the Jev provider, a
flow that does not exist today for learned rules (the asks classifier already
sends agent messages there). Shadow measurement is authorized by decision 2 (§7.3); selected delivery
remains gated on the second pilot.

### 5.3 The cheaper selector

BM25 is computed locally over the candidates as the corpus, the brief as the
query: text in NFKC lower case, runs of three or more letters or digits as
terms, a short English stop list, `k1 = 1.2`, `b = 0.75`, and
`idf = ln(1 + (N − df + 0.5) / (df + 0.5))`, the formula the pilot used
(§5.5). It is the primary selector in mode `bm25` and Jev's only fallback in
mode `jev` (§5.1). It needs no network, no key and no new data flow. In the
pilot it kept the grounded positive in 20 of 24 cases at 8 000 code points
under the exact measure; the pilot cannot say how that compares with Jev at
equal budget (§5.5), which is what the second pilot measures (§5.6). The
pilot met one of the fallback causes: the key's own limit answered 403.

### 5.4 Where it runs

Once per stage attempt, in the pipeline engine's launch path where
`stageMemoryForLaunch` decides eligibility
(`src/lib/memory/roleStage.ts:30-33`), before the spawn: asynchronous, under
the 3-second deadline, registered with the loop monitor as
`memory.select`. Ids alone cannot hold a block still: an agent or curator
rewrite changes a rule's text under the same id (`roleStore.ts:255-262`), a
launch reads the current active rows (:196-212), and moves, merges, splits
and archives change which rows are active. So the attempt freezes its
content.

- **What is frozen.** The whole learned-rules block of the attempt's first
  engine start, whichever row of §5.1 produced it (always-on, selected,
  `whole`, a fallback): the rendered string, at most 24 000 bytes from
  slice 4 on (before it, today's whole block; the largest delivered to `T`
  was 25 004 bytes with 96 rules), and its
  ordered entries, each a scope, a rule id and a hash, the SHA-256 of the
  rule text the ledger already records (`roleStore.ts:210-212`).
- **Where.** A new collection, `role_memory_selection`, one row per pipeline,
  stage and attempt, written once by the launch path before the attempt's
  first engine start, in one transaction that keeps an existing row; a start
  that races it reads the row that transaction kept. Old releases
  never open the collection, and `role_memory` gains no row kind (its strict
  decoder would refuse one, `role-memory-curation.md` §1).
- **What the row holds.** Its key (pipeline, stage, attempt); `createdAt`;
  the release that rendered it; mode, shadow flag, selector and selector
  version; the reason; the reader's four scope keys, once; `block`, the
  rendered string; `entries`, one `[scope index, id, hash]` per rule in the
  block, in block order; `scores`, one `[id, score]` per selected rule only,
  three decimals, none without a selection; in shadow these scores belong
  only to candidates chosen in shadow. During the shadow week `shadowIds`, the
  ids the selector would have delivered, which the first start's ledger row
  also carries for the recall of §5.6; and `removed`, the operator deletions
  below.
- **Every later start of the attempt** (fresh, resume, boot adoption,
  account migration: the six builders that call
  `learnedRulesForLaunchProfile`) delivers the stored string byte for byte.
  Rewrites, curator passes, moves, merges, splits, budget archives and
  approvals that happen in between do not reach it; each start's ledger row
  carries the frozen ids and hashes and the reason `frozen`.
- **The one permitted change: an operator deletion.** When the operator
  deletes a rule that is in a frozen block (`deleteRule`, `roleStore.ts:364`,
  the operator's way to withdraw a rule for any reason, privacy included),
  the attempt's next start re-renders the block from the stored entries
  without that rule, through the same renderer, stores the new string, and
  records `{ id, reason: "deleted", at }` on the selection row and on that
  start's ledger row. The entries resolve to their exact texts by hash,
  because no rule row is ever deleted (`roleStore.ts:30-34`) and every text
  change keeps the replaced text as a version row (`versionedRule`; the
  curator's apply uses it too, `apply.ts:206`); an entry that no longer
  resolves is dropped the same way with the reason `unresolved`. The block
  only loses lines, so it never grows.
- **Not frozen.** Seats and maintainers have no attempt; they render at each
  start as today.
- **Retention.** A selection row is removed one day after its attempt
  settles; the ledger keeps the ids, hashes and reason. The stored strings
  are rule texts that already live in `role_memory`, so the stored-lesson
  privacy matcher already covers them.
- **Size, an estimate.** Rows serialized with `JSON.stringify`, every field
  above included, from blocks this commit's renderer produced from synthetic
  ASCII rules, with scope keys of the stored keys' length (51 to 57
  characters) and the longest stage id and attempt the ledger holds; bytes of
  serialized JSON, the block column with its escapes:

  | Row | Rules in the block | Block | Entries | Scores and shadow ids | Whole row |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Selected start at its ceilings, rules of today's mean length (252) | 43 | 12 642 | 3 957 | 925 | 17 975 |
  | `whole` at the maximum, mean-length rules | 69 | 19 844 | 6 349 | 0 | 26 646 |
  | That `whole` block and a 32-rule shadow selection | 69 | 19 844 | 6 349 | 1 598 | 28 254 |
  | Shadow week, before the hard maximum: a block the size of the largest delivered to `T`, and a 32-rule shadow selection | 96 | 25 211 | 8 833 | 1 598 | 36 105 |
  | 25 rules of 240 characters per scope, cut at the maximum | 73 | 20 076 | 6 717 | 0 | 27 246 |
  | Rules of the 20-point minimum; a shadow selection packed to 9 000 points | 438 | 20 444 | 40 297 | 10 180 | 71 384 |

  The table follows a per-field sum: each entry costs 92 bytes
  (`[0,"<18-character id>","<64 hex>"]` and a comma), each score 29, each
  shadow id 21; the block costs its UTF-8 bytes plus two quotes, one byte
  per line break and one per quote or backslash; the remaining fields come
  to about 460 bytes. From slice 4 on, the design
  bounds each part of a row: the block (24 000 bytes of UTF-8; the
  historical size table above used the original 20 000-byte proposal), the entries
  (one per rule in the block) and the scores and shadow ids (one per
  selected rule, within the 9 000 points of the pack), so the last row is the
  largest a block can produce under today's lesson limits (rules of at least
  20 code points). Before slice 4 the block is today's whole block, which
  only the 120 000-byte argument limit caps; the shadow-week row above uses
  the largest one delivered. Three assumptions are not enforced. First,
  JSON spends one more byte on a quote or backslash and five more on a
  control character, and the lesson limits do not forbid control
  characters; of the 2 809 rule and version texts stored at the third read,
  none held one, 17 held a quote or backslash, and escapes added 0.01 % to
  their length. Second, before slice 4 a block grows with its scopes, which
  today's 10 000-point targets keep near the size above. Third, the number
  of rows is not capped: a row lives from the first start of its attempt
  until a day after the attempt settles. In the ledger to `T`, 1 179 stage
  attempts had a first start that carried rules, 240 a day and at most 362
  within any 24 hours; with the attempts still running, about 400 rows at
  that peak. At that count the collection holds at most about 14 MB in the
  shadow week if every row were as large as the fourth, about 7 MB once
  selected delivery runs (rows like the first), and about 29 MB if every rule
  were of the minimum length. The first version of this section printed 300
  rows of at most 25 KB, under 8 MB, without entries or scores; a 73-rule
  block with entries written as objects serializes to 30 622 bytes before
  any other field (29 614 in the critique, with shorter scope keys).

A start that finds no selection row (the row was never written, or the
release predates slice 1) renders per §5.1, freezes that block as the
attempt's, and records why.

In a fix round the same scorer runs once more over the handed findings, and
the lesson request lists the ids of the three rules nearest each finding, so
the fixer can rewrite the rule that names the class and leave no near
duplicate behind (benchmark item 4).

### 5.5 The offline pilot

**Run, partially, within the cap.** Spend $0.014083 of the $2.00 cap,
335 304 input tokens, 65 answered requests and one refused. The planned 60
cases (234 requests, worst case $0.263 by the byte bound) stopped at request
66 with HTTP 403: the OpenRouter key's own spending limit of $3 was reached.
The key had about $0.02 left before the pilot started, and the asks
classifier uses the same key (§Notes). An error status bills nothing
(`jevFailureCostUsd`, `src/lib/asks/jev.ts`). Private inputs and the Jev
answers stayed in the first stage's scratch directory and were removed with
it. Figures computed from Jev scores are therefore given as that stage
recorded them and cannot be recomputed without paying for the calls again;
the case set, the sizes, the BM25 figures and the delivery checks below were
recomputed by the revision from the rolled-back export (§1.1). The 24
completed cases are the first 24 of the plan, whose 65 requests precede the
refused one.

**Population and labels.** Positives come from fix-round rewrites: a fixer,
after the review's findings, rewrote a builder rule it had been given
because the rule named the class of a finding and was too narrow. The
positive is that rule at the text the fix round replaced. From 294 builder
rewrite requests: 113 were dropped because the rule was created after the
lane's first builder attempt started, 18 were not fix rounds, 24 lanes had no
separate first builder stage, 32 repeated a lane; 107 remained (A 79, C 14,
D 9, B 4, E 1). The plan took every case outside A and 32 of A by hash order.
The 24 cases completed before the 403 are all outside A: B 3, C 13, D 7, E 1.

The replaced text was chosen as the first version row written within six
hours after the lesson request. The revision checked that choice against the
row that follows each version, whose `revisedBy` names the attempt that
wrote it: the two agree for 22 of the 24 cases; for 2 a later curator touch
had overwritten that source, and the timestamp choice stands unverified.

**Was that text delivered to the first builder?** The ledger records the
rule ids and text hashes of every engine start. For the first engine start
of each case's first builder attempt:

| | Pilot cases | All eligible lanes |
| --- | ---: | ---: |
| Received the positive's exact text (hash match) | 15 | 53 |
| Started before the ledger's first row (2026-10-16 23:11 UTC), cannot be checked | 8 | 43 |
| Received an earlier revision of the same rule, rewritten after that start | 1 | 11 |
| The rule was absent from a recorded start | 0 | 0 |
| Total | 24 | 107 |

Only for those 15 is the positive a text the first builder received and that
still failed to prevent its finding; 14 of them also pass the version check
above, and the fifteenth rests on the timestamp choice. For the other 9 the
positive is the text a fix round found too narrow, of a rule created before
the first builder started. Jev's per-case answers are gone, so the Jev
figures below cover all 24 and cannot be split; the BM25 figures are given
for both.

**Pool.** The builder's four scopes at the cutoff: active rules plus rules
archived for budget (the larger pool a raised bound would keep), with the
positive at its replaced text and its current text removed. Mean 106 rules;
16 % of them budget archives. Measured as §4.3 defines it, their rule lines
come to 27 285 code points (22 750 for the active rules alone) and 27 309
UTF-8 bytes; rendered as a whole block with heading, notice, four scope
headings and pointer, 28 036 bytes (23 500 for the active rules alone). The
first version of this document counted each line as its rule's length plus
22 with no separators and printed 27 074, short by one code point per rule
and one per separator.

**Inputs.** Pipeline task, specification and the first builder stage's
prompt template, redacted, as in §5.2.

| Policy | Mean rules offered | Mean code points of rule lines | Grounded positive kept [95 % Wilson] |
| --- | ---: | ---: | --- |
| Jev ≥ 0.9 | 0.1 | about 25 | 0 of 24 [0–14] |
| Jev ≥ 0.7 | 3.8 | about 1 020 | 5 of 24 [9–40] |
| Jev ≥ 0.5 | 13.3 | about 3 516 | 15 of 24 [43–79] |
| Jev ≥ 0.3 | 31.8 | about 8 145 | 20 of 24 [64–93] |
| Whole pool | 106 | 27 285 | 24 of 24 |

Rules offered and positives kept per threshold are as recorded; they do not
depend on size. The Jev sizes are the recorded means converted to the exact
measure, which adds 2 code points per offered rule and subtracts 1 per case
with any rule offered; rounding of the recorded means leaves them ±2.

| Budget, code points of rule lines | BM25, 24 cases | BM25, 15 delivered cases | Random, expected |
| ---: | --- | --- | ---: |
| 2 000 | 11 of 24 [28–65] | 7 of 15 [25–70] | 7 % |
| 4 000 | 13 of 24 [35–72] | 9 of 15 [36–80] | 15 % |
| 8 000 | 20 of 24 [64–93] | 14 of 15 [70–99] | 30 % |
| 12 000 | 22 of 24 [74–98] | 14 of 15 [70–99] | 45 % |
| 16 000 | 23 of 24 [80–99] | 15 of 15 [80–100] | 60 % |

BM25 packs by the walk of §5.1 under the exact measure; equal scores keep
the pool's export order, since the pilot had no curator rank. Under the first
version's approximate measure the same packs kept the positive in exactly the
same cases (0 of 120 case and budget pairs changed). The first version also
printed Jev at these budgets; those counts came from the approximate measure
and from scores that no longer exist, so they are withdrawn. That BM25 did
not move suggests they would have moved little, which is an inference and
nothing more.

- Under Jev the positive ranked in the top 8 % of its pool at the median
  (p25 3 %, p75 23 %), as recorded; under BM25, recomputed, in the top 11 %
  (p25 4 %, p75 23 %). Its median Jev probability was 0.62 against 0.17 for
  the other rules (p90 0.53), as recorded.
- Score bands over all 2 521 non-positive candidates, as recorded: 70.6 %
  below 0.3, 17.3 % from 0.3 to 0.5, 12.1 % at 0.5 or more. BM25 scored 4.5 %
  of the pool at zero on average and never the positive.
- **Judged relevance**, as recorded. Eight cases drawn by hash; in each, five
  rules Jev scored at 0.5 or more and five below 0.3, mixed in hash order
  with the scores hidden; one judge (the first stage's agent) asked whether
  each rule applies to the brief's work. Relevant: 31 of 40 at 0.5 or more,
  78 % [62–88]; 1 of 40 below 0.3, 3 % [0–13].
- Spend per case, as recorded: median $0.00059. Latency per request, as
  recorded: median 462 ms, p90 574 ms, p95 605 ms, max 964 ms.

**Conditions and limits.** n = 24, none from project A, where most builder
work runs, and only 15 with a proven first delivery. So the pilot measures
whether a selector keeps a rule a fix round later found relevant; whether
delivering that rule helps stays unmeasured. The pool carries current texts
beside a positive's replaced text. Relevance has one judge and no agreement
figure. The request differs from the 2026-10-02 harness in its framing (a
stage launch, where the earlier study framed an operator message), so the two
studies' numbers do not compare.

**What it suggests.** Jev at 0.5 cuts the pool to about an eighth with most
of what it offers relevant, and keeps the known-relevant rule about two times
in three; at 0.3 it keeps it five times in six at under a third of the pool.
BM25 filling to 8 000 to 12 000 code points keeps it in 20 to 22 of 24 cases,
short of the acceptance bar of §5.6 at this sample size. Selection looks
viable; whether Jev beats BM25 at equal budget, and so earns a new data flow,
is unmeasured until the second pilot.

### 5.6 Evaluation plan and acceptance thresholds

**Offline, before selected delivery ships (slice 4).** A second pilot under
its own cap: at least 100 grounded cases from at least three projects,
at least 30 from A, each positive matched by id and text hash to the first
builder start's ledger row (§5.5), the key's own limit read before the first
call, and every score kept with the frozen export so each number can be
recomputed without another call. Sizes and budgets are measured as §4.3
defines them, and both selectors pack by the §5.1 walk. Two
independent relevance judges (one Claude, one Codex) on 20 cases × 10 rules,
agreement reported as Cohen's kappa. Accept the shipped policy when all hold:

1. grounded positive kept in at least 85 % of cases, lower 95 % bound at
   least 75 %;
2. judged relevance of selected (non-always-on) rules at least 60 %, and of a
   random excluded sample at most 10 %;
3. no selected part above 9 000 code points and no block above 24 000
   bytes, both measured as §4.3 defines them;
4. Jev is the primary selector only when it beats BM25 at equal budget on
   criterion 1 or 2 by at least 10 points with the paired interval above
   zero. Otherwise BM25 ships alone and the Jev flow stays deferred.

**Shadow week (slice 1).** Selection runs for every eligible start and is
recorded; delivery stays whole-scope. Accept when: the selector (Jev or
BM25) answers for at least 99 % of eligible starts, the fallback reasons are
counted, p95 added launch time is at most 2 seconds, and online grounded
recall (each fix-round rewrite, or lesson merged into an existing rule: was
that rule, at the text the first start's ledger row records, in the first
attempt's shadow selection?) is at least 85 %.

**Live (slice 4 onward).** Primary metrics: online grounded recall and the
applied rate of §6. Guard: first-review failure of builder lanes, judged
against the drift of rolling weekly windows over the four weeks before the
switch; that rate moved 14 points within one week of rolling windows
(`memory-source-switch.md` §6.3), so it can catch only a large harm. Rule
written in advance: a rise beyond the largest prior weekly drift plus 5
points sets `memory.delivery` to `whole` (§5.1), which stops both selectors
for every attempt not yet frozen, and the shadow continues.

## 6. Write-quality checks

Decision 7 (§7.3) drops the proposed correction trace, judge passes and
automated quality loop below. Only applied/misled measurement proceeds in
slice 1; the operator reviews rule quality visually. The table retains the
earlier options for the decision record.

| Check | How | Metric and target | Cost |
| --- | --- | --- | --- |
| Operator correction → rule | When the seat writes a rule from an operator correction, `leave_lesson` carries `fromOperatorAt`: the time of the operator message in the seat's own conversation. The server checks that a member-authored message exists there at that time and keeps the link local. The rules window marks the rule "from your correction" and opens the message | Share of seat rules with a verified link; on a weekly sample of 20 operator messages judged "is this a correction of how work is done?", share followed in the same turn by a rule or a task: target 80 % | One optional field; one clean judge pass of 20 messages a week |
| Correction means what was said | The same weekly pairs (operator message, rule written) judged blind: does the rule state what the operator asked, at the right level, without adding to it? | Faithful share, target 90 %; each unfaithful pair goes to the seat as a rewrite | Part of the same judge pass |
| Use of delivered rules | Every `leave_lesson` answer (none, lesson, rewrite, problem) may carry `applied` (up to 5 ids of delivered rules that changed what the agent did) and `misled` (ids that were wrong or stale). The ledger already holds what was delivered | Per rule: deliveries, applied rate, misled count. Citation alone reached 7 % of conversations (§1.7); the answer field is the signal. Target: answer rate 80 % of requests | About 50 output tokens per stage end |
| Disuse | A rule delivered 30 times with no `applied` ranks lower in the curator's read and in selection's tie-breaks; it leaves only for budget, reversibly | Count of such rules per scope, read by the curator | None beyond the counters |
| Level fit and write precision | Monthly blind sample of 40 new rules stratified by writer role and level, two judges (Claude and Codex), the §1.6 classes plus "actionable" (names a trigger and a check), "readable" (no slash or semicolon chains) and "accurate at HEAD" | Project-specific share in `role:*` at most 5 % (3 % now); holds-across-projects share of role-here writes reported, drawn and judged as the second sample of §1.6 (88 % now, one judge; should fall as writers use the new level); actionable 90 %; compression index under 10 %; kappa reported | About 40 × 300 tokens of rules plus rubric per judge, under a dollar API-equivalent |
| Curator calibration | Weekly sample of 20 curator dispositions judged against the code (benchmark item 10) | Disposition accuracy with interval | One clean judge pass |
| Recurrence | A fix-round rewrite whose replaced text matches, by id and hash, an entry of the first attempt's ledger row marks the rule "too narrow when delivered"; counted per rule and per writer role. Starts with no ledger row are counted apart, never as delivered | Rewrites of delivered rules per 100 fix rounds, reported weekly | None: already in the request rows and the ledger |

The judges run through the existing role evaluation harness
(`evals/roles/`, `scripts/role-eval.ts`) on frozen exports, never against live
state. None of these checks refuses a write on a pattern: they rank, hint,
sample and report, and the operator decides.

## 7. Migration, slices and decisions

### 7.1 Migration from the current store

- **No row is rewritten at deploy.** `applied` and `misled` are optional
  fields on request rows. Future `layer` and `parent` fields arrive in slice
  3. `role_memory` retains schema version 1 and its three row kinds, so older
  readers can still decode the store. The agent-write visibility fields,
  correction link and project-vocabulary cache are dropped.
- **New records live apart:** frozen selections in `role_memory_selection`;
  the independent monthly feature reservation in
  `role_memory_selection_spend`. Neither adds a row kind to `role_memory`.
- **Existing rules get layers** in one curator pass with the Layer check: each
  of the 437 active rules gets a layer and, where clear, a parent. Until a
  rule has a layer it is treated as a practice (selectable, never always-on).
- **The 185 budget archives** are offered to the curator's existing "return
  budget archives" step once the store bounds rise; only those that pass the
  checklist return.
- **Order matters.** Raising the store bounds before selected delivery would
  raise builder starts from about 23 KB toward 60 KB. Bounds rise after
  selection is live or together with it.
- **Rollback.** Selected delivery's `memory.delivery = whole` returns
  whole-scope delivery under the hard maximum; already frozen attempts keep
  their block. Slice 1's independent shadow switch is
  `LLV_ROLE_MEMORY_SHADOW=off`: it stops both shadow selectors and retains
  frozen delivery. A binary predating slice 1 ignores the selection
  collection and cannot preserve a frozen block across starts. Role-wide
  writes remain curator-only throughout.

### 7.2 Slices, in order

1. **Measure first.** `applied` and `misled` in `leave_lesson`; delivery
   stays `whole` but its block is frozen per attempt (§5.4); selection
   computed in shadow (BM25 always, Jev when the key, its limit and the cap
   allow) and recorded in `role_memory_selection` and the ledger. Files:
   `src/lib/memory/roleStage.ts`, `roleRender.ts`, `roleStore.ts`,
   `roleTypes.ts`, `roleLaunch.ts`, a new `src/lib/memory/roleSelect.ts`,
   `src/lib/mcp/server.ts`. Tests on isolated state: answer fields validated
   against ids the attempt actually received; a resume, a boot adoption and an account migration
   after an agent rewrite, a curator move and a budget archive deliver the
   first start's block byte for byte; an operator deletion between starts
   removes exactly that rule's line and records it on the selection row and
   the ledger row; two concurrent first starts store one block; every row of
   the §5.1 table records its reason in shadow; the launch never waits past
   the deadline; a stored row carries exactly the fields of §5.4, scores only
   for selected rules, and the first start's ledger row carries the shadow
   ids.
2. **Role-wide scope stays curator-only.** Agent writes to `role:*:<role>`
   and slice 2's agent-write visibility machinery are dropped. Agents keep
   leaving role lessons in their project's scope; the curator alone widens
   them after checking their fit across projects. Existing scope and write
   behavior stays in force.
3. **Layers.** `layer` and `parent`, the Layer check in the curator brief and
   in `apply`, principles rendered first. Tests: the server refuses a parent
   outside the reader's scopes and a principle over 200 code points; a child
   renders under its delivered parent and alone otherwise.
4. **Selected delivery.** The `bm25` and `jev` modes of §5.1, always-on up
   to 3 000 and selected up to 9 000 code points, the 24 000-byte hard
   maximum on every path, the fix-round nearest-rules list; gated on the
   offline and shadow acceptance of §5.6. Tests: each row of the §5.1 table
   gives its one output and reason; equal scores pack in curator rank order,
   then by id; a partial Jev answer packs exactly as `bm25`; zero BM25
   matches pack in curator rank order; `whole` calls no selector; no row
   exceeds 9 000 code points of selected lines or 24 000 bytes of block; in
   rule text of one to four bytes per code point, for a builder, a seat and
   a maintainer, every member of the always-on set at its cap survives every
   row of §5.1 and the frozen re-render; a reader scope holding unseen
   lessons beyond its target is cut in the order of §5.1, curated rules
   first and the newest lesson last, and stays within 24 000 bytes; a pool
   over 120 000 code points calls no Jev and records `jev-pool`.
5. **Larger store.** The targets of §4.2; budget archives returned through
   the curator; the brief's 16 000-byte four-scope target replaced by the
   layer guidance.
6. **Dropped: quality loop.** No correction-trace link, window mark, judge
   passes or automated quality review. The operator reviews rule quality
   visually. Slice 1's applied/misled measurement remains.


The open lane on memory profiles (PR #3177, still open at this revision)
changes `src/lib/memory/profileModel.ts`, `src/lib/agent/headless.ts`,
`src/lib/agent/registry.ts` and `src/lib/viewerLoopMonitor.ts`, among
others. None of these slices needs them: `memory.select` registers through
the existing `withViewerOperation` call. A slice that turns out to touch one
starts after that lane merges. The runtime host is untouched by every slice.

### 7.3 Recorded decisions — 2026-10-22

These decisions supersede the options proposed earlier in this document.
Historical measurements and probes above retain their original budgets.

1. **Role on every project stays curator-only.** Slice 2's agent writes
   are dropped; agents continue writing role lessons in the project scope.
2. **Jev selection is conditional.** Rule texts and redacted stage briefs
   may be sent for shadow measurement under an independent $5/month feature
   cap. Selected delivery uses Jev only if the second pilot beats BM25 by
   10 percentage points at equal budget; otherwise it uses BM25.
3. **One hard maximum: 24 000 bytes per launch**, introduced with selected
   delivery in slice 4. Slice 1 keeps today's whole-scope delivery unchanged.
4. **Store targets:** role here 20 000, role on every project 30 000,
   project and machine 15 000 code points. Raise them together with selected
   delivery, in slice 5; unseen lessons retain today's target semantics.
5. **Layers:** a layer field and parent link; principles always-on up to
   3 000 code points; the curator decides the layer. Deferred to slice 3.
6. **Provider and feature budgets:** the operator raises the OpenRouter key
   limit. Delegatus retains independent per-feature caps: memory selection
   $5/month, separate from the asks classifier's cap. A missing key,
   unavailable provider limit or exhausted budget falls back to BM25.
7. **Quality review is visual and operator-owned.** The correction-trace
   link and judge passes are dropped, along with slice 6. Applied/misled
   measurement in slice 1 remains authorized.

## Deferred — not currently justified

- **Multi-role scopes** (`roles:<a>+<b>`, `role-memory-to-prompts.md` §5.1).
  74 copy rows collapse to 32; the requirement is about levels and projects,
  and the copies cost bytes that selection now filters.
- **Tool scopes** (`tool:<name>`, §5.2 of the same document). 14 of 16
  machine rules are tool practices; selection drops a tool rule a brief does
  not need, which is what the tool scope was for.
- **A scope per layer.** §3.1, option L2.
- **The last approved text for other projects while a rewrite waits.**
  Under §2.3 an agent rewrite of an approved role-wide rule leaves other
  projects without that rule until a pass approves the new text. Rendering
  the newest version whose hash was approved would close that gap at the
  cost of a version lookup on every launch; curator passes run many times a
  day, so the gap is short.
- **Embedding or graph selectors.** No local embedding model runs here, and
  the 2026-10-02 study found graph gating lost its useful offer.
- **Selection for seats and maintainers.** They start without a task brief;
  curator rank order within the hard maximum serves them.
- **Removing the per-scope bound.** The operator asked that some maximum
  stay; the store bound stays as curation pressure and the hard maximum
  stays per launch.
- **Memory for reviewers, verifiers, the issue reporter or the curator.** The
  2026-10-07 rule stands; their know-how arrives through promotion into
  prompts.
- **Archiving or deleting for disuse.** Disuse ranks lower (§6); only the
  bound archives, and reversibly (2026-10-02 rule).
- **A model judging every lesson at write time.** The curator judges in bulk,
  and the monthly sample measures it.
- **Automatic promotion into prompts.** It stays a reviewed change to the
  shipped role text.
- **A live A/B split of delivered rules.** Both arms would read the same
  scopes; the shadow and the replay measure without contamination.

## Validation against the requirement

| Requirement (paraphrased, 2026-10-21) | Where answered |
| --- | --- |
| Research memory behaviour and improve it | §1 measures fill, delivery, losses, write levels, generality; §2–6 propose |
| More tokens | Store bounds 1.5–3× per scope (§4.2); start budget under one hard maximum (§4.3) |
| More layers, several levels of abstraction | Principle → practice → specific with parent links (§3), promotion above (§3.4) |
| Roles write memory that holds in every project | The `every-project` level for every memory-eligible role, the writer's test and four guards (§2.3) |
| Check that agents write what the operator means and what is useful | Correction-to-rule links and faithfulness checks, use counts, blind level and precision samples, curator calibration (§6) |
| 10 000 per kind is too small | Evidence that the store bound is the binding limit (§1.4) and new bounds (§4.2) |
| Combine with Jev and measure how well it picks | Grounded stage request (§5.2), pilot with spend, numbers, exact sizes and a ledger check of its labels (§5.5), one delivery policy (§5.1), acceptance thresholds (§5.6) |
| Relax per-scope limits, keep an overall maximum | Larger store, one hard maximum of 24 000 bytes per launch on every path (§4.3) |
| Jev saves injected volume | 106 rules → 13 at 0.5 or 32 at 0.3 in the pilot; API-equivalent cost per start roughly halves (§4.4, §5.5) |
| Earlier rules: clean reviewers, nothing deleted for disuse, lessons active at once | §2.1, §6 "Disuse", §2.3 visibility gate (active at once for the writing project) |

## Notes

- **Side effect of the pilot.** The OpenRouter key's own limit is $3; it
  stood at about $2.98 when the pilot began and reached the limit during it
  ($0.014 spent here). The asks classifier, enabled with a $1 monthly
  Delegatus cap, uses the same key and will be answered 403 until the limit
  is raised. Decision 6 covers it.
- The seat's launch note said the every-project level existed only for the
  orchestrator and the maintainer; it exists for every role, filled by the
  curator (§2.1).
- The pinned specification names reviewer and verifier among
  memory-eligible roles; they stay clean under the operator's 2026-10-07 rule.
- 32 rule texts appear in more than one role's scope (§1.7); no reader gets
  two copies, so they cost stored bytes only.
- The memory index (`search_memory`) held nothing about this subject.
- **What the revision changed after the critique.** The visibility gate now
  approves an exact text (§2.3); the attempt freezes delivered content, not
  ids (§5.4); one table governs selection, fallback and rollback (§5.1);
  pilot sizes use the renderer's own line format, the Jev budget column is
  withdrawn and the pilot's labels are checked against the ledger (§5.5);
  the writer-behaviour figure comes from a uniform write sample at the
  writers' own text, and the earlier stratum's exclusions are stated (§1.6).
- **What the second revision changed after the second critique.** The
  writer of a role-wide text is a field of its own, keyed to the text's hash,
  which curator Undo restores with the rest of the rule's prior fields, and
  every write path's effect on it is listed (§2.3). The always-on set is
  reserved before any pack or cut, the pack tests bytes as well as code
  points, and the cut takes rules in the store's leaving order (§4.3, §5.1).
  The store values are stated as targets, with the measured size of the
  unseen part, the conditions under which the pool figures hold and a Jev
  pool ceiling (§4.2). The selection row is sized from its full
  serialization, with what is and is not enforced (§5.4).

## Appendix: how each number was counted

Cutoff `T = 2026-10-21T21:08:15.093Z`. Windows of 7 days end at `T`. Rows
are read from `state_rows` of the state database with collection
`role_memory` (kinds `rule`, `scope`, `request`) and `role_memory_curation`
(`r:` pass rows), and from `deliveries` of the delivery ledger. The store is
not append-only (state, reason and scope lists change in place), so a later
export reproduces the counts that depend only on write times (requests,
rules written, ledger rows) directly. The point-in-time ones (scope fill,
active counts, rule fates) can be rebuilt only by rolling a later export back
to `T`, which the revision did once (§1.1): rows created after `T` dropped,
each rewrite after `T` undone from the version row it wrote, each archive
after `T` undone from the scope history, ledger rows kept by their own `at`.
The script refused any change kind it could not undo from the records (a
curator pass, a move, a split, a merge, an operator restore); none had
happened.

- **Active rule**: `kind = rule`, `state = active`, no `versionOf`, listed in
  its scope row's `active`.
- **Scope fill**: code points of the scope's active rules rendered as
  `- [id] rule` and joined with newlines (`scopeChars`).
- **Level**: `machine`; `role:*:` prefix → role on every project; other
  `role:` → role on this project; `project:` → project.
- **Budget archive**: original rule with `reason = budget`; curated when
  `curatedAt` precedes `changedAt`; life is `changedAt − createdAt`.
- **Write level**: the scope of the first scope-history entry whose `added`
  holds the rule id (succession entries resolved to the original scope).
- **Requests by answer**: request rows with `at` in the window; lesson when
  `ruleIds` is non-empty, else rewrite when `rewrote`, else problem, else
  none when `none` is set, else open.
- **Delivery**: ledger rows; role from the scope `role:<project>:<role>` in
  the row's scopes; rows with no rule ids are clean or role-free.
- **Citations**: transcripts found through the registry's conversation-path
  rows for 250 conversations drawn by SHA-256 of the conversation id among
  ledger rows with rules and a pipeline attempt; a citation is a delivered id
  inside an assistant message, a function call or a custom tool call.
- **Requests per stage**: distinct Claude message ids of assistant records,
  or Codex `token_count` events, in the same transcripts.
- **Blind samples and pilot**: strata, frames and draws as in §1.6 and
  §5.5, order by SHA-256 of a fixed salt and the record id; Wilson intervals
  at 95 %.
- **Original text** of a write: the text of the rule's earliest version row
  when it has versions, its own text otherwise. Every text change goes
  through `versionedRule`, which keeps the replaced text as a version row.
- **Rule-line size**: `scopeChars` over the lines (§4.3); UTF-8 bytes of the
  same newline-joined lines; block bytes from `renderLearnedRulesSelection`
  over the four scopes with no ceiling, run from this commit's own module in
  a scratch export.
- **Ledger match**: the ledger rows whose `attempt` names the case's first
  builder stage and attempt 1; the lowest sequence is the first start; a
  match is an entry with the positive's rule id whose `hash` equals the
  SHA-256 of the positive's text.
- **Version check**: for the version row a case chose, the next version row
  of the same rule, or the rule itself when none follows, must carry
  `revisedBy.by = agent`, `revisedBy.at` equal to the version's `changedAt`,
  and a source naming the case's pipeline, stage and attempt.
- **Unseen at a start** (§4.2): a delivered rule was unseen at a start when
  no curator entry of scope history dated at or before the start lists it in
  `before`, `created` or `restored`; an entry undone later counts only until
  its `revertedAt`, unless the rule is in its `undoSkipped`. Texts are looked
  up by the ledger's hash among rule and version rows (none missing). Each
  delivered rule is assigned to one of the reader's scopes by splitting the
  ledger's ordered list into the scopes in the row's scope order, which the
  renderer writes contiguously, choosing the split that best agrees with
  each rule's scope at the start (its current scope, or the source scope of
  the first curator move or split after the start); the split disagreed with
  no rule in 1 539 starts. Sizes are `scopeChars` over each scope's unseen
  lines; quantiles by nearest rank.
- **Attempts per 24 hours** (§5.4): distinct pipeline, stage and attempt
  among ledger rows to `T` that carry rules and an attempt, each dated by its
  first start; the most first starts within 24 hours ending at any of them.
- **Probes** (§4.2, §4.3, §5.1, §5.4): synthetic rules with distinct texts,
  ids of 18 characters, rendered and retained by this commit's
  `renderLearnedRulesSelection` and `retainRules` from a scratch export; the
  proposed pack and cut exist only in the probe; row
  sizes are the UTF-8 length of `JSON.stringify` of the row of §5.4.
