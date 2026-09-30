# Composer context mode for Codex

Status: design, ready to build. Task 95696127, pipeline bab19b14.

## 0. The originating requirement

Operator, 2026-09-30 about 12:05 UTC, Russian speech-to-text, verbatim from the
task's details:

> «Сейчас, когда я хочу закинуть сообщение кодексу в контекст, есть специальная
> такая менюшка, которую можно нажать, но мне это неудобно. Я бы хотел сделать
> по-другому: чтобы была кнопочка... Наверное, которая бы помечала бы input как
> вот это, как будто что это контекст, вот, и оно чтобы оно показывалось, что я
> его как будто бы отправил. Вот, и когда оно уже появилось, то тогда оно
> рендерилось. Ну, короче, как правильно, чтобы оно рендерилось, грубо говоря,
> чтобы все стейты были правильно сделаны. И чтобы было очевидно. Просто я чтобы
> мог, грубо говоря, мог перейти в этот режим и постоянно отправлять сообщения
> только вот в виде контекста, да, а если я там... скажем так, агент закончил, то
> тогда пусть этот режим переключается в обычный. Может быть, когда он работает,
> пусть он переключается в тот режим, а когда не работает, то назад. Может быть,
> даже это было бы получше. Вот. Но при этом как бы нужно вот этот debounce
> какой-то, throttle сделать, чтобы на всякий случай, чтобы правильно это все
> состояния определять.»

In English: the menu for putting a message into Codex's context is awkward.
The operator wants a button that marks the input as context. A message sent
that way should look sent at once and then render properly when it lands, with
every state correct and obvious. They want to stay in that mode and keep
sending context. When the agent finishes, the mode should go back to normal.
Better still, the mode could follow the agent: context while it works, normal
while it does not. That switching needs a debounce so the states are read
correctly.

The pinned acceptance criteria (toggle; auto mode with named debounce and
guards; optimistic row lifecycle with dedupe; 390 px and desktop, EN and UK;
tests) are answered section by section below. §10 checks the design against
the quote.

## 1. The design in one paragraph

A **Context** toggle sits beside the model pill in the composer's options row
on the desktop and in the tools row on the phone. It appears only on Codex
structured conversations. It is enabled when the host advertises
`capabilities.inject` and disabled with a reason otherwise. In context mode,
Enter, the Send button and one-tap dictation call the existing
`injectContext`. The Send button, the placeholder and the input box change to
the context look. By default an **auto** rule drives the mode from the host's
turn axis. The mode enters context after 400 ms of a running turn. It leaves
after 2500 ms of an idle turn. It never flips while the operator is typing,
dictating, or has a submission in flight. A manual press holds until the next
debounced turn boundary. Every injection now writes an optimistic row into the
conversation's existing outbox, marked `intent: "context"`. The outbox
dispatcher never sends such a row. It settles from the inject receipts the
composer already receives. When the transcript record arrives, the #1950
submission join binds it to the row, so the message keeps one row. The server,
the runtime host and the inject route stay unchanged.

## 2. What exists today (grounding)

