# Role memory: agents leave abstract lessons, the next agent of the role starts with them

Status: design, with prototypes and a test plan. Written against `main` at
`5a197eeb5` (2026-10-07). File and line references are to that commit. This
stage wrote this document and nothing else in the repository; the prototype
frames live outside it, under `~/Pictures/delegatus-review/role-memory/`.

## Originating requirement

Operator, 2026-10-07 11:41 UTC (14:41 Kyiv), by voice, in Russian, in the
Delegatus orchestrator conversation. Verbatim:

> Я, кажется, придумал: суть в том, чтобы наша сеть как бы начинала хранить
> какую-то память. Может быть, действительно, у нас может быть сеть из 100
> агентов, из которых... то есть, как бы, грубо говоря, там 100 ролей, или даже
> не 100 ролей, ну, каких-то вот... какое-то количество ролей, и у них
> постоянно один, ну, скажем так, наверное, как одна линейка событий, то есть
> которые постоянно один компакт у них происходит, то есть если мы...
> Единственное, что у нас ревьюер всегда чистый, ревьюеру нам нужно всегда,
> чтобы они были новые, то есть там, где у нас правила нарушаются, вот
> необходимости хранения памяти, то нет. А билдер, билдер можно компактить, то
> есть каждый билдер после своей работы может оставить небольшой компакт,
> только, знаешь, как-то это надо подумать. Вот нам, с одной стороны, нужно...
> наверное, это будет не один агент, это будет какой-то пул агентов тогда,
> потому что нам всегда нужно иметь быстро поднимать агента под рукой, но
> потом, когда агент закончил, и мы к нему не возвращаемся, то он должен
> сделать какую-то... какой-то компакт, грубо говоря, который пойдёт в
> следующему билдеру, в этом проекте. То есть я вот думаю такое: то есть можно
> сделать как бы, что у нас есть там какой-то swarm builders, у которых общая
> память, все пишут куда-то в память билдеров, да, вот так как-то можно
> сделать, все её как-то обновляют, все её читают, сразу же, и обновляют. Что
> тут дописать? Это большой вопрос, надо, чтобы не захламлять разной
> информацией, чтобы файл не раздувался, но при этом чтобы память была
> достаточно объёмная. Надо ограничить, например, каким-нибудь там 10 000
> символов, давай примем, и. То есть у нас есть вот это swarm of builders, кто
> у нас там ещё есть, swarm of critiques, потому что по сути-то у нас... ну, у
> нас как бы память и так, и так есть, но вот это у нас должна быть как тоже
> injected каждый раз, когда создаётся новый этот агент с ролью, там, то тогда
> у нас как бы архитекторы все примерно помнят, что было раньше, но это должна
> быть какая-то вот такие очень valuable штуки, я вот не знаю, какие именно, я
> вот даже сейчас не могу придумать, что бы это могло быть. Но вот такое
> направление. Тогда, когда у них общая память, они друг на друга... а, скажем
> так, влияют, то есть. Это их память. Нужно ли ещё как-то сделать, чтобы они
> cross row, делали cross row, делали... Синтез памяти и использование тоже
> может быть какой-то... какие-то полезные вещи, которые можно было бы от
> билдера передать критику, тогда у нас бы вот этот сам проект, он бы
> постоянно обучался, вот, и можно подумать, то есть то, что касается,
> например, бил... вот, запоминать то, что касается билдера, если какие-то
> ошибки он делает или. Что-то он... то есть, ну да, по сути нужно учиться на
> ошибках. Если он делает какую-то ошибку, нужно сделать вывод. Какое
> абстрактное правило, то есть не конкретное, а именно абстрактное правило
> записать, чтобы такой класс ошибок больше не ловился, то есть попытаться
> предиктить, какой... какая... какое абстрактное правило нам поможет здесь.
> Это пойдёт в память. После этого. И-и-и при этом релевантно на этом
> масштабе, то есть релевантно на уровне роли билдера, например, потом на
> релевантно на уровне проекта, cross row, то есть между ролями, и релевантно
> на уровне вообще машины, компьютера, тоже может быть какие-то вещи, то есть
> общая память. Которую делегатас пишет, вот этими агентами. То есть, скажем
> так, после того как они закончили работу и они уверены, что они закончили
> работу вот по этому, они отдают вызов типа, что они stage completed или
> что-то вроде этого, тогда пусть они выбирают, пусть они подумают, что из
> этого такого абстрактного, то есть это как... этот промпт даже, наверное,
> как-то должен injected специально им, чтобы получить конкретно контекст.
> Здесь и сейчас, вот типа, если ты завершаешь, окей, теперь дай фидбек, ты
> готов какую-то память оставить, лучше, чтобы хоть какую-то оставил. Ну вот
> какую, а какое... какие абстрактные правила помогут там знанию на этой
> машине, на это-этом и на это-этом. Давай попробуем такое, но мне нужен... я
> хочу MVP уже получить тогда, я не хочу там что-то фантазировать, как я вот
> тебе описал, описал это всё, это в принципе уже можно строить MVP. И скажешь
> мне, как я смогу это протестить. Мне нужно, наверное, какие-то прототипы
> увидеть, чего-то.

The pinned specification condenses it into R1–R7 and asks for D1 (this
document), D2 (prototypes) and D3 (a test plan). One earlier operator rule
binds this design. Operator, 2026-10-02, verbatim, answering open question 6
of `docs/design/agent-memory.md`:

