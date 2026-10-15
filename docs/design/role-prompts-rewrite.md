# Role prompts and the orchestrator mandate: a universal core, three rewrites, full traceability

## Originating requirement

Operator, 2026-10-15 at about 10:16 UTC, spoken in Russian to this
repository's orchestrator seat, which pinned it as this lane's specification.
Verbatim excerpt:

> «Я хочу, чтобы ты запустил агента, который оценит … Как можно переписать? … пайплайн нужно запустить. Как переписать? Сейчас роль, роли, наш промпты ролей. И мандат оркестратора. Как именно переписать так, чтобы не упустить ничего важного, но при этом то, что может касаться всех проектов, всех людей в любых задачах, такие правила мы могли бы добавить, сохранить, то есть вынести. … без привязки к какому-то конкретному инструменту или фреймворку. Это нужно проанализировать и обновить, но сделать версию ролей, показать мне прототипом до и после. Ну, картинками, чтобы была читабельно текст. … не обязательно мне прямо весь промпт вываливать. Но при этом, не, я всё-таки хочу посмотреть текст. … Может быть, в виде diff.»

The same day the operator added that the rules have to be abstract
(«це мають бути абстрактні правила»).

What the requirement asks of this stage (pinned outcome items 1–3):

1. an inventory of every text Delegatus gives an agent, with its source;
2. a classification of every sentence: universal (U), Delegatus mechanics (D),
   project-specific (P), redundant or contradictory or obsolete (R);
3. a rewrite that extracts the universal rules, keeps Delegatus mechanics
   where agents need them, moves project-specific items out, loses nothing,
   and is measured before and after.

The prototype images (item 4) and the decision form (item 5) belong to the
next stages of this lane. This document gives them the texts to render
(`docs/design/role-prompts-rewrite/`) and the questions to ask (§6).
Nothing in the live role registry, the mandate source or product code changes
in this lane.

## Status and evidence

- Code: this worktree at `e3dad062c` (main). The prompt sources
  (`src/lib/roles/defaults.ts`, `src/lib/roles/registry.ts`,
  `src/lib/orchestrator/prompt.ts`, `src/lib/pipelines/prompts.ts`,
  `src/lib/pipelines/testGuidance.ts`, `src/lib/memory/roleRender.ts`) are
  byte-identical between `8f2db43e5`, the release this machine serves, and
  `e3dad062c`; `origin/main` had not moved when this was written.
- The `before/` texts were rendered by the real functions
  (`roleScaffoldBody`, `roleFenceBlock`, `orchestratorMandateForDelivery`,
  `renderStagePrompt`, `renderLearnedRules`, `lessonRequestLines`), run under
  Bun from a scratch export of the commit with isolated HOME, XDG config and
  state directory. Role parameters are left as their `{{tokens}}`; the
  orchestrator renders in `standard` mode. Nothing was typed by hand.
- Live registry (`role_presets` with `detail: true`, revision
  `roles-1-2049dd0aaa1fe9f4e7ce`, health `healthy`): no role's prompt text is
  overridden on this install, so the live text equals the shipped text. One
  runtime row differs from the shipped default (curator runs Claude Opus
  here; the shipped row is Codex), which changes no text.
- Live mandate (`get_orchestrator` for this project, read-only): the seat
  holds a v53 mandate (27,670 characters) whose body is the shipped default
  plus a private rotation handoff; the shipped default is v54. Delivery
  replaces the one v53 directive that differs (the prototype directive) by
  exact match (`prompt.ts:417-423`, `:650`). The handoff is generated per
  rotation (`src/lib/orchestrator/handoffDigest.ts`) and is out of scope; it
  is not reproduced here.
- Learned rules: counted read-only from the `role_memory` collection of the
  live state database (counts only; no rule text leaves the machine).

### Prior work

