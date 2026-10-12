# Voice Delegatus on the phone: the floating head

Status: prototype, three numbered variants. The visual critic's first and second rounds are answered below; the frames
wait for the critic's next look and then the operator's pick.
Nothing in `src/` is changed by this folder.

## Originating requirement

Operator, 2026-10-12 about 09:05, voice message to the orchestrator seat (Russian, verbatim):

> я бы хотел иметь голосового оркестратора, который на мобильном у меня пока что не показывается. Я бы хотел, чтобы он показывался. … точно так же, как у нас на компьютере. У меня есть вот эта голова летающая, у неё слова вылетают, но при этом я хочу находиться в разговоре оркестратора. А, нет, с другой стороны, пусть она будет плавать, у меня всегда на экране лучше. Пусть она у меня всегда будет показывать … давай не минимизировать, а скрыть вообще. Но при этом я через менюшку, чтобы мог его открыть назад. И... В остальном пусть он у меня висит на экране. Если я переключаюсь между проектами, оркестраторами и агентами, чтобы он находился у меня. И я продолжал общаться.

What it asks for, point by point:

1. The voice companion shows on the phone, as it does on the desktop: a floating head whose words fly out.
2. It floats and is always on screen, whatever conversation the operator is in.
3. It is hidden completely (no minimised state), and a menu brings it back.
4. It stays, and the conversation with it goes on, while the operator moves between projects, orchestrators and agents.

The operator's standing rule of the same day applies to its state: a small dot and a short popover, never a text pill.
The operator's phone is an iPhone with Edge, which is WebKit.

## Why the companion does not show on the phone

It is switched off for the phone in one place, on purpose. Nothing about audio or permissions is involved.

| Where | What it does |
| --- | --- |
| `src/components/Viewer.tsx:333`, `:1909` | The shell reads `useIsMobile()` and mounts `<VoiceCompanionHost project=… mobile={isMobile} />` beside its screens, on the desktop and on the phone alike. |
| `src/hooks/useIsMobile.ts:9-17`, `src/lib/attention/eligibility.ts:25-26`, `:37` | `mobile` is true when the window is under 640 px wide or under 600 px high. |
| `src/components/voiceCompanion/VoiceCompanionHost.tsx:27` | `useVoiceCompanionSettings(!mobile)`: on the phone the settings are never read. |
| `src/components/voiceCompanion/VoiceCompanionHost.tsx:29` | The listener for a saved settings change is not attached on the phone. |
| `src/components/voiceCompanion/VoiceCompanionHost.tsx:34` | `if (mobile \|\| !settings?.enabled) return null;` Nothing is mounted on the phone, even with the companion turned on. |
| `src/components/voiceCompanion/VoiceCompanionHost.tsx:15-18` | The comment states the decision: "Never on the phone." |
| `src/components/voiceCompanion/voiceCompanionProduct.dom.test.tsx:104` | A test holds it: the shell "mounts nothing … and reads nothing on a phone". |
| `docs/design/voice-companion-research.md:714`, `:920`; `docs/design/voice-tools-and-spend.md:592-597`, `:765` | The record of the decision: "Desktop only: a phone mode is out of scope for now (operator, 2026-10-05)". |

Line numbers are those of the commit this lane started from, `69ad5cf84`. `main` has since taken #2767 (`212d9780e`, the
choice between the API and Codex V3 for the voice): it leaves the gate as it is and moves these lines by a few, so in
`VoiceCompanionHost.tsx` the three gate lines are 28, 30 and 35 and the project hand-over is line 49
(`liveAdapter.ts:259`). Every other anchor in this document reads the same on both commits.

So the cause is a deliberate gate from #2519, kept by #2642, #2681 and #2767. Three more facts follow from the code:

- **The switch already works on the phone.** The phone's board menu has Settings → «Голосовий Delegatus»
  (`src/components/headerMenu/headerMenuModel.ts:51`, `src/components/headerMenu/HeaderMenu.tsx:324-325`), and its dialog is
  mounted on every surface (`src/components/Viewer.tsx:1892`). The operator can turn the companion on from the phone today and
  still sees no head.
