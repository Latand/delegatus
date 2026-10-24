# Tests that assert phrases in agent-facing text: audit (2026-10-24)

Read-only audit for the lane that removes these tests. Base: `main` at
`3736d5e434149f257061a94cb74b4c0806f152c8` (committed 2026-10-24 09:54 UTC).
Every line number below refers to that commit.

## Originating requirement

Operator, 2026-10-24 11:06 UTC, a voice message in this project's seat
conversation. It was about the loop of `expect(prompt).toContain("…")` checks
that open pull request #3291 adds to
`src/lib/voiceCompanion/sessionConfig.test.ts` over the rendered voice prompts.
Working rule 12 keeps quotes from private conversations out of published files,
and this file is published with the repository, so the message is paraphrased:
tests like that check nothing; the operator never asked for tests that look for
strings; remember that such tests are not written; remove tests of that kind
from the repository. The pinned specification holds the message verbatim. The
architect scaffold asks for the verbatim quote; working rule 12 governs a
published file, so the paraphrase stands, as `docs/design/gpt-6-role-prompts.md`
did for the same conflict.

The pinned specification, condensed: afterwards the repository has no tests or
test blocks whose assertions only check that agent-facing text (prompts,
instructions, mandates, role scaffolds, tool and MCP descriptions, guidance)
contains or lacks given phrases, and AGENTS.md says such tests are not written.
Tests that exercise behaviour stay even when they read text: valid structure,
parsing, routing, limits, size budgets, redaction. UI copy and i18n string tests
are listed for a later decision and are not deleted. The removal adds no
replacement tests, deletes a whole file only when nothing behavioural remains,
and drops helpers and fixtures that become unused. This stage writes only this
document.

## The answer in brief

- **291 rows over 78 test files**: 3 delete-file, 79 delete-block, 137 trim,
  72 keep. Applied, the verdicts remove about 789 assertion calls (a loop counts
  once) from 75 files: 87 whole tests go, and 137 kept tests lose their phrase
  lines.
- The heaviest files: `src/lib/orchestrator/prompt.test.ts` (39 rows that
  remove or trim), `src/lib/roles/registry.test.ts` (21),
  `src/lib/mcp/schemaParity.test.ts` (15), `src/lib/pipelines/prompts.test.ts`
  (12), `src/lib/runtime/voicePersonaRole.test.ts` (11),
  `src/lib/runtime/voicePersona.test.ts` (9) and
  `src/lib/voiceCompanion/sessionConfig.test.ts` (8).
- Whole files that go: `src/lib/roles/defaults.test.ts`,
  `src/lib/memory/roleSeatRender.test.ts`, `scripts/first-message-design.test.ts`.
- 73 more files were read whose string checks observe behaviour; they stay and
  are listed with the reason.
- UI copy and i18n: 169 files with 521 string-only blocks, listed at the end and
  left alone.
- Open pull requests #3291, #3314 and #3200 add new phrase assertions to files in
  this table, and #2926 removes some. The removal lane rebases first and applies
  the same rules to whatever has landed.
- A proposed AGENTS.md section is in "Proposed AGENTS.md section". Its wording
  is new, because the publication gate refuses text that matches stored learned
  rules.

## How a test was classified

**Agent-facing text** is text a model reads as instructions:

- stage prompts and the stage wrapper (`src/lib/pipelines/prompts.ts`,
  `stageInput.ts`, `testGuidance.ts`, `roles.ts`);
- the seat mandate (`src/lib/orchestrator/prompt.ts`) and its handoff
  (`handoffDigest.ts`, `seatCommand.ts`);
- role scaffolds (`src/lib/roles/defaults.ts`, `registry.ts`);
- MCP tool and field descriptions and the server instructions
  (`src/lib/mcp/server.ts`, `bindings.ts`);
- voice instructions and personas (`src/lib/voiceCompanion/sessionConfig.ts`,
  `tools.ts`, `src/lib/runtime/voicePersona.ts`);
- relay prompts (`src/lib/externalRelay/prompt.ts`, `ownerRun.ts`);
- seat-tick wakes (`src/lib/monitor/report.ts`, `seatTick.ts`,
  `seatTickController.ts`, `autonomy.ts`, `turbo.ts`) and the board
  maintenance report (`src/lib/orchestrator/boardReport.ts`);
- learned-rule notices and the curator brief (`src/lib/memory/roleRender.ts`,
  `curation/brief.ts`), the maintenance and release briefs
  (`src/lib/boardMaintenance/text.ts`, `src/lib/release/stages.ts`), and the
  continuation notices after a cut turn (`src/lib/runtime/recoveryNotices.ts`,
  `interruptionObligations.ts`);
- the repository files agents read as instructions: `AGENTS.md`,
  `CONTRIBUTING.md`, `.claude/skills/*/SKILL.md` and the docs a test checks.

**A phrase assertion** expects wording written in the source: a sentence, a
clause, a word, a heading, or a regex over them, present or absent. Counts and
positions of fixed wording, regex lints over authored text, whole-text equality
on a constant, and checks that prose names every member of an enum (drift
checks) are phrase assertions too.

**A behavioural assertion** stays even when it reads text:

- the output carries a value from the test's inputs: template substitution, ids,
  paths, counts, computed limits;
- a section for an absent input is left out (the label of an input's own section
  is a template marker);
- order or placement that the composer produces;
- idempotent delivery and upgrade of stored text;
- a block the code composes is included, asserted through its exported constant;
- a branch: the same marker present for one input and absent for another, both
  in the same test;
- byte budgets and truncation, redaction, parsers, and schema shape (keys,
  enums, required fields, types).

**Golden hashes and equalities.** A whole-text pin stays when a mechanism needs
the exact bytes:

- the mandate fingerprint (`src/lib/orchestrator/prompt.test.ts:300-312`): an
  edit must bump `ORCHESTRATOR_PROMPT_VERSION`, which marks running seats stale
  and redelivers the mandate;
- the stored-mandate fixtures (v54 to v57) that delivery upgrades by exact
  match;
- the relay's switch-off pins. `fixtures/legacy-prompt-hashes.json` is itself
  pinned by `fixtures/relay_v1/owner-tools-off-v3-hashes.json` and
  `switches-off-2b-hashes.json` (`src/lib/externalRelay/protocol.test.ts:60`,
  `:244`).

A golden that is re-pinned whenever the wording changes is a wording freeze,
and it goes: the stage-input hash (`src/lib/pipelines/stageInput.test.ts:77-94`)
and the learned-rules block `toBe` (`src/lib/memory/roleSeatRender.test.ts:23-33`).

**Out of scope.** Runtime outcome text that a test reads to observe behaviour:

- errors and refusals, park reasons, journal and board-card details;
- hints in MCP answers;
- spoken replies, owner replies in Telegram, pull request bodies;
- CLI output and launch argv.

Where such checks sat in candidate files, those files are listed in "Files read
whose string checks stay".

**Verdicts.**

- delete-file: no behavioural assertion remains in the file.
- delete-block: every assertion in the test is a phrase assertion. A `test.each`
  or a loop that makes tests is one row.
- trim: the test keeps its behavioural assertions and loses the listed lines.
  A loop or case left without an assertion goes with them, and so do variables
  only those lines used.
- keep: behavioural, with the reason.

## Decisions taken here

1. **Lines inside behavioural tests.** The specification speaks of tests and
   test blocks. A phrase line inside a behavioural test is the same check the
   operator rejected, so the table drops those lines and keeps every behavioural
   assertion (verdict trim). The trim rows are separable: if the seat wants whole
   blocks only, the lane skips them and every other row stands.
2. **Branch tests stay** when one test asserts presence for one input and absence
   for another. Examples: `src/lib/pipelines/prompts.test.ts:394-409` (the
   prototype paragraph by role) and `src/lib/attention/seatAgenda.test.ts:63-83`
   (merge stop classes). A test that asserts one branch's wording for a single
   input goes.
3. **Docs and skills are in scope.** Tests that check repository docs,
   `AGENTS.md`, `CONTRIBUTING.md` or skills for phrases go, because agents read
   those files as instructions.
4. **Enum-to-prose drift checks go**, for example
   `src/lib/orchestrator/prompt.test.ts:537-541` (bridge report classes) and
   `src/lib/memory/curation/curation.test.ts:772` (checklist outcomes). Where
   the code builds the prose from the enum, the check is composition and stays:
   `src/lib/mcp/schemaParity.test.ts:869` (target shapes, `server.ts:3761`),
   `src/lib/mcp/taskColor.integration.test.ts:121` and
   `src/lib/mcp/taskPriority.integration.test.ts:139-143` (`server.ts:4137`,
   `:4139`).

## Method and evidence

- **Earlier answers.** Transcript search, scoped to this project, found the
  requirement and the seat's reply at 11:08 UTC: the seat recorded the practice
  as a machine-wide learned rule and found no earlier rule. At this commit
  `AGENTS.md` and `CONTRIBUTING.md` carry no rule about wording tests (a grep for
  phrase, wording and toContain finds nothing on the subject). A memory search
  found no entry.
- **Inventory.** A TypeScript-compiler scan of all 2,317 test files listed
  29,081 test blocks, each with its assertion calls. 14,867 calls use a string
  matcher: `toContain`, `toMatch`, `toStartWith`, `toEndWith`,
  `stringContaining`, `stringMatching`, or `includes`, `startsWith` or `indexOf`
  compared with `toBe`.
- **Origin.** Each string literal was searched, whitespace-normalised, in the
  2,692 non-test source files under `src`, `bin`, `scripts` and `landing`, and
  7,242 matched a file. 183 test files assert literals written in one of the
  agent-facing producers above. A grep over `readFileSync` and `new URL`
  arguments found the tests that read docs, `AGENTS.md`, `CONTRIBUTING.md` or
  skills.
- **Reading.** Every candidate file was read test by test, and the largest ones
  whole. Ranges come from the compiler scan: the first and last line of the
  `test(...)` call, or of the loop that generates the tests.
- **Limits.** A literal that the source assembles across lines can miss the
  origin match, so the files where it mattered were read whole:
  `src/lib/orchestrator/prompt.test.ts`, `sessionConfig.test.ts`,
  `registry.test.ts` and both voice persona files. Tests under `src/components`,
  `src/hooks`, the `src/app` pages and `landing` are covered only by the UI list.

## The table

Rows are grouped by file. The Test column gives the test's title. Line numbers
are at `3736d5e4`.

