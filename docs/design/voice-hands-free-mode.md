# Voice Delegatus hands-free mode: hearing what the screen would show

Design only; this note changes no product code. Task `2753d517`, design lane
`d122e4c7`. Every `file:line` below refers to commit `d2bc2945` on `main`.

## The requirement

Operator request, 2026-11-01 at about 08:27 UTC, spoken to Voice Delegatus and
relayed by it as a paraphrase; no verbatim line was supplied. In English:

> Design a full hands-free mode for voice Delegatus. When the operator cannot see the
> interface and works without hands, Delegatus must explain by voice what it is doing
> and pass on the information the operator would normally see on screen. Audio
> notifications about actions are one of the needed nuances. A well-thought-out
> hands-free experience is expected.

At about 08:40 UTC the operator corrected where the **design work** runs: in the cloud,
not on a local model. A later seat note records that the operator's subsequent
correction, Claude running in the cloud, governs. Both corrections are about where
this lane's stages run. Neither asks for the product's voice to run in the cloud, so
this design keeps the voice where it runs today (§1.1).

The pinned specification asks for six parts. Each has its own section:

| Asked for | Section |
| --- | --- |
| 1. What exists today, and the gaps a hands-free user hits | §1 |
| 2. The hands-free experience end to end | §2 |
| 3. Audio cues on the existing lane | §3 |
| 4. Priority and verbosity rules, and privacy in shared spaces | §4 |
| 5. Failure modes and what the operator hears | §5 |
| 6. A phased build plan with acceptance and measurements | §6 |

Places that need the operator's choice are marked **Choice H1…H10** where they arise.
§7 collects them with a recommendation for each.

### Conventions and sources

- **Observed** means read in code or in a committed document. **Inferred** marks a
  conclusion drawn from what was read. **Unknown** marks what neither shows.
- Short names: `liveSession.ts`, `admission.ts`, `tools.ts`, `sessionConfig.ts`,
  `liveAdapter.ts`, `media.ts`, `storage.ts`, `errors.ts`, `codexProvider.ts`,
  `voiceTimers.ts`, `boardReads.ts` and `companionCues.ts` (for
  `src/lib/voiceCompanion/cues.ts`) are in `src/lib/voiceCompanion/`.
  `eventLane.ts`, `cuePlayer.ts`, `synth.ts`, `workCues.ts`, `prefs.ts`,
  `captions.ts` and `audio/app.ts` are in `src/lib/audio/`.
- Design documents read first, and what each contributes:
  - `docs/design/voice-mode-explained.md`: how a call works on both backends, the
    message channels, barge-in and call lifetime. Its citations are on an older
    commit; every claim reused here was checked again on `d2bc2945`.
  - `docs/design/voice-call-reconnect.md`, §4 "Shared cues and words with the
    hands-free design": the reconnect cues and strings this design must adopt
    unchanged (§5.1).
  - `docs/design/sound-redesign.md`, `docs/design/sound-captions.md` and
    `docs/design/sound-events-audit.md`: the sound map S1–S9, the one event lane and
    its rates.
  - `docs/design/voice-prototype-review-flow.md` §2.9: today a spoken choice on a
    form records nothing.
  - `docs/design/voice-privacy-scope-and-honest-delivery.md`: the private-context
    boundary and its threat cases.
  - `docs/design/voice-companion-research.md`, "Operator requirement change
    2026-10-06: send without confirmation" (line 48) and "Operator amendment
    2026-10-06" (line 169): the operator works hands-free and confirms nothing by
    default; the official realtime API is the default backend.
  - Also `voice-call-memory.md`, `voice-timers.md`, `voice-tools-and-spend.md`,
    `voice-lean-delegation.md`, `voice-codex-subscription.md`,
    `phone-voice-head-build.md`, `needs-attention.md`, `attention-auto-resolve.md`,
    `telegram-prototype-review.md` and `done-section.md`.
- Earlier answers: this stage ran in a cloud checkout with no Delegatus MCP server, so
  `search_transcripts` and `search_memory` could not be queried. The repository
  search found the task id `2753d517` only in `voice-call-reconnect.md`
  (lines 28, 51, 695 and 996), which records this design as not yet written on
  2026-11-01. It found task `7194c5e5` (locked-phone audio, long sessions) cited as
  open in `phone-voice-head-build.md:365` and `:401`. Nothing else on hands-free
  narration exists.

---

## 0. In one minute

- **Which voice.** Hands-free mode is a mode of a **Voice Delegatus** call: the
  floating companion on the desktop or the head on the phone. The other voice
  surface, the root conversation's Live Mode call (the "voice gateway"), is off in
  the ordinary state of this machine (`src/lib/bridge/asks.ts:16-19`). It is left
  out of the first slices (**Choice H1**).
- **What the voice hears about today.** During a call it hears three things on its
  own: the orchestrator's `bridge_report`s for the project in view or for projects
  the call sent to, its own timers, and an expired confirmation
  (`liveSession.ts:1425-1436`). Everything else on the board needs a question first.
  Lanes parked on a decision, waiting forms, deploy results, limit waits and stalled
  agents are visible only on screen.
- **The core idea.** The Viewer already computes "what needs you" and "what
  finished" for the screen and for the sound map:
  - the needs-you queue (`src/components/attention/attentionQueue.ts:61-76`);
  - the «Готово» items (`src/lib/done/types.ts:8`);
  - the pipeline diffs that drive the event sounds (`workCues.ts:29-38`,
    `:285-299`).

  Hands-free mode reads the same facts **on the server**, from each store's change
  log, once per voice poll and only the rows that changed (§4.4). It classifies each fact into seven event classes and
  feeds the result into the speech queue that already speaks reports. That queue
  already waits while the operator talks (`liveSession.ts:1189-1229`). Each spoken
  notice is preceded by one earcon on the **existing** event lane.
- **What it says.** Proactively: what needs the operator, what failed, what landed,
  what was deployed, and the outcome of anything the operator asked for in this
  call. On request: "what's going on", details, lists one page at a time. It never
  reads identifiers aloud.
- **Forms by voice.** The voice reads a waiting decision form one question at a time
  and records the spoken answer through the path the Telegram reply already uses
  (`src/lib/externalRelay/prototypeAnswer.ts:23`). That includes a free-text
  "other", taken from the operator's own transcript. The answer is recorded under
  whoever started the call. In team mode only the owner can start a voice call,
  so a spoken answer there is the owner member's decision, recorded as that
  member, the same record the owner's answer on screen gets (§1.4, §2.4). This
  changes a standing rule,
  "a spoken choice records no decision" (`sessionConfig.ts:17`), so it is
  **Choice H4**.
- **Seven earcons** for started, finished, needs you, failed, merged, deployed and
  rate-limited. Six of them are sounds the lane already has (`synth.ts:160-248`);
  one is new (**Choice H3**). They play only in gaps of speech.

---

## 1. What exists today

### 1.1 Two voice surfaces, and which one this design builds on

| | Voice Delegatus (companion) | Voice gateway (root Live Mode) |
| --- | --- | --- |
| Started by | Talk on the floating character or the phone head | The voice button on the root conversation's card |
| Route | `/api/voice-companion/session` (`src/app/api/voice-companion/session/route.ts`) | `/api/runtime/realtime` (`src/app/api/runtime/realtime/route.ts:11-30`) |
| Models | API backend: `gpt-live-1` speaks, `gpt-6-luna` runs the tools (`sessionConfig.ts:11-12`). Codex backend: an ephemeral read-only thread per call (`codexProvider.ts`) | The root thread's own agent on its Codex host, `gpt-live-1-codex` (`src/lib/runtime/codexAppServerHost.ts:438`) |
| Default | The API backend (`storage.ts:16-17`) | Off; "with the gateway off — the ordinary state of this machine" (`src/lib/bridge/asks.ts:18`) |
| Tools | 23 compiled-in registry tools (`tools.ts:98-206`); no MCP inventory | The root's full Viewer MCP surface (`src/lib/mcp/toolAllowlist.ts:6-13`) |
| State reaches it by | The server's per-call speech queue, on the browser's 500 ms poll (`liveAdapter.ts:246`, `liveSession.ts:1434-1435`) | A 10 s relay of `bridge_report` batches (`src/hooks/useBridgeReportRelay.ts:108`), at most one batch per 30 s (`src/lib/runtime/bridgeDelivery.ts:122-166`) |
| Reconnect and memory | One-tap and automatic resume within 30 min (`src/lib/voiceCompanion/callResume.ts:15`); summaries of earlier calls (`src/lib/voiceCompanion/callMemory.ts:117`) | Hangs up on `pagehide` (`src/lib/realtime/codexRealtimeClient.ts:616-641`); a new call rebuilds from startup context |

**Choice H1: which surface gets hands-free mode.**

- (a) **Voice Delegatus only** (recommended). It is the default voice. It owns a
  server-side speech queue with holds, a durable resume cursor, timers and the
  privacy boundary. Every slice in §6 builds on it.
- (b) Both surfaces. The gateway would need its own narration path. It speaks
  reports at most every 30 s in batches of 5 (`src/lib/bridge/types.ts:361-363`).
  Its persona forbids reading a report verbatim (`src/lib/runtime/voicePersona.ts:177`).
  The scheduling in §4 does not fit that.
- (c) The gateway only. It has every MCP tool, but it is not the voice the operator
  calls "voice Delegatus".

### 1.2 How the voice learns state now

**Bridge reports, drained per call.** On each events poll the Viewer runs
`pollReports` (`admission.ts:612`):

- **Which projects.** The project in view, plus every project this call sent a
  request to (`admission.ts:618-621`).
- **Ordering.** It keeps a durable per-project watermark (`admission.ts:626-650`).
- **Who counts.** It speaks only reports whose origin is the manager
  (`admission.ts:663`).
- **Queue.** It queues the whole text for speech in the same storage commit that
  moves the watermark (`admission.ts:674`). The queue holds 64 items
  (`admission.ts:85`). A full queue stops the scan, so nothing owed is dropped
  (`admission.ts:655-657`).

`speakReports` (`liveSession.ts:1189-1229`) then cuts each report into parts of at
most 500 bytes (`liveSession.ts:187-190`):

- **Framing.** Each report gets a frame naming the project and class, for example
  "The orchestrator for project … reports completed."