- `docs/design/agent-prompt-contract.md` (2026-09-27/28) made one verdict
  vocabulary, one completion channel and the shared-rules block, and removed
  language, framework and Delegatus-code specifics from agent text. Its §2.6
  rule ("agent-facing text names no language, framework, package manager or
  command") is the standard this audit applies; §2 P below lists what has
  crept back in since.
- `docs/design/opus-55-prompting-review.md` (2026-09-24) added the finish
  lines, "keep going" and "how to show it fails"; all three survive into the
  universal core here.
- `docs/design/role-memory.md`, `role-memory-curation.md` and
  `orchestrator-role-memory.md` define the learned-rule levels inventoried in
  §1.6. A 2026-10-10 lane already analysed rule quality ("too many, too
  task-specific") and asked for abstract lessons; the stage-end lesson request
  (`roleRender.ts:88-110`) carries that today.
- Searches: `search_transcripts` in several phrasings (role prompts rewrite
  universal rules abstract; абстрактні правила для всіх проектів ролі промпт;
  mandate size duplicated scaffold shared rules), project-scoped and
  unscoped, found the prompt-contract and role-memory lanes above and no
  earlier proposal of a universal core. `search_memory` returned nothing for
  two phrasings.

---

# 1. Inventory

## 1.1 How an agent's text is assembled

| launch path | what the agent receives, in order | sources |
| --- | --- | --- |
| pipeline stage | engine system prompt (not ours) → learned-rules block (appended system prompt / developer instructions) → first message: stage prompt, relayed input, pinned task, pinned specification, `Role preset:` line, role scaffold (body + safety fences), stage wrapper (prototype lane, access, host access, base, branch, nesting, test guidance, completion contract, fallback) → after `stage_report`, the lesson request | `pipelines/prompts.ts:32-127`, `pipelines/roles.ts:42-74`, `roles/registry.ts:115-127,153-156`, `memory/roleRender.ts:47-58,88-110`, `runtime/claudeStreamBrokerHost.ts:918-919`, `runtime/structuredSpawn.ts:1822` |
| spawned role agent | role scaffold + fences, the caller's brief, the completion line | `roles/registry.ts:132,144-150` |
| orchestrator seat | role scaffold + fences, the mandate (with delivered directives and the role table), on rotation a handoff; learned rules with the seat notice | `orchestrator/prompt.ts:425-509,634-662`, `roles/defaults.ts:187-191` |
| orchestrator as a stage or child | scaffold + the "without mandate" rules | `roles/defaults.ts:95`, `pipelines/roles.ts:61-63`, `roles/registry.ts:144-150` |

A stage stores its rendered scaffold when the pipeline is created
(`pipelines/roles.ts:157-171`), while the wrapper renders at every launch. That is
why the wrapper repeats some rules (prototype lane, blocked fix stage): it is
the only text that reaches lanes created before a scaffold changed.

## 1.2 Role scaffolds

All 13 roles, live runtime row, access, parameters and the size of the
scaffold layer as delivered (body plus fences, characters):

| role | source | live runtime | access | parameters, modes, variants | chars |
| --- | --- | --- | --- | --- | ---: |
| orchestrator | `roles/defaults.ts:170-193` | claude/opus/high | read-write | mode standard, plan-tickets, wayfind, backlog-campaign (adds 6 lines, `registry.ts:84-100`) | 620 (stage form 2,901) |
| reviewer | `:194-209` | codex/gpt-6.1-sol/xhigh; size=trivial codex/gpt-6-luna/high | read-only | diffSource, lens (9), mode fresh, parallelN, size | 7,156 |
| verifier | `:210-221` | codex/gpt-6.1-sol/high | read-only | claims | 4,022 |
| builder | `:222-235` | codex/gpt-6.1-sol/high; frontend, docs, trivial on claude-sonnet-5-5; apply-fixes codex/gpt-6-luna | read-write | mode (6), domain general/frontend/docs, size; frontend guidance `registry.ts:116-118`; fix round `registry.ts:106,119-124` | 3,671 (frontend 4,043, apply-fixes 4,767) |
| architect | `:236-247` | claude/opus/xhigh | read-only | mode design, spec, architecture-audit | 6,102 |
| cleaner | `:248-257` | codex/gpt-6-luna/medium | read-write | none | 3,076 |
| prod-auditor | `:258-269` | codex/gpt-6.1-sol/xhigh | read-only | questions | 3,436 |
| deployer | `:270-285` | codex/gpt-6.1-sol/medium | read-write; a pipeline admits it only in release mode | sha, mode deploy/release, pr | 4,829 |
| merger | `:286-298` | codex/gpt-6.1-sol/high | read-write | prs | 7,392 |
| maintainer | `:108-129,299-306` | codex/gpt-6.1-sol/medium | read-only | none | 12,109 |
| curator | `:307-315` | claude/opus/high (shipped codex) | read-only | none | 3,020 |
| issue-reporter | `:136-148,316-323` | claude/claude-sonnet-5-5/high | read-only | none | 5,967 |
| visual-critic | `:150-167,324-331` | claude/opus/high | read-only | none | 5,281 |

Domains: the reviewer and builder variants differ in runtime only, except
builder `domain=frontend` (adds the UI guidance) and `mode=apply-fixes`
(swaps the finish line and adds the fix-round guidance). The maintainer's
scaffold (12,109 characters) is above the 12,000-character cap an override
may have (`roles/store.ts:26`); it is not a pipeline role, so nothing
truncates it today.

## 1.3 Shared blocks

| block | source | chars | carried by |
| --- | --- | ---: | --- |
| missing access | `roles/defaults.ts:46-47` | 570 | every role except the seat (via `SHARED_RULES`, `:88`) |
| project rules | `:51-52` | 317 | same |
| search prior conversations | `:31-32` | 457 | same; the seat has a longer version (`prompt.ts:458-459`) |
| human in the loop (decide yourself) | `:39-40` | 763 | same; the seat has a longer version (`prompt.ts:461-466`) |
| process cleanup | `:74-76` | 450 | every role, the seat included |
| scope | `:56-57` | 166 | builder |
| findings rule | `:59-60` | 601 | reviewer, verifier, architect |
| review verdict | `:62-63` | 524 | reviewer |
| test baseline | `:66-67` | 869 | reviewer; the legacy flow reviewer (`flows/prompts.ts:46`) |
| three standing rules (frame) | `:25-26` | 1,409 | reviewer, architect |
| review dependencies | `:90` | 443 | reviewer |
| prototype publication | `:131` | 332 | builder, architect (and the stage wrapper for every stage) |
| finish lines | `:81-82` | 196 / 280 | builder / fix round |
| apply-fixes guidance | `registry.ts:106` | 983 | builder mode=apply-fixes |
| spawn completion | `registry.ts:132` | 483 | every spawned role agent |
| orchestrator without mandate | `roles/defaults.ts:95` | 2,280 | an orchestrator stage or child |
| safety fences | per role, rendered by `registry.ts:153-156` | — | every role |

## 1.4 Stage wrapper

`renderStagePrompt` (`pipelines/prompts.ts:32-127`) adds 3,709 characters to
every stage (read-only form), including the prototype-lane paragraph
(`:100`) and the blocked-fix-stage paragraph (`:116`) for every role, and the
test guidance line from `pipelines/testGuidance.ts:21` (or `:30`), which
names `LLV_STATE_DIR` for every project. The decision continuation
(`prompts.ts:20-29`) adds the precedence sentence "the answer governs".

## 1.5 Orchestrator mandate

`ORCHESTRATOR_SYSTEM_PROMPT` (v54, `prompt.ts:425-509`) plus the role table
generated at delivery (`:555-576`); 29,320 characters as rendered with the
shipped registry. Five sections are delivered directives, recognized by a
heading or by their whole text, so their constants must change together with
any rewrite (`:594-603`).

| § | section | source | chars | marker |
| --- | --- | --- | ---: | --- |
| 0 | opening | `prompt.ts:425` | 193 | |
| 1 | Who you are | `:408-409` | 668 | |
| 2 | Initial visible status | `:117,131-135` | 768 | whole text |
| 3 | Two channels to the operator | `:431-433` | 641 | |
| 4 | Bridge reports | `:435-439` | 1,364 | |
| 5 | Directives | `:441-442` | 272 | |
| 6 | Steering the operator's attention | `:444-448` | 1,158 | |
| 7 | Reply drafts | `:450-452` | 550 | |
| 8 | Delegatus's clock | `:164-223` | 2,485 | heading; tick-contract clauses checked by `:675-680` |
| 9 | Board maintenance report | `:259-260` | 725 | heading |
| 10 | Search prior conversations | `:458-459` | 972 | |
| 11 | Human in the loop | `:461-466` | 778 | |
| 12 | The task is the unit of work | `:358-383`; colour rule `tasks/colorRule.ts:10-24` | 6,365 | heading |
| 13 | How work runs | `:470-484` | 3,743 | |
| 14 | Pipeline stage contract | `:486-492` | 1,798 | |
| 15 | A pipeline that finishes its task | `:494-495` | 516 | |
| 16 | Start-by-default pipeline contract | `:497-499` | 735 | |
| 17 | Delegatus bug reports, and work for another project | `:287-290` | 942 | whole text |
| 18 | Fences + prototype directive | `:503-509`, `:415` | 1,137 | prototype directive: whole text |
| 19 | Role table | `:555-576` | 3,472 | heading |

## 1.6 Learned-rule levels

| level (scope key) | heading the agent reads | readers | active rules (live) | chars |
| --- | --- | --- | ---: | ---: |
| role on this project (`role:<project>:<role>`) | "Role rules · <Role> on this project" | that role, this project | 135 | 32,826 |
| role on every project (`role:*:<role>`) | "Role rules · <Role> on every project" | that role, any project; only the curator widens to it | 75 | 17,017 |
| project (`project:<project>`) | "Project rules · every role on this project" | every role here | 8 | 1,824 |
| machine (`machine`) | "Machine rules · every project on this machine" | every role, every project here | 16 | 2,560 |

Sources: scope keys `memory/roleScopes.ts:1-27`; headings and notices
`memory/roleRender.ts:9-16,25-30,47-58`; the level definitions agents choose
from at stage end `roleRender.ts:101-107`; rule length 300, why 160
(`memory/roleTypes.ts:15-16`). Reviewers and verifiers leave no rules. There
is no level above "machine": nothing a stage learns can reach every machine,
and the shipped prompts are the only text every install shares.

## 1.7 Adjacent texts, inventoried and left alone

| text | source | size | why it stays out of this rewrite |
| --- | --- | --- | --- |
| MCP server instructions | `mcp/server.ts:4570` | 1,935 chars | product mechanics for every caller; overlaps noted in §2 R |
| tool descriptions | `mcp/server.ts:3329-` | large | read only once a tool loads; V3 moves text into them (§3.5) |
| seat-tick wake | `monitor/seatTickController.ts` | per wake | generated per wake from state |
| rotation handoff | `orchestrator/handoffDigest.ts` | bounded | generated per rotation |
| maintenance brief | `boardMaintenance/text.ts:57-76` | per run | generated; repeats the maintainer's deploy-note rule (`:74`) |
| curator brief and checklist | `memory/curation/brief.ts:1-9` | ~5 KB | curator pass procedure |
| voice coordinator mandate | `runtime/voicePersonaMandate.ts` | ~4 KB file | voice modality, its own lane |

---

# 2. Classification

## 2.1 Classes

- **U, universal**: holds for any project, any person, any task and any
  tool. A trigger may limit it ("when the work changes what a person sees")
  if the trigger names no tool.
- **D, Delegatus mechanics**: names a Delegatus tool, state, verb, setting or
  role, or an engine or forge Delegatus drives (GitHub review states, Claude
  scheduling tools).
- **P, project- or environment-specific**: names this repository's files,
  scripts, variables, languages or deploy topology, or one operator's locale;
  it belongs in that project's instruction files.
- **R, redundant, contradictory, obsolete or misplaced**: with the sentence it
  repeats or contradicts.

Every sentence of every text in §1.2–§1.6 got one id (`MA.1`, `MRG.17`,
`M12.45`, …), 676 in all. A sentence that wraps a universal principle in a
Delegatus tool name is classed by its principle and its tool name goes to the
mechanics block (the traceability rows say so).

| area | sentences | U | D | P | R |
| --- | ---: | ---: | ---: | ---: | ---: |
| shared blocks | 65 | 41 | 17 | 0 | 7 |
| role bodies and fences | 249 | 39 | 179 | 26 | 5 |
| mandate | 259 | 26 | 207 | 1 | 25 |
| stage wrapper | 37 | 1 | 35 | 1 | 0 |
| learned-rule framing | 66 | 0 | 65 | 0 | 1 |
| **all** | **676** | **107** | **503** | **28** | **38** |

## 2.2 The universal rules that exist today, and who gets them

The 107 U sentences reduce to twelve principles and three conditional ones.
Most of them reach only one or two roles, which is the gap the operator
suspected:

| # | principle | carried today by | missing from |
| --- | --- | --- | --- |
| 1 | judge against the quoted requirement; build nothing it does not need; keep cut scope visible | reviewer, architect (`RF.1`, `ARC.5-6`), seat (`M13.14`) | builder, verifier, cleaner, prod-auditor, deployer, merger, maintainer, curator, issue-reporter, visual-critic |
| 2 | the project's own rules and checks govern | every role (`PR.1-3`); seat via its fences (`M18.4`) | — |
| 3 | look for an earlier answer, recheck it against the current state | every role (`SP.1`), seat (`M10`) | — |
| 4 | decide what you can find out; ask only what is the person's | every role (`HL`), seat (`M11`) | — |
| 5 | keep going; naming the next step is no stop | every role (`HL.2`), seat (`M11.7-8`) | — |
| 6 | every claim carries its evidence; observation apart from inference | verifier, prod-auditor, issue-reporter, reviewer fences | cleaner, deployer, merger, curator, architect; the builder only "reports verification evidence" |
| 7 | a missing access is a named gap | every role (`MA`) | the seat |
| 8 | stay in scope; leave others' in-flight areas alone | builder (`SC`) | every other role |
| 9 | prefer the simplest mechanism; cutting scope is success | reviewer, architect (`RF.2`) | builder (the one who builds) and the rest |
| 10 | done means verified: criteria hold, checks pass, self-review | builder (`BF`, `BLD.3`), fix round | every other role (the deployer has its own health checks) |
| 11 | touch only what is yours (processes, ports, other checkouts, user data, backups) | every role (`PC`), cleaner, seat persona boundary | — |
| 12 | public text carries no identities | issue-reporter (`IR.12-14`), merger (`MRGF.5`) | builder, which writes commits and pull requests on every project |
| 13 | rendered surfaces are part of correctness (when UI changes) | reviewer, architect, visual-critic, frontend builder | — |
| 14 | compare with the base before blaming a change (when tests fail) | reviewer (`RB`), merger (`MRG.23`) | — |
| 15 | production is read-only by default | prod-auditor, deployer | — |

## 2.3 Project-specific text in shipped prompts (P, 28 sentences)

The 2026-09-28 contract removed this kind of text; these sentences are in the shipped prompts today:

- Visual critic names this repository's four driver files and its isolation
  recipe, and the product's two languages (`VC.6-8`,
  `roles/defaults.ts:162`). A visual critic on any other project is told to
  run files that do not exist there. This repository's AGENTS.md already
  lists three of the four drivers.
- Deployer names `docs/deploy-checkout.md`, `scripts/deploy-checkout.py` and
  the verdict files (`DEP.5-7`, `:282`). The sentence is scoped "For a
  Delegatus checkout install", so it misleads nobody, but it is this
  repository's procedure.
- Merger: 17 sentences are the protocol of this repository's
  `scripts/merge-batch.ts` (`MRG.7-8,10,13,16-22,24-28,30`, `:291`). The role
  works only where that script exists.
- The stage test guidance names `LLV_STATE_DIR`, this repository's variable,
  for every project (`SW.17`, `testGuidance.ts:21,30`).
- The mandate names "runtime host" among high-risk areas twice (`M14.14`,
  `M19.29`).
- Maintainer: the batch-merge comment form (`MNT.42`), the Ukrainian
  deploy-note literals for one operator (`MNT.48`), and "gh needs the
  network, so retry on DNS" (`MNT.6`).

## 2.4 Redundant, contradictory, obsolete or misplaced (R, 38 sentences)

Contradictions (each would mislead an agent that reads both):

- The role table's UI lane ends in an "Opus review-loop" (`M19.24`,
  `prompt.ts:570`); the stage contract says never compose `review-loop`
  (`M14.17`, `prompt.ts:491`).
- The maintainer writes "Blocked: <reason> — unblocks when <what>" as the
  first details line (`MNT.34`, `roles/defaults.ts:119`); `update_task`'s
  description asks for a `hold` with kind and reason and says a bare blocked
  status "reads as no reason given" (`mcp/server.ts`, `update_task`). The
  mandate's tick contract and task section also say "mark … blocked with the
  reason" (`M08.14`, `M12.45`).
