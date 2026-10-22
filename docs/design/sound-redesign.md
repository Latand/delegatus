# Sound redesign: the sound map

Requirement, 2026-10-21, private operator brief (dictated; paraphrased here because the source is private): audit which events the system has and how often they happen, and give them different sounds. Some sounds play today during orchestrator activity and elsewhere; redo all of it from scratch. The sounds are written as code, programmatically and with care, together with a critique of where they are inserted. The design follows real usage and the real history. Every sound must correctly tell the operator that work is going on. The current typing effect works well and is interesting, so it stays; the rest can go.

This document is acceptance 2 (the sound design) of that lane, with the placement critique of acceptance 3 in its own section. It builds on the event audit in `docs/design/sound-events-audit.md` (acceptance 1); every rate below is quoted from that audit's tables, window W (2026-10-14 17:00 to 2026-10-21 17:00 UTC, 168 hours) unless another window is named. The prototype, the rendered media and the listening form (acceptances 4 and 5) are later stages of this lane, and implementation is a separate lane after the operator's answer.

Code examined: `3e6ca3c16dbd31e7e19b5bc807d8f93b7584cd25` (the pipeline base). Every `file:line` below refers to that revision; each was re-checked one file at a time. `origin/main` has moved four commits since; none of them touches an audio module, a cue call site or `public/audio`. None of the twelve open pull requests touches those files either (`gh pr list` filtered on the file paths, 2026-10-21).

Earlier answers: transcript and memory searches for sound, cue, chime and typing work found the audit stage itself, the original earcon implementation lane and a demo that fetched the cue files. No design doc for the current earcons exists under `docs/design`, and no earlier operator decision about which events are voiced was found. The current code's comments are the only prior rationale, and this design cites them where it keeps or reverses them.

## 1. What the audit tells the design

Two series the audit did not count are added here from a read-only recount (section 10 gives the method): the «Asks you» classifier's inferred asks, and lanes that reached `completed` without a merge. Rates are machine-wide source counts across every project. A browser tab hears only the conversations it has on screen, the project scope its board feed serves and the runtime stream it subscribes to, so every rate here is an upper bound for what one tab could play. The audit says plainly that playback itself was never recorded.

The events fall into four frequency bands, and the band decides the treatment:

| Band | Events (mean/h, busiest hour, max per 10 s) | Treatment |
| --- | --- | --- |
| Continuous, over 100/h | Model tool calls 1,632/h, 3,614, 52; direct Viewer MCP calls 109/h, 1,204, 25; delivery phases up to 91/h; quota probes 289/h (window Q); runtime text chunks about 3,850/h (window R, normalized) | Texture or silence. Only the kept typing effect is allowed here, because it is the one sound already proven to carry dense activity without fatigue. |
| Frequent, 10–100/h | Turn starts and ends (Claude 29/h, Codex 16/h), launches 23/h, stage starts 17/h, stage passes 10/h, seat checks 4–47/h (window C), bridge reports 9/h (window B) | Silent unless the event changes what the operator knows. One quiet event (a stage passing) is voiced, with a coalescing window and a minimum gap. |
| Occasional, 1–10/h | Stage failures 5.2/h, repairs 4.4/h, tasks created 5.2/h, Telegram sends 6.3/h, inferred «asks you» 2.94/h (81% from orchestrator seats), merges 1.6/h, lanes completed without a merge 1.33/h, pipelines created and closed about 4/h | Voiced only for results: a lane landing, merged or completed. Failures that go to a fix stage on their own are routine and stay silent. The inferred ask is prose an agent wrote, mostly at the end of an orchestrator tick; it gets no sound of its own (section 4.1). |
| Rare, under 1/h | Decision forms 0.92/h, stages needing a decision 0.92/h, launch failures 0.95/h, deploys 0.42/h, deploy failures and rollbacks 0.03/h, merge blocks 0.04/h, attention requests 0.13/h, limit exhaustion 0.02/h, voice calls 0.04/h | Distinct, recognizable sounds. These are the events the operator must not miss. |

Three audit findings shape the design more than any single rate:

- **Activity is nearly continuous.** Retained work intervals overlap 158.7 of the 168 hours (94.5%), with up to 26 at once. Any sound tied to "an agent is running" would play all day. The continuous layer therefore has to be sparse by construction and has to scale with the amount of work.
- **One obligation produces several records.** A decision can appear as a form, a parked stage, an attention offer, a bridge report and several Telegram polls. Counting each would multiply one obligation into several sounds. The browser already folds these into one queue (section 4.1), and the design voices that queue.
- **Bursts come from batches.** The largest bursts among rare and occasional events are batch artefacts: 7 stages needing a decision in 10 s, 8 stage failures in 10 s, 3 merges in 10 s, 60 tasks marked Done in 10 s. Coalescing windows are sized to swallow these.

## 2. What plays today, and why most of it goes

The current wiring (audit, "Current audio"; code at the lines below) maps events to six sample files:

| Today | Trigger | Rate it inherits | Problem |
| --- | --- | --- | --- |
| `attention.mp3`, the loudest cue | Any top-level conversation entering pane state `waiting` (`src/hooks/useAgentChimes.ts:13`, `:90`). `paneState` (`src/components/paneState.ts:18`) returns `waiting` for every finished turn of a Claude, Codex or OpenClaw root conversation (`src/hooks/useSwitchboardData.ts:65`), for a rate limit and for a real question | Every root turn end in scope: up to 29 + 16 = 46/h machine-wide on average, including each orchestrator tick (2,729 orchestrator turns in W, 16/h) and each stage agent finishing | Wrong meaning and wrong frequency. The loudest sound fires for orchestrator activity, which is the complaint in the brief. An agent ending a turn by itself does not need the operator. |
| `launch.mp3` | A child first linking into the tree (`src/hooks/useAgentChimes.ts:109`) or this device's own launch (`src/components/DraftAgentPane.tsx:650`) | Generations 21/h, launches 23/h | A parent link resolved late rings for a process that started long ago (audit, row `launch.mp3`). |
| `success.mp3` | A subagent returning (`src/lib/audio/cues.ts:118`), and the master switch preview (`src/components/SoundToggle.tsx:52`) | Every subagent return | A subagent returning is the middle of its parent's work. |
| `failure.mp3` | A pane turning `stalled`, and a failed own launch | Unknown; stalled is a liveness inference | Inferred liveness rings the strongest negative sound. |
| `viewer-mcp.mp3` | Every tool call carrying the Viewer MCP marker (`src/lib/audio/toolCues.ts:35`) | 109/h, 1,204 in its busiest hour, 25 in 10 s | A distinct cue at continuous rates, for orchestration plumbing. |
| `tool-tick-1..8.mp3` | Every newly appended tool call in an on-screen pane (`src/components/LogFeed.tsx:885`, `src/hooks/useToolActivityCues.ts:52`) | Up to 1,632/h | Kept. This is the typing effect. |

Estimated from those rates, today's scheme can produce around 176 distinct cues per hour on average machine-wide (46 attention + 109 Viewer MCP + 21 launch, before success and failure), on top of the typing. The design below brings the event cues to about 15/h on average and 45 in the busiest hour of the voiced sources, replayed under its rules (section 10).

## 3. The sound map

### 3.1 Voiced events

Nine sounds. Each is named for what it tells the operator, so the meaning stays fixed when the source changes.

| # | Sound | Tells the operator | Fires on (source the browser has) | Source rate (mean/h; busiest hour; max/10 s) |
| --- | --- | --- | --- | --- |
| S1 | **Typing** (kept) | An agent on screen is working right now | Each newly appended tool call, ordinary or Viewer MCP, in an on-screen conversation pane | 1,632; 3,614; 52 |
| S2 | **Distant typing** (kept effect, processed) | Agents off screen are working, and roughly how many | Tool items on the runtime stream for live sessions that have no live feed in this tab (no pane whose feed is running: section 4.4) | Same population; played at most one slice per 3–8 s |
| S3 | **Step** | A lane moved forward | A stage attempt settling `passed` in the board's pipelines | 10.1; 30; 3 |
| S4 | **Landed** | A lane finished: merged, or completed with no merge to make | A pipeline's merge reaching `merged`, or the pipeline reaching `completed` with no merge state; never when the merge is `blocked` or `cancelled` | Merges 1.61 + completions without a merge 1.33 = 2.94; 10; 3 |
| S5 | **Released** | A new Delegatus version is serving | A deploy item with phase `succeeded` in the «Готово» feed | 0.42; 2; 1 |
| S6 | **Your move** | Something is waiting for the operator's answer | A new entry in the needs-you queue that carries a structured question: a seat's bridge ask, a pending question or plan, a permission or terminal-input request, a lane needing a decision or review, a prototype or decision form, an update decision; plus attention requests. The inferred «asks you» reason is excluded (section 4.1) | Forms 0.92 + parked stages 0.92 + requests 0.13 + bridge asks 0.13 (window B) = about 2.1; 17; 7. After the obligation key, 1.89/h plays (section 10) |
| S7 | **Fault** | Something broke and needs a look | A new needs-you entry of kind stuck delivery, failed launch or memory kill; a pipeline merge reaching `blocked`; a deploy item with phase `failed` or `rolled-back`; a limit episode item | Launch failures 0.97 + merge blocks 0.04 + deploy failures 0.03 + limits 0.02, about 1.05; 12; 3 |
| S8 | **Reply** | The conversation this device just wrote to has answered | The turn that carries this device's message (or this device's launch prompt) ending `completed` (section 4.4) | Bounded by the operator's own sends and launches |
| S9 | **Launched** | The launch this device asked for was accepted | The launch receipt in the new-agent card | Bounded by the operator's own launches |

