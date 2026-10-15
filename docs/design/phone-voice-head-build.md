# Voice Delegatus on the phone: the floating head (build of variant 1)

Status: build design. Nothing in `src/` is changed by this document.
Base: `main` at `0f9a382e0`. Design input: the prototype on commit `de58480ba` (the prototype lane 8a952634), its `docs/design/mobile-voice-floating/README.md`,
`FRAMES.md`, `geometry.json`, `PhoneVoiceHead.tsx` and `harness/`. Those files were never merged; read them with
`git show de58480ba:<path>`.

## Originating requirement

Operator, 2026-10-12 about 09:05, voice message to the orchestrator seat (Russian, verbatim as pinned):

> я бы хотел иметь голосового оркестратора, который на мобильном у меня пока что не показывается. Я бы хотел, чтобы он
> показывался … точно так же, как у нас на компьютере. У меня есть вот эта голова летающая, у неё слова вылетают … пусть
> она будет плавать, у меня всегда на экране лучше … давай не минимизировать, а скрыть вообще. Но при этом я через
> менюшку, чтобы мог его открыть назад … Если я переключаюсь между проектами, оркестраторами и агентами, чтобы он
> находился у меня. И я продолжал общаться.

Operator decision, 2026-10-12 about 15:06, on the prototype round «Голова голосу на телефоні»:

- Q1 a) variant 1 «Над полем вводу» (the head bottom right, above the composer or the dock);
- Q2 a) «Сховати» during a call ends the call: a live microphone with no sign on screen is not allowed;
- Q3 a) «Показати голос» lives in the ⋯ menu directly above «Налаштування», only while the head is hidden.