> 2D не используемые, не совсем понимаю, что имеется в виду. Как мы будем
> понимать, что они не используемые? Может быть, они потом понадобятся.

The phase 1 brief recorded it as "Nothing is ever deleted for disuse; at most
it ranks lower."

The default answer to "should we build this" is no. Here the quote asks for an
MVP in so many words («я хочу MVP уже получить … это в принципе уже можно
строить MVP»), so the question this document answers is the smallest build
that satisfies every line of it, and what waits.

## 0. Prior conversations and memory

`search_transcripts` and `search_memory`, project-scoped and unscoped,
2026-10-07: `role memory builder lessons`, `память ролей билдер компакт`,
`never delete for disuse archive memory`, `never delete for disuse ranks
lower`, and `search_memory` for `memory lessons rules role builder reviewer
clean`.

| Hit | What it settles |
| --- | --- |
| The orchestrator conversation, 2026-10-07 11:41 UTC | The quote above, read in full at its transcript line. |
| Phase 1 stage briefs, 2026-10-02 (Codex rollouts) | The operator's 2026-10-02 answers on shared memory, including the disuse rule quoted above, and "memory has kinds scoped per project and cross-project, in parallel". |
| The orchestrator conversation, 2026-10-05 (phase 4 brief) | "never delete memories for disuse (at most lower ranking); private memory text stays …" — the same rule carried into phase 4. |
| `search_memory` | No entry about role memory, lessons or stage-end reflection. |

No earlier design proposes per-role memory or a stage-end lesson. The one
earlier decision this design overrides is the first item of "Deferred — not
currently justified" in `docs/design/agent-memory.md`: "A writable Delegatus
store and a `remember` tool. Both engines already save on request, and a third
write path would compete with them." Section 2.1 says why the new requirement
justifies a store of Delegatus's own, and why it does not compete.

## 1. What exists, and what it does not cover

| Piece | Where | What it gives role memory |
| --- | --- | --- |
| Shared memory phases 1–3 | `src/lib/memory/*`, `docs/design/agent-memory.md` | A read-only index over the engines' own stores (`memory-index.sqlite`), `search_memory`, and per-prompt injection through the engines' `UserPromptSubmit` hooks. The index is a derivative, "safe to delete" (§4.7 of that design), so it cannot hold primary text. Injection runs only for the operator's own turns (`memoryGate`, `src/lib/memory/selection.ts:14`), and a launch brief from a pipeline is skipped (agent-memory.md §4.4, "holds a pipeline or flow membership"). Pipeline stages therefore receive no shared memory today. |
| The per-project memory switch | `src/lib/memory/settings.ts:17`, `src/components/memory/MemoryPage.tsx` | The operator's existing place for memory: header menu → Settings → Memory, on the desktop rail menu and the phone's menu sheet. On by default for this repository only. |
| The stage prompt | `renderStagePrompt`, `src/lib/pipelines/prompts.ts:36` | Brief, relay, pinned task, pinned specification, role scaffold, then the controller's contract, which every stage reads last. It is re-rendered at activation and must match byte for byte (`engine.ts:4666`), so anything injected has to be frozen on the attempt. |
| Attempt binding | `bindAttemptDefinition`, `engine.ts:2424` | Freezes a stage's prompt, role, account, sandbox and outputs when the attempt starts. |
| `stage_report` | `src/lib/mcp/server.ts:3216`, `reportStageCompletion` at `engine.ts:11113` | The one completion channel. It resolves the calling conversation to its live attempt (`resolveStageCompletionTarget`, `engine.ts:10952`), records the report, and answers the agent. "The stage settles when this turn ends, so you may keep working after it" (`prompts.ts:107`). |
| The role registry | `src/lib/roles/types.ts:1`, `src/lib/roles/defaults.ts` | Twelve roles: orchestrator, reviewer, verifier, builder, architect, cleaner, prod-auditor, deployer, merger, maintainer, issue-reporter, visual-critic. A fixer is the builder in `mode: apply-fixes` (`defaults.ts:223`). |
| One-turn headless Codex | `runHeadlessCodexOnce`, `src/lib/agent/headless.ts:477` | A bounded, read-only, schema-free single answer. The rotation digest uses it with a small model (`handoffDigest.ts:562`). |
| State in SQLite | `SqliteStateCollection`, `src/lib/state/sqliteStateStore.ts:919`; `docs/design/state-sqlite-migration.md` decision 1 | Durable collections in `state.sqlite` with WAL, integrity checks and the ten-minute backups. "No new database file is introduced." |
| Privacy detectors | `staticSensitiveClasses`, `src/lib/privacy/staticDetectors.ts:32`; `scrubIssueReport`, `src/lib/issueReports/scrub.ts:67` | Hints for home paths, credentials, private addresses and ids, already used on text bound for a public issue. |
| Linked lane rows | `src/lib/links/laneFeed.ts:1-7` | By construction carry identifiers and counts only: "no prompt, spec, finding text, summary, path or conversation id". |
| The board maintainer | `docs/design/board-maintainer.md` | A per-project agent on the seat tick, every few hours, with board tools. |

What none of these does: let an agent of one role leave a rule for the next
agent of the same role, the same project or the whole machine, and hand that
rule to every new agent of the role at its start. Native memories are per
engine and per account; Claude's is per repository for every session alike,
Codex's is generated in the background from threads idle for six hours
(agent-memory.md §2.2). Neither knows what a role is, neither crosses
engines, and Delegatus runs builders on Codex and critics on Claude.

