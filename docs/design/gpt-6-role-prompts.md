# GPT-6 maintenance techniques in Delegatus role prompts and seat practice

Status: design, no product change. Written 2026-10-20 against `main` at
`f335de650`, the commit this lane's worktree started from. Every `file:line`
below is from that commit unless it names a design document. The research
document this builds on, `docs/design/gpt-6-maintenance.md`, was written on
its own lane and is cited by section; at `f335de650` it is not yet on `main`.

> **Outdated in part (2026-10-20, orchestrator mandate v58).** The operator
> answered Q3 (b): the seat's maintenance practice is a mandate line in every
> installation, not learned rules on one machine. Mandate v58 states it in the
> "How work runs" section of `src/lib/orchestrator/prompt.ts`; the operator
> let the mandate grow to state it fully (delivered default 29,576 → 30,112
> bytes). The statements this changes carry a dated "Outdated" note below.
> The two scaffold blocks (§3.1, §3.2) are unchanged by that answer: they are
> tried as stage-prompt text first and enter code only if measurements improve.

## Originating requirement

Operator, 2026-10-20 about 17:20Z, as a comment on the decision form that
chose the pilot. The pinned specification forbids copying, translating or
excerpting that comment into a published file, so it is paraphrased: besides
running the pilot, think about how the post's techniques can be built into
our role prompts and the like. The architect scaffold asks for the
requirement verbatim; the pinned specification's prohibition governs the
scaffold (working rules, precedence), so the paraphrase stands.

The pinned acceptance, condensed: read how the role prompts are assembled and
how learned rules reach agents, with `file:line`; for each technique in the
research document say where it belongs (a role mode or parameter, a scaffold
line, the orchestrator mandate, a learned rule, or nowhere) and why, preferring
a mode, parameter or short line over a new role, and saying what not to add;
draft the exact before and after text with its token cost per launch; give a
rollout and measurement plan tied to the running pilot, P2's cost per accepted
finding and later P5's replay; list open questions for a decision form; write
this document only.

The default answer to "should we build this" is no. Most of what follows is a
short block for one architect mode, one builder mode, and four learned rules
the seat leaves itself. Everything heavier is in "Deferred".

## 0. Earlier answers

`search_transcripts`, project-scoped then unscoped, for the post's title with
"role prompts", for "cost per accepted finding, discrepancy classes" and for
"dead code audit report workstreams deletion lane"; `search_memory` for
"maintenance audit dead code flaky tests prompt role scaffold" and for "cost
per finding model effort comparison replay instruction".

| Hit | What it settles |
| --- | --- |
| The research lane of 2026-10-20 and this lane's own brief | Only the request itself and the research document's proposals (P1–P7). |
| Three Codex sessions started 2026-10-20 17:22Z–17:24Z, "Dead-code audit of src/components/scheme, report only (pilot, arm A/B/C)" | The pilot is running; §1.6 reads their stage records. |
| `search_memory`, both phrasings | Nothing: no memory or learned rule about maintenance prompts, audits or arm comparisons exists. |
| Design documents reused here | `docs/design/role-prompts-rewrite.md` and `role-prompts-rewrite/v4/` (the shipped prompt texts and their limits), `docs/design/role-memory-to-prompts.md` (what moves from memory into prompts and how to measure it, §5.8), `docs/design/memory-quality-benchmark.md` §4.1 (the replay set P5 would build), `docs/design/model-sizing-tiers.md` (the sizing rule), `docs/design/model-analysis-2026-10.md` (the 30-lane floor before a role change). |

Nothing earlier proposed a maintenance mode, a sweep mode or a seat practice
for audits; the research document's P7 ("the report-then-fan-out step as a
seat practice") is the nearest, and this document is its design.

## 1. How a role prompt reaches an agent today

### 1.1 Role definitions and their parameters

- Thirteen frozen role ids: `src/lib/roles/types.ts:1-15`. A definition is a
  runtime, a parameter list, a `promptScaffold` with `{{tokens}}`, safety
  fences and capabilities (`types.ts:49-61`). A parameter is text, integer or
  select (`types.ts:35-47`); an absent value takes the declared default, else
  the first select option (`src/lib/roles/parameters.ts:4-9`).
- The shipped texts: `src/lib/roles/defaults.ts:223-394`. The sixteen working
  rules every role reads whole (`defaults.ts:41-60`) and their short form for
  the seat (`defaults.ts:70-89`); the judging rules (`:95`), the verdict line
  (`:97`), and the conditional blocks RENDERED, TESTS, SHARED PATHS and
  SERVER with their judging forms (`:115-122`).
- The builder's `mode` options are plain, apply-fixes, tdd, diagnose,
  prototype and merge-resolve, and its `domain` general, frontend, docs
  (`defaults.ts:285-286`); the architect's `mode` options are design, spec and
  architecture-audit (`defaults.ts:299`). Each option has an interface label
  in both languages (`src/lib/i18n/en.ts:1444-1459`, `uk.ts:1423-1438`).
