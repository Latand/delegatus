# Voice: a group read no longer switches the voice off, and «sent» is said only after a send

## Originating requirement

The operator's request of 2026-10-16, paraphrased in English from this task's
pinned specification. After a voice call that went badly, the operator said the
voice companion could get nothing done and asked for the call to be broken into
issues. The operator approved six issues and, in a decision form at 13:08Z,
chose to fix two of them first: #2976 (every tool blocked after a Telegram group
read) and #2974 (the voice claiming a request was sent when it was not). The
other four follow.

The outcome the pinned specification sets, in short:

- Group content still cannot leave the call. A test tries to carry history text
  out through each send-capable tool. A group read no longer disables unrelated
  actions for the whole call: the boundary covers what can carry group content,
  and anything blocked is explained in plain speech with a way out.
- The voice states delivery only from a successful send result in this call or
  a receipt it has just read. Every refusal or failure result carries an
  explicit «nothing was sent» fact handed to speech. A scripted scenario where
  every send is refused proves the final speech never claims delivery. A
  scenario where a send succeeds speaks its delivery state.

Issue #2976, as approved, asks that the block stop only group content from
leaving and leave every other action working; failing that, that the voice say
plainly what is blocked and why, and offer a way out.

Written against `main` at `18096e8f2`. Every `file:line` below is on that
commit. `main` has since moved to `a880de287`; no file under
`src/lib/voiceCompanion/` changed in between, so the references hold. This note
changes no product code.

## The operator's decision

One question changed what gets built, and it was a privacy trade-off, so it went
to the operator: after a Telegram group has been read in a call, may the voice
still send work to an orchestrator in that same call?

The operator chose, on 2026-10-16, **yes, from the next turn, on API calls**:

- The turn that read the group cannot send.
- From the next turn on, the model that writes a task is never shown what the
  voice said after the read. The server withholds those replies from that
  model's input. It cannot copy group content into a task, and a message planted
  in the group cannot steer a send, because the writer never reads it.
- Codex calls keep sending off until the call ends, with a plain explanation and
  the offer of a new call. Codex keeps the whole call in one thread, and the
  thread cannot un-read the group.

Steps 1–4 of the build plan were shared by every option and stand as written.
The two options not taken are recorded under "Deferred".

### The residual risk the operator accepted

Two paths remain open on API calls, and the design does not close them:

- **The operator's own spoken words.** The task writer still reads the
  operator's turns, because acting on them is its job. A name or a quote from
  the group that the operator says aloud can travel into a task, the request
  row and the delivery to another agent.
- **Microphone echo.** The browser asks for echo cancellation
  (`src/lib/voiceCompanion/media.ts:38`), but on loudspeakers the canceller can
  miss. When the voice reads the group aloud and the microphone picks it up, the
  provider transcribes it as the operator's speech, and the writer reads it as
  such. The same path lets an instruction planted in a group message reach the
  writer when the voice reads it aloud.

Nothing in the server can tell an echoed sentence from one the operator said, so
both are named here and left open. Headphones close the second.

## What happened, from the call record

The call ran on the API backend, the backend the settings choose; 24 of the 25
stored voice sessions ran on it. Times are minutes into the call. The record was
read for tool names, statuses, codes and timing; no message content is
reproduced here.

