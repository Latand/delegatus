# Role memory layers: a larger store in levels, role-wide rules for every role, write-quality checks, and selection under one hard maximum

Status: research and design, no product change. Written 2026-10-22 against
`main` at `f5fd6a2c0`; `main` had not moved when the document was finished
(the forge's compare answered 0 commits ahead). File and line references are
to that commit. Live records were read once, read-only, at
2026-10-21 21:08:15 UTC: the `role_memory` and `role_memory_curation`
collections of the state database, the memory delivery ledger, the pipeline
records of the pilot's lanes, the conversation-path rows of the agent
registry and, for two counts, the stage transcripts those rows point at. Every
export lived in this stage's scratch directory and goes with it. Projects
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
this stage for the blind sample (§1.6) and the pilot (§5.5); none of it is
reproduced here.

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
it): role on this project 537 (89 %), project 43, machine 21. No writer can
target "role on every project": `leave_lesson` accepts `role`, `project` and
`machine` (`src/lib/mcp/server.ts:4251`), and the request tells agents to
leave a role-wide rule under `role` and lets the curator alone widen it
(`src/lib/memory/roleRender.ts:108`).

Where those 601 lessons are now: 238 active (147 in role-on-this-project
scopes, 62 widened by the curator to role on every project, 29 elsewhere), 75
merged into an existing rule, 154 archived for budget, 94 as task-specific,
21 as already in instructions, 19 for other reasons.

### 1.6 Generic or project-specific: a blind sample

**Method.** 148 rules drawn by SHA-256 order from five strata: 60 active
rules of role-on-this-project scopes, 30 active rules of role-on-every-project
scopes, all 16 machine rules, both project rules, and 40 lessons written at
role-on-this-project level in the last 7 days (any state). The judge saw only
the rule text under a random label, in label order; scope, role, project and
state were hidden and joined afterwards. One judge, this stage's agent; no
second judge, so no agreement figure exists (§6 adds one). The judge had seen
the architect scopes in its own start block, so a few architect rules were
recognisable.

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
| Written at role-on-this-project level, last 7 days | 40 | 20 | 7 | 5 | 8 (3) | 80 % [65–90] |

By writer role, over the 100 role-on-this-project rules: builder 48 of 60
hold across projects, orchestrator 13 of 21, architect 8 of 13, prod-auditor
1 of 5. Of the 40 recent lessons, the 8 project-specific ones ended 3 active,
2 budget, 2 task-specific, 1 merged; the 20 principles ended 7 active, 5
budget, 4 in instructions, 3 merged, 1 task-specific.

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
- Writers file role-wide knowledge as project knowledge: 80 % of last week's
  role-on-this-project lessons hold across projects, and two thirds of the
  active role-on-this-project rules do. The curator widens slowly (62 of 601
  in a week) into a scope that is itself full.
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
| B. Writer chooses "role on every project", gated | `leave_lesson` gains the level; a rule written there reaches other projects only after one curator pass; a project-term hint at write time | Matches what writers produce (80 % generic); one copy of a practice where four projects keep four today; the gate keeps an unreviewed project fact inside its own project | One more choice in the lesson request; a curator pass per new role-wide rule before it travels |
| C. Every role lesson goes to "every project" by default; the curator demotes | Writers stop choosing between the two role levels | Simplest request | 20 % of recent lessons are project-specific and would sit in the wrong scope until demoted; the gate would hold most of the scope back from other projects |
| D. Multi-role scopes (`roles:<a>+<b>`) | A scope read by a set of roles | Collapses 74 copy rows to 32 | Answers which roles read a rule, a question this requirement does not ask; deferred |

