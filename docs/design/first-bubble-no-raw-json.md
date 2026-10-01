# First message of a new agent never shows raw red JSON (#2006)

## Originating requirement

Operator, board card, in Ukrainian (verbatim):

> Коли створюєш оркестратора або нового агента, перше повідомлення кілька секунд показується як червоний сирий JSON і зникає, коли підтягується транскрипт. Одразу має показуватися звичайна бульбашка з текстом.

The issue records the first report as 2026-09-22. On 2026-10-01 at 19:24 the
operator added the dispatch instruction «розбирай задачі з вхідних по
пріорітетам і правильно запускай». Source: issue #2006 and the pinned
task.

The outcome the task pins: from the first paint, the first message of a new
seat or a new agent shows as a normal row with its text. It never shows the
envelope, raw JSON or error styling. It hands over to the transcript record
without a flicker or a duplicate. This holds for seat creation and for a plain
spawn, on desktop and at 390 px.

## Verdict in one paragraph

The red JSON was the runtime's **launch-recovery envelope**. Every structured
launch writes it into `receipt.error` during *healthy* setup. The server
projected it to the browser as `launch.error`, and `LaunchChips` printed any
`launch.error` in `text-danger`, inside the launch row of the new
conversation, until adoption retired the launch facts. Commit `71518ab12`
(2026-09-29, "Keep internal noise out of the orchestrator seat panel", on
main) fixed that at the projection and the chip without closing #2006, so
**a plain spawn on main no longer shows red JSON**. Two things are still
missing. First, no test or rendered evidence covers the plain-spawn first
message from open to transcript. Second, a seat created through the panel's
Confirm button still paints its mandate as the operator's bubble on first
paint. The mandate card then appears beside it once the files poll lands,
which is the flicker and duplicate the requirement forbids. This lane fixes
the seat path in one place and locks both paths with a DOM test and rendered
evidence.

## 1. The path in code

### 1.1 Plain spawn (board draft pane, desktop and phone)

| Step | Where | What it holds |
|---|---|---|
| Operator presses send in the draft | `src/components/DraftAgentPane.tsx:644` `submitAttempt` → `POST /api/spawn` | the prompt and the images |
| Server answers `launched` | `src/lib/runtime/structuredSpawn.ts:2293-2379` | `launched`, `launchId`, `conversationId`, `transport: "structured"`, `initialMessage`, `state`. **No `error` on a launched answer.** |
| Optimistic first bubble seeded | `DraftAgentPane.tsx:684-692` → `seedLaunchOutbox` (`src/components/conversation/outbox.ts:1193`) | `{ id: launchId, text: candidate.prompt, images, at }`, stored as `launchOwned: true` with state `delivering`. Plain prompt text. |
| Lost-response recovery seed | `DraftAgentPane.tsx:589-597` | same shape, same id (idempotent) |
| Window attached instantly | `DraftAgentPane.tsx:700-704` `provisionalSpawnFile` (`src/components/draftSpawn.ts:395`) | a `spawn:<launchId>` card, `size: 0`, `spawn.prompt = attempt.prompt`, `spawn.error = null` |
| Server's projection replaces the card on the next files poll | `src/lib/agent/spawnProjection.ts:118-185` `cardState` | `prompt` and `promptEcho` from `receipt.launchDisplay`, plus `error` **through `projectedError` (`:112-117`)** |
| LogFeed seeds the same bubble from the projection (idempotent) | `src/components/LogFeed.tsx:976-999` | `{ id: launch.launchId, text: launch.prompt, echoText, owner, state, settledAt, error: launch.error }` |
| Render | `LogFeed.tsx:1621-1629` launch row (`MandateCard` when the launch carries a mandate, then `LaunchChips`), `LogFeed.tsx:1640-1660` message row → `FeedMessageRow` → `ConversationMessageRow` (`src/components/conversation/OutboxBubbles.tsx:114`) → `UserMessageRow` | the prompt in the normal bubble; one quiet spinner in the gutter |
| Handover to the transcript | `LogFeed.tsx:888-948` (`launchEchoKeys`, `transcriptEchoes`), `:1052-1066` (`echoBindings`, `pendingOutbox`), `:1201-1255` (bound record adopts the row under key `msg:<launchId>`); adoption retirement at `LogFeed.tsx:333-340` | the transcript record supplies `canonical`; the row keeps its key |

