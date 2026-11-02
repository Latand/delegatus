# Voice timers and reminders

**Originating requirement.** Operator request, 2026-11-01 about 09:45 UTC,
relayed by Voice Delegatus from the operator's speech. It is a paraphrase; no
verbatim line was supplied:

> Let the operator quickly set several independent timers or reminders by voice
> (for example 15 or 20 minutes); when the time is up, tell them it has passed.
> Work out where and how the voice interface delivers these notifications,
> including the option of not going through bridge reports. Expected: a
> worked-out, delivered improvement that supports multiple timers.

This note is acceptance item 1 of that task. Items 2 and 3 (the build and its
tests) follow this design. Code citations are `file:line` on commit `c9732531`
(main). The note changes no product code.

---

## 1. Decision

A timer is a **server-side row in `state.sqlite`**, owned by whoever started
the call. It does not belong to the call. The voice sets, lists and cancels
timers through **one new registry tool, `timer`**. A **scheduler in the Viewer
process** fires each timer at its due time, including after a restart.
Delivery then follows the requirement's order:

1. **Live call.** If a call by the timer's owner is live, the call plays a short
   cue and the voice says the timer is up. This uses the same
   `session.commentary.append` path that speaks reports, with no bridge report.
2. **No live call.** A Web Push notification goes to the operator's
   browsers and phones, and an in-app toast shows in every open Delegatus tab
   (one tab claims it).
3. **Telegram**, only after the operator turns it on. The message goes to the
   operator's own private chat with the paired bot.

A fired timer is delivered at most once per channel. Each channel's delivery
is recorded on the timer row before or as it happens. A timer that no channel
could deliver stays owed: the next call says it, or the next page load shows
it.

Bridge reports are not used. They exist so that an orchestrator's turn can
reach the voice (`deliveryPaths.ts:94-95`). A timer needs no orchestrator, no
model turn and no seat.

---

## 2. What the code has today

| Need | Present today | Where |
| --- | --- | --- |
| Voice tools | One compiled registry. The API backend runs a tool through `runCompanionTool`, and Codex gets the same list as `dynamicTools`. | `tools.ts:91`, `:196-211`; `liveSession.ts:874-877`; `codexProvider.ts:68`, `:152` |
| A tool with several actions | `relay_owner_history` takes an `action` enum. | `tools.ts:105-112` |
| Speaking server text into a live call | `append()` sends `session.commentary.append`. `speakReports` splits a report into parts, records each part the provider took, and waits while the operator speaks or a backend turn runs. | `liveSession.ts:1016-1039`, `:1041-1044`, `:1045-1052` |
| The browser's poll of a live call | `events()` runs about every 500 ms, updates `lastSeen` and speaks owed reports. A call whose browser stops polling for 30 s is closed. | `liveSession.ts:1166-1181`, `:355-364` |
| Call cues | Two sine tones, behind the header's sound switch. Only connect and disconnect use them. | `cues.ts:19-26`, `:30`, `:62-66`; `liveAdapter.ts:130`, `:301` |
| Who started a call | `startedBy` is the operator or a team member. | `storage.ts:74`; `deliveryPaths.ts:106-107` |
| Web Push | VAPID push to every stored subscription, with a send-once ledger. The service worker gives every notification the tag `agent-question`. The TTL is 60 s. | `push.ts:39-53`, `:157-187`, `:205-235`, `:174`; `public/question-push-sw.js:15` |
| In-app toast | `pushTaskToast` sends a toast to every mounted `TaskToastHost`; it disappears after 6 s. The only host is mounted inside `ProjectDashboard`. `Viewer.tsx` renders `ProjectDashboard` only outside the overview. | `taskToast.tsx:19`, `:27-30`; `ProjectDashboard.tsx:2590`; `Viewer.tsx:1968`, `:2074` |
| Telegram to the operator's own chat | The paired owner's private chat, and `send` with a durable claim per `clientRequestId`. An ambiguous earlier send answers `send_uncertain` and is not sent again. | `externalRelay/telegramPublication.ts:9`; `ownerDestination.ts:14-40`; `telegram/bot/service.ts:1076-1132` |
| Operator time zone without a call | `operatorTimeZone()` | `operator/settings.ts:114-117` |
| Durable background worker pattern | Prototype delivery: state on `globalThis`, a boot sweep, and attempts only while this release owns traffic | `prototypeReview/deliveryWorker.ts:25-27`, `:258`, `:267-273`; `viewerInstrumentation.ts:592-597` |
| Private-history boundary | After a Telegram group read, nothing the model wrote may leave the call. | `liveSession.ts:770-778` |
| Calls across a restart | A call never survives a Viewer restart. | `liveSession.ts:1068`; `server.ts:24-25` |