What the build must deliver, point by point (each is checked against the design in "Validation against the
requirement" at the end):

1. The head with its flying words appears on the phone (390 and 375 px; the operator's browser is iPhone WebKit).
2. It floats above the composer and can be dragged as the prototype shows.
3. It stays on screen and the conversation goes on across project, orchestrator and agent navigation.
4. «Сховати» removes it completely and ends a live call.
5. «Показати голос» in the ⋯ menu brings it back.
6. The hidden state survives a reload.
7. The phone gate added on purpose for #2519 is lifted only for this behaviour; what it protected stays protected. The
   desktop is unchanged.

## What exists today

| Where | What it does |
| --- | --- |
| `src/components/Viewer.tsx:1952` | The shell mounts `<VoiceCompanionHost project={project === OVERVIEW ? null : project} mobile={isMobile} />` once, beside `<main>` and its screens, on both surfaces. The comment above it says "Desktop only". |
| `src/components/voiceCompanion/VoiceCompanionHost.tsx:28` | `useVoiceCompanionSettings(!mobile)`: on the phone the settings are never read. |
| `VoiceCompanionHost.tsx:30` | The listener for a saved settings change is not attached on the phone. |
| `VoiceCompanionHost.tsx:35` | `if (mobile \|\| !settings?.enabled) return null;` the gate. |
| `VoiceCompanionHost.tsx:41-67` | `MountedCompanion` owns one `OfficialVoiceCompanionAdapter` (`useState`), hands it the project on every change (`adapter.setProject`, line 49) and renders the desktop `VoiceCompanion`. |
| `src/components/voiceCompanion/VoiceCompanion.tsx:400-402` | The desktop presentation creates its store over the adapter (`createCompanionStore`) and connects it in an effect. |
| `src/hooks/useVoiceCompanion.ts:68-72` | `connect()`'s cleanup calls `adapter.dispose()`: unmounting the presentation ends the call. |
| `src/lib/voiceCompanion/liveAdapter.ts:316-345` | `dispose()` → `close()`; `close()` mutes the microphone synchronously (`media?.mute(true)`, line 333), asks the server to close, then closes the media and the peer whatever the answer. |
| `src/components/voiceCompanion/voiceCompanionProduct.dom.test.tsx:94` | Holds the gate: "on a phone it does not even read the settings". |
| `src/components/headerMenu/HeaderMenu.tsx:265-375` | `PhoneMenu`, the ⋯ sheet of every phone screen. Its first screen ends with the rows «Налаштування» (line 371), «Допомога», and «Правила» when there are rules. Settings → «Голосовий Delegatus» already opens the voice settings on the phone. |
| `src/hooks/useIsMobile.ts` | Phone layout: width under 640 or height under 600, so a landscape phone is the phone layout too. |

## Why #2519 gated the phone off, and how it stays protected

The gate came in with #2642 (the build of #2519, merged 2026-10-09) and was kept by #2681 and #2767. The record is
`docs/design/voice-companion-research.md` (§ "Stated behaviour", the prototype-stage requirement quoted there, item 6:
"Desktop only: remove every phone surface from the prototype and say in the note that a phone mode is out of scope for
now", operator, 2026-10-05) and `docs/design/voice-tools-and-spend.md:592-597, 765`. No audio, permission or
platform defect is behind it. What it protected, and what this build does about each:

| Protected by the gate | How it stays protected |
| --- | --- |
| **Scope.** The operator kept the phone out of #2519 "for now". | Lifted by the operator's own request and decision of 2026-10-12, for this behaviour only: the phone head, its Hide and its menu row. Nothing else of the desktop window (transcript panel, call cards, delegation card, spend footer) comes to the phone with it (see "Deferred"). |
| **The page under an object that cannot be put away.** The desktop window places itself by searching a wide page for room free of text and controls (`placement.ts`), its block is 132 × 148 px with a 216–280 px lane, its buttons are 28 px, its state is a text label, and it "has no way to be dismissed" (`VoiceCompanion.tsx:52-53`). At 390 px every place holds text or a control, so it would have covered the conversation and could not be removed. | The phone gets its own presentation (variant 1): a 52 px head in a band the feed and the column are inset by, words on cleared page that hides whole messages or cards and never cuts one, 44 px rows, a dot instead of a label, and «Сховати». The desktop `VoiceCompanion` is never mounted on the phone. The driver measures 0 px² of the page's text and controls under the head and its words. |
| **Nothing is spent or opened by being on the phone.** No settings read, no adapter, no poll, no microphone prompt. | Off in the settings: one settings read on load (the desktop already does it) and nothing mounted. Hidden: the same, plus no adapter, no store, no poll. Shown and on: mounting starts no call; a tap on the head opens its popover and never starts a call; only the popover's «Говорити» starts one, through the same `talk()` rules as the desktop (pre-flight refusals for no key, a reached cap or no project, before any microphone). |
| **No live microphone the operator cannot see.** On the desktop the window cannot be dismissed, so a call always has a visible owner. | Hide ends the call (operator decision Q2): see "How Hide ends a call". While a call is live or starting, the head paints above every layer a phone surface uses (image preview, search, full-screen dialogs; see "Placement"), and a full-height sheet keeps it visible. With no call it keeps the dock's place and the layers above it cover it, since there is no microphone to show. |

The PR states this table's left column as the reason for the gate and its right column as how each point is kept.

## Files to change

| File | Change |
| --- | --- |
| `src/components/voiceCompanion/VoiceCompanionHost.tsx` | Read the settings on both surfaces (`useVoiceCompanionSettings(true)`, the change listener always attached). Return `null` while off, and on the phone while hidden. Mount `MountedCompanion` keyed by surface (`key={mobile ? "phone" : "desktop"}`) and let it render `PhoneVoiceCompanion` on the phone and `VoiceCompanion` on the desktop over the same adapter it already owns. Publish "available" (on and on the phone) to the phone store. Update the doc comment. |
| new `src/components/voiceCompanion/PhoneVoiceCompanion.tsx` | The phone presentation, built from the prototype's variant 1 (`PhoneVoiceHead.tsx`, variant-1 paths only): props as `VoiceCompanion`'s that apply (`adapter`, `project`, `locale`, `seat`, `preflight`, `onOpenSettings`); its own `createCompanionStore(adapter)` connected in an effect, exactly as `VoiceCompanion.tsx:400-402`; head, dot, popover, one two-line bubble, cleared-page plate, band. Root carries `data-phone-voice` (and `data-phase`, `data-muted`) for tests and the driver. No scripted state, no `window` hooks, no variant switch. |
| new `src/components/voiceCompanion/phoneVoiceStore.ts` | One small module store: `hidden` and `side` persisted in `localStorage` under `llv:phone-voice:v1` as one JSON value; `available` held in memory. Mirrors `useStoredChoice` in `src/components/ProjectRail.tsx:550-580` (listeners, private-mode fallback that keeps the choice for the page, server snapshot `hidden: false`). Exports `usePhoneVoice()`, `hidePhoneVoice()`, `showPhoneVoice()`, `setPhoneVoiceSide()`, `setPhoneVoiceAvailable()`. |
| `src/components/voiceCompanion/voiceCompanionStyles.ts` | A `PHONE_VOICE_CSS` string beside `VOICE_COMPANION_CSS`: the prototype's `.mvf*` rules for variant 1 renamed to `.pvc*`, without the drag-to-hide, rail, strip and free-lane rules of variants 2 and 3; the band rule (below). |
| `src/components/headerMenu/HeaderMenu.tsx` | In `PhoneMenu`'s first screen, one conditional row directly before the «Налаштування» row (line 371): key `voice-show`, icon `AudioLines` (already imported for the settings row), label `t("voiceCompanion.show")`, shown only while `available && hidden`; on select it closes the sheet and calls `showPhoneVoice()`. The settings count and every other row are unchanged. |
| `src/components/Viewer.tsx` | The mount at line 1952 passes `project={dashboardProject === OVERVIEW ? null : dashboardProject}` (line 357) so that a screen opened over the phone's Overview gives the voice its own project; on the desktop `dashboardProject` equals `project`, so the desktop is unchanged. The comment above the mount drops "Desktop only". Nothing else in the file. |
| `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` | `voiceCompanion.hide`: "Hide" / «Сховати»; `voiceCompanion.show`: "Show voice" / «Показати голос». Everything else the head says reuses existing keys (`voiceCompanion.talk`, `.mute`, `.unmute`, `.end`, `.phase.*`, `.settings.label`, `companionErrorMessage`). |
| `src/components/voiceCompanion/voiceCompanionProduct.dom.test.tsx` | The phone half of the test at line 94 is replaced, and the phone tests below are added (see "Tests"). The desktop half is kept as it is. |
| `src/components/headerMenu/HeaderMenu.dom.test.tsx` | The «Показати голос» row: absent while shown or while unavailable, present above «Налаштування» while hidden, and a tap closes the sheet and shows the head. |
| `src/components/mobile/issue1671Evidence.fixture.tsx`, `src/components/mobile/issue1671Evidence.browser.test.tsx` | One scene in the fixture and one `describe` block in the driver (see "Driver case"). |
| `docs/design/voice-companion-research.md`, `docs/design/voice-tools-and-spend.md` | A dated note (2026-10-12) where they say the phone mounts nothing (`voice-companion-research.md` "Production mount" and "Tests at the seams"; `voice-tools-and-spend.md:592-597, 765`), pointing here. Quoted requirements of earlier dates stay verbatim. |
| `src/components/headerMenu/headerMenuModel.ts` | Comment only (line 36, "The voice companion is a desktop surface"). No layout change: the row is not a `HeaderItem`, so `headerHome` and its tests are untouched. |

Nothing is added to `LogFeed.tsx`, `MobileKanban.tsx`, `MobileShell.tsx` or `globals.css`: the band is a rule in the
head's own stylesheet, present only while the head is (below).

## The phone presentation

All measures are those of the prototype's variant 1 as the critic passed it (`geometry.json`, 8 of 8 readings of
variant 1).

- **Head.** A 52 × 52 px round button with `CompanionCharacter` at 36 px, the ring in the state's colour as on the
  desktop tile; `touch-action: none`. `aria-label` "Delegatus · <state word>", `aria-haspopup="menu"`.
- **State: a dot and a short popover.** A 13 px dot on the head's rim: accent while listening, the text colour while
  speaking, grey while thinking or connecting, red while muted, and with no call a hollow solid grey ring with a solid
  grey outline on the head and the character at full colour and still (nothing dashed, dimmed or pulsing). No label
  stands under the head.
- **Popover** (a tap that does not drag), 236 px wide, above the head because it rests in the lower half; first line
  the dot, the state word and, in a call, the call's clock. Rows are 44 px:
  - no call: «Говорити» (the one filled row), then «Сховати»;
  - in a call (from the tap on «Говорити» while connecting, too): «Вимкнути мікрофон» / «Увімкнути мікрофон»,
    «Завершити розмову» (danger tone), «Сховати»;
  - while a failure whose remedy is in the settings is said (`NO_KEY`, `CAP_REACHED`, `KEY_FROM_ENV`): one more row
    «Голосовий Delegatus» that calls `onOpenSettings`.
  The popover closes on a row, a tap outside or Escape.
- **Words.** One opaque bubble of at most two lines beside the head, as tall as the head, 280 px wide at both sizes
  (x 42–322 at 390, 27–307 at 375, 8 px from the head). It shows the companion's speech as the desktop paces it: the
  newest line cut with `splitSpeech(text, bubbleChars(280))` from `placement.ts`, the piece the played time has reached
  at the desktop's nominal pace (`NOMINAL_MS_PER_CHAR`); if that pacing is inline in `VoiceCompanion.tsx`, extract it
  into a pure helper both use, with no change to the desktop's output. A failure (`companionErrorMessage`) takes the
  same bubble for `NOTICE_LINGER_MS`. The bubble is `aria-live="polite"` and takes no touch.
- **Cleared page.** While the bubble shows, the head and the bubble stand on a plate in the pane's own colour with no
  border and no shadow, spanning both with 8 px around; each edge moves outward to the nearest gap between whole
  messages (`[data-mobile-message]`) or whole cards (`[data-phone-card-shell]`, `[data-phone-kanban-more]`,
  `[data-phone-kanban-unlinked]`), as the prototype's `WordsPlate` does. A line that a clamped title or another clipping
  ancestor cuts off is cut to that clip and adds no row (a clamped title's hidden lines once read as rows below the last
  card and stretched the plate over it); screen-reader-only text adds none. At the end of a list the plate is 68 px and
  clears nothing (the band holds that room). It takes the touch. It is computed only while the bubble shows, and again
  on scroll (one per animation frame at most).
- **Drag.** Past 6 px of movement the head follows the finger; the two resting places (bottom left and bottom right of
  the same row) are drawn as slots while it is held, and it snaps to the nearer one. The side is written to the store,
  so the head comes back on that side after Hide, Show or a reload. A drag never opens the popover.
- **Motion.** The bubble comes out of the head's side over about 180 ms and fades on leaving;
  `prefers-reduced-motion` drops both to an instant change, as the desktop's styles do.

### Placement

The head reads the phone shell's own boxes, as the prototype's `readShell` does:

- **Top chrome:** `[data-mobile2-bar]`, `[data-mobile2-seat-card]`, `[data-mobile2-seat-invitation]`,
  `[data-phone-kanban-tabs]`. **Bottom chrome:** `[data-mobile2-composer]`, `[data-mobile2-dock]`,
  `[data-mobile2-receipt]`, measured from the line the eye reads as the chrome's top (the dock's border, the composer
  footer's border 7 px above the field: the prototype's `lineAbove`).
- **Rest:** x = 8 px from the chosen side (plus `env(safe-area-inset-left|right)` in landscape), y = bottom line − 8 −
  52. Measured: (330, 665) on the conversation at 390 × 844, (330, 727) on the board; (315, 488) and (315, 550) at
  375 × 667.
- **Keyboard:** the composer's box moves with the keyboard and the head moves with it; `visualViewport` gives the
  height.
- **Sheet open** (`[data-mobile2-sheet]`, at most 88 % high): the head rides the dimmed strip above the sheet's top
  edge (y = sheet top − 8 − 52, at least 4), on the layer `LAYER.sheet + 1`; its plate lies under the sheet's dimming
  (`LAYER.sheet − 1`). 0 px² of the head or its bubble on the sheet. While the call is live or starting, the head leaves
  this layer for `LAYER.overlay + 1` (above the image preview, below the toasts), so modals, popovers and the preview
  never cover it; with no call, modals and popovers (`LAYER.modal` and up) stay above it.
- **Full-height sheet** (`MobileSheet full`, the prototype review): no strip is left above it. The head stays visible,
  so a call is never hidden: it stands 8 px above the sheet's footer line (or the bottom safe area when the sheet has no
  footer), on `LAYER.sheet + 1`, and shows no bubble while such a sheet is open; the call goes on and is heard. This
  case was not rendered by the prototype; the driver adds it (scene `full-sheet`).
