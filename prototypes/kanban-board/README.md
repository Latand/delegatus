# Task board as status columns — critique and prototype

> **Originating requirement.** Operator, 2026-09-14, the assignment of this pipeline stage (architect, design mode), quoted verbatim; three private screenshots were attached and are described below, not reproduced:
>
> *"User complains one long vertical stack, clutter from empty assigned merge tasks and done tasks; slow Remove from board/status changes; no one-action hide whole task+child conversations/pipeline visuals; Details opens opaque Task history with confusing dropdown/search, no useful inline editing. Wants Kanban columns with deliberate spacing, easy navigation; optimistic status moves instantly between columns; one top-right X/menu hides entire group preserving history and data and EXCLUDING orchestrator; undo/failure rollback. Inline edit title/description, color selection, immediate editable status. Critique necessity of Details vs optional tucked-away history. Preserve stage graph context inside tasks; never equate empty conversation count with done. Distinguish task status, historical attempt status, visual hiding and worker control. No casual hide stops live workers. Accessibility keyboard/touch, responsive and long-title layout, pending/error/concurrent update behavior. […] Prioritize polished usable design over generic kanban."*

Issue: https://github.com/Latand/live-log-viewer-next/issues/1695 (the same content in Ukrainian, with the acceptance criteria and the cross-links).

This directory is the design answer. Nothing in product source changed.

| Path | What it is |
| --- | --- |
| `README.md` | This document: what the screenshots show, the critique, the options, the chosen design and why, what the prototype proves, acceptance, and what is deliberately not built. |
| `index.html` | The clickable prototype. Open it from the file system; no server, no build step, no dependency. `fixture.js` is invented, identity-free data; `styles.css` and `app.js` are the whole implementation. |
| `capture.ts` | `bun prototypes/kanban-board/capture.ts` renders every key screen at five viewports, light and dark, into `out/` (gitignored) and gates each frame; then drives eleven interaction flows headless and asserts what each must do. |
| `out/` | Gitignored: `out/<frame>/<scheme>/<screen>.png`, `out/flows/*.png`, `out/manifest.json` with the per-frame measurements. A browser render is not byte-deterministic and carries no provenance manifest, so it is regenerated, never committed. |

**How to look at it.** Open `index.html`. Add `?bench=1` for a strip with scheme, width presets (1440 · 1280 · 1024 · 768 · 390), latency, "fail the next save", reduced motion, and two simulations: an agent renaming the card you are editing, and a hidden task asking for a decision. Deep links: `?menu=<id>`, `?status=<id>`, `?edit=<id>`, `?editdesc=<id>`, `?hidden=<id,id>&tray=1`, `?colmenu=done`, `?drawer=<id>`, `?history=open`, `?q=<text>`, `?focus=<id>`, `?scheme=dark`, `?fail=status|hide|title|description|color|any`, `?latency=<ms>`, `?motion=reduce`. Keys on a focused card: `Enter` rename · `E` description · `S` status menu · `[` / `]` previous / next column · `H` hide · `M` actions · `C` colour · arrows move between cards and columns · `U` undoes the latest receipt · `/` finds a task.

---

## 1. What the three screenshots show

Loaded into vision directly, without OCR. Text below is what could be read from the renders; a phrase in quotes is confirmed, a paraphrase is not.

**Frame A — a light board, one column of bands, one expanded.** A dotted canvas about 1,300 px wide. Task bands stack in one left-aligned column roughly 615 px wide; more than half of the canvas to the right is empty. Every band carries the same anatomy: a title, a status pill ("assigned" or "done"), a counts line ("0 working · 0 conversations"), and three controls right-aligned: "Remove from board", "Details", "+ Agent". One "done" band is about 1,100 px wide because it holds a pipeline section: a tinted heading with the pipeline goal and a chevron, then a stage graph — an "Implementer waiting" tile, an arrow into a round marker "R1", a "Reviewer waiting" row reading "1 round ✓ APPROVE" with an engine chip and "4d ago". A lineage chip ("← Native queue adapter — …") overlaps the section's bottom border. The done band's title is a raw deployment report (a commit hash, a deployment identifier, a timestamp with words run together). A floating "+12" badge sits bottom-centre; "+ Agent · + Task · + Pipeline" float bottom-left.

