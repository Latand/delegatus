# Operator attention: can a cheap classifier flag agent messages that need the operator?

Research and a bounded paid evaluation, 2026-09-26. Nothing in the product
changed. Live state was read from copies or through read-only SQLite handles
(`mode=ro&immutable=1`), and the stage host was read the same way over SSH.
The only outward calls were the classifier requests described in section 4,
with total spend confirmed against the provider's key ledger.

## Originating requirement

Verbatim from the pinned specification of this pipeline stage (2026-09-26,
source: the stage's pinned task, which paraphrases the operator):

> The operator's problem (paraphrased): information about agents is scattered
> (board, reports log, chats), so it is hard to know which agent needs them
> right now. Idea: classify every agent TEXT message (not tool calls) from
> every agent with a cheap model, to know at once whether an agent needs the
> operator's attention or has something important; use that to fill the
> reports log more often, make it a bit interactive (jump to the agent), and
> surface decisions. Before building anything, prove the classifier works and
> price it.

The requirement asks for proof and a price before any build. The default
answer to "should we build this" stays no until section 7 argues otherwise.

## Answer in brief

- **What works.** Jev (TypeSafe `jev-1.13` through OpenRouter) reliably spots
  the agent message that *asks* the operator for something: a question, a
  decision, a permission, a login, a command only the operator can run. On
  382 labelled messages it reaches AUC 0.95. At a 0.85 threshold it has
  precision 0.82 and recall 0.77. At a 0.5 threshold it caught 63 of the 64
  asks the operator later answered and 21 of the 24 asks nobody answered in
  the chat. Reading
  the false positives again, 11 of 15 were real asks the operator skipped, so
  the true precision is closer to 0.95.
- **What cannot work from text.** In 77 of the 197 cases where the operator
  acted on a message (39%), the operator *corrected* an agent whose message
  looked routine: a claimed "it's running" when nothing ran, the wrong model
  or account, work stopped too early. The text carries no sign of the
  problem, and every classifier tried flags those cases at about the noise
  rate. No model at any price fixes this part.
- **Price does not matter.** Classifying every turn-ending agent message on
  this machine and the stage host costs about **USD 0.73 a month** with Jev.
  Classifying every agent text message costs about **USD 3.3 a month**.
  Latency is 0.34 s median and 0.47 s p99 from this machine.
- **The gap is real.** In the replayed week, agents asked the operator in
  prose in about 17 conversations a day (42 messages). In the same week
  orchestrators filed 24 declared asks (`bridge_report` `question`/`blocked`)
  in total. The existing needs-you model (`docs/design/needs-attention.md`)
  sees structured asks only, so the prose asks raise nothing.
- **Decision:** build a narrow slice (section 7). Classify only turn-ending
  messages, in projects the operator opted in. Feed the result into the
  existing needs-you reasons and the reports log with a jump link. Do not
  classify every message: mid-turn messages are 81% of the volume, and in
  the samples Jev flagged 0–2.5% of them.

## 1. The stream

Source: the Viewer's transcript search index (`transcript-search.sqlite`,
opened immutable read-only). Agent text messages are the indexed `assistant`
bodies: tool calls and tool results are not indexed. "Turn-final" means the
agent message is followed by a user-side message or ends the transcript, so
the agent stopped and waits. That is the only point at which it can need
someone.

| Scope | Window | Agent text messages | Per day | Turn-final | Turn-final per day |
|---|---|---:|---:|---:|---:|
| This machine | 30 days (to 2026-09-26) | 58,605 (Claude 29,902, Codex 28,693, Copilot 10) | 1,954 | 11,127 (19%) | 371 |
| This machine | last 7 days | 21,210 | 3,030 | 3,161 | 452 |
| Stage host (read-only over SSH) | last 7 days (30 days: 8,944; it became busy this week) | 8,909 | 1,273 | 1,412 | 202 |
| **Both** | last 7 days | **30,119** | **4,303** | **4,573** | **653** |

Shape of the local 30-day stream:

- **Days.** The busiest day had about 4,670 messages and the quietest about
  200. The busiest single hour had 822.
