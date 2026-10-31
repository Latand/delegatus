# OpenAI key services: build contract and variant 3 brief

## Requirement and settled decisions

Originating requirement, operator, 2026-10-29, seat chat (voice transcript,
Russian). The verbatim text stays off this public document under the
publication rules (AGENTS.md, working rule 12); it is held in the task record.
In substance: an OpenAI subscription now carries a sizeable API credit
allowance; once an OpenAI API key is saved in Settings, the operator wants to
choose which Delegatus API features that key serves. Named: the «Asks you»
classifier through OpenAI's decisions API in place of OpenRouter's (a choice of
OpenRouter or OpenAI), read aloud, fast voice transcription, voice Delegatus,
and anything else API-based in Delegatus. The key is not for Codex.

Decisions already taken (operator-delegated autonomy, 2026-10-29, after an
independent visual review of three numbered prototypes):

- **Variant 3**, «In each feature's settings»: under the OpenAI key row, a list
  of the six features naming each one's provider now; each opens that feature's
  own settings page, where OpenAI is one more choice in the feature's existing
  list.
- **No feature moves to OpenAI when a key is saved**; each one is switched by
  hand.
- **Classifier**: OpenAI Decisions is added as a selectable alternative;
  OpenRouter stays the default.
- **Key removed**: the feature runs on its previous provider again, and the
  OpenAI choice is remembered until a key is saved again.

This document replaces the inventory and prototype brief of the same name
published with open pull request #3491 (head `109100568`). It is the build
contract for the implementation stages: vendor contracts observed fresh, the
six callers on current `main`, one shared provider policy, key removal, routes
and authorization, tests, and the variant 3 frontend brief with its file
keep-list, states and capture plan. Product behaviour beyond what is written
here is out of scope.

## Evidence boundary

- **Source**: `origin/main` at `10294c944671f3f9d367f8b0ab64d737137ad5f8`
  (fetched 2026-10-30). The worktree started one commit behind it at
  `7c13643b`; the one newer commit touches only proactive-task files
  (`src/lib/tasks/proactive*`, `src/lib/pipelines/engine.ts` and runtime
  queue files) and none of the files below. Citations are `path:line` at
  `10294c94`, read from a scratch `git archive`.
- **Prototype**: `docs/design/openai-key-services/prototype/` at `109100568`
  (fixture, README) and its retained variant 3 frames (408 of the 558; the
  inspected ones are named in the frontend brief). The prototype harness and
  fixture are not imported; only the drawn behaviour is carried.
- **Vendor documentation**: read 2026-10-29 22:22–22:45 UTC through the
  public OpenAI developer-docs MCP endpoint (`search_openai_docs`,
  `fetch_openai_doc`) and as raw pages (all HTTP 200), tags stripped, read
  whole. No API call was made with any key, no key or setting was read, and
  nothing was generated. Pages are listed with each contract below.
- **Earlier answers**: the prior inventory (above), the prototype README and
  critic record, and the Keys design (`docs/design/keys-settings.md`, whose
  §12 deferred key removal as not asked). Transcript and memory searches for
  earlier decisions on OpenAI transcription transport, key removal and TTS
  migration found nothing beyond those.
- **Open changes on the same files** (`gh pr list`, 23 open, none at the 100
  file cap): #3471, #3415, #3265 and #3263 append to
  `src/lib/team/workspaceRoutes.ts`; #3399, #3265 and #3263 append to
  `src/lib/i18n/en.ts` and `uk.ts`; #3491 holds the older version of this
  document. None touches the key, classifier, dictation, read-aloud or voice
  code. Merge by appending; keep their entries.

## What changed since the prior inventory

| Topic | Prior inventory | Observed now |
| --- | --- | --- |
| Decisions | `answers` array with token usage, matched by name | Generally available. `answers` is an **array in question order**, each echoing its `name`; any answer can be `{ type: "refusal" }`. `usage` reports tokens only, no dollars. |
| Decisions pricing | $0.10/M input, cache read/write rates | Same base; cache writes $0.125/M (1.25×), cache reads $0.01/M, regional processing +10%, 2× above 272K input tokens. |
| OpenAI read aloud | A Realtime text-to-audio adapter needed; no recipe cited | Official recipe exists: a Realtime session told to read the user's text aloud without commentary, `output_modalities: ["audio"]`, text as a user message, then `response.create`. |
| Realtime voices | Not compared | Speech offers 13 voices; Realtime offers 10. `fable`, `nova`, `onyx` have no Realtime equivalent. |
| Live transcription from a browser | "Ephemeral credential/WebRTC flow" | The unified `/v1/realtime/calls` server path accepts only `type: "realtime"` sessions. A transcription session reaches a browser through a client secret (`/v1/realtime/client_secrets`, `type: "transcription"`), then WebRTC. |
| Six callers | Cited at `83973ce6` | Re-read at `10294c94`; the call sites are unchanged in substance. The asks status view and the memory status view also read OpenRouter key presence directly (new finding). |

## Observed vendor contracts

Each contract names what the build may rely on, and what the documentation does
not show. A test fakes exactly this shape (a mock vendor contract); no test
calls OpenAI.

### C1. Decisions (classifiers)

