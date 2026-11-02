# Codex MCP calls in the conversation feed: build brief

Base: `main` at 03730853 (2026-10-31 13:29 +02:00). Every `file:line` below is at that revision.

## Originating requirement

Operator, 2026-10-30 07:20:49 UTC (09:20 GMT+2), in their own Delegatus orchestrator seat conversation
(conversation e3b1322c, a Codex seat), with a screenshot (runtime image `4df0336b…`). The record carries a
system-inserted preface before the operator's words: a "While you were away the manager reported" digest of
finished tasks and a viewer-context line naming the focused transcript by its local path. That preface is
omitted here. The operator's words follow verbatim, dictated in Russian:

> «Нужно разобраться, какого хуя у нас показывается UI для кодекса. В виде NVIDIA, где пишется MCP в.
> Количество. Вместо того чтобы показывать. Как в Claude Code, когда рендерится Claude, разговор, там
> показывается. Конкретно, если он вызвал MCP вьюера, если он отправил общение, если агент вернул и можно
> перейти по ссылке. А таким образом нихуя нельзя сделать. Какого хуя у нас вообще отличается вид вызова и
> вызовов, и отличается вид рендера? Если даже не те же элементы, один рендер и лучше это делать как в Claude
> Code. В Claude Code, по-моему. Хотя иногда мне нравится, как группируют и в кодексе, но я. Хочу в разговоре
> иметь возможность быстро перейти к другим разговорам, которые спавнят мой оркестратор.»

Translation: "We need to figure out why the hell the Codex UI shows it [as NVIDIA: a dictation slip] where it
writes MCP and a count, instead of showing it the way Claude Code does. When a Claude conversation renders, it
shows specifically whether it called the Viewer MCP, whether it sent a message, whether the agent came back,
and you can follow the link. This way you can't do a damn thing. Why the hell does the look of a call and of
calls differ at all, and why does the rendering differ? Even if they aren't the same elements: one render, and
better done the Claude Code way. Claude Code's, I think. Although sometimes I like how Codex groups them too.
But I want to be able, in a conversation, to jump quickly to the other conversations my orchestrator spawns."

The screenshot is the orchestrator dock on the board (Codex, `gpt-6.1-sol`). Under one answer it shows three
collapsed rows: «викликів MCP: 7 ✕1» (09:12:14–09:12:16, 2.6 s), «викликів MCP: 4» (09:13:56–09:14:01) and
«викликів MCP: 2» (09:15:33–09:15:37).