Three small sounds keep their current triggers and move into the same synthesis module and palette: the voice-call connect and disconnect pair (`src/lib/voiceCompanion/cues.ts:64`, called at `src/lib/voiceCompanion/liveAdapter.ts:127` and `:297`; 7 calls in W), and the dictation near-cap ping and auto-stop (`src/hooks/useDictation.ts:596` and `:243`). The master switch preview plays S3.

### 3.2 Silent events, with the reason

| Event family (audit rate) | Why silent |
| --- | --- |
| Turn starts and ends of agents the operator did not write to (46/h) | Covered by S1/S2 while running; a turn ending is no news unless the operator is waiting for it (S8). |
| Inferred «asks you» (reason `ask`, 2.94/h, 400 of 494 from orchestrator seats, 14 in the busiest hour) | An inference from the agent's own prose, which the product itself ranks below every structured signal (`src/components/attention.ts:377`). Each orchestrator tick ending in a question mints a new ask id with no task id, so no key merges them: voiced as S6 it would bring the loudest sound back to orchestrator activity, which is the complaint in the brief. The badge still counts it. When the asking conversation is one this device wrote to or launched, S8 already sounds for that same turn. The listening form offers voicing it as S6 as an unticked option. |
| A turn that ends `interrupted` or `error` in a conversation the operator wrote to | The interrupt the default send causes is the operator's own act (section 4.4); an error shows in the pane. |
| A lane completing with its merge `cancelled` (3 in W) | Someone cancelled it on purpose. |
| Orchestrator seat checks, wakes, refusals and errors (4–47/h, window C) | Controller bookkeeping. A seat that needs the operator raises a bridge ask, which reaches S6 through the needs-you queue. |
| Stage starts (17/h) and repair starts after a fail edge (4.4/h) | S2 already says work is happening; a start is no result. |
| Stage failures that follow a fail edge (5.2/h, 8 in 10 s) | Review findings going to a fixer are the normal loop. A failure with nowhere to go becomes a needs-decision or a blocked lane, which S6 or S7 voices. |
| Stage report submissions (pass 10.6/h, fail 4.0/h) | A report precedes the settlement the board shows; S3 voices the settlement. |
| Launch admissions and generations from agents (23/h, 21/h) | An agent starting a child is part of its work. Only this device's own launch gets S9. |
| Subagent returns, panes inferred stalled | Mid-work, and an inference. Real failures arrive as needs-you entries. |
| Delivery phases, echoes and settlements (up to 91/h) | Transport. A delivery stuck for half an hour becomes a needs-you entry of kind `delivery` (S7). |
| Quota probes (289/h, window Q), limit snapshots | Polling. Exhaustion becomes a limit episode (S7). |
| Telegram sends and polls (6.3/h), external relays (1.3/h, window X) | The phone already notifies through Telegram; a second sound on the desk duplicates it. |
| Bridge reports: completed and status (6/h and 2.9/h, window B) | The seat's narration; the results it reports (lanes landing, decisions) have their own sounds. |
| Pipelines created (4.0/h) and closed (3.8/h) | Creation is the operator's or seat's own act; closing follows a landing that S4 already voiced. |
| Tasks created (5.2/h) and moved to Done (4.8/h, 60 in 10 s) | Board bookkeeping; bulk moves would burst. |
| Builds, applies and intermediate deploy phases | S5 voices the outcome that matters. |
| Permission denials (0.10/h), provider recovery waits | Policy and retry records. A recovery that parks surfaces as a needs-you lane (S6). |
| Voice transcript, response and playback events | The call is already audio; cues over speech would talk over the companion. |
| Board maintenance runs (0.2/h) | Housekeeping. |

## 4. Where each sound comes from

### 4.1 S6 and S7 read the needs-you queue

The Viewer already builds one queue of everything waiting for the operator: `buildNeedsYouQueue` (`src/components/attention/attentionQueue.ts:61`), computed at `src/components/Viewer.tsx:1070`. The header count, the panel, the phone badge and the tab title (`src/components/Viewer.tsx:1128`) read it. Each entry carries a stable id, and the conversation entries carry a typed reason from `attentionReason` (`src/components/attention.ts:260`): `decision`, `question`, `plan`, `permission`, `delivery`, `launch`, `memory` or `ask`. Pipeline rows, prototype and decision forms and the update decision are their own entry kinds. Dismissed and routed reasons are already excluded (`reasonAsksOperator`).

Voicing this queue gives S6 and S7 the product's own definition of "needs you", with the product's own deduplication. A sound and the badge can no longer disagree. Entries map as:

