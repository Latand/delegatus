# Owner relay context gap: production diagnosis

Recorded 2026-10-15 UTC. Scope: outcome (1), read-only diagnosis and fix design.
Delegatus source: `805a790ac4be5b20941ab708e1e7274918cd4cf1`.
The originating requirement, received through the verified owner relay on
2026-10-15, is to retain questions and answers for the next owner turn.
This public report contains no private message text or destination identifiers.

The immediate context loss is confirmed on the Celestia side. Both persisted
prepared requests preserved the complete reply-parent snippet, but their relay
payloads omitted the parent and changed the reply link to null. The actual
numbered question has now been recovered through the coordinated Celestia
investigation. Its text belongs only in the private final response. This audit
interprets neither short owner answer as authorization for that question.

No retained record attributes the parent to a registered sender on this
installation. Every local outbound path below was checked. The controller
assigned the remaining custody investigation to the other linked installation;
its sender and outbound records cannot be verified from here. Celestia is
separately implementing the confirmed context repair. The settled continuation
directs the next Delegatus build to cover its senders while that other-install
gap remains open. The earlier Celestia coordination decision is settled.

## Incident evidence

Initial reads ran at 15:42–15:49Z; continuation reads ran at 16:35–16:42Z.
SQLite connections used URI `mode=ro` and `PRAGMA query_only=ON`. JSON records
were read directly. Application-store imports, migrations, production writes
and Telegram sends were excluded.

| Evidence | Observation | Consequence |
| --- | --- | --- |
| Local relay archive, 327 retained records | A confirmed publication-reference join identifies 56 records for the affected opaque chat. Its four same-day requests start at 15:17:50.075Z, 15:25:20.507Z, 15:37:00.676Z and 15:38:36.492Z. The last earlier request starts on 2026-10-14 at 22:20:13.225Z. | No locally archived relay run generated the question before the first answer. |
| First two archived inputs | Each contains 40 messages. The first has one same-day owner answer; the second has both. Both wire reply links are null, with no parent text. | Context is already missing before Delegatus builds its prompt. |
| Later archived inputs | Subsequent clarification answers reappear with reply links. The second request's answer was archived at 15:27:09.631Z and its completion accepted. | Storage works for some relay answers. Service acceptance alone does not prove Telegram delivery. |
| Owner-history API | The continuation exhausted four pages, containing 20, 10, 13 and 3 rows. Both answers retain the same explicit raw parent and topic; the parent is absent. | The incident involved explicit Telegram replies. A genuinely unthreaded answer remains a separate acceptance case. |
| Local bot history | All 21 retained same-day posts in the affected group are outbound and in another topic. No parent or row in the incident topic exists at any retained time. | Nearby reports cannot establish the missing question. |
| Exact local lookups | Zero matching bot message, send receipt, publication reference or bridge receipt. No unsettled send exists for that group. | The registered local send paths have no custody record for this parent. |
| Coordinated Celestia database investigation | The parent has no current ChatMessage row, including deleted or notice rows. Both persisted prepared requests contain its identical complete snippet; both stored relay payloads omit it. | Snapshot text was available before serialization. Physical deletion versus a missing original insert remains unknown. |

The owner-history date query covers
`[2026-10-14T21:00:00Z, 2026-10-15T21:00:00Z)`; observations end at read time.
One continuation page timed out after three reconnect attempts; the same cursor
subsequently succeeded and pagination reached null. The prior audit had also
exhausted this date's history. API absence alone concerns eligible rows;
Celestia's unfiltered database read closes that limit.

The archive and later replies survived the reported Viewer restarts. There is
no evidence that a Viewer restart erased this parent. Publication's restart
gap below is a confirmed design defect with no receipt connecting it to this
particular message.

## Every local outbound path checked

The incident window is
`[2026-10-15T14:56:47.000Z, 2026-10-15T15:17:35.087558Z)`.
Exact parent lookups also ran without time or topic filters.

