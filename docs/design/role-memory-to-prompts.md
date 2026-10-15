# Role memory to prompts: what the learned rules on this machine teach, what belongs in the role prompts, what stays memory

## Originating requirement

Operator, 2026-10-15 at about 10:35 UTC, spoken in Russian to this
repository's orchestrator seat, relayed by the controller as this stage's
brief (condensed by the seat, quoted as relayed):

> «analyse ALL learned memory on this machine — every active rule at
> machine, project and role level, across all projects, and all lessons —
> and think how to update the role prompts of every Delegatus agent role
> from it; memory itself will need expanding later, for now lessons are
> extended and checked. Read-only.»

The same morning (about 10:16 UTC) the operator pinned the lane's
specification: rewrite the role prompts and the orchestrator mandate so that
nothing important is lost and the rules that hold for every project, every
person and every task are extracted, «без привязки к какому-то конкретному
инструменту или фреймворку», and «це мають бути абстрактні правила».

What this stage owes, from the brief:

1. an inventory of every active rule by scope and theme, with duplicates and
   contradictions;
2. which rules are universal (tool- and project-agnostic) and belong in role
   prompts, per role;
3. which stay as memory, and at which level;
4. proposed prompt changes per role as before/after text, nothing important
   lost;
5. how memory should be expanded later.

Two constraints frame the answer. Review roles (reviewer, verifier,
issue-reporter, curator) receive no learned rules: `leave_lesson` refuses a
role lesson for them with `LESSON_CLEAN_ROLE`
(`src/lib/memory/roleStage.ts:112`, `src/lib/memory/eligibility.ts:11`),
and their launches carry no rules block
(`src/lib/memory/roleLaunch.ts:35`). A rule a reviewer must apply reaches it
only through its prompt. And this lane changes no live registry, no mandate
source and no product code; it proposes.

## Status and evidence

- Code: this worktree at `e3dad062c` on main; the prompt sources and the
  memory sources (`src/lib/memory/roleStore.ts`, `roleRender.ts`,
  `roleScopes.ts`, `roleTypes.ts`, `eligibility.ts`, `roleLaunch.ts`,
  `curation/brief.ts`) are the ones the serving release carries.
- Live registry: `role_presets` with `detail: true`, revision
  `roles-1-2049dd0aaa1fe9f4e7ce`, health `healthy`, no role's prompt text
  overridden; the role texts in
  `docs/design/role-prompts-rewrite/before/roles/` are the live texts.
- Learned rules: `curate_rules` refuses every caller except the scheduled
  curator (`CURATE_CALLER`), so the inventory was taken read-only from the
  `role_memory` collection of the live state database (opened read-only,
  no write, no lock held beyond the read), at 2026-10-15 13:56 UTC. The
  dump lived in this stage's scratch directory and is gone with it.
- Engine-side memory: `search_memory` in six phrasings and two kinds, and a
  read-only count of the memory index behind it (§1.6).
- Prior conversations: `search_transcripts` in two phrasings, project-scoped
  and unscoped, found the lanes listed under Prior work and no earlier
  proposal that maps learned rules into the shipped prompts.
- Rule texts stay on this machine. This document names rules by id, counts
  them, and states each class in its own words. Projects other than this
  repository are named by a letter and their kind.

### Prior work

- `docs/design/role-prompts-rewrite.md` (this lane, previous stage):
  inventory and classification of the 676 sentences of the shipped prompts,
  three rewrite variants, V2 recommended (a universal core of twelve
  principles, `role-prompts-rewrite/v2/core.txt`). Its §2.5 classed the 64
  rules this project's architect reads; this document widens that to every
  scope on the machine and builds on V2.