## 2. Design

### 2.1 What is new

1. **A store of rules**, in Delegatus's own state: three kinds of scope, each a
   list of rules rendered to at most 10 000 characters, with immutable
   revisions, per-rule provenance and an archive.
2. **A stage-end prompt and one MCP tool, `leave_lesson`.** The prompt rides in
   the answer to an accepted `stage_report`; the agent answers it with
   `leave_lesson` before its turn ends.
3. **Consolidation**: one headless Codex turn per scope that merges,
   deduplicates and rewrites the rules under the bound, checked by the server
   so no rule disappears unrecorded.
4. **Injection at start**: a stage attempt freezes the revisions it reads when
   it binds, and the stage prompt carries a labelled "Learned rules" block.
5. **Controls** on surfaces that exist: a second switch and the scope pages on
   the Memory page; one line under the stage report on the card.

Everything else is reused: the conversation→attempt resolution of
`stage_report`, the attempt binding, the headless runner, the state
collections and their backups, the privacy detectors, the Memory page and the
stage report line.

Why a Delegatus store now, against the earlier deferral: the earlier design
deferred a store for facts an engine can already remember on request. These
rules belong to a role and a project, are written at a moment Delegatus
controls (stage end), cross engines by design, and are injected
deterministically into agents that the engines' own memory reaches unevenly:
what a Codex stage learned reaches Codex's memory only after its thread has
sat idle for six hours and never reaches a Claude stage, and a Claude stage
gets the repository's notes whatever its role. Delegatus writes nothing into
an engine's store, so the engines' recall and pruning stay as they are.

### 2.2 Scopes and storage (R1)

| Scope | Key | Who reads it | Who writes it |
| --- | --- | --- | --- |
| Role in a project | `role:<project>:<roleId>` | every new stage of that role in that project | stages of that role, and stages of other roles addressing it (2.7) |
| Project | `project:<project>` | every memory-eligible stage of the project | any memory-eligible stage of the project |
| Machine | `machine` | every memory-eligible stage of every project whose switch is on | any memory-eligible stage |

`<project>` is the canonical project key (`canonicalProject`), so a folder
whose key changed (a new origin, a rename the forge proves) keeps its rules
through the succession aliases that already govern every project-keyed store
(AGENTS.md, "The same folder can change key over time").

**Bound.** Each scope renders to at most 10 000 characters, counted as Unicode
code points, so a Ukrainian rule costs the same as an English one. With three
scopes a stage receives at most 30 000 characters, about 7 500 tokens.

**Storage.** Three collections in `state.sqlite` through
`SqliteStateCollection`, so the store inherits WAL, the activation integrity
check and the ten-minute backups, and adds no database file:

| Collection | One record per | Fields |
| --- | --- | --- |
| `role-memory-rules` | rule, ever | `id`, `scope`, `rule` (≤ 300), `why` (≤ 160), `state`: `active` · `pending` · `merged` · `archived`, `archivedReason`, `mergedInto`, `sources` (ids it was merged from), `pinned` (operator-written), `author` (`agent` · `consolidation` · `operator`), `provenance` (project, pipeline, stage, attempt, role and mode, engine and model, conversation id, time), `hints` (privacy detector classes), `createdAt`, `changedAt` |
| `role-memory-revisions` | change of a scope's active list | `scope`, `n`, `at`, `author`, `active` (rule ids in order), `rendered` (the exact injected text), `chars`, `added`, `merged`, `archived`, `note` (a refused consolidation's reason) |
| `role-memory-settings` | project | `enabled` |

A revision is never rewritten, so an attempt that recorded `(scope, n)` renders
the same text on every re-render. Only the Viewer process writes these
collections; the `leave_lesson` MCP tool forwards to the Viewer the way
`search_memory` does (`src/lib/memory/mcp.ts`), and the state ownership rules
in AGENTS.md apply unchanged: a build or a test resolves a throw-away state
directory.

### 2.3 Who gets memory, and who stays clean (R2)

| Role | Reads | Writes | Why |
| --- | --- | --- | --- |
| reviewer | nothing | nothing | The operator: «ревьюер всегда чистый … чтобы они были новые». A review judges the diff against the requirement; a reviewer told "builders here forget X" hunts X, and one told "reviews here accept Y" lowers the bar. This covers every stage whose role is reviewer, including legacy `review-loop` stages. |
| verifier | nothing | nothing | It confirms or refutes stated claims on evidence; priors about the author bias the verdict the same way. |
| issue-reporter | nothing | nothing | It judges whether a text may be published; it must judge that text alone, and its output is public. |
| orchestrator, maintainer | nothing in the MVP | nothing in the MVP | They are not pipeline stages, so the stage-end write path does not reach them, and each already carries its own continuity (the seat's monitor note and rotation digest; the maintainer's previous-run record). Deferred to slice 3. |
| builder (every mode and domain; a fixer is the builder in `apply-fixes`) | its role scope, project, machine | yes | «swarm builders, у которых общая память». One builder scope per project: frontend, docs and fix rounds share it. |
| architect | same | yes | «архитекторы все примерно помнят, что было раньше». |
| visual-critic | same | yes | «swarm of critiques». The critic stays independent of the builder's text; what reaches it from builders comes through the project scope or a rule addressed to it, which is the cross-role transfer the quote asks for. |
| merger, deployer, cleaner, prod-auditor | same | yes | Recurring operational traps are where a rule pays most. |
| a stage with no role preset | project, machine | project and machine only | It has no role scope to read or write. |

