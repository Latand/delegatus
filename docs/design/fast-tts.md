Source: operator request, 2026-09-30, personal conversation relayed into this task. The originating requirement is reproduced verbatim:

> Мне нужна какая-то супербыстрая озвучка текста, вот которая вот я вижу. Возможно, знаешь, даже делать какими-то там батчами по 3, по каждому предложению отдельному, чтобы быстрее оно начинало озвучиваться. Потому что сейчас озвучка очень неудобная. Вот, и иконка: хотелось, ну, чтобы озвучки, чтобы была вверху, чтобы я мог вверху нажать и. Оно бы сразу начало озвучивать. По дефолту это я хочу сейчас добавить только в Soniox, потому что я использую Soniox, и надо пересмотреть текущее решение, потому что мне кажется, оно неправильно, ну, неправильно или с ошибками. Вот, пусть этим всем занимается GPT-6.1 Sol, пусть он и переделывает, и ревью делает, и что там, анализ

# Fast speech from the conversation header

Design and observations dated 2026-09-30. Source inspected at `c49d27a33391f70b9d87b4c8f1a62a8b98058e8d`. This stage writes the design only. Defects below are implementation work; their listing satisfies this stage's audit contract. Implementation, candidate measurements, screenshots of the new control, CI, publication and deployment each need their own evidence.

Build this because the operator explicitly requests it. Use the existing Soniox HTTP endpoint with streamed PCM playback, one short first chunk, bounded prefetch and a native Web Audio clock. Add a header control that reads the assistant answer currently in view. Keep OpenAI and ElevenLabs on their existing audio and alignment path. No ADR is needed: the provider adapter and playback policy are reversible.

## Current path, end to end

1. `src/components/feed/parse.ts:276` represents assistant prose. `src/components/feed/speakableAnswer.ts:5-20` combines adjacent prose with the same engine and timestamp. `spokenAnswerText` in `src/lib/tts.ts:37-54` removes code, URLs, tables, hidden markup and memory citations, unwraps Markdown and redacts secrets.
2. `src/components/LogFeed.tsx:709` creates a resolver over the loaded feed. At `:1161-1162` only the first fragment of an answer receives its speech text. `src/components/feed/FeedItem.tsx:203-205` puts the phone control after the answer; `:237-244` puts the desktop control above its message body. Neither is the conversation header.
3. `src/components/feed/SpeakButton.tsx:28-59,119-134` fetches and shares backend configuration. `:113` chunks the sanitized answer. `src/lib/ttsChunks.ts:104-145` packs sentence/paragraph units into roughly 800-character chunks; an entire answer under 800 characters bypasses sentence splitting.
4. One tap at `SpeakButton.tsx:291-317` synchronously unlocks two audio elements, claims the page-wide playback latch, builds DOM karaoke ranges and starts a `TtsSession` after unlocking. A second tap stops. Another message's start calls `stopActive` at `:168`. Existing one-tap behavior already avoids a confirmation dialog.
5. `src/components/feed/ttsSession.ts:336-369` requests the cursor and following chunks, normally two concurrently. It keeps pumping on synthesis completion, even while the same audio chunk plays. `synthesizeChunk` at `:204-231` posts each text to `/api/tts`, retries local 429 responses, and consumes the complete response into a Blob or JSON envelope.
6. `src/app/api/tts/route.ts:178-219` enforces same-origin, resolves the configured backend/key at request time, validates text, redacts it again and admits at most three syntheses. Soniox uses `POST https://tts-rt.soniox.com/tts`, Bearer authentication, and `{model, voice, language, audio_format:"mp3", text}` at `:91-103`. The route has a 60-second timeout and a 32 MiB response ceiling. `:270-278` forwards the bounded stream; it does not wait for the full Soniox body.
7. Backend selection is read at `src/lib/ttsBackend.ts:40-44`; Soniox settings/key availability are at `:79-87`, with the key reader at `src/lib/transcribeBackend.ts:128-137`. `/api/tts/backend` GET returns settings; its POST persists a user selection unless environment-locked. This design does not change the selected provider automatically.
8. A completed Blob enters the page LRU at `ttsSession.ts:75-111`. Two HTML audio elements alternate at `:409-501`, with the next loaded onto the idle element. Playback advancement depends on `ended`.
9. `src/lib/ttsAlignment.ts:93-116` maps audio position to characters. Soniox has proportional interpolation; ElevenLabs supplies character timestamps. `ttsSession.ts:527-538` adds each chunk's source offset. `src/components/feed/ttsKaraoke.ts:123-201,227-279` maps spoken words onto rendered DOM ranges and paints a CSS highlight. `SpeakButton.tsx:199-206` turns a click in prose into a seek.
10. `src/lib/audio/speech.ts:19-26` derives the active speaker from realtime call transcripts. It is a different feature and is outside this read-aloud path.

