# Voice reads the orchestrator's messages and actions

Status: implemented, 2026-10-15. Design base: `main` at `011a4fe97`. Code anchors below are
`file:line` on that commit.

## Originating requirement

**The operator, speaking in the voice call, 2026-10-15 ~12:52Z** (Russian, from the
call's transcript record; one expletive left out as […]):

> «Окей, тогда открой другой проект делегатус. Там нужно передать ему, что это баг
> голосового помощника, который нужно исправлять. Он заключается в том, что ты не можешь,
> […], нормально прочитать сообщение делегатуса, у этого оркестратора. У тебя должна быть
> возможность, во-первых, ты запутался между тем длинным названием и коротким названием
> проекта, ты должен только иметь, оперировать только тем, что теми же названиями, которые я
> вижу. И, соответственно, ты должен иметь возможность выгрузить последние сообщения
> оркестратора быстро, текстом, чтобы он тебе выдал, и ты увидел это. Также, чтобы отдельно
> можно было, ты мог увидеть, какие действия он делал. Вот, чтобы это как бы немножко, ну,
> типа чтение сообщений. Вот, чтобы ты мог смотреть чтение сообщения в просто в текущем
> проекте, в котором сейчас у меня открыт. Также, чтобы ты мог обращаться к списку к другим
> проектам, чтоб тоже мог смотреть»

**The same request as the voice gateway wrote it to the orchestrator**, 2026-10-15
~12:55Z:

> «Исправить баг голосового помощника: обеспечить возможность быстро получать и
> показывать пользователю текст последних сообщений оркестратора, отдельно просматривать
> выполненные оркестратором действия, а также читать сообщения оркестратора в текущем
> открытом проекте и выбирать другие проекты из списка для просмотра их сообщений.
> Ожидаемый результат — голосовой помощник корректно показывает эти сообщения и действия с
> использованием понятных пользователю названий проектов.»

**The earlier report on the same card**, voice directive of 2026-10-12 ~06:36Z:

> «я несколько раз пытался дочитать его ответ и упирался в ограничение на число шагов, не
> смог получить нужное сообщение.»

### What it asks, item by item

| The operator's words | Outcome item | What this design builds |
| --- | --- | --- |
| «выгрузить последние сообщения оркестратора быстро, текстом, чтобы он тебе выдал, и ты увидел это»; «дочитать его ответ» | 1 | `orchestrator_messages` returns the latest messages whole in one call; a long one continues in a second; any message can be read again by its handle or time, and read aloud whole. |
| «отдельно … ты мог увидеть, какие действия он делал» | 2 | New `orchestrator_actions`: what the orchestrator did through Delegatus, as short plain lines with their outcome, apart from its prose. |
| «в текущем проекте, в котором сейчас у меня открыт» | 3 | Already the default (traced below); a name that equals the project in view now selects it. |
| «обращаться к списку к другим проектам»; «оперировать только … теми же названиями, которые я вижу» | 3 | `list_projects` lists projects with an orchestrator by the names the operator sees, never a `repo-<hash>` key; names resolve to the project with an orchestrator. |
| «показывать пользователю», «корректно показывает» (gateway wording) | 4 | Existing surfaces only: the whole read stays in the companion's conversation panel, and a message read aloud also appears as the card reports already use. |
| (performance rules) | 5 | Every read has a byte budget, a 2 MiB scan cap and no whole-transcript scan. |

**"Show" reads two ways, and the operator's own words settle it.** The gateway wrote
«показывать пользователю» (show the user). The operator said «чтобы он тебе выдал, и ты
увидел это» (so that it hands it to you and *you* see it). The pinned specification
also says to reuse existing surfaces and add no new chrome unless the design proves
one is needed. Read together, the voice must get the whole text, and whatever it reads
or reads aloud must be visible on a surface that already exists. On the desktop that
is the conversation panel and the lane's card. On the phone it is the head's bubble,
which shows the words as they are spoken. Nothing in the request asks to read a long
message silently on the phone, so a phone panel stays under "Deferred" (the phone head
design already deferred it, `docs/design/phone-voice-head-build.md:391`).

## What happens on `main` today

### The reads that touch orchestrator messages, reports and projects

| Read | Where | What it does now |
| --- | --- | --- |
| `orchestrator_messages` | tools.ts:79 (description), readSchemas.ts:21,36 (schema), boardReads.ts:72-75 (defaults), :132-135, :140-142, :178 | Resolves the seat with `orchestratorSeatFor(project).active.conversationId` (readPaths.ts:84) and reads it through MCP `conversation_messages` with `kinds:["message"], maxChars:320` forced. Projection: `excerpt: short(text, 320)`, a **320-byte** cut (boardReads.ts:36-40), about 160 Cyrillic characters. Parameters: `roles`, `since`, `cursor`, `limit` 1–10, and nothing that reads the rest of a message. The page answer is capped at 4,000 bytes (boardReads.ts:47-59). |
| `conversation_messages` | readSchemas.ts:35, tools.ts:78, boardReads.ts:178 | The same projection for any conversation handle (for example a `search_transcripts` hit on the orchestrator's transcript). |
| `orchestrator_reports` | tools.ts:101-108 → admission.ts:351 | The reports filed during this call, whole, at most 5 within about 12,000 characters. |
| `reread_orchestrator_report` | tools.ts:109-116 → admission.ts:648 → liveSession.ts:692 | Reads a report of this call aloud again from its own text, in appends of at most 500 bytes (`speechParts`, reportSpeech.ts:47-60; `SPOKEN_LIMIT_BYTES`, liveSession.ts:110). |
| `get_orchestrator` | boardReads.ts:145-148 | Whether a project has a designated seat and its engine. |
| `list_projects` | tools.ts:70, readSchemas.ts:24, boardReads.ts:84-88, readPaths.ts:70-83 | Every known project with `{project: key, displayName, liveSeat, openTaskCount}`. No size budget. |
| `request_orchestrator_delegation` | tools.ts:117-150 (`resolveProject` at :128) | Sends; uses the same project resolution. |
| Project resolution | readPaths.ts:85-102 → nameResolution.ts:147-187 | Null means the project in view (readPaths.ts:96). A name goes through `resolveNamedProject`, which treats a key that spells the name as an identity (:157) and refuses as ambiguous when another project carries that name (:161). |
| Refusal speech | liveSession.ts:609 | `Several projects match: <name> (<key>), …`: the key is handed to the voice. |
| Project directory | liveSession.ts:235, :247, :471 | All known projects, keys included, go into the Live instructions and into every backend turn. |

### How the project in view reaches the voice (item 3: already there)

`VoiceCompanionHost.tsx:83` calls `adapter.setProject(project)` whenever the screen on
top changes, on the desktop and the phone alike. `liveAdapter.ts:259` posts it, and
`liveSession.ts:648` (`context()`) stores `currentProject` and tells Live. Each
delegation freezes it (`liveSession.ts:462`) and passes it as `context.project`, and
`resolveProject(current, null)` returns it (readPaths.ts:96). The backend sees it as
"Project currently in view: <label>" (liveSession.ts:471). The Codex path freezes the
same field per turn.

### What the operator sees of a read (item 4)

- Every tool call is a transcript entry. Its result is kept **cut at 8,000 characters**
  (liveSession.ts:598), and the desktop conversation panel shows it as one line that
  opens to its arguments and result (`CompanionTranscript.tsx:143-162`). The desktop lane
  shows the call with the first 240 characters of its `speech` (liveSession.ts:600).
- Orchestrator reports become `orchestrator.report` events (contract.ts:127,
  reducer.ts:433). They show as a card with the whole text and a copy button in the lane
  (`VoiceCompanion.tsx:1175-1179`) and in the panel (`CompanionTranscript.tsx:83, 212-224`),
  and they are read aloud whole (liveSession.ts:692-711).
- The phone shows only the companion's words while they are spoken, two lines at a time
  (`PhoneVoiceCompanion.tsx:436-440`). It has no panel and no cards.

### The step limit

A delegation on the API path gets `BACKEND_ROUNDS = 4` tool rounds (usage.ts:14,
liveSession.ts:475), then one answer with tools off. The backend answer is spoken in at
most 500 bytes (liveSession.ts:110, 117-131).

## Evidence

**1. The 2026-10-12 failure, reproduced on `main`.** A probe test (run in a scratch
export of `011a4fe97`, isolated state) wrote a Claude seat transcript in the reported
shape. The operator's 3,890-byte reply is the second assistant message on page one, a
short note of the same turn is newer, and an older turn is below. `orchestrator_messages`
with every argument null answered 4 rows with excerpts of 58, **320**, 26 and **320**
bytes in 1,699 bytes total. The schema's only parameters were `project, roles, since,
cursor, limit, refresh`, so nothing could read the remaining 3,570 bytes, and the cursor
only pages to older messages. The orchestrator diagnosed the same thing that day (its
reply of 2026-10-12 06:37Z): «жёстко обрезает каждое сообщение до 320 символов …
Курсор листает к более старым сообщениям».

**2. The call that produced this directive (2026-10-15, API path).** The project in view
was a project with an orchestrator. In this document it is "project A".

- The backend's first read passed project A's *label* as `project`, where null names
  the project in view. The directory holds two keys with that label: the seated `repo-<hash>` key (18 open
  tasks) and a legacy name key with no orchestrator and no open task. The read was
  refused as ambiguous, and the refusal speech carried the key. The voice then asked:
  "which one, `<name>` or `repo-<hash>`?" The operator answered: «Не надо мне читать это
  название огромное, это его техническое название».
- `list_projects` returned 14 projects. Four names appeared twice, each time as a seated
  `repo-<hash>` key plus a legacy key with no orchestrator and 0 open tasks.
- To find the orchestrator's comment, the backend used `search_transcripts`, then
  `conversation_messages` for 3 pages, and later `orchestrator_messages` for 3 cursor
  pages, twice. The voice ended with "the excerpt breaks off in the middle of the
  explanation".

**3. A call on 2026-10-14.** To check whether the orchestrator had started on a request,
the backend made 8 `orchestrator_messages` calls with `roles: [user, assistant]`: two
runs of 4 cursor pages, each ending at the step limit. That question is about the
orchestrator's *actions*.

**4. What the orchestrator writes and does** (read-only scans of two Delegatus seat
transcripts on this machine, 3.9 MB and 8.3 MB):

| | seat A (13 turns) | seat B (110 turns) |
| --- | --- | --- |
| Last message of a turn, median / p90 / max | 1,309 / 2,030 / 2,372 B | 1,363 / 2,624 / 4,164 B |
| Turns answering a voice request, median / max | 2,030 / 2,030 B | 3,017 / 4,164 B |
| Largest single assistant text record | 2,648 B | 4,970 B (not the last of its turn) |
| Tool calls / Delegatus write calls | 139 / 54 | 413 / 241 |
| Write calls per turn, median / max | 3 / 14 | 2 / 16 |

The substantive text is not always the turn's last message. In the 2026-10-12 case the
3 KB answer was followed by «Варианты ответа под сообщением.» in the same turn, and seat
B's largest record is mid-turn. So the read returns every assistant message, each with
its turn's label. All 154 shell calls in three seat transcripts were reads. None merged, pushed or
deployed: the orchestrator's merges and deploys go through `pipeline_action`
(`retry-merge` 5×) and `deploy_exact_sha`.

**5. Cost of a bounded read** (the real `readMessagesPage` on copies of the two
transcripts, 7 runs each, measured during this stage with 5 Delegatus workers running):

| Page | Bytes scanned (A / B) | Median ms (A / B) | Max ms (A / B) |
| --- | --- | --- | --- |
| 40 message records, user + assistant, `maxChars` 16,000 | 1.3 MB / 2.1 MB | 9.5 / 5.9 | 13.4 / 8.2 |
| 120 tool records (calls + results) | 1.3 MB / 2.1 MB | 16.5 / 9.1 | 17.8 / 14.4 |

40 message records covered 11 turns in seat A and 21 in seat B.

**6. The Codex backend cuts tool outputs at 10,000 tokens.** Codex's model cache on
this machine (codex-cli 0.162.1) gives `gpt-6-luna` a `truncation_policy` of
`{mode: tokens, limit: 10000}`. A 16,000-byte answer stays below that even at one token
per character.

**Searched before deciding:** the 2026-10-12 relay from another orchestrator and the
seat's diagnosis (quoted above), `docs/design/voice-tools-and-spend.md:176-212` (the
4,000-byte page cap was a projection choice: about 300 bytes a row × 10 rows; no operator
decision set it), and the cross-project read design discussed on 2026-10-11/12
(`list_projects` and reads of other projects' orchestrators). Neither memory store had
anything relevant.

## Design

### 1. `orchestrator_messages`: the latest messages, whole

**What counts as a message.** An assistant `message` record of the project's current
orchestrator transcript: Claude `text` blocks, Codex `agentMessage` of either phase.
The prompts it was sent (seat ticks, relays, worker notices, voice requests, forms,
typed chat) are user records and are never rows. Each row gets an `after` label taken
from the user record that opened its turn, so the backend can tell a reply to its own
request from a bulletin after a scheduled wake:

| `after` | Opening record | Written by |
| --- | --- | --- |
| `wake` | starts `Seat tick — ` | `src/lib/monitor/report.ts:273, 398` |
| `voice` | carries `[Voice Delegatus wrote this request` (or the 2026-10-12 `[Voice Delegatus reply:`) | `src/lib/voiceCompanion/admission.ts:58` |
| `form` | starts `Prototype review decision`, `Operator decision` or `Seat decision` | `src/lib/prototypeReview/decision.ts:34-35` |
| `relay` | parses as a relay | `src/lib/orchestrator/relayText.ts:8-11` |
| `agent` | starts `Agent finished: ` | `src/lib/spawnNotice/sweep.ts:138` |
| `other` | anything else, mostly the operator typing | — |

These labels are hints for the backend. They grant nothing, and nothing is refused on
them. No authorship join runs (below).

**Parameters** (strict schema: every property present, nullable):

| Parameter | Type | Meaning |
| --- | --- | --- |
| `project` | name or `p…` handle, ≤200, null | null = the project in view |
| `message` | `m…` handle, ≤40, null | read this one message |
| `offset` | integer 0–1,000,000, null | with `message`: byte offset to continue from |
| `at` | ISO time, ≤40, null | read the message written at or before this time |
| `before` | `m…` handle, ≤40, null | messages **older** than this one |
| `limit` | integer 1–12, null (default 6) | rows on a latest/older page |
| `refresh` | as today | |

`roles`, `since` and `cursor` are removed. `before` replaces the opaque cursor and says
in its own name which way it goes.

**Handles** are `m<seq base36>.<part>.<6 hex>`. `seq` is the record's byte offset in the
transcript (messagesPage.ts:407, the `seq` MCP already returns), `part` its index in the
line, and the hex the first 6 of `sha256(transcriptPath)`. A transcript is append-only,
so new records never move a handle. A handle whose fingerprint is not the current seat
transcript's (the seat rotated) is refused as `stale_handle` and nothing is read. No map
or session state is kept. A position that does not start a record parses as nothing and
answers `not_found`.

**Read path.** `readPaths` resolves the seat's conversation (`orchestratorSeatFor`), maps
it to its transcript with `selectedConversationTarget` (mcp/selectedContextTarget.ts:359),
opens it with `openPinnedTranscript` (mcp/bindings.ts:2689) and calls
`readMessagesPage` (session/messagesPage.ts:353) **directly**, with the voice's
credential redactor as `redactText`. It does not go through MCP `conversationMessages`.
That path joins authors whenever a user record is on the page (bindings.ts:3390-3397):
`readMessageAuthorContext` can read up to 16 MiB of user records, and the agent-author
join loads the registry snapshot. Neither is needed here.

- **Latest page** (`message`, `at` and `before` null): one page of at most 24 message
  records, roles user and assistant, `maxChars` 16,000, scan capped at **2 MiB** (new
  optional `maxScanBytes` on `MessagesPageQuery`, default unchanged at 16 MiB). The
  assistant rows are kept newest first while their text totals at most **12,000 bytes**
  and their count is at most `limit`. The row that crosses the budget is cut at a line
  end (a lone row larger than the budget is cut too) and carries
  `rest: {message, offset}`. The answer's `before` is the oldest returned handle;
  `more: true` when the page or the budget left messages out.
- **Older page** (`before`): the same, from the cursor `{o: seq, p: part, r: []}`: the
  reader's own cursor shape (messagesPage.ts:27-31), built internally, which reads the
  earlier parts of that line and then older lines.
- **One message** (`message`, optional `offset`): a page of limit 1, roles assistant,
  from `{o: seq, p: part + 1}`. Records carry their part index non-enumerably (as
  `sourceId` does), and the answer is accepted only when its `seq` and part match the
  handle; anything else is `not_found`. The answer is the record's text from `offset`
  (moved back to a UTF-8 boundary), up to 12,000 bytes cut at a line end, with `next` (an
  offset or null) and `bytes` (the whole length).
- **By time** (`at`): pages of 20 assistant records from the newest until a record has
  `ts ≤ at`, with the same 2 MiB total scan. Otherwise `not_found`, with the answer
  saying the message is older than the voice reads.

**Answer shape** (asserted ≤ 16,000 bytes of JSON):

```text
latest/older: { speech, shown, more, before: "m…"|null, truncated,
                rows: [{ handle, time, after, bytes, text, rest?: { message, offset } }] }
one message:  { speech, item: { handle, time, after, bytes, offset, text, next } }
```

Text passes the same cleaning as today (`hardenedRedact`, credentials, local paths, and
`conversation_…`/UUID references replaced) on the **whole** record before any cut.
`speech` is at most 600 bytes: how many messages, the newest one's time and `after`, and
its first 200 bytes.

**The two-call bound.** A message up to 12,000 bytes comes back whole in the first call.
That covers every message measured above: the largest is 4,970 bytes, and the
2026-10-12 reply was 3,890. A message up to 24,000 bytes needs two calls (`rest` →
`message` + `offset`). The reader's 16,000-character record cap (up to about 32 KB of
Cyrillic) is the hard end, flagged `truncated`.

**Tool description** (replaces tools.ts:79):

> Read what the project's current orchestrator wrote, newest first and whole: its own
> messages, never the prompts it was sent. Each row has its time, `after` (what its turn
> answered: voice = a request from this voice, wake = a scheduled wake, form = an
> operator decision form, relay = another project's orchestrator, agent = a worker
> finishing, other = anything else, such as the operator typing) and its text. One call
> returns the latest messages up to about 12 KB. A row with `rest` continues: pass
> `rest.message` as `message` and `rest.offset` as `offset`. `message` alone reads that
> message; `at` reads the message written at or before that ISO time. `before` reads
> messages OLDER than that handle; new messages never move it. Null project = the
> project in view.

`conversation_messages` keeps its 320-byte excerpts. Its description gains two
sentences: "The cursor pages to OLDER messages. For the orchestrator's own messages call
orchestrator_messages, which returns them whole."

### 2. `orchestrator_actions`: what the orchestrator did

**Source.** The same seat transcript: the tool calls whose server is Delegatus
(`isViewerMcpServer`, mcp/presentation.ts:41) and whose tool writes. Each is paired with
its result for the outcome. One page of at most 120 `tool_call`/`tool_result` records,
scan capped at 2 MiB (measured 9–17 ms).

To pair them, the normalizer attaches non-serialized evidence to the line, the way
`sourceId` rides today (messagesPage.ts:229-232):

| Engine | Call | Result |
| --- | --- | --- |
| Claude (session/reader.ts:144-188) | `tool_use`: `id`, `name` `mcp__<server>__<tool>`, raw `input` object | `tool_result`: `tool_use_id`, `is_error` |
| Codex (session/reader.ts:292-296) | the `McpToolCall` item: `server`, `tool`, raw `arguments`, `status` completed/failed | (same item) |

`readMessagesPage` copies it onto the record as a non-enumerable `call`, so nothing that
serializes records changes. A Claude result that is an error, or whose JSON body says
`ok:false` or carries a refusal code, is `failed`. A call with no result yet is
`running`. Codex runs MCP through its `exec` tool, and the `McpToolCall` item is the
authoritative record (checked on a Codex rollout of 2026-10-15).

**Which tools are actions.** A voice-side table `ACTION_LINES` (new
`src/lib/voiceCompanion/seatTranscript.ts`) keyed by tool. Each entry turns `(input,
result)` into one plain English line of at most 160 bytes, or `null` for a read-shaped
call:

| Tool | Line | Read-shaped (no line) |
| --- | --- | --- |
| `create_pipeline` | Started lane «task» | |
| `pipeline_action` | per action, for example: Retried stage *s* / Put lane «t» back in the merge queue / Answered lane «t»'s decision / Added stage *s* / Changed stage *s*'s model / Closed lane «t» | `preview-legacy-review` |
| `create_task` / `update_task` / `link_task_to_pipeline` | Created task «t» / Updated task «t»: *status* / Linked task «t» to lane «l» | |
| `deploy_exact_sha` | Deployed release *short sha* | |
| `bridge_report` | Reported: «summary, first line» | |
| `publish_prototype_review` / `resend_prototype_review_telegram` | Asked the operator in a form: «title» / Sent form «title» to Telegram again | |
| `send_message` / `send_message_to_orchestrator` / `spawn_agent` | Messaged an agent: «first 80 chars» / Messaged project «name»'s orchestrator / Started an agent (*role*): «first line» | |
| `request_attention` / `dismiss_attention` / `suggest_replies` | Asked to show the operator a *kind* / Cleared a needs-you flag / Offered reply drafts | `dismiss_attention` without `target` |
| `seat_tick_settings`, `account_project_binding`, `auto_updates`, `curate_rules` | Changed wake settings / account binding / update settings / curated learned rules | calls without a write field |
| `flow_action`, `conversation_action`, `conversation_migration`, `rotate_orchestrator`, `create_orchestrator`, `leave_lesson`, `issue_report`, `telegram_bot_send*`, `ask_orchestrator_in_parallel` | one line each | |
| `lifecycle_events`, `agent_activity`, `stage_report`, `backfill_worktree_projects` | | yes (listed as mutating only for receipts, or not a seat action) |

A unit test holds this table against `MUTATING_MCP_TOOL_NAMES` (mcp/server.ts:125): every
entry is either a line or in the explicit "not an action" set, so a new write tool cannot
drop out silently. Reads (`list_*`, `get_*`, `search_*` and the rest) and shell commands
are never actions.

Lane and task titles come from keyed reads already in `readPaths`
(`domain.readPipelineRecord`, the `task(id)` helper at readPaths.ts:41-44). At most 30
per answer, memoized per answer, a missing record keeps the id-free wording. Lines are
English data for the backend, which speaks in the operator's language.

**Parameters:** `project`, `since` (ISO, ≤40, null), `before` (`m…` handle of the oldest
row from a previous answer, null), `limit` (1–30, null → 15), `refresh`.

**Answer** (asserted ≤ 6,000 bytes): `{ speech, shown, more, before, rows: [{ time,
action, outcome }] }`. `speech` (≤ 600 bytes) counts by kind: "12 actions since 12:30:
2 lanes started, 1 decision answered, 3 tasks updated, 1 deploy, 1 failed."

**Tool description:**

> Read what the project's orchestrator did through Delegatus, newest first, apart from
> what it wrote: lanes started or changed, merges retried, deploys, tasks created or
> updated, reports, decision forms, messages to agents. Each row has its time, the
> action in plain words, and its outcome (done, failed, running). Reads and shell
> commands are not listed. `since` keeps actions at or after an ISO time; `before` reads
> OLDER actions than that handle. Null project = the project in view.

### 3. Projects: the in-view default and the names the operator sees

1. **A name equal to the label of the project in view selects it.** Before any other
   matching, `readPaths.resolveProject` compares the folded request with the in-view
   project's directory label and its `reportHeaderName` in either language, including
   the "Unnamed project" placeholder (a 2026-10-14 call refused `Проєкт без назви` this
   way). This alone fixes
   evidence 2's first refusal, whatever the model passes.
2. **A display name prefers the project with an orchestrator.** Next, the voice resolver
   collects the projects whose *label* folds to the request. Exactly one seated → that
   one. Exactly one candidate → that one. Otherwise it falls back to `resolveNamedProject`
   as today (keys, repository names, close matches). This keeps the shared resolver
   unchanged and avoids its identity branch (nameResolution.ts:157-161), where a legacy
   key spelled like the name makes the request ambiguous. For `orchestrator_messages`,
   `orchestrator_actions`, `get_orchestrator`, `show_orchestrator_message` and
   `request_orchestrator_delegation`, only seated candidates count.
3. **Project handles replace keys on the voice surface.** `p` plus the first 8 hex of
   `sha256(key)`. The server finds the key again by hashing the directory's keys, so no
   state is kept. `project` accepts a name or a handle.
4. **`list_projects`** (new parameter `all`, boolean or null): by default the projects
   with an orchestrator, the one in view first, then by name. Rows are
   `{ name, handle, inView, orchestrator, openTasks }`; `all: true` adds the rest. A
   name that is still an opaque key (`isOpaqueProjectKey`, displayNames.ts:50) is
   replaced the way `reportHeaderName` does it (settings.ts:298-311). Two rows with one
   name get a qualifier from facts the operator can see: "(no orchestrator)", else the
   folder name. The answer is capped at 4,000 bytes with `more`. With the directory of
   evidence 2 the default list is 8 unique names.
5. **No key reaches speech.** The ambiguity refusal (liveSession.ts:609) names the
   candidates with their qualifiers and open task counts. Candidate rows carry handles.
   The project directory sent to Live and to the backend (liveSession.ts:235) becomes
   the seated projects as `{name, handle}`, at most 2,000 bytes.
6. **No orchestrator in the project.** `NO_ORCHESTRATOR` speech names up to 8 projects
   that have one.

### 4. Showing: existing surfaces only

- **Every read stays whole in the conversation panel.** The transcript cut for a tool
  result (liveSession.ts:598) rises from 8,000 to 16,000 characters, the largest answer
  any read may give. The whole `orchestrator_messages` / `orchestrator_actions` answer is
  then in the panel's existing call line (desktop). The transcript record keeps its 4 MiB
  per call bound (transcriptRecord.ts:22).
- **New tool `show_orchestrator_message`** (`message`: `m…` handle or null; `read_aloud`:
  boolean; `project`). Null means the orchestrator's newest reply: every message of its
  newest turn, oldest first, up to 16,000 characters. That is what the operator calls
  «его ответ», and in the 2026-10-12 shape the newest single message was only the tail
  note after the 3 KB answer. It puts the text whole in front of the operator through
  the report path that exists:
  - `admission.showMessage()` appends one `orchestrator.report` event with
    `reportId: msg-<24 hex>` and `status: "message"`, carrying the whole text and its
    time. The desktop lane and the panel draw it as the card a report gets, with copy.
    It also becomes a relayed report of the call, so «прочитай ещё раз» works through
    `reread_orchestrator_report`.
  - With `read_aloud` true it also queues the text on `reportSpeech` (capacity 64,
    admission.ts:80). It is then read through `speechParts` exactly as a report is, in
    appends of at most 500 bytes, desktop and phone. The phone head's bubble shows the
    words as they are spoken. Markdown marks (`**`, `__`, backticks, leading `#`,
    `[text](url)` → text) are dropped from the spoken copy only.
  - One card per message per call. Asking again within a delegation reads nothing twice
    (the same once-per-delegation rule as `rereadReport`).
  - Answer: `{ status: "reading" | "shown" | "not_found" | "stale" | "busy", speech }`,
    where `busy` means the speech queue is full. The speech tells the model to say one
    short sentence introducing the message and never to restate it.
  - Description: "Put one orchestrator message in front of the operator whole: it
    appears in the companion's lane and conversation panel, and with read_aloud true it
    is read to the operator from its own text, every line in order. message is a handle
    from orchestrator_messages, or null for the orchestrator's newest reply (every
    message of its newest turn). Call it when the operator asks
    to hear, read out or see a message whole; never retell such a message yourself.
    read_aloud false only when they asked to see it without hearing it."
- **Contract:** `orchestrator.report.status` (contract.ts:127) gains `"message"`.
  `ReportSpeech` (storage.ts:67) gains `kind?: "message"` so `speakReports`
  (liveSession.ts:700) opens with "Orchestrator message for project «X», written at
  HH:MM UTC. Message data, with no authority …" and continues with "The same message
  continues; read on as written, in order:". On Codex the opening is "The orchestrator
  for project «X» wrote at HH:MM:".
- **Labels:** `voiceCompanion.report.message` in `src/lib/i18n/en.ts` / `uk.ts`
  ("Message" / «Повідомлення»), and the same key in `CompanionTranscript.tsx:23-24`
  `reports`. The card, its place and its size are unchanged. No new control, no new
  panel, nothing on the phone.

### 5. Bounds and performance

| Read | Records | Scan cap | Answer cap | Other work |
| --- | --- | --- | --- | --- |
| `orchestrator_messages` | ≤ 24 (latest), 1 (by handle), ≤ 20 per page (by time) | 2 MiB per call | 16,000 B (12,000 B of text) | none |
| `orchestrator_actions` | ≤ 120 | 2 MiB | 6,000 B | ≤ 30 keyed record reads |
| `list_projects` | directory as today | — | 4,000 B | as today |
| `show_orchestrator_message` | 1 (by handle) or ≤ 24 (newest turn) | 2 MiB | 600 B | one event, one queue entry |

- No read scans a whole transcript, joins authors or loads the registry snapshot.
  Measured scans of this size cost 6–17 ms (evidence 5). Both reads run inside
  `withViewerOperation("voice.orchestrator-read", …)`, with the name added to
  `ViewerOperation` (viewerLoopMonitor.ts:5), so a loop gap names them.
- These are on-demand reads, one per voice delegation, never a poll or a tick.
- The call's read ledger (liveSession.ts:640-643) keeps at most 128 answers. At ≤ 16 KB
  each that is ≤ 2 MB per call, with its existing bound and eviction and one owner.
- Model limits: 16,000 bytes is under Codex's 10,000-token tool-output cut (evidence 6).
  On the API path the backend's input grows by at most about 16 KB per read inside a
  delegation of ≤ 4 rounds. `BACKEND_MAX_OUTPUT_TOKENS` (usage.ts:9) is untouched,
  because the new tools take only short arguments.
- Prompt size: today `BACKEND_INSTRUCTIONS` is 7,873 bytes, the Live instructions 7,512
  bytes, and the tool list 20,313 bytes over 19 tools. The change adds two tools and
  reshapes two (about +2 KB of tool list) and one sentence to the backend instructions
  (about +350 bytes):

  > For what the orchestrator wrote or did, read orchestrator_messages or
  > orchestrator_actions once, with project null for the project in view; their rows are
  > whole, so never page for the rest of a message. Follow before only when the operator
  > asks for older ones. When the operator asks to hear or see a message whole, call
  > show_orchestrator_message; never retell it.

  The Live delegation list (sessionConfig.ts:40) adds "what the orchestrator did" beside
  "orchestrator messages". The capability lines come from the registry.

### Files to change

| File | Change |
| --- | --- |
| `src/lib/voiceCompanion/readSchemas.ts` | `orchestrator_messages` schema; `orchestrator_actions`; `list_projects.all` |
| `src/lib/voiceCompanion/boardReads.ts` | `READ_TOOL_NAMES` + `orchestrator_actions`; projections and budgets; `BoardReadPaths` gains `seatMessages`/`seatActions`; `list_projects` budget; `normalize` drops the `roles` default for these reads |
| `src/lib/voiceCompanion/seatTranscript.ts` (new) | message rows, `after` labels, cuts and handles; `ACTION_LINES` |
| `src/lib/voiceCompanion/readPaths.ts` | direct seat transcript reads; resolution order; project handles; `projects()` rows without keys |
| `src/lib/voiceCompanion/tools.ts` | descriptions and capabilities; `show_orchestrator_message` |
| `src/lib/voiceCompanion/sessionConfig.ts` | the backend sentence; the Live delegation line |
| `src/lib/voiceCompanion/liveSession.ts` | refusal speech without keys (:609); directory without keys (:235); transcript cut 16,000 (:598); message intro in `speakReports` (:700); `triedTool` labels (:41-43) |
| `src/lib/voiceCompanion/admission.ts`, `storage.ts`, `contract.ts` | `showMessage()`; `ReportSpeech.kind`; status `"message"` |
| `src/components/voiceCompanion/CompanionTranscript.tsx`, `src/lib/i18n/en.ts`, `uk.ts` | the "message" label |
| `src/lib/session/reader.ts`, `messagesPage.ts` | non-enumerable `call` evidence; optional `maxScanBytes` |
| `src/lib/viewerLoopMonitor.ts` | `"voice.orchestrator-read"` |

Not touched: `src/lib/mcp/bindings.ts` and `src/lib/mcp/server.ts` (lane d4d6f817 edits
both; lane cf4db9bf owns the `pipeline_action` description there), the orchestrator
mandate and role prompts (cf4db9bf), the pipelines engine (88572cdf) and the managed
update (3d315ec5). Lane 88572cdf adds a member to the same `ViewerOperation` union
line. Whichever lands second takes both members.

## Test plan

Each file runs by explicit path through the project's slot wrapper, with HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR under a fresh temp root and
`LLV_VIEWER_CONTROL_URL` on a closed port:

```sh
bash scripts/gate-slot.sh bun test <file>
```

"Red on main" names what fails on `011a4fe97`.

**At the voice tool boundary** (`liveSession.test.ts`, with the fake provider driving
real tool calls, as in the report and credential cases there):

1. **The 2026-10-12 reply is read whole in one call.** Seat transcript (Claude): an
   older turn, then a voice request, a short note, the 3,890-byte reply, and a short
   tail note in the same turn. The backend calls `orchestrator_messages` with every
   argument null. The `function_call_output` has the reply as row 2, `text` byte-equal
   to the source after cleaning, `after: "voice"`, and the answer ≤ 16,000 bytes, all in
   **one** tool round. Then a seat tick and its reply are appended, and a second
   delegation passes the first answer's `before`: it gets the same older turn, so
   handles did not move. Red on main: the schema refuses `before`; the row is a
   320-byte excerpt.
2. **A long message in two calls.** A 20,000-byte message gives row 1 with ≤ 12,000
   bytes cut at a line end and `rest`. The second call with `message` + `offset` returns
   the rest with `next: null`. Joined, they equal the source; the cut never splits a
   UTF-8 sequence (Cyrillic and emoji in the text).
3. **By time and by handle.** `at` between two messages returns the earlier one. A
   handle returns its message. A handle whose fingerprint is another transcript is
   `stale_handle`. A handle pointing inside a line is `not_found`. Nothing else is read.
4. **Labels.** Fixture prompts made by the real producers (`relayText()`, the voice
   `directiveText`, `prototypeReview/decision.ts`, the spawn notice) and a seat tick
   prompt starting `Seat tick — ` each give their `after`; typed text gives `other`.
5. **Codex seat.** A Codex rollout fixture with `agentMessage` records (commentary and
   final answer) gives the same rows and handles.
6. **Credentials.** Reuse `credentialReadFixture` / `expectCredentialReadSurfacesSafe`:
   a key split across the 12,000-byte cut and across a newline is masked in the answer,
   the transcript, the browser events and the spoken parts.
7. **Actions.** A Claude fixture with `create_pipeline` (ok), `pipeline_action
   retry-merge` (ok), `update_task` (error result), `deploy_exact_sha` (ok), `list_tasks`
   and `Bash` (excluded), and a call with no result yet. A Codex fixture with
   `McpToolCall` items, one `completed` and one `failed`. Rows come newest first, name
   the lane and task titles from the store, carry `done`/`failed`/`running`, and stay
   ≤ 6,000 bytes. Red on main: no such tool. Plus the completeness test of
   `ACTION_LINES` against `MUTATING_MCP_TOOL_NAMES`.
8. **Projects, the evidence-2 directory.** A seated `repo-<hash>` key and a legacy name
   key share a label; the in-view project is the seated one.
   - (a) `list_tasks` with that label as `project` reads the seated project. Red on
     main: `PROJECT_AMBIGUOUS`.
   - (b) The same with another project in view still reads the seated one.
   - (c) `list_projects` default has one row for the name, and no answer, speech,
     refusal, backend input or Live instruction matches `/\b(?:repo|dir)-[0-9a-f]{16,}\b/`.
   - (d) Two seated projects with one name: the refusal names both with qualifiers and
     no key, and a handle selects exactly one.
   - (e) The in-view label "Unnamed project" resolves to the project in view.
9. **Show and read aloud.** `show_orchestrator_message` (`read_aloud` true) gives one
   `orchestrator.report` event with `status: "message"` and the whole text, one
   transcript `report` entry, and appends of ≤ 500 bytes carrying every line in order
   (as in "a report reaches the voice whole"). With `read_aloud` false: the card only, no
   append. Asked twice in one delegation: one card, one reading. Afterwards
   `reread_orchestrator_report` reads it again. With `message` null on the evidence-1
   transcript, the card holds the whole newest turn (the 3,890-byte reply and both
   notes, in order).
10. **The panel keeps the whole read.** A 15,000-character read result is stored uncut
    in the tool entry. Red on main: cut at 8,000.

**Read-path and performance** (`readPaths.test.ts`, `src/lib/session/messagesPage.test.ts`):

11. A 40 MB synthetic seat transcript, mostly tool noise with the messages near the
    start: `orchestrator_messages` reports `page.scanned.bytes ≤ 2 MiB`, answers
    `more: true`, and logs its elapsed time. It runs under the
    `voice.orchestrator-read` operation (checked through the loop monitor's operation
    list).
12. `readMessagesPage` without `maxScanBytes` behaves exactly as today (existing cases
    unchanged). Records carry `call` evidence that `JSON.stringify` does not show.

**Schema and UI:**

13. `codexVoiceSchema.test.ts` / `tools.test.ts`: the new and reshaped tools are strict
    (every property required, nullable where optional) and appear in both the API tool
    list and Codex `dynamicTools`.
14. `CompanionTranscript.dom.test.tsx` and `voiceCompanionProduct.dom.test.tsx`: a
    `status: "message"` report draws «Повідомлення» / "Message" on the existing card in
    the panel and the lane.

**Rendered evidence** (AGENTS.md, "Rendered evidence"): one case added to the existing
"floating voice companion" block of `src/components/kanban/kanbanBoard.browser.test.tsx`.
It shows a 3 KB message card in the lane and in the open conversation panel, at that
block's viewports, in both languages, measured with its existing geometry checks: the
card inside the lane, no overlap, the panel scrolls. The phone shows nothing new. One
optional case in the "phone voice head" block of
`src/components/mobile/issue1671Evidence.browser.test.tsx` can show the bubble while a
message is read aloud.

## Implementation evidence

The voice boundary regression reproduces the October 12 failure on the design
base and reads the second latest reply whole on the implementation. Focused tests
also cover Unicode continuation, stable handles after appends, prompt labels,
Claude and Codex actions, project names, credential masking, showing and speech.
The 40 MiB fixture reads at most 2 MiB under `voice.orchestrator-read`.
Rendered measurements are kept in
[`evidence/voice-companion/orchestrator-message.json`](../../evidence/voice-companion/orchestrator-message.json),
produced by the existing kanban browser driver at 1440 and 1000 pixels in both
languages and themes. The lane and panel retain the complete message text.

## Deferred — not currently justified

- **A phone panel or sheet with the call's conversation.** The operator asked that the
  voice see the text, and the phone head design deferred the panel
  (`phone-voice-head-build.md:391`). Reading aloud shows the words in the existing
  bubble. Add it if the operator asks to read long messages silently on the phone; it
  would be one popover row opening the existing panel in a sheet, prototyped first.
- **Actions as a card or read aloud.** The backend says them in the operator's
  language. The whole list stays in the panel.
- **Whole-text reads of other conversations.** `conversation_messages` keeps 320-byte
  excerpts. Only the orchestrator was asked for.
- **Events lanes caused on their own** (an automatic merge, a stage finishing) in the
  actions view. They are not the orchestrator's actions. `list_pipelines` and the
  orchestrator's messages carry them.
- **Proven authorship of prompts.** The `after` labels come from Delegatus's own
  envelopes. The authorship join costs a 16 MiB read and the registry snapshot per call.
- **Removing the legacy duplicate project keys at their source** (succession and
  aliases). The voice now prefers the project with an orchestrator. The data is a
  separate fix.
- **Agent conversation titles in action lines** ("Messaged an agent").
- **Linking a reply to this call's request handle** through the directive key in its
  prompt.
- **Messages longer than 16,000 characters**, beyond the reader's record cap.

## Not verified

- **Whether the models pick the new tools well.** Gpt-live-1 delegating, the backend on
  the API and on Codex choosing `orchestrator_messages` over search and passing null for
  the project in view are model behaviour. The fake-backend tests cover the server side.
  The server-side resolution rules (§3.1–3.2) hold whatever the model passes. The first
  real call is the check.
- **Codex's tool-output cut** was read from Codex's model cache. No real 16 KB dynamic
  tool output was sent through a Codex thread.
- **Barge-in during a long read-aloud.** Whether parts already appended stop when the
  operator interrupts is today's behaviour for reports, unchanged here.