An excluded stage sees no "Learned rules" block, gets no lesson request in its
`stage_report` answer, and `leave_lesson` refuses it. On-demand search is
outside the guarantee: a reviewer can still read a builder's transcript, which
carries the block the builder received, through `search_transcripts`. "Clean"
here means nothing is put into its context.

### 2.4 The write path: the stage-end prompt (R3)

**When.** An agent calls `stage_report`. When the report is accepted, the
attempt's role is memory-eligible, the project's switch is on and this is the
attempt's first accepted report, the acknowledgement gains one field,
`lessonRequest`, holding the prompt below as an array of lines; the
conversation reader's tool card then shows it line by line, where one long
string would read as a single escaped line (variant 5 shows both the card and
the text). The agent is still inside its turn (the stage settles when the turn
ends), so it reads the request with the whole stage in context, after its
verdict is recorded and unable to change it. A replacement report does not
repeat the request. A legacy `review-loop` stage completes through its flow
and refuses `stage_report`, so its fix rounds get no request; the converted
form `add-stage` creates (a reviewer stage and a fix stage joined by a fail
edge) does.

**Why the acknowledgement.** It is the moment the operator named («после того
как они закончили … stage completed … этот промпт … injected специально им»),
it costs no extra turn, no host hook and no new delivery, and it works the same
on Claude and Codex because both read MCP answers. Agents treat instructions
inside tool output with caution, so the stage wrapper announces it in advance,
in the paragraph about `stage_report` (`prompts.ts:104`), for eligible stages
only:

> When this project keeps learned rules, the answer to an accepted stage_report
> asks you for a lesson. Answer it with leave_lesson, then end your turn.

**The prompt, in full.** `{{handed}}` is filled by the server when the attempt
was activated by a fail edge (a fix round): "This attempt was handed N findings
from stage `<id>` (P1 ×a, P2 ×b). Start there." Otherwise the line is absent.

```text
Your stage report is recorded. Before you end this turn, leave what this stage
taught you for the agents who come after you. Delegatus keeps it as learned
rules and gives them, at the start of their work, to every new agent of the
role you address.

Write one to three lessons. Each lesson is an abstract rule: it names a class
of mistake or of situation and what to do about it, so the whole class stops
recurring. A one-off fact (a file name, a pull request number, the state of a
branch today) belongs in your stage report and makes no lesson.

Where to look first:
- Findings you were handed or found yourself: for each class of finding,
  which rule, followed from the start, would have prevented it?
- A wrong turn you corrected, a check that failed late, a retry, anything
  that cost a round.
- A learned rule you were given that proved wrong, stale or too broad: say
  what is wrong with it. That is a lesson too.
{{handed}}

For each lesson give:
- rule: one or two imperative sentences, at most 300 characters, true beyond
  this task.
- why: one line, at most 160 characters: what went wrong here, or what it cost.
- scope: where the rule is relevant.
    role     the next agent of a role on this project; your own role unless
             you name another
    project  every role on this project
    machine  every project on this machine: tools, the operating system,
             the environment
- role (optional, with scope role): the role the rule is for, when another
  role would have prevented or caught the problem earlier, for example a
  builder's mistake the visual critic should check. Reviewers and verifiers
  receive no learned rules; address such a rule to the project.

Learned rules go into other agents' prompts, and machine rules into other
projects. Write no account names, emails, tokens, absolute home paths,
customer data or names of people; write paths relative to the repository.

Read the learned rules you were given at the start before you write, and
repeat none of them unless you sharpen it.

Call leave_lesson once with all your lessons. If this stage taught nothing new,
call it with none and one line saying why; leaving at least one lesson is
better. Then end your turn: the stage itself is complete.
```

**`leave_lesson`.** Input:
`{ lessons?: [{ scope: "role" | "project" | "machine", role?: RoleId, rule, why }] (1–3), none?: string, clientRequestId }`.
The server resolves the calling conversation to its attempt with
`resolveStageCompletionTarget`, as `stage_report` does, and takes every piece
of provenance from that resolution. It refuses an excluded role, a lesson
addressed to an excluded role, a missing `why`, and a settled attempt. It
accepts within the length bounds above, and answers with the scope each rule
joined, the rule id, the scope's size after it, whether a consolidation was
scheduled, and privacy hints (2.9). A second call in the same turn adds to the
first, up to three lessons per attempt.

**A stage that leaves nothing.** In the MVP the stage card says so (2.10) and
the Memory page counts it, so the operator sees the rate. Slice 2 adds a nudge
for a turn that ends after an accepted report with no `leave_lesson` call.
The pipeline never waits on a lesson.

**Example.** A fixer whose first review round failed on an untested empty
input and a clipped Ukrainian label, after a browser died in its stage:

```json
{
  "lessons": [
    {
      "scope": "role",
      "rule": "When a change adds a branch for empty, missing or zero input, write the test for that branch in the same commit as the branch.",
      "why": "Round 1 failed on two P2 findings: the empty-list path of the new selector had no test and threw."
    },
    {
      "scope": "role",
      "role": "visual-critic",
      "rule": "Judge the 390 px Ukrainian frame first: Ukrainian labels run about a third longer than English, and clipping shows there before anywhere else.",
      "why": "The Save button clipped only at 390 px in Ukrainian; the English frames passed and hid it."
    },
    {
      "scope": "machine",
      "rule": "Give a browser started from a pipeline stage a temporary directory of 42 characters or fewer; the stage's own TMPDIR pushes Chromium's socket path past the 107-byte limit.",
      "why": "The browser driver died in under a second with 'Socket path too long' until TMPDIR was shortened."
    }
  ]
}
```

### 2.5 Appending and consolidation (R4)

**Append at once.** An accepted lesson becomes an active rule at the end of its
scope immediately, as a new revision, when the scope still fits under 10 000
characters with it; the next agent of the role reads it from its very next
start («все её читают, сразу же»). A lesson that does not fit is `pending`:
visible on the Memory page, waiting for consolidation, and never injected
half-cut.

**When consolidation runs.** On write, for that scope only, when its active
text passes 8 000 characters, when five lessons have joined since its last
consolidation, or when a pending lesson waits; and when the operator presses
"Consolidate now". There is no timer. One consolidation runs at a time on the
machine, scopes queue, and a scope consolidates at most twelve times a day; a
refused or failed run is retried at the next trigger, no sooner than 30
minutes later.

**By whom, with which model.** Delegatus itself, through `runHeadlessCodexOnce`,
the one-turn path the rotation digest uses: an empty working directory,
`sandbox: "read-only"`, a three-minute cap, the account selection headless
runs already use. The model is `gpt-6.1-sol` at effort `medium`. The digest
uses a small model because a lossy summary costs little there; here
consolidation is the one step that decides which rule to drop, so it gets the
model the review roles use. The board maintainer was considered and set aside:
it runs per project every few hours with board tools and a long brief, and the
machine scope has no project.

**Budget.** Input at most 24 000 characters (the scope's rules, pending
lessons, the instructions), output at most 12 000; about 8 000 tokens in and
4 000 out per run. A lane of five stages that each leave two rules triggers
about two runs.

**The contract.** Every input rule carries an id (`R1…` active, `L1…`
pending, `P1…` pinned). The model answers JSON:

```json
{
  "rules": [{ "rule": "…", "why": "…", "from": ["R3", "L2"] }],
  "archived": [{ "id": "R7", "reason": "duplicate | superseded | too-specific | wrong | budget", "note": "…" }]
}
```

The instructions: keep the scope useful to a new agent of the role; merge
rules that state one class; rewrite a specific rule into its class when the
class is clear; drop a rule a newer rule contradicts as `superseded`, or one a
later lesson shows `wrong`; when the bound forces a choice, archive the most
specific, least general rule first, as `budget`; keep pinned rules verbatim.

The server accepts the answer only when every input id appears in some
`from` or in `archived`, no unknown id appears, every pinned rule survives
unchanged, every rule is within its length, and the rendered text is at most
10 000 characters. Otherwise the scope keeps its revision, the pending lessons
stay pending, and the history records the refusal with its reason. A rule with
several `from` ids is a merge; its sources become `merged` and link to it.

**Nothing disappears silently.** Every rule leaving the active list is either
`merged` (its successor named) or `archived` (its reason named), shown on the
scope's page and restorable in one action. Consolidation never deletes a
record, and no rule is dropped for disuse: the MVP has no usage signal, and
the operator's 2026-10-02 rule stands.

### 2.6 Injection at start (R5)

**When it is frozen.** `bindAttemptDefinition` (`engine.ts:2424`) gains one
field, `definition.memory`: the `(scope, revision)` pairs current at binding,
for the scopes this attempt may read, or `null` when the role is excluded or
the project's switch is off. Revisions are immutable, so the activation
re-render (`engine.ts:4666`) produces the same bytes, a retried or restarted
attempt reads what its first launch read, and the stage card can name exactly
which revision a stage started with. The pipeline record holds the revision
ids only; the text stays in the role memory collections.

**Where it goes.** `renderStagePrompt` takes the rendered block as one more
argument and places it after the role scaffold, before the controller's lines
(publish_prototype_review, access, host access, branch contract, stage_report),
which keep their place as what every stage reads last. So the block sits below
the brief and the specification, and nothing the controller requires is pushed
above it.

**Format.**

```text
Learned rules (Delegatus role memory)
Earlier agents left these after their stages. They are rules of thumb and can
be out of date: the brief, the pinned specification and the project's
instruction files win where they disagree. A rule that misled you is worth a
lesson at the end. Keep these rules out of commits, pull requests, issues and
documents.

Builder · this project · revision 14 · 6 820 / 10 000 characters
- When a change adds a branch for empty, missing or zero input, write the test for that branch in the same commit as the branch. Why: an untested empty-list path failed review.
- …

Every role · this project · revision 5 · 2 140 / 10 000 characters
- …

Every project · this machine · revision 3 · 1 380 / 10 000 characters
- …
```

An empty scope prints no heading. A stage on an excluded role, or in a project
whose switch is off, gets no block at all.

**Coexistence with shared memory.** Per-prompt shared memory already skips
pipeline launch briefs, so a stage is never offered both for the same turn.
Claude stages still load the repository's native auto memory, as they do
today; the two may repeat a fact, and the block's header says which wins.

### 2.7 Cross-role transfer (R6)