- **Re-reading the shell.** The prototype read the shell on every animation frame for as long as it was mounted. The
  build reads it on events instead, so an always-present head does not keep a loop running on the phone: window
  `resize`, `visualViewport` `resize` and `scroll`, the phone navigation store's `subscribe` (screens and sheets), a
  `ResizeObserver` on the chrome boxes it found, and a `MutationObserver` on `document.body`'s children (sheets mount
  there); each event runs a burst of animation-frame reads that stops after 600 ms without change, so a sheet's
  entrance or the keyboard's rise is followed to its end.

### The band

While the head is mounted and no sheet is open, the feed's scroller (`[data-log-feed-scroller]`) and the board's open
column (`[data-phone-kanban-column]`) keep room at their end so the last row (with its copy button's touch area) or the
last card ends above the head. The room is a rule in `PHONE_VOICE_CSS`, rendered inside the head's own `<style>`, so it
exists exactly while the head does and never on the desktop:

```css
html [data-log-feed-scroller], html [data-phone-kanban-column] { padding-bottom: var(--pvc-band, 76px); }
```

76 px is the prototype's value where the pane's box ends at the bottom chrome's line (the conversation at both sizes:
the feed ends at 725 and 548, the chrome lines at 725 and 548). Where a pane's box ends lower than that line, the head
sets `--pvc-band` on its root to `max(60, paneBottom − headTop) + 16`, as the prototype computed it. When the head
appears (first mount, «Показати голос») over a pane that was within 4 px of its end, the head sets that pane's
`scrollTop` to its `scrollHeight` once; after that the feed's own tail pin (`LogFeed.tsx`, which pins to
`scrollHeight`) includes the padding. The prototype's continuous scroll follower is not carried over; the driver's
`feedAtEnd` reading after a new message arrives decides whether it is needed.