Nothing in the code schedules anything for the voice, and no timer, reminder or
alarm exists in `src/lib/voiceCompanion/`. A search of earlier conversations for
voice timers or reminders found no previous design.

---

## 3. Design

### 3.1 The record

The timers live in a new `state.sqlite` collection, `voice_timers`, with one
row per timer. It uses the same row store as the push collections
(`push.ts:39-53`). It is registered beside them in `legacyCollections.ts:75-84`,
so it joins the release fence and the demotion checkpoint. It has no legacy
JSON file, so the import reads empty.

```
id          "vt_<random>"         also the model's handle; never spoken
owner       { operator: true } | { memberId }
label       string | null         the operator's own word(s), at most 60 chars
minutes     number                as asked, clamped to 0.5..1440
createdAt   epoch ms
dueAt       epoch ms
timeZone    string | null         operatorTimeZone() at creation
private     boolean               set after a private read in the creating call
sessionId   string                the call that set it (for the transcript only)
state       pending | fired | cancelled | missed
firedAt?    epoch ms
delivery    { voice?, push?, toast?, telegram? }   one entry per channel, below
```

- An owner may have at most **20 pending timers**. One more is refused, and the
  answer says how many are running.
- Fired, cancelled and missed rows are deleted 24 hours after they settle. The
  scheduler does this in its normal pass.

The record is not stored in `voice-companion.json` (`storage.ts:214`). That
document holds call history: retention prunes it, and every call poll
transacts on the whole file.

### 3.2 The voice tool

There is one registry entry, named `timer`, with a strict schema. It is not
egress and not delegation, so the private-history send boundary
(`liveSession.ts:770-778`) does not block it. Both backends get it from the
registry automatically (`codexProvider.ts:68`).

```
action   "set" | "list" | "cancel"
minutes  number | null     set: the duration
label    string | null     set: what the operator called it ("tea"), null when unnamed
timer    string | null     cancel: a handle from set/list, or the label words
```

| Operator says | Call | Answer `speech` (example, Kyiv zone) |
| --- | --- | --- |
| "set 15 minutes for tea" | `set`, 15, "tea" | Timer «tea» set for 15 minutes, until 10:20 Kyiv time. Two timers are running. |
| "and one for 20 minutes" | `set`, 20, null | A 20-minute timer is set, until 10:25 Kyiv time. |
| "what timers do I have" | `list` | Two timers: «tea» in 12 minutes, at 10:20; the 20-minute timer in 17 minutes, at 10:25. |
| "cancel the tea timer" | `cancel`, timer "tea" | Timer «tea» is cancelled. One timer is still running, at 10:25. |

The tool behaves as follows:

- **Cancel matching.** The handle wins. Otherwise the label is compared, ignoring
  case and spacing: an exact match first, then a single pending timer whose
  label contains the words. When several timers match, nothing is cancelled and
  the answer lists them, so the voice can ask which one. When nothing matches,
  the answer is `not_found` with the pending list.
- **Out-of-range minutes** are clamped to the nearest bound, and the answer
  says so.
- **`list`** also returns timers that fired in the last hour, each with how it
  was delivered.