1. **Addressed at write time (MVP).** A lesson may name another memory-eligible
   role (`scope: "role", role: "visual-critic"`) or the project. The prompt
   asks for exactly that when another role would have prevented or caught the
   problem earlier, which is the builder→critic transfer the quote names. The
   provenance keeps the writing role, so the critic's page shows "from a
   builder (fix round)".
2. **Synthesis (slice 2).** When a project scope consolidates, its input also
   lists the project's role scopes, and the model may promote a rule that two
   or more roles hold into the project scope: the role copies become `merged`
   into the project rule. The same contract and server check apply.
3. **Up to the machine (slice 3).** A project rule that two projects hold is
   proposed for the machine scope; the operator accepts it on the Memory page.

### 2.8 Visible and controllable (R7)

All on the existing Memory page (header menu → Settings → Memory, desktop and
phone), with no new menu item:

- **A switch, "Learned rules for this project".** Off: the project's stages get
  no block, no lesson request, and `leave_lesson` refuses them; its stored rules
  stay. On by default for this repository, off for every other project, the
  way the shared memory switch starts. It is separate from the shared memory
  switch because it needs no provider key and sends nothing off the machine.
- **The scopes**, one row each: Builder, Architect, Visual critic and any other
  role scope that has rules, "Every role" and "This machine", each with its
  size (6 820 / 10 000), its revision and how many rules joined today.
