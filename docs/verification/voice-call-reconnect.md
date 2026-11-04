# Voice reconnect: slices 0 and 1

During a call, a failed peer, closed data channel, failed poll or provider drop starts
automatic reconnection. End remains available. The call keeps its conversation,
microphone and mute setting. The phone clock continues through the attempts.

After give-up, open the phone head's menu or use Reconnect in the desktop lane.
Reloading offers the dropped call for manual continuation. It starts no automatic call.

The loop allows 60 seconds of runnable online time or eight attempts, with at most six
automatic reconnects per ten minutes on the page holding the call. Retry delays are
0–300 ms, then 1, 2, 4 and 8 seconds, with 25% jitter on the backoff. An attempt has
15 seconds for its offer, same-key recovery and readiness. Offline time and a hidden
phone page pause the retry clock. Returning online wakes an eligible attempt.

The disconnect cue sounds once, then a soft tick every five runnable seconds, then
the connect or give-up cue. The sound preference governs all of them. The restored
notice says only that the connection returned. The spoken cut position and question
belong to slice 2. Provider storage remains disabled; continuation uses the journal.

## Acceptance map

All test paths below are explicit file selections, run through `scripts/gate-slot.sh`
with private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, and the Viewer control
URL on closed port 1. Each file has its own owned runner and log.

Short names in the table:

- **A**: `src/lib/voiceCompanion/liveAdapter.test.ts` — production adapter, store and
  service, with fake media and `FakeLiveProvider`; other requests still reach the
  service when a start answer is lost.
- **R**: `src/lib/voiceCompanion/callResume.test.ts` — journal, resume, lease and retry
  schedule tests.
- **L**: `src/lib/voiceCompanion/liveSession.test.ts` — server close paths and the
  concurrent lease acquisition test.
- **H**: `src/app/api/voice-companion/session/route.test.ts` — actual route validation,
  ownership, episode records and timing metadata.

| Acceptance | Test or frame |
| --- | --- |
| Provider `connection_lost`, `expired`, `remote_hangup` retain final usage and resume; `content` does not | R, `provider close …: final usage preserves the close cause and resume eligibility`; persisted reader after restart |
| Native Codex unsolicited close records its source; an explicit hang-up stays final | R, `an unsolicited native Codex close …` |
| Browser and server close paths write their causes | H, `browser drop causes …`; L, `sideband`, `provider-error`, `watchdog` cases; R, Viewer restart; H, refused mint; A, lost answer chain |
| A three-second ICE blip mid-reply writes one episode and leaves the call up; malformed input is refused | A, `a three-second ICE episode …`; H, `browser drop causes and ICE episodes …` |
| Reconnect timing is journalled and validated | H, `resume timing is bounded at the route …` |
| Failed peer and failed poll reconnect within 300 ms, with one capture, retained mute and one cue each | A, `failed peer mid-reply …` and `failed poll mid-reply …` |
| One lost answer recovers the exact offer and request key, keeping that session open | A, `1 lost start answers …`; R, `same-key replay keeps the minted resume open …` |
| Two lost attempts, including their same-key retries, produce one chain with at most one attached provider | A, `4 lost start answers …`; checks every mint and every `resumes` link |
| Unheard parts close as transport with `answer-lost`; failed attempts publish no restored state | A, the four-answer case, under five seconds between mints on the fixture clock |
| A tapped reconnect losing its answers leaves the part resumable for the next tap | A, `a manual reconnect losing both answers …` |
| End behind an unanswered mint hangs it up and cancels retries; End in backoff preserves the offer | A, `End behind an unanswered mint …` and `a same-key replay after its part closed …` |
| Same-key replay of a closed part answers SESSION_CLOSED; the next attempt follows it | R, same-key replay test; A, same-key replay after close |
| The first poll of the new part can fail without ending the call chain | A, `resumed first poll fails and retries` |
| Playback refusal closes as transport and stops automatic retries with a resumable offer | A, `resumed playback refusal stops …` |
| Another page polling the successor prevents an older-page resume from closing it | R, `a page following an older part cannot close a successor another page polls` |
| A lease taken during recovery refuses before any part is created; retry follows the winner | L, `a lease set while a resume awaits recovery …` |
| Concurrent starts with one request key join one mint; End remains final when a late provider drop arrives | R, same-key concurrent start and explicit hang-up with late provider close |
| A provider answer lost to the Viewer stops on MINT_UNCERTAIN and mints no second replacement | A, `an uncertain provider mint …`; H, uncertain mint and restart cases |
| Retry cadence, 60-second and eight-attempt bounds, terminal refusal, five-second ticks and one give-up cue | R, runnable-clock schedule and slow-attempt tests; A, SESSION_UNAVAILABLE/MINT_UNCERTAIN cases and six-reconnect cap |
| Reload offers Reconnect without automatic start | R, runnable-clock reload test and reloaded page case; product DOM test, phone reload after a later drop |
| Actual media retains capture, output and context across peer replacement, including a failed offer; stale peer callbacks have no effect | `src/lib/voiceCompanion/media.test.ts`, replacement, failed replacement offer and pending-capture cases |
| New retry sounds respect gain, duration and mute preference | `src/lib/voiceCompanion/cues.test.ts`, retry tick/give-up case |
| Same conversation remains mounted and readable after automatic reconnect | `src/components/voiceCompanion/voiceCompanionProduct.dom.test.tsx`, desktop and phone reconnect cases |
| Reconnecting, restored and gave-up render in en/uk and light/dark; End stays available, Reconnect appears after give-up; phone clock survives | Existing browser cases named `automatic voice reconnect` in the board and phone drivers; manifests below |