| Sender | Recording path and source location | Incident result |
| --- | --- | --- |
| Bridge-report Telegram copies | `src/lib/mcp/bindings.ts:3794` sends the stored copy; `:3827` dispatches to the bot-agent route. `src/lib/bridge/store.ts:945` records Telegram state and message IDs on the report. | Nineteen same-day reports precede the first answer. Exactly one report/send falls in the window: the neighboring report in the other topic. No parent receipt. |
| Agent bot sends and relay-owner tool sends | `src/app/api/telegram/bot/agent/route.ts:61` dispatches text/media/document sends. `src/lib/telegram/bot/service.ts:954`, `:1190` and `:1273` complete them through the same store. | No match among the group's 155 retained messages and 155 send records; no pending, failed or uncertain send remains for that group. |
| Seat replies and recovery notices | Report replies follow the bridge path. `src/lib/monitor/seatAuthRecovery.ts:103` and `:154` use the bot service and record their report outcome. | Covered by the bot, send and bridge lookups. No separate matching receipt. |
| Prototype reviews, decision forms and carousels | `src/lib/prototypeReview/telegramPost.ts:148` calls `sendOwnerReview`. `src/lib/telegram/bot/service.ts:981` requires a private owner chat; `:1090` journals the rich post. Metadata lives in task prototypeReviews or seat-decisions. | All 134 retained rounds were checked: 111 task rounds and 23 seat rounds. None was created in the window or contains the parent ID. The automatic private-chat route cannot target this group topic. |
| Decision polls added since the audit base | The inspected main revision's `src/lib/telegram/bot/reviewPolls.ts:167` retains a sent outcome/message ID on the form and invokes in-memory publication. | Another sender for the build to cover. No matching local round establishes it as the incident sender. |
| Relay final answers | `src/lib/externalRelay/runner.ts:280` archives the generated decision before completion; `:308` records service acknowledgement. | No run in the window. Four later requests are retained. The archive lacks a confirmed Telegram send receipt. |
| Operator test posts and sign-in acknowledgements | `src/lib/telegram/bot/service.ts:600` and `:751` call the transport directly and publish without completeSend. | Test posts specify no topic; sign-in acknowledgements are private-chat only. Neither registered route can produce this forum-topic parent. Their recording gap still belongs in comprehensive sender coverage. |

The request/run ledgers contain no parent ID. Old bridge paths contain
migration README files; current bridge data is in state.sqlite. No separate
local publication outbox exists in these paths. Source searches covered
transport calls, bot-agent dispatch, bridge copies, prototype posting, seat
recovery and relay completions.

This establishes absence from retained registered local sender records. It
does not identify an arbitrary unjournaled Bot API script. The coordinated
investigation found a matching release task owned by another linked install.
The controller treats that install as the sender lead. Message-ID proximity
and task subject alone do not identify its bot or sending process. Closing
that gap needs its read-only send, publication, form and sending-transcript
evidence for the privately bound parent and window. That access is unavailable
here; the settled continuation explicitly permits the local build to proceed.

## Cause and code locations

Celestia's coordinated production audit verified backend revision
`414a93ef75b2952786f3865ad6c1e8b160334ed4` through running processes and source
hashes. These Celestia locations refer to that revision, independently re-read
here with `git show`:

- `apps/backend/aiinit/controllers/prepare_answer.py:3147` validates the incoming
  reply snapshot; `:3154` retains its text and `:3211` puts the snippet in the
  persisted prepared request.
- `apps/backend/aiinit/controllers/prepare_answer.py:3310` builds relay input
  from history without passing that preserved snippet.
- `apps/backend/application/usecase/clones/relay_answer_input.py:128` makes the
  raw parent mandatory, but `:130` and `:143` can select and assign opaque IDs
  only to existing history rows. `:196` uses ids.get for the parent, producing
  null when it is absent.
- `apps/backend/aiinit/controllers/prepare_answer.py:698` refuses to promote an
  absent own-bot text snapshot to an ordinary history row because snapshots
  cannot distinguish assistant answers from notices. The preserved snippet
  nevertheless provides an independent way to carry reply context.

At the Delegatus audit revision, `src/lib/externalRelay/ownerRun.ts:37` embeds
the supplied conversation. `ownerBridgeContext.ts:46` needs a non-null wire
reference plus a confirmed publication mapping for report context; `:59` needs
the parent row for ordinary reply context. Both fail to resolve this input.
`ownerRun.ts:33` consequently asks for clarification. Full owner turns use fresh
conversations: `runner.ts:493` excludes them from persistent chat-conversation
reuse. The answer archive is read as audit evidence (`answers.ts:9`); it does not
reconstruct context.

