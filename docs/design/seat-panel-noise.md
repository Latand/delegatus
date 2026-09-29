# Seat panel noise: launch-recovery text, the composer's effort, operator-irrelevant rows

## Originating requirement

Operator, 2026-09-29 ~21:10 UTC, in Ukrainian, about a screenshot of an
orchestrator's conversation panel (verbatim):

> баг вгорі червона хуйня, подивись на інше непотрібне, + наспраід мало б бути опус хай, і він там і є, але внизу селектотр показує як ніби нам лоу. треба фікс

Meaning, as the task records it:

1. A red internal diagnostic at the top of the panel must not be shown to the operator.
2. Look at the other things the operator does not need, and remove them.
3. The seat runs Opus at high effort (the header says `opus · high`), but the composer's
   model/effort selector says `Opus 5.5 · Легкі` (low). It must show what the conversation
   actually runs.

The task numbers these differently from the operator's order. This document follows the
operator's order: **point 1** is the red text, **point 2** is the selector, and **point 3**
is "other unneeded".

## What the screenshot shows (read directly as an image)

The dock panel of a project's orchestrator on a Claude seat, desktop width, light theme.
From the top:

- The header row: engine badge `Claude`, `opus · high`, the account badge, the 10 % context
  meter, the previous-seats chip (9), the reports target, the seat tick (`кожні 7 хв`),
  `Замінити` and `Зупинити хост`, and the predecessor glyph.
- **Red caption text, half hidden under the header**:
  `structured launch recovery: {"phase":"delivered","startedAt":…,"checks":6,"nextTryAt":…,"reason":"transcript publication pending"}`.
  The style (`text-caption font-semibold text-danger`, full row width) is the error span of
  `LaunchChips`.
- A right-aligned **user bubble** under the operator's own display name and dot. It holds the
  seat's mandate («You are this project's orchestrator in Delegatus …»), cut off with a
  `(25729 симв.)` expander.
- `6 попередніх кроків`: the `earlier` line of `LiveTurnRows`.
- Tool rows: `ToolSearch: select:mcp__viewer__get_task,mcp__viewer__get_pipeline,…` (wrench
  icon, "other" family), `MCP · VIEWER Opening task: <uuid>` with `Відкрити задачу`,
  `ToolSearch: select:mcp__viewer__spawn_agent`, a shell `ls -d … && git -C …` row, and
  `MCP · VIEWER Creating agent: architect · …` and `Updating task …: assigned`.
- Assistant prose: the seat's status note.
- The control strip (interrupt, re-check, compact, attach), the composer, and in its quiet
  row the pill **`⚡ Opus 5.5 · Легкі ▾`**.
- On the right, the report log column.

The order (launch chips, then the mandate bubble, then `LiveTurnRows`, with no transcript rows
above them) is the conversation tail from `orderedConversationTail`
(`src/components/conversation/tailOrder.ts:14`: `launch`, `outbox`, `delta`). So the frame
is the **launch window**, before the live transcript was adopted into the feed. The mandate
bubble is the launch-seeded outbox entry, and the steps are the live turn streamed from the
runtime host.

## Evidence gathered (read-only)

- The seat's launch receipt was read from the registry through a read-only handle, and nothing
  was written. It records `launchProfile.model = "opus"` and `launchProfile.effort = "high"`.
  Its claude process runs `… --model opus --effort high`, and its transcript carries
  `thinking` blocks from the fourth second on. **The source knows the seat runs high.**
- The same receipt **now** reads `state: "failed"` with
  `error: "structured spawn startup reached its 300000ms durable setup bound while session materialization was pending"`,
  while the seat conversation is alive and answering. So the red text in the screenshot has a
  successor: see §1.3.
- `/api/files` already projects the conversation's current `launchProfile.effort` onto the
  latest generation's row (`src/app/api/files/response.ts:501`). A spawn placeholder carries
  `receipt.launchProfile.effort` (`src/lib/agent/spawnProjection.ts:566`). The server hands
  the browser `high` on both kinds of row.
- `search_transcripts` (project-scoped, then unscoped; queries on the recovery text, the
  selector effort, and the mandate attributed to the operator) found nothing earlier than this
  task. Nothing prior to build on.

---

## Point 1: the red launch-recovery text

### Component and data path