Sources: [Decisions guide](https://developers.openai.com/api/docs/guides/decisions),
[create reference](https://developers.openai.com/api/reference/resources/decisions/methods/create),
[gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna).

- `POST https://api.openai.com/v1/decisions`, `Authorization: Bearer <key>`,
  JSON body. `model` must be `gpt-6-luna` ("the only currently supported
  model").
- `input`: a string, or an array of messages; a `user` message may combine
  `input_text` and `input_json` parts (`{ "type": "input_json", "data": … }`).
  Keys inside `data` are ordinary data.
- `questions`: 1–400 items; a predicate is
  `{ "type": "predicate", "name": <string>, "instructions": <string or
  input_text/input_image parts> }`. Objects as instructions are not accepted.
- Response: `{ answers: [...], model, usage }`. `answers` follows question
  order; a predicate answer is `{ type: "predicate", name, probability }`; a
  refusal is `{ type: "refusal", name }` and other questions still answer.
  `usage.input_tokens` includes `input_tokens_details.cached_tokens` and
  `cache_write_tokens` (do not add them again); output tokens are not charged
  on Decisions.
- Price per 1M input tokens: $0.10 uncached, $0.01 cached, $0.125 cache write;
  +10% with regional processing; 2× above 272K input tokens. The guide advises
  setting thresholds from labelled examples of one's own application.
- Usage reporting (`GET /v1/organization/usage/decisions`) needs an **admin**
  key; no project-key balance endpoint is documented. Credits running out
  answers HTTP 429 `credit_balance_exhausted` (credits guide, below).
- Not shown: OpenAI's internal prompt overhead per request, so a token ceiling
  cannot be computed exactly before the call (the ceiling in D-asks covers
  it with a stated allowance).

Differences from today's Jev request (`src/lib/asks/jev.ts:14-19`,
`:117`, `:134-149`): Jev sends `model: "typesafe/jev-1.13"`, a `state` object
and a `questions` **object keyed by name** with `type: "noul"`, reads
`answers[name].noul` and a dollar `usage.cost`. None of that exists on
Decisions, so the adapter translates both directions; changing the URL and key
alone would break every parser.

### C2. Read aloud on Realtime (migration of the OpenAI path)

Sources: [Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech),
[Deprecations, 2026-10-01](https://developers.openai.com/api/docs/deprecations#2026-10-01-text-to-speech-models),
[Custom voices, speech generation](https://developers.openai.com/api/docs/guides/custom-voices),
[Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations),
[WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime),
[client events](https://developers.openai.com/api/reference/resources/realtime/client-events),
[gpt-realtime-2.1-mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini).

- `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` (both snapshots) shut down on
  **2027-01-06**. Replacement: `gpt-realtime-2.1-mini` on the Realtime API.
  It is not a valid model for `/v1/audio/speech`; changing the model id alone
  is unsupported. Of the 18 endpoints on its model page, only `v1/realtime`
  is marked supported (`v1/audio/speech` is marked unsupported).
- Server connection: `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini`
  with `Authorization: Bearer <key>`.
- Text to speech recipe (custom-voices guide): session
  `{ type: "realtime", instructions: <read the user's text aloud without
  commentary>, output_modalities: ["audio"], audio: { output: { voice } } }`;
  add a user message `conversation.item.create` with one `input_text` part;
  send `response.create` with `output_modalities: ["audio"]`.
- Output over a WebSocket: `response.output_audio.delta` events carry base64
  audio; `response.output_audio.done` and `response.done` carry no audio.
  Output format `session.audio.output.format`: `{ type: "audio/pcm", rate:
  24000 }` (only 24 kHz) or G.711 μ-law/A-law.
- Voices: `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`,
  `verse`, `marin`, `cedar`; the voice cannot change after the session has
  emitted audio.
- Price per 1M tokens: text input $0.60, audio output $20.00 (Speech
  `gpt-4o-mini-tts` today: text input $0.60, audio output $12.00). Equivalence
  of audio-token counts between the two models is not documented; the per-call
  cost change is unmeasured.
- Not shown: any guarantee that the spoken words equal the input text. The
  recipe relies on session instructions. Speech remains callable until
  2027-01-06.

### C3. Recorded dictation (file transcription)

Sources: [File transcription](https://developers.openai.com/api/docs/guides/speech-to-text),
[create transcription](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create),
[gpt-transcribe](https://developers.openai.com/api/docs/models/gpt-transcribe)
(marked supported on `v1/audio/transcriptions` and
`v1/realtime/transcription_sessions` only),
[pricing](https://developers.openai.com/api/docs/pricing).

- `POST https://api.openai.com/v1/audio/transcriptions`, multipart: `file`
  (flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm; up to 25 MB; an
  extension-bearing filename and content type), `model: gpt-transcribe`,
  optional `languages[]` (ISO 639-1), `prompt`, `keywords[]`.
- Response (`json`): `{ text, languages?: [{ code }], usage }`; an empty
  `languages` means no reliable detection.
- Estimated $0.0045/minute. `whisper-1` and the `gpt-4o-*-transcribe` models
  shut down 2027-02-26; none of them is introduced.

### C4. Live dictation (Realtime transcription in the browser)

Sources: [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription),
[gpt-live-transcribe](https://developers.openai.com/api/docs/models/gpt-live-transcribe)
(marked supported on `v1/realtime/transcription_sessions` only),
[client secrets](https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create),
[WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=realtime),
[create call](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create),
[push to talk](https://developers.openai.com/api/docs/guides/realtime-conversations#push-to-talk).

- Model `gpt-live-transcribe` in a session of `type: "transcription"`;
  `turn_detection` must be `null` (no server or semantic VAD); the client
  commits each turn with `input_audio_buffer.commit`. Events:
  `conversation.item.input_audio_transcription.delta` (`item_id`, `delta`)
  and `…completed` (`item_id`, `transcript`). No detected language, word
  timestamps, speaker labels or confidence. `languages[]`, `keywords[]`,
  `prompt` and `delay` (`minimal`…`xhigh`, no fixed milliseconds) are
  accepted. Estimated $0.017/minute.
- The guide sends browser audio to WebRTC. The server mints a client secret:
  `POST /v1/realtime/client_secrets` with `expires_after: { anchor:
  "created_at", seconds: 10…7200 }` (default 600) and `session:
  { type: "transcription", audio: { input: { transcription: { model:
  "gpt-live-transcribe", languages, delay }, turn_detection: null } } }`; the
  answer carries `value` and `expires_at`. The browser posts its SDP offer to
  `POST https://api.openai.com/v1/realtime/calls` with
  `Authorization: Bearer <client secret>` and `Content-Type: application/sdp`,
  sets the answer, sends its microphone as a media track and exchanges events
  on a data channel. WebRTC negotiates the audio format, so `audio.input.format`
  is omitted. Commit over the data channel is documented for WebRTC
  push-to-talk.
- The unified interface (server posts the SDP with the standard key) accepts
  only `type: "realtime"` sessions, so it cannot carry a transcription session.
- Not shown in one example: a transcription-type client secret used on
  `/v1/realtime/calls`. Each step is documented separately and the
  transcription guide points browsers to this path. The design therefore keeps
  the existing fallback: any failure before recording starts records the clip
  and transcribes it with C3 (contract D-live below).

### C5. Voice Delegatus (unchanged)

[GPT-Live 1](https://developers.openai.com/api/docs/models/gpt-live-1) is still
listed at $0.05/minute, billed per second, with backend model and tools
charged separately; no deprecation is listed for `gpt-live-1` or `gpt-6-luna`.
The existing API backend (`src/lib/voiceCompanion/sessionConfig.ts:11-12`,
`src/lib/voiceCompanion/provider.ts:41`, `:51`, `:67`) keeps its endpoints.

### C6. Credits and the key's scope

[API credits for ChatGPT subscribers](https://developers.openai.com/api/docs/guides/chatgpt-api-credits):
eligible Pro and Business subscriptions claim up to $500 a month, credited to
one linked API organization owned by the subscriber; grants expire at the end
of the billing cycle; they cover Decisions, GPT-Live and Realtime; "Codex usage
through API keys is not supported by this benefit" and the credits do not raise
signed-in Codex limits; with no credits left, requests fail with HTTP 429
`credit_balance_exhausted`. Saving a key proves neither eligibility nor
balance. The product makes no credit or "free" claim and keeps its own spend
caps.

## The six callers on current main

| Feature | Reached caller and credential read | Provider today | What the OpenAI choice changes |
| --- | --- | --- | --- |
| Asks you | `src/lib/asks/controller.ts:94` reads the OpenRouter key once per sweep; `:120` calls `classifyWithJev`; `src/lib/asks/sweep.ts:89-90` holds that key for every message of the sweep; ceiling `:157`, settle `:188`; threshold 0.85 (`jev.ts:17`) | OpenRouter Jev, 3 `noul` statements, 2 s, no retry | Decisions adapter; re-resolve provider and key before **each** call |
| Memory in chats | `src/lib/memory/controller.ts:160` reads the OpenRouter key; reserve `:178`, decide `:185`, settle `:186` against the asks cap; request `src/lib/memory/selection.ts:98-106`; call `src/lib/memory/injection.ts:86-105`; ceiling `injection.ts:52`; offer threshold 0.70 | OpenRouter Jev, one statement per candidate, whole injection ≤ 1.5 s | Decisions adapter translating object instructions to text |
| Learned rules (shadow) | `src/lib/memory/roleLaunch.ts:85` → `src/lib/memory/roleSelect.ts:115-121` key read, `:131` OpenRouter credit check, `:136` reservation ($5/month, `roleSelectionSpend.ts:5`), batches of 32, threshold 0.3, `:161` records `selector: "jev"` | OpenRouter Jev with BM25 computed first | Decisions adapter; no credit pre-check on OpenAI; shadow mode unchanged |
| Dictation, recorded | `src/app/api/transcribe/route.ts:54` `resolveTranscribeBackend()`; branches `:56-90` | `local` by default (`src/lib/transcribeBackend.ts:25-35`); ChatGPT, ElevenLabs, Soniox | New `openai` backend, C3 |
| Dictation, live | `src/app/api/transcribe/token/route.ts:34-41` mints per backend; `src/hooks/useDictation.ts:75-86` asks for a token, `:532-534` picks the socket, `:549-558` falls back to recording when no token | ElevenLabs or Soniox sockets | New `openai` live provider, C4 |
| Read aloud | `src/app/api/tts/route.ts:153-158` resolves backend and key; `:87-93` OpenAI Speech request (MP3); `src/lib/ttsBackend.ts:48-53` default `openai`, `:117-126` model `gpt-4o-mini-tts`, voice `alloy` | OpenAI Speech by default; ElevenLabs, Soniox, Fish Audio | OpenAI path migrates to C2 as 24 kHz PCM |
| Voice Delegatus | `src/lib/voiceCompanion/liveSession.ts:276` picks the provider from `settings.backend`; `src/lib/voiceCompanion/storage.ts:298` default `api`; key read at call time `:368-376` | API (`gpt-live-1` + `gpt-6-luna`) or Codex subscription | The OpenAI choice **is** the existing `api` backend |

Also reached by the change, because they report key state for these callers:
`src/lib/asks/view.ts:6-18` (`keySource` from OpenRouter) feeding
`src/components/AsksYouRow.tsx:19`, `:47`; `src/lib/memory/view.ts:11`, `:18`
(`noKey` from OpenRouter) feeding the «enter key» button at
`src/components/memory/MemoryPage.tsx:182`, which opens the OpenRouter key.

Not a caller, confirmed: Telegram has no transcription or speech generation
(`git grep` over `src/lib/telegram/`, `vendor/telegram-mcp/`,
`src/lib/externalRelay/` finds only agent-conversation transcripts). The
research replay in `scripts/memory-selection.ts` stays manual and OpenRouter
only. The configurable Claude provider relay, Codex accounts, call-memory
summaries and memory profiles keep their current paths (see Deferred).

## Shared provider policy (backend contract P)

One small typed module decides, for every feature, what the next request uses.
Each caller and each settings view goes through it; no caller keeps its own
fallback logic.

### P1. Types

```ts
// src/lib/openaiServices/policy.ts
export type ServiceFeature = "asks" | "memory" | "rules" | "dictation" | "read" | "voice";
export type ClassifierProvider = "openrouter" | "openai";
// dictation: TranscribeBackend gains "openai"; read: TtsBackend already has it;
// voice: "codex" | "api" ("api" is the OpenAI choice).
export interface ServiceResolution<P extends string> {
  feature: ServiceFeature;
  requested: P;          // what the operator chose (or the legacy default)
  effective: P;          // what the next request is routed to
  held: boolean;         // an explicit OpenAI choice waiting for the key
  available: boolean;    // the effective provider has what it needs right now
  lockedBy: string | null; // the environment variable that fixes the choice, if any
  apiKey: string | null; // the credential read in this same resolution; never serialized
}
```

### P2. Storage: native baseline plus one opt-in document

- **Native stores stay the baseline and keep their meaning**: `tts-backend`
  and `transcribe-backend` config files, `voice-companion.json`
  `settings.backend`, and for the three classifiers the implicit OpenRouter
  (they have no provider field). Existing values, including legacy OpenAI
  ones (read aloud defaulting to `openai`, voice defaulting to `api`), are
  read exactly as today.
- **New**: `configFilePath("openai-services.json")`, mode 0600, atomic
  temp-and-rename, written under the file's transaction lock
  (`withFileTransactionAsync` on Viewer paths, sync only for transfer and CLI):

  ```json
  { "version": 1, "openai": { "asks": { "since": "2026-10-30T00:00:00.000Z" } } }
  ```

  One entry per feature explicitly moved to OpenAI. No credential, no other
  setting. A missing file means no opt-ins. An unreadable or malformed file
  reads as no opt-ins, logs one `[openai-services] unreadable` line without
  content, and is rewritten by the next choice.
- No migration step: an upgrade with no document behaves exactly as today. An
  older release, during succession or after a rollback, ignores the document
  and runs every feature on its native baseline; nothing it reads changes
  shape.

### P3. Resolution (pure, read at the moment of each dispatch)

`resolveService(feature)` reads the environment, the native store, the opt-in
document and the OpenAI key (`readKey("openai")` in `src/lib/keys/store.ts:59-78`:
environment first, then the file) in one call, and returns:

1. An environment lock (`LLV_TTS_BACKEND`, `LLV_TRANSCRIBE_BACKEND`) wins:
   `requested = effective = <env value>`, `lockedBy` set, opt-in ignored.
2. Opt-in present and the OpenAI key readable: `effective = openai` (`api`
   for voice), `held = false`.
3. Opt-in present and the key missing or unreadable (`source` `missing` or
   `failed`): `effective = <native baseline>`, `requested = openai`,
   `held = true`.
4. No opt-in: `effective = requested = <native baseline>`.

`available` is computed for the effective provider with the existing
availability readers (`transcribeBackendInfo`, `ttsBackendInfo`, Codex sign-in
for voice, OpenRouter key for classifiers). `apiKey` is the credential that
resolution read, and the caller uses that one value for its request. There is
no cache: each resolution reads at most three small files and the environment.
Background work (the asks sweep, memory batches, role batches, live-token
minting, voice call start, read-aloud chunks) resolves again before each
outbound request, so a removed or replaced key is never used for a new
request. A request already in flight finishes with the credential it started
with.

### P4. The one writer

`chooseService(feature, provider)`, used by the new route and by every existing
selector route:

- `openai` (or `api` for voice) **while the OpenAI key reads**: write the
  opt-in; leave the native baseline untouched. If the native baseline is
  already OpenAI (legacy), the opt-in is still written and changes nothing
  visible.
- `openai` **while the key is missing or unreadable**: the new route refuses
  (409 `unavailable`; its pages disable the option). The existing routes keep
  today's behaviour exactly: the native store is written to OpenAI (`openai`
  for read aloud and dictation, `api` for voice), the opt-in is cleared, and
  the feature reports OpenAI as unavailable until a key arrives. This keeps
  the voice dialog's «choose the API, then add the key» flow and the read-aloud
  menu as they are; there is no previous provider to fall back to because the
  operator replaced it.
- any other provider: write the native store to it (existing writer:
  `writeTtsBackendAsync`, `writeTranscribeBackend`,
  `CompanionStorage.updateSettings({ backend })`) **and** delete the opt-in,
  in that order. If the native write fails, the opt-in stays and the route
  answers the failure.
- refused when the feature is environment-locked (409 `locked_by_env`, as the
  existing routes answer).

A held choice therefore arises only one way: OpenAI was chosen while its key
worked, and the key later disappeared. An explicit non-OpenAI choice always
becomes the retained baseline and clears OpenAI, so a later key removal cannot
undo it. Nothing in the product writes a choice automatically: fallback and
restore are both resolution results, so there is no automatic revert that
could overwrite an explicit choice. Saving a key (`writeKey`, `src/lib/keys/store.ts:91-101`)
and importing keys (`applyImport`, `:157-173`) never touch the opt-in document.

### P5. Readers that must report the resolution

- `GET /api/tts/backend` and `ttsBackendInfo().backend` report `effective`;
  add `requested`, `held`. `POST /api/tts/backend` writes through P4.
- `GET /api/transcribe/backend` and `transcribeBackendInfo()` the same; the
  `options` list gains `openai` (available when the key reads). `POST` writes
  through P4.
- `CompanionStorage.settings()` reports `backend = effective` plus
  `requestedBackend`, `held`; `updateSettings({ backend })` goes through P4.
  `liveSession.ts:276` keeps reading `settings.backend` at call start.
- `asksYouSettingView()` (`keySource`, `keyPath`) and `memorySettingView()`
  (`keySource`, the `noKey` reason) report them for the **effective**
  classifier provider, and both add `provider` so the «enter key» action
  opens the right key.
- The availability check `GET /api/tts` (`route.ts:144-147`) and the token and
  upload routes call the same resolver, so a settings view and the request it
  describes cannot disagree.

### P6. Transfer and copies

`src/lib/transfer/sections.ts:121-123` carries `tts-backend`,
`transcribe-backend` and the voice document; add `openai-services.json` to the
same voice-settings section as an explicit entry. It carries no credential. On
a target machine without the key, transferred opt-ins are held and the
transferred baselines run. Key copy and import (`exportKeys`, `applyImport`)
stay credentials only.

## Per-caller backend contracts

### D-asks. Asks you

- `runAsksSweepOnce` keeps its enabled and release-ownership gates; it no
  longer captures one key. `runAskSweep` receives `resolve(): { provider,
  apiKey } | null` and calls it immediately before each classification;
  `null` (no usable credential for the effective provider) ends the sweep as
  `!apiKey` does today.
- `classify(text, resolved)` dispatches to `classifyWithJev` (unchanged) or
  `classifyWithDecisions` (new, `src/lib/openaiServices/decisions.ts`).
- Decisions request: `model: "gpt-6-luna"`, `input` = the existing
  `classifierText(text)` (same redaction and 1,000 + 3,000 character cut),
  `questions` = the three existing statements (`jev.ts:24-37`) as predicates
  with `name` `asks`, `waiting`, `decision`. Parse by `name`; every answer
  must be a predicate with a finite probability in [0, 1]. A refusal, a
  missing, duplicate or extra name, or a malformed number is a `shape` error
  (no verdict; the message stays unclassified, as today). Score = max of the
  three; threshold 0.85 unchanged.
- Timeout 2 s, no retry, `JevError` codes and the "an error status bills
  nothing" rule unchanged.
- Cost: `cost = (uncached × 0.10 + cached × 0.01 + cacheWrite × 0.125) / 1e6`
  from `usage`. Pre-call ceiling for the cap: `(1024 + UTF-8 bytes of input
  and all question text) × 0.1375e-6` USD, the worst per-token rate (cache
  write with the regional premium) over a byte bound plus a fixed allowance
  for OpenAI's request framing, which the documentation does not state. The
  settle step replaces the reservation with the computed cost, as the Jev
  path does with `usage.cost`. Inputs stay far below the 272K long-context
  threshold. The cap holds at published rates; the allowance is a design
  value, recorded as such.
- The score cache (`scores[textKey]`, `sweep.ts:145`, `:190-191`) keeps OpenRouter
  keys as they are and stores OpenAI scores under `openai:<textKey>`, so a
  score is reused only for the provider that produced it.
- Enabling stays separate: choosing a provider never turns «Asks you» on.

### D-memory. Memory in chats

- `controller.ts:160` resolves `memory`; `noKey` when the effective provider
  has no credential. The decide port receives the resolution.
- `groundedRequest` (`selection.ts:98-106`) keeps building the evidence. The
  OpenAI form puts the task text in an `input_text` part and the `state` object
  in an `input_json` part of one user message; each candidate becomes a
  predicate named by its candidate id whose `instructions` is text carrying the
  same `statement`, `proposedOffer`, `supportingBodyExcerpt`, `bodyRule`,
  `examples` and `criteria` (rendered as labelled JSON text). Nothing in the
  evidence is dropped.
- Same 1.5 s budget, same shared asks cap and ledger, threshold 0.70; ceiling
  `max(0.01, (4096 + request bytes) × 0.1375e-6)`; settle from usage tokens;
  refusals or malformed answers fail the optional offer as `failed` and the
  operator's turn proceeds without it.

### D-rules. Learned rules (shadow)

- Resolve `rules` before reading the key; re-resolve before each batch, as
  `roleSelect.ts` already re-reads the key, and end with
  `jev-authority-changed` when provider or key changed.
- OpenAI path: same batches of 32, the same `state` as an `input_json` part,
  predicates named by the hashed rule ids; threshold 0.3; same 3 s deadline;
  same $5 monthly reservation ledger. The OpenRouter credit check (`:131`) is
  skipped on OpenAI because no project-key balance endpoint is documented; a
  429 (`credit_balance_exhausted`) returns the BM25 result as `jev-http`.
- Recorded rows keep `selector: "jev"`; the provider goes into
  `selectorVersion` (`openai/gpt-6-luna-1`, while OpenRouter keeps
  `typesafe/jev-1.13-1`). `roleSelection.ts:41-42` decodes rows strictly with
  `selector ∈ {whole, bm25, jev}` and two releases run side by side during a
  succession, so a new selector value would make the older release refuse
  new rows.
- Shadow mode is unchanged: agents still receive the whole snapshot
  (`roleLaunch.ts:85`), and the regression at
  `src/lib/memory/roleSelection.test.ts` still holds.

### D-dictation. Recorded

- `TranscribeBackend` gains `openai` (`transcribeBackend.ts:10-12`);
  `resolveTranscribeBackend()` returns the P3 effective value;
  `LLV_TRANSCRIBE_BACKEND=openai` is accepted like the other values.
- `src/lib/transcribe/openai.ts`: multipart C3 request with the uploaded file
  (filename with its extension, the route's normalized MIME type),
  `model: "gpt-transcribe"`, `languages[]` = `TRANSCRIPTION_LANGUAGES`
  (`uk`, `ru`, `en`). The result passes through `transcriptionResult(text,
  languages.map(code), preferred)` (`languages.ts:24-33`), so an unexpected
  code is tagged with the preferred language and no language is invented.
- Route semantics as the other key providers: missing key → 503 with the key
  path; upstream failure → 502 with a message that never includes the key or
  the audio; the 16 MB cap stays.

### D-live. Live

- `POST /api/transcribe/token` with effective `openai` mints a C4 client
  secret that expires after 120 seconds, for a session of
  `type: "transcription"` with `gpt-live-transcribe`, `languages` =
  `TRANSCRIPTION_LANGUAGES`,
  `delay: "low"`, `turn_detection: null`, no `audio.input.format`. Its answer
  carries the secret's value in the existing token field, the provider name
  `openai` and the expiry as `expiresAt`. A missing or empty
  `value`, or one equal to the account key, is a 502 and the browser records
  instead (as the Soniox path refuses its account key at `token/route.ts:103`).
- `src/lib/transcribe/openaiLive.ts` (pure, like `sonioxLive.ts`): the data
  channel event reducer (deltas append to the draft keyed by `item_id`;
  `completed` replaces the draft with the final transcript), the commit event,
  and the stop rule (commit, then wait for `completed` up to 10 s, then close).
- `useDictation.ts`: for `provider: "openai"`, create an `RTCPeerConnection`,
  add the microphone track, open the `oai-events` data channel, post the SDP
  offer to C4 with the client secret, set the answer, and only then enter the
  recording phase. Any failure before that point (mint, SDP exchange, a 10 s
  connect deadline) starts the existing `MediaRecorder` path and the clip goes
  to `/api/transcribe` (D-dictation). A drop after recording started keeps the
  text already committed and shows the existing `dictation.connectionLost`,
  as the ElevenLabs and Soniox paths do. No detected language is reported for
  live text. Prewarming keeps its 45 s freshness; the secret lives 120 s.
  An OpenAI secret is minted again at each press. Any other warm token, or a
  remembered «no live mode», is spent only after one local read of
  `GET /api/transcribe/backend` still names its provider: a key saved again on
  another tab or device moves a held choice back to OpenAI without an event
  reaching this one. A session already connected keeps its own token.
- The account key never reaches the browser; only the short-lived secret
  does, as with the Soniox temporary key today.

### D-read. Read aloud

- `isPcmTtsBackend("openai")` becomes true (`src/lib/tts.ts:58-60`), so the
  client uses the existing PCM session (`ttsPcmSession.ts:56`, `:72`),
  chunker (`ttsChunks.ts:121`) and cache keying by the response headers.
- `src/lib/ttsOpenAiRealtime.ts`: one server WebSocket per `/api/tts`
  request with the existing socket factory pattern
  (`voiceCompanion/provider.ts:27-30`), the C2 session, item and response
  events, and a `ReadableStream<Uint8Array>` of decoded
  `response.output_audio.delta` bytes. It feeds the existing
  `boundedAudioStream` (32 MB cap, 60 s deadline, client abort, one release of
  the 3-synthesis admission). `response.done` with a non-`completed` status, an
  `error` event or a close before any audio is a 502 (OpenAI errors are 502
  today, `route.ts:220`); a failure after audio started errors the stream.
  Abort closes the socket. Nothing logs the text, the key or provider errors
  verbatim.
- Headers: `x-tts-backend: openai`, `x-tts-model: gpt-realtime-2.1-mini`, the
  voice actually used, `x-tts-encoding: pcm_s16le`, `x-tts-sample-rate:
  24000`, `x-tts-channels: 1`.
- Model and voice resolution in `ttsBackendInfo()` (`ttsBackend.ts:117-126`):
  the model is `gpt-realtime-2.1-mini`; an override from `LLV_TTS_OPENAI_MODEL`
  or `tts-model-openai` is honoured only when it names a `gpt-realtime` model.
  A Speech model name (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts*`) resolves to the
  default, because Speech shuts down. The voice is the configured one when it
  is in the Realtime list, else `alloy` (today's default and present in both
  lists). The info reports these resolved values, so the menu shows the voice
  that speaks.
- The Speech request (`route.ts:13`, `:87-93`) is removed. Existing OpenAI
  read-aloud users stay on OpenAI and move to the replacement model before
  the shutdown; this is the required migration, and their provider choice is
  untouched.

### D-voice. Voice Delegatus

- No provider code changes. `api` is the OpenAI choice; an opt-in moves a
  `codex` baseline to `api` while the key reads, and the next call falls back
  to `codex` when it does not. An active call keeps the provider and key it
  started with (existing). The enable switch and monthly cap stay separate;
  choosing the API backend never enables voice or starts a call.

## Key removal and restore (contract K)

Removal is required: the operator's decision describes the key-removed
behaviour, and today a key can only be replaced (`src/app/api/keys/[id]/route.ts`
exports `PUT` only; `docs/design/keys-settings.md` §12 deferred removal as not
asked). Scope is the OpenAI key only, the one whose removal has designed
behaviour.

- `DELETE /api/keys/openai`: `keysOwnerGate` (same origin, operator page, no
  agent capability, owner on a team install; `src/lib/keys/access.ts:41-49`),
  staging refusal as `PUT`. Source `env` → 409 `set_by_env` (the variable
  would still win); `missing` → 200 with the unchanged list (idempotent);
  `file` or `failed` → remove `configFilePath("openai-api-key")` under its
  file transaction and answer the masked list (`keyEntries(true)`). Any other
  id → 409 `not_removable`. Audit line `[keys] remove openai`, no value.
- After removal every reader (TTS, voice `providerKey`, transcription,
  classifiers through P3) sees `missing` on its next read. Held features run
  their baselines; legacy OpenAI features (no baseline) answer exactly as
  today without a key (read aloud 503, voice `NO_KEY`). Opt-ins are retained.
- Saving a key again (`PUT`, import, the legacy voice key route) makes held
  features effective on OpenAI at their next resolution. No other feature
  changes.
- A request between resolution and dispatch uses the credential its own
  resolution read; the next request resolves again. Tests cover deletion
  between a sweep's two messages and between role batches.

## Routes and authorization

| Route | Method | Gate | Contract |
| --- | --- | --- | --- |
| `/api/openai-services` (new) | GET | same origin; workspace decision `owner` | `{ openaiKey: KeySource, features: ServiceState[] }`, `Cache-Control: no-store`. `ServiceState` = P1 without `apiKey`, plus `options: { id, available, reason? }[]` in the feature's existing order with OpenAI last. Never carries a key or a masked key. |
| `/api/openai-services` (new) | PUT | `keysOwnerGate` | Body `{ feature, provider }`, bounded read (1 KB). 400 for anything outside the unions; 409 `locked_by_env`; 409 `unavailable` when the chosen provider's credential is missing (OpenAI without a key included), unless it is already the requested one. Writes through P4; answers the full GET body. |
| `/api/keys/[id]` | DELETE (new) | `keysOwnerGate` | Contract K. |
| `/api/tts/backend`, `/api/transcribe/backend`, `/api/voice-companion/settings` | POST/PUT | unchanged gates | Writes go through P4; GET bodies gain `requested`, `held`. |
| `/api/transcribe`, `/api/transcribe/token`, `/api/tts` | POST | unchanged gates | Dispatch from P3. |

`src/lib/team/workspaceRoutes.ts` gets `"/api/openai-services": "owner"`
(unknown routes are owner-only already, `:246-254`; the explicit entry keeps
the table complete for its test). The choice is installation-wide, like the
keys it depends on; no workspace or member adopts it, and a member's Keys page
does not show the list (the GET is owner-only).

## Backend file list

The backend stages create or change only these files (and their tests); they
edit no UI file.

- New: `src/lib/openaiServices/policy.ts`, `src/lib/openaiServices/decisions.ts`,
  `src/lib/ttsOpenAiRealtime.ts`, `src/lib/transcribe/openai.ts`,
  `src/lib/transcribe/openaiLive.ts`, `src/app/api/openai-services/route.ts`.
- Changed: `src/app/api/keys/[id]/route.ts`, `src/lib/keys/store.ts`,
  `src/lib/keys/access.ts` (audit action); `src/lib/asks/controller.ts`,
  `sweep.ts`, `view.ts`; `src/lib/memory/controller.ts`, `injection.ts`,
  `view.ts`, `viewTypes.ts`, `roleSelect.ts`; `src/lib/transcribeBackend.ts`,
  `src/app/api/transcribe/route.ts`, `token/route.ts`, `backend/route.ts`;
  `src/lib/ttsBackend.ts`, `src/lib/tts.ts`, `src/app/api/tts/route.ts`,
  `backend/route.ts`; `src/lib/voiceCompanion/storage.ts`;
  `src/lib/team/workspaceRoutes.ts`; `src/lib/transfer/sections.ts`.

## Tests the build owes

Behaviour only; no test inspects prompt or instruction wording. Every test runs
with isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`, builds
inputs with the production builders (`groundedRequest`, the role batch builder,
`ttsBackendInfo`, `transcribeBackendInfo`, `CompanionStorage`), fakes OpenAI
with the C1–C4 shapes (injected `fetch`, or a port-0 local WebSocket server
for C2), and never calls a vendor.

Each new control must be red against the pre-fix code (swap the production
file from the base commit in a scratch export; never `git stash`):

1. **Policy**: P3 for every feature over env lock / opt-in / key
   `file|env|missing|failed` / legacy native OpenAI; P4 from each writer (new
   route, mic route, TTS route, voice route), including OpenAI chosen without
   a key (new route 409; existing routes keep today's native write); saving
   and importing a key leaves
   every `requested` unchanged and creates no opt-in; remove → held → restore
   → effective OpenAI; a fresh module load (restart) resolves identically; an
   unreadable document resolves to baselines.
2. **Decisions adapter**: the exact request shape for asks, memory and rules
   (model, `input_json`, predicate names); parsing by name; refusal, missing,
   duplicate and out-of-range answers rejected; cost from usage including
   cached and cache-write tokens; ceiling ≥ computed cost for the fixture
   inputs; HTTP error bills zero.
3. **Asks sweep**: key removed between two messages → the second request goes
   to the baseline (or stops) with the new credential; score cache separated by
   provider.
4. **Role selection**: OpenAI path skips the credit check, writes
   `selector: "jev"` with the OpenAI `selectorVersion`, and the delivered block
   stays the whole snapshot; 429 → BM25.
5. **Read aloud**: against a local WebSocket server, PCM bytes arrive in order
   with the declared headers; `error`, early close and abort each release the
   admission once and close the socket; Speech model overrides and a `nova`
   voice resolve as D-read.
6. **Transcription**: multipart fields for C3; token route session body for C4
   and refusal of a returned value equal to the key; `openaiLive.ts` reducer
   (deltas, completed, out-of-order items).
7. **Routes through the production boundary**: `/api/openai-services` and
   `DELETE /api/keys/openai` called as route handlers behind the real
   `keysOwnerGate` and same-origin check: cross-origin, agent capability
   header, team member, staging, env-owned key, other key ids, malformed
   bodies; the GET body never contains a key or masked key.
8. **Status views**: asks and memory views report the effective provider's key
   state and `provider`.

Checks: the touched test files by path through `scripts/gate-slot.sh`, one at a
time; then, after the final merge of `origin/main`, the full typecheck
(`bunx tsc --noEmit`) through the gate slot; privacy publication on the changed
files; commits with hooks. `src/runtime-host/**`, `bin/**` and the
`Dockerfile` are not touched.

## Frontend brief: variant 3

### Surfaces and behaviour

1. **Keys page, OpenAI row** (`KeysMenuPage`, desktop 232 px panel and phone
   menu sheet). Directly under the OpenAI row, inside `data-keys-list`, a group
   hangs from the row's name column on the existing in-group left rule: one
   secondary label «Choose OpenAI in each setting», then six rows (lucide icon,
   feature name, one line naming the **effective** provider, chevron), in this
   order: Asks you (`MessageCircleQuestion`), Memory in chats (`Brain`),
   Learned rules (`ListChecks`), Dictation (`Mic`), Read aloud (`Volume2`),
   Voice Delegatus (`AudioLines`). When `held`, the line is amber
   «<provider>, no key». When the OpenAI key is present, a divider and the
   muted footnote «Codex agents keep signing in with their subscription.»
   close the group. Its data is one `GET /api/openai-services` when the page
   mounts and after any key change. The group renders in every key state; it
   is absent when that GET is refused (team member) or fails (no new notice;
   the rest of the page works).
2. **Feature page**, a new header-menu page under Keys (desktop `View` and
   `PhoneView`, parent `keys`, the existing back row with the feature name):
   muted «what it does» line; «Now <effective>»; for voice only, the existing
   «Show the voice» switch; the group label; a radio list in the onboarding
   dictation step's recipe, OpenAI last. Each option shows its name and note;
   an option that cannot be taken is disabled with its reason on its last line
   (muted); the OpenAI option without a key reads «No OpenAI key yet», or, when
   held, amber «Chosen before the key was removed», and carries one «Add the
   key» link beside it (phone) or under it (panel) that calls the existing
   `openKeys("openai")` and lands on the Keys page with the OpenAI field open.
   Options per feature:
   - Asks you, Memory in chats, Learned rules: OpenRouter («OpenRouter key»),
     OpenAI («OpenAI key»); group label «Who serves it».
   - Dictation: the existing four with `onboarding.voice.name.*` /
     `onboarding.voice.note.*`, then OpenAI «recording and live, with the
     key»; group label `onboarding.voice.heading`.
   - Read aloud: ElevenLabs, Soniox, Fish Audio, OpenAI («<Name> key»), a
     missing key reading «No <Name> key yet»; group label «Who serves it».
   - Voice Delegatus: `voiceCompanion.settings.backend.codex` («your Codex
     sign-in»), `voiceCompanion.settings.backend.api` («OpenAI key · its own
     monthly cap»); group label `voiceCompanion.settings.backend`.
   - Environment lock: every radio disabled and the existing lock sentence of
     that feature's menu under «Now …».
3. **Choosing**: optimistic. The radio and «Now …» change on click; `PUT
   /api/openai-services` runs in the background; a failure rolls back to the
   last server state and shows the existing keys error style (`role="alert"`)
   in place. The Keys list refetches on return and on `KEYS_CHANGED_EVENT`.
4. **Removing the key** (contract K): the OpenAI row's existing «⋯» menu gains
   «Remove» when the key is file-held, the caller is the owner and the release
   is not staging. It opens one confirmation line in the row's flow, «Remove the
   OpenAI key from this computer?», with «Remove» and the existing «Cancel».
   This one waits on the server (irreversible): the button is busy until the
   answer, then the row shows its existing «Not set» and «Add», a success note
   «OpenAI key removed» in the existing saved-note recipe, and the list
   refetches (held features turn amber). A failure keeps the key and shows the
   error in place.
5. **Restoring**: saving a key with the existing field refetches the list;
   held features return to OpenAI with no other change.
6. **Existing selectors kept consistent**: the mic menu lists OpenAI
   (`stt.openai.name`, `stt.openai.desc`) from the server's options, and an
   OpenAI pick without a key calls `openKeys("openai")` where other providers
   open the menu's key popup; the
   onboarding dictation step shows OpenAI as a fifth option with the same row
   (without a key: disabled, «No OpenAI key yet», «Add the key»);
   the read-aloud and voice menus need no change because their GET bodies
   already report the effective provider; the memory page's «enter key» button
   opens `view.provider`'s key.
7. **Letting a held choice go**: on a held feature the provider serving it now
   is drawn checked, and pressing it is the decision to stay there. Each
   feature page, the onboarding dictation step, the read-aloud menu and the
   voice settings dialog send that choice, which clears the remembered OpenAI
   opt-in, so a key saved later moves nothing back. Pressing a checked choice
   that is not held still sends nothing.

No other chrome, notice, pill, badge, branding or colour. Status is a word or a
dot already used on the page.

### Strings (en / uk)

Every row is the approved prototype's text except the last seven, which are new
(the removal flow, the mic menu entry and the classifiers' own explanations
while OpenAI serves them).

| Key text (en) | uk |
| --- | --- |
| Choose OpenAI in each setting | OpenAI вибирається в налаштуваннях |
| Codex agents keep signing in with their subscription. | Агенти Codex і далі входять за підпискою. |
| Memory in chats | Пам’ять у розмовах |
| Read aloud | Читання вголос |
| <name>, no key | <name>, без ключа |
| Now <name> | Зараз <name> |
| Who serves it | Хто це обслуговує |
| <Name> key | ключ <Name> |
| No <Name> key yet | Ключа <Name> ще немає |
| Chosen before the key was removed | Було вибрано, доки ключ не прибрали |
| Add the key | Додати ключ |
| recording and live, with the key | запис і наживо, за ключем |
| your Codex sign-in | ваш вхід у Codex |
| OpenAI key · its own monthly cap | ключ OpenAI · свій місячний ліміт |
| Spots the moment an agent waits for your answer. | Помічає, коли агент чекає на вашу відповідь. |
| Picks memories to add to your messages. | Добирає спогади до ваших повідомлень. |
| Scores rules for new agents. A trial for now: agents still get every rule. | Оцінює правила для нових агентів. Поки пробно: агенти отримують усі правила. |
| The microphone in the message field: a recording and live text. | Мікрофон у полі вводу: запис і живий текст. |
| Reads an agent's answer out loud. | Читає відповідь агента вголос. |
| Calls with Delegatus and the tools it uses in them. | Дзвінки з Delegatus та інструменти, якими він у них користується. |
| Remove | Прибрати |
| Remove the OpenAI key from this computer? | Прибрати ключ OpenAI з цього комп’ютера? |
| OpenAI key removed | Ключ OpenAI прибрано |
| OpenAI (mic menu name) / recording or live, with an OpenAI API key | OpenAI / запис або наживо, за ключем OpenAI API |
| Off, for all projects. When on, the last message of each agent's turn is sent to OpenAI to spot a question for you. No other text leaves this machine. | Вимкнено для всіх проєктів. Коли увімкнено, останнє повідомлення кожного ходу агента надсилається в OpenAI, щоб помітити питання до вас. Інший текст не залишає цю машину. |
| On, for all projects: each agent's last message of a turn goes to OpenAI. This month {spent} of {cap}. | Увімкнено для всіх проєктів: останнє повідомлення кожного ходу агента йде в OpenAI. Цього місяця {spent} з {cap}. |
| A small OpenAI model picks memories to add to your messages. | Невелика модель OpenAI добирає спогади до ваших повідомлень. |

Reuse existing keys where the text already exists: `asksYou.label`,
`roleMemory.row`, `onboarding.voiceTitle`, `voiceCompanion.settings.label`,
`voiceCompanion.settings.enable`, `keys.cancel`, `keys.state.missing`,
`keys.add`. Ukrainian text carries no Latin word except provider and product
names; a one-letter word never ends a line.

### Frontend keep-list (the only UI files the frontend stages edit)

- `src/components/keys/KeysSection.tsx` (group under the OpenAI row, «Remove»
  menu item and confirmation), `KeysSection.dom.test.tsx`.
- `src/components/keys/OpenAiServices.tsx` (new: the list and the feature
  page), `OpenAiServices.dom.test.tsx` (new).
- `src/components/headerMenu/HeaderMenu.tsx` (the feature-page view on desktop
  and phone).
- `src/components/MicButton.tsx`, `src/components/onboarding/VoiceStep.tsx`
  (OpenAI option).
- `src/components/feed/SpeakButton.dom.test.tsx` (Realtime PCM contract fixtures).
- `src/components/memory/MemoryPage.tsx` («enter key» opens the effective
  provider's key; its explanation names OpenAI while OpenAI serves memory,
  `memoryPage.openai.explains`).
- `src/components/AsksYouRow.tsx` (its hint names OpenAI while OpenAI serves
  «Asks you», `asksYou.openai.off` / `asksYou.openai.on`, and OpenRouter's Jev
  otherwise), covered with the memory page in `OpenAiServices.dom.test.tsx`.
- `src/hooks/useDictation.ts` (the OpenAI live transport over the backend's
  `openaiLive.ts`).
- `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts`.
- `src/components/voiceCompanion/VoiceCompanionSetting.tsx` (the voice
  settings dialog: pressing its checked backend while the API choice is held
  sends that backend), covered in `OpenAiServices.dom.test.tsx`.
- `src/components/feed/SpeakMenu.tsx` (one line: OpenAI read aloud is billed
  by tokens on Realtime, `tts.billingTokens`, where the other providers keep
  their per-character or by-size wording), with its expectation in
  `SpeakButton.dom.test.tsx`.
- The tests of the files above: `src/components/onboarding/VoiceStep.dom.test.tsx`,
  `src/hooks/useDictation.languages.dom.test.tsx`.
- Capture: one case, `openai key services`, in
  `src/components/mobile/issue1671Evidence.browser.test.tsx`, beside the «Keys»
  case that already frames the header menu (1440, 820) and the phone sheet
  (390) over the kanban fixture; `issue1695Evidence.fixture.tsx` hands the
  provider routes to the driver under `&openai=1`. No new driver, no file
  named after an issue.

The page sends its choices one after another, so the server keeps the last one
pressed; an answer to an older choice never replaces a newer one on screen.

Backend stages edit no file above except the i18n files when a server message
needs a key (none is planned). Frontend stages edit nothing outside this list.

### States to render and capture

Defining element named per state; each must be visible text on the first
screen of the page it belongs to.

| # | State | Defining element |
| --- | --- | --- |
| K1 | No OpenAI key, no opt-ins | the group label and «Not set» on the OpenAI row |
| K2 | Key saved | footnote line under the six rows |
| K3 | Asks you, Dictation, Voice Delegatus on OpenAI | «OpenAI» on those three rows |
| K4 | Key removed with K3's choices | amber «<previous>, no key» on those rows |
| K5 | Key saved again | «OpenAI» back on the K3 rows |
| K6 | All six on OpenAI | «OpenAI» on six rows |
| K7 | Remove confirmation open | the confirmation question |
| F1–F6 | Each feature page, no key | OpenAI disabled with «No OpenAI key yet» and «Add the key» |
| F7–F12 | Each feature page, OpenAI chosen | «Now OpenAI», OpenAI checked |
| F13–F18 | Each feature page, key removed | «Now <previous>», amber «Chosen before the key was removed» |
| F19 | Read aloud on the legacy OpenAI default with no key | «Now OpenAI», OpenAI checked and disabled, «No OpenAI key yet» |
| F20 | Dictation locked by the environment | the lock sentence, radios disabled |
| E1 | Memory on OpenAI, its page in the header menu | «A small OpenAI model picks memories…» |
| E2 | «Asks you» on OpenAI, its row in the board menu or the phone's ⋯ sheet | «…is sent to OpenAI to spot a question for you…» |

Matrix, bounded at 244 frames: every state at 390 × 844 (phone driver, touch)
and 1440 × 900 (kanban driver) in en and uk, light and dark (27 × 8 = 216),
plus K1–K7 at 820 × 900 in the same four language and theme pairs (28).
E1 and E2 add 16 frames at 390 and 1440 in the same pairs, run by
`LLV_OPENAI_ONLY=explains`. Data:
the invented installation of the prototype (OpenRouter, ElevenLabs, Soniox and
Telegram keys present; Fish Audio absent; previous providers Soniox for
dictation, ElevenLabs for read aloud, Codex for voice). No credential-shaped
value anywhere; masked tails only. One driver interaction run per driver
performs the real sequence: open Dictation, pick OpenAI (optimistic), back,
remove the key through «⋯ → Remove → Remove», see K4, let «Asks you» go by
pressing OpenRouter on its held page, save a key through the field, see K5 with
«Asks you» still on OpenRouter; each step is asserted on visible text.

Per frame, from text ranges: the defining element whole on the first screen;
nothing outside the viewport or cut by a scroll edge, the pinned sheet header
or a clipping ancestor; no overlap with foreign text; no sideways overflow;
targets ≥ 44 px under touch and ≥ 24 px under a pointer; text contrast at the
platform floor; neighbouring states with distinct words; no nested interactive
elements (the «Add the key» link sits beside the radio's label, never inside
it). Every frame is opened and looked at before it is cited. The old 558
prototype frames are not re-rendered.

## Risks and unknowns (none blocks the build)

- **Read-aloud fidelity**: the Realtime recipe tells the model to read the text
  without commentary; no API field guarantees verbatim speech. Delegatus
  already shows the text being read; a spoken deviation is visible to the
  operator. The response's output transcript could be compared with the input
  later if needed (Deferred).
- **Classifier calibration**: thresholds 0.85, 0.70 and 0.30 were chosen on
  Jev scores. OpenAI's guide asks for thresholds set on one's own labelled
  data; that needs paid calls and is deferred. The operator chose OpenAI as an
  opt-in alternative, and OpenRouter stays the default.
- **Live transcription path**: C4's client-secret-to-WebRTC sequence is
  documented step by step, without one end-to-end transcription example. The
  fallback to the recorded path keeps every utterance if the connection fails
  before recording begins.
- **Latency and price per call** for Realtime read aloud (one socket per
  chunk) and for Decisions against Jev are unmeasured; this design claims no
  speed gain and no saving.
- **Credits**: availability, eligibility and balance belong to the operator's
  OpenAI organization; the product claims none of them.

## Deferred — not currently justified

- Paid calibration of OpenAI classifier thresholds, quality comparison with
  Jev, and any first-audio latency or price benchmark (each needs paid calls and
  separate authorization).
- Comparing the Realtime output transcript with the read-aloud text.
- One Realtime socket per read-aloud session across chunks.
- Removing keys other than OpenAI, key testing against a provider, automatic
  credit or balance discovery.
- Tightening the existing feature routes (`/api/tts/backend`,
  `/api/transcribe/backend`) from same-origin to operator-only.
- Telegram voice transcription or speech replies (no caller exists).
- Call-memory summaries and memory profiles on OpenAI Responses (they run on
  the managed Claude subscription CLI today).
- Routing coding-agent accounts, Codex sign-in or the Claude provider relay
  through the saved key; the key never serves agent CLI login, quota or account
  fallback.
- A provider plugin framework, a new secret store, a «move everything» switch,
  role presets or account-pool changes.
- The research replay tools in `scripts/memory-selection.ts` on Decisions.

## Validation against the requirement

- «Choose what OpenAI serves once a key is saved»: six features listed under
  the OpenAI row, each with its own choice (variant 3); saving a key switches
  nothing (P4, test 1).
- «OpenRouter or OpenAI for the classifier»: D-asks, D-memory, D-rules on C1,
  OpenRouter default.
- «Read aloud, fast transcription, voice Delegatus»: D-read on C2 (with the
  required Speech migration), D-dictation and D-live on C3/C4, D-voice on the
  existing API backend.
- «Not for Codex»: no agent path reads the key (Deferred); the footnote says
  so once on the Keys page.
- Key removed: previous provider runs, choice remembered, restored on a new key
  (P3, contract K).
- Every shown choice reaches its caller: the same resolver answers the
  settings views and the dispatching routes (P5).

## Notes for the stages

- Backend first (P, C1–C4 adapters, routes, K, tests), then frontend on the
  same branch after the backend review passes. Merge `origin/main` by a merge
  commit before the final typecheck.
- This path also exists, older, on the #3491 branch; whichever merges second
  resolves the conflict by keeping this version.
- No ADR: the choice is reversible (delete the opt-in document) and the
  trade-offs are recorded here.

## Verification of this document

Written from `origin/main` at `10294c94` and the OpenAI documentation read on
2026-10-29 between 22:22 and 22:45 UTC; prototype facts from `109100568` and its
retained frames (variant 3: 390 uk light no-key and switched lists, removed
dictation page, 1440 en no-key «Asks you», removed list, switched dictation in
dark, 390 en dark voice and read aloud pages, each opened and inspected). Checks
run on this file: whitespace (`git diff --no-index --check`) and the
repository's privacy publication gate with the committed fingerprints in an
isolated environment.