Prior-work lookup used project-scoped and global transcript queries for Soniox, TTS latency, karaoke, byte limits and language cache identity. No relevant earlier fast-TTS solution was found. Reading the originating conversation confirmed the requirement and the planned analysis/build/review sequence. Existing design notes about phone message actions agree that the old button sits below prose; the current code was checked independently. No earlier latency claim is used here.

## Measured baseline

Configured selection read from the installation's configuration files: Soniox, `tts-rt-v2`, voice `Adrian`, language `en`. No model/voice/language override file was present. The configured key was loaded into memory and used for the calls below; its value was never printed or written into evidence.

Use this exact 329-character answer again for the candidate comparison:

```text
The first sentence should start speaking immediately. The next sentences should arrive while the first one plays. A single tap in the conversation header starts reading the answer. A second tap stops the voice immediately. Starting another answer cancels the previous read. Highlighting follows the sentence that is being spoken.
```

The baseline mounted the unchanged production `SpeakButton` and its imported session/chunker/karaoke code in Chromium at 390 × 844. An in-memory loopback server on an OS-assigned port dispatched `/api/tts` to the unchanged production `POST(new NextRequest(request))`, with the real Soniox key. Its backend GET returned the production configuration shape with key paths omitted from display. No product source or live state was changed. Each trial used a fresh page and cold page cache; configuration was loaded before the tap. This exercises the component, client fetch, route and provider; it excludes the deployed Next server's HTTP adapter, remote phone network and Safari.

Tap time came from the button's captured click event. Each actual HTML audio element was connected to a browser `AudioContext` analyser and destination. The first unmuted sample above amplitude 0.001 identified speech onset, sampled every 2 ms. This excludes the silent unlock clip. The numbers measure the browser rendering its first speech signal, a reproducible proxy for first audible audio. They do not measure sound reaching a physical phone speaker or the operator's ear. Headless output reported `baseLatency=42.67 ms` and `outputLatency=128 ms`; neither was silently added to or subtracted from the measured onset.

| Cold trial | Tap to speech signal | Tap to real `play()` call | Tap to `playing` event | Route to first upstream bytes | Route to body completion |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 17,379.3 ms | 17,259.1 ms | 17,269.4 ms | 428.4 ms | 17,162.4 ms |
| 2 | 17,822.2 ms | 17,728.9 ms | 17,735.2 ms | 377.2 ms | 17,707.7 ms |
| 3 | 18,081.6 ms | 17,911.8 ms | 17,917.8 ms | 377.2 ms | 17,886.6 ms |

Median tap-to-speech signal: **17,822.2 ms**. All six sentences fit one existing chunk. Body sizes were 329,900 / 344,876 / 349,100 bytes, delivered in 99 / 82 / 74 reads. First-byte arrival precedes playback by roughly seventeen seconds: full-body consumption dominates this example. Three samples characterize this observation; they do not establish a population p95.

A separate direct provider probe used only the first 51-character sentence. Existing MP3 shape returned HTTP 200, `audio/mpeg`, HTTP chunked transfer, first bytes at 393.8 ms, EOF at 2,435.1 ms, 51,500 bytes across 20 reads. Shortening the request alone still leaves a multi-second Blob wait.

The same sentence with `audio_format:"pcm_s16le", sample_rate:24000` returned HTTP 200, `audio/pcm`, headers at 346.9 ms, first bytes at 349.6 ms, the first packet containing nonzero signed PCM samples at 350.1 ms, and EOF at 2,265.9 ms. It delivered 143,360 bytes in 34 reads, equivalent to 2.9867 seconds of mono 16-bit audio at 24 kHz. This verifies that streaming can expose speech well before EOF. It is a provider probe; candidate tap-to-audio results remain to be measured.

A follow-up WAV request with the same voice/model/language and explicit 24 kHz rate confirmed a RIFF `fmt ` chunk with PCM format 1, one channel, 24,000 Hz and 16 bits/sample. Its HTTP content type was `application/octet-stream`, despite the guide's `audio/wav` example. The fast path uses the separately observed `audio/pcm` response and checks its negotiated geometry; it does not infer encoding from arbitrary MIME types.

Candidate results remain to be produced by implementation. Aim for median cold tap-to-rendered-speech ≤1 second and p95 ≤2 seconds under the recorded local setup; these are product targets, not provider guarantees. Compare at least ten cold trials for base and candidate with the exact answer/settings/key, interleaved where practical, plus cached replay. Record raw timings, failures, browser version, viewport, network route, output latency, chunk text/ranges, response format and cache state. Re-measure the base if the host/network changes. The phone acceptance run must separately record Safari/device/network and tap to physical audio or explicitly obtain acceptance for the browser proxy. Never label TTFB, `play()` or `playing` alone as audible onset.

## Soniox facts observed on 2026-09-30