- Which modes carry text of their own: only the builder's. `roleScaffoldBody`
  substitutes the tokens and then, for the builder alone, puts the fix-round
  paragraph (`APPLY_FIXES_GUIDANCE`, `src/lib/roles/registry.ts:111`) or the
  frontend and prototype rendered rules in front of the work rules
  (`registry.ts:131-147`). For every other role, and for the builder's
  `diagnose`, `tdd` and `merge-resolve`, a mode changes exactly one word: "You
  are a Builder in diagnose mode" (`defaults.ts:289`), "You are an Architect in
  architecture-audit mode" (`defaults.ts:301`). The architect's audit mode
  reads the design-mode text whole: deliver a design document, open with the
  requirement verbatim, keep a "Deferred — not currently justified" section.
- Variants are the parameter combinations that run on their own runtime:
  builder trivial, frontend, docs and the three fix rows; reviewer trivial
  (`src/lib/roles/paramConfig.ts:12-35`, precedence `:45-57`). The sizing rule
  (`src/lib/roles/sizing.ts:119-152`) refuses a light model on the
  orchestrator, architect and non-trivial reviewer (`:25-28`) and demands a
  large-model brief for `size=trivial`.
- An install can override a role's config, its prompt text and its variant
  rows in `role-presets.json` (`src/lib/roles/store.ts:37`, shape
  `types.ts:105-110`, validation `store.ts:67-103`). A role whose text an
  install replaced no longer receives shipped text changes, and the seat is
  told so in its role table (`src/lib/orchestrator/prompt.ts:625-632`).

### 1.2 How a pipeline stage gets its scaffold

- `pipelineRoleLookup` (`src/lib/pipelines/roles.ts:47-90`) resolves the
  parameters (operator value, else default), renders the body through the same
  `roleScaffoldBody`, appends the fence block, and stores the result on the
  stage as `effectiveRole.promptScaffold`. The body is cut at
  `MAX_SCAFFOLD_LENGTH` minus the fences; a cut that only supplied text
  parameter values would cause refuses the stage instead (`:76-79`,
  `:148-151`).
- `MAX_SCAFFOLD_LENGTH` is 12,000 characters (`src/lib/roles/store.ts:28`),
  shared with the pipeline store so a value that saves is a value that loads.
  A test keeps every shipped role and variant more than 200 characters under
  it (`src/lib/pipelines/roles.test.ts:260-268`). The maintainer is exempt
  (it is not a pipeline role, `roles.ts:12-23`).
- The stage wrapper (`src/lib/pipelines/prompts.ts:108-146`) places the
  stage prompt, the pinned task and specification, the role line and the
  scaffold, the prototype pointer for builder, architect and visual critic
  (`:115-117`), access, host, base, branch, delivery, the Delegatus mechanics
  (`:124`), the test command and the completion contract. Every stage reads
  all of it at every launch; a stage keeps the scaffold it was created with
  (`docs/design/role-prompts-rewrite/v4/README.md:74`).
- A spawned role agent reads scaffold, brief and the spawn completion line
  (`registry.ts:153`, `:166-172`); the mechanics sentence travels with it.

### 1.3 The seat's mandate

- The mandate is `ORCHESTRATOR_SYSTEM_PROMPT` (`prompt.ts:541` onward),
  version 57 (`prompt.ts:110`). Its "How work runs" section (`:570-581`)
  carries the lane recipe: size the lane first, architect first when the work
  needs options or a plan, builder, reviewer with a fix edge (`:574`); a stage
  that hands a document on declares its path in `outputs`, and role params
  hold short values, the rest goes in the brief (`:577`).
- The role table is rendered at delivery (`orchestratorRoleTable`,
  `prompt.ts:642-665`) and ends with the sizing lines: trivial / normal /
  design, the UI-lane recipe, the Sonnet and Opus split, the large-model
  brief rule (`:656-660`).
- The envelope: a seat's first message shares one 32,000-byte structured
  envelope with its rotation history, so a test keeps the delivered mandate
  under `MAX_STRUCTURED_TEXT_BYTES - 2_150` and, with the spawn overhead,
  under `- 1_950` (`src/lib/orchestrator/prompt.test.ts:824-857`;
  `launchOverheadBytes` at `src/lib/orchestrator/handoffDigest.ts:305-310`).
  Measured on this commit in a scratch export (`bun run` of a four-line
  script importing `prompt.ts` and `defaults.ts` under an isolated
  `LLV_STATE_DIR`): delivered default 29,576 bytes, spawn overhead 215 bytes,
  bounds 29,850 and 30,050. **The mandate has 259 bytes of room** before the
  test fails. Any mandate line longer than that is paid for by cutting another.
  *Outdated (2026-10-20, mandate v58): the operator let the mandate grow
  instead; v58 adds 536 bytes and raises both bounds by 300.*

### 1.4 How learned rules reach agents

