# Role memory: agents leave abstract lessons, the next agent of the role starts with them

Status: design, with prototypes and a test plan, revised once after an
independent design review (section 6 lists what changed). Written against
`main` at `5a197eeb5` (2026-10-07). File and line references are to that
commit. This lane wrote this document and the frame manifest and nothing else
in the repository; the prototype frames live outside it, under
`~/Pictures/delegatus-review/role-memory/`.

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
| Shared memory phases 1–3 | `src/lib/memory/*`, `docs/design/agent-memory.md` | A read-only index over the engines' own stores (`memory-index.sqlite`), `search_memory`, and per-prompt injection through the engines' `UserPromptSubmit` hooks (installed for every Claude launch, `src/lib/agent/spawnPolicy.ts:493-496`). The index is a derivative, "safe to delete" (§4.7 of that design), so it cannot hold primary text. Injection runs only for the operator's own turns (`memoryGate`, `src/lib/memory/selection.ts:14`). A pipeline's launch brief is skipped, but only the launch: `src/lib/memory/controller.ts:76-88` admits a later human message in the same conversation, and nothing there looks at the conversation's role. A reviewer stage the operator writes to can therefore receive shared memory today. |
| Native engine memory | agent-memory.md §1–2 | Claude's auto memory is on by default and is turned off by `autoMemoryEnabled` in settings or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (agent-memory.md, table in §1.1). Codex's memories are a feature flag (`[features] memories`), already turned off for ephemeral runs with `--disable memories` (`src/lib/agent/ephemeral.ts:211`). Pipeline stages get both today, whatever their role. |
| The stage input composer | `composeStageInput`, `src/lib/pipelines/stageInput.ts:14` | Keeps a launch message within the 32 000-byte structured envelope (`MAX_STRUCTURED_TEXT_BYTES`, `src/lib/runtime/structuredContent.ts:40`). When substitutions do not fit, it writes them, and as a last resort the whole rendered prompt, to `.artifacts/pipeline-stage-inputs/private/` inside the checkout (`stageInput.ts:58-72`, `controllerArtifacts.ts:5,22-42`): ignored and kept out of the index, but on disk in the repository's working tree. |
| Deferred activation | `engine.ts:5244-5288`, `engine.ts:4679-4691`, `types.ts:384-387` | A deferred or replayed launch persists its whole `spawnInput`, prompt included, on the attempt (`attempt.activation.input`), after the composer has run ("Persist the materialized bytes before reserving or replaying a launch"). |
| Free-text writers that leave the machine | `encodeTask`, `src/lib/links/taskWire.ts:49-55`; `src/lib/bridge/reportRender.ts:149-168`; `publishPipelineBranch`, `src/lib/pipelines/git.ts:1372`; `publishPrototype`, `src/lib/prototypeReview/store.ts:128`; the agent Git guard, `src/lib/git/agentHistoryGuard.ts`, and the forge shims, `src/lib/git/agentForgeCredentials.ts:280-290` | Task text and details are copied to a linked board verbatim; bridge reports drop items by sensitive class, which says nothing about whether a text is a private rule. Commits, pull requests, prototype reviews and issues are written by agents and by the engine through these paths. |
| The per-project memory switch | `src/lib/memory/settings.ts:17`, `src/components/memory/MemoryPage.tsx` | The operator's existing place for memory: header menu → Settings → Memory, on the desktop rail menu and the phone's menu sheet. On by default for this repository only. |
| The stage prompt | `renderStagePrompt`, `src/lib/pipelines/prompts.ts:36` | Brief, relay, pinned task, pinned specification, role scaffold, then the controller's contract, which every stage reads last. It is re-rendered at activation and must match byte for byte (`engine.ts:4666`), so anything injected has to be frozen on the attempt. |
| Attempt binding | `bindAttemptDefinition`, `engine.ts:2424` | Freezes a stage's prompt, role, account, sandbox and outputs when the attempt starts. |
| `stage_report` | `src/lib/mcp/server.ts:3216`, `reportStageCompletion` at `engine.ts:11113` | The one completion channel. It resolves the calling conversation to its live attempt (`resolveStageCompletionTarget`, `engine.ts:10952`), records the report, and answers the agent. "The stage settles when this turn ends, so you may keep working after it" (`prompts.ts:107`). |
| The role registry | `src/lib/roles/types.ts:1`, `src/lib/roles/defaults.ts` | Twelve roles: orchestrator, reviewer, verifier, builder, architect, cleaner, prod-auditor, deployer, merger, maintainer, issue-reporter, visual-critic. A fixer is the builder in `mode: apply-fixes` (`defaults.ts:223`). |
| One-turn headless Codex | `runHeadlessCodexOnce`, `src/lib/agent/headless.ts:477` | A bounded, read-only, schema-free single answer. The rotation digest uses it with a small model (`handoffDigest.ts:562`). |
| State in SQLite | `SqliteStateCollection`, `src/lib/state/sqliteStateStore.ts:919`; `docs/design/state-sqlite-migration.md` decision 1 | Durable collections in `state.sqlite` with WAL, integrity checks and the ten-minute backups. "No new database file is introduced." `patchSync` with a `companion` (`sqliteStateStore.ts:1338-1368`) writes two collections of the same database in one transaction. |
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
   it binds; the pipeline record keeps a marker and the revision ids, and the
   rule text enters the launch message only at the spawn boundary.
5. **One exclusion policy** for every automatic memory path: the new block and
   lesson request, the existing shared-memory hook for every turn of the
   conversation, and the engines' native memory at launch (2.3).
6. **A private-memory egress check**: one function over the known rule texts,
   called by every path that writes free text off the machine or into the
   repository (2.9).
7. **Controls** on surfaces that exist: a second switch and the scope pages on
   the Memory page; one line under the stage report on the card.

