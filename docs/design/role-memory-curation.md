# Role memory curation: rules rewritten in place, merged and generalized per level

Status: slice A implementation. Slices C and B
follow in later lanes, in that order (section 4). Written 2026-10-11 against
`main` at `e5cd0ff3d`; every `file:line` below is from that commit. It
extends `docs/design/role-memory.md` ("the MVP design") and rests on the
role memory quality analysis of the same night, whose report and frames stay
outside the repository under
`$HOME/.local/share/delegatus-evidence/role-memory-quality/`. No rule text
from the live store appears here; the examples are invented.

## Originating requirement

Operator, 2026-10-11 01:59 Kyiv (2026-10-10 22:59 UTC), orchestrator seat
chat, by voice, in Russian, after the analysis. Verbatim:

> Э-э, по поводу уроков этих выученных, по поводу памяти. Нужно, чтобы оно
> могло. Иметь возможность перезаписывать уже созданные фрагменты. Э-э, и в
> идеале это же у нас абстрактные правила должны записываться, поэтому в
> идеале оно должно даже как-то группироваться, объединяться,
> консолидироваться.

Twenty minutes earlier, the request that started the analysis:

> Я вижу память уже. Работает, я вижу, что проблема есть. Что память уже
> забита, и слишком много. Пишется. То есть там должны быть такие заметки,
> которые, как бы, универсальны будут для любой задачи, просто зависят от
> разных уровней. А он говорит про конкретные задачи, как мне кажется. Надо
> проанализировать и подумать, как мы это можно изменить.

The operator's answers to the analysis's five questions, prototype review on
the task, 2026-10-11 02:02 Kyiv. The labels the operator chose, verbatim:

1. «Скільки правил максимум на рівень (роль / проєкт / машина)?» →
   «Без стелі за кількістю, 10 000 символів на область, як зараз»
2. «Що зробити з 140 наявними правилами?» → «Перший прохід куратора:
   узагальнити, злити, архівувати з причиною (усе можна повернути)»
3. «Хто доглядає пам'ять?» → «Агент-куратор на тіку місця, коли набралось
   ≥10 кандидатів або минуло 6 годин»
4. «Де лишати уроки про конкретну задачу?» → «Ніде: агент пише їх лише у
   звіт етапу»
5. «Чи отримує наступний агент новий урок одразу, ще до куратора?» → «Так,
   одразу в загальний список, як зараз»

Three minutes later the seat asked in chat whether to keep 10/10/6 and the
curator thresholds, and the operator answered «так і це пріоритетні задачі».
The seat followed the form, told the operator that 10/10/6 is one parameter
if wanted, rewrote this lane's build and review prompts to the form's
answers, and sent this stage the same five answers as a correction that wins
over the specification. This document follows them.

Ten minutes after the form, two more voice messages in the same chat set the
level boundaries. 2026-10-11 02:13 Kyiv, verbatim (relayed by the seat to
this stage as a requirement for the curator and the write path alike):

> Куратор, э-э, также должен как-то смотреть на то, типа, память, насколько
> она... Действительно актуальна... То есть, учитывая, что это память у
> нас... которая инжектится для каждого агента, который создаётся, там нужно
> учитывать правильно все вот эти boundaries, то есть, и ни одна память не
> должна обсуждать. Задачу. И, например, билдер, э-э, билдеру, например, не
> нужно знать про то, как работать с... Я не знаю, с тем, что делает
> ревьюер. То есть у ревьюера это должно быть, если это что-то specific для
> reviewer. А если... ну, то есть, для каких-то задач, которые он делает. А
> если это specific для проджекта, проекта, то есть оно должно быть такое,
> что делают и тот, и другой. И, соответственно, на машине то же самое: то,
> что память должна быть такая, которая делает во всех проектах что-то
> общее для всех. Вот это должно быть учтено правильно в задаче этого
> аудитора памяти.

2026-10-11 02:14 Kyiv, verbatim (read in the seat conversation; not yet
relayed to this stage when this was written):

> А, и забыл очень важный момент: нам нужно, получается, память
> cross-projects, да? Только для какого-то... для какой-то конкретной роли.
> То есть, грубо говоря, у нас могут быть какие-то заметки для билдеров,
> которые общие для разных проектов.

The seat's relay states the first as: no rule may discuss a specific task;
role level holds only what is specific to that role's own kind of work;
project level only what every role working in the project does in common;
machine level only what holds across all projects; and the curator judges
whether each rule is still current against the code, `AGENTS.md` and the
tooling. It asks for the curator's operations to include moving a rule to
its level or splitting it, archiving as task-specific, stale or already
enforced, and merging across roles into the project only when every role
needs it; for the same level test at write time; and for an explicit
checklist with tests for each boundary. The second message adds a fourth
level: one role across every project on this machine. Section 3.0 defines
the four levels; 3.3 applies them at write time and 3.6 in the curator's
checklist; section 4 lists a test per boundary.

2026-10-11 02:58 Kyiv, the operator's comment on another prototype review
(the audit of duplicated mechanisms), verbatim:

> Я вот думаю, чтобы это было всё эффективно работало, наверное,
> желательно, чтобы файлы, наверное, через SQL память работала, чтобы
> быстрее это всё работало. Как ты думаешь, и инжектилось правильно?

The seat relayed it to this stage as a requirement on delivery: every
eligible agent always receives its rules as text, rendered from SQLite at
launch into a channel the message envelope does not bound, with no
per-launch rule files, in slice A. Section 3.5 answers it.

Two older requirements still bind. 2026-10-07, quoted in the MVP design:
«Надо ограничить, например, каким-нибудь там 10 000 символов» and «Какое
абстрактное правило, то есть не конкретное, а именно абстрактное правило
записать, чтобы такой класс ошибок больше не ловился». 2026-10-02: «Может
быть, они потом понадобятся»: nothing is deleted, and whatever leaves the
injected list can come back.

The default answer to "should we build this" is no. The operator asks for
rewriting, grouping and consolidation in so many words, so the question this
document answers is the smallest build that does those three things.

### Where the answers supersede the pinned specification

The lane's pinned specification was written before the form was answered.

| Pinned specification | Operator's answer | This design |
| --- | --- | --- |
| Injection caps of 10 role, 10 project and 6 machine rules | 1: no count cap; 10 000 characters per scope, as now | No count cap. Each scope keeps its 10 000-character bound, and curation decides what fills it (3.2). Caps stay a one-constant option (Deferred). |
| Task narration is archived with the reason «about one task» | 4: nowhere; the stage report only | `leave_lesson` refuses it and stores nothing (3.3). A stored rule that turns out to be about one task is archived by the curator, reversibly (3.6). |
| New lessons are candidates, injected only after a curator pass | 5: at once, in the general list | A lesson is active at once. The curator reviews it afterwards. There is no candidate state. |
| Candidates visible in the window and in search | follows from 4 and 5 | Nothing new needs search (Deferred). |
| Curator at 10 candidates or 6 hours | 3: the same | At 10 new lessons or rewrites since the last pass, or 6 hours after the project's last pass while its scopes hold active rules, new lessons or none (3.6). |
| First curator pass over the existing rules | 2: the same | 3.9 |
| Rewrite by id with a kept version; «nothing new» by default; at most one new lesson that passes the cross-task test; no «Why» lines at start | not asked | Kept (3.3 to 3.5). |

## 0. Was this solved before

`search_transcripts`, project-scoped and unscoped: «перезаписывать уже
созданные фрагменты группироваться объединяться консолидироваться», «role
memory curator candidates rewrite rule by id versions». `search_memory`:
«role memory learned rules curator consolidation candidates».

| Hit | What it settles |
| --- | --- |
| The seat conversation, 2026-10-10 22:39 to 23:15 UTC | All four quotes above, the form decision as delivered to the seat, the seat's question about 10/10/6 and its reconciliation in favour of the form. |
| The analysis lane, 2026-10-10 22:40 to 22:55 UTC | Root causes at `file:line`, the classification of the 140 rules, four variants and the five questions. |
| `search_memory` | Nothing about curation of role memory. |

Two earlier designs supply parts. The MVP design's section 2.5 specified
consolidation by a model: a total partition of a scope's rules into kept,
rewritten, merged and archived, checked by the server, with a rebase over a
scope that moved meanwhile. The MVP deferred all of it (its section 3.1,
"Later"). This design reuses the partition and the server's check, runs them
from an agent that reads the code (answer 3 and the pinned specification),
and drops the rebase: a call against a scope that moved is refused and the
curator repeats it. `docs/design/board-maintainer.md` supplies the seat-tick
launch machinery the curator reuses.

## 1. What the code does today