- `docs/design/role-memory.md`, `role-memory-curation.md` (levels, their
  boundaries, the curator's checklist) and `orchestrator-role-memory.md`
  (the seat reads and writes rules).
- `docs/design/lessons-from-review-findings.md` (#2779): fix rounds leave
  the rule their role needed; a rule carries `tasks`, the count of distinct
  tasks behind it; the curator names rules with `tasks ≥ 2` as "candidates
  for that role's template"; promotion is a manual operator step.
- A 2026-10-10 lane analysed 131 live rules as "too many, too
  task-specific" and asked for abstract lessons; the lesson request in
  `roleRender.ts:88-110` carries that today.

---

# 1. Inventory

## 1.1 The store

| | count |
| --- | ---: |
| rule rows ever written (2026-10-10 to 2026-10-15) | 1,511 |
| active | 243 |
| merged into another rule (`duplicate`) | 125 |
| archived | 1,143 |
| — of which earlier versions of a rewritten rule | 757 |
| — archived by the curator as task-specific | 341 |
| — stale 12 · in-code 9 · in-instructions 9 · problem 6 · duplicate 4 · contradicted 4 · deleted 1 | 45 |
| distinct active texts | 221 |
| active characters (rule text only) | 56,029 |
| active rules curated at least once | 229 of 243 |
| active rules kept by the operator | 0 |

The store is six days old. Four rules in five were written and then rewritten,
merged or archived; what is active is mostly the curator's wording of a
class, which explains the compressed, telegraphic style of many rules (the
300-character cap, `roleTypes.ts:15`, plus merges that "keep every
condition").

Who wrote the active rules: builder 125, architect 71, orchestrator seat 33,
prod-auditor 6, visual critic 4, merger 4. Origin: 111 from an ordinary
stage, 99 from a fix round (a rule the role needed before the review that
found the defect), 33 from a seat. No active rule carries a privacy hint.

## 1.2 By scope

Projects on this machine with memory: A is this repository (Delegatus, a
long-lived server with a browser UI); B is an ERP customization deployed to a
shared stand; C is a bot and web-app product with a blue/green backend; D is
a dispatching web application with a Python backend; E is a thesis
repository; F is a plain folder. E and F hold scope rows and no active rule.

| scope | active | chars | notes |
| --- | ---: | ---: | --- |
| machine | 22 | 3,742 | 14 tool quirks, 6 server-engineering principles, 2 Delegatus mechanics |
| project A | 6 | 1,245 | the 6 server principles again, in project form |
| project B | 2 | 579 | one ERP browser-check rule, one numeric-format rule |
| project C, D, E, F | 0 | 0 | |
| role on every project: builder | 38 | 8,106 | |
| role on every project: architect | 19 | 4,689 | |
| role on every project: orchestrator | 10 | 2,351 | |
| role on every project: prod-auditor | 6 | 1,351 | 4 are copies of architect rules |
| role on every project: visual-critic | 3 | 740 | 1 is a copy of an architect rule |
| role on every project: 8 other roles | 0 | 0 | cleaner, curator, deployer, issue-reporter, maintainer, merger, reviewer, verifier |
| role in A: builder 38 · architect 23 · prod-auditor 8 · orchestrator 5 | 74 | 16,668 | |
| role in B: builder 16 · merger 4 · orchestrator 4 · architect 2 · deployer 2 | 28 | 7,339 | |
| role in C: builder 15 · orchestrator 3 | 18 | 4,667 | 11 uncurated |
| role in D: builder 13 · architect 4 | 17 | 4,552 | 3 uncurated |
| **all** | **243** | **56,029** | |

What an agent actually reads: a stage of role R in project P reads
`role:P:R`, `role:*:R`, `project:P` and `machine`
(`roleStore.ts:readableScopes`). An architect stage in A today reads
23 + 19 + 6 + 22 = 70 rules, about 15,000 characters, before its brief. A
builder in A reads 38 + 38 + 6 + 22 = 104 rules, about 21,000 characters.
A reviewer in any project reads 0.

## 1.3 By theme

Every distinct active text was put under the first theme whose terms it
matches, by a keyword pass over the texts; a rule that touches several
themes counts once, under the first match, so each count is approximate to
a few rules. Counts are of distinct texts (221), by the level they are
stored at.

| theme | what the rules say | role:P | role:* | project | machine | total |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| T · tooling quirks | how a named tool behaves on this machine or in this stack (browser automation flags, the runtime's test runner, the package manager, the shell, kernel lock tables, the ERP's ORM, the backend's DI container) | 22 | 19 | 3 | 14 | 58 |
| U · rendered evidence | what to render, at which widths and states, how to measure overlap, clipping, alignment, contrast, visibility; what frames must show | 16 | 12 | 1 | 0 | 29 |
| C · concurrency, locks, leases, processes | what to probe after an await, who owns a signal or a handle, how counters and budgets survive restarts, how queues and sessions end | 16 | 3 | 0 | 0 | 19 |
| M · measurement and performance | before/after on identical data, like-for-like windows, labelled slow work, bounded caches, cost by component | 14 | 7 | 4 | 4 | 29 |
| D · deploy, stand and production ops | upgrade sequencing on a shared stand, reconciling receipts after an interruption, read-only probing of production, capacity attribution | 15 | 6 | 0 | 2 | 23 |
| O · operator and seat practice | do what was asked, forms admit free text, one-line reports for routine re-runs, how to brief a merger or a successor lane, account pinning near limits | 9 | 11 | 0 | 0 | 20 |
| F · forge, git and merge | first-parent history, batch merges, rebases that drop accepted commits, predecessor closure, fenced areas, open parallel pull requests | 11 | 6 | 0 | 0 | 17 |
| P · privacy and publication | credential-shaped lines, identities and trailers, scrub extractors, style bans, release-note citations, doc pages as the forge renders them | 11 | 3 | 0 | 0 | 14 |
| S · design and analysis method | trace every caller and consumer, threat cases against higher-precedence paths, catalog assets by name, budgets and counters, ownership versus deletion evidence, dating actions from primary records | 6 | 0 | 0 | 0 | 6 |
| Q · tests and data correctness | deterministic ids, frozen clocks, pagination under change, caps across transport, failure paths beside success paths | 1 | 3 | 0 | 1 | 5 |
| X · other | one Delegatus board-timeout rule | 0 | 0 | 0 | 1 | 1 |
| **total** | | **121** | **70** | **8** | **22** | **221** |

Three observations:

- **Tooling quirks are the largest theme (58 of 221).** They are true, they
  are expensive to relearn, and almost none of them is universal: a rule
  about a browser-automation flag or a test runner's matcher is bound to the
  tool. They are exactly what memory is for.
- **Rendered evidence is the second largest (29) and almost all of it is
  tool-free.** Thirteen of these rules were written by architects and copied
  by the curator to builders, prod-auditors or visual critics. They say the
  same things in different words: render every state at every width, name
  the defining element, measure from text ranges, no overlap, inert modal
  backgrounds, distinct visible words for neighbouring states. This is a
  universal block for every role that renders or judges a screen, and today
  no shipped prompt carries it.
- **The machine level is not what the design says it is.** Of 22 machine
  rules, 14 are tool quirks a cleaner or a deployer never acts on, 6 are
  engineering principles for long-lived servers that only a builder, an
  architect, a prod-auditor and a reviewer apply, and 2 are Delegatus
  mechanics. The design's criterion for machine is "every role acts on it
  alike in any repository" (`role-memory-curation.md` §3.0). Only the two
  mechanics rules and perhaps the shell-script and temp-path rules meet it.

## 1.4 Duplicates

**Exact copies across scopes: 17 groups, 39 rules.** The curator's checklist
4 and 5 say that a rule several roles act on gets a copy under each role and
rises to the project only when every role acts on it, so copies are the
designed outcome. Groups (ids by scope):

- role on every project, architect ↔ prod-auditor ↔ visual critic:
  `r_05739da160fe42f6` / `r_17f76b0a009998a6` / `r_443e8401eb32ce52`
  (scratch export for write-fenced stages); architect ↔ prod-auditor:
  `r_03e0441f0e0ceabc` / `r_a19cac81b169b5c8` (raw official content for
  price audits), `r_df2341fdff82f41b` / `r_348cd7ef22df1cf9` (clone
  fallback from a stage); architect ↔ builder: `r_cbd63dcac30e81b5` /
  `r_6fd97c98a96c315b` (defining element visible on the first screen),
  `r_8241a828585a79a5` / `r_39b9c9cc6bd86e86` (forms admit free text).
- role in A, three-way copies: `r_ebb912c8dc94c041` / `r_283b4fc54d5ebe79`
  / `r_188a04edd2ad0061` (first-parent history for landed work);
  `r_ddf51d94eae7ca43` / `r_8b5ff93045503894` / `r_740da6a04a0e4cda`
  (credential shapes in committed text); `r_a24ab995fc4c3c7e` /
  `r_9aed5c0e19937ab3` / `r_bf5d9ce911ca40f9` (read the latest answers
  before publishing); `r_ca615273afc2b7bf` / `r_d0f1d380a82e85a3` /
  `r_d784b50db7aa1203` (date actions from the primary record); two-way:
  `r_ed0bcf456b857eee` / `r_a788ab680a3fa77c` (fenced areas),
  `r_b2e3465f7b63d212` / `r_ff810d9c2862e17f` (capture drivers),
  `r_2dc70fda3cd204f5` / `r_1127ed2d55a1e05d` (store timing).
- role in B: `r_0c5d973bb983e6ff` / `r_b43975e0808c6fe7` and
  `r_a13847bc216972e0` / `r_f981434468672419` (builder ↔ deployer, stand
  upgrades).
- role in D: three layout-audit rules, architect ↔ builder
  (`r_f59d8e8973e82a4f` / `r_3362ca8ab317dad0`, `r_5233674333c3ee7c` /
  `r_75f083c93935d3c7`, `r_df055c19b893e09a` / `r_3bdd7090036c28e8`).

**Near-duplicates (same class, different wording): 7 groups, 15 rules.**
`r_bb751eb160754ffc` and `r_e8c9fd37c524c477` (inert modal background);
`r_7f8572fdf928f5c2` and `r_77fc7abe32501e22` (popover boxes against
foreign text); `r_683a5f5b0799e39f` and `r_993f853f9eea89d5` (the
prototype width matrix); `r_20c3a41be387a482` and `r_610444719b0ea163`
(counts and statuses from shared state); `r_d6ec86fc782898ee` and
`r_d0bd52a6d2de30d7` (a stale integration receipt on a shared stand);
`r_bec8d03dde587664` and `r_09d846fc007b3baa` (a data load's loader and
manifest before deployment); `r_11ac1155eccf8fe7` contains
`r_8241a828585a79a5` whole.

**Level twins: 6 pairs.** Each of the six server-engineering rules at
machine level (`r_b4b1e13108cc4d29`, `r_c869bcde5b95b72a`,
`r_2979d609338030f9`, `r_18779603ccf36f9b`, `r_4592bedbfb8ef2e5`,
`r_fa84534081f0d90f`) has a "project form" at project A level
(`r_a954a09a49e2640c`, `r_851d675f7202bb42`, `r_d851907a6bfc2bc9`,
`r_f7dcc821242dff13`, `r_85009c5923b00682`, `r_6aea5f42f89e67c3`) that names
this repository's helpers and tags. An agent in A reads both.

In all, 60 of 243 active rules (25%) are a copy, a near-copy or a level twin
of another active rule. The cause is structural: there is no scope that two
or three roles share, so the curator copies, and there is no scope that
"everyone who renders a screen" shares, so each role relearns the same
class. §5.1 proposes the scope that removes this.

## 1.5 Contradictions and tensions

Rules that contradict each other or the shipped prompts, read together by
the same agent:

1. **Scratch location.** `r_1aa162e17fde7afa` (project C, builder) tells
   the builder to keep scratch output under a directory it names under the
   system temp root, outside the worktree. The reviewer and architect
   scaffolds, and V2's mechanics block, say the stage's own `$TMPDIR`,
   "never a directory you name under /tmp or /var/tmp". The rule's
   substance (leave nothing in the worktree; the controller stages leftovers
   at settlement and refuses ignored paths) is right and universal; its
   location advice contradicts the prompt. A builder in C reads both.
2. **Rebase.** `r_803c316e8c3af4c6` (orchestrator, every project): never
   brief a rebase on a successor lane, because the controller refuses a head
   that drops accepted commits. Project B's merger rules
   (`r_bd594febda0ae867`, `r_e6e5071fabcf0bcc`) use head-guarded rebases to
   land prerequisites and preserve authorship. Both are right in their
   context; nothing tells the merger that a branch a lane still continues
   must not be rebased. The merger block in §4.1 states it.
3. **Merger without batch tooling.** The shipped merger prompt is the
   protocol of this repository's batch script (previous document, §2.3).
   Two projects learned the same workaround independently:
   `r_6fe87b303f22729a` (C) and `r_efb65732c07e0fb4` (B) tell the seat to
   authorize the plain exact-head squash in the brief, or the merger parks
   asking for a batch receipt. V2 makes the merger generic and has it finish
   with needs_decision when the project names no batch procedure; that would
   still park on B and C. §4.1 gives the merger a plain-merge default
   instead, and the two rules become in-instructions once it ships.
4. **Proactive seat versus literal request.** `r_0ee4a00258704cf9`
   (orchestrator, every project): do exactly what the operator asked, where
   they said; anything beyond is a proposal offered in chat. The mandate
   defines "proactive" three times (previous document, §2.4) and the seat's
   engine memory holds "act on obvious unblocks". These are reconcilable
   (unblocking a jam the operator already authorized is inside the request;
   adding a destination or a file is outside), and the mandate should say so
   in one place; the seat block in §4.1 does.
5. **Blocked versus hold** (previous document, §2.4) is unchanged by memory;
   no rule touches it.
6. **In the archive**, the curator recorded four `contradicted` pairs and
   kept the side the code supported at the time (`r_7f9c75e380e358d0` against
   `r_77fc7abe32501e22`, `r_9beb70db2866e8a1` against `r_ed6efeea28042334`,
   `r_b93d7d3a10e26dd0` against `r_3af8e9b625110e0d`, `r_e59be9208815117c`
   against `r_4dacde0d6b572d34`). That path works.

## 1.6 Engine-side memory, for completeness

`search_memory` reads a separate index of each engine's own memory: Claude
project memory files, Codex session summaries, both engines' global
instruction files and single-fact skills. Its row counts, read-only:

| source | entries |
| --- | ---: |
| Codex rollout summaries (reference) | 6,082 |
| Claude index references | 644 |
| Claude preference memories | 334 |
| Claude project facts | 292 |
| Claude references | 109 |
| skills (shared) | 331 |
| Codex summaries and global preferences | 33 |
| global instruction files (one per engine) | 2 |
| **entries** | **7,827** (1,393 files) |

What matters for this design: the 334 Claude preference memories are the
operator's practice rules as a seat recorded them (how to show status, when
to ask in a form, what to deploy first). They reach one engine and one
account; a Codex seat of the same project does not read them, and no stage
reads them. Several say what a learned rule also says (browser-tested UI
changes; a seat problem becomes a rule or a task; forms over chat
questions). Many are duplicated between an old project path and an imported
copy. Four broad `search_memory` queries on practice terms returned 0 to 2
hits each, and only a query filtered to the `preference` kind returned a
page of them, so this store is hard to recall by search. §5.6 proposes what
to do with it.

## 1.7 Who reads what today

| reader | learned rules | shipped prompt | where a rule it must apply can live |
| --- | --- | --- | --- |
| builder, architect, cleaner, deployer, merger, prod-auditor, visual-critic stages | four scopes (`roleLaunch.ts`) | scaffold + stage wrapper | memory or prompt |
| orchestrator seat, maintainer | four scopes with the seat notice | scaffold + mandate / maintainer scaffold | memory or prompt (mandate) |
| reviewer, verifier, issue-reporter, curator | none (clean) | scaffold + stage wrapper | prompt only |
| spawned role agents outside a pipeline | four scopes when the launch profile names a role | scaffold + spawn line | memory or prompt |

The reviewer gap is the one that costs most: 99 of the 243 active rules were
written by fix rounds, that is after a reviewer found a class of defect, and
they describe what a reviewer looked for. The reviewer that found it reads
none of them next time; the builder reads all of them. The prompt is the only
channel to the reviewer, so §2.4 and §4 give the reviewer the judging form of
every universal class.

---

# 2. Universal rules that belong in role prompts

## 2.1 The test

A rule goes into a prompt when all of these hold:

- **Tool-free:** it names no tool, framework, language, file or command; a
  trigger may name a kind of work ("when the work changes what a person
  sees", "when the work touches a long-lived server").
- **Project-free:** it holds in any repository on any machine; at least two
  projects on this machine, or two roles, learned it, or it restates one of
  the twelve V2 core principles with a sharper trigger.
- **Role-wide:** every agent of the roles it is addressed to acts on it in
  its ordinary work, so that reading it at every start is cheaper than
  relearning it.
- **Stable:** it will still be true when the tools change.

A rule that fails the first or second test stays memory (§3). A rule that
passes them but is acted on by one role only goes into that role's part, not
the core.

## 2.2 The classes memory adds to the universal core

The twelve V2 core principles cover what the shipped prompts already said
in scattered places. Memory adds four principles that no shipped text states
and sharpens three that the core states loosely. Backing ids are the active
rules whose class the principle names; after promotion the curator archives
them as `in-instructions` (checklist 2).

| # | principle (short form) | backed by | learned in | roles that act on it |
| --- | --- | --- | --- | --- |
| 13 | **Read the newest answer before you act.** A later answer replaces only the decision it names; before you publish, decide or re-ask, read what was answered since the brief; never re-ask a settled question. | `r_a24ab995fc4c3c7e` (+2 copies), `r_4fe6c7706d25c6f3`, `r_c2e419ba5014c61b`, `r_433c378e4ad0834c` | A (architect, builder, seat) | every role; the seat first |
| 14 | **Date and list from the primary record.** The time of an action is the clock of the action; the arrival of a report about it tells you nothing about when it happened. A summarised list can miss entries, so check the source before calling something absent or new. | `r_ca615273afc2b7bf` (+2), `r_ebb912c8dc94c041` (+2), `r_150208b4d6f488bf`, `r_134244464d1c46b0`, `r_ea1a929bde01b74f` | A (architect, prod-auditor, seat, builder) | every role that reports; sharpens core 6 |
| 15 | **A reply is no proof of what happened.** Before a retry, read the state the action should have changed; retry with the same key when it may have landed; a message is delivered when its destination shows it. | `r_61f2cf2f612fd49c`, `r_d23af0d290bda1ac`, `r_8fc1437a7d6fc29b`, `r_98eae49e5c20d7fe` | A (architect, seat), B (merger) | every role; the seat and the deployer most |
| 16 | **Leave the checkout as you found it.** Work, build, probe and render in a scratch export of the commit; a read-only stage leaves no new file behind, ignored ones included. | `r_05739da160fe42f6` (+2), `r_1aa162e17fde7afa`, `r_019be1b36b6dfdca`, `r_71b8e9ffdb428733` | A, C (architect, prod-auditor, critic, builder, seat) | every stage; today only reviewer and architect prompts say it |
| 6′ | **Evidence provenance** (sharpens core 6): evidence is made from the final state by the recorded procedure and says what it was made from; regenerate after the last change; look at every frame yourself; a speed, memory or cost claim rests on before/after on identical data and load, with the load recorded. | `r_145e15e39dc953e0`, `r_d18256459a7d92f7`, `r_c3e5ec7527cc1ab4`, `r_ff810d9c2862e17f`, `r_fa84534081f0d90f`, `r_6aea5f42f89e67c3`, `r_5ed89c43655bc53e`, `r_35361805df13a61b`, `r_2dc70fda3cd204f5`, `r_8689ac4eb73ab5cb`, `r_aec9eddc5d6adf3e`, `r_486c2d8b6e387742` | A, C (builder, critic, seat, prod-auditor) | builder, architect, verifier, visual-critic, prod-auditor, reviewer, deployer |
| 8′ | **Open parallel work** (sharpens core 8 and 3): list the open changes that touch the same files or issue and read their actual diffs; recheck the base before you finish. | `r_1c4b8fcfaab6fc82`, `r_ed0bcf456b857eee` (+1), `r_0de29e8da84bca83`, `r_539cbcaaebd15323` | A (architect, builder, seat) | builder, architect, merger, seat, reviewer |
| 12′ | **Publication hygiene** (sharpens core 12): run the project's publication checks on the files before handover; credential-shaped examples go in prose; trailers in one final block with the launched identities. | `r_ddf51d94eae7ca43` (+2), `r_ae7b46d00637e4f1`, `r_a09dd0f23294f9df`, `r_3191f198a7afdd78`, `r_ad88eb09dfee5fa8` | A (architect, builder, prod-auditor) | builder, architect, merger, issue-reporter |

Five conditional blocks follow the same test but apply to a kind of work,
so they go to the roles that do or judge that work:

| block | trigger | what it says (short form) | backed by | learned in |
| --- | --- | --- | --- | --- |
| RENDERED | the work changes what a person sees | every state at every named and intermediate width, each language and theme, real data; defining element visible on the first screen; no overlap, no clipping, measured from text ranges; inert modal background; contrast and target floors; a fact once per surface; neighbouring states told apart by words; evidence at the exact viewport, scrolled until whole | `r_683a5f5b0799e39f`, `r_993f853f9eea89d5`, `r_7f8572fdf928f5c2`, `r_77fc7abe32501e22`, `r_cbd63dcac30e81b5` (+1), `r_bb751eb160754ffc`, `r_e8c9fd37c524c477`, `r_20c3a41be387a482`, `r_610444719b0ea163`, `r_82995cc5daa98212`, `r_f59d8e8973e82a4f` (+1), `r_5233674333c3ee7c` (+1), `r_df055c19b893e09a` (+1), `r_aa90f93518308dff`, `r_49482f52b4039c8b`, `r_812eb8c4be1bf9b5`, `r_c8aa83d7f9e2b530`, `r_d45b19dc0fe6ef7d`, `r_4f41b86501b43d8d`, `r_9d7b29cf71e3e274`, `r_a82a0f50c4d1f3c9`, `r_2741b6ee2289c1b2`, `r_9c5f9531c3980403`, `r_3416f0eb8e646071`, `r_c3e5ec7527cc1ab4` | A, B, C, D |
| TESTS | the work writes or judges tests | deterministic ids, order and time; a failure case beside each success case; in-memory budgets tested by restarting the real process; races probed after each await; cleanup owns only its handles; baseline before blame | `r_1e44b3829a23a76f`, `r_ac39458a8661f4a5`, `r_c10e3cc2f1363aa7`, `r_0ccb16d01b06da1e`, `r_858f77a51e8dcd49`, `r_729f9a238ec156cd`, `r_e798b3c5d526db97`, `r_050fc8122b896640`, `r_34648454387f21bc`, `r_97424278a65d0291`, `r_9589b1f33372d2f4`, `r_5d207362b1e14dfb`, `r_a81c01bf36cb21f9` | A, C, D |
| SHARED PATHS | the work changes a contract, schema or write path others use | list every producer, consumer, copy, default and cascade; a check on submitted values misses defaults, copies and parent paths; for a privacy, authorization or fallback promise name the server-side check, try hostile input, run threat cases against every higher-precedence path | `r_29f9b3674e3d714e`, `r_bba6516e82f53c95`, `r_2e6de7be8ed7122c`, `r_423c10cb05217858`, `r_2db5319d149f9906`, `r_699737aa8a99278a`, `r_a2a665f6b077bcf6`, `r_6eefbb58037367a4`, `r_3d27cdd6cffe21cf`, `r_8cd0ac8698041b47`, `r_3fbd1b8880c24310`, `r_c1ec1a29264af989`, `r_ae9c9fd65797e0ba`, `r_cf567b8e5b89ddfe` | A, B, D |
| SERVER | the work touches a long-lived server or a hot path | no synchronous wait on the main loop; work scales with what changed; bounded, owned caches; first answers from a persisted artifact; slow work labelled; a hot-path change carries its measurement | the six machine rules and their six project twins (§1.4) | A (seat, from five incidents in one week) |
| SEAT | the orchestrator seat | do what was asked, where asked; a proposal is offered, acted on after a yes; routine recoveries in one line; every form question admits free text; unknown names looked up inside the vendor under discussion; delivered means shown at the destination | `r_0ee4a00258704cf9`, `r_f726db14334664cc`, `r_11ac1155eccf8fe7`, `r_8241a828585a79a5` (+1), `r_c9c7b01f416ccb7a`, `r_8fc1437a7d6fc29b` | A, C (seats) |

Together: 4 new principles, 3 sharpened ones, 5 conditional blocks, backed by
112 of the 243 active rules (94 distinct texts, the rest copies and twins
of them). Everything the shipped
prompts say today stays as V2 placed it; nothing in this list replaces a
sentence of V2, it adds to it.

## 2.3 Per role

Which universal additions each role receives, on top of the V2 core it
already receives in that variant:

| role | 13 | 14 | 15 | 16 | 6′ | 8′ | 12′ | RENDERED | TESTS | SHARED PATHS | SERVER | SEAT |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| builder | ● | ● | ● | ● | ● | ● | ● | frontend and prototype modes | ● | ● | ● | |
| reviewer | ● | ● | ● | ● | ● | ● | | ● | ● | ● | ● | |
| architect | ● | ● | ● | ● | ● | ● | ● (documents) | prototype mode | | ● | ● | |
| verifier | ● | ● | ● | ● | ● | | | | | | | |
| visual-critic | ● | | | ● | ● | | | ● | | | | |
| prod-auditor | ● | ● | ● | ● | ● | | | | | | ● | |
| cleaner | ● | ● | ● | ● | | | | | | | | |
| deployer | ● | ● | ● | | ● | | | | | | | |
| merger | ● | ● | ● | ● | | ● | ● | | | | | |
| maintainer | ● | ● | ● | | | | | | | | | |
| curator | ● | ● | | ● | | | | | | | | |
| issue-reporter | ● | ● | ● | | | | ● | | | | | |
| orchestrator seat (mandate) | ● | ● | ● | ● | | ● | | | | | | ● |

Principles 13 to 16 go into the core so that every role reads them once;
the rows mark where they matter most. The conditional blocks are appended
only to the roles marked, by the same mechanism V2 uses for BASELINE and
RENDERED (`roles/defaults.ts` blocks assembled per role).

## 2.4 The reviewer

The reviewer reads no memory, so the reviewer's prompt has to carry the
judging form of every class a fix round learned. The classes above are the
ones 99 fix-round rules describe. In the reviewer's prompt they read as
checks a reviewer applies:

- RENDERED: evidence that skips a named width, state, language or theme is a
  finding; a control that overlaps or leaves the viewport, a cut row, a
  background that stays focusable under a modal, a state told apart by
  colour alone, are findings with the viewport and the measured numbers.
- TESTS: a test that depends on wall-clock time, collection order or a random
  id, a budget tested inside one process, a success path without its
  failure path, a cleanup that stops by name or pattern, are findings.
- SHARED PATHS: a contract change with an unlisted producer or consumer, a
  guard that reads submitted values and misses defaults, copies or cascades,
  a promise with no server-side check, are findings.
- SERVER: a synchronous wait on a main loop, per-tick work proportional to
  total data, an unbounded or duplicated cache, a cold path that rebuilds
  derived state before its first answer, an unlabelled slow operation, a
  hot-path change without its measurement, are findings.
- 6′, 14, 8′: evidence without its revision and time, a date taken from a
  report's arrival, a change that ignores an open pull request on the same
  files, are findings.

The verifier gets 13 to 16 and 6′ (its work is evidence); the issue-reporter
gets 12′ beside its own scrub rule; the curator gets 13, 14 and 16 (it reads
rules against the current code and must not leave files behind).

---

# 3. What stays memory, and at which level

## 3.1 The test, inverted

A rule stays memory when it names a tool, a stack, a file, a repository
procedure or an operator's current preference, or when one role in one
project learned it and no second task confirms it. Memory is where a rule is
cheap to write, cheap to retire, and read only by the roles and projects it
is about. Of the 221 distinct active texts, 127 stay memory under this test;
94 move into prompts (§2.2) and are archived as `in-instructions` once the
prompt ships.

## 3.2 Disposition by theme

| theme | stays memory | level today | level it should have | notes |
| --- | ---: | --- | --- | --- |
| T · tooling quirks | 44 of 58 | 14 machine, 19 role:*, 22 role:P, 3 project | **toolkit scope** (§5.2) read by the roles that run tools; until then role:* for the role that uses the tool | the 14 machine rules are read by cleaners, deployers and mergers that never open a browser; the ERP, DI-container and test-runner rules belong to their stack; the 14 that move are the ones whose substance is tool-free (scratch exports, stand receipts, evidence provenance) |
| U · rendered evidence | 9 of 29 | role:P, role:* | role:P | the ones that stay name a product component, a project's driver or a motion capture recipe (`r_bd3fb75c67d52d64`, `r_236f876d5cbbb7cf`, `r_1856613bd7e8c8d5`, `r_9da7d45109b33cc8`) |
| C · concurrency, locks, leases, processes | 12 of 19 | role:P, role:* | role:P (they describe one codebase's lease, queue or namespace model) | the universal ones moved to TESTS |
| M · measurement and performance | 14 of 29 | role:P, role:*, project, machine | role:P for store- and bundle-specific measurement; the six machine principles move to SERVER and their project twins stay in **project A** as the repository's named helpers | |
| D · deploy, stand and production ops | 17 of 23 | role:P, role:*, machine | **project B** instruction files for the stand procedure (shared by builder and deployer today as copies); role:P for the rest | project B has 2 project rules and 28 role rules; its stand procedure is read by two roles and belongs in its repository |
| O · operator and seat practice | 11 of 20 | role:*, role:P (orchestrator) | role:*:orchestrator for how to brief lanes and pin accounts; role:P:orchestrator for one project's merge and release habits | the rest moved to SEAT and to principles 13 and 15 |
| F · forge, git and merge | 6 of 17 | role:P, role:* | role:P (merger, builder) | the fenced-areas, first-parent, open-PR and predecessor rules moved to 8′, 14 and 15 |
| P · privacy and publication | 6 of 14 | role:P, role:* | role:P (builder) for the scrub-extractor and doc-page rules, which name this repository's gate | the rest moved to 12′ |
| S · design and analysis method | 4 of 6 | role:P | role:*:architect | `r_53987e4be1891aa9` (catalog assets by name) and `r_8be4966e99699181` (token budgets) are near-universal architect rules; kept in memory until a second project confirms them |
| Q · tests and data correctness | 3 of 5 | role:*, role:P | role:*:builder | the two that move are in TESTS; the rest name one store's pagination or cap model |
| X · other | 1 of 1 | machine | role:*:architect and role:*:builder | the board-timeout rule is Delegatus mechanics (`r_61f2cf2f612fd49c`) and belongs with the roles that publish prototype reviews |

The "stays" column follows the keyword themes of §1.3 and carries the same
approximation; the moved set itself is exact: the 94 distinct texts behind
the ids in §2.2.

## 3.3 Mis-levelled rules, by the design's own boundaries

- **Machine → role.** 20 of 22 machine rules fail "every role acts on it
  alike". Until a toolkit scope exists (§5.2), the 14 tool rules belong under
  `role:*:builder` and `role:*:architect` (the roles that drive browsers,
  runtimes and git), and the 6 principles become the SERVER block. The
  curator can do this with `move` and `split` today.
- **Project A's six twins** stay at project A: they name the repository's
  admission helper, loop monitor tags and bootstrap; every role working in A
  that touches the server acts on them. They are the repository's
  engineering rules and would sit as well in its instruction files.
- **Role copies** (§1.4): 17 groups stay copies until a multi-role scope
  exists; the curator should at least merge the 7 near-duplicate groups into
  one wording each.
- **Uncurated rules in C and D** (14): three of them restate what the curator
  elsewhere widened to role:*; they wait for the next pass.

---

# 4. Proposed prompt changes per role

The base is V2 of the previous document (`role-prompts-rewrite/v2/`). The
changes below are the memory delta on top of V2; a diff of V2 against V2
plus this delta is what the prototype stage should render beside the V2
diff, so the operator can accept V2 alone, V2 with the delta, or neither.
"Before" quotes the live text (`before/roles/*.txt`, identical to the
shipped code), or says none.

## 4.1 The texts

Characters are Unicode code points of the text as written here.

**Core, principles 13 to 16** (appended to `v2/core.txt`, 1,071 characters;
with the three sharpened principles below the core grows from 3,917 to
5,974):

> 13. Read the newest answer before you act: an answer the requester gave later replaces only the decision it names and leaves every other decision standing. Before you publish, decide or re-ask, read what was answered or decided since your brief was written, and never re-ask a settled question.
> 14. Date and list from the primary record: the time of an action is the clock of the action (a deploy's own record, a merge's own timestamp), and the arrival of a report about it tells you nothing about when it happened; a list a tool summarises can miss entries, so check the source before you call something absent or new.
> 15. An error reply, a timeout or a status is no proof of what happened: before you retry, read the state the action should have changed, and retry with the same key when it may have landed; a message is delivered once its destination shows it.
> 16. Leave the checkout as you found it: work, build, probe and render in a scratch export of the commit and leave the live checkout untouched; a read-only stage leaves no new file behind, ignored ones included.

**Principle 6, sharpened** (replaces V2's sentence 6, from 261 to 676
characters; the V2 sentence is kept whole as its first half, including
"say where you looked for what you could not confirm", which V2 merged
in from the prod-auditor, `PA.5`):

> 6. Back every claim with its evidence: the command and its output, the file and line, a measurement with its conditions, the time bounds of what you read. Keep what you observed apart from what you infer, and say where you looked for what you could not confirm. Evidence you hand over is made from the final state, by the recorded procedure, and says what it was made from (revision, time, command); regenerate it after the last change that could alter it. Look at every frame, table and output yourself before you cite it. A claim about speed, memory or cost rests on a before/after measurement on identical data and load, repeated, with the load recorded beside the numbers.

**Principle 8, sharpened** (adds 233 characters to V2's sentence 8):

> 8. Stay in scope: do what the brief names, leave alone the files and areas other open work is changing, and say so when your work needs them. Before you start, list the open changes that touch the same files or the same issue and read their actual diffs, because a brief's file list can be wrong; before you finish, recheck the base you started from and reverify what moved.

**Principle 12, sharpened** (adds 345 characters to V2's sentence 12):

> 12. Keep identities out of public text: a commit, pull request, issue or published document names no people or accounts and carries no emails, secrets, hostnames, private paths or quotes from private conversations; describe a thing by its kind. Before you hand over text that leaves the machine, run the project's own publication checks on those files and read the result; a credential-shaped example is written as prose; a key-and-value line with a secret-shaped value fails the gate. Attribution trailers stay in one final block and keep the identities you were launched with.

**RENDERED block** (replaces V2's RENDERED for reviewer and architect, new
for builder frontend and prototype modes and for the visual critic; 1,009
characters):

> Rendered work (when the work changes what a person sees): render every state at every width the requirement names and at one width between each named pair, each language and theme the project ships, with real data in every field and a non-default value where one exists. For each state name its defining element and check that it is visible text on the first screen at every width. No control, popover, tooltip or menu may overlap foreign text or leave the viewport, and no row or label may be cut by a scroll edge, a pinned bar or the window; measure from text ranges, because element boxes alone miss fractional cuts. A modal makes its background inert: keyboard traversal and taps outside it reach nothing behind. Text contrast and target sizes meet the platform's accessibility floor. Show a fact once per surface; give neighbouring states distinct visible words; a colour difference alone tells them apart for nobody. Evidence covers each changed string at the exact viewport, scrolled until it is whole.

For the reviewer, the architect and the visual critic the block is preceded
by a line of its own, "Judge rendered work by the rules below; each breach is
a finding carrying the viewport and the measured numbers.", and keeps V2's
sentence about evidence that skips a named surface. For the architect it
replaces V2's other two RENDERED sentences: rendering in a scratch export of
the commit moves to core 16, and the severity-ranked findings with viewport
and numbers are that intro line.

**TESTS block** (builder, reviewer; 584 characters; the reviewer's BASELINE
sentences of V2 stay beside it):

> Tests (when you write or judge them): identifiers, order and time are deterministic (frozen clocks, fixed ids, no dependence on collection order); every failure path has a case beside the success path; a budget, counter or guard that lives in memory is tested by restarting the real process, because a loop inside one process never resets it; a race is probed after each await by changing the state the code assumed; cleanup stops only handles the test created. Before you blame a change for a failing test, run the same test on the base with the same isolation and keep both results.

**SHARED PATHS block** (builder, architect, reviewer; 462 characters):

> Shared paths: before you change a contract, a schema or a write path that others use, list every producer, consumer, copy, default and cascade that reaches it, and check what each passes; a check on submitted values alone misses defaults, copies and parent paths. For a privacy, authorization or fallback promise, name the server-side check that keeps it, try hostile input against it, and run each threat case against every path that answers before the new one.

**SERVER block** (builder, architect, reviewer, prod-auditor; 618
characters):

> Long-lived servers and hot paths (when the work touches one): the main loop never waits synchronously on a shared resource; a wait is asynchronous under one deadline and recorded with its origin. Work per request, poll or tick scales with what changed; a whole-store read per tick is a defect. Every cache has a bound, an eviction rule and one owner, and large payloads stream. Startup and first requests answer from a persisted, validated artifact and refine afterwards. Slow or blocking work carries a label that monitoring can report. A change on such a path carries its before/after measurement, or claims no gain.

**SEAT block** (the mandate's "Who you are", after the definition of
proactive; 565 characters):

> Do exactly what the operator asked, where they asked it; anything beyond the literal request is a proposal offered in chat and acted on only after their yes. A routine recovery (a re-run of a flaky check, a retry) is reported in one line or not at all; alarm wording is for something broken. Every question in a form admits a free-text answer. An unfamiliar product or model name is looked up first inside the vendor already under discussion. A message you sent is delivered once its destination shows it; the sending tool's answer proves only that it was accepted.

**Merger default** (replaces V2's "finishes with needs_decision when the
project names no batch procedure"; 344 characters):

> Merge through the batch procedure the project's instruction files name; when the project names none, merge each listed pull request at its reviewed head with the plain exact-head squash and the launched identity, and say so in your report. A rebase of a branch that a lane still continues drops accepted commits: merge the base into it instead.

## 4.2 Per role, before and after

Each row names the concern, what the live prompt says about it today, and
what the role reads after the change. Sizes are the delta on top of V2's
role file.

### Builder (V2 4,544 → about 8,200 characters; frontend and prototype modes + 1,009)

| concern | before (live) | after |
| --- | --- | --- |
| newest answer, primary record, reply is no proof, clean checkout | none | core 13–16 |
| evidence provenance | "Review your own diff before you finish and report the verification evidence." | core 6 sharpened |
| open parallel work | "When the brief lists files or areas that other open lanes are changing, leave them alone, and say so when the work needs them." | core 8 sharpened: list the open changes yourself, read their diffs, recheck the base before finishing |
| publication hygiene | none (the builder writes every commit and pull request) | core 12 sharpened |
| rendered work | frontend mode only: "follow the approved interaction and visual contract, preserve accessible semantics and responsive behaviour, and keep every language the project ships in step. Reuse the colours, type, spacing and components…" | that sentence stays (V2 FRONTEND) + RENDERED block in frontend and prototype modes |
| tests | none | TESTS block |
| shared paths | none | SHARED PATHS block |
| servers | none | SERVER block |

### Reviewer (V2 7,847 → about 11,900 characters)

| concern | before (live) | after |
| --- | --- | --- |
| 13–16 | none; the scratch rule exists only inside the rendered-surfaces rule | core 13–16 |
| evidence, open work | "Three standing rules… (1) Anchor the frame… (2) Over-engineering pass… (3) Rendered surfaces…" | V2 keeps them; core 6 and 8 sharpened add the provenance and open-work checks |
| rendered work | rule (3): "Check that the author's rendered evidence reaches every surface and every viewport the requirement names; evidence that skips a named surface is a finding on its own… report overflow, clipped or zero-width controls, overlap and unreadable states as severity-ranked findings carrying the viewport and the measured numbers." | that sentence stays + RENDERED block in its judging form (§2.4) |
| tests | "Test baseline comparison: before attributing a failing test to the change, compare the same explicit test file on the captured review base and the reviewed head…" | V2 BASELINE stays + TESTS block in its judging form |
| shared paths, servers | none | SHARED PATHS and SERVER blocks in their judging form |

### Architect (V2 6,541 → about 10,350 characters)

| concern | before (live) | after |
| --- | --- | --- |
| 13–16 | the scratch rule inside rule (3) only | core 13–16; 13 matters most (a design published against a decision the operator made meanwhile, `r_a24ab995fc4c3c7e`) |
| evidence, open work, publication | rules (1)–(3); nothing on open pull requests, nothing on publication checks for the document it writes | core 6, 8, 12 sharpened |
| rendered work | rule (3) as for the reviewer | the block above in its judging form; V2's sentence on evidence that skips a named surface stays, its scratch-export sentence moves to core 16 |
| shared paths, servers | none | SHARED PATHS and SERVER blocks (design-time form) |

### Verifier (V2 5,560 → about 7,550 characters)

| concern | before (live) | after |
| --- | --- | --- |
| 13–16 | none | core 13–16; 14 and 15 are its daily work (a claim about when something happened, a claim that a message was sent) |
| evidence | "Label every claim CONFIRMED, WRONG or UNCONFIRMED with its exact evidence" | stays + core 6 sharpened |

### Visual critic (V2 6,182 → about 9,350 characters)

| concern | before (live) | after |
| --- | --- | --- |
| 13, 16 | none | core 13 and 16 (frames from an export of the head; judge the round the operator has not yet answered) |
| evidence | "Look at every frame yourself, as the operator would use the screen." | stays; core 6 sharpened adds provenance: frames made after the last change, from the reviewed head (`r_c3e5ec7527cc1ab4`) |
| rendered work | "Capture every touched surface at 1440x900, 1000x700 and 390 px wide, in en and uk, light and dark" and the three classes of finding | V2 replaces the fixed matrix by the project's named widths and languages; RENDERED block in judging form adds the measured checks the critic applies today only from memory |

### Prod-auditor (V2 4,747 → about 7,350 characters)

| concern | before (live) | after |
| --- | --- | --- |
| 13–16 | none | core 13–16; 14 (dating from primary records) and 16 (read-only probing leaves nothing behind) are its own learned rules |
| evidence | "Cite every answer with the exact command or query and its UTC time bounds." | stays + core 6 sharpened (identical-load comparison before attributing capacity, `r_aec9eddc5d6adf3e`) |
| servers | none | SERVER block, as the yardstick its audits measure against |

### Cleaner (V2 4,379 → about 6,400 characters)

| concern | before (live) | after |
| --- | --- | --- |
| 13–16 | "back up anything recoverable before each destructive step, and keep sibling worktrees and user data untouched" | stays (core 11) + core 13–16; 16 says what "untouched" means for its own scratch |

### Deployer (V2 5,948 → about 7,950 characters)

| concern | before (live) | after |
| --- | --- | --- |
| 15 | "A restart submission error or an exited old PID is an observation to reconcile; judge the final serving identities… from the procedure's verdict." | stays; core 15 states the general rule (read the state before a retry, same key when it may have landed) |
| evidence | "validate the new version before traffic moves to it" | stays + core 6 sharpened |

### Merger (V2 6,796 → about 9,150 characters)

| concern | before (live) | after |
| --- | --- | --- |
| no batch procedure | the protocol of this repository's batch script; V2: "finishes with needs_decision when there is none" | merger default above: plain exact-head squash with the launched identity, said in the report |
| rebase of a continued branch | none | "A rebase of a branch that a lane still continues drops accepted commits: merge the base into it instead." |
| 13–16, open work, publication | "Public bodies, comments and reports carry no identities." | core 13–16, 8 and 12 sharpened; 15 covers a forge that already merged the predecessor (`r_98eae49e5c20d7fe`) |

### Maintainer (V2 13,540 → about 15,550 characters)

| concern | before (live) | after |
| --- | --- | --- |
| 14, 15 | "A status is a claim. For every agent and pipeline stage a task relies on, look for real work: recent transcript activity (…), new commits on its branch (…), stage attempts that started or settled recently (…)." | stays; core 14 and 15 generalise it (date from the record; a tool's answer is no proof of the fact) |
| 13 | "Do not repeat or reverse its changes without new evidence, and do not ask again what it asked unless something has changed since." | stays; core 13 states the general rule |

### Curator (V2 4,343 → about 6,350 characters)

| concern | before (live) | after |
| --- | --- | --- |
| 13, 14, 16 | "judge the currency and readers of each rule" | core 13, 14, 16: check rules against the current state, date them from their record, leave no file behind |

### Issue-reporter (V2 7,284 → about 9,300 characters)

| concern | before (live) | after |
| --- | --- | --- |
| 13–15 | "Keep what you observed apart from what you infer." | core 13–15; 14 matters for the Observed evidence section |
| publication | its own scrub rule (step 4) | stays verbatim (pinned `ISSUE_REPORT_SCRUB_RULE`) + core 12 sharpened |

### Orchestrator seat (mandate, V2 26,188 → about 28,750 characters)

| concern | before (live) | after |
| --- | --- | --- |
| literal request versus proactive | "proactive" defined three times (previous document §2.4); nothing on scope added beyond the request | V2 defines proactive once; SEAT block follows it |
| forms | v54: waiting and repeated unanswered asks go into decision forms | stays + "Every question in a form admits a free-text answer." |
| routine re-runs | none | SEAT block |
| delivery | none | core 15 + SEAT block's last sentence |
| 13, 14, 16 | "Search prior conversations" and "Human in the loop" sections | V2's "Before you decide" + core 13, 14, 16 |

Spawned agents and stages created before the change keep the scaffold they
were created with (`pipelines/roles.ts:157-171`); the stage wrapper, which
renders at every launch, is the place for any sentence that must reach old
lanes.

## 4.3 Nothing lost

Every one of the 94 distinct texts named in §2.2 has one home above; the
backing-ids columns are the traceability. After the prompts ship, the
curator archives those rules as `in-instructions` with the prompt file as
`where` (checklist 2 admits a repository-relative file; the role defaults
are one), and the 18 copies and twins go with them. The other 127 distinct
texts keep their ids and levels (§3.2), with the moves §3.3 names. No rule
is deleted: an archive is reversible from the rules window.

Size: the V2 core grows by about 2,000 characters (13–16 and the three
sharpened principles), which every role reads once; the conditional blocks
add 462 to 2,673 characters to the roles that carry them. The reviewer,
which reads no memory, grows most (+4,037 characters, +51% over V2) and gains the judging
form of every class fix rounds have learned. A builder in A today reads 104
rules, about 22,000 characters, before its brief; after promotion and
archiving it reads about 3,700 more characters of prompt and about 8,900
fewer characters of memory (39 of those 104 rules move). An architect in A
reads 70 rules, about 15,000 characters; 32 of them move.

---

# 5. How memory should be expanded later

Ordered by what the inventory shows costs most.

## 5.1 A scope shared by several roles

Cause of 25% duplication (§1.4). Add `roles:<a>+<b>[+<c>]` scopes (sorted
role ids), read by each listed role in the project (and `roles:*:<a>+<b>`
across projects), written only by the curator's `move`/`split`/`merge`. The
lesson request keeps its four levels; the curator widens to a role set when
"several roles short of every role here" act on a rule, which its checklist
4 already names as the case it has no answer for today. Reading cost: one
more scope per stage, within the same byte bound. The 17 copy groups collapse
to 17 rules.

## 5.2 A toolkit level for tool knowledge

Cause of the mis-levelled machine scope (§1.3, §3.3). Add
`tool:<name>` scopes (browser automation, the runtime, git, the ERP's ORM,
the package manager), each read by a stage whose role is one that runs
tools (builder, architect, visual critic, prod-auditor, cleaner, deployer,
merger) and whose project's instruction files or lockfiles name the tool.
A rule about a tool is then read where the tool is used, in any project,
and a cleaner stops reading browser flags. The machine level keeps what every
role does alike (temp paths, shell scripts, the board's timeouts). The
curator's checklist 4 gains the level; `leave_lesson` gains `scope: "tool"`
with a `tool` name the server checks against a short list it learns from
lockfiles and instruction files.

## 5.3 Promotion as a flow, with the code it needs

The design in `lessons-from-review-findings.md` §3.5 says the operator
promotes a candidate "in the existing role presets" by copying it into the
scaffold. The code refuses that: `role_presets` and `PUT /api/roles` accept
`promptScaffold: null` only (`src/lib/roles/store.ts:236`,
`src/app/api/roles/route.ts:52`); a scaffold can be changed only in
`src/lib/roles/defaults.ts` by a pull request. So promotion is, and should
stay, a reviewed change to the shipped text, because the shipped prompts
are the only text every install shares. What is missing is the path to it:

1. the curator's final message already lists `tasks ≥ 2` candidates; make
   it also mark rules that pass §2.1's test as **universal candidates**
   (tool-free, project-free, acted on by every reader of a level or by two
   projects), by id;
2. the seat turns the curator's list into one decision form per pass
   (promote into the prompt as a new principle or block / keep in memory /
   archive), one question per candidate, free text admitted;
3. a "yes" opens a task for a builder lane on this repository that adds the
   abstract wording to the role defaults and tests, and names the ids in the
   pull request body only by id;
4. on merge, the next curator pass archives the ids as `in-instructions`
   with the defaults file as `where`.

The reviewer, verifier, issue-reporter and curator stay clean; their prompts
are fed by step 3 from fix-round rules (§2.4), which is the only way those
roles learn at all.

## 5.4 A rule's `why` and `tasks` in the operator's view of promotion

The candidate list should carry each rule's `tasks` count, its projects, and
its writers' roles, so the operator sees that a class was learned twice
(the merger workaround in B and C, the scratch-export rule in three roles)
before promoting it. All three facts are in the store today.

## 5.5 Writing rules a person can read

The 300-character cap and the "keep every condition" merge rule produce
rules of the form "A/B: x/y/z; p before q" that a later agent parses slowly
and the operator cannot review. Two changes: let the curator split a merged
rule into two plain sentences instead of compressing (it has `split`), and
raise the cap for curator-written rules only, keeping 300 for stage-written
ones so a lesson stays one idea. The 16,000-byte per-role bound still holds
the total.

## 5.6 The operator's engine-side memories

The 334 Claude preference memories (§1.6) are practice rules that a seat on
another engine or account never reads. The seat rule that already exists
(a practice becomes a `leave_lesson`, `roleRender.ts` seat pointer) is the
right path forward; for what is already there, one read-only pass by the
curator over `search_memory` hits of kind `preference` for each project,
proposing each as a seat rule (`role:P:orchestrator`) by id in its final
message, lets the operator move them in one form. Nothing is copied
automatically: those files belong to the engine.

## 5.7 Project instruction files for the other projects

Projects B, C and D hold 63 role rules and 2 project rules. Of their role
rules, about a third name the project's own procedures (the stand upgrade,
the hotfix path, the locale file layout, the DI container, the loader
guards). The curator's `in-instructions` archive reason needs a file to
point at; those repositories should get the paragraph, written by a docs
builder lane in each, so that their reviewers (clean) and any new role read
it. The curator's final message can name those ids now; the lanes are the
operator's to open.

## 5.8 What to measure to know it worked

- the share of fix-round lessons that name a class already covered by a
  prompt block (should fall after §4 ships; a lesson that repeats a prompt
  is refused by the request text today, so the count of `none: already in
  the prompt` answers is the signal);
- the number of copy groups (§1.4) after the curator's first pass with
  §5.1;
- the characters a builder stage reads before its brief, prompt and memory
  together, per project;
- reviewer findings per round in the RENDERED, TESTS, SHARED PATHS and
  SERVER classes, before and after.

---

# Deferred — not currently justified

- Promoting any rule now, or editing any rule's level: the curator does both
  after the operator answers; this stage proposes.
- Writing the moved project procedures into projects B, C and D: separate
  lanes in those repositories.
- Translating rule text or prompts; both stay English.
- A model judging each lesson at write time, count caps per level, selecting
  rules per task: deferred by the curation design and unchanged here.
- Changing the clean-role list: the operator's 2026-10-07 rule stands; this
  document routes what reviewers need through the prompt instead.
- Importing engine memories automatically (§5.6 proposes a read-only pass
  and a form).

# Validation against the requirement

| operator's words | where this answers |
| --- | --- |
| «every active rule at machine, project and role level, across all projects, and all lessons» | §1.1–§1.5: 243 active rules in every scope of six projects, the 1,268 merged and archived rows by reason, exact and near duplicates, level twins, contradictions |
| «think how to update the role prompts of every Delegatus agent role from it» | §2 (which classes, which roles), §4 (before/after per role, all 13 roles and the mandate) |
| «review roles receive no learned rules… reach it only through its prompt» | §1.7, §2.4, §4.2 reviewer, verifier, issue-reporter and curator rows |
| «which stay as memory and at which level» | §3 |
| «memory itself will need expanding later» | §5 |
| «без привязки к какому-то конкретному инструменту или фреймворку», «абстрактні правила» | §2.1 test; every text in §4.1 names no tool, file or command |
| «nothing important lost» | §4.3 and the backing-id columns of §2.2; archives are reversible |
| read-only | no file outside this document written; the store read read-only; no curate_rules write (refused for this caller in any case) |

# Questions for the decision form

Beyond the six in the previous document's §6:

7. **Memory delta on top of V2?** (Додати до V2 правила з пам'яті?)
   **yes, principles 13–16, the three sharpened ones and the five blocks
   (recommended)** · principles only, blocks stay memory · nothing from
   memory into prompts yet.
8. **Reviewer size** (Розмір промпта рецензента): **accept +56% over V2 so
   the clean reviewer carries the judging form of every learned class
   (recommended)** · give the reviewer only RENDERED and TESTS · keep the
   reviewer at V2.
9. **Merger without a batch procedure** (Merger без batch-скрипта):
   **plain exact-head squash with the launched identity by default
   (recommended)** · needs_decision as V2 proposes · keep the batch protocol
   in the shipped prompt.
10. **Next memory change** (Що розширювати в пам'яті першим): **a shared
    multi-role scope (§5.1) (recommended)** · a toolkit level (§5.2) · the
    promotion flow (§5.3) · the engine-memory pass (§5.6).