Ordinary outbound text, chat, topic, Telegram message ID and attribution are
committed in one transaction (`src/lib/telegram/bot/store.ts:697`). Publication
remains vulnerable: `service.ts:327` launches an unawaited callback, often before
completeSend. `src/lib/externalRelay/publish.ts:75` queues at most 128 operations
in memory, retries transient failures and can skip work during cooldown. No
persisted pending obligation survives restart. `publishedReferences.ts:34`
records only confirmed mappings; its schema at `:6` has no topic or text.
A delivered local post can therefore remain absent from service history; the
fresh owner prompt does not independently read local sent history.

## Earlier work and concurrent changes

Transcript searches used owner-history, ownerRun and relay-journal phrasings,
project-scoped first and then globally. The 2026-10-13 audit was opened through
conversation_messages. It described archives and acknowledgement evidence,
without establishing complete outbound context recovery. Related memory
queries returned no hits. Later transcript reads and the Celestia evidence
report supplied the coordinated diagnosis. Search tokenization ignored some
quoted phrases, so those empty results do not establish absence.

First-parent Git history and gh merge metadata establish:

| Change | Merge UTC | Scope |
| --- | --- | --- |
| Full owner turns, PR 2677 | 2026-10-10 14:40:39Z | Full-agent execution and archive conversation binding. |
| Owner group history, PR 2801 | 2026-10-12 23:15:22Z | Private group-history reads; ownerHistory.ts:99 excludes page persistence. |
| Claim custody, PR 2811 | 2026-10-13 04:21:43Z | Earlier acknowledgement, feature refresh and terminal-record handling. |
| Bounded relay waits, PR 2822 | 2026-10-13 18:04:41Z | Admission and deadline custody. |
| Explicit reply context, PR 2839 | 2026-10-14 07:47:28Z | Interpretation of supplied parent context and receipt-backed report custody. |

These changes did not guarantee every delivered question appears in the next
owner prompt. Celestia's earlier hosted reply-snippet fix remains present in
both prepared requests; the relay lacks equivalent consumption. No revert of
that preservation was established.

The audit HEAD stayed fixed. At the continuation recheck origin/main was
`e253b96f73b197cecdf639c41ee5c0be4b513245`. Its decision-poll diff touches the
runner, prototype rendering/parsing, bot service and new poll sender; it still
needs a supplied parent. The reply-pill removal branch shares several changes.
Their relevant diffs were read. Mandate, pipeline-controller and MCP-store work
remains fenced; none changes this declared report. The build must integrate
sender coverage with current main and preserve these lanes' behavior.

## Reproduction selections

Private parameter bindings are in this stage's tool transcript. All SQL used
a read-only connection and query_only=ON. At 16:37–16:41Z the exact selections
included:

```sql
SELECT chat_id,message_id,date,direction,topic_id FROM messages
WHERE chat_id=? AND message_id=?;

SELECT state,message_ids,sent_at,error_code FROM sends
WHERE chat_id=? AND EXISTS (
  SELECT 1 FROM json_each(sends.message_ids) WHERE value=?
);

SELECT message_id,date,direction,topic_id FROM messages
WHERE chat_id=? AND topic_id=?;

SELECT state,message_ids,created_at,sent_at,error_code FROM sends
WHERE chat_id=? AND created_at>=? AND created_at<?;

SELECT state,error_code,count(*) AS n FROM sends
WHERE chat_id=? AND state<>? GROUP BY state,error_code;

SELECT row_key FROM state_rows
WHERE collection='relay_published_references'
AND json_extract(value_json,'$.chatId')=?
AND json_extract(value_json,'$.messageId')=?;

SELECT value_json FROM state_rows
WHERE collection='bridge_reports' AND row_key LIKE 'e:%';

SELECT collection,value_json FROM state_rows
WHERE collection IN ('seat-decisions','tasks');
```

Bindings select the affected group, parent and topic. The receipt window uses
the UTC bounds above with fractional-second ISO strings. Bridge rows were
decoded from v, filtered by verified chat ID/alias, and their timestamps parsed
as UTC before comparison. Telegram IDs were compared exactly. Task rounds
come from v.prototypeReviews; seat rounds are direct records. Every retained
round was checked, without limiting the exact-ID search to the window.

