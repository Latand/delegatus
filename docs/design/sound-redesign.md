# Sound redesign: the sound map

Requirement, 2026-10-21, private operator brief (dictated; paraphrased here because the source is private): audit which events the system has and how often they happen, and give them different sounds. Some sounds play today during orchestrator activity and elsewhere; redo all of it from scratch. The sounds are written as code, programmatically and with care, together with a critique of where they are inserted. The design follows real usage and the real history. Every sound must correctly tell the operator that work is going on. The current typing effect works well and is interesting, so it stays; the rest can go.

This document is acceptance 2 (the sound design) of that lane, with the placement critique of acceptance 3 in its own section. It builds on the event audit in `docs/design/sound-events-audit.md` (acceptance 1); every rate below is quoted from that audit's tables, window W (2026-10-14 17:00 to 2026-10-21 17:00 UTC, 168 hours) unless another window is named. The prototype, the rendered media and the listening form (acceptances 4 and 5) are later stages of this lane, and implementation is a separate lane after the operator's answer.

Code examined: `3e6ca3c16dbd31e7e19b5bc807d8f93b7584cd25` (the pipeline base). Every `file:line` below refers to that revision; each was re-checked one file at a time. `origin/main` has moved four commits since; none of them touches an audio module, a cue call site or `public/audio`. None of the twelve open pull requests touches those files either (`gh pr list` filtered on the file paths, 2026-10-21).

Earlier answers: transcript and memory searches for sound, cue, chime and typing work found the audit stage itself, the original earcon implementation lane and a demo that fetched the cue files. No design doc for the current earcons exists under `docs/design`, and no earlier operator decision about which events are voiced was found. The current code's comments are the only prior rationale, and this design cites them where it keeps or reverses them.

## 1. What the audit tells the design

Rates are machine-wide source counts across every project. A browser tab hears only the conversations it has on screen, the project scope its board feed serves and the runtime stream it subscribes to, so every rate here is an upper bound for what one tab could play. The audit says plainly that playback itself was never recorded.

The events fall into four frequency bands, and the band decides the treatment:

| Band | Events (mean/h, busiest hour, max per 10 s) | Treatment |
| --- | --- | --- |
| Continuous, over 100/h | Model tool calls 1,632/h, 3,614, 52; direct Viewer MCP calls 109/h, 1,204, 25; delivery phases up to 91/h; quota probes 289/h (window Q); runtime text chunks about 3,850/h (window R, normalized) | Texture or silence. Only the kept typing effect is allowed here, because it is the one sound already proven to carry dense activity without fatigue. |
| Frequent, 10–100/h | Turn starts and ends (Claude 29/h, Codex 16/h), launches 23/h, stage starts 17/h, stage passes 10/h, seat checks 4–47/h (window C), bridge reports 9/h (window B) | Silent unless the event changes what the operator knows. One quiet event (a stage passing) is voiced, with a coalescing window and a minimum gap. |
| Occasional, 1–10/h | Stage failures 5.2/h, repairs 4.4/h, tasks created 5.2/h, Telegram sends 6.3/h, merges 1.6/h, pipelines created and closed about 4/h | Voiced only for results: a lane landing. Failures that go to a fix stage on their own are routine and stay silent. |
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

Estimated from those rates, today's scheme can produce around 176 distinct cues per hour on average machine-wide (46 attention + 109 Viewer MCP + 21 launch, before success and failure), on top of the typing. The design below brings the event cues to about 15/h on average and about 38 in the busiest hour (section 9).

## 3. The sound map

### 3.1 Voiced events

Nine sounds. Each is named for what it tells the operator, so the meaning stays fixed when the source changes.