- **No phone-specific audio gate exists.** The microphone is asked for only on Talk (`src/lib/voiceCompanion/media.ts:38`), and
  nothing under `src/lib/voiceCompanion/` branches on the device. A tap on Talk is the user gesture iOS needs for the microphone
  and for audio. `navigator.mediaDevices` exists only on a secure origin, so a phone that opens Delegatus over plain HTTP gets
  the existing `MICROPHONE_REFUSED` notice. That applies to the desktop too and is unchanged here.
- **Lifting the gate alone is not enough.** The desktop component was drawn for a wide page: its open block is 132 × 148 px
  with a lane 216 to 280 px wide (`VoiceCompanion.tsx:57`, `src/lib/voiceCompanion/placement.ts:60-66`), it places itself off
  every line of text and every control, its state is a text label (`voiceCompanionStyles.ts:68`), its buttons are 28 px
  (`voiceCompanionStyles.ts:81`, under the phone's 44 px), it floats under the phone's sheets
  (`voiceCompanionStyles.ts:36`, `src/components/layers.ts:49-51`) and "has no way to be dismissed"
  (`VoiceCompanion.tsx:52-53`). On a 390 px screen every place holds text or a control, so it needs a phone presentation.
  That presentation is what the variants below draw. (Not measured: the desktop component was not rendered at 390 px here.)

The session itself is already built to survive navigation: the adapter lives in `MountedCompanion`, which the shell never
remounts, and a change of project is passed to the running session (`VoiceCompanionHost.tsx:45-46`,
`src/lib/voiceCompanion/liveAdapter.ts:253`).

## What every variant shares

- **The head.** A 52 px round tile with the product's own character (`CompanionCharacter`), its ring in the state's colour
  as on the desktop tile. It is one object: there is no open and collapsed pair on the phone.
- **State: a dot and a short popover.** A 13 px dot on the head's rim carries the state: accent while listening, the text
  colour while speaking, grey while thinking, a hollow solid grey ring with no call, red while the microphone is muted. With no call the head keeps
  its full colour and a solid grey outline: nothing is dashed or dimmed, so nothing reads as work in progress. A tap on the head
  opens its popover: one line with the dot, the state's word and the call's clock, then the rows. No label stands under the
  head.
- **The head's menu.** In a call: «Вимкнути мікрофон», «Завершити розмову», «Сховати». With no call: «Говорити» as the one
  filled button, then «Сховати». Rows are 44 px. A tap never starts a paid call by itself; «Говорити» does.
- **«Показати голос».** While the head is hidden, the board menu (the ⋯ of every phone screen) carries one more row,
  «Показати голос», directly above «Налаштування». It closes the sheet and the head is back where it stood. While the head
  is shown the row is absent, so the menu grows by nothing. Hidden is remembered on the device until that row is used.
- **Navigation.** The head is mounted beside the screens, as `VoiceCompanionHost` is today, so pushing a conversation, going
  back to a board, switching project or opening a sheet does not touch it. The driver checks this with a real navigation:
  the same mounted instance and the same running call clock on the next screen.
- **Sheets.** A phone sheet takes at most 88 % of the height (`MobileSheet.tsx:134`). While one is open the head rides the
  dimmed strip above the sheet's top edge, above the sheet's layer, and its words stand beside it there. It lies on 0 px² of
  the sheet in every frame.
- **Composer, keyboard, safe areas.** The head stands between the screen's fixed chrome: under the bar (on a board, under the
  seat card and the column tabs too) and above the composer or the dock, 8 px from each and from the side edge. Below, the 8 px are counted from the line the
  eye reads as the chrome's top: the dock's own border, and the border of the footer the composer's field sits in, which
  is 7 px above the field. So the gap is the same 8 px on a conversation and on a board. It reads those
  boxes while they move, so when the keyboard raises the composer the head rises with it. The composer and the dock already
  pad the bottom safe area, and the bar the top one, so the head inherits both; the side insets are added to its 8 px in
  landscape.
- **Words.** Each variant uses the product's bubble. On the phone it is opaque: the desktop's glass let the rows under it
  read through (first render of variant 2), and the operator's rule is no liquid glass.