### 1.2 Seat creation (orchestrator panel, desktop and phone)

| Step | Where | What it holds |
|---|---|---|
| Operator confirms the mandate | `src/components/orchestrator/OrchestratorPanel.tsx:431-458` (create), `:905-916` (rotate); `src/components/mobile/MobileOrchestratorSheet.tsx:776-787`; `src/components/mobile/MobileSeatCard.tsx:237` (rotate) | body `{ project, mandate, …, promptVersion? }`; `launch.firstMessage = mandate` |
| `POST /api/orchestrator/seat` or `/rotate` | `src/lib/orchestrator/seatCommand.ts:806`; the success body spreads the structured spawn body (`seatCommand.ts` near `:1128-1131`) | `launchId`, `conversationId`, `transport: "structured"` |
| Window attached instantly | `src/components/orchestrator/useSeatConfirm.ts:136-154` → `provisionalSpawnFile(...)` → `applySpawnedConversationSnapshot` | `spawn.prompt = mandate`, **no `spawn.mandate`** |
| LogFeed seeds a bubble from that card | `LogFeed.tsx:976-999`: the early return at `:980` (`if (launch.mandate) return;`) does not fire because the provisional card has no `mandate` | an operator bubble whose text is the whole mandate |
| Server's projection arrives | `src/app/api/files/response.ts:287-301` (`launchMandate`) → `spawnProjection.ts:181` | the same launch, now with `mandate: { kind: "version" \| "custom" \| "unqualified" }` |
| Render after the poll | `LogFeed.tsx:1624-1626` renders `MandateCard` in the launch row; **the bubble seeded a moment earlier is still in the outbox**, and nothing in `pendingOutbox` (`:1064`) or `conversationRows` (`:1169`) drops it | **mandate card and operator bubble with the same text, both on screen** until echo or adoption retires the bubble |

When the seat is created by MCP (`create_orchestrator`) or in another tab, no
provisional card exists, so the first card the window sees already carries
`mandate` and no bubble is seeded. The defect is specific to the Confirm
button's instant attach.

## 2. Root cause

### 2.1 The red raw JSON (the reported symptom)

1. Every structured launch parks its recovery bookkeeping in the receipt's
   `error` field during **normal** setup:
   `structuredSpawn.ts:2233-2234` writes
   `structured launch recovery: {"phase":"unpublished",…,"reason":"host publication pending"}`
   before host publication, and `structuredSpawn.ts:2252` rewrites it as
   `{"phase":"uncertain",…,"reason":"first-message acknowledgement pending"}`
   before the first message. The writer is `writeStagedRecovery`
   (`structuredSpawn.ts:1900-1902`) → `registry.preserveSpawnArtifactOwnership`
   (`src/lib/agent/registry.ts:5871-5878`), which sets `receipt.error`. The
   prefix is `STAGED_RECOVERY_PREFIX` (`src/lib/runtime/stagedRecovery.ts:3`).
2. Before `71518ab12`, the projection copied it verbatim
   (`spawnProjection.ts:158` at `71518ab12^`: `error: receipt.error`).
3. Before `71518ab12`, `LaunchChipsView` printed any `launch.error` in red,
   whatever the launch state (`LaunchChips.tsx:99-101` at `71518ab12^`:
   `{launch.error ? <span … text-danger>{launch.error}</span> : null}`).
4. The launch row sits directly beside the first bubble in the new window, and
   it retires on adoption (`LogFeed.tsx:333-340`) or on the first answer. The
   operator saw that as the first message showing as red JSON for a few
   seconds and disappearing when the transcript loaded.

`docs/design/seat-panel-noise.md` §"Point 1" diagnosed the same envelope from
the seat panel on 2026-09-29. Its fix is generic and covers every launch: it
lives in the projection and the chip, not in any seat code.

**State on main (`311e47fd1`):**

- `projectedError` (`spawnProjection.ts:112-117`) returns `error: null` while
  recovery runs, and only the plain `recovery.reason` with
  `recoveryStopped: true` once recovery stopped. It is applied at
  `spawnProjection.ts:173`. Covered by `src/lib/agent/spawnProjection.test.ts:455`.
- `LaunchChips.tsx:117-124` paints the error line only when
  `state === "failed" || recoveryStopped`. It shows one translated sentence
  (`spawnCard.failedDetail`), with the raw reason in `title` only.