| # | Sound | Tells the operator | Fires on (source the browser has) | Source rate (mean/h; busiest hour; max/10 s) |
| --- | --- | --- | --- | --- |
| S1 | **Typing** (kept) | An agent on screen is working right now | Each newly appended tool call, ordinary or Viewer MCP, in an on-screen conversation pane | 1,632; 3,614; 52 |
| S2 | **Distant typing** (kept effect, processed) | Agents off screen are working, and roughly how many | Tool items on the runtime stream for live sessions that have no on-screen pane | Same population; played at most one slice per 3–8 s |
| S3 | **Step** | A lane moved forward | A stage attempt settling `passed` in the board's pipelines | 10.1; 30; 3 |
| S4 | **Landed** | A lane finished: merged, or completed without a merge | A pipeline's merge reaching `merged`, or the pipeline reaching `completed` | Merges 1.61; 7; 3 |
| S5 | **Released** | A new Delegatus version is serving | A deploy item with phase `succeeded` in the «Готово» feed | 0.42; 2; 1 |
| S6 | **Your move** | Something is waiting for the operator's answer | A new entry in the needs-you queue whose kind asks a question: decision, question, plan, permission, terminal input, inferred ask, a lane needing a decision or review, a prototype or decision form, an update decision; plus attention requests | Forms 0.92 + parked stages 0.92 + requests 0.13, with overlaps (section 4.1) |
| S7 | **Fault** | Something broke and needs a look | A new needs-you entry of kind stuck delivery, failed launch or memory kill; a deploy item with phase `failed` or `rolled-back`; a limit episode item | Launch failures 0.95; deploy failures 0.03; limits 0.02 |
| S8 | **Reply** | The conversation this device just wrote to has answered | A turn ending in a conversation this device sent a message to | Bounded by the operator's own sends |
| S9 | **Launched** | The launch this device asked for was accepted | The launch receipt in the new-agent card | Bounded by the operator's own launches |

Three small sounds keep their current triggers and move into the same synthesis module and palette: the voice-call connect and disconnect pair (`src/lib/voiceCompanion/cues.ts:64`, called at `src/lib/voiceCompanion/liveAdapter.ts:127` and `:297`; 7 calls in W), and the dictation near-cap ping and auto-stop (`src/hooks/useDictation.ts:596` and `:243`). The master switch preview plays S3.

### 3.2 Silent events, with the reason

| Event family (audit rate) | Why silent |
| --- | --- |
| Turn starts and ends of agents the operator did not write to (46/h) | Covered by S1/S2 while running; a turn ending is no news unless the operator is waiting for it (S8). |
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

- S6 Your move: reasons `decision`, `question`, `plan`, `permission`, `ask`; entry kinds `pipeline`, `prototype`, `update`.
- S7 Fault: reasons `delivery`, `launch`, `memory`.