| Piece | Where | Relevance |
| --- | --- | --- |
| Bound | `src/lib/memory/roleTypes.ts:9` | `ROLE_MEMORY_BOUND = 10_000` code points per scope, measured on the injected lines. |
| Lesson limit | `roleTypes.ts:14`, `roleStore.ts:211` | Up to three lessons per stage attempt. |
| States | `roleTypes.ts:29-30` | `active`, `merged`, `archived`; reasons `duplicate`, `budget`, `deleted`. |
| Injected line | `roleConsolidate.ts:18-19` | `- [id] rule Why: why`: every rule carries its story into every start. |
| Append | `roleConsolidate.ts:50-71` | A word-for-word repeat merges into the earlier rule; then, at `:65-69`, the oldest rule is archived while the scope is over the bound. |
| The same age loop elsewhere | `roleStore.ts:137` (a project key that moved), `:281` (the operator's Return) | Age decides what survives in all three writers. |
| Write path | `roleStore.ts:198-245` | One transaction per call; `:243` rewrites the known-values file the publication gate reads. |
| Storage | `roleStore.ts:51`, `:59`, `:44-50` | One collection, `role_memory`, schema version 1, `strictDecode: true`; `decode` accepts rule, scope and request rows and nothing else. |
| Egress | `roleStore.ts:364-371`, `:373-377` | Every rule and why of every rule row, whatever its state, is a known value; a store that cannot be read refuses every relay, linked-board page, bridge report and publication with `LESSON_PRIVACY_UNAVAILABLE`. |
| Request | `roleRender.ts:64`, `:72-74`, `:79` | "Start there"; "Write one to three lessons"; "Look first at the findings you were handed"; why is "what went wrong here"; "leaving at least one lesson is better". |
| Block | `roleRender.ts:27-37`, `roleStore.ts:164-167` | Every active rule of the role, project and machine scopes, oldest first. |
| Delivery | `roleLaunch.ts:18-53`, `src/lib/pipelines/engine.ts:622` | Inline in the first message when it fits 32 000 bytes, else a file under the state directory and a one-line pointer. |
| Engine instruction channels | `src/lib/runtime/claudeStreamBrokerHost.ts:861-862`; `src/lib/runtime/codexAppServerHost.ts:1559-1580` | Claude takes `--append-system-prompt` (used today for a Telegram notice); Codex takes `developerInstructions` in `thread/start` and `thread/resume` (used today for the same notice). |
| Validation | `roleStage.ts:79-100` | Length, letters, scope, and a refusal of rules addressed to a clean role (`:92`). |
| MCP | `src/lib/mcp/server.ts:3329`, `:3883`; `src/lib/mcp/bindings.ts:2444-2456` | `leave_lesson` runs in the agent's own MCP server process, which writes `state.sqlite` itself. |
| Window | `src/components/roleMemory/LearnedRules.tsx` | Three sections; × with Undo; "Left the rules" with Return. `:200` labels every reason other than duplicate and deleted "archived to keep 10 000". Route: `src/app/api/role-memory/route.ts`, `delete` and `restore`. |
| Seat tick | `src/lib/monitor/seatTickController.ts:1491-1493`, `:1771-1772` | Board maintenance reconciles before the gather and launches after the wake. |
| Maintenance run | `src/lib/boardMaintenance/run.ts`, `store.ts`, `guard.ts:12-31` | Durable claim per interval, `launchAutonomousConversation`, `observeSpawnedTurn`, settle; a caller is a maintainer by its registry role and its receipt's `maint_` attempt id. |

Two facts shape everything below.

**Agent MCP servers write the store with the code they started with.** An
agent launched before a deploy keeps its MCP server, and the old
`leave_lesson` with it, for as long as its session lives, and a rolled-back
release reads the same rows. Old code decodes only the three row kinds and
throws on any other (`strictDecode`), and a throw there fails every egress
check closed. So `role_memory` gains no new row kind and keeps schema
version 1. Every new field is optional on the existing rule, scope and
request rows, and the stored order of `active` keeps a meaning that old code
also acts on correctly (3.2). The curator's run records live in a separate
collection that old code never opens.

**Every stored text is a known value.** The old text of a rewritten rule
must stay in the egress set in every release that can run against the store,
the old ones included. That decides how versions are stored (3.1).

## 2. Choices this design had to make

| Question | Chosen | Set aside |
| --- | --- | --- |
| Where a rewritten rule's earlier text lives | A version row: an archived rule row with `versionOf` | An array on the rule. Old code builds the known-values file from rule rows only, so an old MCP server's next lesson would drop every earlier text from the publication gate until a new process rewrote the file. |
| How curation decides what fills the bound | The stored order of `active` is the order of leaving: never-curated rules oldest first, then curated rules from the curator's lowest rank to its highest | A rank field. Old code archives the head of the list, which would then be the curator's best rule. |
| How a task lesson is refused | The request's cross-task test, judged by the agent; a fixed refusal of the identifiers that name one change or one run; then the curator | A hint only: a lesson naming a pull request would be stored, against answer 4. A model call on every lesson: a call and a delay on every stage end for what the curator does in bulk. |
| How the curator acts | An agent that reads the code and calls one MCP tool, `curate_rules`, with `read` and `apply`; each `apply` is one checked transaction | The maintainer's pattern of parsing the final message: one malformed partition loses the whole pass, with no chance to fix it. The MVP design's one-turn headless model: it cannot read the code or the instruction files. |
| Which role runs it | A new registry role, `curator`, clean and read-only | The maintainer role: its scaffold, fences and MCP guard are about the board. |
| Count caps | None (answer 1) | 10/10/6, kept as a one-constant option. |
| The key of a role's rules for every project | `role:*:<roleId>` | `machine-role:<roleId>`. Old code reads any key that does not start with `role:` as a project scope, and its succession join would then try to resolve a project it cannot find and move the rows; with `role:*:` old code resolves `*` to itself (`src/lib/projects/aliases.ts:113-125`), leaves the row alone and never injects it. |
| Who places a rule at that level | The curator, by moving a role rule there (slice B) | Stages writing it directly. A stage knows one project; a rule placed one level too narrow is safe, and only the curator sees the same role's rules across projects. |
| How the rules reach the agent | The engine's own instruction channel, rendered from SQLite at every engine process start, from a text-free marker in the launch profile (3.5) | The first message, with or without a pointer file: the envelope is 32 000 bytes, a builder's block is about 22 KB, and a pointer can be skipped. The rule text stored in the launch profile: the profile is copied into receipts and read by many surfaces, and a resume would carry stale text. An inline fallback for an engine without a channel: both stage engines have one, so the fallback would have no caller (Deferred). |
| How a boundary is tested | Deterministic tests of each structural boundary (what a start reads, where a write lands, what an apply may move or merge), plus one opt-in fixture pass of the real curator with an expected disposition per boundary case (section 4) | Tests of the judgment alone: the judgment is a model's, so only a run of the model can show it, and that run cannot sit in the default suite. |

## 3. Design

### 3.0 Levels and their boundaries

Every agent that starts reads its levels whole, so each level holds only what
every one of its readers needs. A stage of role R in project P reads four
scopes; slice A implements all four matching scopes.

| Level | Scope key | Read by | Holds only |
| --- | --- | --- | --- |
| Role on this project | `role:<P>:<R>` (today) | stages of R in P | what R does in its own kind of work and needs only in P (one repository's gates or layout as R meets them) |
| Role on every project | `role:*:<R>` (slice A) | stages of R in any project | what R does in its own kind of work in any repository |
| Project | `project:<P>` (today) | every stage in P | what every role working in P does alike: builder, architect, critic and the rest; reviewers stay clean and read none of it |
| Machine | `machine` (today) | every stage in any project | what every role does alike in any repository on this machine: its tools, its operating system, its environment |

The boundaries that follow from it:

- **No task.** No rule at any level narrates a task, a pull request, a lane,
  an incident or one module's invariant. Everything stored is a general rule
  of its level.
- **One role's know-how stays with that role.** A rule only one role acts on
  lives under that role and nowhere wider, however useful it would be
  elsewhere. A builder never starts with a critic's know-how.
- **Shared by several roles.** Each of those roles keeps its own copy. A
  rule rises to the project level only when every role working there acts
  on it.
- **Shared by every project:** a rule rises from a project to the machine
  only when it holds for every role in every repository; a rule one role
  needs in every repository goes to that role on every project.
- **Roles that read no rules** (reviewer, verifier, issue reporter and curator,
  which stay clean by the operator's 2026-10-07 rule) have no
  level. Their know-how has no home in role memory, and a rule addressed to
  them is refused at write time (clean roles) or archived as `no-reader` by
  the curator.
- **Orchestrator and maintainer** read their role here, their role on every
  project, the project and the machine. Their rules are curated like other
  roles' rules. The designated seat writes its own rules and the maintainer's;
  see `orchestrator-role-memory.md`.
- **Current.** A rule that is no longer true against the code, the
  instruction files or the tools as they are now, or that the code or the
  instructions already enforce, leaves the injected list.

Stages place a lesson at the narrowest level that holds (3.3); the curator
moves, splits and merges toward the right level (3.6).

### 3.1 Data model

All of it is optional fields on today's rows of `role_memory`
(`roleTypes.ts`); no row is rewritten at deploy.

```ts
type RuleState = "active" | "merged" | "archived";             // unchanged
type RuleLeftReason =
  | "duplicate" | "budget" | "deleted"                           // today
  | "rewritten"                                                  // A: a version row
  | "task-specific" | "stale" | "in-code" | "in-instructions"
  | "contradicted" | "no-reader"                                 // B: curator archives
  | "undone";                                                    // B: a split part a pass revert took back

interface RoleMemoryRule {
  /* today's fields: id, scope, rule, why, state, reason, mergedInto, hints, source, createdAt, changedAt */
  versionOf?: string;          // A: this row is an earlier text of that rule
  versions?: string[];         // A: on the rule itself, its version rows, oldest first
  revisedBy?: RuleRevision;    // A: who wrote the current text, when it is not the original lesson
  keptByOperatorAt?: string;   // A: the operator returned it (Return or Undo)
  curatedAt?: string;          // B: the curator call that last placed it
  against?: string;            // B: the rule a duplicate or contradicted archive points at
  where?: string;              // B: repository-relative path[:line] for in-code and in-instructions
  note?: string;               // B: the curator's line on this change, at most 160 characters
  movedFrom?: string;          // B: the scope before the curator's last move
}

interface RuleRevision {
  by: "agent" | "curator" | "operator";
  at: string;
  source?: RuleSource;         // a stage's rewrite: its attempt, resolved by the server as today
  pass?: string;               // a curator pass
  mergedFrom?: string[];       // a merge: the rules folded into this one
  splitFrom?: string;          // a split: the rule this part came from
  revertedTo?: string;         // a revert: the version row it returned to
}
```

Scope keys stay `role:<project>:<roleId>`, `project:<project>` and
`machine`; slice A adds `role:*:<roleId>` (3.0, section 2). The new code
reads `*` as "every project" wherever it parses a scope (`roleScopes.ts`),
and no project key can be `*`.

**Version rows.** A rewrite copies the rule's current `rule`, `why`,
`hints`, `source`, `createdAt` and `revisedBy` into a new rule row with a
fresh id (`newRuleId`, `roleStore.ts:151`), `state: "archived"`,
`reason: "rewritten"`, `versionOf: <rule id>`, and appends that id to the
rule's `versions`. The rule keeps its id and its place. A version row is
never injected, never a rewrite target and never returned as a rule of its
own; it is the record a revert reads. Old code shows it under "Left the
rules" and matches its text in every egress check.

**Scope rows.** `active` keeps its type; its order is the order of leaving
(3.2). History entries gain `by: "curator"`, `pass?`,
`rewritten?: { id, version }[]`, `moved?: { id, from, to }[]`, and, for a
curator call, `before?: string[]` and `prior?: Record<id, RulePrior>` (the
fields a revert writes back, 3.6). The row gains `curatedAt?`, the last
curator call that covered the scope.

**Request rows.** `ruleIds` keeps the id of a new lesson; `rewrote?: string`
holds the id of a rewritten rule.

**The curation collection (slice B).** `role_memory_curation` in
`state.sqlite`, with its own seed, built like `board_maintenance_runs`
(`src/lib/boardMaintenance/store.ts`): `statePath("state.sqlite")` resolved
per call and never at module load, as the state ownership rules in
`AGENTS.md` require. Rows: a pass (`p:<passId>`), one row per project
(`j:<project>`: `lastPassAt`, `currentPassId`, recent pass ids), one machine
row (`m:` with the machine scope's `lastPassAt` and the machine-wide
`currentPassId`), and a conversation index (`c:<conversationId>` to its
pass) for the MCP guard.

### 3.2 Retention: curation fills the 10 000 characters

Implementation update, 2026-10-16: [memory-delivery-ledger.md](memory-delivery-ledger.md#curation-admission-and-budget)
supersedes the budget behavior below. Never-curated rules remain active through
budget overflow, scopes at 90% with pending lessons make curation due early,
and a committed curator partition must meet the character bound.

- **The bound** stays 10 000 code points per scope, measured on what an
  agent reads: the rendered lines `- [id] rule`, which no longer carry Why
  (3.5). The analysis found the Why lines were 36 % of the builder's block,
  so a full scope now holds about 43 rules of average length where it held
  about 27. The curator brief treats the bound as a ceiling (3.6).
- **Order of leaving.** `active` is stored head first to leave:
  never-curated rules oldest first, then curated rules from the lowest rank
  to the highest. A rule counts as curated when it has `curatedAt` or
  `keptByOperatorAt`. Every write normalizes the list with a stable
  partition on that test, so a tail append by an old MCP server is placed
  correctly on the next write.
- **A new lesson** goes to the end of the never-curated segment and is
  active at once (answer 5). A word-for-word repeat merges into the earlier
  rule as today (`roleConsolidate.ts:56`); a never-curated target moves to
  the end of its segment, since a second agent found it again.
- **Over the bound** after any write, the head leaves (archived, reason
  `budget`): first the oldest never-curated rule other than the one the
  write added or rewrote, then the curated rule of lowest rank. Rules the
  operator returned are passed over until no other rule is left to leave.
- **Before any curator pass** every rule is never-curated, so among them the
  head is the oldest: age is the only signal until the first pass assigns
  an order. The first pass also reads every rule ever archived for budget
  and may return it (3.6, 3.9).
- **Old code** archives the head too, so it picks the rule the new code
  would pick, except that it does not protect the lesson it just added.
- **The same rule** governs the join of a project key that moved
  (`roleStore.ts:114`) and the operator's Return (`:266`), which places the
  rule at the protected end with `keptByOperatorAt`.
- **Render order** is the reverse of `active`: the curator's best rule
  first, never-curated rules after.

### 3.3 The lesson request and `leave_lesson` (slice A)

The answer to an accepted `stage_report` carries this request, replacing
`roleRender.ts:58-81`. The fix-round line appears only on an attempt
activated by a fail edge, and drops "Start there" (`:64`).

```text
Your stage report is recorded. One question before you end this turn: did this stage show that a learned rule you were given is wrong, too narrow or unclear, or teach a rule that changes what an agent does on a different task? Most stages do neither; then call leave_lesson with none and one line saying why.
This attempt was handed 3 findings from stage review (P1 ×1, P2 ×2). They make a lesson only when a rule, followed from the start, would have prevented that class of finding on other tasks too.
Otherwise do one of these, once:
- rewrite: the id of a rule you were given, with its better text (sharper, more general or corrected) and why. The earlier text is kept and can be restored.
- lesson: one new rule; agents start with it from the next stage on. It qualifies only when you can name a different task where following it changes what the agent does, and it repeats nothing you were given and nothing the project's instruction files say. To improve a rule you were given, rewrite it.
No lesson may be about a task. What happened on this task alone (a pull request, a commit, a lane, an id, an incident, one module's quirk) belongs in your stage report, and leave_lesson refuses it.
Every agent of a level starts with all of that level's rules, so choose the narrowest level that holds:
- role: only agents of that role act on it, in their own kind of work; your own role unless you name another. Reviewers and verifiers take no rules, so a rule only they would use is no lesson.
- project: every role working on this project acts on it alike: this repository's gates, tools and layout.
- machine: every role acts on it alike in any repository on this machine: its tools, its operating system, its environment.
A rule that some roles need goes to your own role; a rule your role needs in every repository goes to your role too. The curator widens a rule when it holds wider.
rule: imperative, at most 300 characters. why: one line, at most 160 characters, saying what happened here; it stays on the record and agents never see it. Each needs at least 16 letters or digits.
Write no names of people, accounts, emails, tokens, ids or absolute paths. Keep a rule's text out of commits, pull requests, issues, tasks and reports; name it by its id. Then end your turn: the stage itself is complete.
```

The tool takes exactly one of three answers:

```ts
leave_lesson {
  clientRequestId: string;
  none?: string;                                                        // 1..160
  rewrite?: { id: string; rule: string; why: string };
  lesson?: { scope: "role" | "project" | "machine"; role?: RoleId; rule: string; why: string };
}
```

| Check | Refusal | Stored |
| --- | --- | --- |
| Not exactly one of `none`, `rewrite`, `lesson`; a length or letter limit (`roleStage.ts:62-76`, unchanged) | `LESSON_INVALID` | nothing |
| The attempt already answered | `LESSON_LIMIT` | nothing |
| `rewrite.id` is not an active rule of a scope this stage reads (`readableScopes`, `roleStore.ts:101`), or is a version row, or the text is the same rule (`sameRule`) | `RULE_NOT_READABLE` / `LESSON_INVALID` | nothing |
| `rule` names an identifier of one change or one run (below) | `LESSON_ABOUT_ONE_TASK`, naming the span: "this belongs in your stage report; if the rule holds on other tasks, say it without that" | nothing |
| `lesson.role` is a clean role (`roleStage.ts:92`; slice B adds `curator`) | `LESSON_CLEAN_ROLE` | nothing |
| Privacy detectors (`staticSensitiveClasses`) | never refuse: the rule carries the hint, as today | the rule |

A refused call leaves the attempt's answer open. The first accepted call is
the answer: `none` records the line, `lesson` appends a rule (3.2), and
`rewrite` rewrites one (3.4). The acknowledgement names the attempt, as
today, and carries `action`, `id`, `state`, `mergedInto`, `version` (the new
version row on a rewrite), `scopeChars`, `archived` (rules the bound moved
out) and `hints`.

**The identifiers that refuse a rule** are a fixed list of three:

1. a pull request or issue number: `#` followed by digits, or "PR", "pull
   request" or "issue" followed by a number, or `pull/<n>` and `issues/<n>`;
2. a run of 7 to 40 hexadecimal characters holding both a digit and a
   letter (a commit, a pipeline, a launch);
3. an id Delegatus mints: `r_` followed by hex, `conversation_…`, a UUID.

None of these identifiers can belong to a rule that holds on another task,
and the existing contract already forbids ids in a lesson. Narration written in
words passes the list: the cross-task test in the request (the agent's
judgment) and the curator catch it. The list never grows to chase a missed
spelling, and a missed spelling is no review finding (operator, 2026-10-06,
on detectors: they are hints for an agent's judgment and the operator
decides last). The refusal stores nothing because answer 4 keeps task
lessons out of memory; the agent decides what goes into its report.

The server cannot judge a level: which roles act on a rule is the agent's
judgment at write time and the curator's afterwards. What it enforces is
structural: a lesson lands in the scope its level names (`role:<P>:<R>`,
`project:<P>`, `machine`), never in a scope the stage does not read except a
named role's own, never under a clean role, and a rewrite keeps its rule's
scope, so a stage cannot move a rule across levels.

### 3.4 Rewrite by id, versions and revert (slice A)

- **A stage's rewrite** replaces an active rule's `rule` and `why` in place,
  keeps the rule's id, place and `curatedAt`, writes the earlier text as a
  version row (3.1) and sets `revisedBy: { by: "agent", at, source }`. The
  scope's revision moves on, its history records `rewritten`, and the bound
  applies with the rewritten rule protected. Agents read the new text from
  their next start. The known-values file is rewritten after a rewrite, as
  after a lesson (`roleStore.ts:243`).
- **Revert**, `revertRule(versionId)` in the store and a `revert` action on
  the existing route (`src/app/api/role-memory/route.ts`) under operator
  authority: the rule's current text becomes a new version row, and the rule
  takes the version's text, with `revisedBy: { by: "operator", revertedTo }`.
  No version row is ever changed or deleted.
- **`restoreRule`** refuses a version row (`RULE_IS_VERSION`); the way back
  for an earlier text is a revert.
- The window draws the versions and their Return in slice C. Until then the
  route answers versions on each rule (`RuleView.versions`) and keeps
  version rows out of "Left the rules", so the window shows no wrong label.

### 3.5 The startup block and how it reaches the agent (slice A)

```text
Learned rules (Delegatus role memory): 3 role · 26 project · 8 machine
Rules of thumb that earlier agents left. The brief, the pinned specification and the project's instruction files win where they disagree. Keep them on this machine: never copy a rule into a commit, pull request, issue, task or report; name it by its id.

Role rules · Architect on this project
- [r_0a1b2c3d4e5f6a7b] <rule text>
- …

Project rules · every role on this project
- …

Machine rules · every project on this machine
- …

When you report with stage_report, its answer asks whether this stage taught anything; most stages answer none. A rule above that proved wrong or too narrow can be rewritten then, by its id.
```

`ruleLine` drops ` Why: …` (`roleConsolidate.ts:18-19`); the why stays on
the record and in the window. Each scope lists every active rule in render
order (3.2). Slice A adds the group `Role rules · Builder on every project`
(for the stage's own role) after the role group, and `readableScopes`
(`roleStore.ts:101`) gains `role:*:<R>` between the role and project
scopes. A stage reads exactly its own role's two scopes, its own project's
scope and the machine scope, and no other.

**Delivery today.** The engine reads the block before it composes the stage
input (`stageMemoryForLaunch`, `roleStage.ts:34-41`), and the spawn port
puts it into the first message (`withLearnedRules`, `roleLaunch.ts:46-53`,
called at `src/lib/pipelines/engine.ts:622`) when the message fits the
32 000-byte structured envelope. Otherwise it writes
`statePath("role-memory/launch/learned-rules-<sha256>.md")` and the message
says only "Read the full file before working" (`roleLaunch.ts:18-35`). A
builder's block is about 22 KB, so any stage prompt over about 10 KB sends
the builder a pointer it may never open. The composer reserves room for the
pointer (`engine.ts:5512`, `:5934`; `src/lib/pipelines/runtimeSwitch.ts:280`).

**Delivery from slice A: the engine's own instruction channel, rendered from
SQLite at every engine start.**

1. **The first message carries the stage prompt and nothing else.** No rule
   text enters a message, a checkout, a pipeline record or a file.
2. **The launch profile carries a marker,** `learnedRules: { project, roleId }`
   with no text. The engine sets it for an eligible stage where it decides
   eligibility today (`stageMemoryForLaunch`) and leaves it out for a clean
   stage or with the kill switch set. The launch profile is the durable
   record that every start of a structured host builds its options from.
3. **Every start of the stage's engine process renders the block from
   `role_memory`.** Six option records start a structured Claude or Codex
   process, and each calls one function,
   `learnedRulesForLaunchProfile(profile)`:
   - a fresh launch and a resume: `claudeStructuredHostOptions`
     (`src/lib/runtime/structuredSpawn.ts:1690`) and the Codex options in
     `defaultStartHost` (`:1760-1788`);
   - boot adoption after a restart: the Claude options in
     `src/lib/runtime/startup.ts:1740-1760` and the Codex options at
     `:2083-2105`, which `adoptClaudeRegistryHosts` and
     `adoptCodexRegistryHosts` use (`src/lib/runtime/registry.ts:644`,
     `:761`);
   - an account migration successor:
     `src/lib/accounts/migration/provider.ts:371` (Codex) and `:505`
     (Claude).
   A test drives each of the six with a marked profile, and a source check
   lists every `start` and `adopt` call of the two host classes, so a new
   start path fails the test until it carries the rules. The function reads
   only: moved project keys resolve on read, and the combined snapshot
   follows the scope's curation order and character bound. The succession
   join stays with the writers.
   The collection's snapshot is cached by revision, so a start costs at most
   one SQLite read.
4. **The channels**, checked against the engines installed on this machine:
   - **Claude** (Claude Code 2.1.284): `--append-system-prompt <block>`.
     `--system-prompt` would replace Claude Code's own prompt and is never
     used for this. The host already passes a Telegram notice through the
     same flag (`src/lib/runtime/claudeStreamBrokerHost.ts:862`); both go in
     one argument, block first. The CLI records the system prompt on the
     conversation's first request and replays it on every resume until a
     compaction (`--system-prompt-snapshot`, on by default); passing the
     block at every start keeps it after a compaction too.
   - **Codex** (codex-cli 0.162.1): `developerInstructions` in `thread/start`
     and in `thread/resume`; the app-server's generated schema has the field
     in both. The field replaces the account's own `developer_instructions`,
     so the host joins the account's instructions, the block, and the
     Telegram notice when there is one, as it already joins the notice
     (`src/lib/runtime/codexAppServerHost.ts:1559-1568`).
5. **The composer reserves nothing for rules.** `withLearnedRules`,
   `learnedRulesReserve`, `learnedRulesFile` and the reserve arithmetic at
   `engine.ts:5512`, `:5934` and `runtimeSwitch.ts:280` go. A stage prompt
   keeps the whole 32 000 bytes.
6. **Failures.** A store that cannot be read starts the engine without the
   block and logs it, as `stageMemoryForLaunch` does today: rules never hold
   a launch, and every egress check already fails closed on that store. An
   engine that refuses the channel fails its start, and the stage parks with
   the reason. No path falls back to a pointer or starts silently without
   the rules it could read.
7. **Size.** Each scope stays within 10 000 code points (3.2); with English
   rules three full scopes render to about 31 000 bytes, four to about
   41 000. A single command-line argument on Linux holds at most 131 072
   bytes, so the render keeps the block within 120 000 bytes: past that it
   leaves the lowest-ranked rules of the largest scope out of that start's
   text (they stay active and are not archived) and logs how many. The
   curator's target (3.6) is a whole block of a role within 16 000 bytes,
   small enough to fit inline beside a typical stage prompt.
8. **Old files.** The Viewer's activation step removes files older than one
   day under `statePath("role-memory/launch")`, and the directory once it is
   empty, under `assertStateStartupMutation` (`AGENTS.md`, state ownership
   rule 2). A day leaves every agent the previous release launched time to
   read the pointer it was given.
9. **Where the text now lives.** Claude: on the engine process's command
   line, which other users of this machine can read through `/proc`, and in
   the engine's request to its provider, as before. Codex: in the thread's
   developer instructions, which its rollout may record locally. Neither
   leaves the machine by a new path, and the egress checks (3.7) are
   unchanged. `--append-system-prompt-file` would keep the text off the
   command line at the cost of a file per start; it is in Deferred.

### 3.6 The curator (slice B)

**Role.** `curator` joins the registry (`src/lib/roles/types.ts:1`,
`defaults.ts`): engine Codex, `gpt-6.1-sol`, effort high, read-only
capability; fences "Files stay untouched: no edits, staging, commits or
pushes; git and gh are for reading." and "Change role memory only through
curate_rules." It joins `CLEAN_ROLE_IDS` (`src/lib/memory/eligibility.ts:11`),
so it starts with no learned rules, no shared memory and no engine memory,
and no lesson may be addressed to it. The operator changes its engine and
model in the existing role presets.

**When a pass is due**, per project, in the seat tick check beside
maintenance: `curation.reconcile(project)` before the gather and
`curation.launchIfDue(input)` after the wake (`seatTickController.ts:1491`
and `:1771`), each in its own `try` that turns a failure into a journal
clause. The onboarding health check passes no `curation`, as it passes no
maintenance. A pass launches when all of these hold:

1. role memory is on (the kill switch `LLV_ROLE_MEMORY=off` stops the
   curator too) and the project's seat tick wakes are on;
2. no automatic-update drain and no running deployment;
3. no curator pass is live anywhere on this machine: the machine scope is
   shared, so one pass at a time;
4. it is due: the project has never had a pass and the scopes of its pass
   (its role scopes, its project scope, the scopes of every role on every
   project, the machine scope) hold active rules (the first pass, 3.9); or
   at least 10 lessons and stage rewrites joined those scopes since their
   last passes (the early trigger); or 6 hours have passed since the
   project's last pass and those scopes hold active rules, whether or not
   any lesson joined since. With no candidate state (answer 5), the
   «candidates» of answer 3 are the lessons and rewrites the curator has
   not yet seen, already active. The 6-hour branch needs none of them:
   stages answer «nothing new» by default, and a rule goes stale against
   the code with no lesson written, so only a timed pass keeps checklist
   question 2 (Current) running on a quiet project;
5. the claim admits it: one `boundedPatch` over the machine row and the
   project row refuses while a pass is live or within 30 minutes of the
   project's last claim. A failed pass counts as a pass, so a broken setup
   retries after 6 hours.

**Admission amendment, 2026-10-14.** Every launch, restart recovery and
deferred spawn admission also requires the host project's designated seat
to have an alive host in the shared liveness record and to be present and
unretired. Its tick settings must be enabled. The tick's existing delivery
stamp, `lastWakeAt`, must belong to that seat's epoch and designation and
be within two configured wake intervals. Settings alone grant no admission.
For shared scopes, choose the eligible project with the newest delivered
wake, breaking ties by project key. Project-only rules stay in their own
eligible project. With no eligible host, the tick journal records the reason.

An incumbent whose host becomes ineligible settles as `failed` with an
`abandoned:` reason. Recovery keeps its original project and never transfers
it to another seat. Its existing writes and undo history remain. The sweep
also visits an incumbent's project after its seat and open work disappear.

Admission path inventory, including restart reapers:

| Path | Project that owns the pass | Admission checked |
| --- | --- | --- |
| Seat-tick sweep: `reconcileCuration(project)` before gather and `launchCurationIfDue(input)` after wake | The incumbent's recorded project during reconciliation; the selected eligible project for a new machine-scope pass | Designated seat, live host/lifecycle, matching seat epoch and designation, fresh delivered-wake stamp, settings, update drain and deployment state; new shared passes choose newest delivered wake, then project key |
| Manual `curate_rules` and ordinary structured resume/recovery | The live pass's persisted project, bound through its receipt | Receipt pass id and project binding, then the same seat and wake admission at recovery and delivery |
| Pinned-account queue reaper (`actuateQueuedPinnedSpawn`) | The project bound to the durable curator receipt and pass | Rebuilt before claiming the queued actuation, after asynchronous account admission, and at the tmux spawn or structured spawn authorization fence; refusal fails the queued receipt and abandons an ineligible incumbent |
| Staged structured-launch recovery after its continuation closure is lost | The project bound to the original durable curator receipt and pass | Rebuilt before retained-host publication, checked inside publication and again at the original first-message dispatch; refusal stops recovery and abandons the incumbent |

Before conversation role metadata materializes, a queued curator launch uses
its durable receipt as the role authority. Once a conversation has a role, a
non-curator role remains a refusal.

Thresholds are named constants beside `ROLE_MEMORY_BOUND`. The operator's
existing switches cover it: the seat tick's on/off for the project, and the
kill switch for the installation. The tick sweeps projects with an active
seat, an open pipeline or a waiting task (`seatTickSources.ts:1533`); the
rules of a project with none of these wait for its next one, and meanwhile
no stage of it reads them.

**Launch.** `launchAutonomousConversation` with `role: "curator"`, the
project's repository as working directory, the brief below,
`clientAttemptId` = the pass id (`curate_<sha256(project:claimedAt)>`), the
Viewer MCP server, and no board card; `src/lib/externalRelay/ownerRun.ts`
launches without one too. The account comes from the project's bindings as
for any spawn. Observation and settling reuse `observeSpawnedTurn`, with the
maintenance bounds: 15 minutes for a launch to prove itself, 60 minutes for
the turn. On settle the conversation is archived like the maintainer's, and
the pass row keeps its state, its counts and its final message.

**The checklist.** The curator puts every active rule of its pass, and every
rule archived for budget, through the same seven questions, in this order. A
rule that questions 1 to 3 archive needs no further question; a rule that
stays goes through all seven.

1. **Task.** Does it narrate a task, a pull request, a lane, an incident, or
   one module's invariant? Archive it as `task-specific`. A module invariant
   worth keeping is named in the final message as a test or a comment for
   that module.
2. **Current.** Is it still true against the code, the instruction files
   and the tools as they are now? A script, flag, file, command or
   behaviour it names that changed or is gone, or a later decision that
   replaced it: archive as `stale`, with a note saying what changed. Code
   that already enforces it: `in-code`, with `path:line`. Instruction files
   or the role's scaffold that already say it: `in-instructions`, with the
   path.
3. **Readers.** Is it addressed to a role that reads no rules (3.0)? Archive
   as `no-reader`.
4. **Level.** Who acts on it, and where?
   - one role, in this project only: that role on this project;
   - one role, in any repository: that role on every project;
   - every role working in this project, alike: the project;
   - every role, in any repository: the machine;
   - several roles, short of every role working here: a copy under each of
     them (`split` into same-text parts);
   - a rule that mixes levels: `split` it into one rule per level.
   Move or split it there.
5. **Duplicates.** Two rules that state one class merge into one rule that
   keeps every condition they state, within one scope. Copies held by
   different roles merge into the project only when step 4 puts the class
   at the project; otherwise each role keeps its copy.
6. **Contradictions.** Two rules that a single agent would read together and
   that ask for opposite things: keep the one the code and the instruction
   files support, archive the other as `contradicted` against it. Never
   leave both active.
7. **General and ranked.** Rewrite a rule into its class when the class is
   clear, keeping every condition; rank each scope's rules, most useful
   first, and keep each scope well under its bound and each role's whole
   block (its four scopes together) within 16 000 bytes (3.5). Restore a
   rule archived for budget when it passes questions 1 to 6 and no active
   rule covers it.

**The brief** (English, with the project key filled in; the checklist above
follows it verbatim):

```text
You curate Delegatus role memory for this project and for this machine. Every agent that starts a pipeline stage reads all the active rules of four levels: its role on this project, its role on every project, this project, and the machine. Leave fewer rules, each general and current, each at the one level whose readers all act on it, and lose none for good.
Read each scope of this pass with curate_rules read, then the project's instruction files, the code a rule names and the tools it names. Put every rule through the checklist below, then apply one call per scope (or per group of scopes for a move, split or merge across them) that accounts for every active rule.
Rules the operator returned stay: never archive them or merge them into another rule. A refused call says what to fix; after a stale refusal, read the scope again. Change no file. Never quote a rule in your final message: name rules by id. End with one line of counts per scope, the module invariants you archived that deserve a test or a comment, and the ids of rules worth moving into the project's instruction files.
```

**`curate_rules`**, refused to any caller that is not the live pass's
conversation (a guard like `maintainerCallerOf`, `guard.ts:12-31`, by the
registry role `curator`, the receipt's `curate_` attempt id and the `c:`
index). The `curator` role may otherwise call only read tools.

```ts
curate_rules {
  clientRequestId: string;
  action: "read" | "apply";
  /* read: without scope, the pass's scopes with sizes and counts; with scope, that scope, paged within 24 KB */
  scope?: string; cursor?: string;
  /* apply */
  scopes?: { scope: string; revision: number; order: string[] }[];   // each named scope's active list after the call, best first
  rewrite?: { id: string; rule: string; why?: string; note: string }[];
  merge?: { into: string; from: string[]; rule: string; why?: string; note: string }[];
  move?: { id: string; to: string }[];                               // a scope of this pass: "role:<P>:<R>", "role:*:<R>", "project:<P>", "machine"
  split?: { id: string; parts: { to: string; rule: string; why?: string }[]; note: string }[];   // two or more parts; the rule keeps the first
  archive?: { id: string; reason: CuratorReason; against?: string; where?: string; note: string }[];
  restore?: string[];
}
```

A pass covers the project's role scopes, its project scope, the scope of
every role on every project and the machine scope. A read of one scope
answers its revision, size and bound; its active rules in render order, each
with id, rule, why, curated or not, new since the last pass (and, after a
stage's rewrite, the earlier text), operator-kept, the writer's role and
fix-round mark, and the number of versions; every rule of the scope ever
archived for budget and every rule that left since the last pass, with its
reason; the stage attempts per role in this project over 30 days, which
tells the curator which roles work here; for a role scope, that role's
prompt scaffold, so it can tell what the instructions already say; and, for
a role's scope on this project, the same role's rules in the other projects'
scopes, read-only, so a class that recurs across projects can rise to the
role on every project. The other projects' copies are archived as
duplicates by their own passes.

**The server's check** on `apply`, all in one `boundedPatch` over
`role_memory`, all or nothing. Items 8 to 10 are the level boundaries the
server can check; which roles act on a rule stays the curator's judgment.

1. Every named scope belongs to this pass and is at the revision the call
   names; otherwise `CURATE_STALE` with the scope's current revision.
2. Every active rule of a named scope appears exactly once: in an `order`,
   as a `merge.from`, as a `move` or `split` source, or in `archive`. Every
   id in an `order` is an active rule of a named scope, a rule moved or
   split into it, or a rule restored by this call. A `merge.into`, a moved
   rule and every split part appear in the `order` of the scope they end in
   (new parts by a placeholder `split:<id>:<n>` the answer maps to the ids
   it drew).
3. `restore` names rules of these scopes archived with any reason except
   `deleted` (the operator removed them) and except version rows.
4. A rule with `keptByOperatorAt` is never archived, never a `merge.from`,
   and never split.
5. Texts pass the lesson limits (`roleStage.ts:62-76`) and the identifier
   list of 3.3: everything stored is a general rule, the curator's text
   included. The privacy detectors answer as hints.
6. `against` names a rule active after the call. `where` names a file that
   exists in the pass's repository, with an optional line, and is required
   for `in-code` and `in-instructions`. `stale` requires its note.
7. Each named scope renders within 10 000 code points after the call, or,
   when it was over before, within its size before.
8. A `move` target and every `split` part's target is a scope of this pass
   whose role reads rules: a clean role's scope is refused
   (`CURATE_NO_READER`), and so is any other project's scope.
9. A merge widens or stays: every `from` rule's scope lies within the reach
   of the `into` rule's final scope. Reach: `role:<P>:<R>` covers itself;
   `role:*:<R>` covers `role:<P>:<R>`; `project:<P>` covers `role:<P>:<R>`
   for every R; `machine` covers everything. A merge of rules from two
   roles' scopes into one role's scope is refused (`CURATE_NARROWS`): it
   would leave the other role without its rule. A misplaced rule is moved
   first, in the same call.
10. A merge that lands at `project:<P>` or `machine` from role scopes, and a
    move of a role rule up to those levels, carry a note saying that every
    role working there acts on it; the server requires the note, and the
    window shows it on the rule.

On success the call writes, for each named scope: the new `active` (the
reverse of `order`, every rule in it with `curatedAt` set to the call),
`curatedAt` on the scope, a revision, and one history entry
`{ by: "curator", pass, before, prior, rewritten, merged, moved, split, archived, restored }`;
for each rewrite, merge and split, a version row and `revisedBy`
(`mergedFrom` on a merge; each `from` rule becomes `merged` with
`mergedInto`; each new split part is a new rule with `splitFrom` and the
original's `source`); for each move, the new `scope` and `movedFrom`; for
each archive, its reason, `against`, `where` and `note`. Then it rewrites the
known-values file. The pass row counts the call in its own collection
afterwards; the history entries in `role_memory` are the record a revert
reads.

**Revert a pass**, `revertCuratorPass(passId)`, for the operator (slice C's
control): every rule the pass changed and nothing has changed since (its
`changedAt` still equals the call's time) gets its `prior` fields back and,
after a rewrite, merge or split, its text back from the version row, with
the replaced text kept as a version; a split part the pass created is
archived as `undone`; each scope takes its `before` order, less the rules
that were changed since. Rules changed since are listed and left alone. A
revert archives nothing else: a scope over the bound settles at the next
write.

**Visibility.** Each check that decides something adds one journal clause
(`curation: launched …`, `curation: settled …, 3 calls, 41 rules changed`,
`curation: failed, no-account`). The window lists passes (3.8). There is no
board card and no wake item: a pass every few hours would flood both.

### 3.7 Privacy

- A version row is a rule row, so its text is a known value in every release
  and in every old MCP server without code of its own.
- The curator's reads go to its engine's provider under the project's
  account, as the same rules already do in every stage prompt. Its
  conversation stays local; the journal clause carries counts only. A
  curator note, `where` and the final message stay in `state.sqlite` and in
  the window, which is local.
- The curator writes nothing into a repository: read-only role, read-only
  fences, and its only write tool is `curate_rules`.
- Nothing changes for the egress checks of the MVP design (its 3.1 item 7).

### 3.8 What the window shows (slice C)

The existing window and the card line, with one new control.

- **The Role section** keeps its role picker and shows the chosen role's
  rules in two groups under the section heading: "This project" and "Every
  project". The chip count adds both. Slice A exposes the cross-project role
  scope in the store; slice C groups both scopes in the window, and slice B
  places rules there.
- **A rule's row**, opened with the tap that shows its why today, adds to
  its meta line who wrote the current text ("rewritten by a builder, fix
  round", "merged from 3 rules", "kept by you") and an "Earlier text · n"
  toggle in the style of "Left the rules", listing the version rows, each
  with the existing Return button, which reverts to it.
- **"Left the rules"** labels every reason: about one task; already in the
  code, with `path:line`; already in the instructions, with the file; the
  same as another rule, or contradicts another rule, with the other rule's
  first words, which focus it on tap; no agent of this role reads rules;
  merged into another rule; archived to keep 10 000; removed by you. The
  curator's note is the row's title text. Return stays as it is.
- **Pass lines**, in the same toggle and newest first: "Curator · 02:14 ·
  merged 9, rewrote 4, moved 2, archived 12 · Undo pass", or "Curator ·
  failed, no account". "Undo pass" is the one new control. Per-rule Return
  already exists; the first pass changes about a hundred rules on live data,
  and the operator's «усе можна повернути» needs one action for that.
- **The size line** stays as it is (characters against 10 000, shown from
  80 %).
- **The card line** under a stage report: "Left 1 rule → Builder" as
  today, "Rewrote 1 rule → Builder" for a rewrite (a new string in the same
  line), and "No rule left" for `none`.
- Strings in English and Ukrainian. Rendered evidence through the existing
  drivers only: the phone driver
  (`src/components/mobile/issue1671Evidence.browser.test.tsx`) over the
  kanban fixture, desktop and 390 px, both languages, and the frames go to
  the operator before the merge.

### 3.9 The existing rules

- **No data migration.** Today's rows read as the new model: no
  `curatedAt`, so every active rule is never-curated, and today's order
  (oldest first) is already the order of leaving. Merged and archived rules
  keep their reasons; `budget` keeps its label.
- **Before slice B**, age still decides among never-curated rules when a
  scope overflows. With Why gone from the measure, today's fullest scope
  drops from about 9 900 to about 6 300 characters at deploy, so nothing
  leaves for a while.
- **The first pass** is due for each project as soon as slice B runs, and
  covers the machine scope with the first project it reaches. It puts every
  rule through the checklist, so rules the analysis found at the wrong level
  move, mixed rules split, and stale or already enforced ones leave. It
  reads the rules archived for budget, so the 12 general rules the age loop
  removed can return. The analysis expects about 21 kept, 9 generalized, 51 merged
  into about 20, 12 moved and 47 archived across all scopes; the curator
  decides. The pair of contradictory rules the analysis found, both of which
  a builder receives today, is resolved there; until then the operator can
  remove one with ×.
- **Reversible**: every change keeps its record, and "Undo pass" reverts the
  pass.
- **The lane touches no live state.** Every test runs under an isolated
  `HOME`, `LLV_STATE_DIR` and `TMPDIR` in one `mktemp -d` root under `/tmp`;
  the first pass happens through the feature after deploy.

## 4. Slices, in build order

The pinned specification names the curator slice B and the window slice C.
They are built A, then C, then B: slice B's first pass rewrites about a
hundred rules on live data, and the operator needs to see each reason and
undo the pass from the window before it runs. C is useful at once after A,
since it shows stage rewrites and their versions.

### Slice A — store, write path, render (this lane, one PR)

Files: `src/lib/memory/roleTypes.ts`, `roleConsolidate.ts`, `roleStore.ts`,
`roleRender.ts`, `roleStage.ts`, `roleScopes.ts` (all four scope readers);
`src/lib/mcp/server.ts` (schema and
description of `leave_lesson`); `src/lib/mcp/bindings.ts` (passes `none`,
`rewrite`, `lesson`); `src/app/api/role-memory/route.ts` (`revert`); for
delivery (3.5), `src/lib/memory/roleLaunch.ts` (the marker, the read-only
render and the old-file sweep, replacing the inline and file paths),
`src/lib/pipelines/engine.ts` and `runtimeSwitch.ts` (marker in the launch
profile, no reserve), the launch profile type, the six option records in
`src/lib/runtime/structuredSpawn.ts`, `startup.ts` and
`src/lib/accounts/migration/provider.ts`, and the two hosts
(`claudeStreamBrokerHost.ts`: an `appendSystemPrompt` option joined with
the Telegram notice; `codexAppServerHost.ts`: the block in
`developerInstructions` on start and resume); this document. Component
drivers receive fixture maintenance for the singular lesson contract; UI
controls remain in slice C.

Failing-first tests, run by path under isolated state:

- `src/lib/memory/roleStore.test.ts` and `roleCuration.test.ts`: the order of leaving (oldest
  never-curated first, the lesson just added stays, the curated rule of
  lowest rank before a higher one, an operator-returned rule last); a
  rewrite keeps the id and place, writes a version row and moves the
  revision; revert keeps the replaced text as a version; a version row
  refuses Return and rewrite; a repeat moves an uncurated target to the end
  of its segment; a tail append written in the old shape is placed
  correctly on the next write; the succession join and Return follow the
  same order; an engine start bounds aliased scopes without changing the
  store; a store written by slice A decodes under a decoder that
  accepts only the three row kinds. The test at `:60` (oldest archived over
  the bound) changes to the new order.
- `src/lib/memory/roleEgress.test.ts`: the earlier text of a rewritten rule
  is withheld at every boundary and is in the known-values file.
- `src/lib/mcp/leaveLesson.test.ts`: exactly one of `none`, `rewrite`,
  `lesson`; a second answer is `LESSON_LIMIT`; a refused call leaves the
  answer open; each identifier class is refused and stores nothing; a
  rewrite outside the stage's readable scopes is refused; privacy hints
  never refuse; the request has no "one to three", no "at least one lesson
  is better", no "Start there", and offers none, rewrite and lesson.
- `src/lib/memory/roleLane.test.ts`: the fixer's request names its findings
  with the cross-task sentence; its lesson is active for a fresh builder
  at once; the block carries no "Why:".
- `src/app/api/role-memory/route.test.ts`: `revert` under operator
  authority; version rows absent from `left`.

Boundary tests in slice A, one per boundary the write path and the start
can hold (in `roleStore.test.ts`, `roleCuration.test.ts` and `roleLane.test.ts`, with every scope
seeded with its own distinct rule):

- **What a start reads.** A builder stage in project P starts with the rules
  of `role:<P>:builder`, `role:*:builder`, `project:<P>` and `machine`, and with none of
  `role:<P>:visual-critic`, `role:<Q>:builder` or `project:<Q>`. A visual
  critic stage in P starts with its own role's rules and none of the
  builder's. A reviewer, a verifier and a review-gate stage start with
  nothing.
- **Where a lesson lands.** Scope role lands in the writer's own role scope
  on this project; a named role lands in that role's scope; a clean role is
  refused; scope project lands in `project:<P>` and never in another
  project; scope machine lands in `machine`.
- **A rewrite keeps its level.** A builder rewriting a project rule leaves
  it in `project:<P>`; a rewrite of another project's rule, or of a role
  scope the stage does not read, is refused.
- **No task.** Each identifier class is refused at write time and stores
  nothing; the request carries the no-task line and the four level tests (the curator alone widens a
  new rule to the cross-project role level).

Delivery tests in slice A (3.5):

- **A large stage prompt still carries the full rules** (`roleLaunch.test.ts`,
  through the real engine and spawn port): a stage whose composed prompt is
  within a few bytes of the 32 000-byte envelope, in a project whose role,
  project and machine scopes are each near 10 000 code points. The first
  message equals the composed prompt, with no rule text and no pointer; the
  launch profile carries the marker and no rule text; the options the host
  is started with carry every active rule line of the three scopes, whole.
- **No rules file is written**: after that launch, and after launches with
  blocks of every size from empty to the 120 000-byte ceiling,
  `statePath("role-memory/launch")` does not exist.
- **Claude** (`claudeStreamBrokerHost.test.ts`, with its `spawnProcess`
  stub): the arguments hold `--append-system-prompt` exactly once, with the
  block and then the Telegram notice when there is one; an adoption passes
  it again; a clean profile passes none; `--system-prompt` never carries it.
- **Codex** (`codexAppServerHost.inject.test.ts`, with its app-server stub):
  `thread/start` and `thread/resume` carry `developerInstructions` holding
  the account's own instructions, the block and the notice, in that order; a
  clean profile changes nothing.
- **Every start path** (`roleDelivery.test.ts`, `startup.test.ts` and
  `provider.test.ts`): each of the six option records, given a marked
  profile, yields the block; the source check fails on a `start` or `adopt`
  call of `ClaudeStreamBrokerHost` or `CodexAppServerHost` outside them.
- **Failures**: an unreadable store starts the host without the block and
  logs it; a block past 120 000 bytes leaves out the lowest-ranked rules of
  its largest scope, keeps them active, and logs the count. The shared
  renderer uses `TextEncoder` and runs without Node's `Buffer` global in
  browser fixtures.
- **Old files**: the sweep removes a launch file older than a day, keeps a
  newer one, and refuses outside the release fence.

Checks: the touched test files by path through `scripts/gate-slot.sh`;
`bunx tsc --noEmit` through the slot; the local privacy gate from the merge
base; the pre-push hook.

### Slice C — the window

Files: `src/components/roleMemory/LearnedRules.tsx`, `src/lib/i18n/en.ts`,
`uk.ts`, `RuleView` and `ScopeView` in `roleTypes.ts`, `projectView` and
`stageLessons` in `roleStore.ts`, the route (`revert-pass` once slice B
exists; until then pass lines are absent). Evidence as 3.8.

### Slice B — the curator

Files: `src/lib/roles/types.ts`, `defaults.ts` (the `curator` row and its
scaffold); `src/lib/memory/eligibility.ts` (clean role);
`src/lib/memory/curation/` (`store.ts` for the curation collection, `run.ts`
for due, claim, launch, observe and settle, `brief.ts`, `guard.ts`,
`apply.ts` for the checked transaction and the pass revert);
`src/lib/mcp/server.ts` and `bindings.ts` (`curate_rules`);
`src/lib/monitor/seatTickController.ts` (two hooks);
`src/lib/i18n/en.ts`, `uk.ts` (the role's name).

Tests: due conditions, including the first pass over rules that never had a
pass; a pass due 6 hours after the last one with zero new lessons or
rewrites; no pass due before 6 hours with fewer than 10; a pass due before
6 hours at 10; no pass due when the pass's scopes hold no active rule; one live pass per machine; a repeated or concurrent claim; the
health check launches nothing; the guard admits only the live pass's
conversation; every check of the apply list, each with a refusing case;
`CURATE_STALE` after a stage's lesson lands mid-pass; a merge and a move
across two scopes; a revert of a pass with one rule changed since, and of a
split; old readers decode the store after a pass, `role:*:` scopes included;
a stubbed launch through settle.

Boundary tests in slice B, deterministic, one per checklist outcome and one
per structural refusal:

- **Reach of the new level.** After a rule moves to `role:*:builder`, a
  builder stage in project Q starts with it, a builder stage in P starts with
  it once, and a visual critic stage in P does not.
- **Each outcome is accepted:** archive as `task-specific`; as `stale` (and
  refused without its note); as `in-code` and `in-instructions` (and refused
  without a `where` that exists in the repository); as `no-reader`; a move
  to each of the four levels; a split of one rule into parts under two roles
  and into parts at two levels; a merge within a scope; a merge of two
  roles' rules into the project with its note (and refused without it); a
  contradicted archive whose kept rule is active after the call.
- **Each boundary the server holds is refused:** a move or a split part into
  a clean role's scope (`CURATE_NO_READER`) or into another project's
  scope; a merge of two roles' rules into one role's scope
  (`CURATE_NARROWS`); a curator text that names an identifier of 3.3; an
  operator-kept rule archived, split or merged away.

The judgment behind each boundary is the curator's, so slice B also carries
one opt-in check of the real curator, gated by `LLV_CURATOR_EVAL=1` like the
browser drivers are gated, outside the default suite because it calls a
model. It builds a fixture repository (an `AGENTS.md`, one script, one test
that enforces a rule) and a fixture store under an isolated state root,
runs one real pass, and expects one disposition per case:

| Fixture rule (invented) | Expected |
| --- | --- |
| Narrates what one lane did, in words, with no identifier | `task-specific` |
| Reviewer know-how stored for the builder | `no-reader` |
| A builder-only practice stored at the project level | moved to the builder on this project |
| A fact of this repository stored at the machine level | moved to the project |
| A builder practice true in any repository, stored for the builder on this project | moved to the builder on every project |
| One rule that states a project gate and a builder habit | split into a project rule and a builder rule |
| Names a script the fixture repository no longer has | `stale` |
| Says what the fixture `AGENTS.md` already says | `in-instructions`, with that path |
| Asks for what the fixture test already enforces | `in-code`, with that path and line |
| One class held by the builder and the visual critic, which every role here acts on | merged into the project |
| One class held by the builder and the visual critic, which only those two act on | both copies kept under their roles |
| Two rules a builder reads together that ask for opposite things | one `contradicted` against the other |

Slice B's lane runs it once before the merge and reports each case in its
pull request. The fixture's pipeline records name the roles that work in
the fixture project, which is what "every role" means there. A failing case
is fixed in the brief or the checklist; the expected dispositions stay as
written.

## 5. Validation against the requirement

| Quote | Where it is answered |
| --- | --- |
| «перезаписывать уже созданные фрагменты» | A stage rewrites a rule by id (3.3, 3.4); the curator rewrites and merges (3.6); every earlier text is kept and revertible. |
| «абстрактные правила … группироваться, объединяться, консолидироваться» | The curator merges rules of one class, generalizes and moves them to their level (3.6), and runs on the seat tick at 10 new lessons or rewrites, or 6 hours after the project's last pass with no new-lesson condition, so a quiet project's rules are still checked for currency (answer 3). |
| «универсальны … для любой задачи, просто зависят от разных уровней» | The cross-task test and the level test in the request (3.3); the curator's level moves and `no-reader` archives (3.6). |
| «он говорит про конкретные задачи» | Task lessons go into the stage report: the request says so and `leave_lesson` refuses the unmistakable ones (3.3, answer 4); the curator archives the rest (3.6); Why leaves the startup block (3.5). |
| «память уже забита, и слишком много. Пишется» | «Nothing new» by default and one answer per stage (3.3); merges shrink the scopes (3.6). |
| Answer 1: no count cap, 10 000 characters | The bound stays; curation decides what fills it (3.2). |
| Answer 2: a first, reversible pass | 3.9, with "Undo pass" (3.8). |
| Answer 5: at once, in the general list | A lesson is active from the next start (3.2). |
| 2026-10-07: 10 000 characters; abstract rules | The bound (3.2); the cross-task test (3.3). |
| 2026-10-02: «Может быть, они потом понадобятся» | Nothing is deleted: versions, merges and archives keep their records and their way back (3.4, 3.6). |
| 02:13: «ни одна память не должна обсуждать. Задачу» | The no-task boundary (3.0); the write-time refusal and request line (3.3); checklist question 1 and the identifier check on the curator's own text (3.6); the no-task tests (section 4). |
| 02:13: «билдеру … не нужно знать … то, что делает ревьюер»; project «что делают и тот, и другой»; machine «во всех проектах что-то общее для всех» | The four levels and their readers (3.0); the narrowest-level test at write time (3.3); checklist questions 3 to 5, and the reach and no-reader checks (3.6); a boundary test each (section 4). |
| 02:13: «насколько она... Действительно актуальна» | Checklist question 2: `stale`, `in-code`, `in-instructions`, each with its evidence (3.6). |
| 02:58: «через SQL память работала, чтобы быстрее … и инжектилось правильно» | Rendered from `role_memory` in SQLite at every engine start into the engine's own instruction channel; no message envelope, no pointer, no rule file (3.5); a test with a full block beside a prompt at the envelope bound, and one that no file is written (section 4). |
| 02:14: «память cross-projects … для какой-то конкретной роли … заметки для билдеров, которые общие для разных проектов» | The level `role:*:<R>` (3.0), placed by the curator (3.6), read by that role in every project (3.5), shown in the Role section (3.8). |

## Deferred — not currently justified

- **Count caps per level** (10 role, 10 project, 6 machine). The operator
  chose characters (answer 1); a cap is one constant in the render if it is
  ever wanted.
- **Candidates kept out of injection until a pass.** Answer 5 puts a lesson
  in the list at once.
- **An archive of task lessons, visible in the window and in search.**
  Answer 4 keeps them in the stage report.
- **Learned rules in `search_memory`.** With no candidates and no task
  archive nothing needs it; the window shows every record.
- **An inline fallback for an engine without an instruction channel.** Both
  stage engines (`RoleEngine` is Claude or Codex) have one on this machine,
  so a fallback would have no caller. The curator's 16 000-byte target keeps
  the block small enough to go inline should an engine ever lose its
  channel; until then such an engine fails its start loudly (3.5).
- **`--append-system-prompt-file` for Claude.** It keeps the text off the
  process command line at the cost of a file per engine start; worth it only
  if this machine gains other local users.
- **A model judging each lesson at write time.** The curator does the same
  judgment in bulk with the code in view.
- **Rebasing a curator call over concurrent writes** (the MVP design's 2.5).
  A stale call is refused and repeated; a pass is minutes long.
- **Writing rules into the instruction files or the code.** The repository
  is public; the curator only names candidates for promotion in its final
  message, and the operator promotes by hand.
- **Editing a rule's text in the window.** Remove, Return, revert and the
  curator's rewrites cover it today.
- **An attention line after repeated failed passes.** The journal and the
  window show failures; add one if failures go unnoticed.
- **Selecting rules per task at start, usefulness counting, scopes per
  domain.** As in the MVP design's Deferred list and the analysis.

## Open questions

None blocks slice A; each has the default this design takes.

1. **Count caps on top of the 10 000 characters?** Default: none, as the
   form says. The seat offered 10/10/6 as one parameter; it stays in
   Deferred.
2. **What the 10 000 measures once Why leaves the block.** Default: the
   injected lines, which is what the bound has always measured; a full
   scope then holds about 43 rules of average length. The alternative is to
   keep counting rule and why, so a full scope holds about 27, as today.
3. **The curator's engine.** Default: Codex `gpt-6.1-sol`, effort high,
   changeable in the role presets.

## Notes

- The one place a pattern refuses is the list of three identifier classes in
  3.3. It follows answer 4, it is fixed, the refusal tells the agent what to
  do, and the semantic judgment stays with the agent and the curator.
- Between slices A and B, age still decides among never-curated rules when
  a scope overflows (3.2, 3.9); the bound measured without Why leaves every
  scope room at deploy.
- An agent whose MCP server started before slice A deploys keeps the old
  `leave_lesson`, with up to three lessons and the old request, until its
  session ends; the data stays consistent (3.1, 3.2).
- The 02:14 message (a role's rules across projects) was read in the seat
  conversation; the seat had not relayed it to this stage. It is in the
  design because it adds a level the boundaries of 02:13 depend on: without
  it, a builder rule true in every repository has no level its readers all
  act on.
- With four scopes at 10 000 characters each, a stage can read up to 40 000
  characters of rules. The instruction channel carries all of it (3.5); the
  curator's 16 000-byte target for a role's whole block keeps it far below.
- The rules on Claude's command line are readable by other local users of
  this machine through `/proc`; `--append-system-prompt-file` is the switch
  if that ever matters (Deferred).
- Reviewers, verifiers and the issue reporter stay clean, so know-how only
  they would use has no level; the curator archives it as `no-reader`.
