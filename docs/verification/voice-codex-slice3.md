# Codex subscription voice: slice 3 verification

This implements slice 3 of [the design](../design/voice-codex-subscription.md)
as the operator changed it on 2026-10-11 about 11:10 UTC, by voice, relayed by
the seat, verbatim:

> Добавьте переключатель способа голосового общения: Codex V3 по подписке или голос через API. API-вариант должен запрашивать API-ключ только если выбран; пока он не выбран, ключ не нужно показывать или требовать. Оператор предпочитает API-голос и хочет оставаться на нём, даже с оплатой за API.

Item 4 of the slice is replaced by that choice and slice 4 is cancelled. Items
1 to 3 hold for calls on the Codex backend. The API path keeps its key, cap,
model, voice and dollar display; its tests run unchanged apart from the
assertions that said there was no backend to choose.

## Acceptance evidence

1. **Usage and display.** `CompanionUsage` is now the figures of the backend
   the call ran on. A Codex call carries `callSeconds` on the server clock
   (from the voice's start to its close), the plan type, both windows with
   their reset times, `limitReached`, and the primary window's use at the
   call's first reading. The provider merges every
   `account/rateLimits/updated` into one plan, so a reading that leaves a
   window out keeps the earlier value (`codexProvider.test.ts`, "usage carries
   the call's seconds…"). The transcript footer keeps variant 2's layout: the
   call's length and the plan window above a thin meter whose teal share is
   the rise since the call started; its label and hint say the window is the
   whole account's, its agents included. With Codex chosen the settings
   dialog shows the last Codex call and its plan window and nothing about a
   key; with the API chosen it shows the key field, the cap and the month's
   dollars as before. The kanban driver's voice cases render both dialog
   states at 1440, 1000 and 390 in en and uk, light and dark
   (`evidence/voice-companion/settings.json`), the Codex footer at 1440 and
   1000 (`evidence/voice-companion/transcript-codex.json`), and the API footer
   unchanged (`evidence/voice-companion/transcript.json`). At 390 the
   companion is not mounted, so the dialog is the only place for these
   figures there, as #2681 set.
2. **Limit mid-call.** A recorded `account/rateLimits/updated` at 100 % with
   `rateLimitReachedType`, delivered twice by the stub app-server mid-call,
   produces exactly one `thread/realtime/appendSpeech` in the call's language,
   then `thread/realtime/stop`, a `session.closed` with reason `limit`, and an
   ended usage with `limitReached: true`. The recorded observation, read back
   through `durableQuotaObservation`, makes `selectVoiceAccount` pick the
   other managed account, and refuse with `CODEX_LIMIT_REACHED` when that
   account is the only one. A `thread/realtime/error` that follows the limit
   still closes with reason `limit` and emits no generic error. A start the
   limit refuses names its reset in the notice (`liveAdapter.test.ts`,
   `voiceCompanionProduct.dom.test.tsx`, and the driver's no-key case).
3. **The voice.** `thread/realtime/listVoices` on `codex-cli 0.162.1` answers
   a v1 list of nine voices (juniper, maple, spruce, ember, vale, breeze,
   arbor, sol, cove; default cove) and a v2 list. A V3 start validates against
   the v1 set: `codexVoiceSchema.test.ts` starts the installed binary in an
   isolated home with no account, asks for a v2 voice and reads the accepted
   set from the refusal. The canary recorded one greeting per voice through
   the production `CodexLiveProvider` over V3 WebRTC (table below) and
   published the nine as numbered options on the task's prototype review. The
   operator picked option 9, cove. `CODEX_VOICE` names it on every start, so
   a change of Codex's own default leaves the voice as it is.
4. **The backend choice** (replacing "the default becomes Codex"). The
   settings store `backend: "api" | "codex"`, read as `api` when absent; a
   stored `official-realtime` reads as `api` and a stored demo as off. The
   settings route accepts the field and refuses anything else. Each new call
   runs on the provider its start chose, and recovery hangs up an old call
   through the provider it ran on. With Codex chosen and no key anywhere,
   Talk opens the microphone and reaches the session route with an offer,
   and the server starts the call with no key read
   (`codexProvider.test.ts`, "the server starts a call on the API by
   default and on Codex when the settings choose it…").

## Voice canary

Each voice ran in its own isolated home holding a copy of one managed Pro
account's sign-in, with the bridge's and the leased app-server's PIDs
recorded. The bridge asked the voice to say a fixed Ukrainian greeting through
`thread/realtime/appendSpeech`; an aiortc peer recorded the answer audio.

| # | Voice | Start (ms) | Request to audio (ms) | Speech (s) | Median F0 (Hz) |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | juniper | 1654 | 1047 | 2.76 | 205 |
| 2 | maple | 1637 | 851 | 2.34 | 211 |
| 3 | spruce | 1746 | 1200 | 2.74 | 96 |
| 4 | ember | 1871 | 870 | 2.50 | 91 |
| 5 | vale | 1866 | 654 | 3.04 | 222 |
| 6 | breeze | 1719 | 1028 | 2.74 | 165 |
| 7 | arbor | 1773 | 961 | 2.62 | 133 |
| 8 | sol | 1561 | 746 | 2.44 | 200 |
| 9 | cove | 1684 | 1345 | 2.76 | 129 |

Every run connected; every recorded PID had exited afterwards; no file
appeared under the copied home's `sessions` directory. Juniper alone reworded
the greeting.

## Checks

The touched test files ran by path under one isolated root (HOME, XDG
directories, `TMPDIR` and `LLV_STATE_DIR` under `mktemp -d /tmp/…`,
`LLV_VIEWER_CONTROL_URL` on a closed port) through `scripts/gate-slot.sh`;
`bunx tsc --noEmit` ran through the slot. The installed Codex was
`codex-cli 0.162.1` and Bun `1.4.0`.