**Frame B — the same board, further down.** Nine bands. Every one reads "0 working · 0 conversations". Seven say "assigned", two "done". Several titles end in a kind suffix ("· merge", "· verify", "· prepare"). The three controls repeat nine times. The left accent bars are different hues (green, purple, blue, pink) with no relation to status. The right half is empty again.

**Frame C — bands that hold a conversation, and the "Details" drawer.** A band with a member shows a white nested tile that repeats the band's title with a role suffix ("— builder", "— orchestrator"); such bands offer only "Details" and "+ Agent" (no "Remove from board"). The orchestrator lives in its own band titled with its raw prompt ("orchestrator · You are the viewer's built-in Manager…"). The Details click opened a right drawer titled "Task history": a "Task" dropdown listing tasks with counts, the task name, "assigned · 1 workers · 0 reviews · 0 executions", a collapsed "Original requirement", the note "Release associations are not recorded in this task history.", a search field "Find a worker or attempt", "1 records", one row ("… ↗ · worker · Assignment: linked"), and "Previous · 1 / 1 · Next". Nothing in the drawer edits anything.

Visual uncertainty: the zoom level and theme toggles are not visible; the meaning of "+12" is inferred (more items) and not confirmed.

## 2. What the code confirms behind each complaint

Read at `main` (`94655e9e`), files under `src/`.

| Complaint | Mechanism | Where |
| --- | --- | --- |
| One long vertical stack | `layoutTaskBands` places every band at `cursorY`, one under the other; empty bands may share a row only when the canvas fits several `minBandW` (620 px) bands, which a 1,300 px canvas with an orchestrator panel does not. Status is not a layout input at all. | `components/scheme/taskBands.ts` (`BAND`, the `cursorY` loop) |
| Empty "assigned" tasks read like work | `assigned` is stored task status and never changes on its own; the counts line is the only activity signal. The two concepts share one row and one typographic weight. | `lib/tasks/types.ts` (`TaskStatus`), `TaskBandsLayer.tsx` header |
| "Remove from board" is slow and comes and goes | `bandRemoveFromBoard` fires `updateTask(id, { board: "hidden" })` and returns; the band disappears only when the next tasks poll lands and the whole band stack re-lays out. The control renders only when `!bandHoldsMembers(band)`, so it appears and vanishes as members come and go. Undo exists only as «show on board» in the side task list. | `SchemeBoard.tsx` (`bandRemoveFromBoard`), `TaskBandsLayer.tsx`, `lib/tasks/boardVisibility.ts` |
| Status change is slow and indirect | The status pill click **cycles** inbox → assigned → blocked → done (`nextTaskStatus`), so assigned → done is two round trips through blocked. `taskHandlers.patch` awaits the server and re-renders from the poll; no optimistic state, no undo. | `SchemeBoard.tsx` (`bandCycleStatus`), `tasks/taskModel.ts` |
| No one-action hide for a whole group | Three unrelated mechanisms: the task's `board: "hidden"` flag (honoured only while the band is empty, by design, so a live conversation can never be lost), each conversation card's own board `close`, and a pipeline's `dismissedAt` (phone only, #1671/#1677). Nothing composes them. | `boardVisibility.ts`, `ProjectDashboard.tsx` (`prefs.hidden`), `lib/pipelines/types.ts` |
| "Details" is opaque | `TaskWorkflowPanel` is a read-only navigation surface: a task `<select>`, counts with a broken plural, a search over the rows, pagination by 30. It edits nothing by design ("never starts, retries, edits, or settles an execution"). | `components/tasks/TaskWorkflowPanel.tsx` |
| No inline editing on the desktop band | The band title is a button that opens the history drawer. Inline text editing exists on the phone sheet (`TaskSheet`) and on the legacy free-map card (`TaskCard`), not on bands. `PATCH /api/tasks/:id` already accepts `text`, `status`, `board`, `dueAt`, `expectedRevision`. | `TaskBandsLayer.tsx`, `TaskSheet.tsx`, `lib/tasks/commands.ts` |
| Colour means nothing | The accent is `hueFromId(task.id)` — a hash. No task field stores a colour. | `taskBands.ts`, `scheme/agentLinks.ts` |
| Raw prompts as titles | The #1586 refinement (3–10 word title on the agent's first action) is prompted, never guaranteed; when it does not happen the first line of the prompt is the title. | `docs/design/task-centered-board.md` |

