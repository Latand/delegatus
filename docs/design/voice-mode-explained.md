# How voice mode works in Delegatus today

**Originating requirement (paraphrase).** Source: a private chat message the
operator dictated by voice on 2026-10-20; the original wording stays private.
The operator asked for two things. First, a visual, easy-to-follow explanation
of how voice mode works in the vendor's API: how messages are combined, how
full duplex works, and so on, because today that is not fully clear. Second, a
way for anyone to give the voice Delegatus new tools by adding an MCP server
(an installed connector such as a music or messenger one, or a script written
on the spot). The new server would join the main Delegatus MCP, and the voice
would get its tools at the next call start, ideally without rebuilding the app.
The operator should also be able to ask the orchestrator, by voice, to add such
a server.

This note is **deliverable A** of that lane: the explainer of today's voice
mode. Deliverable B (the design for extensible voice tools) and deliverable C
(the diagrams) are separate stages. This note changes no product code.

- Code: every `file:line` below is on commit `8ae63305` (main).
- Vendor docs: read on 2026-10-20 between 20:51 and 21:00 UTC. §14 lists each
  page with its HTTP status, size and digest.
- Not done: no voice session was started and no live state was read. The
  operator's current backend choice is therefore unknown here (§13).
- Convention: **observed** means read in code or in a vendor page.
  **Inferred** marks a conclusion drawn from what was read. **Unknown** marks
  what neither shows.
- Short file names: these modules are cited by file name alone.
  - `src/lib/voiceCompanion/`: `liveSession.ts`, `provider.ts`,
    `codexProvider.ts`, `sessionConfig.ts`, `tools.ts`, `admission.ts`,
    `media.ts`, `liveAdapter.ts`, `boardReads.ts`, `readPaths.ts`,
    `deliveryPaths.ts`, `storage.ts`, `usage.ts`, `callMemory.ts`,
    `liveTranscript.ts`, `codexTranscript.ts`, `contract.ts`, `server.ts`.
  - `route.ts` is `src/app/api/voice-companion/session/route.ts`.
  - `src/lib/runtime/`: `realtimeControl.ts`, `codexAppServerHost.ts`.
  - `codexRealtimeClient.ts` is in `src/lib/realtime/`.
  - `VoiceCompanionHost.tsx` is in `src/components/voiceCompanion/`, and
    `VoiceBridgeRelayHost.tsx` in `src/components/voice/`.
  - `useBridgeReportRelay.ts` is in `src/hooks/`.

---

## 0. In one minute

- Delegatus has **two voice surfaces**:
  - **Voice Delegatus** is the floating character on the desktop (a voice head
    on the phone). It talks about the board and passes work to the project's
    orchestrator. Sections 1–10 cover it.
  - **Live Mode** is a voice call on one conversation card, where you talk to
    that card's own agent. Section 11 covers it.
- Voice Delegatus runs on OpenAI **GPT-Live**, where two models share the work.
  A *speaking model* listens and talks at the same time (full duplex). A
  *backend model* reads the board and calls tools. The speaking model holds no
  tools. When it needs one, it **delegates**: it raises a signal and waits for
  the answer.
- There are **two backends**, chosen in the voice settings:
  - **API** (the default): an OpenAI key, billed per second of voice plus per
    backend answer.
  - **Codex V3**: the ChatGPT plan of a managed Codex account, through one
    local `codex app-server` process per call.
- **Audio** goes straight between the browser and the vendor over WebRTC. The
  Viewer never handles audio. **All text** goes through the Viewer:
  transcripts, tool calls, answers and orchestrator reports.
- **Tool calls run inside the Viewer process.** Board reads call the same
  functions the `viewer` MCP server uses. Sends go to the orchestrator's
  conversation. The voice talks to **no MCP server at all**: its 21 tools are a
  fixed list compiled into the app. Adding a tool today means changing code and
  rebuilding.
- **Orchestrator answers** come back as `bridge_report`s. The Viewer polls for
  them and hands them to the voice to read aloud, in parts of at most 500
  bytes.
- **Turn taking and barge-in** happen inside the speaking model. No session
  setting tunes them. The prompt tells it to stop talking when the operator
  speaks, and the browser does nothing extra.

---

## 1. Two voice surfaces

Both surfaces are mounted on every Viewer page (`src/components/Viewer.tsx:1999`,
`:2002`, `:2006`, `:2012`).

| | Voice Delegatus | Live Mode (conversation card) |
| --- | --- | --- |
| What the operator sees | Floating character with Talk on desktop; voice head on the phone | Voice button on a conversation card; picture-in-picture panel |
| Mounted by | `VoiceCompanionHost` (`src/components/Viewer.tsx:2012`, `src/components/voiceCompanion/VoiceCompanionHost.tsx:41`) | `VoicePipHost`, `VoiceBridgeRelayHost`, `VoiceComposerHost` (`src/components/Viewer.tsx:1999-2006`) |
| Browser ↔ Viewer route | `/api/voice-companion/session` (`src/app/api/voice-companion/session/route.ts:13-75`) | `/api/runtime/realtime` (`src/app/api/runtime/realtime/route.ts:11-30`) |
| Vendor call | API: `POST /v1/live/sessions` (`src/lib/voiceCompanion/provider.ts:49`). Codex: `thread/realtime/start` v3 (`src/lib/voiceCompanion/codexProvider.ts:68-71`, `:189`) | `thread/realtime/start` v3 on the conversation's own Codex host (`src/lib/runtime/codexAppServerHost.ts:2673-2700`) |
| Who does the work behind the voice | A backend model (`gpt-6-luna`) with the 21 voice tools | The conversation's own agent, with its own MCP servers |

Voice Delegatus mounts only when it is switched on in settings
(`VoiceCompanionHost.tsx:48`). Mounting starts no call; the tap on Talk does
(`VoiceCompanionHost.tsx:39`).

---

## 2. The vendor API in plain words