Everything else is reused: the conversation→attempt resolution of
`stage_report`, the attempt binding, the stage input composer, the headless
runner, the state collections, their two-collection transaction and their
backups, the privacy detectors, the agent Git guard, the Memory page and the
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
scopes a stage receives at most 30 000 characters, about 7 500 tokens. In
UTF-8 that is up to about 60 000 bytes of Ukrainian, more than the 32 000-byte
launch envelope holds on its own; 2.6 says where such a block goes.

**Storage.** Three collections in `state.sqlite` through
`SqliteStateCollection`, so the store inherits WAL, the activation integrity
check and the ten-minute backups, and adds no database file:

| Collection | One record per | Fields |
| --- | --- | --- |
| `role-memory-rules` | rule, ever | `id`, `scope`, `rule` (≤ 300), `why` (≤ 160), `state`: `active` · `pending` · `rewritten` · `merged` · `archived`, `archivedReason`, `successor` (the rule a rewrite or merge produced), `sources` (the ids it was rewritten or merged from), `changeReason` (consolidation's one line), `pinned` (operator-written), `publishable` (the operator's release from the egress check, 2.9), `author` (`agent` · `consolidation` · `operator`), `provenance` (project, pipeline, stage, attempt, role and mode, engine and model, conversation id, time), `hints` (privacy detector classes), `createdAt`, `changedAt` |
| `role-memory-revisions` | change of a scope's active list | `scope`, `n`, `at`, `author`, `active` (rule ids in order), `rendered` (the exact injected text), `chars`, `added`, `kept`, `rewritten`, `merged`, `archived`, `rebasedOver` (revisions a consolidation was rebased over, 2.5), `note` (a refused consolidation's reason) |
| `role-memory-settings` | project | `enabled` |

A scope's current revision number is its version. Every change to a scope (an
appended lesson, an operator edit, a consolidation) is one `patchSync` over
`role-memory-revisions` with `role-memory-rules` as its companion
(`sqliteStateStore.ts:1338`): the rule records and the new revision commit in
one transaction, and only when the scope's latest revision is still the one the
change was computed from. A crash leaves either both or neither.

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

**One policy, every automatic path.** "Clean" means no learned memory reaches
an excluded agent's context unless it searches for it. Learned memory has five
automatic ways in, today or after this design. One predicate,
`learnedMemoryExcluded(conversation)` in `src/lib/memory/exclusion.ts`, closes
the first four, and the egress check (2.9) the fifth. The predicate answers yes when the conversation's pipeline or flow membership
role, or the role preset it was launched with, is reviewer, verifier or
issue-reporter; the membership is read from the registry snapshot the hook
already loads.