- **Cleared page, nothing covered in part.** While the head speaks, it and its words stand on cleared page: an opaque
  stretch in the pane's own colour (the feed's, or the board's behind the cards), with no border and no shadow. It spans
  the head and every bubble with 8 px around them, and each edge moves outward to the nearest gap. In variants 1 and 2 a
  message counts as one row and a card always does, so a message or a card is hidden whole (author line, every line, copy
  button) or left whole. Variant 3's strip hangs from the bar, so its lower edge falls between two lines of the feed or two
  cards, as a scrolled feed's top edge does. The plate takes the touch, so no control under it is pressed unseen. While a
  sheet is open the plate lies under the sheet's dimming like the rest of the page, and only the head and its words stay
  lit above it. The prototype finds the gaps from the rendered lines, messages and cards; the build would take them from
  the feed's and the column's own rows.

## The variants

| | 1 · Над полем вводу | 2 · Вільна голова, хмаринки | 3 · Під шапкою |
| --- | --- | --- | --- |
| Where it floats | Bottom right, 8 px above the composer (above the dock on a board). | The same place by default; any height on either side edge once moved. | Top right, 8 px under the bar (under the seat card and the tabs on a board). |
| Words | One bubble of two lines beside the head, as tall as the head, in a 76 px band the feed (and on a board the column) is inset by. At the end of the list the last row stands above the band. | The desktop's lane: the newest bubble and the one before it, above the head (under it when the head is in the upper half), its tail pointing at the head, on cleared page from the bubbles down to the composer. | One bubble of two lines beside the head, in a strip under the bar that ends between two rows. |
| Rows under the words, speaking | **None** in the conversation (8 of 8 frames: the plate is 68 px and clears nothing). On the board: the card at the band, whole. | Whole messages only, 0 cut: the newest reply, author line to copy button. Plate 220 px of the feed's 668 at 390×844, 238 of 491 at 375×667. On the board, the cards under it whole (292 to 341 px). | Whole lines only, 0 cut: a strip 71 px high, the first two rows under the bar. On the board, the first card whole (130 to 147 px). |
| Text under the head | 0 px² in every frame | 0 px² in these frames; with no inset, a row that reaches the right edge passes under the idle head | 0 px² in these frames; the same holds |
| Cost | The last 76 px of the list's end are kept for the head while it is shown. The feed's box is unchanged (668 px of 844, 491 px of 667). | Hides the newest reply whole, about a third to a half of the feed, for as long as it speaks. | Far from the thumb; the first rows under the bar are hidden while it speaks, and on the board a whole card, which can leave a blank band under the bubble when that card is tall. |
| Dragging | Left or right corner of the same row; it snaps to the nearer. Measured rest: x = 8, same y. | Either edge at any height between the bar and the composer; it keeps the height. Measured rest: x = 8, 30 % of the height up. | Left or right corner under the bar. Measured rest: x = 8, same y. |
| «Сховати» | The row of the head's menu: two taps. | The same row, and one gesture: drag the head into the round place that appears over the composer while it is held, labelled «Сховати» beside it in the free band above the composer. | The row of the head's menu: two taps. |
| Sheet open | Rides above the sheet's top edge, 0 px² on the sheet; its bubble stands beside it on cleared page under the dimming. | The same; its words stand beside it, as in 1. | Stays under the bar and moves 0 px; its strip takes the dimming, the head and the bubble stay lit. It rides the sheet's edge only for a sheet tall enough to cover it. |
| Keyboard | Rises with the composer. | Rises when the composer reaches it. | Does not move. |

Measured in all 24 runs (3 variants, 390×844 and 375×667, uk and en, light and dark): the head, its words and its menu stay
inside the viewport; 0 px of sideways scroll; 0 px² of the head or a bubble on any shown control or line (what the plate
hides whole, such as the copy button of the reply variant 2 covers, is not shown); 0 lines, icons, messages or cards cut by
a plate in `talk`, `sheet` and `board-talk`; no bubble's text is cut; the
head is 52 × 52 px and every menu row 44 px; the same mounted head and the same call clock after a real navigation from the
conversation to the board; «Показати голос» is a 44 px row on the first screen of the menu at both sizes, and a tap on it
closes the sheet with the head back in place.