- **Hours (Kyiv).** Every hour of the day is active. The lowest hour is 05:00
  with 719 messages over 30 days and the highest is 11:00 with 3,478. The
  00:00, 01:00 and 02:00 slots still hold 2,100–2,500 each, so agents keep
  talking while the operator sleeps.
- **Projects.** 27 project keys were active. Delegatus (this repository) has
  68.2% of the messages. The next five have 11.0%, 7.7%, 4.6%, 4.2% and 2.3%,
  and the other 21 share 2.0%.
- **Sizes.** All messages: mean 467 characters, median 193, p90 806, p95
  2,129, max 27,249. Turn-final messages are longer: mean 1,464, median 653,
  p90 3,599.
- **Tokens.** Measured on Jev's counter over 4,600 calls, a call costs
  **≈ 462 + 0.42 × characters** input tokens. That is about 2.4 characters per
  token for this mostly Ukrainian and Russian text, plus a fixed overhead for
  the question and its criteria. The Gemini tokenizer counts ≈ 99 + 0.325 ×
  characters for the same prompt. A turn-final message averages about 860 Jev
  tokens per call.

## 2. The classifier: Jev

The earlier Delegatus research (`git show a66d8b287:docs/research/jev-integration.md`,
lane 3ce59035, 2026-09-19) describes Jev from vendor documentation:
TypeSafe AI's "System One" model, which returns typed answers only. A
`choice` question returns a probability per option and a confidence. A
`noul` question returns the probability that a statement is true. That
research found no API key on the machine and made no paid call.

Celestia's antispam Tier-0 (Celestia PR #3092, merged 2026-09-20) is the
working integration, and this evaluation copied its call exactly:

- **Model:** `typesafe/jev-1.13`. The response names the served snapshot
  `jev-1.13-20260917`.
- **Provider and route:** OpenRouter's alpha decisions endpoint,
  `POST https://openrouter.ai/api/alpha/decisions`, with body
  `{ model, state, questions }` and the application's existing OpenRouter key.
  The response is `{ answers, usage: { input_tokens, output_tokens, cost } }`.
- **Celestia's usage.** One `choice` question (allow / block / unclear), then a
  second `choice` for the category. The confidence gate is 0.65, the timeout
  2 s, and the feature is disabled by default. Uncertain or failed answers
  fall back to the existing LLM chain. Celestia measured p50 0.68 s inside its
  pipeline and an accuracy of 98.15% for the combined chain on 704 cases.
- **Price.** USD 0.042 per million input tokens, and output is free. This was
  confirmed on every call made here: `cost` equals `input_tokens × 0.042e-6`
  exactly. A request with four questions bills the state once: the four-question
  variant cost the same as the one-question variant.
- **Latency from this machine (Ukraine).** Over 4,591 calls, p50 was 0.34 s,
  p95 0.40–0.45 s, p99 0.47 s and max 0.82 s. There were no errors and no
  retries.

**Suitability.** Jev is suitable (section 4). The vendor's documented
weaknesses show up where expected: literal reading, lower recall on
unrelated context, and lists that read as informational. None of them blocks
this use. The cheapest alternative measured is Gemini 2.5 Flash-Lite. It
costs about the same per message, but it ranks worse (AUC 0.86 against 0.95)
and returns a bare word with no probability to set a threshold on. Claude
Haiku 4.5 costs 13 times more and scored lower still. The only reason to
switch would be dropping the dependency on a one-week-old vendor, and Flash-Lite
is the fallback for that case.

## 3. Ground truth

### Who the operator is

A reply counts as the operator's only when the Viewer recorded it that way.
For Codex, that is the structured-user marker the Viewer writes into the
rollout. For Claude, it is the per-session delivery ledger
(`claude-delivery-ledger/<session>.jsonl`, `origin.kind = "operator"`),
matched to the transcript by message text. Over 45 days this yields 1,955
pairs of an agent message followed directly by an operator message.

Two artefacts had to be handled:

- **The voice relay prepends a digest.** "While you were away the manager
  reported … Do not read this list aloud." comes before the operator's own
  words. The words after the digest were labelled.
- **Relays and automations carry operator-looking markers.** These include
  review-loop findings pasted into a builder's chat, "continue the
  interrupted turn" notices, pasted third-party chat logs, and orchestrator
  notes. 65 of 340 sampled pairs (19%) were of this kind and were excluded
  (label X).

### Labelling rule

Each sampled agent message A got one label, set by reading the operator's
next message O in the same conversation:

| Label | Meaning | Count |
|---|---|---:|
| Q | O answers a question or decision A put to the operator, or does what A asked for (enter a code, run a command, send output) | 64 |
| A | O approves, rejects or adjusts a plan A stated ("go", "merge when approved", "use another account") | 27 |
| C | O corrects the agent's actions or claims ("nothing is running", "wrong model", "why did you stop") | 77 |
| R | O acts on important content in A (asks a follow-up on its result, sends it on, reacts to a failure) | 29 |
| N | O starts something unrelated, pings for status, or says "continue"; or A was routine and no operator message followed (mid-turn narration, stage reports, seat-tick reports) | 294 |
| U | No operator reply in the conversation, but A plainly asks the operator for something ("say go", "waiting for your decision", "run this command") | 24 |
| X | O was not written by the operator | 65 |

"Needs attention" under the specification's definition is Q ∪ A ∪ C ∪ R (197
messages). "Explicit ask", the part a text classifier can see, is Q ∪ U (88).
The negatives are N (294). U cannot be a clean negative, because the agent
really did ask. It is scored as a positive in the explicit-ask metric and
left out of the broad one.

### Sample

580 messages from the last 45 days, drawn round-robin across projects with a
per-project cap so that no single project dominates. They cover 29 project
keys and both engines (plus 3 Copilot messages):

- 340 messages the operator answered directly;
- 100 turn-final messages followed by a machine prompt (seat tick, task
  notification, pipeline instruction);
- 60 messages that ended their transcript;
- 80 mid-turn messages.

515 remained after exclusions. The sample is deliberately **not**
stream-representative: Delegatus is 68% of the stream and about 10% of the
sample. The week replay in section 5 gives the representative rates.

### Error sources

1. **The operator answers elsewhere or not at all.** An ask answered in the
   seat, on the board, by voice or in Telegram, or simply ignored, looks like
   N. Of the 15 false positives at threshold 0.85, 11 were real asks of this
   kind. The U label catches the plain cases, and the measured precision is a
   lower bound.
2. **One labeller.** Every label was set by one agent reading both messages,
   with no second rater. The R/N and A/N boundaries are judgment calls. Q and
   U are the least ambiguous.
3. **Corrections depend on the agent's actions, not its words.** A C label
   says the operator had to intervene. It does not say the message showed
   any sign of trouble.
4. **Origin attribution.** A relay recorded with an operator marker and missed
   by the X pass would add noise to the positives.
5. **Clipping.** Messages over 4,000 characters were sent as the first 1,000
   plus the last 3,000 characters, after redaction.

## 4. Evaluation

### Setup

Each message was sent as `state: { agent_message }` after redaction. Emails,
key-shaped strings, long opaque tokens and home paths were replaced with
placeholders, and memory-citation blocks were stripped. No project, role or
conversation context was added. Four classifiers ran on the same 515
messages, and two zero-cost heuristics ran as baselines:

- **Jev V1:** one `choice`: `needs_operator` / `routine`, with one criterion
  sentence each. The score is the probability of `needs_operator`.
- **Jev V2:** four `noul` statements: "asks the operator a question or asks
  them to reply, choose, confirm or approve", "is stopped or waiting until the
  operator acts", "presents options and leaves the choice to the operator",
  and "reports that the agent itself failed, hit a limit or lost auth". The
  score is the maximum of the first three. Adding the fourth changed nothing
  at the chosen threshold.
- **Gemini 2.5 Flash-Lite** and **Claude Haiku 4.5:** the V1 wording as a
  prompt, answering one word, at temperature 0.