## How the head survives navigation

- `VoiceCompanionHost` is rendered by `Viewer` beside `<main>`, outside every phone screen and sheet. Pushing a
  conversation, going back to a board, switching project through the project sheet, opening an orchestrator or an
  agent, and opening a sheet change only the `project` prop. `Viewer` itself is not remounted by any of them.
- `MountedCompanion` already hands a project change to the running session (`adapter.setProject`), which mutes the
  microphone until the server confirms the new context and then unmutes it
  (`liveAdapter.ts:259-292`); `voiceCompanionProduct.dom.test.tsx:465` holds "project switches and null context preserve
  the same live call, transcript and microphone until true unmount" for the desktop, and the build adds the same test
  for the phone.
- The project the phone passes is `dashboardProject` (`Viewer.tsx:357`): over the phone's Overview it is the project of
  the screen on top, so a conversation opened from the Overview is talked about as its own project. On the Overview
  board itself it is `null`, as on the desktop: a call goes on with no project in view, and «Говорити» there says to
  open one.
- `MountedCompanion` is keyed by surface. A window that crosses the phone breakpoint (a desktop window narrowed under
  640 px) unmounts one presentation and mounts the other with a fresh adapter: the call ends cleanly on the crossing.
  This never happens on a phone, whose rotation stays in the phone layout (height under 600). Sharing one adapter
  across two presentations would hand the second a disposed adapter, because each presentation's store disposes it on
  unmount.