| Path | Today | With this design |
| --- | --- | --- |
| The "Learned rules" block and the lesson request | new | Not rendered; `leave_lesson` refuses. |
| Shared memory through `UserPromptSubmit` | Skips the launch brief only; a later operator message is admitted (`controller.ts:76-88`) | The controller returns empty for every turn of an excluded conversation, the operator's follow-ups included, and records "skipped: reviewer" in the status line the Memory page already shows. |
| Claude native auto memory | On for every Claude launch | The per-launch settings `spawnPolicy.ts` writes gain `autoMemoryEnabled: false` for an excluded role, and its launch environment gains `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. |
| Codex native memories | On wherever `[features] memories` is on | The launch for an excluded role passes `--disable memories`, the switch ephemeral runs already pass (`ephemeral.ts:211`), or its app-server config equivalent. |
| A relayed previous output that quotes a rule | A builder's summary reaches the next stage through `{{prev.output}}` | The egress check (2.9) replaces a quoted rule with its id, `[learned rule r_8c1e]`, when the stage report is recorded, so a reviewer reading the builder's relay reads an id. |

The two native switches are documented, and their effect is observed before
ship: a probe per engine plants a synthetic native memory holding a canary,
launches a reviewer stage on an isolated home, asks a question that matches it
at launch and again as an operator follow-up, and requires the canary absent
from both answers' context. If an engine version ignores its switch, the
excluded launch fails closed: it starts with the engine's memory home pointed
at an empty directory, through the documented `autoMemoryDirectory` per-launch
setting for Claude (agent-memory.md §1.1 and §6, phase 0) and an empty memory
folder for Codex.

Explicit evidence searches stay: a reviewer may still call `search_memory` or
`search_transcripts`, and a builder's transcript carries the block the builder
received. That is the reviewer choosing to look, which the quote does not
forbid; nothing is put into its context for it.

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
Learned rules stay on this machine: keep the text of a rule, yours or one you
were given, out of commits, pull requests, issues, task text, board and bridge
reports and prototype reviews, and name it there by its id. Delegatus refuses
text that repeats a rule.

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
first, up to three lessons per attempt. The attempt records the ids of the
rules it left, and nothing else of them: the stage card reads their text from
the store (2.10).

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
`sandbox: "read-only"`, a three-minute cap. The model is `gpt-6.1-sol` at
effort `medium`. The digest uses a small model because a lossy summary costs
little there; here consolidation is the one step that decides which rule to
drop, so it gets the model the review roles use. The board maintainer was
considered and set aside: it runs per project every few hours with board tools
and a long brief, and the machine scope has no project.

**Whose account, and what leaves the machine.** The run is an ordinary Codex
turn: the scope's rules, their reasons and the pending lessons, with the
instructions below, are sent to OpenAI's service under a Codex account of this
machine. A role or project scope uses the account selection the digest uses,
fenced to the project's allowed accounts (`resolveHeadlessSpawn("codex", null,
[], project)`, `src/lib/orchestrator/handoffDigest.ts:376`); the machine scope has
no project and uses the same selection unfenced. The history line of every
consolidation names the account and the model that ran it. An empty working
directory and a read-only sandbox keep the run away from files; the inference
still runs at the provider.

**Budget.** Input at most 24 000 characters (the scope's rules, pending
lessons, the instructions), output at most 12 000; about 8 000 tokens in and
4 000 out per run. A lane of five stages that each leave two rules triggers
about two runs.

**The input is frozen.** A run starts from the scope's current revision N: the
active rules, the pending lessons and the pinned rules as they stood at N, each
with a short id (`R1…` active, `L1…` pending, `P1…` pinned). The model sees
only that snapshot.

**The contract.** The answer is a total partition of the input ids. Every
input id appears in exactly one disposition, and every disposition is one of
four kinds:

```json
{
  "kept":      ["R1", "P1"],
  "rewritten": [{ "from": "R2", "rule": "…", "why": "…", "reason": "generalized | sharpened | shortened" }],
  "merged":    [{ "from": ["R3", "L2"], "rule": "…", "why": "…", "reason": "one class" }],
  "archived":  [{ "id": "R7", "reason": "duplicate | superseded | too-specific | wrong | budget", "note": "…" }]
}
```

- `kept` installs the rule unchanged, by id, in the given order.
- `rewritten` replaces one rule with one successor and says why.
- `merged` replaces two or more rules with one successor.
- `archived` takes a rule out with a named reason.

The instructions: keep the scope useful to a new agent of the role; merge
rules that state one class; rewrite a specific rule into its class when the
class is clear, keeping every condition it states; archive a rule a newer rule
contradicts as `superseded`, or one a later lesson shows `wrong`; when the
bound forces a choice, archive the most specific, least general rule first, as
`budget`; keep pinned rules, which only `kept` may name.

**The server's check.** The answer is accepted only when all of these hold:

1. Every input id appears exactly once across the four lists, and no unknown
   id appears. An id in two dispositions (`from` and `archived`, two `from`
   lists, `kept` and anything) is refused, so are an omitted id and a
   duplicate.
2. Every pinned id is in `kept`.
3. A `merged` entry names at least two ids; a `rewritten` entry names exactly
   one and carries a reason.
4. Every rule and reason is within its length, and the rendered text of the
   new active list (kept, then rewritten and merged successors, in the answer's
   order) is at most 10 000 characters.

Anything else refuses the run: the scope keeps its revision, the pending
lessons stay pending, and the history records the refusal with its reason.

**Committing against a moving scope.** Appends and operator edits do not wait
for a consolidation, which can take three minutes. When the answer arrives the
server reads the scope's latest revision M inside the same transaction that
would install it:

- M = N: install the answer as revision N+1.
- Every revision after N only appended lessons (agents' `leave_lesson`, or an
  operator's added rule): rebase. The answer is installed and the appended
  rules follow the consolidated list in their order, active when they fit and
  `pending` when they do not, so the next trigger consolidates them. The
  revision records `rebasedOver`.
- Any revision after N edited, archived, restored, pinned or unpinned a rule
  that was in the input, or another consolidation committed: the answer is
  discarded unapplied, the history records "superseded by revision M", and the
  scope consolidates again at its next trigger from M.

The check and the install are one `patchSync` over the revisions and the rule
records together (2.2), so a crash at any point leaves revision M as it was,
and no acknowledged append or edit can be lost to an answer computed before it.

**Nothing disappears silently.** Every rule leaving the active list is
`rewritten` or `merged`, with its successor and the change reason, or
`archived`, with its reason. The scope's page shows a rewrite and a merge with
the text before and after, side by side, and each is restorable in one action:
restoring puts the original back as active and archives its successor as
"replaced by your restore". A rewrite whose successor drops more than a third
of the original's length is marked "shortened" on the page for the operator to
check, since an id count cannot prove a rewrite kept every condition.
Consolidation never deletes a record, and no rule is dropped for disuse: the
MVP has no usage signal, and the operator's 2026-10-02 rule stands.

### 2.6 Injection at start (R5)

**When it is frozen.** `bindAttemptDefinition` (`engine.ts:2424`) gains one
field, `definition.memory`: the `(scope, revision)` pairs current at binding,
for the scopes this attempt may read, or `null` when the role is excluded or
the project's switch is off. Revisions are immutable, so a retried or restarted
attempt reads what its first launch read, and the stage card can name exactly
which revision a stage started with.

**The pipeline record holds a marker, never the text.** `renderStagePrompt`
places one line after the role scaffold, before the controller's lines
(publish_prototype_review, access, host access, branch contract, stage_report),
which keep their place as what every stage reads last:

```text
[[delegatus:learned-rules role:<project>:builder@14 project:<project>@5 machine@3]]
```

That line is what every persisted prompt carries: the activation re-render and
its comparison (`engine.ts:4666`), the deferred activation's `spawnInput`
(`engine.ts:5244-5288`), and the materialized prompt the composer's caller
persists before reserving a launch (`engine.ts:4679-4691`). All of them stay
byte-stable because the marker is a function of the frozen revision ids. No
pipeline record, attempt input or activation holds rule text.

**Where the text is materialized.** Only at the spawn port, the last step
before the host receives the launch (`spawnAgent`, `engine.ts:1287`). The port
expands the marker from the immutable revisions, so a replayed launch expands
to the same bytes. Expansion runs after `composeStageInput`, so nothing the
composer writes into the checkout (`.artifacts/pipeline-stage-inputs/private/`)
can hold rule text, including its last-resort file holding the whole prompt.
The size rule is the composer's own, applied once more:

- When the launch message with the block inline is within
  `MAX_STRUCTURED_TEXT_BYTES`, the block goes inline.
- Otherwise the block is written to the pipeline's artifact directory in the
  state directory, outside every checkout (`pipelineArtifactsDir`,
  `src/lib/pipelines/store.ts:1702`, which resolves under
  `statePath("pipelines")`), as `learned-rules-<sha256>.md`, mode 0600, named by
  the digest of its content so a replay reuses it. The message carries the
  composer's reference form ("Full learned rules file: …. Read the full file
  before working.") with the heading lines and no rule text.

The conversation's own records (its launch receipt and its transcript) hold
the expanded block, as they hold every stage prompt; they are local and are
named in 2.9.

**Format.** Each rule carries its id, so an agent can name a rule anywhere
without quoting it.

```text
Learned rules (Delegatus role memory)
Earlier agents left these after their stages. They are rules of thumb and can
be out of date: the brief, the pinned specification and the project's
instruction files win where they disagree. A rule that misled you is worth a
lesson at the end. These rules stay on this machine: never copy a rule or its
reason into commits, pull requests, issues, task text, board or bridge reports,
prototype reviews or your stage report; name it by its id instead.