## 3. Critique

1. **One axis carries everything.** Status, activity, recency and history are all encoded as vertical order in a single column, so the eye has to read every title and pill to answer "what is being worked on". The horizontal axis, which the operator's own request reserves for "deliberate spacing" and columns, is unused: more than half of every frame is empty canvas.
2. **Three different facts wear the same clothes.** *Task status* (what the operator decided), *activity* (whether an agent is on it now), and *attempt history* (what happened before) sit on one line in one weight. Nine "assigned · 0 working · 0 conversations" bands say either "someone forgot to finish this" or "this is queued for an agent"; the board cannot tell. The request's rule — never equate an empty conversation count with done — is exactly the ambiguity the current row invites.
3. **Controls are furniture.** Three identical buttons on every band make the chrome heavier than the content; on Frame B the buttons outnumber the words of information. A control that is offered only when an internal predicate holds ("Remove from board" on empty bands) leaks the rule instead of stating it.
4. **Mutations are fire-and-forget, then a full relayout.** No optimistic state, no undo, no error path on the band. "Slow" is the honest description: a click waits for a round trip, a poll and a relayout of hundreds of bands.
5. **Hide does not exist for the thing the operator looks at.** The operator sees a *group* (a task with its conversations and its pipeline); the code offers a per-task flag that refuses groups, a per-conversation close that ignores tasks, and a phone-only pipeline dismiss. The request for one control is a request for a **group-level presentation preference**, which is a new primitive, not a button.
6. **"Details" leads with the wrong thing.** The drawer opens on a *task selector* (navigation inside a detail view), then counts, then an apology for missing data, then a search over one record. The primary needs on a task — rename, describe, set status, add an agent, tidy — are absent. History is legitimate and must stay reachable; it is a secondary need and should be shaped as one.
7. **Titles are prompts.** A raw report or role prompt as the headline defeats a board. The card must clamp, must say "name pending" honestly, and must make renaming a one-click act.
8. **Colour is decoration.** A hash hue competes with the status colours and cannot be learned. A colour the operator *chooses* is a label; a colour the machine assigns is noise.
9. **Members repeat the headline.** The nested tile in Frame C shows the task's own title again with "— builder" appended, spending its space on the one thing the reader already knows.

## 4. Options

| Option | What changes | Verdict |
| --- | --- | --- |
| A. Keep the band stack; compact the empties and add quick actions | Empty bands become compact rows, controls collapse into a menu, moves become optimistic. | Cheapest; does not give the requested status columns, and a staffed board is still one stack. Kept as the fallback if columns are refused. |
| B. Classic kanban: four equal columns of small cards | Every task is a compact card; conversations and stage graphs move behind a click. | Familiar and the request's literal words, but it flattens the stage graph the request asks to preserve, and it is the conversion two earlier rounds rejected (§6). |
| **C. Status columns with a workspace column (chosen)** | Columns follow *task status*; the Assigned column is wide and keeps the band's internals — member tiles, pipeline section, stage graph, edges — inside each card. Shelf columns hold compact cards. Activity ranks cards inside a column and is shown as text with a dot, never as a column. | Answers every line of the request; keeps #1586's projection model and #1668/#1670's pipeline sections; incremental over the current bands rather than a competing redesign. |