**Obligation key.** One decision can still enter the queue twice in different polls: a lane parks (pipeline row) and a minute later the seat raises a form for the same task (prototype entry). The planner maps each entry to an obligation key, the task id when the entry has one (`notice.taskId`, the pipeline's task), else the entry id. A key that already sounded in the last 10 minutes stays silent.

### 4.2 S3 and S4 read the board's pipelines

`useFiles` delivers the scope's pipelines (`src/components/Viewer.tsx:270`), including on a hidden desktop tab at the 30-second cadence (`src/hooks/useFiles.ts:44`). A pure planner beside the agent-chime planner diffs them:

- S3 on an attempt (`pipelineId:stageId:n`) entering `passed` (`PipelineAttemptState`, `src/lib/pipelines/types.ts:164`).
- S4 on `merge.state` entering `merged` (`src/lib/pipelines/types.ts:1216`) or the pipeline state entering `completed`, keyed by pipeline id so a merged lane that then completes sounds once.

### 4.3 S5 and the deploy and limit faults read the «Готово» feed

`useDoneItems` (`src/components/attention/doneItems.ts:105`, read at `src/components/Viewer.tsx:1075`) returns deterministic items of kind `pr`, `pipeline`, `task`, `deploy`, `report` and `limit` (`src/lib/done/types.ts:8`). Deploy items carry the terminal phase. This feed covers both deployment backends; the audit found the runtime-host deployment table empty on this installation, so the runtime stream's `deployment.state` (`src/components/runtime/runtimeModel.ts:800`) cannot be the only source.

A deploy restarts the Viewer, so the item usually arrives in the first read after the page reloads, which is a baseline read. Two rules make that case sound once: an item whose own `at` is less than 5 minutes old sounds even on a baseline read, and every key that sounded is remembered in `sessionStorage` (bounded to 256 keys) so a second reload stays silent.

### 4.4 S2 and S8 read the runtime stream

The tab-wide runtime bus (`src/hooks/runtimeBus.ts:567`) carries every structured session's `item` (`src/components/runtime/runtimeModel.ts:619`) and `turn-ended` (`:710`) events, and keeps streaming in a hidden desktop tab (`src/lib/client/hiddenTraffic.ts:31`). Its subscribers receive store snapshots without event detail, and `updateSession` replaces only the changed session object, so the cue watcher compares session objects by identity and examines only the sessions that changed. Work per notification scales with what changed, and the bus already batches notifications to one per frame.

- S2: a tool item id not seen before, in a session whose conversation has no registered on-screen pane (`registerPane`, `src/lib/chime.ts:45`, registered by `src/components/BranchPane.tsx:290`; off-screen panes pause their feed at `src/components/BranchPane.tsx:284`, so their typing is already silent).
- S8: `turn-ended` for a conversation in this tab's "awaiting reply" set. `sendRuntimeMessage` (`src/hooks/useRuntime.ts:347`) adds the conversation when a send is accepted; the turn ending removes it. The set holds at most 64 conversations and forgets entries after 2 hours.

The implementation lane must confirm that `item` events reach the stream for sessions the tab has never opened; the stream route forwards the host's events without a kind filter, but no test asserts it. If they do not, S2 falls back to `turn-started` and `turn-ended` alone, ticking per running turn.

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
  detuneCents?: number;            // > 0: each mode is a pair at ±detune (slow beating)
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
  peak: number;                    // linear gain at cue volume 1.0, before the bus limiter
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
if (twin) osc.detune.value = twin * timbre.detuneCents!;
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

A mallet adds a slice of the shared one-second white-noise buffer through a band-pass (`bandHz`, `q`) with a 1 ms attack and `setTargetAtTime(0, t, length / 6.91)`. Vibrato is one LFO oscillator into `osc.detune` with gain `cents`. Each sound then runs `soundLowpass → soundGain(peak × cueVolume) → StereoPanner(pan) → event bus`.

The graph has two buses: an event bus and a typing bus, both into one master gain and a limiter (`DynamicsCompressorNode`: threshold −10 dB, knee 0, ratio 20, attack 3 ms, release 150 ms) before the destination. The limiter only catches overlaps; a single sound never reaches it.

### 5.2 Two timbres, one set of gestures

The gestures (note count, contour, timing) carry the meaning and are shared. Two timbres are proposed so the operator can choose by ear; the listening form shows one variant per palette.

| Palette | Timbre | Register |
| --- | --- | --- |
| **1. Скло (glass)** (recommended) | `wave: "sine"`, modes `[{ratio 1, gain 1, decayScale 1}, {ratio 2, gain 0.12, decayScale 0.6}, {ratio 3, gain 0.04, decayScale 0.35}]`, `attack: 0.006`, `lowpass: { hz: 5000, q: 0.5 }`, no mallet | Pitches as listed in 5.3 (D5–F♯6) |
| **2. Дерево (wood)** | `wave: "sine"`, modes `[{1, 1, 1}, {3.93, 0.22, 0.3}, {9.2, 0.05, 0.12}]` (the marimba bar's mode ratios), `attack: 0.002`, `mallet: { bandHz: 2500, q: 1.5, gain: 0.18, length: 0.012 }`, `lowpass: { hz: 4200, q: 0.5 }` | Every `hz` and `glideFrom` × 0.5 (one octave down), every `decay` × 0.7 |

Recommendation: palette 1. The typing effect is broadband noise concentrated between 1 and 5.5 kHz (measured in 5.4). Pure tonal sines sit apart from it, so an event sound stays legible over dense typing; the wood palette's mallet strike is itself a short noise click, which is closer to a keystroke. Wood is warmer and lower, and some listeners find it less fatiguing, which is the reason to hear both.

All pitches are in D major (D, E, F♯, A, B), so overlapping sounds never clash.

### 5.3 The sounds

Values for palette 1. `peak` is the linear gain at cue volume 1.0; the default cue volume stays 0.4 (`src/lib/audio/prefs.ts:47`).

| Sound | Gesture | Strikes (`at` s, `hz`, `vel`, `decay` s, extras) | peak | length |
| --- | --- | --- | ---: | ---: |
| S6 your-move | Three notes rising, the last held: "your turn" | (0, 587.33 D5, .75, .6); (0.11, 880 A5, .8, .6); (0.22, 1174.66 D6, 1, 1.4) | 0.50 | 1.5 |
| S7 fault | Three notes falling, slowly beating, over a low drop | Timbre override `detuneCents: 8`. (0, 880 A5, .85, .5); (0.14, 698.46 F5, .85, .5); (0.28, 587.33 D5, 1, 1.1); thud (0, 146.83 D3, .6, .3, `wave: "triangle"`, `glideFrom: 196`, `glideTime: .12`). Sound lowpass 3200 Hz | 0.42 | 1.3 |
| S8 reply | Two notes falling a fourth: the familiar "message arrived" | (0, 1174.66 D6, .8, .5); (0.13, 880 A5, .7, .9) | 0.30 | 1.0 |
| S4 landed | Quick major arpeggio up, the top note shimmering | (0, 587.33, .6, .6); (0.07, 739.99 F♯5, .65, .6); (0.14, 880, .7, .6); (0.21, 1174.66, .9, 1.6, `vibrato: {hz 5, cents 6}`). For a coalesced batch of n lanes add `min(n−1, 3)` grace strikes (0.40 + 0.09k, 1318.51 E6, .3, .4) | 0.32 | 1.8 |
| S5 released | The landed arpeggio over a low swell, ending higher | S4's four strikes; swell (0, 293.66 D4, .5, 2.0, `wave: "triangle"`, `attack: .25`); top (0.42, 1479.98 F♯6, .5, 1.4) | 0.36 | 2.2 |
| S3 step | One short note | (0, 880 A5, .7, .45), first two modes only, sound lowpass 6000 Hz | 0.18 | 0.5 |
| S9 launched | A quick upward glide and a light answer | (0, 880, .6, .25, `glideFrom: 440`, `glideTime: .09`); (0.08, 1174.66, .4, .35) | 0.20 | 0.45 |
| voice-connect / voice-disconnect | Two short notes up / down, as today | (0, 880, 1, .12); (0.09, 1174.66, 1, .12); reversed for disconnect | 0.05 (unchanged, `src/lib/voiceCompanion/cues.ts:11`) | 0.25 |
| dict-warn / dict-stop | One ping / a low fall, pitches unchanged from `src/lib/chime.ts:118` | warn (0, 660 E5, .8, .32); stop (0, 523.25 C5, 1, .3), (0.17, 329.63 E4, 1, .62) | 0.07 (unchanged, `src/lib/chime.ts:155`) | 0.8 |

The contours are what tells the sounds apart, and they stay distinct at any volume: rising and held (S6), falling and beating (S7), two falling (S8), four rising (S4), four rising plus a swell (S5), one note (S3), a glide (S9). The two loudest sounds are the two that need the operator.

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

S2 reuses the S1 slices (or the replica) processed so it sounds like typing in the next room: `BufferSource(playbackRate 0.92) → BiquadFilter(lowpass, 1400 Hz, Q 0.7) → Gain(S1 gain × 0.2, that is −14 dB) → StereoPanner(random −0.3…0.3) → typing bus`. One voice at a time.

Rate: at most one slice every `clamp(8 / √n, 3, 8)` seconds, where n is the number of sessions with a running turn and no on-screen pane. One agent off screen murmurs every 8 s, four every 4 s, seven or more every 3 s, which caps the duty at about 22% at the audit's peak of 26 concurrent intervals. S2 is skipped when S1 played within the last second, since the near layer already says the same thing.

## 6. Timing rules

### 6.1 Rate limits and coalescing

A sound plays only for an event the tab observed after its baseline, and only if the event's own time is less than 2 minutes old where the source records one (5 minutes for deploy items, section 4.3). Older events are absorbed silently: a sound that arrives after the thing has been on screen for minutes is noise.

| Sound | Identity | Coalescing window | Minimum gap after the last play | Cap |
| --- | --- | --- | --- | --- |
| S6 your-move | Obligation key (4.1) | 3 s: a burst of entries is one sound | 5 s; entries arriving inside the gap produce at most one more play at its end | 6 per minute |
| S7 fault | Entry id or done-item key | 3 s | 10 s | 3 per minute |
| S8 reply | Conversation and turn | 1.5 s | — | — |
| S5 released | Deployment id | — | — | — |
| S4 landed | Pipeline id | 5 s; n lanes in the window add grace notes | 8 s | — |
| S3 step | Pipeline, stage and attempt | 2 s | 6 s | 6 per minute; dropped when S4 for the same pipeline plays within 10 s |
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

A higher sound arriving while a lower one plays cuts it with a 40 ms fade and starts at once. An equal or lower sound arriving while another plays is dropped, unless its class allows one pending play after a gap (S6). Typing never competes for the event lane.

### 6.3 Levels

| Layer | Peak at cue volume 1.0 | At the default 0.4 |
| --- | --- | --- |
| S6 your-move | 0.50 (−6 dB) | −14 dB |
| S7 fault | 0.42 | −15.5 dB |
| S5 released | 0.36 | −16.9 dB |
| S4 landed | 0.32 | −17.9 dB |
| S8 reply | 0.30 | −18.4 dB |
| S9 launched | 0.20 | −22 dB |
| S3 step | 0.18 | −22.9 dB |
| S1 typing | gain 0.5 × slice (slice max −4 to −12 dB) | about −18 to −26 dB peaks, −46 to −49 dB mean |
| S2 distant typing | S1 × 0.2 | about −32 to −40 dB peaks |

### 6.4 Ducking

While an event sound plays, the typing bus ramps to 0.35 (−9 dB) over 20 ms and back over 400 ms after the sound's `length`. S6 and S7 also duck the opt-in music bed, as priority cues do today (`onPriorityCue`).

## 7. "Work is going on"

The operator hears work as typing: close and clear for the conversations on screen (S1), muffled and sparse for the agents off screen (S2). Both are triggered only by real tool calls, so silence means no agent is calling tools, and the density follows the amount of work. Nothing plays because a process merely exists, so the near-continuous activity the audit found produces a murmur that thickens and thins with the work, and stops when work stops.

Progress and results come on top as short tonal sounds: a step (S3), a landing (S4), a release (S5). What needs the operator is louder and different in contour (S6, S7).

## 8. Context rules

| Context | Behaviour | Why |
| --- | --- | --- |
| Visible, focused desktop tab | Everything | — |
| Hidden desktop tab | Event sounds S3–S9 play; S1 and S2 stop | A hidden desktop tab keeps the board feed at a 30 s cadence and the runtime stream (`src/lib/client/hiddenTraffic.ts:31`) so the operator learns of results while working elsewhere; typing from a tab nobody looks at is background noise in another application. Batches from the slower cadence fall into the coalescing windows. |
| Two Delegatus tabs on one device | Event sounds play only in the tab that most recently had focus (a `localStorage` key holding a tab id and time, written on focus and on becoming visible, read through the existing `storage` listener); typing plays in each visible tab for its own panes | One device, one sound per event. |
| Phone, visible | S1 for the open conversation and every event sound; S2 off | Small speaker, battery, one conversation on screen. |
| Phone, hidden | Nothing; the transport suspends after 30 s (`HIDDEN_SUSPEND_MS`) | Telegram notifies the phone. |
| A voice call is connected (`setVoiceConnected`, `src/lib/audio/app.ts:151`) | S1, S2, S3 and S9 off; S4–S8 at −6 dB | The companion is speaking; only results and obligations interrupt it. |
| Before the first gesture | Nothing plays; sounds requested are dropped (autoplay policy), as today | Unchanged. The first `pointerdown`/`keydown` resumes the context (`src/lib/audio/app.ts:213`). |
| iOS silent switch on | Web Audio is muted by the system | Platform behaviour; noted in the settings hint text only if the operator asks. |

## 9. Off switch and settings

The existing master switch keeps governing all product audio on this device (`llvSound`, `src/lib/audio/prefs.ts:19`; desktop menu `src/components/ProjectDashboard.tsx:2132`; header and phone `src/components/headerMenu/HeaderMenu.tsx:337`). The cue volume slider keeps its role. The settings panel (`src/components/SoundToggle.tsx:61`) gains one checkbox, «Звук роботи агентів» / "Agent typing", stored as `llvAudioTypingEnabled`, default on, which turns S1 and S2 off together. It is the one frequent layer, so it is the one an operator may want off while keeping results and questions. No new menu or control surface is added.

The opt-in background music for calls and the Viewer (`public/audio/ambient/voice-call-loop.wav`, `src/lib/audio/loopAsset.ts:15`) is music with its own switches and default off; it voices no event and is unchanged. The listening form asks whether to remove it too.

## 10. Busy-hour check

The audit's busiest tool hour, 2026-10-15 14:00 UTC, in its five-minute bins, under the rules above (machine-wide, so an upper bound for one tab):

| Sound | Source events in the hour | Plays after the rules |
| --- | ---: | ---: |
| S3 step | 29 stage passes, at most 5 per bin | at most 29; the bins cannot show how many fall inside one 2 s window or 6 s gap, so the coalescing can only lower this |
| S6 your-move | 3 stages needing a decision, 1 form | at most 4, fewer where a form and a parked stage share a task |
| S4 landed | 4 merge confirmations | 4 |
| S5 released | 1 deploy succeeded | 1 |
| S7 fault | 16 stage failures (all silent by rule) | 0 from stages; launch failures in that hour are not split out in the bins |
| Total event sounds | | at most about 38, one every 95 s on average |
| S1 / S2 | 3,614 tool calls | S1 for on-screen panes only; S2 at most one slice per 3–8 s |

Average over W: S3 10.1/h + S6 about 1.5/h + S4 1.6/h + S5 0.4/h + S7 about 1/h, plus the operator's own S8 and S9, comes to about 15 event sounds per hour across every project. The current scheme, from the same audit rates, can produce around 176 per hour.

## 11. Placement critique (acceptance 3)

Each insertion point checked for frequency, overlap and meaning. "Fixed" names the change the design made after the check failed.

| # | Insertion point | Frequency | Overlap | Meaning | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | `useAgentChimes` waiting → attention (`src/hooks/useAgentChimes.ts:13`, `:90`, `:205`) | Up to 46/h of root turn ends, 16/h of them orchestrator ticks | Duplicates the needs-you queue for real questions | Fails: a finished turn is labelled "needs you" | **Fixed:** removed. Real questions come from the needs-you queue (S6); the operator's own conversations answer with S8. |
| 2 | `useAgentChimes` spawned → launch (`:109`) | 21–23/h | A late parent link rings for an old process | Fails | **Fixed:** removed. Only this device's own launch sounds (S9). |
| 3 | `useAgentChimes` returned → success, stalled → failure (`src/lib/audio/cues.ts:118`) | Per subagent return; stalls unknown | Stalled overlaps real failures that the queue carries | Fails: mid-work news, and an inference voiced as a failure | **Fixed:** removed. Planner and hook are deleted once nothing maps to them. |
| 4 | Viewer MCP calls → `viewer-mcp` (`src/lib/audio/toolCues.ts:35`) | 109/h, 1,204 in its busiest hour, 25 in 10 s | Same stream as typing | A distinct cue at continuous rates for plumbing | **Fixed:** folded into S1. |
| 5 | Tool calls → typing (`src/components/LogFeed.tsx:885`, `src/hooks/useToolActivityCues.ts:52`) | Up to 52 in 10 s | Shared the three-voice pool with every event cue | Passes | **Kept;** own pool, ducks under event sounds, Viewer MCP included. |
| 6 | Needs-you queue → S6/S7 (new, `src/components/Viewer.tsx:1070`) | About 2/h of obligations | A parked stage and its form can arrive in different polls | Passes: the product's own "needs you" | **Fixed:** obligation key per task with a 10-minute memory (4.1). |
| 7 | Own launch result → launched / failure (`src/components/DraftAgentPane.tsx:650`) | Bounded by the operator's own launches | A failed launch also enters the queue as reason `launch` under a different id | The failure would sound twice | **Fixed:** the card plays S9 for `launched` only; the queue's `launch` reason plays S7. The implementation adds a test that a failed operator launch reaches the queue. |
| 8 | Attention offers and directed requests (`src/components/overlay/useAttentionOffers.ts:373`, `src/components/attention/AttentionHost.tsx:340`) | 0.13/h | An offer can point at an obligation the queue already carries | Passes: an agent asks the operator to look | **Kept as S6**, sharing the S6 coalescing window and gap. |
| 9 | Pipelines → S3 step (new, beside `src/components/Viewer.tsx:445`) | 10/h, 3 in 10 s | The last stage passing and the merge can be close | Passes: progress | **Fixed:** S4 for the same pipeline within 10 s replaces S3. |
| 10 | Stage failures | 5.2/h, 8 in 10 s | Repairs follow at once (4.4/h) | Fails as "fault": the review loop is working | **Fixed:** silent. A failure with nowhere to go reaches S6 or S7 through the queue. |
| 11 | Pipelines → S4 landed (new) | 1.6/h, 3 in 10 s from batch merges | Merge then `completed` for the same lane | Passes | **Fixed:** keyed by pipeline id; a batch coalesces with grace notes. |
| 12 | Done feed → S5 released and deploy/limit faults (new, `src/components/Viewer.tsx:1075`) | 0.42/h | The deploy restarts the Viewer, so the item lands in a baseline read | The sound would be lost | **Fixed:** fresh items sound on a baseline read; heard keys persist in `sessionStorage` (4.3). |
| 13 | Runtime stream → S2 (new, `src/hooks/runtimeBus.ts:567`) | Up to 1,632/h of items, 26 concurrent intervals | On-screen panes also ring S1 | Passes if sparse | **Fixed:** off-screen sessions only, rate formula, skipped right after S1, off when hidden and on phones. |
| 14 | Runtime stream → S8 reply (new) | Bounded by sends | A seat's own ticks end turns too | Passes only for turns the operator is waiting on | **Fixed:** limited to the "awaiting reply" set filled by this tab's sends. |
| 15 | Master switch preview (`src/components/SoundToggle.tsx:52`) | Per toggle | — | Previewed `success`, a sound now gone | **Fixed:** previews S3. |
| 16 | Voice-call and dictation cues (`src/lib/voiceCompanion/cues.ts:64`, `src/hooks/useDictation.ts:243`, `:596`) | 0.04/h calls; dictation unrecorded | None | Passes | **Kept;** same pitches, rendered by the shared engine. The companion keeps its own context, opened on the Talk tap. |
| 17 | Tab title count (`src/components/Viewer.tsx:1128`) | — | Reads the same queue as S6/S7 | — | Unchanged; the sound and the badge now agree by construction. |

## 12. Change list for the implementation lane

| Where | Change |
| --- | --- |
| `src/lib/audio/synth.ts` (new) | The spec types, the renderer (5.1), both palettes (5.2), the sound table (5.3), the typing replica (5.4) and the distant-typing chain (5.5). |
| `src/lib/audio/cues.ts:19`, `:50`, `:67`, `:118` | `AudioCue` becomes the nine sound ids; `CUES` keeps only the typing slices as files; `TIER_GAIN` becomes the level table (6.3); `CUE_OF_LIFECYCLE` is deleted. |
| `src/lib/audio/cuePlayer.ts:77`, `:132` | Two pools: typing (3 voices) and the event lane (6.2); per-class coalescing windows, gaps, caps and the staleness rule (6.1); the one-pending-play rule for S6. |
| `src/lib/audio/webAudioTransport.ts:209` | The cue transport starts either a typing buffer or a synth spec on the right bus; adds the two buses, the limiter and the typing duck (6.4). |
| `src/lib/audio/app.ts:106`, `:151`, `:213` | `playCue` takes the new ids; the voice-call rule (section 8); warming only the eight typing files. |
| `src/lib/audio/prefs.ts:19`, `:47`, `:112` | `llvAudioTypingEnabled`, default on. |
| `src/lib/audio/toolCues.ts:35` | Every tool call is typing. |
| `src/hooks/useToolActivityCues.ts:52` | Skip when the typing switch is off, the document is hidden, or a voice call is connected. |
| `src/hooks/useAgentChimes.ts` (whole file), `src/components/Viewer.tsx:445` | Replaced by `useWorkCues(needsYou, pipelines, doneItems, scope, certified)`: pure planners for the queue (4.1), pipelines (4.2) and done items (4.3), with the same scope-certification and baseline rules `planScopedAgentChimes` has today. |
| `src/hooks/useFleetCues.ts` (new), mounted once in `Viewer` | Runtime-bus subscriber for S2 and S8 (4.4). |
| `src/hooks/useRuntime.ts:347` | A successful send adds the conversation to the "awaiting reply" set. |
| `src/lib/chime.ts:45`, `:118`, `:155`, `:187` | Export `paneMounted(id)` beside `registerPane`; delete the lifecycle tunes; route `dictWarn`/`dictStop` through the engine. |
| `src/lib/voiceCompanion/cues.ts:9`, `:64` | Render connect/disconnect from the engine's specs on the companion's own context. |
| `src/components/DraftAgentPane.tsx:650` | `launched` only. |
| `src/components/overlay/useAttentionOffers.ts:373`, `src/components/attention/AttentionHost.tsx:340` | Play S6 with the attention request id. |
| `src/components/SoundToggle.tsx:52`, `:61` | Preview S3; the typing checkbox (section 9), with en and uk strings. |
| `public/audio/cues/` | Delete `attention.mp3`, `failure.mp3`, `launch.mp3`, `success.mp3`, `viewer-mcp.mp3`; keep `tool-tick-1..8.mp3` unless the operator picks the replica. |

Tests the implementation owes (by explicit path, isolated state, per the project's instructions): the planners' baseline, scope-switch and staleness cases; the obligation-key memory; S4 superseding S3; the fresh-deploy-after-reload case; a failed operator launch reaching the queue; the player's windows, gaps, caps and priority cut; the hidden-tab, phone and voice-call gates; S2 counting only sessions without a mounted pane; and the existing `cuePlayer`, `toolCues`, `cues`, `chime` and `useAgentChimes` tests rewritten to the new ids. Rendered evidence for the one settings checkbox goes through the existing header and phone drivers, in en and uk, light and dark.

## 13. What the prototype and the form need from this document

The prototype page (acceptance 4) plays every sound in 5.3 in both palettes from the specs above, the original typing slices beside the replica, S2 at one, four and seven off-screen agents, and a simulated busy hour: the twelve five-minute bins of the audit's busiest hour, with events placed uniformly at random inside each bin, all of the bin's tool calls sent to S1 for two on-screen conversations and S2 for the rest, and every rule of section 6 applied. The rendered MP4 files show the same.

The listening form (acceptance 5) asks, each with an "other" answer:

1. **Palette:** 1 Скло (recommended), 2 Дерево.
2. **Typing:** the original eight files (recommended), the synthesized replica.
3. **Which events are voiced** (multi-select, all recommended ticked except the last): S2 distant typing; S3 step; S4 landed; S5 released; S6 your move; S7 fault; S8 reply; S9 launched; also remove the background music file.
4. **Start implementation** with these answers: yes (recommended), not yet.

## 14. Check against the requirement

- *Audit which events exist and how often:* every voiced and silent family above cites the audit's rate; section 10 replays the busiest hour.
- *Different sounds for the events:* nine sounds with distinct contours, two of them loud for the two classes that need the operator.
- *The sounds that play during orchestrator activity:* orchestrator ticks no longer ring the loudest cue (critique rows 1 and 4).
- *Redo from scratch; the rest can go:* five sample cues are deleted; every new sound is synthesized code.
- *Sounds written as code, with critique of where they go:* section 5 gives the parameters, section 11 the critique.
- *Follow real usage:* coalescing windows and gaps are sized to the audit's measured bursts.
- *Every sound tells the operator that work is going on:* each sound fires only on a real event of its meaning; the continuous layer is real tool activity, and it stops when work stops.
- *Keep the typing effect:* kept byte for byte, with a replica only as a listening option.

No ADR: every decision here is a code-level choice reversible in one lane.

## Deferred — not currently justified

- Repeating a reminder sound for an obligation left unanswered: the badge and the tab title already persist, and a repeating sound is the classic fatigue source.
- Per-event or per-project sound settings beyond the one typing switch: no evidence the operator wants more controls, and the project prefers reusing existing ones.
- Spoken announcements (text to speech) for events: a separate feature with its own costs.
- Sounds for seat checks, deliveries, quota probes, Telegram sends, bridge status reports, task moves and permission denials: silent by the frequency and meaning rules above.
- A cross-device leader so only one device plays: devices are device-local by design (`src/lib/audio/prefs.ts`), and the operator's desk and phone are usually in different places.
- Recording which sounds actually played: the audit notes the gap; the design does not need it to be judged by ear.
- Replacing the opt-in music loop with synthesized music: it voices no event; the form asks only whether to remove it.
- Pitch or pan encoding of which project or lane an event belongs to: more to learn for the operator, and the existing pane panning already places on-screen sounds.