Builder · this project · revision 14 · 6 820 / 10 000 characters
- [r_8c1e] When a change adds a branch for empty, missing or zero input, write the test for that branch in the same commit as the branch. Why: an untested empty-list path failed review.
- …

Every role · this project · revision 5 · 2 140 / 10 000 characters
- …

Every project · this machine · revision 3 · 1 380 / 10 000 characters
- …
```

An empty scope prints no heading. A stage on an excluded role, or in a project
whose switch is off, gets no marker and no block.

**Coexistence with shared and native memory.** For an eligible stage, shared
memory skips the launch brief and admits the operator's later messages, as
today, and the engine's native memory loads as today; they may repeat a fact,
and the block's header says which wins. For an excluded stage, 2.3 closes all
three.

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
  switch because it needs no OpenRouter key and costs nothing beyond the runs
  the operator's own accounts already make. Its one-line description states the
  data flow as it is: "Kept on this machine and never sent to a linked board.
  Stage agents read the rules through their engine, and consolidation sends a
  scope to Codex." Behind "Details" the page says which text goes where: the
  rules of the scopes a stage reads go to that stage's engine provider with its
  prompt (Anthropic for a Claude stage, OpenAI for a Codex stage), under the
  account the stage runs on; a consolidation sends one scope's rules, reasons
  and pending lessons to OpenAI under the account named on its history line.
- **Switching off with work in flight.** A queued consolidation of the
  project's role and project scopes is cancelled. A running one is let finish,
  since its text has already been sent, and its answer is discarded unapplied
  ("discarded: learned rules were switched off"). Stages already bound keep the
  revisions they froze; stages bound after the switch get none. The machine
  scope keeps consolidating while any project has the switch on; with every
  project off, nothing is sent anywhere.
- **The scopes**, one row each: Builder, Architect, Visual critic and any other
  role scope that has rules, "Every role" and "This machine", each with its
  size (6 820 / 10 000), its revision and how many rules joined today.
- **A scope's page**: its active rules in injection order, each with who left
  it (role and mode, stage, pipeline, time) behind one tap; pending lessons;
  `Rewritten (n)` and `Merged (n)` with the text before and after and the
  change reason, `Archived (n)` with reasons, each restorable; `History`, one
  line per revision ("+2 from fix · stage fix · 14:32", "consolidation: 1
  rewritten, 3 merged, 1 archived as too specific · gpt-6.1-sol · account B",
  "consolidation superseded by revision 15"); "Consolidate now".
- **Editing.** Edit a rule's text, archive a rule (reason "by you"), restore an
  archived, rewritten or merged rule, add a rule. An operator's rule is pinned:
  consolidation keeps it verbatim, and it counts toward the 10 000. "May be
  published" releases one rule from the egress check (2.9), for a rule the
  operator has copied into the instruction files by hand.
- **The stage card** (2.10).

The prototypes (section 4) show where these live.

### 2.9 Privacy

The repository is public, and so is anything a lane pushes. Rules hold what
agents learned on this machine.

**Where the text is stored.** In the role memory collections in the state
directory; in a learned-rules file under the pipeline's artifact directory in
the state directory when a block is too large to go inline (2.6); and in each
stage conversation's launch receipt and transcript, which hold every stage
prompt. All local, all outside every checkout. The pipeline record holds
markers and ids (2.6, 2.4). Lane rows are identifiers and counts by
construction (`laneFeed.ts:1-7`), and this design adds no field to them.

**Where the text is processed.** A stage's engine provider receives the rules of the scopes it reads with its
prompt, as it receives the rest of the prompt; consolidation sends one scope to
OpenAI through Codex (2.5). The Memory page states this flow (2.8). Nothing is
sent to a linked board, and nothing is synced between machines.

**The egress check.** Agents write free text to many places, and a rule that
contains nothing sensitive-looking (an abstract rule usually does not) passes
every class detector: the static detectors classify text, they do not know
which text is a private rule. Membership has to be checked against the rules
themselves, the way the publication gate already refuses known values from its
fingerprint file (`scripts/privacy-publication-gate.ts:961-990`).

- **One function.** `privateMemorySpans(text)` in `src/lib/memory/egress.ts`
  normalizes the text (NFKC, lower case, punctuation and whitespace folded) and
  looks for every rule and every reason in every state, archived ones
  included, except rules the operator marked "May be published". A rule or a
  reason counts as present when at least half of its five-word shingles occur
  in the text, or, under five words, when it occurs whole. It returns the
  rule ids and the spans.
- **The fingerprint file.** Processes outside the Viewer (the Git hooks and
  the `gh` shim agents run) cannot read the store, so the Viewer writes
  `statePath("role-memory/egress.json")`, mode 0600, on every revision: keyed
  HMAC-SHA-256 digests of the normalized shingles, under a per-installation key
  kept in the state directory. The file holds no rule text.
- **Where it is called.** Every path that writes agent text off the machine or
  into the repository:

| Path | Where | On a match |
| --- | --- | --- |
| Commits made by an agent | the `commit-msg` hook of the agent Git guard (`agentHistoryGuard.ts`) over the message, and its `pre-push` hook over the added lines of the pushed range | Refused, naming the rule id |
| Pushes and pull requests the engine makes | `publishPipelineBranch` (`git.ts:1372`) over the commits it publishes; the engine's `gh pr create` that finishes a workflow (`agentForgeCredentials.ts:280-290`) over title and body | Refused; the lane parks with the rule id on its first line |
| Pull requests and issues an agent opens with `gh` | the `gh` shim on the agent's PATH (the one `agentForgeWriteEnv` installs), extended to every memory-eligible launch: `pr create/edit`, `issue create/edit/comment` and `api` body fields | Refused, naming the rule id |
| A lane's pull request text written some other way | the read of the branch's pull request the pipeline already makes at publication and before landing | The lane parks for the operator; the merger refuses to land it |
| Task text and details | `create_task` and `update_task`, agent origin | Refused, naming the rule id |
| Linked-board task sync | `encodeTask` (`taskWire.ts:49-55`), for every task whatever wrote it, prototype review replica included | The span is replaced by `[learned rule kept local]`; the local task is unchanged and its card says one span stayed local |
| Bridge reports | `reportRender.ts:149-168`, beside `privateClasses` | The item is dropped and counted as "learned rule" |
| Prototype reviews | `publishPrototype` (`prototypeReview/store.ts:128`), agent origin, names and descriptions | Refused, naming the rule id |
| Issue reports | the scrub in `src/lib/issueReports/scrub.ts:67` | Refused, naming the rule id |
| Stage reports and stage output | when `stage_report` is recorded and when a final output is relayed | The span is replaced by `[learned rule r_8c1e]`; the relay and the pipeline record carry the id |

A refusal is a known-value match against the store, and it tells the agent
what to do: say the class in its own words, or name the
id. A paraphrase passes, which is the agent's judgment, as the stage-end prompt
and the block's header ask. The hooks and the shim are the cooperative guard
the Git guard already is ("not a sandbox against hostile shell code"): an
agent that disables hooks and pushes on its own can still publish a copy, and
the pull request read and the merger's refusal are the backstop for that.

**Detectors stay hints.** `leave_lesson` also runs the static detectors the
issue report uses (`staticSensitiveClasses`) over each lesson. A match never
refuses: the answer names the class and the span ("this looks like a home
directory path"), the agent judges and may call again with a rewritten lesson,
which replaces its earlier one, and the rule carries the hint so the Memory
page marks it for the operator, who decides last.

**Machine rules cross projects.** That is their purpose («на уровне вообще
машины»). The prompt asks for rules about tools and the environment there, and
the per-project switch keeps any project out entirely.

**Who can read the pages.** The routes serve the installation's operator under
the access rules the settings routes already use.

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

The line is a projection: the attempt holds the rule ids (2.4), and the card
reads their text from the role memory route when it draws. The text never
enters the pipeline record, the board snapshot sent to a linked board, or a
lane row.

The prototypes compare a line of its own with a count inside the report line.

## 3. The MVP and the slices after it

### 3.1 MVP — what gets built (simplified)

The operator asked for an MVP «без фантазий», and the design's own challenger
noted that the plan below had grown to three lanes. The orchestrator cut it on
2026-10-07 to one lane, and the operator chose the surfaces the same day
(prototype review round 2: variants 2, 3 and 5, with the comment «Треба, щоб не
було дуже багато тексту. І зайвої інформації.»). This is what the lane builds.

1. **Store.** One collection, `role_memory`, in `state.sqlite` through
   `SqliteStateCollection` (`src/lib/roleMemory/store.ts`): rule rows, one row
   per scope with its active list, revision and history, one row per stage
   attempt that was asked for a lesson, and one row per project switch. Scopes
   are `role:<project>:<roleId>`, `project:<project>` and `machine`, with the
   canonical project key. Each scope renders to at most 10 000 code points.
   Rule rows are never deleted. Nothing is written into a repository, a pull
   request, an issue, a linked board or a bridge or relay payload.
2. **Write path.** `stage_report`'s answer gains `lessonRequest` (the prompt of
   2.4, shortened, as lines) on the first accepted report of an eligible
   attempt in a project whose switch is on; a fix round's request names the
   findings it was handed. The new MCP tool `leave_lesson` takes one to three
   lessons (`scope` role, project or machine, an optional `role` with scope
   role, `rule` of 20–300 characters, `why` of at most 160) or `none` with one
   line. The server resolves the calling conversation to its attempt and takes
   every piece of provenance from the pipeline record. The static privacy
   detectors run over each lesson as hints: a match marks the rule ("check the
   text") and never refuses it. Instead of a sentence in the stage wrapper, the
   injected block itself tells the agent that the request will come, so
   `renderStagePrompt` and its byte-stable re-render are untouched.
3. **Who stays clean.** `learnedMemoryExcluded` (`src/lib/roleMemory/policy.ts`):
   role reviewer, verifier or issue-reporter, or any stage the engine
   classifies as a review gate (`isReviewGate`, now exported from
   `src/lib/roles/sizing.ts` and read by both the engine and role memory: a
   review-loop stage, or a stage with a fail edge), whatever role it names.
   Such a stage gets no block and no request, `leave_lesson` refuses it, and no
   lesson may be addressed to a clean role. The visual critic is not excluded
   by role (2.3): it reads and writes its rules when it runs as an ordinary
   stage, and like any role it stays clean when its stage carries a fail edge.
4. **Consolidation, without a model.** On every append, in the same
   transaction: a lesson that restates an active rule of its scope (nearly the
   same words, or one inside the other) merges with it and the fuller text
   survives; then, while the scope is over 10 000 characters, its oldest rule
   is archived with the reason "budget". A merged or archived rule keeps its
   record, its state, its reason and its successor, and the rules window shows
   it under "Left the rules". Nothing is dropped for disuse.
5. **Injection.** The engine reads the block once per activation in
   `spawnRunStage` (`learnedRulesForLaunch`) and hands it to the spawn port as
   `learnedRules`, a field that is neither persisted on the attempt nor part of
   the request digest. The production port expands it into the prompt only at
   dispatch (`withLearnedRules` in `spawnPipelineAgent`), below the brief and
   the role scaffold and above the controller's lines, labelled "Learned rules
   (Delegatus role memory)" with every rule's id. A block that would push the
   message past the 32 000-byte envelope is written to
   `statePath("role-memory/launch/learned-rules-<sha256>.md")`, mode 0600, and
   the message points at it. No pipeline record, attempt input or composer
   artifact in the checkout holds rule text.
6. **Controls.** The Memory page (header menu → Settings → Memory) gains the
   switch "Learned rules for this project" and one row, "Learned rules · n
   rules · +k today", whose Open button shows the rules window (variant 2):
   scopes on the left, the scope's rules as coloured blocks in the middle with
   their size against 10 000, and what left the rules on the right; on the
   phone a full-screen sheet with the scopes as chips. Under a stage report on
   the card, one coloured line (variant 3): "Left 2 rules → Builder, Visual
   critic" with the first rule, which opens the window on that rule, or a quiet
   "No rule left" once the turn ended without one; a clean stage draws
   nothing. The switch is on by default for this repository and off for every
   other project. Switching it off stops both the request and the injection;
   stored rules stay.
7. **Privacy for the MVP** is the abstract-rule instruction in the request and
   in the block, the detector hints, and the existing publication privacy
   gate on everything published.

Tests on isolated state: the bound in code points, merge and archive with the
dropped rule visible, the lane path through the real engine (a review's finding
makes the fixer's request name it, the fixer's rule reaches a fresh builder's
launch and no persisted pipeline record, reviewers get nothing, the switch
stops both), `leave_lesson` and `lessonRequest` through the MCP service, and the
oversized block as a file outside the checkout. Rendered evidence goes through
the existing phone driver (`issue1671Evidence.browser.test.tsx`) over the
kanban fixture, desktop and 390 px, English and Ukrainian.

**Later.** Each of these is in sections 2.2–2.9 above and waits for a slice of
its own:

- The egress system of 2.9: `privateMemorySpans` and its known-value matching
  over every rule and reason, the HMAC fingerprint file for processes outside
  the Viewer, the `commit-msg` and `pre-push` checks in the agent Git guard,
  the `gh` shim extended to `pr`, `issue` and `api` bodies, the scans of staged
  blobs and pushed ranges, the checks on task text, linked-board sync, bridge
  reports, prototype reviews and issue reports, and the replacement of a quoted
  rule by its id in stage reports and relays.
- Consolidation by a model (2.5): the headless Codex turn, the partition
  contract and its server check, the frozen input and the commit against a
  moving scope, rewrites with before and after.
- Closing shared memory and the engines' native memory for clean stages (2.3):
  the `UserPromptSubmit` controller on every turn, Claude's
  `autoMemoryEnabled` and Codex's `--disable memories` at launch, and the
  native probes.
- Revisions frozen at binding and the marker in the stage prompt (2.6): the
  MVP reads the current rules at each activation.
- Operator editing: add, edit, pin, archive and restore a rule, "May be
  published" and "Consolidate now".
- The test aid `scripts/role-memory.ts` (`show`, `fill`, `probe`, `scan`).

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
- **A second model that checks a rewrite kept the meaning.** The partition
  check proves every rule is accounted for; whether a rewrite kept every
  condition it cannot tell. The before-and-after view, the "shortened" mark and one-action
  restore leave that judgment to the operator; a checking model would double
  the cost of every consolidation for a risk the history already exposes.
- **A sandbox that stops an agent bypassing the egress hooks.** The Git guard
  and the `gh` shim are cooperative, as the guard is today; the pull request
  read and the merger's refusal catch what bypasses them. A hostile-agent
  sandbox is a separate problem from role memory.
- **Running consolidation on a local model.** It would keep a scope's text off
  the provider, but this machine runs no local model and the stage prompts
  carrying the same rules go to the providers anyway.
- **Asking for lessons up front in the stage prompt or as a `stage_report`
  field.** The quote places the question after completion, and a field would
  have the agent write its lesson before its verdict is fixed.

## 4. Prototypes (D2)

Published to this task's prototype review, five numbered variants, rendered
through the kanban evidence fixture (`issue1695BrowserHarness`) with the
product's own components and stylesheet, desktop 1440 px and phone 390 px,
English and Ukrainian: 44 frames, re-rendered after the design review (round
2). The prototype components lived in a scratch export of `5a197eeb5` and were
never added to the repository. Frames:
`~/Pictures/delegatus-review/role-memory/`. Measurements:
`evidence/role-memory/frames.json`.

| # | Name | What it shows |
| --- | --- | --- |
| 1 | Pages in the menu | (a) The Memory page gains the switch, whose line states the data flow (2.8), and the scope rows; a scope opens as a deeper page in the same menu or sheet, with rules, history, rewritten, merged and archived. No new window. |
| 2 | Rules window | (a) The same switch and one row, "Learned rules", opening a wide window: scopes on the left, rules in the middle, history, rewritten rules with their text before and after, and the archive on the right; on the phone a full-screen sheet with a scope picker. |
| 3 | Rule line under the report | (b) A line of its own under the stage report: "Left 2 rules → Builder, Visual critic" and the first rule; "No rule left" when none. |
| 4 | Count in the report line | (b) "2 rules" as a count inside the report line, expanding into the rules on a tap; nothing extra when collapsed. |
| 5 | The prompt as the agent sees it | (c) The stage conversation: the "Learned rules" block with rule ids in the first message, then `stage_report`, the lesson request in its answer, and the `leave_lesson` call with the example answer of 2.4. |

What the frames showed:

- Variant 1 adds no window. On the phone the scope page reads comfortably in
  the menu sheet. On the desktop the rail menu is 232 px wide, so four rules
  fill the panel to the bottom of a 900 px screen; a full scope of about thirty
  rules means a long scroll inside the menu. A Ukrainian role name
  ("Критик вигляду") clipped beside the "+1 today" mark in the first render;
  the mark moved onto the size bar's line and the name now reads in full.
- Variant 2 shows a whole scope with its history, rewrites and archive at once
  on the desktop; a rewrite marked "shortened" stands out in the right column.
  Its "Restore" buttons, under 16 px tall in the first round, are 24 px now.
- The data-flow line under the switch takes six lines in Ukrainian at 232 px,
  and the desktop menu then reaches about 790 px of a 900 px screen.
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

For the MVP as built (3.1): steps 1–5, 7 and 10 apply, read on the Memory
page's rules window and on the card instead of `scripts/role-memory.ts`, and
step 1 adds no rule by hand, since editing waits for a later slice. Of step 6
only the recheck's first message applies; closing shared and native memory
waits. Steps 8 and 9 test the deferred egress system and model consolidation
and wait for them; the MVP's bound is exercised by its tests.

About fifty minutes and at most an hour, on a local repository with no
remote, so nothing reaches GitHub. A pipeline with the default `publication: "internal"` never pushes or
reads a remote while it runs (`create_pipeline`, `src/lib/mcp/server.ts:3695`).
The first stage is a review of a seeded defect, so the lane reaches its fix
round whatever a builder would have written. Every wait has a bound and a
fallback; a fallback that fails is a defect to report, with the printed
reason.

**1. Prepare (5 min).** Create the trial repository, copy and paste:

```sh
mkdir -p ~/Projects/role-memory-trial/src && cd ~/Projects/role-memory-trial
git init -q -b main
printf '{ "name": "role-memory-trial", "private": true, "type": "module" }\n' > package.json
cat > src/size.ts <<'EOF'
const UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/** "10MB" -> 10485760. */
export function parseSize(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i.exec(text.trim());
  if (!match) throw new Error(`invalid size: ${text}`);
  return Math.round(Number(match[1]) * UNITS[match[2]!.toUpperCase()]!);
}
EOF
cat > src/size.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { parseSize } from "./size";