- **Transport.** The parts go to the provider as `session.commentary.append` (API)
  or `thread/realtime/appendSpeech` (Codex, `codexProvider.ts:349`).
- **Holds.** Each part waits while the call holds speech (`reportsHeld`). A hold
  starts from the operator's recognised input and lasts while backend work runs,
  bounded by the 15 s input hold (`liveSession.ts:212`;
  `voice-mode-explained.md` §7).
- **How reports are read.** The speaking instructions say a report is read "as
  written, in order", as the exception to a short summary (`sessionConfig.ts:64`).

**Directives.** Voice Delegatus sends work with `request_orchestrator_delegation`
(`tools.ts:140`). It does not use `bridge_directive`. That tool is the gateway's
relay to the designated manager (`src/lib/mcp/server.ts:4057`, schema `:4972-4979`).
Its answer comes back as a `bridge_report`. The gateway reads reports through a
host-side drain that only the live call's `realtimeSessionId` may open
(`src/lib/bridge/gatewayAuthority.ts:52-55`; `src/app/api/bridge/route.ts:20-27`).

**Tools the companion may call** (`tools.ts:98-206`):

- 14 board reads (`boardReads.ts:12`);
- four reads about the call: `show_orchestrator_message`, `call_clock`,
  `orchestrator_reports` and `reread_orchestrator_report`;
- `relay_owner_history`, private (`tools.ts:112`);
- `request_orchestrator_delegation` and `resolve_orchestrator_confirmation`;
- `timer`;
- `end_conversation`.

None of them reads the needs-you queue, the «Готово» items, or answers a form.
`agent_fleet` already speaks limit waits and stalls as counts
(`boardReads.ts:177-186`).

**What the speaking model is told about hands-free use.** "The operator works
hands-free and confirms nothing by default" (`sessionConfig.ts:64`). "When there is
a lot to say … prefer a short spoken summary with an offer to go deeper"
(`sessionConfig.ts:33`). The backchannel and interruption policies are one line each
(`sessionConfig.ts:35`, `:37`). It never reads handles aloud (`sessionConfig.ts:64`).

### 1.3 The audio event lane and the synth

- **One lane for event sounds.** `createEventLane` (`eventLane.ts:102`) applies the
  sound map's timing rules:
  - a coalescing window, a gap and a per-minute cap per class
    (`eventLane.ts:43-51`);
  - 10 minutes of obligation memory (`eventLane.ts:53`);
  - only `your-move` and `fault` may cut a playing sound (`eventLane.ts:61`);
  - `step` and `launched` are dropped when busy (`eventLane.ts:63`);
  - a queued play expires after 15 s (`eventLane.ts:65`).

  Its only caller is the tab-wide cue player (`cuePlayer.ts:192-211`), reached
  through `playCue` (`audio/app.ts:151`).
- **Synthesised sounds.** No files are fetched. The sounds are `your-move` (S6),
  `fault` (S7), `reply` (S8), `released` (S5), `landed` (S4), `launched` (S9) and
  `step` (S3). Each is calibrated to its own loudness (`synth.ts:160-248`). The
  priority order is in `src/lib/audio/cues.ts:34`.
- **What plays today** (`workCues.ts`):

  | Event | Sound | Code |
  | --- | --- | --- |
  | A needs-you entry with a structured question, a parked lane or a form | `your-move` | `:29-38` |
  | A stuck delivery, failed launch or memory kill | `fault` | `:29-38` |
  | A deploy that succeeded | `released` | `:285-289` |
  | A deploy that failed or rolled back | `fault` | `:290-292` |
  | A limit episode | `fault`, with the account's label in its caption | `:295-299` |

- **Context rules.**
  - A hidden phone plays nothing (`cuePlayer.ts:260`).
  - Only the most recently focused tab plays event sounds (`cuePlayer.ts:263`;
    `src/lib/audio/focusOwner.ts:1-15`).
  - During a voice call, typing, distant typing, `step` and `launched` are silent
    and the rest play 6 dB down (`cuePlayer.ts:122-124`, `:200-203`).
- **Preferences** are device-local `localStorage`: master switch, cue volume, typing,
  music (`prefs.ts:19-24`). There are no quiet hours and no per-class switches.
  Captions show in words what a sound announced, on the desktop only
  (`captions.ts:6-16`; the phone shows none, `src/components/SoundCaptions.tsx:155-156`).
- **Gap: Voice Delegatus never tells the lane that a call is live.** The
  "voice connected" lease (`setVoiceConnected`, `audio/app.ts:196-200`) clears the
  lane's queue and turns on the call rules. It is taken only by Live Mode's
  `useAmbientCallLease` (`src/hooks/useCodexRealtime.ts:127-132`), mounted by
  `VoicePipHost` (`src/components/voice/VoicePipHost.tsx:116`). Nothing in
  `src/lib/voiceCompanion/` or `src/components/voiceCompanion/` calls it (searched).
  *Inferred:* during a Voice Delegatus call today, event sounds play at full level
  and can land on top of the companion's speech.
- **A second sound path.** The companion's connect, disconnect, timer, tick and
  give-up tones come from their own `AudioContext` (`companionCues.ts:34-81`). That
  path obeys only the master switch (`companionCues.ts:36`). The sound redesign
  left it out on purpose (`sound-redesign.md` §3.1, last paragraph).
- **No spoken announcements of events** exist; `sound-redesign.md` lists them as
  deferred. The only text-to-speech is the read-aloud button
  (`src/components/feed/SpeakButton.tsx`, `src/lib/tts.ts`).

### 1.4 Forms, Telegram polls and attention requests

- **Decision forms.** `publish_prototype_review` publishes questions. Each has
  options, each option optionally marked `recommended`, and optional `multiple` and
  `other` (`src/lib/prototypeReview/types.ts:20-31`).
  - **Where they live.** A task form lives on the task. A seat form (no task) lives
    in the `seat-decisions` collection (`src/lib/prototypeReview/seatRounds.ts:10-19`).
  - **How they are decided.** `decidePrototype` records a decision for one of three
    callers (`src/lib/prototypeReview/decision.ts:55`, `:236`): the operator's own
    HTTP request, an `operator-in-process` caller, or an autonomous seat.
  - **What guards an in-process caller today** (`decision.ts:240-248`, `:302-308`):
    - Only the autonomous seat's project is checked (`:244`). An
      `operator-in-process` caller has no project check.
    - The "no longer waiting" refusal (`:245-247`) applies only to a task round
      with no decision yet. A seat round (`taskId` null) skips it.
    - A round that already has a decision: the same answers from the same actor
      (`decidedBy`, compared at `:304`) change nothing and report no new decision
      (`:302-307`). Different
      answers are refused as "already decided" (`:308`), **except** on a
      native-association round, where an in-process caller amends the saved
      decision.
  - **Who is recorded as deciding** (`decidedBy`, `decision.ts:215-227`):
    - an autonomous seat is recorded as the agent (`:217`);
    - an in-process caller with a Telegram user id is recorded as the person that
      id belongs to, or refused when it belongs to nobody active (`:218-222`);
    - **any other in-process caller is recorded as `{kind:"operator"}`** (`:223`);
    - an HTTP request is recorded as the signed-in member, or as the operator
      (`:225-226`).
  - **Who may decide on screen.** Two web routes record a decision:
    `src/lib/prototypeReview/http.ts:180-197` for a task's form and `:227-252` for
    the decisions column. They refuse an anonymous request (`:183`, `:230`), an
    agent or a service (`:184-188`, `:231-235`) and a task that runs elsewhere
    (`:189`, `:247`). Both routes are wrapped in `workspaceRoute`
    (`src/app/api/tasks/[id]/prototypes/route.ts:12`,
    `src/app/api/projects/decisions/route.ts:14`), and that wrapper is where
    a role is checked. The owner, and a solo installation, pass straight through
    (`src/lib/team/workspaceRoute.ts:286`). A POST from any other member is
    admitted only when `canAct` holds for every project the request targets
    (`workspaceRoute.ts:294-300`). `canAct` is true for the active owner on any
    project, and for another active member only when the project belongs to a
    workspace that member is in (`src/lib/team/workspaceAccess.ts:34-39`). So a
    member decides on screen only the forms of their own workspaces' projects,
    and is recorded as that member. A native-association round also needs a
    Telegram-signed owner session (`decision.ts:252-256`).
  - **Who may start a voice call.** In team mode only the owner. The team gate
    runs on every request (`src/proxy.ts:81`). It lets the owner member through
    (`src/lib/team/gate.ts:189`) and refuses any other signed-in member on a
    route marked `owner` (`gate.ts:199-202`). Every Voice Delegatus route is
    marked `owner`, including `/api/voice-companion/session`, which starts a
    call (`src/lib/team/workspaceRoutes.ts:252-258`). A team call's starter is
    therefore always the owner member, stored as `{memberId}`
    (`src/lib/voiceCompanion/http.ts:9-14`). On a solo installation the starter
    is the operator.
  - **Delivery rechecks the author.** Before every send and automatic retry
    (`prototypeAuthorCurrent`, `decision.ts:187-194`, called at `:182` and
    `:429`), a member author must still be active, and an `operator` author is
    valid only on a solo installation (`activeDeliveryActor`,
    `src/lib/team/actor.ts:46-49`).
  - **Answer rules.** `normalizePrototypeAnswers` validates the answers
    (`src/lib/prototypeReview/questions.ts:8`). Per-question `customText` is
    accepted only from an owner reply (one that carries `originalReply`) or an
    autonomous seat (`decision.ts:276`, `:290`; `questions.ts:14`). For any other
    caller an "other" answer requires a non-empty shared comment (`questions.ts:30`).
- **Telegram polls.**
  - **Shape.** Each question goes out as an anonymous native poll. Options are
    lettered (`1a)`), the recommended one is marked, and an "other" question gets a
    "your own option by text reply" suffix
    (`src/lib/telegram/bot/reviewPolls.ts:27-42`).
  - **Votes decide nothing** (`src/lib/prototypeReview/types.ts:138`). Each poll
    says so in its text (`reviewPolls.ts:169`).
  - **The decision is the owner's text reply.** It is parsed by
    `parsePrototypeAnswer` (`src/lib/prototypeReview/telegramAnswer.ts:35`) and
    recorded as `operator-in-process` (`src/lib/externalRelay/prototypeAnswer.ts:23`),
    then confirmed back with what was recorded (`prototypeAnswer.ts:28-36`).

  That is the precedent for recording an answer away from the screen.