- **A scope's page**: its active rules in injection order, each with who left
  it (role and mode, stage, pipeline, time) behind one tap; pending lessons;
  `Archived (n)` and `Merged (n)` with reasons; `History`, one line per
  revision ("+2 from fix · stage fix · 14:32", "consolidation: 3 merged, 1
  archived as too specific"); "Consolidate now".
- **Editing.** Edit a rule's text, archive a rule (reason "by you"), restore an
  archived rule, add a rule. An operator's rule is pinned: consolidation keeps
  it verbatim, and it counts toward the 10 000.
- **The stage card** (2.10).

The prototypes (section 4) show where these live.

### 2.9 Privacy

The repository is public, and so is anything a lane pushes. Rules hold what
agents learned on this machine.

- **Where the text lives.** Only in the role memory collections in the state
  directory, the stage prompts that carried it, and those stages' transcripts:
  all local. The pipeline record holds revision ids (2.6). Task text and
  details, linked-board task sync and lane rows carry none of it; lane rows are
  identifiers and counts by construction (`laneFeed.ts:1-7`), and this design
  adds no field to them.
- **No publication path.** No rule is ever written into the repository,
  AGENTS.md or CLAUDE.md, a commit, a pull request or an issue by Delegatus.
  The injected block tells the agent to keep its rules out of all four.
- **Detectors are hints.** `leave_lesson` runs the static detectors the issue
  report uses (`staticSensitiveClasses`) over each lesson. A match never
  refuses: the answer names the class and the span ("this looks like a home
  directory path"), the agent judges and may call again with a rewritten
  lesson, which replaces its earlier one, and the rule carries the hint so the
  Memory page marks it for the operator, who decides last.
- **Machine rules cross projects.** That is their purpose («на уровне вообще
  машины»). The prompt asks for rules about tools and the environment there,
  and the per-project switch keeps any project out entirely.
- **Who can read the pages.** The routes serve the installation's operator
  under the access rules the settings routes already use.

### 2.10 The stage card

Under the stage report line (`StageReportLine`, `PipelineSection.tsx:72`),
which the card's lane row and the Stages sheet draw. The phone's task screen
draws a report line only for the current stage (`PipelineBlock.tsx:967`), so
there a finished stage that left rules gains its report line with the lesson
under it, above "Open agent":

- a stage that left rules: "Left 2 rules → Builder, Visual critic", with the
  first rule's text, opening that rule on its scope page;
- an eligible stage whose turn ended with no lesson: a quiet "No rule left";
- an excluded stage (a review): nothing.

The prototypes compare a line of its own with a count inside the report line.

## 3. The MVP and the slices after it

### 3.1 MVP — what gets built

1. **Store**: the three collections (2.2), the scope keys, rendering and the
   10 000 bound, revisions.
2. **Write path**: `leave_lesson` on the MCP server, forwarded to the Viewer;
   `lessonRequest` on the accepted `stage_report` answer for eligible roles; one
   sentence in the stage wrapper; exclusions (2.3); privacy hints (2.9).
3. **Consolidation**: triggers, the headless run, the contract and its server
   check, archive and merge records (2.5).
4. **Injection**: `definition.memory` at binding, the block in
   `renderStagePrompt` (2.6).
5. **Controls**: the switch, the scope rows and pages with edit, archive,
   restore, add and "Consolidate now" on the Memory page, desktop and phone;
   the line under the stage report (2.8, 2.10).
6. **A test aid**: `scripts/role-memory-fill.ts`, which adds a fixed set of
   forty generic rules to one scope of a named project through the Viewer's
   own route, marked as synthetic, so the operator can watch consolidation
   hold the bound within minutes (section 5, step 7). Its rules archive in one
   action.

Tests that ship with it, all against isolated state: rendering and the bound
in code points; the consolidation check (every refusal reason, and acceptance);
byte-stable re-render with frozen revisions; the exclusion table, including a
reviewer stage whose prompt holds no block and whose `stage_report` answer
holds no request; `leave_lesson` provenance taken from the server resolution;
no rule text in a lane row or a task sync payload; a refused consolidation
leaving the scope unchanged.

### 3.2 Slice 2

- **At least one lesson.** A nudge when a stage's turn ends after an accepted
  report with no `leave_lesson`: Claude's `Stop` hook can return one blocking
  reason that asks again, once; for Codex the same needs a probe of its hook
  events under the app-server host first. Ship when the MVP's rate of "No rule
  left" says it is needed.
- **Agents launched with a role outside pipelines** (the new-agent form,
  `spawn_agent` with a role): the block at launch, and `leave_lesson` when they
  finish.
- **Synthesis** into the project scope (2.7, item 2).

### 3.3 Slice 3

- Usefulness: count review findings in later lanes that fall in a rule's class,
  and rounds after a rule joined; rank by it, never delete by it.
- Machine promotion proposals (2.7, item 3).
- The maintainer's brief gains a short section: rules that name a path the
  repository no longer has, and project rules that contradict the instruction
  files. It raises attention lines and changes nothing itself.
- Role memory for the orchestrator seat and the maintainer.
- `search_memory` covers archived rules for eligible roles.

## Deferred — not currently justified

- **Per-stage selection of rules** (Jev or embeddings). A scope is small enough
  to inject whole, and selection would make the injection depend on a model
  call at every start.
- **Separate builder scopes per domain or mode** (frontend, docs, fix rounds).
  One builder scope per project until a scope overflows with rules that only
  one domain needs.
- **A dedicated "fixer" role.** The fixer is the builder in `apply-fixes` and
  shares the builder's memory.
- **A consolidation agent role in the registry.** One headless turn with a
  checked contract does the job.
- **Writing rules into AGENTS.md or CLAUDE.md**, automatically or on a button.
  The repository is public; the operator promotes by hand.
- **Syncing role memory across machines or linked installs.**
- **Any memory for reviewers, verifiers or the issue reporter**, including a
  memory of their own.
- **A follow-up turn after settlement** to ask for the lesson. It would reopen a
  settled attempt's conversation, run beside the next stage and need a live
  host; the acknowledgement asks inside the same turn for free.
- **Asking for lessons up front in the stage prompt or as a `stage_report`
  field.** The quote places the question after completion, and a field would
  have the agent write its lesson before its verdict is fixed.

## 4. Prototypes (D2)

Published to this task's prototype review, five numbered variants, rendered
through the kanban evidence fixture (`issue1695BrowserHarness`) with the
product's own components and stylesheet, desktop 1440 px and phone 390 px,
English and Ukrainian: 44 frames. The prototype components lived in a scratch
export of `5a197eeb5` and were never added to the repository. Frames:
`~/Pictures/delegatus-review/role-memory/`. Measurements:
`evidence/role-memory/frames.json`.

| # | Name | What it shows |
| --- | --- | --- |
| 1 | Pages in the menu | (a) The Memory page gains the switch and the scope rows; a scope opens as a deeper page in the same menu or sheet, with rules, history and archive. No new window. |
| 2 | Rules window | (a) The same switch and one row, "Learned rules", opening a wide window: scopes on the left, rules in the middle, history and archive on the right; on the phone a full-screen sheet with a scope picker. |
| 3 | Rule line under the report | (b) A line of its own under the stage report: "Left 2 rules → Builder, Visual critic" and the first rule; "No rule left" when none. |
| 4 | Count in the report line | (b) "2 rules" as a count inside the report line, expanding into the rules on a tap; nothing extra when collapsed. |
| 5 | The prompt as the agent sees it | (c) The stage conversation: the "Learned rules" block in the first message, then `stage_report`, the lesson request in its answer, and the `leave_lesson` call with the example answer of 2.4. |

What the frames showed:

- Variant 1 adds no window. On the phone the scope page reads comfortably in
  the menu sheet. On the desktop the rail menu is 232 px wide, so four rules
  fill the panel to the bottom of a 900 px screen; a full scope of about thirty
  rules means a long scroll inside the menu. A Ukrainian role name
  ("Критик вигляду") clipped beside the "+1 today" mark in the first render;
  the mark moved onto the size bar's line and the name now reads in full.
- Variant 2 shows a whole scope with its history and archive at once on the
  desktop. Its "Restore" links are text buttons under 16 px tall, which the
  build would enlarge.
- Variants 3 and 4 reuse the report line. On the phone's task screen the
  finished fix stage gains its report line with the lesson (2.10).
- Variant 5 renders through the real conversation reader: the stage prompt is
  folded under "system", and the `stage_report` card shows the request line by
  line.
- Two measurements flag the existing shared-memory part of the Memory page,
  untouched by these variants: in Ukrainian at 232 px the tile label
  "підставлено" overflows its tile by 5 px, and the inline "Докладніше" link is
  under 16 px tall.

The recommendation, for the operator's choice: **1 with 3**. Variant 1 adds no
window and keeps memory where the operator already switches it; variant 3
makes a missing lesson visible, which the quote asks for («лучше, чтобы хоть
какую-то оставил»). If reading a full scope in the desktop menu proves
cramped, variant 2's window is the desktop alternative, entered from the same
row.

## 5. Test plan for the operator (D3)

About an hour, on a scratch repository so nothing reaches GitHub. A pipeline
pinned to a `baseRef` never touches the network (`create_pipeline`,
`publication` defaults to internal).

1. **Prepare (5 min).** Create a small local repository, for example
   `~/Projects/role-memory-trial`: one TypeScript file with `parseDuration`
   and one test, committed, no origin. Open its project in Delegatus.
   Header menu → Settings → Memory: switch **Learned rules for this project**
   on. The scope rows read empty; "Every project" under "On this machine"
   shows whatever earlier lanes left.
2. **A lane that will fail review (20–25 min).** Ask the seat for a pipeline
   on the trial project, pinned to the current commit: a builder stage, a
   reviewer stage, and a fix stage the reviewer's fail edge points at (the
   form `add-stage` builds from a review loop; a legacy `review-loop` stage
   gets no lesson request, 2.4), task "Add `parseSize('10MB')` beside
   `parseDuration`". Give the reviewer, and only the reviewer, one extra
   rule in its brief: "Fail any new function whose empty-string input has no
   test." The builder does not know it, so the first review fails with a finding
   of that class.
3. **Watch the fixer leave a rule (2 min after it ends).** On the card the fix
   stage shows "Left 1 rule → Builder" (or 2, with the rule text). Open the
   fixer's conversation: the `stage_report` answer carries the lesson request,
   and the next call is `leave_lesson`. The reviewer's stage shows no line and
   its first message has no "Learned rules" block.
4. **See the rule stored (2 min).** Memory → Builder: the rule is in the
   list, with "fix · attempt 1 · <time>" behind it; History shows revision 1,
   "+1 from fix". While there, add one rule by hand on "Every role" for step 6.
5. **A fresh builder starts with it (10–15 min).** A second lane on the same
   repository, builder → reviewer, task "Add `parseRate('5/s')`", the reviewer
   again with the same extra rule. Open the builder's first message: the
   "Learned rules" block lists the rule under "Builder · this project". Expected,
   though a model can still slip: the builder writes the empty-input test
   itself and the review passes in the first round.
6. **Cross-role (2 min).** If the fixer addressed a rule to the visual critic
   or the project, it appears under that scope with "from a builder (fix
   round)". The rule you added in step 4 appears under "Every role · this
   project" in the second lane's builder prompt, and nowhere in its reviewer's.
