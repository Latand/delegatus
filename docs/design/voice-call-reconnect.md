# Voice call reconnect: the call comes back by itself and goes on from where it stopped

Design only; no product code. Task `de4377a6`, pipeline `64b8f113`. Written against
`main` at `c97325311` on 2026-11-01. Every `file:line` below refers to that commit.

## The requirement

Operator request, 2026-11-01, spoken in a voice call. Voice Delegatus sent it to the
orchestrator at 09:16:53 UTC (the call journal's `request` row) and the seat received
it at 09:17:43 UTC; the brief dates it about 08:55 UTC. The relay is Voice Delegatus's
paraphrase of the speech and carries no verbatim line. In English:

> Work out and file a task to improve recovery after connection drops: on reconnect,
> carry on quickly and well from the same moment where it stopped, modelled on how
> comfortable reconnecting is in Google Meet. Expected result: a worked-out approach and
> the matching project task.

The project task exists («Голосовий дзвінок сам відновлюється після обриву, як у Google
Meet», `de4377a6`). The call in which the operator asked for this dropped 43 seconds
after the request went out, and the operator brought it back by tapping Reconnect
10.4 seconds after the drop (§1.4).

The pinned specification asks the document to cover: how drops happen today and what
is lost; the target experience with Google Meet as the reference; the mechanism
(detection, retry policy, client and server state, a resume cursor, idempotency,
provider limits); one set of cues and words shared with the hands-free design
(`2753d517`); and a build plan in thin slices with testable acceptance and
measurements. Places that need an operator choice are marked **Choice D1…D4** and
collected in §6.

Google Meet is the operator's reference for how reconnecting should feel. This document
takes from it only the properties the specification lists (no click, a calm
"reconnecting" state, the call keeps its identity, nothing lost or repeated) and makes
no claim about how Meet is built.

## Sources read first

- `docs/design/voice-call-memory.md:591-669`, "A dropped call resumes" (operator
  request 2026-10-22; merged as #3197 with `47c99dec6`, `016841b68`, then `34d5f21f0`
  for call history). It built today's one-tap Reconnect, the `resumes` chain and the
  continuation block. Its review notes: the desktop Reconnect had DOM tests and no
  rendered frame; the phone driver case covers drop, reload and Reconnect at 390 px
  (`src/components/mobile/issue1671Evidence.browser.test.tsx:11860`).
- `docs/design/voice-companion-research.md:420-460`: mint idempotency, uncertain mints
  and why a lost mint answer blocks every later start on the API backend.
- `docs/design/voice-mode-explained.md:619-635`, §10 "Call lifetime and restart": a
  call never survives a Viewer restart; the vendor's close reasons.
- `docs/design/voice-delegatus-live-feedback.md:574-612`, item 5: the connect and
  disconnect cues.
- The hands-free task `2753d517` («Повністю hands-free режим голосового Delegatus»):
  blocked, its design lane `d122e4c7` paused before any stage ran, and
  `docs/design/voice-hands-free-mode.md` does not exist on `main` or in any pipeline
  worktree on this machine (checked 2026-11-01 10:00 UTC). §4 is therefore written as
  the table that design should adopt.
- Task `7194c5e5` («Доробити голосовий режим після запуску»): audio on a locked iPhone
  is still open there.
- Past conversations (search_transcripts, project-scoped then unscoped, five phrasings):
  the #3197 lane and its reviews, and the orchestrator seat's relay of this request.
  search_memory returned nothing on reconnecting.
- Vendor pages, fetched 2026-11-01 10:01 UTC, both HTTP 200: the OpenAI "Live
  conversations" guide (`/api/docs/guides/live-conversations`) and its WebRTC guide
  (`/api/docs/guides/voice-webrtc?api=live`).
- The installed Codex CLI's app-server schema: `codex-cli 0.162.1`, generated with
  `codex app-server generate-json-schema --experimental` under a scratch `CODEX_HOME`;
  the v2 schema file's SHA-256 starts `5c0ee37a723e4672`.

## 1. Today

### 1.1 A call rides on three connections

| Leg | Between | Carries | Code |
| --- | --- | --- | --- |
| Media | browser and provider, WebRTC | both directions of audio; a data channel the page listens on | `src/lib/voiceCompanion/media.ts:39-81` |
| Poll | browser and Viewer, HTTP every 500 ms | transcripts, tool calls, delegation cards, reports, usage | `src/lib/voiceCompanion/liveAdapter.ts:143-153`, `:154-187` |
| Sideband | Viewer and provider: a WebSocket on the API, the `codex app-server` child's stdio on Codex | every provider event the server acts on; commands to the voice | `src/lib/voiceCompanion/provider.ts:66-91`, `src/lib/voiceCompanion/codexProvider.ts:297-321` |

The browser's offer goes to the provider once, through the Viewer, when the session is
minted (`provider.ts:51-54`, `codexProvider.ts:71-73`). Nothing renegotiates the media
after that.

### 1.2 How a drop is noticed

| Signal | What happens | Latency | Code |
| --- | --- | --- | --- |
| Peer connection `failed` or `closed` | the call is lost | whenever the browser's ICE declares it; `disconnected` is ignored, so a short blip on the same network can recover by itself | `media.ts:61-63` |
| Data channel `close` | the call is lost | at once | `media.ts:68` |
| One failed poll | the call is lost, even with the audio still flowing | 0.5 s when the request is refused; up to the 40 s request timeout when packets vanish | `liveAdapter.ts:147-150`, `:81` |
| Server watchdog | the server closes the part as `transport` when the browser has not polled for 30 s | 30-35 s (checked every 5 s) | `src/lib/voiceCompanion/liveSession.ts:355-365` |
| Sideband closed or failed | hang up and close as `transport` | at once | `provider.ts:73-74`, `liveSession.ts:1202-1210`; Codex `codexProvider.ts:186-191`, `:247-251` |
| Provider's own `session.closed` | the close is recorded; its `reason` is never read, so a provider-side `connection_lost` or `expired` with final usage is journalled as an operator hang-up and is never offered back | at once | `liveSession.ts:586-590`, `:1259` |
| Page hidden, network `offline`/`online`, laptop wake | nothing listens to them | none | no `visibilitychange`, `online` or `offline` listener under `src/lib/voiceCompanion`, `src/components/voiceCompanion` or `src/hooks/useVoiceCompanion.ts` |

`lost()` turns any of the browser-side signals into one `CONNECTION_LOST` error and
closes the part with reason `transport` (`liveAdapter.ts:303-309`, `:359`).

### 1.3 What the operator goes through

1. The audio stops. The playing line stays unfinished in the lane: the error sets
   `playing` to null first (`src/lib/voiceCompanion/reducer.ts:454`), so the
   `playback.stopped` that follows finds no playing response and leaves the line as it
   was (`reducer.ts:345-355`). It is marked cut only when the next part starts
   (`reducer.ts:271-272`).
2. The disconnect cue sounds once, two tones falling 990 → 660 Hz
   (`src/lib/voiceCompanion/cues.ts:65`, latched in `liveAdapter.ts:297-302`).
3. The desktop lane shows "The connection dropped. What was said is kept." with a filled
   **Reconnect** (`src/components/voiceCompanion/VoiceCompanion.tsx:644`, `:1191`;
   strings `src/lib/voiceCompanion/errors.ts:11`). The phone says it in its bubble and
   puts Reconnect first in the head's menu
   (`src/components/voiceCompanion/PhoneVoiceCompanion.tsx:395`, `:598-601`).
4. Nothing happens until the operator taps. Reconnect starts a new provider session
   that continues the same call (`VoiceCompanion.tsx:1118-1129`,
   `PhoneVoiceCompanion.tsx:450-461`): a new microphone capture and a new peer
   (`liveAdapter.ts:103-113`, `media.ts:41`), and the mute switch turned off again
   (`liveAdapter.ts:106`, `VoiceCompanion.tsx:1125`, `PhoneVoiceCompanion.tsx:457`). On
   the phone the call clock restarts from zero (`PhoneVoiceCompanion.tsx:380-381`).
5. The connect cue sounds (`liveAdapter.ts:130`) and the lane shows "Connection
   restored. The conversation goes on where it stopped." (`errors.ts:12`,
   `VoiceCompanion.tsx:647`, `PhoneVoiceCompanion.tsx:398`). That notice is visual
   only. The new voice says nothing: its opening tells it not to greet and not to ask
   again for what the operator said (`src/lib/voiceCompanion/callResume.ts:61`), so it
   waits for the operator to speak.