- Outside the rewritten texts, and recorded for the fix lane: the
  `pipeline_action` description says that under `advance` "a terminal gate
  re-checks once and completes only on pass, otherwise parks"
  (`mcp/server.ts:3388`), while the mandate says advance "creates no terminal
  re-check" (`prompt.ts:488`) and the engine agrees ("the current advance
  policy never creates this cursor", `pipelines/engine.fixture.ts:1044`).

Duplicates the agent reads twice in one prompt:

- The prototype-lane paragraph: builder and architect scaffolds (`PP`,
  `roles/defaults.ts:131`) and the stage wrapper (`prompts.ts:100`), which
  every stage reads, a reviewer included.
- The blocked-fix-stage rule: the apply-fixes guidance (`AF.7-9`) and the
  stage wrapper (`SW.22-24`), the wrapper shown to every stage; the mandate
  states it a third time (`M13.8-9`) and the role table a fourth (`M19.25-27`).
- WRONG-PREMISE and OVER-BUILT are defined in the findings rule (`FR.5`) and
  again in the frame rules (`RF.1-2`) of the same reviewer and architect
  prompts.
- "A needs_decision carries no findings" in the reviewer scaffold (`RV.2`),
  the stage wrapper (`SW.28`) and the spawn line (`SPW.2`).
- The colour rule in the mandate (`M12.17`) and in `create_task`'s
  description; "text for the human, details for the agent" in the mandate
  (`M12.18-19`), `create_task`, `update_task` and the MCP instructions.
- "Operate only through Delegatus tools" opens the mandate (`M00.2`) and
  heads its fences (`M18.2-3`).
- "Proactive" is defined three times (`M01.4-6`, `M08.11`, `M16.5`).
- Visual critic's "close every browser … by the PID" (`VC.19`) restates
  process cleanup; architect's "Product-source edits are prohibited" (`ARC.3`)
  restates its first fence; curator's "change role memory only through
  curate_rules" (`CUR.2`) restates its fence.

Misplaced or obsolete:

- Four reporting sentences sit inside the pipeline stage contract
  (`M14.10-13`, `prompt.ts:489`).
- The clock section's handover (`M08.6-9`) addresses seats that armed their
  own schedules before v11 and names Claude-only tools (ScheduleWakeup,
  CronCreate, CronDelete, CronList), which a Codex seat does not have.
- The learned-rules notice restates precedence per block (`LR.3`).

## 2.5 Learned rules: where universal rules accumulate today

This stage started with 64 learned rules (23 role, 19 role on every project,
6 project, 16 machine). Classed by the same test, by id only, since rule
text stays on this machine:

| level | U | D | P (project, tool or machine) |
| --- | --- | --- | --- |
| role, this project (23) | 9: r_82995cc5daa98212, r_3416f0eb8e646071, r_4fe6c7706d25c6f3, r_779fff4c296893f3, r_0de29e8da84bca83, r_ed0bcf456b857eee, r_134244464d1c46b0, r_35361805df13a61b, r_e2de29d59f9271a0 | 9 | 5 |
| role, every project (19) | 14: r_683a5f5b0799e39f, r_7f8572fdf928f5c2, r_29f9b3674e3d714e, r_20c3a41be387a482, r_03e0441f0e0ceabc, r_cbd63dcac30e81b5, r_3fbd1b8880c24310, r_8cd0ac8698041b47, r_1c4b8fcfaab6fc82, r_c10e3cc2f1363aa7, r_8be4966e99699181, r_53987e4be1891aa9, r_ae9c9fd65797e0ba, r_bb751eb160754ffc | 2 | 3 (one names an operating-system interface) |
| project (6) | 6, all engineering principles for long-lived servers: r_85009c5923b00682, r_f7dcc821242dff13, r_6aea5f42f89e67c3, r_d851907a6bfc2bc9, r_851d675f7202bb42, r_a954a09a49e2640c | 0 | 0 |
| machine (16) | 4: r_3565b00fd0d43985, r_39ed1fd0281cdfff, r_b941c97ebc4393ab, r_aa739275b4e55958 | 2 | 10 (named tools and this machine) |

Two observations follow. First, 33 of 64 rules are tool-free and
project-free, and several of them restate a core principle with a sharper
trigger: r_39ed1fd0281cdfff and r_3565b00fd0d43985 are principle 11 for
files and dev servers, r_ed0bcf456b857eee is principle 8, r_03e0441f0e0ceabc
is principle 6, r_1c4b8fcfaab6fc82 and r_0de29e8da84bca83 are principle 3.
Second, the six "project" rules of this repository hold for any long-lived
server, and the "machine" level holds mostly tool knowledge (browsers, git,
cgroups). The levels work for what they were built for; what they lack is a
home for a rule that is true everywhere, which today can only be the shipped
prompts.

---

# 3. Rewrite proposal

## 3.1 Target structure

```
  ┌──────────────────────────────────────────────────────────────┐
  │ Universal core: "Working rules (every role, every project)"  │  U, no tool names
  │   precedence + 12 principles (V2: + 3 conditional blocks)    │
  └──────────────┬───────────────────────────────────────────────┘
                 │ every role and the seat read it once
  ┌──────────────▼──────────────┐   ┌────────────────────────────┐
  │ Role part (thin)            │   │ Judging block              │  reviewer, verifier,
  │ identity, parameters,       │   │ finding vs note, labels    │  architect
  │ verdict words, role steps,  │   └────────────────────────────┘
  │ safety fences               │
  └──────────────┬──────────────┘
                 │
  ┌──────────────▼──────────────────────────────────────────────┐
  │ Delegatus mechanics, once per launch path                   │  D
  │ stage wrapper / spawn line / mandate: tools, verdict words, │
  │ $TMPDIR scratch, needs_decision as the way to ask           │
  └──────────────┬──────────────────────────────────────────────┘
                 │
  ┌──────────────▼──────────────────────────────────────────────┐
  │ Project instruction files (AGENTS.md, CONTRIBUTING, …)      │  P
  │ drivers, deploy scripts, merge-batch protocol, languages    │
  └─────────────────────────────────────────────────────────────┘
```

Precedence, stated in the core so that every agent reads it once: the safety fences and
the controller's instructions (access, branch, completion) are hard limits;
an answer the operator gave in this work governs the brief and the pinned
specification (today `prompts.ts:28`); the project's instruction files
govern how its code is built, checked and released (today `M18.4`, `PR.1`);
learned rules yield to all of them (today `LR.3`, `LR.6`). This restates the
existing rules and adds no new ordering; the seat's fence and the decision
continuation keep their own sentences, and the learned-rules notice points
to the core.

## 3.2 Variant 1 — conservative ("clean-up")

Keeps the structure and every U and D sentence where it is, wording
unchanged. It removes R sentences, fixes the two contradictions, and moves P
sentences that mislead other projects.

- Remove the prototype paragraph from builder and architect scaffolds (the
  wrapper keeps it), the duplicated blocked rule from the apply-fixes guidance
  (the wrapper keeps it, so stored lanes still get it), the duplicated label
  definition, `RV.2`, `ARC.3`, `VC.19`, the fence restated in `CUR.2`.
- Visual critic: "the drivers and the isolated state the project's
  instruction files name", "every language and theme the project ships".
- Maintainer and the role table: a task `hold` where they wrote "Blocked:"; the UI lane's
  review stage written as a reviewer with its fix stage.
- Mandate: one "only through Delegatus tools" sentence, the colour rule by
  pointer, the four misplaced reporting sentences moved into Bridge reports,
  the duplicated fix-stage bullet removed, "runtime host" written as "the
  project's critical runtime".
- Stage test guidance: "any state-directory variable the project's
  instruction files name".
- Kept on purpose: the merger's protocol and the deployer's Delegatus
  paragraph (scoped), the maintainer's Ukrainian literals (the maintenance
  brief already says to localize), the clock handover.

Trade-off: smallest risk and diff (−3% of role text, −3% of the mandate);
it does not extract a universal core, so principles 1, 6, 8, 9, 10 and 12
still reach only the roles that have them today. It answers "remove
contradictions" and leaves the operator's main ask open.

## 3.3 Variant 2 — balanced ("core + thin roles"), recommended

Everything in V1, plus:

- **A universal core** (`v2/core.txt`, 3,918 bytes) that every role and the
  seat read once: the precedence sentence and the twelve principles of §2.2,
  written without tool names. It replaces the shared block
  (`SHARED_RULES`), the orchestrator-without-mandate rules, and the
  universal halves of the frame rules, the finish line and the fences.
  Process cleanup keeps its concrete command examples, since they are what
  agents actually type (#1770).
- **One judging block** (`v2/judging.txt`) for reviewer, verifier and
  architect: the findings rule with the two labels defined once.
- **Conditional blocks only where they apply**: test baseline (reviewer;
  the merger keeps its own), rendered changes (reviewer, architect).
- **Delegatus mechanics once per launch path** (`v2/mechanics.txt`): the
  tool names behind principle 3, needs_decision as the way to ask, and the
  `$TMPDIR` scratch rule, appended by the stage wrapper; the spawn line
  carries the same lines for spawned agents. The wrapper shows the prototype
  paragraph only to builder, architect and visual-critic stages, and the
  blocked paragraph only to fix stages.
- **Project procedures move out**: the deployer's Delegatus paragraph, the
  merger's 17 protocol sentences and the visual critic's driver list move to
  this repository's AGENTS.md and CONTRIBUTING.md
  (`project-files/AGENTS.additions.txt`, verbatim). The merger becomes
  generic: it uses the batch-merge procedure the project names and finishes
  with needs_decision when there is none.
- **Mandate**: Two channels, Bridge reports, Directives, Attention, Reply
  drafts and the prototype directive become one section, "Reaching the
  operator", with one rule for forms; "proactive" is defined once in Who you
  are; Search prior conversations and Human in the loop become "Before you
  decide", carrying only what a seat adds to core principles 3 and 4; the
  start-by-default contract and the finishing-task section join How work runs
  and the stage contract; the clock names no Claude-only tool; "hold"
  replaces "blocked".

Trade-off: every role gains the principles it lacked, so the scaffold layer
grows (13 roles +23%, small roles +40%), the seat stays the same size (+1%)
and the mandate shrinks 11%. A pipeline stage's whole first-message layer
grows 5–20% (the merger shrinks 6%). In exchange, a builder on any project is
told to keep identities out of commits, to stay in scope and to prefer the
simplest mechanism; a cleaner and a deployer are told to back their claims
with evidence. Seats need one rotation to receive it (version bump).

## 3.4 Variant 3 — aggressive ("principles + tool docs")

Everything in V2, then compressed:

- Core of 2,354 bytes: the same twelve principles in one or two clauses each.
- Role parts of 3–10 lines; the maintainer goes from 12,109 to 6,177
  characters by trusting the server's refusals
  (`boardMaintenance/guard.ts:68-78`) and drops their enumeration.
- Every merger sentence beyond the core protocol moves to the project file.
- Mandate of 13,983 characters (−52%): bulleted sections; rare-path task
  binding mechanics, review-edge details, bridge-report rules, attention and
  draft rules move into the descriptions of the tools they govern
  (`v3/tool-descriptions.txt`, verbatim with the target tool).
- A fifth learned-rule level "universal" appears in the lesson request: an
  agent marks a rule that reads universal, and the curator proposes it to the
  operator for the core.

Trade-off: the largest saving (−27% role text, −45% for the seat, −11 to
−35% per stage) and the most behaviour risk. Much of it rests on agents
reading tool descriptions, and in Claude Code an MCP tool is deferred: its
description is invisible until the agent loads the tool, which this very
session shows. Guidance on *when* to use a tool (attention moves, reply
drafts, placeholder repair) would no longer be in front of the seat at the
moment it decides. Several incident-born clauses lose their reasons. It also
needs the most new tests.

## 3.5 Comparison

| | V1 | V2 | V3 |
| --- | --- | --- | --- |
| universal core extracted | no | yes, 12 principles + 3 conditional | yes, compressed |
| contradictions fixed | yes | yes | yes |
| project text moved out | partly (visual critic, test guidance, runtime host) | all 28 sentences | all |
| 13 roles, one file each | 64,965 (−3%) | 81,831 (+23%) | 48,362 (−27%) |
| seat (scaffold + mandate) | 28,922 (−3%) | 30,320 (+1%) | 16,512 (−45%) |
| reviewer stage, whole layer | −2% | +5% | −26% |
| moves text to tool descriptions | no | no | yes (`v3/tool-descriptions.txt`) |
| new behaviour | none | merger asks when no batch procedure exists; hold replaces blocked | V2 plus a "universal" lesson level |
| implementation | small: defaults.ts, prompt.ts, testGuidance.ts, mandate v55 | medium: new core constant, scaffolds, wrapper conditions, mandate v55, tests | large: V2 plus tool descriptions, curator flow |

## 3.6 Recommendation

Variant 2. It is the one that does what the operator asked: it pulls the
rules that hold everywhere into one tool-free text every agent reads, keeps
every Delegatus mechanic in front of the agent that needs it, and moves this
repository's procedures into this repository. V1 leaves the universal rules
scattered. V3's savings depend on tool descriptions that a Claude agent does
not see until it loads the tool, which is a loss of guidance this design
cannot verify away. If size matters more than coverage, the V2 core can drop
principles 9, 10 and 12 into the roles that use them, saving about 580
characters per role (question 6 in §6).

## 3.7 Implementation constraints found in the code

- Bump `ORCHESTRATOR_PROMPT_VERSION` and its fingerprint test
  (`prompt.ts:94-102`); add the old text of every rewritten delivered
  directive to its `SHIPPED_*` list so delivery replaces it by exact match
  (`:123-127`, `:234-241`, `:262-263`, `:417-423`).
- Keep the headings that are delivery markers (task ownership, clock, board
  report, role table) and update `ORCHESTRATOR_SEAT_TICK_CONTRACT`
  (`:181-189`) with the hold wording, or wakes repeat the old clauses
  (`:675-680`).
- Pinned texts: `PROCESS_CLEANUP_MARKER` (both cores keep the phrase "stop
  only the processes you started yourself"), `VISUAL_CRITIC_UNFRAMED`,
  `VISUAL_CRITIC_CLASSES`, `ISSUE_REPORT_SCRUB_RULE` (all kept verbatim).
- `roleScaffoldBody` swaps the builder finish line by exact string
  (`registry.ts:120-124`); the fix-round text moves with it.
- Stored lanes keep the scaffold they were created with
  (`pipelines/roles.ts:157-171`); conditional wrapper paragraphs must key on the
  stage's role and params so old lanes still receive the blocked rule.
- The curator should archive learned rules that the core now states
  (reason `in-instructions`), by id.
- Every edit to role text reaches launches after it; running agents keep
  theirs.

---

# 4. Sizes before and after

Characters (Unicode code points) of the texts in
`docs/design/role-prompts-rewrite/`. Role rows are the scaffold layer as
delivered: body, shared rules or core, fences.

| text | before | V1 | V2 | V3 | V1 Δ | V2 Δ | V3 Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| role: orchestrator | 620 | 620 | 4,132 | 2,529 | +0% | +566% | +308% |
| role: orchestrator.backlog-campaign | 1,081 | 1,081 | 4,593 | 2,956 | +0% | +325% | +173% |
| role: orchestrator.stage | 2,901 | 2,901 | 4,305 | 2,674 | +0% | +48% | -8% |
| role: reviewer | 7,156 | 6,850 | 7,847 | 4,834 | -4% | +10% | -32% |
| role: verifier | 4,022 | 4,022 | 5,560 | 3,395 | +0% | +38% | -16% |
| role: builder | 3,671 | 3,343 | 4,543 | 2,715 | -9% | +24% | -26% |
| role: builder.frontend | 4,043 | 3,715 | 4,887 | 3,017 | -8% | +21% | -25% |
| role: builder.apply-fixes | 4,767 | 4,185 | 5,022 | 3,081 | -12% | +5% | -35% |
| role: architect | 6,102 | 5,538 | 6,541 | 3,824 | -9% | +7% | -37% |
| role: cleaner | 3,076 | 3,076 | 4,378 | 2,776 | +0% | +42% | -10% |
| role: prod-auditor | 3,436 | 3,436 | 4,747 | 3,166 | +0% | +38% | -8% |
| role: deployer | 4,829 | 4,829 | 5,947 | 3,870 | +0% | +23% | -20% |
| role: merger | 7,392 | 7,392 | 6,795 | 4,012 | +0% | -8% | -46% |
| role: maintainer | 12,109 | 12,105 | 13,534 | 6,177 | -0% | +12% | -49% |
| role: curator | 3,020 | 2,970 | 4,342 | 2,694 | -2% | +44% | -11% |
| role: issue-reporter | 5,967 | 5,967 | 7,283 | 4,315 | +0% | +22% | -28% |
| role: visual-critic | 5,281 | 4,817 | 6,182 | 4,055 | -9% | +17% | -23% |
| **13 roles, one file each** | **66,681** | **64,965** | **81,831** | **48,362** | **-3%** | **+23%** | **-27%** |
| mandate | 29,320 | 28,302 | 26,188 | 13,983 | -3% | -11% | -52% |
| stage wrapper (read-only) | 3,709 | 3,761 | 4,485 | 4,078 | +1% | +21% | +10% |
| stage wrapper (read-write) | 3,713 | 3,765 | 4,489 | 4,082 | +1% | +21% | +10% |
| memory/learned-rules.stage.txt | 860 | 860 | 843 | 843 | +0% | -2% | -2% |
| memory/lesson-request.txt | 2,646 | 2,646 | 2,665 | 2,916 | +0% | +1% | +10% |
| **seat: orchestrator scaffold + mandate** | **29,940** | **28,922** | **30,320** | **16,512** | **-3%** | **+1%** | **-45%** |

A pipeline stage's whole first-message layer from Delegatus (stage wrapper
plus role scaffold; the brief and the pinned specification excluded). For V2
and V3 each stage counts only the conditional wrapper paragraphs its role
receives:

| stage role | before | V1 | V2 | V3 | V1 Δ | V2 Δ | V3 Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| reviewer | 10,865 | 10,611 | 11,462 | 8,042 | -2% | +5% | -26% |
| verifier | 7,731 | 7,783 | 9,175 | 6,603 | +1% | +19% | -15% |
| architect | 9,811 | 9,299 | 10,606 | 7,482 | -5% | +8% | -24% |
| prod-auditor | 7,145 | 7,197 | 8,362 | 6,374 | +1% | +17% | -11% |
| visual-critic | 8,990 | 8,578 | 10,247 | 7,713 | -5% | +14% | -14% |
| builder | 7,384 | 7,108 | 8,612 | 6,377 | -4% | +17% | -14% |
| builder.frontend | 7,756 | 7,480 | 8,956 | 6,679 | -4% | +15% | -14% |
| builder.apply-fixes | 8,480 | 7,950 | 9,511 | 7,163 | -6% | +12% | -16% |
| cleaner | 6,789 | 6,841 | 7,997 | 5,988 | +1% | +18% | -12% |
| merger | 11,105 | 11,157 | 10,414 | 7,224 | +0% | -6% | -35% |
| orchestrator.stage | 6,614 | 6,666 | 7,924 | 5,886 | +1% | +20% | -11% |

---

# 5. Traceability

Every sentence id, its source, class and home in each variant is in
`docs/design/role-prompts-rewrite/traceability.tsv` (676 rows, one per
sentence, with the sentence text). The table below groups consecutive
sentences that share a class and a destination. Destinations: `kept`,
`edited` (same place, new wording), `core N`, `judging`, `mechanics`,
`BASELINE`, `RENDERED`, `PRODUCTION`, `APPLY-FIXES`, `FRONTEND`,
`spawn line`, `role`, `fences`, a mandate section, `project file`
(`project-files/AGENTS.additions.txt`), `tool desc: <tool>`
(`v3/tool-descriptions.txt`), `brief` (the maintenance brief), or `dropped`
with its reason. Nothing is dropped without a reason that names where the
rule still lives or why it no longer applies.

| ids | source | class | note | V1 | V2 | V3 |
| --- | --- | --- | --- | --- | --- | --- |
| MA.1 | `roles/defaults.ts:46-47` | U | missing access, any tool | kept | core 7 | core 7 |
| MA.2 | `roles/defaults.ts:46-47` | U | gap = operator's call; names needs_decision | kept | core 7 + mechanics (ask = needs_decision) | core 7 + mechanics |
| MA.3-4 | `roles/defaults.ts:46-47` | U |  | kept | core 7 | core 7 |
| PR.1-3 | `roles/defaults.ts:51-52` | U | project rules govern | kept | core 2 | core 2 |
| SP.1 | `roles/defaults.ts:31-32` | U | principle U; tool names D | kept | core 3 + mechanics (tool names) | core 3 + mechanics |
| HL.1 | `roles/defaults.ts:39-40` | U |  | kept | core 4 | core 4 |
| HL.2 | `roles/defaults.ts:39-40` | U | keep going | kept | core 5 | core 5 |
| HL.3 | `roles/defaults.ts:39-40` | U |  | kept | core 4 | core 4 (examples of unconfirmable facts dropped) |
| HL.4 | `roles/defaults.ts:39-40` | U | names needs_decision | kept | core 4 + mechanics | core 4 + mechanics |
| HL.5 | `roles/defaults.ts:39-40` | U |  | kept | core 4 | core 4 |
| PC.1 | `roles/defaults.ts:74-76` | U |  | kept | core 11 | core 11 |
| PC.2 | `roles/defaults.ts:74-76` | U | command examples are Linux tools | kept | core 11 (examples kept) | core 11 (examples dropped: port, name or pattern covers them) |
| PC.3 | `roles/defaults.ts:74-76` | U |  | kept | core 11 | core 11 |
| SC.1-2 | `roles/defaults.ts:56-57` | U |  | kept | core 8 | core 8 |
| FR.1-4 | `roles/defaults.ts:59-60` | U | finding vs note | kept | judging | judging |
| FR.5 | `roles/defaults.ts:59-60` | U | labels; also defined in RF.1-2 | dropped for reviewer and architect (R: RF.1-2 define the labels); kept for verifier | judging | judging |
| RV.1 | `roles/defaults.ts:62-63` | D | reviewer verdict words | kept | role | role |
| RV.2 | `roles/defaults.ts:62-63` | R | dup of SW.28 and SPW.2 | dropped (R: the stage wrapper and spawn line state it) | dropped (R) | dropped (R) |
| RB.1-8 | `roles/defaults.ts:66-67` | U | baseline before blame; tool-free | kept | BASELINE (reviewer) | BASELINE (reviewer, merger) |
| RF.1 | `roles/defaults.ts:25-26` | U | anchor on the requirement | kept | core 1 + judging (WRONG-PREMISE) | core 1 + judging |
| RF.2 | `roles/defaults.ts:25-26` | U | simplest mechanism | kept | core 9 + judging (OVER-BUILT) | core 9 + judging |
| RF.3-4 | `roles/defaults.ts:25-26` | U | rendered surfaces, when UI changes | kept | RENDERED (reviewer, architect) | RENDERED (reviewer); dropped for the architect (the visual critic judges design frames) |
| RF.5 | `roles/defaults.ts:25-26` | D | render under `$TMPDIR`, never the operator's Delegatus | kept | RENDERED + mechanics (scratch) | RENDERED |
| RD.1 | `roles/defaults.ts:90` | D | project's review-export helper | kept | role (reviewer) | dropped (core 2: the project's files name its helpers) |
| RD.2-3 | `roles/defaults.ts:90` | U | borrowed dependencies read-only | kept | role (reviewer) | role (reviewer, one sentence) |
| RD.4 | `roles/defaults.ts:90` | U |  | kept | role (reviewer) | dropped (core 7 covers an unusable dependency graph) |
| PP.1-3 | `roles/defaults.ts:131` | R | dup of stage wrapper SW.1-3 | dropped (R: the wrapper carries it, also for stored lanes) | dropped (R) | dropped (R) |
| BF.1 | `roles/defaults.ts:81` | U | finish line | kept | role (builder) + core 10 | core 10 + role (brief's finish line governs) |
| FF.1-2 | `roles/defaults.ts:82` | D | fix-round finish line | kept | APPLY-FIXES | APPLY-FIXES |
| WL.1 | `roles/defaults.ts:95` | D | worker limit for an orchestrator stage | kept | kept | kept (shortened) |
| FG.1-2 | `roles/registry.ts:117` | U | UI work, when UI changes | kept | FRONTEND | FRONTEND (shortened) |
| FX.1 | `roles/registry.ts:123` | D | fix-round self-review swap | kept | APPLY-FIXES | core 10 |
| AF.1-5 | `roles/registry.ts:106` | D | fix-round guidance | kept | APPLY-FIXES | APPLY-FIXES (shortened) |
| AF.6 | `roles/registry.ts:106` | D |  | kept | APPLY-FIXES + stage wrapper SW.22-24 | APPLY-FIXES + stage wrapper |
| AF.7-9 | `roles/registry.ts:106` | R | dup of stage wrapper SW.22-24 | dropped (R: the wrapper says it to every fix stage, stored lanes included) | dropped (R) | dropped (R) |
| AF.10 | `roles/registry.ts:106` | D |  | kept | APPLY-FIXES | APPLY-FIXES |
| SPW.1-2 | `roles/registry.ts:132` | D | spawned agent's completion | kept | spawn line (needs_decision carries no findings, stated) | spawn line (shortened) |
| SPW.3 | `roles/registry.ts:132` | D | retired markers | kept | spawn line | spawn line (marker list dropped: seats no longer write them) |
| ORC.1-2 | `roles/defaults.ts:187-191` | D |  | kept | kept | kept |
| ORCF.1 | `roles/defaults.ts:187-191` | D |  | kept | fences (edited wording) | fences (merged) |
| ORCF.2 | `roles/defaults.ts:187-191` | D | workers start fresh | kept | fences (edited wording) | fences (merged) |
| REV.1-6 | `roles/defaults.ts:8-11,206-207` | D | reviewer identity and parameters | kept | kept | kept (shortened) |
| REV.7 | `roles/defaults.ts:8-11,206-207` | U | project's checks, caches to scratch | kept | kept | kept (shortened) |
| REV.8 | `roles/defaults.ts:8-11,206-207` | U |  | kept | kept | kept |
| REVF.1-2 | `roles/defaults.ts:8-11,206-207` | D |  | kept | kept | fences (merged) |
| VER.1-6 | `roles/defaults.ts:12-15,218-219` | D | claim labels and verdicts | kept | kept | kept (shortened) |
| VER.7 | `roles/defaults.ts:12-15,218-219` | D | partly dup of SW.28 | kept | kept (unique part: unconfirmed claims and what settles them) | dropped (VER.4 + mechanics cover it) |
| VERF.1 | `roles/defaults.ts:12-15,218-219` | D |  | kept | kept | kept |
| VERF.2 | `roles/defaults.ts:12-15,218-219` | U |  | kept | kept | dropped (R: core 6) |
| BLD.1-2 | `roles/defaults.ts:232-233` | D |  | kept | kept | kept |
| BLD.3 | `roles/defaults.ts:232-233` | U | self-review | kept | kept | core 10 |
| BLD.4 | `roles/defaults.ts:232-233` | D | Delegatus preview links | kept | kept | kept |
| BLDF.1-2 | `roles/defaults.ts:232-233` | D |  | kept | kept | fences (merged) |
| ARC.1-2 | `roles/defaults.ts:244-245` | D |  | kept | kept | kept |
| ARC.3 | `roles/defaults.ts:244-245` | R | dup of ARCF.1 | dropped (R) | dropped (R) | dropped (R) |
| ARC.4 | `roles/defaults.ts:244-245` | D | declared output path | kept | kept | kept (shortened) |
| ARC.5-6 | `roles/defaults.ts:244-245` | U | quote the requirement; default no; keep deferred scope | kept | kept + core 1 | kept + core 1 |
| ARC.7-8 | `roles/defaults.ts:244-245` | D |  | kept | kept | kept |
| ARCF.1-2 | `roles/defaults.ts:244-245` | D |  | kept | kept | fences (merged) |
| CLN.1 | `roles/defaults.ts:254-255` | D |  | kept | kept | kept |
| CLN.2 | `roles/defaults.ts:254-255` | U | back up, keep siblings untouched | kept | role (classify) + core 11 + fences | role + core 11 + fences |
| CLN.3-4 | `roles/defaults.ts:254-255` | D |  | kept | kept | kept |
| CLNF.1-2 | `roles/defaults.ts:254-255` | U |  | kept | kept | fences (merged) |
| PA.1-2 | `roles/defaults.ts:266-267` | D |  | kept | kept | kept |
| PA.3 | `roles/defaults.ts:266-267` | U | named read access only | kept | kept | kept + PRODUCTION |
| PA.4 | `roles/defaults.ts:266-267` | U |  | kept | kept | kept |
| PA.5 | `roles/defaults.ts:266-267` | U |  | kept | core 6 | core 6 |
| PA.6 | `roles/defaults.ts:266-267` | U |  | kept | kept (joined to PA.3) | PRODUCTION |
| PA.7-8 | `roles/defaults.ts:266-267` | D |  | kept | kept | kept (shortened) |
| PAF.1-2 | `roles/defaults.ts:266-267` | U |  | kept | kept | fences (merged) |
| DEP.1-3 | `roles/defaults.ts:282-283` | D |  | kept | kept | kept |
| DEP.4 | `roles/defaults.ts:282-283` | U | project's release procedure | kept | kept (+ never replace a committed procedure) | kept |
| DEP.5-6 | `roles/defaults.ts:282-283` | P | this repository's deploy script and verdict files | kept (scoped: 'For a Delegatus checkout install') | project file | project file |
| DEP.7 | `roles/defaults.ts:282-283` | P |  | kept | edited to tool-free form + project file verbatim | edited + project file |
| DEP.8 | `roles/defaults.ts:282-283` | U | keep current version serving | kept | kept | PRODUCTION + kept |
| DEP.9-10 | `roles/defaults.ts:282-283` | D | seat-quoted approval; release.askBeforePublish | kept | kept | kept (shortened) |
| DEP.11 | `roles/defaults.ts:282-283` | U | plan, validate, present, stop | kept | kept | kept |
| DEP.12 | `roles/defaults.ts:282-283` | U | stop conditions | kept | kept | PRODUCTION + kept |
| DEP.13 | `roles/defaults.ts:282-283` | D |  | kept | kept | kept |
| DEPF.1-3 | `roles/defaults.ts:282-283` | D |  | kept | kept | fences (merged) |
| MRG.1-2 | `roles/defaults.ts:291-296` | D |  | kept | kept | kept |
| MRG.3-6 | `roles/defaults.ts:291-296` | D | GitHub review states; the rule itself is universal | kept | kept (rule stated tool-free, GitHub fields kept) | kept (one sentence) |
| MRG.7-8 | `roles/defaults.ts:291-296` | P | scripts/merge-batch.ts | kept (the role runs only where the script exists) | project file | project file |
| MRG.9 | `roles/defaults.ts:291-296` | D |  | kept | kept | project file |
| MRG.10 | `roles/defaults.ts:291-296` | P |  | kept | project file | project file |
| MRG.11 | `roles/defaults.ts:291-296` | U |  | kept | kept | project file |
| MRG.12 | `roles/defaults.ts:291-296` | D |  | kept | kept | kept (merged) |
| MRG.13 | `roles/defaults.ts:291-296` | P | resolve N | kept | kept (tool-free) + project file | project file |
| MRG.14 | `roles/defaults.ts:291-296` | D |  | kept | kept | kept (merged) + project file |
| MRG.15 | `roles/defaults.ts:291-296` | U | one validation per exact tuple | kept | kept | kept (merged) |
| MRG.16 | `roles/defaults.ts:291-296` | P |  | kept | kept (tool-free) + project file | project file |
| MRG.17-22 | `roles/defaults.ts:291-296` | P | gate internals of merge-batch.ts | kept | project file | project file |
| MRG.23 | `roles/defaults.ts:291-296` | U | pre-existing failures | kept | kept | BASELINE |
| MRG.24 | `roles/defaults.ts:291-296` | P |  | kept | kept (joined to MRG.23) | BASELINE |
| MRG.25-28 | `roles/defaults.ts:291-296` | P | confirmation and removal-probe protocol | kept | project file | project file |
| MRG.29 | `roles/defaults.ts:291-296` | U | never guess a culprit | kept | kept | kept |
| MRG.30 | `roles/defaults.ts:291-296` | P | stale reviewed detector exception | kept | project file | project file |
| MRG.31 | `roles/defaults.ts:291-296` | U |  | kept | kept | project file |
| MRG.32 | `roles/defaults.ts:291-296` | D |  | kept | kept | kept (shortened) |
| MRG.33 | `roles/defaults.ts:291-296` | U | append-only attribution log | kept | kept (shortened) + project file | project file |
| MRG.34-37 | `roles/defaults.ts:291-296` | D |  | kept | kept | project file |
| MRG.38-39 | `roles/defaults.ts:291-296` | D |  | kept | kept | kept |
| MRGF.1-4 | `roles/defaults.ts:291-296` | D |  | kept | kept (MRGF.3-4 joined) | fences (merged) |
| MRGF.5 | `roles/defaults.ts:291-296` | U | public text carries no identities | kept | core 12 | core 12 |
| MRGF.6 | `roles/defaults.ts:291-296` | D |  | kept | kept | fences (merged) |
| MRGF.7 | `roles/defaults.ts:291-296` | D |  | kept | kept | kept (merged into the body) |
| MNT.1-5 | `roles/defaults.ts:108-129,303-304` | D |  | kept | kept | kept (shortened) |
| MNT.6 | `roles/defaults.ts:108-129,303-304` | P | gh needs the network; DNS retries on this machine | kept | edited (transient network error; forge tool) | edited |
| MNT.7 | `roles/defaults.ts:108-129,303-304` | D | refused writes enumerated | kept | kept | edited: 'Delegatus refuses every other write' (enforced in src/lib/boardMaintenance/guard.ts) |
| MNT.8 | `roles/defaults.ts:108-129,303-304` | D |  | kept | kept | step 5 |
| MNT.9 | `roles/defaults.ts:108-129,303-304` | U | a refusal is an answer | kept | kept | kept |
| MNT.10-13 | `roles/defaults.ts:108-129,303-304` | D |  | kept | kept | step 1 (shortened) |
| MNT.14-16 | `roles/defaults.ts:108-129,303-304` | D |  | kept | kept | step 2 (shortened) |
| MNT.17-18 | `roles/defaults.ts:108-129,303-304` | D |  | kept | edited (gh -> the forge) | step 2 + tool desc: list_pipelines |
| MNT.19 | `roles/defaults.ts:108-129,303-304` | D |  | kept | kept | step 3 (shortened) |
| MNT.20-23 | `roles/defaults.ts:108-129,303-304` | U | liveness by evidence | kept | kept | step 4 (shortened) |
| MNT.24 | `roles/defaults.ts:108-129,303-304` | D |  | kept | kept | step 10 |
| MNT.25-27 | `roles/defaults.ts:108-129,303-304` | D |  | kept | kept | step 5 (shortened) |
| MNT.28-32 | `roles/defaults.ts:108-129,303-304` | D |  | kept | kept | step 6 (shortened) |
| MNT.33 | `roles/defaults.ts:108-129,303-304` | R | 'blocked' contradicts the task hold the tool asks for | edited (hold) | edited (hold) | step 6 |
| MNT.34 | `roles/defaults.ts:108-129,303-304` | R | 'Blocked:' details line contradicts update_task hold | edited (hold with kind and reason) | edited (hold) | step 6 |
| MNT.35-41 | `roles/defaults.ts:108-129,303-304` | D |  | kept | kept | step 6 (shortened) |
| MNT.42 | `roles/defaults.ts:108-129,303-304` | P | this repository's batch-merge comment form | kept | edited (tool-free) | step 7 |
| MNT.43-46 | `roles/defaults.ts:108-129,303-304` | D |  | kept | kept | step 7 (shortened) |
| MNT.47 | `roles/defaults.ts:108-129,303-304` | D |  | kept | kept | dropped (the maintenance brief states how the project ships) |
| MNT.48 | `roles/defaults.ts:108-129,303-304` | P | Ukrainian literals for one operator's locale | kept (the brief adds 'localize') | edited; the literal stays in the maintenance brief (src/lib/boardMaintenance/text.ts:74) | edited; brief |
| MNT.49-50 | `roles/defaults.ts:108-129,303-304` | D |  | kept | kept | step 7 |
| MNT.51-56 | `roles/defaults.ts:108-129,303-304` | D | nothing closes to tidy up | kept | kept | step 8 (shortened) |
| MNT.57-60 | `roles/defaults.ts:108-129,303-304` | D |  | kept | kept | step 9 (shortened) |
| MNT.61-70 | `roles/defaults.ts:108-129,303-304` | D | attention and left lines | kept | kept | step 10 (shortened) |
| MNTF.1-4 | `roles/defaults.ts:108-129,303-304` | D |  | kept | kept (gh -> the forge's tool) | fences (merged) |
| CUR.1 | `roles/defaults.ts:312-313` | D |  | kept | kept | kept |
| CUR.2 | `roles/defaults.ts:312-313` | R | repeats CURF.2 | edited (curate_rules clause left to the fence) | edited | edited |
| CUR.3-5 | `roles/defaults.ts:312-313` | D |  | kept | kept | kept |
| CUR.6 | `roles/defaults.ts:312-313` | D |  | kept | fences | fences |
| CURF.1-2 | `roles/defaults.ts:312-313` | D |  | kept | kept | fences (merged) |
| IR.1-6 | `roles/defaults.ts:136-148,320-321` | D |  | kept | kept | kept (shortened) |
| IR.7 | `roles/defaults.ts:136-148,320-321` | U | observation vs inference | kept | core 6 | core 6 |
| IR.8-11 | `roles/defaults.ts:136-148,320-321` | D |  | kept | kept | kept (shortened) |
| IR.12-14 | `roles/defaults.ts:136-148,320-321` | D | pinned scrub rule (ISSUE_REPORT_SCRUB_RULE); principle in core 12 | kept | kept | kept verbatim |
| IR.15-18 | `roles/defaults.ts:136-148,320-321` | U | detector hints are pointers | kept | kept | step 5 (shortened) |
| IR.19-25 | `roles/defaults.ts:136-148,320-321` | D |  | kept | kept | kept (shortened) |
| IRF.1-3 | `roles/defaults.ts:136-148,320-321` | D |  | kept | kept | fences (merged) |
| VC.1-4 | `roles/defaults.ts:156-167,328-329` | D |  | kept | kept | kept (shortened) |
| VC.5 | `roles/defaults.ts:156-167,328-329` | U | existing drivers, from an export | kept | edited (+ as the project's files name them) | edited |
| VC.6-7 | `roles/defaults.ts:156-167,328-329` | P | this repository's driver paths and isolation recipe | project file; replaced by 'the drivers and isolated state the project's files name' | project file | project file |
| VC.8 | `roles/defaults.ts:156-167,328-329` | P | widths U; 'en and uk' P | edited (every language and theme the project ships); en/uk to project file | edited | edited |
| VC.9 | `roles/defaults.ts:156-167,328-329` | D | pinned VISUAL_CRITIC_UNFRAMED | kept | kept | kept |
| VC.10 | `roles/defaults.ts:156-167,328-329` | U |  | kept | kept | kept |
| VC.11-14 | `roles/defaults.ts:156-167,328-329` | D | pinned VISUAL_CRITIC_CLASSES | kept | kept | kept |
| VC.15 | `roles/defaults.ts:156-167,328-329` | U |  | kept | kept | kept |
| VC.16-18 | `roles/defaults.ts:156-167,328-329` | D |  | kept | kept | kept (shortened) |
| VC.19 | `roles/defaults.ts:156-167,328-329` | R | dup of process cleanup PC.1 | dropped (R) | dropped (R: core 11) | dropped (R: core 11) |
| VC.20 | `roles/defaults.ts:156-167,328-329` | D |  | kept | kept | kept |
| VCF.1 | `roles/defaults.ts:156-167,328-329` | D |  | kept | kept | kept |
| VCF.2 | `roles/defaults.ts:156-167,328-329` | D | dup of VC.11 | kept | kept | dropped (R: VC.11) |
| M00.1 | `orchestrator/prompt.ts:425` | D |  | kept | kept | edited (shortened) |
| M00.2 | `orchestrator/prompt.ts:425` | D | repeated by M18.2-3 | edited (+ no direct process or runtime manipulation) | edited (+ the working rules apply) | edited |
| M01.1-2 | `orchestrator/prompt.ts:408-409` | D | seat persona (product default) | kept | kept | kept (shortened) |
| M01.3 | `orchestrator/prompt.ts:408-409` | U | mirror the person's language and register | kept | kept | kept |
| M01.4-6 | `orchestrator/prompt.ts:408-409` | D | proactive and its boundary | kept | edited (one definition, merged with M08.11 and M16.5) | edited |
| M02.1-11 | `orchestrator/prompt.ts:117,131-135` | D | delivered whole-text marker | kept | kept | edited (shortened) |
| M03.1 | `orchestrator/prompt.ts:431-433` | D | heading | kept | M:Reaching the operator | M:Reaching the operator |
| M03.2-4 | `orchestrator/prompt.ts:431-433` | D |  | kept | M:Reaching the operator (Chat) | Chat bullet (shortened) |
| M03.5-6 | `orchestrator/prompt.ts:431-433` | D |  | kept | M:Reaching the operator (Bridge reports) | dropped (bridge_report's description names the gateway) |
| M03.7 | `orchestrator/prompt.ts:431-433` | U | an unreported outcome reached nobody | kept | Chat | Chat bullet |
| M04.1 | `orchestrator/prompt.ts:435-439` | D | heading | kept | M:Reaching the operator | M:Reaching the operator |
| M04.2-5 | `orchestrator/prompt.ts:435-439` | D |  | kept | Bridge reports | Bridge reports bullet (shortened) + tool desc: bridge_report |
| M04.6-7 | `orchestrator/prompt.ts:435-439` | D |  | kept | Bridge reports | tool desc: bridge_report |
| M04.8-9 | `orchestrator/prompt.ts:435-439` | D |  | kept | Bridge reports | Bridge reports bullet + tool desc: bridge_report |
| M04.10 | `orchestrator/prompt.ts:435-439` | U | nothing changed, no report | kept | Bridge reports | Bridge reports bullet |
| M04.11 | `orchestrator/prompt.ts:435-439` | D | report classes | kept | Bridge reports | tool desc: bridge_report |
| M05.1-4 | `orchestrator/prompt.ts:441-442` | D |  | kept | M:Reaching the operator (Directives) | Directives bullet (shortened) |
| M06.1-2 | `orchestrator/prompt.ts:444-448` | D |  | kept | Attention | Attention bullet + tool desc: request_attention |
| M06.3-7 | `orchestrator/prompt.ts:444-448` | D |  | kept | Attention | tool desc: request_attention (when and when not) |
| M06.8 | `orchestrator/prompt.ts:444-448` | D |  | kept | Attention | dropped (the tool schema states the target kinds) |
| M07.1-3 | `orchestrator/prompt.ts:450-452` | D | decisions are forms; overlaps M18.7 | kept | Decisions | Decisions bullet |
| M07.4 | `orchestrator/prompt.ts:450-452` | D |  | kept | Reply drafts | drafts bullet |
| M07.5-8 | `orchestrator/prompt.ts:450-452` | D |  | kept | Reply drafts | tool desc: suggest_replies |
| M08.1 | `orchestrator/prompt.ts:164-223` | D | delivered heading marker | kept | kept | kept |
| M08.2-3 | `orchestrator/prompt.ts:164-223` | D |  | kept | kept | kept (shortened) |
| M08.4 | `orchestrator/prompt.ts:164-223` | D | names Claude-only tools (ScheduleWakeup, CronCreate, Monitor) | kept | edited (tool-free: no wakeup, cron job or monitor loop your engine offers) | edited |
| M08.5 | `orchestrator/prompt.ts:164-223` | D |  | kept | kept (shortened) | merged |
| M08.6-9 | `orchestrator/prompt.ts:164-223` | R | the v11 handover; CronDelete and CronList are Claude-only | kept | edited (one sentence, tool-free) | edited (one sentence) |
| M08.10 | `orchestrator/prompt.ts:164-223` | D |  | kept | kept | kept |
| M08.11 | `orchestrator/prompt.ts:164-223` | R | third statement of 'proactive' | kept | M:Who you are | M:Who you are |
| M08.12-13 | `orchestrator/prompt.ts:164-223` | D | pinned tick-contract clauses | kept | kept | kept |
| M08.14 | `orchestrator/prompt.ts:164-223` | R | 'mark blocked' predates the task hold | kept | edited (set its task's hold with the reason) | edited |
| M08.15-16 | `orchestrator/prompt.ts:164-223` | D | pinned tick-contract clauses | kept | kept | kept |
| M08.17 | `orchestrator/prompt.ts:164-223` | D |  | kept | kept | kept (shortened) |
| M09.1-7 | `orchestrator/prompt.ts:259-260` | D |  | kept | kept | kept (shortened) |
| M10.1 | `orchestrator/prompt.ts:458-459` | D | heading | kept | M:Before you decide | M:Before you decide |
| M10.2 | `orchestrator/prompt.ts:458-459` | D | what Delegatus indexes | kept | kept | dropped (search_transcripts' description says it) |
| M10.3 | `orchestrator/prompt.ts:458-459` | U | 3 to 5 phrasings, scoped then unscoped | kept | kept | kept |
| M10.4 | `orchestrator/prompt.ts:458-459` | D |  | kept | kept | kept (byte-offset detail left to the tool description) |
| M10.5 | `orchestrator/prompt.ts:458-459` | U | cite by title and date | kept | kept | kept |
| M10.6 | `orchestrator/prompt.ts:458-459` | U |  | kept | core 3 | core 3 |
| M11.1 | `orchestrator/prompt.ts:461-466` | D | heading | kept | M:Before you decide | M:Before you decide |
| M11.2-3 | `orchestrator/prompt.ts:461-466` | U |  | kept | core 4 | core 4 |
| M11.4 | `orchestrator/prompt.ts:461-466` | U | an unobserved external fact is step one | kept | kept | kept |
| M11.5 | `orchestrator/prompt.ts:461-466` | D |  | kept | Decisions (publish its form at once) | Decisions bullet |
| M11.6 | `orchestrator/prompt.ts:461-466` | U | check the visible result after deploy | kept | kept | kept |
| M11.7 | `orchestrator/prompt.ts:461-466` | U |  | kept | kept + core 5 | Chat bullet + core 5 |
| M11.8 | `orchestrator/prompt.ts:461-466` | U |  | kept | core 5 | core 5 |
| M12.1 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D | delivered heading marker | kept | kept | kept |
| M12.2-4 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | U | one outcome, one task | kept | kept | bullet 1 |
| M12.5-6 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D |  | kept | kept | bullet 2 |
| M12.7-9 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D | list_tasks mechanics | kept | kept | tool desc: list_tasks |
| M12.10-11 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D |  | kept | kept | bullet 2 |
| M12.12 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D |  | kept | kept | bullet 3 |
| M12.13 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D | already in create_task's description | kept | kept | tool desc: create_task (already there) |
| M12.14 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D |  | kept | kept | bullet 3 + tool desc: create_task |
| M12.15-16 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D |  | edited (points to create_task's colour rule) | merged into NAME paragraph | bullet 3 |
| M12.17 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | R | the colour rule repeats create_task's description | dropped (R) | dropped (R) | dropped (R) |
| M12.18 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | R | text vs details: create_task, update_task and the MCP instructions say it | kept | edited (pointer) | bullet 3 |
| M12.19 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | R |  | kept | dropped (R: create_task's description) | dropped (R) |
| M12.20 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D |  | kept | kept | tool desc: create_task |
| M12.21-25 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D | binding at reservation | kept | kept | bullet 4 + tool desc: create_pipeline, spawn_agent |
| M12.26-32 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D |  | kept | kept | bullet 4 + tool desc: create_pipeline, spawn_agent |
| M12.33-34 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D |  | kept | kept | bullet 5 |
| M12.35 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D |  | kept | kept | bullet 5 + tool desc: create_pipeline |
| M12.36-38 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D | placeholder repair | kept | kept | bullet 6 + tool desc: pipeline_action, link_task_to_pipeline |
| M12.39-42 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | D |  | kept | kept | bullet 7 + tool desc: get_task, pipeline_action |
| M12.43-44 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | U | no two live claims for one outcome | kept | kept | bullet 8 |
| M12.45 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | R | 'mark blocked' predates the task hold | kept | edited (hold) | bullet 8 |
| M12.46 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | U | never close in bulk to tidy | kept | kept | bullet 8 |
| M12.47-51 | `orchestrator/prompt.ts:358-383; src/lib/tasks/colorRule.ts:10-24` | U | idempotent retries keep their key | kept | kept | bullet 9 (shortened) |
| M13.1-3 | `orchestrator/prompt.ts:470-484` | D |  | kept | kept | bullet 1 |
| M13.4 | `orchestrator/prompt.ts:470-484` | D |  | kept | kept | bullet 2 |
| M13.5-7 | `orchestrator/prompt.ts:470-484` | D |  | kept | kept (sizing and composition in one bullet) | bullet 3 |
| M13.8-9 | `orchestrator/prompt.ts:470-484` | R | the fixer's own guidance (APPLY-FIXES) restated for the seat | kept | dropped (R: APPLY-FIXES) | dropped (R) |
| M13.10 | `orchestrator/prompt.ts:470-484` | D |  | kept | kept | bullet 3 |
| M13.11-13 | `orchestrator/prompt.ts:470-484` | D |  | kept | kept | bullet 4 (shortened) |
| M13.14 | `orchestrator/prompt.ts:470-484` | U | quote the requirement verbatim with its date | kept | kept | bullet 4 |
| M13.15-17 | `orchestrator/prompt.ts:470-484` | D |  | kept | kept | bullet 4 |
| M13.18-20 | `orchestrator/prompt.ts:470-484` | D |  | kept | kept | bullet 5 |
| M13.21-26 | `orchestrator/prompt.ts:470-484` | D | merge bar | kept | kept | merge-bar bullet (shortened) |
| M13.27-28 | `orchestrator/prompt.ts:470-484` | D |  | kept | kept | kept |
| M13.29-30 | `orchestrator/prompt.ts:470-484` | R | one rule on two lines | merged | merged | merged |
| M14.1 | `orchestrator/prompt.ts:486-492` | D | heading | kept | kept | merged into M:How work runs |
| M14.2-4 | `orchestrator/prompt.ts:486-492` | D | stage shape and graph edits | kept | kept | tool desc: create_pipeline, pipeline_action |
| M14.5-9 | `orchestrator/prompt.ts:486-492` | D | review edges | kept | kept | review bullet (shortened) + tool desc: pipeline_action |
| M14.10 | `orchestrator/prompt.ts:486-492` | R | misplaced in the stage contract | moved to the prototype directive | Decisions | tool desc: publish_prototype_review |
| M14.11-12 | `orchestrator/prompt.ts:486-492` | R | misplaced: reporting rules in the stage contract | moved to Bridge reports | Bridge reports | tool desc: bridge_report |
| M14.13 | `orchestrator/prompt.ts:486-492` | R | misplaced; repeats core 4 | moved to Bridge reports | dropped (R: core 4) | dropped (R: core 4) |
| M14.14 | `orchestrator/prompt.ts:486-492` | U | risk = consequences x probability; 'runtime host' is P | edited (the project's critical runtime) | edited | review bullet |
| M14.15-17 | `orchestrator/prompt.ts:486-492` | D |  | kept | kept | review bullet |
| M14.18 | `orchestrator/prompt.ts:486-492` | D |  | kept | kept | tool desc: create_pipeline |
| M15.1-5 | `orchestrator/prompt.ts:494-495` | D |  | kept | M:Pipeline stage contract (Finishing a task) | finishesTask bullet + tool desc: pipeline_action |
| M16.1 | `orchestrator/prompt.ts:497-499` | D | heading | kept | merged into M:How work runs | merged |
| M16.2 | `orchestrator/prompt.ts:497-499` | D |  | kept | Start-by-default bullet | bullet 1 |
| M16.3-4 | `orchestrator/prompt.ts:497-499` | D |  | kept | Start-by-default bullet | bullet 1 + tool desc: create_pipeline |
| M16.5 | `orchestrator/prompt.ts:497-499` | R | second statement of 'proactive' | kept | M:Who you are | M:Who you are |
| M17.1-9 | `orchestrator/prompt.ts:287-290` | D | delivered whole-text marker | kept | kept | edited (shortened) |
| M18.1 | `orchestrator/prompt.ts:503-509,415` | D | heading | kept | kept | kept |
| M18.2-3 | `orchestrator/prompt.ts:503-509,415` | R | repeats M00.2 | merged into M00.2 | merged into M00.2 | merged into M00.2 |
| M18.4-5 | `orchestrator/prompt.ts:503-509,415` | D |  | kept | kept | kept (shortened) |
| M18.6 | `orchestrator/prompt.ts:503-509,415` | U | re-derive state from sources each turn | kept | kept | kept (shortened) |
| M18.7-12 | `orchestrator/prompt.ts:503-509,415` | D | delivered prototype directive (whole-text marker) | kept (+ M14.10) | Decisions | Decisions bullet (shortened) |
| M19.1-2 | `orchestrator/prompt.ts:555-576` | D |  | kept | kept | kept |
| M19.3-19 | `orchestrator/prompt.ts:555-576` | D | generated from the live registry | kept | kept | kept |
| M19.20-21 | `orchestrator/prompt.ts:555-576` | D |  | kept | kept | kept (merged) |
| M19.22-23 | `orchestrator/prompt.ts:555-576` | D |  | kept | kept | kept (shortened) |
| M19.24 | `orchestrator/prompt.ts:555-576` | R | 'Opus review-loop' contradicts M14.17 (do not compose review-loop) | edited (reviewer stage with its fix stage) | edited | edited |
| M19.25-27 | `orchestrator/prompt.ts:555-576` | R | dup of M13.7-9 | dropped (R) | dropped (R) | dropped (R) |
| M19.28 | `orchestrator/prompt.ts:555-576` | D |  | kept | kept | kept (shortened) |
| M19.29 | `orchestrator/prompt.ts:555-576` | P | 'deploy/runtime host' names this repository | edited (the project's critical runtime) | edited | edited |
| M19.30-33 | `orchestrator/prompt.ts:555-576` | D |  | kept | kept | kept (shortened) |
| M19.34 | `orchestrator/prompt.ts:555-576` | D |  | kept | kept | merged with M19.21 |
| SW.1-4 | `pipelines/prompts.ts:61-125; src/lib/pipelines/testGuidance.ts:21,30` | D | prototype lane; read by every stage today | kept | kept, prototype-capable stages only | kept, prototype-capable stages only |
| SW.5-16 | `pipelines/prompts.ts:61-125; src/lib/pipelines/testGuidance.ts:21,30` | D | access, host, base, branch, nesting | kept | kept | kept |
| SW.17 | `pipelines/prompts.ts:61-125; src/lib/pipelines/testGuidance.ts:21,30` | P | LLV_STATE_DIR is this repository's variable, shown to every project | edited (any state-directory variable the project names) | edited | edited |
| SW.18-20 | `pipelines/prompts.ts:61-125; src/lib/pipelines/testGuidance.ts:21,30` | D |  | kept | kept | kept |
| SW.21 | `pipelines/prompts.ts:61-125; src/lib/pipelines/testGuidance.ts:21,30` | D | retired markers | kept | kept | edited (shortened marker list) |
| SW.22-24 | `pipelines/prompts.ts:61-125; src/lib/pipelines/testGuidance.ts:21,30` | D | blocked fix stage; read by every stage today | kept | kept, fix stages only | kept, fix stages only |
| SW.25-35 | `pipelines/prompts.ts:61-125; src/lib/pipelines/testGuidance.ts:21,30` | D |  | kept | kept | kept |
| SWD.1 | `pipelines/prompts.ts:20-29` | U | the operator's answer governs | kept | kept + core precedence | kept + core precedence |
| SWD.2 | `pipelines/prompts.ts:20-29` | D |  | kept | kept | kept |
| LR.1-2 | `memory/roleRender.ts:9-16,47-58` | D |  | kept | kept | kept |
| LR.3 | `memory/roleRender.ts:9-16,47-58` | R | precedence restated per block; core states it once | kept | edited (yield to every other instruction) | edited |
| LR.4-20 | `memory/roleRender.ts:9-16,47-58` | D | levels, headings, pointers | kept | kept | kept |
| LQ.1-7 | `memory/roleRender.ts:72-110` | D |  | kept | kept | kept |
| LQ.8 | `memory/roleRender.ts:72-110` | D |  | kept | edited (+ the working rules) | edited |
| LQ.9-23 | `memory/roleRender.ts:72-110` | D | levels role / role on every project / project / machine | kept | kept | kept (+ a universal line after LQ.23) |
| LQ.24-46 | `memory/roleRender.ts:72-110` | D |  | kept | kept | kept |

---

# 6. Questions for the operator

For the decision form the publish stage builds (3–7 questions, one
recommended option each, free text allowed).

1. **Which rewrite?** (Яку версію переписування беремо?)
   1 conservative · **2 balanced (recommended)** · 3 aggressive · a mix
   (say which parts).
2. **Which borderline rules join the universal core?** (Які правила на
   межі зробити універсальними?) Multi-select:
   **public text names nobody (recommended)** · **process cleanup with
   concrete command examples (recommended)** · **"the default answer to
   'should we build this' is no" for every role (recommended)** · the six
   server-engineering rules now at this project's level, as a conditional
   block "when the work touches a long-lived server" · the tool-free learned
   rules listed in §2.5.
3. **Where do universal rules live?** (Де живуть універсальні правила?)
   **shipped core in Delegatus, changed by reviewed pull requests; the
   curator proposes promotions from learned rules (recommended)** · a new
   learned-rule level "universal" the curator fills with the operator's
   approval · each engine's own global instruction file on this machine.
4. **What stays word for word?** (Що лишити дослівно?) Multi-select:
   **the seat's "Who you are" (recommended)** · **the review labels
   WRONG-PREMISE and OVER-BUILT (recommended)** · the clock section · the
   task-ownership section · nothing beyond the pinned texts.
5. **This repository's own procedures** (merge-batch protocol, deploy
   script, browser drivers) (Процедури саме цього репозиторію):
   **move to this repository's instruction files; shipped roles become
   generic (recommended)** · keep them in the shipped prompts.
6. **Size budget for V2** (Розмір V2): **accept +23% of role text for full
   coverage; the mandate shrinks 11% (recommended)** · cap the core at
   today's shared-block size by moving principles 9, 10 and 12 into the
   roles that use them.

---

# Deferred — not currently justified

- Rewriting the MCP server instructions and tool descriptions (except the
  `pipeline_action` contradiction, which the fix lane can correct on its
  own), the seat-tick wake, the rotation handoff, the maintenance and
  curator briefs, and the voice coordinator mandate.
- A fifth learned-rule level outside V3, and promoting any learned rule now;
  the curator acts after question 3 is answered.
- Removing the merger role from installs without a batch procedure.
- Translating agent-facing text; it stays English, as today.
- Per-engine variants of the core.

# Validation against the requirement

| operator's words | where this answers |
| --- | --- |
| «как переписать … роли, наш промпты ролей. И мандат оркестратора» | §1 inventories all 13 roles and their variants, the shared blocks, the stage wrapper, the mandate by section and the learned-rule framing; §3 rewrites each in three variants |
| «не упустить ничего важного» | §5 and `traceability.tsv`: 676 sentences, each with a home or a stated reason; `project-files/AGENTS.additions.txt` and `v3/tool-descriptions.txt` hold moved text verbatim |
| «то, что может касаться всех проектов, всех людей в любых задачах … вынести» | §2.2 finds 15 universal principles and who lacks them; §3.3 makes them one core every agent reads |
| «без привязки к какому-то конкретному инструменту или фреймворку», «абстрактні правила» | the core names no tool; §2.3 lists 28 project or tool-bound sentences and where each goes |
| «показать мне … до и после … в виде diff», «читабельно» | `before/` and `v1/`, `v2/`, `v3/` hold the same file names, so each pair diffs mechanically for the prototype stage |

# Files

```
docs/design/role-prompts-rewrite/
  before/roles/*.txt            current scaffold + fences per role and variant
  before/shared/*.txt           each shared block alone
  before/mandate.txt            delivered mandate v54 with the shipped role table
  before/mandate/NN-*.txt       the same, one file per section
  before/stage-wrapper.*.txt    stage wrapper, read-only and read-write
  before/stage-decision-continuation.txt
  before/memory/*.txt           learned-rule framing (stage, seat, maintainer) and the lesson request
  v1/ v2/ v3/                   the same file names as before/ for roles/, mandate.txt,
                                stage-wrapper.*.txt and memory/
  v2/ v3/ core.txt judging.txt mechanics.txt spawn-completion.txt
  v3/tool-descriptions.txt      text V3 moves into tool descriptions
  project-files/AGENTS.additions.txt   text every variant moves into this repository's files
  traceability.tsv              one row per sentence
```

`v1/`, `v2/` and `v3/` role files are the full text a role would receive, so
`diff before/roles/reviewer.txt v2/roles/reviewer.txt` shows the whole
change. Wrapper paragraphs that V2 and V3 show only to some stages carry a
leading `[only for …]` tag in the file.