- A stage launch carries a text-free selector `{project, roleId}` unless the
  stage is clean (`src/lib/memory/roleStage.ts:30-33`); clean roles are
  reviewer, verifier, issue-reporter and curator
  (`src/lib/memory/eligibility.ts:11`), plus any stage with a fail edge
  (`sizing.ts:34-36`). At engine start the block is rendered within
  `LEARNED_RULES_MAX_BYTES` = 120,000 (`src/lib/memory/roleLaunch.ts:14`,
  `:46-59`) from four scopes: the role in this project, the role in every
  project, the project, the machine (`src/lib/memory/roleScopes.ts:7-13`,
  `src/lib/memory/roleStore.ts:196-213`), each scope within 10,000 code points
  (`src/lib/memory/roleTypes.ts:11`).
- The rendered block tells a stage the rules are rules of thumb that yield to
  every other instruction (`src/lib/memory/roleRender.ts:13`); it tells the
  seat that a practice (how to brief, what to check before you report, how the
  operator wants a thing done) becomes a rule through `leave_lesson`
  (`roleRender.ts:15`).
- A stage is asked for a lesson once, in the answer to its accepted
  `stage_report` (`roleStage.ts:45-53`); a fix round is asked to name the
  class of each handed finding and the rule its role needed before the first
  review (`roleRender.ts:77-90`). A rule is at most 300 characters, its `why`
  160 (`roleTypes.ts:14-15`); it may name no task, run or id
  (`roleStage.ts:74-85`).
- A seat may leave a rule under another role: `parseLessons` accepts `role`
  with scope `role` for any role id (`roleStage.ts:106-110`), and
  `leaveLessonForSeat` runs it with the seat's own designation
  (`roleStage.ts:158-176`). So the seat can write an architect rule after
  judging an audit, and the curator later widens or merges it.
- The curator's checks (`src/lib/memory/curation/brief.ts:6-12`) judge each
  rule as task-specific, current, read, levelled, duplicate, contradicted,
  general and ranked; its brief ends by naming rules with `tasks ≥ 2` as
  candidates for that role's template, and says promotion into a template is a
  separate explicit operator step (`brief.ts:23`).

### 1.5 `src/lib/roleFrames.ts`

It decides which role's visual frame a conversation wears and how the frame
is drawn (`roleFrames.ts:3-22`, `:114-132`). It carries no prompt text and
nothing here changes it; it is listed because the acceptance named it.

### 1.6 Sizes on this commit, and the running pilot

Rendered in a scratch export of this commit with `roleScaffoldBody` plus
`roleFenceBlock`, parameters at their defaults unless shown:

| Role (params) | chars | room to the 12,000 cap |
| --- | ---: | ---: |
| architect (design) | 10,580 | 1,420 |
| architect (architecture-audit) | 10,592 | 1,408 |
| builder (plain) | 8,426 | 3,574 |
| builder (diagnose) | 8,429 | 3,571 |
| builder (apply-fixes) | 8,974 | 3,026 |
| builder (frontend) | 9,780 | 2,220 |
| reviewer (lens all, 1 pass) | 11,769 | 231 |
| verifier | 7,676 | 4,324 |
| prod-auditor | 7,477 | 4,523 |
| curator | 6,477 | 5,523 |
| orchestrator scaffold | 213 | (mandate: 259 bytes, §1.3) |

The reviewer has 231 characters of room, 31 above what the cap test demands;
a reviewer line of any length is paid for by a cut. The architect can take
about 1,200 characters; the builder about 3,300.

The pilot (research document P1 and P2, operator decision of 2026-10-20):
three sibling lanes on `src/components/scheme`, all with the same pinned
specification and the one-line stage prompt "Do the pinned specification.
Write only docs/audits/scheme-dead-code.md", role architect, read-only,
declared output. Arms: A `codex/gpt-6.1-sol/medium`, B
`codex/gpt-6.1-sol/xhigh`, C `codex/gpt-6-astra/xhigh` (`list_pipelines`
compact:false, read 2026-10-20 about 19:30Z; all three `running`, attempt 1).
Two facts matter for this design:

- All three run the architect's **default mode, design**: the stage record's
  `role` is `{roleId: "architect"}` with no params. Their scaffold therefore
  tells them to deliver a design document that opens with the requirement
  verbatim and keeps a "Deferred" section, and to state options and
  trade-offs. The audit's own contract (evidence per candidate, keep-list,
  workstreams, counts) lives entirely in the pinned specification. That is
  the case for a mode block (§2, T1 and T2): the mode exists, the seat did
  not select it because it changes nothing.
- The whole audit prompt is the specification, written by the seat. It is
  the text P7 asks to version; §3.5 says where.

## 2. Technique by technique: where each belongs

The techniques are the nine the acceptance lists, in the research document's
order. "Where" names one place; "why" gives the test applied: a line belongs
in a scaffold when every launch of that role and mode acts on it; in the
mandate when every seat on every project acts on it and the envelope has the
bytes; in a learned rule when it is a practice of this installation that may
change with the next run; nowhere when it is a measurement, a tool or a
one-off brief.