### 2.3 Recommendation: option B

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
A rule written for every project reaches other projects after the curator has read it once; until then only this project's agents read it.
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
3. **A visibility gate.** When the block is rendered for a reader in project
   P, a rule in `role:*:<role>` is included only when it has been curated
   (`curatedAt`), kept by the operator, or written from P. A new
   role-wide lesson is therefore active at once for its own project (the
   operator's 2026-10-11 answer) and travels after one curator pass.
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
  `role:*:<role>` or `machine`. In the blind sample 40 % of role-here and
  50 % of role-wide rules were of this kind.
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
| One scope's rendered lines | 10 000 code points | `retainRules`, `src/lib/memory/roleConsolidate.ts:60` |
| A role's four scopes | 16 000 bytes | the curator brief only; builders start with 23 KB |
| One start's block | 120 000 bytes | `renderLearnedRulesSelection` (`src/lib/memory/roleRender.ts:36`), never reached |
| Orchestrator four-scope target after an import trigger | 24 000 bytes | the curator brief (`fourScopeTarget`, `src/lib/memory/roleTypes.ts:166`) |

### 4.2 Store bounds (what a scope keeps active)

With selection (§5) the store and the start block stop being one number. The
store bound becomes curation pressure, and the start budget becomes what an
agent reads.

| Scope | Today | Proposed | Why |
| --- | ---: | ---: | --- |
| Role on every project | 10 000 | 30 000 | Receives the general part of four projects' role rules (§2.3) |
| Role on this project | 10 000 | 20 000 | Keeps the curated rules the bound removed last week (163) with room to churn |
| Project | 10 000 | 15 000 | Nearly empty today; no evidence for more |
| Machine | 10 000 | 15 000 | 36 % full; tool practices grow with tools |

In tokens, at about four bytes per token for English rule text: 30 000 code
points are about 7 500 tokens, 20 000 about 5 000, 15 000 about 3 750. A
builder's pool would then be at most 80 000 code points (about 300 rules at
today's mean length, about 20 000 tokens), which only the selector reads,
against 23 000 bytes delivered whole today. The curator reads a
scope in 24 KB pages, so a 30 000-point scope adds one or two pages per
pass; pass time is not measured at that size. The rule that only curated
rules leave for budget (`docs/design/memory-delivery-ledger.md`) stays.

### 4.3 The start budget and one hard maximum

- **Always-on**: the role's principles, the machine's principles and rules
  the operator kept, at most 3 000 code points, curator rank order.
- **Selected**: practices and specifics chosen per launch (§5), filling up
  to 9 000 code points.
- **One hard maximum per launch: 20 000 bytes** of rendered block for every
  role and engine, enforced in `renderLearnedRulesSelection` on every path:
  selected, fallback, seats, maintainers. The 120 000-byte argument limit
  stays beneath it as a safety net. 20 000 bytes covers the seat's p90 start
  today (17 996) and sits below a builder's median (22 851).

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
| Hard maximum, 20 000 bytes | $0.094 / $0.109 | $0.054 | $0.107 |
| Typical selected start, 12 000 bytes | $0.056 / $0.065 | $0.032 | $0.064 |

At last week's builder volume (about 991 Codex and 317 Claude stage
conversations a week, starts from the ledger divided by 1.12 starts per
conversation), whole-scope builder blocks cost about $61 (Codex standard) and
$34–40 (Claude) a week; selected 12 KB blocks about $32 and $18–21. Selection
itself costs about $0.0006 per launch at today's pool (§5.5), about $1.2 a
week for every start that carries rules, and about $3 a week at a pool two and
a half times larger.

- **Context.** 20 000 bytes is about 5 000 tokens: 0.5 % of Claude's 1M
  window and under 2 % of the 272 000 tokens past which OpenAI prices a
  prompt higher.
- **Cache.** The block sits in Claude's appended system prompt and Codex's
  developer instructions, both inside the cached prefix, so a smaller block
  lowers every later request's read. A block that changes between engine
  starts of one attempt would break the cache; selection is frozen per attempt
  (§5.4).
- **Latency.** Not measured end to end. Jev answered in 462 ms median and
  605 ms p95 per request in the pilot; a launch's batches run in parallel, so
  selection adds about half a second at the median. No claim is made for the
  prefill time saved.

## 5. Selection

### 5.1 The selection, step by step

1. **Candidates**: the active rules of the reader's four scopes, minus the
   always-on set.
2. **Score**: one grounded Jev request per batch of 50 candidates (§5.2), in
   parallel, under one deadline of 3 seconds.
3. **Fill**: candidates with probability at least 0.5, highest first, then
   those from 0.3 to 0.5, highest first, until 9 000 code points.
4. **Render**: always-on, then selected, grouped under their principles,
   within the hard maximum.
5. **Freeze**: the ordered ids are stored for the attempt and recorded in the
   delivery ledger with the selector, its version, the scores and the
   fallback reason when there is one.

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
sends agent messages there). It needs the operator's yes (decision 2).