Pinned acceptance (from the lane's specification):

1. Each Codex MCP call shows its tool name, key arguments and result, reusing Claude's rich renderers. Calls
   that spawn or message agents link to that conversation through the existing navigation resolver and stable
   conversation/launch ids.
2. Grouping of consecutive calls is kept: a group header with the count, expandable to the named calls.
3. Direct MCP calls, nested `functions.exec` batches, partial results and errors are covered. A spawn that
   has not materialized shows as pending, with no invented conversation and no claimed success.
4. First compare the raw Codex and Claude records, their normalization and the components, and establish
   whether the data is missing or only collapsed.
5. The feed stays compact. Text and attachment integrity and authority/workspace access are unchanged.
6. Rendered evidence at 390 px and desktop, en/uk, light/dark, from the existing capture drivers.

Fences: lane a8de05b7 (#3523) changes the feed's delivery UI. No live message sends, no new agents for a demo,
no disclosure redesign.

## Acceptance 4: the data is present and only collapsed

### What each engine writes

| Source | Raw record(s) | What it carries |
|---|---|---|
| Claude | assistant `tool_use` `{name: "mcp__viewer__<tool>", input}`, then user `tool_result` `{content: [{type: "text", text: "<JSON>"}], is_error}` | Tool name, full arguments, JSON result. A `spawn_agent` result reads `{conversationId, transcriptPath: null, operationId, launchId, state: "starting", initialMessage: "pending", ok, …}` while the child is not yet materialized. |
| Codex, code mode (every MCP call in current rollouts) | `response_item` `custom_tool_call` `{name: "exec", input: "<JS calling tools.mcp__viewer__…>"}`; one `event_msg` `item_completed` `{item: {type: "McpToolCall", id: "exec-<uuid>", server, tool, arguments, status, result: {content: [{type: "text", text: "<JSON>"}], isError?}, error?, duration}}` per nested call; then `custom_tool_call_output` with the script's combined output | The same as Claude: server, tool, full arguments, the same JSON result text, `status: "completed" \| "failed"`, `isError`, an optional `error: {message}`, timing (`started_at_ms`, `completed_at_ms`, `duration`). No `item_started` is written for nested calls. |
| Codex, direct call (seen Oct 17; also July) | `response_item` `function_call` `{namespace: "mcp__viewer", name: "<tool>", arguments: "<JSON string>", call_id}`, then `McpToolCall` `item_completed` with `id = call_id` (Oct 17), then `function_call_output` | The same fields. The July form has `mcp_tool_call_end` `{invocation: {server, tool, arguments}, result: {Ok: {content}}}` between the call and its output, and no begin record. |
| Codex, legacy events | `event_msg` `mcp_tool_call_begin` / `mcp_tool_call_end` with `invocation` | Server, tool, arguments, `Ok`/`Err` result. |

Corpus counts, read 2026-10-31 from rollouts on this machine (the default Codex home for Oct 29–31 and every
account home for Oct 30–31): 43,418 `McpToolCall` `item_completed` items with status `completed`, 2,020 with
`failed` + `isError: true` and 31 with `failed` + `error.message` (an approval refusal). Every id starts with
`exec-`. There are no `item_started` records for them, no `mcp_tool_call_begin`/`_end` and no direct
`function_call` MCP calls. The seat conversation in the screenshot alone has 791 nested Viewer calls (42
failed) across 164 `exec` batches.

### Normalization: `src/components/feed/parse.ts`

| Path | Code | Sets `ToolEvent.mcp`? | Folds into a group? |
|---|---|---|---|
| Claude `tool_use` | `:3614-3637`: `viewerMcpToolUse(name)` (`:564-573`) → `newToolEvent({…, mcp})`; the result lands in `attach`, `mcp.result = jsonRecord(body)` (`:2502-2505`) | yes | no: `foldableTool` excludes `item.mcp` (`:1086-1088`) |
| Codex legacy `mcp_tool_call_begin/_end` | `:3339-3360`: `viewerMcpInvocation` (`:556-562`), `codexMcpResult` (`:575-583`) | yes, when the begin/end record creates the row | no |
| Codex code-mode `McpToolCall` | `:2865-2869` → `emitCodexThreadTool` (`:2765-2801`), whose `newToolEvent` call (`:2777-2784`) takes no `mcp` | **no** | **yes** |
| Codex direct `function_call` | `:3411-3437`; `:3418` reads `p.name` and ignores `p.namespace`, so the row is named plain `send_message`; `:3431` builds it with no `mcp` | **no** | **yes** |
| July order: `function_call` (namespace) → `mcp_tool_call_end` | `:3345-3352` finds the row `:3431` already made, which has no `mcp`, so `:3353` never stores the result | **no** | **yes** |

The MCP read path is already complete: `src/lib/session/reader.ts:324-327` and `:368-374` expose server, tool,
input, status and result of every `McpToolCall` to `conversation_messages`. Only the feed parser drops the
identity.

### Components

- `src/components/feed/FeedItem.tsx:354-357`: a tool row with `mcp` renders `McpCallCard`
  (`src/components/runtime/McpCallCard.tsx:131-218`), or `DecisionPointer` for `publish_prototype_review`
  (`src/components/decisions/DecisionPointer.tsx:27-33`). The card's text comes from `describeMcpCall`
  (`src/lib/mcp/presentation.ts:130-614`): an action title in the interface language, entity chips
  (`#c=<conversationId>`, task and pipeline links through `llv:mcp-navigate`), a success, error or pending
  glyph, and a Details disclosure holding the bounded payload. A conversation chip stays disabled until the
  conversation id appears in the availability set (`McpCallCard.tsx:101-115`), which `Viewer.tsx:440-442`
  publishes from the listed files (`src/lib/mcp/availability.ts`).
- `FeedItem.tsx:360-361`: any other tool row renders `ToolCard`; a group renders `CmdGroupCard`.
- `src/components/feed/cards/CmdGroupCard.tsx:193` (desktop and dock) and `:110` (phone fold) title a group
  with `meaningfulToolGroup` → `src/components/feed/toolMeaning.ts:28`: «викликів MCP: N». An opened group
  draws each member as a `ToolLine`/`ToolBlockRow` (`CmdGroupCard.tsx:24-62`, `ToolCard.tsx:305-430`) whose
  text is the generic summary from `src/components/feed/tools.ts:443-453`, «viewer · list_tasks · repo-…»,
  with argument chips and raw output text. There is no action title and no link.
- The live overlay already names Codex calls while they run: `src/lib/runtime/liveTurn.ts:271-282` names
  them `mcp__<server>__<tool>`, and `src/components/conversation/LiveTurnRows.tsx:107-119` / `LiveMcpRow`
  (`:280`) render them through `describeMcpCall`. Once the call settles, the transcript row replaces the
  named live row with the collapsed count.

### Where Codex calls get collapsed

1. `parse.ts:2865-2869` → `:2777-2784` (and `:3418`/`:3431` for direct calls): the Viewer MCP identity is
   not set, so the row is a generic `family: "mcp"` tool.
2. `parse.ts:1087` (`foldableTool`) → `:4269-4326` (a run of `CMD_GROUP_MIN = 2`, `:991`, becomes a
   `cmd-group`) → `CmdGroupCard.tsx:193` → `toolMeaning.ts:28`: «викликів MCP: 7».

### Evidence for this section

Run in a scratch export of 03730853 with an isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR and the
control URL on port 1. A small `bun run` script calls the production `buildFeed` and prints each item.

- The seat rollout, lines 1528-1570 (the screenshot's span, 43 records), produces three `cmd-group`s:
  7 calls with `errCount=1`, then 4, then 2. Every member is `family=mcp mcp=none`, and the `exec` wrappers
  are represented and hidden. Member summaries are «viewer · list_tasks · repo-…», «viewer · leave_lesson»,
  and so on. This reproduces the screenshot exactly.
- Synthetic Claude records (`list_tasks`, `get_pipeline`, `spawn_agent`) produce three standalone tool rows,
  each with `mcp` set and its parsed result keys (`conversationId,transcriptPath,launchId,state` for the
  spawn).
- Synthetic Codex direct calls (namespace and flat-name forms) produce one `cmd-group` of 2 with `mcp=none`.
- The real July order (namespace `function_call` → `mcp_tool_call_end` → `function_call_output`) produces one
  row named `spawn_agent`, of family `spawn` (Codex's own sub-agent family), with `mcp=none` and no result.
  With a `mcp_tool_call_begin` added after the `function_call`, it produces two rows: that bare `spawn_agent`,
  stuck at `run`, and a second, named row for the same id.
- With the scratch export patched so that `:2865-2869` passes `viewerMcpInvocation(...)` into
  `emitCodexThreadTool`, the same 43 records produce 13 standalone rows. Each has `mcp` and a parsed result
  (`count,total,…`, `taskId,task,…`, `pipelineId,state,…`). The failed `leave_lesson` reads `status=err`
  with output text «MCP error -32602: Input validation error: …». So setting the identity alone restores the
  data but loses the grouping. That is why the folding rule changes too (D2).

## Design

### D1. Codex Viewer MCP calls carry the same identity as Claude's

All three Codex shapes set `mcp` for Viewer servers (`isViewerMcpServer`, `presentation.ts:45-53`) exactly as
the Claude path does. `attach` then fills `mcp.result` from the same JSON text (`:2502-2505`), bounded and
redacted by `boundedMcpRecord` (`:945-970`). Non-Viewer servers keep their generic rows, as in Claude.

### D2. One folding rule: a code-mode batch folds; agent calls stand alone

A Viewer MCP call folds into a group only when it is a nested call of a code-mode batch (its id starts with
`exec-`, the same marker `parse.ts:2810` already pairs on) and it is not a call that stands alone. Calls that
stand alone: `spawn_agent`, `send_message`, `send_message_to_orchestrator`, `ask_orchestrator_in_parallel`,
`create_orchestrator` (spawn or message an agent) and `publish_prototype_review` (its row is the decision
pointer). Every other Viewer MCP call stands alone, as every one does today.

Why this rule:

- It keeps what the operator likes about Codex: the screenshot's three groups are exactly its three `exec`
  batches (7, 4, 2), and a batch stays one group with a count header (acceptance 2).
- The operator's goal is to jump to the conversations the orchestrator spawns or messages. Those rows stay
  outside any group, one click away in the collapsed dock, as in Claude.
- Claude never writes batches, so its rendering does not change. Changing it would undo an operator decision
  this request does not name. On 2026-09-29 the operator kept the seat panel's MCP task rows visible, one line
  each («1,2, 3 - треба залишити, просто обрізані щоб і все.», `docs/design/seat-panel-noise.md:321-323`,
  `:382-389`). Two driver cases pin that decision: `kanbanBoard.browser.test.tsx` «seat panel carries no
  internal noise» (`:19108`, three Claude MCP rows) and `issue1671Evidence.browser.test.tsx:6756` (two rows,
  `:6877`). Folding Claude's consecutive Viewer calls would hide those rows behind a closed group in the dock.
- Direct Codex calls (not batched) stand alone, like Claude's.

### D3. Opened groups reuse the Claude row

Inside an opened group, a member with `mcp` renders `McpCallCard` instead of `ToolLine`/`ToolBlockRow`. One
renderer then draws a Viewer call in both engines, standalone or grouped. The group header keeps its count
(«викликів MCP: N», «✕k» for failures). On the phone's failed-run block, whose rows sit inside one `<button>`,
a Viewer MCP row prints the `describeMcpCall` title instead of the generic summary. Links are reachable in the
readable block that opens below the button, never inside it.

### D4. Agent-messaging tools get titles and links from existing strings

`describeMcpCall` has no branch for three tools a seat uses. They fall back to «Running MCP tool: …» with no
link (`presentation.ts:608-614`), in Claude too. All three return `conversationId`
(`src/lib/mcp/bindings.ts:5670-5690`, `:5866-5884`, and the observed `send_message_to_orchestrator` result).

- `send_message_to_orchestrator`: `mcp.call.sendMessageTo` with `{conversation: args.project}`, a
  conversation link from `result.conversationId` labelled "Open conversation".
- `ask_orchestrator_in_parallel`: the same title and link.
- `create_orchestrator`: `mcp.call.spawnAgent` with `{subject: project}`, an "Open agent" link from
  `result.conversationId`.

### D5. A spawn that has not materialized reads as pending, in words

Today a returned `spawn_agent` whose conversation the scanner has not attributed shows a greyed «Відкрити
агента» chip whose tooltip is hard-coded English (`McpCallCard.tsx:109`), next to a green success check. For
links whose conversation the call itself creates (`spawn_agent`, `create_orchestrator`,
`ask_orchestrator_in_parallel`), while that id is not in the availability set:

- the chip is not interactive and shows a short visible word, `mcp.link.pending` ("starting" /
  «запускається»), with a clock glyph at every width, including ≤480 px where enabled chips hide their label;
- its hint comes from a localized key. Keep the current English sentence as the en value so the existing
  assertion (`McpCallCard.dom.test.tsx:98`) still holds;
- the row shows no trailing outcome glyph: the chip's clock is the one sign of this state, and the tool icon
  uses the pending tone instead of the success colour. The call was accepted; the agent does not exist yet.
  `data-state` keeps the call's own outcome, and the chip carries a marker of its own (`data-link-pending`).

When the id appears, the chip becomes the existing link (the upgrade at `McpCallCard.dom.test.tsx:81-106`
already covers this). Message tools keep today's disabled chip: their target conversation exists and may simply
be outside this Viewer's file list. No row ever links an id that is not in the availability set.

The literals `McpCallCard` prints in English move to en/uk keys: «Replay» (`:188`), «Retryable» (`:189`),
«MCP call failed» (`:64`) and the chip hint (`:109`). These now appear in uk Codex frames, and the evidence
covers uk.

### Rejected

- **Set the identity and change nothing else.** Every Viewer call becomes a standalone row: 13 rows instead of
  3 groups for the screenshot's span, and 791 rows in that seat. Grouping is lost (acceptance 2) and the feed
  stops being compact (acceptance 5).
- **Fold every Viewer MCP call in both engines.** This hides the b2 rows the operator chose to keep (D2).
- **Link chips on the group header.** This adds chrome. Standing the agent rows outside the group reuses the
  existing row.

## Build brief

### Files and changes

1. `src/components/feed/parse.ts`
   - `emitCodexThreadTool` (`:2765-2801`) accepts an optional `mcp` and passes it to `newToolEvent`. The
     `mcptoolcall` branch (`:2865-2869`) passes
     `viewerMcpInvocation({server: item.server, tool: item.tool, arguments: codexThreadArgs(item.arguments)})`.
     The arguments go through `codexThreadArgs` because `viewerMcpInvocation` reads them with `rec`, and a
     string form would come back empty.
   - `codexThreadToolStatus` (`:2673-2684`) also returns `err` for `rec(item.result).isError === true`, the
     rule `codexMcpResult` already applies (`:578`).
   - `function_call` (`:3411-3437`): when `p.namespace` starts with `mcp__`, the tool name is
     `${namespace}__${name}` (tolerate a trailing `__` on the namespace). A name that `viewerMcpToolUse`
     accepts, whether composed or already flat, builds its row with `mcp`, as the Claude branch does at
     `:3632-3636`. This alone fixes the July order: `mcp_tool_call_end` then finds a row that has `mcp`.
   - `mcp_tool_call_begin` (`:3339-3344`) returns without registering when `calls` already holds that id, so
     the call keeps one row.
   - `foldableTool` (`:1086-1088`) applies D2: a tool with `mcp` folds only when `item.id.startsWith("exec-")`
     and the tool does not stand alone. Everything else in the predicate is unchanged.
2. `src/lib/mcp/presentation.ts`
   - Export the stand-alone set (D2) as one predicate, used by the parser.
   - Add the three branches of D4, reusing the existing message keys.
   - Mark the links whose conversation the call creates (D5), e.g. a boolean on `McpCallLink`, set by
     `spawn_agent`, `create_orchestrator` and `ask_orchestrator_in_parallel`.
3. `src/components/runtime/McpCallCard.tsx`
   - A prop for rendering inside a group that drops the standalone `ml-9 my-1` (`:166`). The group already
     carries the indent, and the phone's sunken block has its own padding.
   - The D5 chip, glyph and localized literals. Keep the row one line, `flex-nowrap`, title floor `6rem`
     (b2, #1955).
4. `src/components/feed/cards/CmdGroupCard.tsx`
   - `ReadableBlocks` (`:24-62`): in both the collapsed and the board branch, a `block.parent.mcp` renders
     `McpCallCard` with the in-group prop.
   - `MobileCmdGroup` (`:74-146`): the single and trailing lines (`:141-143`) render `McpCallCard` for a
     Viewer call.
5. `src/components/feed/cards/ToolCard.tsx`: `MobileRunRow` (`:449-482`) prints the `describeMcpCall` title
   (through `useLocale`) for an event with `mcp`, and the summary otherwise.
6. `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts`: the new keys go inside the existing `mcp.*` block
   (en `:2412-2553`, uk `:2358-2499`): pending label, pending hint, replay, retryable, failure fallback.

`toolMeaning.ts`, `FeedItem.tsx`, `tools.ts` and `LiveTurnRows.tsx` need no change.

### States

Surfaces: the dock (`OrchestratorConversation`, collapsed tool policy, `ToolDisclosurePolicy` = `collapsed`)
and the conversation window (board policy). Widths: 1440, 900 and 390 px.

| State | Defining element | Dock, desktop | Conversation window, desktop | Phone, 390 |
|---|---|---|---|---|
| Named call | `McpCallCard` row: `MCP · VIEWER`, the `describeMcpCall` title, entity chip, outcome glyph, duration, time | standalone Claude calls, Codex direct calls and agent calls; inside an opened group for batch members | same | same row; enabled chip labels are icon-only ≤480 px (existing) |
| Group | `[data-tool-row=group]` header «викликів MCP: N», «✕k» when any failed | closed until tapped | settled: closed, open when it holds a failure (`CmdGroupCard.tsx:191`); live trailing run: open | board policy: 44 px fold row with the count; collapsed policy: as in the dock |
| Nested exec batch | represented wrapper hidden (`parse.ts:2558-2569`); members fold per D2 | group of named rows | same | same |
| Batch the parser could not pair (extra operations, more than `ORCH_MAX_CALLS`, non-literal calls) | the `exec` wrapper row stays, with its source-parsed list; the named children render too and fold with it | wrapper + named rows | same | same |
| Partial | the script failed (`Script failed`, an error) before every call it names returned | a batch of Viewer calls only: the wrapper row is hidden; each call that returned has its named row, and each call that never returned gets a named failed row with no result, the first carrying the script's error and any later one «Скрипт зупинився до цього виклику». A batch with any other operation keeps its wrapper row with its failure | same | same |
| Error | `data-state=error` row, danger glyph, the error line under it: `result.error`, else `error.message`, else the output text (e.g. «MCP error -32602: …»); localized «Retryable»/«Replay» | inside the group, header «✕k» | the group opens by default | failed-run block: each Viewer call is its named card, drawn once, its error line visible; only other calls keep a tap that opens their rows |
| Pending spawn, in flight | Claude, or a Codex direct call: the call's own row is the existing pending card (progress bar, spinner), with no link because there is no result. Codex batch: the `exec` wrapper row runs until its output lands, and the nested call itself appears only in the live overlay (`LiveMcpRow`, no link), because rollouts record no start for nested calls | same | same | same |
| Pending spawn, returned before its conversation exists | non-interactive chip with the visible word «запускається»/"starting" and a clock glyph; no outcome glyph after it, the tool icon in the pending tone | standalone | standalone | the word stays visible ≤480 px |
| Link | `<a data-testid=mcp-link-conversation href="#c=<id>">` «Відкрити агента»/«Відкрити розмову»; task and pipeline chips dispatch `llv:mcp-navigate` | standalone agent rows; entity chips inside opened groups | same | icon chip, ≥32 px on touch (existing) |

### Shared paths

- `ToolEvent.mcp` producers: the three Claude/Copilot/Codex-legacy paths (unchanged) and the two Codex
  paths added here. Consumers: `FeedItem.tsx:354`, `DecisionPointer`, `foldableTool`, `McpCallCard`, and the
  new `ReadableBlocks`/`MobileRunRow` branches. `src/lib/audio/toolCues.ts:46` walks group members already.
  `agentRecordAuthors.ts` only imports the type. No server code imports `buildFeed` (checked by grep), so the
  parser stays a browser-side path.
- `describeMcpCall` consumers: `McpCallCard`, `LiveMcpRow`, and the deputy note links (English default).
  The new branches change Claude's rows for those three tools too, from «Running MCP tool: …» to a title and
  a link. That is the intent: one renderer.
- `McpCallLink` gains an optional field. `LiveTurnRows`' own chip (`:194-232`) ignores it and keeps its
  behaviour.

### Authority, workspace access, text and attachments

No new route, fetch or capability. Links are URL fragments: `#c=` is encoded by `presentation.ts:92`, and the
existing router resolves it inside the member's own scope. A chip links only an id the availability set
already holds, which is built from the files this Viewer listed for the member. A transcript that names a
foreign or crafted id therefore gets a disabled chip, never a link. Arguments and results are what the
transcript already shows the member, bounded and redacted by `boundedMcpRecord`, the same as Claude rows. The
change does not touch message text or attachment paths (`normalizeCodexUserContent` at `parse.ts:756`, which
#3525 changed; `addCodexAssistant`; outbox rows), and tool `outputPreview` is computed as before.

### Tests (explicit paths only; isolated HOME, XDG_CONFIG_HOME, TMPDIR, LLV_STATE_DIR; `NODE_ENV=test` for React)

Each new case is shown red on 03730853 first: swap the pre-change production files into a scratch export, run
the head tests there, and leave the worktree alone. Fixtures use the production record shapes from the table
above, with invented ids, and no UUID-shaped values copied from a real rollout.

- `src/components/feed/mcpIdentity.parse.test.tsx` (or `parse.test.ts`):
  - a code-mode Viewer `McpToolCall` gets `mcp` and a parsed `mcp.result`; a `catalog` server stays generic
    (`codexReadable.parse.test.ts:86` stays green);
  - `status: "completed"` with `isError: true` is `err`;
  - a namespace `function_call` + `McpToolCall` + `function_call_output` is one named row with a result;
  - the July order (`function_call` namespace → `mcp_tool_call_end` → `function_call_output`) is one row with
    `mcp` and a result, and no `spawn` row is left at `run`; `mcp_tool_call_begin` after a `function_call`
    with the same id adds no row;
  - folding: three `exec-` Viewer reads make one `cmd-group`; `spawn_agent`, `send_message`,
    `send_message_to_orchestrator` and `publish_prototype_review` in the same batch stand alone; consecutive
    Claude Viewer calls and Codex direct calls stand alone; a 7/4/2 batch layout with one failure gives three
    groups whose members all carry `mcp`.
- `src/lib/mcp/presentation.test.ts`: the three new titles and links in en and uk, the stand-alone predicate,
  and the creates-conversation mark.
- `src/components/runtime/McpCallCard.dom.test.tsx`: the pending chip's visible word in en and uk; no anchor
  for an unavailable created conversation; the row glyph is not the success check; the upgrade to a link once
  `publishConversationAvailability` holds the id; uk «Replay»/«Retryable».
- `src/components/feed/cards/toolDisclosure.dom.test.tsx` or `CmdGroupCard.mobile.dom.test.tsx`: an opened
  group of Viewer calls renders one `[data-testid=mcp-call-card]` per member under the collapsed policy, the
  board policy and on the phone; the phone's failed block prints the described titles and holds no `<a>`.
- Re-run `mcpIdentity.parse.test.tsx`, `codexReadable.parse.test.ts`, `contextTokens.parse.test.ts`
  (`:273-281` pairs a `function_call` and an `McpToolCall` on one id), `copilot.parse.test.ts` and
  `liveTurnToolRows.dom.test.tsx`.

Command form: `bash <gate-slot> bun test <file>` from the worktree, with the isolated variables and
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. No full suite, typecheck or build in the stage.

### Rendered evidence: one case in the conversation-window driver

Add a fixture case `mcp-calls` to `src/components/conversation/conversationWindowEvidence.fixture.tsx` and one
`describe` («Viewer MCP calls read the same in Claude and Codex conversations») to
`src/components/conversation/conversationWindow.browser.test.tsx`. The model is the `agent-images` case
(fixture `:1218-1296`, driver `:1855-2010`): per-engine records → production `buildFeed` → `FeedItem`.

- **Records**, Claude and Codex, the same calls:
  - batch A: `list_tasks`, `get_pipeline`, and a failing `leave_lesson`
    (`{"ok":false,"error":"…","code":"tool_failed","retryable":true}`);
  - batch B: `spawn_agent` → `conversation_child_starting` (pending), `spawn_agent` →
    `conversation_child_ready`, `send_message` → `conversation_child_ready`, `send_message_to_orchestrator`,
    then `get_task`, `update_task`;
  - Codex only: a partial batch whose script failed after one of two calls, and a direct namespace call.
  - Codex batches are `exec` + `McpToolCall` + output; Claude records are `tool_use` + `tool_result`.
  - Each engine renders twice: plain (board policy) and inside `ToolDisclosurePolicy value="collapsed"` with
    `ConversationRoleScope value="orchestrator"` (the dock).
  - A live section renders `LiveTurnRows` with a running Codex `mcp__viewer__spawn_agent`.
  - Availability comes from the production `publishConversationAvailability` with
    `conversation_child_ready` and the seat peer only.
- **Frames**: 1440, 900 and 390 (touch) × en, uk × light, dark. At each, capture before and after opening
  every group. Write PNGs under `.artifacts/mcp-calls/` (not committed) and the readings to
  `evidence/mcp-calls/frames.json` (committed).
- **Readings and assertions** (behaviour, no prose matching beyond `translate(lang, key)`):
  - Codex batch members sit in groups whose header count matches.
  - The agent rows of both engines are standalone cards outside any `[data-tool-row=group]`.
  - The Claude section has no group holding a Viewer call.
  - Every opened member is a `[data-testid=mcp-call-card]` whose `[data-mcp-title]` equals the production
    `describeMcpCall(...).title` and does not start with «viewer ·».
  - The ready chip is an anchor with `href="#c=conversation_child_ready"`, and clicking it sets that
    `location.hash`.
  - The pending chip shows `translate(lang, "mcp.link.pending")`, and no anchor names
    `conversation_child_starting`.
  - The error row's line holds the error text; the partial batch shows no wrapper row, its returned call
    and the call it never finished as two named cards, the second carrying the script's error.
  - The live row has no conversation link.
  - `overflowX === 0`; titles are whole or end in an ellipsis with the full text in `title`; on touch,
    summaries are at least 44 px tall.
- **Regression for the shared card**: run `kanbanBoard.browser.test.tsx -t "cases i-v hold no internal
  noise"` (`LLV_KANBAN_BROWSER_TEST=1`) and `issue1671Evidence.browser.test.tsx -t "seat panel noise: cases
  i-v"` (`LLV_SWIPE_BROWSER_TEST=1`). Both should pass unchanged, because Claude rows do not fold.
- **Run**: through `gate-slot.sh` with `CHROME_BIN`, `LLV_CONVERSATION_BROWSER_TEST=1`, a private HOME,
  TMPDIR and state directory, the control URL on a closed port, and a short Chrome TMPDIR.

### What not to touch

- `LiveTurnRows.tsx`, `liveTurn.ts` and the runtime host: the live overlay already names Codex calls.
- The card's disclosure structure (Details, payload, link chips inside `summary`), the group header wording
  and `meaningfulToolGroup`, and `OrchestrationCard`/`NestedRow` (fence: no disclosure redesign).
- Message text, attachments, outbox and delivery UI: `TmuxComposer`, `NativeQueuePanel`,
  `RuntimeComposerReceipts`, the receipt stack (#3523's area).
- `src/lib/session/reader.ts`, the MCP server and bindings, and every route.
- Rendering of non-Viewer MCP servers. The Claude `tool_use` branch (`parse.ts:3614-3637`) except through the
  shared presentation.
- No live sends, no new agents, no new scripts or drivers, and no file named after an issue number.

### Overlap with open work (read 2026-10-31)

`main` moved one commit past the base (464b517, 2026-10-31 14:05 UTC), and it touches none of the files named
here.

- **a8de05b7 / #3523** (open, head b6b7581, lane in `needs_decision` on a spawn-lock error). Its 14 files
  include no feed, card, parser or presentation file. It shares the two driver files:
  - in `conversationWindowEvidence.fixture.tsx` it adds imports after `:69`, a union member after
    `"delivery-check-card"` (`:122`), `ConsumedDeliveryFixture` after `DeliveryCheckCardFixture` (`:1495`)
    and a switch line after `:1606`;
  - in `conversationWindow.browser.test.tsx` it adds a `describe` at `:2533`.

  Put this lane's hunks elsewhere: the union member after `"memory-cap"` (`:146`), the fixture function after
  `AgentImagesFixture` (`:1296`), the switch line after `:1614`, and the `describe` after the `#2075` block
  (`:2010`).
- **acbd334a / #3525** (text integrity) merged at 21f1e3d18 before this base. It changed only the Codex
  user-content join (`parse.ts:756`) and the session reader, so there is no conflict. Keep message text paths
  untouched.
- PRs #3552, #3545, #3508, #3506, #3493, #3491, #3396, #3265 and #3263 add to the kanban, phone or
  conversation-window drivers and to the i18n files. Keep additions inside this lane's own blocks. No open PR
  touches `parse.ts`, `CmdGroupCard.tsx`, `ToolCard.tsx`, `McpCallCard.tsx`, `presentation.ts`,
  `toolMeaning.ts` or `LiveTurnRows.tsx`.

## Risks

- **Browser memory.** Each Codex Viewer call now keeps a bounded `mcp` record (≤24,000 characters for the
  arguments and the same for the result, `parse.ts:945-970`), as Claude rows already do. Record the parsed
  feed's heap for the 2,247-line seat rollout before and after, in a scratch export (`bun:jsc`
  `heapStats`, three runs, same command), and report the delta. No gain is claimed.
- **The `exec-` marker** is a Codex id convention outside any published schema. It covers every nested item
  observed (45,469) and the parser already depends on it (`:2810`). If Codex renames it, batches render like direct
  calls, each standalone and still readable.
- **Within a batch, rows follow completion order** (`item_completed`). An agent row splits the batch's group
  where it lands; that is accepted to keep the link one click away.

## Deferred — not currently justified

- Folding Claude's consecutive Viewer calls (one rule across engines): it hides the b2 rows the operator kept
  on 2026-09-29. This needs their call.
- Links for `rotate_orchestrator`, `relay_answer` and `conversation_action`, and from a pipeline row to its
  stage conversations (`create_pipeline` links the pipeline).
- Codex native sub-agents (`collabAgentToolCall`, `subagentActivity`): Codex's own agents, outside the
  Viewer's spawn path.
- `NestedRow` printing a raw `mcp__viewer__…` method name in the dock (`OrchestrationCard.tsx:19`).
- The duplicate chip in `LiveTurnRows.tsx:194-232` (no pending word); `liveTurn.ts:222-231` ignoring
  `isError`.
- Links inside `summary` and 32 px touch chips in `McpCallCard`: an existing structure that a disclosure
  redesign would own.
- Naming actions in the group header instead of the count.

## Open questions

None block the build. D2 keeps Claude as it is. If the operator wants Claude's consecutive Viewer calls
grouped too, it is a change to one predicate plus the two seat-panel driver cases, and it reverses the b2
decision.