1. The runtime parks durable recovery evidence in the receipt's **error** field, with a
   prefix: `STAGED_RECOVERY_PREFIX = "structured launch recovery: "`
   (`src/lib/runtime/structuredSpawn.ts:1786`). `writeStagedRecovery`
   (`structuredSpawn.ts:1806-1808`) writes `prefix + JSON.stringify(recovery)` through
   `registry.preserveSpawnArtifactOwnership` (`src/lib/agent/registry.ts:5857-5865`). The
   comment says why it uses `error`: older readers preserve it.
2. The launch read-model copies it verbatim:
   `cardState() → error: receipt.error` (`src/lib/agent/spawnProjection.ts:158`). That is
   `StructuredSpawnCardState.error` (`src/lib/types.ts:69`), sent as `file.spawn` or
   `file.launch` (`src/app/api/files/response.ts:284-290`).
3. `LogFeed` takes `launch = file.launch ?? file.spawn` (`src/components/LogFeed.tsx:302`),
   pushes the `launch` tail row (`LogFeed.tsx:1286-1290`), and renders `<LaunchChips>`
   (`LogFeed.tsx:1575`).
4. `LaunchChipsView` prints **any** `launch.error` in red, whatever the launch state
   (`src/components/conversation/LaunchChips.tsx:99-103`).

### Root cause