- **Voice and forms today.** The voice reads forms
  (`read_prototype_review`, `view_prototype_frame`, `boardReads.ts:12`). By rule it
  records nothing: "A spoken choice on a review is recorded only in the review form"
  (`sessionConfig.ts:17`; `voice-prototype-review-flow.md` §2.9).
- **`request_attention`.**
  - It moves the operator's view, or on a phone shows a notice
    (`src/lib/mcp/server.ts:4033`).
  - It plays `your-move` (`src/components/attention/AttentionHost.tsx:341`).
  - It has no Telegram path, and it never reaches the voice (searched
    `src/lib/attention`, `src/lib/telegram`, `src/lib/voiceCompanion`).
  - Its record carries a one-sentence `reason` meant to be safe to show the operator
    (`src/lib/attention/types.ts:60`, `:224-290`).

### 1.5 What only the screen shows: the gaps

| What the screen shows | Where it shows | Does the voice hear it? |
| --- | --- | --- |
| Board state: what runs, what waits | Board and needs-you badge (`src/components/Viewer.tsx:1110`) | Only when asked: `list_pipelines`, `list_tasks` (`boardReads.ts:12`) |
| A lane parked on a decision | Pipeline state `needs_decision` (`src/lib/pipelines/types.ts:902`, set by `park`, `src/lib/pipelines/engine.ts:3347-3350`); a needs-you row, or routed to the seat first (`src/components/attention/needReason.ts:107-112`) | No. A seat may later file a `blocked` report, which is spoken |
| A form waiting | Needs-you `prototype` entry (`attentionQueue.ts:73`), `your-move` sound | No. Only on request |
| A deploy result | «Готово» `deploy` item with its phase (`src/lib/done/types.ts:29-30`), `released` or `fault` | Only if the seat files a report about it |
| An agent stalled | Row words «Stalled»; no longer a needs-you entry (`src/components/attention.ts:108-114`) | Only on request, as a count (`boardReads.ts:177-186`) |
| A rate-limit wait | Conversation badge (`src/components/RateLimitBadge.tsx:13`, `src/lib/types.ts:117-123`); lane "waiting" and a «Готово» limit item | Only on request. `agent_fleet` takes its limit waits from lanes' provider waits (`src/lib/mcp/agentFleet.ts:64-77`); *inferred:* a rate-limited conversation outside a lane is not counted |
| An attention request from a seat | The view moves, or a phone notice | No |
| A launch accepted, a stage passed, a merge | `launched`, `step`, `landed` sounds | No. `launched` and `step` are muted during calls (`cuePlayer.ts:124`) |
| Which request of this call is still waiting | The companion lane cards | Yes, on request (`orchestrator_reports`, `tools.ts:124`) |

One more gap: on a phone the board feed stops when the page is hidden
(`src/lib/client/hiddenTraffic.ts:31-33`), and so do event sounds
(`cuePlayer.ts:260`). The voice poll runs on its own and does not consult that rule
(searched `src/lib/voiceCompanion`, `src/components/voiceCompanion`). *Inferred
consequence:* hands-free facts must come over the voice poll from the server, not
from the page's board feed. Otherwise a phone in a pocket hears nothing.

---

## 2. The hands-free experience

### 2.1 Entering and leaving

- **By voice.**
  - Entering: "hands-free", «без рук», «режим без рук» and similar phrases, said at
    any time in a call.
  - Leaving: "hands-free off", «досить без рук», or ending the call.
  - The voice delegates the phrase to a new registry tool `hands_free`
    (class `session-control`, like `end_conversation`, `tools.ts:196`).
  - The server checks the operator's own words the same way it checks a hang-up
    (`liveEndRefusal`, `src/lib/voiceCompanion/liveGate.ts:94`, called at
    `tools.ts:201`), so a quoted or conditional phrase changes nothing.
- **By tap.** A toggle in the companion's menu. On the phone it sits beside Hide
  (`phone-voice-head-build.md`, "The ⋯ menu entry").
- **What signals it.**
  - **Entering:** one spoken line, "Hands-free on. I'll tell you when something
    needs you, fails, lands or ships. Ask 'what's going on' any time." The companion
    shows a small «Без рук» badge. No earcon: an earcon for the mode would be an
    eighth sound to learn.
  - **Leaving:** "Hands-free off. I'll answer when you ask."
- **Where the mode lives.** On the server, in the call's stored session
  (`storage.ts`), so a reconnected part keeps it (`callResume.ts`). Each backend
  delegation's input states it (the input built in `liveSession.ts`,
  `voice-mode-explained.md` S3).
- **Choice H2: does every call start hands-free?**
  - (a) Off by default, and a setting "Start calls hands-free"
    (recommended). The mode adds proactive speech, which is wrong when the operator
    is looking at the board.
  - (b) Always on.
  - (c) On for phone-head calls only.

### 2.2 What it says on its own, and what only on request

Proactive speech is limited to facts that change what the operator does next, or
that answer something they asked in this call. Classes and their tiers are in §4.

| Proactively (in a gap, earcon first) | Only on request |
| --- | --- |
| Something needs you: a form waiting, a lane parked on a decision, a seat's question or blocker, an attention request | The whole board, lists of tasks or pipelines |
| Something failed: a merge blocked, a deploy failed or rolled back, a launch failed | Stage-by-stage progress, steps passed |
| Work started on a request sent in this call, and its outcome (its reports) | Agents' messages and conversation text |
| A lane merged; a lane you started in this call finished | Stalled agents (also in the brief, §2.8) |
| A deploy succeeded | Limit waits on accounts not blocking your requests |
| A rate-limit wait that holds a lane you asked about | Frames, variants, full report text for unrelated projects |

### 2.3 Narrating its own actions

The voice already acknowledges briefly while the backend works
(`sessionConfig.ts:17`, "say only a short acknowledgement"). It must not say what it
is about to read: a claim of intent that then fails is the honesty defect
`voice-prototype-review-flow.md` §2.7 fixed. Hands-free keeps that rule and adds
narration **after the fact**, written by the server from the tool's result:

| Action | Spoken when it completes | Source of the words |
| --- | --- | --- |
| Board read | The answer itself | `speech` of the read result (`boardReads.ts`) |
| Send to the orchestrator | "Sent. I'll tell you when it answers." | The delegation result's `speech` (`tools.ts:60-70`) |
| A send not made | The reason, in its own words | Same; honest delivery (`voice-privacy-scope-and-honest-delivery.md` Design B) |
| Form answer recorded (§2.4) | "Recorded: …; the orchestrator has it." or "… saved; it will reach the orchestrator when it is back." | The decision's delivery state, as the Telegram confirmation reports it (`prototypeAnswer.ts:28-36`) |
| Timer set | Already spoken | `timer` (`tools.ts:191`) |
| Mode or setting changed | One line | `hands_free` result |

**Long backend work.** When a delegation has produced no answer after 6 s, the server
appends one progress line for that delegation: "Still reading; one moment." It does
not repeat it. The vendor allows updates on a running delegation ("Keep updates
accurate and useful", cited in `voice-mode-explained.md` §7). *Unknown:* whether
Codex speaks an append during a backing turn. `codexProvider.ts:332-350` holds
appended speech until the voice is silent and no backing turn runs, so on Codex the line may arrive with the
answer. Slice 2 measures it.

### 2.4 A decision form, read and answered by voice

**Finding it.** A proactive "needs you" notice names the form by its title words:
"A decision is waiting on the voice settings form: three questions." The operator
may also ask "what decisions are waiting". The flow below starts when the operator
says "read it" or «давай».

**Reading** is one question at a time, from the round read `read_prototype_review`
already returns (`voice-prototype-review-flow.md` §2.3):

1. "Question one of three: which layout should the phone head use?"
2. "Option A: …. Option B: …, the recommended one. Option C: …."
3. When the question allows "other": "Or say your own answer."
4. "What do you choose?"

Option letters are spoken as letters because the form and the Telegram poll use the
same letters (`reviewPolls.ts:36`). The operator may answer:

- **A letter or the option's words.** "B", "the recommended one", «другий».
- **Several options**, only when the question is `multiple`.
- **"Other"** followed by free text. The server takes the text **from the operator's
  own transcript turn**, not from the model's paraphrase. The server-side precedent
  is `operatorWords` (`liveSession.ts:945-948`), which joins the stored input rows
  of one operator turn and is what the send gate reads. The model only names which
  turn holds the answer; the words come from the session's stored inputs. How the
  words are recorded is under "Recording" below.
- **"Skip" or "already decided"**, when the question is skippable
  (`types.ts:26-27`).
- **"Take the recommendations"** for every question, the form's existing whole-form
  skip (`types.ts:34-36`).
- **"Repeat"**, **"go back"** or **"stop"**. Stopping leaves nothing recorded.

**Read-back and consent.**

- After the last question the voice reads the whole decision back in one or two
  sentences: "So: one B, two your own words '…', three recommended. Record it?"
- Only a plain yes in the operator's next turn records it. The server reads that
  turn's own words with the agreement check a spoken confirmation already uses
  (`spokenAgreement`, `src/lib/voiceCompanion/gate.ts:171`, applied at
  `liveSession.ts:958-970`; the rule is described in `voice-companion-research.md`
  lines 81-95).

**Recording.**

- A new registry tool `answer_decision_form` (class `delegation`, no egress) calls
  `decidePrototype` with a new in-process caller kind, `operator-voice`
  (`decision.ts:55`). It carries two facts, both read from the stored call and
  never from a tool argument the model could set:
  - the call's **starter** (`startedBy`, `src/lib/voiceCompanion/storage.ts:86`,
    of type `SessionStarter`, `:74`), which `companionStarter` set when the call
    began: in team mode the owner member's id, because only the owner can start
    a call (§1.4), or the operator on a solo installation
    (`src/lib/voiceCompanion/http.ts:9-14`);
  - the call's **project set**: the project in view and every project this call
    sent to, the same set `pollReports` reads (`admission.ts:618-621`).