- **Heuristics:** "a question mark in the last 500 characters", and the same
  plus a Ukrainian/Russian/English keyword list ("say the word", "your call",
  "waiting for you", "confirm", "permission", "options", …).

### Explicit asks (Q ∪ U = 88 against N = 294)

| Classifier | AUC | Threshold | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|
| Jev V2 | **0.954** | 0.70 | 0.71 | 0.91 | 0.80 |
| Jev V2 | | **0.85** | **0.82** | **0.77** | **0.80** |
| Jev V2 | | 0.90 | 0.84 | 0.74 | 0.79 |
| Jev V1 | 0.943 | 0.85 | 0.73 | 0.80 | 0.76 |
| Gemini 2.5 Flash-Lite | 0.856 | (binary) | 0.58 | 0.91 | 0.71 |
| Claude Haiku 4.5 | 0.826 | (binary) | 0.60 | 0.82 | 0.69 |
| Question mark | 0.590 | (binary) | 0.81 | 0.19 | 0.31 |
| Keywords + question mark | 0.707 | (binary) | 0.37 | 0.86 | 0.51 |

Agents rarely end on a question mark: they write "say the word and I'll
merge". That is why the punctuation rule misses four asks in five. Keywords
catch the asks but flag a third of all turn-final messages.

By script, for Jev V2 at 0.85: Cyrillic messages (222, 69 asks) had AUC 0.94,
precision 0.81 and recall 0.83. English messages (160, 19 asks) had AUC 0.96,
precision 0.85 and recall 0.58. The vendor warns about non-English accuracy,
but it did not show up here. The lower English recall comes from seat-tick
reports that bury a standing ask in their last line.

### The specification's broad definition (Q ∪ A ∪ C ∪ R = 197 against N = 294)

| Classifier | AUC | Best F1 (threshold, P, R) | Precision and recall at 0.5 |
|---|---:|---|---|
| Jev V2 | 0.742 | 0.64 (0.25, 0.60, 0.70) | 0.67 / 0.56 |
| Jev V1 | 0.725 | 0.62 (0.10, 0.57, 0.69) | 0.68 / 0.51 |
| Flash-Lite | 0.683 | 0.61 | 0.66 / 0.56 |
| Haiku 4.5 | 0.635 | 0.52 | 0.64 / 0.44 |

Flag rate at 0.5 per label, Jev V2:

| Label | Flag rate |
|---|---:|
| Q (answered asks) | 63/64 |
| U (unanswered asks) | 21/24 |
| R (acted on content) | 13/29 |
| A (plan approved or adjusted) | 7/27 |
| C (corrections) | 25/77 |
| N, mid-turn | 2/80 |
| N, turn-final with no reply | 25/136 |
| N, operator moved on | 25/78 |

The ceiling on the broad definition comes from the task, not from the model:
A and C messages look like the N messages. A stronger and 13 times dearer
model (Haiku) scored lower.

### Confusions (paraphrased; no message text)

**False positives at 0.85.** Eleven of the fifteen were asks the operator
skipped. The four genuine ones:

- a deploy plan that sets a merge order and says it will not merge without
  green CI;
- a seat report listing what the next tick will pick up;
- a report that lanes were moved to "awaiting decision", with no question to
  the operator in the message itself;
- a report that the agent cannot spawn workers until a channel returns. This
  one is borderline, because it is a blocker.

**Misses at 0.85:**

- device-login codes the operator had to enter before they expired, which
  read as an informational list (0.41);