- A reload ends a call, as on the desktop: the peer and the microphone belong to the page. The hidden state and the
  side survive it.

## Hide and Show: state and where it persists

| | Where | Read by |
| --- | --- | --- |
| `hidden` (boolean) | `localStorage["llv:phone-voice:v1"]`, JSON `{ "hidden": true, "side": "left" }`; on a write refused in private mode the value holds for the page | the host (phone branch), `PhoneMenu` |
| `side` (`"left" \| "right"`, default right) | the same value | the phone presentation |
| `available` | memory only, set by the host: settings on and phone layout | `PhoneMenu` |

- Per device and per browser, as the operator asked ("скрыть … через менюшку … открыть назад"). It is not a server
  setting: another device keeps its own choice.
- The flag is read only on the phone. The desktop never reads it, so a desktop that hid the head while narrowed shows
  its window again when widened.
- The server render and the first paint read `hidden: false` and mount nothing until the settings read answers, so the
  hydration is identical and a hidden head never flashes on load: the host mounts the head only after both the settings
  and the store say so, and the store is read synchronously on the client.
- `localStorage` writes from another tab are not followed live (no `storage` listener); the next load reads them.
  Two tabs of Delegatus on one phone is not a case the requirement names.

## How Hide ends a call

«Сховати» in the popover runs, in this order and synchronously in the tap's handler:

1. `hidePhoneVoice()` writes `hidden: true` and notifies.
2. The host re-renders and returns `null` for the phone branch, which unmounts `MountedCompanion` and
   `PhoneVoiceCompanion`.
3. The store's `connect()` cleanup (`useVoiceCompanion.ts:68-72`) calls `adapter.dispose()` → `close()`, which in the
   same tick bumps the epoch, plays the disconnect cue, stops playback and mutes the microphone (`liveAdapter.ts:322-333`),
   then asks the server to close the session (final usage is drained) and in `finally` closes the media and the peer,
   so the microphone track is stopped whether or not the close request succeeds.

No second path is added: Hide is unmounting, and unmounting already ends a call completely (the desktop has relied on
it since #2642). Consequences, all intended:

- Hide while connecting (the microphone prompt or the mint in flight) closes by request id, as `close()` already does.
- A confirmation waiting for the operator ends as unanswered (`session_closed`); nothing is sent. A request already sent
  to the orchestrator is unaffected: its delivery and report belong to the server, and the next call's transcript
  record shows the report.
- The month's usage is refreshed by `MountedCompanion` on `session.closed`, which an unmounted companion no longer
  hears. So the host calls its settings `refresh()` when the phone branch goes from hidden to shown, and the settings
  dialog reads its own figures from the server whenever it opens, so the last call and the month stay right.
- The iPhone's own microphone indicator turns off when the track is stopped, after the close request answers or fails.

«Показати голос» calls `showPhoneVoice()`: the host mounts a fresh `MountedCompanion` with a fresh adapter, the head
appears on its side with no call, and nothing is requested but the settings read. It never starts a call.

## The ⋯ menu entry

- Where: `PhoneMenu`'s first screen, the row directly above «Налаштування», on every phone screen whose bar has this ⋯ (the
  board and the Overview). A conversation's bar has no such menu: after Hide inside a conversation the way back is a
  board's ⋯.
- When: only while `available && hidden`. While the head is shown, or the companion is off, the menu is exactly as
  today, so it grows by nothing.