- **Backend instructions** gain one sentence (`sessionConfig.ts:66`): a timer
  or reminder is set, listed or cancelled with `timer`, and is never sent to
  the orchestrator. Without that sentence, the existing send rules could treat
  "remind me" as work to send.

### 3.3 The scheduler

`VoiceTimers` is one instance on `globalThis`, the same pattern as
`server.ts:13-15`, so the route and the instrumentation bundles share it.

- **Arming.** It keeps one `setTimeout` (`unref`) for the earliest pending
  `dueAt`. Create and cancel re-arm it. It never scans every second.
- **Boot.** It starts at Viewer boot beside prototype delivery
  (`viewerInstrumentation.ts:592-597`), reads the pending rows (at most
  20 per owner) and arms the timeout. A timer that came due while the Viewer
  was down fires at once, and its words say when it was due.
- **Single owner.** It fires only while `viewerReleaseOwnsTraffic()` is true,
  the same check as `deliveryWorker.ts:258`. A predecessor release left
  running beside its successor does not fire anything.
- **Firing.** When a timer comes due, a compare-and-set moves the row from
  `pending` to `fired`. Then the scheduler chooses the channels (3.4). Timers
  due at the same moment fire in `dueAt` order, then `createdAt` order.
- **Hot path.** Fired timers owed to a live call sit in an in-memory list.
  `events()` (`liveSession.ts:1178-1179`) only looks that list up until a timer
  is owed. A wake, a tab's read, a set and a cancel read the active rows only;
  §7 says how settled rows leave them.

### 3.4 Delivery, in order

A call counts as **live** for an owner when it has an active session with a
connection, is not ending, and its browser polled within the last 5 s
(`lastSeen`, `liveSession.ts:1168`).

| Order | Channel | When | How | Delivered once because |
| --- | --- | --- | --- | --- |
| 1 | **Voice** | A live call by the owner exists at fire time | On its next poll, `speakTimers(active)` runs after `speakReports`, under the same hold (`reportsHeld`). In the same poll, the call emits a new `CompanionEvent` `timer.fired`, and the browser plays `cues.timer()`, a new three-tone chime behind the existing sound switch (`cues.ts:30`). Codex gets the bare sentence. The API backend gets the sentence with a framing line, as reports do (`liveSession.ts:1028-1032`). | The row says `saying` before the words leave, and `spoken` once the provider has taken them. On Codex that is when `appendSpeech` is answered, because words queued behind the voice's current sentence can still be taken back. §7 has the full order. |
| 1→2 | Fallback | The call ends, or 60 s pass, before the voice spoke | The owed entry is withdrawn, queued words are taken back from the provider, and the timer goes to row 2. | The words are gone before the row says `withdrawn`. Words already on their way make the row `uncertain`, and the voice never says it again. |
| 2a | **Web Push** | No live call. Operator-owned timers only (subscriptions belong to the installation, `push.ts:39-45`). | Reuse the subscription loop of `notifyQuestionNow`, with a payload that carries `tag: "voice-timer:<id>"`. The service worker uses `payload.tag` and falls back to `agent-question` (`question-push-sw.js:15`), so a timer never replaces a question notification. The TTL is 900 s instead of 60 s. | Each device has its own claim in `voice_timer_push`, written before the request leaves. A claim with no recorded answer is never sent again. The question ledger keeps only its newest 500, so timer claims live apart from it and retire with their timer. |
| 2b | **Toast** | No live call | `VoiceCompanionHost` (mounted on every page when the voice is on, `Viewer.tsx:2074`) reads the owner's timers on mount, on becoming visible and after a call ends. It arms one `setTimeout` for the earliest `dueAt`. When the timeout runs, or a fired and undelivered timer shows up, it POSTs a toast claim. A tab that wins commits with `showing`, calls `pushTaskToast("ok", …)` only after the server answers, and then sends `shown` (or `release` if it showed nothing). | The first tab to claim holds the toast for a 30 s lease. A claim with no commit runs out and the toast is free again. Once the row says `showing`, no tab is offered it again. §7 has the order. |
| 3 | **Telegram** | No live call, the operator chose it (§5 Q1), and an owner timer | `telegramBotService().send` to the private chat from `ownerReviewDestination()` | `clientRequestId` `voice-timer:<id>` is a durable claim (`service.ts:1107-1129`). `send_uncertain` is recorded as uncertain and not sent again. |
| — | **Owed** | Fired, but no channel delivered it | The next call by the owner says it at start ("while you were away, «tea» fired at 10:20"). The next page load toasts it. After 12 hours the timer becomes `missed`, and `list` still shows it for an hour. | The same per-channel entries apply. |