7. **Consolidation keeps the bound (5 min).** Run
   `bun scripts/role-memory-fill.ts --project <trial key> --scope builder`.
   The Builder row passes 10 000 with pending lessons; within a few minutes a
   consolidation revision appears: the size reads at most 10 000, "Merged (n)"
   and "Archived (n)" list what left the list and why, and nothing is missing
   from history. Press "Consolidate now" once more and confirm a second
   revision changes little. Archive the synthetic rules in one action.
8. **The switch (5 min).** Turn **Learned rules for this project** off. Start a
   one-stage builder lane: its first message has no block, its `stage_report`
   answer has no lesson request, and the Builder page still shows its rules.
   Turn it back on.
9. **Privacy spot check (2 min).** Search the trial repository and its pushed
   branches for a rule's text: nothing. On a linked board, the trial lanes show
   no rule text.

## Validation against the requirement

| Quote | Where answered |
| --- | --- |
| «какое-то количество ролей … swarm builders … swarm of critiques … архитекторы» | Scopes per role in a project (2.2), roles that read and write (2.3). |
| «ревьюер всегда чистый … чтобы они были новые» | Reviewer, verifier and issue reporter receive and write nothing (2.3). |
| «каждый билдер после своей работы может оставить небольшой компакт … который пойдёт в следующему билдеру, в этом проекте» | The stage-end prompt and `leave_lesson` (2.4), the builder scope per project (2.2), injection at start (2.6). |
| «все пишут … все её читают, сразу же, и обновляют» | Append at once as a new revision; the next start reads it (2.5). |
| «чтобы не захламлять … чтобы файл не раздувался … 10 000 символов» | The bound per scope and consolidation with a checked contract (2.2, 2.5). |
| «injected каждый раз, когда создаётся новый этот агент с ролью» | Frozen at binding, rendered below the brief (2.6). |
| «cross row … от билдера передать критику» | Rules addressed to another role or the project at write time; synthesis in slice 2 (2.7). |
| «учиться на ошибках … абстрактное правило … чтобы такой класс ошибок больше не ловился» | The prompt asks for classes of mistakes, findings first, with the handed findings named in fix rounds (2.4). |
| «релевантно на уровне роли … проекта … машины» | The three scopes, chosen by the agent per lesson (2.2, 2.4). |
| «после того как они закончили … stage completed … промпт … injected специально им … лучше, чтобы хоть какую-то оставил» | The request in the accepted `stage_report` answer; "No rule left" on the card; a nudge in slice 2 (2.4, 2.10). |
| «я хочу MVP уже получить» | Section 3.1. |
| «скажешь мне, как я смогу это протестить … прототипы увидеть» | Section 5 and section 4. |
| 2026-10-02: «Может быть, они потом понадобятся» | Nothing is deleted; merged and archived rules stay visible and restorable (2.5). |

## Open questions for the operator

None of these blocks the MVP; each has a default the build takes.

1. **Which projects start with learned rules on?** Recommendation: this
   repository on, every other project off until you switch it on, as shared
   memory starts.
2. **Does the visual critic read the project scope?** Recommendation: yes;
   that is the builder→critic path you named.
3. **Do your own pinned rules count toward the 10 000?** Recommendation: yes,
   so the bound holds whatever is in the scope.
4. **Variants**: which of 1–2 for the Memory page, and which of 3–4 for the
   card? Recommendation: 1 and 3.