A page that reloads, or another device, learns of the dropped call from
`GET /api/voice-companion/resume`, asked again 6 s later up to three times
(`src/hooks/useVoiceCompanion.ts:70-97`), and offers the same one-tap Reconnect for
30 minutes (`callResume.ts:12`).

### 1.4 What the records show

Read on 2026-11-01 at 10:03 UTC from copies of the 38 call journals this installation
retains (2026-10-09 to 2026-11-01), counting only `session_start` and `session_end`
rows and the kinds of the rows before an end; no spoken text was read.

| Measure | Value |
| --- | --- |
| Parts by end reason | operator 22, cap 10, transport 6. Until the 2026-10-22 change a browser that stopped polling was closed as `cap` (`voice-call-memory.md:622-623`), so `cap` before that date mixes drops with spend |
| Parts that resume another | 3, all on 2026-11-01 |
| Drop to the next part's start, per resume | 10.4 s, 31.2 s, 67.9 s |
| Mint time, for comparison | API backend, where all three drops ran: `session.ready` 1.8 to 7.6 s after the part began, median 2.8 s, over the 17 API parts whose ready event is still in their stored ring (its `atMs` alone, read 2026-11-01 11:56 UTC from a copy of the voice state, parts of 2026-10-09 to 2026-11-01; a long call's ring has rolled it off, so this leans to short calls). Codex backend: one such part at 3.5 s, and a V3 probe's SDP answer in 2.019 s (`voice-call-memory.md:585-586`). Most of each gap above is noticing the drop and tapping |
| Drops on 2026-11-01 | three, at 08:41:12, 08:43:54 and 09:17:36 UTC, all on the API backend (`voice` meridian in their starts) |
| Cause of those drops | unknown: every leg journals the same `transport` (`liveSession.ts:1207`, `:1259`, `liveAdapter.ts:359`) |
| Viewer restarts then | none: the deployment list has no deploy between 06:18 and 09:30 UTC |
| Viewer loop stalls | the largest `[viewer loop-gap]` in the 75 s before each drop: 7.4 s, 4.7 s, 22.9 s. During the two calls that did not drop (08:45-09:12 and 09:17-09:47 UTC) the Viewer logged 35 and 22 stalls of 5 s or more, the longest 23.5 s and 17.5 s, so stalls alone do not explain the drops |
| Before each drop | a server hand-off to the voice (a report or a spoken notice) 5.4 s, 9.0 s and 16.7 s earlier; three cases, which proves no cause |

The design therefore starts by recording which leg failed and why (§3.9, slice 0);
nothing in the current records can tell a network loss from a provider close.

### 1.5 What a drop loses

| Item | What happens today | Code |
| --- | --- | --- |
| The voice's half-said reply | The transcript is the generated text, which runs ahead of the audio (`src/lib/voiceCompanion/contract.ts:10-12`). At the close the server seals every unfinished segment as final (`src/lib/voiceCompanion/liveTranscript.ts:117-119`, called from `liveSession.ts:1248`), so the journal holds the whole reply and the next part reads it as said (`callResume.ts:45-46`). Only the browser knows how much played (`reducer.ts:271-272`, `media.ts:108-110`), and it never tells the server. | as cited |
| The operator's half-said sentence | What was transcribed before the drop is sealed as a final utterance and reaches the next part. Speech after the media died was never sent. No line says the last utterance went unanswered, and the opening tells the voice not to ask again (`callResume.ts:61`), so the new part waits. | `liveTranscript.ts:117-119`, `callResume.ts:57-76` |
| Reads in flight | Aborted (`liveSession.ts:1239`); the browser marks running calls failed (`reducer.ts:274`); tool rows are left out of the continuation (`callResume.ts:41-52`). | as cited |
| A request waiting for confirmation | Cancelled as `session_closed` at the part's end (`src/lib/voiceCompanion/admission.ts:772`, `reducer.ts:298-299`), and the next part is told "Every request in it was already handled; send nothing again" (`callResume.ts:61`). The operator has to ask again unprompted. | as cited |
| A request already sent | Its receipt and its answers are polled per part (`admission.ts:544-547`, `:605-607`). While the call stays dropped the page keeps observing the dropped part for them (`liveAdapter.ts:144`); a reconnect stops that (`liveAdapter.ts:104`, `:335-338`). The new part watches only its current project and its own requests (`admission.ts:599-601`) and starts its report scan at the newest report on its first poll (`admission.ts:612-616`), so an answer filed during the outage, or to a request for another project, is never spoken. A send whose outcome was unknown is sent again only while its own part is polled (`liveSession.ts:1172-1174`). | as cited |
| Reports owed to the voice | Deleted when the part ends (`admission.ts:771`). A report part counts once the provider took it (`liveSession.ts:1033-1036`, `admission.ts:752-760`), so one handed just before the drop counts though nobody heard it. A report that a poll of the closed part finds moves the watermark and is listed as spoken (`admission.ts:641-644`) with no speech queued, because a closed part owes none (`admission.ts:86`, `:655`). | as cited |
| Delivery cards | Stay on screen (`reducer.ts:268-270`) and stop changing after a reconnect. | as cited |
| Mute, microphone, call clock | Mute switched off, microphone re-captured, phone clock restarted (§1.3, step 4). | as cited |
| The provider's context | Gone with the session. The next part starts with at most 2,400 characters of the call so far, newest lines kept, each at most 300 (`callMemory.ts:116`, `callResume.ts:18`, `:57-76`). | as cited |

### 1.6 What the providers allow

**API backend** (`gpt-live-1`, the default backend since the operator's 2026-10-06
change, and the one all three of today's drops ran on):

- The session is created by one `POST /v1/live/sessions` carrying the SDP offer
  (`provider.ts:51-54`). Neither vendor page read documents renegotiation, an ICE
  restart or re-attaching a new peer to a running session.
- The vendor's recovery advice ("Recover from a failed connection"): fork a completed
  stored recording into a new session, "otherwise, create a replacement session with
  relevant saved history. Before continuing, check unfinished actions with your
  backend, restore current task state, and update result routing so late results from
  the previous session cannot overwrite newer work." That is the shape of this design.
- Forking needs `store: true` at creation; Delegatus sets `store: false`
  (`src/lib/voiceCompanion/sessionConfig.ts:74`). It also needs a completed stored
  recording, which takes a graceful close, and stored recordings are kept 30 days at
  the vendor (Choice D4).
- A session can be seeded with prior role-bearing messages (`session.input`). Delegatus
  sends the history as one text block in the instructions
  (`liveSession.ts:288-291`, `:319`).
- Close reasons: `close_requested`, `expired` (duration limit; its value is not stated),
  `content` (a safety filter), `remote_hangup`, `connection_lost`
  (`voice-mode-explained.md:632`, and the guide fetched today).
- Cost of a reconnect: each new part reserves $0.27 (`src/lib/voiceCompanion/usage.ts:15`)
  and is billed at least 15 s of voice at $0.05 a minute (`liveSession.ts:1255`,
  `usage.ts:8`), so at least $0.0125 per reconnect. A mint whose answer the Viewer loses
  blocks every later start until the operator releases it
  (`voice-companion-research.md:420-437`, `liveSession.ts:236-238`).

**Codex backend** (`gpt-live-1-codex`, V3 over WebRTC):

- One `codex app-server` child per call, on a fresh ephemeral thread
  (`codexProvider.ts:112-143`, `:67`). When the realtime transport closes, the provider
  hangs up and the child is stopped (`codexProvider.ts:247-251`, `:340-361`), so the
  backing thread is lost with it.
- The installed schema (0.162.1) shows that `thread/realtime/start` is thread-scoped
  and takes `initialItems` ("complete role-bearing text items", V3 only, at most 128
  items and 8,192 estimated tokens), a `realtimeSessionId` with no description, and an
  `existingCall` transport for "a realtime call already created and negotiated by the
  client". Whether a second realtime start on a thread whose first one closed is
  accepted, and what `realtimeSessionId` does, the schema cannot show (§8).
- Codex transcripts carry no audio clock, only receipt offsets
  (`src/lib/voiceCompanion/codexTranscript.ts:3`). `thread/realtime/appendSpeech`
  voices text as written (`codexProvider.ts:337`).

## 2. The target

A drop, as the operator should live it:

1. The audio stops. Within a second the character's ring turns to the reconnecting
   state and the lane, or the phone's bubble, reads "Reconnecting…". If the session
   itself is gone, the disconnect cue sounds once. Nothing asks for a tap.
2. The call keeps its identity: the same lines stay in the lane, the delivery cards keep
   updating, the phone clock keeps counting, mute stays as it was, the record and the
   call history show one call with a "Connection dropped · reconnected" divider (as
   today, `src/lib/voiceCompanion/callHistory.ts:48`, `callResume.ts:78-91`).
3. When the network is back, the call is back within a few seconds without a click:
   the connect cue, the "Connection restored" notice.
4. If the voice was in the middle of a reply, it carries on from the start of the
   sentence the cut fell in, without repeating what the operator heard. When it does
   not know how much was heard (a reload), or the rest is long, it says in one line
   where it stopped and asks whether to go on (Choice D1).
5. If the operator was speaking, their words up to the cut are kept: the voice answers
   them, or, when the sentence was cut off, says in one short line where it lost them
   and lets them finish.
6. Pending work finishes or is reported exactly once: an answer that arrived during the
   outage is read once after the return; a request that was waiting for the operator's
   yes is asked about once more; nothing is sent twice.
7. Wi-Fi to mobile, a phone locked and unlocked, a laptop that slept: the call comes back
   on its own when the page can run and play sound again.
8. It gives up after a bounded effort (Choice D2), or at once when the answer can never
   change (the window passed, the plan or the cap ran out, the microphone was refused).
   It then says so with a distinct cue and line and leaves today's one-tap Reconnect
   for the rest of the 30 minutes.

What it does not try to recover: words the operator spoke while the connection was
down. They never reached anyone; the voice says where it lost them (point 5).

## 3. Mechanism

### 3.1 Two tiers

| Tier | When | What survives | Mechanism |
| --- | --- | --- | --- |
| 1. Same session | a blip the browser's ICE recovers by itself on the same network; a Viewer that stops answering polls while the audio still flows | the provider session and its whole context | ride it out with bounded grace; afterwards, if words were lost, the server makes the voice say where it stopped (§3.6) |
| 2. Same call, new session | the peer failed, the data channel closed, the grace ran out, the server closed the part (watchdog, sideband, provider close, a Viewer restart), a network change | the call: its journal, requests, reports, lines and identity | today's resume (`liveSession.ts:225-389`, `callResume.ts`) started automatically, with a resume cursor (§3.5), the resume line (§3.6) and pending work carried over (§3.7) |

There is no ICE restart tier: the provider offers no renegotiation path (§1.6). A
network change moves the browser to a new address, which the existing peer cannot
follow, so it ends in tier 2 once ICE fails or the grace runs out (§3.2).

### 3.2 Noticing

In the end state four things end a session: the peer failing, the data channel closing,
the ICE grace running out, and the server answering that the part closed. Every other
signal is a hint that makes the browser check at once; `navigator.onLine` and a hidden
page never end a call by themselves.

| Signal | Today | Proposed |
| --- | --- | --- |
| ICE `disconnected` | ignored (`media.ts:61-63`) | start a 5 s grace; show "Reconnecting…" after 1 s; if the operator or the voice was speaking, take the cut (§3.5) and send the existing interrupt as soon as the Viewer answers (`liveAdapter.ts:249-262`, `liveSession.ts:1163-1164`), so the voice stops talking into the outage. Back to `connected` within the grace: tier 1, and the cut reaches the server by the `cut` command (§3.6). Still disconnected after 5 s: tier 2 |
| ICE `failed`, peer `closed`, data channel `close` | lost (`media.ts:61-68`) | tier 2 at once |
| A failed or timed-out poll | lost (`liveAdapter.ts:147-150`) | from slice 4, the Viewer leg is unsteady: keep polling with backoff 0.5, 1, 2, 4 s (cap 4 s), each poll with a 10 s deadline (40 s today); the call goes on while the media is up; "Reconnecting…" after 10 s of failures; tier 2 only when the server answers that the part closed, or the media fails too. Until slice 4: still ends the session, and goes to tier 2 |
| Server watchdog, 30 s without a poll | close as `transport` | unchanged; cause `watchdog` (§3.9) |
| Sideband lost | hang up, close as `transport` | unchanged; cause `sideband` |
| Provider `session.closed` | reason ignored, journalled as operator | read `reason`: `connection_lost`, `expired` and `remote_hangup` become `transport` (resumable); `content` becomes a new non-resumable reason; `close_requested` keeps the reason our own close set |
| `offline` / `online` | none | `offline` pauses tier 2 attempts (they cannot succeed); `online` starts the next attempt at once. Neither touches a running grace, and a seamless network switch may fire neither |
| `visibilitychange` | none | on a phone: when hidden, record the cut (§3.5); when visible again, check health at once (poll now, read the peer state), and a closed part goes to tier 2 with no backoff. On a desktop a hidden tab is a normal state during a call and changes nothing |
| Clock jump (a 1 s tick that sees more than 5 s pass) | none | the device slept: check health at once, as above |

Both cues and the "Reconnecting…" line belong to the session being gone or about to be
replaced. A tier 1 blip that recovers inside the grace shows the line, plays no sound,
and is followed by the resume line only if words were lost.

**The order these land in matters.** Today a failed poll is the only signal that notices
a short loss of the device's network, because ICE `disconnected` is ignored
(`liveAdapter.ts:147-150`, `media.ts:61-63`). Making it non-fatal before the grace and
the cut exist would leave a 5 s drop to recover as `disconnected` → `connected`, with the
words of the gap lost silently. So a failed poll stays fatal, with its 40 s request
timeout, and feeds tier 2 from slice 1, until slice 4 changes the poll, the grace, the
cut and the `cut` command together. The 10 s poll deadline waits for slice 4 as well:
while a failed poll ends the call, that deadline would turn each long Viewer stall (up
to 23.5 s, §1.4) into a drop.

A client whose Viewer stays reachable through the drop, such as a desktop browser with
the Viewer on the same machine, keeps answering polls while the provider leg is gone. No
tier 2 happens for a short drop there, and only the slice 4 grace notices it.

### 3.3 Retrying

The store that already owns the resume probe and `start` (`useVoiceCompanion.ts:119-158`)
owns the loop. It runs only on the page that held the call: the drop it saw followed
speech on that page (`useVoiceCompanion.ts:29-31`). A page that reloaded, or another
device, keeps today's one-tap Reconnect: a reload is often deliberate, and two pages
retrying the same call would race.

| Attempt | Starts |
| --- | --- |
| 1 | 0-300 ms after tier 2 is decided (random) |
| 2 | 1 s after attempt 1 failed |
| 3 | 2 s later |
| 4 | 4 s later |
| 5 onward | every 8 s |

Each delay gets ±25 % jitter. Each attempt is a `start` with `resume` and a 15 s
deadline (on the API the median mint is 2.8 s and the slowest retained 7.6 s, §1.4).
`resume` names P, the newest part whose answer this page received. Rules:

- **Same key first.** An attempt whose request got no answer is sent once more with the
  same `requestId` and the same offer, on the same pending peer. The server answers a
  known request with the session it already minted (`liveSession.ts:239-247`), so a lost
  answer recovers its own session. That lookup moves ahead of the close at `:231-232`:
  once the server follows the chain (§3.7), the close would otherwise end the very
  session a same-key retry came to recover.
- **Then the next attempt, on the same call.** The same-key retry may also get no answer
  (the network is still down), or answer `SESSION_CLOSED` (the part it minted has closed
  since, `:244-246`: the watchdog ended it, or its mint failed). The loop then takes the
  next row of the schedule: a new peer, a new offer and a new `requestId`, still naming
  P. The server follows P's `resumedBy` to the newest part and continues that one (§3.7),
  so an automatic reconnect never stops because the network flapped during a mint. Any
  other retryable answer (`PROVIDER_ERROR`, `COMPANION_UNAVAILABLE`) takes the same next
  row at once, with no same-key retry: the server has already answered that key.
- **A resume that got its session and then fails ends it as a drop.** When the answer
  cannot be applied or the first poll fails, `begin` closes the session with no reason
  (`liveAdapter.ts:131-141`, `:352`, `:359`), which journals an operator hang-up and would
  end the chain for the next attempt (§3.7). In a resume it closes as `transport`, and the
  next attempt names that part.
- **No attempts while offline**, and on a phone none while the page is hidden; time
  spent so does not count against the budget.
- **One microphone for the whole call.** The capture, the output element and the audio
  context stay open across attempts; only the peer connection is replaced. Today
  `close()` releases all of them (`media.ts:121-135`) and each start captures again
  (`media.ts:41`). Keeping them means no new permission prompt, the same device, and,
  on phones, playback that keeps the user activation of the first tap. If the browser
  still refuses playback (`AUDIO_REFUSED`, `media.ts:59`), the loop stops and the
  one-tap Reconnect supplies the activation.
- **The call's settings carry over:** mute, the project in view (as today,
  `VoiceCompanion.tsx:1121`), the call clock.
- **The dropped part is closed by the resume itself.** A start that resumes a part
  this Viewer still holds open closes it as `transport` first (`liveSession.ts:231-232`),
  so the browser need not wait for its own close request to land; a close that fails
  during reconnecting raises no `FINALIZATION_INCOMPLETE` notice (`liveAdapter.ts:361`).

### 3.4 When to give up

- **At once**, for answers that cannot change: `SESSION_UNAVAILABLE` (the window passed,
  another owner, the operator ended the newest part, or another page is reading it,
  §3.7), `COMPANION_DISABLED`, `CAP_REACHED`, `CODEX_LIMIT_REACHED`,
  `CODEX_AUTH_REQUIRED`, `NO_CODEX_ACCOUNT`, `CODEX_UNSUPPORTED`, `NO_KEY`, `KEY_FROM_ENV`,
  `NO_PROJECT`, `INVALID_REQUEST`, `MICROPHONE_REFUSED`, `AUDIO_REFUSED`, `MINT_UNCERTAIN`,
  and a provider close for `content`. `SESSION_CLOSED` and `PROVIDER_ERROR` are never on
  this list (§3.3).
- **After the budget**: 60 s of online, runnable time since tier 2 began, or 8 attempts,
  whichever comes first (Choice D2). A call also stops reconnecting by itself after 6
  automatic reconnects in 10 minutes, which bounds the cost of a flapping network on
  the API backend (§1.6).
- **Then**: the give-up cue and "Couldn't reconnect. What was said is kept; Reconnect
  continues the call." (§4), and today's Reconnect for the rest of the 30-minute window
  (`callResume.ts:12`). Reconnect after a give-up uses the same cursor and carries the
  same pending work, including reports filed while the part sat closed (§3.7), so the
  manual path resumes as exactly as the automatic one.

Two different answers can be lost, and they end differently. An answer lost between the
browser and the Viewer names a session the server knows: §3.3 recovers it, and it never
becomes `MINT_UNCERTAIN`. An answer lost between the Viewer and the provider may leave a
session open that nobody can name or hang up, so one more mint could break the rule of
one open provider session. That case keeps today's `MINT_UNCERTAIN`, which holds every
new start until the operator releases it (`liveSession.ts:236-237`,
`src/app/api/voice-companion/session/route.test.ts:173-219`, the fake's
`createFailures: ["lost"]`), and the loop gives up on it at once.

### 3.5 Where the state lives; the resume cursor

| Kept by | What | Survives |
| --- | --- | --- |
| Browser | each line's playback state and played milliseconds (`reducer.ts:34-46`); the cut taken when the drop was noticed; the microphone, output and audio context; mute; the call clock; the retry loop | a network drop; lost on reload |
| Server, durable | the journal's settled rows (`src/lib/voiceCompanion/transcriptRecord.ts:29-31`, `:88-99`); requests with their delivery keys and statuses; report watermarks, spoken report ids and owed report speech; the `resumes` chain and the new `resumedBy` lease; resume lines handed; the drop cause | reload, other device, Viewer restart |
| Provider | the model's context, audio buffers, tool state | nothing (tier 2) |

The **cursor** is what only the browser can know, sent with the resuming `start`
(`contract.ts:161`, route `src/app/api/voice-companion/session/route.ts:23-31`,
`StartInput` at `liveSession.ts:166`):

```ts
cursor?: ResumeCursor;
interface ResumeCursor {
  /** The companion line that was playing when the drop was noticed, and how much of it played. */
  heard?: { itemId: string; playedMs: number };
  /** Companion lines whose audio never started. */
  unplayed?: string[];
  /** The operator line still growing in the browser at the drop. */
  operatorOpen?: string;
}
```

Item ids are the server's own (`live-companion-N`, `live-operator-N`,
`liveTranscript.ts:64`), and their sequence restarts in each part, so the cursor is read
against the part the browser named in `resume`, the one it heard, whichever part the
server then continues (§3.7). The server ignores any id that is not a row of that part,
clamps `playedMs` to the line's length and says so in the new part's start record. The
cursor joins the mint digest (`liveSession.ts:239`), so a same-key retry carries the same
cursor. The adapter takes the cut before it closes anything: when the audio went quiet
before the drop was noticed, `playing` is already empty and `lastPlayed` holds the
position (`liveAdapter.ts:60`, `:247`). A line played to its end is not cut.