| Fact | Evidence and consequence |
| --- | --- |
| HTTP supports incremental audio output for a complete text request | [REST guide](https://soniox.com/docs/tts/rest-api/generate-speech) and the multiple reads/early PCM samples above. Keep this existing transport. HTTP streaming does not accept incremental text within a request. |
| Required shape is model, language, voice, audio format and text; Bearer key authenticates | [Generate speech reference](https://soniox.com/docs/api-reference/tts/generate_tts), plus successful real MP3 and PCM requests. PCM additionally used the explicit 24 kHz sample rate; the [audio formats guide](https://soniox.com/docs/tts/concepts/audio-formats) lists support for it. The WAV geometry probe independently confirmed the current output's mono 16-bit/24 kHz geometry. |
| Current input enforcement counts bytes | Real requests of 5,001 ASCII bytes and 2,501 Cyrillic characters / 5,002 UTF-8 bytes both returned HTTP 400, `invalid_request`, with `input text too long (limit: 5000 bytes)`. The reference describes a 5,000 text-length limit. Apply the stricter observed UTF-8 byte bound; a character count alone is insufficient. |
| REST has a fixed two-minute generated-audio cap | [REST limits](https://soniox.com/docs/tts/rest-api/limits-and-quotas) documents truncation when reached. It also documents defaults of 100 requests/minute and three concurrent requests. These are documented defaults; account-specific overrides were not queried and limits were not deliberately saturated. |
| Post-stream errors lack a normal error response | The REST guide says errors can be returned as structured JSON before audio starts, while later errors cannot be delivered that way. EOF alone cannot prove every requested word was spoken. Keep chunks short and test speech coverage with actual audio. |
| WebSocket streaming and character alignment exist | [Realtime guide](https://soniox.com/docs/tts/rt/real-time-generation) and [timestamps guide](https://soniox.com/docs/tts/rt/timestamps). Its alignment follows normalized Unicode codepoints, can be absent on audio frames, and is unavailable over REST. Verified by reading current primary documentation; no WebSocket call was required for the chosen HTTP design. |

The implemented local ceiling of 4,000 characters and the three-slot route gate are Delegatus policy. Effective provider byte, duration and account limits need the separate evidence above. No undocumented speed parameter, silence reduction behavior, shared quota scope across transports, or exact word timing is assumed.

## Defects and required remedies

Each item gives a reproducible symptom, the intended fix and its acceptance. All remain listed here because this stage prohibits product edits.

| Severity | Location | Defect, reproduction and acceptance |
| --- | --- | --- |
| P1 | `src/lib/ttsChunks.ts:107-109`; `src/components/feed/ttsSession.ts:230` | An answer under 800 characters becomes a single request, and playback waits for EOF. The baseline above takes 17.38–18.08 seconds despite bytes arriving below 0.43 seconds. Fix with a short first sentence chunk and streamed PCM consumption. A delayed-EOF test must hear nonzero first-chunk audio while the response remains open. |
| P2 | `src/components/feed/FeedItem.tsx:203-205,237-244`; `src/components/mobile/MobileFocusView.tsx:700-712`; `src/components/BranchPane.tsx:332-345` | The button belongs to each message; the phone places it below prose. The supplied phone screenshot has reports and menu controls at the top and no read-aloud control there. Add the shared header control described below. Browser evidence must show one visible speaker/stop control in each required header at both viewports and themes. |
| P2 | `src/components/feed/ttsSession.ts:336-369` | Startup requests chunk 1 while chunk 0 is pending, then refills on every completion and can synthesize the entire answer long before it is heard. The existing test at `ttsSession.dom.test.ts:147-175` explicitly expects two requests before playback. Prioritize only chunk 0 until audio starts, then maintain bounded lookahead. A stubbed production-route test must see no second provider request before the first audible buffer is scheduled and must stop requests beyond the lookahead. |
| P2 | `src/components/feed/ttsSession.ts:437-439,487-500` | Alternating elements advance from a main-thread `ended` callback and a later `play()` call. There is no common sample clock that can guarantee a gapless join. Existing fake audio tests prove ordering, without measuring a rendered transition. Schedule Soniox PCM buffers contiguously on one audio clock. With prefetched buffers ready, sample evidence must show zero added silence and zero overlap at joins, even when the UI thread is briefly busy. |
| P2 | `src/components/feed/ttsSession.ts:75-76,184-195`; `src/app/api/tts/route.ts:124-129`; `src/components/feed/SpeakMenu.tsx:17-24` | Cache and billed identity omit Soniox language. `voiceKey({id:"soniox",model:"tts-rt-v2",voice:"Adrian",language:"en"}, text)` equals the corresponding `uk` key in a runtime probe. A language change can replay old audio and miss the stale-config notice. Include language and output encoding/sample rate in typed request, returned identity and cache keys. A language-only switch must miss the old cache; stale-response identity must describe the audio actually generated. |
| P2 | `src/app/api/tts/route.ts:229-231`; `src/components/feed/ttsSession.ts:216-222` | Every upstream refusal becomes 502. A real-handler probe with Soniox stubbed to 429 and `Retry-After: 2` returned 502 and dropped that header, so the client busy retry cannot apply. Preserve a sanitized retryable status/header and distinguish it from permanent refusal. The production-handler/client test must retry a pre-audio 429 with bounded, abortable delay and leave a 401/402 terminal. |
| P2 | `src/lib/ttsChunks.ts:83-87,117-127`; `src/app/api/tts/route.ts:203-205`; `src/lib/ttsBackend.ts:86` | A long unbroken non-ASCII token can stay in a 4,000-character request even though Soniox enforces 5,000 UTF-8 bytes; a long expanded utterance can also reach the documented audio-duration cap. The 2,501-character Cyrillic probe was rejected at 5,002 bytes. Split Soniox overlong units with a conservative small chunk ceiling, enforce bytes before contacting Soniox, and exercise slow/numeric speech below two minutes. A byte-overflow request must fail locally and an oversized unit must preserve all characters across valid chunks. |
| P2 | `src/components/feed/ttsSession.ts:458-459`; `src/components/feed/SpeakButton.tsx:350-368` | `playing` is announced before `play()` resolves or the element starts audio. Loading and playing share the same square icon with no visual loading distinction. A deferred-play stub can leave the UI saying playing while silent. Tie fast-path phase to scheduled audio reaching the output clock and give loading a visible spinner plus an enabled stop action. A stalled or rejected playback must remain loading or become error, and Stop must work in both phases. |
| P2 | `src/components/LogFeed.tsx:1161-1162` | Speech control is emitted only at the answer's first loaded fragment. If the visible window starts on a later fragment, the visible prose can have no control. Header selection must resolve any intersecting fragment to its whole loaded answer. Test a multi-fragment answer with its first fragment outside the rendered window. |

Existing limitations to carry explicitly: Soniox word highlighting/seek timing is proportional (`ttsAlignment.ts:93-116`), so word-exact alignment has never been demonstrated here. The cache's 51-entry assumption (`ttsSession.ts:34-49`) also becomes invalid with sentence-sized chunks; byte-based retention must replace that assumption for the fast path. These are addressed by the alignment and cache policies below.

## One design

### What one tap reads

The header reads the whole loaded assistant answer with the greatest visible prose area inside that conversation's feed viewport. Group intersecting fragments with the existing answer resolver. Sum visible body intersection area across an answer; break ties by the latest answer in feed order. Exclude user messages, tools, thinking, code-only answers, hidden prose and other conversations. This makes a scrolled-back view read the answer on screen even when newer answers exist below it.

At the live tail this normally selects the latest assistant answer. If the viewport shows no speakable assistant answer, disable the control with “No assistant answer in view.” Do not silently substitute an unseen answer. The tooltip/accessibility label says “Read this answer from the beginning” and describes the selected answer. A row-level control can still explicitly read an older answer.

Freeze the answer identity, sanitized text and source offsets at tap time. For a growing answer, read the text currently loaded and show that fact in its tooltip/menu; later transcript growth is available on the next read. Tail appends, scroll, virtualization and component remounts must not splice text into an active read. A second tap stops the active read belonging to that conversation even if the viewport's selected answer has changed. Starting any different read first cancels the page's previous session. Navigating away from the active conversation stops it. An empty/over-limit answer produces an explicit refusal; the existing 20,000-character message ceiling remains.

### Header placement and ownership

Phone: add the control to the `MobileShell` bar used by `MobileFocusView`, after the title/attention area and before reports/⋯. Reserve a 44 × 44 CSS-pixel hit target with a 20-pixel glyph. The supplied screenshot, `$HOME/Pictures/delegatus-review/fast-tts/operator-2026-09-30-phone-header.png`, was inspected visually. Its title and model already share a compact two-line cell; preserve that structure and the 52-pixel bar height.

At 390 pixels, back + speaker + reports + menu consume 176 pixels; 8 pixels of padding and 8 pixels of gaps leave 198 for the title. An attention badge adds 52 pixels and would squeeze the title below `TITLE_MIN_PX=190` (`MobileShell.tsx:34-55`). When attention is present, put Reports in the existing ⋯ sheet and retain attention + speaker + menu on the bar. Those controls with Back leave the same 198-pixel title budget. Update the existing width calculation to count actual optional actions. For wider badges and narrower widths, keep the speaker fixed and move secondary header actions into ⋯ according to measured available width. Do not let the control overlap the title or change the bar height.

Desktop: put the same control in the conversation's top action cluster, before expand/close controls in `BranchPane.tsx:332-345`. The orchestrator conversation also needs it in its actual top controls (`IncumbentHeader.tsx:156-173`) for the dock and board seat; `OrchestratorConversation.tsx:50` uses `LogFeed` directly. A desktop viewport can show several conversations: each button is scoped to its own feed. A full-window placement must retain the same session and button state.

Lift audio ownership out of a particular message button into a small conversation speech controller shared by the header and row controls, with one existing-style page-wide active-session latch. Share phase, target identity and stop behavior. Pass explicit answer DOM roots from the owning feed to karaoke; moving `SpeakButton` alone cannot work because `karaokeRoots(trigger)` currently requires a message ancestor. Scope DOM lookup to the conversation feed, and remap roots after virtualization without restarting speech. Keep text and controller state local to the current conversation; avoid a second transcript fetch or a document-wide selector.

Preserve existing row controls for other providers. Soniox row controls use the same fast controller, so header and row actions cannot start overlapping sessions. The header dispatches the configured provider: Soniox uses the fast policy, OpenAI/ElevenLabs use their current policy. Existing provider selection remains available through the current menu, with a labelled route in the phone's ⋯ sheet. One ordinary tap always starts or stops directly.

### Sentence and batch policy

Keep the current `SpeechChunk` exact-source-slice contract: `{index,text,start,end}` uses JavaScript UTF-16 offsets into one immutable sanitized string. Extend `chunkSpeech` with a Soniox policy; retain its existing default for other providers.

Use `Intl.Segmenter` sentence boundaries for the configured language, with paragraph/list breaks as additional boundaries. Test abbreviations, decimals, quoted punctuation, Cyrillic and punctuation-free prose. Supply a tested punctuation/whitespace fallback where the native segmenter is unavailable. Source offsets always come from the original string, including after fallback splitting.

Chunk 0 is the first complete sentence, capped at 160 Unicode codepoints. If that sentence is longer, split at the latest whitespace under the cap. Later chunks pack up to three sentences, capped at 360 codepoints, and stop at paragraph boundaries. A single overlong token splits at codepoint boundaries, retaining every character and never cutting a surrogate pair. Preserve punctuation and intra-chunk whitespace; only boundary whitespace may be omitted. There is no minimum character threshold before emitting the first sentence.

Validate each Soniox request's UTF-8 byte length against a conservative 4,800-byte application ceiling, below the observed 5,000-byte rejection limit. The ordinary 360-codepoint chunks are much smaller. Byte validation also protects direct callers of `/api/tts`. The two-minute cap is a duration constraint, so the character policy alone cannot prove speech coverage for every input. Include unusually slow speech and expanded numbers in real provider acceptance; detect a received chunk approaching the cap, surface an error and stop instead of claiming completion or silently retrying already-heard text.

### Request and playback

Extend the existing `/api/tts` route with an explicit Soniox streaming mode. A client selects it only for the configured Soniox option. The server validates that mode against the actual backend and answers a stale-mode mismatch before making a paid call. Standard MP3/OpenAI/ElevenLabs callers retain their current response contracts.

For fast Soniox requests send the observed shape with `audio_format:"pcm_s16le"` and `sample_rate:24000`. Keep the key on the server. Return `audio/pcm` with authoritative backend, model, voice, language, encoding, channel count and sample-rate metadata; validate those values in the client. Reuse the existing same-origin, timeout, concurrency and bounded-body cancellation machinery. Before exposing a response body, map Soniox errors into sanitized application errors with retryability. No API key or arbitrary upstream headers belong in client errors.

The client reads `response.body` incrementally. Convert signed little-endian 16-bit mono samples to float samples. Fetch-read boundaries are unrelated to sample boundaries: retain an unmatched final byte until the next read; an unmatched byte at EOF is a malformed stream. Read packet sizes can vary. Accumulate small PCM blocks suitable for scheduling (start with 100 ms blocks); do not await a Blob, full decode, or EOF to play the first block.

Create/resume one native `AudioContext` synchronously inside the tap. Use `AudioBufferSourceNode`s on that context's clock. After roughly 100 ms of available PCM, schedule the first block with a small scheduling lead. Every later block begins exactly at the previous block's scheduled end. Across chunk boundaries, schedule the next chunk at the same end time, with no crossfade, overlap, duplicated sample, or timer-based `ended` handoff. Preserve provider-generated silence; the requirement removes application-added gaps. Validate joins for clicks and voice continuity with real audio.

Track played samples on the audio clock and use `requestAnimationFrame` only for UI updates. A UI stall must not move an already scheduled audio join. When queued audio runs dry, enter loading, preserve the exact consumed sample position and resume the next unplayed block when data arrives. Network starvation can create a real wait; do not hide it by dropping text or by declaring a gapless pass. Browser suspension/interruption follows the same loading/stop semantics.

### First chunk first, then bounded prefetch

Start exactly one provider request for chunk 0. Let its samples reach the scheduled playback clock before starting later chunks. Thus the first request and first playback receive priority; no later synthesis is required to start speech.

After playback begins, allow up to two fast requests in flight, within the route's existing three-slot process budget. Keep at most the next two chunks ahead of the playing cursor; completion must not drain the whole answer into synthesis. Start the next needed chunk before a further prefetched chunk. Maintain ordered per-chunk buffers even when responses arrive out of order. Queued sample end times determine playback order.

Use a bounded client request cadence of at most one new request per second after the initial request. In the server's Soniox adapter, keep a small in-memory rolling admission counter for the documented default of 100 starts per minute within this Viewer process, alongside its three active slots. Do not add a persistent scheduler. Independent clients of the same Soniox account can still exhaust the provider limit; surface and retry a pre-audio upstream 429 using its safe retry delay, with bounded attempts and an abortable wait.

Retry only a refusal before any samples from that request are played. If a stream fails after playback starts, cancel the read and report the failure. Blindly restarting it could repeat words already heard. Cached chunks skip provider admission; a cache hit on chunk 0 still plays before new prefetch starts.

### Cancellation and cache lifetime

Every read owns a generation token, abort controllers for its requests, scheduled source nodes and its karaoke subscription. Stop invalidates the token first, aborts all fetches/backoff waits, cancels readers, stops and disconnects every scheduled node, clears unplayed buffers/highlights and returns the UI to idle. Stop must be enabled while loading. A late response, resolved resume promise, animation frame or source callback checks the generation before changing playback or UI.

Starting a new read runs that cleanup synchronously before creating its audio nodes. Seek cancels obsolete pending chunks within the same read before prioritizing its new cursor; it never exceeds the fast request budget. The current session can exceed its nominal concurrency on repeated seek (`ttsSession.ts:343`): a probe with concurrency 2 and seeks to chunks 3, 5 and 7 left five requests pending. The fast controller must eliminate that behavior.

Cache only complete successful chunks, using text plus the authoritative backend/model/voice/language/encoding/sample-rate identity. A partial or canceled stream cannot be advertised as a free replay. Keep the existing completion marker rule: an answer is free to replay only when all required audio remains cached.

Use a byte budget suitable for decoded PCM, instead of the old 51-entry minimum-chunk assumption or MP3 byte-rate estimate. At the existing assumed 15 characters/second, 20,000 characters require about 128 MB as float32 mono 24 kHz. Cap retained fast-path PCM at 32 MiB, including prefetched data; release blocks after playback when needed. Pin active queued blocks against eviction until played or canceled. Long answers may therefore require paid synthesis on replay, and the UI must say so. Preserve the existing MP3 cache for other providers and avoid charging again for a completed chunk that still fits the PCM cache.

### States and alignment

Idle: speaker icon, enabled when a visible answer and usable configured provider exist. Disabled state explains the missing answer/key or length refusal. Loading: stop icon with a visible spinner, `aria-busy=true`, and polite “Preparing speech” or “Buffering speech.” Playing: accented stop icon, `aria-pressed=true`, with “Stop reading this answer.” Error: return to a usable idle control and show the existing dismissible alert. Completion clears highlight and state. Keep progress in the existing answer/menu surface so the header retains its width. Translate all added copy in both `src/lib/i18n/en.ts` and `uk.ts`.

Loading changes to playing when the output clock reaches scheduled speech, rather than on fetch completion or a call to `play()`. The same clock drives UI progress; output latency is recorded in measurement. Respect reduced motion while retaining a visible loading cue. A spinner never consumes a second header target.

Keep the existing DOM range mapping and global source offsets. For the fast Soniox path, highlight the current sentence/batch chunk from its actual scheduled start to end, and clear it during a starvation gap. This highlight is aligned at chunk granularity, including three-sentence batches. Word-exact Soniox karaoke is explicitly out of scope: REST supplies no timestamps, and its existing proportional word cursor cannot truthfully identify spoken words before a stream's duration is known. Do not label the batch highlight as word-exact.

For completed cached Soniox chunks, retain approximate proportional click-to-seek using the measured sample duration; stop old scheduled nodes and restart from the chosen sample under the same cleanup rules. During an incomplete chunk, a click seeks to that chunk's start and announces that boundary behavior. Row controls for OpenAI and ElevenLabs retain their existing interpolation/timestamp behavior. Highlight roots can disappear through virtualization: clear unavailable ranges and rebuild the map when the answer remounts, without changing audio offsets or playback order.

## Tests and evidence required from implementation

External Soniox calls are stubbed in automated tests. Test the production chunker/controller/client/route, with only the provider and browser audio boundary controlled. Do not replace the entire client path with hand-fed chunks and call that an integration test.

| Test file or existing driver | Cases to add or retain |
| --- | --- |
| `src/lib/ttsChunks.test.ts` | Soniox first sentence under 800 characters; 160/360-codepoint boundaries; at most three later sentences; paragraphs, abbreviations, Cyrillic, quotes, decimals, long token and surrogate pairs. Assert exact source slices, ordered non-overlapping ranges, and that all non-boundary-whitespace characters occur exactly once. Assert OpenAI/ElevenLabs default output unchanged. |
| `src/components/feed/speakableAnswer.test.ts` | Visible-answer grouping/selection; scrolled-back answer with a newer answer offscreen; two visible answers/ties; no prose; incomplete answer frozen at tap; first fragment outside the window; separate conversations and hidden/code content. |
| `src/app/api/tts/route.test.ts` | Actual fast-mode PCM body/metadata; mismatched configured backend; UTF-8 byte rejection before external fetch; sample format validation; streamed bytes before EOF; client abort before headers and mid-body; timeout, malformed/oversized response, slot release exactly once; Soniox pre-audio 429 and sanitized retry delay; permanent refusal; local rate admission; unchanged existing provider shapes. |
| `src/components/feed/ttsSession.dom.test.ts` | Production fast controller with controlled request/audio clock: only chunk 0 before first scheduled playback; bounded two-chunk prefetch; out-of-order arrivals; chunks played exactly once in order; cached first chunk; stop mid-block, during loading and backoff; new-read cancellation; late-response fencing; rapid seek never exceeds budget; bounded memory and truthful replay availability. |
| `src/components/feed/SpeakButton.dom.test.tsx` | Header and row controls share one read/phase; tap starts directly and second tap stops; growing/retargeted answers do not alter a frozen read; loading differs visually; context resume refusal; unmount/navigation cleanup; authoritative language change; alert dismissal and provider menu remain functional. |
| `src/lib/ttsAlignment.test.ts`; `src/components/feed/ttsKaraoke.dom.test.ts` | Chunk-level Soniox ranges include global offsets; highlight follows the actual clock and clears during buffering; DOM roots span answer fragments and remount; cached proportional seek remains explicitly approximate; ElevenLabs alignment unchanged. |
| `src/lib/ttsBackend.test.ts`; `src/components/feed/SpeakMenu.placement.test.ts` | Soniox identity includes language/format; PCM cache eviction updates free/paid copy; desktop/right-click and phone menu route; existing placement/refusal behavior remains valid. |
| `src/components/mobile/mobileHeaderFit.dom.test.tsx`; `MobileFocusView.conversation.dom.test.tsx` | Header includes speaker; width accounting includes optional actions; reports remains reachable when attention forces it into ⋯; title retains its budget and loading/playing state does not change geometry. |
| `src/components/mobile/issue1671Evidence.browser.test.tsx` | Add a `fast TTS header` describe block to the existing phone driver/fixture. Exercise the actual control at 390 × 844 in light/dark, with ordinary and orchestrator conversations, long titles and attention; idle/loading/playing/error and Stop. |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | Add a `fast TTS header` case to the existing desktop driver/fixture, using real `BranchPane` and orchestrator headers at 1440 × 900, including a narrow dock/card and full-window placement, in light/dark. Reuse these cases for actual browser PCM scheduling evidence and stubbed delayed-EOF playback. |

At the real browser audio boundary, use known PCM packets whose first/last sample positions and chunk IDs are controlled. Record the contiguous output timeline: with data ready, joins have zero missing/duplicated samples, including under a short main-thread stall. Real playback must produce samples before a delayed EOF. Stop and replacement must remove old-source samples by the next audio render quantum plus recorded device latency. Unit mocks alone cannot prove audible joins or autoplay permission; a physical Safari run verifies gesture unlock, interruption and Stop. No extra dependency or issue-specific capture driver is needed.

Save implementation renders to `$HOME/Pictures/delegatus-review/fast-tts/` and name them in the PR:

```text
phone-390-light-idle.png
phone-390-light-loading.png
phone-390-light-playing.png
phone-390-dark-idle.png
phone-390-dark-loading.png
phone-390-dark-playing.png
desktop-1440-light-idle.png
desktop-1440-light-loading.png
desktop-1440-light-playing.png
desktop-1440-dark-idle.png
desktop-1440-dark-loading.png
desktop-1440-dark-playing.png
```

Also capture attention/report overflow and the desktop orchestrator/narrow-dock variant with meaningful filename suffixes. Assert positive control width, hit target size, viewport containment, disjoint control/title rectangles, readable focus/loading/playing states and unchanged header height. This design stage inspected the supplied screenshot; it makes no claim that the proposed UI has already rendered.

Run only explicit test files under isolated state/config. The project test preload already assigns a private state directory; verify that environment rather than inheriting live state. Run heavy browser/build/type gates under `flock /var/tmp/llv-heavy-gate.lock`, waiting for its current owner. A read-only review uses an export of the candidate under the stage's own scratch root and cleans only its own processes/directories. Example driver commands after adding the named cases:

```sh
flock /var/tmp/llv-heavy-gate.lock env LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN="$CHROME_BIN" bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t 'fast TTS header'
flock /var/tmp/llv-heavy-gate.lock env LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN="$CHROME_BIN" bun test src/components/kanban/kanbanBoard.browser.test.tsx -t 'fast TTS header'
```

Implementation also runs the repository's lint/type checks, build, publication gate and relevant CI/runtime verification as required by the changed files. Use explicit tests and private state; never sweep runtime/registry directories against the operator's installation. No changes to `landing/`, `scripts/usage-metrics.ts` or `src/lib/links/**` belong to this work.

## Validation performed in this stage

- Read the repository instructions, contribution/privacy rules, relevant installed Next route/streaming guidance and the complete TTS path above.
- Inspected the operator's actual phone image visually; used no OCR.
- Made real Soniox MP3/PCM requests with the configured key, measured the unchanged production component/client/route in three cold browser trials, and observed ASCII/Cyrillic byte-limit refusals. Probe browsers and ephemeral loopback server completed and closed before the deployment interruption; all results were returned. Resume inspection found the source head unchanged and no product diff. A WAV geometry probe after resume confirmed mono PCM at the requested sample rate.
- Ran explicit baseline tests: `tts.test.ts`, `ttsBackend.test.ts`, `ttsChunks.test.ts`, `ttsAlignment.test.ts`, `api/tts/route.test.ts`, `speakableAnswer.test.ts`, `ttsSession.dom.test.ts`, `ttsKaraoke.dom.test.ts`, `SpeakButton.dom.test.tsx`, `SpeakMenu.placement.test.ts`: **101 pass, 0 fail, 427 assertions**. They ran under the repository's isolated test preload. Existing green tests intentionally assert some of the slow behavior identified above.
- Reproduced language cache collision, upstream 429 becoming 502, and repeated seek exceeding client concurrency with in-memory probes of production modules and stubbed external calls.
- Ran `bun run privacy:check`, including the required known-value fingerprints and commit checks: **pass**. The generic publication gate against `HEAD` also passed. The only worktree output is this document; no build/lint/type run was needed for a prose-only artifact. Source-wide checks and browser evidence for the proposed UI remain implementation gates.

No build, deployment, production state mutation, commit, stage or push is part of this stage. A read of the live backend GET after the Viewer replacement returned connection refused; the earlier measurements exercised the pinned source with the configured on-disk selection, and do not claim the successor's deployed environment or phone latency. Candidate before/after and rendered UI evidence are acceptance work for the implementation stage.

## Requirement check

| Originating request / acceptance | Design coverage |
| --- | --- |
| Start reading quickly, split by sentence or about three | Short first sentence, PCM playback before EOF, then bounded three-sentence batches. Baseline and first-sentence provider probe explain why both chunking and incremental playback are needed. |
| Button at the top, one tap starts and another stops | Phone bar and desktop conversation/orchestrator headers share the controller; loading remains stoppable. |
| Read what is on screen | Explicit greatest-visible-prose answer selection; read that frozen loaded answer from its beginning; no hidden-answer fallback. |
| Soniox first; other backends continue working | Fast mode is Soniox-specific; existing provider request, cache/playback and alignment contracts stay covered by regressions. |
| No duplicate/skipped sentences, gaps or overlaps; replacement cancels | Exact slice invariants, indexed buffers, shared sample clock, generation fencing and cancel-before-start. Starvation is reported and tested separately from a ready-buffer join. |
| Karaoke accounted for | Chunk/batch highlighting follows actual audio; existing DOM mapping survives. Exact Soniox words are explicitly deferred with the REST limitation documented. |
| Before/after and renders | Exact baseline answer, three measured source trials, repeated candidate protocol, existing drivers, required viewports/themes and named artifacts. Physical phone latency remains separately identified. |
| External facts observed and defects listed | Current primary docs, successful configured-key requests and byte-limit refusals; file/line defects with remedies and targeted tests. |

## Deferred — not currently justified

- WebSocket transport, temporary-key issuance, SDK adoption and exact Soniox word timestamps. The observed HTTP PCM stream already supplies early audio. Timestamp accuracy would justify its own transport work if the operator requests word-exact highlighting; the existing Soniox cursor is approximate.
- Reading a live assistant stream forever, arbitrary text selections, reading user messages or tool output, and automatic synthesis before a tap. This request asks for reading the answer in view on demand.
- Fast-path rewrites for OpenAI/ElevenLabs, persistent playback jobs, background narration, cross-device sessions and a shared distributed quota service. The current scope has one active page read and the existing local Viewer process.
- Changes to the realtime call speaker detector, voice discovery, automatic language detection, or provider switching by UI locale. Use the configured Soniox language and expose it correctly in identity; mixed-language inference needs a separate product requirement.
- A new capture framework or another pipeline. Extend the existing drivers and let the owning pipeline perform implementation and review.