**GPT-Live** is OpenAI's voice API. The vendor's own summary: "GPT-Live handles
a spoken conversation while a backend agent looks up information, uses tools,
and completes tasks. It can listen while speaking (**full duplex**). Sending
work to the backend is called **delegation**."
([Getting started](https://developers.openai.com/api/docs/guides/live))

- **Two parts.** "GPT-Live handles conversation. It listens, speaks, and
  decides when to ask the backend for help." "The backend handles delegated
  tasks … The backend reasons, uses tools, and returns results for GPT-Live to
  communicate."
  ([Understand the two parts](https://developers.openai.com/api/docs/guides/live#understand-the-two-parts))
- **Two delegation modes**
  ([Choose a delegation mode](https://developers.openai.com/api/docs/guides/live-delegation#choose-a-delegation-mode)):
  - In **Responses delegation**, OpenAI runs the backend model and its tools,
    including hosted tools and MCP.
  - In **client delegation**, "your application prepares the context, runs an
    agent or workflow, and sends results back".
  - **Delegatus uses client delegation**: `delegation: { type: "client" }`
    (`src/lib/voiceCompanion/sessionConfig.ts:70`). The delegation event
    "does **not** contain the user's utterance or task text"
    ([Keep the conversation context in your application](https://developers.openai.com/api/docs/guides/live-delegation#keep-the-conversation-context-in-your-application)).
    The Viewer therefore keeps the transcript itself and builds every backend
    request from it (§8).
- **Connections.** WebRTC "carries audio on media tracks and JSON events on a
  data channel". A **sideband** is "an additional WebSocket" through which a
  server monitors and controls the same session
  ([Choose a connection](https://developers.openai.com/api/docs/guides/live#choose-a-connection),
  [Server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live)).
  Delegatus uses WebRTC for audio and the sideband for every event
  (`provider.ts:64-65`).
- **Billing.** "GPT-Live voice sessions are billed by duration, per second." A
  WebRTC session creation "bills 15 seconds of voice duration during
  initialization"
  ([WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)).
  Delegatus books those 15 seconds at mint (`src/lib/voiceCompanion/liveSession.ts:248`).
- **Codex V3** reaches the same speaking-model family through Codex's
  app-server, with the model `gpt-live-1-codex` (`codexProvider.ts:69`).
  - Its realtime methods are marked "EXPERIMENTAL" in the protocol schema that
    the installed Codex generates (`codex-cli 0.162.1`, §14).
  - They do not appear on the public
    [Codex App Server](https://learn.chatgpt.com/docs/app-server.md) page: the
    word "realtime" has 0 matches there.
  - The tools of the Codex backing turn use the app-server's "dynamic tools",
    which that page also marks experimental (its section "Dynamic tool calls
    (experimental)").

---

## 3. Components map

```
                              OPERATOR
                       speaks |      ^ hears
                              v      |
+------------------------- BROWSER (Delegatus tab) ----------------------------+
| VoiceCompanion UI -- OfficialVoiceCompanionAdapter (liveAdapter.ts)          |
|   microphone --> RTCPeerConnection --> voice audio --> <audio> + analyser    |
|   data channel "oai-events": opened; the session lets no event through it    |
|   polls GET /api/voice-companion/session every 500 ms (text, reports, cost)  |
+-------+-----------------------------------------------------+---------------+
        | WebRTC audio, both ways                             | HTTP, same origin,
        | (never through the Viewer)                          | operator only
        v                                                     v
+------ VENDOR (OpenAI) ---------------+    +------ VIEWER (Next.js server process) -------------+
| API backend:                         |    | /api/voice-companion/session                       |
|   GPT-Live session, gpt-live-1  <----+----+ CompanionLiveSessions (liveSession.ts)             |
|   sideband WebSocket  ---------------+--->|   event queue, transcript, delegation loop,        |
|   Responses API, gpt-6-luna  <-------+----+   watchdog, cost reservations                      |
|                                      |    | tools.ts registry (21 tools)                       |
| Codex backend:                       |    |   board reads --> viewerReadTools (mcp/bindings.ts)|
|   the same voice family on a ChatGPT |    |   sends -----> conversation-host --> orchestrator  |
|   plan, via one `codex app-server`   |<-->|   reports <--- bridge report log <-- bridge_report |
|   child per call (stdio JSON-RPC)    |    | CompanionAdmission (journal, receipts, watermarks) |
+--------------------------------------+    +---------------+-------------------------^----------+
                                                            | send (steer-or-queue)   | bridge_report via
                                                            v                         | the agent's own MCP
                                              ORCHESTRATOR conversation (a Claude or Codex agent)
```

### Where the MCP sits

- **The voice runs beside the `viewer` MCP server.** That server is a stdio
  process which each agent CLI launches for itself (`src/lib/mcp/entry.ts:1-20`;
  its environment is built in `src/lib/agent/spawnPolicy.ts:93-123`). The voice
  never connects to it.
- **The voice's board reads call the same implementations in the Viewer
  process.** Comment at `src/lib/voiceCompanion/readPaths.ts:25-26`: "In-process
  reads use the same implementations as MCP, without receipts or
  lifecycle-journal writes." The call itself is at `readPaths.ts:38`
  (`viewerReadTools(domain, …)`), defined at `src/lib/mcp/bindings.ts:8008-8020`.
- **No MCP inventory reaches a voice session.**
  - Comment at `src/lib/voiceCompanion/tools.ts:89-90`: "No general MCP tool
    inventory enters a voice session."
  - The Codex voice child starts with `-c mcp_servers={}` and the shell tool
    off (`codexProvider.ts:57-58`).
  - The API backend request carries only the registry's tools
    (`sessionConfig.ts:80`, `tools.ts:196-197`).
- **The orchestrator answers through its own MCP.** It calls `bridge_report`
  (a tool of the `viewer` MCP server, `src/lib/mcp/server.ts:112`). The report
  lands in the bridge report log, and the voice's poll reads it from there
  (`src/lib/voiceCompanion/deliveryPaths.ts:22-23`).

---

## 4. Starting a call

### Sequence S1: start on the API backend

```
Operator      Browser (adapter + media)            Viewer                          OpenAI
  | tap Talk       |                                  |                                |
  |--------------->| getUserMedia (echo cancel, ...)  |                                |
  |                | create offer, wait for ICE       |                                |
  |                |-- POST start {project, locale, sdp, requestId} -->|               |
  |                |                                  | voice on? reserve budget       |
  |                |                                  | read call memory, project list |
  |                |                                  |-- POST /v1/live/sessions ----->| config + offer
  |                |                                  |<-- {session.id, answer sdp} ---|
  |                |                                  |-- WSS /v1/live/sessions/{id}/attach -->| sideband
  |                |<-- 201 {sessionId, sdp} ---------|                                |
  |                | setRemoteDescription(answer)     |                                |
  |                |<=================== WebRTC audio, both ways ======================>|
  |   connect cue  | poll events every 500 ms ------->|                                |
```

Evidence for each step:

| Step | Code |
| --- | --- |
| Browser side | `liveAdapter.ts:99-139`, `media.ts:36-76` |
| Start route | `route.ts:23-29` |
| Settings and budget checks | `liveSession.ts:185-211` |
| Mint | `provider.ts:46-63`, called at `liveSession.ts:231` |
| Sideband | `provider.ts:64-89`, attached at `liveSession.ts:249-258` |
| Poll cadence | `liveAdapter.ts:149` |
| Connect cue | `liveAdapter.ts:127` |

### Sequence S1b: start on the Codex backend

```
Viewer                                     codex app-server (one child per call)      OpenAI (ChatGPT plan)
 | pick a managed account with plan room           |                                       |
 | spawn leased helper: codex -c mcp_servers={} -c features.shell_tool=false ... app-server |
 |-- account/read (must be a ChatGPT login) ------>|                                       |
 |-- thread/start {gpt-6-luna, dynamicTools = 21 registry tools,                           |
 |                 approval never, sandbox read-only, ephemeral} ----------------------->  |
 |-- thread/realtime/start {v3, gpt-live-1-codex, webrtc offer, prompt, voice "cove"} ---->|
 |                                                  |--------- negotiates the call ------->|
 |<-- thread/realtime/sdp {answer} -----------------|                                       |
 | the answer goes back to the browser exactly as in S1                                     |
```

Evidence: account choice at `codexProvider.ts:47-56` and `:110-111`. The child
is spawned at `:120-133` with the arguments at `:57-58`. The ChatGPT login
check is at `:134`, `thread/start` at `:136` (parameters `:62-67`), the start
call at `:189` (parameters `:68-71`), and the SDP answer at `:175-177`.

### What the session carries

| Setting | API backend | Codex backend | What the vendor says |
| --- | --- | --- | --- |
| Speaking model | `gpt-live-1` (`sessionConfig.ts:10`, `:67`) | `gpt-live-1-codex` (`codexProvider.ts:69`) | "Set the required `model`." Changing it needs a new session ([configuration fields](https://developers.openai.com/api/docs/guides/live-conversations#configuration-fields)) |
| Speaking instructions | `liveInstructions(...)` (`sessionConfig.ts:20-58`), described below | The same text as `prompt` (`codexProvider.ts:70`) | "up to 16,384 tokens"; add more later with `session.instructions.append` |
| History (`input`) | Not used; memory travels inside the instructions (`provider.ts:51` → `sessionConfig.ts:57`) | Memory goes into the backing thread's developer instructions (`codexProvider.ts:63`) and into the prompt (`:70`) | `input` takes "up to 128 messages and 8,192 combined tokens" |
| Voice | `meridian` (`sessionConfig.ts:14`) | `cove`, the operator's pick (`codexProvider.ts:28-30`) | Default `marin`; a new session is needed to change it. The table lists Meridian as "Masculine, Natural" |
| Delegation | `client` (`sessionConfig.ts:70`) | A backing Codex turn on the call's own thread; `clientManagedHandoffs: false` (`codexProvider.ts:70`) means Codex forwards the backing answer into the voice by itself | Mode is chosen at creation; switching needs a new session |
| Storage | `store: false` (`sessionConfig.ts:67`) | `ephemeral: true` thread (`codexProvider.ts:64`) | `store: true` is needed for forks and recordings |
| Browser data channel | `allowed_client_events: []`, `allowed_server_events: []` (`sessionConfig.ts:69`): the page can send no command and receives no provider event | Not applicable | "an empty array allows none" ([primary WebSocket reference](https://developers.openai.com/api/reference/resources/live/primary-websocket), `client.data_channel`) |
| Tools of the speaking model | None. It sees only the "Backend tools:" capability list in its prompt (`sessionConfig.ts:34-35`) | None, same prompt | The template's "Backend tools" list is what "GPT-Live uses … to decide which requests to hand off" ([Prompting GPT-Live](https://developers.openai.com/api/docs/guides/live-prompting)) |
| Tools of the backend | 21 strict function tools (`tools.ts:196-197`), sent with every backend request (`sessionConfig.ts:79-83`) | The same 21 as `dynamicTools` (`codexProvider.ts:65`) | — |
| Backend settings | `gpt-6-luna`, `tool_choice` auto (none on the last round), `parallel_tool_calls: false`, `max_output_tokens: 2048`, reasoning effort `none`, `store: false` (`sessionConfig.ts:79-83`, `usage.ts:9`) | `gpt-6-luna`, approval `never`, sandbox `read-only`, no shell tool, no MCP servers (`codexProvider.ts:57`, `:64`) | — |
| Backend instructions | `BACKEND_INSTRUCTIONS` plus the interface language (`sessionConfig.ts:59`, `:80`) | The same text as developer instructions (`codexProvider.ts:63-66`) | "Keep detailed instructions, business rules, and tool workflows" in the backend ([Getting started](https://developers.openai.com/api/docs/guides/live)) |
| Who pays | The settings key or `OPENAI_API_KEY` (`storage.ts:297`). Voice seconds and each backend answer are reserved before use (`liveSession.ts:207`, `:469`) | The ChatGPT plan of a managed account; no key and no monthly cap (`VoiceCompanionHost.tsx:49-52`) | Voice billed per second; backend usage billed separately |

What the speaking instructions contain (`sessionConfig.ts:20-58`):

- who Delegatus is and the project in view;
- the languages it may hear;
- its character, and masculine forms when speaking of itself;
- its pace;
- a **Backchannel policy** and an **Interruption policy** (`:29-31`);
- a **Delegation policy**: a "Backend tools:" list generated from the registry
  (`:34-35`) and when to delegate and when not (`:39-52`);
- rules for prototype reviews (`:55`);
- an **Ending policy** (`:57`);
- at the end, the memory of earlier calls and the known-projects list
  (`liveSession.ts:203`, `:219`, `:231`).

---

## 5. Audio, both ways

- **Microphone.** `getUserMedia` with echo cancellation, noise suppression and
  automatic gain (`media.ts:38`). The track goes onto the peer connection
  (`media.ts:59`).
- **Voice.** The remote audio track plays in an autoplay `<audio>` element
  (`media.ts:47-55`). An analyser on the same stream measures loudness, which
  drives the character's mouth and its "speaking" state (`media.ts:52-53`,
  `:89-108`). The adapter pairs played audio with the voice's transcript lines
  as they arrive (`liveAdapter.ts:185-244`).
- **The Viewer never receives audio.** Media travels on the WebRTC tracks
  ([Choose a connection](https://developers.openai.com/api/docs/guides/live#choose-a-connection)).
  A sideband does receive copies of the audio
  ([Receive reflected audio](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live)),
  but the Viewer's event handler reads only the event types it lists and drops
  those copies (`liveSession.ts:334-423`).
- **Mute.** Mute disables the local microphone track (`media.ts:109`) and sends
  `session.input_audio.mute` (`liveSession.ts:834`). Vendor: "Muting input
  leaves the session running: the model can keep generating speech, and
  delegated work can continue"
  ([Control microphone input](https://developers.openai.com/api/docs/guides/live-conversations#control-microphone-input)).
- **Project switch.** The microphone stays muted until the Viewer confirms the
  new project context (`liveAdapter.ts:264-266`).
- **Codex backend.** The browser media code is the same. The answer SDP comes
  from the app-server's `thread/realtime/sdp` notification
  (`codexProvider.ts:175-177`). *Inferred:* media flows between the browser
  and the provider, and the Codex process only does the signalling. The Live
  Mode client says the same about its own Codex call: "the WebRTC leg runs to
  the provider" (`src/lib/realtime/codexRealtimeClient.ts:56`).

---

## 6. Turn detection and VAD

- **Nothing to configure.** A GPT-Live session has six settings: model,
  instructions, history, voice, delegation and storage
  ([configuration fields](https://developers.openai.com/api/docs/guides/live-conversations#configuration-fields)).
  None of them is turn detection or voice activity detection (VAD).
  - The older **Realtime API** does have VAD (`session.audio.input.turn_detection`,
    [Voice activity detection](https://developers.openai.com/api/docs/guides/realtime-vad)).
    The voice never calls that API, and no source file outside tests
    mentions `turn_detection` (searched `src`, 2026-10-20).
  - The Codex start parameters have no VAD field either (§14,
    `ThreadRealtimeStartParams`).
- **The speaking model decides** when the operator has finished, when to
  answer and when to make a short listening sound. The vendor steers this
  through the prompt template's "Backchannel policy" and "Interruption policy"
  ([Prompting GPT-Live](https://developers.openai.com/api/docs/guides/live-prompting)).
  Delegatus's lines: "Backchannel policy: Listen attentively; keep
  acknowledgments brief." and "Interruption policy: Stop speaking when the
  operator interrupts. Listen to what they say." (`sessionConfig.ts:29-31`).
  How the model detects a turn internally is **unknown**: the pages read do
  not say.
- **Delegatus's own "turns" are bookkeeping and have no effect on audio.**
  - The vendor: "Transcript deltas have no item ID or event that marks a
    completed conversational turn, so your application decides how to group
    them"
    ([Transcript deltas](https://developers.openai.com/api/docs/guides/live-conversations#transcript-deltas)).
  - Delegatus groups fragments into display lines on a 1.5-second pause
    (`src/lib/voiceCompanion/liveTranscript.ts:7`).
  - It counts an operator **turn** as "the speech between two of the
    companion's answers or delegations" (`liveTranscript.ts:16-17`).
  - That turn ties a send, a confirmation or a hang-up to the operator's own
    words (`liveSession.ts:454`, `tools.ts:185`).
  - On Codex, a transcript `done` notification closes a part
    (`codexTranscript.ts:17-22`).

---

## 7. Full duplex and barge-in

### Sequence S2: one exchange with an interruption

```
time ----------------------------------------------------------------------------------->

Operator : "what's open on the board?"                   "wait, only the pipelines"
Voice    :            "sure, one sec"   [reads the answer ..........]x  "OK, pipelines only..."
                                                                     ^ operator talks over it:
                                                                       the model stops and listens
Viewer   :     delegation #1 -> backend rounds -> commentary.append(#1)
                                                          delegation #2 -> rounds -> append(#2)
Backend  :     [ list_tasks, list_pipelines ........ done ]   [ list_pipelines ... done ]
Browser  : microphone always open; voice audio plays; no local ducking
```

- **The model listens while it speaks**
  ([Getting started](https://developers.openai.com/api/docs/guides/live)). It
  is told to stop when the operator talks (`sessionConfig.ts:31`). The vendor
  separates the two: "'Stop talking' asks the assistant to yield; 'Cancel my
  booking' asks the backend to take an action"
  ([Interruptions](https://developers.openai.com/api/docs/guides/live-prompting)).
- **The browser does not cut the voice when the microphone hears sound**
  (`media.ts:16-18`). An earlier build muted the voice whenever the microphone
  went above a level, so echo and breathing cut it off. That was removed after
  the first live session
  (`docs/design/voice-delegatus-live-feedback.md`, item 4).
- **An explicit interrupt path exists, but nothing uses it.** Three pieces are
  in place:
  - the session route accepts `command: interrupt` (`route.ts:49`);
  - the adapter mutes received audio until 1.5 seconds of quiet
    (`liveAdapter.ts:246-251`, `media.ts:93-100`, `:110-115`);
  - the Viewer then appends the instruction "Yield to the operator now…"
    (`liveSession.ts:835-836`).

  No shipped control sends that command. A search of `src` outside tests finds
  it only in the contract type (`contract.ts:148`) and the route check. Today,
  barge-in is entirely the model's.
- **Backend work keeps going after an interruption.** Vendor: "Interrupting the
  spoken conversation leaves backend work running"
  ([Keep updates accurate and useful](https://developers.openai.com/api/docs/guides/live-delegation#keep-updates-accurate-and-useful)).
  The code agrees: the delegation loop stops only when the call ends or closes
  (`liveSession.ts:465`, `:483`). Its answer is still handed to the voice with
  its delegation id (`liveSession.ts:686-688`, `:717-724`), and the speaking
  model decides how to use it.
- **Handing text over is not the same as speaking it.** Vendor: the append
  acknowledgement marks when context reached the session, "not speech or
  playback"
  ([Understand when context reaches the model](https://developers.openai.com/api/docs/guides/live-conversations#understand-when-context-reaches-the-model)).
  On the API backend, a report part counts as handed once the provider took it
  (`liveSession.ts:689-693`). On Codex, the Viewer holds report speech until
  the voice is silent and no backing turn runs (`codexProvider.ts:321-334`),
  because, in the code's words, "Standalone speech can be lost while a
  backing answer is being voiced" (`:321`).
- **Report handoffs wait for recognized input and backend work.**
  `CompanionLiveSessions` in `src/lib/voiceCompanion/liveSession.ts` holds due
  parts from the first valid operator transcript fragment. An API delegation
  keeps them held until its answer has been handed over and its work has
  settled. A newer input generation survives an older delegation's completion.
  A Codex backing turn holds them while it runs, and its completion releases
  only an input the turn was given or steered to cover. For a direct voice
  answer, output starting at or after the latest input's end releases the
  hold. Earlier overlapping output leaves it in place, and so does any speech
  while input was dictated within the 15-second hold window of an answer's
  start or end: the voice speaks that answer in as many transcript items as it
  needs, so only the request's own answer, or the lapse of the window, releases
  the hold.
  Live exposes no speech-start or turn-done event
  ([transcript deltas](https://developers.openai.com/api/docs/guides/live-conversations#transcript-deltas)),
  so this guard starts with recognized input. Microphone levels continue to
  leave duplex audio alone. Every report part rechecks the hold; accepted
  parts retain their `speechHanded` receipts and the rest resume in order.

---

## 8. How messages are combined

### Three places hold "the conversation"

1. **Inside the speaking model**, kept by the vendor:
   - It holds the startup instructions, the operator's audio, the model's own
     speech and every append.
   - The window is 128,000 tokens. "When context usage exceeds 90%, it starts
     a replacement voice engine within the same session. The replacement
     receives your original instructions and up to 8,192 tokens of
     conversation history"
     ([Manage longer conversations](https://developers.openai.com/api/docs/guides/live-conversations#manage-longer-conversations)).
   - Delegatus cannot read this context.
2. **Delegatus's call record**, kept by the Viewer. It holds every transcript
   segment, delegation, tool call (with arguments and result), handoff (each
   text given to the voice), receipt and report (`liveSession.ts:325-333`,
   `:374-375`, `:566`, `:722`).
3. **The backend's input.** On the API backend it is rebuilt from (2) for each
   delegation; the request is stateless. On Codex it is the call's ephemeral
   thread, which keeps its own history between backing turns
   (`codexProvider.ts:63`, "whose answer is in this thread").

### Every kind of message, and how it gets in

| Message | Written by | How it reaches the voice | Vendor meaning | Code |
| --- | --- | --- | --- | --- |
| Operator speech | Operator | WebRTC audio, heard directly; transcript deltas come back on the sideband | User transcript deltas | `media.ts:59`, `liveSession.ts:349-353` |
| Voice reply | Speaking model | WebRTC audio, plus output transcript deltas | Captions per speaker, independent | `liveSession.ts:349-353` |
| Delegation | Speaking model | API: `session.delegation.created`. Codex: realtime item `handoff_request` | Carries no task text | `liveSession.ts:356-383`, `codexProvider.ts:229-231` |
| Backend tool calls and results | Backend model and Viewer | Stay in the backend; the speaking model never sees them | — | `liveSession.ts:507-539`, `codexProvider.ts:145-153` |
| Answer to a delegation | Backend's final text, checked for claims of delivery that were never confirmed | API: `session.commentary.append` with that delegation's id. Codex: the backing turn's answer, forwarded by Codex | "information for the model to say aloud, which it may paraphrase"; at most 500 tokens | `liveSession.ts:494-506`, `:686-688`, `:717-724`; `codexProvider.ts:70` |
| Orchestrator report or message | Orchestrator, through `bridge_report` | API: `session.commentary.append` with `delegation_id: null`, in parts of at most 500 bytes. Codex: `thread/realtime/appendSpeech` | Same as above | `liveSession.ts:110`, `:694-716`; `codexProvider.ts:317-334` |
| Project switch | Operator's view in the browser | API: `session.instructions.append`. Codex: a developer item via `thread/inject_items`, then `thread/realtime/appendText` as developer | Instructions "influence behavior and speech"; "can interrupt speech in progress" | `liveSession.ts:650-658`, `codexProvider.ts:305-309` |
| Memory of earlier calls; project list | Viewer, at start | Inside the instructions (API); the thread's developer instructions and the prompt (Codex) | Startup context | `liveSession.ts:203`, `:219`, `:231`; `sessionConfig.ts:57`; `codexProvider.ts:63` |
| Notices: confirmation expired, budget spent, plan limit | Viewer | Commentary append (API) or `appendSpeech` (Codex) | — | `liveSession.ts:848`, `:730`; `codexProvider.ts:96-99`, `:327-332` |
| Interrupt (unused, §7) | — | `session.instructions.append` | — | `liveSession.ts:835-836` |

The vendor's channel for quiet facts and UI state is `session.thinking.append`
([Share UI context](https://developers.openai.com/api/docs/guides/live-delegation#share-ui-context)).
Delegatus never sends it: outside tests, only the simulator fixture
`fakeProvider.ts:6` mentions it.

### Sequence S3: what one backend request holds (API backend)

```
backend request  (one Responses call; stateless; store: false)       liveSession.ts:460-467
  model: gpt-6-luna      tools: the 21 registry functions      tool_choice: auto (none at the end)
  instructions: BACKEND_INSTRUCTIONS + "The operator's interface language is ..."
  input:
    [developer] memory of earlier calls (when call memory is on)
    [user]  project in view and the known projects
            reads earlier in this call (last 6, each with its answer)
            requests still waiting for the orchestrator's report
            the conversation so far ("Operator: ..." / "Delegatus: ..." lines, last 12,000 chars)
            the operator's latest turn: "Act on that turn alone"
            a confirmation waiting for the operator's answer, if any
    [function_call] + [function_call_output] ... added each round (at most 4 rounds)
    [user]  prototype frame images, when view_prototype_frame returned some
    [user]  "The tool budget ... is spent. Answer now ..." on the final round
```

On Codex the backing turn runs inside the Codex thread. Which parts of the
spoken conversation the Codex V3 runtime gives that turn is internal to Codex:
**unknown**.

---

## 9. Tool calls, there and back

### Sequence S4: a board question on the API backend

```
Voice model        Viewer (liveSession + tools)                    Responses API      Board
  | delegation.created(id) |                                          |                 |
  |----------------------->| build the input (S3)                     |                 |
  |                        | reserve the price of one answer          |                 |
  |                        |---------------- respond(input) --------->|                 |
  |                        |<-------- function_call list_pipelines ---|                 |
  |                        | runCompanionTool: allowlist + strict args |                 |
  |                        |---- viewerReadTools.list_pipelines (same code as the MCP) ->|
  |                        |<--------------------------------- rows --------------------|
  |                        | shrink to a speech-size answer; reuse for 2 min             |
  |                        |---------------- respond(+ result) ------>|                 |
  |                        |<------------------------- text ----------|                 |
  |<-- commentary.append(id, answer) ---------------------------------|                 |
  | speaks it              |                                          |                 |
```

Evidence:

| Step | Code |
| --- | --- |
| Delegation loop | `liveSession.ts:434-549` |
| Budget per answer | `liveSession.ts:469` |
| Request | `liveSession.ts:473`, `provider.ts:37-45` |
| Tool run | `liveSession.ts:550-620`, `tools.ts:199-211` |
| Read cache | `liveSession.ts:622-648` |
| Answer size bound | `boardReads.ts:54-66` |

### Sequence S5: the same question on the Codex backend

```
Voice (gpt-live-1-codex)   codex app-server                           Viewer
  | handoff_request item  |                                            |
  |---------------------->| thread/realtime/itemAdded --------------->| records the delegation,
  |                       |                                            | freezes the project for it
  |                       | starts a backing turn (gpt-6-luna)        |
  |                       |-- item/tool/call {tool, arguments, turnId} ->| runCompanionTool (same registry)
  |                       |<-- {contentItems: [text, images]} ----------|
  |                       | the turn's answer goes to the voice by itself (clientManagedHandoffs: false)
  |<----- speaks it ------|                                            |
```

Evidence:

- Handoff → delegation: `codexProvider.ts:229-231`, `liveSession.ts:376-382`.
- Turn started and completed: `codexProvider.ts:232-258`.
- Tool request: `codexProvider.ts:145-153` (schema `DynamicToolCallParams`, §14).
- Result shape: `codexProvider.ts:76-79`.
- Vendor flow: "`item/tool/call` as a server request to the client" ([Codex
  App Server](https://learn.chatgpt.com/docs/app-server.md), section "Dynamic
  tool calls (experimental)").

### Sequence S6: a send to the orchestrator, and its report coming back

```
Voice    Viewer                         Orchestrator conversation       viewer MCP      Bridge report log
  | "pass it on"                              |                              |                 |
  |-> request_orchestrator_delegation         |                              |                 |
  |   admission.delegate                      |                              |                 |
  |   conversation-host POST (steer-or-queue) |                              |                 |
  |   text + trailer: "answer with bridge_report, correlatesDirective = <key>"                 |
  |------------------------------------------>| works on it                  |                 |
  |<- "Sent to the orchestrator."             |-- bridge_report(...) ------->|---- appended -->|
  |                                           |                              |                 |
  |   browser poll (every ~500 ms) -> events(): pollReports past the watermark <---------------|
  |   split into parts of at most 500 bytes, record each part handed                          |
  |<- commentary.append (API) / appendSpeech (Codex)                                           |
  | reads the report aloud                                                                     |
```

Evidence:

| Step | Code |
| --- | --- |
| Send | `deliveryPaths.ts:32-50` (policy `steer-or-queue` and the `voiceDelegatus` marker at `:40-41`) |
| Trailer | `admission.ts:62` |
| Poll chain | `liveAdapter.ts:149` → `route.ts:73` → `liveSession.ts:838-853` |
| Which reports count | New reports of the project in view or of any project the call sent to (`admission.ts:598-601`), after a stored watermark (`admission.ts:608-629`) |
| Queue capacity | 64 (`admission.ts:84`) |
| Speaking a report | `liveSession.ts:694-716` |

### The 21 tools

| Group | Tools | Code |
| --- | --- | --- |
| Board reads (14) | `list_tasks`, `get_task`, `list_pipelines`, `get_pipeline`, `agent_activity`, `conversation_messages`, `orchestrator_messages`, `orchestrator_actions`, `search_transcripts`, `read_prototype_review`, `view_prototype_frame`, `agent_fleet`, `get_orchestrator`, `list_projects` | `boardReads.ts:12`, `tools.ts:72-96` |
| Reads about this call (3) | `show_orchestrator_message`, `orchestrator_reports`, `reread_orchestrator_report` | `tools.ts:97-128` |
| Owner read (1) | `relay_owner_history` (Telegram groups; its switch defaults off) | `tools.ts:105-112` |
| Delegation (2) | `request_orchestrator_delegation`, `resolve_orchestrator_confirmation` | `tools.ts:129-179` |
| Session control (1) | `end_conversation` | `tools.ts:180-189` |

Guards around the tools:

- **Allowlist and strict arguments.** Anything outside the registry is refused
  `TOOL_NOT_ALLOWED`, and extra or invalid arguments are refused
  (`tools.ts:199-211`). The Codex handler refuses unknown names before running
  anything (`codexProvider.ts:147-149`).
- **Bounded rounds.** At most 4 tool rounds, then one answer with tools off
  (`usage.ts:14`, `liveSession.ts:464-467`).
- **No repeated reads.** The same read within 2 minutes is answered from
  memory (`liveSession.ts:629-633`).
- **Private history stays private.** After a Telegram group read, sends are
  blocked (`liveSession.ts:568-579`).
- **A send needs the operator's own words.** A send must answer an explicit
  operator ask (`BACKEND_INSTRUCTIONS`, `sessionConfig.ts:59`), and a hang-up
  is checked against the operator's words (`tools.ts:184-186`).

**What this means for new tools today.** The registry is TypeScript in
`tools.ts`. Two other lists are generated from it: the "Backend tools:" list in
the speaking prompt (`sessionConfig.ts:34-35`) and the Codex `dynamicTools`
(`codexProvider.ts:65`). Any new tool therefore needs a code change, a rebuild
and a restart. Deliverable B designs the alternative.

---

## 10. Call lifetime and restart

| Moment | What happens | Code / vendor |
| --- | --- | --- |
| Start | Idempotent per `requestId`. A call whose hang-up the provider never confirmed blocks a new one. | `liveSession.ts:163-184`, `:168-171` |
| During the call | A watchdog runs every 5 seconds. It closes the call when the voice is switched off, when the monthly cap is reached (API), or when the browser has not polled for 30 seconds. | `liveSession.ts:264-274` |
| Long API call | The budget reservation grows in 5-minute steps of voice; a refusal ends the call with reason `cap`. | `liveSession.ts:899-907`, `usage.ts:20` |
| Project switch | Same session, same read cache; the new project arrives as context. | `liveSession.ts:649-658` |
| Hang-up | Send `session.close`, wait for `session.closed` with the final usage, force a hang-up after 15 seconds. | `liveSession.ts:854-869`; vendor [Usage and graceful close](https://developers.openai.com/api/docs/guides/live-conversations#usage-and-graceful-close) |
| Lost connection or provider error | Hang up and close. | `liveSession.ts:874-883`, `:416-421` |
| Viewer restart | A call the old Viewer started has no owner. The new Viewer closes it on first use and again before any new start. A call never survives a Viewer restart; there is no resume. | `server.ts:20`, `liveSession.ts:740-826` |
| Codex call | One leased `codex app-server` child per call. Hang-up sends `thread/realtime/stop`, closes stdio, waits up to 5 seconds for the child to exit and deletes the call's temp folder. | `codexProvider.ts:126`, `:335-356` |
| Codex plan runs out | The voice says one sentence ("The Codex plan limit is reached…"), then the call ends with reason `limit`. | `codexProvider.ts:96-99`, `:162-172`; `liveSession.ts:391-400` |
| Vendor-side end | The close reasons are `close_requested`, `expired` ("reached its duration limit"), `content`, `remote_hangup` and `connection_lost`. The duration limit's value is not stated in the pages read: **unknown**. | [Usage and graceful close](https://developers.openai.com/api/docs/guides/live-conversations#usage-and-graceful-close) |
| Next call | A brand-new session. Recent call summaries reach it through the instructions (`callMemory.ts:129-132`, design in `docs/design/voice-call-memory.md`). The vendor's "fork" needs `store: true`; Delegatus uses `store: false`. | [Store and fork a session](https://developers.openai.com/api/docs/guides/live-conversations#store-and-fork-a-session) |

---

## 11. The other voice: Live Mode on a conversation card

Live Mode talks to one conversation's own agent; it does not use the voice
companion's code.

```
Browser (card / PiP)                    Viewer + runtime host                       Vendor
 | getUserMedia, offer, data channel     |                                            |
 |-- POST /api/runtime/realtime {start, conversationId, sdp} -->|                     |
 |                                       | the conversation's Codex app-server host   |
 |                                       |-- thread/realtime/start {v3, gpt-live-1-codex,
 |                                       |     clientManagedHandoffs: true, codexResponsesAsItems: true,
 |                                       |     includeStartupContext: true, persona prompt,
 |                                       |     start/end instructions for the agent, initialItems} -->|
 |<-- {sdp, realtimeSessionId} ----------|                                            |
 |<==================== WebRTC audio; provider events on the data channel ===========>|
 |-- selectedContext / appendSpeech (the selected card, per utterance) -->|            |
 |-- deliverWorkerResponse (the agent's answer, into the call) --------->|            |
 | VoiceBridgeRelayHost: manager reports -> worker deliveries ---------->|            |
```

What differs from Voice Delegatus:

- **The browser reads provider events directly** from the data channel
  (`codexRealtimeClient.ts:590`, `:606-608`).
- **The work behind the voice is the card's own agent thread.** That thread's
  MCP servers are configured in it: `viewer` and any granted servers
  (`src/lib/codexHeadlessConfig.ts:82-90`, `:111-133`;
  `codexAppServerHost.ts:1599-1601`, `:1705-1725`). Work started by voice in
  Live Mode can therefore use every MCP tool that agent has. Start parameters:
  `codexAppServerHost.ts:2673-2700`, model at `:410`.
- **Selected-card context is a Live Mode feature.** Each utterance can carry
  the card the operator has selected; the Viewer admits it against the call's
  binding (`realtimeControl.ts:345-360`, `:423-452`). Voice Delegatus has no
  selected-card context; it knows only the project in view.
- **Bridge reports reach Live Mode through a separate relay**
  (`VoiceBridgeRelayHost.tsx:22-37`, `useBridgeReportRelay.ts:21-44`). The
  relay delivers them into the call as worker deliveries
  (`realtimeControl.ts:453-459`, `codexRealtimeClient.ts:769-804`).

---

## 12. Observations worth knowing (no fixes here)

These came up while reading. None is in scope for this note; parts B and C,
or later work, can pick them up.

1. **Prompt wording versus the vendor guide.** The vendor says: "For
   `gpt-live-1`, use the instruction `Generate <|SpawnThinking|>` when the
   model should request backend work, rather than 'delegate to the backend.'"
   ([Prompting GPT-Live](https://developers.openai.com/api/docs/guides/live-prompting)).
   Delegatus's prompt says "Delegate to the backend when:"
   (`sessionConfig.ts:39`, `:47`). Effect on delegation rate: not measured.
2. **UI context goes through the instruction channel.** The vendor recommends
   `session.thinking.append` for UI context and says instructions "can
   interrupt speech in progress". Delegatus sends the project switch with
   `session.instructions.append` (`liveSession.ts:656`). Effect: not measured.
3. **The interrupt command is unreachable from the UI** (§7).
4. **Responses delegation can run MCP servers itself.** Vendor: "Responses
   delegation also supports MCP" and "Live passes the MCP `authorization` and
   `headers` you provide to Responses"
   ([Add MCP and other tools](https://developers.openai.com/api/docs/guides/live-delegation#add-mcp-and-other-tools)).
   Delegatus uses client delegation, which keeps every tool call inside the
   Viewer. This is an input for part B.
5. **The report poll reads the whole report log every time.** Each events
   poll (about every 500 ms per active call) reads the whole bridge report
   log, then filters it by project (`deliveryPaths.ts:22-23` →
   `src/lib/bridge/store.ts:617-624`). Cost: not measured here. It matters for
   part B's long-lived-server rules.
6. **Codex realtime is experimental.** A Codex upgrade can change it. The repo
   checks the fields it sends against the installed schema
   (`src/lib/voiceCompanion/codexVoiceSchema.test.ts`).

---

## 13. Unknowns

| Question | Where I looked | Status |
| --- | --- | --- |
| Which backend the operator's installation uses now | Code default is `api` (`storage.ts:297`). The live setting is in state this stage may not read. | Unknown |
| How `gpt-live-1` detects the end of a turn and when it yields | GPT-Live guides (§14) | Not documented in the pages read |
| GPT-Live session duration limit | Managing sessions page: only the `expired` reason | Unknown |
| Whether the Codex app-server handles signalling only, with media flowing browser ↔ provider | Code comments; the Codex schema describes the SDP exchange | Inferred; no packet capture was made |
| What context Codex V3 gives a backing turn about the spoken conversation | Codex schema descriptions only | Unknown |
| Limits on tool count and schema size for the backend request and for Codex `dynamicTools` | Not needed for this explainer | Left to deliverable B, to be measured there |

---

## 14. Sources

### Vendor pages (read 2026-10-20, 20:51–21:00 UTC)

Each page was downloaded in its Markdown form (the site serves one when `.md`
is appended to the URL) and read whole. No page carries a date. Digests are
the first 12 hex characters of SHA-256 over the downloaded bytes.

| Page | Status | Bytes | Digest |
| --- | --- | --- | --- |
| [Getting started with GPT-Live](https://developers.openai.com/api/docs/guides/live) | 200 | 6,299 | `9f553eb5f3fd` |
| [Managing GPT-Live sessions](https://developers.openai.com/api/docs/guides/live-conversations) | 200 | 39,968 | `5985b748ac4f` |
| [Delegation and tools in GPT-Live](https://developers.openai.com/api/docs/guides/live-delegation) | 200 | 42,457 | `e080a8d3f61c` |
| [Prompting GPT-Live](https://developers.openai.com/api/docs/guides/live-prompting) | 200 | 11,320 | `d43105ff0e63` |
| [Server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live) | 200 | 19,192 | `d50ac6963d87` |
| [WebRTC connection](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live) | 200 | 27,244 | `c436dfba5593` |
| [Voice activity detection (Realtime API)](https://developers.openai.com/api/docs/guides/realtime-vad) | 200 | 5,564 | `23db05b6f02b` |
| [Live primary WebSocket reference](https://developers.openai.com/api/reference/resources/live/primary-websocket) | 200 | 317,156 | `906fd6270f4b` |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server.md) | 200 | 102,656 | `f879715bb0d4` |

### Codex realtime protocol

The public Codex page does not document the realtime methods. Their shapes
come from the protocol schema that the installed Codex generates:

```
CODEX_HOME=<scratch dir> codex app-server generate-json-schema --experimental --out <scratch dir>
```

- Codex version: `codex-cli 0.162.1`.
- Output: `codex_app_server_protocol.v2.schemas.json`, SHA-256 prefix
  `5c0ee37a723e`.
- Definitions used:
  - `ThreadRealtimeStartParams`: its fields include `version`, `model`,
    `prompt`, `voice`, `transport`, `clientManagedHandoffs`,
    `codexResponsesAsItems`, `initialItems` ("limited to 128 items and 8,192
    estimated text tokens") and `realtimeStartInstructions` /
    `realtimeEndInstructions`. It has no VAD field.
  - `ThreadRealtimeStartTransport`: `websocket`, `webrtc` or `existingCall`.
  - `RealtimeConversationVersion`: `v1`, `v2` or `v3`.
  - `RealtimeVoice`: an enum that includes `cove`.
  - `DynamicToolSpec`: a `function` (with `deferLoading`) or a `namespace`.
  - `DynamicToolCallParams`: `threadId`, `turnId`, `callId`, `tool`,
    `namespace`, `arguments`.

### Searches behind the absence claims (on `8ae63305`, outside test files)

- `turn_detection` in `src`: no match.
- `thinking.append` in `src`: only `src/lib/voiceCompanion/fakeProvider.ts:6`
  (the simulator).
- `type: "interrupt"` in `src/components`, `src/hooks` and
  `src/lib/voiceCompanion`: only `src/lib/voiceCompanion/contract.ts:148`.
- Earlier answers: `search_transcripts`, scoped to this project, found the
  2026-10-10/11 audit and probes that moved Voice Delegatus onto Codex V3. Its
  design notes are `docs/design/voice-codex-subscription.md`,
  `docs/design/voice-tools-and-spend.md`,
  `docs/design/voice-delegatus-live-feedback.md`,
  `docs/design/voice-lean-delegation.md` and
  `docs/design/voice-call-memory.md`. This note checks their claims against
  the current code and cites the code. `search_memory` found nothing relevant.
