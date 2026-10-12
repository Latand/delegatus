# Voice Delegatus on the Codex subscription

Originating requirement. Operator, 2026-10-10 about 18:55 Kyiv, by voice,
relayed by Voice Delegatus to the audit task, verbatim:

> Запусти аудит коду голосового Delegatus: перевір, чи можна замінити поточний API-key backend на Codex subscription backend, щоб голосовий Delegatus використовував саме підписку замість моїх API-витрат. У нас уже є схоже рішення — знайди й оціни його повторне використання, сумісність, обсяг змін, ризики й чи можна зробити заміну швидко. Поки що виконай лише аудит: нічого не змінюй і не деплой.

Operator, 2026-10-11 about 01:20 Kyiv, seat chat, after reading the audit, verbatim:

> Надо, чтобы кодекс сработал. Ну, на подписке кодекса, короче.

Written against `main` at `e5cd0ff3d`; every file:line below is on that
commit. This note builds on `docs/design/voice-companion-research.md` (#2519)
and `docs/design/voice-tools-and-spend.md` (#2681). It changes no product code.

## Verdict

Option C of the audit works on the subscription. On 2026-10-10 an isolated
Codex app-server (`codex-cli 0.162.1`), signed in to a Delegatus-managed Pro
account with ChatGPT auth and no API key, ran `thread/realtime/start` over
WebRTC with the voice persona as its prompt. Each spoken board question became
a backing Codex turn, that turn called the voice's read tools as dynamic tools,
and the answer came back as speech. The WebSocket transport requires an API key;
the browser already talks to the voice over WebRTC, so that limit costs
nothing.

**Design verdict: pass.** Four slices, about 1,700 lines added and 1,000
removed, about six working days. After slice 3 a voice call reads no API key
and calls no `api.openai.com` endpoint.

## Was this solved before?

`search_transcripts` (project, then unscoped) for "voice companion Codex
app-server dynamicTools realtime subscription", "голосовий Delegatus підписка
Codex app-server thread/realtime/start" and "clientManagedHandoffs delegation
duplicate handoff", and `search_memory` for "voice Codex subscription realtime
app-server dynamic tools rate limit" and "gpt-live-1-codex usage limit cut".
The only prior work is the audit (task 913bc2ff) and the probe stage of this
pipeline. The #2519 research recorded that native voice routes handoffs into a
backing Codex turn (`voice-companion-research.md:755`); the probe confirmed it
on 0.162.1 and added dynamic tools. Nothing else applies.

## Probe results (step 1)

Isolated temporary HOME, `CODEX_HOME`, XDG, TMPDIR and state directory; only
the picked account's `auth.json` copied; every `OPENAI_*`, `CHATGPT_` and
`*_API_KEY` variable removed. The account was chosen by `selectProjectAccount`
with capacity selection, managed accounts only. Raw logs, schema and pinned
Codex source: `$HOME/.local/share/delegatus-evidence/voice-codex-probes/run-20261010T2226Z-6ff5fa30/`.

| Measurement | Result | Samples |
| --- | ---: | ---: |
| App-server spawn → thread ready (initialize, `account/read`, `thread/start`) | 0.78 s | 1 |
| `thread/realtime/start` → `realtime/started` and answer SDP | 0.95 s, 1.12 s | 2 |
| End of "Say hello to me." → first received speech | 1.14 s | 1 |
| End of the board question → first received answer speech | 5.89 s | 1 |
| First handoff → first received answer speech | 5.19 s | 1 |
| Backing turn, `turn/started` → `turn/completed` | 2.36 s, 4.41 s | 2 |
| WebSocket start → `thread/realtime/error` "realtime conversation requires API key auth" | 1.9 ms | 1 |
| Loopback HTTP 429 → `thread/realtime/error` | 1.2 ms after the 429 | 1 |

Latency is client PCM receipt, filler disabled in the precise sample; speaker
playback was not measured. Each row holds one or two samples, too few for a
distribution.

What the wire showed, in order: `initialize` → `account/read` (chatgpt, pro) →
`thread/start` with `dynamicTools` accepted → `thread/realtime/start` answers
`{}` → `thread/realtime/started` → `thread/realtime/sdp` → WebRTC connected →
`thread/realtime/transcript/delta|done` → `thread/realtime/itemAdded`
(`type: handoff_request`, with the operator's words and the recent transcript)
→ `turn/started` → server request `item/tool/call` (`list_pipelines`,
`list_tasks`) answered with `{contentItems: [{type: "inputText", text}], success: true}`
→ `thread/tokenUsage/updated` → `account/rateLimits/updated` → `turn/completed`
→ the answer spoken → `thread/realtime/stop` → `thread/realtime/closed`
(`reason: requested`).

Facts the design rests on:

- **The server sees every handoff.** `itemAdded` with the handoff arrives on
  the app-server's stdio before its `turn/started`; the browser's data channel
  is not needed for it.
- **Duplicate handoff.** One voice turn produced two handoffs 1.2 s apart with
  identical words. Codex steered the second into the running turn as a second
  user message; one turn completed, each tool was called once.
- **Rate limits.** The start RPC answers `{}` before the backend is asked; a
  429 then arrives as `thread/realtime/error` with the text "exceeded retry
  limit, last status: 429 Too Many Requests", no code, no retry-after, no
  response body. The process stayed usable for `stop`.
- **Usage.** `account/rateLimits/updated` arrived after every backing request
  (plan type, primary window `usedPercent`, window length, reset time,
  `rateLimitReachedType`). `thread/tokenUsage/updated` gave the backing
  tokens: 31,959 and 48,076 per board question, about 16,000 input tokens per
  request, most of it cached after the first. The voice-minute counter
  (`session.usage.updated`, every ~15 s) reaches only the browser's data
  channel. Two calls of 65 s and 34 s plus their backing turns left the
  weekly window at 77% before and after; the per-call debit is below the
  integer percent's resolution.
- **Prompt weight.** The voice's own tools and instructions are about 3,000
  tokens (9.4 kB of schema, 2.5 kB of instructions); the remaining ~13,000
  input tokens per request are Codex's own prompt and tools. The first request
  of a call is mostly uncached (1,792 of 15,841 cached), and its first output
  came 2.6 s after the handoff. A smaller prompt is the obvious lever; its
  effect is unmeasured.
- **Voice name.** The app-server's voice list for 0.162.1 has 19 names;
  `meridian`, today's voice (`sessionConfig.ts:12`), is not among them.

Not measured: playback latency in a browser, the production board and send
path, a naturally exhausted account, a limit hit mid-call, token refresh during
a call, an app-server crash during a call, `appendSpeech`, `appendText` and
`inject_items` on this thread, image results from a dynamic tool. The slices
below measure each one where it matters.

## Target architecture

```
browser (unchanged)                Viewer                                  OpenAI
  mic + speaker ── WebRTC ────────────────────────────────────────────── gpt-live-1-codex
  /api/voice-companion/session ── CompanionLiveSessions ── stdio ── codex app-server ── sideband
                                     │  tool calls answered here       (leased helper,
                                     │  gate, admission, reads          managed account home)
                                     └─ orchestrator inbox                   └─ backing turn: gpt-6-luna
```

One Codex app-server per call, owned by the Viewer process, started on
`start` and ended on close.

**Process.** `CodexAppServerClient` (`src/lib/accounts/codexAppServer.ts:243`)
already owns one stdio app-server with a single answerer for server requests
(`:307`, `:549-560`), lifecycle events and redacted stderr. It gains an `args`
option (fixed today at `:133-139`) and the voice gives it a spawn through
`spawnLeasedHelper` (`src/lib/helperLease.ts:59`), so the app-server ends when
the Viewer ends, however it ends.

- Arguments: `cli_auth_credentials_store=file` and `mcp_servers={}` as today;
  `analytics.enabled=false`; `features.shell_tool=false`; the features of
  `CODEX_VIEWER_SPAWN_FEATURES` (`src/lib/agent/spawnPolicy.ts:53-57`: apps,
  plugins and multi-agent off); `--enable realtime_conversation`, as the
  conversation host starts it (`codexAppServerHost.ts:1462-1464`).
- Environment: `CODEX_HOME` is the picked account's own home, so Codex keeps
  refreshing its token there as it does for workers. No `*_API_KEY` reaches
  the process. `codexAppServerEnvironment` (`codexAppServer.ts:146-148`)
  forwards `OPENAI_API_KEY` (`src/lib/environmentIsolation.ts:4-8`); the voice
  spawn strips it, and a start whose `account/read` is anything but `chatgpt`
  is refused. Otherwise a key in the Viewer's environment could switch Codex to
  API billing, which is the spend this work removes.
- The conversation host (`CodexAppServerHost`) is the wrong owner: it turns
  every server request into an operator attention card
  (`codexAppServerHost.ts:3871-3880`) and carries a conversation's durable
  ledger, writer fences and delivery queue, none of which a voice call has.

**Thread** (`thread/start`):

| Field | Value | Probed |
| --- | --- | --- |
| `model` | `gpt-6-luna`, today's backend model (`sessionConfig.ts:9`) | yes |
| `ephemeral` | `true`: no rollout file, so no phantom conversation in the scanner | yes |
| `approvalPolicy`, `sandbox` | `never`, `read-only` | yes |
| `dynamicTools` | every `COMPANION_TOOL_REGISTRY` entry (`tools.ts:65-104`) as `{type: "function", name, description, inputSchema}` | nine read entries |
| `developerInstructions` | `BACKEND_INSTRUCTIONS` (`sessionConfig.ts:46`), less the sentences about the hand-built input | yes |
| `environments`, `baseInstructions` | `[]` and the voice backend's own instructions, kept only if slice 1 measures them faster and still correct | no |
| `cwd` | an empty private directory under the state directory | yes (temp) |

**Call** (`thread/realtime/start`): `version: "v3"`, `model:
"gpt-live-1-codex"` (named explicitly, as `codexAppServerHost.ts:375-383`
explains for #664), `outputModality: "audio"`, `transport: {type: "webrtc",
sdp}` with the browser's offer (CRLF healed as at `codexAppServerHost.ts:2522-2525`),
the persona `liveInstructions(locale, project)` (`sessionConfig.ts:13`) as its
`prompt`, `clientManagedHandoffs: false` so Codex speaks the backing answer
itself, the acknowledgement filler left at its default (on), and `voice`
chosen in slice 3. Start waits for `thread/realtime/sdp` or
`thread/realtime/error`; the `{}` answer alone proves nothing.

**App-server → companion.**

| Message | Companion effect | Replaces |
| --- | --- | --- |
| `thread/realtime/sdp` | answer SDP returned to the browser | `provider.create` (`provider.ts:43-60`) |
| `thread/realtime/started` | `session.ready`; the call clock starts | `liveSession.ts:165` |
| `thread/realtime/error` before the SDP | start refused, classified (failure table) | `PROVIDER_REFUSED` |
| `thread/realtime/error` or `closed` after it | session closes with its reason | `liveSession.ts:252-268` |
| `thread/realtime/transcript/delta`, `done` | a new adapter feeds `LiveTranscript.fragment` with receipt-time stamps; `done` seals the role's segment | `liveSession.ts:238-240` |
| `thread/realtime/itemAdded`, `handoff_request` | delegation record and transcript boundary; freezes the operator turn and the waiting confirmation for the tool calls that follow | `liveSession.ts:241-251` |
| server request `item/tool/call` | `runCompanionTool` (`tools.ts:109`) through the existing `tool()` and read ledger (`liveSession.ts:354-412`); the result goes back as `inputText` | function calls of the backend loop (`liveSession.ts:309-342`) |
| `turn/completed` with a failed status | one fixed spoken sentence through `appendSpeech` | `liveSession.ts:300-306` |
| `account/rateLimits/updated` | window figure in the voice window; durable observation for the account | dollar usage (`liveSession.ts:252-263`) |
| `thread/tokenUsage/updated` | kept on the session record; nothing is priced | `usage.ts:36-46` |

**Companion → app-server.**

| Need | Method | State |
| --- | --- | --- |
| speak an orchestrator report, a confirmation expiry, a failure | `thread/realtime/appendSpeech` | used by composer voice (`codexAppServerHost.ts:2599-2606`); unprobed here |
| project switch | `thread/inject_items` (developer item for the backing model) and `thread/realtime/appendText` with role `developer` (for the voice) | inject is in production in the host; `appendText` unprobed |
| interrupt | browser mutes received audio (`media.ts:110-115`) as today, plus `appendText` asking the voice to yield | unprobed |
| mute | browser disables its track (`media.ts:109`); nothing server-side | — |
| hang up | `thread/realtime/stop`, then the client closes | probed |

Reads and sends need no project hint from the model: a tool called with a
null project already resolves to the project in view on the server
(`tools.ts:69`, `:77`). The project messages only keep the spoken wording right.

The backing thread lives for the whole call, so earlier reads and earlier tool
results (an `awaiting_confirmation` included) stay in its own history. The
hand-built input of today's loop (`liveSession.ts:274-285`) goes away.

## What stays and what changes

| Part | Stays | Changes |
| --- | --- | --- |
| Browser: media, adapter, window, character, bubbles, cues (`media.ts`, `liveAdapter.ts`, `VoiceCompanion.tsx`) | all of it; the offer already opens the `oai-events` channel Codex expects (`media.ts:60`) | the data channel now carries provider events; the browser keeps ignoring them |
| Session route surface (start, context, command, close, events) | yes | new refusal codes: `CODEX_LIMIT_REACHED`, `CODEX_AUTH_REQUIRED`, `NO_CODEX_ACCOUNT`, `CODEX_UNSUPPORTED` |
| Send gate and admission (`liveGate.ts`, `admission.ts`, `tools.ts`) | yes, unchanged: proposals, confirmations, dedupe (`admission.ts:24-27`, `:214-226`), end refusal, delivery, reports | reached from `item/tool/call`; the Responses loop goes |
| Read tools and their ledger (`boardReads.ts`, `readPaths.ts`, `liveSession.ts:386-412`) | yes | — |
| Transcript reducer (`liveTranscript.ts`) | yes | fed by a small new adapter from stdio notifications, timed by receipt |
| Persona (`sessionConfig.ts:13-44`) | yes | travels as the realtime `prompt` |
| Provider seam (`provider.ts:6-14`, `server.ts:13`) | a seam stays for the fake provider and simulator | narrowed to start, speak, note, stop; `OpenAILiveProvider` deleted in slice 4 |
| Backend loop (`liveSession.ts:272-353`), USD reservations, watchdog renewals, receipts (`:127`, `:290-298`, `:425-447`, `:606-618`) | — | deleted; Codex runs the backing turn |
| Recovery of provider sessions (`liveSession.ts:474-535`) | stored rows still close at startup | no remote hangup or retry: the leased process ends with its Viewer |
| Abandoned-call watchdog (`liveSession.ts:171`, 30 s without a poll) | yes | ends the call through `stop` |
| Key storage and route (`storage.ts:256-284`, `api/voice-companion/key/route.ts:9`) | — | deleted in slice 4 |
| Spend display (`CompanionSpend.tsx:14-37`, `storage.ts:198-229`) | variant 2's layout, chosen on 2026-10-10 | figures become call minutes and the plan window |
| Settings dialog (`VoiceCompanionSetting.tsx:102-138`) | the on/off switch | key field and monthly cap removed |

## Account choice and limit sharing with workers

- **Who pays.** A Delegatus-managed Codex account (`kind: "managed"`). The
  legacy account, the operator's own Codex home (`codex.ts:367-379`), and any
  account without `auth.json` are removed from the candidate list before the
  pick. Passing the legacy id in `excludedIds` would not keep it out: that
  list only moves an account to a second tier (`headlessSelection.ts:82-88`),
  which is used when no other account has room.
- **Which one.** `selectProjectAccount` (`projectSelection.ts:186`) with
  `engine: "codex"`, `unbound: "capacity"`, the backing model, and the project
  in view at start: the same rule and observations the headless paths use,
  bindings honoured. It takes the account with the most confirmed headroom,
  then one whose quota is unknown. When every account it may use is out of
  room, the call is refused with the earliest reset time. The account stays
  fixed for the call.
- **What it shares.** Voice minutes ($0.05 a minute of the Codex budget by the
  vendor's pricing page) and the backing turns draw on the same 5-hour and
  weekly windows as every worker on that account. A 30-minute call is about
  $1.50 of plan budget. The probe's calls moved the weekly Pro window by less
  than one point.
- **What workers see.** Each `account/rateLimits/updated` from the voice
  app-server is recorded through `recordLiveObservation`
  (`src/lib/accounts/liveLimits.ts:50`), so worker scheduling sees the voice's
  draw within seconds, and a limit hit on the voice marks the account for the
  next pick.
- **No voice-only reserve.** The capacity pick takes the account with the
  most room and a limit ends the call (below); a threshold that keeps room for
  workers waits until starvation is observed.

## Spend and limit display

The footer keeps the layout the operator chose on 2026-10-10 (two figures
above a thin meter). The call figure becomes the call's minutes on the server
clock. The month figure becomes the paying account's plan window: plan type,
`usedPercent` of the primary window (and of the secondary when there is one)
and its reset time, updated live from `account/rateLimits/updated`. The meter
shows that window's `usedPercent`; the teal share is the rise since the call
started, which is coarse because the backend reports whole percents. The
figure is the whole account's use, workers included, and the label says so.
The settings dialog loses the key field and the monthly cap, and its usage
line shows the last call's minutes and the window; at 390 px the companion is
not mounted and the dialog stays the place for this, as #2681 set.

## Failure modes

| Case | What the operator sees | How |
| --- | --- | --- |
| No managed account with room | the call does not start; the window names the reset time | selector answers `exhausted` → `CODEX_LIMIT_REACHED` |
| No managed account signed in | the call does not start | selector `unavailable` → `NO_CODEX_ACCOUNT` |
| 429 or usage limit at start | the call does not start | `thread/realtime/error` before the SDP; the same client reads `account/rateLimits/read` to tell a limit (`rateLimitReachedType` set or 100%) from another failure; the observation is recorded; the process is stopped |
| Limit hit mid-call (unmeasured; #664 saw such cuts as `rate_limit_error`) | one short spoken sentence, then the call ends with reason "limit" | `account/rateLimits/updated` reaching the limit ends the call through `stop`; a `thread/realtime/error` or `closed` ends it at once |
| Backing turn fails (limit, network) | the voice says the board could not be read; the call goes on | `turn/completed` with a failed status → `appendSpeech` |
| Token expiry | nothing, normally | Codex refreshes in the account's home (the host already reads its `modelProvider/authRecovery*` notifications, `codexAppServerHost.ts:3883-3888`); a refused refresh ends the call and the next start picks another account |
| App-server crash | the call ends | client lifecycle `failed` or `reaped` → session closes (transport); the browser closes its peer on `session.closed` (`liveAdapter.ts:164-170`) |
| Viewer crash or restart | the call ends | the lease ends the app-server; the browser's poll fails and it closes the peer (`liveAdapter.ts:134-143`) |
| Browser gone | the call ends after 30 s | the existing watchdog (`liveSession.ts:171`) |
| Duplicate handoff | one answer, one send | Codex steers it into the running turn (observed); admission dedupes by call id and by the same words in the same operator turn (`admission.ts:24-27`) |
| Codex update changes the experimental API | the call does not start, with `CODEX_UNSUPPORTED` | `dynamicTools` and realtime are marked experimental in the schema; start checks that `thread/start` accepted the tools and that an SDP arrived; slice 1 adds a schema test against the installed binary |
| An API key in the Viewer's environment | nothing | stripped from the spawn; `account/read` must say `chatgpt` |

Residual risk: a duplicate handoff that arrives after the first turn completed
starts a second turn, and a backing model that words the same request
differently would pass the same-words dedupe. Slice 2 keeps the existing rule
(the detector is a hint and the model judges) and counts such sends in the
canary.

## Privacy

- Audio, transcripts and the backing turn's text go to OpenAI under the
  managed ChatGPT account's terms. Today they go to the API organisation with
  `store: false` (`sessionConfig.ts:54`, `:66`).
- Locally the thread is ephemeral: no rollout lands in the account's sessions
  directory, nothing appears in the conversation scanner, and the transcript
  record stays where it is today.
- Delegatus handles no credential on this path. Codex reads and refreshes its
  own `auth.json`; the Viewer never reads a token (unlike the dictation path,
  `src/lib/transcribe/chatgpt.ts`).
- `account/read` returns the account's email. The voice provider reads only
  its auth mode and plan type and never stores, logs or emits the rest. The
  window shows the plan type and nothing that identifies the account.
- The browser's data channel now receives the provider's events (transcripts,
  handoff text, voice minutes) in the operator's own page. The page reads none
  of them, and no browser command can submit a transcript, a tool result or
  usage, as today.
- App-server stderr stays redacted (`redactAppServerDetail`); production logs
  no raw event stream.

## Decisions this reverses, and one it keeps

- **Reversed, #2519:** voice on the official API with a key
  (`voice-companion-research.md:5`). The operator's 2026-10-11 message is the
  reversal.
- **Reversed, #2519:** no hidden Codex turn between voice and work
  (`voice-companion-research.md:745`, `:953`). The backing Codex turn is now
  the design; it can only read through the registry and send through the gate.
- **Replaced, #2681:** spend in dollars against a monthly cap. The plan window
  takes its place.
- **Kept, amendment of 2026-10-06, point 1:** write the companion's live
  handling fresh and import none of the composer voice's code
  (`voice-companion-research.md:221`). The companion keeps its own reducer,
  gate and event handling; `codexRealtimeTranscript.ts` and
  `CodexAppServerHost` are not imported. What carries over from the composer
  path is protocol knowledge: the model name, the start parameters, the CRLF
  rule. The audit listed both files as reusable; the 2026-10-11 reversal does
  not name this amendment, so it stands.

## Build slices

Each slice ends with the touched tests by path under isolated state, and every
live check runs on a managed account in an isolated home with recorded PIDs,
as the probe did.

**Slice 1. A Codex voice that answers board questions.** About 700 lines,
two days. The Codex provider (account pick, leased app-server, thread and call
start, notification routing, `item/tool/call` answered through
`runCompanionTool` for the read and end tools); the client's `args` option and
leased spawn; `server.ts` picks the Codex provider when
`LLV_VOICE_BACKEND=codex` (tests and canary only, no control). Acceptance:

1. Against a stub app-server that replays the probe's recorded wire shapes,
   start resolves only after `thread/realtime/sdp`; an error before it refuses
   the start and the stub's process is gone afterwards.
2. A `list_tasks` tool request is answered through the registry and the read
   ledger; the same read again within 120 s does not reach the store.
3. The spawned environment holds no `*_API_KEY`; an `account/read` other than
   `chatgpt` refuses with `CODEX_AUTH_REQUIRED`; an exhausted pool refuses with
   `CODEX_LIMIT_REACHED` and the reset time; the legacy account is never
   picked, also when every managed account is exhausted.
4. Ending the Viewer stand-in ends the app-server through the lease.
5. A schema generated from the installed `codex` binary contains every field
   the provider sends.
6. Live canary: a spoken board question answered through the production read
   path from a fixture board; no new file in the account's sessions directory;
   no `codex_apps` server start. The canary reports the first request's input
   tokens and handoff → answer audio with and without `environments: []` and
   `baseInstructions`, beside the probe's 15,841 tokens and 5.19 s, and keeps
   whichever answers correctly and faster.

**Slice 2. Sends, transcript, reports and context on the Codex path.** About
500 lines, two days. Acceptance:

1. The transcript adapter turns a recorded `transcript/delta|done` sequence
   into the operator segments and turns `LiveTranscript` gives for the same
   words with provider timing; credential masking holds.
2. Replaying the recorded duplicate handoff (two handoffs, one steered turn,
   one `request_orchestrator_delegation`) delivers exactly one request.
3. `end_conversation` is refused for "finish the task" and admitted for
   "заверши розмову" through a dynamic tool call; the admitted one stops the
   call and it closes with reason `tool`.
4. Three orchestrator reports filed during a call produce three
   `appendSpeech` calls in report order, once each across polls.
5. A project switch produces one `inject_items` and one `appendText`; the next
   send without a project goes to the new project.
6. `view_prototype_frame` returns its frame as `inputImage`, or the slice
   records that Codex refuses it and keeps the text result.
7. Live canary: one send to a fixture orchestrator inbox, one confirmation
   answered by voice, one hang-up by voice, the duplicate-send count reported.

**Slice 3. The plan window replaces dollars; Codex becomes the voice.** About
500 lines, one and a half days. Acceptance:

1. `CompanionUsage` carries the call's seconds, the plan type and the windows;
   the footer and the settings dialog show them as described above, en and
   uk, rendered through the existing kanban driver's voice cases at 1440, 1000
   and 390.
2. A recorded `account/rateLimits/updated` that reaches the limit mid-call
   produces one spoken sentence, a `stop`, reason `limit`, and a recorded
   observation that the next pick avoids.
3. The voice: the canary records a short greeting in each voice
   `thread/realtime/listVoices` returns for V3 WebRTC; the operator picks one
   by number in chat before the default changes.
4. The default backend becomes Codex; with no key configured the voice starts.

The operator replaced item 4 on 2026-10-11 and cancelled slice 4: the voice
settings choose the backend, through the API with its key (the default, as
before) or Codex V3 on the subscription, and the key field and the cap show
only for the API. `docs/verification/voice-codex-slice3.md` quotes the
decision and records how slice 3 was built against it.

**Slice 4. Delete the API-key path.** Cancelled by the operator on
2026-10-11; the API path stays as the default backend. As planned: about
1,000 lines removed, half a day.
Acceptance:

1. Nothing under `src/lib/voiceCompanion` or `src/app/api/voice-companion`
   names `api.openai.com` or reads `OPENAI_API_KEY`; the key route is gone.
2. The backend loop, USD constants, reservations and provider hangup retries
   are gone with their tests; the fake provider and simulator suites pass.
3. A stored companion document with old charge and cap fields still loads.

## Deferred — not currently justified

- Keeping the API-key backend as a selectable fallback. The requirement is to
  stop the API spend; a revert of slice 4 restores it if ever needed.
- Serving the voice tools from an MCP server. Dynamic tools carried them in
  the probe and keep the handler in the Viewer's process.
- A voice-only reserve on the account's window, to keep room for workers.
- Attributing each call's exact debit. The backend reports whole percents and
  `account/usage/read` has no per-session figure.
- A pre-started app-server to save the ~0.8 s of process start.
- Moving a call to another account mid-call.
- The WebSocket transport; it requires API-key auth.
- `clientManagedHandoffs: true` with Delegatus pacing each answer itself.
- A control to pin the voice's account; the capacity pick decides.

## Checked against the requirement

The operator asked that Voice Delegatus run on the subscription in place of
API spend, reusing what exists, and asked about speed of the change. After
slice 3 a call picks a managed Codex account, the voice and its backing turns
draw on that plan, and no API key is read; slice 4 removes the key path. It
reuses the companion's window, browser media, gate, admission, read tools and
reducer, and the account layer's app-server client. It is not quick: about
six days, consistent with the audit's estimate for option C.