Three rules apply to all of these channels:

- **No toast during a call.** A live call delivers the timer by voice only, so
  the operator does not get a toast on top of the spoken words.
- **Member-started calls.** Their timers use voice and toast only. Push
  subscriptions and the Telegram chat belong to the operator's devices.
- **Private timers.** A timer set after a private read in the same call
  (`private: true`) keeps its label in the voice and in the toast. Push and
  Telegram do leave the call, so they say "Your 15-minute timer set at 10:05
  is up" without the label.

### 3.5 Times

Every time a person hears or reads gives the clock time in the operator's
zone and the minutes left:

- "until 10:20 Kyiv time"
- "in 12 minutes, at 10:20"
- "the 15-minute timer «tea», set at 10:05, is up"

When the zone is unknown, the time is given in UTC and the words say so. Tool
answers also carry ISO `dueAt` and `createdAt`, so later localisation of tool
answers can rewrite them.

Formatting lives in one small helper, `src/lib/voiceCompanion/timerTime.ts`,
with two functions: the clock text for an instant in a zone, and the
minutes-left text. It uses `Intl.DateTimeFormat` and the row's `timeZone`.
Lane 666f2739 is building a `voiceClock` module in this folder, with a call
clock and elapsed-time text. That work is not on main at `c9732531`, and this
lane does not edit it. When it merges, the helper's two bodies switch to that
module, and the zone comes from the call's clock when a call is live.

---

## 4. Fences and neighbouring work

- **Lane 666f2739** (voice local time) also adds a registry entry to
  `tools.ts` and edits `liveSession.ts`. The build rebases onto whichever lands
  first and leaves that lane's formatting code alone.
- **Reconnect** (lanes de4377a6 and 64b8f113) is untouched. A timer belongs to
  its owner, so a dropped call or a reconnected one needs no
  timer-specific code. A timer owed to a call that dropped falls back by the
  1→2 rule.
- **Hands-free cues** (2753d517) can later take `cues.timer()` into its cue set.
  This lane adds only that one tone.
- **Bridge reports** and the orchestrator seat are not used.

---

## 5. Operator choices

Each question below has a recommendation. The build uses the recommendation
unless the operator answers otherwise.

| # | Question | Options | Recommendation |
| --- | --- | --- | --- |
| Q1 | Telegram for timers | (a) off by default, with a switch in the voice settings (`CompanionSettings`, `storage.ts:15-31`); (b) on whenever a paired owner chat exists | **(a)**. A new outbound channel stays off until the operator chooses it. |
| Q2 | When Telegram is on, when does it send? | (a) together with push and toast when no call is live; (b) only when push and toast both failed | **(a)**. Choosing Telegram means wanting the timer there. |
| Q3 | A fired timer nobody received | (a) owed for 12 h, said at the next call and toasted at the next page load; (b) dropped at fire time | **(a)**. A dropped call still reaches the operator. |
| Q4 | Reminders at a clock time ("at 15:00") | (a) defer; (b) add an `at` argument now | **(a)**. The request names durations, and clock-time parsing waits for lane 666f2739's clock. |
| Q5 | Fire sound | (a) a new short three-tone chime behind the existing sound switch; (b) reuse the connect cue; (c) no sound | **(a)**. It is distinct from connect and disconnect and respects the switch. |