### 5.3 The cheaper selector, and every fallback

The fallback is BM25 between the brief and each rule, computed locally, with
the same fill and the same budget. In the pilot it kept the grounded positive
about as often as Jev at 8 000 characters and above (§5.5). It runs when:

- no OpenRouter key is set, the key's own spending limit is reached (the
  pilot met this: a 403 stopped it), or Delegatus's monthly selection cap is
  spent;
- Jev answers an error, times out at 3 seconds or returns a malformed answer;
- the launch has no brief: seats and maintainers use curator rank order
  within the hard maximum, as today;
- the operator switches selection off.

A fallback never blocks a launch and never delivers more than the hard
maximum. Its reason is on the ledger row and in a status line the Memory page
shows.

### 5.4 Where it runs

Once per stage attempt, in the pipeline engine's launch path where
`stageMemoryForLaunch` decides eligibility
(`src/lib/memory/roleStage.ts:30-33`), before the spawn: asynchronous, under
the 3-second deadline, registered with the loop monitor as
`memory.select`. The result is written to a new collection,
`role_memory_selection`, keyed by pipeline, stage and attempt; old releases
never open it, and `role_memory` gains no row kind (its strict decoder would
refuse one, `role-memory-curation.md` §1). Every engine start of that attempt
(fresh, resume, boot adoption, account migration: the six builders that call
`learnedRulesForLaunchProfile`) renders the frozen ids, so the block is
byte-stable within an attempt and the cache holds. A start that finds no
selection row renders the fallback and records why.

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
(`jevFailureCostUsd`, `src/lib/asks/jev.ts`). Private inputs stayed in the
stage's scratch directory.

**Population and labels.** Grounded positives come from fix-round rewrites:
a fixer, after the review's findings, rewrote a rule it had been given
because that rule named the class of the finding and was too narrow. That
rule, at its pre-rewrite text, is a rule the first builder attempt of the
same lane should have received. From 294 builder rewrite requests: 113 were
dropped because the rule appeared after the first attempt started, 18 were
not fix rounds, 24 lanes had no separate first builder stage, 32 repeated a
lane; 107 remained (A 79, C 14, D 9, B 4, E 1). The plan took every case
outside A and 32 of A by hash order. The 24 cases completed before the 403
are all outside A: B 3, C 13, D 7, E 1.

**Pool.** The builder's four scopes at the cutoff: active rules plus rules
archived for budget (the larger pool a raised bound would keep), with the
positive at its old text and its current text removed. Mean 106 rules and
27 074 characters of rendered lines; 16 % of the pool were budget archives.

**Inputs.** Pipeline task, specification and the first builder stage's
prompt template, redacted, as in §5.2.

| Policy | Mean rules offered | Mean characters | Grounded positive kept [95 % Wilson] |
| --- | ---: | ---: | --- |
| Jev ≥ 0.9 | 0.1 | 25 | 0 of 24 [0–14] |
| Jev ≥ 0.7 | 3.8 | 1 013 | 5 of 24 [9–40] |
| Jev ≥ 0.5 | 13.3 | 3 490 | 15 of 24 [43–79] |
| Jev ≥ 0.3 | 31.8 | 8 082 | 20 of 24 [64–93] |
| Whole pool | 106 | 27 074 | 24 of 24 |

| Budget, characters | Jev ranking | BM25 ranking | Random, expected |
| ---: | --- | --- | ---: |
| 2 000 | 10 of 24 [24–61] | 11 of 24 [28–65] | 8 % |
| 4 000 | 16 of 24 [47–82] | 13 of 24 [35–72] | 15 % |
| 8 000 | 19 of 24 [60–91] | 20 of 24 [64–93] | 30 % |
| 12 000 | 22 of 24 [74–98] | 22 of 24 [74–98] | 45 % |
| 16 000 | 24 of 24 [86–100] | 23 of 24 [80–99] | 60 % |

- The positive ranked in the top 8 % of its pool at the median under Jev
  (p25 3 %, p75 23 %) and the top 11 % under BM25. Its median probability
  was 0.62 against 0.17 for the other rules (p90 0.53).
- Score bands over all 2 521 non-positive candidates: 70.6 % below 0.3,
  17.3 % from 0.3 to 0.5, 12.1 % at 0.5 or more.
