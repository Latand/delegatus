Source: operator requirement, 2026-10-15, dictated in Russian and relayed into this task by the orchestrator. Verbatim:

> Слушай, я передумал… давай без вот этой дополнительной хуйни, по отличию по голосам. Наверное, убираю это всё. Будет один выбор: либо ты используешь Eleven Labs, либо одно, либо другое, либо третье. И, соответственно… Где-то нужно иметь возможность прописать… по каким-то образом выбрать или прописать голос.

# Read-aloud: one provider, and a voice per provider

Design dated 2026-10-15, written against `61799bbcc` (which was still `origin/main` when this was finished). This stage changes no product code.

**Verdict: build it, and keep it small.** Most of what the requirement asks for is already in place. ElevenLabs is already a `TtsBackend`. Its key is already read from `elevenlabs-api-key` in the app config dir. The provider choice is already one radio list in the read-aloud right-click menu (`SpeakMenu`). A per-provider voice is already read from `tts-voice-<provider>`. Four things are missing:

1. A way to set the voice from the UI.
2. A voice list per provider.
3. ElevenLabs on `eleven_v4_turbo`, using the streamed playback path that Fish Audio and Soniox use.
4. A readable error for a voice id the provider does not know.

The language-routing lane (PR #2888, closed unmerged) is not ported. Nothing in this design inspects the message's language. No ADR: every piece is a file, a route or a menu block, and each one is easy to reverse.

## 1. What exists today

| Concern | Where | What it does now |
| - | - | - |
| Provider list and selection | `src/lib/ttsBackend.ts:8-9,44-49` | `openai \| elevenlabs \| soniox \| fishaudio`. Selection order is `LLV_TTS_BACKEND` (which locks the picker), then the `tts-backend` file, then `openai`. |
| Selection write | `src/lib/ttsBackend.ts:51-55`, `src/app/api/tts/backend/route.ts:15-32` | `POST /api/tts/backend {backend, model?}` writes `tts-backend` and, for Fish, `tts-model-fishaudio`. |
| Keys | `src/lib/transcribeBackend.ts:116-137` (ElevenLabs, Soniox), `src/lib/ttsBackend.ts:57-63` (OpenAI, Fish) | Each key is read on every request: environment variable first (`ELEVENLABS_API_KEY`, `SONIOX_API_KEY`, `OPENAI_API_KEY`, `FISH_AUDIO_API_KEY`), then `<config>/<provider>-api-key` through `configFilePath` (`src/lib/configDir.ts:46-48`). That path resolves to the `delegatus` app dir, which is where the operator's ElevenLabs key already sits. **No key work is needed.** |
| Per-provider voice | `src/lib/ttsBackend.ts:84,92,100,110` | `LLV_TTS_<P>_VOICE` first, then the `tts-voice-<p>` file, then a code default: `alloy`, `21m00Tcm4TlvDq8ikWAM`, `Adrian`, `default`. None of these is writable from the UI. |
| ElevenLabs model | `src/lib/ttsBackend.ts:91` | Default `eleven_multilingual_v2`. |
| Synthesis | `src/app/api/tts/route.ts:90-133` | OpenAI streams mp3. Soniox and Fish stream 24 kHz PCM when the client sends `mode`. ElevenLabs calls `/with-timestamps` and returns the whole chunk as base64 mp3 with character alignment (`:280-305`). |
| Upstream refusal | `src/app/api/tts/route.ts:268-276` | Cancels the body without reading it. Answers `"<backend> TTS failed (HTTP n)"`. ElevenLabs refusals are always reported as 502. |
| Client playback | `src/components/feed/SpeakButton.tsx:152,198`, `ttsPcmSession.ts:70,273`, `src/lib/ttsChunks.ts:105` | `soniox \|\| fishaudio` takes the PCM fast path (short first sentence, streamed, Web Audio). The rest use whole-chunk `<audio>` playback through `TtsSession`. |
| The control | `src/components/feed/SpeakMenu.tsx:240-389` | The right-click menu (long press on a phone) titled "Voice & billing": a cost line, `provider · model · voice`, the provider radio rows, and Fish's nested model group. |
| Rendered evidence | `src/components/kanban/issue1695BrowserHarness.ts:883-993` (`captureFishAudioMenu`), called from `kanbanBoard.browser.test.tsx:17120` and `issue1671Evidence.browser.test.tsx:6918` | The SpeakMenu matrix: en/uk × light/dark × 1440/1000 and 320/390. |

Installation state, read without changing it: `tts-backend` = `fishaudio`, `tts-model-fishaudio` = `s2.1-pro`, no `tts-voice-*` file, no `LLV_TTS_*` in `service.env`. All four key files are present.

## 2. Observed provider facts (2026-10-15)

Every call below used the installation's configured keys. Key values were never printed. **No synthesis was paid for.** The three bad-voice probes were refused before any audio was generated.

| Question | Observation |
| - | - |
| `eleven_v4_turbo` exists | `GET /v1/models` lists it. `can_do_text_to_speech: true`, `maximum_text_length_per_request: 10000`, `character_cost_multiplier: 0.5`, `serves_pro_voices: false`. Its 94 languages include `uk`, `ru` and `en`. |
| ElevenLabs voice list | `GET /v2/voices?page_size=100` returned 200 with 60 voices, `has_more: false`. Each item has `voice_id`, `name`, `category` (`premade` / `cloned` / `generated` / `professional`) and `is_owner`. The legacy `GET /v1/voices` returns the same 60 in one unpaginated body. The documented endpoint is v2 (`page_size` ≤ 100, `next_page_token`). |
| The «Delegatus» voice | `03PJALT6TZ4IVrK14MXx` is in the list: `category: generated`, `is_owner: true`, `high_quality_base_model_ids: []`. It is the only voice with that name. `GET /v1/voices/03PJALT6TZ4IVrK14MXx` answers 200. |
| Old ElevenLabs code default | `GET /v1/voices/21m00Tcm4TlvDq8ikWAM` now answers with a *different* voice: a `professional` voice under another name. That id is not among the account's premade voices. The code default no longer means what it meant. |
| ElevenLabs key scope | `GET /v1/user/subscription` returns `401 {"detail":{"status":"missing_permissions","message":"The API key you used is missing the permission user_read …"}}`. The key is scoped, so a key without `voices_read` gets the same shape on the list call. The plan tier could not be read. |
| ElevenLabs bad voice at synthesis | `POST /v1/text-to-speech/<unknown>/stream?output_format=pcm_24000` (and `/with-timestamps`) answers **404**, `application/json`, `{"detail":{"type":"not_found","code":"voice_not_found","message":"A voice with voice_id '…' was not found.","status":"voice_not_found","request_id":"…"}}`. |
| ElevenLabs PCM | The `/stream` docs list `output_format` values including `pcm_24000` and note "PCM with 44.1kHz sample rate requires you to be subscribed to Pro tier or above". So `pcm_24000` has no tier gate. The TTS capability page lists "PCM (S16LE)". This matches `PcmDecoder` (`ttsPcmSession.ts:30-41`). |
| Fish voice list | `GET https://api.fish.audio/model?self=true&page_size=100` returned `total: 0`: this account owns no voices. The OpenAPI `/model` parameters are `self`, `title`, `tag`, `language`, `author_id`, `licensed`, `sort_by`, `page_size ≤ 100` and `page_number`. There is no "saved/liked" filter. |
| Fish Jarvis | `GET /model/0c7fd46820854a9e8c4010d911687b7a` returns 200: title «Джарвис 2.0», `type: tts`, `state: trained`, `visibility: public`, languages `uk, ru, bg`. An unknown id returns `404 {"status":404,"message":"Model not found"}`. |
| Fish bad voice at synthesis | `POST /v1/tts` with an unknown `reference_id` answers **400** `{"message":"Reference not found","status":400}`. |
| Soniox voice list | `GET https://api.soniox.com/v1/tts-models` returns 200. `tts-rt-v2` has 200 voices `{id, gender, description}`, and the id is the name passed as `voice` (`Daniel`, `Adrian`, …). `GET /v1/voices` (cloned voices) returns 200 `{voices: [], next_page_cursor}`. Docs: soniox.com/docs/tts/concepts/voices. |
| Soniox bad voice at synthesis | `POST https://tts-rt.soniox.com/tts` with an unknown voice answers **400** `{"error_code":400,"error_message":"Invalid voice 'X' for model 'tts-rt-v2'.","error_type":"invalid_request",…}`. |
| OpenAI | No voice list endpoint. Voice name typed only. |

**Not observed** (each needs a paid synthesis, which this stage does not make without the operator's OK):

- Whether `eleven_v4_turbo` accepts the *generated* «Delegatus» voice. Its `high_quality_base_model_ids` is empty, and the v4 page talks only about instant and professional clones.
- The `Content-Type` ElevenLabs sends for `pcm_24000`.

The design handles both anyway. The route normalises `audio/*` and `application/octet-stream` to `audio/pcm`, as it already does for Fish, and passes a voice/model refusal through as a readable error (§6). The first real read on this installation settles it.

## 3. Decisions

### 3.1 ElevenLabs joins the streamed PCM path

Requirement 2 says ElevenLabs audio plays "the same way the other providers' audio does today (same format path, streaming if the others stream)". Soniox and Fish, the providers this installation actually uses, stream 24 kHz PCM through `PcmSession`. ElevenLabs therefore moves from `/with-timestamps` (whole chunk, base64 mp3) to:

```
POST https://api.elevenlabs.io/v1/text-to-speech/{encodeURIComponent(voice)}/stream?output_format=pcm_24000
content-type: application/json

{"model_id":"eleven_v4_turbo","text":"<chunk>"}
```

The key goes in the `xi-api-key` request header, set the same way `synthesisRequest` sets it today.

Effects:

- The first sentence is synthesized alone and starts playing while the rest streams. This is the fast-tts behaviour (`docs/design/fast-tts.md`) the operator asked for on 2026-09-30.
- The same response headers apply (`x-tts-encoding: pcm_s16le`, `x-tts-sample-rate: 24000`, `x-tts-channels: 1`).
- The cache key already carries the voice (`voiceKey`), so changing the voice never replays audio spoken by the previous one.

**Trade-off:** ElevenLabs loses word-exact karaoke from the alignment payload (#1022). It gets Fish's duration-based word estimate (`ttsPcmSession.ts:273`). Nobody on this installation reads with ElevenLabs today. Keeping `/with-timestamps` would have kept exact karaoke, at the price of a first sound that waits for a whole ~800-character chunk. Streaming alignment (`/stream/with-timestamps`) is deferred (§10).

The route's `/with-timestamps` branch (`route.ts:78-89` comment, `:128-133`, `:159-200` `readBounded` / `alignmentOf`, `:280-305`) becomes unreachable and is **deleted**. The client's generic JSON-envelope handling in `ttsSession.ts` and `src/lib/ttsAlignment.ts` stays untouched in this lane (see §10).

One predicate replaces the six `soniox || fishaudio` checks: `isPcmTtsBackend(id)` in `src/lib/tts.ts`, which is already client-safe and already imported by `SpeakMenu`. It is true for `soniox`, `fishaudio` and `elevenlabs`.

### 3.2 Voice storage: the files that already exist

There is no new store. The voice of provider `p` lives in `<config>/tts-voice-<p>`, the file `ttsBackendInfo()` already reads, written beside `tts-backend` and `tts-model-fishaudio`. It is read on every request, so it survives a restart and applies without one. `LLV_TTS_<P>_VOICE` keeps overriding it and now also **locks** it in the UI, mirroring `LLV_TTS_FISHAUDIO_MODEL`.

Data shape added to `TtsBackendOption` (`src/lib/ttsBackend.ts`) and mirrored in `BackendOption` (`SpeakMenu.tsx:18-29`):

```ts
voiceLockedByEnv?: boolean;   // LLV_TTS_<P>_VOICE is set
voiceList: boolean;           // provider has a list endpoint: elevenlabs, fishaudio, soniox true; openai false
```

New writer, beside `writeFishAudioModel`:

```ts
export function writeTtsVoice(backend: TtsBackend, voice: string): void // writes `${voice}\n` to configFilePath(`tts-voice-${backend}`)
export function isTtsVoiceId(value: unknown): value is string          // trimmed, 1–128 chars, no control characters or whitespace other than inner spaces
```

Soniox shared voice ids are names (`Adrian`), and an OpenAI voice is a word, so spaces are not forbidden in the middle. Newlines are forbidden: the file holds one line.

`POST /api/tts/backend` gains an optional `voice`:

```ts
{ backend: TtsBackend; model?: FishAudioModel; voice?: string }
```

- `voice` is rejected with 400 unless `isTtsVoiceId`.
- 409 `"voice is locked by LLV_TTS_<P>_VOICE"` when that variable is set.
- Under `LLV_TTS_BACKEND`, `voice` is allowed only for the locked backend, the same rule the Fish model follows (`backend/route.ts:29`).
- The answer is `ttsBackendInfo()`, as today.

**Code defaults:**

- ElevenLabs model becomes `eleven_v4_turbo`.
- ElevenLabs default voice becomes `JBFqnCBsd6RMkjVDRZzb`, a premade voice in every account and the one the ElevenLabs docs use, because the old default now resolves to a different voice (§2).
- The default backend stays `openai`. **This installation's** defaults are configuration and are set in rollout (§9). The «Delegatus» voice belongs to this account and would answer `voice_not_found` on any other.

### 3.3 Voice list: one read-only route

`GET /api/tts/voices?backend=<id>` (new `src/app/api/tts/voices/route.ts`, `runtime = "nodejs"`, `dynamic = "force-dynamic"`). It reads the key with the existing readers and calls the provider server-side, so the key never reaches the browser. It maps each item to three fields and drops everything else (preview URLs, owner data, samples):

```ts
interface TtsVoice { id: string; name: string; own: boolean }
interface TtsVoicesResponse {
  backend: TtsBackend;
  voices: TtsVoice[];          // own first, then by name (Intl.Collator)
  truncated: boolean;          // page bound hit
  selected: { id: string; name: string | null; known: boolean | null };
}
// error: { error: string; code: "missing-key" | "no-list" | "provider-refused" | "unreachable"; keyPath?: string } with 503 / 404 / 502
```

| Provider | Calls | `own` | `selected` when absent from the list |
| - | - | - | - |
| ElevenLabs | `GET /v2/voices?page_size=100`, following `next_page_token` while `has_more`, at most 5 pages | `is_owner` | `GET /v1/voices/{id}`: 200 → known with its name; 400/404 `voice_not_found` → `known: false` |
| Fish Audio | `GET /model?self=true&page_size=100` (max 5 pages), plus a first synthetic entry `{id: "default", name: <Fish default>}` | `true` for `self` results | `GET /model/{id}`: 200 → known with `title` (e.g. Jarvis resolves to «Джарвис 2.0»); 404 → `known: false` |
| Soniox | `GET /v1/tts-models` → voices of the configured model (`option.model`, following `aliased_model_id`); `GET /v1/voices` (cloned, cursor, max 5 pages) | `true` for `/v1/voices` | `known: false`, because the list is complete for the model |
| OpenAI | none | none | `404 {code: "no-list"}`; the UI offers the typed field only |

Bounds:

- 10 s timeout per call.
- 4 MB per body (`readBounded`-style; the existing helper moves here when the route's copy is deleted).
- Provider error text passes through `redactSecrets`, cut to 300 characters.
- A missing key answers 503 `{code: "missing-key", keyPath}` **before** any fetch.
- A provider 401/403 is `provider-refused`, carrying the provider's own message. That covers ElevenLabs' `missing_permissions … voices_read`.
- Same headers as `GET /api/tts/backend`. No CORS.

There is no server cache. The client caches per backend for the page's life, the same way `SpeakButton` holds backend info. It refetches when the menu opens after a voice save, or on Retry.

## 4. The UI change, inside the existing menu

Everything goes inside `SpeakMenu`'s existing body. There is no new panel, page, pill or trigger, and the provider rows, cost lines and Fish model group are unchanged. One block is added: **Voice**, rendered directly under the *selected* provider's row (and under Fish's model group when Fish is selected). Other providers' rows show their saved voice in their existing subtitle (`model · voice`) and get no editor.

```
Voice & billing
Next click: paid synthesis of this answer
ElevenLabs · eleven_v4_turbo · Delegatus
…
─────────────────────────────
✓ ElevenLabs
  eleven_v4_turbo · Delegatus
  ┌ Voice ───────────────────┐
  │ [ Name or voice id     ] │   ← one input: filters the list, or takes a typed id
  │ ✓ Delegatus      yours   │   ← menuitemradio rows, max 6 shown
  │   Celestia       yours   │
  │   George                 │
  │   …                      │
  │ +54 more — type to narrow│
  └──────────────────────────┘
● OpenAI         gpt-4o-mini-tts · alloy
● Soniox         tts-rt-v2 · Adrian
● Fish Audio     …
```

**Structure.** A `role="group"` labelled "Voice" (`tts.voiceGroup`) holds:

- One `<input>` (`aria-label` "Voice name or id", `autocomplete="off"`, `spellcheck=false`, empty placeholder). It filters case-insensitively on name and id.
- The voice rows as `role="menuitemradio"` with `aria-checked` on the saved voice. This keeps the menu's existing semantics: a voice is a radio choice like a provider.
- **At most 6 rows** of the current filter, own voices first. When more match, one muted line follows: "+N more — type to narrow" (`tts.voiceMore`). The menu does not get a second, nested scroller.
- Each row shows the name (truncated, `min-w-0`) and a `yours` tag for `own`. The id goes in the row's `title`, so long ids never widen the menu.

**Typed id.** When the filter text is non-empty and matches no row id exactly, a last row appears: "Use «<text>» as the voice id" (`tts.voiceUseTyped`). Under it, a muted note says "Not in your list" when a list was loaded (`tts.voiceNotListed`). Enter in the input picks the single match when exactly one row matches. Otherwise it picks the typed row.

**Save.** Picking a row POSTs `{backend: selected, voice}`. The row shows the existing `Loader2`. Success stores the answer through `storeBackendInfo` (every control on the page follows) and closes the menu, as a provider pick does. Failure keeps the menu open with "Could not save the voice" (`tts.voiceSaveFailed`) in the existing error slot.

**States** (all inside the group; the input is always present unless locked):

| State | What the group shows |
| - | - |
| Loading | One row-height line: spinner + "Loading voices…" (`tts.voicesLoading`). The input works and a typed id can be saved. |
| Loaded | Rows as above. If `selected.known === false`: a danger line "<Provider> has no voice «id». Pick another." (`tts.voiceNotFound`) above the rows, before any paid click. |
| Failed | A danger line "Couldn't load <Provider> voices: <provider message>" (`tts.voicesFailed`) and a `Retry` button (`tts.voicesRetry`). The typed path still works. |
| No list (OpenAI) | A muted line "OpenAI has no voice list — type a voice name." (`tts.voiceTypeOnly`). |
| Unconfigured provider | The existing `tts.missingKey` line (already rendered at `SpeakMenu.tsx:324-328`) stays. The list area shows nothing else, and **no list request is made**. The typed id can still be saved, so the voice is ready when the key arrives. The provider row keeps its `not set up` tag, and the left click keeps refusing out loud with the key path (`SpeakButton.tsx:381-384`). |
| Locked by env | The input and rows are disabled, with "Voice is set by LLV_TTS_<P>_VOICE." (`tts.voiceLocked`). |

**Header line.** `SpeakMenu.tsx:314` and the provider subtitle show the voice's **name** when the list resolved it (`selected.name`), and the id otherwise.

**Sizes:**

| Viewport | Layout |
| - | - |
| Desktop (1440, 1000) | Menu stays 300 px wide. Input `h-8 text-[12px]`, rows `py-1.5` like the provider rows. |
| Phone (390, also checked at 320) | Menu is `min(300, 100vw − 16)`, already in place. Input `min-h-11 text-[16px]` (the `QuestionCard` convention, so iOS does not zoom on focus). Rows `min-h-11`. |

The menu already re-places itself on `resize` (`useAnchoredBox`), so the on-screen keyboard shrinking the viewport moves it, and its existing `max-h-[calc(100vh-16px)] overflow-y-auto` keeps it whole.

Input styling: `rounded-control border border-border bg-card px-2 focus-visible:ring-2 focus-visible:ring-accent/35`. These are the same tokens as the existing inputs; no new colours. Light and dark come from those tokens.

**Focus.** The menu's mount effect still focuses the checked *provider* row. It never focuses the input, so the phone keyboard does not jump up on long press. Escape closes the menu from the input as from anywhere else (`useOverlayEscape`). Pointerdown inside the input is inside `rootRef`, so it does not dismiss.

**ARIA note.** A text input inside `role="menu"` is a deviation: the menu already holds non-item text lines, and its keyboard model is Tab, not arrow keys. Changing the container to `dialog` would rewrite every provider row and both drivers. That is recorded under Deferred, not built here.

## 5. Synthesis sends the saved voice

- **ElevenLabs:** `voice_id` in the URL path, `encodeURIComponent`.
- **Fish:** `reference_id`, omitted for `default` (`route.ts:109`, unchanged).
- **Soniox:** `voice` in the body (unchanged).
- **OpenAI:** `voice` (unchanged).

`activeTtsOption()` already reads the file per request, so a saved voice is what the next request bills. `x-tts-voice` reports it back and `onVoice` (`SpeakButton.tsx:289`) keeps catching a stale tab.

## 6. A bad voice id: visible and readable, never replaced

The route never substitutes another voice. There is no retry with the default anywhere: `requestPcm` retries only 429 (`ttsPcmSession.ts:54-62`), and that stays.

On a non-OK upstream answer the route stops cancelling blind. It reads at most 8 KB of the error body (JSON when the content type says so), then classifies:

| Provider | Recorded refusal | Classified as |
| - | - | - |
| ElevenLabs | 404, `detail.status` or `detail.code` = `voice_not_found` | `voice-not-found` |
| Fish | 400 or 404 with `message` matching `/reference\|voice/i` | `voice-not-found` (checked before the free-model `fishaudio-free-refused` code) |
| Soniox | 400 with `error_message` matching `/invalid voice/i` | `voice-not-found` |

A `voice-not-found` answers **422** `{error, code: "voice-not-found", voice}`. Every other refusal keeps today's mapping, with ElevenLabs added to the pass-through list `[400, 401, 402, 403, 404, 429]` (today it is always 502), so a 429 carries `retry-after` and the client's existing retry works. For ElevenLabs only, a 4xx whose body has `detail.message` also carries that text (redacted, ≤ 300 characters). That is how a model/voice incompatibility, if `eleven_v4_turbo` refuses the generated voice, reads as ElevenLabs' own sentence instead of "HTTP 400". No key or request header is ever echoed: the existing "maps HTTP %i without echoing upstream secrets" test extends to ElevenLabs.

Client: the `onError` mapping at `SpeakButton.tsx:308-317` gains `cause.code === "voice-not-found"` →

`tts.voiceNotFoundAlert`: "<Provider> doesn't know the voice «<id>». {action} to pick another."

`{action}` reuses the mouse/touch split (`tts.voiceChooseMouse` "Right-click", `tts.voiceChooseTouch` "Press and hold this button"). The message shows in the existing `SpeakAlert`, or in the menu's notice slot when the menu is open. The read stops; nothing else plays.

## 7. Files to change

| File | Change |
| - | - |
| `src/lib/ttsBackend.ts` | `voiceLockedByEnv`, `voiceList`, `writeTtsVoice`, `isTtsVoiceId`; ElevenLabs default model `eleven_v4_turbo`, default voice `JBFqnCBsd6RMkjVDRZzb`. |
| `src/lib/tts.ts` | `isPcmTtsBackend()`. |
| `src/app/api/tts/backend/route.ts` | Optional `voice` with validation and locks. |
| `src/app/api/tts/voices/route.ts` (new) | §3.3. |
| `src/app/api/tts/route.ts` | ElevenLabs `/stream?output_format=pcm_24000`; accept `mode:"pcm"` for ElevenLabs and refuse anything else with 409 (as Fish); content-type normalisation for ElevenLabs; refusal classification (§6); delete the `/with-timestamps` branch, `alignmentOf` and the comment at `:78-89`. |
| `src/components/feed/ttsPcmSession.ts` | `requestPcm` accepts `elevenlabs` (`:70`); duration-based word estimate for every PCM backend except Soniox (`:273`). |
| `src/lib/ttsChunks.ts` | `:105` uses `isPcmTtsBackend`. |
| `src/components/feed/SpeakButton.tsx` | `fast`/chunk policy via `isPcmTtsBackend` (`:152,198`); `pickVoice(backend, voice)` beside `pickBackend` (`:425`); `voice-not-found` message (`:308-317`); pass `onPickVoice` to the menu. |
| `src/components/feed/SpeakMenu.tsx` | The Voice group (§4), its voices fetch and cache, the name in the header line and subtitles; `isPcm` via the predicate; the seek hint generalised (below). |
| `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` | New keys: `tts.voiceGroup`, `tts.voiceInput`, `tts.voicesLoading`, `tts.voicesFailed`, `tts.voicesRetry`, `tts.voiceMore`, `tts.voiceOwn`, `tts.voiceUseTyped`, `tts.voiceNotListed`, `tts.voiceNotFound`, `tts.voiceNotFoundAlert`, `tts.voiceChooseMouse`, `tts.voiceChooseTouch`, `tts.voiceTypeOnly`, `tts.voiceLocked`, `tts.voiceSaveFailed`, `tts.fishDefaultVoice`. `tts.fishSeekHint` becomes `tts.estimatedSeekHint` with `{provider}` and is used for Fish and ElevenLabs. Ukrainian `tts.voiceMore`: `ще +{count} — уточніть пошук`. |
| `src/components/kanban/issue1695BrowserHarness.ts` | The driver case (§8.2), plus the Fish case stubbing `/api/tts/voices` and counting provider rows by a `data-tts-provider` attribute instead of all `menuitemradio`. |
| `docs/transcription.md` (Read-aloud section) | ElevenLabs model/stream/voice, the voice picker, `tts-voice-<p>`, the env lock. |

## 8. Tests

All tests run by explicit path through `bash scripts/gate-slot.sh bun test <file>`, with isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` under `/tmp`, and `LLV_VIEWER_CONTROL_URL` on a closed port. Every provider call is a stubbed `fetch` that returns the **recorded shapes from §2**. No test reaches a provider, and none pays for synthesis.

### 8.1 Unit and route tests

| File | Cases |
| - | - |
| `src/lib/ttsBackend.test.ts` | ElevenLabs defaults `eleven_v4_turbo` / `JBFqnCBsd6RMkjVDRZzb`. `writeTtsVoice` per provider, read back after a fresh module import (restart). `LLV_TTS_ELEVENLABS_VOICE` wins and sets `voiceLockedByEnv`. `isTtsVoiceId` refuses empty, newline and over-128. `voiceList` per provider. |
| `src/app/api/tts/backend/route.test.ts` (exists, has no ElevenLabs case today) | `{backend, voice}` persists only that provider's file. Invalid voice 400. Voice env lock 409. Backend lock allows the locked backend's voice and refuses another. |
| `src/app/api/tts/voices/route.test.ts` (new, beside its route) | ElevenLabs two-page `has_more` follow and own-first order. Selected resolved through `/v1/voices/{id}`, and `known: false` on the recorded 400 `voice_not_found`. 401 `missing_permissions` → 502 `provider-refused` with the provider sentence. Fish `self` empty plus `default` entry plus Jarvis resolved by `/model/{id}`. Soniox `tts-models` filtered to the configured model plus `/v1/voices`. OpenAI `no-list`. Missing key → 503 with `keyPath` **and zero fetch calls**. Body over the bound → `unreachable`. The key never appears in any response body or header. |
| `src/app/api/tts/route.test.ts` | Replace the `#1022 elevenlabs character alignment` describe with "ElevenLabs PCM route": exact URL (`/stream?output_format=pcm_24000`, encoded voice), headers, body `{model_id, text}`; the saved `tts-voice-elevenlabs` is the voice sent; streams `application/octet-stream` PCM before EOF as `audio/pcm` with the PCM headers; no-mode request → 409 before fetch. `test.each` over the three recorded bad-voice bodies → 422 `voice-not-found` with the voice, **exactly one** upstream fetch (no fallback request). ElevenLabs 429 keeps `retry-after`. Extend the no-secret-echo case to ElevenLabs. |
| `src/components/feed/ttsSession.dom.test.ts` (holds the `requestPcm`/`PcmSession` tests) | `requestPcm` accepts ElevenLabs geometry without a language. The ElevenLabs word estimate advances with played time. |
| `src/lib/ttsChunks.test.ts` | `elevenlabs` gets the sentence chunks. |
| `src/components/feed/SpeakButton.dom.test.tsx` | The Voice group appears under the selected provider only. A list pick POSTs `{backend, voice}` and every control follows. Enter on a typed id POSTs it. Loading, failed with Retry, unconfigured (no `/api/tts/voices` request made), env-locked disabled, and OpenAI type-only states. `selected.known === false` shows the warning before any click. A 422 `voice-not-found` from `/api/tts` shows the en and uk alert with "Right-click" on desktop and "Press and hold" on a phone, and a single `/api/tts` request. The ElevenLabs read sends `mode: "pcm"`. The input is not focused on open. |

### 8.2 Rendered evidence: a case in the existing driver

Add **`captureReadAloudVoiceMenu(browser, mobile)`** to `src/components/kanban/issue1695BrowserHarness.ts`, beside `captureFishAudioMenu` and on the same `serveEvidenceFixture` / `openFixture` scaffolding. Call it from one new `browserTest` in each existing driver:

- `src/components/kanban/kanbanBoard.browser.test.tsx`, desktop, gated by `LLV_KANBAN_BROWSER_TEST=1` plus `CHROME_BIN`;
- `src/components/mobile/issue1671Evidence.browser.test.tsx`, phone, gated by `LLV_SWIPE_BROWSER_TEST=1`.

No new script file.

The matrix is en/uk × light/dark × 1440/1000 (desktop) and 320/390 (phone). Routes are stubbed with `page.route` using the §2 shapes. `/api/tts/voices` is held open for the loading frame. `/api/tts` answers 422 `voice-not-found` for the alert frame.

States: `loaded`, `filtered`, `typed-unlisted`, `loading`, `failed`, `unconfigured`, `locked`, `fish-jarvis` (resolved name), `selected-unknown`, and `alert-voice-not-found`.

Assertions per frame:

- the menu is inside the viewport with no sideways scroll and an opaque background;
- each voice row's box is fully below the previous one and inside the menu;
- on a phone, input and rows are ≥ 44 px high and the input's computed `font-size` is 16 px;
- at most 6 voice rows, and the `+N` line text matches the stub count;
- after a pick: one POST with `{backend, voice}`; after Enter: one POST with the typed id;
- no request to `/api/tts/voices` in `unconfigured`;
- the alert has `word-break` other than `break-all` and contains the voice id;
- `pageErrors` is empty.

Readings go to `evidence/read-aloud-voice/{desktop,phone}.json`. Frames go to `$HOME/Pictures/delegatus-review/read-aloud-voice/` and are never committed. Before the PR, a person opens every frame.

## 9. Rollout for this installation

Once the change is deployed, the seat (not the build stage, which may not touch live configuration) sets requirement 6's defaults. Either:

- through the menu, or
- with three one-line files in the app config dir:

| File | Content |
| - | - |
| `tts-voice-fishaudio` | `0c7fd46820854a9e8c4010d911687b7a` (Jarvis, so switching to Fish keeps the voice the operator uses) |
| `tts-voice-elevenlabs` | `03PJALT6TZ4IVrK14MXx` («Delegatus») |
| `tts-backend` | `elevenlabs` |

They are read per request, so no restart is needed. Then one header read checks it. That is the first and only paid synthesis this lane causes, and it settles the two unobserved points in §2. If ElevenLabs refuses the generated voice under `eleven_v4_turbo`, the alert shows ElevenLabs' sentence, and the operator chooses between another voice and `tts-model-elevenlabs` = `eleven_v4`.

## 10. Must not be touched

- **Speech-to-text.** `src/lib/transcribeBackend.ts` (only its two key readers are *called*), `src/app/api/transcribe/**`, `src/lib/transcribe/**`, `MicButton.tsx`, `useDictation.ts`, `transcribe-backend`. They share the key files; changing a reader changes dictation.
- **The voice companion and calls.** `src/lib/voiceCompanion/**`, `src/lib/audio/**` and their voice settings. Open PR #2880 is in that tree.
- **Fish's model choice and free-period guard.** `src/lib/fishAudio.ts` logic, `tts-model-fishaudio`, `fishaudio-free-*` codes.
- **Soniox's language setting** and its rolling admission.
- **OpenAI's mp3 path** and `TtsSession`'s `<audio>` playback.
- **The key files and their readers.** No new key location.
- **The default backend in code** (`openai`).
- **Any message-language detection** (PR #2888's `proseLanguage.ts` and `tts-route-*` files must not come back).
- **The operator's live configuration and state** during build and tests.
- **The committed `evidence/fish-audio/*.json` records** (regenerated only by their own case if its counting changes).

## 11. Deferred — not currently justified

- **Streaming alignment for ElevenLabs** (`/stream/with-timestamps` with `pcm_24000`, decoding JSON chunks server-side to keep word-exact karaoke). It is more machinery than the requirement asks for. Revisit if the operator misses exact highlighting.
- **Removing the client JSON-envelope and provider-alignment code** (`ttsSession.ts` JSON branch, provider alignment in `src/lib/ttsAlignment.ts`), which nothing produces after this lane. This is a separate cleanup with its own tests.
- **Fish public-library search** (`/model?title=…&language=…`) and recently used voice ids. The operator's Fish voices are public ids they already know; the typed field covers them and the lookup names them.
- **Voice previews** (ElevenLabs `preview_url`, Soniox console samples).
- **Turning the menu into `role="dialog"`** with radio groups, so the input sits in an ARIA-valid container.
- **Save-time validation** of a typed id. The `selected.known` lookup on the next menu open and the 422 at read time already make a bad id visible.
- **ElevenLabs voice settings** (stability/similarity) and a model picker for ElevenLabs. `tts-model-elevenlabs` still works by hand.

## 12. Check against the requirement

| Requirement | Where |
| - | - |
| «Будет один выбор: либо Eleven Labs, либо одно, либо другое, либо третье» | One selected provider (§1, unchanged mechanism); no language routing (§10). |
| ElevenLabs `eleven_v4_turbo`, key as the others, same playback | §3.1, §3.2; the key path already works (§1). |
| «Выбрать или прописать голос», persisted per provider, sent on synthesis | §3.2–§5. |
| Bad voice: visible, readable, no fallback | §6. |
| Unconfigured provider shown with what to configure | §4 states. |
| Existing control, smallest UI, 390 px and desktop, light and dark, uk and en | §4, §8.2. |
| Defaults ElevenLabs + «Delegatus»; Fish Jarvis | §9. |