- S6 Your move: reasons `decision` (a seat's bridge ask), `question`, `plan`, `permission`; entry kinds `pipeline`, `prototype`, `update`.
- S7 Fault: reasons `delivery`, `launch`, `memory`.
- No sound: reason `ask`. It is the «Asks you» classifier's inference from the agent's prose (`openOperatorAsk`, `src/components/attention.ts:166`, ranked last at `:377`), enabled on this machine. Over W it produced 494 asks (2.94/h), 400 of them (81%) from orchestrator seats, 14 in its busiest hour and 10 in 2026-10-15 14:00. Voiced as S6 it would raise S6 from 1.89 to 4.83 plays per hour and make the inferred ask more than half of all S6 plays, most of them orchestrator ticks. The structured ways a seat or a stage asks (a bridge ask, a parked lane, a form) stay voiced, and a conversation the operator is waiting on answers with S8 whether or not it ends in a question.

**Obligation key.** One decision can still enter the queue twice in different polls: a lane parks (pipeline row) and a minute later the seat raises a form for the same task (prototype entry). The planner maps each entry to an obligation key, the task id when the entry has one (`notice.taskId`, the pipeline's task), else the entry id. A key that already sounded in the last 10 minutes stays silent.

**The clock of an entry.** The staleness rule (6.1) reads each entry's own time of asking, never its first sighting and never `since`: a conversation entry uses `reason.raisedAt` (`src/components/attention.ts`, set per reason; a stuck delivery's `since` is its admission, and it raises half an hour later at `raisedAt`, `:344`–`:351`); a pipeline row uses `now − row.seconds` (seconds since the lane stopped and asked, `src/components/mobile/mobileBoardModel.ts:262`; when `seconds` is null, the first sighting); a prototype entry uses `notice.createdAt`; the update decision uses `decision.at` (`src/lib/selfUpdate/auto.ts:69`).

### 4.2 S3 and S4 read the board's pipelines

`useFiles` delivers the scope's pipelines (`src/components/Viewer.tsx:270`), including on a hidden desktop tab at the 30-second cadence (`src/hooks/useFiles.ts:44`). A pure planner beside the agent-chime planner diffs them:

- S3 on an attempt (`pipelineId:stageId:n`) entering `passed` (`PipelineAttemptState`, `src/lib/pipelines/types.ts:164`).
- S4 on `merge.state` entering `merged` (`src/lib/pipelines/types.ts:1216`), or the pipeline state entering `completed` while it has no merge state, keyed by pipeline id so a merged lane that then completes sounds once. A lane completing with merge state `blocked` or `cancelled` never plays S4 (5 such completions in W would otherwise have sounded «Landed»).
- S7 on `merge.state` entering `blocked` (7 in W), keyed `merge-blocked:<pipeline id>`: the change did not land and someone has to look. `cancelled` stays silent.

### 4.3 S5 and the deploy and limit faults read the «Готово» feed

`useDoneItems` (`src/components/attention/doneItems.ts:105`, read at `src/components/Viewer.tsx:1075`) returns deterministic items of kind `pr`, `pipeline`, `task`, `deploy`, `report` and `limit` (`src/lib/done/types.ts:8`). Deploy items carry the terminal phase. This feed covers both deployment backends; the audit found the runtime-host deployment table empty on this installation, so the runtime stream's `deployment.state` (`src/components/runtime/runtimeModel.ts:800`) cannot be the only source.

A deploy restarts the server, not the open page: a new release raises a manual reload banner (`src/components/Viewer.tsx`, `reloadTo`) and nothing reloads the tab. The item therefore arrives in an ordinary poll of the open tab, and since a hidden desktop tab has to hear it too, `useDoneItems` keeps its 30-second read in a hidden desktop tab and suspends it only where `hiddenTrafficSuspended()` is true (a hidden phone), the way the board feed does (#1994). Without that a hidden tab would read nothing until the operator returned, when the deploy item is already past the 5 minutes and the limit item past the 2 minutes of the staleness rule. A page opened or reloaded after a deploy still meets the item in its baseline read. Two rules make that case sound once: an item whose own `at` is less than 5 minutes old sounds even on a baseline read, and every key that sounded is remembered in `sessionStorage` (bounded to 256 keys) so a second reload stays silent.

### 4.4 S2 and S8 read the runtime stream

The tab-wide runtime bus (`src/hooks/runtimeBus.ts:567`) carries every structured session's `item` (`src/components/runtime/runtimeModel.ts:619`) and `turn-ended` (`:710`) events, and keeps streaming in a hidden desktop tab (`src/lib/client/hiddenTraffic.ts:31`). Its subscribers receive store snapshots without event detail, and `updateSession` replaces only the changed session object, so the cue watcher compares session objects by identity and examines only the sessions that changed. Work per notification scales with what changed, and the bus already batches notifications to one per frame.

- S2: a tool item id not seen before, in a session whose conversation has **no live feed** in this tab. A live feed is a mounted `LogFeed` whose `paused` prop is false, and only a live feed can play S1: the cue scanner runs on the feed's own parse (`src/components/LogFeed.tsx:885`), and a paused feed stops polling and parsing. A board pane pauses its feed when it is dormant or when its IntersectionObserver reports it off screen (`offscreen`, rootMargin 256 px, `src/components/BranchPane.tsx:269`–`:284`). Pane registration is the wrong test: `registerPane` (`src/lib/chime.ts:45`) is called by every mounted, non-expanded board pane whether or not it is visible (`src/components/BranchPane.tsx:288`–`:291`), and the board can hold dozens of mounted panes of which a handful fit on screen. So `LogFeed` registers its conversation in a new live-feed set (`registerLiveFeed(conversationId)` in `src/lib/chime.ts`, a reference count, so the board pane, the expanded overlay and the phone sheet all count) while `!paused`, keyed by `file.conversationId`, which is the runtime session's id; `conversationIdentity` falls back to the path (`src/lib/accounts/identity.ts:53`), and a path-only card has no runtime session. Every live session is then exactly one of S1 (live feed) or S2 (none), and scrolling moves it from one to the other. The 256 px margin means a pane just beyond the edge already counts as live; that is the margin the feed itself uses.
- S1 on resume: when a paused feed resumes, its scanner re-baselines silently on the first parse after the pause. Today it would ring every call appended while paused (the floor is the pre-pause window end, `src/lib/audio/toolCues.ts:78`–`:84`), as a burst of staggered ticks, for calls S2 already voiced.
- S8: the end of the turn that carries this tab's message. When `sendRuntimeMessage` (`src/hooks/useRuntime.ts:347`) is called, the watcher records a pending entry for the conversation holding the session's `activeTurnId` and `settledTurnId` at that moment; an accepted send commits it, a refused one removes it. The ordinary composer send uses policy `interrupt-active` (`src/hooks/useRuntime.ts:354`, asserted in `src/components/TmuxComposer.nativeQueue.dom.test.tsx:296`), so a message sent to a running turn first ends that turn as interrupted and the answer comes in a new turn. The entry therefore plays S8 only when the session's `settledTurnId` becomes a turn id other than both recorded ids and the turn ended with outcome `completed`. The one exception is a send under `steer-if-active`, which the host may fold into the running turn: for that policy, which the caller chose and therefore knows, the recorded active turn ending `completed` also qualifies. An `interrupted` end of a later turn keeps the entry (a second send, or the operator's own stop); `error` removes it silently. The session store keeps no outcome today (`src/components/runtime/runtimeModel.ts:710`–`:724` sets only `turn`, `activeTurnId` and `settledTurnId`), so the `turn-ended` case also stores `lastTurnOutcome` from `p.outcome` (`completed`, `interrupted` or `error`, `src/lib/runtime/consumers.ts:22`). Comparing settled ids rather than waiting for a `running` snapshot also covers a turn that starts and ends inside one batched notification. The new-agent card adds its conversation the same way when the launch receipt names one (`json.conversationId`, `src/components/DraftAgentPane.tsx:656`), so the operator's own launch answers with S8 when its first turn completes. The set holds at most 64 conversations and forgets entries after 2 hours. The audit shows the interrupt case is routine: 880 «waiting for the current turn» phase records in W.

`item` events reach the tab for every session: the stream route forwards the host's events with no session or kind filter (`src/app/api/runtime/stream/route.ts:25`), and a hidden desktop tab keeps streaming (the runtime bus suspends only on phone-class devices). No test asserts it yet, so the implementation adds one; if a later change filters the stream, S2 falls back to `turn-started` and `turn-ended` alone, ticking per running turn.

### 4.5 S1 and S9 keep their call sites

S1 stays where it is (`src/components/LogFeed.tsx:885` → `src/hooks/useToolActivityCues.ts:52`), with `cueFor` (`src/lib/audio/toolCues.ts:35`) returning typing for every call. S9 stays in the new-agent card (`src/components/DraftAgentPane.tsx:650`) for the `launched` outcome only; the failed outcome is voiced by the queue's `launch` reason (section 7, row 7).

## 5. Sound specifications

Every new sound is synthesized with Web Audio: oscillators, gain envelopes, biquad filters and one shared noise buffer. No new file ships. The kept typing effect is the one exception, explained in 5.4.

### 5.1 The synthesis engine

One module, `src/lib/audio/synth.ts`, renders a sound spec onto the tab's shared `AudioContext` (`src/lib/chime.ts`, `sharedAudioContext`). Specs are data; the renderer is about forty lines.

```ts
export type SoundId =
  | "step" | "landed" | "released" | "your-move" | "fault" | "reply" | "launched"
  | "voice-connect" | "voice-disconnect" | "dict-warn" | "dict-stop";

/** One resonant mode of the struck body. `decayScale` shortens upper modes. */
export interface Mode { ratio: number; gain: number; decayScale: number }

export interface Timbre {
  wave: OscillatorType;            // "sine" | "triangle"
  modes: readonly Mode[];
  attack: number;                  // seconds, linear ramp from 0
  detuneCents?: number;            // > 0: each mode is a pair at ±detune, levels 0.6 and 0.4 (slow, shallow beating)
  mallet?: { bandHz: number; q: number; gain: number; length: number }; // noise strike
  lowpass: { hz: number; q: number };
}

export interface Strike {
  at: number;                      // seconds after the sound starts
  hz: number;
  vel: number;                     // 0..1, multiplies every mode gain
  decay: number;                   // seconds to -60 dB
  glideFrom?: number;              // start pitch, exponential glide to hz
  glideTime?: number;
  wave?: OscillatorType;           // per-strike override (a low swell)
  attack?: number;                 // per-strike override
  vibrato?: { hz: number; cents: number };
}

export interface SoundSpec {
  strikes: readonly Strike[];
  loudness: number;                // LUFS, momentary maximum at cue volume 1.0; sets the gain (6.3)
  length: number;                  // seconds until every node has stopped
}
```

Rendering one strike, for each mode (and each detuned twin):

```ts
const t = start + strike.at;
const osc = ctx.createOscillator();
osc.type = strike.wave ?? timbre.wave;
osc.frequency.setValueAtTime(strike.glideFrom ?? strike.hz * mode.ratio, t);
if (strike.glideFrom) osc.frequency.exponentialRampToValueAtTime(strike.hz * mode.ratio, t + strike.glideTime!);
if (twin) osc.detune.value = twin * timbre.detuneCents!;   // twin −1 at level × 0.6, twin +1 at level × 0.4
const env = ctx.createGain();
const level = strike.vel * mode.gain;
const attack = strike.attack ?? timbre.attack;
const decay = strike.decay * mode.decayScale;
env.gain.setValueAtTime(0, t);
env.gain.linearRampToValueAtTime(level, t + attack);
env.gain.setTargetAtTime(0, t + attack, decay / 6.91);   // e^(-6.91) = -60 dB at `decay`
osc.connect(env).connect(soundLowpass);
osc.start(t);
osc.stop(t + attack + decay + 0.05);
```

A mallet adds a slice of the shared one-second white-noise buffer through a band-pass (`bandHz`, `q`) with a 1 ms attack and `setTargetAtTime(0, t, length / 6.91)`. Vibrato is one LFO oscillator into `osc.detune` with gain `cents`. Each sound then runs `soundLowpass → soundGain(gain × cueVolume) → StereoPanner(pan) → event bus`, where `gain` comes from the sound's measured loudness (6.3), never from its strikes' levels: a struck sound's loudness is what its overlapping tails add up to, which no single strike shows, and the first prototype, levelled by per-strike peak, put S5 above S6 and S4 above S7.

The graph has two buses: an event bus and a typing bus, both into one master gain and a limiter (`DynamicsCompressorNode`: threshold −10 dB, knee 0, ratio 20, attack 3 ms, release 150 ms) before the destination. The limiter only catches overlaps; at the default cue volume no single sound reaches it (measured: the loudest single sound, S6 in palette 2, peaks at −11.6 dBFS). Two properties of the Web Audio compressor the implementation has to handle. It adds its own makeup gain, `(1 / its gain at 0 dBFS)^0.6`, +5.7 dB at these settings, so a `Gain` of −5.7 dB follows it and the chain is unity below the threshold; without that every layer plays 5.7 dB louder than its table value, which is how the first prototype's renders came out. And it starts from a low-gain state that takes about 100 ms to settle, so the first sound on a new graph is scheduled no earlier than 150 ms after the graph is made (measured: S3 started at once came out 5 dB quiet, at 50 ms 1.4 dB quiet).

### 5.2 Two timbres, one set of gestures

The gestures (note count, contour, timing) carry the meaning and are shared. Two timbres are proposed so the operator can choose by ear; the listening form shows one variant per palette.

| Palette | Timbre | Register |
| --- | --- | --- |
| **1. Скло (glass)** (recommended) | `wave: "sine"`, modes `[{ratio 1, gain 1, decayScale 1}, {ratio 2, gain 0.12, decayScale 0.6}, {ratio 3, gain 0.04, decayScale 0.35}]`, `attack: 0.006`, `lowpass: { hz: 5000, q: 0.5 }`, no mallet | Pitches as listed in 5.3 (D5–F♯6) |
| **2. Дерево (wood)** | `wave: "sine"`, modes `[{1, 1, 1}, {3.93, 0.22, 0.3}, {9.2, 0.05, 0.12}]` (the marimba bar's mode ratios), `attack: 0.002`, `mallet: { bandHz: 2500, q: 1.5, gain: 0.18, length: 0.012 }`, `lowpass: { hz: 4200, q: 0.5 }` | Every `hz` and `glideFrom` × 0.5 (one octave down), every `decay` × 0.7 |

Recommendation: palette 1. The typing effect is broadband noise concentrated between 1 and 5.5 kHz (measured in 5.4). Pure tonal sines sit apart from it, so an event sound stays legible over dense typing; the wood palette's mallet strike is itself a short noise click, which is closer to a keystroke. Wood is warmer and lower, and some listeners find it less fatiguing, which is the reason to hear both.

Every new pitch is in D major (D, E, F♯, A, B), so overlapping sounds never clash. The dictation cues keep their current pitches (C5 and E4 in dict-stop), which lie outside the key; they play only while the operator dictates, so they rarely overlap anything.

### 5.3 The sounds

Values for palette 1. `loudness` is the momentary maximum in LUFS at cue volume 1.0 (6.3); the default cue volume stays 0.4 (`src/lib/audio/prefs.ts:47`), 8 dB lower.

| Sound | Gesture | Strikes (`at` s, `hz`, `vel`, `decay` s, extras) | loudness | length |
| --- | --- | --- | ---: | ---: |
| S6 your-move | A call repeated: a rising fourth, a pause, the same fourth again with the top held, as a knock at the door is repeated | (0, 739.99 F♯5, .7, .35); (0.12, 987.77 B5, .9, .5); (0.40, 739.99 F♯5, .7, .35); (0.52, 987.77 B5, 1, 1.0) | −14 | 1.6 |
| S7 fault | Three notes falling, slowly beating, over a low drop | Timbre override `detuneCents: 2.5` (the twins beat at 1.7 Hz on D5, 0.85 Hz in palette 2; at 8 cents they beat at 5.5–8 Hz and swung 24 dB, a wobble). (0, 880 A5, .85, .5); (0.14, 698.46 F5, .85, .5); (0.28, 587.33 D5, 1, 1.1); thud (0, 146.83 D3, .6, .3, `wave: "triangle"`, `glideFrom: 196`, `glideTime: .12`). Sound lowpass 3200 Hz | −16 | 1.3 |
| S8 reply | Two notes falling a fourth: the familiar "message arrived", above and slower than the call-ended pair | (0, 1318.51 E6, .8, .5); (0.16, 987.77 B5, .7, .9) | −20 | 1.0 |
| S4 landed | Quick major arpeggio up, the top note shimmering | (0, 587.33, .6, .6); (0.07, 739.99 F♯5, .65, .6); (0.14, 880, .7, .6); (0.21, 1174.66, .9, 1.6, `vibrato: {hz 5, cents 6}`). For a coalesced batch of n lanes add `min(n−1, 3)` grace strikes (0.40 + 0.09k, 1318.51 E6, .3, .4) | −18 | 1.8 |
| S5 released | The landed arpeggio over a low swell, ending higher | S4's four strikes; swell (0, 293.66 D4, .5, 2.0, `wave: "triangle"`, `attack: .25`); top (0.42, 1479.98 F♯6, .5, 1.4) | −18 | 2.2 |
| S3 step | One short note | (0, 880 A5, .7, .45), first two modes only, sound lowpass 6000 Hz | −23 | 0.5 |
| S9 launched | A quick upward glide and a light answer | (0, 880, .6, .25, `glideFrom: 440`, `glideTime: .09`); (0.08, 1318.51 E6, .4, .35) | −23 | 0.45 |
| voice-connect / voice-disconnect | Two short notes up / down, as today | (0, 880, 1, .12); (0.09, 1174.66, 1, .12); reversed for disconnect | 0.05 (unchanged, `src/lib/voiceCompanion/cues.ts:11`) | 0.25 |
| dict-warn / dict-stop | Two quick pings / a low fall, pitches unchanged from `src/lib/chime.ts:118`. Warn was one ping, the same gesture as S3, which can play while the operator dictates | warn (0, 660 E5, .8, .2), (0.11, 660 E5, .8, .32); stop (0, 523.25 C5, 1, .3), (0.17, 329.63 E4, 1, .62) | 0.07 (unchanged, `src/lib/chime.ts:155`) | 0.8 |

The contours are what tells the sounds apart, and they stay distinct at any volume. Four sounds rise (S4, S5, S6, S9), so for those the top note, the time it arrives and the rhythm have to differ as well; this matters most for listeners with weak pitch discrimination, who hear rhythm before pitch. The rule covers every sound that can play in the same minute, the small ones included: no two share direction, the same number of notes and onset spacing within 50 ms while also landing on the same pitches, and two one-note sounds must differ in note count or rhythm, since a single note has only its height to tell it apart. The prototype checks this rule on the sound table (its «Rules check» list), and it caught two collisions in the first version: S8 and the call-ended pair were both D6 then A5, and dict-warn and S3 were both one short sine ping.

| Sound | Direction | Top note, onset | Rhythm |
| --- | --- | --- | --- |
| S6 your-move | Rising, twice | B5 at 0.12 s, again held at 0.52 s | Two pairs with a 0.28 s gap: the only sound that repeats a figure |
| S4 landed | Rising | D6 at 0.21 s (a batch adds E6 grace notes from 0.40 s) | Four even notes 70 ms apart, the last shimmering |
| S5 released | Rising | F♯6 at 0.42 s | S4's run over a slow low swell, then a higher note |
| S9 launched | Rising glide | E6 at 0.08 s | One glide and one light answer, under half a second |
| S7 fault | Falling | A5 at 0 s | Three notes 140 ms apart, slowly beating, over a low drop |
| S8 reply | Falling a fourth | E6 at 0 s | Two notes 160 ms apart |
| S3 step | One note | A5 at 0 s | One |
| V+ call connected | Rising a fourth | D6 at 0.09 s | Two short notes 90 ms apart |
| V− call ended | Falling a fourth | D6 at 0 s | Two short notes 90 ms apart (S8 is 70 ms slower and a tone higher) |
| D! dictation near the cap | Repeated | E5 at 0 s | Two pings 110 ms apart |
| D■ dictation stopped | Falling a sixth | C5 at 0 s | Two notes 170 ms apart, an octave under S8 |

S6 also differs in register: it is the only rising sound that stops below D6, so it never shares the top note of a result sound. The two loudest sounds are the two that need the operator. The prototype plays S4, S5, S6 and S9 back to back so the operator can judge the difference by ear.

### 5.4 The kept typing effect (S1)

The typing effect is the eight slices `public/audio/cues/tool-tick-1.mp3` … `tool-tick-8.mp3` of one master take, one drawn at random per tool call (`src/lib/audio/cues.ts:50`). Measured from the shipped files (ffmpeg decode to mono 44.1 kHz in stage scratch, a 5 ms RMS envelope, onset at 25% of the slice peak):

| Property | Measured |
| --- | --- |
| Slice length | 0.653 s each, 44.1 kHz stereo, 320 kb/s |
| Mean / max level | −32.3 to −35.3 dB mean, −4.3 to −11.8 dB max |
| Keystrokes per slice | 3 to 9 |
| Interval between keystrokes | 15 to 225 ms, mostly 50–125 ms |
| Keystroke decay to −20 dB | 5 to 40 ms, mostly 15–25 ms |
| Spectral centroid of the loudest 20 ms | about 3.0 to 5.5 kHz; strongest bands between 0.9 and 8.3 kHz |

S1 keeps the files byte for byte, the random slice choice, the routine gain of 0.5 (`src/lib/audio/cues.ts:67`), the 220 ms stagger for calls found in one parse (`src/lib/audio/toolCues.ts:72`) and the baseline rules of the scanner. What changes: Viewer MCP calls use it too; it gets its own pool of three voices on the typing bus, so it neither blocks nor is displaced by event sounds; and it ducks under event sounds (section 6.4).

**The one sample file kept, and the replica offered.** The pinned specification asks that every sound be generated by code, and the operator asked to keep this effect. The operator's words decide: the eight files stay. A synthesized replica, specified from the measurements above, is offered as a listening variant, and if the operator prefers it, Delegatus ships no sample files at all:

```ts
/** One tool call's burst of keystrokes; parameters from the measured slices. */
function typingBurst(rand: () => number): Keystroke[] {
  const strokes: Keystroke[] = [];
  const count = 3 + Math.floor(rand() * 7);                 // 3..9
  let at = 0.02 + rand() * 0.12;
  for (let i = 0; i < count && at < 0.62; i++) {
    const space = rand() < 0.15;
    strokes.push({
      at,
      bandHz: space ? 1100 : 2200 + rand() * 2300,          // centroid 3–5.5 kHz overall
      q: space ? 1.2 : 2 + rand() * 2,
      clickDecay: space ? 0.035 : 0.012 + rand() * 0.012,   // to -60 dB; about 15–25 ms to -20 dB
      bodyHz: 180 + rand() * 80,                            // the key bottoming out
      bodyGain: 0.25,
      gainDb: -4 * rand(),                                  // stroke-to-stroke variation
    });
    at += 0.05 + rand() * 0.075;                            // 50–125 ms between keys
  }
  return strokes;
}
```

Each keystroke is a 3 ms noise burst through its band-pass with `setTargetAtTime(0, t, clickDecay / 6.91)`, plus a sine at `bodyHz` decaying over 12 ms at `bodyGain`, summed into the typing bus at the slices' measured level (peak about −10 dB re full scale at gain 0.5 × cue volume).

### 5.5 Distant typing (S2)

S2 reuses the S1 slices (or the replica) processed so it sounds like typing in the next room: `BufferSource(playbackRate 0.92) → BiquadFilter(lowpass, 1400 Hz, Q 0.7) → Gain(S1 gain × 0.2 × 10^(5.5/20)) → StereoPanner(random −0.3…0.3) → typing bus`. One voice at a time. The 0.2 is the intended −14 dB; the lowpass alone takes about 5.5 LU out of slices centred at 3–5.5 kHz, so without the extra 5.5 dB S2 measured 19–21 LU under S1 and was close to inaudible. With it, S2's momentary maximum sits 12.6–15.1 LU under S1's (measured over one, four and seven agents off screen).

Rate: at most one slice every `clamp(8 / √n, 3, 8)` seconds, where n is the number of sessions with a running turn and no on-screen pane. One agent off screen murmurs every 8 s, four every 4 s, seven or more every 3 s, which caps the duty at about 22% at the audit's peak of 26 concurrent intervals. S2 is skipped when S1 played within the last second, since the near layer already says the same thing.

## 6. Timing rules

### 6.1 Rate limits and coalescing

A sound plays only for an event the tab observed after its baseline, and only if the event's own time is less than 2 minutes old (5 minutes for deploy items, section 4.3). Older events are absorbed silently: a sound that arrives after the thing has been on screen for minutes is noise. The event's own time is, per source: for a needs-you entry, the clock named in 4.1 (`reason.raisedAt` for a conversation entry, never `since`, so a delivery stuck since its admission sounds when it crosses the half hour); for a stage pass, the attempt's `completedAt`; for a merge, `merge.mergedAt` or `merge.blockedAt`; for a completion, the pipeline's `closedAt`; for a done item, its `at`. S1, S2, S8 and S9 are observed live and carry no staleness test.

| Sound | Identity | Coalescing window | Minimum gap after the last play | Cap |
| --- | --- | --- | --- | --- |
| S6 your-move | Obligation key (4.1) | 3 s: a burst of entries is one sound | 5 s; entries arriving inside the gap produce at most one more play at its end | 6 per minute |
| S7 fault | Entry id, done-item key or `merge-blocked:<pipeline id>` | 3 s | 10 s; entries inside the gap produce at most one more play at its end | 3 per minute |
| S8 reply | Conversation and turn | 1.5 s | — | — |
| S5 released | Deployment id | — | — | — |
| S4 landed | Pipeline id | 5 s; n lanes in the window add grace notes | 8 s; lanes inside the gap produce at most one more play at its end | — |
| S3 step | Pipeline, stage and attempt | 2 s | 6 s | 6 per minute; dropped when S4 for the same pipeline is already in the gate (or left it within the previous 10 s) when the step leaves the gate |
| S9 launched | Launch receipt id | — | 1 s | — |
| S1 typing | Conversation and engine call id (unchanged) | — | 220 ms stagger per parse (unchanged) | 3 voices |
| S2 distant typing | Session and item id | — | `clamp(8/√n, 3, 8)` s | 1 voice |

All windows and gaps are kept by the one tab-wide player (`src/lib/audio/cuePlayer.ts:132`), which already owns identity deduplication (2,048 identities) and spends an identity before checking mute or transport, so a muted event never sounds later.

### 6.2 Priority when several fire at once

Event sounds play on one lane. Order, highest first:

1. S6 your-move
2. S7 fault
3. S8 reply
4. S5 released
5. S4 landed
6. S9 launched
7. S3 step

A higher sound arriving while a lower one plays cuts it with a 40 ms fade and starts at once. An equal or lower sound arriving while another plays waits in the lane's queue, except S3 and S9, which are dropped: they are the frequent or self-caused ones, and a step a few seconds late says nothing. The queue holds at most one pending play per class (a second request of the same class merges into it, and for S4 adds a grace note). When the playing sound ends, the highest queued class starts 150 ms later. A sound cut by a higher one goes back into the queue once and replays in full afterwards; S3 cut is gone. A queued play older than 15 s is dropped; the longest drain the queue can hold is five sounds of at most 2.2 s each, about 12 s, so only repeated cuts reach that bound. Muting, the master switch or a voice call connecting empties the queue.

So an S7 fault arriving during S6 (1.6 s) plays right after it, and an S5 release arriving during S4 plays after the landing. The audit's provider-incident hour, 2026-10-20 12:00, had 15 lanes parked for a decision (7 within 10 s, the same burst as the provider recovery parks) and 8 launch failures, one of them within 10 s of a park; that S7 is now heard after the S6. Replayed over W (section 10), the lane drops only three S3 plays and never drops a rarer sound. Typing never competes for the event lane.

### 6.3 Levels

Each event sound is levelled by its measured loudness. The engine renders every sound once per palette at gain 1 (offline, about a second in all, no user gesture needed), measures its momentary maximum (EBU R 128: K-weighted, 400 ms windows every 100 ms) and sets `gain = 10^((loudness − measured) / 20)`. So the order below holds in both palettes whatever the strikes add up to. The targets keep today's scale: today's attention cue reaches −13.1 LUFS at cue volume 1.0, failure −17.5, success −22.6 and a typing slice −33 to −37.

| Layer | Target, LUFS momentary max at cue volume 1.0 | Measured at the default 0.4, both palettes (momentary max / sample peak) |
| --- | ---: | --- |
| S6 your-move | −14 | −22.0 / −14.1 (1) and −11.6 (2) dBFS |
| S7 fault | −16 | −24.0 / −14.6 and −14.4 dBFS |
| S5 released | −18 | −26.0 / −19.4 and −16.3 dBFS |
| S4 landed | −18 | −26.0 / −18.8 and −17.6 dBFS |
| S8 reply | −20 | −28.0 / −20.9 and −17.8 dBFS |
| S9 launched | −23 | −31.0 / −19.5 and −17.3 dBFS |
| S3 step | −23 | −31.0 / −19.5 and −16.5 dBFS |
| S1 typing | gain 0.5 × slice, unchanged | −39.0 (six calls in 5.6 s) / −21.0 dBFS |
| S2 distant typing | S1 × 0.2 × the 5.5 dB room loss (5.5) | −51.6 to −54.1 / −29.2 to −33.8 dBFS |

Neighbours are at least 2 LU apart: S6 > S7 > S5 = S4 > S8 > S9 = S3, and S3 sits 8 LU over a run of typing, so a step is heard over it as an event. No single sound reaches the −10 dB limiter at the default volume. Measured with ffmpeg `ebur128` and `astats` on the prototype's renders (cue volume 0.4 plus a fixed 9 dB for listening, subtracted above); the prototype's «Rules check» repeats the limiter test from its own measurement.

### 6.4 Ducking

While an event sound plays, the typing bus ramps to 0.35 (−9 dB) over 20 ms and back over 400 ms after the sound's `length`. S6 and S7 also duck the opt-in music bed, as priority cues do today (`onPriorityCue`).

## 7. "Work is going on"

The operator hears work as typing: close and clear for the conversations on screen (S1), muffled and sparse for the agents off screen (S2). Both are triggered only by real tool calls, and every live session is heard through exactly one of them (4.4), so in a visible desktop tab silence means no agent is calling tools, and the density follows the amount of work. The one gap: S2 reads the runtime stream, so an off-screen agent that does not run under the runtime host (a terminal session) is heard only while its pane's feed is live. Nothing plays because a process merely exists, so the near-continuous activity the audit found produces a murmur that thickens and thins with the work, and stops when work stops.

Progress and results come on top as short tonal sounds: a step (S3), a landing (S4), a release (S5). What needs the operator is louder and different in contour (S6, S7).

## 8. Context rules

| Context | Behaviour | Why |
| --- | --- | --- |
| Visible, focused desktop tab | Everything | — |
| Hidden desktop tab | Event sounds S3–S9 play; S1 and S2 stop | A hidden desktop tab keeps the board feed at a 30 s cadence and the runtime stream (`src/lib/client/hiddenTraffic.ts:31`) so the operator learns of results while working elsewhere; typing from a tab nobody looks at is background noise in another application. Batches from the slower cadence fall into the coalescing windows. |
| Two Delegatus tabs on one device | Event sounds play only in the tab that most recently had focus (a `localStorage` key holding a tab id and time, written on focus and on becoming visible, read through the existing `storage` listener); typing plays in each visible tab for its own panes. The owner refreshes the key's time every 30 s while it is open, and removes the key on `pagehide`. A key older than 90 s, or no key, is void: the next tab with an event sound to play claims the key and plays, so a closed or crashed tab never silences the others. Two tabs claiming in the same instant can double one sound, which is the old behaviour | One device, one sound per event. |
| Phone, visible | S1 for the open conversation and every event sound; S2 off | Small speaker, battery, one conversation on screen. |
| Phone, hidden | Nothing; the transport suspends after 30 s (`HIDDEN_SUSPEND_MS`) | Telegram notifies the phone. |
| A voice call is connected (`setVoiceConnected`, `src/lib/audio/app.ts:151`) | S1, S2, S3 and S9 off; S4–S8 at −6 dB | The companion is speaking; only results and obligations interrupt it. |
| Before the first gesture | Nothing plays; sounds requested are dropped (autoplay policy), as today | Unchanged. The first `pointerdown`/`keydown` resumes the context (`src/lib/audio/app.ts:213`). |
| iOS silent switch on | Web Audio is muted by the system | Platform behaviour; noted in the settings hint text only if the operator asks. |

## 9. Off switch and settings

The existing master switch keeps governing all product audio on this device (`llvSound`, `src/lib/audio/prefs.ts:19`; desktop menu `src/components/ProjectDashboard.tsx:2132`; header and phone `src/components/headerMenu/HeaderMenu.tsx:337`). The cue volume slider keeps its role. The settings panel (`src/components/SoundToggle.tsx:61`) gains one checkbox, «Звук роботи агентів» / "Agent typing", stored as `llvAudioTypingEnabled`, default on, which turns S1 and S2 off together. It is the one frequent layer, so it is the one an operator may want off while keeping results and questions. No new menu or control surface is added.

The opt-in background music for calls and the Viewer (`public/audio/ambient/voice-call-loop.wav`, `src/lib/audio/loopAsset.ts:15`) is music with its own switches and default off; it voices no event and is unchanged. The listening form asks whether to remove it too.

## 10. Busy-hour check

This section replays the voiced sources themselves over the whole window, and reports both the busiest hour of the voiced series and the audit's busiest tool hour, which are different hours.

**Method.** Read-only, from scratch copies taken 2026-10-21 at 20:39 UTC (the state database and its WAL, the agent registry and the classifier's asks state; each copy passed `PRAGMA quick_check`), over window W. Sources, one timestamp each, deduplicated as in the audit's methods: stage attempts settling `passed` (`completedAt`), stage attempts settling `needs_decision` (`completedAt`), merges reaching `merged` (`mergedAt`), lanes `completed` with no merge state (`closedAt`), merges still `blocked` (`blockedAt`), prototype and seat decision forms (`createdAt`), attention requests (`createdAt`), failed launches (`failureReporting.failedAt`), deploy and limit done items (`at`), and the classifier's asks (`messageAt`, split by the stored role). The replay then applies every rule of section 6 in time order: the obligation key with its 10-minute memory, each class's coalescing window, gap and cap, S4 superseding S3 for the same pipeline within 10 s, and the queued lane of 6.2 with each sound's length. Bridge asks (7 in window B, 0.13/h) are not in the replay, because their retained ring starts on 10-19. The reproduced source counts match the audit (1,700 passes, 271 merges, 154 forms, 154 decisions; launch failures 163 against the audit's 159, from a later capture). SHA-256 of the reduced class and timestamp series: `1395b7d0bf9f1db610a86a0e6088eb28c5df2ff889e2cf0cf8bdd36563dc4956` (3,266 rows). Only aggregates are published.

**Whole window**, machine-wide:

| Sound | Source events in W (mean/h) | Plays after the rules (mean/h) |
| --- | ---: | ---: |
| S3 step | 1,700 (10.12) | 1,462 (8.70); 235 merged by the 2 s window and 6 s gap or superseded by S4, 3 dropped on the lane |
| S4 landed | 271 merges + 223 completions without a merge = 494 (2.94) | 494 (2.94) |
| S6 your-move, structured | 154 decisions + 154 forms + 22 requests = 330 (1.96) | 317 (1.89) |
| S7 fault | 163 launch failures + 5 merge blocks + 5 deploy failures or rollbacks + 4 limits = 177 (1.05) | 173 (1.03) |
| S5 released | 71 (0.42) | 71 (0.42) |
| **Total** | **2,772 (16.5)** | **2,517 (14.98)** |
| Not voiced: inferred asks | 494 (2.94), 400 from orchestrator seats | Voiced as S6, S6 would be 811 plays (4.83/h), the total 3,011 (17.9/h) |

**Busiest hour of the voiced series:** 2026-10-21 11:00 UTC, 53 voiced sources (58 with the inferred asks).

| Sound | Sources in 10-21 11:00 | Plays | Sources in 10-15 14:00 (the tool hour) | Plays |
| --- | ---: | ---: | ---: | ---: |
| S3 step | 30 | 22 | 29 | 22 |
| S4 landed | 10 (2 merges, 8 completions) | 10 | 10 (4 merges, 6 completions) | 10 |
| S6 your-move | 5 (3 decisions, 2 forms) | 5 | 6 (3 decisions, 1 form, 2 requests) | 5 |
| S7 fault | 8 launch failures | 8 | 0 | 0 |
| S5 released | 0 | 0 | 1 | 1 |
| **Total event sounds** | **53** | **45**, one every 80 s | **46** | **38** |
| Inferred asks, not voiced | 5 | — | 10 | — |
| S1 / S2 | | | 3,614 tool calls | S1 for live feeds only; S2 at most one slice per 3–8 s |

With the inferred asks voiced as S6, 10-15 14:00 would carry 56 sources and 48 plays, 15 of them S6, three times the structured rate; this is the measured cost of the choice in 4.1. The densest ten minutes of plays in W hold 16 sounds. The rates stay machine-wide: one tab hears only its scope, so they are an upper bound for any tab. S8 and S9 come on top and are bounded by the operator's own sends and launches. The current scheme, from the same audit rates, can produce around 176 cues per hour.

## 11. Placement critique (acceptance 3)

Each insertion point checked for frequency, overlap and meaning. "Fixed" names the change the design made after the check failed.

| # | Insertion point | Frequency | Overlap | Meaning | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | `useAgentChimes` waiting → attention (`src/hooks/useAgentChimes.ts:13`, `:90`, `:205`) | Up to 46/h of root turn ends, 16/h of them orchestrator ticks | Duplicates the needs-you queue for real questions | Fails: a finished turn is labelled "needs you" | **Fixed:** removed. Real questions come from the needs-you queue (S6); the operator's own conversations answer with S8. |
| 2 | `useAgentChimes` spawned → launch (`:109`) | 21–23/h | A late parent link rings for an old process | Fails | **Fixed:** removed. Only this device's own launch sounds (S9). |
| 3 | `useAgentChimes` returned → success, stalled → failure (`src/lib/audio/cues.ts:118`) | Per subagent return; stalls unknown | Stalled overlaps real failures that the queue carries | Fails: mid-work news, and an inference voiced as a failure | **Fixed:** removed. Planner and hook are deleted once nothing maps to them. |
| 4 | Viewer MCP calls → `viewer-mcp` (`src/lib/audio/toolCues.ts:35`) | 109/h, 1,204 in its busiest hour, 25 in 10 s | Same stream as typing | A distinct cue at continuous rates for plumbing | **Fixed:** folded into S1. |
| 5 | Tool calls → typing (`src/components/LogFeed.tsx:885`, `src/hooks/useToolActivityCues.ts:52`) | Up to 52 in 10 s | Shared the three-voice pool with every event cue | Passes | **Kept;** own pool, ducks under event sounds, Viewer MCP included. |
| 6 | Needs-you queue → S6/S7 (new, `src/components/Viewer.tsx:1070`) | S6 with every reason, inferred `ask` included: 824 sources in W, 811 plays (4.83/h), 15 in 10-15 14:00, with the inferred asks more than half of them and 81% of those from orchestrator seats. S6 structured only: 330 sources, 317 plays (1.89/h), 5 in each of the two busy hours. S7: 1.03/h | A parked stage and its form can arrive in different polls; each orchestrator ask is a new id with no task id, so the obligation key never merges them | Fails for `ask`: the loudest sound would fire on orchestrator prose again. Passes for the structured reasons | **Fixed:** `ask` plays no sound (4.1); the operator's own conversations answer with S8; the form offers `ask` as an unticked option. Obligation key per task with a 10-minute memory; each entry's staleness uses its own clock of asking (`raisedAt`, 4.1). |
| 7 | Own launch result → launched / failure (`src/components/DraftAgentPane.tsx:650`) | Bounded by the operator's own launches | A failed launch also enters the queue as reason `launch` under a different id | The failure would sound twice | **Fixed:** the card plays S9 for `launched` only; the queue's `launch` reason plays S7. The implementation adds a test that a failed operator launch reaches the queue. |
| 8 | Attention offers and directed requests (`src/components/overlay/useAttentionOffers.ts:373`, `src/components/attention/AttentionHost.tsx:340`) | 0.13/h | An offer can point at an obligation the queue already carries | Passes: an agent asks the operator to look | **Kept as S6**, sharing the S6 coalescing window and gap. |
| 9 | Pipelines → S3 step (new, beside `src/components/Viewer.tsx:445`) | 10/h, 3 in 10 s | The last stage passing and the merge can be close | Passes: progress | **Fixed:** S4 for the same pipeline replaces S3 when the landing is in the gate while the step is (inside its 2 s window or 6 s gap) or left it in the 10 s before; the lane never recalls a step that has already played (see the implementation notes). |
| 10 | Stage failures | 5.2/h, 8 in 10 s | Repairs follow at once (4.4/h) | Fails as "fault": the review loop is working | **Fixed:** silent. A failure with nowhere to go reaches S6 or S7 through the queue. |
| 11 | Pipelines → S4 landed (new) | 494 in W (2.94/h: 1.61 merges + 1.33 completions without a merge), 10 in each busy hour, 3 in 10 s | Merge then `completed` for the same lane | Fails for 5 completions whose merge was `blocked` or `cancelled`: «Landed» for a change that did not land | **Fixed:** keyed by pipeline id; a batch coalesces with grace notes; completion plays S4 only with no merge state; a blocked merge plays S7 (row 18), a cancelled one nothing. |
| 12 | Done feed → S5 released and deploy/limit faults (new, `src/components/Viewer.tsx:1075`) | 0.42/h | The page is not reloaded by a deploy (a banner offers it), so the item lands in a poll of the open tab, which a hidden desktop tab did not make | The sound would be lost in a hidden tab, and for a page opened after the deploy | **Fixed:** the done feed polls in a hidden desktop tab (suspended only on a hidden phone); fresh items sound on a baseline read; heard keys persist in `sessionStorage` (4.3). |
| 13 | Runtime stream → S2 (new, `src/hooks/runtimeBus.ts:567`) | Up to 1,632/h of items, 26 concurrent intervals | On-screen panes also ring S1. Keyed on pane registration, a mounted pane scrolled out of view would play neither S1 (its feed is paused) nor S2 (it is registered), so most off-screen work on a full board would be silent | Fails as first written | **Fixed:** eligibility is "no live feed", the same `paused` state that stops the feed (4.4), so every live session is exactly one of S1 or S2; a resumed feed re-baselines silently; rate formula, skipped right after S1, off when hidden and on phones. |
| 14 | Runtime stream → S8 reply (new) | Bounded by sends and own launches | A seat's own ticks end turns too; the default `interrupt-active` send ends the running turn first (880 «waiting for the current turn» records in W) | Fails as first written: S8 at the interrupt, then silence at the real answer | **Fixed:** limited to the "awaiting reply" set filled by this tab's sends and launches, and played only when the carrying turn (a turn newer than the ones recorded at the send) ends `completed`; the store keeps `lastTurnOutcome` (4.4). |
| 15 | Master switch preview (`src/components/SoundToggle.tsx:52`) | Per toggle | — | Previewed `success`, a sound now gone | **Fixed:** previews S3. |
| 16 | Voice-call and dictation cues (`src/lib/voiceCompanion/cues.ts:64`, `src/hooks/useDictation.ts:243`, `:596`) | 0.04/h calls; dictation unrecorded | S8 plays during a call (section 8); S3 can play while the operator dictates | Passes for meaning; fails for distinctness as first written (row 22) | **Kept;** same pitches, rendered by the shared engine; dict-warn becomes two pings (row 22). The companion keeps its own context, opened on the Talk tap. |
| 17 | Tab title count (`src/components/Viewer.tsx:1128`) | — | Reads the same queue as S6/S7 | — | Unchanged; the sound and the badge now agree by construction. |
| 18 | Pipelines → S7 on a blocked merge (new) | 7 in W (0.04/h) | A blocked lane can also park for a decision (S6); different obligation, different sound | Passes: the change did not land and needs a look | **Added**, keyed `merge-blocked:<pipeline id>`. |
| 19 | The event lane (6.2) | 2,517 plays in W, 45 in the busiest hour | S7 during S6 (1.6 s), S5 during S4, S6, S7 or S8; in 10-20 12:00 a launch failure fell within 10 s of a lane park | Fails as first written: an equal or lower sound was dropped and its identity already spent, so a rare S5 or S7 was never heard | **Fixed:** every class but S3 and S9 queues behind the playing sound, one pending play per class, a 15 s bound; a cut sound replays once. Replayed over W, only 3 S3 plays are dropped. |
| 20 | S6 against S4, S5 and S9 (5.3) | — | All four rise; S6 and S4 both reached D6 at about 0.21 s in D major | Fails as first written: the most important sound and a routine result sounded alike | **Fixed:** S6 is a repeated rising fourth topping at B5; S9 tops at E6; no two rising sounds share top note and onset within 50 ms (5.3 table). |
| 21 | Two tabs, the focus key (section 8) | Per focus change | A closed or crashed owner tab | Fails as first written: a closed tab would silence the others | **Fixed:** the key is refreshed every 30 s, removed on `pagehide`, void after 90 s. |
| 22 | S8 against the call-ended pair, S3 against dict-warn (5.3) | S8 bounded by sends; S3 8.7/h | S8 keeps playing during a call, so «reply arrived» and «call ended» can fall in one minute; S3 can sound while the operator dictates | Fails as first written: S8 and V− were the same D6→A5 figure 40 ms apart in spacing; S3 and dict-warn were both one short sine ping | **Fixed:** S8 is E6→B5, 160 ms apart; dict-warn is two pings; the distinctness rule now covers every sound, the small ones included, and the prototype checks it. |
| 23 | Levels (6.3) | — | S5 and S4 against S6 and S7 | Fails as first written: levelled by per-strike peak, a routine release was as loud as «your move» and a fault quieter than a landing; S3 sat at typing level and S2 20 LU under S1 | **Fixed:** each sound's gain comes from its measured loudness, with targets 2 LU or more apart; S2 makes up the lowpass loss; the compressor's own makeup gain is taken back out. |

## 12. Change list for the implementation lane

| Where | Change |
| --- | --- |
| `src/lib/audio/synth.ts` (new) | The spec types, the renderer (5.1), both palettes (5.2), the sound table (5.3), the loudness calibration that sets each gain (6.3), the typing replica (5.4) and the distant-typing chain with its room-loss makeup (5.5). |
| `src/lib/audio/cues.ts:19`, `:50`, `:67`, `:118` | `AudioCue` becomes the nine sound ids; `CUES` keeps only the typing slices as files; `TIER_GAIN` becomes the level table (6.3); `CUE_OF_LIFECYCLE` is deleted. |
| `src/lib/audio/cuePlayer.ts:77`, `:132` | Two pools: typing (3 voices) and the event lane (6.2) with its queue (one pending play per class, S3 and S9 dropped, a cut sound replayed once, a 15 s bound, emptied on mute); per-class coalescing windows, gaps, caps and the staleness rule with its per-source clocks (6.1). |
| `src/lib/audio/webAudioTransport.ts:209` | The cue transport starts either a typing buffer or a synth spec on the right bus; adds the two buses, the limiter with its makeup gain taken back out and the 150 ms settle before the first sound (5.1), and the typing duck (6.4). |
| `src/lib/audio/app.ts:106`, `:151`, `:213` | `playCue` takes the new ids; the voice-call rule (section 8); warming only the eight typing files. |
| `src/lib/audio/prefs.ts:19`, `:47`, `:112` | `llvAudioTypingEnabled`, default on. |
| `src/lib/audio/toolCues.ts:35` | Every tool call is typing. |
| `src/hooks/useToolActivityCues.ts:52` | Skip when the typing switch is off, the document is hidden, or a voice call is connected. |
| `src/hooks/useAgentChimes.ts` (whole file), `src/components/Viewer.tsx:445` | Replaced by `useWorkCues(needsYou, pipelines, doneItems, scope, certified)`: pure planners for the queue (4.1), pipelines (4.2) and done items (4.3), with the same scope-certification and baseline rules `planScopedAgentChimes` has today. |
| `src/hooks/useFleetCues.ts` (new), mounted once in `Viewer` | Runtime-bus subscriber for S2 and S8 (4.4); also owns the focus key of section 8 (30 s refresh, `pagehide` removal, 90 s expiry). |
| `src/hooks/useRuntime.ts:347` | Before the POST, record a pending "awaiting reply" entry with the session's `activeTurnId`, `settledTurnId` and the send's policy; commit it on acceptance, remove it on refusal. |
| `src/components/runtime/runtimeModel.ts:710` | The `turn-ended` case stores `lastTurnOutcome` from the payload's `outcome`. |
| `src/lib/chime.ts:45`, `:118`, `:155`, `:187` | Add `registerLiveFeed(conversationId)` (reference-counted) and `hasLiveFeed(conversationId)` beside `registerPane`; delete the lifecycle tunes; route `dictWarn` (now two pings) and `dictStop` through the engine. |
| `src/components/LogFeed.tsx:885` | Register the conversation as a live feed while `!paused`; when `paused` turns false, re-baseline the cue scanner silently on the next parse. |
| `src/lib/voiceCompanion/cues.ts:9`, `:64` | Render connect/disconnect from the engine's specs on the companion's own context. |
| `src/components/DraftAgentPane.tsx:650` | `launched` only; when the receipt names `conversationId`, add it to the "awaiting reply" set. |
| `src/components/overlay/useAttentionOffers.ts:373`, `src/components/attention/AttentionHost.tsx:340` | Play S6 with the attention request id. |
| `src/components/SoundToggle.tsx:52`, `:61` | Preview S3; the typing checkbox (section 9), with en and uk strings. |
| `public/audio/cues/` | Delete `attention.mp3`, `failure.mp3`, `launch.mp3`, `success.mp3`, `viewer-mcp.mp3`; keep `tool-tick-1..8.mp3` unless the operator picks the replica. |

Tests the implementation owes (by explicit path, isolated state, per the project's instructions): the planners' baseline, scope-switch and staleness cases; the obligation-key memory; S4 superseding S3; the fresh-deploy-after-reload case; a failed operator launch reaching the queue; the player's windows, gaps, caps and priority cut; the lane queue (S7 arriving mid-S6 plays S7 after it; S5 arriving mid-S4 plays after it; S6 arriving mid-S4 cuts it and S4 replays once; S3 arriving mid-S6 is dropped; a queued play older than 15 s is dropped; mute empties the queue); the staleness clocks (a stuck delivery whose admission is 30 minutes old but whose `raisedAt` is fresh plays S7); the hidden-tab, phone and voice-call gates; S2 eligibility (a mounted but off-screen pane gets S2; a pane in view gets S1 and no S2; scrolling a pane back into view rings no backlog burst); S8 (send to a running turn: no S8 at the interrupt, S8 when the answering turn completes; a refused send leaves no entry; an `error` end removes the entry silently; a turn that starts and ends inside one notification still plays; a launch's first completed turn plays S8); `ask` entries play nothing; a completion with a `blocked` or `cancelled` merge plays no S4, and a `blocked` merge plays S7; the focus key (a closed owner tab stops silencing others after `pagehide` or 90 s); the runtime stream delivering `item` events for a session the tab never opened; and the existing `cuePlayer`, `toolCues`, `cues`, `chime` and `useAgentChimes` tests rewritten to the new ids. Rendered evidence for the one settings checkbox goes through the existing header and phone drivers, in en and uk, light and dark.

## 13. What the prototype and the form need from this document

The prototype page (acceptance 4) plays every sound in 5.3 in both palettes from the specs above, the original typing slices beside the replica, S2 at one, four and seven off-screen agents, and a simulated busy hour: the twelve five-minute bins of the audit's busiest tool hour (2026-10-15 14:00, the only hour with tool bins), with events placed uniformly at random inside each bin, all of the bin's tool calls sent to S1 for two on-screen conversations and S2 for the rest, and every rule of section 6 applied. Its event plays (38 from 46 sources, section 10) are within seven of the busiest voiced hour's 45. The audit's bins lack two voiced sources; their bins from the recount of section 10 are:

| Minute in hour | 00 | 05 | 10 | 15 | 20 | 25 | 30 | 35 | 40 | 45 | 50 | 55 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Completions without a merge (S4) | 1 | 0 | 0 | 0 | 2 | 0 | 1 | 1 | 0 | 1 | 0 | 0 |
| Attention requests (S6) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |
| Inferred asks (only for the optional S6 variant) | 0 | 2 | 0 | 1 | 0 | 3 | 1 | 3 | 0 | 0 | 0 | 0 |

Launch failures in that hour: none. The page also plays S4, S5, S6 and S9 back to back (5.3). The rendered MP4 files show the same.

The listening form (acceptance 5) asks, each with an "other" answer:

1. **Palette:** 1 Скло (recommended), 2 Дерево.
2. **Typing:** the original eight files (recommended), the synthesized replica.
3. **Which events are voiced** (multi-select, all recommended ticked except the last two): S2 distant typing; S3 step; S4 landed; S5 released; S6 your move; S7 fault; S8 reply; S9 launched; also S6 for an inferred «asks you» (about 2.9 more per hour, 81% from orchestrators); also remove the background music file.
4. **Start implementation** with these answers: yes (recommended), not yet.

## 14. Check against the requirement

- *Audit which events exist and how often:* every voiced and silent family above cites the audit's rate or the recount of section 10, which replays the whole window and its busiest voiced hour under the rules.
- *Different sounds for the events:* nine sounds with distinct contours, two of them loud for the two classes that need the operator.
- *The sounds that play during orchestrator activity:* orchestrator ticks no longer ring the loudest cue, neither as a finished turn nor as an inferred ask (critique rows 1, 4 and 6).
- *Redo from scratch; the rest can go:* five sample cues are deleted; every new sound is synthesized code.
- *Sounds written as code, with critique of where they go:* section 5 gives the parameters, section 11 the critique.
- *Follow real usage:* coalescing windows and gaps are sized to the audit's measured bursts.
- *Every sound tells the operator that work is going on:* each sound fires only on a real event of its meaning (S4 only for a change that landed, S8 only for the turn that answers); the continuous layer is real tool activity, every live session is heard as exactly one of S1 or S2, and it stops when work stops.
- *Keep the typing effect:* kept byte for byte, with a replica only as a listening option.

No ADR: every decision here is a code-level choice reversible in one lane.

## Implementation notes (2026-10-22)

The operator's listening answers chose palette 2 «Дерево» (`ACTIVE_PALETTE` in `src/lib/audio/synth.ts`, one constant), the original eight typing files, and every voiced event as designed with the inferred ask silent; the call music is unchanged. Where the code departs from the text above:

- **Gains are measured once, not in every tab.** Rendering is deterministic, so `CALIBRATED_GAIN` holds the §6.3 calibration for both palettes, and `src/lib/audio/synth.browser.test.ts` re-runs it in Chromium and fails on any drift over 0.1 dB.
- **Every sound renders the same at any start.** Until an oscillator's first frequency event applies, Chrome plays its 440 Hz default for the frames before it in the 128-frame render block. The prototype's strikes therefore opened with a start-dependent phase, which moved peaks by up to 1.8 dB between plays. The engine sets the starting pitch as the static value too, and the mallet reads the noise slice of the prototype's renders. The table's S5 palette-2 sample peak is therefore the start-independent −16.3 dBFS (first written −17.5, a low draw of the leak; 6.3 gives the method), and the render check compares every sound with the table within 1 dB, with no exception. Every loudness is within 0.5 LU of the table.
- **S3 is replaced causally.** The lane cannot recall a sound it has played. A step is dropped when its lane's landing is in the gate at the moment the step would leave it, or left the gate in the 10 s before; a landing requested after the step has played (step at 0 s, landing at 5 s: the step plays at 2 s, the landing at 10 s after its own 5 s window) sounds both. `src/lib/audio/eventLane.test.ts` pins that case.
- **S7 keeps its F5.** §5.3's table writes the fault as A5 → F5 → D5, the one figure outside D major (a minor third, on purpose), and the code keeps it.
- **S5 does not cut S4.** Only S6 and S7 cut a playing sound (§6.2's own example: S5 arriving mid-S4 plays after it), as the prototype's planner does.
- **The voice-call pair is unchanged.** `src/lib/voiceCompanion/cues.ts` belongs to the voice call code, which another open lane is changing; its two tones stay as they are. The dictation pair moved onto the engine.
- **No replica.** The synthesized typing replica (§5.4) was a listening variant only; the operator kept the original files, so it is not shipped.

## Deferred — not currently justified

- Repeating a reminder sound for an obligation left unanswered: the badge and the tab title already persist, and a repeating sound is the classic fatigue source.
- Per-event or per-project sound settings beyond the one typing switch: no evidence the operator wants more controls, and the project prefers reusing existing ones.
- Spoken announcements (text to speech) for events: a separate feature with its own costs.
- Sounds for seat checks, deliveries, quota probes, Telegram sends, bridge status reports, task moves and permission denials: silent by the frequency and meaning rules above.
- A cross-device leader so only one device plays: devices are device-local by design (`src/lib/audio/prefs.ts`), and the operator's desk and phone are usually in different places.
- Recording which sounds actually played: the audit notes the gap; the design does not need it to be judged by ear.
- Replacing the opt-in music loop with synthesized music: it voices no event; the form asks only whether to remove it.
- Pitch or pan encoding of which project or lane an event belongs to: more to learn for the operator, and the existing pane panning already places on-screen sounds.
