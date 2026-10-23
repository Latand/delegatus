# Voice: choose the microphone and the speakers (implementation brief)

## Requirement

Operator, 2026-09-26, paraphrased on the board (task «Вибір мікрофона й
динаміків у голосовому режимі», postponed by the operator until 22.10 and now
taken up as pipeline a3ae3666):

> Add a microphone and speaker selector for voice; today nothing can be chosen
> and it is unclear which device is used (browser-level selection exists but
> is not obvious).

Standing operator preferences: reuse an existing control instead of new
chrome where one fits; show status compactly.

Acceptance, as pinned:

1. In the existing voice settings (no new panel), two selectors list the
   browser's audio input and output devices (labels after permission; a clear
   «System default» first). The call uses the chosen microphone (getUserMedia
   `deviceId`) and plays through the chosen output (`setSinkId` where
   supported; where it is not, the output selector says so and stays disabled).
2. Choices are remembered per browser. A remembered device that disappears
   falls back to default with a short notice. `devicechange` updates the lists.
3. The active call shows which microphone it uses in its existing status
   surface (no new pill).
4. Works on desktop and in the phone layout (390 px), with uk and en strings.
5. Tests for the selection, fallback and unsupported-output paths. Rendered
   evidence comes from the existing browser drivers (no new one-shot driver),
   with frames under the stage scratch and never committed.
6. Checks: typecheck, ESLint on touched files, touched tests by path through
   `gate-remote -- <command>`. Fences: lanes f3f1998a and voice tools slice 2
   (8ea0c9c2) are open, so do not touch the call backend or the tool wiring.
   Leave `.github/workflows` alone. Public text names no person, account, host
   or absolute path.

Earlier answers: the board task above had no design. An audit on 2026-10-20
found that no voice surface had a device selector. Searches of memory found
nothing relevant. Line numbers below are at `e38b86d3`.

## Where things are today

| What | Where |
|---|---|
| Voice settings dialog («Voice Delegatus»), the only voice settings surface | `src/components/voiceCompanion/VoiceCompanionSetting.tsx:27-54` (`VoiceCompanionSettingsHost`, rows at :48-49) |
| Its rows; call memory is inserted at :187, outside the `settings.enabled` block | `src/components/voiceCompanion/VoiceCompanionSetting.tsx:67-191` |
| Entry from the desktop header menu | `src/components/headerMenu/HeaderMenu.tsx:157` |
| Entry from the phone menu sheet | `src/components/headerMenu/HeaderMenu.tsx:355` |
| Companion call opens the microphone | `src/lib/voiceCompanion/media.ts:38` |
| Companion call's playback element; the remote track is attached at :51 and played at :54 | `src/lib/voiceCompanion/media.ts:47` |
| Companion call teardown | `src/lib/voiceCompanion/media.ts:116-128` |
| Where the companion media is constructed (do not edit) | `src/lib/voiceCompanion/liveAdapter.ts:113` |
| Composer voice conversation opens the microphone | `src/lib/realtime/codexRealtimeClient.ts:585-587` |
| Composer conversation's playback element and its track | `src/lib/realtime/codexRealtimeClient.ts:591-594`, `:601-604` |
| Composer conversation teardown | `src/lib/realtime/codexRealtimeClient.ts:1310-1315` |
| Desktop companion status pill (phase, `.vc-sim` line) | `src/components/voiceCompanion/VoiceCompanion.tsx:1357`; CSS `src/components/voiceCompanion/voiceCompanionStyles.ts:68-75` |
| Desktop companion mute button | `src/components/voiceCompanion/VoiceCompanion.tsx:1361` |
| Desktop companion notices (`say(...)`) | `src/components/voiceCompanion/VoiceCompanion.tsx:636-646`; codes that offer Settings at :94 |
| Phone head popover status line; its mute row is at :582 | `src/components/voiceCompanion/PhoneVoiceCompanion.tsx:579` |
| Phone notices | `src/components/voiceCompanion/PhoneVoiceCompanion.tsx:390-394` |
| Composer call panel status row; the panel already receives `stream` | `src/components/VoiceConversation.tsx:289`; stream passed at `src/components/voice/VoicePipHost.tsx:181` |
| Notice texts (en, uk pairs) | `src/lib/voiceCompanion/errors.ts:4` (`COMPANION_MESSAGES`) |
| Strings | `src/lib/i18n/en.ts:2581-2590` and `src/lib/i18n/uk.ts:2526-2535` (`voiceCompanion.settings.*`); `voice.live` at en :4082, uk :4015 |