- **Who is recorded as deciding.** `decidedBy` gets a branch for `operator-voice`
  ahead of the bare-operator line (`decision.ts:223`), so a voice answer never
  falls through to `{kind:"operator"}` by default. The branch maps the starter the
  way the call's own sends already do (`src/lib/voiceCompanion/deliveryPaths.ts:34-35`):
  - the owner's call in team mode is recorded as `{kind:"member", memberId}` of
    the owner, the record the web form gives the owner's own answer
    (`decision.ts:225-226`);
  - an operator's call on a solo installation is recorded as `{kind:"operator"}`;
  - a stored call with no `startedBy` (older records, which the transcript reads
    as the operator, `src/lib/voiceCompanion/transcriptRecord.ts:74`) counts as the
    operator on a solo installation and is refused in a team (guard 0 below).

  The saved decision then carries the owner member as its author, exactly as the
  owner's answer on screen does, and delivery's author recheck reads it from there
  (`decision.ts:187-194`).
- **Authority by voice is the owner's, narrowed.** Only the owner can start a
  call in team mode (§1.4), and the owner may decide any form on screen. The
  voice narrows that in two ways: it never decides a native-association round
  (guard 1), and it decides only forms in the call's project set (guard 2). The
  starter's membership is read again at decision time (guard 0). No route can
  revoke the owner today (`src/lib/team/members.ts:545`), so that read is a
  defence: if the starter is no longer the active owner, the answer is refused.
  An answer whose author stops being active afterwards is held by the existing
  delivery recheck (`decision.ts:182`, `:429`).
- **Non-owner members: cut, with a defence kept.** No route lets a non-owner
  member start or resume a call, so the design has no branch for one: no
  workspace check, no per-member wording, no per-member Telegram rule. This
  revision cuts those branches rather than adding a `canAct` check, because
  `canAct` is always true for the owner (`workspaceAccess.ts:36`) and would test
  nothing a reachable call can fail. Guard 0 keeps the defence: it refuses any
  starter other than the operator on a solo installation or the active owner
  member. If the voice routes are ever opened to other members, this section
  must first add `canAct` on the form's project to guard 2, for parity with the
  web form (`workspaceRoute.ts:294-300`).
- **What the answer records.** The voice answer is an **owner reply**, the shape the
  Telegram reply already uses
  (`src/lib/prototypeReview/telegramAnswer.ts:116-117`):
  - `originalReply` is the operator's own words for this form: the stored input
    rows of every operator turn from "read it" to the "yes", joined in order, the
    way `operatorWords` joins one turn (`liveSession.ts:945-948`). It is capped at
    20,000 characters like any owner reply (`decision.ts:277`).
  - A question answered "other" carries `customText`: the words of the operator
    turn that gave it, minus the leading "other" or «своє».
  - `comment` is empty.

  Because the input carries `originalReply`, `normalizePrototypeAnswers` accepts
  `customText` and does not require a shared comment (`decision.ts:276`, `:290`;
  `questions.ts:14`, `:30`). An owner reply skips two checks a web answer gets:
  "other must be offered" and "exactly one answer for a single-choice question"
  (`questions.ts:30`, `:32`). `answer_decision_form` makes both checks itself, from
  the round it read, before it calls `decidePrototype`. No change to
  `normalizePrototypeAnswers` is needed.