**Recommended: variant 1.** It is the only one whose words lie on no text, it is under the thumb, and it reads as part of the
conversation the operator is in, which is where the request started ("я хочу находиться в разговоре оркестратора").
Variant 2 is the closest to the desktop and the only one that hides in one gesture, at the price of covering the rows being
read. Variant 3 never meets the composer or the keyboard, and is the furthest from the thumb.

## Rendered evidence

Rendered by the existing phone driver, `src/components/mobile/issue1671Evidence.browser.test.tsx` with
`LLV_SWIPE_BROWSER_TEST=1`, over its own fixture and the production stylesheet. No driver was added to the repository:
`harness/apply.mjs` lays this folder over an export of the commit under the stage's scratch (the head beside the real
`Viewer`, one row in the phone menu, one case appended to the driver from `harness/driver-case.txt`), and `harness/run.sh`
runs that case with private home, state and temp, a closed control URL and a short TMPDIR for Chromium alone. The browser is
closed by the case and its process id is recorded; no process of the run was left.

- Touch input is real: the head's menu opens on a tap, the drag frames are taken with the finger still down
  (`Input.dispatchTouchEvent`), and «Сховати» and «Показати голос» are tapped.
- The conversation is the fixture's seat conversation filled past the screen (`?mvf-long`), so what is covered is measured
  over real rows.
- 448 frames, 224 pairs: `variant-N-<scene>-<size>-<lang>-<theme>-changed.png` beside `…-original.png`, the same screen as
  the product draws it today. Scenes: `talk`, `offline`, `menu-idle` (a tap on the idle head), `menu` (in a call), `drag`,
  `drag-hide` (variant 2), `sheet`, `board` (after the navigation, empty tab), `board-talk` (the fixture's board with its
  cards, `?kanban`, on «У роботі» with 11 tasks, the head speaking), `hidden`.
  Every frame carries its printed band: the variant's number and name, then the scene, size, language and theme.
- The frames are under `/var/tmp/mvf-fix2-8a952634/frames/`, outside the repository; `FRAMES.md` lists every path. The
  readings are `geometry.json` here. One full run drew all 448 frames: 0 failed checks.
- `PhoneVoiceHead.tsx` and the patched files type-check (`tsc` on them through a small tsconfig in the export, exit 0).

The first render found three defects, fixed before these frames: the head's menu opened above the screen; the desktop's glass
bubble let rows read through it; variant 3 lay on the board's seat card (1 936 px² of a control), so the head now stands under
all of a screen's fixed chrome. A fourth was in the measurement: message text sits in boxless wrappers and was not counted,
which read variant 2 as covering nothing.

## Self-check against the critic's checklist

| Check | Reading |
| --- | --- |
| Clutter | One object on screen: the head. Its words show only while it speaks; its menu only on a tap. |
| An obvious primary action | With no call the menu has one filled button, «Говорити». In a call the menu has three plain rows, the hang-up in the danger colour. |
| Rows of identical cards or buttons | None. The menu has at most three rows, each with its own icon. |
| Overlap and truncation | Measured, see above: 0 px² of the head on controls and on sheets in every frame, no cut text. While the head speaks, variants 2 and 3 hide whole messages, lines or cards and cut none; that is their trade-off and it is stated. |
| Affordances | The head is the one thing that takes a tap and a drag. While it is dragged, where it may land is drawn: the two places (1, 3), the two edges and the place to hide (2). |
| Hierarchy | The head is 52 px beside 44 px controls; its dot is 13 px; the words use the product's 14 px bubble. |
| Consistency | The character, the ring colours, the bubble and the menu's words are the desktop companion's. The menu row is the phone menu's own row. |
| Status as a dot and a short popover | Yes: no label, no pill. The popover's first line is the dot, one word and the clock. |
| No liquid glass | The phone bubble is opaque with no blur. |
| No new chrome | The restore lives in the existing ⋯ menu as one row, present only while hidden. The round place to hide in variant 2 exists only during a drag. |

## The critic's first round

The visual critic judged all three variants (352 frames, both sizes, both languages, both themes) and returned six findings.
Each is fixed in every variant it names and held by a check in the driver case, so a state the fix missed fails the run.