- The `/api/spawn` launched answer carries no `error`. The browser's
  provisional card sets `error: null`.
- The bubble's own failure line (`OutboxBubbles.tsx:176-190`) exists only in
  phase `failed` (`src/components/conversation/messageRow.ts:353-355`). Its
  visible text is a translated reason, and the raw sentence sits behind the
  disclosure.
- The feed's other red text, `kind: "raw"` with `err`
  (`src/components/feed/FeedItem.tsx:443`), comes only from the non-JSONL
  `plain` format (`src/components/feed/parse.ts:3403`, `:3462`), never from a
  launch window. A `spawn:` card has `size: 0` and tails nothing.

The red JSON is gone on main for every launch path, but nothing proves it on
the surface the operator named. `71518ab12` captured only the **seat panel**:
a static launch window with hand-fed facts. There is no plain-spawn capture and
no LogFeed-level DOM assertion over the first message from open to transcript.

### 2.2 The residual defect: a seat's first message flickers and duplicates

`useSeatConfirm.ts:136-154` builds the seat's instant-attach card with
`provisionalSpawnFile`, and that function has no way to say the launch prompt
is a mandate (`draftSpawn.ts:395-430`). The window's first paint therefore
seeds and renders the mandate as the **operator's bubble**. When the files
poll brings the server card with `mandate`, `MandateCard` renders in the
launch row while the bubble stays, because the seed's `launch.mandate` guard
(`LogFeed.tsx:980`) prevents only a new seed and does not remove the bubble
already seeded. That gives a bubble-to-card change on screen and two copies of
one message, which is what the requirement rules out ("hands over … without a
flicker or duplicate", "covers a seat creation").

## 3. The change

### 3.1 Seat: the instant-attach card says the prompt is a mandate (code)

1. `src/components/draftSpawn.ts:395` `provisionalSpawnFile`: add an optional
   fourth parameter `mandate?: MandateDelivery` (type from
   `@/lib/runtime/messageOrigin`). When it is given and the attempt has a
   prompt, set `spawn.mandate = mandate` next to `prompt`, `promptImages` and
   `promptAt`. Nothing else in the function changes.
2. `src/components/orchestrator/useSeatConfirm.ts:136-154`: every caller of
   this hook is a seat create or rotate, so the hook always passes a mandate.
   Derive it from the body the hook already holds, using the same rule the
   server applies in `seatMandate`
   (`src/lib/runtime/deliveredMessageOccurrences.ts:88-94`) as far as the
   browser knows it:
   - `typeof input.body.promptVersion === "number"` → `{ kind: "version", version: input.body.promptVersion }`
   - otherwise → `{ kind: "unqualified" }` (the card's title then reads
     "Mandate" until the next poll names the qualifier, if it has one.
     Only the title's qualifier word can change; the card itself does not
     move.)

   Put the derivation in a small exported pure function in the same file, for
   example `seatProvisionalFile(...)`, so the DOM test below can build exactly
   what the hook builds without mounting the panel.

With the provisional card carrying `mandate`, the existing guard at
`LogFeed.tsx:980` stops the bubble from ever being seeded. The existing launch
row at `LogFeed.tsx:1624-1626` renders `MandateCard` from the first paint, and
the server card later renders the same card in the same row.

**Why the seat shows the mandate card instead of a bubble.** The operator's
words say "a normal bubble with text". For a seat, the transcript's own record
of the first message renders as the collapsed mandate card (#1166, and
`71518ab12` for the launch window). If the optimistic row were a bubble, the
handover to the transcript would turn it into a card, which is the flicker the
requirement forbids. The normal presentation of that message is the card, so
the card is shown from the first paint. This reading is settled by the code
and the requirement's own no-flicker clause, so no operator decision is
needed.

### 3.2 Plain spawn: no product change

The plain spawn needs no code change on main. The work is the DOM test (§6.1)
and the rendered evidence (§6.3). Builder rule: if any assertion in §6.1 or
§6.3 fails on the plain-spawn path, the fix belongs in the files this document
names (`LogFeed.tsx`, `OutboxBubbles.tsx`, `messageRow.ts`, `LaunchChips.tsx`,
`outbox.ts`). Report which assertion failed and the fix in the PR.
Node-identity loss across `spawn:` → transcript is the one assertion that has
not been observed either way; see §6.1.

### 3.3 What the change does NOT include

- No client-side "looks like JSON" filter in the chip, the bubble or the seed.
  The projection is the one chokepoint (`projectedError`) and it has a test.
  A second, regex-based gate in the browser would be OVER-BUILT and would
  hide the next server leak instead of failing a test.
- No change to the recovery envelope's storage in `receipt.error`
  (`structuredSpawn.ts`, `registry.ts`). Moving it to its own field is a
  registry-schema change, which is deferred below.

## 4. States to cover

"First message" means the plain spawn's prompt bubble, or the seat's mandate
card. Every state must satisfy the invariant below.

**Invariant:** exactly one first-message row. Its text is the prompt or
mandate text. Nowhere in the feed's text content does
`structured launch recovery`, `{"phase"`, `"startedAt"` or any `{"` appear.
No element of the first-message row or the launch row has a `danger` class
(`text-danger`, `bg-danger-soft`, `border-danger…`), except in the failed
state.

| State | Launch facts fed (plain spawn / seat) | Expected first-message row | Expected launch row |
|---|---|---|---|
| **Pending**: card attached, nothing delivered | `state: "reconciling"`, `initialMessage: "queued"`, `error:` **the raw envelope** (fed on purpose, as the `seat-noise` fixture does, so the render layer is proven independently of the projection) | plain: bubble with the prompt, `data-message-row="pending"`, one spinner in the gutter, no failure line. Seat: one `[data-mandate-card]`, zero `[data-outbox-entry]` | state chip in its neutral or warning hue, no `[data-launch-chip="error"]` |
| **Pending, browser-only**: before the first poll | plain: `provisionalSpawnFile` card; seat: `seatProvisionalFile` card | as above | as above |
| **Delivered**: receipt says delivered, no transcript yet | `state: "recovered"`, `initialMessage: "delivered"`, `deliveredAt` | plain: the same bubble, same node, spinner cleared (`confirmed`) and the copy control in the same slot. Seat: the same card | success-hue state chip only |
| **Transcript arrived**: the scanned row adopts the launch | the `adopted(...)` row with the first user record in the tail, then the `answered(...)` row | plain: the same row under key `msg:<launchId>`, now `canonical`, with no second bubble. Seat: no outbox bubble, and no mandate card left in the launch row (the transcript's own mandate row takes over, as `LogFeed.startingWindow.dom.test.tsx:442` already pins) | chips retire per the existing rules |
| **Failed launch** (the only state allowed to be red) | `state: "failed"`, `initialMessage: "failed"`, `retrySafe: true`, `error: "runtime host unavailable"`; and the stopped-recovery variant `recoveryStopped: true` with a plain reason | plain: bubble with the prompt text unchanged; one failure line under it carrying the **translated** reason; the raw reason only in `title` or behind the disclosure; no JSON. Seat: card unchanged | one `[data-launch-chip="error"]` reading `spawnCard.failedDetail` in the active locale, raw reason only in `title` |

## 5. Desktop and 390 px expectations

Both widths use the same `LogFeed` and `ConversationMessageRow`. Expectations
are per frame:

- **Desktop (1280 × 800 and 1440 × 900)**: the plain-spawn bubble is right
  aligned at the transcript bubble's width cap. Its bounding box at Pending is
  the same as at Transcript arrived, within 1 px for top, left and width. The
  only allowed change is the gutter's spinner turning into the copy control in
  the same box. The seat card stays in the launch row with no bubble beside
  it.
- **Phone (390 × 844, coarse pointer emulated)**: the same as desktop, using
  the phone's widths (`UserMessageRow`'s mobile cap, which is the cap the
  transcript record uses since slice 3). Measure no horizontal overflow
  (`scrollWidth - innerWidth ≤ 0`) and no zero-width control. The gutter
  affordance and any failure action must be at least 44 px on a coarse
  pointer (`OutboxBubbles.tsx` `affordanceClass(coarse)` and `ROW_ACTION`).
- **Both**: light and dark, English and Ukrainian. The Ukrainian failure
  sentence and reason must wrap inside the row with no overflow.

## 6. Tests and evidence

### 6.1 DOM test: extend `src/components/LogFeed.startingWindow.dom.test.tsx`

Use this file because it already drives LogFeed the way the board does
(`placeholder`, `launchFacts`, `adopted`, `answered`, with the log tail
mocked) and holds the seat-mandate case at `:442`. Add a constant
`ENVELOPE = "structured launch recovery: " + JSON.stringify({ phase: "uncertain", startedAt: 1, checks: 2, nextTryAt: 2, reason: "first-message acknowledgement pending" })`
and a helper `assertCleanFirstMessage(host)` that checks the §4 invariant.
For the danger check, query the feed for `[class*="danger"]`, excluding
nothing.

Each of the following tests asserts the §4 invariant at every step:

1. **"plain spawn: the first message is the prompt bubble from the first paint to the transcript"**.
   Use an operator-origin prompt (no `llv:structured-user origin=agent` marker,
   so the transcript renders the operator's own row and not a relay card).
   Steps: `placeholder` with `launchFacts({ error: ENVELOPE })`, then
   `launchFacts({ state: "recovered", initialMessage: "delivered", deliveredAt })`,
   then `adopted(...)` with the user record in `tailLines`, then
   `answered(...)`. At every step there is exactly one `[data-message-row]`
   containing the prompt's first line. Keep a reference to that element at
   the first step and `expect(...).toBe(sameNode)` at each later step. If node
   identity fails on main, it is in scope (§3.2): report it and fix it in
   LogFeed's launch-echo binding.
2. **"plain spawn, browser-only first paint"**: the card from
   `provisionalSpawnFile(...)` itself (`draftSpawn.ts:395`), seeded the way
   `DraftAgentPane.tsx:686` seeds it. Expect one bubble and a clean invariant.
3. **"failed launch: the only red is the failure sentence"**: facts as in the
   §4 failed row. Expect one bubble with the prompt text, one
   `[data-outbox-failure]` whose `[data-outbox-status]` equals a translated
   reason, one `[data-launch-chip="error"]` reading `spawnCard.failedDetail`,
   and no JSON anywhere. The danger check applies to everything except those
   two elements.
4. **"seat confirm: the mandate is one card from the first paint and never the operator's bubble"**.
   This test is red on main because `seatProvisionalFile` does not exist and
   the bubble is seeded. Steps: the card from `seatProvisionalFile(...)`, then
   the server card `launchFacts({ mandate: { kind: "version", version: 1 }, error: ENVELOPE, prompt: MANDATE })`,
   then `adopted(...)`. Expect exactly one `[data-mandate-card]` and zero
   `[data-outbox-entry]` on the first two steps, and zero
   `[data-outbox-entry]` after adoption.
   Also test the same steps with a **pre-seeded** launch-owned outbox entry
   left by an earlier provisional render (`seedLaunchOutbox(conversationId, { id: launchId, text: MANDATE, … })`
   before the first render). Mark it `test.todo` and leave it unimplemented
   unless the builder implements the deferred guard (§9).

Add a unit case in `src/components/draftSpawn.test.ts`:
`provisionalSpawnFile(..., mandate)` carries `spawn.mandate`, and without the
argument the card is byte-for-byte what it was.

### 6.2 Run the tests in isolation

Never run these against the operator's live state (AGENTS.md):

```
LLV_STATE_DIR="$(mktemp -d)" bun test \
  src/components/LogFeed.startingWindow.dom.test.tsx \
  src/components/draftSpawn.test.ts \
  src/lib/agent/spawnProjection.test.ts \
  src/components/conversation/LaunchChips.render.test.tsx
bunx tsc --noEmit
bunx eslint <changed files>
bun scripts/privacy-publication-gate.ts --base "$(git merge-base HEAD origin/main)" --check-commits
```

### 6.3 Rendered evidence: existing drivers only, one block each

AGENTS.md allows no new driver and no file named after the issue. Name the
scenario by what it shows (`first-message`), not by #2006.

**Desktop**: `src/components/kanban/kanbanBoard.browser.test.tsx`, add one
`describe("a new conversation's first message is a normal row", …)` over
`src/components/kanban/issue1695Evidence.fixture.tsx?scenario=first-message&case=<…>`.
Model it on the `"seat panel carries no internal noise"` block at `:13502`:
the same `serveEvidenceFixture`, `openFixture` and `readPanel`-style reader.
Frames at 1440 and 1280, light and dark, en and uk.

Fixture additions, all in `issue1695Evidence.fixture.tsx` (beside the
`seat-noise` scenario at `:380-417`):

- Plain-spawn cases `p1`–`p4`: the conversation pane opened on a
  `spawn:<launchId>` card in each §4 state. Pending carries `error: ENVELOPE`.
  Expose `window.evidence.advanceFirstMessage()`, which moves the same pane
  through Pending → Delivered → Transcript arrived (it serves the tail lines
  from `/api/log`, which currently answers empty at `:2532`). The driver reads
  every step in one page, so the row's bounding box and element identity are
  compared within the same frame series, not across reloads.
- Seat cases `s1`–`s3`: the `NO_SEAT` panel draft, with **Confirm actually
  pressed**. Add a `POST /api/orchestrator/seat` answer (beside `:2534`)
  returning
  `{ ok: true, launched: true, transport: "structured", launchId, conversationId, state: "path-pending", initialMessage: "queued", path: null }`,
  so `useSeatConfirm` builds its real provisional card. The next files poll
  then returns the server card with `mandate` and `error: ENVELOPE`, then
  the adopted row.
- Failed case `f1`: the plain spawn in the failed state.

Each frame records: the envelope test
(`/structured launch recovery|"phase"|\{"/` on the pane's text), the count of
`[class*="danger"]` elements outside `[data-outbox-failure]` and
`[data-launch-chip="error"]`, the counts of `[data-message-row]`,
`[data-outbox-entry]` and `[data-mandate-card]`, the first row's
`getBoundingClientRect()`, whether it is the same node as in the first step
(through a `data-` marker set by `page.evaluate` on step one), `overflowX`, and
zero-width controls. Any deviation from §4 and §5 fails the block. Write the
readings to `evidence/first-message/desktop.json` and the frames to
`.artifacts/first-message/`.

**Phone**: `src/components/mobile/issue1671Evidence.browser.test.tsx`, add one
`describe("a new conversation's first message is a normal row on the phone", …)`.
Use the same cases through `issue1671Evidence.fixture.tsx` (the `seatnoise`
query at `:119-121` is the pattern), at 390 × 844 with touch, light and dark, en
and uk, and add the §5 44 px checks. Write the readings to
`evidence/first-message/phone.json`. The phone's spawn path is
`MobileFocusView.tsx:660` → `DraftAgentPane`, and its seat path is
`MobileOrchestratorSheet.tsx:786`, so both cases run the same components as on
desktop.

Run:

```
LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=<chrome> bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "first message is a normal row"
LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=<chrome> bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "first message is a normal row"
```

## 7. What NOT to touch

- **Fenced by other lanes**: `src/lib/mcp/*`; spawn admission
  (`src/lib/agent/spawnAdmission*`); the seat tick panel
  (`src/components/orchestrator/SeatTickBody.tsx`, `SeatTickChip.tsx`,
  `useSeatTickSettings.ts`, `openSeatTick.ts`, `seatTickView.ts`); the
  external relay section (PR #2400); `src/lib/search/*`.
  `useSeatConfirm.ts` is the seat **creation** hook. It is not the tick panel,
  and §3.1 touches only its provisional-card construction.
- `src/lib/runtime/structuredSpawn.ts`, `src/lib/runtime/stagedRecovery.ts`,
  `src/lib/agent/registry.ts`: the recovery envelope stays where it is.
- `src/lib/agent/spawnProjection.ts` `projectedError`: it is correct. Do not
  widen or duplicate it.
- `LaunchChips.tsx` state logic and `messageRow.ts`'s failure model: they
  are correct for every §4 state. Touch them only if a §6 assertion proves
  otherwise.
- The outbox's retirement and binding machinery (`outbox.ts`
  `seedLaunchOutbox`, `reconcileEchoRetirements`, `transcriptEchoBindings`,
  `submissionJoin.ts`): out of scope unless the §6.1 node-identity assertion
  fails.
- `parse.ts`'s `raw` rows and `FeedItem.tsx:443`: they belong to plain-format
  job logs and are not on this path.
- No live state, no restart, no deploy.

## 8. Validation against the requirement

| Requirement | Met by |
|---|---|
| "перше повідомлення … червоний сирий JSON" never shows | already true on main through `projectedError` and the chip gate. §6.1 tests 1–3 and the desktop and phone evidence feed the raw envelope to the render layer and prove it never prints |
| "Одразу має показуватися звичайна бульбашка з текстом" | plain spawn: seeded before attach (`DraftAgentPane.tsx:686`), asserted from the first paint. Seat: the card that the transcript itself renders, from the first paint (§3.1) |
| "зникає, коли підтягується транскрипт", with no flicker or duplicate at handover | plain: same row and same node, asserted. Seat: §3.1 removes the bubble-then-card change and the duplicate, asserted by §6.1 test 4 and evidence `s1`–`s3` |
| seat creation and plain spawn, desktop and 390 px | §6.3 cases `p*`, `s*` and `f1` in both drivers |

## 9. Deferred — not currently justified

- **LogFeed guard that hides a launch-owned bubble once `launch.mandate`
  arrives** (filter in `pendingOutbox` at `LogFeed.tsx:1064` for
  `entry.launchOwned && entry.id === launch.launchId && launch.mandate`).
  §3.1 prevents the seed on every Confirm path. The guard would only matter
  when the server's seat-file read fails on one poll and succeeds on the next
  (`files/response.ts:291-297` falls back to "no mandate"), or for a bubble a
  tab seeded before this change shipped. Build it if §6.3 shows a duplicate
  that §3.1 does not prevent.
- **Moving recovery bookkeeping out of `receipt.error` into its own receipt
  field.** This would remove the overloaded field at its source, but it is a
  registry and store schema change across `structuredSpawn.ts`, `registry.ts`,
  `sqliteRegistryStore.ts` and older readers (`stagedRecovery.ts:1-2` keeps it
  in `error` deliberately for them). The projection already contains it.
- **A client-side JSON or envelope sniffer** in `LaunchChips`, `seedLaunchOutbox` or
  `OutboxBubbles` (OVER-BUILT, §3.3).
- **Merging the failed launch's two red lines** (the chip sentence and the
  bubble's failure line) into one. That is a real redundancy, but the failed
  state is allowed to be red, and the requirement does not ask for it.

## 10. Prior work searched

Transcript search, project-scoped and unscoped, with the phrasings
"first message red JSON launch bubble", "#2006 raw JSON optimistic",
"червоний JSON перше повідомлення" and "launchOwned bubble envelope
placeholder", found nothing beyond this stage's own brief. The prior work is in
the repository: `docs/design/seat-panel-noise.md` (the same envelope, seat
panel), commit `71518ab12` (its fix), #1793 (`979aa1807`: a delivered launch
prompt never reads "Delivering"), and the send-latency slices #1946, #1963,
#1950 and #2001 together with `docs/design/send-latency-and-message-states.md`
(one row per message, same-key adoption). I checked each claim taken from them
against the code at `311e47fd1`.

## 11. As built

The rendered evidence found three things beyond §3.1, each fixed and each red
before its fix:

- **The phone's seat Confirm builds its own provisional card.**
  `MobileSeatCard.tsx` calls `provisionalSpawnFile` itself and did not pass the
  mandate either; the sheet showed the mandate as an operator bubble beside the
  mandate card. It now passes `seatMandateDelivery(...)`, the one rule
  `useSeatConfirm` uses (`seatProvisionalFile`).
- **An empty frame at the hand-off.** `LogFeed` retired the launch bubble the
  moment the scanned row carried `file.launch`, a poll before the window had read
  the transcript's tail. For that gap the window held no first message at all.
  The retirement now waits for the transcript's first row (`transcriptAttached`).
  `LogFeed.startingWindow.dom.test.tsx` feeds the adopted row with an empty tail
  first.
- **The bubble moved 37 px at the hand-off.** The launch chips sat above the
  launch prompt's bubble while the window had no transcript, and below the
  transcript's row after it. The launch-owned bubble now renders above the chips
  in both states. `CONVERSATION_TAIL_ORDER` is unchanged; only the launch's own
  prompt is placed ahead of the chips.

Evidence: `evidence/first-message/desktop.json` (24 frames: 1440 and 1280,
light and dark, en and uk, cases p, s and f) and
`evidence/first-message/phone.json` (12 frames at 390). The plain case on the
phone reads each state as a first paint (`&step=<n>`) because the fixture's
focus view re-resolves the conversation when its path flips; the in-page
hand-off (same node, no empty frame, no moved row) is asserted on desktop and in
the DOM test.

Left alone, and visible in the evidence: the create draft reappears for a frame
between the provisional card and the server's seat read (the same with and
without this change, possibly a fixture race), and the failure line's reason
toggle is 15 px tall on the phone (it is a disclosure, not the failure's action,
which is 44 px).