From the cursor and its own journal the server derives the three positions the
specification names:

1. **Last spoken text offset.** On the API, reply rows keep each fragment's
   `[start_ms, end_ms]` on the provider's audio timeline (`liveSession.ts:516-523`,
   stored at `:486`); the heard text is the fragments ending within `playedMs` of the
   reply's first fragment. On Codex there is no audio clock, so the offset is
   `playedMs / 58` characters, the nominal rate the lane already paces bubbles by
   (`VoiceCompanion.tsx:98`). Either way the offset moves back to the start of the
   sentence it falls in, so a few words may be heard twice and none is skipped. `playedMs`
   counts audible time only (`liveAdapter.ts:227`), so a pause inside the reply makes it
   fall short of the audio timeline and the offset errs early, the safe direction; the
   last sample also carries up to 250 ms of quiet tail (`media.ts:108-110`), which the
   adapter subtracts. Lines in `unplayed` count as unheard whole.
2. **Last operator turn.** The newest operator utterance with no voice reply after it in
   the journal, or `operatorOpen`. It is "cut" when it was still growing at the drop.
3. **Last delivered tool result.** For each request: the last status the voice was told
   (the tool result it received) and whether a reply came after it. A result that
   arrived with no reply after it was never spoken.

Without a cursor (a reload, another device), the server treats the newest reply that
ended in the last 10 s of the part as possibly unheard, and the resume line becomes the
one-line form of Choice D1.

