# Voice Delegatus on the phone: the floating head

Status: prototype, three numbered variants, waiting for the visual critic and then the operator's pick.
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
  colour while speaking, grey while thinking, a dashed ring with no call, red while the microphone is muted. A tap on the head
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
  seat card and the column tabs too) and above the composer or the dock, 8 px from each and from the side edge. It reads those
  boxes while they move, so when the keyboard raises the composer the head rises with it. The composer and the dock already
  pad the bottom safe area, and the bar the top one, so the head inherits both; the side insets are added to its 8 px in
  landscape.
- **Words.** Each variant uses the product's bubble. On the phone it is opaque: the desktop's glass let the rows under it
  read through (first render of variant 2), and the operator's rule is no liquid glass.

## The variants

| | 1 · Над полем вводу | 2 · Вільна голова, хмаринки | 3 · Під шапкою |
| --- | --- | --- | --- |
| Where it floats | Bottom right, 8 px above the composer (above the dock on a board). | The same place by default; any height on either side edge once moved. | Top right, 8 px under the bar (under the seat card and the tabs on a board). |
| Words | One bubble of two lines beside the head, in a 76 px band the feed is inset by. At the feed's end the last row stands above the band. | The desktop's lane: the newest bubble and the one before it, over the page above the head. | One bubble of two lines beside the head, over the oldest rows on screen. |
| Text under the words, speaking | **0 px²** in 8 of 8 frames | **8 082 to 12 533 px²** | **1 130 to 1 336 px²** |
| Text under the head | 0 px² in every frame | 0 px² in these frames; with no inset, a row that reaches the right edge passes under it | 0 px² in these frames; the same holds |
| Cost | The last 76 px of the feed's end are kept for the head while it is shown. The feed's box is unchanged (668 px of 844, 491 px of 667). | Covers what the operator reads for as long as it speaks. | Far from the thumb; words stand over rows, though the oldest ones. |
| Dragging | Left or right corner of the same row; it snaps to the nearer. Measured rest: x = 8, same y. | Either edge at any height between the bar and the composer; it keeps the height. Measured rest: x = 8, 30 % of the height up. | Left or right corner under the bar. Measured rest: x = 8, same y. |
| «Сховати» | The row of the head's menu: two taps. | The same row, and one gesture: drag the head into the round place that appears over the composer while it is held. | The row of the head's menu: two taps. |
| Sheet open | Rides above the sheet's top edge, 0 px² on the sheet. | The same; its words stand beside it, as in 1. | The same. |
| Keyboard | Rises with the composer. | Rises when the composer reaches it. | Does not move. |

Measured in all 24 runs (3 variants, 390×844 and 375×667, uk and en, light and dark): the head, its words and its menu stay
inside the viewport; 0 px of sideways scroll; 0 px² of the head or its words on any control; no bubble's text is cut; the
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
- 352 frames, 176 pairs: `variant-N-<scene>-<size>-<lang>-<theme>-changed.png` beside `…-original.png`, the same screen as
  the product draws it today. Scenes: `talk`, `offline`, `menu`, `drag`, `drag-hide` (variant 2), `sheet`, `board`, `hidden`.
  Every frame carries its printed band: the variant's number and name, then the scene, size, language and theme.
- The frames are under `/var/tmp/delegatus-mobile-voice-floating/`, outside the repository; `FRAMES.md` lists every path.
  The readings are `geometry.json` here. The last run: 1 pass, 0 failures, 352 frames.
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
| Overlap and truncation | Measured, see above: 0 px² on controls and on sheets in every frame, no cut text. Variants 2 and 3 cover text by the figures given; that is their trade-off and it is stated. |
| Affordances | The head is the one thing that takes a tap and a drag. While it is dragged, where it may land is drawn: the two places (1, 3), the two edges and the place to hide (2). |
| Hierarchy | The head is 52 px beside 44 px controls; its dot is 13 px; the words use the product's 14 px bubble. |
| Consistency | The character, the ring colours, the bubble and the menu's words are the desktop companion's. The menu row is the phone menu's own row. |
| Status as a dot and a short popover | Yes: no label, no pill. The popover's first line is the dot, one word and the clock. |
| No liquid glass | The phone bubble is opaque with no blur. |
| No new chrome | The restore lives in the existing ⋯ menu as one row, present only while hidden. The round place to hide in variant 2 exists only during a drag. |

Open to the critic: with no call the head is dimmed and its dot is a dashed ring, which at 13 px may read as a spinner; and
in variant 2 the older bubble is drawn in the secondary colour, which is quiet on the dark theme.

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
