# Dictation languages

Dictation recognizes Ukrainian (`uk`), Russian (`ru`) and English (`en`).
`TRANSCRIPTION_LANGUAGES` in `src/lib/transcribe/languages.ts` is the shared set
for composer batch uploads, live sockets and native voice instructions.

The composer sends its UI locale to batch transcription and uses it as the
primary ElevenLabs realtime language. The interface has Ukrainian and English
locales. Single-language providers use that locale, and accept Russian when a
caller supplies it explicitly. Regional and ISO-639-3 forms normalize to the
allowed two-letter code. Missing or unsupported hints choose Ukrainian, the
first allowed language; they never omit the provider language parameter.

## Provider controls verified on 2026-10-14

| Path | Request control | Official source |
| --- | --- | --- |
| Soniox batch | `language_hints: ["uk", "ru", "en"]`, `language_hints_strict: true`, `enable_language_identification: true` | [Create transcription](https://soniox.com/docs/api-reference/stt/transcriptions/create_transcription) |
| Soniox live | The same hints, strict flag and language identification in the socket start request | [WebSocket API](https://soniox.com/docs/stt/api-reference/websocket-api), [language restrictions](https://soniox.com/docs/stt/concepts/language-restrictions) |
| ElevenLabs Scribe batch | One explicit `language_code`, chosen from the UI locale | [Create transcript](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) |
| ElevenLabs Scribe realtime | UI locale in `language_code`; the remaining allowed languages as repeated `secondary_languages` query parameters | [Realtime](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime), [official SDK serialization](https://github.com/elevenlabs/elevenlabs-js/blob/main/src/wrapper/realtime/scribe.ts) |
| ChatGPT batch adapter | One explicit `language` multipart field, chosen from the UI locale | [OpenAI transcription parameter reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) |
| Local faster-whisper | One explicit `language` with `multilingual=False`; the Python wrapper reports the model's language | [WhisperModel.transcribe source and parameter documentation](https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py) |

Soniox documents strict hints as a strong restriction and warns that multiple
languages can still produce a wrong script in ambiguous audio. Keeping all three
languages supports mixed speech. An overridden Soniox model that rejects the
strict flag fails the request; the application never retries without it.

ElevenLabs batch documents a single language code and automatic prediction when
it is omitted. Realtime additionally documents a secondary-language list that
focuses identification on the specified set. The application always supplies
the primary code and the two secondary codes for realtime.

The ChatGPT adapter uses `chatgpt.com/backend-api/transcribe`, which has no
published official endpoint schema. The official OpenAI reference above verifies
the public transcription `language` parameter; it does not establish a hard
restriction contract for the private ChatGPT endpoint. This change retains the
adapter's existing field and endpoint, normalizes its value and always sends it.
No public API model or multi-language field is assumed for that private endpoint.

## Unexpected provider language

When a provider reports a language outside the set, retain its text and tag the
result with the preferred allowed language. For batch requests, that preference
is the normalized request/UI language. Soniox live uses Ukrainian, the first
allowed language, and retains a tag across final-token and endpoint frames.
ElevenLabs live uses the session's UI locale. Allowed ISO-639-3 codes normalize
to `uk`, `ru` or `en`. A response with no language metadata keeps the existing
text-only shape. Live committed segments carry the normalized tag to their
callback. This rule normalizes metadata; it does not rewrite text or promise to
repair a provider's spelling.

## Voice companion

The API voice companion uses native GPT-Live audio; Codex voice uses its native
realtime transport. Neither invokes a separate dictation STT backend. Both use
`liveInstructions` in `src/lib/voiceCompanion/sessionConfig.ts`, which includes
the recognition instruction generated from the shared set.

The [official Live session schema](https://developers.openai.com/api/reference/resources/live/methods/create)
exposes audio output voice settings and instructions, with no input STT language
field. [Live transcript events](https://developers.openai.com/api/docs/guides/live-conversations#transcript-deltas)
contain text and timing without a detected-language code. Therefore native voice
uses the shared instruction; it has no API-enforced language filter or returned
language code to normalize. A prompt cannot guarantee the recognizer's script.
The voice ask/tool rules and TTS paths are outside this change.

## Investigation and verification

The configured machine path was recorded before implementation in
[evidence/dictation-languages/path.md](../../evidence/dictation-languages/path.md),
with base file locations and the serving backend response. It identifies Soniox
live as the normal path and Soniox batch as its fallback; no provider request
record proves which transport handled the incident clip.

[evidence/dictation-languages/verification.json](../../evidence/dictation-languages/verification.json)
records the final regression tests replayed on the starting commit and on the
implementation. Tests intercept HTTP/process boundaries or use a fake local
model; none calls a live provider. Every run uses an isolated HOME, XDG config,
temporary directory and `LLV_STATE_DIR`, through `scripts/gate-slot.sh`, with
explicit test paths. The composer DOM tests exercise live socket construction,
committed-segment language tags and actual multipart batch fallback requests.