The cursor also feeds the continuation block: `lines()` (`callResume.ts:41-52`) marks
`voice (cut; the operator heard up to «…»)` and `operator (cut off, unanswered)`, lists
open requests as "waiting for the orchestrator's answer", and the header's "Every
request in it was already handled" becomes "Requests marked waiting are still open;
their answers will be read to the operator when they arrive; do not send them again."
The block stays inside the 2,400-character budget it shares with the earlier call
notes (`liveSession.ts:288-291`).

### 3.6 Saying where it stopped

After the resumed part is ready, and before any report is spoken, the server hands the
voice at most one **resume line**, chosen in this order. Codex voices text exactly as
written (`codexProvider.ts:337`), so each Codex cell is text the server composes from the
journal and the cursor, with no model involved; on the API the same facts go in an
instruction.

| Situation | The voice says | API (`session.commentary.append`, `liveSession.ts:1045-1051`) | Codex (`thread/realtime/appendSpeech`) |
| --- | --- | --- | --- |
| A reply was cut and the rest is short (Choice D1) | the rest of the reply from the start of the cut sentence | instruction to carry on, with the heard tail and the rest "read as written, in order", the pattern reports already use (`liveSession.ts:1026-1032`), split under the 500-byte limit (`liveSession.ts:167-170`) | a fixed bridge ("Picking up where it cut off:" / «Продовжу з місця, де обірвалося:») and the rest, as written |
| A reply was cut and the rest is long, or nothing is known of what was heard | one line saying where it stopped, then "Shall I go on?" | instruction naming what it was explaining | a fixed line quoting the last words heard, or the reply's opening words when none are known: "The connection dropped at «…». Shall I go on?" / «Зʼєднання обірвалося на словах „…“. Продовжити?» |
| The operator's last turn went unanswered | its answer; when the turn was cut off, one line: "The connection dropped after «…». Go on." / «Зʼєднання обірвалося після „…“. Продовжуйте.» | instruction | the line as written; its answer then comes from the voice's own turn |
| A request result arrived with no reply after it | one line with its outcome | instruction | a fixed line from the request's project and status, followed by the report text the way a report is read (`liveSession.ts:1031`) |
| A request was waiting for the operator's yes | one question asking whether to send it, through the normal confirmation gate | instruction | a fixed line quoting the request: "Shall I send this to the orchestrator: «…»?" / «Надіслати це оркестратору: „…“?» |
| Nothing was cut | nothing; the connect cue and the notice are enough | none | none |

