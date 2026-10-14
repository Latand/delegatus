# Dictation language investigation — 2026-10-14

Recorded before implementation, against base `b9b7fabdaa06f8b2789e57a0fd6a7341b8ad72b6`.

The serving Viewer answered `backend: soniox`, `lockedByEnv: false` from the
read-only `GET /api/transcribe/backend`. The configuration file
`$HOME/.config/delegatus/transcribe-backend` contains `soniox`; the serving
Viewer environment has no `LLV_TRANSCRIBE_BACKEND` override. No keys were logged.

`src/lib/transcribeBackend.ts:24` resolves the environment, then the config
file, then the local default. The composer uses `src/hooks/useDictation.ts:528`
to select Soniox live when its token is available. Its socket starts at
`src/hooks/useDictation.ts:413`, calling `sonioxStartRequest` without language
hints. `src/lib/transcribe/sonioxLive.ts:52` only sends hints when supplied;
it sends no strict option. Thus normal composer dictation uses unrestricted
Soniox language detection. The batch fallback at
`src/hooks/useDictation.ts:358` also sends no language; the route at
`src/app/api/transcribe/route.ts:57` passes an empty hint through to
`src/lib/transcribe/soniox.ts:46`, which omits hints entirely. This identifies
the configured path and both possible transports; no retained audio or provider
request record is available to distinguish the incident transport conclusively.

The UI supports Ukrainian and English. The existing voice initial-language rule
is Ukrainian for `uk`, English otherwise (`sessionConfig.ts:26`). Single-language
STT will use the same locale choice, accepting Russian when explicitly supplied.
The dictation hook currently reads only the translation function, so batch and
ElevenLabs live need to carry the UI locale explicitly.

Memory and transcript searches found no prior solution to this language restriction.