**Why the column is status and not activity.** Activity changes on its own; a card that jumped columns whenever an agent paused would be unusable and would also encode "no agent" as "done". Status is the operator's decision, so a column change is an act, and it can be optimistic, undone and rolled back. Activity is a *label* on the card and an *order* inside the column: needs-you first, then the most working, then the most recently touched. The Assigned column adds one quiet divider, "Idle · N", between cards that hold an agent and cards that do not — that divider is the honest answer to "empty assigned tasks", and its "Hide idle" is the one-action tidy for them.

## 5. The design

### 5.1 Layout

```text
1440 wide
┌ atlas  ● 4 agents working · ● 1 needs you · 17 tasks ─────── [Find a task] [Hidden · 2] [+ Task] [+ Agent] ┐
┌ Inbox 3 ─┐ ┌ Assigned 7 · 3 working · 1 needs you ──────────────────┐ ┌ Blocked 2 ┐ ┌ Done 5 · 1 working ┐
│ card     │ │ ┌ Repair old links …                          × ⋯ ┐    │ │ card      │ │ card               │
│ card     │ │ │ ● needs you · 1 conversation                      │    │ │ card      │ │ card               │
│ card     │ │ │ [Implementer · needs you]                          │    │ └───────────┘ │ card               │
└──────────┘ │ │ [Assigned ▾] 17m ago                     + Agent │    │               │ card               │
             │ └───────────────────────────────────────────────────┘    │               └────────────────────┘
             │ ┌ Project manager seat                          🔒 ⋯ ┐  │
             │ ┌ Restore search results after the index rebuild  × ⋯ ┐ │
             │ │ ┌ Pipeline · goal · stage 2 of 3 ──────────────────┐ │ │
             │ │ │ [Implementer·finished] → (R1) → [Reviewer·working] → (R2) ⇢ [Verifier·planned] │
             │ │ │  ⤺ on fail · 2 rounds left                          │ │ │
             │ │ └──────────────────────────────────────────────────┘ │ │
             │ │ [Implementer · finished] [Reviewer · working]          │ │
             │ │ ▸ Round 1 · changes requested · 1h ago · 1 earlier     │ │
             │ ──── Idle · 3 ──────────────────────────── Hide idle ── │
             │ ┌ Merge the approved queue adapter release · merge  × ⋯ ┐│
             └────────────────────────────────────────────────────────┘
```