- standing reminders at the end of a tick report ("everything still waits on
  your four decisions", "both blockers are on you", 0.23–0.82);
- engine error strings: session limit reached, OAuth refresh failed
  (0.53–0.83);
- a recommendation list of logo variants that implied a choice without
  asking for one (0.76).

**Corrections, which no text classifier can catch:**

- an agent reports a worker as running while nothing is running;
- an agent picked a model or account the operator had ruled out;
- a status report that stops short of work the operator expected finished.

### Latency and spend

Latency p50/p95/max on the labelled set:

| Classifier | p50 | p95 | Max |
|---|---:|---:|---:|
| Jev | 0.34 s | 0.45 s | 0.82 s |
| Flash-Lite | 0.40 s | 0.75 s | 1.33 s |
| Haiku | 0.87 s | 1.15 s | 10.9 s |

Spend was capped at USD 2.00 in the runner and USD 3.00 on the key. The
actual total was **USD 0.4249**, and the key's usage counter moved by exactly
that amount:

| Calls | Classifier | Cost |
|---|---|---:|
| 515 | Jev V1 | USD 0.0193 |
| 4,076 | Jev V2 (labelled set, a 400-message stream sample, and the full week replay) | USD 0.1468 |
| 515 | Flash-Lite | USD 0.0207 |
| 515 | Haiku 4.5 | USD 0.2480 |

## 5. What a live classifier would have flagged: one replayed week

All 3,161 local turn-final messages from 2026-09-19 to 2026-09-26 went
through Jev V2 (cost USD 0.115):

| Threshold | Flagged messages | Per day, mean (max) | Distinct conversations per day, mean (max) |
|---|---:|---:|---:|
| 0.80 | 388 (12.3%) | 48 (88) | 19 (30) |
| 0.85 | 335 (10.6%) | 42 (76) | 17 (25) |
| 0.90 | 267 (8.4%) | 33 (54) | 14 (18) |

At 0.85, 127 flagged messages got a direct operator reply, after a median of
6 minutes (p75 14 minutes; 16 waited more than 30 minutes). The other 208,
across 103 conversations, got no direct reply. They were answered elsewhere,
went stale, or were missed, and that is the set a queue would surface.
Declared asks in the same week (`bridge_report` classes `question` and
`blocked`) totalled 24. Flags come at every hour, with small peaks around
01:00, 09:00 and 12:00 Kyiv.

In a random 100-message sample of mid-turn messages from the same week, Jev
flagged 2 at 0.5 and none at 0.85.

## 6. Cost projection

Jev at USD 0.042 per million input tokens, token counts from the formula in
section 1, volumes from the last week (this machine plus the stage host).
Thirty-day months:

| Scope | Calls per day | Tokens per day | USD per day | USD per month |
|---|---:|---:|---:|---:|
| Every agent text message | 4,303 | 2.64 M | 0.111 | **3.33** |
| Turn-final messages only | 653 | 0.58 M | 0.024 | **0.73** |
| Turn-final, filtered (below) | ≈ 520 | ≈ 0.46 M | 0.019 | **≈ 0.58** |

The filtered scope skips four kinds of turn-final message, measured on the
week. Together they remove 20% of the calls and 10% of the flags:

- structured stage endings such as `REVIEW_READY`, `VERDICT:` and verdict JSON
  (15%). Lanes already surface their own decisions.
- bodies under 30 characters (4%);
- engine error strings, which should be a deterministic reason instead;
- exact duplicate bodies.

For comparison, turn-final messages only:

| Classifier | USD per month |
|---|---:|
| Gemini 2.5 Flash-Lite | about 0.8 |
| Claude Haiku 4.5 | about 9.5 |
| Claude Haiku 4.5, OpenRouter batch route (50% off, but delivery becomes asynchronous) | about 4.8 |

Other levers:

- **Batching several messages into one Jev request.** Each message would need
  its own question over a combined state, and the vendor's weakness #6 says
  accuracy falls with unrelated context. The saving is below USD 0.30 a
  month, so it is not worth it.
- **Caching.** Jev has none to use, and the fixed overhead (≈ 460 tokens per
  call) is already most of the bill.
- **Headroom.** A tenfold growth in agent traffic still costs under USD 35 a
  month for every message. The busiest local hour had 822 messages, about 14
  a minute, against a rate limit of 1,200 requests per minute.

## 7. Product sketch and decision

Validated against the quoted requirement. The existing needs-you model
(`docs/design/needs-attention.md` §2) raises a card for structured asks:
`AskUserQuestion`, `ExitPlanMode`, permission prompts, a bridge `question` or
`blocked`, and lanes in `needs_decision`. The reports log
(`src/lib/bridge/reportLog.ts`) shows what orchestrators file. Neither sees an
agent that ends its turn with "say go and I'll merge". Section 5 measured
that case as the common one.

**Build this, narrowly:**

1. **Trigger.** When a Delegatus-hosted turn ends, take the final agent text
   message, apply the section 6 filters, and skip the call if a structured
   reason already holds for that conversation. Classify with Jev V2 at 0.85,
   with a 2 s timeout. A timeout or error means no flag, and nothing retries.
2. **Scope.** Opted-in projects only, off by default. The switch follows the
   per-project report setting from #2242. The text leaves the machine for a
   US vendor with an open-ended retention clause (see the Jev research §2), so
   it gets the same redaction the eval used.
3. **Signal.** Add one conversation reason kind, `ask`, beside `question` and
   `plan`. Its label is "Asks you · ‹role›", and its header is the message's
   last sentence (the agent's own words; nothing is generated). The decision
   `noul` at ≥ 0.85 names it "Decision". One open ask per conversation. It
   clears when the operator writes to that conversation, when the agent
   speaks again, or on the existing Dismiss.
4. **Reports log.** Each new ask becomes one line: "‹agent› needs you: ‹last
   sentence›", with a jump link that opens the conversation. It is collapsed
   per conversation, so the log gains about 17 lines a day (25 on the busiest
   day) instead of 42.
5. **False positives.** A wrong flag costs one glance and one Dismiss. No
   action is ever taken on a flag, and a lane never settles or advances on
   one. Count dismissals per project, and raise the threshold if more than
   about a third of flags are dismissed.

**Validation against the requirement:**

- "Know at once which agent needs you": prose asks join the one needs-you
  queue.
- "Fill the reports log more often": one line per new ask.
- "A bit interactive (jump to the agent)": the jump link.
- "Surface decisions": the decision `noul` names them.
- "Classify every agent text message": deferred, with the measurement below.

## Deferred — not currently justified

- **Classifying every text message, including mid-turn ones.** That is 81% of
  the calls, and Jev flagged 0–2.5% of mid-turn messages. A mid-turn ask is
  followed by more work in the same turn.
- **Flagging messages the operator will need to correct.** The text does not
  carry it (C labels, 39% of what the operator acted on). The route there is
  outcome checks, such as a claim of "running" against real process
  activity. That is a separate design.
- **Generated summaries or decision extraction for the reports log.** The
  agent's last sentence already names the ask. A generative model costs
  more, and it paraphrases a request the operator should read in the agent's
  own words.
- **An LLM fallback for the uncertain band (0.5–0.85).** Flash-Lite and Haiku
  rank worse than Jev on this task.
- **Per-project thresholds or learning from dismissals.** Revisit once
  dismissal counts exist.
- **Batching several messages per request.** Saves less than USD 0.30 a
  month and costs accuracy.

## Summary for the seat

1. Jev (`typesafe/jev-1.13` through OpenRouter, the same call Celestia's
   antispam uses) reliably spots agent messages that ask the operator for
   something. On 382 labelled messages it has AUC 0.95 and precision 0.82 /
   recall 0.77 at 0.85. Most of its false positives were real asks the
   operator skipped.
2. It cannot spot the 39% of operator interventions that were corrections of
   routine-looking messages. No model can, because the text does not show
   them.
3. It beats Gemini Flash-Lite and Haiku 4.5 on this task, and a keyword rule
   gets F1 0.51 against Jev's 0.80.
4. Replayed on one week, it would flag about 17 conversations a day. In the
   same week agents filed 24 declared asks in total.
5. The cost is USD 0.73 a month for all turn-ending messages (this machine and
   the stage host), or USD 3.3 for every message. Latency is 0.34 s median.
   The eval spent USD 0.42 of the USD 3 cap.
6. Recommendation: a narrow, opt-in slice that classifies turn-ending messages
   and feeds an "Asks you" reason plus a jump-linked reports-log line.
   Classifying every message is deferred.