The error field has two meanings: a real failure reason, and the runtime's in-flight recovery
bookkeeping. The projection and the chip both treat every value as a failure to show. In the
frame, the launch state was healthy (`phase: "delivered"`, the first message delivered, only
the transcript's publication pending), yet the chip printed the JSON envelope in the danger
colour.

### 1.3 The same symptom, after the recovery budget

When the setup bound fires (`structuredSpawn.ts:2060-2066`), the receipt is marked `failed`
even though the host went on and the conversation lives. `transientLaunchFact`
(`spawnProjection.ts:386-397`) keeps a **failed** fact on the live window for 15 minutes
(`TERMINAL_SPAWN_RECENT_MS`, `spawnProjection.ts:9`). It retires only a **succeeded** fact on
evidence of an assistant turn. So the panel next shows a red "Launch failed" chip plus a raw
engineering sentence over a seat that is plainly working. The seat in the screenshot is in
exactly this state now.

### Exact change

1. **Projection: the recovery envelope never leaves the server as error text.** Move the
   envelope reader (`STAGED_RECOVERY_PREFIX`, `StagedLaunchRecovery`,
   `stagedLaunchRecovery()`) out of `structuredSpawn.ts` into a small pure module beside it
   (for example `src/lib/runtime/stagedRecovery.ts`). `structuredSpawn.ts` re-exports and
   imports it unchanged, so its writer, its readers and the pipeline engine keep their
   imports. The projection must not import the whole runtime spawn module. In `cardState`
   (`spawnProjection.ts:158`):
   - an envelope with `stopped !== true` → `error: null`. The chips already say what state the
     launch is in;
   - an envelope with `stopped === true` → `error: recovery.reason`. This is plain text,
     already redacted and capped at 240 characters by `stagedRecoveryFailureReason`
     (`structuredSpawn.ts:1820-1822`). Also project `recoveryStopped: true` on
     `StructuredSpawnCardState`, so the chip knows this is terminal while the receipt is still
     `path-pending`;
   - any other value → unchanged.
2. **Chip: a sentence, never the raw reason.** In `LaunchChipsView` (`LaunchChips.tsx:99-103`),
   render the error line only when `launch.state === "failed"` or `launch.recoveryStopped`.
   Its visible text is a new i18n sentence:
   - `spawnCard.failedDetail`, EN: "The agent could not be started."
   - UK: "Агента не вдалося запустити."

   The projected reason moves to the span's `title` (hover or long-press). That keeps the
   #1138 contract: the id and the reason stay available as the handle an operator quotes when
   chasing a failed launch (`LaunchChips.render.test.tsx:30-45` still passes on
   `toContain("host never bound")`). While a launch is healthy or pending, no error line
   renders at all.
3. **A failed fact retires on the same evidence as a succeeded one.** In `transientLaunchFact`
   (`spawnProjection.ts:392-396`), return `false` for a `failed` state too when
   `assistantTurnObserved(live, createdMs)`. If the conversation has answered since the launch,
   the launch evidently worked and the chip is not news. A launch that really failed has no
   assistant turn after it, so it keeps its chip, sentence and 15-minute window as today. A
   host that died later is covered by `DeadHostBanner`, which this change does not touch.

### States to cover

| State | Receipt / fact | Expected on the panel |
|---|---|---|
| recovery pending, healthy | `path-pending`, envelope `phase: delivered`, not stopped | state and first-message chips only; **no** red line; no JSON anywhere in the DOM |
| recovery pending, uncertain | envelope `phase: uncertain`, not stopped | same as above |
| recovery stopped (terminal) | `path-pending`, envelope `stopped: true` | red `Launch failed`/`Запуск не вдався` chip-row sentence "The agent could not be started." / "Агента не вдалося запустити."; reason only in `title`; no `{`/`"phase"` text |
| real failure, no conversation | `failed`, no assistant turn after launch | as the stopped row, unchanged 15-minute window, Retry where the surface offers it (board `BranchPane`) |
| stale failure, live seat (§1.3) | `failed`, assistant turn after launch | no launch chips at all |

Each row at desktop (the kanban seat and the side dock) and at 390 px (the phone focus view,
which mounts the same `BranchPane` → `LogFeed`), for a Claude seat and a Codex seat, in EN and
UK, light and dark.

### Must not be touched

- The envelope's storage format and its home in `receipt.error`
  (`structuredSpawn.ts:1784-1808`). Older readers and the pipeline engine
  (`src/lib/pipelines/engine.ts:1179, 3642, 3699, 4936-4954, 5003, 5716`) parse it there.
- The recovery algorithm (`recoverStagedStructuredLaunch`), the budget and the setup bound
  (`structuredSpawn.ts:1824-1900, 2055-2066`).
- `src/lib/runtime/structuredDeliveryQueue.ts`, `src/lib/runtime/codexAppServerHost.ts`, and
  the delivery/steering receipts another lane owns.
- `DeadHostBanner`, `ReceiptChip`, and the outbox failure line
  (`OutboxBubbles.tsx:174-230`): they carry human text already.

---

## Point 2: the composer's selector says low while the seat runs high

### Component and data path

- Header chip: `IncumbentHeader` reads the seat designation
  (`designated.effort`, `src/components/orchestrator/IncumbentHeader.tsx:88-90`) →
  `opus · high`. This is correct.
- Composer pill: `TmuxComposer` mounts `<RuntimePill file={file} …/>`
  (`src/components/TmuxComposer.tsx:4722`). On the structured surface its face is the
  browser-local `liveDraft` (`src/components/RuntimePill.tsx:424-436`: `face = liveDraft`
  unless `applyState === "error"`).
- `liveDraft` is written in only four places:
  - the `useState` initializer, `defaults(file)` at mount (`RuntimePill.tsx:154-155`);
  - the load effect, `readDraft(file)` (`RuntimePill.tsx:228-241`), which reruns **only when
    `engine`, `file.path` or `pillSurface` change**;
  - `commit`;
  - rollback.
- `defaults(file)` falls back to the **lowest tier** of the scale when `file.effort` is absent
  (`src/components/runtimeProfile.ts:56-63`, `efforts[0]`, which is `low` for both Claude and
  Codex). `readDraft` prefers a stored `llvAgentRuntime:<identity>` draft over the observed
  runtime (`runtimeProfile.ts:66-81`).
- The identity effect (`RuntimePill.tsx:252-261`) calls
  `adoptRuntimeProfile(previousIdentity, cardId)` (`runtimeProfile.ts:212-224`) whenever
  `cardId` changes while the pill is mounted. It moves every stored runtime key: the full
  draft, `:profile`, `:resume` and `:phase*`.

### Root cause

The server hands the right value (`high`) and the pill does not show it. The face is a
browser-local draft, and nothing reconciles it with the observed runtime once seeded. Two
confirmed code paths produce the frame's `Opus 5.5 · Легкі`:

1. **Frozen seed.** The draft is seeded once per path. If the first `file` the pill sees for
   a path has no effort yet, the pill stays on the lowest tier for the life of that path.
   Examples: a scanner row in the first seconds of a fresh seat, before a `thinking` block or
   a Codex `turn_context` exists, or a row that has not yet been joined to its registry
   generation. A later poll that carries `high` does not reach the face.
2. **Inherited draft across a rotation.** The dock's `OrchestratorConversation` is not keyed
   by seat (`src/components/orchestrator/OrchestratorPanel.tsx:769, 778`). A rotation
   therefore changes `cardId` under a mounted pill, and the identity effect moves the
   **previous seat's** stored draft and `:profile` onto the new seat. The previous seat here
   was a Codex seat. `readDraft` keeps a foreign draft's effort whenever that tier exists in
   the new engine's scale, and swaps its unknown model for the first catalog model. A Codex
   `{model: <gpt id>, effort: "low"}` therefore reads on a Claude seat as exactly
   `Opus 5.5 · low`. The next path change (the `spawn:` placeholder → the transcript path)
   reloads it. The composer's own draft adoption is safe because it only takes over from the
   previous owner of the **same path** (`TmuxComposer.tsx:1356-1368`). The pill's adoption
   has no such guard.

Path 2 is worse than a wrong label:

- `:profile` rides every structured send as the message's runtime
  (`sendRuntimeFrom`, `runtimeProfile.ts:195-204`, used at `TmuxComposer.tsx:2740, 3810`), so
  the operator's next message can reconfigure the new seat to the old seat's effort.
- `commit` and `pickAccount` build their reconfigure from `liveDraftRef.current`
  (`RuntimePill.tsx:464, 530`). A model or account pick from a frozen or inherited face sends
  `effort: "low"` along with it.

Which of the two paths produced this exact frame cannot be replayed: the operator's browser
storage and the `/api/files` payload of that moment are not recorded. The change fixes both,
and the tests below reproduce both.

### Options

- **A. Key the dock conversation by seat** (`key={seat.conversationId}` on
  `OrchestratorConversation`). This closes path 2 only for the dock. It also remounts the feed
  and composer on every rotation and changes what happens to a draft typed during a rotation,
  which is a product question. Path 1 stays. Rejected.
- **B. Server-only.** The server already projects the truth (`response.ts:501`), so there is
  nothing to fix there. Rejected.
- **C. Make the pill follow the observed runtime, and scope adoption to the same path.**
  Recommended. Two small changes in the pill and the profile module, with no new state.

### Exact change (option C)

1. **Structured face follows the observed runtime unless the operator's change is in flight**
   (`RuntimePill.tsx:228-241` and `424-436`):
   - The load effect, on the structured surface, seeds from `readDraft(file)` only when a
     stored phase is `pending`/`confirming` (an in-flight reconfigure restored after a
     remount). Otherwise it seeds from `defaults(file)`.
   - Add the observed runtime (`file.model`, `file.launchModel`, `file.effort`, `file.fast`)
     to that effect's dependencies. When `applyState` is `idle`, re-seed
     `liveDraft`/`liveDraftRef` from `defaults(file)` whenever those change. `commit` and
     `pickAccount` then build on what the conversation runs.
   - `applied` keeps the committed draft on the face until the observed runtime equals it
     (the next `/api/files` poll; the claim already wrote `generation.launchProfile`,
     `registry.ts:7450`), then returns to `idle`. This avoids a one-poll flicker back to the
     old value.
   - `saving`, `pending` and `confirming` are unchanged, and so is `error` (already
     `defaults(file)`).
   - The live-tmux (`live-root`) and resume surfaces are unchanged.
2. **Adoption only for the same transcript** (`RuntimePill.tsx:252-261`,
   `runtimeProfile.ts:212`): keep the previous `{identity, path}` in the ref, and call
   `adoptRuntimeProfile` only when the path is unchanged (a provisional id or alias
   canonicalizing onto the canonical id of the **same** transcript). This is the composer's
   own rule. A rotation changes both path and identity, so nothing is adopted and the
   predecessor's keys stay under the predecessor.
3. No server change. `response.ts:501` and `spawnProjection.ts:564-567` already carry the
   authoritative launch profile, including every applied reconfigure (`registry.ts:2277-2290`,
   written at claim time and rolled back on failure at `7483`).

### States to cover

- Claude seat launched `opus`/`high`:
  - the pill mounts on the `spawn:` placeholder, then the row moves to the transcript path;
  - the pill mounts first on a row with `effort: null`, and a later poll brings `high`;
  - a rotation from a Codex seat whose stored draft is `{gpt id, low}`.

  Every case → `Opus 5.5 · High` / `· Високі` (desktop) and `Opus 5.5 · high` (phone:
  `tierWord` uses tier ids, `RuntimePill.tsx:106-108`).
- Codex seat launched `high` → `<model> · High` under the same three sequences, with
  `fast` shown from the observed value.
- Changing it still works as today:
  - pick `medium` → the face shows `medium` at once (saving, pending), the reconfigure body
    carries `medium`, and after `applied` plus the next poll the face stays `medium` from the
    observed runtime;
  - a failed apply reverts to the observed runtime;
  - an account pick sends the **observed** model and effort, never a stale draft.
- The 390 px phone and the desktop, EN and UK, light and dark.

### Must not be touched

- The header chip and the seat status route: they are correct.
- `sendRuntimeFrom` and the sparse `:profile` contract (#241 finding 4: a display default is
  never persisted).
- The live-tmux reconfigure lifecycle and confirm-by-observation (`RuntimePill.tsx:326-331, 397-412`).
- `adoptComposerState`.
- The server-side runtime and reconfigure code (`structuredControls.ts`,
  `structuredReconfigure.ts`, and the fenced delivery queue).

---

## Point 3: "other unneeded"

### Candidates from the screenshot, classified

**(a) Internal noise: fix in this lane**

| # | Candidate | Evidence | Where it comes from |
|---|---|---|---|
| a1 | The seat mandate shown as the **operator's own turn**, under the operator's name and dot, as a 25 729-character bubble | The mandate is written by Delegatus (#1166 made the transcript render it as a Delegatus `MandateCard`). #2265 established that agent-delivered messages never render as the operator's turn. | In the launch window the bubble is the **launch-seeded outbox entry**: `seedLaunchOutbox` (`LogFeed.tsx:933-956`) → the outbox tail row → `FeedMessageRow` → `ConversationMessageRow`, whose sender is `provenance.senderForSubmission(entry.id) ?? me` (`src/components/conversation/OutboxBubbles.tsx:137-139`). A launch entry has no submission provenance, so it falls back to the signed-in member. |
| a2 | `ToolSearch: select:mcp__viewer__…` rows | Claude Code's deferred-tool schema loader: it fetches tool definitions and does no work the operator asked for. Two of the eight visible steps in the frame. Codex rollouts have no equivalent (the tool names in the day's rollouts contain none). | Live turn: `LiveTurnRows` → `liveTurnTail` (`src/components/conversation/LiveTurnRows.tsx:130-178`) lists any tool item. Transcript: the Claude `tool_use` branch of `parse.ts` registers every call (`src/components/feed/parse.ts:3093-3113`) as family "other" (`src/components/feed/tools.ts:259-270`). |
| a3 | The red recovery text | Point 1 | Point 1 |

**(b) Product judgement: not changed here; for the orchestrator to ask the operator**

| # | Candidate | Evidence and why it is a judgement call |
|---|---|---|
| b1 | Launch chips on a seat that launched fine (`Launched`, `First message: delivered`) and the 8-character launch id chip while a launch is pending | Transient by design (#569) and the quotable handle (#1138). They retire on the first assistant turn. Hiding them on seats only is a product call. |
| b2 | `MCP · VIEWER Opening task: <uuid>` / `Updating task <uuid>: assigned` rows naming a raw task id | The row carries an action (`Відкрити задачу`). Replacing the id with the task title needs a lookup and changes a shared MCP card. |
| b3 | Shell rows showing absolute paths (`ls -d … && git -C …`) | What the agent ran. Some operators want it. Hiding shell rows on seats is a product call. |
| b4 | `Creating agent: architect · <first words of the prompt>` | The MCP spawn card's summary. It quotes the operator's own requirement back, which may be wanted. |
| b5 | `6 попередніх кроків` line | The count of hidden live steps (#674). After a2 it no longer counts ToolSearch. Whether the seat needs the count at all is a product call. |
| b6 | Control strip icons: interrupt, re-check, compact, attach | Operator controls. Which of them a seat needs is a product call. |
| b7 | Header chips: previous seats (9), reports target, seat tick, account badge, context meter, `Замінити`, `Зупинити хост`, predecessor glyph | Each is a deliberate seat control from earlier issues (#1452, #1695, #2146). |
| b8 | The report log column beside the conversation | A deliberate split (#2146). |

### Exact change for (a)

- **a1 Mandate as Delegatus, collapsed, in the launch window too.**
  - Server: `/api/files` stamps `mandate?: MandateDelivery` on the launch facts and cards of a
    launch that is a seat's. Build the map once per response with
    `orchestratorMandateDeliveries(readOrchestratorSeatFile())`
    (`src/lib/runtime/deliveredMessageOccurrences.ts:108-127`; it already keys
    `spawn_<launchId>` to the seat that recorded the launch), degrading to none on an
    unreadable seat file exactly as `deliveredMessageOccurrences` does (`:211-219`). Pass it
    into `projectLaunchConversations` (`spawnProjection.ts:444`, called at `response.ts:284`)
    as an optional lookup, so `cardState` sets `mandate` beside `prompt`. Add the field to
    `StructuredSpawnCardState` (`types.ts:49`).
  - Client: in `LogFeed`, a launch with `mandate` does **not** seed an operator outbox bubble
    (`LogFeed.tsx:933-956` returns early). Instead, the `launch` tail row renders
    `<MandateCard item={{ kind: "mandate", ts: launch.promptAt, text: launch.prompt, mandate: launch.mandate }} />`
    above the chips (`src/components/feed/cards/MandateCard.tsx:30`; Delegatus mark, the
    mandate behind its "read" disclosure, copy button).
  - When the transcript is adopted, `launchFactsWithoutPrompt` drops `prompt`
    (`spawnProjection.ts:176-187`), and the transcript's own mandate row takes over as the same
    `MandateCard` through the #1166 occurrence join. That join already exists and is kept.
  - No operator name or dot appears on it in either window.
- **a2 Hide the schema loader.**
  - Add one exported predicate in `src/components/feed/tools.ts`:
    `isToolSchemaLoader(name) => name === "ToolSearch"`.
  - Transcript: in the Claude `tool_use` branch (`parse.ts:3093`), skip `registerCall` for it
    and record the id, and drop the matching `tool_result` in `addOutput`
    (`parse.ts:2150`, early return for a recorded id). That way no orphan `output:` service row
    appears where `showSvc` is on.
  - Live turn: `listable` and `steps` (`LiveTurnRows.tsx:124-150`) treat a
    `tool.name === "ToolSearch"` item as neither listed nor counted.
  - The raw transcript and the MCP `conversation_messages` output are unchanged: agents still
    read everything.

### States to cover (point 3)

- Launch window (a `spawn:` placeholder, prompt present, `mandate` set): a `MandateCard`, no
  operator bubble, no sender name. Also a launch with **no** seat mandate (an ordinary operator
  launch from the board), where the operator bubble is unchanged.
- Adopted window: exactly one `MandateCard` and no duplicate bubble during the handoff poll.
- A Claude live turn and a Claude transcript containing ToolSearch calls: no ToolSearch row,
  and the earlier-steps count excludes them. A Codex conversation is unchanged.
- The 390 px phone focus view and the desktop kanban seat and side dock, EN and UK, light and
  dark.

### Must not be touched

- The #2265 sender resolution for transcript rows (`messageProvenance.tsx`,
  `deliveredOccurrences.ts`) and the #1166 mandate join. They are reused as they are.
- The outbox's echo retirement and ownership (`outbox.ts`) for ordinary launches.
- Every (b) item above.

---

## Rendered evidence

Each evidence case goes into the driver that already exists for its surface (AGENTS.md,
"Rendered evidence"). No new driver file, and no file named after an issue.

- **Desktop:** `src/components/kanban/kanbanBoard.browser.test.tsx`, over
  `src/components/kanban/issue1695Evidence.fixture.tsx`, gated by `LLV_KANBAN_BROWSER_TEST=1`
  plus `CHROME_BIN`. Add one `describe` block, "seat panel carries no internal noise". Add a
  fixture scenario query (for example `?seatnoise=<case>`) that seats the orchestrator with:
  - (i) a Claude seat in the launch window whose launch fact carries a pending recovery
    envelope, `mandate`, and live-turn items including ToolSearch;
  - (ii) the same seat adopted, with a stale failed receipt and an assistant turn after it;
  - (iii) a terminal failure: a stopped envelope, and a `failed` receipt with no turn;
  - (iv) a rotation from a Codex seat whose stored draft is `{gpt id, low}` to a Claude seat
    launched `opus`/`high`;
  - (v) a Codex seat launched `high`.

  Frames at 1280 and 1440 wide, light and dark, EN and UK, for the kanban seat and the side
  dock. Assertions per frame:
  - no text matching `/structured launch recovery|"phase"|\{"/` inside `[data-orchestrator-panel]`;
  - `[data-launch-chip="error"]` absent in (i), (ii) and (iv), and in (iii) present with the
    sentence;
  - `[data-mandate-card]` present with no operator sender line on it;
  - no row whose text starts with `ToolSearch`;
  - the `[data-runtime-pill]` text ends with the high-tier label;
  - no horizontal overflow and no zero-width control.
- **390 px:** `src/components/mobile/issue1671Evidence.browser.test.tsx`, over
  `src/components/mobile/issue1671Evidence.fixture.tsx`, gated by `LLV_SWIPE_BROWSER_TEST=1`.
  Add one `browserTest` that opens the seat conversation in the focus view (`MobileFocusView`
  mounts the same `BranchPane` → `LogFeed` → `TmuxComposer` → `RuntimePill`) for cases
  (i)-(v) at 390×844, light and dark, EN and UK, with the same assertions. The pill face reads
  the tier id (`high`).
- The drivers' JSON records go to their existing `evidence/**` output directories.

Fast checks, by file path, each run with fresh `LLV_STATE_DIR`, `XDG_CONFIG_HOME` and
`TMPDIR` from `mktemp -d /tmp/…`:

- `src/components/RuntimePill.dom.test.tsx`: frozen seed, cross-rotation adoption, apply
  still working, account pick sending the observed profile.
- `src/components/runtimeProfile.test.ts`: `adoptRuntimeProfile` is not reached across paths.
- `src/lib/agent/spawnProjection.test.ts`: envelope → `null`, stopped → reason plus
  `recoveryStopped`, a failed fact retiring on an assistant turn, `mandate` on a seat launch.
- `src/components/conversation/LaunchChips.render.test.tsx`: the sentence, and raw text only
  in `title`.
- `src/components/feed/parse.test.ts` and
  `src/components/conversation/liveTurnOverlayBound.dom.test.tsx`: ToolSearch dropped and not
  counted.
- A `LogFeed` DOM case: a seat launch renders `MandateCard` and seeds no outbox bubble.

Then `tsc`, the i18n test (`src/lib/i18n/i18n.test.ts`, for the new EN/UK key), and
`bun scripts/privacy-publication-gate.ts --base <merge-base>`. Never sweep `src/lib/agent/` or
`src/app/api/runtime/`.

## Deferred: not currently justified

- **The runtime marks a launch `failed` at the setup bound while its host goes on and the
  conversation lives** (`structuredSpawn.ts:2060-2066`, seen on the seat in the screenshot).
  This lane stops the panel from showing it (§1.3). The receipt's lifecycle is runtime code
  next to the fenced delivery lane, so it is reported to the orchestrator, not changed here.
- The **board's** attention item and the kanban unstarted row still carry a failed launch's
  raw first error line as their header (`src/components/attention.ts:342`,
  `src/components/kanban/kanbanModel.ts:651`). A recovery envelope no longer reaches them after
  change 1.1, but a plain failed reason does. They are outside the seat panel, so they are left
  for a separate board item.
- The same operator-attribution of the **launch bubble** for conversations launched by an
  agent (an MCP `spawn_agent` from an orchestrator, a pipeline stage brief). It is the same
  mechanism as a1, but not on the seat panel the requirement names. Extending a1 to "any launch
  whose parent is an agent" is one more predicate once the operator wants it.
- Moving the recovery envelope out of `receipt.error` into its own field. It is cleaner, but
  it touches the runtime writer, the pipeline engine readers and older readers. The
  projection-level mapping gives the operator the same result without it.
- Keying the dock conversation by seat (option A above).

## Questions for the operator (none block this design)

The (b) table is the list: b1-b8, each with its evidence. The recommendation for every one is
"keep as is" unless the operator names it.