### `src/lib/pipelines/prompts.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 20-39 | generated refresh and fix prompts keep commits in the stage worktree and publication with the pipeline | fixed commit/push wording in refresh and fix prompts | **delete-block** | every assertion is wording authored in prompts.ts |
| 41-82 | assembled test guidance uses installed tooling and project checks: %s (3 cases) | test-guidance wording; resolved gate-slot.sh path | **trim** | keep 67, 69 and 72-75 (a branch on installed tooling: without the wrapper the guidance says it is unavailable, with it the resolved absolute path and its rule appear); drop 59-66, 68, 70, 76 |
| 84-87 | role and workflow defaults leave gate location and test runner to assembly and project rules | scaffolds lack "scripts/gate-slot.sh"; seeded templates carry no verify | **trim** | keep 86 (seeded templates have no verify field); drop 85 |
| 89-102 | comparison guidance names the owner while preserving full host capabilities | owner id and epoch from delivery rendered; guidance wording | **trim** | keep 97 (owner id and epoch from the delivery record are rendered) and 101; drop 98-100 |
| 104-130 | persisted orchestrator scaffolds use the project's worker limit when each stage launches | worker limit from project setting substituted into a stored scaffold | **keep** | behaviour: the launch-time worker limit (12) replaces the stored value and {{maxWorkers}}; the preview keeps the stored text |
| 132-148 | every run scaffold overrides conflicting branch instructions and names the lane branch | branch name rendered; branch line placed after the scaffold; override wording | **trim** | keep 139, 141, 143, 146 (lane branch rendered; branch rule placed after the scaffold; the commit line appears for read-write and not for read-only); drop 140, 144 |
| 150-198 | run prompt renders task, previous output, spec, access, verdict, and nesting contracts | {{task}}/{{prev.output}}/spec/role substitution; verdict-contract wording; parseStageVerdict | **trim** | keep 179-181, 186, 193, 196, 197 (template substitution; spec, access and role id from the input; the DELEGATUS_MECHANICS block the wrapper composes; the verdict parser); drop 182-185, 187-189, 192, 194, 195 |
| 200-231 | role-less prompts omit role identity and scaffolding | {{task}} substitution; pinned-task section present; role sections omitted without a role; fallback example | **trim** | keep 226, 227, 229, 230 (template substitution; sections for absent inputs are omitted); drop 228 |
| 233-271 | a prompt without {{prev.output}} still receives the relayed previous output (#1678) | relay section placement, omission when empty, placement by template | **keep** | behaviour: relayed output is placed between the brief and the pinned task, omitted when blank, and left to a template that places it |
| 276-316 | the stage prompt names stage_report as the one completion channel and the fenced block as its fallback | order of stage_report and fence; wording of the fallback condition; one fence | **delete-block** | all assertions read fixed wording (order and counts of authored phrases); nothing comes from input |
| 318-324 | no role scaffold instructs an unconditional fenced verdict (#1797) | scaffolds lack fence wording | **delete-block** | phrase lint over ROLE_DEFAULTS scaffolds |
| 328-336 | a decision continuation says the answer governs and is relayed under a label that fits it | decision-input wording; relay label wording | **delete-block** | all assertions are authored wording |
| 345-391 | every stage a lane renders names no stack and teaches one verdict vocabulary | legacy review conversion; fix-stage role; stack lint; marker counts; fix-prompt wording | **trim** | keep 355, 363, 365, 378, 379, 382 (conversion result, the 40-hex base commit rendered only in its 8-character form, fix role and runtime, findings relayed); drop 361, 362, 364, 366-373, 381, 383-390 |
| 394-409 | design and UI stages receive the task-bound prototype publishing contract | prototype contract wording per role | **trim** | keep 405-408 (the wrapper adds the prototype paragraph by role: shown for builder, architect, visual-critic and role-less stages, absent for reviewer, merger, verifier); drop 399-401, 404 |
| 417-435 | a stored lane renders its original scaffold and its fix stage still reads the blocked rule | stored scaffold rendered byte for byte; blocked-rule wording by role or edge | **keep** | behaviour: a stored scaffold renders byte for byte, and the wrapper detects a fix stage by params or by its fail edge and not for the reviewer (426, 431, 434 compare the branches) |
| 437-449 | an owner without a delivery remote gets a local commit instruction | commit wording by delivery remote | **keep** | behaviour: a branch on the delivery remote; the local-commit instruction appears without a remote and the publish instruction with one |

### `src/lib/orchestrator/prompt.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 44-47 | the manager draft defaults to the Claude Opus alias on low effort through the role preset | ORCHESTRATOR_SPAWN_CONFIG fields | **keep** | behaviour: spawn configuration object, no text |
| 51-53 | no auto-start prohibition survives in the mandate | mandate lacks a phrase | **delete-block** | phrase absence in a constant |
| 58-60 | the retired unequal-channel phrasing does not return | mandate lacks a phrase | **delete-block** | phrase absence in a constant |
| 62-65 | the canonical direct-spawn example includes the mandatory semantic title | SKILL.md contains an example line | **delete-block** | phrase in an agent skill file |
| 72-83 | no prohibition on addressing the operator survives anywhere in the mandate | mandate lacks six phrases | **delete-block** | phrase absence in a constant |
| 87-180 | the default mandate is at version 58, and a v57 seat reads as stale | version constant; orchestratorMandateStale; mandate wording | **trim** | keep 88, 137-165 (version and stale detection); drop 166-179 |
| 252-266 | the merge bar follows the project's merge setting, and the mandate says when a lane finishes its task | mandate wording | **delete-block** | phrases in a constant |
| 271-279 | the mandate opens without issue numbers, greets in plain words and runs releases only when turned on | first line equals a sentence; greeting and release wording | **delete-block** | exact wording of constants |
| 285-298 | a mandate delivered with the greeting as it shipped up to v25/v26/v29 greets once, in the current words (3 cases) | orchestratorMandateForDelivery replaces an old greeting | **keep** | behaviour: delivery rewrites a stored greeting and states the status section once |
| 300-312 | any edit to the default mandate text moves its version (#2030) | SHA-256 of the mandate matches the pinned version; versions unique | **keep** | behaviour: the version bump is what makes running seats stale and redelivers the mandate (orchestratorMandateStale); no phrase is read |
| 339-352 | every clause the tick contract carried lives in the mandate, and reaches every seat once (#2030) | clauses present in the clock directive; delivery appends the section once | **trim** | keep 348-351 (a bespoke mandate gets the section once; delivery is idempotent); drop 340-345 |
| 373-375 | the shipped clock opening the module keeps is the one that shipped | ORCHESTRATOR_SHIPPED_CLOCK_OPENING equals the historical text | **keep** | behaviour: delivery recognises stored older mandates by this exact text, so the test pins the matcher's input; it makes no claim about the current mandate |
| 380-399 | delivery replaces the clock section an older mandate carries, so it states every contract clause once (#2030) | orchestratorMandateForDelivery on v11-v20 bodies | **keep** | behaviour: replacement by exact match, single section, idempotent, a reworded section kept |
| 401-415 | only a seat delivered a mandate that states the contract is spared its clauses in the wake (#2030) | orchestratorMandateCarriesTickContract | **keep** | behaviour: decision by version and section content |
| 420-423 | the mandate names the transcript search and read tools | mandate contains two tool names | **delete-block** | phrases in a constant |
| 428-430 | no transport named tmux survives in the mandate | mandate lacks "tmux" | **delete-block** | phrase absence in a constant |
| 436-440 | the clock section names every kind of schedule a seat could reach for, by no engine's tool name | clock directive wording; tool names absent | **delete-block** | phrases in a constant |
| 442-444 | the playbook reference is no longer pinned to this checkout | mandate lacks a phrase | **delete-block** | phrase absence in a constant |
| 451-458 | the checked-in playbook no longer tells the seat to schedule itself | delegatus-conveyor SKILL.md wording | **delete-block** | phrases in an agent skill file |
| 460-468 | mandate delivery keys off directive content and appends it exactly once | delivery of a custom mandate; idempotence; role table appended | **keep** | behaviour: append once, idempotent |
| 476-500 | the clock handover reaches a bespoke or older mandate, exactly once | delivery appends, is idempotent, keeps a reworded section | **keep** | behaviour |
| 504-506 | the current default already contains the clock directive | default contains the directive constant delivery keys on | **keep** | composition: the section delivery recognises is inline in the default, so delivery appends nothing (also pinned by 642-654) |
| 511-520 | the mandate names every attention target and uses the tool schema for shapes | mandate wording; FOCUS_TARGET_KINDS membership | **delete-block** | phrases in a constant; the enum line 516 only supports them |
| 525-530 | the mandate names explicit graph insertion and final-fix completion (#2247) | mandate wording | **delete-block** | phrases in a constant |
| 532-535 | the mandate carries the pipeline stage shape a first pipeline needs | mandate wording | **delete-block** | phrases in a constant |
| 537-541 | the prompt names every bridge report class and no others | mandate names each BRIDGE_REPORT_CLASSES value | **delete-block** | enum-to-prose drift check: the mandate contains given words |
| 543-545 | the prompt carries the directive trailer contract in the exact wire form | mandate contains "[bridge ref=<seq>]" | **delete-block** | phrase in a constant |
| 551-555 | the mandate body says nothing about deploying the Viewer | no "## Deploys" line; two phrases absent | **delete-block** | phrase absence in a constant |
| 560-581 | no retired task-binding claim survives in the ownership directive | ownership directive wording | **delete-block** | phrases in a constant |
| 585-593 | the task-creation section tells the manager to pass icon and color by the one rule create_task carries | section wording; rule text absent; server.ts source contains a call | **delete-block** | phrases in a constant and a grep of source text |
| 598-615 | the task-ownership section reaches a bespoke or older mandate, exactly once | delivery appends once, idempotent, keeps a reworded section | **keep** | behaviour |
| 620-638 | the board report section reaches a bespoke or older mandate once, and is recognized by its heading | delivery behaviour; directive wording | **trim** | keep 622-628; drop 631-637 |
| 642-654 | the delivered default carries each directive exactly once, and delivery adds only the role table | delivery of the default; each directive once | **keep** | composition: delivery adds only the role table |
| 657-687 | the mandate asks before a bug report is filed, publishes only an approved preview, and sends another project's work to its seat | section wording; delivery of the section into bespoke and reworded mandates | **trim** | keep 676-686; drop 660-672 |
| 705-712 | delivery removes the deploy section a stored mandate carries from the old body | delivery removes a shipped block by exact match | **keep** | behaviour |
| 716-719 | a seat's own deploy section survives delivery | delivery keeps bespoke text | **keep** | behaviour |
| 731-760 | successive mandate renders read saved rows, variants and revision from the current registry | role table rows from a saved registry | **keep** | behaviour: rendered from registry data and revision |
| 762-773 | the delivered mandate renders the role table from the registry it is handed | role rows from a handed registry | **keep** | behaviour |
| 775-789 | the role table carries the runtime guidance beside it | guidance wording in the role table notes | **delete-block** | phrases in fixed notes; the builder row values are already checked at 762-773 |
| 791-810 | the manager table uses resolved saved builder variants and keeps registry provenance | variant runtimes and revision rendered | **keep** | behaviour |
| 812-818 | the manager table makes a fallback registry visible | degraded health and its reason rendered | **keep** | behaviour: health state and reason from the input |
| 820-828 | delivery replaces a role table the mandate already carries, so it is always the live one | stale table replaced | **keep** | behaviour |
| 830-868 | the role table keeps the delivered default inside the structured envelope | byte bounds | **keep** | size budget |
| 872-909 | the role table tells the seat to size lanes, lists every variant and names a reset row | variant grouping; reset row; table notes wording | **trim** | keep 882-886, 904, 906-908 (variants sharing a runtime listed once, the reset row from the input, no blank line, idempotent replace); drop 887-903 |
| 917-942 | the delivered default names no stack and teaches one verdict vocabulary (v30) | stack lint; marker counts; wording | **delete-block** | phrases, counts and absences in the delivered default |
| 948-958 | the seat's personality is proactive inside accepted work, and every line agrees | personality wording | **delete-block** | phrases in constants |
| 962-973 | delivery replaces the clock section a v29 mandate carries | delivery of a v29 section | **keep** | behaviour |
| 977-983 | the role table names a role whose prompt text this install replaced | override detection | **keep** | behaviour: the role whose scaffold differs from the shipped one is named |
| 988-997 | the delivered mandate names no Viewer, and the v29 clock heading still marks a seat's own section | "viewer" lint; reworded v29 section kept | **trim** | keep 992-996; drop 990-991 |
| 999-1002 | the mandate chooses an explicit review budget from consequences and probability | mandate wording | **delete-block** | phrases in a constant |
| 1004-1014 | agent-facing review skills agree with the mandate's risk budget | SKILL.md wording | **delete-block** | phrases in agent skill files |
| 1016-1018 | the versioned mandate asks for a current status note in the operator's language | mandate wording | **delete-block** | phrase in a constant |
| 1021-1040 | the mandate asks every decision as a form | delivery adds the form directive; wording | **trim** | keep 1022-1023 and 1025 (a bespoke mandate is delivered the directive); drop 1024, 1028-1039 |
| 1043-1046 | the mandate names linked seats and requires coordination before a shared release | mandate wording | **delete-block** | phrases in a constant |
| 1048-1064 | the decision-form mandate upgrades every shipped pointer once and preserves bespoke wording | delivery upgrades shipped pointers | **keep** | behaviour |
| 1066-1073 | the board walk clears only rows that ask nothing and replaces the shipped paragraph exactly | directive wording; exact-match replacement | **trim** | keep 1068-1072; drop 1067 |
| 1076-1078 | the role table names the gated prototype lane | role table note wording | **delete-block** | phrase in fixed notes |
| 1083-1095 | the seat's Who you are section is kept word for word and the literal-request rules follow it | section text frozen against the v54 fixture | **delete-block** | wording freeze of a constant |
| 1103-1125 | delivery replaces every rewritten v54 directive by exact match | v54 fixture hash; delivery replacements | **keep** | behaviour: upgrade of a stored mandate |
| 1131-1148 | delivery takes every reply-draft instruction out of a v55 mandate by exact match | v55 upgrade | **keep** | behaviour |
| 1154-1165 | delivery sends a v56 mandate's proposals to a decision form by exact match | v56 upgrade | **keep** | behaviour |
| 1178-1194 | the mandate states the maintenance practice after the declared-outputs bullet | bullet wording, position and lint | **delete-block** | phrases and placement in a constant |
| 1200-1218 | delivery gives a v57 mandate the maintenance practice and the current rule 16 by exact match | v57 upgrade | **keep** | behaviour |
| 1224-1232 | the seat's mandate carries all sixteen working rules in their short form | short rules inside the mandate; numbering parity; phrases | **delete-block** | contents of constant texts |
| 1238-1260 | a seat's launch prompt carries the evidence and publication duties of rules 6 and 12 | roleSpawnPrompt carries the short rules once; duty phrases | **trim** | keep 1239-1243 (the launch built by roleSpawnPrompt holds the short rules once and not the full ones); drop 1244-1259 |

### `src/lib/roles/registry.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 18-63 | merger resolves a required reviewed-PR list with a read-write, non-nesting profile | missing-param error, config, capabilities, prs value rendered; merger wording; CONTRIBUTING.md wording | **trim** | keep 19, 21, 24-26 (required parameter, runtime, capabilities, the prs value in the prompt); drop 27-62 |
| 65-74 | maintainer preserves review and release ownership and treats retired seats as history | maintainer scaffold wording | **delete-block** | phrases in a scaffold |
| 76-151 | role registry exposes the thirteen role ids and campaign-ready orchestrator config | role ids and configs; campaign parameters rendered only in that mode; wording | **trim** | keep 79-108, 119, 121-125, 132-135, 138, 141-150 (ids, runtimes, parameter values rendered, parameter lines omitted outside the campaign mode, no triple blank line); drop 120, 127, 136, 137 |
| 153-161 | builder parameters select the cheap fixer and the frontend implementation profile | runtimes; FRONTEND_GUIDANCE block selected by domain; a wording line | **trim** | keep 155, 158, 159 (runtime by parameter; domain=frontend selects the exported guidance blocks); drop 160 |
| 163-177 | builder and fix-round scaffolds route heavy commands through the gate wrapper and keep plain commits | scaffold wording per mode and domain | **delete-block** | phrases in scaffolds |
| 196-206 | the reviewer scaffold runs the project's own checks, and a cross-engine inherited model is rejected | diffSource rendered; wording; engine-override error | **trim** | keep 199, 202-205 (parameter value rendered; refusal without a model); drop 198, 200 |
| 211-224 | builder, reviewer and architect scaffolds send the agent to earlier answers first, and the spawn line names the tools | rule 3 wording; tool names in constants | **delete-block** | phrases in scaffolds and constants |
| 229-236 | the builder scaffold names files repository-relative and no role scaffold asks for absolute paths | builder wording; regex lint over scaffolds | **delete-block** | phrase presence and absence |
| 241-258 | every registry role scaffold carries the process-cleanup rule | PROCESS_CLEANUP_MARKER, "pkill", "port 0" in every rendered role | **delete-block** | PROCESS_CLEANUP_MARKER exists only as a phrase the tests pin (defaults.ts:35); the shared rules block itself is checked at 413 |
| 272-286 | spawn role resolution injects the scaffold and requires deploy confirmation | deploy confirmation refusal; runtime; mode value rendered | **keep** | behaviour: confirmation refusal, explicit runtime, the tdd mode rendered from the parameter |
| 322-330 | orchestrator spawn retires the launch-only worker number | phrase absence; scaffold unchanged by maxWorkers | **trim** | keep 329 (maxWorkers changes nothing); drop 325 |
| 348-367 | the small-change and docs variants ship their runtime, and only builder and reviewer take size | variant runtimes; FRONTEND_GUIDANCE kept for size=trivial; unknown-parameter errors | **keep** | behaviour: runtime selection, guidance block selected by domain, parameter refusal |
| 381-390 | an empty optional parameter drops its labelled line | empty parameter drops its labelled line; values rendered | **keep** | behaviour: template rendering of empty and filled parameters |
| 402-422 | every role scaffold carries the working rules once and names no stack, project file or retired marker | stack and project lint; marker absence; WORKING_RULES once; wording | **trim** | keep 403-406, 413 (every rendered role carries the shared rules block exactly once); drop 407, 409, 410, 416-419 |
| 426-430 | the verifier names a verdict for every combination of claim labels | verifier wording | **delete-block** | phrase in a scaffold |
| 435-441 | the deployer and the prod-auditor name their verdicts | scaffold wording | **delete-block** | phrases in scaffolds |
| 445-457 | a builder fix round carries the apply-fixes guidance | guidance and finish-line blocks selected by mode; wording | **trim** | keep 449, 450, 454-456 (mode selects APPLY_FIXES_GUIDANCE and the fix-round finish line; the plain builder gets neither); drop 453 |
| 459-474 | %s fixers repair their own discoveries and leave grading to reviewers (3 cases) | fix-round wording | **delete-block** | phrases in scaffolds (BLOCKED_FIX_ROUND is a literal copied into the test) |
| 478-487 | a spawned fixer reads the blocked-only failure definition without stage fields | wording; spawn prompt ends with SPAWN_COMPLETION | **trim** | keep 486 (the spawn prompt ends with the completion block); drop 482-485 |
| 491-504 | a role spawn ends with the verdict line, and a seat or a role-less spawn does not | exact composition of roleSpawnPrompt; wording | **trim** | keep 492, 496-502 (exact composition per caller; a child orchestrator without a mandate gets the seat rules, one with a mandate does not, registry.ts:170); drop 503 |
| 508-529 | the issue-reporter preset is read-only, previews and never publishes, and states every scrub rule | capabilities; scrub-rule and scaffold wording | **trim** | keep 511 (read-only capability); drop 512-528 |
| 534-564 | the visual-critic preset is read-only on Opus and judges only rendered frames | capabilities, runtime, name; scaffold and AGENTS.md wording | **trim** | keep 537-539; drop 540-563 |
| 568-577 | the visual critic ends needs_decision with no findings when a touched surface cannot be framed | scaffold wording | **delete-block** | phrases in a scaffold and a constant |
| 595-599 | the visual critic judges every prototype variant with the operator's checklist | scaffold wording | **delete-block** | phrases in a scaffold |

### `src/lib/mcp/schemaParity.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 37-50 | agent_fleet advertises summary-first filters and bounded detail through the protocol | tool description phrase; schema fields; dispatch | **trim** | keep 42-48 (schema fields, optional key, arguments forwarded, invalid state refused); drop 41 |
| 123-134 | spawn_agent advertises an optional account pin with project binding semantics | account schema; description phrases | **trim** | keep 126-129 (optional nullable account field); drop 130-132 |
| 318-337 | migration schema names explicit selection and preserves automatic reseat | schema carries the select-account action and accountId; dispatch | **keep** | behaviour: published schema values and dispatch of both actions |
| 352-367 | spawn_agent, create_pipeline and pipeline_action publish the visual critic | role enums in three schemas | **keep** | behaviour: schema enums |
| 369-382 | get_conversation listTools publishes every bounded tail target | tool and field description wording | **delete-block** | phrases in tool descriptions |
| 384-408 | conversation_messages publishes identity, filters, clamps, and paging on the first probe | schema properties; description wording | **trim** | keep 390-393 without 391 (identity fields exist in the schema); drop 391, 394-406 |
| 410-466 | conversation_action publishes full-generation archive outcomes and the 100-target bound | action enum, maxItems, item fields, dispatch; description wording | **trim** | keep 429, 435-439, 443-465; drop 430-434, 440-441 |
| 468-494 | search_transcripts publishes its body-query, project, cursor, and bounded page schema | description wording; required and property keys | **trim** | keep 482-489; drop 473-481, 490-492 |
| 727-795 | create_pipeline publishes the stage contract in its tool definition | stage schema keys and enums; description wording | **trim** | keep 736-741, 746-749 (stage keys, kind/engine/role enums, onExhausted enum); drop 743-744, 751-773, 779-793 |
| 835-872 | request_attention publishes the per-kind target schema in its tool definition | oneOf branches and required fields; examples composed from FOCUS_TARGET_SHAPES; wording | **trim** | keep 842-859, 869 (one branch per kind with its required fields; the description is composed from the shapes table, server.ts:3761); drop 864-866, 870 |
| 905-966 | spawn_agent and both send tools publish recoveryOnly and the recovery contract, and the flag never enters the digest | recoveryOnly type and optionality; RECOVERY_CONTRACT_DESCRIPTION composed into descriptions; wording; recovery dispatch | **trim** | keep 913 reduced to { type: "boolean" }, 918, 919 (the exported contract block is composed into each description, server.ts:3656), 934-965; drop 912, 914, 915-917, 920-932 |
| 1002-1023 | task writes advertise hold reasons and the additive checklist with stopping guidance | hold and steps schema; description phrase | **trim** | keep 1012-1019; drop 1020 |
| 1030-1073 | the launch tools publish the task binding fields agents must pass | taskIds/taskId types and optionality; description wording | **trim** | keep 1036, 1037, 1044, 1049, 1068; drop 1040-1043, 1045, 1050-1067, 1069, 1071 |
| 1124-1140 | stage_report's field descriptions match the stage contract | field description wording | **delete-block** | phrases in field descriptions |
| 1142-1174 | telegram_bot_send_document publishes its own schema and the text tool's stays text-only | document schema; dispatch; caption bound; description phrases | **trim** | keep 1152-1158, 1162-1172; drop 1159-1160 |
| 1186-1196 | MCP pipeline tools describe default 3 and accept an explicit higher budget | description and schema-description phrase; explicit budget admitted | **trim** | keep 1195; drop 1189-1193 (the loop asserts only description text) |
| 1198-1208 | the published update_task schema advertises replaceable notes without author inputs | note schema; no author inputs; description phrases | **trim** | keep 1202-1204; drop 1205-1206 |

### `src/lib/voiceCompanion/sessionConfig.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 31-54 | the Live configuration exposes the explicit read allowlist and the delegation tools with calm speech instructions | API version, model, tool allowlist, store:false, closed client events, strict tool parameters; instruction wording | **trim** | keep 32-40, 51-52; drop 41-50 |
| 56-79 | the backend answers from reads, composes one complete task, names a waiting request instead of sending it again, and keeps report facts with their subjects | instruction wording; tool_choice auto/none | **trim** | keep 77-78 (the final delegation response turns tools off); drop 57-75 |
| 81-88 | the Codex thread carries the same backend rules and the call's reports read | instruction wording; the thread's dynamic tools | **trim** | keep 87 (the thread is given orchestrator_reports); drop 83-86 |
| 90-105 | both voice paths require prototype evidence and stop reading on a hand-off | PROTOTYPE_BACKEND_RULES and PROTOTYPE_LIVE_RULES composed into both paths; wording | **trim** | keep 91-92 and 98-100 (the exported rule blocks reach the backend, the Codex thread and both Live locales); drop 93-96, 101-103 |
| 107-115 | Telegram history reads directly and never hands private content to the orchestrator | instruction wording | **delete-block** | phrases in instructions |
| 117-144 | composed tasks carry project scope, provenance and interface language in both backend paths | locale-derived language line in both paths; wording; field and length limits | **trim** | keep 118-122 and 142-143 (the locale's interface language reaches both backend paths; instruction maxLength and the ask cap); drop 123-141 |
| 146-156 | voice design docs describe the current composition rule and contain no copied-phrasing directive | design doc wording | **delete-block** | phrases in repository docs |
| 158-163 | both native voice transports receive the shared speech language restriction | recognition-language line in Live and Codex voice prompts | **keep** | composition: VOICE_RECOGNITION_LANGUAGES, built from TRANSCRIPTION_LANGUAGES (transcribe/languages.ts:37), reaches both transports |
| 166-169 | project ambiguity instructions never ask the operator for an internal key | instruction wording | **delete-block** | phrases in instructions |

### `src/lib/roles/defaults.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 1-54 | (whole file: maintainer, deployer, reviewer and prototype-publication scaffold wording) | scaffold phrases; AGENTS.md and boardMaintenance/text.ts source text | **delete-file** | all four tests assert wording of scaffolds, AGENTS.md or source text; nothing behavioural remains |

### `src/lib/pipelines/roles.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 21-31 | builder isolation keeps edits and commits in its assigned worktree | scaffold and WORKING_RULES_SHORT wording | **delete-block** | phrases in authored scaffolds |
| 87-103 | pipeline role resolution defers legacy worker placeholders until stage launch | saved override placeholder kept unsubstituted | **keep** | behaviour: the operator's override keeps {{maxWorkers}} until launch |
| 147-161 | a near-limit override scaffold composes with fences inside the store cap | length cap; fences section appended | **keep** | size budget and composition of a fences section after an input scaffold |
| 173-180 | a visual-critic stage resolves read-only on the role's Claude Opus runtime | runtime and access; scaffold opening wording; fences section | **trim** | keep 175, 176, 178, 179; drop 177 |
| 216-223 | a Builder fix round resolves to the fix row its domain and size select | fix-row runtimes; mode rendered into the scaffold heading | **keep** | behaviour: runtime selection; the apply-fixes mode value appears |
| 235-243 | operator role params substitute into the resolved prompt scaffold | parameter values rendered | **keep** | template substitution |
| 248-253 | an orchestrator pipeline stage carries the working rules and the worker limit | exact composition; a constant's ending wording | **trim** | keep 250, 251; drop 252 |
| 259-269 | every shipped role and variant scaffold fits the stage cap untruncated | last working rule present; headroom under the cap | **keep** | size budget: rule 16 is the last rule, so its presence proves no truncation |
| 274-305 | accepted text parameter values keep every rule whole or refuse the stage | overflow refusal; values rendered; scaffold end kept | **keep** | behaviour: parameter overflow and truncation |
| 307-324 | a reviewer diff source past the stage cap is refused, a usual one keeps rules 13 to 16 | overflow refusal; value rendered; end kept | **keep** | behaviour |
| 326-330 | pipeline role lookup ignores the retired orchestrator maxWorkers parameter | retired wording absent; scaffold unchanged by maxWorkers; default parallelN rendered | **trim** | keep 328, 329; drop 327 |
| 332-344 | blank role params fall back to the registry default token value | default token rendered; empty parameter drops its line | **keep** | template rendering |
| 346-356 | Builder domain=frontend keeps the canonical frontend scaffold guidance (parity with resolveRole) | FRONTEND_GUIDANCE present for frontend, absent otherwise; parity with resolveRole | **keep** | branch on domain and parity between two resolvers |

### `src/lib/flows/prompts.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 46-54 | reviewer prompt includes pinned specification and acceptance criteria | spec section and text; review head shortened; wording | **trim** | keep 49-51, 53 (spec rendered under its label; head in its 8-character form, no full hash); drop 52 |
| 56-58 | kickoff carries a pinned specification into the implementer session | spec text rendered | **keep** | data from the input reaches the prompt |
| 60-67 | flow reviewers require base evidence and retain blocking head-only failures | reviewer wording | **delete-block** | phrases in a fixed prompt |

### `src/lib/workflows/prompts.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 32-40 | stage 0 kickoff carries the brief, the scope, the verify hint and the marker rule | brief, scope, verify rendered; marker wording; notes section omitted | **trim** | keep 35-37, 39; drop 38 |
| 42-49 | later stages receive the prior stages' STAGE_DONE notes | prior notes rendered under their section | **keep** | data and section rendering |
| 51-55 | a stage finished without a note still threads through readably | fallback text for a null note | **keep** | template rendering of a missing value |
| 57-67 | fixer kickoff adds the FIXED/REJECTED protocol and every stage note | stage notes rendered; protocol wording | **trim** | keep 62-63; drop 64-66 |
| 69-82 | prBody folds the brief, stage notes and rounds into the PR | PR body data and trailer | **keep** | data; the PR body is published text for people and gives agents no instructions |

### `src/lib/pipelines/testGuidance.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 9-37 | standalone assembly finds the install and quotes its wrapper for another checkout | resolved, quoted wrapper command runs; fallback after removing a tooling file | **keep** | behaviour: the quoted command executes; the branch to the fallback is observed |
| 39-64 | packed tooling resolves without source files and the container bridge publishes host-visible bundles | tooling resolution; fallback branch; error | **keep** | behaviour |
| 66-74 | an install without resolvable gate tooling composes the fallback brief | fallback wording | **delete-block** | the branch itself is already observed at 33 and 58 in the same file; this block asserts the fallback's sentences |

### `src/lib/pipelines/stageInput.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 54-75 | a large multibyte specification is file-backed after the previous output | byte bound; file written; head sections; no broken multibyte; determinism | **keep** | size budget and file backing |
| 77-94 | small stage inputs preserve the original renderer's bytes ($hash) (3 cases) | branch rendered; guidance composed; SHA-256 of the whole rendered prompt | **trim** | keep 84-86, 91; drop 87-90 and 92-93 and the hash field of the cases (a golden hash of the whole agent-facing text: any wording edit re-pins it) |
| 96-107 | the exact UTF-8 boundary stays inline and one byte over becomes a file reference | byte boundary; file-reference label | **keep** | size budget |
| 109-115 | an entry stage can externalize just its specification | byte bound; which file reference appears | **keep** | size budget |
| 117-127 | a prompt beyond the reference budget preserves full stage input in one file | byte bound; full input in the file | **keep** | size budget |
| 129-142 | controller artifacts stay outside read-only settlement in a repository without ignore rules | git status; file references present | **keep** | behaviour: settlement and file backing |
| 259-272 | read-write settlement never stages or commits controller artifacts | git state; file references present | **keep** | behaviour |
| 274-308 | settlement excludes controller artifacts despite repository inclusion rules (read-write=%s) | git state; file references present | **keep** | behaviour |
| 310-329 | launch filtering executes stored privacy patterns away from the calling thread | learned rule redacted to a placeholder | **keep** | redaction |

### `src/lib/externalRelay/prompt.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 12-28 | owner sequential-write guidance is scoped to enabled owner-action claims | legacy prompts unchanged; guidance on with the switch and action tools, off without them | **trim** | keep 20, 21, 24-27 (a branch on the switch and on action tools; disabled output unchanged); drop 22-23 |
| 30-50 | a request without requester_context gets the Phase 1 prompt unchanged | whole prompt equals the Phase 1 text | **keep** | rollout guard: a request without the new fields renders the pre-feature prompt byte for byte; same family as the switch-off hash pins below |
| 52-71 | requester, memory and tool index arrive as escaped data with the hand-off rule | trust line names the present sections; requester and tools rendered; a field cannot close its section; hand-off wording | **trim** | keep 59-69 (sections named from what is present, data rendered, escaping, the hand-off rule appears with a hand-off tool); drop 70 |
| 73-84 | no tool index, no hand-off: requester alone adds only its own section | sections and hand-off rule absent without tools | **keep** | the other side of the branch at 52-71 |
| 86-91 | all slice 1 prompts match the pre-change e65e6603 hashes | SHA-256 of prompts for fixture requests | **keep** | rollout guard: fixtures/legacy-prompt-hashes.json is itself pinned by fixtures/relay_v1/owner-tools-off-v3-hashes.json and switches-off-2b-hashes.json (protocol.test.ts:60, 244); removing it breaks those pins |
| 93-98 | action retry guidance accounts for post-execution denials | retired wording absent; new wording present | **delete-block** | phrases for one fixed input |
| 100-112 | negotiated conversation turns trust only the formatting section alongside the answer frame | format data rendered; continuation omits the seen section; legacy request keeps its frame | **keep** | behaviour: continuation and negotiated-format branches |
| 114-129 | owner continuation sends unseen data and refreshes changed instructions | sections omitted once seen; size; refreshed when tools change | **keep** | behaviour and size |
| 132-144 | owner continuation carries an unseen explicit reply alongside local outbound context | sections present or absent by seen state | **keep** | behaviour |
| 146-165 | owner continuation never repeats seen reply context and prefers complete recovered rows | seen rows omitted; recovered row once | **keep** | behaviour |
| 177-199 | owner continuation retains negotiated formatting beside service-tool guidance and refreshes a changed guide | sections by digest; tool names when the feature is on | **keep** | behaviour |

### `src/lib/externalRelay/runner.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 251-300 | prototype owner control records the web decision without capacity or an agent, and concurrent replay adds nothing (%s) | decision record; delivery size; option label; seat instruction wording | **trim** | keep everything except 289; drop 289 (the "Read read_prototype_review" instruction) |
| 2340-2461 | X4 six owner runs extend the existing X2 capture format | calls, waits, projections, call budget rendered; guidance wording | **trim** | keep all but 2422 and 2442; drop 2422, 2442 (guidance sentences asserted for one case) |
| 2493-2521 | an exhausted unavailable replay preserves the completed ban's uncertainty with ${choice} | replay state; schema; guidance wording | **trim** | keep all but 2516; drop 2516 |

### `src/lib/externalRelay/ownerTier.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 58-71 | owner prompt isolates the single request and escapes every data section | owner request parsed from its section; escaping; cap and reply budget rendered; wording; hand-off marker by tools | **trim** | keep 61-62, 65-66, from 67 only the "30 minutes" and "20 characters" checks, 68-70; drop 63, 64 and the three wording checks on 67 |
| 809-823 | owner callable tools use a compact index and on-demand MCP instructions | compact tool index; on-demand tool named; inline guidance absent; wording | **trim** | keep 816-819, 821; drop 820 |

### `src/lib/externalRelay/ownerAttachment.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 26-130 | every test in the file (8 tests: captioned reply, %s attachment fetched, no fetch, content present, still needs a fetch, other message, get_media, marker data) | fetch instruction present or absent by attachment state | **keep** | branch on attachment state; the expected fetch instruction is built from each case's message id (instruction(ownerId)), appears once, and hostile captions stay escaped data |

### `src/lib/externalRelay/ownerOutboundContext.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 32-42 | unthreaded answer follows full options in the real owner prompt and service rows are deduplicated | local context resolution and rows; order in the prompt; one copy; wording | **trim** | keep 35-40; drop 41 |

### `src/lib/externalRelay/ownerRelayContract.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 12-25 | owner contract carries the ask through a refused relay and explains a concrete owner action | owner prompt wording | **delete-block** | phrases for one fixed input |
| 27-41 | owner run delivers the refusal outcome and queued board destination to the chat | reply relayed to the chat; a wording check inside the launch port | **trim** | keep 40; drop 33 |

### `src/lib/runtime/voicePersonaRole.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 98-103 | the modality spoken persona replaces no part of an existing role | regex absence over MODALITY_VOICE_PERSONA | **delete-block** | phrase absence in a constant (SPOKEN_ROLE_REPLACEMENTS) |
| 105-111 | the modality backing instructions replace no part of an existing role | regex absence over startInstructions | **delete-block** | phrase absence in a fixed text (BACKING_ROLE_REPLACEMENTS) |
| 113-122 | the modality backing instructions say outright that the role and its work stand | wording | **delete-block** | phrases in a fixed text |
| 124-130 | the modality backing instructions tell an incumbent manager not to relay its own work | wording | **delete-block** | phrases in a fixed text |
| 132-138 | the modality spoken persona forbids the spoken model claiming it has no tools | wording | **delete-block** | phrases in a constant |
| 140-149 | both spoken personas keep the spoken-delivery rules the call needs | headings and a rule in both personas | **delete-block** | phrases in constants |
| 155-163 | the coordinator persona still carries the relay mandate it was written for | regex presence over the coordinator texts | **delete-block** | phrases in constants |
| 232-244 | a session persona carries the spoken prompt and the backing pair, and nothing thread-durable | prompt is the selected constant; key set; start/end wording | **trim** | keep 236-237, 241-243; drop 238-240 |
| 246-259 | the end instructions supersede the spoken register the start instructions imposed | wording of start and end instructions | **delete-block** | phrases in fixed texts |
| 261-273 | the spoken persona carries native's own operating rules for a backend it fronts | wording | **delete-block** | phrases in constants |
| 348-369 | the modality instructions add no procedure to a conversation that has its own | regex absence lint; coordinator wording | **delete-block** | phrase presence and absence in fixed texts |

### `src/lib/runtime/voicePersona.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 47-54 | both spoken personas frame the two sources of a turn the same way | "[USER]" and "[BACKEND]" in both personas | **delete-block** | phrases in constants |
| 96-109 | no shipped persona pins a spoken language anywhere | language-name and script lint over shipped texts | **delete-block** | phrase-absence lint over constants |
| 111-130 | appending a hard pin to any language is caught | the test-local languagePins helper | **delete-block** | tests only the lint helper of 96-109; drop LANGUAGE_NAMES, FOREIGN_SCRIPT and languagePins with it |
| 139-145 | a persona rewritten in another script is caught | the test-local languagePins helper | **delete-block** | tests only the lint helper; drop nonLatin with it |
| 147-156 | the name is English too, so the guard carves out no exception for it | PERSONA_NAME value and format; name sentence; lint | **delete-block** | constant pin and phrases; drop the PERSONA_NAME import |
| 158-164 | a name in another script is caught like any other foreign text | the test-local languagePins helper | **delete-block** | tests only the lint helper |
| 166-172 | the persona hands the spoken language to the operator's locale | wording | **delete-block** | phrases in a constant |
| 174-177 | the persona names no person | a name absent from a constant | **delete-block** | phrase absence in authored text; the privacy gate's known-value fingerprints cover names in published files |
| 183-188 | the backing instructions name the directive tool | tool name in a fixed text | **delete-block** | phrase in a fixed text |

### `src/lib/voiceCompanion/liveSession.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 977-986 | the Live backend answers board questions with read tools and the prompt keeps talk-first | nothing sent; instruction wording | **trim** | keep 983; drop 984 |

### `src/lib/voiceCompanion/tools.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 158-167 | asking first is the model's judgment in the schema: an optional reason, and no list of words anywhere in the registry | tool schema fields and enums; description wording | **trim** | keep 160-163, 166; drop 164-165 |
| 257-278 | orchestrator reads expose bounded continuation and every mutating tool has an action policy | strict schemas; action policies; a description phrase | **trim** | keep 260-268, 273-277; drop 270 |

### `src/lib/voiceCompanion/provider.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 134-154 | mint carries Delegatus identity, project, mandate character, registry capabilities and masculine voice | project name, mandate character section and registry capabilities composed in; voice; identity and language wording | **trim** | keep 140-142, 147-149 (project from the input, the mandate's character section and the registry capability list composed in, the voice); drop 139, 143-145 |

### `src/lib/voiceCompanion/ownerHistoryRecording.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 106-144 | API later turns withhold every private source, including a straddling voice segment, and send clean operator words | private content absent from later turns; safe content kept; notice wording | **trim** | keep all but 136-137; drop 136-137 (wording of the withheld notice) |

### `src/lib/orchestrator/handoffDigest.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 532-536 | the delivered mandate retains the gated prototype lane within its existing budget | role-table note wording; byte budget | **trim** | keep 535; drop 534 |

### `src/lib/orchestrator/boardReport.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 135-185 | the §6 example: a finished lane's open pull request, running lanes, close candidates and label-ranked issues | report lines computed from the fixture facts; the fixed read-only header sentence; byte cap | **trim** | keep all but 164; drop 164 (the header's fixed wording) |
| 437-448 | no recorded priority: one neutral line and the newest three, never a suggestion to label | computed GitHub section; ranking headings absent; regex lint against suggestion wording | **trim** | keep 445-446; drop 447 |

### `src/lib/boardMaintenance/text.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 6-13 | brief reads previous card summary, changes, questions and left-alone evidence | previous run's summary, changes, questions and left-alone reasons rendered; fallback for no previous run; one fixed sentence | **trim** | keep 11 without the "Confirm every decision from current state" item, and 12; drop that item |
| 14-21 | production brief preserves Done with mergeOnReview ${on/off} (2 cases) | setting rendered; sentence chosen by the setting; fixed wording list | **trim** | keep 17-19 (the project's setting and the branch it selects); drop 20 |

### `src/lib/boardMaintenance/run.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 57-65 | launch brief reads this project's mergeOnReview setting: ${enabled} (2 cases) | this project's setting reaches the launch brief; a fixed sentence | **trim** | keep 59-63; drop 64 |

### `src/lib/memory/roleSeatRender.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 1-33 | (whole file: seat and maintainer notices, and the stage block byte for byte) | notice wording per reader; an exact golden of the empty stage block | **delete-file** | two tests assert notice phrases; the third pins the whole block's wording with toBe, so every wording edit re-pins it; nothing behavioural remains (see Deferred: the role-keyed notice choice then has no direct test) |

### `src/lib/memory/roleLane.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 119-195 | a review's finding becomes the fixer's abstract rule, a fresh builder starts with it, reviewers stay clean, and the kill switch stops both | lesson flow, scoping, kill switch; block headings and rule text; one request sentence | **trim** | keep all but 146; drop 146 ("before the first review" wording) |

### `src/lib/memory/swarm.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 103-122 | off preserves the exact four-scope block; on inserts the fifth scope after role everywhere | scope order; counts line; swarm section; notice wording | **trim** | keep all but 114; drop 114 ("are public") |
| 323-342 | the curator sees usage even for no-lesson answers and can retire guidance already in the receiving pack | usage counts; read-only swarm rows; left reason; curator-brief wording | **trim** | keep 332-339; drop 340-341 |
| 374-389 | curator swarm instructions and evidence follow consent; off preserves the pre-swarm brief byte for byte | brief unchanged without consent (digest against the brief computed in the test); swarm instructions with consent | **keep** | branch on consent, both sides asserted |

### `src/lib/memory/importLifecycle.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 271-291 | the orchestrator target rises only after its project's completed import records a seat room drop | budget sentence with the computed target appears only for this project after the import; survives an alias | **keep** | behaviour: per-project budget and alias resolution, observed with the computed byte figure |
| 345-354 | a room drop after the trial opened keeps the pre-trial budget | raised-budget sentence absent | **keep** | the other side of 271-291 |

### `src/lib/memory/operatorMemory.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 189-205 | the operator block holds project and machine rules under its own notice and pointer | rules and counts rendered; notice and pointer wording; stage pointer absent | **trim** | keep 193-196, 202-204; drop 197-200 |
| 207-212 | a role-less stage keeps the stage block byte for byte in Delegatus mode | block equals renderLearnedRules(scopes); a wording line | **trim** | keep 210; drop 211 |
| 214-226 | the seat's pointer in %s names the engines' memory as off only in Delegatus mode | sentence chosen by memory-source mode, present in one mode and absent in the other; a tool name | **trim** | keep 219-223 (branch on mode, both sides); drop 225 |

### `src/lib/memory/roleDelivery.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 134-174 | %s receives a seat-written rule on fresh and resumed engine starts from another account | rule delivered on each channel and kept out of the receipt and the builder; seat notice wording | **trim** | keep all but 166-168; drop 166-168 |

### `src/lib/memory/curation/seatRules.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 68-72 | the curator brief names both readers and directs it to the seat's mandate | CURATOR_CHECKLIST wording | **delete-block** | phrases in a constant |

### `src/lib/mcp/leaveLesson.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 36-51 | task identifiers are refused without consuming the request, and a second accepted answer is refused | lesson-request wording; refusals of task-shaped lessons; limit | **trim** | keep 38, 43-50; drop 39-42 |
| 168-188 | a fix request quotes finding classes and asks for the rule needed before the first review | findings quoted by severity, first sentence only; shared scope lines composed in; request wording and option order | **trim** | keep 176-181, 186, 187; drop 182-185 (keep the `prompt` variable only if 186 needs it; it does not) |
| 231-246 | a concrete problem answer is retained for the seat and never stored as a rule | answer retained as a problem; nothing stored; an option label in the request | **trim** | keep 236-245; drop 235 |

### `src/lib/memory/curation/curation.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 760-773 | the v1 row kinds and optional metadata survive an apply, and clean curator has no injected rules | row kinds survive apply; curator role clean; checklist names every outcome kind | **trim** | keep 769-771; drop 772 (enum-to-prose drift check) |

### `src/lib/mcp/answerSizes.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 53-245 | measure every tool through the MCP service and budget common board answers | answer byte budgets, paging, projections; two description phrases | **trim** | keep all but 235-236; drop 235-236 |

### `src/lib/mcp/autoUpdates.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 557-566 | the registered description says what enabling does | tool description wording | **delete-block** | phrases in a tool description |

### `src/lib/mcp/issueReport.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 291-302 | the form is asked in the operator's language, and its English twin approves as well | approval form; publication; a next-step phrase | **trim** | keep 295-296, 300-301; drop 297 |
| 429-450 | show guidance and the published tool description send the approval through a decision form | next-step guidance and tool description wording | **delete-block** | phrases in an answer's fixed guidance and a tool description |
| 647-659 | the reporter's hint tool returns class and matched span without storage | hint class, span, no storage; a guidance phrase | **trim** | keep 651-657; drop 658 |
| 661-691 | a %s hint never blocks preview, storage or approved publication | hints never block; preview content; approval gate; a guidance phrase | **trim** | keep all but 679; drop 679 |

### `src/lib/mcp/pageCursors.integration.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 71-87 | registered tools describe short expiring handles and carry them unchanged over MCP | description wording; cursor length over MCP | **trim** | keep 85; drop 82-83 |

### `src/lib/mcp/reportTools.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 78-84 | the session instructions name the interface language once a client reported it, and say nothing before | language line only with a reported locale; opening wording | **trim** | keep 79, 80, 82 (branch on the reported locale, the locale's language named); drop 83 |
| 86-92 | MCP accepts prompt-only launches and makes refinement optional for already named launches | schema admits a prompt-only launch; instructions wording | **trim** | keep 87; drop 89-91 |

### `src/lib/mcp/retirementStatus.integration.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 139-149 | served schema teaches automatic launch identity and bounded pagination | schema properties and optionality; description wording | **trim** | keep 144, 147; drop 145-146 |

### `src/lib/mcp/retryStageLaunch.integration.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 221-242 | retry-stage on a stage whose attempt never launched is fenced the same way | fenced request; a property description phrase | **trim** | keep 231-234; drop 238 |

### `src/lib/mcp/server.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 2044-2070 | create_task and update_task tell a writer which hold kind a worker slot wait takes and pass both kinds through | description wording; both hold kinds forwarded | **trim** | keep 2065; drop 2057-2061 |
| 2133-2151 | seat_tick_settings publishes the panel instruction contract through tools/list | description wording; published reason schema equals the source schema; parse | **trim** | keep 2144, 2148-2149; drop 2141-2143, 2147 |
| 3273-3289 | prototype publication tells callers about the critic gate and fresh refusal retries | tool description wording | **delete-block** | phrases in a tool description |

### `src/lib/mcp/spawnDeployer.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 68-89 | spawn_agent advertises the deployer's top-level confirmation and its caller restriction | confirm field in the schema; dispatch; description wording | **trim** | keep 69, 77, 82-84; drop 78-80 |

### `src/lib/mcp/stdio.integration.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 442-476 | the packaged stdio host publishes and invokes the expanded read surface | tool list, schema keys, optionality, replay; description wording | **trim** | keep all but 453-454; drop 453-454 |

### `src/lib/mcp/taskBoardVisibility.integration.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 63-98 | update_task publishes board membership, and every published value lands in the task file | board enum; stored values; a description phrase | **trim** | keep all but 75; drop 75 |

### `src/lib/mcp/taskColor.integration.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 111-123 | create_task carries the rendered colour and icon rule, and both task tools tell agents to set icon and color | renderTaskColorRule() and TASK_COLORS composed into descriptions; wording | **trim** | keep 117, 121 (composed from the rule module and TASK_COLORS, server.ts:4137); drop 118-119 |

### `src/lib/mcp/taskColorGroupHide.integration.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 77-110 | update_task publishes the colour names and the hide, and both land in the task file | enum and type; stored values; a description phrase | **trim** | keep all but 85; drop 85 |

### `src/lib/mcp/taskDetails.integration.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 136-155 | the tools publish details as its own field, and say the text is the human's | details property exists; description wording | **trim** | keep 143; drop 144-151 |

### `src/lib/mcp/taskFinding.integration.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 34-81 | published finding schemas, recurrence, receipts and key updates through MCP | finding behaviour; description phrases | **trim** | keep all but 48-49; drop 48-49 |

### `src/lib/mcp/taskLineEdits.integration.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 197-208 | update_task publishes the line edits | properties exist; a description phrase | **trim** | keep 203; drop 204 |

### `src/lib/mcp/taskPriority.integration.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 134-146 | both task tools say when to use each level, and list_tasks names the filter | renderTaskPriorityRule() and TASK_PRIORITIES composed; enum; a list_tasks phrase | **trim** | keep 139-143 (composed from the rule module and TASK_PRIORITIES, server.ts:4139); drop 144 |

### `src/lib/monitor/report.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 24-60 | a wake says why, lists the items, and names the mandate section holding its contract (#2030) | header, reasons, items and deferred count from the agenda; retired wording absent; contract pointer composed | **trim** | keep all but 41; drop 41 |
| 74-92 | the skipped-child summary describes the children, not an outcome they may not have (#1783) | summary lines with the computed counts; retired wording absent | **trim** | keep 87-89; drop 90-91 |
| 94-107 | the proposal brief asks for one ranked card and forbids opening issues or lanes from it | issue data and card ref rendered; brief wording | **trim** | keep 102, 105; drop 103-104, 106 |
| 183-197 | a wake carries the project's own monitor prompt beside what the tick derived, above an untouched contract | monitor note, reasons and items rendered; order; retired wording absent | **trim** | keep all but 192; drop 192 |

### `src/lib/monitor/turbo.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 244-261 | the wake overlay: full text on a new revision, a pointer after, nothing once ended; names the credit approval | overlay state, accounts and limits rendered; size bounds; a field-name instruction | **trim** | keep all but 252; drop 252 |
| 263-277 | the seat notices: one on, one off, each with a stable idempotency key and no operator text | keys; state and count rendered; pointer wording | **trim** | keep 267-269, 274-275; drop 270, 276 |

### `src/lib/monitor/autonomy.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 127-144 | every active wake carries the overlay; off and expiry carry none | overlay present while active, absent after; size bounds; overlay wording | **trim** | keep 132, 135-143; drop 133-134 |
| 171-176 | release publish always rechecks current autonomy and retains every release gate | release publish stage prompt wording (release/stages.ts) | **delete-block** | phrases in a stage prompt |

### `src/lib/monitor/seatTick.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 230-245 | overdue board tasks > priority then overdue age; seven overdue name five and defer two, with facts and seat policy | order, deferred count, item labels; policy wording in the reason | **trim** | keep all but 239-241; drop 239-241 |
| 2428-2435 | waits routed to the seat > an ask wakes the seat on the next check, without waiting for the interval, and names the question and the way to answer | reason and item; a tool-call phrase in the reason detail | **trim** | keep 2430, 2433; drop 2434 |

### `src/lib/monitor/seatTickController.reporting.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 530-566 | a read and acted-on child is described by delivered-wake acknowledgement (#2346) | acknowledgement state machine; reason wording old and new | **trim** | keep all but 560-562; drop 560-562 |

### `src/lib/monitor/seatTickReports.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 126-152 | a full owed-outcome ledger stays within the wake bound and names the key that settles it | bound; settling key rendered; autonomy overlay marker; a contract clause | **trim** | keep all but 141 and 151; drop 141, 151 |

### `src/lib/monitor/workerLimitWake.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 4-13 | current worker guidance survives a truncated wake | limit, source and running count rendered; truncation; one fixed sentence | **trim** | keep 7-8, 10-12; drop 9 |

### `src/lib/attention/seatAgenda.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 41-53 | a routed lane names the stage's own question, the decision answer path and the form to escalate through | key and id; the stage's question; answer-path and escalation wording | **trim** | keep 49-50; drop 51-52 |
| 63-83 | each stopped merge's class gets its own step, and the line names the class first | class label first; retry-merge offered only for retryable classes, a dismiss step with the lane id for the others | **keep** | branch on the stop class, both sides asserted (78 against 80-82) |
| 85-95 | a parked lane's line names its stop class before the stage's words | class label and stage words in order; the class's step wording | **trim** | keep 93; drop 94 |

### `src/lib/runtime/codexAppServerHost.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 1365-1413 | CodexAppServerHost > a thread already carrying a coordinator persona row still gets the modality correction | modality variant chosen; persona not the coordinator's; nothing injected; persona wording | **trim** | keep all but 1400 and 1403; drop 1400, 1403 |

### `src/lib/agent/operatorQuestionPolicy.native.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 8-91 | native Codex denies async seat questions and preserves worker questions | the real hook denies the seat's async question and lets a worker's through; denial wording | **trim** | keep 65-72, 80-81; drop 74-78 |

### `src/lib/runtime/releaseInterruption.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 1225-1249 | a spawned agent whose turn a service restart cut is resumed once, and a second restart sends nothing more | one continuation; restart notice header; the cut event; an instruction sentence | **trim** | keep all but 1238; drop 1238 |

### `src/lib/runtime/startup.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 2551-2620 | the surviving restart nudge names the turn that was severed | notice header; event kind and time from the cut; instruction wording; retired wording absent | **trim** | keep 2606, 2608, 2609; drop 2610, 2613-2614 |

### `src/lib/runtime/interruptionObligations.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 88-95 | the continuation names the deployment and the way back to a stage verdict | deployment notice header; event and time; instruction wording | **trim** | keep 91-92; drop 93-94 |

### `src/lib/roles/workerLimit.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 11-18 | retired maxWorkers is ignored and no shipped scaffold names a worker number | maxWorkers ignored; scaffold lint; worker sentence | **trim** | keep all but 16-17; drop 16-17 |
| 19-22 | the mandate names the live limit and delivery repairs an older mandate | mandate wording; delivery removes the older sentence | **trim** | keep 21; drop 20 |

### `src/lib/prototypeReview/decision.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 21-29 | rejection asks for a new round with corrections and no chosen variant | corrections rendered, no chosen section; rejection wording; amended marker | **trim** | keep 26-27; drop 25 |

### `src/lib/prototypeReview/decision.integration.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 237-308 | owner %s replies survive decision normalization, reload and production delivery | answers normalised, reloaded and delivered; owner notes; one instruction sentence | **trim** | keep all but 299; drop 299 |

### `src/lib/agent/spawnAdmission.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 216-227 | rejection guidance is actionable and names the escalation paths | role label and computed depth rendered; guidance wording; endpoint and product-name lint | **trim** | keep 218, 220; drop 217, 219, 221, 223-226 |

### `src/lib/forge/autoRefresh.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 309-325 | a semantic conflict names its hunk on the successor and keeps the PR open | successor stages and states; the conflict instruction from the input; a review-command phrase | **trim** | keep all but 317; drop 317 |
| 646-684 | strict protection refreshes the next PR locally and waits for checks on its new head | local refresh, merge order, checks wait; refresh-prompt wording | **trim** | keep all but 664-665; drop 664-665 |

### `src/lib/links/seatMessages.http.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 96-116 | linked seats exchange attributed messages in both directions with one durable delivery per retry | delivery, text, structured agent origin; relay framing sentence | **trim** | keep all but 108; drop 108 (the structured origin at 109-110 is the authority check) |

### `src/lib/pipelines/engine.creation.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 280-299 | read-only stages preserve declared outputs and tell the agent their write boundary | outputs stored; output path in the prompt; an instruction phrase | **trim** | keep 294, 297; drop 298 |

### `src/lib/pipelines/legacyReviewDefinition.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 107-139 | the fixer takes its implementer's domain and size, and the row decides its runtime | fixer role, runtime, account; prompt template opening | **trim** | keep all but 120; drop 120 |

### `src/lib/release/stages.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 5-17 | release template validates; capture and one-round visual and code reviews precede publishing | stage graph, fail edges, roles; publish-stage wording | **trim** | keep 7-11, 13, 16; drop 12, 14-15 |
| 18-26 | each release reads current autonomy and asks when the effective approval gate is on | publish-stage wording; the approval reason from the input | **trim** | keep 25; drop 19-24 (the loop asserts only wording) |

### `scripts/first-message-design.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 1-32 | (whole file: the first-message as-built record covers the durable seat hand-over) | mechanism names in a design doc section; named evidence files exist | **delete-file** | asserts that docs/design/first-bubble-no-raw-json.md names given mechanisms; the file-existence line only supports that doc claim |

### `scripts/setup-whisper.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 114-118 | transcription documentation states the recording cap | docs/transcription.md states the cap computed from CAP_SECONDS; old wording absent | **delete-block** | a doc sentence checked against a constant: a wording-drift check |

### `src/app/typingLatencyEvidence.test.ts`

| Lines | Test | What it asserts | Verdict | Why; for trim, the lines to keep and drop |
|---|---|---|---|---|
| 37-49 | the record names its revisions, fixture fingerprints and procedure | evidence record fields; headings of procedure.md | **trim** | keep 38-44, 47-48; drop 45-46 |

## Files read whose string checks stay

Every test in these files was read. Their string assertions observe behaviour
(data in rendered text, the branch the code took, refusal and journal text) or
check no agent-facing wording. No row is needed.

| File | Why its string checks stay |
|---|---|
| `src/lib/monitor/seatTickController.delivery.test.ts` | wake state machine; string checks read journal and card details (outcome text) and ids |
| `src/lib/monitor/seatTickController.agenda.test.ts` | wake composition from agenda data, monitor note and operator instructions; markers show which branch rendered |
| `src/lib/monitor/seatTickController.policy.test.ts` | policy and fences; journal and notice details; full against compact autonomy overlay compared in one block |
| `src/lib/monitor/seatTickController.test.ts` | wake items and reasons rendered from lanes, deploys and reports |
| `src/lib/monitor/seatTickController.catchUp.test.ts` | backlog window and timestamps rendered from data |
| `src/lib/monitor/seatTickSources.test.ts` | source gathering; note length and record reasons |
| `src/lib/monitor/seatTickFence.test.ts` | fence sentence with key and times |
| `src/lib/monitor/journalStore.test.ts` | journal records |
| `src/lib/monitor/seatAuthIncident.test.ts` | no agent-facing phrase assertion |
| `src/lib/monitor/seatAutoRotation.test.ts` | no agent-facing phrase assertion |
| `src/lib/monitor/ruleReports.test.ts` | report titles and links from data |
| `src/lib/monitor/cards.test.ts` | board cards: redaction of operator words and secrets; bilingual card copy is listed with UI copy |
| `src/lib/orchestrator/seatCommand.test.ts` | designation, rotation and handoff composition, budgets, refusals |
| `src/lib/orchestrator/rotationSettlement.test.ts` | rollback reasons and the handover naming the right predecessor |
| `src/lib/orchestrator/ownerRelay.test.ts` | owner replies (human-facing) and refusal codes |
| `src/lib/orchestrator/boardReportRun.test.ts` | delivery key and policy; report header with data |
| `src/lib/orchestrator/operatorDecisionForms.test.ts` | no agent-facing phrase assertion |
| `src/lib/orchestrator/seatChannel.test.ts` | no agent-facing phrase assertion |
| `src/lib/orchestrator/deputyCommand.test.ts` | no agent-facing phrase assertion |
| `src/lib/telegram/reportRunner.test.ts` | launch grants, privacy of account and dialog names, edited brief placed after the fixed preamble |
| `src/lib/runtime/voicePersonaMandate.test.ts` | persona variant resolution only |
| `src/lib/agent/cli.test.ts` | launch argv and config flags |
| `src/lib/agent/codexSpawnPolicy.test.ts` | launch argv |
| `src/lib/agent/ephemeral.test.ts` | launch argv |
| `src/lib/agent/codexFeatureFixture.test.ts` | feature inventory and argv |
| `src/lib/flows/exec.test.ts` | headless argv; the spawn-policy section composed into stdin |
| `src/lib/tmux.test.ts` | argv delivered through tmux |
| `src/lib/roles/sizing.test.ts` | refusal messages |
| `src/lib/pipelines/stageSizing.test.ts` | refusal messages |
| `src/lib/pipelines/stageCommitRepair.test.ts` | park reasons and git calls (the defaults.ts matches were "git commit") |
| `src/lib/prototypeReview/http.test.ts` | refusals and amended marker |
| `src/lib/prototypeReview/seatDecisions.test.ts` | decision state and owner notes relayed |
| `src/runtime-host/mcpRuntimeCompatibility.test.ts` | tool list and refusal |
| `src/runtime-host/hostBootstrap.test.ts` | operator-facing bootstrap plan text, listed with other human-facing text |
| `src/lib/voiceCompanion/callMemory.test.ts` | redaction and ordering |
| `src/lib/voiceCompanion/codexConversation.test.ts` | spoken output to the operator, order and bounds |
| `src/lib/voiceCompanion/delegationOutcome.test.ts` | spoken output bounds |
| `src/lib/voiceCompanion/codexProvider.test.ts` | read ledger reuse |
| `src/lib/externalRelay/ownerOutput.test.ts` | redaction |
| `src/lib/memory/roleEgress.test.ts` | lesson text withheld at every egress |
| `src/lib/memory/curation/reviewLessons.test.ts` | no agent-facing phrase assertion |
| `src/lib/memory/roleLaunch.test.ts` | no agent-facing phrase assertion |
| `src/lib/memory/injection.test.ts` | no agent-facing phrase assertion |
| `src/lib/memory/context.test.ts` | no agent-facing phrase assertion |
| `src/lib/pipelines/engine.settlement.test.ts` | relayed findings and outputs between stages |
| `src/lib/pipelines/engine.routing.test.ts` | continuation chosen by cause (restart, silence, lost host), present and absent compared |
| `src/lib/pipelines/engine.succession.test.ts` | continuation keeps uncommitted work |
| `src/lib/pipelines/engine.succession.part2.test.ts` | continuation keeps uncommitted work |
| `src/lib/pipelines/legacyReviewConversion.test.ts` | review budget and unreviewed relay |
| `src/lib/pipelines/resolveDecision.test.ts` | question and answer relayed into the next prompt |
| `src/lib/pipelines/engine.rolePrivacy.test.ts` | learned rules redacted in delivered prompts |
| `src/lib/mcp/bindings.test.ts` | refusals, hints and fence details carrying data |
| `src/lib/mcp/controlPlaneReads.test.ts` | partial-read hints by cause |
| `src/lib/mcp/crossProject.test.ts` | schema key and refusal pointer |
| `src/lib/mcp/largeReads.test.ts` | refusal codes |
| `src/lib/mcp/http.test.ts` | HTTP and stdio publish the same tools |
| `src/lib/mcp/orchestratorTools.test.ts` | delivery key |
| `src/lib/mcp/bridgeReportShape.test.ts` | refusal of oversized reports |
| `src/lib/mcp/bridgeReportOrigin.test.ts` | warnings |
| `src/lib/mcp/compactAnswers.test.ts` | delivery note by delivery mode |
| `src/lib/mcp/deployAuthority.test.ts` | refusal |
| `src/lib/mcp/projectResolution.test.ts` | refusal absent after resolution |
| `src/lib/mcp/receiptsStartup.test.ts` | cold refusal body |
| `src/lib/mcp/agentFleet.binding.test.ts` | scope refusal |
| `src/lib/mcp/autonomy.test.ts` | decision attribution |
| `src/lib/mcp/voiceTools.test.ts` | operator-only refusal |
| `src/lib/mcp/spawnRecovery.integration.test.ts` | refusal |
| `src/lib/voiceTools/contracts.test.ts` | description byte bound (size budget) |
| `src/lib/runtime/deliveryWake.test.ts` | no agent-facing phrase assertion |
| `src/lib/bridge/directive.test.ts` | no agent-facing phrase assertion |
| `src/lib/reviewHistory/reader.test.ts` | no agent-facing phrase assertion |
| `src/lib/boardMaintenance/wake.test.ts` | no agent-facing phrase assertion |
| `scripts/bun-runtime-workflow.test.ts` | parses the installed CLI pin out of a design doc and compares it with the CI matrix (a parse of a declared value) |

## Notes for the removal lane

### Rebase first, then find each row by its title

Line numbers refer to `3736d5e4`. After rebasing, locate each row by its test
title and apply the same rules to what moved. These open pull requests touch
files in the table, counted on 2026-10-24 from `gh pr diff`:

| Pull request | Files in the table | String assertions it changes |
|---|---|---|
| #3291 | `src/lib/voiceCompanion/sessionConfig.test.ts` | adds 13 in two new tests, all phrase checks on the rendered voice prompts. The seat runs a separate lane for them; if #3291 lands first with them, delete both tests. |
| #3314 | `src/lib/orchestrator/prompt.test.ts`, `src/lib/forge/autoRefresh.test.ts` | adds 13 and removes 5 in `prompt.test.ts`: mandate wording for v59 (a version test whose tail of phrase lines matches 87-180 here), and a v58 upgrade test that is delivery behaviour apart from its phrase lines. |
| #3200 | `src/lib/pipelines/prompts.test.ts`, `src/lib/pipelines/roles.test.ts`, `src/lib/roles/registry.test.ts`, `src/lib/orchestrator/prompt.test.ts`, `src/lib/orchestrator/handoffDigest.test.ts`, `src/lib/memory/roleSeatRender.test.ts`, `src/lib/memory/swarm.test.ts`, `src/lib/memory/roleLane.test.ts`, `src/lib/mcp/leaveLesson.test.ts` | adds 16, mostly wording of the operator-correction duty; it also adds a test of the kind this audit deletes to `roleSeatRender.test.ts` |
| #2926 | `src/lib/pipelines/prompts.test.ts`, `src/lib/pipelines/testGuidance.test.ts` | removes the four "missing" case lines that the trim of `prompts.test.ts:41-82` keeps in part, and one of the fallback markers kept in `testGuidance.test.ts:9-37` |
| #3298 | `src/lib/orchestrator/prompt.test.ts`, `src/lib/externalRelay/ownerTier.test.ts` | rewords the phrase in `prompt.test.ts:1016-1018`; the test still goes |
| #3310, #3263, #3321, #3269, #3308 | `autoRefresh`, `engine.creation`, `boardMaintenance/run`, `taskFinding`, `releaseInterruption` tests | add branch names, refusal reasons, a schema field and a notice header: behaviour, nothing to remove |

Other open pull requests touch further files in the table without changing
their string assertions: #3207, #3231, #3236, #3260, #3284, #3301, #3302.

### Left unused after the removal

The linter reports most of these. Known ones:

- `src/lib/orchestrator/prompt.test.ts`: the `STACK_SPECIFIC` constant (915);
  the imports `FOCUS_TARGET_KINDS`, `BRIDGE_REPORT_CLASSES`, `renderTaskColorRule`,
  `TASK_COLOR_RULE` and `PROCESS_CLEANUP_MARKER`. `WORKING_RULES` stays (1243).
- `src/lib/pipelines/prompts.test.ts`: `STACK_SPECIFIC` (343); the imports
  `ROLE_DEFAULTS`, `renderDecisionInput` and `refreshRequest`.
- `src/lib/roles/registry.test.ts`: `BLOCKED_FIX_ROUND`, `repository`,
  `STACK_SPECIFIC`, `PROJECT_SPECIFIC`; the `fs`, `path` and
  `defaultRoleParameterValue` imports; the imports `EARLIER_ANSWERS_MECHANICS`,
  `ISSUE_REPORT_SCRUB_RULE`, `PROCESS_CLEANUP_MARKER`, `VISUAL_CRITIC_CLASSES`
  and `VISUAL_CRITIC_UNFRAMED`.
- `src/lib/runtime/voicePersonaRole.test.ts`: `SPOKEN_ROLE_REPLACEMENTS`,
  `BACKING_ROLE_REPLACEMENTS`.
- `src/lib/runtime/voicePersona.test.ts`: `LANGUAGE_NAMES`, `FOREIGN_SCRIPT`,
  `languagePins` and `nonLatin`; the `PERSONA_NAME` and `MODALITY_VOICE_PERSONA`
  imports.
- `src/lib/voiceCompanion/sessionConfig.test.ts`: the `readFileSync` import.
- `src/lib/pipelines/stageInput.test.ts`: `originalGuidance`, the `crypto`
  import, and the `hash` field of the cases.
- `PROTOTYPE_PUBLICATION_RULE` (`src/lib/roles/defaults.ts:188`) has no
  production reader; only `src/lib/roles/defaults.test.ts` imports it. Delete
  the constant with that file.
- Production exports that only these tests imported. Each stays in use inside
  its own module, so only the `export` goes:
  - `src/lib/roles/defaults.ts`: `PROCESS_CLEANUP_MARKER`,
    `VISUAL_CRITIC_CLASSES`, `VISUAL_CRITIC_UNFRAMED`, `ISSUE_REPORT_SCRUB_RULE`;
  - `src/lib/runtime/voicePersona.ts`: `PERSONA_NAME`;
  - `src/lib/memory/curation/brief.ts`: `CURATOR_CHECKLIST`.

  The comment above `PROCESS_CLEANUP_MARKER` (`src/lib/roles/defaults.ts:35-36`)
  says that the tests pin it, which stops being true; drop that sentence.
- Fixtures: none. The mandate fixtures v54 to v57 and
  `fixtures/legacy-prompt-hashes.json` are still read by kept tests.

### Checks the lane runs

- Typecheck.
- ESLint on the touched files.
- Every touched test file that remains, run by path. Each run gets its own
  HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, and LLV_VIEWER_CONTROL_URL
  points at a closed port.
- The privacy gate.

Run heavy checks one at a time through the gate wrapper. A trimmed test must
still contain an `expect` call, because Bun passes an empty test without saying
so. After the removal, run the inventory method above again over the touched
files. Every string assertion that remains should be one the table keeps.

## Proposed AGENTS.md section

The pinned task asks for the practice in `AGENTS.md`. Proposed as a new
top-level section before "Rendered evidence: call the driver that exists, do not
write a new one". The wording is new. The publication gate fingerprints the text
of stored learned rules, so a line copied from one is refused at push.

```markdown
# Agent-facing text gets no wording tests

Stage prompts, the seat mandate, role scaffolds, MCP tool and field
descriptions, server instructions, voice and relay prompts, wake texts,
learned-rule notices, skills and the docs agents read are rewritten often. A
test that looks in such text for a sentence, a word or its absence shows only
that the wording is still there, and it breaks on every rewording. Write none,
and add no test to a change that only edits such text.

When code builds or chooses that text, test what the code does: values taken
from its inputs, the block a branch selects (present for one input and absent
for another, in one test), order and placement, idempotent delivery and upgrade
of stored text, byte budgets and truncation, redaction, parsers and schema
shape. Hash pins stay where a mechanism needs the exact bytes: the mandate
fingerprint that forces a version bump, and the relay's switch-off pins.
`docs/audits/prompt-string-tests.md` records the removal and its rules.
Interface copy and translations are outside this rule.
```

## UI copy and i18n string tests: out of scope, for a later decision

This is a mechanical inventory and gives no verdicts. It lists the files under
`src/components`, `src/hooks`, the `src/app` pages, `landing` and
`src/lib/i18n` that have at least one string-only test, meaning a test whose
every assertion is a string match. In total: 169 files, 521 string-only tests
and 3,708 string assertions. Some entries are parsers or secret scans and test
behaviour, for example `src/components/feed/parse.test.ts`,
`src/components/feed/messageProvenance.parse.test.tsx` and
`src/app/servedPayloadSecrets.test.ts`.

Human-facing text outside those folders is out of scope for the same reason,
and stays:

- the bilingual board cards in `src/lib/monitor/cards.test.ts`,
  `src/lib/boardMaintenance/text.test.ts:27-43` and
  `src/lib/boardMaintenance/run.test.ts:66-71`;
- the operator's bootstrap plan in `src/runtime-host/hostBootstrap.test.ts`;
- launcher output in `bin/cli.exposure.integration.test.ts`;
- owner replies in the relay tests.

| File | String-only blocks | String assertions |
|---|---:|---:|
| `src/components/AccountsPanel.render.test.tsx` | 25 | 140 |
| `src/components/feed/cards/toolCards.render.test.tsx` | 23 | 80 |
| `src/components/runtime/runtimeComponents.render.test.tsx` | 16 | 55 |
| `src/components/pipelines/PipelineStrip.render.test.tsx` | 15 | 71 |
| `src/components/selfUpdate/SelfUpdateView.dom.test.tsx` | 15 | 133 |
| `src/components/TelegramReports.render.test.tsx` | 15 | 55 |
| `src/components/feed/messageProvenance.parse.test.tsx` | 14 | 90 |
| `src/components/TelegramConnect.render.test.tsx` | 12 | 51 |
| `src/components/scheme/GroupsLayer.render.test.tsx` | 11 | 50 |
| `src/components/AgentControlStrip.dom.test.tsx` | 10 | 30 |
| `src/components/feed/parse.test.ts` | 10 | 100 |
| `src/components/pipelines/VerdictPopover.render.test.tsx` | 10 | 22 |
| `src/components/TelegramBot.render.test.tsx` | 9 | 56 |
| `src/lib/i18n/i18n.test.ts` | 8 | 47 |
| `src/components/DraftLaunchStatus.render.test.tsx` | 7 | 22 |
| `src/components/kanban/compactMenu.test.tsx` | 7 | 24 |
| `src/components/resources/AttachControls.render.test.tsx` | 7 | 28 |
| `src/components/roleMemory/LearnedRules.render.test.tsx` | 7 | 21 |
| `src/components/AccountsPanel.dom.test.tsx` | 6 | 78 |
| `src/components/AttachTerminalDialog.dom.test.tsx` | 6 | 19 |
| `src/components/conversation/LaunchChips.render.test.tsx` | 6 | 29 |
| `src/components/MigrationRibbon.render.test.tsx` | 6 | 14 |
| `landing/site/copy.test.ts` | 5 | 38 |
| `src/app/servedPayloadSecrets.test.ts` | 5 | 10 |
| `src/components/feed/cards/WakeupCard.render.test.tsx` | 5 | 22 |
| `src/components/feed/selectedContext.parse.test.tsx` | 5 | 21 |
| `src/components/runtime/DeadHostBanner.dom.test.tsx` | 5 | 20 |
| `src/components/scheme/GroupOverridePanel.render.test.tsx` | 5 | 36 |
| `src/components/SelectedContextBadge.render.test.tsx` | 5 | 12 |
| `src/components/session/SessionTitle.dom.test.tsx` | 5 | 23 |
| `landing/worker.test.ts` | 4 | 38 |
| `src/components/AccountBadge.render.test.tsx` | 4 | 7 |
| `src/components/cardAnatomy.render.test.tsx` | 4 | 13 |
| `src/components/CardStatusBadge.render.test.tsx` | 4 | 18 |
| `src/components/feed/FeedItem.actions.render.test.tsx` | 4 | 11 |
| `src/components/feed/MandateCard.dom.test.tsx` | 4 | 25 |
| `src/components/LimitsFooter.dom.test.tsx` | 4 | 55 |
| `src/components/ResourcesFooter.dom.test.tsx` | 4 | 44 |
| `src/app/attentionMotion.test.ts` | 3 | 13 |
| `src/components/BranchPane.spawn.render.test.tsx` | 3 | 17 |
| `src/components/BranchPane.stageTitle.render.test.tsx` | 3 | 8 |
| `src/components/conversation/DeputyBlock.dom.test.tsx` | 3 | 32 |
| `src/components/conversation/OutboxBubbles.delivery.dom.test.tsx` | 3 | 18 |
| `src/components/EngineAccountSwitch.test.tsx` | 3 | 10 |
| `src/components/feed/diff.test.ts` | 3 | 4 |
| `src/components/feed/SpeakButton.dom.test.tsx` | 3 | 81 |
| `src/components/feed/tools.test.ts` | 3 | 30 |
| `src/components/OverviewBoard.catalog.render.test.tsx` | 3 | 15 |
| `src/components/pipelines/stageCardAria.render.test.tsx` | 3 | 18 |
| `src/components/prototypeReview/PrototypeReview.dom.test.tsx` | 3 | 40 |
| `src/components/runtime/DeadHostBanner.copy.dom.test.tsx` | 3 | 7 |
| `src/components/scheme/AgentLinksLayer.render.test.tsx` | 3 | 5 |
| `src/components/scheme/nodes.anatomy.render.test.tsx` | 3 | 7 |
| `src/components/scheme/workerCollapse.test.ts` | 3 | 6 |
| `src/components/skeletons.dom.test.tsx` | 3 | 19 |
| `src/components/TmuxComposer.migrationHold.dom.test.tsx` | 3 | 10 |
| `src/components/Viewer.attentionMount.test.ts` | 3 | 10 |
| `src/components/voiceCompanion/CompanionTranscript.dom.test.tsx` | 3 | 65 |
| `src/components/AccountsPanel.mobile.dom.test.tsx` | 2 | 42 |
| `src/components/activity/ActivityDashboard.dom.test.tsx` | 2 | 48 |
| `src/components/BootShell.dom.test.tsx` | 2 | 15 |
| `src/components/ComposerBar.dom.test.tsx` | 2 | 22 |
| `src/components/conversation/liveTurnToolRows.dom.test.tsx` | 2 | 38 |
| `src/components/DraftAgentPane.receiptAttach.dom.test.tsx` | 2 | 7 |
| `src/components/DraftLaunchStatus.structured.render.test.tsx` | 2 | 16 |
| `src/components/feed/cards/readableTool.dom.test.tsx` | 2 | 24 |
| `src/components/feed/cards/toolRowParity.dom.test.tsx` | 2 | 26 |
| `src/components/feed/codexReadable.parse.test.ts` | 2 | 13 |
| `src/components/feed/FeedItem.mobile.dom.test.tsx` | 2 | 52 |
| `src/components/feed/markdown.test.tsx` | 2 | 9 |
| `src/components/LimitsFooter.test.ts` | 2 | 5 |
| `src/components/mobile/MobileChromeSheets.dom.test.tsx` | 2 | 11 |
| `src/components/NativeQueuePanel.dom.test.tsx` | 2 | 32 |
| `src/components/onboarding/CheckStep.dom.test.tsx` | 2 | 22 |
| `src/components/OverviewBoard.firstRun.dom.test.tsx` | 2 | 16 |
| `src/components/PlanChip.render.test.tsx` | 2 | 6 |
| `src/components/ProjectDashboard.empty.dom.test.tsx` | 2 | 13 |
| `src/components/projectModel.test.ts` | 2 | 16 |
| `src/components/runtime/SupersededBanner.dom.test.tsx` | 2 | 12 |
| `src/components/search/GlobalSearch.dom.test.tsx` | 2 | 32 |
| `src/components/SwitchCard.anatomy.render.test.tsx` | 2 | 15 |
| `src/components/SwitchCard.attention.render.test.tsx` | 2 | 9 |
| `src/components/SwitchCard.status.render.test.tsx` | 2 | 13 |
| `src/components/TaskHeader.killConfirm.dom.test.tsx` | 2 | 10 |
| `src/components/TmuxComposer.injectReceipts.dom.test.tsx` | 2 | 4 |
| `src/components/Viewer.test.ts` | 2 | 6 |
| `src/components/voiceCompanion/voiceCompanionProduct.dom.test.tsx` | 2 | 47 |
| `src/components/WakeupChip.render.test.tsx` | 2 | 9 |
| `src/hooks/useBridgeReportRelay.dom.test.tsx` | 2 | 9 |
| `src/hooks/useFiles.dom.test.tsx` | 2 | 20 |
| `src/lib/i18n/spawnCopy.test.ts` | 2 | 3 |
| `src/components/AccountBadge.dom.test.tsx` | 1 | 11 |
| `src/components/AsksYouRow.dom.test.tsx` | 1 | 4 |
| `src/components/attention/arrivalPulse.dom.test.tsx` | 1 | 6 |
| `src/components/attention/decision.test.ts` | 1 | 2 |
| `src/components/attention/prototypeDeliveryResolution.test.tsx` | 1 | 8 |
| `src/components/BoardSearchEntry.dom.test.tsx` | 1 | 3 |
| `src/components/BranchPane.lineage.render.test.tsx` | 1 | 2 |
| `src/components/BranchPane.render.test.tsx` | 1 | 3 |
| `src/components/BranchPane.superseded.render.test.tsx` | 1 | 7 |
| `src/components/brand/roleCostumes.test.ts` | 1 | 15 |
| `src/components/cardStatus.activity.test.ts` | 1 | 8 |
| `src/components/ComposerBar.mobileUnit.dom.test.tsx` | 1 | 15 |
| `src/components/conversation/liveTurnOverlayBound.dom.test.tsx` | 1 | 5 |
| `src/components/DraftAgentPane.dom.test.tsx` | 1 | 31 |
| `src/components/DraftAgentPane.render.test.tsx` | 1 | 8 |
| `src/components/EffortPills.slot.dom.test.tsx` | 1 | 15 |
| `src/components/externalRelay/RelayChats.dom.test.tsx` | 1 | 9 |
| `src/components/feed/cards/CmdGroupCard.mobile.dom.test.tsx` | 1 | 37 |
| `src/components/feed/cards/toolLifecycle.dom.test.tsx` | 1 | 14 |
| `src/components/feed/cards/WakeupCard.dom.test.tsx` | 1 | 5 |
| `src/components/feed/contextTokens.test.ts` | 1 | 7 |
| `src/components/feed/mandateMessage.test.ts` | 1 | 11 |
| `src/components/feed/mcpIdentity.parse.test.tsx` | 1 | 7 |
| `src/components/feed/mcpRedaction.parse.test.tsx` | 1 | 10 |
| `src/components/feed/MemoryOnMessage.dom.test.tsx` | 1 | 10 |
| `src/components/feed/QuestionCard.delivery.dom.test.tsx` | 1 | 19 |
| `src/components/feed/QuestionCard.dismiss.dom.test.tsx` | 1 | 8 |
| `src/components/feed/ResponseDuration.render.test.tsx` | 1 | 2 |
| `src/components/feed/scrollMemory.test.ts` | 1 | 1 |
| `src/components/headerMenu/HeaderMenu.dom.test.tsx` | 1 | 11 |
| `src/components/imageAttachments.progressive.dom.test.tsx` | 1 | 8 |
| `src/components/kanban/KanbanEditing.dom.test.tsx` | 1 | 20 |
| `src/components/kanban/orchestratorWires.dom.test.ts` | 1 | 36 |
| `src/components/mobile/MobileConversationMenu.answers.dom.test.tsx` | 1 | 8 |
| `src/components/mobile/MobileFocusView.conversation.dom.test.tsx` | 1 | 29 |
| `src/components/mobile/mobileOrchestratorControls.dom.test.tsx` | 1 | 42 |
| `src/components/mobile/MobileOrchestratorSheet.render.test.tsx` | 1 | 5 |
| `src/components/mobile/MobilePipelineScreen.dom.test.tsx` | 1 | 26 |
| `src/components/mobile/MobileRemoteTask.dom.test.tsx` | 1 | 8 |
| `src/components/mobile/MobileSheet.dom.test.tsx` | 1 | 22 |
| `src/components/mobile/seatFailureTime.render.test.tsx` | 1 | 3 |
| `src/components/onboarding/OnboardingDialog.dom.test.tsx` | 1 | 48 |
| `src/components/onboarding/PhoneStep.dom.test.tsx` | 1 | 17 |
| `src/components/orchestrator/SeatReports.dom.test.tsx` | 1 | 3 |
| `src/components/orchestrator/seatState.test.ts` | 1 | 11 |
| `src/components/OverviewBoard.kanban.dom.test.tsx` | 1 | 28 |
| `src/components/OverviewBoard.render.test.tsx` | 1 | 7 |
| `src/components/pipelines/pipelineModel.test.ts` | 1 | 5 |
| `src/components/pipelines/PipelineStrip.dom.test.tsx` | 1 | 12 |
| `src/components/pipelines/PipelineTemplatePicker.dom.test.tsx` | 1 | 12 |
| `src/components/preview/ArtifactPreviewHost.dom.test.tsx` | 1 | 16 |
| `src/components/ProjectDashboard.loadingStates.dom.test.tsx` | 1 | 17 |
| `src/components/ProjectRail.dom.test.tsx` | 1 | 11 |
| `src/components/RateLimitBadge.test.tsx` | 1 | 2 |
| `src/components/ReasoningControls.render.test.tsx` | 1 | 2 |
| `src/components/roleMemory/MemoryProfile.dom.test.tsx` | 1 | 8 |
| `src/components/runtime/AttentionCard.dismiss.dom.test.tsx` | 1 | 3 |
| `src/components/runtime/deliveryWait.dom.test.tsx` | 1 | 16 |
| `src/components/RuntimePill.accountIntent.dom.test.tsx` | 1 | 15 |
| `src/components/RuntimePill.dom.test.tsx` | 1 | 20 |
| `src/components/RuntimePill.limitAccounts.dom.test.tsx` | 1 | 16 |
| `src/components/scheme/Minimap.render.test.tsx` | 1 | 12 |
| `src/components/scheme/SchemeBoard.pipelineRegions.dom.test.tsx` | 1 | 4 |
| `src/components/scheme/SubagentBadgeAnchors.render.test.tsx` | 1 | 4 |
| `src/components/scheme/SubagentBadges.dom.test.tsx` | 1 | 13 |
| `src/components/scheme/TaskCard.dom.test.tsx` | 1 | 14 |
| `src/components/TmuxComposer.deliveryNotice.dom.test.tsx` | 1 | 45 |
| `src/components/TmuxComposer.dom.test.tsx` | 1 | 54 |
| `src/components/TmuxComposer.inject.dom.test.tsx` | 1 | 52 |
| `src/components/TmuxComposer.nativeQueue.dom.test.tsx` | 1 | 27 |
| `src/components/TmuxComposer.operationReadBack.dom.test.tsx` | 1 | 11 |
| `src/components/TmuxComposer.runtimeSnapshot.dom.test.tsx` | 1 | 7 |
| `src/components/TmuxComposer.test.ts` | 1 | 14 |
| `src/components/TransferAccountsChecklist.dom.test.tsx` | 1 | 4 |
| `src/components/TurnStatusBar.dom.test.tsx` | 1 | 16 |
| `src/components/voice/viewerContextPrelude.test.ts` | 1 | 5 |
| `src/components/WakeupChip.dom.test.tsx` | 1 | 3 |
| `src/hooks/useTaskDraft.refusals.dom.test.tsx` | 1 | 8 |

## Deferred: not currently justified

- **Replacement tests.** The pinned specification forbids them in this lane.
  Two behaviours lose their only direct test and could earn a behavioural one
  later:
  - the learned-rules notice chosen per reader (seat, maintainer, stage), today
    covered only by `src/lib/memory/roleSeatRender.test.ts`;
  - the check that shipped voice personas name no spoken language
    (`src/lib/runtime/voicePersona.test.ts:96-164`), a lint over authored text
    whose cases test a helper defined in the test file.
- **Rewriting kept branch tests to assert through exported constants.** That
  would make them survive rewording. Nobody asked for it, and the kept tests
  already exercise the branch.
- **Deleting the UI copy and i18n string tests.** That waits for the operator's
  later decision, and the inventory above is its input.
- **A lint rule or hook that refuses new phrase tests.** Not requested. Telling
  a branch test from a phrase test is judgment, so the AGENTS.md rule and review
  carry it.
- **Trimming string checks on runtime outcome text** (refusal wording, journal
  and card details, spoken replies). Out of scope: those checks observe
  behaviour the pinned specification keeps.