| # | Technique (research doc §) | Where | Why |
| --- | --- | --- | --- |
| T1 | Evidence-gathering before deletion: prove non-use from history, references, open changes and production records; explain each candidate (§1.2 "Removing unused code", §1.3 row 1) | **Architect `mode=architecture-audit`**, a guidance block rendered only in that mode (§3.1) | Every audit stage acts on it; today the mode renders no text of its own, so the seat types the standard into each spec. The reviewer side of it (a deletion PR carries the evidence) is the brief's job, see T2 and §2.1. |
| T2 | Report, then parallel workstreams, then one small PR each (§1.2 "Tracking down stale experiments", §1.3 row 3; P1, P7) | The **same architect block** for the report's shape; the **seat's practice as a learned rule** for the fan-out (§3.3, R1 and R3) | The report shape is the audit stage's output contract. The fan-out (one lane per accepted workstream, which reviewer row, what the brief carries) is the seat's lane composition; the mandate already says a document stage declares its output (`prompt.ts:577`) and the envelope has 259 bytes, so the practice goes to the seat's role memory, where the seat is told practices belong (`roleRender.ts:15`). |
| T3 | Cost per accepted finding on one fixed task and snapshot (§1.2 "Improving cost effectiveness"; P2) | **Nowhere in a prompt.** A measurement over the token store (`src/lib/activity/tokenStore.ts`, priced by `tokenPrices.ts:55-58`) and the seat's blind judging; the procedure is one learned rule (§3.3, R2) and the decision rule is in §4 | No agent can read its own token cost reliably inside a turn, and a prompt line cannot compute a ratio over three lanes. The seat runs the comparison; the rule says how. |
| T4 | Discrepancy classes folded back into prompts; prompts revisited at each model release (§1.2 "Improving cost effectiveness", §1.3 row 5) | **Architect learned rules first** (the seat writes them under `role: "architect"` after judging the arms, `roleStage.ts:106-110`); the **audit block only after the curator reports a class with `tasks ≥ 2`** (`brief.ts:23`); the release re-run as a **seat rule** (§3.3, R4) | This is the memory loop Delegatus already has: write the class as a rule, let the curator merge and rank it, promote to the template when it recurs. Editing the scaffold from one comparison would freeze one model's blind spot into every audit. |
| T5 | The flaky-test prompt shape: read recent runs, find the flaky tests, try a fix, PR when it works (§1.2 "Other ideas to try" 1; P3) | **Builder `mode=sweep`**, a new option with a guidance block (§3.2); until it ships, the same text in the brief | `diagnose` is for finding the cause of one problem; `apply-fixes` is a fix round scoped to findings; `plain` is a scoped build. A sweep over a listed class with "fix the clear ones" is a fourth discipline, and its sentence about not weakening a check is a rule every sweep needs before its first review. A builder mode is the cheapest home: one option, one block, the base row or `size=trivial` by the seat's choice. |
| T6 | "Clear fixes to simple issues, not exhaustively" (same section) | **The core sentence of the `sweep` block**; nothing for the reviewer | The reviewer anchors on the pinned specification (rule 1); when the specification says the sweep is not exhaustive, an unfixed instance left with its reason is no finding. No reviewer text is needed, and there is no room for it anyway (§1.6). |
| T7 | One-instruction replay: run the same prompt twice from one snapshot, with and without one instruction, compare (§1.2 "Other ideas to try" 2; P5) | **Nowhere now.** It is the replay launcher of `memory-quality-benchmark.md` §4.1, a tool; once it exists, a curator check "replay before archiving a contested rule" is the place, not a role scaffold | No stage can replay itself. Until the launcher exists the seat compares two lanes by hand (§4 phase 0 does exactly this for the audit block). |
| T8 | CI cuts ranked by minutes saved per day from run history (§1.2 "Other ideas to try" 3; P4) | **Nowhere as a standing line; one sentence of the audit block** generalises it ("rank by what the project's own records measure") | The denominator is installation-specific (here the local pre-push, not CI: research document §2.3) and the ranking is a one-off read-only lane with a brief. The generic part, rank candidates by a measured saving, holds for every audit and is one clause. |
| T9 | Ramp: one task, then a subdirectory, then the repository; compare models on the small task; fold review feedback into the next prompt (§1.2 "Start small, review, and expand") | **Seat practice as a learned rule** (§3.3, R1); a mandate line only if the operator wants it durable across installs (open question Q3, with its byte cost) | It is lane composition over weeks, which only the seat does. The role-table sizing line could take a 117-byte clause (§3.4), but the mandate's 259 bytes are better kept for a contract every seat needs; a rule is per project and the curator can widen it. |

### 2.1 What not to add

- **No fourteenth role.** The architect's audit mode and the builder's sweep
  mode cover both stage kinds the post uses; the research document's §5
  defers the role until a prompt has stabilised across re-runs, and nothing
  here changes that.
- **No reviewer change.** The reviewer is 231 characters under the cap. The
  evidence standard for a deletion PR belongs in the pinned specification the
  seat writes (R3), which the reviewer judges against by rule 1. A `deletion`
  lens option would be one word with no text behind it.
- **No verifier, prod-auditor, curator, cleaner or maintainer change.** The
  maintainer tends the board and may not touch files
  (`defaults.ts:362-368`); the curator's checklist gets a replay check only
  when P5 ships; the prod-auditor's SERVER block already covers "read
  production records before calling a path unreached".