| Finding | What changed | The check |
| --- | --- | --- |
| P1, variant 2, speaking: the bubbles cut lines of the newest reply, and a line showed between them | The two bubbles stand on one opaque plate as wide as the page; its edges move to the gap between two rows. | `rowsCutByWords` and `marksCutByWords` are 0 in 8 of 8 `talk` frames; a `talk` frame of variant 2 or 3 with no plate fails. The reading knows the plate's rounded corners. |
| P2, variant 3, speaking: the bubble sliced the author line under the bar | The words stand in a strip from the bar down to the first gap between rows under the head. | The same two readings, 0 in 8 of 8. |
| P2, variants 1 and 2: the head and the bubble rested on the composer's line | The 8 px are counted from the footer's border, 7 px above the composer's field. The two-line bubble is 52 px, the head's height, with the small shadow. | `chromeLine` less the head's bottom is 8 px in `talk`, `offline`, `menu-idle`, `menu` and `board`; the bubble's bottom in variant 1 too. |
| P2, all variants, no call: the dot and the head read as a spinner | A hollow solid ring, a solid grey outline, the character at full colour and still. | In `offline` the head's and the dot's border style is `solid`, the character's opacity 1 and its filter `none`. |
| P2, all variants: no frame of the menu with no call | A new scene, `menu-idle`: a tap on the idle head. 24 frames, each with its pair. | The popover holds two rows, the filled «Говорити» then the plain «Сховати», each 44 px and uncut. |
| P3, variant 3, sheet: the head dropped to the middle of the screen | The head keeps its place under the bar unless the sheet's top edge reaches it. | In `sheet` the head's y equals its y in `talk`, and no row is cut. |

One more defect came out of the gap's fix and is fixed too: raised by 7 px, variant 1's bubble touched 15 px² of the touch
area of the last reply's copy button at 390×844, because the feed pins its tail by its own measure and stopped short of the
inset. The prototype now carries that pin on to the true end (`feedAtEnd` is true in all 8 `talk` frames of variant 1).

## The critic's second round

The critic rendered all 400 frames again and returned six findings. All are fixed in every variant they name, by one rule
shared by all three (cleared page, above), and each is held by a check in the driver case.

| Finding | What changed | The check |
| --- | --- | --- |
| P2, variant 2, speaking: the plate ended inside a message, leaving its tail or its author line alone | The plate's edges skip whole messages: it clears the newest reply from its author line to its copy button, from above the bubbles down to the composer. | `blocksSplitByWords` (a message or card under the plate in part) is 0 in 8 of 8 `talk` frames of variants 1 and 2. |
| P2, variants 1 and 2, sheet: the bubble cut dimmed rows and the copy button | The head and its bubble stand on cleared page under the sheet's dimming; its edge moves to the gap above the message. | `rowsCutByWords`, `marksCutByWords` and `blocksSplitByWords` are 0 in all 24 `sheet` frames, every variant; a `sheet` frame with no plate, or a plate above the dimming, fails. |
| P2, all variants: the board frames were empty and silent | A new scene, `board-talk`: the board with its cards, the head speaking. 24 frames, each with its pair. Variant 1 insets the column by its band, as it does the feed. | 0 lines, icons and cards cut, 0 px² of shown text under the head and its words in 24 of 24, and in variants 1 and 2 the head 8 px above the dock. |
| P3, variant 2, speaking: the plate read as a third boxed card, and the tail poked out of it | The plate is the pane's own colour with no border, no shadow and square edges; it reaches from 8 px above the bubbles to the composer, so the tail, which now points at the head's middle, is inside it. | The plate's background equals the pane's, its border is 0 and its shadow `none`; 8 px from the plate's top edge to the highest bubble. |
| P3, variant 3, sheet, light: the strip stayed a bright band over the dimming | The strip is drawn under the sheet's dimming; the head and its bubble stay above it. | A `sheet` frame whose plate lies above the dimming fails. |
| P3, variant 2, drag at 390×844: the «Сховати» label cut a line of the conversation | The label stands beside the round place, on its left and level with it, inside the free band above the composer. | `dropWordOnPagePx2` (the label over any line or icon of the page) is 0 in all 16 `drag` and `drag-hide` frames. |

Still open after these rounds, none of it in the findings:

- Variant 3's strip ends between two lines of the feed, as its first round asked, so the message at the top can show
  without its author line, as a scrolled feed does (`blocksSplitByWords` 1 in `talk` and `sheet`). Skipping whole messages
  there would grow the strip by up to a whole reply.
- Variant 2's cleared page is large: 220 px of 668 at 390×844 and 238 of 491 at 375×667 in the conversation, up to 341 px
  on the board. That is the price of covering whole messages and cards.
- The rule that variant 3 rides a sheet tall enough to reach it is written and not rendered: the driver's sheets end
  below the head.
- The idle head over a scrolled feed or a long column (no words, so no plate) still lies over whatever passes under it.

## Questions for the operator

1. **Which variant?** 1 «Над полем вводу», 2 «Вільна голова, хмаринки», 3 «Під шапкою».
   Recommendation: **1**.
2. **«Сховати» during a call: does the call go on?** (a) Hiding ends the call. (b) The call goes on with nothing on screen.
   Recommendation: **(a)**. A live microphone and a paid session with no sign of them on screen is the one state the phone
   bar has no room to show (the bar carries no badge by its own rule), and «Показати голос» plus «Говорити» is two taps back.
3. **Where «Показати голос» lives.** (a) In the ⋯ menu itself, above «Налаштування», only while hidden. (b) Inside
   Налаштування → «Голосовий Delegatus».
   Recommendation: **(a)**: one tap after ⋯, and the menu is unchanged while the head is shown.

## What the build touches

The build follows the operator's pick; nothing below is done by this stage.

| File | Change |
| --- | --- |
| `src/components/voiceCompanion/VoiceCompanionHost.tsx` | Read the settings and mount on the phone too; pass the phone presentation instead of returning `null`. |
| new `src/components/voiceCompanion/PhoneVoiceCompanion.tsx` | The phone presentation over the same adapter and reducer (`createCompanionStore`): head, dot, popover, words. No second session path. |
| `src/components/voiceCompanion/voiceCompanionStyles.ts` | The phone's head, dot, popover and opaque bubble. |
| `src/components/headerMenu/HeaderMenu.tsx`, `headerMenuModel.ts` | The «Показати голос» row of the phone menu while hidden. |
| `src/lib/i18n/en.ts`, `uk.ts` | «Сховати» / "Hide", «Показати голос» / "Show voice". |
| `src/components/voiceCompanion/voiceCompanionProduct.dom.test.tsx` | The phone test turns from "mounts nothing" to "mounts the phone head when on, reads nothing when off, starts no call". |
| `src/components/mobile/issue1671Evidence.fixture.tsx`, `issue1671Evidence.browser.test.tsx` | One case in the existing phone driver over the simulator, replacing this folder's harness. |
| `docs/design/voice-companion-research.md`, `voice-tools-and-spend.md` | The "never on the phone" lines, updated to the new decision. |

## Deferred — not currently justified

- **The transcript panel on the phone.** On the desktop a tap on the character opens the whole conversation
  (`CompanionTranscript`). The requirement does not ask for it, and on the phone the tap opens the head's menu. It can become
  one more row that opens a sheet.
- **Call cards and the delegation card.** The desktop lane also shows tool calls and the hand-off to the orchestrator with its
  confirmation. The prototype draws speech only. The build has to place the confirmation where the operator can answer it;
  that is a design step of its own once a variant is picked.
- **Sound on a locked iPhone and long sessions.** Task 7194c5e5; untouched here.
- **A landscape phone.** 844 × 390 is the phone layout too. The rules above hold there; no frame was rendered.
- **Free placement anywhere on the page with avoidance of text**, as on the desktop. On a phone no place is free of text, so
  the search would always end in the same corner.

## Not shown by this prototype

- A real voice, a real microphone or a real key. The state is scripted; no route is asked for anything.
- WebKit. The frames are Chromium at phone size with touch input; the operator's Edge on iPhone is WebKit, and the first real
  session is the operator's own after the build.
- The keyboard. Headless Chromium has no on-screen keyboard; the head follows the composer's box, which is what the keyboard
  moves.
- Motion. The frames are stills: a bubble comes out of the head's side over about 180 ms and the older one leaves by fading.