test("parses megabytes", () => { expect(parseSize("10MB")).toBe(10485760); });
EOF
git add -A && git commit -qm "parseSize" && git rev-parse HEAD
```

The seeded defect: the specification below asks for `null` on empty input,
and `parseSize("")` throws. Open the project in Delegatus. Header menu →
Settings → Memory: switch **Learned rules for this project** on, and read the
switch's line: it says the rules stay on this machine and go to the stage
engines and to Codex for consolidation. Open "Every role" and add one rule by
hand, the canary for step 8:

> Name every input class a change handles in its stage report. ROLEMEM-CANARY-7Q2

Then, from the Delegatus checkout:

```sh
bun scripts/role-memory.ts show --repo ~/Projects/role-memory-trial
```

It prints "Every role" at revision 1 (your rule) and the builder scope empty.
Note each scope's revision; later steps compare against these numbers, never
against an assumed 1.

**2. Start the lane (2 min).** Ask the seat to create exactly this pipeline,
with the SHA from step 1 as `baseRef`:

```json
{
  "task": "Role memory trial: parseSize empty input",
  "repoDir": "<home>/Projects/role-memory-trial",
  "baseBranch": "main",
  "baseRef": "<sha from step 1>",
  "publication": "internal",
  "spec": "parseSize returns null for an empty or whitespace-only string without throwing, and that branch has its own test. bun test passes.",
  "stages": [
    { "id": "review", "kind": "run", "role": { "roleId": "reviewer" }, "access": "read-only",
      "prompt": "Review src/size.ts at HEAD against the specification. Run bun test, and run bun -e 'import { parseSize } from \"./src/size.ts\"; console.log(parseSize(\"\"))'. Fail with one finding per criterion that does not hold.",
      "next": null, "onFail": { "to": "fix", "maxRounds": 1 } },
    { "id": "fix", "kind": "run", "role": { "roleId": "builder", "params": { "mode": "apply-fixes" } }, "access": "read-write",
      "prompt": "Fix the findings below, commit, and report.\n\n{{prev.output}}",
      "next": "recheck" },
    { "id": "recheck", "kind": "run", "role": { "roleId": "reviewer" }, "access": "read-only",
      "prompt": "Review src/size.ts at HEAD against the specification. Run bun test, and run bun -e 'import { parseSize } from \"./src/size.ts\"; console.log(parseSize(\"\"))'. Fail with one finding per criterion that does not hold.",
      "next": null }
  ]
}
```

**3. The review finds the defect (5–10 min).** `review` fails: `parseSize("")`
throws and has no test. Its stage shows no lesson line, and its first message
holds no "Learned rules" block and no learned-rules marker. Bound: if it has
not reported in 15 minutes, open its conversation; a stage that passes the
seeded defect is a reviewer defect to report, and the plan stops here.

**4. The fixer leaves a rule (5–10 min).** `fix` runs with the finding handed
to it. Its first message holds the block, with your canary rule under "Every
role · this project". When it ends, the card shows "Left 1 rule → Builder" (or
more) with the rule. Open its conversation: the `stage_report` answer carries
the lesson request, with "This attempt was handed 1 finding…", and the next
call is `leave_lesson`. Fallback: if the agent answered with `none`, the card
reads "No rule left" and the conversation shows its reason; add a builder rule
by hand on the Builder page and continue, noting that the stage left none.

**5. The rule is stored, with its history (2 min).**

```sh
bun scripts/role-memory.ts show --repo ~/Projects/role-memory-trial --scope builder
```

The builder scope is one revision past the number from step 1, authored
"agent · fix · attempt 1". The Builder page on the Memory page shows the same
rule, and its History the same line.

**6. The recheck stays clean (5 min).** `recheck` passes. Its first message
holds no block, and if the fixer's summary quoted a rule, the relay reads
`[learned rule r_…]` instead. Clean on follow-ups too: switch shared memory on
for the trial project (Memory page, first switch; it costs OpenRouter credit),
type into the `recheck` conversation "how should I name inputs in a stage
report?", and the Memory page's last-turn line reads "skipped: reviewer". Then:

```sh
bun scripts/role-memory.ts show --stage <pipeline id>:recheck
```

prints `excluded: reviewer · block: none · shared memory: skipped · native
memory: off`, with the setting the launch used (`--disable memories` for Codex,
`autoMemoryEnabled: false` for Claude). Switch shared memory off again.

**7. A fresh builder starts with it (10 min).** A second lane on the same
repository, one builder stage: task "Add parseRate('5/s'), returning null for
empty input", `baseRef` the SHA from step 1. Its
first message lists the step 4 rule under "Builder · this project · revision
<the step 5 number>". Bound: once its first message is visible the step is
done; the stage may keep working.

**8. Nothing private leaves (3 min).**

```sh
grep -rIl ROLEMEM-CANARY-7Q2 ~/Projects/role-memory-trial; echo "checkout: $?"
bun scripts/role-memory.ts scan --canary ROLEMEM-CANARY-7Q2
bun scripts/role-memory.ts probe --repo ~/Projects/role-memory-trial --rule <the canary rule's id>
```

`grep` finds nothing, ignored `.artifacts` included, and exits 1. `scan`
prints zero for pipeline records, the linked-board outbox and bridge reports.
`probe` prints, for the canary rule, "refused" for commit message, pushed
lines, `gh pr create`, task update, prototype review and issue report, and
"replaced" for the linked-board row, the bridge report and the stage report.
Live, ask the seat to put the canary rule's sentence into the trial task's
details: the update is refused and names the rule id.

**9. Consolidation keeps the bound (8 min).**

```sh
bun scripts/role-memory.ts fill --repo ~/Projects/role-memory-trial --scope builder
```

It adds forty synthetic lessons as pending in one revision and runs one
consolidation. While it waits, add one more builder rule by hand on the Memory
page. Expected within six minutes: "installed", the builder scope at most
10 000 characters, the dispositions adding up to the input count, and your
hand-added rule active after the consolidated list with "rebased over 1" on
the history line. The Builder page lists Rewritten, Merged and Archived with
before and after and reasons; restore one rewritten rule and see its successor
archived as "replaced by your restore". Fallback: on "refused" or a timeout,
run it once more with `--retry`; a second failure is a defect to report, and
the scope must still read its earlier revision. Finish with `fill --archive`.

**10. The switch (3 min).** Press "Consolidate now" on the Builder page and,
while it runs, turn **Learned rules for this project** off. The history shows
"discarded: learned rules were switched off". Start a one-stage builder lane:
its first message has no block, its `stage_report` answer has no lesson
request, and the Builder page still shows its rules. Turn it back on.

## 6. Changes after the design review

An independent review of the first revision raised seven blocking findings.
Each changed the design as follows.

| Finding | Change |
| --- | --- |
| Reviewer exclusion covered only the new block | One predicate closes the block, shared memory on every turn, both engines' native memory at launch and quoted rules in relays, with a probe per engine (2.3). |
| Rule text could reach checkout files and persisted pipeline prompts | The pipeline record holds a marker with revision ids; the text is expanded only at the spawn port, after the composer, inline or in a file under the state directory (2.6). |
| Free-text writers had no private-memory check | A known-value check against the store, with a fingerprint file for hooks and shims, called by every writer in the 2.9 table; the card line is a projection by id (2.9, 2.10). |
| Consolidation had no fence against concurrent writes | Frozen input revision; the install rebases over appends only, discards over any other change, and commits rules and revision in one transaction (2.2, 2.5). |
| A one-source rewrite left no disposition | The answer is a total partition into kept, rewritten, merged and archived; rewrites show before and after and are restorable (2.5). |
| The switch claimed nothing leaves the machine | The switch line, its details, 2.5 and 2.9 state which text goes to which provider under which account; switching off cancels queued runs and discards a running one (2.8). |
| The hour-long trial relied on a builder's accidental omission | The lane opens on a review of a seeded defect, with the exact pipeline, revision numbers read from a command, bounded waits with fallbacks, and canary checks for every egress path (5). |

## Validation against the requirement

| Quote | Where answered |
| --- | --- |
| «какое-то количество ролей … swarm builders … swarm of critiques … архитекторы» | Scopes per role in a project (2.2), roles that read and write (2.3). |
| «ревьюер всегда чистый … чтобы они были новые» | Reviewer, verifier and issue reporter receive and write nothing, through any automatic path (2.3). |
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
| 2026-10-02: «Может быть, они потом понадобятся» | Nothing is deleted; rewritten, merged and archived rules stay visible with their before and after text and are restorable (2.5). |
| «ревьюер всегда чистый», on every automatic path | One exclusion policy over the block, shared memory on every turn, native memory at launch and relayed output (2.3). |

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
5. **Which provider consolidates?** Consolidation sends one scope's rules to
   the engine that runs it. Recommendation: Codex, as designed (2.5), since the
   same rules already reach Codex stages in their prompts; the alternative is a
   one-turn Claude run under a Claude account, at the same contract.