- **No working-rules change.** The sixteen principles hold for any task
  (`defaults.ts:41-60`); maintenance is a kind of work, and a kind of work
  gets a conditional block, as RENDERED, TESTS, SHARED PATHS and SERVER did.
- **No stage-wrapper line.** The wrapper reaches every stage of every lane
  (`prompts.ts:108-146`); a maintenance sentence there is noise for the
  ninety-odd per cent of stages that are not audits.
- **No change to any role-table runtime** from the pilot's numbers; the
  model-analysis floor of 30 lanes stands
  (`docs/design/model-analysis-2026-10.md` "Recommendations for the role
  table").
- **No new parameter for the evidence sources** (an "evidence" text param
  listing entry points, manifests, flag consoles). Role params hold short
  values (`prompt.ts:577`); the sources are project facts and belong in the
  specification and, when they repeat, in the project's instruction files.

## 3. Proposed text, before and after

Token figures are estimates at four characters per token for English prose,
rounded up; the exact count depends on each engine's tokenizer and the text
is counted once per launch as prompt input. "Per launch" means one stage
attempt or one spawn of that role and mode; no other launch reads it.

### 3.1 Architect audit block (`AUDIT_GUIDANCE`)

Mechanism: a constant beside `APPLY_FIXES_GUIDANCE` (`registry.ts:111`), and
`roleScaffoldBody` (`registry.ts:131-147`) extended from "builder only" to
"builder, and architect in `architecture-audit` mode", placing the block
before the judging rules the way the builder's guidance goes before its work
rules. The scaffold template itself (`defaults.ts:301`) does not change, so an
install that overrode the architect's text keeps its override and, as today,
receives no shipped change (`prompt.ts:625-632`).

Before (what an audit stage reads after its first sentence today):

> You are an Architect in architecture-audit mode. Ground the design in the
> current code, state options and trade-offs, and deliver a design document.
> […] When you review a plan or a design, judge it this way:
> Judging work. A finding is work that must be done […]

After (the block inserted between the opening paragraph and "Judging work"):

> Audit round: the output is a report, and the report changes nothing. For
> each candidate (unused code, a stale flag, fallback or compatibility branch,
> a slow or flaky check) record the evidence that it is unreached or always
> one way: reachability from the entry points the project names, dynamic and
> string-named references, the last change that touched it and why, open
> changes on it, and every instruction file, workflow, manifest or runtime
> string that names it; a candidate without evidence is a note, never a
> finding. Keep anything marked permanent, an operational safeguard or a kill
> switch, and raise it for the operator with its measured cost. Group verified
> candidates into independent workstreams small enough for one pull request
> each, with files, evidence, risk, the checks that go with them and what to
> verify after removal; rank them by what the project's own records measure
> (time, bytes, lines, cost). End with the counts: candidates, workstreams,
> kept.

Cost: 968 characters, about 245 tokens per architect audit launch; the
architect in audit mode goes from 10,592 to about 11,562 characters, 438
under the cap and 238 above the test's floor. The design and spec modes read
nothing new. What it carries from the post: the evidence sources (T1), the
"permanent, raise for review with the cost" rule (§1.2 worked example), the
workstream report (T2), the ranking clause (T8). What it leaves to the
specification: which entry points, manifests and runtime strings this project
has, and the output path.

One sentence of the design-mode opening still misfits an audit ("state
options and trade-offs, and deliver a design document"). Swapping the opening
for audit mode the way the builder swaps its finish line (`registry.ts:119`,
`:141`) is a second, optional change of about 120 characters; it is listed in
"Deferred" because the block above says what the output is and the
misfit costs nothing but one clause.

### 3.2 Builder `mode=sweep` (`SWEEP_GUIDANCE`)

Mechanism: a seventh `mode` option, its interface label in both languages
(`en.ts:1446` pattern, `uk.ts:1425`), the option description, and a guidance
constant placed by `roleScaffoldBody` in front of the work rules like the fix
round's. The cap test's parameter list (`roles.test.ts:262`) gains
`{ mode: "sweep" }`. No new variant row: a sweep runs the builder's row, or
`size=trivial` when the seat briefs it precisely; the seat sets `effort` on
the stage (the post ran these at medium).

Before (`defaults.ts:285`):

> Implementation discipline. apply-fixes: a fix round, whose brief is a list
> of findings.

After:

> Implementation discipline. apply-fixes: a fix round, whose brief is a list
> of findings. sweep: a maintenance round over a listed class of small
> defects; clear fixes only.

Before (what a sweep reads today, as `mode=plain` or `diagnose`):

> You are a Builder in plain mode. Implement the brief with focused checks.
> […]

After (the block in front of the work rules):

> Sweep round: the brief names a class of small defects (flaky tests, unused
> code, a stale flag) and the sources that list them. Fix the clear, simple
> instances and leave the rest listed with the reason; the job is not to
> exhaust the list. Never weaken a check to make it pass: a timing test moves
> to a controlled clock or an injected deadline, or goes with its reason. Keep
> each pull request to one file group, and report what was fixed, what was
> left and why.

Cost: 459 characters, about 115 tokens per sweep launch; the builder in sweep
mode is about 8,890 characters, 3,110 under the cap. Nothing else reads it.
What it carries: T5's shape, T6's sentence, #1761's rule that no test is
weakened to pass (research document P3), and the one-PR-per-group rule.
Until the option ships, the same paragraph goes into P3's first brief; the
mode is then a promotion of a text that has run, see §4.

### 3.3 Seat practice as learned rules

*Outdated (2026-10-20, mandate v58): the operator chose the mandate (Q3 b).
R1–R4 below are the source of the v58 bullet in "How work runs" and are not
written as learned rules.*

Each rule is at most 300 characters (`roleTypes.ts:14`) and names no task or
id. The seat writes them with `leave_lesson` (scope `role`, its own role) after
the pilot's first re-run, so they carry a real `why`; the curator judges them
on its next pass and can widen them to `role:*:orchestrator` when a second
project runs an audit. They yield to the mandate and the operator's answers,
as every rule does (`roleRender.ts:13-15`). Rendered sizes include the
`- [id] ` prefix the block adds per rule.

R1, ramp and lane shape (285 characters, about 75 tokens per seat start):

> Maintenance work ramps: one task, then one subdirectory, then the
> repository. Each step is a read-only architect mode=architecture-audit
> stage with a declared report output and no deletions, then a form listing
> the workstreams, then one lane per accepted workstream, one small PR each.

R2, comparing arms (283 characters, about 75 tokens):

> Before a maintenance prompt is re-run wider, compare arms on the same
> snapshot and prompt: judge findings once, blind, against the union; take
> cost per accepted finding from the token store; write the classes the
> cheaper arm missed as architect rules and into the prompt's changelog.

R3, deletion lanes (246 characters, about 65 tokens):

> A deletion lane's brief carries the audit's evidence per candidate and its
> keep-list, and its PR body repeats the evidence. Reviewer row: the normal
> row when a removal touches a runtime path, the trivial row for tests,
> scripts, docs and evidence.

R4, model releases (219 characters, about 55 tokens):

> When the default model of a role changes, re-run the versioned maintenance
> prompt once on its fixed task before re-running it wider, and record the
> discrepancy classes; prompt corrections written for one model go stale.

R3 restates the operator's answer to the research document's Q3 (normal row
for `src/`, trivial row for tests, scripts, docs) so later seats on this
project read it without the form. R2 and R4 are the post's method; R1 is its
ramp. Together they cost about 270 tokens per seat start on this project and
nothing on any other until the curator widens them.

### 3.4 Mandate: the optional sizing clause

*Outdated (2026-10-20, mandate v58): the practice went into the mandate as
its own "How work runs" bullet (535 bytes) after the declared-outputs bullet,
not as this clause on the role table's sizing line; the role table is
unchanged.*

If the operator wants the ramp durable across installs rather than in this
machine's memory (Q3), the smallest mandate change is a clause on the sizing
line of the role table (`prompt.ts:656`):

Before:

> - Size each lane first. trivial (…): builder and reviewer size=trivial, one
>   review round. normal: rows, effort low or medium. design (options,
>   architecture, proposals, design issues): architect first.

After (appended):

> … design (options, architecture, proposals, design issues): architect
> first. maintenance (audits, sweeps): architect mode=architecture-audit
> report first, then one lane per accepted workstream.

Cost: 117 bytes of the mandate's 259 (§1.3) and of the role-table section's
own bound (3,343 of 3,500 bytes, `prompt.test.ts:830`), about 30 tokens per
seat start on every project. It is not recommended now: the practice may
change after the first re-run, and a mandate line changes only at the next
rotation of every seat while a rule reaches the next start.

### 3.5 The versioned audit prompt (P7), a file and not a prompt

The audit's long text (entry points, keep-list sources, output path, the
report's sections) stays in the pinned specification, as the mandate requires
(`prompt.ts:577`). P7 asks that it live in the repository as a versioned
text. The place: `docs/maintenance/prompts/<audit>.md` beside the existing
`docs/maintenance/worktree-recovery.md`, one file per prompt, with a
changelog list at its end: one line per model release and one per discrepancy
class folded in, each naming the run (date, subdirectory, arm) that caused
it. The seat pastes the current text into each specification and adds the
run to the changelog in the same lane that re-runs it (a builder
`domain=docs` stage, `size=trivial`). Nothing in code reads the file.

## 4. Rollout and measurement

### Phase 0, on the pilot's re-runs: zero product change

The pilot's three arms are running (§1.6). When they settle, the seat judges
their findings blind against the union (R2) and takes each arm's tokens from
the token store keyed by pipeline and stage (`tokenStore.ts`, prices at
`tokenPrices.ts:55-58`, a comparison figure and never spend). That gives the
first cost per accepted finding per arm and the first discrepancy classes.

The audit block is then tried **as text in the stage prompt**, before any
code change: a re-run of arm A (the cheapest arm) on the same `baseRef` and
specification, with `role.params.mode = "architecture-audit"` set so the
record names the mode, and the §3.1 paragraph pasted into the stage prompt
after "Do the pinned specification". Because a stage keeps the scaffold it was
created with and the stage prompt is read verbatim, this is exactly what the
shipped block would deliver, minus its position.

Noise first. One repeat of arm A **without** the block gives the band
(findings, accepted findings, tokens) that two runs of the same arm differ
by; the pre-registered rule below must not trigger on drift of that size.

Decision rule, written before the run: the block is kept when, against the
repeat without it,

- the candidates listed without evidence go to zero (the block's structural
  claim; the current specification already demands it, so the comparison is
  of compliance);
- every "permanent" or safeguard candidate appears in a kept-and-raised list
  rather than a workstream;
- accepted findings do not fall by more than the noise band;
- tokens do not rise by more than the noise band plus the block's own 245.

If the first two hold and the last two do not, the block is shortened, not
dropped. If the first two do not hold, the block is wrong and §3.1 goes back
to the drawing board with the transcript as evidence.

The sweep block is tried the same way on P3's first lane: the §3.2 paragraph
in the brief of a builder stage, `mode=diagnose` as the nearest existing
mode, `size=trivial` when the brief lists exact files. What to read
afterwards: the reviewer's findings per round in the TESTS class (a widened
timeout is the known trap, research document P3), and the left-alone list's
reasons.

### Phase 1, code: the two blocks

One normal lane: `registry.ts` (the two constants, the `roleScaffoldBody`
branch), `defaults.ts:285` (the option and description), the two i18n files,
`roles.test.ts:262` (the parameter list), `registry.test.ts` (render the
architect in audit mode and assert the block precedes "Judging work"; render
the builder in sweep mode and assert the block precedes the work rules;
assert design, spec, plain and diagnose are byte-identical to before), and
the v4 README's role list (`docs/design/role-prompts-rewrite/v4/roles/`
gains `architect.architecture-audit.txt` and `builder.sweep.txt`, rendered by
the real functions). Reviewer on the normal row. The lane changes no runtime
and no mandate, so no seat needs a rotation.

