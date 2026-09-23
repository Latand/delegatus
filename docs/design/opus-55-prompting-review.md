# Opus 5.5 prompting review: the mandate, role prompts and agent-facing text

## Originating requirement

Pipeline pinned specification, 2026-09-24 (the operator's own message was not
available to this stage; this is the spec the seat wrote from it):

> The operator asks whether Anthropic's post "Getting the most out of Opus 5.5"
> (https://claude.dev/blog/getting-the-most-out-of-opus-5-5/) holds anything
> worth applying to the agent-facing text this product ships.

The deliverable is a ranked list of concrete changes small enough for one or
two PRs, a list of what to leave alone, and an estimate of mandate bytes saved.
The default answer is "change nothing". A proposal below exists only where the
post names a behaviour our text gets wrong or leaves out, and where it cites
file:line on current main (`1ab574c36`, 0 commits behind `origin/main` when
this was written).

## Source and prior work

- **The post.** Fetched on 2026-09-24 with WebFetch, and the raw HTML with
  `curl` so the quotes are exact. It is by Addy Osmani, published 2026-09-22,
  titled "Getting the most out of Opus 5.5 in Claude and Claude Code". Every
  quote below comes from that fetch. Nothing comes from memory of other posts.
- **Prior work.** `search_transcripts` found no earlier review of this post.
  Relevant earlier work does exist:
  - `docs/audits/orchestrator-context-and-latency.md` (2026-09-22) measured
    seat context. Its S3 "read-back rule" and its mandate/tool duplication
    findings are still open on main, and proposal 7 builds on them.
  - #2030 ("seat context diet 1") moved the tick contract into the mandate and
    added the version-bump fingerprint test. Any mandate edit below has to
    follow that mechanism.
  - A review-stage prompt that a seat wrote on 2026-09-22 asked for
    "stage_report and fenced JSON verdict" together. #1797 removed that pairing
    from the controller because it caused unreadable-verdict parks. The skill
    line behind it is proposal 5.
- **A search that came back empty.** The phrases "Shall I proceed" and "Want me
  to continue" match only the mandate's own text, never a stage's final
  message. So the stop behaviour the post describes has **not been observed**
  in our stages. Proposals 1 and 2 are preventive, and they are ranked high
  because of what such a stop costs here (see 1).

## 1. What the post recommends

Short quotes, each followed by what it means for us.

| # | The post says | Where we stand |
|---|---|---|
| G1 | "Say what “done” looks like, then let it run"; give the whole task with its finish line in one message. | The stage prompt carries the pinned spec. The **builder scaffold names no finish line** (`src/lib/roles/defaults.ts:99`). |
| G2 | "Delete “think carefully” lines. Opus 5.5 already thinks before every reply." To change how hard it thinks, "change effort". | **None exist.** A grep for think carefully/hard/step by step/ultrathink over `src/lib`, `AGENTS.md` and `.claude/skills` finds nothing. Effort is already a launch parameter (`prompt.ts:385`). |
| G3 | On long work Opus 5.5 "sometimes stops to report instead of going on": a summary that names the next step without taking it, or an offer to continue. "It follows instructions that name these stops." | **Nothing names these stops.** `HUMAN_IN_THE_LOOP` (`defaults.ts:29`) and the mandate's "Human in the loop" (`prompt.ts:323-327`) say when to stop. Neither says to keep going. The mandate even lists "a status that ends in "shall I"" as a normal thing to send (`prompt.ts:315`). |
| G4 | With a keep-going rule, "keep your own check before anything risky or hard to undo". | **Already covered.** Process cleanup by recorded PID (`defaults.ts:38`), the deployer's per-step approval (`defaults.ts:146`), the cleaner's backup rule (`defaults.ts:121`), the conveyor's data-safety rules (`delegatus-conveyor/SKILL.md:65-69`). |
| G5 | Split big audits across subagents and "check its evidence before you accept it". | Covered differently on purpose. Fan-out runs as visible pipeline stages, and reviewers are terminal (#393, `delegatus-conveyor/SKILL.md:28-32`). |
| G6 | Keep the task list in a file, because "A list in a file survives" the summarizing that long runs trigger. | The seat does this: board tasks and their `details` hold its list, and it re-derives state every turn (`prompt.ts:349`). The mandate arrives as a **message** (`seatCommand.ts:853`), so compaction summarizes it along with everything else. That makes its length matter (proposal 7). |
| G7 | Read first what the run needs from you. | Covered. `stage_report` has `needs_decision`, bridge reports have `blocked`/`question`, and the seat has `suggest_replies`. |
| G8 | Review prompt: list only merge-blocking problems, each with file and line, why it's wrong, and "how to show it fails". | Our reviewers ask for file:line and a fix plan (`defaults.ts:74`, `flows/prompts.ts:48`). **Neither asks how to show the failure.** |
| G9 | "Mark anything you couldn’t confirm, and say where you looked". | The verifier asks for "missing evidence" (`defaults.ts:86`). The prod-auditor asks for nothing like it (`defaults.ts:133`). Neither asks where the agent looked. |
| G10 | For design work, name the styles you don't want. A general instruction like "avoid a generic look" "mostly swaps one default for another". | The frontend builder's guidance is general in exactly that way (`registry.ts:79`). |
| G11 | In long chats, you can tell it earlier answers are settled. "Leave it out of projects for long analysis". | See "What not to change". |
| G12 | Remove requests to reproduce its reasoning in the reply; such a request can be flagged. | **None exist.** A grep for chain of thought/show your reasoning/explain your reasoning finds nothing. |
| G13 | Flagged messages move to an older model; fast mode; attach screenshots. | These are harness and operator settings, not text we ship. Deferred, below. |

The post says nothing about capitalisation, emphasis or prompt length. The
spec asked about "shouting" and verbosity, and I judged those on our own
evidence: the audit's byte counts and duplication I found in the code. I do not
attribute that judgement to the post.

One caveat covers every role proposal. Most roles default to **Codex** today:
reviewer, verifier and builder run `gpt-6-astra`, and cleaner and deployer run
`gpt-5.6-terra` (`defaults.ts:67-141`). The post is about Opus 5.5. Those
scaffolds still reach Opus whenever an install maps a role to Claude, and
architect, orchestrator and frontend builder run on Opus by default. So every
proposal here is engine-neutral wording, and none of it is a Claude-only trick.

## 2. Ranked proposals

Two PRs:

- **PR A, no mandate version bump.** Role scaffolds, the flow reviewer prompt,
  and the two skills. That covers proposals 1b, 3, 4, 5, 6, 8 and 9.
- **PR B, mandate v23.** Everything that edits `ORCHESTRATOR_SYSTEM_PROMPT` or
  a delivered directive: proposals 1a, 2 and 7. It must bump
  `ORCHESTRATOR_PROMPT_VERSION` to 23 and add the v23 fingerprint in
  `prompt.test.ts` (#2030). Without the bump the text reaches no seat.

### 1. Name the stops: keep going when nothing needs the operator

- **Surface.** (a) The mandate's "Human in the loop" (`src/lib/orchestrator/prompt.ts:323-327`).
  (b) `HUMAN_IN_THE_LOOP` (`src/lib/roles/defaults.ts:29`), which reviewer,
  verifier, builder and architect all carry.
- **Problem.** The post says Opus 5.5 sometimes ends a turn on a report or an
  offer to continue, and that it follows instructions that name those stops
  (G3). Our text says only when to stop. In a pipeline stage such a turn
  settles the stage, because "The stage settles when this turn ends"
  (`src/lib/pipelines/prompts.ts:85`). A builder that stops halfway to offer
  "want me to continue?" ends up with a finished attempt, a half-done head, and
  no `stage_report` or the wrong one. The seat has the same problem inside a
  wake.
- **Diff.**

```diff
 // src/lib/roles/defaults.ts:29
 const HUMAN_IN_THE_LOOP =
-  "Decide yourself whatever the code, the running system or one cheap observation can settle; never ask the operator what you can find out. Stop and ask when …
+  "Decide yourself whatever the code, the running system or one cheap observation can settle; never ask the operator what you can find out. When a step needs nothing from the operator, keep going: a summary that names the next step without taking it, or an offer to continue, is no place to stop, and in a pipeline stage it ends the turn and settles the stage. Stop and ask when …
```

```diff
 // src/lib/orchestrator/prompt.ts:327
 - After a deploy, check the operator-visible result on prod before you mark the task done.
+- When a step needs nothing from the operator, keep going and put the status in the same message as the next action. A summary that names the next step without taking it, or an offer to continue, is not a stop.
```

- **Expected effect.** Stages and wakes finish the work they were handed
  instead of settling early. The sentence costs +211 bytes in the mandate and
  +214 bytes in each of four scaffolds.
- **Risk.** It could make an agent push on where it should have asked. The
  sentence is scoped to "needs nothing from the operator", sits right next to
  the existing stop-and-ask rule, and every fence in G4 still applies.

### 2. Stop treating "shall I" as a normal way to end a message

- **Surface.** Mandate, "Reply drafts" (`src/lib/orchestrator/prompt.ts:315`).
- **Problem.** The trigger list for `suggest_replies` includes "a status that
  ends in "shall I"". This presents the stop G3 describes as a routine kind of
  message. It also conflicts with the mandate's own start-by-default contract
  (`prompt.ts:343`), which says to put requested work in motion without a
  confirmation step.
- **Diff.**

```diff
-Call suggest_replies after EVERY message of yours that asks the operator something or proposes a course of action — a question, a choice between options, a plan you want a yes to, a status that ends in "shall I". Offer 2–4 …
+Call suggest_replies after EVERY message of yours that asks the operator something or proposes a course of action — a question, a choice between options, a plan you want a yes to. Work you can decide yourself is no ask: do it and say what you did. Offer 2–4 …
```

- **Expected effect.** Fewer seat turns that end on an offer the operator has
  to answer with "yes". The reply pills still appear for genuine asks. +35
  bytes.
- **Risk.** Low. The operator's standing rule against confirmation prompts
  already points this way.

### 3. Give the builder a finish line

- **Surface.** Builder scaffold (`src/lib/roles/defaults.ts:99`).
- **Problem.** "Implement the scoped product directive with focused checks"
  never says what "done" means. The post's first recommendation is exactly that
  (G1). The pinned spec usually holds acceptance criteria, but the scaffold
  never ties completion to them.
- **Diff.**

```diff
-promptScaffold: `You are a Builder in {{mode}} mode. Implement the scoped product directive with focused checks. Keep changes …
+promptScaffold: `You are a Builder in {{mode}} mode. Implement the scoped product directive with focused checks. You are done when every acceptance criterion in the pinned specification holds at your final commit and the checks you ran pass; a finish line the stage prompt names governs over this one. Keep changes …
```

- **Expected effect.** Builders stop early less often, and stop late less
  often (gold-plating past the criteria). +196 bytes.
- **Risk.** A spec with no criteria makes the sentence a no-op, and the kickoff
  prompt already asks for them (`flows/prompts.ts:14`). The `diagnose` and
  `prototype` modes have their own finish lines, which the "stage prompt
  governs" clause covers.

### 4. One source for runtime choice: the role table

- **Surface.** (a) The orchestrator scaffold, which spawn prepends to every
  seat (`src/lib/roles/defaults.ts:55`). (b) The `delegatus-orchestration`
  skill (`.claude/skills/delegatus-orchestration/SKILL.md:19`, `:27-39`).
- **Problem.** Three places tell the seat how to pick a runtime, and they
  disagree:
  - The mandate's generated role table: "A stage or spawn that omits engine,
    model and effort runs exactly its role's row" (`prompt.ts:379`). Today that
    gives builder `codex/gpt-6-astra/medium` and reviewer
    `codex/gpt-6-astra/xhigh`.
  - The orchestrator scaffold: "use Opus/Sol gates, route backend work to Terra
    and frontend work to Opus".
  - The skill: Opus 5 is the default for "All Delegatus UX/UI and bug
    investigation, implementation, and review", Terra is "parked", and Sol
    handles review swarms. It also names a model that Opus 5.5 has since
    replaced.

  The post's own lever for depth is effort, set at launch (G2), and the skill
  itself says "Never name the model or reasoning level in the prompt text"
  (`SKILL.md:18`).
- **Diff.**

```diff
 // src/lib/roles/defaults.ts:55
-For backlog-campaign mode, inventory dependencies before assignment, use Opus/Sol gates, route backend work to Terra and frontend work to Opus, complete one review round, and require root release checks.
+For backlog-campaign mode, inventory dependencies before assignment, take each lane's runtime from the role table, complete one review round, and require root release checks.
```

```diff
 # .claude/skills/delegatus-orchestration/SKILL.md:27-39
-| Template (engine) | Use for | Avoid |
-… five model rows naming Sol, Terra, Opus 4.8, Opus 5, Sonnet 5 …
-Assignment defaults: all Delegatus UX/UI and bug investigation, implementation, and review go to Opus 5 by default. …
+The role registry decides the runtime. The seat's mandate ends with its table; a stage or spawn that names no engine, model or effort runs its role's row. Name a runtime only when the operator names one, and set it on the stage, never in the prompt text.
```

  The review-pass budget at `SKILL.md:19` and `:39` stays, with the model names
  taken out ("at most one or two independent review passes on any change; a
  swarm of five or more runs as visible pipeline stages").
- **Expected effect.** The seat stops overriding the registry from stale
  prose, and a registry edit becomes the one place to move a runtime.
  Orchestrator scaffold −110 bytes, skill about −1.3 KB.
- **Risk.** The `agent:*` issue labels map to those template rows
  (`SKILL.md:27`). Keep the sentence that labels name an owner, and leave the
  label-to-runtime mapping to the registry.

### 5. The conveyor skill still asks for the fenced JSON verdict

- **Surface.** `.claude/skills/delegatus-conveyor/SKILL.md:14`.
- **Problem.** "Prompts stay English and end with the required fenced JSON
  verdict." The controller has already appended a stage contract to every stage
  since #1797: `stage_report` "is the only way to complete this stage", and the
  fenced block is only a fallback for when the call errors
  (`src/lib/pipelines/prompts.ts:83-91`). A seat that follows the skill writes
  prompts that ask for both, which is the pairing #1797 removed because it
  parked stages. That already happened on 2026-09-22 (see Prior work). This is
  a contradictory rule of exactly the kind the spec asked about.
- **Diff.**

```diff
-… Prompts stay English and end with the required fenced JSON verdict. NON-DRAFT PR, typecheck, tests, and scope fences remain part of the stage prompt. …
+… Prompts stay English; the controller appends the stage_report contract, so a stage prompt names no verdict format of its own. NON-DRAFT PR, typecheck, tests, and scope fences remain part of the stage prompt. …
```

  In the same edit, `SKILL.md:25` "Opus 5 gate on all UI/UX … critiqued by Opus
  5" becomes "The design-critique gate on all UI/UX". Which model runs the
  critique is a role-table question (proposal 4).
- **Expected effect.** Stage prompts stop asking for two completion channels.
  −30 bytes.
- **Risk.** None found.

### 6. Reviewers show how each finding fails

- **Surface.** Reviewer scaffold (`src/lib/roles/defaults.ts:74`) and the flow
  reviewer prompt (`src/lib/flows/prompts.ts:48`).
- **Problem.** G8. Our finding format asks for a problem statement and a fix
  plan (scaffold) or "severity, file, line, title, and explanation" (flow). It
  never asks for a way to show the failure. That is what separates a real
  finding from a false alarm, and it is what the next fresh reviewer needs to
  check a REJECTED reply.
- **Diff.**

```diff
 // defaults.ts:74
-Every finding is an actionable fix plan: clear problem statement, fix intent, constraints, and acceptance criteria.
+Every finding is an actionable fix plan: clear problem statement, how to show it fails (a command, an input or a test that goes red), fix intent, constraints, and acceptance criteria.
```

```diff
 // flows/prompts.ts:48
-"Then write findings in Markdown. For each finding include severity, file, line, title, and explanation. …
+"Then write findings in Markdown. For each finding include severity, file, line, title, explanation, and how to show it fails. …
```

- **Expected effect.** Fewer findings that can't be reproduced, and implementer
  replies that can be checked. +62 and +24 bytes.
- **Risk.** Some findings can't be shown to fail with a command, such as
  over-engineering or wrong-premise findings. "how to show" leaves room for an
  argument, and `REVIEW_FRAME_RULES` keeps those verdicts first-class.
  `relayPrompt` is retained as legacy text (`reviewHistory/relayPrompt.ts:3`),
  so it stays untouched.

### 7. Cut the mandate text that the tool schemas already carry

- **Surface.** Mandate (`src/lib/orchestrator/prompt.ts`).
- **Problem.** The mandate reaches a seat as a message, and compaction
  summarizes it with the rest of a long run (G6, `seatCommand.ts:853`). Four
  passages repeat what the MCP server instructions or a tool schema already
  deliver on every session:

  | Passage | Line | Already stated at | Bytes now → after |
  |---|---|---|---|
  | request_attention target shapes, "verbatim" | 307-312 | `src/lib/mcp/server.ts:3124-3169` (discriminated schema with an example per kind) | 863 → 299 |
  | "THE TEXT IS FOR THE HUMAN…" | 246 | MCP server instructions (`server.ts:3683`), `update_task` schema | 1,062 → 331 |
  | list_tasks paging mechanics in "FIND IT…" | 242 | MCP server instructions ("follow nextCursor", "compact by default", clientRequestId reuse) | 750 → 602 |
  | "READ BACK WHAT YOU DID" | 258 | the `create_pipeline` and `pipeline_action` answers carry `taskIds` (`compactAnswers.ts:39`, `bindings.ts:1576`); audit S3 counted 56 read-backs (82 KB) | 599 → 477 |

- **Diff.** The replacements that were measured:

```diff
-Targets are typed and discriminated by kind. The shapes, verbatim:
-- conversation — {"kind":"conversation",…}
-… (4 more lines) …
-intent "show" frames and highlights the card; intent "open" also opens it. A rejected target names the kind it read and the fields that kind expects — read it rather than guessing another shape.
+Targets are typed by kind (conversation, stage, pipeline, flowRound, task, draft, region, point) and the tool schema gives each shape. intent "show" frames and highlights the card; "open" also opens it. A rejected target names the fields its kind expects: read it rather than guessing another shape.
```

```diff
-THE TEXT IS FOR THE HUMAN; AGENT CONTEXT GOES IN details. The operator reviews the board, so text stays … A worker's first-action refine writes only the human part.
+THE TEXT IS FOR THE HUMAN; AGENT CONTEXT GOES IN details. text is a title and at most a few plain sentences about the outcome. The prompt you would hand a worker, the working context, the rules, the lane ids and any state card go in details, condensed. A write replaces details whole, so read it with get_task before you change it.
```

```diff
-… Results are compact and newest-updated first; follow nextCursor with the same filters and a fresh clientRequestId while hasMore is true. For routine monitoring use openOnly:true or a status set. A size-bounded page carries counts of what remains. …
+… Follow nextCursor while hasMore is true. For routine monitoring use openOnly:true or a status set. …
```

```diff
-READ BACK WHAT YOU DID. After a create or a link, call get_pipeline with compact:true and confirm its taskIds contain the task, then call get_task and confirm the task's pipelineIds contain the pipeline, which holds the moment the link lands. Assignments answer …
+READ BACK WHAT YOU DID. The create_pipeline and pipeline_action answers list the pipeline's taskIds: check the task there, and confirm the other side with get_task compact:true, whose pipelineIds hold the link the moment it lands. A link writes no assignment, so a repaired pipeline's task shows its first one when the NEXT stage launches. A task can hold a launch and still draw no band on the board, so when you hand the operator a task id, say whether it is visible to them.
```

- **Expected effect.** −1,565 bytes in these four passages, and about 40 fewer
  `get_pipeline` reads per audit window (audit §3.3).
- **Risk.** The MCP server instructions and the tool schemas have to keep
  saying what the mandate stops saying. The test pin
  `toContain("AGENT CONTEXT GOES IN details")` (`prompt.test.ts:90`) still
  holds, and `NO_ACTIVE_VIEW` (`:321`) is untouched.
  `ORCHESTRATOR_TASK_OWNERSHIP_DIRECTIVE` is appended to bespoke mandates by
  heading (`prompt.ts:406-410`). A seat that reworded its section keeps its
  own copy, and that is how it should work.

### 8. The research roles mark what they could not confirm, and where they looked

- **Surface.** Verifier (`src/lib/roles/defaults.ts:86`) and prod-auditor
  (`defaults.ts:133`).
- **Problem.** G9. The verifier says "identify missing evidence" but not where
  it looked. The prod-auditor has no such clause, and it is also the one role
  without `HUMAN_IN_THE_LOOP`.
- **Diff.**

```diff
-… Return CONFIRMED or WRONG for every claim with exact evidence and identify missing evidence. …
+… Return CONFIRMED or WRONG for every claim with exact evidence; mark each claim you could not confirm and say where you looked. …
```

```diff
-… Cite every finding with the exact command or SQL and UTC time bounds. Return evidence with no runtime mutation. …
+… Cite every finding with the exact command or SQL and UTC time bounds. Mark what you could not confirm and say where you looked. Return evidence with no runtime mutation. …
```

- **Expected effect.** Gaps show up as their own lines, and an agent reading
  the report can re-check them without redoing the search. About +50 bytes
  each.
- **Risk.** None found.

### 9. The frontend builder names the patterns to leave out

- **Surface.** Frontend builder guidance (`src/lib/roles/registry.ts:79`),
  which is the Opus-default builder variant.
- **Problem.** G10. "follow the approved interaction and visual contract" is
  the kind of general instruction the post says swaps one default for another.
  Delegatus already has a visual language, so the patterns to exclude are the
  ones it does not use.
- **Diff.**

```diff
-"\n\nUI/frontend implementation guidance: follow the approved interaction and visual contract, preserve accessible semantics, responsive behavior, and English/Ukrainian parity."
+"\n\nUI/frontend implementation guidance: follow the approved interaction and visual contract, preserve accessible semantics, responsive behavior, and English/Ukrainian parity. Reuse the colours, type, spacing and components the surrounding UI already uses; add no new colour, font, pill or card shape, or decorative label the issue does not ask for."
```

- **Expected effect.** Fewer rounds of design critique spent removing
  invented styling. +168 bytes.
- **Risk.** This is the lowest-confidence proposal. The design-critique stage
  already catches invented styling, and nobody measured how often it does.
  Ship it with PR A only if the reviewer agrees. Otherwise move it to Deferred.

## 3. What not to change, and why

- **"Think carefully" lines, and requests for reasoning in replies.** There are
  none to delete (G2, G12). The verifier's "Rank falsifiable hypotheses before
  testing" asks for ranked output, not a reasoning transcript, so it stays.
- **Reviewer isolation (#393) against the post's subagent fan-out (G5).** The
  post's pattern, fanning out and then checking each result's evidence, is
  what our visible review stages already do. Adding in-session fan-out would
  hide work from the board, and the operator set that rule on purpose.
- **Destructive-action fences** (process cleanup, deployer approval, cleaner
  backup, data safety). These are the "own check before anything risky" the
  post tells you to keep (G4). Proposal 1 relies on them.
- **"Settled answers" in the seat (G11).** The seat's job is to re-derive state
  every turn (`prompt.ts:349`). An instruction to treat earlier answers as
  settled would pull against that, and the post itself says to leave it out of
  long analysis.
- **ALL-CAPS lead-ins in the task-ownership section** (`prompt.ts:242-262`,
  about 30 capitalised runs). The post says nothing about emphasis, rewording
  costs a version bump, and nobody measured an effect. They are cheap
  (bytes, not tokens of prose). Proposal 7 rewrites two of these paragraphs and
  keeps their lead-ins.
- **Effort defaults.** The post's review claim is one early tester's anecdote
  about Opus at low effort. Our reviewers run on Codex, and the role table
  already tells the seat to "Choose effort deliberately" (`prompt.ts:385`).
  One anecdote is no reason to change a default.
- **The initial-status greeting, the clock section, and the stage_report
  contract.** Each encodes an incident (#1245, #1749, #1797, #2030). The post
  gives nothing that argues against them.
- **The voice persona** (`src/lib/runtime/voicePersona.ts`, 27 KB). It is a
  Codex realtime prompt, and the post does not cover it.

## 4. Mandate size

These numbers were measured by running `orchestratorMandateForDelivery` over
the current default and over the text with proposals 1a, 2 and 7 applied in
memory (no file was edited):

| | Bytes | Approx. tokens (2.53 B/token, the audit's measured ratio) |
|---|---|---|
| Delivered mandate today (body + directives + role table) | 21,808 | ~8,620 |
| After proposals 1a + 2 + 7 | 20,489 | ~8,100 |
| Saved | **1,319 (6.0%)** | ~520 per delivery |

Proposal 7 alone saves 1,565 bytes (7.2%). Proposals 1a and 2 add 246 of them
back, on purpose. The orchestrator scaffold that spawn prepends shrinks by
another 110 bytes (proposal 4). The larger saving is in reads the mandate stops
prescribing: the audit counted 39 `get_pipeline` read-backs in its window,
which proposal 7 removes.

Role scaffolds grow slightly under PR A: builder +410 bytes, reviewer +276,
verifier and architect +214 each, prod-auditor +50. Each stays far below the
12,000-byte pipeline cap (`src/lib/roles/store.ts:27`, applied at
`src/lib/pipelines/roles.ts:61`). The largest, the reviewer, reaches 3.9 KB.

## Deferred: not justified yet

- **A checklist file for long builder runs (G6).** The pinned spec's
  acceptance criteria and the PR body already give a builder a durable list.
  Reconsider if the audit's measured 219 K median builder context starts
  losing criteria to compaction.
- **Flagged-message model switches (G13).** The post says a flagged message
  moves the session to an older model. I could not confirm how a headless or
  structured Claude host reports that switch, or whether Delegatus would then
  record the wrong model on an attempt. That needs an observation before any
  design.
- **Fast mode.** It only applies to back-and-forth sessions, and it costs extra
  usage. That is the operator's launch choice, not text.
- **The rotation's predecessor read** (`seatCommand.ts:1033`, `limit:40` with
  default `maxChars`). This is audit S1 and still open. It is about context,
  not about the post, and belongs to that audit's follow-ups.
- **Proposal 9**, if the PR A reviewer finds it unproven.

## Validation against the requirement

The operator asked whether the post holds anything worth applying. It does:
four of its recommendations (G1, G3, G8, G9) map to specific gaps in our
text, and two of our own contradictions surfaced during the check (proposals 4
and 5). Its two most-quoted instructions, deleting "think" lines and not
asking for reasoning in the reply, need no action here because our text never
had those lines. Everything proposed fits in two PRs and edits text only. The
mandate PR carries the version bump that makes it reach seats.