## Rendered evidence

`evidence/voice-companion/reconnect-desktop.json` records twelve frames at 1440 × 700.
They use the existing board driver's geometry underlay and the actual floating
component, adapter and store. This underlay does not establish fit over a populated
board. `evidence/voice-companion/reconnect-phone.json` records twelve frames at
390 × 844 over the phone product shell and populated conversation.

Each combination has `reconnecting`, `back` and `gave-up` frames under
`.artifacts/voice-reconnect/desktop/` or `.artifacts/voice-reconnect/phone/`.
The drivers check text ranges against inner clipping ancestors and the viewport,
available controls, a single capture and the give-up cue. The phone also checks its
clock across a held reconnect. Compact phone notices preserve two complete lines;
Reconnect remains in the head's menu.

## Stored and browser contracts

The close route accepts only the browser cause allowlist alongside `transport`.
Server causes are assigned by the service. Admission writes cause and episode into
`session_end`; the journal reader and history retain them. `content` is a terminal
contract reason outside `DROP_REASONS`.

The media emits connection episodes; the adapter posts the episode command; the
route validates it; the service writes a `connection` journal row. The simulator
ignores this diagnostic command. Episode values never submit speech, tools or usage.

The store supplies reconnect metadata to the adapter and route. The service records
attempt number, automatic/manual mode and notice-to-start/ready offsets. `resumedBy`
is an optional stored field: earlier rows default to no successor. The service first
answers a known mint key, otherwise follows the chain with owner checks and a bound,
closes an unpolled successor, then rechecks and claims the lease before its mint.
Readers of a continued part return its retained events. Reservations and uncertain
mints continue to fence new paid work.

## Live acceptance still required

Run one phone trial on each backend: interrupt the network for five seconds during a
reply and verify that the call returns without a tap. Record device/browser, cause,
attempt count, notice-to-ready time and whether sound needs activation. With a local
Viewer on desktop, hold the network loss until ICE fails and record that interval.

These real-device trials and provider latency percentiles are separate from the
synthetic seams and frames above. No live installation or network was altered by the
automated checks. Publication creates the PR on which the required
`privacy-tracker-audit` and `runtime-gate` CI contexts can run.