### Phase 2, memory: the four rules

After Phase 0's judging, the seat leaves R1–R4 under its own role on this
project, each `why` naming what the pilot showed. The seat also leaves the
discrepancy classes the cheaper arm missed under `role: "architect"`, one
rule per class, generic (the post's own example would read: a constant flag
that other flags depend on is a stale candidate; trace flag-to-flag
references, enums, wrappers and aliases). The curator's next pass judges
them; a class the curator later reports with `tasks ≥ 2` is the candidate
for the audit block, by the operator's explicit step (`brief.ts:23`).

### Phase 3, measurement over time

Tie to P2: cost per accepted finding per arm, re-measured on every re-run of
the fixed task, with the arm that is cheapest at ≥ 90 % of the best arm's
accepted findings as the default for the next subdirectory (the research
document's decision rule). The prompt changes are judged by the same number:
a block or a rule earns its tokens when the accepted-finding rate of the
cheapest arm rises or its rejected-finding count falls on the fixed task.

Tie to P5: the audit block is the first "one instruction" for the replay
launcher of `memory-quality-benchmark.md` §4.1: two runs of arm A from one
snapshot, engine memory off in both, differing only in the block, compared on
verdict, findings, tool calls, tokens and runtime. Phase 0 is that experiment
by hand; P5 makes it repeatable. The §5.8 metrics of
`role-memory-to-prompts.md` apply unchanged: fix-round lessons that repeat a
prompt block (should stay at zero for the two new blocks), and reviewer
findings per round by class.

### Rollback

- A scaffold block is code: revert the lane. Running stages are unaffected
  either way, since a stage keeps the scaffold it was created with
  (`v4/README.md:74`); a new attempt of a stored stage reads the stored text.
- The `sweep` option is kept even if its block is withdrawn: a stored lane
  that used it still validates on load, so the cheap rollback is an empty
  guidance string, and removal waits until no open lane carries the mode.
- A learned rule: `leave_lesson` with `rewrite` keeps the earlier text and can
  restore it (`roleRender.ts:99`); the curator's archives are reversible
  (`brief.ts:22`). Role memory can be switched off for the installation
  (`roleMemoryEnabled`, `roleLaunch.ts:50`).
- The mandate clause, if taken: one text change, reaching seats at their next
  rotation; the test at `prompt.test.ts:824` pins the bytes.

## 5. Open questions for the operator

Form-ready; one recommendation each.

1. **Architect audit block: when does it ship?** (a) try it as stage-prompt
   text on the pilot re-run first, ship in code only if the §4 rule holds
   **(recommended)**; (b) ship it now, measure afterwards; (c) keep it in the
   specification template only, never in the scaffold.
2. **Builder sweep mode: a new mode option, or brief text only?** (a) brief
   text on P3's first lane, the mode option after a second sweep reuses the
   text unchanged **(recommended)**; (b) the mode option now, with P3 as its
   first user; (c) no mode, the sweep text lives in the versioned prompt file.
3. **Where does the ramp and arms practice live?** (a) four learned rules
   under this project's seat, widened by the curator when another project
   audits **(recommended)**; (b) the 117-byte clause on the mandate's sizing
   line, durable across installs, paid from the 259 bytes left; (c) both.
   *Answered 2026-10-20: (b), as a full mandate bullet (mandate v58).*
4. **Deletion reviews: any reviewer change?** (a) none; the brief carries the
   evidence standard and the reviewer row follows R3 **(recommended)**; (b)
   a `deletion` lens option, one word, no text; (c) a judging sentence for
   deletions, paid for by cutting about 150 characters elsewhere in the
   reviewer.
5. **Discrepancy classes: rules or scaffold?** (a) architect rules written by
   the seat after each comparison, promoted to the block only on `tasks ≥ 2`
   **(recommended)**; (b) edit the audit block directly after P2; (c) both,
   the rule now and the block edit in the same lane.
6. **Re-run on model releases?** (a) yes, R4: one fixed-task re-run per role
   default change, recorded in the prompt's changelog **(recommended)**; (b)
   re-run only when the next audit is due anyway; (c) no standing practice.

None blocks Phase 0; Q1 and Q2 decide Phase 1's scope, Q3 and Q5 decide
Phase 2's.

## 6. Deferred — not currently justified

- Swapping the architect's design-mode opening sentence in audit mode (about
  120 characters): one clause misfits, the block says what the output is.