The line is the first entry of the part's owed speech (`ReportSpeech`, with
`kind: "resume"` and the id `resume-<part>-<item>`), and `speakReports` hands it
(`liveSession.ts:1016-1039`). Queue order puts it ahead of every report; the durable
`handed` count and the carry-over of owed speech (§3.7) then cover it. A line still owed
when its part drops moves to the next part, which derives no second one. Its hand-off
row carries `resumeOf`, the part and item of the cut. A line with a reply row after its
hand-off was said and is never handed again; a line handed with no reply after it was
never voiced and stays owed, as report parts do; if the voice was cut while saying it,
it is simply the newest cut.

Slice 2 adds two holds. `reportsHeld` (`liveSession.ts:1041-1044`) has a term for neither
today, and `append` (`:1045-1051`) sets none of its terms.

- **Nothing is handed before the browser can hear it.** A resumed part hands no owed
  speech until its first poll (`events()`, `:1166-1168`), which proves the browser got
  the answer. The adapter makes that first poll after the peer reaches `connected`,
  bounded at 5 s (`liveAdapter.ts:125-128`, which polls right after the answer today). A
  part whose answer was lost therefore says nothing into the void, and its line moves on
  with the rest of its owed speech (§3.3).
- **Reports wait for the line.** Once the line is handed, later entries hold until the
  voice has begun answering it (an output transcript delta, at the site that sets
  `lastHandoff.replied`, `:522`), or for at most 15 s (the bound of `INPUT_HOLD_MS`,
  `:172`), so a voice that never answers cannot hold reports for good. The hold has its
  own flag, because `lastHandoff` is set by a delegation and decides which turn the next
  delegation belongs to (`:543-548`).

**Tier 1** runs the same rules inside the same session, from the cut the browser took
when ICE went `disconnected`. That session is still up and no `start` is coming, so the
cut has its own way in, a new command:

```ts
// CompanionCommand, contract.ts:147-150; slice 4
| { type: "cut"; cutId: Id; cursor: ResumeCursor }
```

The route validates it beside the other commands (`route.ts:53-57`), with the validator
the `start` branch uses for `cursor`; `command()` (`liveSession.ts:1155-1165`) checks the
ids against that part, chooses the line by the table above and queues it first. A repeated
`cutId` changes nothing. The page posts it after `connected`, once the interrupt's mute
has lifted: the output stays muted until it has been quiet for 1.5 s (`media.ts:98-105`),
so a line handed sooner would play silent and hold the mute on. When the answer is
`SESSION_CLOSED` (`liveSession.ts:1161`), the page keeps the cut and sends it as the
cursor of the tier 2 start.

### 3.7 Pending work crosses the reconnect

All of this happens in one storage change, from dropped part P to new part N: the change
that records the mint before the provider is asked (`liveSession.ts:315`). It comes after
the reservation and the key (`:278-282`), whose failures retire the new part with no
journal end, so nothing moves into a part that could never be continued. There is no
`await` between the read of P (`:257`) and that change, so two starts cannot both take P.

- **Lease.** P gets `resumedBy: N`. A start with a known `requestId` is answered first
  and follows nothing (§3.3). Any other start naming P walks `resumedBy` to H, the
  newest part of the call, bounded by `CHAIN_LIMIT` (`callResume.ts:17`). Today nothing
  prevents two parts continuing P (`liveSession.ts:445-458` checks only owner, reason,
  window and speech). Then:

  | H is | The start |
  | --- | --- |
  | P itself | goes on as today, first closing P if this Viewer still holds it (`:231-232`) |
  | open here, and no browser read it within `STALE_BROWSER_MS` (never polled, or 5 s quiet; `contract.ts:156`) | closes H as `transport`, cause `answer-lost`, then continues H |
  | open here, and a browser is reading it | `SESSION_UNAVAILABLE`: the call is alive on another page, and that page keeps it |
  | closed by a drop | continues H, whose chain still holds the speech (`callResume.ts:23-36`) |
  | closed any other way (the operator, the cap) | `SESSION_UNAVAILABLE`, which is what `continued()` answers (`:451-452`) |

  A part a previous Viewer left open is closed by recovery first (`:235`, `:1102-1154`)
  and then counts as closed by a drop. The new part's `resumes` names H, so the chain
  stays one line. One provider session stays the rule: H is closed before the mint, and
  the existing check refuses a mint while an earlier session is unconfirmed (`:236-238`).
  The route checks the owner of the part named (`route.ts:29`) and `continued()` checks
  the owner of H (`:451`), so following reveals nothing to another caller. A lost answer
  costs one part nobody heard, at least 15 s of voice on the API (§1.6), and a mint that
  fails after this change closes N as `transport`, cause `mint-failed`, with the pending
  work still in the chain for the next attempt.
- **Sent requests.** Every admitted request of P that is queued, delivered or unknown,
  and not yet answered, moves to N with the same `proposalId`, `clientMessageId`,
  `operationId` and recipient; P keeps a pointer `adoptedBy: N`. N's receipt and report
  polls then find them (`admission.ts:544-547`, `:605-607`), its project scan includes
  their recipients (`admission.ts:599-601`), and an unknown outcome is sent again under
  its own key (`liveSession.ts:1172-1174`). A row keeps its `publishedReceipt`, settled on
  P first (`admission.ts:578-592`), so N's answer joins the card. The request's journal
  row is copied to N (`requestRecord`, `admission.ts:216-224`), so its next status merges
  with its instruction, and `lines()` and the transcript view show the newest row of a
  `callId`.
- **Reports.** N starts from P's report watermarks and spoken report ids, where today a
  new part sets a fresh baseline (`admission.ts:608-629`, `:631-644`), so a report filed
  during the outage is spoken once and a report spoken in P is never spoken again.