Archive reads at 16:40Z decoded all retained
external-relay/answers/*/*/*.json records. A join of confirmed publication
messageKey values to input conversation IDs established the affected chatKey.
Selected request start times and messages were then compared. No pruning
helper ran. Direct reads of requests.json and runs.json at 16:41:42Z found no
occurrence of the privately bound parent ID.

Continuation tool reads were:

```text
relay_owner_history(action="groups")
relay_owner_history(action="messages", chat=affected_group,
                    from="2026-10-15", to="2026-10-15", limit=100)
relay_owner_history(action="messages", cursor=previous.nextCursor, limit=100)
telegram_bot_messages(chat=affected_group, since="2026-10-15T00:00:00Z",
                      limit=100, maxChars=1500)
conversation_messages(transcriptPath=prior_audit_or_coordinated_diagnosis,
                      limit=8, maxChars=16000)
```

Bot pagination ended with hasMore=false; owner history reached nextCursor=null.
Celestia's declared evidence report records its read-only Postgres/ClickHouse
queries, persisted-request decoding and runtime/source hashes, observed at
16:09–16:19Z. Its coordinated diagnosis was opened through conversation_messages
and then that report itself. This stage opened no independent Celestia
production connection.

Source/history commands were `git log --first-parent --since=2026-10-09
--until=2026-10-15 --oneline -- src/lib/externalRelay`,
`gh pr view <number> --json title,mergedAt,mergeCommit,files` (or without files),
and `git show <revision>:<path>`. Overlap checks used git merge-base,
git diff --name-only and the relevant actual branch/main diffs.

## Fix design for the following build

1. Reuse the bot journal for owner-bound posts. Record confirmed chat, topic,
   Telegram message ID/date, readable text, origin, reply identity and full
   question/options before reporting a send complete. Retain the actual
   fallback text when rich rendering changes. Cover text, media captions,
   documents, bridge copies, seat notices, rich decisions, carousels and polls
   through one recording boundary. Attribute operator/system replies correctly.
2. Commit a publication obligation with the confirmed local receipt. Reuse the
   existing idempotent service endpoint and confirmed mappings. Drain bounded,
   indexed work asynchronously after startup and sends, with finite deadlines,
   backoff and loop-monitor labels. Recheck current target authorization before
   replay. An interrupted send with unknown delivery stays uncertain; recovery
   must not issue a duplicate under a new key. Distinguish local delivery,
   remote history publication and completion acceptance.
3. Give fresh owner turns bounded access to confirmed local outbound context.
   Resolve target/chat/topic through verified mappings, extending receipt
   metadata as needed; an opaque chat key alone proves no topic. Prefer the
   explicit parent. For an unthreaded short answer, include the latest unresolved
   question in that verified scope before the answer, preserving options and
   assistant attribution. Deduplicate service history. Competing questions
   remain ambiguous; adjacency grants no authority. Unknown destination
   mappings remain unresolved rather than borrowing another topic's question.
4. Preserve Celestia's separate repair: carry incoming reply text or its
   prepared snippet when the history row is missing, with explicit identity
   and snapshot provenance through bounded selection. Celestia owns persistence
   for sends it performs. Another bot's sends need the sender's own journal.
   This build cannot repair the other install's historical record without its
   evidence; describe that limit in the eventual PR.
5. Add the required synthetic behavioral regression: send a question with
   numbered options, close and reopen the service/store as a restart, accept an
   unthreaded short answer, and inspect the actual next owner input for the
   question before the answer. Also cover restart after receipt but before
   publication, replay without a second send, explicit parent absent from
   service history, topic separation and the poll sender. Contend changed store
   operations with peer-held locks while an independent timer advances. Run
   explicit touched files in isolated state.

This diagnosis claims no runtime repair or performance improvement. Only this
report changed. Behavioral tests belong to the implementation stage.

The final report passed the path-scoped publication privacy gate in a scratch
HEAD export, using isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR and
a closed Viewer control URL:

```sh
bun scripts/privacy-publication-gate.ts --repository "$EXPORT" \
  --require-known-values --paths docs/perf/relay-context-gap.md
```

The committed fingerprint file from that export supplied the gate's known
values. New-file git whitespace inspection produced no diagnostics; a separate
line check found no trailing whitespace and confirmed the final newline. The
checkout-scope check found only the declared report, with HEAD unchanged.