- A fourteenth role for code maintenance; a knip- or ts-prune-style checker;
  a stored CI run-duration history; a "create N lanes from one report"
  primitive; Codex subagents or thread goals for audit stages; a seat-tick
  timer for audits: all deferred by the research document §5 and unchanged.
- A curator check that replays a contested rule: after P5 ships the launcher.
- A reviewer `deletion` lens or judging sentence: Q4, not recommended.
- The mandate sizing clause: Q3, not recommended now. *Outdated
  (2026-10-20): taken as mandate v58.*
- An "evidence sources" role parameter: project facts belong in the
  specification and the instruction files.
- Translating any prompt text: prompts stay English; interface labels for
  the new option are the only localized strings.
- Exact token counts per engine tokenizer: the figures here are a
  four-characters-per-token estimate; Phase 0's token-store readings give the
  real delta per launch.

## 7. Validation against the requirement

| Acceptance item | Where |
| --- | --- |
| 1. Role prompts and their assembly, the mandate and earlier rewrite, learned-rule delivery, with `file:line` | §1.1–§1.5, sizes measured in §1.6 |
| 2. Each technique placed (mode, parameter, scaffold line, mandate, rule, nowhere) with why; prefer a mode or short line; what not to add | §2 table T1–T9; §2.1 |
| 3. Exact before and after text with token cost per launch | §3.1–§3.4, each with characters, tokens and room to the cap or envelope |
| 4. Rollout and measurement tied to the pilot's re-runs, P2's cost per accepted finding, later P5; rollback | §4 phases 0–3 and Rollback |
| 5. Open questions with options and one recommendation | §5 |
| 6. This file, English, repository-relative paths, no identities, Ukrainian summary; no edits elsewhere | this document; the only path written; §8 |