| Minute | Record | Meaning |
| --- | --- | --- |
| 11.5–14.1 | 8 × `relay_owner_history` `done`, 3 failed | A group was read; the call is now flagged private for good (`liveSession.ts:590`). |
| 20.6 | operator turn | A request to send work to another project's orchestrator. **No delegation follows.** |
| 20.9 | report, two hand-offs | A report from that project arrives and is read aloud (issue #2972). |
| 21.1 | voice reply | A claim that the request was passed on. No delegation and no tool ran for it: **claim 1, made by the speaking model on its own.** |
| 21.8 | 2 × `private_history_blocked` `private_history_boundary` | An operator turn about that request; the backend's calls are refused. |
| 22.0 | hand-off | **The backend's text claims delivery** after both refusals. The server handed it to the voice as it was: **claim 2.** |
| 22.6–23.6 | 8 × `private_history_blocked` | Two more delegations, each refused two to four times. The hand-offs now say nothing could be sent. |

A claim at the start of the call about an earlier request came from the
backend after a read: an `orchestrator_actions` read finished three seconds
before it. That is a read in this call, the source the requirement allows. Call
memory was not the source: the previous call's summary lists no completed
items, and its requests were stored as `delivered` or `queued`.

## Why it happens, on `main`

**The boundary is all-or-nothing and lasts for the call.**
`liveSession.ts:589-595` sets `active.privateHistory` (and the Codex turn flag)
on any `relay_owner_history` result with status `done`. From then on every tool
except `relay_owner_history` and an empty `end_conversation` is refused, both in
`tool()` (`:566-567`) and in the backend loop (`:461`, `:522-523`, `:537`).

**The refusal hides what happened.** `:577-579` answers
`{ status: "refused", code: "private_history_boundary", reason: "private history is limited to this conversation", speech: "I can only use that history to answer you here." }`.
It does not say that nothing was sent, what was blocked, why, or what the
operator can do. The backend is then shown its own call under a fake name with
no arguments (`:527-534`), so it cannot tell that its send was refused.

**The server hands the backend's last text to the voice unchecked.**
`:512-518` speaks whatever the final response says. A send outcome is recorded
(`:539-544`), but only the path for a missing backend response uses it
(`:493-499`). The prompt rules ("say it was passed on only when the backend says
so", `sessionConfig.ts:16`; "Say that something was sent only when the backend
says so", `:53`) are instructions to models, and they did not hold.

**Some refusals never say «nothing was sent».** A thrown tool error becomes
`"The tool failed: <code>."` (`:617`). `NO_ORCHESTRATOR` lists other projects
(`:614`). Neither says that nothing was sent.

### Probe on `main`

The probe ran in a scratch export of `18096e8f2` with a private HOME, XDG
config, TMPDIR and `LLV_STATE_DIR`, and with `LLV_VIEWER_CONTROL_URL` on a closed
port. Command:
`bash <gate-slot> bun test src/lib/voiceCompanion/probeBoundary.test.ts`. It used
`FakeLiveProvider` on the API backend with synthetic data, and passed 4 of 4.

| Probe | Observed on `main` |
| --- | --- |
| After a history read, a later delegation calls `list_tasks` | `{"status":"refused","code":"private_history_boundary",…,"speech":"I can only use that history to answer you here."}` |
| Every send refused (`no_orchestrator`); the backend then writes "Yes, I passed it to the orchestrator." | The voice is handed `["Yes, I passed it to the orchestrator."]`; 0 sends |
| A send succeeds (`queued`); the backend writes "Done." | The voice is handed `["Done."]`; the delivery state is not handed |
| After a history read, a send; the backend writes "Yes, I passed it on." | The backend sees `{"name":"private_history_blocked","arguments":"{}"}` and the opaque refusal; the voice is handed `["Yes, I passed it on."]`; 0 sends |

## The threat model this keeps

The boundary came from three review rounds of the owner-history lane on
2026-10-12 (pipeline review attempts 1–3 of #2801). Each finding below stays in
force.

- **T1, carrying text out through a later tool** (round 1, P1). A page read
  through `relay_owner_history` stayed in the backend input, and the next
  response wrote it into `request_orchestrator_delegation`. The text reached the
  send, `voice-companion.json` and the call's JSONL record. Acceptance carried
  forward: an attempt to carry message text, a title or a name out through a
  later tool is refused, and none of that data reaches state, the record, events
  or a delivery to another agent. Reading further pages and answering the
  operator keep working, on both backends.
- **T2, the flag reset between turns** (round 2, P1). Codex keeps earlier pages
  in the same thread. The API backend gets the earlier private answer back
  through "The conversation so far" (`liveSession.ts:455`, `:474`). Acceptance
  carried forward: keep the private-context flag while the history or its answer
  stays available to the model, check it before any argument is recorded and
  before dispatch, and prove it with two consecutive turns on API and Codex.
  This design keeps that rule as written. On Codex the history stays available,
  so the flag lasts the call. On API the server stops handing the answer back
  (Design C), so a later delegation's writer has neither the history nor its
  answer, and its flag starts off. The two-turn test stays on both backends: on
  Codex the second turn is refused, and on API it proves the second turn's input
  holds no history.
- **T3, hang-up after a read** (round 2, P2). An explicit "end the call" must
  still end it, and an unrequested hang-up must still be refused.
- **T4, call memory.** `callMemory.ts:21-60` already cuts the summary back to
  the operator turn that triggered the first relay read. It keys on the
  `relay_owner_history` tool row. Nothing here renames that row, so the cut is
  unchanged.
- Round 3 passed. Its note records the operator's 2026-10-12 choice that any
  agent may read group history: for an ordinary agent the forwarding ban is only
  the tool's contract, while the voice applies a programmatic boundary.

Group content may live in two places only: the provider context of this call,
and this call's speech rows (operator and voice speech, and the hand-offs to the
voice). Those already hold it today, and call memory cuts them. It must never
reach a delivery to another agent, a proposal or request row, a tool row's
arguments or result, a browser event, call memory, or the input of a backend
delegation that can send.

## Design A: the narrowed boundary

### Which tools can carry group content out

A tool can carry group content out of the call only if text the model writes into
it reaches something outside the call. The table goes through every tool in
`COMPANION_TOOL_REGISTRY` (`tools.ts:89-188`).

| Tool | Model-written text | Where that text goes | Class after a read |
| --- | --- | --- | --- |
| `request_orchestrator_delegation` | `instruction` (free text), `confirmation_reason`, `asked_again`, `pending_request` (16 chars), `project` | Sent to another agent; stored in the proposal, the request row and the card | **egress: refused in a private context** |
| `resolve_orchestrator_confirmation` | `decision` (`send`/`cancel` only) | Sends a task written before the read; a task written in a private context cannot exist, because its send was refused | local: runs |
| 14 board reads (`READ_TOOL_NAMES`) | `query`, handles, project names, dates | Delegatus's own state, read locally. The result comes back into this call; results can echo the query (`prototypeRead.ts:79-80`) | local: runs, recorded privately |
| `show_orchestrator_message` | `message` handle (40), `project` | The handle selects an orchestrator message; the stored row carries the handle the read returned, never the argument (`admission.ts:647-677`) | local: runs, recorded privately |
| `orchestrator_reports` | none | none | local: runs |
| `reread_orchestrator_report` | `report` handle (16) | Looked up among this call's reports | local: runs, recorded privately |
| `relay_owner_history` | `chat`, dates, cursor | The source itself; its arguments and results are already omitted (`PRIVATE_RESULT_TOOLS`, `tools.ts:190`) | local: runs |
| `end_conversation` | none | none | local: runs (T3) |

The registry gets one explicit attribute: `egress: true` on
`request_orchestrator_delegation`, and `egress: false` on the other tool of class
`delegation`. A test pins the egress set, and requires every tool of class
`delegation` to declare the attribute, so a new send tool cannot ship without a
decision. The `end_conversation` exception is no longer needed, because the tool
is not egress.

A board read cannot bring this call's group content back in: the call's own
speech is not a searchable conversation. The Codex voice thread is ephemeral
(`codexProvider.ts:64`), and the API call's record lives in the companion's
state, which the transcript scanner does not read.

### Where the private context holds

- **API calls: the delegation that read.** It starts at that delegation's first
  successful `relay_owner_history` result and lasts to the end of that
  delegation (today's rule at `:537`). A new API delegation starts with the flag
  off: `:461` stops reading `active.privateHistory`.
- **Codex calls: until the call ends.** The thread keeps the history, so the
  flag set at `:590` and `:594` holds, as today.

The gate in both places becomes `privateContext && EGRESS_TOOLS.has(name)`:

- in the backend loop (`:522-523`), with `privateContext` the delegation's own
  flag;
- in `tool()` (`:566-567`), with
  `privateContext = active.codex ? passedFlag || active.privateHistory === true : passedFlag`.
  The backend loop passes the delegation's flag as `passedFlag` (today it passes
  the blocked result, `:535`), and the Codex attach handler keeps passing its
  turn flag (`:273`).

`active.privateHistory` stays set for the rest of the call on both backends. On
Codex it is the gate. On API it switches on the input cut of Design C.

### Recording in a private context

A local tool that runs in a private context records:

- its name and status, and its code when it failed;
- arguments as `"[arguments omitted: a Telegram group was read in this call]"`;
- a hashed call id, as blocked and private calls get today (`:568-569`);
- a result of `{ status, code }` only.

The `tool.result` event summary becomes a fixed `Done` / `Failed`. The model
still receives the full result. The in-memory read ledger keeps it for this call
and marks the row private (Design C). This is what lets reads run without putting
a query, or a result that echoes it, into the record or the browser. Tools in a
later API delegation record as usual, because their writer never saw the group.

### What the voice says when a send is blocked

The tool row and its events keep the name `private_history_blocked`, with the
speech below as the summary. The live floaters hide calls named after the
delegation tools, because their request card shows them
(`src/components/voiceCompanion/VoiceCompanion.tsx:75-76`, `:610`). A refused
send creates no request, so it needs its own name to stay visible. No component
changes.

**API, in the delegation that read** (239 bytes):

```
status: refused · code: private_history_boundary · sent: false
reason: A Telegram group was read in this turn, so this turn cannot send.
speech: Nothing was sent. This turn read a Telegram group, and nothing from the
group may leave the call, so this turn cannot send. Tell the operator this in one
short sentence, and that they can ask again in their own words to send something new.
```

**Codex, for the rest of the call** (370 bytes):

```
status: refused · code: private_history_boundary · sent: false
reason: A Telegram group was read in this call, so sending is off until the call ends.
speech: Nothing was sent. Sending to orchestrators is off for the rest of this call,
because a Telegram group was read in it and nothing from the group may leave the call.
Reading the board, orchestrator messages and reports still works. Tell the operator
this plainly in one or two short sentences and offer the way out: end this call and
start a new one, which can send again.
```

Both are within the 500-byte limit of one append (`liveSession.ts:111`). No
prompt changes, so no prompt-size bound moves.

- The backend is shown the call under its real name, with arguments `{}`, and
  this result. It can then tell that its send was refused.
- An API delegation **ends at the first `private_history_boundary` refusal**.
  The voice is handed the speech above, so the model is not left to retry a
  refusal it cannot change; the bad call retried two to four times per
  delegation, each retry a paid response.

## Design C: later API delegations never see the group

Once `active.privateHistory` is set on an API call, `delegate()` builds every
later input (`:455-475`) with the group taken out. The cut covers every part of
that input that can hold group content:

- **The voice's replies.** "The conversation so far" (`:455`) keeps the
  operator's segments and withholds every voice segment that received speech
  after the start of the first delegation that read. The cut follows the order
  in which speech arrives at this server, a clock the server owns. The voice can
  speak group content only after the reading delegation's hand-off, which comes
  after that delegation's start on this server. A voice segment absorbs any
  fragment that follows within `DISPLAY_PAUSE_MS` (1.5 s, `liveTranscript.ts:7`,
  `:56`), so a segment that began before the read can carry group speech after
  it. A segment that took any fragment after the start is therefore withheld
  whole.
  Mechanism: `LiveTranscript` counts fragments as they arrive and stores the
  last count each segment received. `delegate()` notes the count at its start,
  and the read that first sets `active.privateHistory` stores it as
  `active.privateFrom`. `record()` takes an optional `withholdCompanionFrom` and
  drops voice segments whose last count is above it.
- **One line takes their place**, outside the 12 000-character slice so it is
  never cut: "The voice's replies since a Telegram group was read in this call are
  withheld from you, and so are the reads made while it was read. If the
  operator asks to send something the voice said since then, ask them to say in
  their own words what to send." (247 bytes.)
- **Reads made in a private context.** "Reads earlier in this call" (`:467`)
  skips ledger rows marked private. `read()` (`:625-651`) takes the private flag
  from `tool()` and stores it on the row.
- **Everything else in the input** was written before the read or by a writer
  that never saw it: the call memory, the project label and directory, the
  requests waiting for a report, and the confirmation waiting for an answer. A
  private context cannot create a proposal, because its send is refused. The
  speaking model passes no text with a delegation; the server reads only its id
  (`:375-394`).

The operator's segments and the operator's latest turn (`:473`) stay. That is
the residual risk named under the decision.

Concurrent delegations stay clean. A delegation builds its input once, at its
start, and later receives only its own tool results. A delegation that started
before another one's read never saw that read.

## Design B: honest delivery

### 1. Every result of a send that did not send says so

In `tool()`, a result from a tool of class `delegation` whose status is not
`sent` gets `sent: false`. Its speech must begin with "Nothing was sent." (or the
existing "Nothing has been sent" / "Nothing new was sent"). Otherwise that
sentence is put in front, and the thrown-error branch (`:605-621`) does the same
for these two tools. Most results already comply (`tools.ts:43-74`, `:137`,
`:146`, `:170`). The ones that do not: the boundary refusal; `"The tool failed:
…"`; `NO_ORCHESTRATOR`; and `nothing_waiting`, which puts it second. Sent results
keep their shape, so existing `toEqual` assertions on them stay green. This is
the whole guarantee on Codex, where the backing turn reads the result and speaks
for itself (below).

### 2. On API calls the server writes the delivery part of the final speech

`delegate()` replaces `completedDelegations` and `refusalReasons`
(`liveSession.ts:457-458`, `:539-544`) with one list of delivery facts. There is
one fact per call of a `delegation`-class tool, taken from its result:

- **S, sent**: status `sent` with delivery `delivered`, `queued` or `unknown`.
  The sentence is the existing wording at `:494-497`, for example "The request
  is queued for the orchestrator."
- **N, nothing sent**: `refused`, `failed`, a sent result whose delivery
  `failed`, `too_long`, `check_waiting`, `nothing_waiting`, and the boundary
  refusal. The sentence is the result's `reason` (the `DELEGATION_REASONS`
  wording already reads as speech), with "Nothing was sent." put in front when
  missing. The boundary refusal uses its whole speech. Three statuses carry no
  `reason`, and their `speech` is written for the backend, so each gets a fixed
  sentence: `too_long` "Nothing was sent: the task was too long. Ask the
  operator to say it more briefly."; `check_waiting` "Nothing was sent yet: a
  similar request already waits for the orchestrator's answer. Ask the operator
  whether this repeats it."; `nothing_waiting` "No confirmation is waiting, so
  nothing was sent."
- **A, waiting for the operator**: `awaiting_confirmation`. The sentence is
  "Nothing has been sent yet: it waits for the operator's yes or no."
- `awaiting_report` and `answered` add no fact. They speak about a request this
  call really sent earlier, and the backend's text and the report read-back say
  where it stands.

One pure function, `delegationSpeech(answer, facts)` in `delegationOutcome.ts`,
builds every hand-off that ends a delegation: the normal answer (`:515`), the
final round and its fallback (`spentRoundSpeech`), the missing-response path
(`:498`) and the boundary end.

- With no facts, the backend's answer goes through as today.
- With any S, the hand-off is the backend's answer, then the S sentences, then
  the sentences for any other fact in the same delegation.
- With no S and a last fact of N, **the hand-off is the server's sentences
  only**. The backend's text is not handed, so no claim it makes can reach the
  voice.
- With no S and a last fact of A, the hand-off is the backend's question, then
  the A sentence.

The facts keep their room within the 500-byte bound: `speakable` gets a byte
limit, and the answer is cut to the bytes left after the facts. A long answer
loses its tail; the delivery state is never cut off. The two existing
missing-response tests (`liveSession.test.ts:570`, `:1299`) expect exactly
today's sentences and stay green.

Cost, named: in a turn that both asks a question and tries to send, if the send
fails, the answer to the question is dropped and the voice says what failed. The
operator can ask again.

### 3. Codex calls

On Codex the backing turn sees the result and speaks for itself. The server
cannot replace that speech, so its guarantee there is the fact in each result
(part 1) plus the explained boundary refusal. A server-voiced correction after a
Codex turn is deferred (below).

### What this does not cover, and why

Claim 1 of the bad call was the speaking model answering a request that was
never delegated. A report arrived while the operator was dictating, and the
request was dropped (#2972). No tool ran, so no result exists for the server to
check. Catching it would mean reading the voice's own speech for claims of
sending in three languages: a word list, which a paraphrase passes. Worse, it
would "correct" true claims. Asked "did you send it?", the voice truthfully
saying it sent something minutes ago would be contradicted, because nothing was
sent since the operator's last turn. The cause, the dropped request, is #2972,
next in the operator's order. Deferred below.

## Shared paths this touches

| Contract | Producers | Consumers checked |
| --- | --- | --- |
| Delivery-tool result (`sent: false`, the speech's first sentence) | `tools.ts` `spoken()`, handlers at `:137`, `:146`, `:170`; `tool()` catch | The replay to the backend (`:545-546`); the Codex tool result (`codexProvider.ts` `codexVoiceToolResult`); the tool row (`:599-601`); the `tool.result` summary (`:602-603`); `triedTool` (`:538`); delivery facts. The UI reads only `status` and `speech` and ignores extra fields. |
| Private-context flag | `:537`, `:589-595` | The API gate (`:522`, now the delegation's flag only), `tool()` (`:566`, per backend), the Codex attach handler (`:273`), the new turn context (`:400-401`), recording (`:568-574`), the read ledger's private mark, and the API input cut (`:455`, `:467`) |
| Transcript record (`LiveTranscript.record()`) | `liveTranscript.ts:102-105`, fed by `fragment()` | Only `delegate()` (`:455`). The arrival count is a new field on the in-memory segment; snapshots, events and the stored record do not carry it. |
| Read ledger row (`active.reads`) | `read()` (`:647`) | "Reads earlier in this call" (`:467`), the repeat cache (`:632-636`). A cache hit returns the stored result and leaves the row's mark as it was; a clean delegation can only hit a private row's key by writing the same arguments. |
| Tool row and events for a blocked or private call | `tool()` | The session route's record read (`src/app/api/voice-companion/session/route.ts:71`); the transcript panel and floaters (`VoiceCompanion.tsx:610`; the name kept for blocked calls); call memory, which reads tool rows as name and status only and keys its cut on relay rows (`callMemory.ts:25-56`) |
| Hand-off text | `say()` (`:689-691`) via `delegationSpeech` | Live `session.commentary.append`; the hand-off row in the record; call memory (speech rows, already cut after a read) |

No hot path, poll or tick changes. The fact list lives in memory for one
delegation and is bounded by its calls (at most `BACKEND_ROUNDS` rounds). The
arrival count is one integer per segment, within the existing 64-segment window.

## Ordered build plan

1. **Classify egress in the registry** (`tools.ts`). Add `egress` to `ToolEntry`
   and export `EGRESS_TOOLS`. Pin it in `tools.test.ts`.
2. **Narrow the boundary** (`liveSession.ts`). Apply the egress-only gate in the
   loop and in `tool()`, with the per-backend private context of Design A.
   Local tools in a private context run with private recording. Use the
   explained refusals; replay the real name; end the API delegation at the
   first boundary refusal. Tests in `ownerHistoryRecording.test.ts`.
3. **State «nothing was sent» in every non-sent result** (`tool()` in
   `liveSession.ts`). Add `sent: false` and the first sentence, the catch branch
   included.
4. **Server-written delivery speech on API calls** (`delegationOutcome.ts`
   gains `deliveryFact` and `delegationSpeech`; `liveSession.ts` gives
   `speakable` a byte limit and routes every closing hand-off of `delegate()`
   through it). Tests in `liveSession.test.ts` and a new
   `delegationOutcome.test.ts`.
5. **Withhold the group from later API delegations** (Design C).
   `liveTranscript.ts` gains the arrival count and the `withholdCompanionFrom`
   option of `record()`; `liveSession.ts` stores `active.privateFrom`, marks
   private ledger rows, stops seeding a new API delegation's flag from
   `active.privateHistory`, and builds the cut input with its one line. Tests in
   `liveTranscript.test.ts` and `ownerHistoryRecording.test.ts`.
6. **Checks** (below), then the publication gate on the changed files.

Steps 2 and 3 can land in one commit. Step 4 depends on step 3's facts. Step 5
must land in the same pull request as step 2: step 2 alone, with the new
per-delegation gate on API, would let a later delegation that still sees the
voice's replies send. The order inside the branch is free as long as the gate
change and the input cut ship together.

## Test plan

All of these run on API and Codex where the behaviour exists on both. "Red on
`main`" means the assertion fails against `18096e8f2`; the probe above shows the
behaviour for the first four.

The privacy tests follow one rule. Where the server rewrites or refuses, the
scripted model is given the sentinel and told to send it, and the test asserts
on what the server passes on. Where the guarantee is that a model never sees
the sentinel (Design C), the test asserts on that model's whole input. The
server cannot rewrite text a model writes from what it was shown, so a later
API backend scripted to write the sentinel would send it, and would prove
nothing about the server.

`ownerHistoryRecording.test.ts` (privacy):

1. **Carrying text out through every tool, table-driven over
   `COMPANION_TOOL_REGISTRY`.** In a private context, call each tool once.
   Every string argument holds the sentinel (cut to its `maxLength`), and enums,
   booleans and integers get valid values. Assert: no sentinel in the `send`
   mock's input, the proposals, the record, the events, `voice-companion.json`
   or the JSONL record. Egress tools answer `private_history_boundary` with
   `sent: false`; local tools run (their read mock is called). On API each egress
   call gets its own delegation that reads first, because a boundary refusal
   ends a delegation and only the reading delegation is private. On Codex the
   later turns are private too. Red on `main`: local tools are refused today.
2. **Reads after a read, in the same private context.** `list_tasks`,
   `orchestrator_reports` and `search_transcripts`, with the sentinel in
   `query`, run; their results reach the backend; the tool rows carry the omitted
   marker and `{ status }` only. Red on `main`.
3. **The refusal explains itself.** `sent: false`, the reason, and the speech
   with the way out, in the API text and the Codex text. The backend replay
   names the real tool; the record keeps `private_history_blocked`; the API
   delegation ends after the first refusal with no further backend response.
   Red on `main`.
4. **Two consecutive turns** (T2). This replaces the API half of today's
   later-turn assertions (`ownerHistoryRecording.test.ts:62-73`), which the
   operator's decision overrules.
   - API: after the reading delegation, script the sentinel into every source
     the server controls: voice transcript deltas after the read, one of them
     merged into a voice segment that began before the delegation (within the
     1.5 s pause); the backend's private answer and so its hand-off; and a
     private read whose `query` holds it. Then a later operator turn and
     delegation. Assert: the later backend input holds none of the sentinels
     (title, text, member, chat), holds the withheld line, and keeps the voice's
     speech from before the read and the operator's later turn. A send the
     script writes there without the sentinel goes out as `sent`. Red on `main`:
     the later send is refused, and the input contains the sentinel through
     "The conversation so far".
   - Codex: the later turn's send stays refused with the Codex text, as today.
5. **A task written before the read, confirmed after it.**
   `resolve_orchestrator_confirmation` `send` delivers exactly the earlier text,
   with no sentinel anywhere. Red on `main`: the resolve is refused today.
6. **Hang-up** (T3), unchanged: explicit end works after a read; unrequested end
   is refused. On API the later delegation is no longer private, so this checks
   that the hang-up rule refuses an unrequested end on its own.

`liveTranscript.test.ts`: `record()` with `withholdCompanionFrom` drops a voice
segment that took a fragment after the mark, drops the straddling segment whole,
and keeps operator segments and voice segments wholly before it. Without the
option, the output is unchanged.

`liveSession.test.ts` (honest delivery, API):

7. **Every send refused, the backend claims delivery.** The scripted backend
   tries a send and then writes "Yes, I passed it to the orchestrator.". Run once
   per refusal kind: gate refusal, `no_orchestrator` (no recipient),
   `PROJECT_REFUSED` (thrown), a sent result whose delivery `failed`, `too_long`
   at the end of the budget, and the boundary refusal. Assert that the closing
   commentary for the delegation contains the server's sentence, begins with
   "Nothing was sent", and contains none of the backend's text. Red on `main`
   (probe rows 2 and 4).
8. **A send succeeds.** The backend writes "Done."; the closing commentary is
   "Done. The request is queued for the orchestrator.", with the `delivered` and
   `unknown` wordings checked the same way. Red on `main` (probe row 3).
9. **The bound.** A 600-byte answer plus a sent fact: the hand-off is at most
   500 bytes and ends with the delivery sentence. Red on `main`.
10. **Confirmation.** An `awaiting_confirmation` outcome hands the backend's
    question followed by "Nothing has been sent yet…". Red on `main`.
11. Unchanged and still green: the missing-response hand-offs (`:570`,
    `:1299`), and the sent-result `toEqual` assertions (`:529`, `:1384`).

`delegationOutcome.test.ts`: the S/N/A rules and the byte reservation as pure
cases. `tools.test.ts`: the egress pin (item 1 of the build plan).
`callMemory.test.ts` and `codexConversation.test.ts` are run unchanged.

The issue suggested `scenarios.ts` for the scripted scenario. That file drives
the simulator used for rendered evidence (`scenarios.ts:6-19`), and the simulator
never runs `CompanionLiveSessions`, so it cannot prove a server property. The
scripted scenarios are items 7 and 8, on `FakeLiveProvider`.

## Checks the build runs

Per `AGENTS.md`, each touched test file runs by path under
`scripts/gate-slot.sh`. Each run gets its own private HOME, `XDG_CONFIG_HOME`,
TMPDIR and `LLV_STATE_DIR`, with `LLV_VIEWER_CONTROL_URL` on a closed port, and
never a sweep of `src/lib/voiceCompanion/`. The files:
`ownerHistoryRecording.test.ts`, `liveSession.test.ts`, `liveTranscript.test.ts`,
`delegationOutcome.test.ts`, `tools.test.ts`, `callMemory.test.ts`,
`codexConversation.test.ts`, `sessionConfig.test.ts`. Then `tsc --noEmit`,
ESLint on the changed files, and `bun run privacy:check`. The required hosted
checks must be green on the pull request. No UI component changes; the only
visible change is the text inside existing tool rows.

## Fences and open work

- **#2971 / PR #2978** changed `src/lib/externalRelay/ownerHistory.ts` and the
  owner-history failure speech; it merged as `a880de287`. Its diff touches no
  file under `src/lib/voiceCompanion/`. This design does not touch
  `ownerHistory.ts` or `ownerHistoryRead.ts`.
- **The seat-routing work** (`docs/design/seat-single-channel.md` on its branch;
  still no code pushed) names `admission.ts:457-511` and `deliveryPaths.ts`.
  Steps 1–5 change neither file.
- No other open pull request touches `src/lib/voiceCompanion/`.
- **#2972** (a report read over dictation) is the cause of claim 1. **#2975**
  (an owner-visible action record) gains, as a side effect, refused sends whose
  rows explain themselves.

## Validation against the requirement

| Requirement | Where it is met |
| --- | --- |
| Group content still cannot leave the call, with a test over each send-capable tool | Egress gate and private recording (Design A); test 1. On API, Design C and test 4 prove the later task writer never sees the group. The operator's spoken words and microphone echo remain, as the operator accepted. |
| A group read no longer disables unrelated actions for the whole call | Reads, reports, message display and confirmations of earlier tasks run (Design A table; tests 2 and 5). On API, sends work again from the next turn (test 4). On Codex, sending stays off until the call ends, with the explanation. |
| Anything blocked is explained plainly with a way out | The refusal speeches: on API, ask again in the operator's own words; on Codex, a new call. The delegation ends at once (test 3). |
| Delivery stated only from a successful send result or a fresh read | Server-written delivery speech on API (B.2); facts in every result (B.1). The speaking model's own unprompted claims are out of reach (see what B does not cover). |
| Every refusal or failure carries «nothing was sent» to speech | B.1 and B.2 (test 7) |
| Every send refused: final speech never claims delivery | Test 7, with a backend scripted to lie |
| A successful send speaks its delivery state | Test 8 |
| Tests red on `main` where behaviour changes | Tests 1–5 and 7–10 |

## Deferred — not currently justified

- **Sending off until the call ends on API calls too** (the first option put to
  the operator). It closes the residual risk of spoken words and echo. The
  operator chose to send from the next turn instead.
- **Every send after a read waiting for a spoken yes** (the third option put to
  the operator). Only the operator's ear would check the text, and it needs an
  unsent, unrecorded pending request in `admission.ts`, which the seat-routing
  work is changing.
- **Closing the echo path** (detecting loudspeaker playback, or refusing sends
  while the voice is speaking). The server cannot tell echoed speech from the
  operator's, and the operator accepted the risk.
- **Carrying sends made after a read into call memory.** The memory cut still
  drops everything after the first read (`callMemory.ts:21-60`), now including
  sends a later API delegation made. The next call does not remember them and so
  cannot claim them; it learns of them from a board read. Keeping them would
  need a second rule inside the privacy cut.
- **Correcting the speaking model's unprompted claims of sending.** It would need
  claim detection over free speech, which a paraphrase passes and which would
  contradict true claims. The observed case comes from #2972.
- **A server-voiced delivery line after each Codex turn.** The result already
  carries the fact. A spoken line after the turn would repeat what an honest turn
  already said, and the configured backend is API.
- **A notice when the group is read** ("sending is now off"). The requirement
  asks for an explanation when something is blocked; the refusal gives it.
- **Gating by content overlap** (allowing a send when none of the read's names,
  titles or phrases appear in it). A paraphrase passes the check unseen.
- **A full ledger of this call's sends in the backend input.** It adds facts the
  model may still ignore; the server-written speech already carries the
  guarantee.
