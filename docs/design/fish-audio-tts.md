Source: operator request, 2026-10-14 ~07:40 UTC, spoken in Russian and relayed into this task by the orchestrator. The originating requirement is reproduced verbatim:

> Добавь ещё как альтернативный вариант вместо Soniox использование text-to-speech, Fish Audio. У них есть Free моделька Free, прошка, можно её использовать, она до какого-то там ноября доступна. А, э-э, но можно было выбрать и другую, которая не Free. Она примерно по той же цене, что и Soniox. Это для озвучки сообщений сделай.

# Fish Audio as a read-aloud provider

Design and observations dated 2026-10-14. Source inspected at `f70bf716b`. During this stage main advanced to `5376895d0` (#2839, relay), which touches none of the files cited here, so every line anchor holds. This stage changes no product code.

Build it: the operator asked for it. Add `fishaudio` as a fourth `TtsBackend`. Synthesize through Fish Audio's native `POST /v1/tts` with `format: "pcm"` at 24 kHz and play it through the existing Soniox fast path (`PcmSession`). Offer two models: `s2.1-pro-free` (the default, free through 2026-11-30) and `s2.1-pro` (paid, $15 per million UTF-8 bytes). Once 30 November 2026 has passed, the route refuses the free model on its own, because Fish Audio documents that an unrecognized model id is served and billed as `s2.1-pro`. No ADR: an adapter and a menu row are easy to reverse.

## 1. Observed facts (fetched 2026-10-14, 07:41 UTC)

Quotes are copied from raw page content: Mintlify `.md` exports, the published OpenAPI schema, or HTML with the tags stripped. None of them comes from memory.

- **[S1]** https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech.md. The same `/v1/tts` schema is published at https://api.fish.audio/openapi.json.
- **[S2]** https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits.md
- **[S3]** https://docs.fish.audio/developer-guide/models-pricing/models-overview.md
- **[S4]** https://docs.fish.audio/developer-guide/getting-started/changelog.md
- **[S5]** https://fish.audio/blog/s2-1-pro-free-api/
- **[S6]** https://docs.fish.audio/developer-guide/core-features/text-to-speech.md
- **[S7]** https://docs.fish.audio/api-reference/errors
- **[S8]** https://docs.fish.audio/api-reference/openapi.json (paths `/v1/tts/stream/with-timestamp`, `/v1/tts/live/with-timestamp`, `/model`)
- **[S9]** https://docs.fish.audio/developer-guide/getting-started/quickstart
- **[S10]** https://docs.fish.audio/agents/build/voice-language
- **[S11]** https://soniox.com/pricing

| Question | Observation | Exact quote |
| - | - | - |
| HTTP endpoint | `POST https://api.fish.audio/v1/tts` | S1: `url: https://api.fish.audio` … `/v1/tts:` `post:` |
| Streaming endpoints | SSE `POST /v1/tts/stream/with-timestamp`; WebSocket `wss://api.fish.audio/v1/tts/live` and `…/live/with-timestamp` | S8: "Connect to `wss://api.fish.audio/v1/tts/live/with-timestamp`" |
| Auth | Bearer token | S1: `BearerAuth: type: http scheme: bearer`. S6: `--header "Authorization: Bearer $FISH_API_KEY"` |
| Model selection | The `model` HTTP header. The body has no model field. | S1: "Specify which TTS model to use. Use `s2.1-pro-free` for the free developer tier. If omitted or set to an unrecognized value, the request falls back to `s2.1-pro`." Enum: `s1`, `s2-pro`, `s2.1-pro`, `s2.1-pro-free`, `drama-3` |
| Request body | JSON or msgpack. `text` is required. There is no language field. | S1 `TTSRequest`: `format` enum `wav, pcm, mp3, opus`, default `mp3`. `sample_rate`: "When null, uses the format's default (44100 Hz for most formats, 48000 Hz for opus)". `latency`: "normal: best quality, balanced: reduced latency, low: lowest latency." `reference_id`: `default: null`. `prosody.speed`: "Valid range: 0.5 to 2.0". `normalize`: "Normalizes text for English and Chinese". `required: - text` |
| Free model | `s2.1-pro-free` exists: the same model as `s2.1-pro` at $0, under fair use | S3: "The same model as S2.1-Pro, available at \$0 for development and testing" and "Free to use under fair-use limits", "No TTFA or DPA guarantees" |
| Free model end date | **30 November 2026.** The date has been extended three times. The cutoff's timezone is not stated. | S4, entry of June 23, 2026: "`s2.1-pro-free` is the same model at no cost through November 30, 2026 for testing, prototyping, development, and smaller businesses, under fair-use limits and without those guarantees." S5 shows struck through (`<del>`) "Free access is available till July 24, 2026 Free access is available through the end of July 2026 Free access is available through August 31, 2026", then "Free access is available through November 30, 2026 — we'll communicate any changes with advance notice." |
| Fish prices | S2 TTS table | "`s2.1-pro` \| \$15.00 / M UTF-8 bytes"; "`s2.1-pro-free` \| \$0.00 / M UTF-8 bytes"; "`s2-pro` \| \$15.00 / M UTF-8 bytes"; "`s1` (deprecated, retiring December 31, 2026) \| \$15.00 / M UTF-8 bytes"; "1M UTF-8 bytes is approximately 180,000 English words, or about 12 hours of speech". `drama-3` has no row. |
| Soniox TTS price | S11 | "Text-to-Speech API pricing" … "$0.70/hour" "of generated speech." "Input text tokens" "$4.00 per 1M tokens" "Output audio tokens" "$21.50 per 1M tokens" "1 character ≈ 0.3 input text tokens • 15,000 input text tokens ≈ 1 hour of generated speech • 1 hour of generated speech ≈ 30,000 output audio tokens" |
| Output formats | mp3, wav, pcm, opus. PCM is offered at 24 kHz. The 200 response is chunked. | S1: "WAV / PCM — Sample Rate: 8kHz, 16kHz, 24kHz, 32kHz, 44.1kHz — Default Sample Rate: 44.1kHz — 16-bit, mono". 200 header: "Transfer-Encoding … chunked". S6: "`pcm` \| raw samples, no container; for low-latency playback and telephony pipelines" |
| Timestamps | `/v1/tts` returns audio only. The SSE and WebSocket endpoints return word segments `{start, end, text}`. | S8: "Each `message` event contains a JSON payload with one base64 audio chunk. … `alignment` is the latest cumulative timestamp snapshot for `chunk_seq` … `chunk_audio_offset_sec` can be added to segment times to derive absolute timestamps in the full audio." |
| Languages | Detected automatically; there is no parameter. 83 languages, which the TTS pages do not list. Ukrainian and Russian are in the Agents product's language list, which uses the same voice library. | S3: "S2.1-Pro supports 83 languages … Both use automatic language detection"; "Language detection is automatic - simply provide text in your target language." S10: "\| `ru` \| Russian \|", "\| `uk` \| Ukrainian \|" |
| Rate limits | Concurrency depends on the prepaid tier. A 429 arrives without `Retry-After`. | S2: "\| Starter \| \< \$100 paid \| 5 requests \|"; "returns 429 without a `Retry-After` header. Retry with exponential backoff." |
| Request size | No text cap is documented for native `/v1/tts`. The edge may send a non-JSON 413. | S7: "Errors returned by the network edge in front of the API, such as some `413` or `5xx` responses, may not be JSON." S5: "no hard character cap (subject to Fair Use Policy)" |
| Errors | JSON `{message, status}` | S7: "`400` \| Bad request: invalid parameters, or a `reference_id` / voice that doesn't exist"; "`401` \| Invalid or missing API key"; "`402` \| Insufficient credits"; "`403` \| Not permitted for this key/resource"; "`404` \| Model or voice not found"; "`429` \| Too many requests" |
| Voice | Leaving out `reference_id` uses the default voice. `GET /model` filters the library by `language` and `licensed`. | S9: "The examples above use the default voice. To use a different voice, add the `reference_id` parameter with a model ID from fish.audio." Anonymous queries on 2026-10-14: `language=uk&licensed=true` returned `total=0`; `language=ru&licensed=true` returned 5. The top unlicensed `language=uk` results are community clones of public figures. |
| Free-tier data use | Fish may use requests for training | S5: "Data retention: Requests may be used to improve model quality"; "Products generating more than $1M ARR should contact us before using S2.1 Pro Free." |

**Price comparison per character of input text** (the unit the route sends):

- **Soniox:** S11's ratios turn 1M characters into 0.3M input tokens ($1.20) plus 20 hours of speech, which is 0.6M audio tokens ($12.90). That is **≈ $14.10 per 1M characters**, or about $0.70 per hour.
- **Fish `s2.1-pro`:** $15.00 per 1M bytes. English is one byte per character, so ≈ $15.00 per 1M characters, about 6% above Soniox. A Cyrillic letter is two UTF-8 bytes. Russian and Ukrainian prose measured 1.65–1.85 bytes per character, which comes to ≈ $25–28 per 1M characters, roughly 1.8–2× Soniox. Fish's own hourly ratio gives ≈ $1.25 per hour for English.
- **Which paid model:** every Fish TTS model with a published price costs the same $15.00. `s2.1-pro` is the paid twin of the free model, so it is the paid choice. "Примерно по той же цене" holds for English text. For Ukrainian and Russian, the paid model costs about twice what Soniox does.

**Unobserved.** These need an API key; the build stage records them if one appears:

- The Content-Type of a `format:"pcm"` response.
- The PCM byte order (the docs say only "16-bit, mono").
- Whether `/v1/tts` sends audio before generation ends. The response is chunked, and the "~300ms" figure for `balanced` is stated for WebSocket streaming.
- What Fish answers for `s2.1-pro-free` after the free period: a refusal, a 402, or silent billing as `s2.1-pro`. S1's fallback sentence makes the last one possible.
- The timezone of "November 30, 2026".
- Whether the default voice suits Ukrainian and Russian, and how a mixed uk/en sentence sounds.
- Any response header that names the model the request was billed under.
- Any per-request text limit on native `/v1/tts`.
- The `drama-3` price.

**Discrepancy.** S6 says "`latency="balanced"` (default)" and `chunk_length` "default `200`". The S1 schema says `latency` defaults to `normal` and `chunk_length` to 300. The adapter sets `latency` explicitly and leaves `chunk_length` to the server.

## 2. Current path

- `src/lib/ttsBackend.ts:7-8` closes the list at `openai | elevenlabs | soniox`.
  - `:40-51` selects the backend: `LLV_TTS_BACKEND`, then the `tts-backend` file, then `openai`.
  - `:57-90` builds one option per provider: key availability, `keyPath`, model and voice from `LLV_TTS_<P>_MODEL|VOICE` or the `tts-model-<p>` / `tts-voice-<p>` files, and `cap` 4000.
  - The Soniox key reader is `src/lib/transcribeBackend.ts:128-137`. The environment wins over the file, and the key is read on every request.
- `src/app/api/tts/backend/route.ts:14-26`: POST `{backend}` writes the file and answers 409 under the env lock.
- `src/app/api/tts/route.ts` is the synthesis route.
  - `:202-206` picks the key per backend and answers 503 with `keyPath` when it is missing.
  - `:217-220` gates `mode:"soniox-pcm"`.
  - `:227` applies `redactSecrets`.
  - `:228-237` runs the Soniox byte and rate checks.
  - `:233` admits three syntheses at once.
  - `:90-126` (`synthesisRequest`) builds the upstream request.
  - `:257-264` maps upstream status: Soniox passes 400/401/402/403/429 through, the others answer 502, and `retry-after` is sanitized.
  - `:291-295` requires `audio/pcm` on the fast path.
  - `:139-148` (`billedBy`) names the billed identity.
  - The key only ever travels in the upstream auth header.
- Client:
  - `src/components/feed/SpeakButton.tsx:190`: `fast = option.id === "soniox"` chooses `PcmSession`. `:380-386` creates its 24 kHz `AudioContext` inside the click.
  - `:144` applies the Soniox chunk policy. `:291` highlights the whole chunk on the PCM path.
  - `:295-303` shows the route's `error` string or a generic line.
  - `:364-371` refuses before any request: message too long, or no key.
- `src/components/feed/ttsPcmSession.ts`:
  - `:53-75` (`requestPcm`) posts `mode:"soniox-pcm"` and retries a 429 up to three times.
  - `:69` refuses any billed identity that is not Soniox with a language, `pcm_s16le`, 24 kHz, one channel and `audio/pcm`.
  - `:28-40` decodes little-endian s16. Requests are paced one per second with two in flight. `:117-126`: stop aborts every fetch and closes the context.
- `src/lib/ttsChunks.ts:104-105` sends Soniox to its sentence policy (`:151-207`): the first chunk is at most 160 codepoints, later chunks at most 360 codepoints or three sentences.
- `src/components/feed/SpeakMenu.tsx`:
  - `:15-31` mirrors the backend types.
  - `:301-308` are the honesty lines: next click "paid synthesis", "Billed to your {provider} account per character", and `tts.batchSeekHint`, which names Soniox.
  - `:321-359` render one `menuitemradio` per provider, disabled under the env lock.
- `src/lib/ttsAlignment.ts` provides the proportional fallback. It needs no change.
- i18n strings are at `src/lib/i18n/en.ts:2118-2152` and `uk.ts:2064-2098`. `src/lib/i18n/i18n.test.ts:12-14` enforces key parity.
- **Environment filter.** `src/instrumentation.ts:10` and `src/lib/mcp/entry.ts:11` call `discardUnsupportedApiCredentials()`. It deletes every `*_API_KEY` missing from `FORWARDED_API_KEYS` (`src/lib/environmentIsolation.ts:4-10`; the launcher's copy is `bin/server-runtime.mjs:9-12`). `FISH_AUDIO_API_KEY` is in neither set, so as things stand the Viewer would drop it at startup and only the key file would work.
- Onboarding (`src/components/onboarding/VoiceStep.tsx:17-35`) lists dictation providers only, so it has no TTS list to extend.
- User docs: `docs/transcription.md:237-267` lists the read-aloud providers. That file is outside the #2836 fence, which covers `README.md` and `docs/guide/**`.

## 3. Design

### Transport: native `/v1/tts`, PCM at 24 kHz

| Option | Gains | Costs | Verdict |
| - | - | - | - |
| A. `POST /v1/tts` with `format:"pcm"` and `sample_rate:24000`, through the existing PCM route branch and `PcmSession` | The same fast path as Soniox: a first-sentence chunk, playback before EOF, one sample clock, and stop closes the context. It needs one new request builder. | The PCM Content-Type and byte order stay unobserved until a key exists. Highlighting is per chunk, as it is for Soniox. | Chosen |
| B. SSE `/v1/tts/stream/with-timestamp` | Word timestamps | The server has to parse SSE and re-emit PCM, and the client needs a second channel for alignment. The PCM path has no word highlighting to feed. | Deferred |
| C. WebSocket `/v1/tts/live` | Text streaming | msgpack framing and a server-side socket lifecycle, while the text is already complete before the request | Deferred |
| D. Fish's OpenAI-compatible `/compat` API through the OpenAI branch | Reuses an existing builder | mp3 that plays only after each chunk completes (the 17-second delay measured in `docs/design/fast-tts.md`), `fish-audio/` model ids, different voice semantics | Rejected |

**Contingency.** If the live check finds PCM unusable (a container, big-endian samples, or no audio before EOF), set `fast` to false for `fishaudio` and send `format:"mp3"`. The mp3 `TtsSession` path then works unchanged, with proportional word karaoke.

### Request

- `POST https://api.fish.audio/v1/tts`.
- Headers: the key as a Bearer token in the `Authorization` header (the existing Soniox shape at `src/app/api/tts/route.ts:108`), `content-type: application/json`, and `model: s2.1-pro-free` or `model: s2.1-pro`.
- Body: `{"text": "<redacted chunk>", "format": "pcm", "sample_rate": 24000, "latency": "balanced"}`.
- Add `"reference_id": "<voice>"` only when a voice is configured; the voice `default` leaves it out.
- Send no language; the provider has no such field.
- Leave `normalize`, `chunk_length` and `prosody` at the server defaults.

### Models and the free-period guard

- The model list is closed: `FISH_AUDIO_MODELS = ["s2.1-pro-free", "s2.1-pro"]`, default `s2.1-pro-free`. A constant `FISH_AUDIO_FREE_UNTIL = "2026-11-30"` marks the end; the free model counts as ended from `2026-12-01T00:00:00Z`. The timezone is unobserved, so UTC is chosen.
- A model value from the environment or a file that is not in the list is ignored, and the free default applies. This mirrors how an invalid `LLV_TTS_BACKEND` is ignored. Passing such a value through would get it served and billed as `s2.1-pro` (S1).
- After the end instant, the route refuses the free model **before** any fetch. It never rewrites the model to another one.
- The menu label reads the same constant, and after the date it says the free period ended.

### Settings

| Setting | Env | File in the config directory | Default |
| - | - | - | - |
| key | `FISH_AUDIO_API_KEY` (added to the forwarded set) | `fishaudio-api-key` | none |
| model | `LLV_TTS_FISHAUDIO_MODEL` (locks the model choice) | `tts-model-fishaudio` | `s2.1-pro-free` |
| voice (`reference_id`) | `LLV_TTS_FISHAUDIO_VOICE` | `tts-voice-fishaudio` | `default`, sent as no `reference_id` |
| provider | `LLV_TTS_BACKEND=fishaudio` | `tts-backend` containing `fishaudio` | existing default `openai` |

### Menu

The `fishaudio` row looks like the other providers: its id, then `s2.1-pro-free · default`, and the warning dot with "not set up" when there is no key. Directly under it sits an indented `role="group"` ("Fish Audio model") holding two `menuitemradio` rows. Both are always rendered:

- `S2.1 Pro Free — free until 30 Nov 2026`, with the date formatted by `Intl.DateTimeFormat` in the UI locale. After the date it reads `S2.1 Pro Free — free period ended 30 Nov 2026` in the danger colour.
- `S2.1 Pro — paid`.

Clicking one of these rows posts `{backend:"fishaudio", model}` as a single request, so the paid model is one click away whichever provider is active. A row is checked when the backend is fishaudio and its model matches. Both rows are disabled while a save is in flight, under `LLV_TTS_FISHAUDIO_MODEL`, and when `LLV_TTS_BACKEND` locks another provider. On a phone they keep `min-h-11`.

The honesty lines change with the selected model:

- **Free model:** the next-click line says the synthesis is free, and the tooltip says "Read aloud (free model)". The billing line says there is no charge until the date and that Fish Audio may use the text to improve its models (S5).
- **`s2.1-pro`:** the billing line says the charge is per UTF-8 byte and a Cyrillic letter counts twice.
- **Both:** `tts.batchSeekHint` gains a `{provider}` parameter; its text names Soniox today.

### Errors

The route echoes no upstream body or header. Its English `error` is kept for logs and tests. The client turns `code` into an i18n line, because the operator reads the UI in Ukrainian.

| Situation | Route answer | UI |
| - | - | - |
| No key | 503 `{error, keyPath}` (existing) | existing `tts.missingKey`, naming `…/fishaudio-api-key` |
| Free model after 2026-11-30 | 410 `{error, code:"fishaudio-free-ended"}`, with no upstream call | `tts.fishFreeEnded`: "Fish Audio's free model ended on {date}. Right-click and choose S2.1 Pro (paid) to keep reading aloud." The client refuses before requesting when `option.freeEnded`. |
| Free model, upstream 402/403/404 | the same status with `code:"fishaudio-free-refused"` | `tts.fishFreeRefused`: "Fish Audio refused its free model (HTTP {status}); the free period may be over. Right-click and choose S2.1 Pro (paid)." |
| Any other 400, 401, 402, 403 or 404 | the upstream status, no code | existing `TTS request failed` text |
| 429 | 429 with `retry-after: 1`, since Fish sends none | `requestPcm` retries up to three times (existing) |
| 5xx or network failure | 502 (existing) | existing |

A 400 on the free model stays generic. S7 attributes a 400 to an unknown `reference_id`, and S1 says an unknown model falls back to `s2.1-pro`.

## 4. File-by-file plan

1. **`src/lib/ttsBackend.ts`**
   - `:7-8`: add `"fishaudio"`.
   - `:10-20`: add optional `models`, `freeModel`, `freeUntil`, `freeEnded` and `modelLockedByEnv` to `TtsBackendOption`.
   - Next to `:53-55`, add:
     - `FISH_AUDIO_MODELS`, `FISH_AUDIO_FREE_MODEL`, `FISH_AUDIO_FREE_UNTIL`.
     - `fishFreeEnded(now = Date.now())`.
     - `readFishAudioApiKey()`: `FISH_AUDIO_API_KEY`, then the `fishaudio-api-key` file, read on every request.
     - `writeTtsModel("fishaudio", model)`, written the way `writeTtsBackend` (`:47-51`) writes.
   - `:57-90`: `ttsBackendInfo(now = Date.now())` appends the fishaudio option after soniox. Its fields: `available`; `keyPath: configFilePath("fishaudio-api-key")`; `model` (a valid env value, else a valid file value, else free); `voice` (env, else file, else `default`); `cap: 4000`; and the new fields.
2. **`src/app/api/tts/backend/route.ts:17-26`**
   - Accept an optional `model`. It is valid only with `backend:"fishaudio"` and only from the list; otherwise answer 400.
   - Answer 409 when `LLV_TTS_FISHAUDIO_MODEL` is set; the backend-lock check stays as it is.
   - Write the model, then the backend, then return `ttsBackendInfo()`.
3. **`src/app/api/tts/route.ts`**
   - `:12-13`: add `FISH_AUDIO_SPEECH_URL = "https://api.fish.audio/v1/tts"`.
   - `:90-126`: add a `fishaudio` branch as described in §3 Request, with `timestamped: false`.
   - `:202-203`: add `readFishAudioApiKey()`. A `Record<TtsBackend, () => string | null>` would replace the ternary chain cleanly.
   - `:217-220`:
     - Accept `mode:"pcm"` for `soniox` and `fishaudio`.
     - Keep `"soniox-pcm"` as an alias that is valid only for soniox, because tabs loaded before the deploy still send it.
     - For `fishaudio` without PCM mode, answer 409 `speech backend changed; refresh configuration`. That is a stale tab, and `SpeakButton.tsx:296` already refreshes on 409.
   - After `:227`, add the free-period guard: a 410 with its code, before `admitSynthesis` and before any fetch.
   - `:257-264`, for fishaudio:
     - Pass 400, 401, 402, 403, 404 and 429 through; anything else becomes 502.
     - Add `code:"fishaudio-free-refused"` when the free model got 402, 403 or 404.
   - `:291-295`, for the fishaudio fast path:
     - Accept an upstream `audio/*` or `application/octet-stream`, and refuse JSON or text.
     - Answer `content-type: audio/pcm`.
     - Soniox keeps its strict check.
   - `billedBy` (`:139-148`) stays as it is: the language is empty and the encoding is pcm.
4. **`src/components/feed/ttsSession.ts:149-154`**: `TtsRequestError` gains an optional `code`.
5. **`src/components/feed/ttsPcmSession.ts`**
   - `:55`: send `mode:"pcm"`.
   - `:63-66`: read `code` along with `error`.
   - `:69`: accept `voice.id` of `soniox` or `fishaudio`, require `language` only for soniox, and keep the geometry checks.
6. **`src/lib/ttsChunks.ts:104-105`**: send `fishaudio` to the same sentence policy. With no language, the `"en"` segmenter is used; the test confirms that it splits Cyrillic prose on punctuation.
7. **`src/components/feed/SpeakButton.tsx`**
   - `:144`: chunk policy for fishaudio. `:190`: `fast` for soniox or fishaudio.
   - `:295-303`: map `cause.code` to `tts.fishFreeEnded` or `tts.fishFreeRefused`.
   - `:364-371`: refuse locally when `option.freeEnded` and the free model is selected.
   - `:408-424`: `pickBackend(backend, model?)` posts the model.
   - `:434-440`: tooltip wording for the free model and for the ended period.
8. **`src/components/feed/SpeakMenu.tsx`**
   - `:15-31`: `BackendId` adds `fishaudio`, and `BackendOption` mirrors the new optional fields. Keep the mirror: the server type's module imports `node:fs`.
   - `:223` and `:274-282`: `onPick(backend, model?)`. Clicking the active backend is allowed when the model differs.
   - `:301-308`: the honesty lines from §3 Menu.
   - `:321-359`: render the model group after the fishaudio row.
9. **i18n**, `src/lib/i18n/en.ts` near `:2118-2152` and `uk.ts` near `:2064-2098`:
   - Add `tts.fishModelGroup`, `tts.fishModelFree`, `tts.fishModelFreeEnded`, `tts.fishModelPaid`, `tts.fishModelLocked`, `tts.nextFreeModel`, `tts.readFreeModel`, `tts.billingFree`, `tts.billingBytes`, `tts.fishFreeEnded` and `tts.fishFreeRefused`.
   - Give `tts.batchSeekHint` a `{provider}` parameter in both locales.
10. **`src/lib/environmentIsolation.ts:4-10` and `bin/server-runtime.mjs:9-12`**: add `FISH_AUDIO_API_KEY`. Under AGENTS.md, a change to `bin/**` makes pre-push run the runtime lanes locally.
11. **`docs/transcription.md:237-267`**: add `fishaudio` to the provider list, plus one paragraph covering the endpoint, both models, the end date, the key file, PCM, the lack of timestamps and the data-use note.

None of these paths falls in another lane's fence: pipelines and the flow controller, `spawnProjection.ts`, account liveness and status UI, voice/relay resolution, `README.md` and `docs/guide/**`, curator and seat tick, runtime loop tests.

## 5. Tests

Run each file by path through `bash scripts/gate-slot.sh bun test <file>`, with isolated HOME, XDG, TMPDIR and LLV_STATE_DIR. Fixtures use fake keys such as `fish-account-key`, set through the `setEnv` helper (`src/app/api/tts/route.test.ts:13-19`). Never use a real key.

| File | Cases |
| - | - |
| `src/lib/ttsBackend.test.ts`, following `:59-118` | fishaudio is listed. The env key beats the file. `keyPath` ends in `fishaudio-api-key`. The default model is free. A file model is honoured. An env model wins and sets `modelLockedByEnv`. Invalid env and file models are ignored. With an injected `now`, `freeEnded` is false at `2026-11-30T23:59:59Z` and true at `2026-12-01T00:00:00Z`. The voice defaults to `default`. The other three options are unchanged. |
| new `src/app/api/tts/backend/route.test.ts` | `{backend:"fishaudio", model:"s2.1-pro"}` persists both. An unknown model answers 400, and so does a model sent with another backend. `LLV_TTS_FISHAUDIO_MODEL` makes it answer 409; `LLV_TTS_BACKEND` does too. |
| `src/app/api/tts/route.test.ts`: a new describe after `:339`, with `FISH_AUDIO_API_KEY` added to the restore at `:6-27` | **Request:** the URL is `https://api.fish.audio/v1/tts` with `authorization: Bearer <fixture>`, and the `model` header equals the configured model for both models. The body is exactly `{text, format:"pcm", sample_rate:24000, latency:"balanced"}`, without `language`, and gains `reference_id` only when a voice is configured. **Streaming:** bytes arrive before EOF as `audio/pcm` with `x-tts-backend: fishaudio`. An upstream `application/octet-stream` is accepted; `application/json` gives 502. **Free model:** after the end date, with a fixed clock, the route answers 410 with its code and fetch is never called. Upstream 402 or 404 gives `fishaudio-free-refused`. **Status mapping:** a 402 on the paid model carries no code. A 401 passes through. A 429 without `retry-after` answers `retry-after: 1`. **Stale or missing input:** `soniox-pcm` with fishaudio answers 409, and so does a request with no mode. A missing key answers 503 with `keyPath`. **Every case:** the key fixture appears in no response body or header. |
| `src/components/feed/ttsSession.dom.test.ts`, at `:526-600` | `requestPcm` accepts a fishaudio identity with an empty language and still refuses wrong geometry. `code` reaches `TtsRequestError`. |
| `src/lib/ttsChunks.test.ts`, at `:97` | fishaudio uses the sentence policy on uk and ru text, with a first chunk of at most 160 codepoints. |
| `src/components/feed/SpeakButton.dom.test.tsx`, following `:733` | The right-click menu shows the fishaudio row and both model rows, labelled "free until" with the date and "paid". Clicking the paid row posts `{backend:"fishaudio", model:"s2.1-pro"}` and checks it. The model lock disables the rows. With the free model, the next-click line and the tooltip say free. Under a `freeEnded` configuration, the label shows the end, and a left click refuses with the ended message without a `/api/tts` request. The route code `fishaudio-free-refused` shows the refused message. One assertion runs in uk. |
| `src/lib/i18n/i18n.test.ts` | parity, existing |
| `src/lib/environmentIsolation.test.ts` and `bin/server-runtime.test.ts` | `FISH_AUDIO_API_KEY` survives `withoutUnsupportedApiCredentials`. Build the name with `join`, as `environmentIsolation.test.ts:29-30` does, so the publication gate never reads it as an assignment. |

Rendered evidence uses the existing drivers only. Add a Fish Audio menu case to the `describe("fast TTS header")` blocks in `src/components/mobile/issue1671Evidence.browser.test.tsx:6827` (phone) and `src/components/kanban/kanbanBoard.browser.test.tsx:17076` (desktop; the harness is `issue1695BrowserHarness.ts:399-430`). Cover the menu open with both model rows, the free and ended states, and both locales. Commit geometry JSON only.

## 6. Live verification

This stage did not exercise live speech: on 2026-10-14 the machine had no `FISH_AUDIO_API_KEY` and no `fishaudio-api-key` file. Unless a key appears, the build delivers on mocked-provider tests and says so.

If a key appears, the build stage runs one short Ukrainian sentence and one short English sentence per model through the real route, on an isolated port. It records:

- the HTTP status and the upstream Content-Type;
- the time to headers, to the first byte, to the first nonzero sample, and to EOF;
- whether the byte count is even, plus an audible check of the byte order;
- whether any response header names the billed model.

The evidence contains no key and no account identifier.

## 7. Requirement check

| Requirement | Where it is met |
| - | - |
| "альтернативный вариант вместо Soniox … Fish Audio"; AC1 | A fourth `TtsBackend` with its own row in the same menu, persisted through `tts-backend` and `LLV_TTS_BACKEND` |
| "Free моделька … до какого-то там ноября"; AC2 | `s2.1-pro-free` is the default, labelled "free until 30 Nov 2026" (observed in S4 and S5) |
| "можно было выбрать и другую, которая не Free … по той же цене, что и Soniox"; AC2 | The `s2.1-pro` row at $15 per million bytes. That is about Soniox's price for English and about twice it for Cyrillic (§1). Fish publishes no cheaper paid model. |
| AC3: never switches to paid on its own | The route guards the free model before any fetch, the model list is closed, the refusals carry codes, and no code path rewrites the model |
| AC4: key | The environment variable and the file, the existing missing-key hint with its path, environment forwarding, and never echoed |
| AC5: parity | `PcmSession` gives the first-sentence chunk and playback before EOF, and stop closes the context. Highlighting is per chunk, as with Soniox. No language is sent; the provider detects it. |
| AC6: tests | §5 |
| AC7: public repository | Fake fixtures only. This document carries no keys, account ids or voice ids. |
| AC8: checks | Test files run by path. Because `bin/server-runtime.mjs` changes, pre-push runs the runtime lanes locally, and `runtime-gate` runs on the PR. |

## 8. Deferred — not currently justified

- Word-exact karaoke through `/v1/tts/stream/with-timestamp` (option B).
- The `/v1/tts/live` WebSocket (option C).
- A voice picker or library browser. The voice setting in the environment or a file covers it, and whether the default voice suits uk and ru is unobserved.
- A `LLV_TTS_FISHAUDIO_FREE_UNTIL` override for another extension. The date has moved three times; updating the constant is a one-line change that ships with the next release, and until then the guard refuses, which costs nothing.
- `s2-pro`, `s1` (retiring) and `drama-3` (no price observed).
- A UTF-8 byte count in the menu.
- Fish Audio for dictation, and Fish key entry in onboarding (VoiceStep lists dictation providers only).
- Fish's npm SDK. Per S6, the current `fish-audio` 0.1.0 release defaults to the deprecated `s1`; raw `fetch` is enough.

## 9. Residual risk and notes

- If Fish extends the free period again, the guard still refuses from 1 December until a release updates the constant.
- Fish promises advance notice of changes. Between an early withdrawal and 30 November, an account with a balance may be billed for `s2.1-pro-free` as `s2.1-pro`. An account with no balance gets a 402, which maps to the refusal message. No documented header names the billed model.
- Fish may use free-tier requests for training. Read-aloud text already passes through `redactSecrets` (`src/app/api/tts/route.ts:227`, `src/lib/tts.ts:54`), and the menu says so.
- Fish's docs use `FISH_API_KEY`. The pinned specification fixes `FISH_AUDIO_API_KEY`, and that is the only name read.

Validation in this stage:

- Fetched the pages above.
- Queried the anonymous `GET https://api.fish.audio/model` voice listing.
- Read the source at `f70bf716b`.
- Ran no tests, because no product code changed.
- Made no paid provider calls.


## 10. Implementation verification (2026-10-14)

The adapter uses the native PCM request from §3. Model choices and both key
allowlists are implemented. `pcm` is the shared client mode; the earlier
`soniox-pcm` mode remains valid for Soniox. A Fish Audio request without the
shared mode is refused so a stale mp3 player refreshes its configuration.
The Fish Audio PCM path estimates word positions from the chunk duration;
Soniox retains its existing sentence highlighting. Both transport paths retain
structured refusal codes, including a stale tab using the earlier mp3 player.

Mocked-provider tests exercise both model headers, the exact request body,
automatic language handling for Ukrainian, Russian and English input,
configured reference voices, pre-EOF delivery, cancellation, the UTC expiry,
free-model refusals, rate-limit responses and credential non-disclosure.
Configuration and DOM tests cover persistence, environment locks, invalid
models, missing keys, free and paid billing copy and Ukrainian error text.
The production route and PCM session are exercised together with a synthetic
upstream for both Soniox and Fish Audio, including first audio before EOF,
bounded prefetch, contiguous scheduling, cached seeking and immediate stop.

The existing desktop and phone browser drivers render the free, paid and ended
menus in English and Ukrainian, in light and dark themes. Measurements cover
1440 px desktop and 390 px / 320 px phones, model selection, whole model buttons,
viewport containment and opaque backgrounds. The committed readings are
`evidence/fish-audio/desktop.json` and `evidence/fish-audio/phone.json`.

**Live synthesis was not exercised.** The implementation stage found neither
an environment key nor a key file. The official-source observations in §1 are
the external evidence; provider audio Content-Type, byte order, streaming
latency, default voice quality and actual free-period withdrawal behavior
remain unverified with Fish Audio. No paid provider call was made.