- **Reports found while the part sits closed.** The page keeps polling P while deliveries
  are pending (`liveAdapter.ts:144`, re-armed by `close()`, `:365`, every 2 s), and
  opening the ended call runs the same scan (`route.ts:79-81`). Today that scan moves the
  watermark and lists the report as spoken with no speech queued (`admission.ts:641-644`,
  `:655`), so carrying those marks over would silence exactly these reports, for longest
  after a give-up. A part closed by a drop therefore keeps owing speech for the resume
  window: `owesSpeech` (`admission.ts:86`) also holds for a part with a new `droppedAt`
  (set where `session.closed` is appended with a drop reason, `admission.ts:189-193`),
  within `RESUME_WINDOW_MS` and with no `resumedBy`. `retire()` keeps its queue
  (`admission.ts:771`), including at the second `retire` that a close request on a closed
  part reaches (`liveSession.ts:1184`), and the capacity guard (`admission.ts:638`) holds
  the scan back as on an open part. A listed id then means spoken or owed, as it already
  does on an open part, where both happen in one commit. Past the window the scan goes
  back to cards only, so reading an old call never fills a queue nobody hears. Listing the
  id only at hand-off would also work; it changes the scan's guard on every open part, for
  nothing this needs.
- **P is frozen once continued.** With `resumedBy` set, `events(P)` returns its stored
  events and scans nothing: no report scan, no receipt poll, no resend
  (`liveSession.ts:1172-1178`). Otherwise a later read of P, from another page or from
  opening the old call, would queue a report nobody speaks or send under a part nobody
  polls.
- **Owed speech.** A drop no longer deletes P's owed report speech (`admission.ts:771`);
  N adopts it, ahead of what N's own scan adds. An adopted entry keeps its composed
  `parts` only when N runs on P's backend; otherwise it restarts from its text, because
  API parts carry instructions a Codex voice would read aloud (`liveSession.ts:1026-1032`).
  Its card event is appended to N's event ring with no second journal row (`appendEvent`,
  `admission.ts:88`), for a page whose poll answer was lost with that card in it; the
  reducer ignores a report id it already shows (`reducer.ts:438`, `:446`). A report part
  handed in P after the last reply row was taken by the provider and never voiced, so it
  is owed again. Hand-off rows carry the report id for this (`liveSession.ts:1050`
  records only the text today).
- **Waiting confirmations.** They stay cancelled, with the code `connection_dropped`
  (`admission.ts:772`), and the resume line asks once whether to send them (§3.6). A yes
  makes a new request through the normal gate with a new key; the old one can no longer
  be confirmed (`admission.ts:446`, `:455`). Carrying the old proposal across would need a
  second confirmation path and buys nothing the one question does not.
- **Reads in flight** were aborted (`liveSession.ts:1239`). Reads have no effect, so the
  unanswered operator turn (§3.5) makes the new part read again.
- **Acting tools in flight** (an added server's acting call, `voice-extensible-tools.md:432-450`)
  have an unknown outcome. They are never run again by themselves; the resume line
  says once that the outcome is unknown.

### 3.8 Nothing said or done twice

| Thing | Key that keeps it single |
| --- | --- |
| A mint | `requestId` plus the digest of project, locale, offer, owner, resume and cursor (`liveSession.ts:239-247`) |
| A continuation of a part | the `resumedBy` lease: a later start follows it to the newest part, and never continues an older one or a part another page is reading (§3.7) |
| A send | its `clientMessageId` and `operationId`, kept through adoption; a part frozen once continued sends nothing more; the relay's idempotency keeps a resend one message (`voice-companion-research.md:455-458`) |
| A report spoken | its report id in the call-wide list of spoken or owed reports, and the owed queue that moves with it, both carried from part to part |
| A resume line | its one entry in owed speech, keyed by part and cut item; once replied to, `resumeOf` in its hand-off row; in tier 1, `cutId` as well |
| An answer to a cut operator turn | the utterance id; once answered, a reply row follows it and it is no longer "unanswered" |
| A cue | the existing latch, one disconnect per connect (`liveAdapter.ts:68-69`, `:297-302`); the reconnecting state adds no cue of its own (Choice D3) |

### 3.9 Recording why a call dropped

Each part's `session_end` gets a `cause`, each resumed part's `session_start` gets a
`reconnect` record, and each ICE episode that recovers gets a `connection` row, all
written by the server:

- `cause`, from the browser's close request (a closed list the route validates, beside
  `reason: "transport"` at `route.ts:40-43`): `ice-failed`, `ice-grace`, `channel-closed`,
  `viewer-unreachable`, `audio-refused`; from the server: `watchdog`, `sideband`,
  `provider-connection_lost`, `provider-expired`, `provider-remote_hangup`,
  `provider-error`, `viewer-restart` (a part closed by recovery, `liveSession.ts:1102-1154`),
  `answer-lost` and `mint-failed` (§3.7).
- `reconnect`: tier, attempts, whether it was automatic, milliseconds from the drop being
  noticed to the start request and to `session.ready`, and the cursor's offsets.
- `connection`, a journal row of its own (`TranscriptKind`, `transcriptRecord.ts:9`; the
  transcript view passes over kinds it does not handle,
  `src/components/voiceCompanion/CompanionTranscript.tsx:81-105`). A blip that recovers
  writes neither of the records above, so without this row the blips that lose words stay
  invisible. It holds how long `disconnected` lasted and who was speaking when it began.
  The page posts it once `connected` returns, as a command
  (`{ type: "episode"; ms: number; speaking: "voice" | "operator" | null }`, validated
  beside the others at `route.ts:53-57`). An episode that ends in `failed` puts the same
  two facts on the close request beside its cause.

With them, the measurements of §5 come from the journals, and the questions §1.4 could
not answer (which leg fails, how often Viewer restarts cut calls) get numbers.

### 3.10 Phone lock, laptop sleep, network change

- **Phone lock.** What a locked phone does to WebRTC, timers and audio is device
  specific, and task `7194c5e5` lists locked-iPhone audio as open. If the page keeps
  running, the call goes on. If it is suspended, the server closes the part after 30 s
  without polls (`liveSession.ts:362`), and on unlock the visibility check (§3.2) starts
  tier 2 at once with the cursor taken when the page was hidden. If playback needs a new
  tap, the call stops at the one-tap Reconnect and says so.
- **Laptop sleep.** The same path, woken by the clock-jump check.
- **Wi-Fi to mobile.** ICE goes `disconnected` on the old address, and `online` may never
  fire on a seamless switch. Tier 2 starts when the 5 s grace runs out, or sooner if ICE
  fails. Before slice 4 it starts when a poll or ICE fails, whichever comes first.
- **Viewer restart** (a deploy): the new Viewer closes the orphaned part
  (`liveSession.ts:1068-1080`); polls fail meanwhile and then answer that the part
  closed, and tier 2 continues the call on the new Viewer. Before slice 4 the first failed
  poll starts tier 2, whose attempts wait within the budget for the new Viewer.

The provider session is not kept open while a phone is locked: on the API it bills by
the second while nobody hears it.

## 4. Shared cues and words with the hands-free design

The hands-free design (`2753d517`) lists a lost connection among its failure modes and
does not exist in writing yet (§Sources). This table is the one source both should use:
the strings live in `src/lib/voiceCompanion/errors.ts` beside the two that exist, and
the sounds in `src/lib/voiceCompanion/cues.ts`, under the header's sound switch
(`cues.ts:30`).

| Moment | Sound | Words on screen (en / uk) | Spoken |
| --- | --- | --- | --- |
| Tier 1 blip, over 1 s | none | "Reconnecting…" / «Перепідключаюся…» | none during; the resume line after, if words were lost |
| Tier 2 begins | the disconnect cue, once (990 → 660 Hz, `cues.ts:65`) | "Connection lost. Reconnecting…" / «Зʼєднання втрачено. Перепідключаюся…» | none (no voice is connected; Choice D3) |
| Back | the connect cue, once (660 → 990 Hz, `cues.ts:64`) | "Connection restored. The conversation goes on where it stopped." / «Зʼєднання відновлено. Розмова триває з того місця, де обірвалася.» (exists, `errors.ts:12`) | the resume line (§3.6), if anything was cut |
| Gave up | a new give-up cue: three tones falling 990 → 825 → 660 Hz at the same gain, under 300 ms | "Couldn't reconnect. What was said is kept; Reconnect continues the call." / «Не вдалося перепідключитися. Сказане збережено; „Відновити розмову“ продовжить її.» | none |
| Offered on reload or another device | none | the existing "The connection dropped. What was said is kept." (`errors.ts:11`) with Reconnect | none |

