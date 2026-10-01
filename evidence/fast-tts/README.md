# Fast Soniox speech evidence

The final cold comparison used the exact 329-character answer and configured voice in `docs/design/fast-tts.md`: Soniox `tts-rt-v2`, Adrian, English. Both revisions ran in Chromium 151.0.7922.71 at 390 × 844 through their production component, client and route, an ephemeral loopback HTTP adapter and the real configured provider key. Configuration loaded before each tap; every trial used a fresh browser context/page. The key remains on the server.

| Measurement | Result |
| --- | --- |
| Baseline median among successful signals | 18,089.3 ms; 8 signals in 10 attempts |
| Candidate median | 497.3 ms; 10 signals in 10 attempts |
| Candidate nearest-rank p95 | 713.9 ms |
| Cached replay | 65.4 ms; no new synthesis requests |
| Complete live read | 219 scheduled blocks; contiguous joins within floating-point rounding |

`latency.json` retains successful timings, failures, audio-clock schedules, browser latency terms, chunk ranges, formats and cache state. Two baseline attempts exceeded the 45-second speech-signal budget. The later attempt recorded HTTP 200; the earlier attempt did not capture HTTP status. A six-pair run was interrupted at the first failure and resumed with that failed attempt preserved. The initial completed ten-pair cohort is retained as console-returned timings in `initial-latency.json` (18,110.7 → 494.55 ms medians). `replay-latency.json` retains the earlier separate replay observation.

The measurement samples the first unmuted browser signal above amplitude 0.001 every 2 ms. It excludes the silent HTML-audio unlock clip. TTFB and calls to `play()` do not supply these onset numbers. Browser output latency is recorded separately, without adjustment of the measured signal. Physical iPhone/Safari, speaker output and the remote phone network remain unmeasured and require operator acceptance or a device run.

`phone-renders.json` includes a real AudioWorklet capture of 172,800 known PCM samples through the production button/client/route with the provider stubbed. Chunk IDs appear exactly once in order, with zero mismatches across both joins during a 500 ms UI-thread stall. Stop left no samples beyond its recorded audio clock in that run; the gate permits one 128-sample render quantum. Cached replay made zero provider calls. Provider-generated silence remains intact; network starvation enters loading and preserves the unread cursor.

`provider-duration.json` records a real slow/numeric PCM probe: speed 0.7, 12.032 seconds of audio, complete within 10.07 seconds of the request. A preceding denser numeric probe hit its 60-second deadline, so no complete duration is claimed for it. The application stops a chunk approaching 115 seconds or exceeding its memory budget. The request fields and PCM output are documented in the [Soniox reference](https://soniox.com/docs/api-reference/tts/generate_tts); observed byte limits and quota sources are recorded in the design.

The existing phone and desktop browser drivers capture idle/loading/playing/error, shared row/header Stop, attention/report overflow, provider settings, full-window transfer and a 360-pixel orchestrator dock. Images are saved under `$HOME/Pictures/delegatus-review/fast-tts/`; the PR lists their filenames. All rendering uses invented fixture content. The operator's reference image stays private.

## Checks

All heavy gates use `flock /var/tmp/llv-heavy-gate.lock`. Tests use the repository's private-state preload; builds use a dedicated state/config root. External calls are stubbed in automated controller/route tests. Live latency and duration probes are explicitly opted in.

- Explicit TTS files: `tts.test.ts`, `ttsBackend.test.ts`, `ttsChunks.test.ts`, `ttsAlignment.test.ts`, `api/tts/route.test.ts`, `speakableAnswer.test.ts`, `ttsSession.dom.test.ts`, `ttsKaraoke.dom.test.ts`, `SpeakButton.dom.test.tsx`, `SpeakMenu.placement.test.ts`: 120 pass under pinned Bun 1.4.0.
- `MobileFocusView.conversation.dom.test.tsx`: 14 pass, run alone to avoid cross-file mock pollution.
- Existing phone/desktop browser drivers, `-t 'fast TTS header'`: pass under Bun 1.4.0 in light/dark at the required viewports, including native output and overflow cases.
- TypeScript, production build plus MCP bundle, focused lint, privacy publication and both runtime rehearsals: results are in the PR. The Viewer rehearsal loads 22 server modules and requires HTTP 200; the host rehearsal drives two generations and their listener succession in private state.
- Full source lint reproduces 506 errors and 267 warnings on both the candidate and an unchanged export of its main base. The unchanged `mobileHeaderFit` suite has five failures on both; its added speech-width case passes. `KanbanReaders` has the same two pre-existing failures on base and candidate (13 pass, 2 fail). These failures are recorded separately from feature verification.

Reproduce renders with `LLV_SWIPE_BROWSER_TEST=1` / `LLV_KANBAN_BROWSER_TEST=1` and `CHROME_BIN`, using the two existing browser files. Add `LLV_TTS_LIVE_LATENCY=1` to opt into ten paired paid provider trials; `LLV_TTS_LIVE_REPLAY=1` runs the replay probe, and `LLV_TTS_RESUME_LATENCY=1` continues a preserved interrupted cohort.

Soniox highlighting is aligned to the sentence batch on the audio clock. REST supplies no word timestamps; exact Soniox words remain outside this change. Cached seeking is proportional, and an unfinished chunk restarts at its boundary. OpenAI and ElevenLabs retain their audio/alignment path. The current read freezes its answer, text and offsets at tap time; newly appended text is available on the next read.