---

## 6. Tests (acceptance item 3)

All tests use a fixed clock and inject `now` and `schedule`, as the
prototype-delivery worker does. Each runs in an isolated `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`.

| Case | Shape |
| --- | --- |
| Two overlapping timers fire in order | Set 20 min and then 15 min. Advance to 15 and then to 20. The fired order is 15, 20, and with a live fake call each is spoken once, in that order. |
| Cancel by label | Set «tea» and «oven», then cancel "tea": only «tea» is cancelled. With two «tea» timers, the answer is `ambiguous` and nothing is cancelled. |
| Restart keeps pending timers | Create, drop the instance, build a new `VoiceTimers` over the same state directory, boot and advance. The timer fires once. A timer that came due during the downtime fires at boot with late wording. |
| Exactly once per channel | Two polls of one call speak it once. Two tabs' toast claims give one winner, and the real component shows one toast with its answers lost across the lease, a reload and another browser. Push is called once per subscription (fake fetch), including after question churn and a restart. Telegram is sent once (`fakeTransport.ts`), and `send_uncertain` is not resent. |
| Dropped call | Set during a call, close the call, advance past `dueAt`. Push and toast deliver it, and the voice records nothing. |
| Real voice tool path | API backend: `CompanionLiveSessions` with `FakeLiveProvider` makes a function call `timer` that reaches `runCompanionTool` (the `liveSession.test.ts` pattern). Codex backend: the app-server fixture calls the `timer` dynamic tool (`codexProvider.fixture.mjs`). |
| Red on main | Each test fails on main, because `timer` is refused with `TOOL_NOT_ALLOWED` (`tools.ts:201`) or the scheduler module does not exist. |

---

## 7. As built

The build follows sections 1 to 6. These details were settled while building it:

- **One toast host per screen.** The dashboard keeps its own host, whose place
  on the phone is part of its layout. The overview and the relay chats, which
  have no dashboard, mount the same host fixed over the screen. A screen never
  has two.
- **A tab toasts only when visible.** A toast in a hidden tab would use up the
  timer's one toast with nobody looking. A tab reads on mount, on becoming
  visible, after a call ends, at the next timer's time and at least once a
  minute, because a timer can be set on another device. It may toast a timer
  another channel delivered only within 2 minutes of firing; after that, only a
  timer no channel delivered is still owed to it.
- **The scheduler also wakes at least once a minute,** beyond the design's one
  timeout for the next timer. That catches a row another release wrote and a
  clock that jumped.
- **In a team install, the active team owner counts as the operator** for push
  and Telegram, the same rule added voice tools use. Other members get voice
  and toast only.
- **A private timer's label stays in the call that set it.** A later call hears
  the timer without its label and cannot cancel it by that label, because a
  private read's words may not reach a model that can send. The label still
  shows on the owner's screen.
- **The row also records the call's language,** so push and Telegram text is in
  it. Spoken text uses the language of the call that says it, and a toast uses
  the tab's. Tool answers stay in English like every other voice tool answer,
  and the model says them in the operator's language.
- **One timer per request.** A provider call replayed with the same call id, or
  a duplicate handoff of one attempt, answers `already_set`.
- **A failed push or Telegram send** is asked again after 1 and then 5 minutes,
  then left owed. A channel that has no way to deliver records `none` and is
  not asked again. A push or Telegram send that may have gone out records
  `uncertain` and is not repeated. The timer stays owed, so the toast and the
  next call can still reach the operator.
- **Voice is at most once across a restart.** The row moves through `owed`,
  `saying` and then `spoken`, `withdrawn` or `uncertain`. `saying` is written
  before the provider sees the words. A row found `saying` with no call holding
  it may have been voiced, so it becomes `uncertain`: no call says it again, and
  the other channels stay free. `owed` and `withdrawn` mean nothing was voiced,
  so the next call may still say those. A write that fails after the words left
  keeps the row at `saying`, which gives the same safe result.