| What | Where |
|---|---|
| The injection action | `src/components/TmuxComposer.tsx:4052-4153` (`injectContext`, #1560). It refuses before anything is durable in these cases: no `capabilities.inject` (`:4072`), attachments still reading or failed, a submission still saving (`composerSubmissionSaving`, `:4071`), documents already on their way in (`refuseWhileInjecting`, `:1832-1843`), a blocked send, and staged images (`:4089`). It clears the draft (`:4105`), fences the documents, posts `injectRuntimeContext` (`:4123`), and restores the draft on refusal (`:4152-4153`). It never falls back to steering. |
| Where it is offered | Send-menu entry `id: "inject"`, `TmuxComposer.tsx:4636-4650`, labelled by turn state (`inject.hintActive` / `inject.hintIdle`). |
| Ordinary submission | `queueSubmit`, `TmuxComposer.tsx:2609`. It admits into the outbox at `:2641-2700` (`outboxCanAdmit`, `enqueueOutbox`, selected-context preview). The Enter/dictation route is `submit: (overrideText) => queueSubmit(overrideText)` at `:1742`. The form submit is `handleSubmit` at `:4235`. Steering is `steerRunningTurn` at `:4214` (`policy: "steer-if-active"`). |
| Client call | `injectRuntimeContext`, `src/hooks/useRuntime.ts:441`, which posts `/api/runtime/inject`. `postCommand` (`:272-313`) answers `{ ok:false, error:"network" }` when no HTTP answer arrived, and carries `delivery: "refused" | "uncertain" | "accepted"` when the route classified the outcome. |
| Engine write | `CodexAppServerHost.inject`, `src/lib/runtime/codexAppServerHost.ts:2042`. It writes a `response_item` user message carrying the same structured-user envelope and `dedup` marker a send carries (`:2098-2117`). The rollout scan reads that raw form at `:654-673`. |
| Receipt lifecycle | `structuredDeliveryQueue.ts:1694` (`executeInjection`) and `:1779` (`settleObservedInjection`). The receipt moves pending → `delivering`, then ends in one of three states. `delivered` carries reason `INJECTION_INTO_RUNNING_TURN` or `INJECTION_INTO_HISTORY` (`:510-513`), and only after the record is seen in the rollout. `uncertain` carries `INJECTION_ACKNOWLEDGED_BUT_UNOBSERVED` or `…_UNVERIFIED_AFTER_ACTUATION`. `failed` carries `stale-generation`, `unsupported-injection`, `stale-turn` or another pre-actuation refusal. A running-turn injection is recorded only at the turn's next model request, which can be minutes away. |
| No Retry, no Discard for injections | `isRetryableReceipt`, `src/components/runtime/deliveryState.ts:43`. Commit `c1c6ad29a` explains why: the engine does not deduplicate, so a same-key retry would be a second insertion. |
| Optimistic rows | The per-conversation outbox, `src/components/conversation/outbox.ts` (`OutboxEntry` `:38`, `outboxStateForReceiptStatus` `:213`, `outboxReceiptPatch` `:254`, `outboxEntryUnresolved` `:1018`, `enqueueOutbox` `:1105`, `holdsLocalWireFence` `:2122`, `nextDispatch` `:2130`, `claimOutboxDispatch` `:2136`, `releaseHeldOutbox` `:1452`, `retryOutbox` `:1513`). The composer projects receipts onto rows by idempotency key at `TmuxComposer.tsx:2474-2490`. |
| One message, one row (#1950) | `localSubmissionJoin`, `src/components/conversation/submissionJoin.ts:58`, maps `dedup token → row id` from the operation ids the browser holds. The server map is `/api/log/provenance` `submissions` (`src/lib/runtime/submissionIdentity.ts`). In `src/components/LogFeed.tsx`, `:868` builds the join, `:869-915` builds the echo ledger, `withheldRecords` (`:1099-1110`) holds back a record that might belong to a row that has no operation yet, and `visibleOutbox` (`:1025`) chooses the tail. Receipts owned by a rendered row are removed from the composer's receipt disclosure (`TmuxComposer.tsx:3754`). |
| Delivered-occurrence join (#1117) | `assignDeliveredOccurrences`, `src/components/feed/deliveredOccurrences.ts`. It matches by text digest and time, for deliveries that carry **no** per-row identity. An injected record always carries the dedup marker, so the submission join is what dedupes it. The occurrence join stays as it is. |
| Row model | `src/components/conversation/messageRow.ts` (`MessageRowAction` `:62`, `transportLine` `:174`, `locallyRetryable` `:239`, `operationRetryable` `:256`, `messageRowModel` `:264`). The row component is `ConversationMessageRow` / `FeedMessageRow` in `OutboxBubbles.tsx`, which sets its attributes at `:346`. Row actions are in `useOutboxRowActions`, `OutboxBubbles.tsx:467` (`onClear` at `:479`). Recovery `check` is at `TmuxComposer.tsx:3701-3715`. |
| Composer bar | `src/components/ComposerBar.tsx`. The send control is at `:404-500` with a hard-coded `Play` glyph at `:384`. The input box is at `:620-628`. The phone tools row `unitTools` is at `:537-546`, in the order `leftSlot`, picker, voice, mic, send, menu chevron. The desktop options row at `:757-762` holds `leftSlot` on the left and the picker on the right. `SendMenuAction` is at `:19-26`. `TmuxComposer` passes `leftSlot` (the `RuntimePill`) at `:4717-4730` and `sendIdleClassName` at `:4522`. |
| Turn axis | `RuntimeSession.turn: "unknown" | "idle" | "running" | "interrupt_requested"`, `src/lib/runtime/contracts.ts:55,543`. The composer reads it as `structuredSession.session.turn`. |
| Capability | `capabilities.inject` is set only for `engine === "codex"` with the `native-inject` flag (`structuredDeliveryController.ts:601`). |

Prior work: searches of the transcripts (project, then all projects) for the
toggle, context mode, optimistic injection rows and `inject_items` returned
nothing except this lane's own brief. No earlier design exists. #1560's
commits are the ancestry, and the code above is their current state.

## 3. Where the toggle lives

### 3.1 Visibility

| Conversation | Toggle |
|---|---|
| Not on the structured surface (`caps.surface !== "structured"`), or not Codex (`structuredSession.session.sessionKey.engine !== "codex"`, falling back to `file.engine` while no session is known) | Hidden. The auto machine does not run and the mode is normal. |
| Codex, structured, no runtime session yet (host unhosted or dead) | Shown, disabled, reason `composer.context.noHost`. |
| Codex, structured, session without `capabilities.inject` | Shown, disabled, reason `inject.unsupported` (existing string). |
| Codex, structured, `capabilities.inject === true` | Shown, enabled. |

One exception keeps the operator's words from being sent as the wrong kind of
message. The capability can disappear while the mode shows **context**: the
host restarts on an app-server without `thread/inject_items`, or answers
`-32601`, which makes `codexAppServerHost.ts:2124` downgrade it. In that case
the toggle stays enabled so the operator can leave context mode, and Send is
disabled with reason `composer.context.blocked`. Enter shows the same reason
and keeps the draft. **A submission is never converted from context to an
ordinary send, or the other way round, behind the operator's back.** An
ordinary Codex send interrupts the running turn, which is the one thing
context mode promises not to do.

### 3.2 Desktop

The toggle joins `leftSlot`: `TmuxComposer.tsx:4717` passes
`<>{runtimePill}{contextToggle}</>`, so the toggle sits right of the model pill
in the options row under the input (`ComposerBar.tsx:758-761`). It is a
`h-7 rounded-full px-2.5 text-label font-semibold` chip, the same height as the
pill, with a `Layers` icon and the word **Context**. When auto is controlling
the mode, it adds a muted `auto` caption. It carries `aria-pressed` and a
`Hint` (`composer.context.hintOn` / `hintOff`). Off: `border border-border
text-secondary`. On: `border-info/45 bg-info-soft text-info`.
`RuntimePill.tsx` is not edited.

### 3.3 Phone

The same `leftSlot` fragment lands in `unitTools`, so the row becomes pill,
**toggle**, picker, voice, mic, send, chevron. The toggle is a real 44 × 44 px
target holding a 32 px visual, following the row's own rule
(`ComposerBar.tsx:352-357`). It shows the icon only, with `aria-label`
`composer.context.toggleAria` plus `aria-pressed`, and the on state uses the
info fill. The pill is already `min-w-0 truncate` (`RuntimePill.tsx:694-700`),
so it gives up the width. The 390 px budget: the form's padding and the box's
padding leave about 352 px. Six 44 px controls plus gaps take about 276 px,
which leaves the pill at least about 76 px. §8 measures this. While dictation
records, the row already drops `leftSlot` (`ComposerBar.tsx:539`), and the
auto machine is frozen then (§4.3), so a hidden toggle cannot change state.

### 3.4 The auto setting

The auto setting is a `menuitemcheckbox` in the existing send menu, labelled
`composer.context.auto` with description `composer.context.autoHint`.
`SendMenuAction` gains one optional field, `checked?: boolean`. When the field
is set, `SendMenu` renders the item with `role="menuitemcheckbox"` and
`aria-checked`, and selecting it does not close the menu. The existing
"Add to context" entry stays as a one-shot action. It calls the same
`injectContext` and therefore gets the same optimistic row.

## 4. Auto mode: the state machine

A pure reducer in a new `src/components/composerContextMode.ts`, driven by a
small hook in the same file that owns one `setTimeout` for the nearest
deadline. No library.

### 4.1 Named values

```ts
export const CONTEXT_ENTER_AFTER_MS = 400;   // running must hold this long to enter context
export const CONTEXT_EXIT_AFTER_MS = 2_500;  // idle must hold this long to return to normal
export const CONTEXT_TYPING_QUIET_MS = 1_500; // no draft edit for this long before an automatic flip
```

The two windows are asymmetric on purpose. Entering late only costs one
ordinary send in the first 400 ms of a turn, which is what happens today.
Leaving early is the expensive error. Between turns, Codex often reports a
short idle gap: the native queue dispatches the next message, a steer lands,
or an orchestrator follow-up arrives. A mode that dropped to normal in that gap
would turn the operator's next Enter into an interrupt. 2.5 s covers those
gaps and is still short enough that "the agent finished" reads as immediate.

### 4.2 Inputs, normalised on every evaluation

- `reading`: `running` for `running` and `interrupt_requested` (the turn still
  exists). `idle` for `idle`. `unknown` for `unknown` or no session.
- `supported`: `capabilities.inject === true`.
- `autoEnabled`: `localStorage["llv_composer_context_auto"] !== "0"`, on by
  default and shared by every conversation in this browser.
- Guards:
  - `typing` means the last `input` or `compositionupdate` event on the
    composer form (both bubble from the textarea to the `<form>` at
    `TmuxComposer.tsx:4734`) was less than `CONTEXT_TYPING_QUIET_MS` ago, or
    an IME composition is open (`compositionstart` without
    `compositionend`).
  - `dictating` means `ComposerBar` reports a recording through a new
    optional `onDictationChange(recording)` prop.
  - `inFlight` means any of these: an injection whose HTTP answer has not
    arrived (a counter `injectsPending`, raised at `TmuxComposer.tsx:4120` and
    lowered in the answer's `finally`), `busy`, `voiceSending`,
    `reconcilingSend`, or `composerSubmissionSaving(cardId)`.

### 4.3 State and transitions

```ts
type Mode = "normal" | "context";
type Turn = "idle" | "running";
interface ContextModeState {
  debouncedTurn: Turn | null;                       // null until the first known reading
  candidate: { turn: Turn; since: number } | null;  // a reading waiting out its window
  override: { mode: Mode; anchor: Turn | null } | null; // manual press, auto on
  manual: Mode;                                     // the mode while auto is off
  shown: Mode;                                      // what the toolbar shows and Enter uses
}
```

One evaluation, `step(state, inputs, now)`:

1. **Debounce the turn.**
   - `reading === "unknown"` sets `candidate = null`. The debounced turn
     holds, and so does the mode. A snapshot gap is not evidence.
   - `debouncedTurn === null` adopts `reading` at once. A conversation opened
     mid-turn is in context mode on its first frame.
   - `reading === debouncedTurn` sets `candidate = null`. A flicker that came
     back cancels itself.
   - Otherwise start or keep `candidate = { turn: reading, since }`. When
     `now − since` reaches the window (`ENTER` for running, `EXIT` for idle),
     set `debouncedTurn = reading`, clear `candidate`, and mark a **turn
     boundary**.
2. **A boundary ends a manual override:** `override = null`.
3. **The desired mode.**
   - `!supported` gives `normal` from the auto rule. Auto never *enters*
     context mode on a host that cannot inject. The §3.1 exception covers a
     `shown === "context"` that is already on screen.
   - `autoEnabled` gives `override?.mode ?? (debouncedTurn === "running" ? "context" : "normal")`.
   - Otherwise `manual`.
4. **Apply automatic changes only when no guard holds.** If
   `desired !== shown` and `!typing && !dictating && !inFlight`, set
   `shown = desired` and announce it in a polite live region
   (`composer.context.announceOn` / `announceOff`). While a guard holds, the
   change waits. The hook re-evaluates at the typing deadline and whenever a
   guard input changes, so it lands the moment the guard clears. The
   debounced turn keeps moving underneath: the guards only delay what the
   operator sees.

The operator's own actions are never deferred:

- **Pressing the toggle** sets `shown = other(shown)` immediately. With auto
  on it records `override = { mode: shown, anchor: debouncedTurn }`. With auto
  off it records `manual = shown`.
- **Switching auto off** sets `manual = shown`, so nothing moves. **Switching
  auto on** sets `override = null`, and the auto result then applies through
  step 4.

The mode an Enter uses is always `shown`, read from a ref at the instant of
the press. No code path recomputes the mode between the operator reading the
toolbar and the submission leaving.

### 4.4 The manual-override rule, stated

**A manual choice made while auto is on holds until the next debounced turn
boundary, in either direction, or until the operator presses the toggle or
changes the auto setting.** Two cases show why this is the useful rule:

- The agent is working, so the mode is context. The operator presses the
  toggle to send one real message that redirects the agent. That send
  interrupts the turn and starts a new one. The idle gap between the two is
  far shorter than 2.5 s, so no boundary is recorded and the normal choice
  holds. When the new turn ends and has been idle for 2.5 s, the override
  clears. The next turn start brings context mode back.
- The agent is idle, so the mode is normal. The operator presses the toggle
  to leave a note without starting a turn. The note stays in context mode
  until the agent next starts working. From then on auto governs again, and
  it wants context anyway.

With auto **off** the mode is the operator's alone. It is kept per
conversation in `sessionStorage["llv_composer_context_mode:<cardId>"]`, so a
phone tab restore does not quietly return a conversation to normal. The auto
override is memory-only: it expires at the next boundary, and after a reload
auto re-derives the mode from the live turn.

A conversation switch on the same composer (a new `cardId`) resets the
machine: `debouncedTurn = null`, `candidate = null`, `override = null`, and
`manual` read from that conversation's key.

### 4.5 Routing the submission

A new `submitDraft()` sends the draft to `injectContext()` when
`shownRef.current === "context"` and the toolbar shows the toggle. Otherwise it
calls `queueSubmit()`. It replaces the body of `handleSubmit`
(`TmuxComposer.tsx:4235`) and the `submit` passed to `useComposer`
(`:1742`, only when no `overrideText` is given). Quick-ack keeps passing its
own text to `queueSubmit` and never becomes context. These keep their
meanings in both modes: Alt+Enter (queue for Codex), Ctrl/⌘+Shift+Enter (ask
in parallel), the send-menu actions, and the phone's Stop slot. An empty draft
while the agent works is still Stop, because `composerSlotKind` is unchanged.

## 5. The optimistic context row

### 5.1 Why the outbox, not a new store

The feed already solves "one message, one row". An outbox row becomes the
transcript record's row in place, through the local join, the server's
`submissions` map, and the withholding of a record whose owner is not yet
named (§2). A separate context store would need its own tail rendering, its
own binding and its own withholding. That is the duplicate-row defect #1950
spent three rounds closing. An injected record carries the same
`dedup=sha256(operationId)` marker a send carries, so the existing join binds
it with no text matching. The cost of reusing the outbox is a list of fences,
so that a context row can never be dispatched, replayed or retried as a send
(§5.3). Each fence gets its own test.

### 5.2 Creation (in `injectContext`)

The row fits between the existing gates and the request, at
`TmuxComposer.tsx:4103-4120`:

1. After every existing refusal gate, and **before** `setText("")`, check
   `outboxCanAdmit(readOutbox(cardId))`. On failure, refuse with the same
   message `queueSubmit` uses and keep the draft.
2. After the documents are fenced, call a new
   `enqueueContextOutbox(cardId, { id: clientMessageId, text: requestedText,
   images: 0, files: requestedFiles.length, at: Date.now(), selectedContext:
   <the same preview queueSubmit stores>, contextTurn: turn at submit })`.
   It writes the entry **directly in state `delivering`** with
   `intent: "context"`. It never passes through `queued`, so `nextDispatch`
   (`outbox.ts:2130`), which only takes `queued`, has nothing to pick even
   before the fences below.
3. Raise `injectsPending`. The composer status line stays as #1560 wrote it
   (`inject.submitting`, then `inject.submitted`), so the existing tests hold.

New `OutboxEntry` fields (`outbox.ts:38`), both optional and persisted with
the entry:

```ts
/** An injection into the thread's context (#1560), never a send. The composer's
    queue never dispatches, replays, retries or releases it. */
intent?: "context";
/** The turn axis when it was submitted, for the row's wording before a receipt. */
contextTurn?: "running" | "idle";
```

### 5.3 Fences: every place a row can become a wire write

The predicate `composerDispatches(entry) = !entry.launchOwned && entry.intent !== "context"`
replaces the bare `launchOwned` test where the meaning is "the composer sends
this":

| Site | Rule for a context entry |
|---|---|
| `holdsLocalWireFence` `outbox.ts:2122` | Never holds the wire. Otherwise a context row waiting minutes for the next model request would block every ordinary send. |
| `nextDispatch` `:2130`, `claimOutboxDispatch` `:2136` | Never returned or claimed. |
| `retryOutbox` `:1513` | No-op. |
| `releaseHeldOutbox` `:1452` | Skipped. A context row is never parked `heldForSwitch`: the route refuses injection across a switch. |
| `outboxEntryUnresolved` `:1018` | Unresolved only while it has no terminal receipt. An uncertain injection is terminal (no retry, no discard), so it must not hold an outbox slot for ever. |
| Restore-time replay `TmuxComposer.tsx:2304`, local recovery `:3513`, row `check` `:3703` | Skip `resolveUnknownAdmission` for context entries. `check` goes straight to the receipt reconciliation and the operation read (`:3708-3715`), which are reads. |
| Receipt projection `TmuxComposer.tsx:2474-2490` | Unchanged, and it already applies: it matches by `idempotencyKey === entry.id`, and the inject key is the row id. |

### 5.4 Settlement

**The HTTP answer.** The branch at `TmuxComposer.tsx:4137-4153` gains three
arms:

| Answer | Row | Draft and status |
|---|---|---|
| `ok` | `updateOutbox(id, { operationId })` and the receipt patch if one came back (`outboxReceiptPatch`). The operation id feeds `localSubmissionJoin`, so the record binds as soon as it is written. | Unchanged: status `inject.submitted`, documents settle. |
| Refused: `ok:false`, and neither of the two ambiguous shapes below | **Withdrawn** by a new `withdrawContextOutbox(cardId, id)`, which removes the entry without an occurrence tombstone. Nothing durable exists, so no row may claim the message was sent. | Unchanged #1560 contract: the words come back (`setText(current => current || snapshotText)`) and the status carries the reason. The test at `TmuxComposer.inject.dom.test.tsx:500` keeps passing. |
| Ambiguous: `error === "network"` (no HTTP answer at all) or `delivery === "uncertain"` | `deliveryUncertain: true`, so the row reads unconfirmed and offers only **Check status**. | **The draft is not restored**, and the status is `composer.context.unconfirmed`. Handing the words back would invite a second insertion under a new key, which the engine will not deduplicate. This changes the one arm #1560 got wrong: today it restores the draft on a lost answer. |

**Receipts.** Once the answer is in, the existing projection drives the row,
and the model reads it as follows (`messageRow.ts`, keyed on `intent === "context"`):

| Receipt / entry | Phase | Row wording (transport line / status) | Actions |
|---|---|---|---|
| No operation id yet | pending | `inject.submitting` (existing) | none |
| `pending`/`queued`/`delivering`, `contextTurn === "running"` | pending | `outbox.context.waitingStep` | none |
| same, `contextTurn === "idle"` | pending | `outbox.context.stored` | none |
| `delivered` | confirmed | `outbox.context.inContext` | none |
| `uncertain` (either unverified reason), or local `deliveryUncertain` | pending, uncertain | `outbox.context.unconfirmed` | **Check status** only (`recovery: "check"`, a read) |
| `failed` / `rejected` | failed | `failureReasonKey(reason)`, with new human keys for `unsupported-injection` and blocking attention. `stale-turn` is mapped already. | **Edit** only |

The rules follow #1560:

- `failure.action` is never `retry` or `retry-operation` for a context entry,
  `discardable` is always false, and `cancellable` is false.
- The new action `edit` (added to `MessageRowAction`, `messageRow.ts:62`) is
  offered only on a **proven** failure. Every `failed` reason an injection can
  carry is pre-actuation, because anything after actuation settles as
  `uncertain`. The row's handler in `useOutboxRowActions` removes the entry and
  appends its words with `appendComposerDraft(cardId, text)`. The same gesture
  exists on `onClear`, and it never overwrites a draft. Sending the words again
  mints a new key, which is the sound path commit `c1c6ad29a` names.
- An `uncertain` row stays as the message's row, marked unconfirmed. Its
  words may well be in the thread, so showing it is honest, and it leaves with
  ordinary outbox compaction because it is no longer unresolved (§5.3).

**The record arrives.** The canonical record carries the dedup marker. It binds
to the row through `localSubmissionJoin` (operation id known) or the server
`submissions` map (operation id lost). `withheldRecords` keeps it off screen
for the moment in which neither has answered. `FeedMessageRow` keeps the same
DOM node, and the row becomes `data-message-row="confirmed"` even if the
receipt still says `delivering`, because the record is proof. On a running
turn, the record is written at the next model request. The bound row then sits
at the record's place in the transcript, which is the same behaviour an
ordinary bound send has. The row keeps its `entry` after binding
(`OutboxBubbles.tsx:337-346`), so the **Context** chip stays on it for as long
as this tab's outbox holds the entry.

The duplicate-surface question is closed by `rowOwnedKeys`
(`TmuxComposer.tsx:3754`). A receipt whose key has a rendered row no longer
appears in the composer's receipt disclosure. An injection therefore shows on
exactly one surface: the row. Injections refused before a row existed keep
using the disclosure, as they do today.

## 6. Looking like context

| Surface | Normal | Context |
|---|---|---|
| Send button (`sendIdleClassName`, `TmuxComposer.tsx:4522`) | `border-accent bg-accent` | `border-info bg-info` |
| Send glyph (new optional `sendIcon` prop, `ComposerBar.tsx:384`) | `Play` | `Layers` |
| Send label (`sendLabelIdle`) | `composer.sendToAgent` | `composer.context.send` |
| Placeholder (both desktop and phone) | `composer.placeholderSend` | `composer.context.placeholder` |
| Input box (new optional `mode` prop, `ComposerBar.tsx:620-628`) | `border-border` | `border-dashed border-info/60`, `data-composer-mode="context"` |
| Row (`UserMessageRow` gains `tone?: "context"`) | solid bubble | dashed `border-info/45` bubble, a `Layers` + **Context** chip in the meta line, `data-message-intent="context"` |

The mode switch changes colour and border only, never geometry, so a flip does
not move the field or the controls. Dark and light themes both use the
existing `info` token.

## 7. Strings (EN / UK)

New keys go in the `inject.*` block of `src/lib/i18n/en.ts:3184` and
`uk.ts:3106`.

| Key | EN | UK |
|---|---|---|
| `composer.context.toggle` | Context | Контекст |
| `composer.context.toggleAria` | Context mode | Режим контексту |
| `composer.context.hintOn` | On: Enter adds the draft to the agent's context without interrupting it. Click for a normal message. | Увімкнено: Enter додає чернетку в контекст агента, не перериваючи його. Натисніть для звичайного повідомлення. |
| `composer.context.hintOff` | Off: Enter sends a normal message. Click to add drafts to the agent's context instead. | Вимкнено: Enter надсилає звичайне повідомлення. Натисніть, щоб додавати чернетки в контекст агента. |
| `composer.context.autoBadge` | auto | авто |
| `composer.context.auto` | Switch with the agent's turn | Перемикати разом із ходом агента |
| `composer.context.autoHint` | Context while the agent works; normal once it has been idle for a few seconds. | Контекст, поки агент працює; звичайний режим, коли він кілька секунд вільний. |
| `composer.context.announceOn` | Context mode: the agent is working | Режим контексту: агент працює |
| `composer.context.announceOff` | Normal messages: the agent is idle | Звичайні повідомлення: агент вільний |
| `composer.context.placeholder` | add to the agent's context… | додати в контекст агента… |
| `composer.context.send` | Add to the agent's context | Додати в контекст агента |
| `composer.context.noHost` | Context needs this conversation's Codex host to be running. | Для контексту потрібен запущений хост Codex цієї розмови. |
| `composer.context.blocked` | Context mode is on, but this host cannot add context now. Switch to a normal message to send. | Режим контексту увімкнено, але цей хост зараз не може додати контекст. Перемкніться на звичайне повідомлення, щоб надіслати. |
| `composer.context.unconfirmed` | No answer from the server. The message row will show whether it was added. | Сервер не відповів. Рядок повідомлення покаже, чи його додано. |
| `outbox.context.chip` | Context | Контекст |
| `outbox.context.waitingStep` | Joins the running turn at its next step | Увійде в поточний хід на наступному кроці |
| `outbox.context.stored` | Stored for the next request | Збережено для наступного запиту |
| `outbox.context.inContext` | In the agent's context | У контексті агента |
| `outbox.context.unconfirmed` | Not seen in the thread; whether it was added is unknown | У треді не видно; невідомо, чи його додано |
| `outbox.action.edit` | Edit | Редагувати |
| `receipt.human.injectUnsupported` | This Codex host cannot add context. | Цей хост Codex не може додавати контекст. |
| `receipt.human.injectAttention` | Answer the agent's pending question first. | Спершу дайте відповідь на запитання агента. |

`inject.submitting`, `inject.submitted`, `inject.unsupported`,
`inject.imagesUnsupported` and `inject.refused` are reused unchanged.
`i18n.test.ts` already enforces key parity between the two locales.

## 8. States at 390 px and on the desktop

| State | Desktop (options row, feed) | 390 px (tools row, feed) |
|---|---|---|
| Codex idle, auto | Chip off, `auto` caption. Accent Send. | Toggle off, 44 × 44. Pill truncates. |
| Codex running, auto | Chip on (info), `auto` caption. Info Send with `Layers`. Dashed info input. | Toggle on. Info send visual. Dashed info box. |
| Manual override | Chip in the pressed state with no `auto` caption until the boundary. | Same, icon only. |
| No inject / no host | Chip disabled; the hint carries the reason. | Toggle disabled at 40 % opacity. The reason is the blocked-send line under the unit, because a phone has no hover. |
| Capability lost while in context | Chip on and enabled. Send disabled; the `composer-send-blocked` line reads `composer.context.blocked`. | Same line, under the box. |
| Dictating | Chip unchanged, and the machine is frozen. | The row hides `leftSlot` while recording, as it does today. |
| Row: adding / waiting / stored | Dashed info bubble, **Context** chip, transport line. | Same. The bubble wraps within the feed width. |
| Row: in context (bound) | Same node, `confirmed`, chip kept. | Same. |
| Row: unconfirmed | Chip, `outbox.context.unconfirmed`, **Check status**. | Same, with a 44 px action target. |
| Row: failed | Chip, reason, **Edit**. | Same. |
| Claude / tmux conversation | No toggle. Layout identical to today. | Same. |

## 9. Tests and rendered evidence

### 9.1 Tests (run by path, never a sweep)

Run every file below by path, with a fresh
`LLV_STATE_DIR=$(mktemp -d /tmp/ctxmode-state.XXXXXX)`, and a fresh
`XDG_CONFIG_HOME` and `TMPDIR` from `mktemp -d /tmp/...`. Never use the stage's
`$TMPDIR`, and never touch the live Viewer or live conversations.

- **New `src/components/composerContextMode.test.ts`**: the reducer with an
  injected clock.
  - Entry flicker: running for 399 ms and then idle leaves the mode normal.
  - Entry after 400 ms of running turns context on.
  - Exit flicker: idle for 2 499 ms and then running keeps context, with no
    boundary recorded.
  - Exit after 2 500 ms of idle returns to normal and clears the override.
  - `interrupt_requested` counts as running.
  - `unknown` holds the mode and cancels a pending candidate.
  - The first reading is adopted with no delay.
  - Typing guard: a flip due while the last edit is 1 000 ms old lands at
    1 500 ms, not earlier.
  - IME guard: an open composition holds the flip until `compositionend`,
    then the quiet window.
  - Dictation guard.
  - In-flight guard: a pending injection holds the flip until its answer.
  - A manual press holds across a sub-2.5 s idle gap and clears at the next
    boundary.
  - With auto off, the mode stays manual across boundaries.
  - Switching auto on and off keeps the displayed mode as §4.3 states.
  - `!supported` never makes auto enter context.
- **New `src/components/TmuxComposer.contextMode.dom.test.tsx`**, built on the
  `TmuxComposer.inject.dom.test.tsx` harness:
  - Toggle visibility: shown on Codex with inject, disabled with reason
    without inject or without a host, hidden for Claude.
  - Enter, the Send click and dictation's stop-and-send in context mode post
    only to `/api/runtime/inject` and never to `/api/runtime/send`.
  - Alt+Enter still queues for Codex.
  - Send, input and placeholder carry the context state.
  - The optimistic row appears (`data-message-intent="context"`,
    `data-outbox-state="delivering"`) before the answer resolves.
  - A refusal withdraws the row and restores the draft.
  - A network loss keeps the row unconfirmed and does not restore the draft.
  - Losing the capability while in context mode blocks Enter with the reason
    and keeps the draft.
  - The dispatcher never sends a context row, including after a reload.
  - A failed receipt offers Edit and never Retry. Edit appends the words to
    the draft and removes the row.
  - An uncertain receipt offers Check status only, and pressing it causes no
    POST to `/api/runtime/send` or `/api/runtime/inject`.
- **`src/components/conversation/outbox.test.ts`**: the fences in §5.3 each
  refuse a context entry (`holdsLocalWireFence`, `nextDispatch`,
  `claimOutboxDispatch`, `retryOutbox`, `releaseHeldOutbox`), and
  `outboxEntryUnresolved` is false once a context entry has a terminal
  receipt.
- **`src/components/conversation/messageRow.test.ts`**: the §5.4 table, row by
  row, in both locales.
- **`src/components/LogFeed.oneMessageOneRow.dom.test.tsx`**:
  - A context row plus its canonical Codex record (a `response_item` with the
    structured marker and `dedup` of its operation id) renders exactly one row
    containing the text.
  - The record that arrives before the operation id is known is withheld,
    not painted a second time.
  - The bound row keeps the **Context** chip.
- **`src/components/ComposerBar.dom.test.tsx`**: `SendMenuAction.checked`
  renders a `menuitemcheckbox`, and `sendIcon` and `mode` render.
- **Existing suites that must stay green, unchanged**:
  `TmuxComposer.inject.dom.test.tsx`,
  `TmuxComposer.injectReceipts.dom.test.tsx`,
  `TmuxComposer.queueFirst.dom.test.tsx`,
  `TmuxComposer.nativeQueue.dom.test.tsx`,
  `LogFeed.deliveryUncertainty.dom.test.tsx`, `submissionJoin.test.ts`,
  `src/lib/i18n/i18n.test.ts`.
- `bunx tsc --noEmit`, the project's lint on the touched files, and
  `bun scripts/privacy-publication-gate.ts --base <merge-base>`.

### 9.2 Rendered evidence, through the existing phone driver

One new case goes in `src/components/mobile/issue1671Evidence.browser.test.tsx`,
gated by `LLV_SWIPE_BROWSER_TEST=1` plus `CHROME_BIN`, and it serves both
widths as the "agent-delivered seat message" case already does (`:392-430`):

```
browserTest("composer context mode: the toggle, auto switching and the context row at 390 and 1440 in en and uk", …)
```

Fixture additions in `issue1671Evidence.fixture.tsx`, behind `?context-mode=1`:

- A Codex structured session for the running conversation: `hostKind:
  "codex-app-server"`, `sessionKey.engine: "codex"`, `capabilities: { steer:
  true, structuredAttention: true, inject: true }`.
- The `turn` value is read from the fixture's `evidence` object, so the driver
  flips it. This is the same mechanism `noticeOn` uses.
- `?context-mode=noinject` serves the same session without `inject`.
- `/api/runtime/inject` records the body and answers `{ ok, operationId,
  receipt: { kind: "inject", status: "delivering" } }`. The driver then
  publishes `delivered`, `uncertain` or `failed (stale-turn)` receipts through
  the snapshot's `recentReceipts`.
- The feed appends the injected Codex record, with the dedup marker computed by
  `deliveryDedupToken(operationId)`, when the driver sets `injectEchoOn`.

The driver runs viewports 390 × 844 (touch, `isMobile`) and 1440 × 900, in
`en` and `uk`, in the dark theme, plus light at 390. It reads and fails on
each of these:

1. Idle, the toggle is off. `aria-pressed="false"`, and it is 44 × 44 at 390.
2. Turn set running: the toggle is still off at +300 ms and on by +700 ms.
   Send has `data-composer-mode="context"` and the input box is dashed.
3. Turn set idle for 1 s and then running again (a flicker): the toggle stays
   on.
4. Turn set idle: the toggle is still on at +2 000 ms and off by +3 000 ms.
5. Typing guard: type during the idle wait, then stop. The flip lands at least
   1 500 ms after the last key.
6. Back in context mode, type and press Enter. Within one frame there is one
   row with `data-message-intent="context"` and `data-outbox-state="delivering"`,
   and the inject body carries the text. No `/api/runtime/send` request is
   made.
7. `injectEchoOn`: exactly **one** element contains the text, it is
   `data-message-row="confirmed"`, and its chip is present.
8. Failed receipt: the reason and **Edit** are present, and there is no Retry
   (`[data-outbox-retry]`, `[data-outbox-operation-retry]` absent).
9. Uncertain receipt: **Check status** only.
10. `noinject`: the toggle is disabled. At 390 the reason is visible as text.
11. Geometry at 390: `document.documentElement.scrollWidth <= innerWidth`, the
    tools row's `scrollWidth <= clientWidth`, no control in the row narrower
    than 44 px, the pill at least 60 px wide, and no overlap between toggle,
    picker, mic and send. At 1440, the chip and pill share one line of the
    options row with no wrap.

Readings go to `evidence/composer-context-mode/readings.json`. Frames go to
`.artifacts/composer-context-mode/` and are not committed. No new driver file,
and no file named after an issue.

## 10. Validation against the quote

| The operator said | The design |
|---|---|
| The menu is inconvenient; they want a button that marks the input as context | A visible toggle beside the pill (§3). The input, the Send button and the placeholder turn into the context look (§6). |
| It should show as if they sent it, then render once it has appeared | The optimistic row is created before the request (§5.2). It becomes the transcript record's row in place when the record arrives (§5.4). |
| All states correct and obvious | The §5.4 state table and the row's chip. There is one surface per injection, and uncertain and failed follow #1560's rules. |
| Stay in the mode and keep sending context | With auto off, the manual mode persists per conversation. With auto on, a manual press holds until the next turn boundary (§4.4). |
| When the agent finishes, back to normal; or better, follow the agent | Auto mode, on by default (§4). |
| Debounce/throttle so states are read correctly | 400 ms to enter, 2 500 ms to leave, `unknown` holds, and typing, dictation and in-flight guards apply (§4.1-4.3). |

Nothing in the design is beyond what the quote and the pinned criteria ask
for. The fences in §5.3 are the cost of reusing the outbox, and they are what
keep "context" from ever becoming an interrupting send.

## 11. What must not be touched

- **Server and runtime.** None of these change: `CodexAppServerHost.inject`
  and its marker, `structuredDeliveryQueue` injection execution and
  observation, `/api/runtime/inject`, `structuredMessageDelivery`, the
  journal's refusal of same-key inject retries, the rollout scan, and
  `src/components/feed/parse.ts`. This is a client-only change.
- **`injectContext`'s refusal gates and their order**, and the absence of any
  steering fallback. Only the row creation (§5.2) and the ambiguous-answer arm
  (§5.4) are added.
- **The meanings of `queueSubmit`, `steer-if-active`, Alt+Enter,
  Ctrl/⌘+Shift+Enter, quick-ack, Stop and the native queue panel.**
- **The #1950 binding and withholding in `LogFeed.tsx`, and the #1117
  occurrence join.** In particular, do not extend text-and-time matching to
  injected records.
- **`isRetryableReceipt` and the hidden Discard for injections**
  (`deliveryState.ts`).
- **Files owned by other open lanes:** `RuntimePill.tsx` and runtime
  settings or service-tier code (lane 25d2077f), `src/lib/links/*` (lane
  7acdca9e), and pipeline defaults and mandate code (lane 09a29c14). The i18n
  files are shared, so add keys only inside the `inject.*` block to keep merge
  conflicts local.
- **The operator's live state.** Run tests by path with sandboxed state
  (§9.1). Commit only as Delegatus.

## 12. Options considered

- **Optimistic row in a separate store.** Rejected (§5.1). It would duplicate
  #1950's binding and withholding, and a second binding path is where
  duplicate rows come from.
- **Mode driven by the feed's "working" indicator** instead of the host's turn
  axis. Rejected. The indicator is inferred from transcript rows. The turn
  axis is the host's own authority, and `steerRunningTurn` already reads it.
- **A manual choice that holds until the next idle** instead of the next
  boundary in either direction. Rejected. An idle-to-running boundary is
  exactly when the operator's "leave a note while it is quiet" intent has
  expired.
- **Replacing the "Add to context" menu entry.** Not done. It is the one-shot
  form of the same action, its tests pin its behaviour, and it now gets the
  optimistic row for free.

## Deferred — not currently justified

- **A durable "context" mark across devices.** Today the chip lives as long as
  this tab's outbox entry. In another browser, or after compaction, the record
  shows as an ordinary operator bubble. The cheap route when it is wanted:
  `/api/log/provenance` adds `contextSubmissions: string[]` (dedup tokens
  whose operation kind is `inject`, read from `deliveryOperationOwners` next
  to `submissionIdentities`), and the feed marks those rows. The requirement
  is about the sender's own states, so this is not built now.
- **A one-shot "send as a normal message" while in context mode.** The toggle
  already does this in one press.
- **Per-project or per-conversation auto preferences.** One browser-wide
  switch covers the quote.
- **A keyboard shortcut for the toggle.** No request for one exists.
- **Context mode for Claude or other engines.** Only the Codex app-server
  exposes `thread/inject_items`.
- **Images in context.** The raw Responses item cannot carry them (#1560). The
  refusal by name stays.
- **Tunable debounce values in settings.** Named constants are enough until
  someone reports a wrong flip.