What this document could not verify: the pilot's arms had not settled when
it was written, so the noise band and the first cost per accepted finding
are Phase 0's to produce; the token figures are estimates until the token
store reports the re-run.

## 8. Короткий підсумок українською

Пост описує дев'ять прийомів; у нас вони лягають у три місця, без нової ролі.

1. **Архітектор, режим `architecture-audit`**: один блок (~970 символів,
   ~245 токенів на запуск) про докази для кожного кандидата, «permanent»
   піднімаємо на рішення з виміряною ціною, звіт групуємо в робочі потоки по
   одному малому PR, ранжуємо за тим, що міряють записи проєкту. Сьогодні цей
   режим змінює лише одне слово, і всі три пілотні лінії працюють у режимі
   design.
2. **Білдер, новий режим `sweep`** (~460 символів, ~115 токенів): прості
   виправлення з переліченого класу (нестабільні тести, мертвий код), без
   вичерпності, без послаблення перевірок, один PR на групу файлів.
3. **Практика сіту як чотири learned rules** (по ≤300 символів): рампа
   задача → підкаталог → репозиторій; порівняння гілок на одному зрізі з
   вартістю на прийняту знахідку; бриф лінії видалення з доказами й рядом
   рев'юера; повторний прогін при зміні моделі.

Не додаємо: нову роль, зміни рев'юера (231 символ до ліміту), робочих
правил, обгортки етапу, рядків таблиці ролей; мандат має лише 259 байтів
запасу. Спочатку блок аудиту йде текстом у промпт повторного прогону пілота
(гілка A, з повтором без блоку для шуму), і лише за правилом рішення з §4
потрапляє в код. Питання до форми: коли шипити блок аудиту, режим `sweep`
зараз чи після другого використання, правила чи рядок мандата, чи чіпати
рев'юера, куди класти класи розбіжностей, чи перезапускати на нових моделях.

*Застаріло (2026-10-20, мандат v58): оператор обрав рядок мандата; практика
сіту тепер окремий пункт мандата в кожній інсталяції, а не learned rules.*