- Four columns, one per `TaskStatus`, in the order work flows: Inbox → Assigned → Blocked → Done. Shelf columns are 264 px; Assigned takes the rest (minimum 520 px) and keeps the board's dot grid, so the texture says "this is where the spatial content lives". Gutters 16 px, card gap 12 px, card padding 10/12 on a 4 px grid, two radii (8 controls, 12 surfaces), the Viewer's tokens in both schemes.
- **Card anatomy, top to bottom, each slot one fact:** title (2-line clamp, click to rename) with `×` hide and `⋯` actions top-right; description (click to edit; the workspace shows "Add a description" when empty); the **activity** line (`● 2 working · 3 conversations · 1 planned`, or `No agent on it` in muted text); the **pipeline section** with its stage graph, round markers and planned fail edge (workspace only, same content as today's band section); member tiles (role, engine dot, state word, latest line, age); the **history** disclosure (latest attempt in one muted line; expands to every attempt; "Open full history ↗" leads to the drawer); the footer with the **status pill** (the one place status is edited), the age, and `+ Agent`.
- The colour label is a 3 px bar on the card's left edge plus a swatch in the menu; it is chosen by the operator from nine named colours (`No colour` default) and stored on the task. Status is always text in a pill and a column; engine is a small dot on the member tile. Three carriers, three positions, no overlap of meaning.
- **Responsive.** ≥ 1400: the layout above. 1200–1399: shelves 220 px, Assigned ≥ 440 px. 768–1199: the four columns in a horizontal scroller with snap points (shelf 280 px, Assigned 480 px) under a jump strip naming each column with its count, because three readable shelves and a workspace do not fit a 1024 px grid. < 768: a segmented tab strip with counts, one column at a time; the bar drops its summary line (the tabs carry the counts) and gives the search its own row. On a coarse pointer every control is ≥ 44 px and the `×` is always visible (on a fine pointer it appears on hover or focus).

### 5.2 Interaction contract

| Act | What happens at once | What the server gets | If the server refuses |
| --- | --- | --- | --- |
| Change status (pill menu, drag to a column, `[` / `]`) | The card moves to the new column in the same frame; a 2 px saving bar runs along its top edge; receipt "Moved «…» to Done · Undo" | `PATCH {status}` | The card returns to its column, flashes once, error receipt "Couldn't save the status: … · Retry" |
| Hide a group (`×`, menu, `H`) | The card and everything inside it leave; the "Hidden · N" pill counts it; receipt "Hidden «…» · Undo" (with "· 1 agent keeps working" when true) | `PATCH {board: hidden, at}` | The group returns, error receipt with Retry |
| Hide idle / Hide finished (column menu) | Every eligible card leaves; one receipt with one Undo; the receipt says what was kept ("kept 1 with a working agent") | one `PATCH` per task | Each refused task returns on its own with its own receipt |
| Rename / describe (click, `Enter` / `E`) | An input replaces the text in place with no layout shift; `Enter` (or ⌘/Ctrl+Enter in the description) saves, `Esc` cancels, blur saves; a saving bar runs | `PATCH {text, expectedRevision}` | The old text returns, and a notice under it keeps the draft: "Not saved: … Your text is kept. · Retry · Discard" |
| An agent edits the card you are editing | A notice inside the card: "An agent changed the title while you edit: «…» · Use theirs · Keep mine". The field is never clobbered. When you are not editing, the card updates and flashes. | — | — |
| Colour (menu, `C`) | The bar and swatch change | `PATCH {color}` | Reverts with a receipt |
| Undo | The inverse mutation runs through the same optimistic path | the inverse `PATCH` | Same as any refusal |

**Protected card.** The project manager's card has no `×`; a lock glyph explains "The project manager stays on the board. Rotate or stop it from the orchestrator panel." Its menu shows "Hide from board" disabled with that reason; `H` answers with the reason. The server refuses the write as well.

**Hide is presentation.** It never stops, pauses or messages an agent, never closes a conversation, never touches a pipeline's state, worktree or transcripts. A hidden group keeps counting its working agents in the tray. A hidden task **comes back by itself** when it needs the operator (a decision request, a new conversation admitted to it after the hide), mirroring the phone board's rule for a dismissed lane (#1677): a hide is scoped to what the operator saw.

**Four things kept apart.** Task status: the column and the pill, changed only by the operator. Attempt history: the muted disclosure and the drawer, never the headline, never a column. Visual hiding: `×`, the tray, `board: hidden`. Worker control: stays on the conversation and stage tiles (stop, interrupt, message); no board action reaches it.

### 5.3 History, and what happens to "Details"

The "Details" button is removed. Its content survives in two places: the card's history disclosure (the latest attempt in one line; expands to all of them, with verdicts coloured only alongside their words) and the drawer behind "Open full history", which keeps the original requirement, the attempts and reviews, and the release/merge records when a pipeline publishes. The drawer loses its task `<select>` — it opens on the task you came from — and its search, which had one record to search. The unlinked-work view of the current drawer is a board-level concern and moves to a board menu entry, not a per-card control.

## 6. Prior work, read and weighed

`search_transcripts` was run in eight phrasings, project-scoped and unscoped ("kanban columns task board", "Remove from board slow status change", "Task history drawer", "task-centered board vertical stack clutter", "kanban" project-scoped, a Russian phrasing, the exact «Remove from board» band, "TaskWorkflowPanel"). Four earlier decisions bear on this one:

| When | What was decided | Weight today |
| --- | --- | --- |
| 2026-07-23, orchestrator mandate (Codex) | The operator's priorities asked that "cards for the same initiative stay spatially close and align in Kanban columns"; #290 then arranged tasks into readiness columns on the free map by hand, and #631 asked for MCP coordinates to do it programmatically. | The wish for status columns is three months old. #290's arrangement was a manual layout on a free canvas and was superseded by #1586's bands; #631 shrinks to "rank inside a column" once the column *is* the status. |
| 2026-08-09, benchmark against an Electron kanban session manager (Codex) | Recommended against a "fixed-column Kanban conversion": LLV's review loops, pipelines, handoffs and task links "carry operational meaning that fixed 288 px columns would flatten". | Right about the conversation layer, which is why option B is rejected. The chosen design keeps that layer inside a wide workspace column; only the *task* layer gets columns. |
| 2026-09-02, desktop-v2 rework (`docs/design/desktop-v2`) | Cut "the kanban of five columns" from a rejected prototype in favour of a spatial "yard"; the readiness sections survive only as packing order. | The yard is a design document, not shipped code; the bands are what the operator uses. This proposal is an increment on the bands and does not decide the yard. Where the two conflict, the operator decides, and this document says so in its issue. |
| 2026-09-09 → #1586 and 2026-09-10/11 repairs (#1614, #1627, #1668) | One full-width band per task, mandatory task binding, projection keys, anchored zoom; then `board: hidden` for empty bands, a band limit, and framed pipeline sections. A reviewer found «Remove from board» accepted-then-ignored and the predicate was fixed. | All kept: projection `(taskId, conversationId)`, one reader owner, recorded-relation edges, pipeline sections. The columns replace only the band stack's *placement policy*, which #1586 itself called reversible. |

## 7. What the prototype proves (and how)

`capture.ts` renders 11 screens × 5 viewports × 2 schemes and gates every frame on: no horizontal body overflow; four columns (or four tabs and one panel below 768 px); Assigned at least 1.6× a shelf's width from 1024 up; every title at most two lines; no menu or popover leaving the viewport; on coarse pointers no control under 44 × 44; no two visible controls overlapping; the protected card offering no hide control and carrying its explanation. It then drives eleven flows in one page and asserts each: the optimistic status move (client moved, server not yet), the saving state, the server catching up, undo reaching the server; a refused move rolling back with an error receipt; hide + undo; bulk hide keeping the card with a working agent and one undo restoring all; the protected card refusing by control, menu and key; a refused rename keeping the draft and retry saving it; the concurrent agent edit surfacing without clobbering the field; a hidden task resurfacing on a decision and sorting first; keyboard-only move, hide and undo with focus preserved; menu focus and Escape returning focus; the colour label. The run's result is in `out/manifest.json`; the frames are in `out/`.

## 8. Acceptance for the implementation

1. The desktop board draws four status columns; every `BoardTask` appears in exactly one, or in the hidden tray. The Assigned column's cards contain what a band contains today: member tiles, mirrors, pipeline sections with their stage graph, rounds and planned edges, drafts. The band projection model and single reader owner are unchanged.
2. Order inside a column: needs-you first, then working count, then `updatedAt`. Activity never moves a card between columns.
3. A status change from the pill menu, a drop on a column, or `[` / `]` moves the card before the request is sent; a refusal moves it back and shows an error receipt with Retry; success needs no poll to be reflected. Every move offers Undo for at least 7 s (paused while hovered or focused).
4. One control on the card hides the task with all of its representations on this board. It writes a stamped hide on the task, never a member's own hidden flag; a member that is also in another task stays visible there. Undo restores in place. The tray lists hidden tasks with their status and working count and restores each with one action. Hiding never sends any runtime or pipeline action.
5. The orchestrator seat's task cannot be hidden: no control, disabled menu item with the reason, server refusal. Bulk hides skip it and any task with a working agent, and the receipt says what was kept.
6. A hidden task returns by itself when a member enters "needs you" or a new conversation is admitted to it after the hide stamp, with a receipt saying why.
7. Title and description edit in place; `Enter`/`Esc`/blur semantics as above; a refused save restores the stored text and keeps the draft with Retry and Discard; a concurrent server change while editing is shown, never applied over the field; `expectedRevision` is sent and a 409 lands in the same notice.
8. Colour is a stored, named label (nine values including none), rendered as the card's edge bar and swatch, never the only carrier of status.
9. Per-card history disclosure with the latest attempt in one line; the full drawer opens from it, on that task, without a task selector; the "Details" band control is gone.
10. Keyboard: cards are focusable; arrows move between cards and columns; `Enter` `E` `S` `[` `]` `H` `M` `C` `U` `/` as listed; menus take focus and return it on Escape; receipts are `aria-live="polite"` and keyboard-reachable. Touch: ≥ 44 px targets, `×` always visible, the status menu as the drag alternative.
11. Responsive: the four layouts at 1440/1280/1024/768/390 as in §5.1; titles clamp to two lines with the full text in the editor; no body-level horizontal overflow at any width.
12. Capture: extend `scripts/capture-issue-1586-task-bands.ts` (or its successor) with the column frames and the flow assertions of §7, against a seeded synthetic home, light and dark.

## 9. Deferred — not currently justified

- **Renaming the statuses** (for example "Assigned" → "In progress"). The four stored values map 1:1 to columns; a rename is a copy decision that touches MCP schemas and the phone, and nothing in the request asks for it.
- **Persisted manual ordering inside a column** and drag-to-reorder. #1586 deferred a second pin system; the derived order (needs-you, working, recency) answers the request. Revisit if operators fight the order.
- **Swimlanes by colour or by agent.** Colour is a label; grouping by it is a filter, not a layout. A "Find a task" field is enough for now.
- **A separate "Unlinked work" surface** replacing the current drawer's unlinked view. It moves to a board menu entry with the same content.
- **The desktop-v2 yard, semantic zoom (#183), or any canvas redesign.** This is an increment on the bands; the yard remains its own decision.
- **Phone changes.** #1671/#1677/#1680 own the phone board; the hide semantics here deliberately match theirs so one rule covers both.
- **MCP placement coordinates (#631).** With status columns the remaining need is a rank; decide after the desktop ships.
- **Retention of task history (#1631)** and the 300-band limit (#1627): unchanged by columns; the hidden tray makes the "board full" remedy visible, which is all this design adds.
- **A "Done" auto-archive after N days.** The operator asked for one-action hiding with undo, not for the board to decide.

## 10. Validation against the requirement

| Request | Coverage |
| --- | --- |
| Kanban columns, deliberate spacing, easy navigation | Four status columns on a 4 px grid, 16 px gutters, 12 px card gap; keyboard and search navigation; tabs below 768 px |
| Optimistic status moves between columns | §5.2 row 1; flow 1 and 2 in `capture.ts` |
| One top-right × / menu hides the whole group, keeps history and data, excludes the orchestrator | §5.2 row 2; protected card; flows 3, 4, 5 |
| Undo / failure rollback | Every mutation is undoable from its receipt and rolls back on refusal; flows 1–6 |
| Inline title/description, colour, immediately editable status | §5.1 anatomy; flows 6, 7, 11 |
| Critique Details vs tucked-away history | §3 item 6, §5.3 |
| Preserve the stage graph inside tasks | Pipeline section in the workspace card, unchanged content |
| Never equate empty conversation count with done | Activity is a label and an order; "No agent on it" is explicit; the Idle divider names the case |
| Distinguish task status, attempt status, hiding, worker control | §5.2 "Four things kept apart" |
| No casual hide stops live workers | Hide is presentation only; the receipt and tray count working agents; resurfacing rule |
| Accessibility, touch, responsive, long titles, pending/error/concurrent | §5.1 responsive, §5.2 table, §7 gates and flows |
| Polished over generic | The Viewer's own tokens; one bold element (the stage graph inside the workspace column); everything else quiet |