Two call paths open the microphone today, and both are reachable: the
companion («Voice Delegatus», `VoiceCompanionHost` from `Viewer.tsx:62`) and
the composer's voice conversation on hosted Codex conversations
(`VoiceConversationButton` at `TmuxComposer.tsx:5799`, enabled at :2025).
Both should honour the choice. Otherwise picking a microphone in Delegatus
and then hearing a different one in the composer call recreates the confusion
the operator described.

## Controls to reuse

- `Select` with `roomy` from `src/components/ui/Select.tsx:22` (the design
  system's one select). Add `w-full max-sm:min-h-11` for the phone's touch
  floor, as the dialog's other phone controls do.
- The dialog's section pattern from `CallMemorySetting.tsx:29`:
  `mt-4 border-t border-border pt-3 text-[13px]` with a semibold title.
- The text-button look of «Open Keys» (`VoiceCompanionSetting.tsx:126`) for
  the one permission button.
- `queryMicPermission` and `rememberMicGrant` from `src/lib/micPermission.ts`.
- The device-local storage pattern from `src/lib/audio/prefs.ts`
  (`localStorage`, `useSyncExternalStore`, `storage` event). Copy the
  pattern; do not add fields to `AudioPrefs`, because PR #3228 is changing
  that directory and the `AudioPrefs` defaults are compared in tests.
- The existing notice channel on both companion surfaces: two codes in
  `COMPANION_MESSAGES`, said through `say(...)` on desktop and
  `sessionNotice` on the phone.

No new panel, pill, popover or icon button.

## What to build

### 1. `src/lib/audio/voiceDevices.ts` (new, the only new module)

- **Stored choice.** Two keys, `llvVoiceInputDevice` and
  `llvVoiceOutputDevice`, each holding JSON `{ id, label }`. When a key is
  absent, the choice is System default. Provide `useVoiceDeviceChoice()` and
  `setVoiceDeviceChoice(kind, choice | null)`, and adopt writes made by
  another tab through the `storage` event.
- **Listing.** `listVoiceDevices()` wraps `navigator.mediaDevices.enumerateDevices()`:
  - Drop entries with an empty `deviceId`.
  - Drop Chrome's `default` and `communications` pseudo-entries, but use the
    `default` entry's `groupId` to name the real device behind it. That name
    is `defaultName`; the select shows it as «System default · {name}».
  - `labelled` is false while every label is empty, which means there is no
    permission yet.
- **Resolving a stored choice.** Match by `id` first. If that fails and labels
  are visible, match by exact `label`, because some browsers rotate ids. A
  choice that matches nothing while labels are visible is `missing`.
- **`openVoiceMicrophone(base)`** returns `{ stream, fellBack, release }`.
  - With a stored choice, it calls `getUserMedia({ audio: { ...base, deviceId: { exact: id } } })`.
  - On `OverconstrainedError` or `NotFoundError` it retries with `base` alone
    and sets `fellBack: true`.
  - Every other error propagates unchanged, so `MICROPHONE_REFUSED` keeps
    working.
  - It records the active input `{ label, fellBack }` in a small module store
    (`useActiveVoiceInput()`). The label comes from the track's
    `getSettings().deviceId`, mapped through the list (so `default` resolves to
    the real device's name), and falls back to `track.label`. `release()`
    clears that record.
- **`outputChoiceSupported()`** is
  `typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype`.
- **`attachVoiceOutput(audio)`** applies the stored output with `setSinkId`.
  If the call rejects or the id is missing, it calls `setSinkId("")` and
  records `outputFellBack`. The element stays registered until the returned
  `detach()` runs, so that:
  - a change in settings applies to a live call at once;
  - a `devicechange` that removes the sink sends playback back to the default
    output with the notice.

  When `setSinkId` is not supported, the function does nothing.

### 2. Settings rows: `VoiceDevicesSetting`

Write it in `src/components/voiceCompanion/VoiceDevicesSetting.tsx` and
render it from `VoiceCompanionSetting.tsx:187`, just before
`<CallMemorySetting …>`. That is outside the `settings.enabled` block, because
the composer call uses the choice even while the companion is off. It reads no
server settings, so it renders without them.

It holds one section titled «Microphone and speakers»: two labelled selects
stacked full width with a muted hint line under each. It lists devices when it
mounts, again on `devicechange`, and again after the permission button
resolves.

| State | Microphone select | Speakers select | Line(s) shown |
|---|---|---|---|
| No permission yet (`labelled` false; permission `prompt` or `unavailable`) | only «System default», enabled | only «System default», disabled | `devices.permission` hint plus the `devices.allow` button. The button runs `getUserMedia({ audio: true })`, stops the tracks at once, calls `rememberMicGrant()`, then lists the devices again |
| Permission denied | «System default», disabled | disabled | `devices.denied` |
| Default (nothing stored) | «System default» selected, then one option per input | the same for outputs | `devices.inUse` names the default device ({name}), so a long name is whole at 390 px where a native select cuts it |
| Chosen device present | that device selected | that device selected | on the phone only (below 640 px) `devices.inUse` repeats the name whole under the select; above that the select shows it |
| Chosen device gone | a selected disabled option «Not connected · {name}» stays first after System default; the marker leads, so a cut select still shows it | the same | `devices.missingHint` with the name whole. The stored choice is kept, so replugging restores it; picking another device replaces it |
| `setSinkId` unsupported, or no output listed (Firefox without `selectAudioOutput`, iOS) | as above | «System default», disabled | `devices.outputUnsupported` under Speakers |
| Call live, microphone changed | as above | as above | `devices.nextCall` under Microphone, after the `devices.inUse` line. The microphone applies from the next call; the speakers apply at once |
| Phone, 390 px | dialog `max-w-lg p-5` inside `p-4` leaves about 318 px of content: selects full width, `min-h-11`, long names truncated by the native select | same | Hints wrap. No horizontal overflow |
| Desktop | same column, 512 px dialog | same | none |

A choice saves on `change`, with no Save button. Selecting «System default»
clears the key.

### 3. The calls

- **`media.ts:38`.** Replace the `getUserMedia` call with
  `openVoiceMicrophone({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })`.
  Keep the `SESSION_CLOSED` and `MICROPHONE_REFUSED` mapping as it is.
- **`media.ts:47`.** After `new Audio()`, run `attachVoiceOutput(audio)`.
- **`media.ts` `close()`.** Call `release()` and `detach()`.
- **`codexRealtimeClient.ts:585-587`, `:591`, `:1310-1315`.** Make the same
  three changes and nothing else in this file. Keep `rememberMicGrant()` at
  :588.
- `liveAdapter.ts` and the `CompanionMedia` interface do not change. The UI
  reads the active input from the `voiceDevices` store.

### 4. Status in the call (no new pill)

- **Desktop companion (`VoiceCompanion.tsx:1357`).** While `connected` and an
  active input label exists, add a second line `.vc-mic` inside `.vc-state`,
  styled like `.vc-sim`: a 10 px `Mic` icon and the device name, with
  `max-width: 100%`, `overflow: hidden` and `text-overflow: ellipsis`. Also
  give the mute button (`:1361`) `title` and `aria-label` suffixed with
  `voiceCompanion.micInUse`, because `.vc-state` is `aria-hidden`. The block
  cuts a long name with an ellipsis, so `.vc-mic` takes the pointer
  (`pointer-events: auto`, the block lets it through) and carries the whole
  name as its `title`.

  Geometry: the block is 132 × 148 (`VoiceCompanion.tsx:58`). Character plus
  padding is 76, pill 20 → 34, controls 28, two gaps of 4, for 146 in total.
  That leaves 2 px; measure it in the driver. If it overflows, the mic line
  replaces nothing and the builder reports the measured box instead of
  shrinking the character.
- **Phone popover (`PhoneVoiceCompanion.tsx:579`).** While connected, add a
  line under the status, «Мікрофон: {name}», truncated in one line within
  the 236 px popover.
- **Composer panel (`VoiceConversation.tsx:289`).** While `live`, take the
  name from `stream?.getAudioTracks()[0]`. The status shows a `Mic` icon and
  the name alone, so the name gets the 214–224 px the row has at 380 and 390
  px (the live dot and the timer say the call is on); the `voice.liveMic`
  sentence is the status's `title` and `aria-label`. The panel already
  receives `stream`, so no client change is needed.
- **Fallback notices.** Add `MICROPHONE_FALLBACK` and `SPEAKERS_FALLBACK` to
  `COMPANION_MESSAGES`, said once per call as tone `note`:
  - desktop: `say("device-in" | "device-out", code, "note")` in
    `VoiceCompanion.tsx:636-646`;
  - phone: the lowest-priority branch of `sessionNotice`.

  Add both codes to `SETTINGS_FAILURES` (`VoiceCompanion.tsx:94`) so the notice
  carries the existing Settings button. The composer panel shows the
  microphone fallback through its existing `notice` row only if that needs no
  client change. Otherwise its status line, which names the device actually
  in use, is the signal.

## Strings

Put the keys in one contiguous block after `voiceCompanion.settings.uncertain.release`
(en :2590, uk :2535), with `voice.liveMic` beside `voice.live`.

| Key | en | uk |
|---|---|---|
| `voiceCompanion.devices.title` | Microphone and speakers | Мікрофон і динаміки |
| `voiceCompanion.devices.microphone` | Microphone | Мікрофон |
| `voiceCompanion.devices.speakers` | Speakers | Динаміки |
| `voiceCompanion.devices.default` | System default | Системний за замовчуванням |
| `voiceCompanion.devices.inUse` | In use: {name} | Використовується: {name} |
| `voiceCompanion.devices.unnamed` | Device {n} | Пристрій {n} |
| `voiceCompanion.devices.permission` | The browser names devices only after you allow the microphone. | Браузер показує назви пристроїв лише після дозволу на мікрофон. |
| `voiceCompanion.devices.allow` | Show devices | Показати пристрої |
| `voiceCompanion.devices.denied` | The browser blocks the microphone for this site. Allow it in the site settings, then reopen this window. | Браузер блокує мікрофон для цього сайту. Дозвольте його в налаштуваннях сайту й відкрийте це вікно знову. |
| `voiceCompanion.devices.missingOption` | Not connected · {name} | Не під’єднано · {name} |
| `voiceCompanion.devices.missingHint` | {name} is not connected. Using the system default until it is connected again. | {name} не під’єднано. Поки його немає, працює системний за замовчуванням. |
| `voiceCompanion.devices.outputUnsupported` | This browser does not let a site choose speakers. Sound plays through the system output. | Цей браузер не дає сайту вибрати динаміки. Звук іде через системний вихід. |
| `voiceCompanion.devices.nextCall` | The new microphone is used from the next call. | Новий мікрофон працюватиме з наступної розмови. |
| `voiceCompanion.micInUse` | Microphone: {name} | Мікрофон: {name} |
| `voice.liveMic` | Voice conversation is live · {mic} | Голосова розмова активна · {mic} |
| `COMPANION_MESSAGES.MICROPHONE_FALLBACK` | The chosen microphone is not connected. Using the system default. | Вибраний мікрофон не під’єднано. Працює системний за замовчуванням. |
| `COMPANION_MESSAGES.SPEAKERS_FALLBACK` | The chosen speakers are not connected. Sound plays through the system default. | Вибрані динаміки не під’єднано. Звук іде через системні за замовчуванням. |

Use the apostrophe `’` that the uk file already uses.

## Tests

Run each test file by path through `gate-remote -- bun test --timeout=60000 <file>`,
with HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR` isolated and
`LLV_VIEWER_CONTROL_URL` pointed at a closed port.

- `src/lib/audio/voiceDevices.test.ts` (new), against a fake `mediaDevices`:
  - stored id → `exact` constraint;
  - id rotated, same label → matched;
  - id missing → retry without `deviceId` and `fellBack: true`;
  - `NotAllowedError` propagates;
  - `default` pseudo-entry named through `groupId`;
  - `setSinkId` missing → `attachVoiceOutput` does nothing and
    `outputChoiceSupported()` is false;
  - `setSinkId` rejects → `""` plus `outputFellBack`;
  - `devicechange` that drops the sink → default plus fallback.
- `src/lib/voiceCompanion/media.test.ts`: `open()` passes the stored
  `deviceId`; `close()` clears the active input. Use the file's existing
  `install("navigator", …)` fakes.
- `src/components/voiceCompanion/VoiceDevicesSetting.dom.test.tsx` (new):
  - each state in the table in §2, in en and uk;
  - a choice writes the key, and System default clears it;
  - `devicechange` re-lists;
  - Speakers is disabled and shows the unsupported line when `setSinkId` is
    absent.
- One case each in the existing `VoiceConversation.dom.test.tsx` (status
  names the track) and `voiceCompanionProduct.dom.test.tsx` (the mic line and
  the `MICROPHONE_FALLBACK` notice).

Then typecheck, and ESLint on the touched files.

## Rendered evidence (existing drivers only)

Use an init script in each driver to stub `navigator.mediaDevices`
(`enumerateDevices`, `getUserMedia`, `devicechange`) and, for the unsupported
state, delete `HTMLMediaElement.prototype.setSinkId`. Use real-length names
such as «Microphone Array (Realtek(R) Audio)» and «Навушники AirPods Pro
(Bluetooth)». Frames go under the stage's `$TMPDIR` and are never committed.

- **Settings dialog, every row of the §2 table at 1440 and 390 (plus 820),
  en and uk, light and dark.** Add a `describe("voice devices")` case to
  `src/components/kanban/kanbanBoard.browser.test.tsx` beside «floating voice
  companion» (:22873), which already opens this dialog at 1440 and 390 through
  `openVoice(...)`.
- **Desktop companion in a call with the mic line, and the fallback notice.**
  Use the same kanban driver block; seed the active input through the
  `voiceDevices` store, since the simulator opens no microphone.
- **Phone head popover with the mic line and the fallback notice, at 390 ×
  844 and 375 × 667.** Add a case to `describe("phone voice head")` in
  `src/components/mobile/issue1671Evidence.browser.test.tsx:10784`.
- **Composer panel status.** The DOM test above, plus the case "the composer's
  voice call panel gives the microphone name the room" in
  `src/components/kanban/kanbanBoard.browser.test.tsx`, which mounts the panel
  through the fixture's `?scenario=voice-panel` at 380, 390 and 640.

## What not to touch

- `src/lib/voiceCompanion/liveAdapter.ts`, `liveSession*.ts`,
  `codexProvider*.ts`, `contract.ts`, and every route under
  `src/app/api/voice-companion/**` and `src/app/api/runtime/realtime/**`.
  These are the call backend.
- `src/components/voiceCompanion/VoiceToolsSetting.tsx`, plus every tool,
  worker-delivery and bridge path in `codexRealtimeClient.ts`. That is the tool
  wiring, which slice 2 owns. In that file only the three hunks in §3 change.
- `src/lib/voiceCompanion/liveSession.test.ts`, which lane f3f1998a owns
  (PR #3239).
- `src/lib/audio/prefs.ts`, plus cues and captions under `src/lib/audio/`
  (PR #3228), `SpeakButton`, `chime.ts`, and `useDictation.ts`.
- `.github/workflows/**`.
- No new driver file, and no file named after an issue.

## Deferred — not currently justified

- **Switching the microphone mid-call** (`RTCRtpSender.replaceTrack`), and
  recovering a microphone unplugged mid-call. The requirement asks for the
  chosen device at call start plus a fallback; a mid-call change applies to
  the next call and says so.
- **Using the chosen microphone for dictation** (`useDictation.ts:550`). The
  requirement names the call. Dictation would be a one-line follow-up once the
  operator wants it.
- **Routing TTS, cues and background music (`SpeakButton`, `chime.ts`,
  `ambientLoop`) to the chosen speakers.** Only the call's playback is asked
  for.
- **Firefox `selectAudioOutput()`** to expose speakers there. Its own browser
  prompt would be new chrome; for now the selector says the browser cannot
  choose.
- **Syncing the choice across browsers or devices.** The requirement says per
  browser, and the device ids are per origin and per browser anyway.
