# Main test recovery audit

Baseline sweep: 5e545a112a94480fc90c1ba0a73a1ab8fbdde472. Integration base after #2400 and #2471: 5b046f54c74f64a5059a9914e374537975198cbe.

The external-relay baseline was 9 pass / 2 fail. Log inspection identified #2405 (311e47fd10fc78f2cd7ea1d5cd8e03f38c766a11): defaultModelFor(codex) changed from gpt-6-astra to gpt-6.1-sol. The product was correct; the two PATCH expectations were stale. After rebasing onto the Celestia merge, the section passes 21 tests, including the new pairing cases.

The first sweep ran 1254 test files under src/components, src/lib excluding src/lib/agent, and scripts, with one Bun process and separate temporary HOME/LLV_STATE_DIR/XDG_CONFIG_HOME per file, in chunks of 30 with at most three concurrent files. It excluded src/app/api/runtime entirely. Every file had a 180-second outer bound. Stateful sweep and TypeScript use the shared heavy-check lock.

That first pass found 148 nonzero files, including file timeouts. Its inherited TMPDIR was still below stage scratch and its child environment carried stage owner/capability and engine-home variables. The neutral rerun uses a separate /var/tmp TMPDIR, strips LLV_/DELEGATUS_/CODEX_/CLAUDE_ inheritance, sets fresh HOME/state/config/tmp roots per file, and builds the ignored MCP transport bundle first. It revisits every nonzero file in chunks of 20 with a 1200-second bound. Credential-backed engine acceptance is gated under the clean home. No result claims operator-state or physical-device acceptance.

The newly merged knownRelays file passes 5 tests, and merged OnboardingDialog passes 29. Changed test files are rerun individually after rebase. Architecture, lifecycle and scale assertions remain intact when their fixes need a larger follow-up. Fenced card, phone header, composer, pipeline store/engine and privacy files are unchanged by this branch.

## Failure catalog

Each entry retains the initial failing test names and gives the current outcome. A file-level timeout is a failing run whose completed cases do not establish the remainder. Cleared harness cases are recorded separately from code fixes. Follow-up causes describe the observed contract or prerequisite failure; complex ownership/storage defects still need a dedicated minimized reproduction before a production change.

### scripts/audit-with-retry.test.ts

**fixed** — 37 pass, 0 fail. Fixed product: Bun 1.4 changed transient audit HTTP diagnostics; exact endpoint/status matching restores retries and keeps permanent/mixed/advisory failures closed.

Initial failures:

- real Bun advisory endpoint responds with 503 then 200

- real Bun advisory endpoint responds with 503 then 503 then 503

### scripts/harness-ledger.test.ts

**cleared by neutral harness** — 22 pass, 0 fail. Harness: stage TMPDIR nested below state scratch triggers live-state guard. Neutral rerun uses /var/tmp TMPDIR and strips inherited owner/capability variables.

Initial failures:

- parsing > reads a copy, prefers the live collection over the archive, refuses a live state path

- parsing > the live-state guard refuses every app dir name and the staging sibling, with no marker files

- parsing > the live-state guard follows symlinks and refuses a directory a live writer holds

### scripts/npm-package-smoke.test.ts

**fixed** — 2 pass, 0 fail. Fixed drift: #2267 added tools/list_changed after initialization. Assert the exact response and notification.

Initial failures:

- all five bins of the packed package run, and the legacy names say so on stderr only

### scripts/privacy-media-workflow.test.ts

**follow-up** — 9 pass, 1 fail. Privacy fence: YAML trigger is on; assertion dereferences workflow.true.push.

Initial and remaining failures:

- main pushes populate the same cache without requiring a tracker number

### scripts/privacy-publication-gate.test.ts

**follow-up** — 515 pass, 31275 skip, 17 fail. Privacy fence: six placeholder/OCR-generation cases invoke Bun 1.4 while source-bound generator requires 1.3.3; eleven GitHub-media cases require absent tesseract. #2471 (468969434) moved the 31275-case relay matrix behind LLV_PRIVACY_RELAY_MATRIX=1; old pre-rebase runs hit 180/1200-second bounds. Current default suite: 515 pass, 31275 skip, 17 fail. Supply pinned generator/media prerequisites in its lane; preserve fail-closed media behavior.

Initial failures:

- privacy publication gate > regenerates source-bound placeholders deterministically

- privacy publication gate > accepts media reproduced by the trusted source-bound generator

- privacy publication gate > operator-approved public relay values > committed catalog: inspects gate and test source without marker collisions

Remaining failures:

- privacy publication gate > regenerates source-bound placeholders deterministically

- privacy publication gate > accepts media reproduced by the trusted source-bound generator

- privacy publication gate > exactOnly known values > OCR exactOnly=true contiguous=true

- privacy publication gate > exactOnly known values > OCR exactOnly=true contiguous=false

- privacy publication gate > exactOnly known values > OCR exactOnly=false contiguous=true

- privacy publication gate > exactOnly known values > OCR exactOnly=false contiguous=false

- privacy publication gate > audits authenticated GitHub issue, PR, comment, review, and media surfaces

- privacy publication gate > audits extensionless inline Markdown images

- privacy publication gate > audits Markdown images with escaped brackets in their descriptions

- privacy publication gate > audits HTML media across quoted and parse-error attribute delimiters

- privacy publication gate > audits slash-delimited HTML media attributes

- privacy publication gate > audits every extensionless source srcset candidate

- privacy publication gate > audits relative reference-style Markdown images

- privacy publication gate > audits escaped reference labels in Markdown images

- privacy publication gate > audits multiline reference destinations in Markdown images

- privacy publication gate > fetches entity-encoded GitHub media references for inspection

- privacy publication gate > resolves relative GitHub media references before trusted-host inspection

### scripts/publish-workflow.test.ts

**fixed** — 15 pass, 0 fail. Fixed drift: workflow uses exact ./bin and ./docs paths after 2d738a543; assertion expected bare paths.

Initial failures:

- the exact npm package is built before a narrow hermetic release gate

### scripts/runtime-host-viewer-adapter.test.ts

**cleared by neutral harness** — 34 pass, 0 fail. Harness prerequisite: build dist/mcp-server.mjs with isolated build:mcp before packaged transport tests. Persistent host/transport settlement errors need lifecycle follow-up.

Initial failures:

- documented bootstrap input obtains host-owned admission through the final MCP transport

- the first successor boot publishes and probes the MCP runtime after an old adapter deployment

### src/components/AccountBadge.render.test.tsx

**follow-up** — 3 pass, 1 fail. Header fence: static Hint assertion expects client-opened hover detail absent from SSR.

Initial and remaining failures:

- the full id, engine, and open affordance ride in the Hint / aria label

### src/components/BranchPane.mobileChrome.dom.test.tsx

**follow-up** — 0 pass, 2 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- the phone pane renders no conversation header at all: no chips, no disclosure, no inline strip

- desktop is untouched: both header rows stay inline, with no fold control

### src/components/BranchPane.relations.dom.test.tsx

**follow-up** — 0 pass, 3 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- the desktop pane reserves an in-flow relation strip that opens tasks both ways

- without relations or an opener the pane renders no strip

- the 390px production pane keeps the strip reserved and tappable

### src/components/BranchPane.render.test.tsx

**fixed through shared SpeakButton** — 7 pass, 0 fail. Shared product fix: SpeakButton previously dereferenced the null SSR snapshot. The unchanged pane suite now passes after the idle-phase fallback.

Initial failures:

- a running root mounts the strip (live-root) above a live composer

- a noComposer review round still mounts the strip but drops the composer

- a running subagent surfaces as live-subagent (enabled root-interrupt Stop lives here)

- a finished conversation surfaces as resume with an on-resume runtime slot

- a gated scanner-shaped subagent (inert) mounts no composer — no Send/quick-ack/mic/image path

- the full-window overlay (expanded) mounts the strip the same way

- the pending migration ribbon clears once the card already runs under the hold's target account

### src/components/BranchPane.spawn.dom.test.tsx