- Look: the menu's own `row()` (44 px, icon `AudioLines`, label «Показати голос» / "Show voice"), no trailing.
- Action: closes the sheet, then `showPhoneVoice()`. The head is back where it stood.
- Measured by the prototype: on the first screen of the menu at both sizes, with no scroll (the menu sheet stands 705 px
  high at 390 × 844 and 587 px at 375 × 667).

## States at 390 and 375, uk and en, light and dark

Every state below holds at 390 × 844 and 375 × 667, in uk and en, light and dark. Text is the same keys in both
languages; colours are tokens (`--color-raised`, `--color-primary`, `--color-border`, `--color-muted`,
`--color-danger`, `--color-accent`), so dark is the token swap with no rule of its own. The longest label, «Увімкнути
мікрофон», fits the 236 px popover with its icon at 14 px semibold. The bubble's two lines are clamped with an ellipsis;
the driver checks the clamp leaves no partial line.

| State | Head | Dot | Bubble | Popover | Band and plate | Menu row |
| --- | --- | --- | --- | --- | --- | --- |
| Off in settings | none | — | — | — | none | absent |
| On, no call | shown at rest | hollow ring | none | on tap: status, «Говорити», «Сховати» | band | absent |
| Connecting | shown | grey | none | status "Connecting", mute, end, «Сховати» | band | absent |
| Listening / thinking | shown | accent / grey | none | status with clock, mute, end, «Сховати» | band | absent |
| Speaking | shown | text colour | two lines beside the head | closes the bubble while open | band; plate (68 px at a list's end) | absent |
| Muted | shown | red | as above | «Увімкнути мікрофон» | band | absent |
| Failure | shown | grey | the failure's words for 12 s | adds «Голосовий Delegatus» for a settings failure | band | absent |
| Dragging | follows the finger, both slots drawn | as before | hidden | closed | band | absent |
| Sheet open (≤ 88 %) | above the sheet's top edge | as before | beside the head, plate under the dimming | — | no band | — |
| Full-height sheet | above the sheet's footer | as before | none | on tap | no band | — |
| Keyboard up | rises with the composer | as before | as before | as before | band | — |
| Hidden | none | — | — | — | none | present above «Налаштування» |
| Landscape phone | rest plus the side safe area | as before | as before | as before | band | as above |

Measured in the prototype (variant 1, all 8 readings): head 52 × 52; 8 px from the head's bottom to the chrome line in
`talk`, `offline`, `menu-idle`, `menu` and `board`; 0 px² of the page's text or controls under the head and its words;
0 rows, icons, messages or cards cut; 0 px sideways scroll; the head and its words inside the viewport; every popover
row 44 px. The landscape and full-height sheet rows were not rendered by the prototype.

## Tests

All run by path through `scripts/gate-slot.sh`, one file per process, with isolated `HOME`, `XDG_CONFIG_HOME`,
`TMPDIR` and `LLV_STATE_DIR` and a closed `LLV_VIEWER_CONTROL_URL`; nothing touches the operator's state.

`src/components/voiceCompanion/voiceCompanionProduct.dom.test.tsx`:

1. **The phone mounts the head only when on and shown.** Off: one settings read, nothing mounted. On: `[data-phone-voice]`
   with `data-phase="offline"`, no `[data-voice-companion]` (the desktop window), and no session request. The desktop
   half of the current test at line 94 stays as it is.
2. **Hidden persists across a remount.** With `llv:phone-voice:v1` = hidden, mounting reads the settings, mounts nothing
   and asks no session route; unmounting and mounting again (a reload) keeps it hidden; `showPhoneVoice()` mounts the
   head with no call; a remount after that shows it. A storage that throws on write keeps the choice for the page.
3. **Hide ends the call.** Over `liveHarness()` on the phone: tap the head, «Говорити», wait for the session; tap
   the head, «Сховати». Then: the fake track's `stops` is at least 1 and its `enabled` is false, the session route
   received `close`, the provider holds no open session, `[data-phone-voice]` is gone, and the store says hidden. The
   same with Hide tapped while the start is still in flight closes by request id and opens no session. Shape it after
   the existing "collapsed during a muted conversation, the shape keeps a hang-up that ends the media and the session"
   test (line 670).
4. **A project change keeps the call.** The phone version of the test at line 465: rerender with another project and with
   `null`; the same `[data-phone-voice]` node, the same live session, no extra `start`, the context request sent.
5. **No tap but «Говорити» starts a call.** A tap on the head, a drag, «Сховати» and «Показати голос» make no session
   request.

`src/components/headerMenu/HeaderMenu.dom.test.tsx`:

6. **The menu row.** Phone surface: with `available` false or `hidden` false, no `[data-mobile2-menu-row="voice-show"]`;
   with both true, the row stands immediately before `[data-mobile2-menu-row="settings"]`, reads «Показати голос» in uk
   and "Show voice" in en, and a tap closes the sheet and clears `hidden`. The desktop menu never shows it.

## Driver case

One `describe` block, "phone voice head", in `src/components/mobile/issue1671Evidence.browser.test.tsx`, gated as
the file is (`LLV_SWIPE_BROWSER_TEST=1`, `CHROME_BIN`), run through `scripts/gate-slot.sh` with a scene filter
environment variable and an evidence writer that merges scenes into one JSON (the file's own pattern for long cases).
Frames go under `.artifacts/phone-voice-head/` (ignored); the readings are committed as
`evidence/phone-voice-head/geometry.json`. No new driver file and no file named after an issue.

Fixture (`issue1671Evidence.fixture.tsx`), one scene selected by `?voice=`:

- `?voice=sim`: `<Viewer />` with `PhoneVoiceCompanion` beside it over `createSimulatedCompanion` (the way
  `issue1695Evidence.fixture.tsx:4034-4110` mounts the desktop window), with a script that speaks, and a wrapper adapter
  that records `setProject` calls and `close` on `window`. It answers `/api/voice-companion/settings` with the companion
  on so `Viewer`'s own host stays off for this scene (`available` is set by the scene).
- `?voice=product`: the fixture answers `/api/voice-companion/settings` with `{ enabled: true, keySource: "file" }` and
  mounts nothing itself, so the shell's own `VoiceCompanionHost` mounts the head on the phone. No call is started in
  this scene; it proves the product mount, the hidden flag across a reload and the menu row.
- `mvf-long`-style filling of the seat conversation past the screen, as the prototype's harness did, so what the words
  cover is measured over real rows.

Combinations: 390 × 844 uk light and 375 × 667 en dark (the acceptance pair), touch input (`hasTouch`, `isMobile`,
CDP `Input.dispatchTouchEvent` for the drag), each frame with its printed band (scene, size, language, theme) and its
`-original` pair where the scene exists without the head.

| Scene | Mount | What is done | Checks (fail the run) |
| --- | --- | --- | --- |
| `talk` | sim | conversation, speaking | head 52 × 52 at rest; 8 px from head bottom and bubble bottom to the chrome line; 0 px² text or controls under head, bubble and plate; 0 rows or marks cut, 0 messages split; bubble text not cut; `feedAtEnd` true; sideways scroll 0; in viewport |
| `menu` | sim | tap the head in a call | rows mute, end, «Сховати», each 44 px and uncut; status line has the clock; popover in viewport |
| `sheet` | sim | ⋯ open in a call | head and bubble 0 px² on the sheet; plate under the dimming |
| `full-sheet` | sim | a prototype review opened (the file's "prototype review on the phone" path) in a call | head visible above the footer line, 0 px² on the footer's controls, no bubble |
| `drag` | sim | finger down and moved left, frame taken while held; then released | slots drawn; rest at x = 8, same y; side survives a reload |
| `hidden` | sim | tap the head, «Сховати» | head gone; the wrapper saw `close`; the store says hidden; band gone (feed padding back to its own) |
| `menu-hidden` | product | reload while hidden; open ⋯ | no head after the reload; row «Показати голос» / "Show voice" 44 px on the first screen, directly above «Налаштування» |
| `restored` | product | tap the row | sheet closed; head back on its side; no session request |
| `navigation` | sim | in a call: conversation of project A → project sheet → project B → its board | the same head node before and after (an expando set on it before the navigation is read back), the call clock advanced, phase not offline, the wrapper saw `setProject(B)`; the head 8 px above the dock on B's board |
| `navigation-product` | product | the same navigation with no call | the same head node, no session request |

The project pair: the fixture's projects sheet (`[data-mobile2-open="projects"]` → `[data-mobile2-project=<key>]`),
using the `overview` scene's projects or the relay chats project beside `atlas`, whichever the fixture lists with both a
conversation and a board; the builder names the pair in the case's comment.

Before the run: one frame per size with its band, read by eye (band not cut at 375). After: every frame read, the
browser closed by the PID the case recorded.

## What not to touch

- The desktop: `VoiceCompanion.tsx` (except extracting a pure pacing helper with identical output, if needed),
  `placement.ts` (read only), `CompanionTranscript.tsx`, `hostSurfaces.ts`, the desktop menu, and the desktop branch of
  `VoiceCompanionHost`.
- The voice server and its tools: `src/lib/voiceCompanion/{tools,boardReads,readPaths,server,liveSession,admission}.ts`
  and `src/app/api/voice-companion/**` (lane 6de3456c works there).
- Lock-screen sound, background audio and long sessions (task 7194c5e5).
- The kanban: card content (lane 221df60e), its order (lane dde55e2d), the «Задачі» panel (lane a64c2c70);
  `MobileKanban.tsx` and `LogFeed.tsx` are not edited (the band is CSS in the head's stylesheet).
- The board header of #2782 (`ProjectBar.tsx`, `ProjectDashboard.tsx`, `BootShell.tsx`).
- `VoicePipHost` and `VoiceBridgeRelayHost` (#691, the per-conversation voice call), which are a different surface.
- `headerMenuModel.ts` layouts and `headerHome` (comment only).
- The phone shell (`MobileShell.tsx`, `MobileFocusView.tsx`, `MobileSheet.tsx`, `layers.ts`): the head reads their boxes
  and attributes, and adds none.

None of the open lanes' branches checked on 2026-10-12 (6de3456c, 9a4857cb) changes a file in "Files to change"; the
other fenced lanes had no published branch yet.

## Validation against the requirement

| Point | Where it is met |
| --- | --- |
| 1. Head with flying words on the phone | The phone presentation; driver `talk` at 390 and 375. |
| 2. Floats above the composer, draggable | Placement and Drag; driver `talk`, `drag`. |
| 3. Stays and talks across navigation | Host beside the screens, `setProject`, `dashboardProject`; test 4, driver `navigation`, `navigation-product`. |
| 4. Hide removes it and ends a call | Hide is unmount; test 3; driver `hidden`. |
| 5. «Показати голос» in ⋯ brings it back | `PhoneMenu` row; test 6; driver `menu-hidden`, `restored`. |
| 6. Hidden survives reload | `localStorage` store; test 2; driver `menu-hidden` reloads. |
| 7. Gate lifted only for this; protections kept; desktop unchanged | The table in "Why #2519 gated the phone off"; desktop half of test 1 unchanged; desktop files untouched. |

The 2026-10-15 voice-read requirement adds a Conversation row to the head's popover.
It opens the existing transcript component for silent messages and action results;
see [voice orchestrator reads](voice-orchestrator-reads.md). This completes the phone
transcript panel deferred in the original 2026-10-12 design.

## Deferred — not currently justified

- **Call cards and the delegation card.** The desktop lane shows tool calls and the hand-off with its confirmation. On
  the phone the confirmation is answered by voice (the gate takes a spoken yes or no) and the bubble says the
  question; Send and Cancel rows in the popover are left for a later step if a spoken answer proves unreliable.
- **Drag to hide in one gesture** (variant 2) and free placement at any height: not the chosen variant.
- **A live `storage` listener across tabs** for the hidden flag.
- **Sound on a locked iPhone and long sessions:** task 7194c5e5.
- **A rendered landscape frame.** The rules hold there (the side safe area is added); no frame is required.

## Not verified by this design

- WebKit. The driver is Chromium at phone size with touch input; the operator's browser is iPhone WebKit. Pointer
  capture, `-webkit-line-clamp`, `visualViewport` and `env(safe-area-inset-*)` are WebKit features too, but no WebKit
  frame is taken. A WebKit run of the same case is possible on this machine without sudo and is optional.
- A real microphone, a real voice and the plain-HTTP case: `navigator.mediaDevices` exists only on a secure origin, so a
  phone that opens Delegatus over plain HTTP gets the existing `MICROPHONE_REFUSED` notice, now said in the bubble. The
  first real session is the operator's own.
- The on-screen keyboard: headless Chromium has none; the head follows the composer's box, which is what the keyboard
  moves.

## Build notes (2026-10-12)

What the build changed from this design, each found while rendering it:

- **The band on the conversation is a margin.** The phone feed aligns its tail on the blank space under its last row
  (`alignFollowedTop` in `LogFeed.tsx`): with the band as padding, that space grew by 76 px and the feed stepped back
  into it, so the last message sat in the band and the cleared page hid it. The head's stylesheet gives the feed's
  scroller `margin-bottom` instead, so the conversation ends above the head; the board's column keeps the band as
  `padding-bottom`. Neither file is edited.
- **«Показати голос» is in the ⋯ menu that holds «Налаштування»:** the board's and the Overview's. A conversation's
  ⋯ is its own menu (this turn, the conversation, close or stop) and has no settings row, so the row is not there.
- **A bubble holds two lines' worth of a line** (`PHONE_BUBBLE_CHARS`, 58 characters: two of the four lines
  `bubbleChars(280)` sizes), so the two-line clamp never cuts a piece the nominal pace has reached.
- **The `sim` scene goes through the product host.** `VoiceCompanionHost` takes its adapter from a factory that only the
  fixture replaces (`setVoiceCompanionAdapterForTests`), so the navigation case runs the Viewer's own mount and
  `dashboardProject`. The full-height sheet is the real `MobileSheet full` with a footer, opened by the fixture; the
  phone fixture has no prototype review of its own.
