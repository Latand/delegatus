# Orchestrator role memory: the seat leaves learned rules, reads them at every start on any engine or account, and turns defects into tasks

Status: design, no product edits. Code read at main `212d9780e`. Lane 26b1a14a
read at its branch head `7568d7d24` (PR #2779, open, in its fix stage). Role
memory records read read-only from the operator's `state.sqlite` at
2026-10-12 09:22 UTC. Probes are in the appendix.

## Originating requirement

Operator, 2026-10-12 09:09 UTC (12:09 Kyiv), orchestrator seat chat, by voice,
in Russian. Verbatim, the whole message:

> Хорошо, смотри, что касается. Вот этих проблем, с которыми ты сталкиваешься.
> Я так понял, что это довольно частая проблема, и я вот не помню, у нас
> память для оркестратора существует или не существует. Потому что, судя по
> всему, тебе тоже надо в память свою иметь свою, как память для своей роли, и
> писать себе вот эти «каждый раз, когда ты натыкаешься на какую-то проблему,
> либо писать в память, либо заниматься тем, что есть», ну, как бы создавать
> задачу на исправление, если это критичная вещь.

It followed a morning in which the seat worked around the same failures more
than once: stage commits that stuck, a false stall report, identity refusals.

Three earlier requirements still bind, and this design keeps each:

- 2026-10-07: «ревьюер всегда чистый». Reviewer, verifier, issue reporter and
  curator read no rules and leave none.
- 2026-10-11: memory was «забита, и слишком много», full of notes about one
  task. Rules are abstract and hold on other tasks.
- 2026-10-12 06:00 UTC, the instruction behind lane 26b1a14a: «по умолчанию,
  чтобы они не сохраняли, а передавали оркестратору … пусть он думает, типа,
  создавать задачу, не создавать. … не решение, а проблема.» A concrete defect
  is a problem that goes to the seat; memory holds practice.

The default answer to "should we build this" is no. The operator asks whether
the orchestrator has a memory, says it needs one for its role, and names the
two outcomes of a problem: a memory entry, or a fix task when it is critical.
Section 1 shows that Delegatus gives the seat neither a place to write nor
anything to read. So the question is the smallest change that gives the seat
both, inside the memory every other role already uses.

## 0. Was this solved before

- `search_transcripts` (project-scoped, then unscoped) for seat learned rules,
  the orchestrator's memory in the operator's words, and the "no learned-rule
  level" sentence; `search_memory` for seat memory and the problem-or-task
  rule. The memory index returned nothing. The transcripts hold the operator
  message above, the role-memory lanes, and lane 26b1a14a.
- **Deferred twice, with a stated reason.** `docs/design/role-memory.md` (the
  reads-and-writes table, and "3.3 Slice 3") gave the orchestrator and the
  maintainer "nothing in the MVP": neither is a pipeline stage, so the
  stage-end write path does not reach them, and each "already carries its own
  continuity (the seat's monitor note and rotation digest; the maintainer's
  previous-run record)". `docs/design/role-memory-curation.md` (§3.0) then
  listed both among the roles with no level, and the curator was built to
  archive rules addressed to them as `no-reader`.
- **Lane 26b1a14a** (`docs/design/lessons-from-review-findings.md` on its
  branch, PR #2779) adds the problem-versus-rule split this design builds on.
  Section 1.6 lists what it supplies.
- Nothing else attempted a seat write path.

## 1. What the code and the records show

### 1.1 Where the seat keeps what it learns today

| Place | What it is | Why a successor does not get it |
| --- | --- | --- |
| The engine's own memory | For a Claude seat, the auto-memory directory of one account. On this machine it holds 44 notes for this project, written 2026-10-01 to 2026-10-12 (26 on how to work, 7 on running work, 11 pointers; at most 10 in one day) | It belongs to one engine and one account. A Codex seat, a seat on another account and a successor on another engine read none of it |
| The monitor note | `seat_tick_settings` `monitorPrompt`, up to 16 000 characters (`src/lib/monitor/seatTickSettings.ts:60`), stored per project | It is the seat's standing note for the tick. A wake shows it only when it changed; it has no versions, no levels, no curator and no place in the rules window |
| The rotation digest | 4 096 bytes of history in a rotation's mandate (`src/lib/orchestrator/handoffDigest.ts:41`) | It summarises what happened; a practice is lost at the first rotation that trims it |

The five examples in the pinned specification all sit in the first row.

### 1.2 How a rule reaches an agent

A pipeline stage's launch profile carries a text-free selector,
`learnedRules: { project, roleId }` (`src/lib/accounts/migration/contracts.ts:74-76`),
set by the pipeline engine only (`src/lib/pipelines/engine.ts:5865-5866`,
`:6251`). At every engine process start the host reads the rules fresh from
`state.sqlite` through `learnedRulesForLaunchProfile`
(`src/lib/memory/roleLaunch.ts:14-23`): Claude receives them as
`appendSystemPrompt` (`src/lib/runtime/structuredSpawn.ts:1732`,
`src/lib/runtime/startup.ts:1748`, `src/lib/accounts/migration/provider.ts:512`,
used at `claudeStreamBrokerHost.ts:868`), Codex as `developerInstructions`
(`structuredSpawn.ts:1802`, `startup.ts:2106`, `provider.ts:376`, used at
`codexAppServerHost.ts:1590`). The block holds four scopes
(`readableScopes`, `src/lib/memory/roleStore.ts:109-111`): the role on this
project, the role on every project, the project, the machine. It is bounded at
120 000 bytes (`roleLaunch.ts:11`), and each scope at 10 000 code points
(`src/lib/memory/roleTypes.ts:9`).

The store is one collection of the installation's `state.sqlite`
(`roleStore.ts:36-70`). It belongs to no engine and no account.

### 1.3 How a rule is written

`leave_lesson` resolves the calling conversation to a pipeline attempt that an
accepted `stage_report` asked for a lesson
(`leaveLessonForConversation`, `src/lib/memory/roleStage.ts:118-142`). A
conversation that runs no stage is refused `LESSON_NOT_AN_ATTEMPT`
(`roleStage.ts:119`, `:123`); a stage nobody asked is refused
`LESSON_NOT_REQUESTED` (`:131`). A seat therefore cannot write.

### 1.4 The seat and the maintainer read nothing, and rules already wait for them

- Seat launches and maintenance runs go through the general spawn admission
  (`src/lib/orchestrator/seatCommand.ts:1259-1270`,
  `src/lib/boardMaintenance/run.ts:162`), which sets no selector, so neither
  starts with a block.
- The curator's brief says they "run outside pipeline stages and have no
  learned-rule level" (`src/lib/memory/curation/brief.ts:3`), and its apply
  refuses any active rule in their scopes (`noRoleReader`,
  `src/lib/memory/curation/apply.ts:37-39`, enforced at `:77` and `:153`).
- **Four active rules already sit in orchestrator role scopes**: two in this
  project's, two in another project's. Builder and architect stages wrote them
  between 2026-10-10 and 2026-10-11 with `lesson.role: "orchestrator"`, which
  `parseLessons` admits (`roleStage.ts:98-104`: the role is a registry role and
  is not clean). No conversation has ever read them. No curator pass has run on
  this machine (the `role_memory_curation` collection is empty), so they are
  still active. The first pass under today's code cannot leave them active in
  those scopes, and its brief tells it to archive them as `no-reader`.

### 1.5 The mandate has no room

Measured on main (appendix, probe A):

| | Bytes |
| --- | ---: |
| Delivered default mandate, role table included | 29 378 |
| Orchestrator role scaffold that a spawn prepends | 742 |
| Structured envelope (`MAX_STRUCTURED_TEXT_BYTES`) | 32 000 |
| Left at a spawn | 1 880 |
| Bound that `src/lib/orchestrator/prompt.test.ts:793` pins for the delivered default | < 29 400 |
| Left under that bound | 22 |

`src/lib/orchestrator/handoffDigest.test.ts:456` pins the room a rotation's
history needs beside the same text, with a margin of the same order. One
scope's bound alone is 10 000 code points.

### 1.6 What a seat of this project would read

| Scope | Active rules | Code points |
| --- | ---: | ---: |
| Orchestrator on this project | 2 | 443 |
| Orchestrator on every project | 0 | 0 |
| This project | 37 | 9 972 |
| Machine | 25 | 5 760 |

About 16 KB, far under the 120 000-byte ceiling of the start instructions.
The project scope already holds rules a seat and a maintainer act on (reading
what merged, dating events, fencing a brief against open pull requests); they
are named here by topic and quoted nowhere.

### 1.7 What lane 26b1a14a supplies

At `7568d7d24` it adds, in the files this design also touches:

- `assertGenericRule` (`src/lib/memory/roleProblems.ts`): a proposed rule that
  names a concrete file or reads as a defect statement is refused
  `LESSON_IS_PROBLEM`; a machine rule tied to this project is refused
  `LESSON_WRONG_LEVEL`. Refusals store nothing.
- A fourth answer for a stage, `problem: { statement, evidence }`, stored on
  the stage's request row and delivered to the project seat's wake agenda as an
  actionable signal; the curator can transfer a misfiled rule the same way.
- An agent rewrite moves an uncurated rule to the end of its scope's leaving
  order, and the rule view counts the tasks behind a rule.

Probe C ran seat-shaped texts through those guards at that head:

| Text shape | Outcome |
| --- | --- |
| An imperative practice ("Before reporting an agent as stalled, read the tail of its conversation…"), six variants covering the five examples of the pinned specification | admitted |
| A statement that something is wrong or fails | `LESSON_IS_PROBLEM` |
| An instruction that names a source file | `LESSON_IS_PROBLEM` |
| A preference stated as a fact about the operator ("The operator requires…") | `LESSON_IS_PROBLEM` |
| A machine rule that says "in this repository" | `LESSON_WRONG_LEVEL` |

The fourth row is a false alarm of a structural hint; the same preference
written as an imperative is admitted. Section 2.6 words the refusal so the
seat sees both ways out.

### 1.8 The board maintainer

One scheduled turn of up to 90 minutes, launched by the seat tick with the
role `maintainer` (`run.ts:143-189`), read-only for files, writing the board
only through `create_task` and `update_task`. Its tool policy fails closed on
every other mutating tool (`permitMaintainerTool`,
`src/lib/mcp/toolAllowlist.ts:322-329`). It ends with `attention:` and `left:`
lines tied to task ids (`parseMaintenanceReport`,
`src/lib/boardMaintenance/text.ts:8`), which reach the seat as one wake item.
It reports no stage, so nothing asks it for a lesson.

## 2. Design

### 2.0 Summary

The seat becomes a reader and a writer of the role memory that exists. Nothing
new is stored anywhere else.

1. **Write.** `leave_lesson`, with its schema unchanged, accepts a caller that
   the server resolves to a project's designated orchestrator seat. The seat
   answers nobody's request: it calls with `lesson` or `rewrite` when it meets
   a practice worth keeping. Every stage guard applies.
2. **Store.** The rule lands under `role:<project>:orchestrator` unless the
   seat names another level, exactly as a stage chooses a level today.
3. **Read.** The spawn admission gives every conversation launched as
   `orchestrator` or `maintainer` the same text-free selector a stage carries,
   so the existing hosts deliver the block at every engine start: creation,
   rotation, resume, account migration, on Claude and on Codex.
4. **When.** The block a seat reads ends with the instruction: a problem that
   can come back becomes a rule or, when it is a defect, a board task, and the
   operator hears about a critical one.
5. **Defects.** A defect-shaped text is refused with a steer to `create_task`.
   The seat creates the task; the store keeps practice only.
6. **Curator.** The two roles stop being `no-reader`. The curator merges,
   archives, moves and widens their rules like any other role's.
7. **Maintainer.** It reads its rules at every run. The seat writes them. It
   writes none itself (2.8 says why).

### 2.1 The call surface

`leave_lesson` keeps its name and its input schema
(`src/lib/mcp/server.ts:3900-3914`; after #2779 the schema also holds
`problem`). The binding (`leaveLesson`, `src/lib/mcp/bindings.ts:2459-2471`)
resolves the caller first:

1. The server-attributed caller is a designated seat (2.2): the **seat path**.
2. Anything else: the stage path, unchanged.

What a seat may send:

| Answer | From a seat |
| --- | --- |
| `lesson { scope, role?, rule, why }` | Stored. One rule per call, active from the next engine start of its readers |
| `rewrite { id, rule, why }` | Stored on a rule the seat reads (its role scopes, the project, the machine). The id and level stay; the earlier text is kept and can be restored |
| `none` | Refused `LESSON_INVALID`: nobody asked the seat, so there is nothing to decline |
| `problem` | Refused `LESSON_IS_PROBLEM` with the task steer of 2.6: the seat is where problem reports arrive |

The answer is `{ project, roleId: "orchestrator", left: [...] }` with the
same `left` entries a stage receives (id, scope, state, merged-into, hints,
scope size, what the bound archived). A replayed `clientRequestId` answers the
first result, as today (`leave_lesson` is in the receipt-kept tool list,
`server.ts:135`).

Refusals a seat can meet, each storing nothing:

| Code | When | What the message says |
| --- | --- | --- |
| `LESSON_IS_PROBLEM` | the text names a file or reads as a defect, or the answer is `problem` | 2.6 |
| `LESSON_ABOUT_ONE_TASK` | the rule carries a task, pull request, commit or rule identifier (`taskIdentifier`, `roleStage.ts:71-76`) | it belongs on that task's card; say it without the identifier if it holds elsewhere |
| `LESSON_WRONG_LEVEL` | a machine rule tied to this project | use the role or project level |
| `LESSON_CLEAN_ROLE` | `lesson.role` names reviewer, verifier, issue reporter or curator | those roles read no rules |
| `LESSON_INVALID` | text limits, more than one answer, `none`, a rewrite that changes nothing | the limit and the count |
| `RULE_NOT_READABLE` | a rewrite of a rule outside the seat's four scopes | name an active rule you were given |
| `LESSON_SWITCHED_OFF` | `LLV_ROLE_MEMORY=off` | learned rules are off on this installation |

Two texts change in `server.ts`. The tool description (`:3331-3336`) gains one
sentence: "A project's designated orchestrator seat may also call unasked,
with lesson or rewrite, for a practice that can come back; a defect goes to a
board task (create_task). Write no names of people, accounts, emails, tokens,
ids or absolute paths." The refusal for a caller that is neither
(`LESSON_NOT_AN_ATTEMPT`, `roleStage.ts:119`, `:123`) says: "a lesson is left
by a stage that was asked for one, or by a project's designated orchestrator
seat; this conversation is neither."

No rate limit is added. Section 3 and Deferred give the reason and the number
to watch.

### 2.2 Identity checks

Everything is derived by the server. The call has no project argument and no
role argument for the writer.

| Caller | How the server knows | Outcome |
| --- | --- | --- |
| The project's designated seat | `attributionOf` answers `manager` with a conversation id (`callerAttributionFrom`, `bindings.ts:1009-1024`), built from process ancestry and the spawn capability minted at admission. `authorizedManagerSeats` (`src/lib/orchestrator/authority.ts:87-109`) holds a row for that conversation: an active seat, no revocation at its epoch or later, registry facts that exist, are not superseded and do not contradict the seat's project. The row's `project` is where the rule goes | seat path |
| A live deputy of that seat | attribution maps it to its seat (`via.deputy`), under the checks of `deputyPrincipal` (`authority.ts:140-164`) | seat path, as its seat; the rule's source records the seat's conversation. A deputy speaks as its seat everywhere but the deploy and the rotation, and a reversible memory write is neither |
| A predecessor after a rotation, a superseded conversation | no row in `authorizedManagerSeats`, so attribution answers `agent` | stage path: `LESSON_NOT_AN_ATTEMPT` |
| A conversation launched with the role `orchestrator` that holds no designation (a child spawn) | the role string is never authority (`toolAllowlist.ts:90-93`) | stage path: `LESSON_NOT_AN_ATTEMPT` |
| A stage agent with an open lesson request | as today | stage path |
| A stage agent nobody asked, a `spawn_agent` worker | attribution `agent` | `LESSON_NOT_REQUESTED` or `LESSON_NOT_AN_ATTEMPT` |
| A maintenance run | `permitMaintainerTool` | `maintainer_tool_refused` |
| The curator | `permitCuratorTool` | `curator_write_refused` |
| The operator's own session, an unidentified caller | attribution `gateway` or `unidentified` | `LESSON_NOT_AN_ATTEMPT`; the operator edits rules in the window |

A caller attributed as `manager` whose seat row carries no project is refused
`LESSON_NOT_A_SEAT`; the check fails closed. A seat cannot write into another
project: the project is the designation's, read fresh on every call, so a
rotation or a revocation takes effect on the next call.

### 2.3 Storage level

A seat rule is an ordinary rule row in `role_memory`. Levels and their keys
are the existing ones:

| The seat sends | Key | Read by |
| --- | --- | --- |
| `scope: "role"` | `role:<project>:orchestrator` | this project's seat, on any engine and account |
| `scope: "role", role: "maintainer"` | `role:<project>:maintainer` | this project's maintenance runs |
| `scope: "role", role: <another stage role>` | `role:<project>:<role>` | that role's stages here; this is the existing `lesson.role` |
| `scope: "project"` | `project:<project>` | every role here, the seat and the maintainer included |
| `scope: "machine"` | `machine` | every role in every project; guarded by `LESSON_WRONG_LEVEL` |

The pinned specification's "machine level only when it is truly cross-project"
has two homes in this vocabulary. A rule every role acts on in any repository
is `machine`, and the seat may write it under the existing guard. A rule the
orchestrator acts on in every project is `role:*:orchestrator`; the seat
leaves it under `role`, and the curator alone widens it after reading the
other projects' orchestrator scopes, which its scope read already returns for
a role scope (`src/lib/memory/curation/read.ts:47`). This is the rule every
role follows today.

What changes in the record:

- **Source.** `RuleSource` (`roleTypes.ts:51-61`) becomes a union. A stage
  source is today's shape. A seat source is
  `{ origin: "seat", project, roleId: "orchestrator", fixRound: false, conversationId }`.
  Rows stored before the change have no `origin` and read as stage sources;
  the collection's schema version stays 1. `RuleView.stageId`
  (`roleStore.ts:400`) answers `"seat"` for a seat source; the window does not
  show that field.
- **No request row.** A seat answers no request. The lesson and rewrite body
  of `leaveLessons` (`roleStore.ts:238-304`) moves into one inner function
  that two entry points call inside their transaction: `leaveLessons`, which
  keeps its request checks, and a new `leaveSeatLessons`, which has none. The
  scope bound, exact-duplicate merge, versions, privacy hints, the rewrite
  refresh of lane 26b1a14a and the refresh of the publication gate's known
  values are therefore the same code for both.
- **History.** The scope history records a seat write as `by: "agent"`, so it
  counts toward the curator's ten-new-lessons trigger
  (`curation/store.ts:86-106`) with no change there.
- **Task count.** Lane 26b1a14a counts the tasks behind a rule from request
  rows. A seat write adds none, so a seat rule shows no "from N tasks" mark,
  and a seat rewrite adds no task to a rule a stage wrote.

### 2.4 Rendering on every engine

**The selector.** `beginSpawnRequestInFile`
(`src/lib/agent/registry.ts:5734`) assembles the launch profile of every
spawn and every resume successor, and already forces `cleanMemory` there by
role (`:5791-5792`). One line beside it: when the conversation's role
(`existingConversation?.agentRole ?? role`) is `orchestrator` or `maintainer`,
the profile is not clean, carries no selector yet and a project is known (the
explicit project, else the recorded ownership, else the profile's own), set
`learnedRules: { project, roleId: <that role> }`. A resume keeps a selector
once set (`mergeResumeLaunchProfile`, `registry.ts:1210-1212`). No host, no
option builder and no contract type changes: the six start sites of 1.2 read
the selector as they do for a stage.

**When each kind of seat start reads the rules.**

| Start | Path | Rules as of |
| --- | --- | --- |
| `create_orchestrator`, a fresh seat | seat spawn with `role: "orchestrator"` and the project (`seatCommand.ts:1259-1270`) | that engine start |
| Rotation, manual or automatic, to any engine and account | the successor is the same spawn (`runOrchestratorRotation`, `seatCommand.ts:1489`) | the successor's engine start. The handoff carries no rule text |
| Resume after a host death, a deploy restart, an account migration | resume successor of a conversation whose recorded role is `orchestrator` | that engine start. A seat designated before this change gets its selector here |
| A deputy | the fork runs under the seat's launch profile (`src/lib/orchestrator/deputyCommand.ts:254-263`) | the deputy's start |
| An adopted conversation (`create_orchestrator` with `conversationId`) | its role is recorded at activation; the selector arrives with its next engine start | that later start (Deferred) |

All of these are the structured transport: the default wherever the runtime
host runs, and the only one a pipeline stage uses (`engine.ts:726`). A seat
launched over the tmux transport has no start-instruction channel and starts
without a block; its write path still works (Deferred).

A seat's own write needs no refresh: the seat wrote the text in the same
conversation. A rule the curator or a stage changes reaches a running seat at
its next engine start.

**The text.** `learnedRulesBlock(project, roleId)` (`roleStore.ts:180-192`)
is unchanged in what it selects. `renderBlock`
(`src/lib/memory/roleRender.ts:43-53`) picks its second line and its closing
line by the reader's role: `orchestrator`, `maintainer`, or any other role,
which keeps today's two lines byte for byte. The headings need no change
(`scopeHeading`, `roleRender.ts:19-24`, already renders "Role rules ·
Orchestrator on this project").

For a seat:

```text
Learned rules (Delegatus role memory): 2 role · 37 project · 25 machine
Earlier seats and stage agents left these. They are rules of thumb: the operator's word, your mandate and the project's instruction files win where they disagree. Keep them on this machine: act on a rule in your own words and never paste its text into a brief, task, report, message, commit, pull request or issue; name it by its id.

Role rules · Orchestrator on this project
- [<id>] <rule>

Role rules · Orchestrator on every project
- none yet

Project rules · every role on this project
- [<id>] <rule>

Machine rules · every project on this machine
- [<id>] <rule>

If you are this project's designated seat, this is your role's memory: every later seat of this project reads it, on any engine and account, while your engine's own memory reaches one account. When you meet a problem that can come back, settle it in the same turn. A practice (how to brief, what to check before you report, how the operator wants a thing done) becomes a rule: call leave_lesson with lesson, or with rewrite and the id of a rule above that proved wrong or too narrow. A concrete defect goes to the board: find or create its task with create_task, and tell the operator in chat when it is critical (it blocks accepted work, loses data, or will hit every lane). A problem report that a wake delivers says what to do with it. leave_lesson's description gives the levels and limits.
```

The closing opens with a condition because the admission cannot know whether
an `orchestrator` launch will be designated; a pipeline stage or a child spawn
with that role reads the same block, and `leave_lesson` refuses it outside a
request.

For a maintainer, the second line is the stage line with "Earlier agents and
this project's seat left these", and the closing is:

```text
You leave no rules in this run. This project's seat keeps the rules for your role and opens the tasks for defects.
```

With an empty store the block still renders its headings with "none yet" and
the closing line, so a first seat reads the instruction before any rule
exists. With `LLV_ROLE_MEMORY=off` no block is delivered and the call is
refused, which matches.

### 2.5 The mandate stays as it is

The pinned specification says the rules are "rendered into the seat's startup
and rotation mandate" and that "the mandate tells the seat when". This design
delivers both through the seat's start instructions, beside the mandate, and
leaves `ORCHESTRATOR_SYSTEM_PROMPT` and its version untouched. The reasons are
measured:

- The delivered default has 22 bytes under its tested bound and 1 880 under
  the envelope (1.5). The four scopes a seat reads are about 16 KB today and
  may reach 40 KB.
- A mandate is the first user message of a conversation that lives for days.
  An engine that compacts its context summarises that message; the start
  instructions stay in force for the whole conversation.
- A rotation hands the successor the incumbent's mandate, so rule text inside
  it would be carried stale and would have to be replaced at delivery, the way
  the role table is. A pending seat intent replays the bytes its first attempt
  recorded (`seatCommand.ts:1215`), so the seat record would have to store
  rule text. The selector stores none.
- The start instructions reach a seat on a bespoke or an older mandate with no
  delivery directive and no version bump.

The operator's sentence asks that the seat have its role's memory and act on
problems. Both hold at every start on every engine. Notes records this reading
of the acceptance wording.

### 2.6 The problem-to-task path

One rule decides, in the seat's own turn: **a practice becomes a rule; a
concrete defect becomes a board task; a critical one is also told to the
operator.**

- **The store refuses defects.** The seat path calls the guards of lane
  26b1a14a before it writes. For a seat the `LESSON_IS_PROBLEM` message reads:
  "this reads as a concrete defect or names a file. A defect goes to the
  board: find or create its task with create_task, and tell the operator when
  it is critical. A practice is written as an imperative, without the
  project's file or fact." The same message answers a `problem` answer from a
  seat. Nothing is stored and nothing is queued: the seat is the role that
  owns the board.
- **The task.** The seat follows its mandate's task-ownership section as it
  stands: look for the task that already owns the outcome, create one only
  when none does, give it a title and an icon and colour by the rule
  (`src/lib/tasks/colorRule.ts`: coral for a bug or a regression). Creating
  the task starts no lane; starting work follows the start contract the
  mandate already states.
- **Critical.** The closing line defines it in one clause (it blocks accepted
  work, loses data, or will hit every lane) and tells the seat to say so in
  chat. The mandate's own rule then applies: an outcome that must reach the
  operator while they are away also goes into a bridge report.
- **A Delegatus failure seen from another project's seat** keeps its own
  path: the mandate's bug-report section (ask, preview, publish on the
  operator's yes). That project's board is not where a Delegatus defect is
  fixed.
- **Problem reports from stages** (lane 26b1a14a) arrive as wake items that
  carry their own instruction. This design leaves that instruction alone and
  says so in the closing line. Notes records one wording to align.

The server makes no task itself. `create_task` already carries the lookup
discipline, the project fence and the receipt; a second creator inside
`leave_lesson` would duplicate all three.

### 2.7 The curator

- `noRoleReader` (`curation/apply.ts:37-39`) drops its two last terms. A role
  outside the registry and the four clean roles stay without a reader. Active
  rules may then stay in, move into and merge within `role:<project>:orchestrator`,
  `role:<project>:maintainer` and their every-project scopes.
- Check 3 of the brief (`curation/brief.ts:3`) replaces its second sentence
  with: "Reviewer, verifier, issue reporter and curator stay clean. The
  orchestrator seat and the board maintainer read rules: their own role
  scopes, the project and the machine. Their role rules are about running the
  board and the lanes: how to brief, what to check before a report, how the
  operator wants work shown. A project or machine rule about work in the
  repository keeps its level when the roles that work in the repository all
  act on it. For the orchestrator scope the role's instructions are the seat's
  mandate: read it with get_orchestrator full:true."
- Nothing else changes. A pass already covers both roles' scopes
  (`passScopes`, `curation/store.ts:81-85`, maps every registry role), the
  scope read already returns the same role's rules from other projects, and
  the task check, the currency check, merges, splits, ranking, the bound and
  Undo treat a seat rule as any rule. The transfer of a misfiled rule to a
  problem report (lane 26b1a14a) routes by the rule's source project, which a
  seat source carries.

The four rules of 1.4 become readable the moment this ships. Section 5 gives
the order that keeps them.

### 2.8 The board maintainer

**It reads.** The selector of 2.4 covers the role, so a run starts with its
role scopes, the project and the machine. That gives project-specific board
practice a home outside shared code: on 2026-10-02 the operator rejected a
lane that wrote one project's board rule into the shipped maintainer text for
every project, and asked that such a rule be applied through the seat.

**The seat writes for it**, with `lesson { scope: "role", role: "maintainer" }`.
The operator corrects board handling in the seat's chat, and the seat reads
every run's outcome, so the seat is where a maintainer's mistake becomes
visible.

**It writes none itself.** Three facts decide this:

- Its tool policy fails closed on new mutating tools by design, and its
  scaffold is one long checklist for a medium-effort model. A maintenance run
  cannot see that its board judgement was wrong; the correction comes later,
  from the operator through the seat.
- What it meets during a run reaches the seat already, as `left:` and
  `attention:` lines in the wake item, and the seat now has both outcomes for
  it: a rule or a task.
- No record shows a lesson a maintainer needed and could not leave. Every
  stored rule was written by a stage role (builder 329, architect 60,
  prod-auditor 12, merger 7, visual-critic 3).

Deferred names the mechanism that would give it the write path when a record
justifies it.

### 2.9 The rules window

No component changes. The window builds its role tabs from the role scopes
that hold a row (`src/components/roleMemory/LearnedRules.tsx:329-334`), and
both roles have localised names (`src/lib/i18n/uk.ts:1297`, `:1370`:
«Оркестратор», «Доглядач дошки»). On main, this project's window lists an
orchestrator tab for the two rules of 1.4. A seat rule appears there with the
existing provenance line; delete, return and revert work as for any rule, and
the curator's passes and their Undo cover it.

### 2.10 Privacy and egress

- Lesson text stays on this machine. A seat rule passes the same hints
  (`rulePrivacyHints`), the same known-values file for the publication gate,
  and the same boundaries as every rule: stage prompts and their files
  (`src/lib/pipelines/stageInput.ts`, `engine.ts:633`), the runtime switch,
  the linked board's feeds, bridge and issue reports.
- **One boundary is new.** A seat that holds rule text also holds the only
  cross-machine message channel: `send_message_to_orchestrator` with `machine`
  (`bindOrchestratorSend`, `bindings.ts:7059-7092`). When the relay names
  another machine, its text passes through `withoutStoredLessons` before it is
  bound; an unreadable store refuses the relay with
  `LESSON_PRIVACY_UNAVAILABLE`, as every other boundary does. A relay to a
  seat on this machine is unchanged.
- The seat's block tells it to act on a rule in its own words and never paste
  one into a brief. A pasted rule would reach a stage as "[learned rule]".
- The selector is text-free, so receipts, the seat record, `get_orchestrator`
  and the handoff digest hold no rule text.

### 2.11 Files

| File | Change |
| --- | --- |
| `src/lib/agent/registry.ts` | the selector for `orchestrator` and `maintainer` launches and resumes (2.4) |
| `src/lib/memory/roleRender.ts` | second line and closing line by reader role (2.4) |
| `src/lib/memory/roleTypes.ts` | `RuleSource` as a union with the seat source (2.3) |
| `src/lib/memory/roleStore.ts` | shared lesson body, `leaveSeatLessons`, `stageId` in the view (2.3) |
| `src/lib/memory/roleStage.ts` | `leaveLessonForSeat`: answers allowed, guards, seat wording of two refusals; the neither-caller refusal text (2.1) |
| `src/lib/mcp/bindings.ts` | seat resolution in `leaveLesson` (2.2); the lesson filter on a cross-machine relay (2.10) |
| `src/lib/mcp/server.ts` | one sentence in the `leave_lesson` description (2.1) |
| `src/lib/memory/curation/apply.ts` | `noRoleReader` (2.7) |
| `src/lib/memory/curation/brief.ts` | check 3 (2.7) |
| `docs/design/role-memory-curation.md`, `docs/design/role-memory.md` | the reads-and-writes table and §3.0 name the two roles as readers |

Untouched: the mandate and its version, the hosts and their option builders,
the launch-profile contract, the seat tick, the maintainer's scaffold and tool
policy, every component.

## 3. Options weighed

| Question | Chosen | Not chosen, and why |
| --- | --- | --- |
| Where the seat keeps a practice | a role scope of the existing role memory | The monitor note: no levels, versions, curator or window, and a successor sees it only when it changes. Copying the engine's memory between accounts: two engines, two formats, and the operator still could not see or curate it. A new seat store: a second memory beside the one the window shows |
| How the seat writes | `leave_lesson`, caller resolved to a seat | A new tool: a second schema, description and policy entry for the same record. A field on `seat_tick_settings`: that tool configures the tick |
| How the rules reach a seat | the launch selector and the start instructions every stage uses | A section in the mandate: 22 bytes free, stale copies through rotation, rule text in the seat record (2.5). A wake item: repeats on every wake, the cost #2030 removed |
| Where "when to write" lives | the closing line of the seat's block | A mandate sentence under a new version: it needs bytes the envelope does not have, marks every seat stale, and reaches bespoke mandates only through a delivery directive |
| Which scopes a seat reads | the four a stage reads | Role scopes only: a second selection path beside the stage one, and the seat stays blind to project practice it writes briefs around; one of the pinned examples is such a fact |
| What a seat may address | the stage grammar: its role, another role, the project, the machine | Its own role only: extra code to narrow an existing grammar, and the maintainer would have no writer |
| What happens to a defect | refused with a steer; the seat calls `create_task` | The server creates the task: a second task creator without the lookup discipline. Stored as a problem row for the seat itself: a queue whose only reader wrote it |
| The maintainer | reads; the seat writes for it | The same write path: no record asks for it, and its policy would have to open (Deferred). Nothing at all: board practice for one project would keep going into shared text |
| A rate limit on seat writes | none | A daily cap: the seat's private notes ran at about four a day with a peak of ten; the scope bound and the curator's cooldown already bound the effect; a cap would also slow the first carry-over of those notes |
| The record of a seat write | the rule row with a seat source | A new row kind: nothing reads it. No rate limit, no problem carrier and no request exist to need one |
| A deputy's call | speaks as its seat | Refused: the write is reversible and gated by the same guards, and the refusal would be a special case |

## 4. Tests

Each file runs by path through `bash scripts/gate-slot.sh bun test <file>`
with HOME, `XDG_CONFIG_HOME`, TMPDIR and `LLV_STATE_DIR` under a private
temporary root and the control URL on a closed port. A test file whose old
fixtures fail the current privacy detectors takes its new cases in the sibling
named below.

**A seat rule reaches a fresh seat on the other engine**
(`src/lib/memory/roleDelivery.test.ts`, beside the existing
`test.each(["codex", "claude"])` at `:32`):

1. A rule left through the seat path (a seat source, project A) appears in
   `developerInstructions` of a Codex start and in `appendSystemPrompt` of a
   Claude start whose launch profiles the registry admitted with the role
   `orchestrator` and project A, fresh and resumed, under a different account
   id from the writer's. The profile and the receipt hold no rule text.
2. The same block carries the seat's second line and closing line and lacks
   the stage pointer. A builder stage's block for project A lacks the
   orchestrator-scope rule and is byte-identical to today's rendering.
3. A seat rule left with `scope: "project"` appears in both the seat's and
   the builder's block.
4. An empty store still yields the closing line for a seat; the kill switch
   yields no block.

**The selector** (`src/lib/memory/roleLaunch.test.ts` or a sibling
`roleSeatLaunch.test.ts`, through `AgentRegistry.beginSpawnRequest`):

5. A launch with the role `orchestrator` and an explicit project carries
   `{ project, roleId: "orchestrator" }`; `maintainer` likewise; a
   `spawn_agent` builder carries none; a clean role carries none and is clean;
   a pipeline stage's selector is kept as given.
6. A resume successor of a conversation recorded as `orchestrator`, whose
   stored profile has no selector, gains it; a launch with no resolvable
   project gains none.

**The call** (`src/lib/mcp/leaveLesson.test.ts` or a sibling
`leaveLessonSeat.test.ts`, through the MCP service with `callerAttribution`
and `authorizedSeats` injected):

7. A seat's `lesson` with `scope: "role"` is stored active under
   `role:<project>:orchestrator` with a seat source; no request row exists
   before or after. `role: "maintainer"` lands in the maintainer scope.
8. A seat's `rewrite` of a rule it reads keeps the id, keeps the earlier text
   as a version, and moves an uncurated rule to the end of the leaving order.
9. **Workers are refused**, each storing nothing: a `spawn_agent` worker
   (`LESSON_NOT_AN_ATTEMPT`), a stage agent nobody asked
   (`LESSON_NOT_REQUESTED`), a predecessor seat whose epoch is revoked, a
   conversation with the role `orchestrator` and no designation, a
   `manager` attribution with no project (`LESSON_NOT_A_SEAT`), a maintenance
   run and the curator through their tool policies.
10. **A defect-shaped rule is steered to a task**: a text that says something
    fails, and one that names a source file, answer `LESSON_IS_PROBLEM` with
    `create_task` in the message; so does a `problem` answer. The store is
    unchanged and no wake signal appears.
11. `none` from a seat is `LESSON_INVALID`; a task identifier is
    `LESSON_ABOUT_ONE_TASK`; a machine rule naming this repository is
    `LESSON_WRONG_LEVEL`; a clean role in `lesson.role` is `LESSON_CLEAN_ROLE`;
    the kill switch is `LESSON_SWITCHED_OFF`.
12. Texts carrying an email-shaped and a home-path-shaped value generated at
    run time: the email-shaped one is stored with its hint and appears in the
    known-values file; the path-shaped one is steered as in 10.
13. The seat of project A, called from a working directory of project B,
    writes into A. A live deputy's call is stored with its seat's
    conversation. A replayed `clientRequestId` stores one rule.
14. The stage path is unchanged: the existing cases of the file pass
    untouched.

**The curator** (`src/lib/memory/curation/curation.test.ts` or a sibling
`seatRules.test.ts`):

15. With two active rules in `role:<project>:orchestrator`, an apply that
    keeps and orders them succeeds. On main this call is refused
    `CURATE_NO_READER`.
16. A move from the builder scope into the orchestrator scope, a move from
    `role:<project>:orchestrator` to `role:*:orchestrator`, a merge of two
    orchestrator rules and an archive as `stale` succeed; a target under
    `reviewer` is still `CURATE_NO_READER`.
17. A seat write raises `curationStatus().newLessons`; Undo of a pass restores
    a seat rule it archived.
18. The brief holds the new check 3 and no longer says "no learned-rule
    level". On lane 26b1a14a's code, a curator transfer of a seat-written
    rule reaches the same project's wake agenda.

**The relay** (`src/lib/orchestrator/relay.test.ts` or the bindings test that
covers `send_message_to_orchestrator`):

19. A relay that names another machine and quotes a stored rule is bound with
    "[learned rule]" in its place; with an unreadable store it is refused
    `LESSON_PRIVACY_UNAVAILABLE`; a relay to a seat on this machine is bound
    as written.

**The window** (`src/components/roleMemory/LearnedRules.render.test.tsx`, and
the existing case "role memory: rules window and the rule line" of
`src/components/mobile/issue1671Evidence.browser.test.tsx`):

20. A view with orchestrator and maintainer role scopes renders both tabs
    with their Ukrainian and English names and their rule rows. The driver
    case gains the two scopes in its fixture and measures the tab row at 390 px
    in Ukrainian: no clipped label, the selected tab inside the row.

An optional model case for `curator.eval.test.ts` (run only with
`LLV_CURATOR_EVAL=1`): an orchestrator scope holding one rule that narrates a
task and one general practice ends with the first archived as task-specific
and the second active.

The project's own checks then apply as the hooks run them: pre-commit
(whitespace, privacy with the committed fingerprints, eslint) and pre-push
(commit publication, types, changed-file lint, touched tests against the merge
base, the scoped gates). The mandate tests (`prompt.test.ts`,
`handoffDigest.test.ts`) need no edit and stay green, because no mandate text
changes.

## 5. Coordination and rollout

**Lane 26b1a14a.** PR #2779 is open with its fix stage running. This design
calls its guards, its `problem` reason and its rewrite refresh, and edits
eight files that lane edits (`roleStage.ts`, `roleStore.ts`, `roleRender.ts`,
`roleTypes.ts`, `curation/apply.ts`, `curation/brief.ts` and the two MCP
files). The build therefore starts from main after #2779 merges. The edits
are disjoint by line: this design changes check 3 of the brief (that lane
changes 1, 5, 7 and the closing sentence), the `noRoleReader` terms, the
reader-dependent lines of the block, and adds a second entry point beside
`leaveLessons`.

**Deploy order.** Production stays on `0ef6ec49` until the incident clears,
and the curator of #2768 has never run there. Its first pass under today's
code takes the four orchestrator rules of 1.4 out of their scopes, archived
as `no-reader` by its brief. Two orders keep them: this change ships in the deploy that first runs the curator, or
the operator returns the four in the rules window afterwards. Nothing here
deploys.

**The seat's private notes.** Once the path is live the seat carries its own
notes over, one `leave_lesson` per practice that passes the guards. Notes
about one task stay where they are; defects among them become tasks.

**How we will know**, two days after the deploy, from the store and the
board:

- active rules with a seat source per project, and how many the curator kept;
- a rotation to the other engine whose successor names its role rules by id
  in its first status;
- `LESSON_IS_PROBLEM` refusals from seat callers against tasks the seat
  created in the same turn;
- seat writes per day against the four a day of the private notes;
- new private notes per day in the engine's memory, which should fall.

## 6. Validation against the requirement and the acceptance

| The operator said | This design |
| --- | --- |
| «я не помню, у нас память для оркестратора существует или не существует» | It did not: the seat read nothing and could write nothing (1.3, 1.4), while four rules addressed to it sat unread |
| «тебе тоже надо в память свою иметь свою, как память для своей роли» | `role:<project>:orchestrator`, read at every engine start on any engine and account (2.3, 2.4) |
| «писать себе … каждый раз, когда ты натыкаешься на какую-то проблему» | The closing line of the seat's block says when; `leave_lesson` takes the write unasked (2.1, 2.4) |
| «либо писать в память, либо … создавать задачу на исправление, если это критичная вещь» | A practice becomes a rule; a defect is refused by the store and becomes a board task the seat creates; a critical one is told to the operator (2.6) |

| Acceptance criterion | Where |
| --- | --- |
| The seat leaves a rule for its own role with the stage guards | 2.1, 2.3; tests 7, 8, 11, 12 |
| A concrete defect is never stored; it becomes a task; critical ones reach the operator | 2.6; test 10 |
| Rendered at startup and rotation on every engine and account | 2.4; tests 1 to 6. Delivered in the start instructions, beside the mandate (2.5) |
| Shown in «Вивчені правила» under the orchestrator role | 2.9; test 20 |
| The curator curates them | 2.7; tests 15 to 18 |
| The maintainer gets the same treatment, or the design says why | 2.8: it reads, the seat writes for it, and three facts explain why it writes none |
| An MCP call usable outside a stage, seat identity checked by the server, workers refused | 2.1, 2.2; tests 9, 13 |
| The seat is told when | 2.4, 2.5 |
| The four named tests | tests 1, 9, 10, 15 |
| Built on lane 26b1a14a | 1.7, 5 |

## Deferred — not currently justified

- **The maintainer leaving its own rules or problem reports.** The cheap
  mechanism exists when a record asks for it: record one lesson request per
  run under the run's id, admit `leave_lesson` in `permitMaintainerTool`, and
  the stage path, the one-answer budget and the problem delivery of lane
  26b1a14a work unchanged.
- **A cap on seat writes per day.** Revisit when seat writes pass ten a day
  for a project or when seat writes alone trigger curator passes.
- **Rule text or a "when" sentence in the mandate.** The envelope has 22 bytes
  (2.5).
- **Direct seat writes to `role:*:orchestrator`.** The curator widens after
  reading other projects, as for every role.
- **Delivering the block to an adopted conversation at adoption.** It arrives
  with the next engine start; a rotation brings it at once.
- **Refreshing a running seat when another writer changes a rule.** The next
  engine start does it.
- **Importing the seat's private notes automatically.** They mix practice,
  task notes and defects; the seat sorts them through the guards.
- **Turning the engine's own memory off for the seat.** It also holds notes
  about one task and pointers, which stay there.
- **A task count for seat rules** ("from N tasks"). A seat write is tied to no
  task.
- **A read tool that lists rules for the seat.** The block shows the active
  ones; the window shows the rest to the operator.
- **A stored-lesson filter on `telegram_bot_send`.** It is absent today for
  stage agents as well (`bindings.ts:4904`); it belongs to a change of its
  own.
- **An operator path to write a new rule in the window.** Unchanged from the
  earlier designs.
- **A block for a seat launched over the tmux transport.** Rules ride in the
  structured hosts' start instructions, for stages as well.
- **Sharing rules between machines.** Role memory is local to an installation.

## Notes

- The acceptance says "mandate" twice. The mandate text does not change: the
  rules and the instruction arrive in the seat's start instructions at every
  engine start, for the measured reasons of 2.5. A reviewer who reads the
  criterion literally will find no new mandate sentence.
- "Machine level only when it is truly cross-project" maps to two existing
  levels (2.3). The seat writes `machine` under the existing guard and leaves
  the every-project orchestrator level to the curator.
- Two instructions will reach a seat about defects once both lanes ship.
  For its own observation the closing line says to create the task. For a
  stage's problem report the wake item of lane 26b1a14a says to decide and to
  ask the operator before creating it. The operator's words of 06:00 UTC leave
  the decision with the seat («пусть он думает, … создавать задачу, не
  создавать»), so one string in `roleProblems.ts` could align the two; this
  design leaves that lane's text alone.
- A preference written as a fact about the operator is refused as a defect by
  a structural hint (1.7). The refusal names the imperative form.
- The first curator pass in production archives the four waiting orchestrator
  rules unless this change is in the same deploy (5).
- A pipeline stage with the role `orchestrator` has always read the
  orchestrator scope through the engine's selector; the curator's `no-reader`
  rule ignored that.
- `telegram_bot_send` carries no stored-lesson check today, for any role.
- The block is delivered on the structured transport. A seat launched over
  tmux can write rules and reads none at its start.
- Probe B opened the operator's store read-only and printed counts and sizes
  only. No rule text was copied into this document.

## Appendix: the probes

Each ran from an export of the named commit under the stage's scratch
directory, with dependencies linked from a checkout whose lockfile matches,
through `scripts/gate-slot.sh`, with HOME, `XDG_CONFIG_HOME`, TMPDIR and
`LLV_STATE_DIR` under that scratch directory.

**A. The mandate envelope** (main `212d9780e`):

```ts
import { ORCHESTRATOR_SYSTEM_PROMPT, orchestratorMandateForDelivery } from "@/lib/orchestrator/prompt";
import { ROLE_DEFAULTS } from "@/lib/roles/defaults";
import { resolveSpawnRole } from "@/lib/roles/registry";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";
const bytes = (text: string) => Buffer.byteLength(text);
const delivered = bytes(orchestratorMandateForDelivery(ORCHESTRATOR_SYSTEM_PROMPT, ROLE_DEFAULTS));
const role = resolveSpawnRole({ role: "orchestrator", roleParams: { mode: "standard" } });
const overhead = role.ok && role.value ? bytes(role.value.scaffold) + 2 : 0;
console.log({ delivered, overhead, left: MAX_STRUCTURED_TEXT_BYTES - overhead - delivered });
```

**B. The store**, given the path of `state.sqlite`, read-only:

```ts
import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { readonly: true });
const rows = (name: string) => (db.query("select value_json v from state_rows where collection=?").all(name) as { v: string }[]).map(row => JSON.parse(row.v));
const memory = rows("role_memory");
const rules = new Map(memory.filter(row => row.kind === "rule" && !row.versionOf).map(row => [row.id, row]));
const roleOf = (scope: string) => scope.startsWith("role:") ? scope.slice(scope.lastIndexOf(":") + 1) : null;
for (const scope of memory.filter(row => row.kind === "scope")) {
  const active = scope.active.map((id: string) => rules.get(id)).filter(Boolean);
  console.log(roleOf(scope.scope) ?? scope.scope.split(":")[0], active.length, [...active.map((rule: any) => `- [${rule.id}] ${rule.rule}`).join("\n")].length);
}
for (const rule of rules.values()) if (["orchestrator", "maintainer"].includes(roleOf(rule.scope) ?? "")) console.log(rule.state, rule.reason ?? "-", rule.source.roleId, rule.createdAt.slice(0, 10));
console.log("curation rows", rows("role_memory_curation").length);
```

**C. The guards** (lane 26b1a14a at `7568d7d24`): each text of the table in
1.7 through `parseLessons({ lesson: { scope, rule, why } }, "orchestrator")`
and `assertGenericRule(rule, scope)`, printing the refusal code or
"admitted".