- **Speech a provider queues is not yet speech.** Codex holds appended speech
  while the voice is talking. A timer in that queue stays owed, and its cue waits
  for the hand-off. Ending the call, the 60 s hold or the plan limit takes the
  words back and the next channel takes over.
- **Two calls starting together** hand a timer to the voice once. Only `owed`
  can become `saying`, and `saying` never goes back, so a second entry for the
  same timer finds nothing to reserve and is dropped.
- **No toast during a call,** including a timer a push already reached. The server
  refuses the claim while the owner has a live call, and the page reads again
  when the call ends.
- **A toast commits before it appears.** The toast moves through `leased`,
  `showing` and `shown`. A claim alone shows nothing, so a tab that closes or hides
  with a claim, or never hears the answer, leaves the toast to the next read when
  the lease runs out. The row says `showing` before the toast appears, and from
  then on no tab, reload or other browser is offered it again, however many answers
  are lost. A tab whose `showing` got no answer asks again under the same lease,
  because only it knows it showed nothing. A tab that hears `showing` after going
  hidden, or that has no host on screen, sends `release` and the toast is free at
  once. `shown` and `release` are receipts kept in the browser's storage until the
  server has them, so a reload or another tab tells them too. A row left at `showing`
  is not known to have reached anyone, so it stays owed like an uncertain Telegram
  send: the next call may still say it, and the toast does not repeat. If a tab
  closes after the server wrote `showing` and before it heard the answer, that toast
  is lost and the other channels still hold the timer. A tab shows at most three
  timer toasts at once, because the host keeps four, and claims the next as one
  leaves.
- **Push claims are per device and have their own ledger.** A definite refusal
  releases that device's claim so a retry can reach it. No answer at all, including
  a request that never connected, counts as uncertain, because the sender cannot
  tell which happened. Timer claims sit in `voice_timer_push`, where no count of
  questions can push them out. They retire one step before their timer's row, a day
  after it settled, when nothing can send that timer again.
- **A write the store refused waits.** A channel whose claim or answer could not
  be written tries again after 5 s, 30 s and then every 60 s, so a read-only disk
  costs a bounded number of writes and logs the channel, the timer's handle and
  the error's name. An answer the channel already gave is held in memory and written
  again, and the channel is not asked twice. A restart loses that memory: the row
  says `sending`, and the channel is asked again under its own key. A voice
  reservation the store refused waits 5 s, however often the call polls.
- **Settled rows leave the active range.** A row that can need no more work moves
  from `<id>` to `done:<id>` in one write. A wake reads only the active keys,
  and a separate cursor retires one page of history per rescan, so a longer
  history costs a wake nothing more. `list` reads the history because the
  operator asked for it.
- **Telegram goes through the bot's allowlist.** The operator's private chat
  needs an alias and "Agents may post". Without them the row records `none` and
  `list` shows that Telegram did not deliver the timer.

## 8. Deferred — not currently justified

- Clock-time reminders ("at 15:00") and recurring timers. See Q4.
- Snooze, "cancel all", and changing the length of a running timer.
- A visible timers panel, or cancelling from the UI. The request asks for voice.
- A per-timer choice of channel.
- Timers set by agents through the `viewer` MCP server, or from text chat.
- Web Push per team member. Push subscriptions belong to the installation today.

## 9. Alternatives rejected

- **Bridge reports or the orchestrator.** This needs a seat turn and model
  tokens, and it is spoken only during a call. The requirement asked for a
  path without them.
- **Timers only in the browser (`setTimeout` in the page).** They are lost on
  reload, on a closed tab and on a Viewer restart.
- **Vendor-side scheduling.** The realtime session has no scheduled speech,
  and it ends with the call.
- **One tool per action** (`set_timer`, `list_timers`, `cancel_timer`). This
  adds three entries to every backend request where one entry with an
  `action` enum already has a precedent (`tools.ts:105-112`).