The phase label gains `reconnecting` ("Reconnecting" / «Перепідключаюся», beside
«Підключаюся» for connecting, `src/lib/i18n/uk.ts:2675`). The words keep the existing
button label «Відновити розмову» (`uk.ts:2639`), so the line names a control the
operator can see. If the hands-free design adds a spoken local line while no voice is
connected, it speaks these same strings; it adds rows to this table and changes none.

## 5. Build plan

Each slice ships on its own, runs its own tests by path, and owes rendered evidence
when it changes the screen: the desktop lane through the "floating voice companion"
block of `src/components/kanban/kanbanBoard.browser.test.tsx:24384` and the phone
through a case beside the drop case at
`src/components/mobile/issue1671Evidence.browser.test.tsx:11860`, in en and uk, light
and dark, at 390 px and a desktop width. No new driver. No slice touches
`src/runtime-host/**` or a Bun pin.

### Slice 0. Know why calls drop; stop losing provider-side drops

- The provider's close reason is read and mapped (§3.2); `content` becomes a
  non-resumable reason in the contract (`contract.ts:96`) and stays out of
  `DROP_REASONS` (`callResume.ts:15`).
- `cause` and `reconnect` records (§3.9); the close route accepts the cause list.
- ICE episodes (§3.9): the media reports `disconnected` and `connected` through a new
  `MediaCallbacks` member (`media.ts:4-8`, `:61-63`) with no other change in behaviour, and
  the page posts the `episode` command.
- Acceptance: with `FakeLiveProvider` (`src/lib/voiceCompanion/fakeProvider.ts`), a
  provider `session.closed` with reason `connection_lost` and final usage is journalled
  `transport` and offered by `resumable()`; one with `content` is not; each browser and
  server path writes its cause (`liveSession.test.ts`, `callResume.test.ts`,
  `src/app/api/voice-companion/session/route.test.ts`). The first case is expected to
  fail on `c97325311`, where the close is journalled `operator`. In `liveAdapter.test.ts`
  with fake media, `disconnected` for 3 s mid-reply and then `connected` writes one
  `connection` row with its duration and `speaking: "voice"`, and the call stays up; the
  route refuses a malformed `episode`.
- Measure from then on: drops per call-hour by cause; ICE episodes per call-hour, how many
  recovered, their durations, and how many had speech in flight. These size the 5 s grace
  and are slice 4's before figure.

### Slice 1. Reconnect without a click

- The store's loop (§3.3, §3.4); the lease and following the chain (§3.7), because an
  automatic loop is what makes a second mint likely; the `reconnecting` phase and notice;
  the cues and the give-up cue (§4); one microphone, output and audio context per call;
  mute and the phone clock kept; no Reconnect button while attempts run (End stays). A
  failed poll stays fatal and starts the loop (§3.2).
- Acceptance, automated at the seams that exist (`AdapterOptions.media` and `cues` in
  `liveAdapter.test.ts`, and its `served()`, the production adapter against the production
  service, `:218-261`, whose fake fetch can lose an answer after the service minted; the
  store's `schedule` in `callResume.test.ts`; the fake provider's `disconnect()`,
  `attached` and `createFailures`):
  - a peer `failed` mid-reply starts a resume within 300 ms, with no tap, and the call is
    ready again; the microphone was opened once; mute set before the drop is still set;
    one disconnect and one connect cue; a failed poll mid-reply does the same;
  - the browser loses a start answer once: the retry with the same `requestId` recovers
    the same session, which is still open; no second mint;
  - the browser loses every answer of two attempts in a row, each with its same-key retry:
    the third attempt brings the call back without a tap; the parts chain P → N → N2 → N3;
    `provider.attached` is at most one at every `create`; no give-up and no
    `MINT_UNCERTAIN`;
  - a same-key retry that lands after its part closed answers `SESSION_CLOSED`, and the
    next attempt continues from that part;
  - the first poll of the new part fails: that part closes as `transport`, and the next
    attempt continues from it;
  - a page naming P while another page polls N is refused, and N stays open;
  - the Viewer loses the provider's answer (`createFailures: ["lost"]`): the loop stops at
    once on `MINT_UNCERTAIN` with the give-up cue, and one provider session was created,
    as `route.test.ts:173-219` requires;
  - attempts follow the schedule and stop at the budget; a `SESSION_UNAVAILABLE` stops
    them at once; after the give-up Reconnect is offered and the give-up cue sounded once;
  - a page that reloads after a drop offers Reconnect and does not reconnect by itself.
- Rendered: reconnecting, back and gave up, desktop lane and phone bubble.
- Live check, once per backend, by the operator or with their phone: on the phone, whose
  polls fail with its network, airplane mode for 5 s in the middle of a reply; the call
  returns without a tap. On a desktop with the Viewer on the same machine a 5 s drop stays
  an ICE blip until slice 4, so keep its network down until ICE reports `failed`, and
  record how long that took.
- Measure: noticed → ready, p50 and p90 (target: median ready within 4 s after the
  network returns; the mint alone has a 2.8 s median and took up to 7.6 s, §1.4); attempts
  per drop; give-ups per drop.

### Slice 2. Go on from the exact point

- The cursor (§3.5), the continuation markers, the resume line as the first entry of owed
  speech, its two holds and its Codex wording (§3.6) on both backends. A part closed by a
  drop keeps its owed queue and the next part adopts it (§3.7), so the line survives a
  second drop; a report already queued travels with it, and with no carried watermark yet
  no report is scanned twice.