- **A new guard for `operator-voice`**, applied inside `mutatePrototypeRound`, so
  the check and the write are one step under the decision lock. Today's
  in-process guards do not cover the voice (§1.4): a seat round skips the waiting
  check, `operator-in-process` has no project check and is recorded as the
  operator whoever started the call (`decision.ts:223`), the same answers given on
  screen would report success to the voice (`decision.ts:302-307`), and a
  native-association round would be amended (`:308`). The voice caller is refused,
  before any other branch of `decidePrototype`, when:
  0. the actor the starter maps to fails `activeDeliveryActor`
     (`src/lib/team/actor.ts:46-49`), or is a member whose role is not `owner`
     (the role test the timers already apply, `voiceTimersServer.ts:49-50`): an
     operator call on a team installation, a call with no starter on a team
     installation, or, as defences only, a starter no longer active and a stored
     call naming a non-owner member, neither of which any route can produce
     today (§1.4, §2.4);
  1. the round is a native-association round. The voice never approves a native
     session association; the screen or the Telegram reply does;
  2. the form's project (`canonicalOrchestratorProject(task?.project ??
     round.project)`, as the seat's check at `:244` computes it) is not in the
     call's project set;
  3. the round has **any** decision, including one with the same answers. The
     voice read the form undecided; a decision now means someone else decided it;
  4. a task round is not the task's waiting round, or its task runs elsewhere
     (the `:245-247` test without its "no decision yet" exemption);
  5. a seat round was dismissed (the `prototype:<id>` dismissal that hides it from
     the needs-you list, `src/lib/prototypeReview/read.ts:147`).

  Each refusal is a `PrototypeError` with status 409 (3–5) or 403 (0–2), and the
  saved round is unchanged. On refusal 0 the voice says "Your access no longer
  lets this call record an answer. Nothing was recorded; the form still waits."
  The call goes on; only the form answer is refused.
- Delivery to the seat follows the existing background path
  (`deliverPrototypeDecision`, `prototypeAnswer.ts:26`).
- The voice then says what was recorded and the delivery state (§2.3).
- **Decided elsewhere while the voice was reading.** Refusal 3 answers. The voice
  says "That form was already decided on another screen" and reads the saved
  decision back from the round. Nothing it heard is recorded.

**A lane parked on a decision** has no form. Its question is the stage's
`needs_decision` summary (`src/components/attention/operatorAsk.ts:87-88`). By voice
the operator hears that summary. Their answer goes to the orchestrator as an
ordinary request through `request_orchestrator_delegation`, exactly as today. The
seat resolves the lane, or escalates it to a form (`attention-auto-resolve.md` line
46), which the flow above then answers.

**Choice H4: may a spoken answer record a form decision?**

- (a) Yes, with the read-back and a spoken yes (recommended). This is what
  "information you would see on screen, and act on it without hands" needs, and the
  Telegram reply already records decisions away from the screen.
- (b) No. The voice forwards the choice to the orchestrator as an ask, as today
  (`voice-prototype-review-flow.md` §2.9). A form is never closed without the screen
  or Telegram.

**Choice H5: may the voice resolve a parked lane directly** (`pipeline_action
resolve-decision`)? Recommended: **no** in this design; it goes through the
orchestrator as above. A parked lane's answer is often an instruction, not a pick
from options.

### 2.5 Long lists: summary first, detail on request

- **Lists.** A list is spoken as a count, the first three by priority, and the rest
  as a number: "Five lanes running. The voice settings one is waiting for you, the
  reconnect one is in review, the timers one is building; two more. Want them?"
  - The reads already return `shown`, `total` and `nextCursor` through their shared
    page shape (`boardReads.ts:56-59`).
  - "More" continues from the cursor. The server keeps the last list cursor per call
    for 10 minutes, so "more" needs no new search.
- **Reports.** Reports answering a request from this call keep today's rule and are
  read whole (`sessionConfig.ts:64`; `voice-lean-delegation.md` amendment of
  2026-10-14). In hands-free mode, a proactive report of more than two parts that
  answers **no** request of this call is spoken as its first part plus "the rest is
  longer; want it?". That rewords the "Reports are the exception to a short
  summary" line for unrelated reports only. **Choice H6.**
- **Order inside a summary.** Needs-you first, then failures, then results, then
  running work, which is the needs-you queue's own order
  (`attentionQueue.ts:14-29`).

### 2.6 Interruptions and barge-in

- **The model yields when the operator talks.** That is the interruption policy
  (`sessionConfig.ts:37`), and it stays. The explicit interrupt command exists
  (`src/lib/voiceCompanion/contract.ts:159`, `liveSession.ts:1410`) but no control
  sends it (searched `src/components`, `src/hooks`). Hands-free adds no tap.
- **Server-written speech never starts while the operator speaks.** Notices go
  through the same hold as reports: recognised input holds them, and the 15 s hold
  bounds it (`liveSession.ts:212`). Each notice part is at most 500 bytes, so a
  barge-in loses one short part at most.
- **"Skip", "next", "later", «далі», «потім».** The voice delegates these to
  `hands_free` with `skip`. The server marks the rest of the current notice spoken,
  and "later" moves it to the next digest (§4.2). Reports answering the operator's
  own request are never dropped by "skip". The report stays in `orchestrator_reports`
  for "read it again" (`tools.ts:132`).
- **"Stop" or «тихо».** The model stops talking. Proactive notices pause for 2
  minutes, and P0 still speaks (§4.1). "Quiet for an hour" is a timed quiet (§2.7).
- **Earcons wait for silence.** An earcon never plays over either voice (§3.2).

### 2.7 Quiet hours

There are none today (`prefs.ts:19-24`).

- **What they change.** Quiet hours apply only to **proactive** narration. Answers
  to questions are never quiet.
- **During quiet:**
  - P0 (§4.1) still speaks, with its earcon.
  - P1 notices are held; their earcons are suppressed.
  - On leaving quiet, one digest says what was held: "While it was quiet: one form
    is waiting, two lanes landed."
- **By voice.** "Quiet until nine", "quiet for an hour" or «тиша до дев'ятої» set a
  one-off quiet window. The voice clock interprets it in the call's time zone
  (`src/lib/voiceCompanion/voiceClock.ts`; `voice-mode-explained.md` §9 "Time").
- **As a setting.** A daily window stored with the companion settings
  (`storage.ts:302-310` validates their fields today).
- **Choice H7: a default daily window?**
  - (a) None. The operator sets one by voice or in settings (recommended): the
    operator's hours are not known to this design.
  - (b) 23:00–08:00 local.

### 2.8 "What's going on?" at any moment

A new read `hands_free_brief` (class `call-read`) answers "what's going on", «що
там», «що відбувається» and "anything for me?" in one tool round. Composing it from
four reads would spend the 4-round budget (`voice-mode-explained.md` §9). It returns
one spoken paragraph of at most three sentences, in this order:

1. **Needs you:** the count and the first one by title words.
2. **Your requests in this call:** how many still wait, and how long the oldest has
   waited.
3. **Since the last brief or notice:** what landed, failed or shipped.
4. **Running now:** the count of lanes and agents; limit waits and stalls when there
   are any.
5. **"Want details on any of these?"**

It reads the same server-side facts the narrator reads (§4.4), so a brief and a
notice can never disagree. Rows come back for "more" with a cursor (§2.5).

---

## 3. Audio cues

### 3.1 The earcon set

Seven classes. Each maps to one sound, and six of the seven sounds exist:

| Class | Earcon | Exists? | What it marks in hands-free mode |
| --- | --- | --- | --- |
| needs you | `your-move` (S6): two knocks F#5→B5 | yes (`synth.ts:160-248`) | A form, a parked lane, a seat question or blocker, an attention request |
| failed | `fault` (S7): falling A5→F5→D5 with a low drop | yes | A merge blocked, a deploy failed or rolled back, a launch failed, a request refused after sending |
| merged | `landed` (S4): rising D-major arpeggio | yes | A lane's merge reached `merged` |
| deployed | `released` (S5): landed plus a low swell | yes | A deploy reached `succeeded` |
| finished | `reply` (S8): E6→B5 | yes | The orchestrator answered a request of this call; a lane completed with no merge to make |
| started | `launched` (S9): glide A4→A5, then E6 | yes | The orchestrator's first `status`-class report that does not answer a request this call sent: work on it started (§4.1, P1). A question or blocker is never "started"; it plays `your-move` |
| rate-limited | new `waiting`: two soft low notes, B3→F#3, about 0.6 s, at the level of `step` (−23 LUFS) | **no** | A limit wait holding a lane or request the operator cares about (§4.1) |

- **Why `waiting` is new.** Today a limit episode plays `fault` (`workCues.ts:295-299`).
  To an ear that cannot look, "broke" and "waits for an account to reset" call for
  different actions. A distinct, quieter sound keeps "failed" meaning "go look".
- **Choice H3: the rate-limit earcon.**
  - (a) A new `waiting` sound in the wood palette (recommended).
  - (b) Reuse `fault`, as the desk does today. That keeps the set at six sounds but
    merges two meanings.
- **The ear learns seven sounds, no more.** `step` (S3) and the typing layers never
  play in hands-free mode (§4.3). The call's own tones stay as they are:
  - connect and disconnect (`companionCues.ts:70-71`);
  - timer (`:72`);
  - reconnect tick and give-up (`:73-74`; `voice-call-reconnect.md` §4).
- **Two classes change meaning in hands-free mode.** On the desk `landed` covers
  "merged or completed with no merge" (`sound-redesign.md` §3.1, S4). In hands-free
  mode, completed with no merge plays `reply` (finished) and `landed` means merged
  only. On the desk `launched` marks "the launch this device asked for was
  accepted" (`sound-redesign.md` §3.1, S9). In hands-free mode it marks the same
  thing for the voice: work started on a request this call sent. Other launches
  stay silent (§4.1, Dropped). The desk's map is unchanged.
- **Why "started" needs an exemption.** During any call the cue player silences
  `launched` (`QUIET_DURING_CALL`, `cuePlayer.ts:124`), both when the request
  arrives (`:261`) and again when the lane starts the sound (`:200`). The lane also
  drops `launched` when another sound is playing (`eventLane.ts:63`). Without a
  change, the started earcon could never play in a call. A hands-free earcon request
  therefore carries a `handsFree` flag, set only by the page when it plays a notice
  the voice poll delivered (§3.2 step 3). The lane passes the flag to its `start`
  callback, and a flagged `launched` is exempt from both the call silence and the
  busy drop. It still waits in the lane queue within the 15 s bound
  (`eventLane.ts:65`) and plays at the call's −6 dB. An unflagged `launched`, such
  as the new-agent card's own (`src/components/DraftAgentPane.tsx:676-678`), stays
  silent during a call, as today.

### 3.2 Cues and speech share one channel

The browser plays both: the provider's voice through the call's `<audio>` element
(`media.ts`), and earcons through the lane. They must take turns:

1. **The call takes the voice lease.** When a Voice Delegatus call connects, the
   companion calls `setVoiceConnected(owner, true)` (`audio/app.ts:196`), and
   `false` when it ends. The lane's existing call rules then apply: the queue clears
   at connect, the background sounds go silent and the rest play 6 dB down
   (`cuePlayer.ts:122-124`). This closes the gap of §1.3. A hands-free "started"
   earcon is the one exception to the silence (§3.1).
2. **The lane waits for silence.** A new "speaking" input on the lane holds the next
   earcon while either voice is audible, and for 300 ms after.
   - **Companion speech** comes from the output analyser `media.ts` already runs
     for the mouth (`voice-mode-explained.md` §5).
   - **Operator speech** comes from the last transcript fragment the poll delivered.
   - The ambient bed already takes the same kind of signal (`setVoiceSpeaking`,
     `audio/app.ts:243`); the lane gains the same input.
   - A held earcon keeps its place in the lane queue, bounded by the 15 s the queue
     already allows (`eventLane.ts:65`).
3. **Earcon first, words second.** A notice's speech is handed to the provider only
   after the page reports that its earcon played or was dropped (§3.3). The report
   goes into the next poll, the same way playback reports flow today
   (`src/lib/voiceCompanion/contract.ts:116`).
   - Bound: if no report arrives within 2 s, the speech goes anyway. A muted page
     must not hold speech.
   - The ear then hears the earcon, a short breath, then "A decision is waiting…".
4. **Priority between earcons stays the lane's.** `your-move` and `fault` may cut a
   lower earcon (`eventLane.ts:61`). An earcon never cuts speech.

**One lane, not two.** The companion's own tones (`companionCues.ts`) move onto the
same transport as one-shot call sounds. They play at once, like the master-switch
preview does (`cuePlayer.ts:254-257`), and keep their frequencies and gain, which the
reconnect design fixes. Hands-free earcons are ordinary lane requests carrying an
`obligation` key (§4.3). So one `AudioContext` and one set of rules play everything,
as the specification asks.

### 3.3 Volume, mute and the phone

- **Volume** is the existing cue volume (`prefs.ts`; slider in
  `src/components/SoundToggle.tsx`). Earcons follow it at the call's −6 dB.
- **Mute.**
  - The master switch mutes every earcon (`cuePlayer.ts:199`, `:251`). Spoken notices still
    come.
  - By voice, "sounds off" or «без звуків» turns hands-free earcons off for this call
    only. The flag is on the server, and the page stops requesting earcons.
  - "Sounds on" restores them.
  - The device switch is not changed by voice. It belongs to the device, and a voice
    command heard by the wrong phone must not flip it.
- **Phone in a pocket.**
  - A hidden phone plays no event sound (`cuePlayer.ts:260`), because its page
    fetches nothing (`hiddenTraffic.ts`).
  - A live call is different: its audio is playing and its poll is running. So while
    a Voice Delegatus call is connected, hands-free earcons bypass the hidden-phone
    rule. They come from the voice poll, not the board feed (§1.5).
  - Whether a locked phone keeps the page running at all is §5.2.

---

## 4. Priority and verbosity

### 4.1 Tiers

| Tier | What | Earcon | Speech |
| --- | --- | --- | --- |
| **P0: now** | An answer, question or blocker on a request this call sent; a deploy failed or rolled back; a form or parked lane the operator asked about in this call; the call itself ending (cap, plan limit) | yes, may cut a lower earcon | At the next gap in speech, ahead of every P1. Speaks during quiet hours |
| **P1: next gap** | Any other needs-you entry (form, parked lane, seat blocker or question, attention request); merge blocked; launch failed; merged; deploy succeeded; a limit wait that holds a lane this call asked about; **started**: the first `status`-class report, not answering, on a request this call sent | yes | At the next gap, after P0. Held during quiet hours and after "stop" (§2.6) |
| **P2: digest** | Lanes of other people's requests merged or completed in a burst; limit waits on other lanes; a stall that persisted 10 minutes; `status` and `completed` reports answering no request of this call | none | In the next brief, or in a digest at most every 15 minutes, only when nothing was spoken for 2 minutes |
| **Dropped** | Typing, tool calls, stage steps, stage starts, launches that serve no request of this call, seat ticks, delivery phases, quota probes, the inferred «asks you» | none | Never. The same events the desk keeps silent (`sound-redesign.md` §3.2) |

The P0 rule for reports keeps today's order: a report answering a request is spoken
whole (`sessionConfig.ts:64`).

**How "started" is recognised.** Every request the voice sends asks the seat to
report with `correlatesDirective` set to the request's key, and to set
`answersDirective` false on progress, a partial answer **or a question back**
(`admission.ts:63`). A correlated report that does not answer its request
(`answersRequest`, `admission.ts:83`) is therefore not always progress: a
`question`, `blocked` or `failed` report that does not answer is the request asking
back, and the scan records it as such (`reportStatus`, `admission.ts:71-79`;
`askedBack`, `:670-672`). So:

- **Started** is the first correlated report on a request whose `class` is `status`
  (the class `reportStatus` maps to `progress`, `:73`) and that does not answer the
  request. It plays `launched`, then the report's own words, which are already
  spoken whole as a report on this call's request. Later `status` reports on the
  same request are spoken without an earcon.
- **A question or blocker back** (class `question`, `blocked` or `failed`, not
  answering) is P0 and plays `your-move`, never `launched`, whether or not it is
  the first report. A later `status` report on the same request can still be the
  first `status` report, and then it plays "started".
- **A partial result** (class `completed` or `review_verdict` with
  `answersDirective` false) is spoken without an earcon and is not "started".
- A request answered in full with no `status` report first gets "finished" and no
  "started".

The obligation key for "started" is the request's key, so a reconnect does not
repeat the earcon. P0 never interrupts the model in mid-sentence. The
server cannot see sentence ends, and appending instructions "can interrupt speech in
progress" (`voice-mode-explained.md` §8), which would cut a word. P0 goes first at
the next gap.

**Expected rate.** The desk's sound map measured `your-move` at about 1.9 per hour
after obligation keys, `fault` 1.05, `landed` 2.94 and `released` 0.42
(`sound-redesign.md` §3.1). Those are source rates over its 168-hour window, not
re-measured here. *Inferred:* P0 plus P1 would be on the order of six spoken notices
an hour on that installation, plus the answers to the operator's own requests. That
is few enough to speak each one; slice 2 measures it.

### 4.2 Batching and collapse

- **One obligation, one notice.** A notice carries the same obligation key the lane
  uses: the task id when the entry has one, else the entry id (`sound-redesign.md`
  §4.1). A key spoken in the last 10 minutes is not spoken again
  (`eventLane.ts:53`). A lane parking and a minute later its seat publishing a form
  for the same task is one notice: "needs you".
- **Bursts.** Notices of one class arriving within 5 s are spoken as one: "Three lanes
  merged: the timers one, the reconnect one and one more." This mirrors the lane's
  window for `landed` (`eventLane.ts:43-51`). The merged notice has one earcon.
- **Flapping.** A state that reverts within 60 s, such as a lane parking and then
  resuming on its own retry, is not spoken. The narrator waits 60 s before speaking
  a park when the lane's provider wait owns an automatic retry
  (`needReason.ts:110`). It speaks at once otherwise.
- **The same fact from two sources.** The seat often reports what the board already
  shows: a deploy, a merge. The notice and the report are joined when the report
  names the same pipeline, task or deployment id within 5 minutes:
  - When the report arrives first, the notice is dropped.
  - When the notice was spoken first, the report's own words follow, framed "more
    from the orchestrator".
- **Limit waits** collapse per account and window: one notice for "an account is
  waiting for its limit until 14:00", however many lanes wait on it.
- **Stalls** are spoken at most once per agent per hour, and only in P2.

### 4.3 Privacy in shared spaces

Hands-free speech is heard by anyone in the room, unlike the screen.

- **What notices never speak.**
  - Report bodies and conversation text for projects other than the one in view.
  - Account labels. The limit caption today carries one (`workCues.ts:297`); the
    spoken notice says "an account".
  - People's names, chat titles, Telegram group content. The existing private
    boundary already keeps group content out of every delivery
    (`voice-privacy-scope-and-honest-delivery.md`, "The threat model this keeps").
  - Identifiers and handles (`sessionConfig.ts:64`).
- **Private mode.** "Someone's here", "private mode" or «тут люди» turn it on.
  - Notices then carry only class, project display name and title words:
    "Something needs you in the voice project."
  - Reports are announced, not read: "The orchestrator answered your request about
    timers. Say 'read it' when you're alone."
  - "Read it" in private mode needs the operator to repeat "read it anyway" once.
    That second ask is the operator's own decision to have it heard.
- **Enforcement.**
  - **On the server.** Notices are built from structured fields only: class, project
    display name, the entry's title words. A private-mode notice never includes free
    text, so this holds whatever the model does.
  - **In the prompt only.** The model's own answers to questions in private mode
    follow a prompt line ("answer with states and counts; no message text"). That
    line is a prompt-level rule, not a server guarantee. A server check like the
    private-context boundary would refuse reads that return message text in private
    mode. It is listed as deferred (§8).
- **Choice H8: how private mode starts.**
  - (a) Only by voice or tap (recommended). Nothing tells the Viewer who is in the
    room.
  - (b) Automatically whenever the output device is the phone's or laptop's speaker
    rather than headphones. The device picker knows the chosen sink
    (`src/lib/audio/voiceDevices.ts`), but a sink's name does not reliably say
    "speaker" (*inferred*).

### 4.4 Where the narrator reads its facts, and what it costs

The narrator runs inside the existing events poll, beside `speakReports` and
`speakTimers` (`liveSession.ts:1434-1435`). It runs only for calls in hands-free mode.

**The rule: per-poll work grows with what changed, never with the registry.** Every
source below is a SQLite state collection with a collection revision and a change
log. `changesAfter(revision, key, limit)` returns only the rows written or deleted
after a `(revision, key)` cursor, each with its current value and row revision, and
reads nothing when the revision has not moved
(`src/lib/state/sqliteStateStore.ts:2642-2670`). Three readers already follow a
collection this way: the task-binding feed over pipelines
(`pipelineTaskBindingSource`, `src/lib/pipelines/store.ts:2625-2636`), the limit-spend
index (`src/lib/activity/taskLimitSpend.ts:228-233`) and the catalog's folder index
(`src/lib/scanner/projectCatalogStore.ts:544-560`).

The narrator does **not** use the obvious tests:

- The cached pipeline list's identity changes on any write to the collection
  (`loadPipelinesForList`, `store.ts:2062-2072`, over the revision-validated cache,
  `:2024-2027`).
- `pipelineRevision` hashes a pipeline's whole JSON (`store.ts:53-54`).

Together they would re-hash every pipeline, for every hands-free call, on every
500 ms poll after any write anywhere. Likewise `buildNeedsYouQueue`
(`attentionQueue.ts:61-76`) takes every conversation, pipeline and task, which the
screen can afford once per board read and the narrator cannot afford per poll.

| Source | Change test | Read when it moved | Facts |
| --- | --- | --- | --- |
| Bridge reports | Already polled per project watermark (`admission.ts:612`, `:626-650`) | New reports for the call's projects | Answers, progress ("started", §4.1), questions, blockers. Class decides the tier (`src/lib/bridge/types.ts:80-89`, `:109-117`) |
| Pipelines | The active collection's change log (`pipelineTaskBindingSource`, `store.ts:2625-2636`) | Changed rows only; each decoded and kept only when its canonical project is in the call's project set | Parks (`needs_decision`), merges, merge blocks, completions |
| «Готово» items | `doneRevision()` (`src/lib/done/store.ts:140`), then the same collection's change log (`:117-123`) | Changed items only | Deploy phases, limit episodes |
| Forms | The tasks change log (`src/lib/tasks/store.ts:1651`) and the `seat-decisions` collection's (`seatRounds.ts:19`) | Changed task rows and seat rounds; a task row counts only when its waiting round changed | Forms waiting |
| Attention requests | The `attention` collection's revision (`src/lib/attention/store.ts:124-135`) | Changed `r:<id>` rows | Requests a seat raised for the operator |
| Needs-you conversations | The `project_catalog` change log (`projectCatalogStore.ts:60`, `:544-560`) | Changed conversation rows, each classified alone by the per-conversation attention rule the queue uses | Permissions, failed launches, stuck deliveries |

- **Shared across calls.** The change-log cursor and the decoded changes of one
  poll window are kept once per Viewer process, keyed by collection revision, and
  every hands-free call filters that one page by its own project set. A second
  call adds a filter, not a second read.
- **Bounded per poll.** Each source reads at most one page of 256 changes per poll,
  the page size the limit-spend index uses. A larger backlog (a burst of writes,
  a Viewer restart) drains over the following polls, oldest first, so a notice can
  be late but is never lost.
- **A cursor behind the log's floor.** When `changeFloor` passes a call's cursor (a
  re-import, or a cursor idle past retention), the source re-baselines from the
  current rows of the call's projects through an indexed read, and speaks the
  one-line baseline summary below instead of the gap. The limit-spend index handles
  the same case by re-seeding (`taskLimitSpend.ts:230-233`).
- **Classification is per changed row.** A pipeline row is compared with the
  narrator's last seen state of that pipeline (state, merge phase, parked reason)
  kept in a bounded per-call map of the call's projects' lanes, evicted when a lane
  is terminal and spoken. No row is hashed whole.
- **Watermarks.** Each source's `(revision, key)` cursor is stored per call in the
  call's session, the way report watermarks already are (`admission.ts:626-650`).
  A reconnected part then speaks what happened while it was away, once.
- **Baseline.** The first poll after entering the mode sets a baseline from indexed
  reads of the call's projects and speaks a one-line summary instead of every old
  fact: "Right now one form waits for you; I'll tell you about anything new."
- **Cost.** *Inferred:* with no writes a poll costs one revision read per source;
  with writes, a page of changed rows. *Unknown:* whether every per-conversation
  needs-you reason can be computed from a catalog row alone, without the
  scanner's in-memory entries. Slice 3 confirms it before that source ships, and
  until then the conversation source is left out. Seat questions still arrive as
  bridge reports. Slice 3 measures the per-poll cost at the candidate performance
  gate's size: 53,299 rows of retained history
  (`docs/design/candidate-performance-gate.md` line 266, built by
  `src/lib/agent/registryPerformanceDataset.ts`), with the pipeline, task and
  «Готово» collections seeded to the same row count, under the gate's two
  concurrent writers. If the 500 ms cadence is too costly even so, the narrator
  runs every 2 s. A notice two seconds late is still timely.
- **No new paid call.** A notice is a commentary append (API) or `appendSpeech`
  (Codex), not a backend response, so it adds no per-answer spend. Voice seconds
  are still billed on the API backend while the call is open
  (`voice-mode-explained.md` §2, "Billing").
- **Choice H9: the backend for long hands-free calls.** Hands-free calls tend to stay
  open longer.
  - (a) Keep the operator's current backend choice and the monthly cap
    (recommended). The cap already ends a call cleanly (`errors.ts:7`).
  - (b) Prefer the Codex backend for calls started hands-free, since it bills the
    plan rather than per second (`voice-codex-subscription.md`).

---

## 5. Failure modes and what the operator hears

### 5.1 Lost connection

The reconnect design's §4 table is the one source of cues and words. This design
adopts all five of its rows unchanged and adds two.

| Moment | Sound | Spoken |
| --- | --- | --- |
| Tier 1 blip, over 1 s | none | none during; the resume line after, if words were lost (`voice-call-reconnect.md` §4) |
| Tier 2 begins | disconnect cue (`companionCues.ts:71`) | none; no voice is connected (`voice-call-reconnect.md` §4) |
| Back | connect cue (`:70`) | the resume line, if anything was cut (`voice-call-reconnect.md` §3.6) |
| Gave up | give-up cue (`:74`) | none; the screen line `RECONNECT_GAVE_UP` (`errors.ts:15`) |
| Offered on reload or another device | none | none; the existing screen line `CONNECTION_LOST` with Reconnect (`errors.ts:11`) |
| **New: back, and notices were owed during the drop** | the connect cue, then the owed notices' earcons in turn | After the resume line: "While we were disconnected: …". Notices are collapsed by class (§4.2) and P0 comes first. They are durable in the call's session, like owed report parts (`admission.ts:674`), so none is lost or doubled |
| **New: gave up while a P0 is owed** | give-up cue | none; the P0 goes to the Telegram fallback when that is chosen and the call's starter may receive it (§5.2); otherwise only the screen shows it |

### 5.2 Locked phone audio

- **What the code does today.**
  - A suspended page stops polling. The server closes the part after 30 s without
    polls (`liveSession.ts:486`).
  - An automatic reconnect does not run while the page is hidden on a coarse-pointer
    device (`src/hooks/useVoiceCompanion.ts:124-125`).
  - There is no Wake Lock or Media Session code (searched).
  - What a locked iPhone does to the page, the peer and playback is **unknown**. It
    is tracked in task `7194c5e5` and measured by the reconnect design's slice 5 on a
    real device (`voice-call-reconnect.md` §8).
- **What the operator hears.**
  - **If the page keeps running**, the call goes on and so do notices and earcons
    (§3.3).
  - **If the page is suspended**, the operator hears the call's audio stop. On unlock
    they hear the resume line and then the owed notices (§5.1).
- **What the server does meanwhile.** It still knows the call's owner, and
  `liveCall(owner)` turns false 5 s after the last poll (`liveSession.ts:1259-1262`,
  `contract.ts:166`). The timers already use that test to deliver by another channel
  when no call can speak (`voiceTimers.ts:586-589`). Hands-free reuses it: a P0
  notice owed to an owner with no live call goes to the operator's Telegram chat,
  with the same structured words as the private-mode notice. The chat is the one the
  timers' Telegram option uses (`storage.ts:23`, `timerTelegram`). It is sent at most
  once per obligation key.
- **Who receives it.** The paired Telegram chat is the installation's and
  belongs to its owner. Every call that can exist today is the owner's: the
  operator's on a solo installation, or the owner member's in team mode, the
  only member the team gate lets start a call (§1.4). So the P0 always goes to
  the paired chat. Hands-free still applies the test the timers use before that
  chat (`isOperator`, `src/lib/voiceCompanion/voiceTimersServer.ts:46-51`;
  `voiceTimers.ts:365-370`) to the call's starter, as a defence only: a stored
  call naming any other member, which no route can create, sends no Telegram
  message, and the P0 stays owed on the call to be spoken when it resumes
  (§5.1).
- **Choice H10: the Telegram fallback.**
  - (a) On for P0 only, under the existing timer Telegram switch's consent, off by
    default (recommended). Only the operator or the owner can start a call, so
    every call qualifies.
  - (b) Off: hands-free stays within the call.

### 5.3 Long sessions and memory after compaction

- **API backend.** The speaking model replaces its engine past 90% of its window.
  The replacement keeps the original instructions and up to 8,192 tokens of history
  (vendor text quoted in `voice-mode-explained.md` §8). Delegatus gets no event when
  that happens (*unknown* whether one exists; the vendor pages read for that note
  name none).
- **Codex backend.** What compaction does to the ephemeral thread's spoken context is
  **unknown**.
- **Design rule: nothing hands-free depends on the model remembering.**
  - The mode, quiet window, private mode, list cursors and owed notices live on the
    server (§2.1, §4.4).
  - Every notice part is self-contained: class, project, subject. It never says "as I
    said".
  - Each backend delegation's input states the mode (§2.1).
  - Hands-free rules live in the startup instructions, so a replacement engine keeps
    them; a mid-call `instructions.append` would be lost with the history.
- **What the operator hears.** Nothing different. If the voice seems to have
  forgotten, "what's going on" (§2.8) rebuilds the picture from the server.
- **Across calls.** Call memory summaries already reach the next call
  (`callMemory.ts:12`, `:117`). The next call starts in hands-free mode only by the
  setting of Choice H2.

### 5.4 The voice failing to read a card

- **The incident.** The pinned specification records an access refusal on
  2026-11-01. Its record is not in the repository: the search of `docs/` for that
  date and for refusals found only the reconnect design's call drops. Which read was
  refused is **unknown** here. The refusals a voice read can meet today:
  - **Voice Delegatus:** `PROJECT_REFUSED` when the card belongs to another project
    than the call's (`boardReads.ts:108-110`, `src/lib/voiceCompanion/readPaths.ts:74`).
    Also `TOOL_NOT_ALLOWED` and the private-data boundary (`liveSession.ts:1063-1072`).
  - **The gateway or any MCP caller:** `workspace_forbidden` for a team member
    (`src/lib/mcp/workspaceFence.ts:23-25`), and
    `conversation_messages_transcript_unavailable` (`src/lib/mcp/bindings.ts:3835-3846`).
  - **A seat:** `project_scope_refused` and `cross_project_refused`
    (`bindings.ts:6508-6510`).
- **What the operator hears.** The voice speaks one sentence in three parts, and it
  never guesses the card's content:
  - what it tried ("I tried to open the timers card");
  - the cause in plain words, never the code ("it belongs to another project than the
    one we're on");
  - what it can do instead ("say the project's name and I'll read it there", or "I can
    ask the orchestrator").
- **Mechanism.** The refused result already carries a `speech` field
  (`liveSession.ts:1069-1072`). Hands-free adds plain wordings for each code and adds
  no earcon. A refused read is not a board event, and `fault` would teach the ear it
  was.
- **Proactive notices.** These come from server facts, not reads, so a read refusal
  never silences them.

### 5.5 Other failures

| Failure | What the operator hears |
| --- | --- |
| Monthly cap or Codex plan limit ends the call | The existing sentence (`errors.ts:7`, `:25`), then the disconnect cue |
| A notice source fails to read (store error) | Nothing at that moment. The narrator retries on the next poll; after 3 failures in a row it says once "I can't see the board's updates right now; ask me and I'll check" and records why |
| The 64-item speech queue is full (`admission.ts:85`) | Notices queue behind reports. A full queue stops the scan, and P2 is folded into the next digest |
| A form recorded but delivery failed | "Saved in Delegatus; the orchestrator will get it when it's back," from the decision's delivery state (`prototypeAnswer.ts:28-36`) |
| The Viewer restarts (a deploy) | The call drops and reconnects (§5.1). The deploy's own notice is not lost: it is a durable «Готово» item past the call's watermark |

---

## 6. Build plan

Thin vertical slices. Each ships alone and is useful alone. Tests run in isolated
state, as the project's instructions require. Each slice's measurement runs on
recorded call journals and recorded board data, before and after.

### Slice 1. The call shares one audio channel

- **Changes:**
  - Voice Delegatus takes the voice lease at connect and releases it at end.
  - The lane gains the "speaking" hold.
  - The companion's tones move onto the shared transport with unchanged sound.
- **Files:** `src/components/voiceCompanion/VoiceCompanionHost.tsx` (or
  `src/hooks/useVoiceCompanion.ts`), `liveAdapter.ts`, `companionCues.ts`,
  `src/lib/audio/app.ts`, `cuePlayer.ts`, `eventLane.ts`.
- **Acceptance:**
  - During a companion call, unflagged `step` and `launched` requests (the desk's,
    such as the new-agent card's) are silent and the rest play −6 dB (fake clock,
    lane test). The hands-free exemption for "started" arrives with slice 3.
  - An event sound requested while the voice output is audible waits, and plays
    300 ms after it falls silent.
  - The connect, disconnect, timer, tick and give-up tones keep their frequencies and
    gain (unit test against `companionCues.ts` constants).
- **Measure:** earcons started while either voice was audible, per call hour.
  Before: counted from the existing journal and cue log. After: target 0.

### Slice 2. Hands-free on and off, and "what's going on"

- **Changes:** the `hands_free` tool, the stored mode, the menu toggle and badge, and
  `hands_free_brief`. No proactive narration yet.
- **Files:** `tools.ts`, `sessionConfig.ts`, `storage.ts`, `liveSession.ts`,
  `admission.ts`, a new `src/lib/voiceCompanion/handsFree/brief.ts` over
  `boardReads.ts`, the companion components, `src/lib/i18n/en.ts`, `uk.ts`.
- **Acceptance:**
  - A spoken "hands-free" turns the mode on. A quoted one ("if I say hands-free…")
    does not (the consent check's cases).
  - The mode survives a reconnect.
  - The brief answers in one tool round, in the needs-you order, with no identifier
    spoken.
- **Measure:** tool rounds per "what's going on" (target 1); brief length in bytes
  (≤ 500).

### Slice 3. Proactive notices for the operator's own requests and needs-you

- **Changes:**
  - The narrator over the sources of §4.4.
  - P0 and P1 tiers with obligation keys.
  - Earcon-then-speech through the report speech queue, with the page reporting
    earcon playback.
  - The `handsFree` flag on earcon requests, carried through the lane to `start`,
    which exempts a flagged `launched` from the call silence and the busy drop
    (§3.1).
  - "Started" from the first `status`-class report, not answering, on a request
    of this call (§4.1); a question or blocker back stays `your-move`.
  - Change-log readers per source, shared per process and bounded per poll (§4.4).
  - The `waiting` sound if Choice H3 is (a).
- **Files:** a new `src/lib/voiceCompanion/handsFree/narrator.ts`, `classify.ts`
  and `changeFeed.ts`, `admission.ts` (a `notice` kind beside reports),
  `liveSession.ts` (`speakReports`), `liveAdapter.ts` (`playCue` on the notice
  event), `cuePlayer.ts`, `eventLane.ts`, `synth.ts`, `src/lib/audio/cues.ts`, and
  read-only change-log sources beside `pipelineTaskBindingSource` in
  `src/lib/pipelines/store.ts`, `src/lib/done/store.ts`,
  `src/lib/prototypeReview/seatRounds.ts` and `src/lib/attention/store.ts`.
- **Acceptance**, each with a fake clock and fixed ids:
  - A lane parking on a decision is heard once, as `your-move` then one line. The
    seat's form for the same task a minute later is not heard again.
  - A deploy that failed is P0 and goes before a waiting P1.
  - A notice never starts while the operator's input hold is active.
  - **Started plays during a hands-free call.** With the voice lease held, the
    first `status`-class report on a request this call sent plays `launched` at
    −6 dB, then its words; a second `status` report on that request plays no
    earcon. In
    the same test, an unflagged `launched` request (the new-agent card's) stays
    silent, and a flagged `launched` that arrives while another sound plays
    waits and then plays instead of being dropped.
  - **A question back is not "started".** When the first correlated report on a
    request is class `question` with `answersDirective` false, the call plays
    `your-move` and speaks it as P0, and no `launched` plays. The same holds for a
    first report of class `blocked`, and of class `failed` with `answersDirective`
    false. A `status` report that follows the question on that request then plays
    `launched` once. A `completed` report with `answersDirective` false plays no
    earcon.
  - **Per-poll work follows changes.** With no writes, a poll reads only
    collection revisions and decodes no row. A write to a pipeline of another
    project is read once per process and speaks nothing. Two hands-free calls
    read each change page once. A cursor behind `changeFloor` re-baselines and
    speaks the baseline line once.
  - A reconnect speaks notices owed during the drop exactly once.
  - Private mode never puts report text into a notice.
  - Every source's failure path keeps the others speaking.
  - Restarting the real Viewer process keeps the watermarks, with no repeat.
- **Measure:**
  - Time from the event's own time to its earcon. Target median under 5 s with the
    page visible.
  - Notices per call hour against the §4.1 estimate.
  - The narrator's time per poll, median and p95, on a registry of the candidate
    performance gate's size (53,299 rows, §4.4) under its two concurrent writers:
    once with no writes, once with the writers running, before and after, each
    run repeated three times on the same seeded data. Also the rows decoded per
    poll, which must track rows changed, not rows stored. The cadence choice of
    §4.4 follows from it.

### Slice 4. A decision form answered by voice (if Choice H4 is (a))

- **Changes:** reading a form one question at a time, `answer_decision_form`, the
  `operator-voice` caller in `decidePrototype` with its own guard, recorded under
  the call's starter (§2.4), the
  answer recorded as an owner reply with the operator's words as `originalReply`
  and "other" as `customText`, read-back and consent.
- **Files:** `tools.ts`, `sessionConfig.ts` (replacing the "records only in the
  review form" line, `:17`), `src/lib/prototypeReview/decision.ts` (the
  `operator-voice` kind, its `decidedBy` branch and its guard), `storage.ts` (the
  call's `startedBy`, read only), `liveSession.ts` (the operator's words
  for `originalReply` and `customText`), `src/lib/voiceCompanion/gate.ts`,
  `prototypeRead.ts`. `questions.ts` is unchanged.
- **Acceptance:**
  - A three-question form with one "other" is recorded with the operator's exact
    words as `customText`. Nothing is recorded without the spoken yes.
  - A form whose only question is answered "other", with no comment, is recorded:
    `customText` holds the exact words of the operator's turn, byte for byte from
    the stored input rows, `comment` is empty, and `originalReply` holds the
    form's operator turns.
  - "Other" on a question that does not offer it, and two options on a
    single-choice question, are refused by the tool before `decidePrototype`.
  - **Decided on screen mid-read.** A task form and a seat form are each decided
    on screen after the voice read them and before the spoken yes. For each, the
    voice answer is refused with 409, the saved round, its decision, revision and
    delivery are deep-equal before and after, and the voice says "already
    decided" and reads the saved decision. The same holds when the screen's
    answers equal the voice's.
  - A native-association round is refused with 403 and left unchanged.
  - A task form and a seat form of a project outside the call's project set are
    each refused with 403. A dismissed seat form is refused with 409.
  - **The owner's call** on a team installation, started through
    `/api/voice-companion/session` by the active owner member, so its stored
    `startedBy` is `{memberId:<owner>}`:
    - the answer is recorded with `decidedBy` deep-equal to
      `{kind:"member", memberId:<owner>}`, never `{kind:"operator"}`, and its
      delivery passes the author recheck (`prototypeAuthorCurrent`) and is sent
      once;
    - a call with `startedBy` `{operator:true}` or no `startedBy` on a team
      installation is refused with 403 and records nothing.
  - **Defensive, not reachable today.** A non-owner member's POST to
    `/api/voice-companion/session` is refused by the team gate and starts no
    call. A stored call whose `startedBy` names an active non-owner member,
    written straight into storage because no route creates one, is refused by
    guard 0 with 403 and records nothing. So is the owner's call after the
    owner member's stored status is set to anything but active mid-call, which
    no route does (`revokeMember` refuses the owner): the saved round is
    deep-equal before and after, and nothing is delivered.
  - On a solo installation an operator call is recorded as `{kind:"operator"}`,
    as the screen records it.
  - The Telegram reply path's tests still pass unchanged.
- **Measure:** the specification's own test. A hands-free user completes a decision
  form and learns the outcome of the lane it unblocks without looking, on a recorded
  scenario replayed through the fake provider (`src/lib/voiceCompanion/fakeProvider.ts`).
  Count the turns and the seconds to record.

### Slice 5. Digest, collapse, quiet hours and private mode

- **Changes:** the P2 digest, burst and flap collapse, report–notice joining, quiet
  windows by voice and setting, private mode, "skip" and "later".
- **Files:** `handsFree/narrator.ts`, `storage.ts` (settings), `voiceClock.ts`
  (window parsing), `sessionConfig.ts`.
- **Acceptance:**
  - Three merges within 5 s are one notice with one earcon.
  - A park that resumes within 60 s is silent.
  - During quiet only P0 speaks, and leaving quiet gives one digest.
  - "Skip" drops the rest of a P1 notice but never of a report answering this call.
- **Measure:** spoken seconds per call hour before and after collapse, on the same
  recorded day.

### Slice 6. Failure wording and the phone

- **Changes:**
  - Plain wording for each read refusal code.
  - The two new rows of §5.1.
  - The P0 Telegram fallback if Choice H10 is (a).
  - The hidden-phone earcon rule of §3.3.
- **Files:** `errors.ts`, `liveSession.ts`, `voiceTimers.ts` (the shared
  no-live-call delivery), `voiceTimersServer.ts` (the `isOperator` test reused for
  the call's starter), `cuePlayer.ts`.
- **Acceptance:**
  - Each refusal code yields one sentence naming what was tried, why and what
    instead, with no code spoken.
  - A P0 owed while `liveCall` is false is sent to Telegram once and not spoken
    again after reconnect.
  - On the owner member's call in team mode, the same P0 goes to the paired chat
    once.
  - Defensive, not reachable today: on a stored call naming a non-owner member,
    written straight into storage, the same P0 sends no Telegram message to any
    chat and is spoken once after reconnect.
- **Measure:** on a real phone, together with reconnect slice 5 and task `7194c5e5`:
  whether earcons and speech continue with the screen locked, for 10 minutes.

### How we know the mode works

| Measure | Target | Where measured |
| --- | --- | --- |
| A decision form completed by voice, with the lane's outcome learned, without looking | Done in one call; no screen interaction in the journal | Slice 4 scenario, then one live call |
| Event-to-earcon latency (page visible) | Median < 5 s, p95 < 15 s | Slice 3 journal rows |
| Earcons over speech | 0 per hour | Slice 1 cue log |
| Every one of the seven earcons can play in a hands-free call, "started" included | Each plays in its test | Slice 3 tests |
| Narrator work per poll | Rows decoded track rows changed; no whole-collection read | Slice 3, at the candidate gate's size |
| Repeated notices for one obligation | 0 | Slice 3 and 5 journals |
| Spoken notices per hour | Within twice the §4.1 estimate; otherwise the tiers are revisited | Slice 3 |
| "What's going on" | 1 tool round, ≤ 500 bytes | Slice 2 |
| Private mode | 0 report or message text in notices | Slice 5 tests, then call journals |

---

## 7. Operator choices

| Choice | Question | Options | Recommendation |
| --- | --- | --- | --- |
| H1 | Which voice gets hands-free mode | (a) Voice Delegatus; (b) both; (c) the gateway | (a) |
| H2 | Does every call start hands-free | (a) off, with a setting; (b) always; (c) phone head only | (a) |
| H3 | Earcon for rate limits | (a) new `waiting` sound; (b) reuse `fault` | (a) |
| H4 | May a spoken answer record a form decision | (a) yes, with read-back and a spoken yes; (b) no, forward it as an ask | (a) |
| H5 | May the voice resolve a parked lane directly | yes; no, through the orchestrator | no |
| H6 | Unrelated long reports in hands-free mode | read whole, as today; first part plus offer | first part plus offer; reports answering this call stay whole |
| H7 | Default quiet hours | (a) none; (b) 23:00–08:00 | (a) |
| H8 | How private mode starts | (a) voice or tap; (b) automatic on speaker output | (a) |
| H9 | Backend for long hands-free calls | (a) the current choice and cap; (b) prefer Codex | (a) |
| H10 | P0 to Telegram when no call can speak | (a) on, P0 only, under the timer Telegram consent, default off; every call is the operator's or the owner's; (b) off | (a) |

Slice 1 needs H1, and slice 2 needs H1 and H2. Slice 3 needs H3, slice 4 needs H4
and H5, slice 5 needs H6–H8, and slice 6 needs H10. H9 changes no slice; it sets
which backend a long call uses.

---

## 8. Unknowns, deferred work and fences

**Unknowns, and how each is settled:**

| Unknown | Settled by |
| --- | --- |
| What a locked phone does to the page and playback | Reconnect slice 5 on a device; task `7194c5e5` |
| Whether Codex voices a progress line during a backing turn | Slice 2 probe on the fake provider, then one live call |
| Whether the API engine replacement can be observed | The vendor's event list; not needed by the design (§5.3) |
| The narrator's per-poll cost at the candidate gate's size | Slice 3 measurement (§4.4) |
| Whether every per-conversation needs-you reason can be computed from a catalog row alone | Slice 3, before the conversation source ships (§4.4) |
| Which read was refused on 2026-11-01 | The call journal of that day on the operator's machine. This cloud stage could not read it |

**Deferred — not currently justified:**

- A server-enforced private mode for the model's own answers (§4.3). Notices are
  enforced; answers rely on the prompt until a misuse is observed.
- Hands-free on the gateway's Live Mode call (Choice H1 b).
- Resolving parked lanes by voice (Choice H5).
- Per-class earcon switches. One "sounds off" for the call covers the need.
- Spoken event announcements on the desk without a call (`sound-redesign.md`
  deferred them).
- An earcon for entering the mode.

**Fences.**

- The reconnect cues and strings (`voice-call-reconnect.md` §4) are adopted, not
  changed.
- The desk's sound map keeps its meanings outside hands-free mode.
- The privacy boundary and honest-delivery rules stay as built.
- The gateway's own report path (`bridgeDelivery.ts`) is untouched.

---

## 9. Check against the requirement

| The operator asked for | Where |
| --- | --- |
| Explains by voice what it is doing | §2.3, slice 2 and 3 |
| Passes on what the screen would show | §1.5 gaps; §2.2, §2.8, §4.4; slice 3 |
| Works without seeing and without hands | Voice entry and exit (§2.1); forms by voice (§2.4); "what's going on" (§2.8) |
| Audio notifications about actions | §3, slice 1 and 3 |
| A well-thought-out experience | Barge-in, quiet, lists, privacy, failures (§2.5–§2.7, §4, §5) |
| Design in the cloud | This lane's stages ran in a cloud checkout |