**follow-up** — 0 pass, 1 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- a never-started launch offers dismissal and no resume control (#1972)

### src/components/BranchPane.spawn.render.test.tsx

**fixed through shared SpeakButton** — 3 pass, 0 fail. Shared product fix: SpeakButton previously dereferenced the null SSR snapshot. The unchanged pane suite now passes after the idle-phase fallback.

Initial failures:

- issue 569: a queued launch renders the ordinary conversation window, not a status card

- issue 569: the materialized conversation keeps the launch as chips in the same window

- an owner action renders in the native pane header, above the feed's launch chips

### src/components/BranchPane.stageTitle.render.test.tsx

**fixed through shared SpeakButton** — 3 pass, 0 fail. Shared product fix: SpeakButton previously dereferenced the null SSR snapshot. The unchanged pane suite now passes after the idle-phase fallback.

Initial failures:

- a titleOverride names the pane and keeps the transcript's own title in the tooltip

- a renamable stage pane shows the imposed title and drops the inline rename pencil, by design

- without an override the pane keeps the transcript-derived title (every other surface)

### src/components/BranchPane.superseded.render.test.tsx

**fixed through shared SpeakButton** — 2 pass, 0 fail. Shared product fix: SpeakButton previously dereferenced the null SSR snapshot. The unchanged pane suite now passes after the idle-phase fallback.

Initial failures:

- a superseded card mounts the successor banner instead of the composer and dead-host recovery

- the successor card wears the round lineage chip deep-linking its predecessor

### src/components/EffortPills.slot.dom.test.tsx

**follow-up** — 3 pass, 4 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- desktop pane header: the bars ride the wrapping meta row beside the model chip, transform-free

- narrow scheme node (360px): the in-node pane keeps the bars in-flow with no inv-z paint scaling

- 390px MobileFocusView: reasoning telemetry is the merged model · reasoning text in the bar's meta line, never an overlay

- pane fallback badge: with model unknown, the desktop engine chip carries the effort tooltip

### src/components/LogFeed.deliveryUncertainty.dom.test.tsx

**follow-up** — 33 pass, 1 skip, 54 fail. Observed composer/delivery failure: bus.refresh() returns false at the receipt-polling assertion (test line 322), so later uncertainty/remount checks are not established. A stale snapshot/receipt mock contract is inferred, not proven; minimize that refresh boundary in the composer lane while retaining uncertainty controls.

Initial and remaining failures:

- textless failed receipt polling and remount retain unknown history, announcement and original controls

- textless uncertain receipt polling and remount retain unknown history, announcement and original controls

- each original operation keeps one recovery row through polling and remount ({"text":"Check the release status","terminal":"delivered"})

- each original operation keeps one recovery row through polling and remount ({"text":"Check the release status","terminal":"discarded"})

- each original operation keeps one recovery row through polling and remount ({"text":"","terminal":"delivered"})

- each original operation keeps one recovery row through polling and remount ({"text":"","terminal":"discarded"})

- each original operation keeps one recovery row through polling and remount ({"terminal":"delivered"})

- each original operation keeps one recovery row through polling and remount ({"terminal":"discarded"})

- authoritative failed/safe resolves unknown without dispatch

- authoritative rejected/safe resolves unknown without dispatch

- authoritative failed/not-needed resolves unknown without dispatch

- authoritative delivered/not-needed resolves unknown without dispatch

- real runtime bus ingestion refuses an older receipt after authoritative delivery

- late queued send callback cannot reverse authoritative success

- late failed send callback cannot reverse authoritative success

- late network send callback cannot reverse authoritative success

- accepted held response persists identity and settles by original operation without resend

- recovery response must name the original operation ({"method":"POST","mismatch":"conversation"})

- recovery response must name the original operation ({"method":"POST","mismatch":"key"})

- recovery response must name the original operation ({"method":"POST","mismatch":"operation"})

- recovery response must name the original operation ({"method":"POST","mismatch":"envelope"})

- recovery response must name the original operation ({"method":"DELETE","mismatch":"conversation"})

- recovery response must name the original operation ({"method":"DELETE","mismatch":"key"})

- recovery response must name the original operation ({"method":"DELETE","mismatch":"operation"})

- recovery response must name the original operation ({"method":"DELETE","mismatch":"envelope"})

- producer settlement delivered survives real journal ingestion and remount

- producer settlement discarded survives real journal ingestion and remount

- producer recovery persists across journal polling, switches and remount ({"outcome":"delivered","local":false})

- producer recovery persists across journal polling, switches and remount ({"outcome":"discarded","local":false,"text":""})

- producer recovery persists across journal polling, switches and remount ({"outcome":"delivered","local":false,"churn":true})

- producer recovery persists across journal polling, switches and remount ({"outcome":"safe","local":false})

- producer recovery persists across journal polling, switches and remount ({"outcome":"safe","local":true,"text":"Check the release status"})

- producer recovery persists across journal polling, switches and remount ({"outcome":"safe","local":false,"newerJournal":true})

- producer pending admission retains none through remount with pending immutable request

- producer pending admission retains image through remount with pending immutable request

- producer pending admission retains document through remount with pending immutable request

- producer queued admission retains none through remount with pending immutable request

- producer queued admission retains image through remount with pending immutable request

- producer queued admission retains document through remount with pending immutable request

- producer pending admission retains none through remount with pending immutable request with newer suffix

- producer pending admission retains image through remount with pending immutable request with newer suffix

- producer pending admission retains document through remount with pending immutable request with newer suffix

- producer queued admission retains none through remount with pending immutable request with newer suffix

- producer queued admission retains image through remount with pending immutable request with newer suffix

- producer queued admission retains document through remount with pending immutable request with newer suffix

- issue 1538: producer-admitted none send with its response still on the wire hydrates as unknown, sends once and settles by its receipt

- issue 1538: producer-admitted image send with its response still on the wire hydrates as unknown, sends once and settles by its receipt

- issue 1538: producer-admitted document send with its response still on the wire hydrates as unknown, sends once and settles by its receipt

- receiptless safe retry preserves selected context empty=false remount=%s

- receiptless safe retry preserves selected context empty=true remount=%s

- restored incomplete context fences safe local retry: undefined

- restored incomplete context fences safe local retry: {"version":1,"state":"selected","conversationId":"invalid"}

### src/components/LogFeed.launchReceiptChip.dom.test.tsx

**fixed** — 4 pass, 0 fail. Fixed harness: supply HappyWindow requestAnimationFrame/cancelAnimationFrame required by current speech geometry; retain behavioral assertions.

Initial failures:

- issue 1793: a rotation launch whose receipt says delivered never reads Delivering

- issue 1793: the launch bubble never doubles the transcript's own first user record

### src/components/LogFeed.liveToolRows.dom.test.tsx

**fixed** — 5 pass, 0 fail. Fixed harness: supply HappyWindow requestAnimationFrame/cancelAnimationFrame required by current speech geometry; retain behavioral assertions.

Initial failures:

- the first live turn shows tool calls interleaved with prose before the transcript has read anything

- once the transcript echoes the calls, the live tool rows yield without duplicates and the order stays stable

- a live tool row newer than every transcript record still yields to the row that carries its call id

- issue 1100 review: the status bar names the newest RUNNING tool, not a later parallel call that already settled

- issue 1565: streamed old tools leave the tail when a later turn owns the transcript window

### src/components/LogFeed.outboxTailOrder.dom.test.tsx

**fixed** — 10 pass, 0 fail. Fixed harness: supply HappyWindow requestAnimationFrame/cancelAnimationFrame required by current speech geometry; retain behavioral assertions.

Initial failures:

- a delivered bubble whose echo was missed cannot render below newer transcript rows

- a delivery newer than the whole transcript still renders its bubble at the tail

- issue 616: direct 202-to-live builder adoption renders only the scaffolded transcript echo

- issue 616: direct 202-to-live reviewer adoption renders only the scaffolded transcript echo

- mounted composer and feed preserve chronology for a late delivered receipt (valid)

- mounted composer and feed preserve chronology for a late delivered receipt (missing)

- mounted composer and feed preserve chronology for a late delivered receipt (scaffolded-echo)

- mounted composer and feed preserve chronology for a late queued receipt (valid)

- mounted composer and feed preserve chronology for a late delivering receipt (valid)

- mounted composer and feed preserve chronology for a late uncertain receipt (valid)

### src/components/LogFeed.spawnPathFlip.dom.test.tsx

**fixed** — 4 pass, 0 fail. Fixed harness: supply HappyWindow requestAnimationFrame/cancelAnimationFrame required by current speech geometry; retain behavioral assertions.

Initial failures:

- first turn, card still spawn:<launchId>, runtime session names the artifact: the one tail reads it at once, canonical rows land during the spawn phase, live tool rows retire once, and the later card flip neither re-subscribes nor duplicates

- a placeholder whose host has not named an artifact yet reads nothing and shows the host-stream rows; the tail follows the card's spawn → artifact flip on its own: canonical rows land, live tool rows retire once, no duplicates

- an image-only roleless launch retires its launch-owned delivering bubble when the live transcript is adopted

- an image-only role launch retires its launch-owned delivering bubble when the live transcript is adopted

### src/components/OverviewBoard.kanban.dom.test.tsx

**follow-up** — 10 pass, 2 fail. Board fence: bare historical tasks in old fixtures lack current board membership and completed-card projection omits them.

Initial and remaining failures:

- the Overview's bar keeps its three facts; the project board's bar, put in order (#1801), says each once

- the Overview draws no seat card and counts no seat task as hidden (#1841)

### src/components/ProjectDashboard.backgroundTaskDock.dom.test.tsx

**follow-up** — 1 pass, 1 fail. Board fence: background-task strip moved into host sheet/orchestrator surface; dashboard text is stale.

Initial and remaining failures:

- two live parentless background tasks draw no strip and leave the board origin where it was

### src/components/ProjectDashboard.headerBar.dom.test.tsx

**follow-up** — 20 pass, 4 fail. Board/phone fence: mocked runtime settings view lacks known array; view.known.some throws and aborts mounting.

Initial and remaining failures:

- narrow, the bar keeps one row: icons, one + with both creators, and the accounts behind ⋯

- Undo and Redo are gone from the header, its ⋯ and Ctrl+Z, even with a close in the log (#1856)

- ⋯ draws no rule next to a group with nothing in it

- `/` and `u` keep their meaning on the Viewer's controls the bar brought into the board

### src/components/ProjectDashboard.launchClaim.dom.test.tsx

**follow-up** — 1 pass, 1 fail. Board fence: failed-delivery fixture does not meet current launch-claim visibility/openability contract.

Initial and remaining failures:

- a failed-delivery launch record on a scanned transcript path never hides the conversation

### src/components/ProjectDashboard.shelf.dom.test.tsx

**follow-up** — 4 pass, 1 fail. Board/phone fence: mocked runtime settings view lacks known array; view.known.some throws and aborts mounting.

Initial and remaining failures:

- mobile: the project name is the bar's title cell and the host sheet stays one row behind ⋯ (finding 2)

### src/components/RuntimePill.limitAccounts.dom.test.tsx

**follow-up** — 8 pass, 1 fail. Header fence: localized account/model/effort labels differ from old raw wording.

Initial and remaining failures:

- with no limit the account group is still there, naming the account the conversation runs on

### src/components/RuntimePill.persistence.dom.test.tsx

**follow-up** — 1 pass, 1 fail. Header fence: localized account/model/effort labels differ from old raw wording.

Initial and remaining failures:

- mounting the pill on structured never rewrites the persisted draft

### src/components/TelegramReports.render.test.tsx

**fixed** — 18 pass, 0 fail. Fixed drift: report editor names Delegatus; #916 also requires titled launch profiles.

Initial failures:

- the prompt editor is a plain textarea with save and reset, and states the fixed preamble

- a save the editor could not complete is announced in the editor

- after a reload, a run the history row cannot name is still linked from the durable marker

### src/components/TmuxComposer.liveRefreshFocus.dom.test.tsx

**follow-up** — 3 pass, 5 fail. Composer fence: current capability/readiness and durable outbox contract differs from older DOM/runtime/storage mocks (missing textarea, labels, recovery state or stale-key reconciliation).

Initial and remaining failures:

- [desktop] a board/feed refresh mid-IME-composition never wipes the composing word or moves the caret (real owner, node identity held)

- [desktop] a mid-string selection, focus, draft, attachments, and runtime choice survive a surface-resolving refresh (real owner)

- [390px mobile] a mid-string selection, focus, draft, attachments, and runtime choice survive a surface-resolving refresh (real owner)

- [desktop] a background board reorder keeps focus, caret, and the textarea node on the typed pane (real NodesLayer keying)

- [negative control] the reenacted historical remount mutation turns the identity assertion RED

### src/components/TmuxComposer.runtimeSnapshot.dom.test.tsx

**follow-up** — 8 pass, 8 fail. Composer fence: current capability/readiness and durable outbox contract differs from older DOM/runtime/storage mocks (missing textarea, labels, recovery state or stale-key reconciliation).

Initial and remaining failures:

- structured recovery state is bounded and exposes retry details

- late receipt snapshot preserves delivery time across replay and remount

- delivered snapshot with missing time waits for valid settlement evidence

- delivered snapshot with invalid time waits for valid settlement evidence

- delivered snapshot with future time waits for valid settlement evidence

- delivered snapshot with before-submission time waits for valid settlement evidence

- delivered snapshot with before-admission time waits for valid settlement evidence

- queued send settles from a later snapshot without resending or re-aging

### src/components/TmuxComposer.sendReadiness.dom.test.tsx

**follow-up** — 4 pass, 2 fail. Composer fence: current capability/readiness and durable outbox contract differs from older DOM/runtime/storage mocks (missing textarea, labels, recovery state or stale-key reconciliation).

Initial and remaining failures:

- the codex Viewer-launched conversation carries the model chip INSIDE the composer box

- the claude Viewer-launched conversation carries the model chip INSIDE the composer box

### src/components/TmuxComposer.staleKey.dom.test.tsx

**follow-up** — 1 pass, 1 fail. Composer fence: current capability/readiness and durable outbox contract differs from older DOM/runtime/storage mocks (missing textarea, labels, recovery state or stale-key reconciliation).

Initial and remaining failures:

- a remount cannot stamp a stale unresolved generation's key onto the operator's new message

### src/components/Viewer.overviewPhone.dom.test.tsx

**follow-up** — 5 pass, 6 fail. Board/phone fence: reader fixture never reaches expected screen; switching also raises measure-before-initialization. Reconcile membership and mount sequencing.

Initial and remaining failures:

- the Needs-you sheet over the Overview opens its conversation full screen over the Overview

- a screen the Overview cannot place sends the stack home, and the next card still opens its task

- the Overview's ⚠ counts what its tabs mark, and a lane in its sheet opens the pipeline screen

- a conversation opened from a task screen over the Overview keeps the Overview's scope, and ‹ walks back through the stack

- Forward and a reload bring a conversation back over the Overview

- a search result on the Overview opens its conversation over it, and ‹ comes back to the Overview

### src/components/Viewer.switching.dom.test.tsx

**follow-up** — 3 pass, 8 fail. Board/phone fence: reader fixture never reaches expected screen; switching also raises measure-before-initialization. Reconcile membership and mount sequencing.

Initial and remaining failures:

- desktop: an in-app «Open conversation» link focuses the target's reader without rebuilding the board

- desktop: a cross-project link switches the project, then focuses — from the last known catalog

- desktop: a project switch paints the revisited board synchronously and never remounts the dashboard

- desktop: moving the focus between readers re-renders only the readers whose focus changed

- desktop: a fresh tail record in one reader leaves the other readers' panes untouched

- phone: A → B → A through the board shows A's previous rows synchronously, then the fresh tail lands without a flash

- phone: a bar swipe never walks Recent — it bumps, and the switcher row is the hop

- phone: switching project through the project sheet paints the revisited board from cache

### src/components/Viewer.test.ts

**follow-up** — 9 pass, 1 fail. Board fence: files URL now explicitly requests view=summary.

Initial and remaining failures:

- a resolved capped-out catalog open remains pinned after its hash intent clears

### src/components/attention/MobileAttentionSheet.dom.test.tsx

**follow-up** — 9 pass, 1 fail. Phone/attention fence: model display now says Opus 5.5 instead of old label.

Initial and remaining failures:

- a permission row puts its long headline on a truncated line of its own and keeps the age on the meta line (#2215)

### src/components/conversation/issue626Lifecycle.test.ts

**follow-up** — 5 pass, 1 fail. Conversation lifecycle follow-up: adopted live-turn ownership/refresh state differs from old fixture; handoff retention or stalled-row progress fails. Validate transcript and host evidence together.

Initial and remaining failures:

- issue 626 refresh after turn completion retains both handoffs until adopted feed ownership

### src/components/conversation/liveTurnStallPath.dom.test.tsx

**follow-up** — 0 pass, 1 fail. Conversation lifecycle follow-up: adopted live-turn ownership/refresh state differs from old fixture; handoff retention or stalled-row progress fails. Validate transcript and host evidence together.

Initial and remaining failures:

- a degraded runtime does not stall the transcript; a paused tail does, and the overlay stays bounded through it

### src/components/feed/senderLine.dom.test.tsx

**fixed** — 5 pass, 0 fail. Fixed drift: sender role display is localized Reviewer; retain no person attribution.

Initial failures:

- an agent's relay keeps its internal card and names no person

### src/components/flows/RoundDeck.strip.dom.test.tsx

**follow-up** — 0 pass, 3 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- an in-progress round mounts the strip (live-subagent) above a composer

- a finished round keeps the strip but drops the composer

- a headless flow drops the composer even for an in-progress round

### src/components/kanban/KanbanAccounts.dom.test.tsx

**follow-up** — 16 pass, 1 fail. Board fence: localized verifier label is Verify.

Initial and remaining failures:

- a conversation switches with the header's reconfigure; an account outside the project's is offered and recorded, and with no runtime plane the switch waits for the turn with its target known to this page only

### src/components/kanban/KanbanBoard.dom.test.tsx

**follow-up** — 17 pass, 3 fail. Board/phone fence: old card/status/chrome selectors and membership fixtures yield absent nodes or changed counts.

Initial and remaining failures:

- four columns hold every task; an empty task taken off the board is counted, never dropped

- the mouse resting in a narrow column widens it after the dwell, with the cue on the way; a menu or a pin holds it

- on a large screen a project board balances its columns; narrow, scroll, tabs and the Overview keep theirs

### src/components/kanban/KanbanEditing.dom.test.tsx

**follow-up** — 17 pass, 7 fail. Board/phone fence: old card/status/chrome selectors and membership fixtures yield absent nodes or changed counts.

Initial and remaining failures:

- × hides the group at once with a receipt and Undo, focus moves to the next card, and no assignment port is called

- Hide finished tasks keeps working and seat groups, writes one task at a time, reports each refusal, and one Undo brings the rest back (en)

- Hide finished tasks keeps working and seat groups, writes one task at a time, reports each refusal, and one Undo brings the rest back (uk)

- an Undo of Hide finished tasks that fails for several groups counts them, with Retry

- the Hidden tray lists hidden groups, empty tasks and closed conversations, and each comes back from it

- after hide and Undo, a poll that left before the Undo keeps the card on the board and focused

- an Undo the server refuses takes back its success receipt and offers Retry

### src/components/kanban/KanbanOpenableConversations.dom.test.tsx

**follow-up** — 4 pass, 1 fail. Board fence: failed launch now renders retry/error controls instead of old openable-conversation copy.

Initial and remaining failures:

- a failed launch shows at once with its error, opens its launch view, and counts as no conversation

### src/components/kanban/KanbanPipelines.dom.test.tsx

**follow-up** — 31 pass, 1 fail. Pipeline fence: fail-edge explanation includes retry-round/continuation state; copy assertion is stale.

Initial and remaining failures:

- a fail edge takes no slot in the lane row: silent at rest, and a suffix on the failing pill once it fires (#1798, #2072)

### src/components/kanban/KanbanReaders.dom.test.tsx

**follow-up** — 13 pass, 2 fail. Board/phone fence: old card/status/chrome selectors and membership fixtures yield absent nodes or changed counts.

Initial and remaining failures:

- a conversation the Viewer is asked to open while the kanban shows opens as its card's reader

- closed never-started launch is dismissible through the task reader's normal chrome (#1972)

### src/components/kanban/KanbanUndo.dom.test.tsx

**follow-up** — 20 pass, 1 fail. Board/phone fence: old card/status/chrome selectors and membership fixtures yield absent nodes or changed counts.

Initial and remaining failures:

- a hide: Ctrl+Z brings the group back, Ctrl+Y hides it again

### src/components/layers.test.ts

**follow-up** — 5 pass, 1 fail. Board attention fence: AttentionPanel contains raw z-50 outside the shared layering scale; guard is correct.

Initial and remaining failures:

- one layering scale > no component under src/components uses a raw z-index outside the scale module

### src/components/mobile/MobileBoard.dom.test.tsx

**follow-up** — 12 pass, 1 fail. Board/phone fence: mocked runtime settings view lacks known array; view.known.some throws and aborts mounting.

Initial and remaining failures:

- the board has no Host section: background processes are rows in the host sheet behind ⋯

### src/components/mobile/MobileFocusView.badges.dom.test.tsx

**follow-up** — 0 pass, 2 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- the phone conversation screen mounts no absolutely-positioned desktop badges over the feed at 390 × 844

- the ⋯ menu lists the child as an in-flow row that opens the current non-archived generation

### src/components/mobile/MobileFocusView.keyboardInset.dom.test.tsx

**follow-up** — 4 pass, 2 fail. Phone/composer fence: current viewport budgets cap drafts at 143px/67px; fixed-160px expectation needs geometry validation.

Initial and remaining failures:

- integrated, portrait keyboard: long draft caps at 160px and the chrome fits (#983 round 2)

- integrated, a 280px visible viewport: the whole composer unit still fits it (#983 round 2, #1483)

### src/components/mobile/MobileFocusView.strip.dom.test.tsx

**follow-up** — 0 pass, 1 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- the phone renders no inline control strip: every control is a labelled 44 px row in the conversation menu

### src/components/mobile/MobileFocusView.superseded.dom.test.tsx

**follow-up** — 0 pass, 2 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- a focused superseded round shows the banner with 44px actions and mounts no composer at 390px

- the focused successor keeps its composer and reaches its predecessor from the menu at 390px

### src/components/mobile/MobileShell.board.dom.test.tsx

**follow-up** — 2 pass, 8 fail. Board/phone fence: mocked runtime settings view lacks known array; view.known.some throws and aborts mounting.

Initial and remaining failures:

- no docked task rows on the phone: a background process is host data in the host sheet behind ⋯ › Host details

- ⋯ opens the board menu over the board with every former header control as a row, in the design's order

- both board faces stay one tap away inside the menu, announced as radio rows, and still switch the board

- ⋯ › Pipelines opens the pipelines list, the one the columns' old «N pipelines» row opened (#2072 slice 4)

- Undo and Redo are not menu rows, even with a close in the device-local log (#1801; kanban undo is #1856)

- Accounts & limits pushes the shell's accounts screen; ‹ returns to the board

- Archive project acts on the tap and answers with a receipt whose Restore unarchives

- an archived project offers Unarchive instead, and a project with a live agent offers neither

### src/components/mobile/MobileTaskScreen.entry.dom.test.tsx

**follow-up** — 4 pass, 3 fail. Board/phone fence: mocked runtime settings view lacks known array; view.known.some throws and aborts mounting.

Initial and remaining failures:

- the ⋯ › Tasks list opens the task screen, and ‹ from the task finds the list again

- a pipeline screen's linked task opens the task screen

- the Tasks list goes with a navigation that sends the stack home, and does not come back over the board

### src/components/mobile/directReviewDeck.dom.test.tsx

**follow-up** — 4 pass, 1 fail. Phone/pipeline fence: collapsed verdict-chip height/classes changed; verify tap target with existing driver.

Initial and remaining failures:

- a terminal direct group rides the phone as a tappable collapsed verdict chip that expands to every round (#289+#325)

### src/components/mobile/issue1347Evidence.browser.test.tsx

**follow-up** — 0 pass, 1 fail. Phone/privacy evidence fence: archived image is zero bytes, while assertion requires more than 10000.

Initial and remaining failures:

- issues 1347 + 1348: the phone's rename editor and orchestrator controls measure as usable at 390px in both themes

### src/components/mobile/mobileHeaderFit.dom.test.tsx

**follow-up** — 1 pass, 5 fail. Board/phone fence: old card/status/chrome selectors and membership fixtures yield absent nodes or changed counts.

Initial and remaining failures:

- the 390px header row keeps one elastic cell — the project name — and fixed 44px targets (#613)

- both board faces stay one tap away inside the «more» menu and still switch the board (#613)

- Undo and Redo are not «⋯» items, even with a close in the device-local log (#1801; kanban undo is #1856)

- «Keep screen awake» is one tap inside the «⋯» menu and holds a real sentinel (#712)

- the wake-lock row never becomes a sixth 44px target on the header row (#712)

### src/components/mobile/mobileOrchestratorControls.dom.test.tsx

**follow-up** — 0 pass, 11 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- a live seat's pinned row carries a VISIBLE controls entry point beside the chip, at a phone tap target

- the controls sheet names the incumbent the way the desktop header does, shows its mandate, and offers Rotate

- Rotate opens the seat's configuration prefilled from the incumbent, and the draft is the SAME shape the desktop has

- confirming a rotation posts to the ROTATE route once — never the seat route, never raw spawn — with the adjusted seat settings

- a double tap rotates ONCE, and a retry after a lost reply replays the SAME key instead of rotating twice

- a rotation the server refused surfaces in the draft with retry, and the retry carries a FRESH key

- a landed rotation hands the phone off into the SUCCESSOR's conversation, with the composer

- a seat whose transcript is not in view still reaches Rotate from the sheet — rotation is the way forward for a gone host

- Rotate over a seat on the CURRENT default keeps the incumbent's text and offers nothing to keep (#1452)

- the rotate draft stays operable with the keyboard open: the sheet pads the inset, the mandate is revealed once, the confirm survives

- each surface respects the inset that can hide it: the bottom sheet the home indicator, the draft both ends

### src/components/mobile/mobileSeatCard.dom.test.tsx

**follow-up** — 2 pass, 20 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- with no seat the card is the invitation, ahead of the leaf and outside anything that scrolls

- the invitation opens the create draft — the rotate sheet in create mode (README §4.5)

- on a signed-out account the create draft says so, and its primary opens that account's sign-in instead of designating (#2170)

- tapping the create row opens the fullscreen sheet with the prefilled mandate and the launch pickers

- confirm posts the draft to the seat route — never to raw spawn — and carries one idempotency key

- a double tap posts once, and a retry after a lost reply replays the SAME key instead of designating twice

- a truncated 2xx reply is not a confirmation: the key survives it and the retry replays the same intent

- a refused designation lands on the row and inside the sheet, with the error and a retry, without a reload

- a created seat hands the phone off from the sheet into the standard focus view, with its composer

- tapping a live seat opens its conversation in the standard conversation screen

- a seated card carries the state badge, the now line and a meter that fills with what REMAINS

- a running parallel self puts the outline twin on the mark and names the ask in the now line

- the seat's ⚙ opens the seat as a BOTTOM sheet — account · plan, the context left, the predecessor, the mandate

- the mandate heading names which rules the seat runs under, and the preview folds to three lines

- the mandate preview expands in place, and folds back

- the sheet's badge speaks the phrase the card speaks, not a second word for the same seat

- the seat's own state moves the row with no reload: rotation advisory, then a retired conversation

- a designation failing ALONGSIDE a live incumbent gets its own control, and never takes the chat away

- the keyboard opening on the focused mandate brings the field into the scroller — once (#1004)

- an unreadable seat offers a re-read that recovers the row without a page reload

### src/components/mobile/phoneKanbanModel.test.ts

**follow-up** — 13 pass, 3 fail. Board fence: bare historical tasks in old fixtures lack current board membership and completed-card projection omits them.

Initial and remaining failures:

- Done shows a window of the newest cards and counts them all

- an empty column points at the nearest column with work, the earlier one on a tie

- the Overview's narrowing keeps live work only, and each tab counts what it draws

### src/components/orchestrator/OrchestratorPanel.dom.test.tsx

**follow-up** — 26 pass, 36 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- an active seat mounts the REAL conversation column — feed and composer, not a bespoke chat

- a re-hosted seat binds to its successor transcript through the status read, with no rotation (#1182)

- a restart-time status read that fails is retried, and the dock binds itself inside the bound (#1189)

- a bind that never lands stops spinning: the panel names the reason and Re-bind CLEARS it (#1182)

- the RUNTIME half of a bounded bind offers the same two ways forward, and Re-bind CLEARS it (#1182)

- a cached «alive» nobody is answering for any more never accuses the seat (#1182)

- a finished seat says so and offers resume in place — never a green live badge

- after a lost reply lands, the next NEW draft carries a fresh key instead of replaying the old one

- a running parallel self gives the seat head its outline twin and a chip that scrolls to the block

- the header names the incumbent — engine, model, account and context percent

- a server recommendation is SHOWN, in the server's own words, and rotates nothing by itself

- an estimated context number is marked as one — a guess never reads as a provider count

- an estimate at 100% is never the red chip; a provider count there is

- Rotate over a STALE seat opens the SAME draft on the CURRENT default mandate, names it, and keeps the incumbent's text one press away (#1452)

- Rotate over a seat on the CURRENT default keeps the incumbent's text, headed as the incumbent's — an operator's edit survives

- Rotate over bespoke rules (no version) keeps them — they claim no version and are never stale

- confirming a rotation posts to the ROTATE route, and never composes the handoff itself

- a double-click rotates ONCE, and a retry after a lost reply replays the same key

- a rotation the server refused surfaces in the panel with retry, and the retry carries a FRESH key

- a durable terminal error on a pending rotation is never hidden — it renders over the incumbent, with retry

- once the successor holds the seat the panel shows IT, with the predecessor linked on the board

- closing the seat conversation returns the panel to the draft WITHOUT a reload

- a rotate draft left open when the seat is closed gives way to the create draft

- Rotate reads the incumbent BEFORE it opens, so the first press is prefilled too

- a rotation whose reply never came keeps its key: the second Confirm replays it instead of rotating twice

- a rotation still in the air keeps its draft when the seat's card is closed — retry replays it at the ROTATE route

- the draft a closed conversation returns to can actually create — it says it is replacing the seat that outlived its card

- the dock renders the delivered mandate as the seat's own card, not as the operator's bubble

- the same row without that evidence stays the message it was

- coming back to a project paints its conversation in the first commit, transcript and all

- a seat holding a question badges «needs you» in the warning tone, and names the decision

- a quiet seat keeps the live badge, and claims no decision in its tooltip

- the badge is localized with the rest of the dock

- the kanban seat's inline header draws the predecessor link as a glyph, with its words on the name and the title (#1681)

- a panel handed its host's seat read shows that seat and never polls the seat route itself (#1695 kanban seat)

- the report log sits beside the seat's chat only where the chat keeps 1.5 times its old minimum, and the toggle still shows it narrower

### src/components/orchestrator/seatState.test.ts

**follow-up** — 51 pass, 1 fail. Orchestrator follow-up: abandoned open turn projects attention instead of queue no-live-process state. Validate liveness/decision precedence.

Initial and remaining failures:

- a decision the operator owes outranks every word for «it is running» (#1167) > the attention read is the QUEUE's: an abandoned open turn with no live process owes nothing

### src/components/pipelines/PipelineStrip.dom.test.tsx

**follow-up** — 8 pass, 1 fail. Pipeline fence: role/model labels and tone classes changed from old preset/render contract.

Initial and remaining failures:

- planned stage configuration opens on demand and Escape restores the compact rail (#353)

### src/components/pipelines/PipelineStrip.render.test.tsx

**follow-up** — 15 pass, 1 fail. Pipeline fence: role/model labels and tone classes changed from old preset/render contract.

Initial and remaining failures:

- the status dot follows the tone matrix (accent busy, amber attention, ok done)

### src/components/projectBoardMutations.test.ts

**follow-up** — 6 pass, 1 fail. Board/pipeline fence: canonical membership/history bands change remap, parent elision and reader ownership relative to old graph fixtures.

Initial and remaining failures:

- 18: planBoardConvergence orders remap before reconciliation and keeps a hidden successor hidden

### src/components/scheme/SchemeBoard.bands.dom.test.tsx

**follow-up** — 10 pass, 1 fail. Board/pipeline fence: canonical membership/history bands change remap, parent elision and reader ownership relative to old graph fixtures.

Initial and remaining failures:

- collapsing one task's history leaves another task's open reader alone; folding the reader's own band closes it

### src/components/scheme/SchemeBoard.lineage.dom.test.tsx

**follow-up** — 0 pass, 4 fail. Board/pipeline fence: canonical membership/history bands change remap, parent elision and reader ownership relative to old graph fixtures.

Initial and remaining failures:

- a transcript pointer naming a descendant never draws the builder as its coordinator's parent

- an ancestor the board does not draw is marked on the edge and on the card

- the whole chain reads coordinator → codex session → orchestrator → builder, in DOM order too

- the drawn hierarchy holds while the intermediate ancestor moves between live, stalled and idle

### src/components/scheme/SchemeBoard.pipelineComposition.dom.test.tsx

**follow-up** — 0 pass, 2 fail. Pipeline fence: mock attempts omit effectiveRole; projection dereferences effectiveRole.roleId.

Initial and remaining failures:

- the production scene keeps EVERY current stage a full real card and shells the future stages inside one halo (#507 F2)

- an idle completed stage stands at its stage position as ONE status row, expandable to the full card (#658)

### src/components/scheme/SchemeBoard.pipelineRegions.dom.test.tsx

**follow-up** — 0 pass, 5 fail. Pipeline fence: mock attempts omit effectiveRole; projection dereferences effectiveRole.roleId.

Initial and remaining failures:

- at 62% lite zoom every pipeline surface stays inside its region and neighboring regions keep their gap

- host loss / delayed materialization: unscanned published transcripts keep two separated shell regions

- a live pipeline beside a delayed-materialization pipeline keeps 24px of visible halo separation

- parked and completed stage cards stay inside their regions beside a live neighbor

- managed fixing and closed-hidden/restored lifecycle panes stay inside their pipeline region

### src/components/scheme/SchemeBoard.stageOverlay.dom.test.tsx

**follow-up** — 0 pass, 3 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- expanding a live stage pane keeps the role-first identity, in the header and in the dialog's accessible name

- F2 on the selected stage node opens a working rename editor in the overlay

- a conversation that is not a pipeline stage keeps its own title in the overlay

### src/components/scheme/SchemeOverlay.strip.dom.test.tsx

**follow-up** — 0 pass, 1 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- the overlay resolves the node and mounts an expanded strip (live-subagent) with a composer

### src/components/scheme/directReviewBoardComposition.test.ts

**follow-up** — 1 pass, 2 fail. Board/pipeline fence: canonical membership/history bands change remap, parent elision and reader ownership relative to old graph fixtures.

Initial and remaining failures:

- direct review board composition (#289 + #325) > two tasks build two isolated groups; every reviewer lives in exactly one surface with a placed anchor

- direct review board composition (#289 + #325) > with the terminal anchor unplaced the group parks as ONE per-group stack and one minimap dot

### src/components/scheme/layout.lineage.test.ts

**follow-up** — 9 pass, 1 fail. Board/pipeline fence: canonical membership/history bands change remap, parent elision and reader ownership relative to old graph fixtures.

Initial and remaining failures:

- scheme lineage direction > an ancestor the board does not draw is elided on the edge, not skipped in silence

### src/components/scheme/nodes.dom.test.tsx

**follow-up** — 1 pass, 5 fail. Board fence: anchored-feed fixtures cannot locate current node/card feed surface; repair selectors and runtime evidence.

Initial and remaining failures:

- an anchored production feed survives overtakes and a short remount window

- an account-migration successor inherits its conversation scroll state

- an anchored feed item keeps its viewport offset while the transcript grows during remount

- an anchored feed item survives parser reset after history is prepended

- a bottom-following production feed returns to the tail after remount

### src/components/scheme/nodes.stageRow.dom.test.tsx

**follow-up** — 6 pass, 1 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- a live stage pane is titled role · stage · position, never the prompt's shared preamble

### src/components/scheme/nodes.strip.dom.test.tsx

**follow-up** — 0 pass, 3 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- a scheme node mounts the strip: live-root for the running root

- a scheme node classifies a scanner-shaped subagent from its live structured root

- dormant far-zoom scheme nodes render no control strip; active nodes restore it

### src/components/session/SessionTitle.mobile.dom.test.tsx

**follow-up** — 0 pass, 5 fail. Board/phone/pipeline fence: missing browser animation APIs used by speech geometry abort React mounting and invalidate downstream selectors.

Initial and remaining failures:

- the phone's rename editor shows the current title in a field that takes the bar over, set in a size the phone will not zoom

- a drag inside the rename field scrolls the title, never the conversation under it

- Enter saves what was typed and the bar's title cell shows the new name

- a phone Cancel press prevents null-target blur before click

- a phone Save name press prevents null-target blur before click

### src/components/workLinks/workLinks.dom.test.tsx

**follow-up** — 3 pass, 1 fail. Board/pipeline fence: attach-link wire carries current container/guard data absent from old assertion.

Initial and remaining failures:

- the card's ⋯ names the task's Attach and each lane's apart, and a lane's attach form sends attach-link with what was typed, and draws the answer at once

### src/components/workflows/legacyDraftPurge.dom.test.tsx

**follow-up** — 4 pass, 14 fail. Board/phone fence: mocked runtime settings view lacks known array; view.known.some throws and aborts mounting.

Initial and remaining failures:

- the 390px draft working-directory picker keeps a 44px touch target

- a task card agent action seeds the task prompt and canonical project directory

- a restored handoff draft shows its populated source cwd and never asks to confirm it (#887)

- a fresh handoff replaces its provisional project root with the resolved source cwd

- a fresh handoff shows a deleted source checkout's cwd without gating on it (#887)

- a restored handoff waits for its out-of-snapshot source cwd before exposing the composer

- a deleted source checkout's cwd launches with no confirmation in the way (#887)

- a restored handoff stays unresolved while source cwd lookup retries

- the desktop agent control stays disabled until project metadata hydrates

- an unmatched metadata-poor project opens a nonempty draft on the root placeholder

- an untouched provisional project draft adopts a canonical root after catalog hydration

- a missing restored handoff reaches an editable bounded recovery card

- a retried launch opens its draft on the Board, prefilled from the launch, and its receipt stays in launch history

- closing a conversation card reports its path to the dashboard owner

### src/lib/accounts/claude.test.ts

**follow-up** — 31 pass, 4 fail. Observed account persistence failure: after fixtures remove/recreate the state tree, registry recovery encounters missing registry_conversation_paths/tasks tables or absent conversation generations. Reused registry/store state is an inference; confirm which owner needs reset with a minimized reproduction before changing removal invariants.

Initial and remaining failures:

- a used Claude home is removed and every leftover moves into the shared archive (#1857)

- a conversation that turns live inside the registry mutation puts the home back

- a Viewer killed after the agent registry retired the account completes the removal on recovery

- recovery that is itself killed after re-retiring still completes the removal

### src/lib/accounts/claudeProvider.test.ts

**fixed** — 20 pass, 0 fail. Fixed drift: provider environments legitimately include validated machine publication identity; retain all routing/secret isolation assertions.

Initial failures:

- provider headers stay private and shared settings cannot replace its routing

### src/lib/accounts/codex.test.ts

**follow-up** — 19 pass, 4 fail. Observed account persistence failure: after fixtures remove/recreate the state tree, registry recovery encounters missing registry_conversation_paths/tasks tables or absent conversation generations. Reused registry/store state is an inference; confirm which owner needs reset with a minimized reproduction before changing removal invariants.

Initial and remaining failures:

- a Codex removal killed after "journaled" puts the home and its registry paths back

- a Codex removal killed after "renamed" puts the home and its registry paths back

- a Codex removal killed after the agent registry retired the account completes on recovery

- the first account listing in a restarted Viewer recovers an interrupted removal

### src/lib/accounts/manager.interprocess.test.ts

**follow-up** — 3 pass, 1 fail. Account interprocess follow-up: controller projection returns null activeAccountId instead of selected controller-race account.

Initial and remaining failures:

- interprocess mutation matrix covers selection, controller sync, login state, and removal

### src/lib/accounts/migration/coordinator.test.ts

**follow-up** — 106 pass, 9 fail. Migration follow-up: committed successor/fork and delivery acknowledgement projection differs from old coordinator fixture. Align durable host/delivery proof.

Initial and remaining failures:

- durable account migration coordinator > a Codex source fork resolves to the committed target without another manual root

- durable account migration coordinator > a committed successor keeps its predecessor hidden through root reconciliation

- durable account migration coordinator > reconciliation repairs board continuity for an already committed successor

- durable account migration coordinator > a 51-conversation drain keeps a two-card board from growing

- durable account migration coordinator > a later migration repairs placement stranded by an earlier board outage

- durable account migration coordinator > first restart repair transfers predecessor placement into the corrected project

- durable account migration coordinator > project correction transfers previously repaired placement

- durable account migration coordinator > repeat migration carries prior project placement into the regrouped board

- durable account migration coordinator > restart adopts a persisted two-path Codex receipt and repairs board continuity

### src/lib/accounts/removal.test.ts

**follow-up** — 25 pass, 5 fail. Removal follow-up: unresolved-launch fixture does not block all accounts as asserted; aged-pin sequence exceeds initial bound. Recheck current reservations.

Initial and remaining failures:

- an unresolved live launch blocks removal of every managed account for its engine

- an aged queued pin blocks every account until its durable receipt settles

- dead pinned receipts block neither their own account nor any other (issue #1595)

- a pinned receipt still inside its launch blocks the account it names, and only that one

- dead history plus stale starting entries and receipts no longer block removal (issue #643)

### src/lib/attention/landing.test.ts

**follow-up** — 0 pass, 8 fail. Pipeline/attention fence: stage fixtures lack a signed-in Codex account, so admission refuses before attention assertions.

Initial and remaining failures:

- a lane the server admitted is on the board before anything requests attention

- attention on the pipeline, raised at once against a stale board, lands on the lane

- attention on one of its stages, raised at once against a stale board, lands on the lane

- attention on its board task, raised at once against a stale board, lands on the lane

- a pipeline the server does not hold carries no record and still answers TARGET_LOST

- a lane the client holds and the server does not comes back as a withdrawal, with its reason

- a lane admitted long ago is not re-pushed on every poll

- the phone's rows-only read carries a freshly admitted lane and touches no request

### src/lib/board/store.sqlite.test.ts

**follow-up** — 29 pass, 1 fail. Board fence: concurrent writer child emits state-import diagnostic on stdout before its JSON result, so parent JSON parsing fails (Unexpected identifier state). Separate diagnostic/protocol output in the owning store lane; retain lost-update assertion.

Initial and remaining failures:

- cross-process durability > concurrent writers in two processes lose no update

### src/lib/bridge/routing.test.ts

**follow-up** — 1 pass, 2 fail. Registry-root lifecycle follow-up: the fixture changes LLV_STATE_DIR and later removes that sandbox, while agentRegistry() retains one process-local registry (src/lib/agent/registry.ts:9418). The observed readOnlySnapshot trace reopens its removed database through sqliteRegistryStore.ts:464 and raises SQLITE_CANTOPEN. Isolate/reset the registry owner in a minimized reproduction; scanner/catalog cache ownership is not established.

Initial and remaining failures:

- rotation moves bridge scope to the successor and revokes the predecessor

- a registered conversation with no project seat has no bridge channel scope

### src/lib/links/boardSync.test.ts

**follow-up** — 48 pass, 1 fail. Linked-board fence: three-run warmed heap median is 701818 bytes against the 262144-byte steady-state bound. Initial run exceeded 180 seconds; longer rerun reaches this memory guard. Minimize churn retention without weakening the bound.

Initial failures:

- File-level timeout or setup/transport exception; see the cause above.

Remaining failures:

- M3 link RSS and heap are measured with 2 000 tasks, 200 agents per side, edits and churn; steady heap stays flat

### src/lib/links/taskSync.test.ts

**follow-up** — 12 pass, 1 skip, 1 fail. Board fence: peer arrival count differs from old explicit membership/band fixture; reconcile linked-board replay.

Initial and remaining failures:

- peer arrivals preserve membership, bound bands, and repair legacy done arrivals once without losing fields

### src/lib/mcp/bindings.test.ts

**cleared by neutral harness** — 88 pass, 0 fail. Harness isolation: this source is unchanged; the initial stage-inherited environment produced a refusal/wire mismatch, while the neutral environment and built MCP prerequisite pass the exact file. No product fix claimed.

Initial failures:

- task placement bindings require atomic guards and classify field refusals as non-retryable

### src/lib/mcp/controlPlaneReads.test.ts

**follow-up** — 22 pass, 1 fail. MCP deadline follow-up: held-path/hydration read throws deadline exceeded instead of returning available partial payload.

Initial failures:

- get_conversation returns a held path tail with deadline-partial metadata

- get_conversation returns hydrated records when the deadline lands after the partial exists

Remaining failures:

- get_conversation returns hydrated records when the deadline lands after the partial exists

### src/lib/mcp/conversationAction.integration.test.ts

**follow-up** — 5 pass, 2 fail. Harness prerequisite: build dist/mcp-server.mjs with isolated build:mcp before packaged transport tests. Persistent host/transport settlement errors need lifecycle follow-up.

Initial and remaining failures:

- MCP kill reaches a live structured host through the Viewer without an agent runtime socket

- MCP interrupt reaches a live structured host through the Viewer without an agent runtime socket

### src/lib/mcp/conversationMigration.integration.test.ts

**cleared by neutral harness** — 15 pass, 0 fail. Harness prerequisite: build dist/mcp-server.mjs with isolated build:mcp before packaged transport tests. Persistent host/transport settlement errors need lifecycle follow-up.

Initial failures:

- Claude reseat crosses MCP stdio and Viewer HTTP without an MCP runtime socket

- Claude select-account crosses MCP stdio and Viewer HTTP without an MCP runtime socket

### src/lib/mcp/dismissAttention.test.ts

**follow-up** — 7 pass, 1 fail. Pipeline fence: dismiss response differs from older projected write shape.

Initial and remaining failures:

- pipeline_action dismiss is the same write, behind the same gate

### src/lib/mcp/maintainerGuard.integration.test.ts

**follow-up** — 6 pass, 1 fail. Board maintainer fence: old gone/live transcript fixture differs from current ownership projection; retain live-owner refusal.

Initial and remaining failures:

- the real transcript projection permits gone history and refuses a verified live idle owner

### src/lib/mcp/reportTools.test.ts

**follow-up** — 5 pass, 1 fail. Board fence: mocked FileEntry omits lineageEdges required by current task-language/membership code.

Initial and remaining failures:

- task text in another language than the interface is stored with a warning; details are never checked; nothing is said while the language is unknown

### src/lib/mcp/requestAttention.targets.test.ts

**follow-up** — 3 pass, 2 fail. Board attention fence: current target admission refuses older task/pipeline ownership fixtures.

Initial and remaining failures:

- the five shapes from the report either land or say what was expected

- a target that already names a path is recorded untouched

### src/lib/mcp/retirementStatus.integration.test.ts

**fixed** — 18 pass, 0 fail. Fixed drift: optional schema may omit required; normalize to []. Packaged stdio also needs build:mcp.

Initial failures:

- served schema teaches automatic launch identity and bounded pagination

- packaged stdio callers retain project access without inheriting a spawn capability

### src/lib/mcp/retirementStatus.test.ts

**fixed** — 5 pass, 0 fail. Fixed drift: request full:true for detailed session/transcript metadata omitted by compact MCP default.

Initial failures:

- rows a failed collection fell back on are marked stale one by one, beside the Viewer's own section (#2110, #1817)

### src/lib/mcp/retryStageLaunch.integration.test.ts

**follow-up** — 2 pass, 4 fail. Pipeline fence: retry/host-access/publication fixtures fail current capability, settlement or branch-publication guards. Repair complete fixtures and verify owned-host settlement.

Initial and remaining failures:

- retry-stage by stage retries a stage whose agent started and ended on a fail verdict

- retry-stage by stage still retries a launch that failed, with or without its launchId

- retry-stage naming the completed launch of a stage whose host was lost retries it (#1871)

- retry-stage by stage is refused with STAGE_CHANGED when the lane waits on another stage or attempt

### src/lib/mcp/stdio.integration.test.ts

**fixed** — 31 pass, 0 fail. Test drift fixed: the all-optional deployment_status schema omits required; normalize to [] before asserting callerLaunchId is optional. Packaged transport rerun passes all 31 tests after build:mcp.

Initial failures:

- store reads stay independent of a slow host, held pipeline lease and same-client HTTP call

- the packaged stdio host publishes and invokes the expanded read surface

- a packaged MCP spawn is dispatched once: a Viewer restart mid-request answers unknown and nothing is re-POSTed

- a packaged MCP tool falls back from a retired launch port to the stable Viewer resolver

- send: acceptance, lost response, original-key recovery — one recipient delivery, across process restart

- spawn: acceptance, lost response, original-key recovery — one launch, one conversation, one writer, across process restart

### src/lib/mcp/taskPosition.integration.test.ts

**cleared by neutral harness** — 7 pass, 0 fail. Harness isolation: this source is unchanged; the initial stage-inherited environment produced a refusal/wire mismatch, while the neutral environment and built MCP prerequisite pass the exact file. No product fix claimed.

Initial failures:

- two independent processes racing identical coordinates under one revision have exactly one winner

### src/lib/mcp/voiceUtteranceContext.test.ts

**fixed** — 18 pass, 0 fail. Fixed drift: request full:true for detailed session/transcript metadata omitted by compact MCP default.

Initial failures:

- naming a target explicitly is never overridden by the call

### src/lib/mcp/writerConcurrency.test.ts

**follow-up** — 4 pass, 1 fail. Pipeline fence: retry/host-access/publication fixtures fail current capability, settlement or branch-publication guards. Repair complete fixtures and verify owned-host settlement.

Initial and remaining failures:

- Viewer HTTP pipeline start and standalone MCP pipeline_action serialize across processes

### src/lib/orchestrator/handoffDigest.test.ts

**follow-up** — 17 pass, 1 fail. Orchestrator budget follow-up: delivery appends 13651 bytes against a 13500-byte envelope share. Reduce/budget append; retain limit.

Initial and remaining failures:

- what delivery appends stays inside its share of the envelope

### src/lib/pipelines/backgroundTaskSettlement.test.ts

**follow-up** — 14 pass, 1 fail. Pipeline fence: restart settlement retains orphan background notification/wait instead of clearing all notified tasks.

Initial and remaining failures:

- one orphan notification after a restart ends every task it lists, and the stage reports and settles

### src/lib/pipelines/legacyReviewConversion.test.ts

**follow-up** — 9 pass, 6 fail. Pipeline fence: legacy-review conversion compiled-role/retry semantics differ from old preview/cardinality fixtures.

Initial and remaining failures:

- preview answers the converted plan and writes nothing, for hot and archived drafts

- a flow limit of 1 runs the converted reviewer exactly that many times, the final review included

- a flow limit of 2 runs the converted reviewer exactly that many times, the final review included

- a flow limit of 3 runs the converted reviewer exactly that many times, the final review included

- an unlimited flow limit is refused with an editable recommendation, then converts at the chosen finite limit

- an unexecuted conversion reverts explicitly; once a new attempt ran it is repaired forward

### src/lib/pipelines/resolveDecision.test.ts

**follow-up** — 0 pass, 15 fail. Pipeline fence: question sequence remains running instead of needs_decision; reconcile settlement/answer fencing.

Initial and remaining failures:

- settled question -> fenced answer -> fresh attempt -> final output (drain 0)

- settled question -> fenced answer -> fresh attempt -> final output (drain 1)

- identical replay returns its durable answer after restart and rollback without a second attempt

- MCP restart before-admission recovers one durable answer and continuation

- MCP restart after-answer recovers one durable answer and continuation

- MCP restart before-admission rechecks the server-attributed actor

- MCP restart after-answer rechecks the server-attributed actor

- MCP completed replay refuses another actor without replacing the creator receipt

- MCP restart before admission retains the pipeline fence {"expectedStageId":"verify"}

- MCP restart before admission retains the pipeline fence {"expectedAttempt":2}

- MCP restart before admission retains the pipeline fence {"expectedRevision":"0000000000000000000000000000000000000000000000000000000000000000"}

- concurrent answers admit one winner under the same revision

- wrong actor, stage, attempt, revision and missing fences leave the question unchanged

- disable blocks fresh admission and operational parks are not answerable questions

- a second question appends another answer and retains the original input and both settled attempts

### src/lib/pipelines/roles.test.ts

**follow-up** — 27 pass, 1 fail. Pipeline fence: #2405 changed Astra builder defaults to Sol/high; assertion is stale.

Initial and remaining failures:

- production role lookup reads the fresh Astra Builder preset

### src/lib/pipelines/severedStageRetry.test.ts

**follow-up** — 2 pass, 2 fail. Pipeline fence: retry/host-access/publication fixtures fail current capability, settlement or branch-publication guards. Repair complete fixtures and verify owned-host settlement.

Initial and remaining failures:

- a CPU-flat stage autonomously retires its exact child before one replacement attempt (#1296)

- a live severed stage host is killed, retired, and its stage retried once, through the seams the incident ran through (#1282)

### src/lib/pipelines/stageCompletion.test.ts

**follow-up** — 45 pass, 2 fail. Pipeline fence: brief scaffold/truncation and admission changed from exact marker/command fixtures.

Initial and remaining failures:

- a long final brief is bounded in bytes with an explicit truncation marker

- a refused call runs no command at all, so no forge latency is ever spent on one

### src/lib/pipelines/stageHostGenerationClose.integration.test.ts

**follow-up** — 32 pass, 12 fail. Harness prerequisite: build dist/mcp-server.mjs with isolated build:mcp before packaged transport tests. Persistent host/transport settlement errors need lifecycle follow-up.

Initial failures:

- incident: a stage host re-hosted by a successor generation is ended by a close from a socketless process (#1501)

- resume/park: a successor generation does not re-host a settled stage attempt on its turn claim alone, and the close then settles on evidence (#1501)

- control: a stage attempt the pipeline still drives is re-hosted at startup (#1501)

- control: a host proven dead with no successor closes through the existing fallback with no signal

- restart durability: after the close, a further generation adopts nothing and the tick restarts nothing (#1501)

- a recorded start identity that no longer matches the pid is proof of death, never a target (#1501)

- an identity that changes between the residency probe and the signal refuses without a signal (#1501)

- a legacy row with no start identity is unresolved: no signal, the close is refused with the reason (#1501)

- a row without a boot epoch is ambiguous evidence: no signal, unresolved (#1501)

- missing launch evidence is unresolved ownership: no launch id, or no receipt for it, and nothing is signalled (#1501)

- a launch receipt that names another conversation is contradictory ownership: no signal (#1501)

- an attempt whose conversation id resolves only through its transcript is contradictory for the identity path (#1501)

- partial stop: a descendant that outlives the kill keeps the attempt unresolved until it is proven gone, whatever the row says (#1501)

- a refused signal on the host itself is unresolved with the pid named, and a later close ends it once the fault clears (#1501)

- a seat taken while the termination awaits the runtime is seen before the signal: refused, nothing sent (#1501)

- a row rebound to another process while the termination awaits the runtime is seen before the signal: refused, nothing sent (#1501)

- a conversation holding an orchestrator seat is revalidated at the kill and refused (#1501)

- two concurrent closes over HTTP signal the host exactly once (#1501)

- a row naming a pid in this process's own ancestry is refused without a signal (#1501)

- with a control channel present the runtime path answers and the identity path is never entered (#1501)

- authority lost after TERM retains every survivor across HTTP closes and startup (#1501)

- successor partial stop merges an earlier generation's late survivor evidence across restart (#1501)

- unreadable pipeline state defers startup without demotion and a successful reread recovers (#1501)

- startup defers a running attempt with an unverifiable survivor until positive death permits reread recovery (#1501)

- a deferred lane completes the boot once: an unrelated pending launch is reconciled, the axis is ready, and the same generation admits the lane only after positive death (#1501)

- terminal reap retains a partial tree for later ticks, HTTP close and startup (#1501)

- an unconfirmed later stop cannot acknowledge away a captured survivor (#1501)

- shared host cannot skip an attempt's durable survivors (#1501)

- expired budget cannot skip an attempt's durable survivors (#1501)

- an authority read exception after TERM preserves survivors through HTTP close and restart (#1501)

- startup rereads after transcript refresh and defers a concurrently persisted partial close (#1501)

- startup admission holds the pipeline lease until its replacement is published (#1501)

- retry-stage checks older attempt survivors before any reset or advancement (#1501)

- skip-stage checks older attempt survivors before any reset or advancement (#1501)

- ticks defer worktree provisioning until an earlier partial tree is positively dead (#1501)

- malformed archive {broken defers startup and recovers on a successful reread (#1501)

- malformed archive {"runs":[]} defers startup and recovers on a successful reread (#1501)

- an older attempt survivor fences every pipeline conversation until positive death (#1501)

- late pass verdict recovery waits for every retained survivor (#1501)

- late fail verdict recovery waits for every retained survivor (#1501)

- bound flow recovery keeps evidence synchronization but defers resume until positive death (#1501)

- null legacy pipelines.json defers startup without migration and recovers on reread (#1501)

- null legacy pipelines-archive.json defers startup without migration and recovers on reread (#1501)

Remaining failures:

- a row rebound to another process while the termination awaits the runtime is seen before the signal: refused, nothing sent (#1501)

- successor partial stop merges an earlier generation's late survivor evidence across restart (#1501)

- startup defers a running attempt with an unverifiable survivor until positive death permits reread recovery (#1501)

- a deferred lane completes the boot once: an unrelated pending launch is reconciled, the axis is ready, and the same generation admits the lane only after positive death (#1501)

- startup rereads after transcript refresh and defers a concurrently persisted partial close (#1501)

- startup admission holds the pipeline lease until its replacement is published (#1501)

- ticks defer worktree provisioning until an earlier partial tree is positively dead (#1501)

- an older attempt survivor fences every pipeline conversation until positive death (#1501)

- late pass verdict recovery waits for every retained survivor (#1501)

- late fail verdict recovery waits for every retained survivor (#1501)

- null legacy pipelines.json defers startup without migration and recovers on reread (#1501)

- null legacy pipelines-archive.json defers startup without migration and recovers on reread (#1501)

### src/lib/pipelines/stageVerdictRequest.test.ts

**follow-up** — 7 pass, 2 fail. Pipeline fence: retry/host-access/publication fixtures fail current capability, settlement or branch-publication guards. Repair complete fixtures and verify owned-host settlement.

Initial and remaining failures:

- skip-stage adopts the parked stage's pushed head and advances the lane (#1756)

- skip-stage carries the parked stage's unpublished local head in an internal lane (#1756)

### src/lib/reaperRuntime.test.ts

**fixed** — 54 pass, 0 fail. Fixed drift: #916 requires a semantic spawn title; seed titled profiles while retaining reaper/lineage assertions.

Initial failures:

- an unknown missing transcript reaches the dead-transcript TTL in production input

- Viewer flow deliveries are discounted from transcript authorship

- the reaper actuates a due pinned tmux queue exactly once without a runtime client

### src/lib/resources.test.ts

**fixed** — 69 pass, 0 fail. Fixed harness: resolve/quote actual Node executable rather than absent /usr/bin/node; preserve fake resolver cases. Drain exit-cleanup request before exit to prevent EPIPE race.

Initial failures:

- resource observation > the packaged worker leaves writable and read-only homes and state trees byte-identical

- resource recurring reads > TERM-handler escaped descendants are absent before every worker outcome settles

- resource recurring reads > pre-armed owner-mutating TERM descendants observe member-before-root cleanup

- resource recurring reads > retains PID namespace membership authority through init disappearance

- resource recurring reads > six pre-armed concurrent containment cleanups stay healthy and reach exact zero

- resource recurring reads > a near-limit handoff to an immediately exiting worker keeps the parent alive and releases the worker

### src/lib/review/extraction.test.ts

**follow-up** — 3 pass, 1 fail. Mixed: fix actual Node import-probe lookup; retain red pure dependency guard because relay projection imports sqliteStateStore. Extract boundary in follow-up.

Initial failures:

- review parsing and settled relay projection cannot load flow execution or storage

- archive route configuration loads in Node build workers without loading Bun SQLite

Remaining failures:

- review parsing and settled relay projection cannot load flow execution or storage

### src/lib/reviewHistory/reader.test.ts

**follow-up** — 10 pass, 56 fail. Review archive follow-up: durable relay/artifact proof omits rows older fixtures treat as settled/exportable. Reconcile delivery/publication proof without fabricating provenance.

Initial and remaining failures:

- missing and pruned artifacts stay explicit, with no fabricated provenance

- HTTP export redacts scalar artifact credentials while preserving raw provenance and SQL revisions

- HTTP export redacts object artifact credentials while preserving raw provenance and SQL revisions

- HTTP export redacts array artifact credentials while preserving raw provenance and SQL revisions

- HTTP export redacts encoded scalar credentials in message strings

- HTTP export redacts encoded object credentials in message strings

- HTTP export redacts encoded array credentials in message strings

- HTTP export redacts encoded scalar credentials in array strings

- HTTP export redacts encoded object credentials in array strings

- HTTP export redacts encoded array credentials in array strings

- HTTP export redacts encoded scalar credentials in recursive strings

- HTTP export redacts encoded object credentials in recursive strings

- HTTP export redacts encoded array credentials in recursive strings

- HTTP export refuses truncated quoted credentials in findings without changing provenance

- HTTP export refuses truncated quoted credentials in output without changing provenance

- HTTP export refuses truncated quoted credentials in stdout without changing provenance

- HTTP export refuses truncated quoted credentials in stderr without changing provenance

- HTTP export refuses malformed encoded strings in findings without changing source or provenance

- HTTP export refuses malformed encoded strings in output without changing source or provenance

- HTTP export refuses malformed encoded strings in stdout without changing source or provenance

- HTTP export refuses malformed encoded strings in stderr without changing source or provenance

- HTTP export redacts complete decoded headers in findings and preserves ordinary history

- HTTP export redacts complete decoded headers in output and preserves ordinary history

- HTTP export redacts complete decoded headers in stdout and preserves ordinary history

- HTTP export redacts complete decoded headers in stderr and preserves ordinary history

- HTTP export preserves lines and nested JSON after decoded URLs in findings

- HTTP export preserves lines and nested JSON after decoded URLs in output

- HTTP export preserves lines and nested JSON after decoded URLs in stdout

- HTTP export preserves lines and nested JSON after decoded URLs in stderr

- HTTP export preserves credential metadata in findings and retained extensions

- HTTP export preserves credential metadata in output and retained extensions

- HTTP export preserves credential metadata in stdout and retained extensions

- HTTP export preserves credential metadata in stderr and retained extensions

- HTTP export retains plain-text secret rules across quoted log boundaries

- HTTP export refuses encoded strings beyond the decoding bound

- HTTP export redacts acronym credential suffixes in findings and extensions

- HTTP export redacts acronym credential suffixes in output and extensions

- HTTP export redacts acronym credential suffixes in stdout and extensions

- HTTP export redacts acronym credential suffixes in stderr and extensions

- HTTP export redacts complete single-quoted credentials in findings

- HTTP export redacts complete single-quoted credentials in output

- HTTP export redacts complete single-quoted credentials in stdout

- HTTP export redacts complete single-quoted credentials in stderr

- HTTP export refuses unterminated single-quoted credentials in findings

- HTTP export refuses unterminated single-quoted credentials in output

- HTTP export refuses unterminated single-quoted credentials in stdout

- HTTP export refuses unterminated single-quoted credentials in stderr

- HTTP export preserves harmless quoted backslashes in findings

- HTTP export preserves harmless quoted backslashes in output

- HTTP export preserves harmless quoted backslashes in stdout

- HTTP export preserves harmless quoted backslashes in stderr

- HTTP export refuses malformed quoted text carrying credential assignments in findings

- HTTP export refuses malformed quoted text carrying credential assignments in output

- HTTP export refuses malformed quoted text carrying credential assignments in stdout

- HTTP export refuses malformed quoted text carrying credential assignments in stderr

- legacy copied findings remain readable without rewriting their stored path

### src/lib/runtime/codexAppServerHost.integration.test.ts

**optional credential cases gated** — 0 pass, 3 skip, 0 fail. Optional external integration: inherited CODEX_HOME triggered real Codex; scratch adoption lacks rollout and attach events time out. Neutral clean-home run strips credentials and gates acceptance.

Initial failures:

- real Codex app-server accepts the read-only scratch profile for fresh and adopted threads

- real Codex subscription supports late attach, steering, and restart resume

### src/lib/runtime/deploymentLedger.test.ts

**fixed** — 6 pass, 0 fail. Fixed drift: #1850 returns deployments by recency, including bounded latest; assertion expected ID ordering.

Initial failures:

- the latest deployment is the newest one, not the one the id ordering happens to end on

### src/lib/runtime/legacyClaudeRecovery.cleanCi.integration.test.ts

**follow-up** — 0 pass, 1 fail. Legacy recovery follow-up: missing title blocks first; a titled probe reveals absent keyed readSession and newer MCP-derived clientMessageId. Repair complete lifecycle fixture.

Initial and remaining failures:

- production acceptance recovers a lifecycle-busy legacy Fable tail from a stale registering projection through MCP

### src/lib/runtime/pipelineStageHostAccess.integration.test.ts

**follow-up** — 0 pass, 1 fail. Pipeline fence / external credential prerequisite: real launch test requires ChatGPT-authenticated Codex. Initial inherited stage capability returned HTTP 401; neutral clean-home test refuses explicitly for absent credentials. Keep this separate from hermetic component/unit acceptance.

Initial and remaining failures:

- real pipeline launch keeps access and sandbox independent through settlement

### src/lib/runtime/severedHostReap.test.ts

**follow-up** — 4 pass, 3 fail. Runtime retirement follow-up: fixtures fail current ownership/progress evidence and retain rows; preserve exact identity and last-write guards.

Initial and remaining failures:

- a kill on a severed host nothing owns reaps the process so its row can retire

- a host that has written since its own launch is never reaped

- a pid the registry no longer owns is reported severed but never signalled

### src/lib/runtime/startup.test.ts

**follow-up** — 107 pass, 2 fail. Runtime startup follow-up: old population snapshot mocks lack current keyed session evidence for adoption/retry drains.

Initial and remaining failures:

- startup socket recovery retains a partially adopted host and drains its held send once

- scheduled startup retry continues through the retained Codex host

### src/lib/runtime/startupFinalization.integration.test.ts

**follow-up** — 18 pass, 1 fail. Startup finalization follow-up: rollback checkpoint waits for startup network publication, contrary to its independent finalization bound (false expected, true observed). Longer rerun passes the other 18 cases; retain the rollback/network ordering guard.

Initial failures:

- historical failed launches do not retain startup admission across one full runtime snapshot per receipt

- rollback checkpoint does not wait on startup network publication

- the full retained history completes within the promoted serving budget

Remaining failures:

- rollback checkpoint does not wait on startup network publication

### src/lib/runtime/structuredAccountSwitch.test.ts

**follow-up** — 10 pass, 2 fail. Runtime switch follow-up: mock lacks readSession, causing runtime-session-read unavailable instead of successor hold/delivery.

Initial and remaining failures:

- a send forces the pending switch and becomes the successor's first delivery

- an image send whose successor has no host yet is held durably, never rejected

### src/lib/runtime/structuredDelivery.integration.test.ts

**follow-up** — 40 pass, 2 fail. Runtime delivery follow-up: kill/retry misses route-kick/queued states under durable effect batching; validate cancellation/persistence together.

Initial and remaining failures:

- a kill cancels an automatic delivery retry and fails the send retryably

- a failed kill projection retries through the coalesced drain and terminalizes

### src/lib/runtime/structuredDeliveryQueue.recoveryContention.test.ts

**fixed** — 9 pass, 0 fail. Test drift fixed: lock diagnostics now include owner operation, PID and age. Assert the marked recovery forwards the exact contention.message, identifies the real holder, and creates no successor receipt or spawn. The synthetic BUSY sentence remains for injected outcomes.

Initial failures:

- the reservation refusal is marked where the reservation is made, with the lock's own sentence

### src/lib/runtime/structuredDeliveryRebind.test.ts

**follow-up** — 12 pass, 1 fail. Runtime rebind follow-up: carried-over registration times out/fails during termination; validate ownership release and delivery ordering.

Initial and remaining failures:

- a carried-over host terminated mid-registration is released once and stays gone (#1191)

### src/lib/runtime/structuredHostRetirementStatus.test.ts

**follow-up** — 8 pass, 1 fail. Keyed registry follow-up: retirement lookup evaluates malformed JSON from unrelated poisoned row. Restrict SQL evaluation to named authorized rows and retain read-only guard.

Initial and remaining failures:

- production reads only named authorization and subject rows without writing state

### src/lib/runtime/structuredMessageDelivery.keyed.test.ts

**follow-up** — 0 pass, 1 fail. Keyed performance follow-up: unrelated sessions/reservations push admission beyond 12000-ms bound (initial 242380 ms). Trace keyed reads/row writes without relaxing guard.

Initial and remaining failures:

- HTTP admission stays keyed as thousands of unrelated sessions and reservations accumulate

### src/lib/runtime/structuredSpawn.integration.test.ts

**follow-up** — 98 pass, 6 fail. Spawn follow-up: memory-scope wrapper fails before executing synthetic Claude; owned-child cleanup reports EPERM. Restore executable/sandbox contract and exact ownership.

Initial and remaining failures:

- a Claude spawn born on a non-routed account (http viewer transport) > starts its first turn on that account and materializes its transcript (no drain)

- a Claude spawn born on a non-routed account (http viewer transport) > starts its first turn on that account and materializes its transcript (a drain running before staging)

- a Claude spawn born on a non-routed account (http viewer transport) > starts its first turn on that account and materializes its transcript (a drain committed after staging)

- a Claude spawn born on a non-routed account (stdio viewer transport) > starts its first turn on that account and materializes its transcript (no drain)

- a Claude spawn born on a non-routed account (stdio viewer transport) > starts its first turn on that account and materializes its transcript (a drain running before staging)

- a Claude spawn born on a non-routed account (stdio viewer transport) > starts its first turn on that account and materializes its transcript (a drain committed after staging)

### src/lib/runtime/structuredSwitchCancel.test.ts

**follow-up** — 22 pass, 1 fail. Switch-cancel follow-up: rollback owner/delivery re-arming differs from fixture projection; validate durable successor reservations.

Initial and remaining failures:

- cancelling a claimed switch that waits for the turn rolls it back, settles its owner, and re-arms only the delivery it held

### src/lib/scanner/discover.performance.test.ts

**follow-up** — 1 pass, 1 fail. Registry-root lifecycle follow-up: the fixture changes LLV_STATE_DIR and later removes that sandbox, while agentRegistry() retains one process-local registry (src/lib/agent/registry.ts:9418). The observed readOnlySnapshot trace reopens its removed database through sqliteRegistryStore.ts:464 and raises SQLITE_CANTOPEN. Isolate/reset the registry owner in a minimized reproduction; scanner/catalog cache ownership is not established.

Initial and remaining failures:

- pipeline status churn keeps a 100 MB growing transcript scan incremental, reporting its event-loop lag

### src/lib/scanner/discover.test.ts

**follow-up** — 8 pass, 38 fail. Registry-root lifecycle follow-up: the fixture changes LLV_STATE_DIR and later removes that sandbox, while agentRegistry() retains one process-local registry (src/lib/agent/registry.ts:9418). The observed readOnlySnapshot trace reopens its removed database through sqliteRegistryStore.ts:464 and raises SQLITE_CANTOPEN. Isolate/reset the registry owner in a minimized reproduction; scanner/catalog cache ownership is not established.

Initial and remaining failures:

- request refreshes persist the per-file scanner index

- a poisoned durable alias source defers only itself in the persist scan

- project catalog persistence repairs private modes and atomically replaces symlinks

- a non-ENOENT directory failure leaves the completed catalog index authoritative until recovery

- project index publication failures preserve the canonical file, clean temps, stay non-fatal, and recover

- an append reparses its file and reuses unchanged persisted summaries

- a same-size transcript rewrite with a newer mtime reparses cwd and project metadata

- larger Codex and Claude rewrites replace cached head metadata

- Codex and Claude true appends retain head metadata through repeated EIO and rewrite recovery

- a one-shot transcript read failure stays incomplete and recovers in memory and after restart

- first-ever repeated transcript read failures publish and persist only after recovery

- a same-size subagent sidecar rewrite with a newer mtime reparses its title

- a one-shot sidecar read failure stays incomplete and recovers in memory and after restart

- a corrupt per-file scanner index falls back to a full parse and repairs itself

- a pinned discovery identifies only rows outside the global scheme window

- discovery orders publication from scan start across overlapping filesystem walks

- project catalog carries the canonical root for projects outside the capped rows

- archived migration predecessors cannot outvote the current project root

- persisted scheme metadata excludes unbounded first-prompt text

- a legacy cached Claude subagent is migrated into the conversation catalog

- project catalog omits task-only residue from a clean state

- a Claude transcript appearing in a previously sessionless project directory enters the conversation catalog

- first-ever EIO and EACCES task twin lookups publish only after recovery

- a first-ever ENOTDIR task twin lookup stays incomplete and publishes no durable scanner state

- project and conversation catalogs retain a project whose only transcript is a subagent

- discoverFiles preserves scanner filters, mtime ordering, and the per-project scheme cap

- discoverFiles applies the card cap independently to each visible project

- discoverFiles merges multiple Codex session roots without duplicate paths

- discoverFiles counts a dual-root Codex rollout once and prefers the account copy

- discoverFiles keeps native Codex spawn parents outside the recent cap

- discoverFilesWithProjectCatalog keeps quiet projects in the recent cap

- discoverFilesWithProjectCatalog refreshes cached projects when flow state changes

- current-production catalog records converge two legacy buckets for one repository

- an ambiguous legacy project key defers catalog and board migration

- demoted archived predecessors rank below live transcripts for the recency cap

- a live conversation keeps its card past the per-project card cap

- a transcript reached through a symlinked account home has one identity in the window

- an OpenClaw agent tree yields one card per transcript and none for its sidecars

### src/lib/scanner/fileScanWorker.test.ts

**cleared by neutral harness** — 11 pass, 0 fail. Harness: stage TMPDIR nested below state scratch triggers live-state guard. Neutral rerun uses /var/tmp TMPDIR and strips inherited owner/capability variables.

Initial failures:

- worker scans publish a Claude transcript that appears in a previously sessionless project directory

### src/lib/scanner/filesResponseWorker.test.ts

**follow-up** — 6 pass, 2 fail. Scanner worker follow-up: neutral rapid/concurrent projection cases create two/four workers instead of one; retired-worker delta now passes. Repair pool lifetime/reuse without weakening assertions.

Initial failures:

- a burst of rapid sequential projections is served by one worker process

- concurrent projections are served by one worker process

- a retired worker still answers the next revision with a delta from its persisted base

Remaining failures:

- a burst of rapid sequential projections is served by one worker process

- concurrent projections are served by one worker process

### src/lib/scanner/links.test.ts

**fixed** — 11 pass, 0 fail. Fixed drift: #916 requires a semantic spawn title; seed titled profiles while retaining reaper/lineage assertions.

Initial failures:

- linkEntries > suppresses a persisted handoff flag for a historical container-born stage

- linkEntries > builds the conversation lookup once for all durable provenance queries

- linkEntries > preserves an operator handoff that later gains flow membership

### src/lib/scanner/process.test.ts

**cleared by neutral harness** — 4 pass, 0 fail. Harness: bare child inherits LLV_STRUCTURED_HOST and is correctly stamped. Neutral rerun removes inherited LLV_ variables.

Initial failures:

- only the stamp this viewer writes marks a process as its own host

### src/lib/session/projectResolution.test.ts

**fixed** — 11 pass, 0 fail. Harness drift fixed: synthetic worktree under a temporary HOME resolves to that directory, while the expectation used the real current checkout repository key. Build a local synthetic repository and its worktree path; retain cwd/ownership precedence and deleted-worktree evidence.

Initial failures:

- canonical worktree cwd identity outranks a selected-project launch hint

### src/lib/stateOwnership.test.ts

**fixed** — 14 pass, 0 fail. Harness drift fixed: Bun 1.4 writes .bun/install/cache/@t@ transpiler artifacts into the probe HOME, so byte-for-byte home snapshots report compiler writes although the app state stays protected. Pin BUN_RUNTIME_TRANSPILER_CACHE_PATH outside the audited home; preserve complete home/state assertions. See https://bun.com/docs/runtime/environment-variables.

Initial failures:

- the operator's state directory > a production build that loads the instrumentation and a store writes nothing outside a temp dir

- the operator's state directory > a test run that inherited the Viewer's owner claim writes no task into the operator's store

- the operator's state directory > a test run handed the operator's directory through LLV_STATE_DIR is refused, not obeyed

- the operator's state directory > a test run that opens a registry at the operator's path explicitly is refused

### src/lib/tasks/taskColorGroupHide.test.ts

**follow-up** — 11 pass, 1 fail. Board lifecycle fence: hide dependency graph reaches runtime/lifecycle modules; extract pure path and retain architecture guard.

Initial and remaining failures:

- the hide path reaches no lifecycle code: the modules it runs through import no runtime, pipeline engine, flow, delivery or process module, relative or aliased

### src/lib/telegram/bot/service.test.ts

**cleared by neutral harness** — 57 pass, 0 fail. Harness first: stage TMPDIR places media/document fixtures under forbidden state tree, so path refusal precedes parsing. Neutral rerun separates receipt/store issues.

Initial failures:

- media validates every local image before any Telegram call and refuses disallowed chats

- media rejects truncated, excessive-dimension and extreme-aspect images before single or album transport

- one photo uses sendPhoto, attributes its receipt and stores an outgoing photo

- album sends per-image captions once and an unfinished claim replays send_uncertain

- a truncated HTTP success stays pending across a service restart

- text and media receipts use separate namespaces for both call orders and prefixed user keys

- a photo must come from under the document roots, like a document

- a document receipt has its own namespace: the same key under text, photo and document posts three times

- a document under the default root goes out as multipart sendDocument, is stored with its filename, and replays

- the shown filename defaults to the file's own name and a caption is optional

- every file refusal lands before Telegram is called, with its own code

- dot components, symlinks out of a root, hard links and the state directory are refused

- a parent directory swapped for a link after the path is checked is caught on the opened file

- without /proc the swap is caught by resolving the path again against the opened file

- a FIFO in a root is refused at once instead of holding the Viewer at the open

- the shown filename keeps the file's type class, and a text file is scanned whatever it is shown as

- a text document in UTF-16, with or without a byte-order mark, is scanned as text

- a credential assigned a plain word is caught; prose, placeholders and references are not

- a text document carrying a secret is refused with its class, never its value

- UTF-16 text appended after 64 KiB of ASCII is still read as text

- a retained provider credential in a document is refused, on its line and in UTF-16

- a refused document leaves its key free: the corrected file sends under the same clientRequestId

- an unconfirmed document send answers send_uncertain and never sends twice under its key

- document roots are the operator's setting: custom roots replace the default, bad roots are refused, empty returns to the default

### src/lib/telegram/reportLineage.test.ts

**fixed** — 3 pass, 0 fail. Fixed drift: #916 requires a semantic spawn title; seed titled profiles while retaining reaper/lineage assertions.

Initial failures:

- a report run is still recognisable after a registry reload, with no history file

### src/lib/telegram/reportRunner.test.ts

**fixed** — 44 pass, 0 fail. Fixed drift: #2405 changed default Codex report model from Astra to Sol; retain explicit presets and MCP grant assertions.

Initial failures:

- Run now launches a board-visible Codex conversation holding exactly viewer + telegram

### src/lib/telegram/reportSpawn.test.ts

**follow-up** — 4 pass, 1 fail. Scheduled report follow-up: disconnected implicit-root Telegram branch precedes explicit reportClassGrant and narrows its grant to viewer. Fix precedence in focused spawn/security change.

Initial and remaining failures:

- the report class decides the whole capability surface admission reserves

### src/components/externalRelay/ExternalRelaySection.dom.test.tsx

**fixed** — 21 pass, 0 fail. Test drift fixed: #2405, merge 311e47fd10fc78f2cd7ea1d5cd8e03f38c766a11, changed defaultModelFor(codex) from Astra to Sol. Product correctly defaults unset/switching targets; update two PATCH expectations and preserve explicitly selected Astra settings.

Initial failures:

- a pending pairing resumes on open: the identity to confirm, confirm sends its id, and unset targets take the chosen engine

- a paired relay: poller state, last outcome and progress, per-target settings, and no answering without a signed-in account

## Final verification

- Rebased after #2400 merged; relay section: 21 pass. knownRelays: 5 pass. Merged OnboardingDialog: 29 pass.
- All changed test files rerun individually: all behavioral fixes pass; extraction keeps its existing pure-dependency guard red (3 pass / 1 fail).
- Audit retry wrapper: 37 pass, including real ephemeral advisory endpoint and fail-closed diagnostics.
- SpeakButton DOM/SSR: 21 pass; unchanged pane render suites pass.
- Resources: 69 pass; recovery contention: 9 pass; packaged MCP stdio: 31 pass.
- State ownership: 14 pass; project resolution: 11 pass.
- Neutral revisit: all 150 files completed. This includes initial nonzero files plus relay and speech regression files. The old privacy matrix hit its 1200-second bound; current rebased default privacy suite completes and records its prerequisite failures above.
- TypeScript, changed-file ESLint, shell syntax, diff whitespace and merge-base publication gate are run at the final candidate. The PR records their final results.
- Independent read-only reviewers checked the entire code diff; final review includes the rebased context and this audit. Existing red architecture/lifecycle/fenced assertions remain follow-ups, and no all-main-green claim is made.