- **Judged relevance.** Eight cases drawn by hash; in each, five rules Jev
  scored at 0.5 or more and five below 0.3, mixed in hash order with the
  scores hidden; one judge (this stage's agent) asked whether each rule
  applies to the brief's work. Relevant: 31 of 40 at 0.5 or more, 78 %
  [62–88]; 1 of 40 below 0.3, 3 % [0–13].
- Spend per case: median $0.00059. Latency per request: median 462 ms, p90
  574 ms, p95 605 ms, max 964 ms.

**Conditions and limits.** n = 24, none from project A, where most builder
work runs. Every positive is a rule that had been delivered and still failed
to prevent its finding, so the pilot measures whether a selector keeps a
relevant rule; whether delivering that rule helps stays unmeasured. The pool
carries current texts beside a positive's old text. Relevance has one judge
and no agreement figure. The request differs from the 2026-10-02 harness in its framing
(a stage launch, where the earlier study framed an operator message), so the
two studies' numbers do not compare.

**What it suggests.** Jev at 0.5 cuts the pool to about an eighth with most
of what it offers relevant, and keeps the known-relevant rule about
two times in three; at 0.3 it keeps it five times in six at under a third of
the pool. BM25 ranks nearly as well at budgets of 8 000 characters and more.
Selection looks viable; whether Jev earns a new data flow over BM25 is open.

### 5.6 Evaluation plan and acceptance thresholds

**Offline, before selected delivery ships (slice 4).** A second pilot under
its own cap: at least 100 grounded cases from at least three projects,
at least 30 from A, the key's own limit read before the first call. Two
independent relevance judges (one Claude, one Codex) on 20 cases × 10 rules,
agreement reported as Cohen's kappa. Accept the shipped policy when all hold:

1. grounded positive kept in at least 85 % of cases, lower 95 % bound at
   least 75 %;
2. judged relevance of selected (non-always-on) rules at least 60 %, and of a
   random excluded sample at most 10 %;
3. mean selected text at most 9 000 code points, and no start above the hard
   maximum;
4. Jev is the primary selector only when it beats BM25 at equal budget on
   criterion 1 or 2 by at least 10 points with the paired interval above
   zero. Otherwise BM25 ships alone and the Jev flow stays deferred.

**Shadow week (slice 1).** Selection runs for every eligible start and is
recorded; delivery stays whole-scope. Accept when: the selector (Jev or
BM25) answers for at least 99 % of eligible starts, the fallback reasons are
counted, p95 added launch time is at most 2 seconds, and online grounded
recall (each fix-round rewrite, or lesson merged into an existing rule: was
that rule in the first attempt's shadow selection?) is at least 85 %.

**Live (slice 4 onward).** Primary metrics: online grounded recall and the
applied rate of §6. Guard: first-review failure of builder lanes, judged
against the drift of rolling weekly windows over the four weeks before the
switch; that rate moved 14 points within one week of rolling windows
(`memory-source-switch.md` §6.3), so it can catch only a large harm. Rule
written in advance: a rise beyond the largest prior weekly drift plus 5
points turns selected delivery off (one setting) and the shadow continues.

## 6. Write-quality checks

| Check | How | Metric and target | Cost |
| --- | --- | --- | --- |
| Operator correction → rule | When the seat writes a rule from an operator correction, `leave_lesson` carries `fromOperatorAt`: the time of the operator message in the seat's own conversation. The server checks that a member-authored message exists there at that time and keeps the link local. The rules window marks the rule "from your correction" and opens the message | Share of seat rules with a verified link; on a weekly sample of 20 operator messages judged "is this a correction of how work is done?", share followed in the same turn by a rule or a task: target 80 % | One optional field; one clean judge pass of 20 messages a week |
| Correction means what was said | The same weekly pairs (operator message, rule written) judged blind: does the rule state what the operator asked, at the right level, without adding to it? | Faithful share, target 90 %; each unfaithful pair goes to the seat as a rewrite | Part of the same judge pass |
| Use of delivered rules | Every `leave_lesson` answer (none, lesson, rewrite, problem) may carry `applied` (up to 5 ids of delivered rules that changed what the agent did) and `misled` (ids that were wrong or stale). The ledger already holds what was delivered | Per rule: deliveries, applied rate, misled count. Citation alone reached 7 % of conversations (§1.7); the answer field is the signal. Target: answer rate 80 % of requests | About 50 output tokens per stage end |
| Disuse | A rule delivered 30 times with no `applied` ranks lower in the curator's read and in selection's tie-breaks; it leaves only for budget, reversibly | Count of such rules per scope, read by the curator | None beyond the counters |
| Level fit and write precision | Monthly blind sample of 40 new rules stratified by writer role and level, two judges (Claude and Codex), the §1.6 classes plus "actionable" (names a trigger and a check), "readable" (no slash or semicolon chains) and "accurate at HEAD" | Project-specific share in `role:*` at most 5 % (3 % now); holds-across-projects share of role-here writes reported (80 % now, should fall as writers use the new level); actionable 90 %; compression index under 10 %; kappa reported | About 40 × 300 tokens of rules plus rubric per judge, under a dollar API-equivalent |
| Curator calibration | Weekly sample of 20 curator dispositions judged against the code (benchmark item 10) | Disposition accuracy with interval | One clean judge pass |
| Recurrence | A fix-round rewrite of a rule that was delivered to the first attempt marks the rule "too narrow when delivered"; counted per rule and per writer role | Rewrites of delivered rules per 100 fix rounds, reported weekly | None: already in the request rows and the ledger |

The judges run through the existing role evaluation harness
(`evals/roles/`, `scripts/role-eval.ts`) on frozen exports, never against live
state. None of these checks refuses a write on a pattern: they rank, hint,
sample and report, and the operator decides.

## 7. Migration, slices and decisions

### 7.1 Migration from the current store

- **No row is rewritten at deploy.** `layer`, `parent`, `applied` counters
  and the `fromOperatorAt` link are optional fields on existing rule and
  request rows; `role_memory` keeps schema version 1 and its three row kinds,
  so agents' MCP servers started on an older release still decode every row.
- **New records live apart**: selections in `role_memory_selection`; the
  project vocabulary is derived, cached and disposable.
- **Existing rules get layers** in one curator pass with the Layer check: each
  of the 437 active rules gets a layer and, where clear, a parent. Until a
  rule has a layer it is treated as a practice (selectable, never always-on).
- **The 185 budget archives** are offered to the curator's existing "return
  budget archives" step once the store bounds rise; only those that pass the
  checklist return.
- **Order matters.** Raising the store bounds before selected delivery would
  raise builder starts from about 23 KB toward 60 KB. Bounds rise after
  selection is live or together with it.
- **Rollback.** Selected delivery off returns whole-scope delivery under the
  hard maximum. A release from before slice 2 ignores the new fields and
  renders every active role-wide rule to every project, uncurated ones
  included, so a rollback past slice 2 is preceded by a curator pass over the
  role-wide scopes.

### 7.2 Slices, in order

1. **Measure first.** `applied` and `misled` in `leave_lesson`; selection
   computed in shadow (BM25 always, Jev when the key, its limit and the cap
   allow) and recorded in `role_memory_selection` and the ledger; delivery
   unchanged. Files: `src/lib/memory/roleStage.ts`, `roleRender.ts`,
   `roleStore.ts`, `roleTypes.ts`, a new `src/lib/memory/roleSelect.ts`,
   `src/lib/mcp/server.ts`. Tests on isolated state: answer fields validated
   against readable ids; shadow selection frozen per attempt and identical
   across resume; every fallback reason recorded; the launch never waits past
   the deadline.
2. **Role-wide writes.** The `every-project` level, the request text of
   §2.3, the project-term hint, the visibility gate in
   `learnedRulesSnapshot`, the curator's demotion sentence. Tests: a gated
   rule renders for its source project and not for another until curated;
   an operator-kept rule travels at once; the hint fires on a repository-only
   term and not on a term two projects share; seats write the level.
3. **Layers.** `layer` and `parent`, the Layer check in the curator brief and
   in `apply`, principles rendered first. Tests: the server refuses a parent
   outside the reader's scopes and a principle over 200 code points; a child
   renders under its delivered parent and alone otherwise.
4. **Selected delivery.** Always-on plus selected within 12 000 code points,
   the 20 000-byte hard maximum on every path, the fix-round nearest-rules
   list; gated on the offline and shadow acceptance of §5.6.
5. **Larger store.** The bounds of §4.2; budget archives returned through the
   curator; the brief's 16 000-byte four-scope target replaced by the layer
   guidance.
6. **Quality loop.** The correction link and its window mark, the weekly
   and monthly judge passes, disuse ranking in the curator's read.

The open lane on memory profiles (PR #3177) changes
`src/lib/memory/profileModel.ts`, `src/lib/agent/headless.ts` and
`src/lib/agent/registry.ts`, none of which these slices need; a slice that
turns out to touch the registry starts after that lane merges. The runtime
host is untouched by every slice.

### 7.3 Decisions for the operator

1. **Who may write "role on every project"?**
   (a) the writing agent, with the visibility gate until one curator pass
   **(recommended)**; (b) the curator only, as today; (c) the writing agent,
   reaching every project at once.
2. **Jev for selection: may rule texts and stage briefs go to OpenRouter and
   the Jev provider?** (a) yes, under its own monthly cap of $5, and only if
   the second pilot shows Jev beating BM25 by 10 points at equal budget;
   otherwise BM25 alone **(recommended)**; (b) no, BM25 only, no new data
   flow; (c) yes, now, without the second pilot.
3. **The hard maximum per launch.** (a) 20 000 bytes (about 5 000 tokens) for
   every role, selected text up to 9 000 code points beside 3 000 always-on
   **(recommended)**; (b) 16 000 bytes, the curator's present target; (c)
   24 000 bytes, about today's builder start.
4. **Store bounds.** (a) role here 20 000, role on every project 30 000,
   project and machine 15 000 code points, raised with selected delivery
   **(recommended)**; (b) keep 10 000 until the shadow week reports; (c)
   double every scope now, with whole-scope delivery.
5. **Layers.** (a) a layer field and a parent link, principles always-on up
   to 3 000 code points, the curator decides the layer **(recommended)**; (b)
   a scope per layer; (c) no layers, selection only.
6. **The OpenRouter key is at its $3 limit.** The asks classifier and any
   selection pilot are refused (HTTP 403) until it changes. (a) raise the key's limit,
   with Delegatus's own caps per feature (asks $1 a month today, selection
   its own) **(recommended)**; (b) a separate key for memory selection; (c)
   leave it, and run selection on BM25 alone.
7. **Tracing your corrections to rules.** (a) the seat links each rule it
   writes from a correction to your message, the window marks it, and a
   weekly blind check reads the pairs **(recommended)**; (b) the weekly blind
   check only; (c) neither.

## Deferred — not currently justified

- **Multi-role scopes** (`roles:<a>+<b>`, `role-memory-to-prompts.md` §5.1).
  74 copy rows collapse to 32; the requirement is about levels and projects,
  and the copies cost bytes that selection now filters.
- **Tool scopes** (`tool:<name>`, §5.2 of the same document). 14 of 16
  machine rules are tool practices; selection drops a tool rule a brief does
  not need, which is what the tool scope was for.
- **A scope per layer.** §3.1, option L2.
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
| Combine with Jev and measure how well it picks | Grounded stage request (§5.2), pilot with spend and numbers (§5.5), acceptance thresholds (§5.6) |
| Relax per-scope limits, keep an overall maximum | Larger store, one hard maximum of 20 000 bytes per launch on every path (§4.3) |
| Jev saves injected volume | 106 rules → 13 at 0.5 or 32 at 0.3 in the pilot; API-equivalent cost per start roughly halves (§4.4, §5.5) |
| Earlier rules: clean reviewers, nothing deleted for disuse, lessons active at once | §2.1, §6 "Disuse", §2.3 visibility gate |

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

## Appendix: how each number was counted

Cutoff `T = 2026-10-21T21:08:15.093Z`. Windows of 7 days end at `T`. Rows
are read from `state_rows` of the state database with collection
`role_memory` (kinds `rule`, `scope`, `request`) and `role_memory_curation`
(`r:` pass rows), and from `deliveries` of the delivery ledger. The store is
not append-only (state, reason and scope lists change in place), so a later
export reproduces the counts that depend only on write times (requests,
rules written, ledger rows); the point-in-time ones (scope fill, active
counts, rule fates) cannot be reproduced.

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
- **Blind sample and pilot**: strata and draws as in §1.6 and §5.5, order by
  SHA-256 of a fixed salt and the record id; Wilson intervals at 95 %.