- Acceptance (`callResume.test.ts`, `liveSession.test.ts`, `liveAdapter.test.ts`):
  - a reply of three sentences cut 40 % into its audio: the API resume line carries the
    text from the start of the second sentence, and none of the first; on Codex the
    estimate lands at a sentence start at or before the cut;
  - an operator turn cut off mid-sentence: the resume line names its last words once; a
    second reconnect of the same call does not repeat it;
  - no cursor (reload): the one-line form, which on Codex quotes the reply's words;
  - no report part is handed before the resume line: with a report owed at the reconnect,
    the provider's commands show the line first and the report's first part only after
    an output delta, or at the 15 s bound with none;
  - a resumed part hands nothing before its first poll; a part that dropped before its
    first poll passes the line on, and the next part hands it once; the adapter's first
    poll of a resumed part waits for the fake media's `connected`, or 5 s;
  - the continuation block carries each open request with its current status and stays
    within the 2,400-character budget; no test reads the wording of its header or of any
    instruction (the project's rule in `AGENTS.md`).
- Live check: the slice 1 phone test, now with the reply continuing from the cut sentence.
- Measure: characters repeated and skipped at the cut (target: none skipped; at most the
  cut sentence repeated).

### Slice 3. Pending work finishes once

- Adoption of sent requests, the carried watermarks and spoken ids, a part closed by a
  drop keeping its newly found reports owed, the frozen part, report ids on hand-off rows,
  waiting confirmations asked once (§3.7).
- Acceptance (`admission.test.ts`, `liveSession.test.ts`):
  - a request delivered just before the drop is answered by the orchestrator during the
    outage: after the reconnect the answer is spoken once and its card turns answered;
  - a report filed while P is closed by a drop and polled for at least 2 s of the fake
    clock is listed once on P, queued once on N (`admission.test.ts`) and spoken exactly
    once in N (`liveSession.test.ts`); the same after a give-up and a manual Reconnect
    minutes later, and with a close request on the closed P between polls;
  - reading P after N exists queues nothing and sends nothing; a part the operator ended
    queues nothing, as today; past the 30-minute window a poll of P fills no queue and its
    report cards still appear;
  - a request with an unknown outcome is sent again under its own key after the
    reconnect, and the relay records one message;
  - a report part handed 1 s before the drop, with no reply after it, is spoken after
    the reconnect, once; a report spoken before the drop is not spoken again;
  - the two lost attempts of slice 1 with a report owed and a request open: both end up in
    the part the browser reached, the report spoken once and the request sent once;
  - a confirmation waiting at the drop is asked about once and is sent only after a new
    yes.
- Measure: reports spoken twice and never (target: 0), duplicate sends (target: 0).

### Slice 4. Ride out blips in the same session; a failed poll stops ending the call

- The 5 s ICE grace, the cut taken at `disconnected`, the interrupt, the `cut` command on
  the contract and the route, and the same-session resume line (§3.6), together with
  polls that back off and no longer end the call (§3.2). These land as one change: on its
  own, either half loses words silently or removes the only fast signal.
- It is built whatever slice 0 counts. It is the only slice that handles the
  specification's own example, a 5 s drop mid-reply, on a client whose Viewer stays
  reachable. Slice 0's rows size the grace and give the before figure. It needs slice 2's
  resume line, and does not depend on slice 3.
- Acceptance (`liveAdapter.test.ts`, `served()` with fake media and failing fetches):
  - `disconnected` for 3 s mid-reply, then `connected`, with polls failing meanwhile: no
    new mint, one cut posted, one interrupt, one resume line in the provider's commands;
  - the same with polls answering: the interrupt lands during the episode, then one cut
    and one resume line;
  - `disconnected` for 6 s: tier 2, with the cut as the start's cursor;
  - polls failing for 20 s with the media `connected` and no episode: the call runs and no
    cut is posted; a poll that then answers `session.closed` starts tier 2;
  - the same `cutId` posted twice gives one line; a `cut` on a closed part answers
    `SESSION_CLOSED` and its cursor goes with the next `start`; the route refuses a
    malformed `cut`; the resume line waits for the interrupt's mute to lift.
- Live check: on a desktop with the Viewer on the same machine, network off for 5 s in the
  middle of a reply; the voice goes on from the cut sentence without a tap and without a
  new part.
- Measure: `connection` rows with speech in flight that ended in a resume line (target:
  all); polls that failed with no drop.

### Slice 5. Lock, sleep and network hints

- `online`/`offline`, phone visibility, the clock-jump check (§3.2, §3.10).
- Acceptance: automated with injected listeners and clock; on a real phone, a lock of
  60 s then unlock brings the call back without a tap, or stops at Reconnect with the
  audio-refused line where the browser demands a tap; the device and browser are
  recorded with the result.

### What to measure, all slices

From the journals after slice 0: drops per call-hour by cause; ICE episodes per call-hour,
recovered or not, with speech in flight or not; time from the drop being noticed to
`session.ready` and to the first resumed audio; attempts and give-ups per drop; characters
repeated and skipped at the cut; reports spoken twice or never; duplicate sends; API cost
per reconnect, including parts nobody heard. Today's baseline: drop to the next part 10.4,
31.2 and 67.9 s with a tap (§1.4).

## 6. Operator choices

**D1. A reply cut in the middle.**
- (a) Carry on with the rest from the start of the cut sentence.
- (b) One line saying where it stopped, then "Shall I go on?" On the API the voice names
  what it was explaining. On Codex the server composes the line, so it quotes the last
  words heard and cannot summarise (§3.6).
- (c) Always (b).
- Recommendation: (a) when the rest fits one hand-off (500 bytes, about two sentences),
  (b) when it is longer or what was heard is unknown.

**D2. How long to keep trying before giving up.**
- (a) 30 s or 6 attempts.
- (b) 60 s or 8 attempts.
- (c) 3 minutes or 14 attempts.
- Recommendation: (b). A network switch or a deploy takes seconds; past a minute the
  operator has usually moved on, and on the API backend each successful mint costs at
  least 15 s of voice.

**D3. Sound while reconnecting.**
- (a) The disconnect cue once, then silence until the connect or give-up cue.
- (b) (a) plus a soft tick every 5 s while trying.
- (c) A short line spoken by the browser itself ("Reconnecting"), since no voice is
  connected.
- Recommendation: (a), with (c) left to the hands-free design, which needs words where
  the screen cannot be seen; both read the table in §4.

**D4. Provider storage for continuation on the API.**
- (a) Keep `store: false`; the new session is seeded from the journal (this design).
- (b) Turn storage on so a dropped session can be forked with its full context.
- Recommendation: (a). Forking needs a completed recording, which a dropped session may
  not have, adds time to every close, and keeps every call's recording at the vendor
  for 30 days.

## 7. Deferred — not currently justified

- **Forking stored sessions** (D4 (b)): see D4.
- **Codex: a new realtime session on the same thread**, keeping the backing thread's
  context, with `initialItems` as the history. Needs the app-server child kept through
  a realtime close (`codexProvider.ts:247-251`) and a probe of the installed CLI showing
  that a second `thread/realtime/start` on the thread is accepted; the API backend
  carries today's calls.
- **Re-attaching the sideband after a Viewer restart** to the provider session the new
  Viewer finds open; today recovery hangs it up (`liveSession.ts:1126-1142`). The vendor
  documents no second attach, and slice 0 will show whether restarts are a real share
  of drops.
- **Recording the microphone during an outage** and transcribing it later. The operator
  can say again what was lost, and the resume line tells them where.
- **Playback receipts on every poll**, so the server knows the heard offset without a
  cursor. Only a reload needs it, and the one-line form covers that.
- **Role-bearing history** (`session.input`, `initialItems`) for the continuation, which
  travels as one text block today.
- **An ICE restart**: the provider offers no renegotiation.
- **Keeping the provider session open while a phone is locked**: it bills while nobody
  hears it.
- **Reconnecting by itself after a reload or on another device**: a reload is often on
  purpose, and two pages retrying would race; both keep the one-tap Reconnect.
- **One usage meter across all parts of a call.**

## 8. Unknowns and how each is settled

| Unknown | Where looked | Settled by |
| --- | --- | --- |
| Why today's three drops happened | journals, deploy list, Viewer log (§1.4) | slice 0's cause record |
| How long a browser's ICE stays `disconnected` before it recovers or reports `failed` | not measured here | slice 0's `connection` rows and close requests, on real calls; the slice 1 live check times one failure; the 5 s grace bounds it from slice 4 |
| What a locked phone does to the page, the peer and playback | task `7194c5e5` | slice 5 on a real device |
| Whether Codex accepts a second realtime start on a thread, and what `realtimeSessionId` and `existingCall` do | the 0.162.1 schema, which only names them | a probe under a scratch `CODEX_HOME` before the deferred Codex item is built |
| Whether the provider's `connection_lost` close reaches the sideband before the browser's own close | not observed | slice 0's cause record shows which arrives first |

None of these blocks the design: each slice either does not depend on it or measures it
first.

## 9. Check against the requirement

| The operator asked for | Where |
| --- | --- |
| Recovery after drops, improved | automatic tiers 1 and 2 (§3.1-§3.4), slices 1 and 4 |
| Quickly | no tap; attempt 1 within 300 ms; back within a median of 4 s after the network returns (slice 1); a 5 s drop on a client whose Viewer stays reachable rides out in the same session (slice 4) |
| Well, from the same moment where it stopped | the cursor and the resume line (§3.5, §3.6), slice 2; pending work once (§3.7), slice 3 |
| Comfortable, as in Google Meet | one calm reconnecting state, two familiar cues, the call keeping its identity (§2, §4) |
| A worked-out approach and a project task | this document; task `de4377a6` |

## Open work touching the same code

- PR #3508 (OpenAI key per feature) changes `src/lib/voiceCompanion/storage.ts`,
  `liveSession.test.ts` and `VoiceCompanionSetting.tsx`; slices 0 and 3 rebase over it.
- Lane `666f2739` (the voice knows local time) is changing the time format in the
  continuation header (`callResume.ts:60`); slice 2 edits the same header and lands
  after it or merges with it.
- Lane `7035a663` (voice timers) delivers its alerts by voice in a call; those alerts
  should use the same carry-over of owed speech (§3.7).
- The hands-free design (`2753d517`) is paused; §4 is the part it should adopt.
