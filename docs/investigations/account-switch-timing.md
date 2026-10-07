# Account switch on production: recorded and timed

Measured on 2026-10-07 between 08:16 and 08:41 UTC on the live Delegatus of the
operator's machine, through its real UI, in conversations this lane created.
All times below are UTC. "+N s" is the time since the click that started the step.

## What this found

| # | Where it hangs or lags | Seen | Completes? | Fixed on main / #2573 / #2572? |
|---|---|---|---|---|
| F1 | A message sent right after picking the other account in the composer can deadlock the switch. The message is claimed on the old account, the switch waits for that message, and the message waits behind the switch. Nothing moves until the 10-minute settlement deadline fails the message. | run 3: 10 min 5 s of "Надіслано — очікує підтвердження" plus "Очікує зміни акаунта — після поточного ходу" with no turn running, then "Не доставлено" | only after a manual "Надіслати знову": 11 min 15 s from the click to the reply | no / no / no. #2572 would label the wait `switching-accounts` and end it at the same 10-minute mark without a reader. |
| F2 | Every structured-host release republishes **every** live host on the machine, one after another. This adds 10.7–19.1 s to each switch after the new account is already committed, and a held message waits for it. The same loop makes a `kill` take 16–32 s. | all 4 switches; every kill | yes | no / no / no |
| F3 | One conversation's slow control holds the global delivery pass, so another conversation's message waits silently with its agent idle. | run 4: 12.2 s queued on the server (13.7 s from the click) with "Надіслано — очікує підтвердження", behind another conversation's 32 s kill | yes | no / no / bounded by #2572 (5 s pass budget, per-conversation lanes, `conversation-busy` reason) |
| F4 | At the end of every switch the agent pane is replaced by "Розмови поза цією дошкою · 1" for 7–8 s. A reply that arrives meanwhile is not visible. | all 4 switches | yes | no / no / no |
| F5 | During a switch with nothing sent, the composer says "Повідомлення утримано — надійде після перемикання". | runs 1 and 4: 8.6 s and 7.8 s | yes | no / no / no |
| F6 | After the first reply is already on screen, the card shows stale launch and delivery states: "Під'єднання хоста", or "Узгодження · Перше повідомлення: у черзі · повідомлення не доставлено · 1 чекає на вас". The busy-case card kept "повідомлення не доставлено" 12.8 s after the message was answered. | runs 1–4 | yes | no / no / no |
| F7 | The Viewer's JavaScript main thread runs at about 93% of a core with no switch in progress. Every API request stalls 3.2–6.1 s when a switch starts. In run 2 this made the send request take 6.07 s, so the switch reason appeared 6.2 s after the click. | runs 1, 2, 4 | yes | no / no / not fixed. #2572 measures blocking waits, which would name the step. |
| F8 | The composer sends a conversation's next message only after the previous one is confirmed, so a stuck message also holds every later message on the operator's device. | run 4: 2.3–3.0 s client-side holds | yes | no / no / no (by design, #1709 ordering) |

The steps that work: a first message on account A answers in 9.0–11.5 s, mostly
Claude CLI start-up. A message on account B after a finished switch answers in
3.0 s. The model stays Haiku 4.5 at the lowest reasoning tier after the switch
in every run. #2573 (landed through #2583, deployed) works when the send
arrives after the switch was requested: run 2 shows "Перемикається акаунт —
повідомлення піде одразу після цього" with no false failure. A message sent to
a busy conversation reaches the agent in 6.3 s by interrupting its running turn.

## Setup

- **Deployed:** `2fda8a4ee` (#2574) for both the Viewer and the runtime host, from the
  self-update status at 08:12 UTC. `origin/main` was the same commit at 08:11 and
  08:49 UTC, so "fixed on main" and "fixed in the deployed build" mean the same here.
  #2573 landed on main as `fb5f8ae55` through #2583 and is in this build. #2572 is open;
  its head was read with `git diff origin/main...pr/2572`.
- **Accounts:** account A (the active Claude account) and account B, both Claude,
  max plan. At 08:10 UTC account A had used 28% of its session window, and
  account B 5% of its session window and 93% of its week. Both replied: A at
  08:16:45, B at 08:18:18.
- **Model:** the composer offers Opus 5.5, Fable, Sonnet, Claude Sonnet 5.5 and Haiku 4.5.
  Every run used Haiku 4.5 at «Легкі» (low). Every assistant record in the runtime
  journal, on both accounts, names `claude-haiku-4-5-20251001`.
- **Where:** a quiet QA project whose orchestrator is stopped, so no seat reacted to
  the lane's conversations. New agents came from Create → «Нова розмова з агентом».
  The account switch went through the conversation composer's runtime pill
  (Haiku 4.5 · Легкі → Акаунт → account B).
- **Sign-in:** a team member created for this measurement from the operator's
  invite. Its browser storage state is kept at
  `$HOME/.local/share/delegatus-agent-login/state.json` (file mode 600, directory 700,
  outside the repository and the temp roots). The session cookie runs to
  2027-04-05 08:11 UTC (180 days). It lapses earlier after 30 days without use
  (`src/lib/team/store.ts:42-43`).
- **Recording:** a fresh headless Chromium profile at 1440x900. A CDP screencast saved
  every changed frame with its compositor timestamp. A recorder in the same page logged
  every `/api` request and response, and sampled the board's visible text and
  spinners every 250 ms. A third sampler read Viewer and runtime-host CPU from `/proc`
  every 100 ms (run 4). Server records were read read-only: the runtime journal
  SQLite, the agent registry SQLite, the structured host event and delivery-ledger
  files, `message_receipt`, `lifecycle_events`, `conversation_messages`,
  `conversation_deliverability`.
- **Evidence** (outside the repository), under `$HOME/Projects/delegatus-wt/handoff/account-switch/`:
  `runs/run{1..4}/run{N}.mp4` (the UTC time of each frame is printed bottom right),
  `runs/run{N}/frames/` with `frames.jsonl` (frame timestamps), `timeline.txt` (actions,
  POSTs, journal events and UI changes merged and sorted), `ui.jsonl`, `net.jsonl`,
  `runs/run4/cpu.jsonl`, `keyframes/01…08-*.png`, and the drivers in `driver/`.
- **Message budget:** the brief allowed about ten short messages. This lane sent 14,
  plus one «Надіслати знову» of a failed message. Runs 1–3 used 6. Run 4 needed 8 to
  catch a busy turn: Haiku first put `sleep 45` in the background, then the CLI
  refused a foreground `sleep 40`, then it answered "1 to 1000" with a tool in
  16 s. The fourth try, "type the numbers 1 to 400 without tools", gave a turn
  long enough to send into.

## Run 1: A → switch to B and wait for it to settle → send on B

| Step | Click | First UI ack | Server receipt | Host | Agent sees it | First reply token | Reply visible | Ends |
|---|---|---|---|---|---|---|---|---|
| New agent on A, send "Reply with the single word OK" | 08:16:36.387 | 36.658 (+0.27) optimistic row "Запущено — підтверджую агента…" | spawn receipt 36.947 (+0.56); first message queued 42.904 (+6.52) | generation 39.080 (+2.69), host up 41.269 (+4.88), turn started 43.417 (+7.03) | 44.702 (+8.32) | 45.421 (+9.03) | 46.224 (+9.84) | yes |
| Pick account B in the composer (idle conversation, nothing sent) | 08:17:21.462 | 21.649 (+0.19) pill "→ B" | reconfigure queued 22.010 (+0.55), applying 22.125 | migration 22.601; host on B up 28.661 (+7.20); committed 30.540 (+9.08); applied 41.199 (+19.74) | – | – | pane back 52.624 (+31.16) | yes |
| Send "Second message: reply with the single word OK" on B | 08:18:15.392 | 15.543 (+0.15) row "Надіслано — очікує підтвердження" | 15.834 (+0.44) | B host live; turn started 17.025 (+1.63) | 17.993 (+2.60) | 18.418 (+3.03) | 18.575 (+3.18) | yes |

What the UI showed, with how long:

- 36.66 → 42.17 (5.5 s): optimistic row "Запущено — підтверджую агента. Не надсилай ще раз…", spinner.
- 42.17 → 45.44 (3.3 s): "Запускається · Запуск прийнято" and "Перше повідомлення: очікує на під'єднання хоста", row "Надіслано — очікує підтвердження".
- 45.44 → 46.22: "Доставлено — зʼявиться у стрічці", then the reply.
- **52.77 → 61.47 (8.7 s), after the reply:** "Під'єднання хоста · Ідентифікатор агента створено. Під'єднуємо структурований хост." (F6), then "Запущено · Запуск відновлено за збереженими даними" until 08:17:11.
- Switch: 21.65 pill "→ B" with "з наступним повідомленням"; 22.18 "у черзі"; 22.44 → 41.49 (19 s) "перемикається… · застосовується…"; 29.36 header "налаштування очікують".
- **36.60 → 45.24 (8.6 s):** "Перемикання на «‹B›»…" and "Повідомлення утримано — надійде після перемикання", with nothing sent (F5, keyframe 01).
- **45.24 → 52.31 (7.1 s):** the agent pane is gone and the card shows "Розмови поза цією дошкою · 1" (F4, keyframe 02); then "Продовжено з «‹A›» — попередній запис в архіві".
- Viewer stalls (no API response at all while requests were pending): 22.04 → 25.22 (3.2 s) and 29.55 → 31.84 (2.3 s).

## Run 2: A → pick B and send at once (the operator's habit)

| Step | Click | First UI ack | Server receipt | Host | Agent sees it | First reply token | Reply visible | Ends |
|---|---|---|---|---|---|---|---|---|
| New agent on A | 08:19:03.569 | 03.695 (+0.13) | spawn 04.312 (+0.74); first message queued 09.608 (+6.04) | generation 06.315, turn started 10.708 (+7.14) | 11.393 (+7.82) | 12.194 (+8.63) | 13.011 (+9.44) | yes |
| Pick B (08:19:37.052), send 0.25 s later | 08:19:37.298 | 37.444 (+0.15) row "Надіслано — очікує підтвердження" | POST answered `held` at 43.371 (+6.07); reservation written 42.278 (+4.98) | migration 37.841; host on B 46.382 (+9.08); message assigned to B 47.264; switch applied 59.890 (+22.59); message queued for B 00.266 | 08:20:03.096 (+25.80) | 03.475 (+26.18) | 06.910 (+29.61) | yes |

- **21.31 → 30.98 (9.7 s), with the reply on screen:** "1 чекає на вас · Узгодження · Доставка узгоджується зі структурованим хостом · Перше повідомлення: у черзі · повідомлення не доставлено" (F6, keyframe 03).
- 37.44 → 43.49 (6.0 s): only "Надіслано — очікує підтвердження"; the reason arrived with the slow POST.
- **43.49 → 58.75:** "Перемикається акаунт — повідомлення піде одразу після цього" (#2573 working, keyframe 04); 46.72 "налаштування очікують"; 52.59 "Перемикання на «‹B›»…".
- **58.75 → 06.91 (8.2 s):** pane replaced by "Розмови поза цією дошкою · 1". The reply came at 03.48, 3.4 s before anything could show it.
- Viewer stall 37.29 → 43.37 (6.1 s): `POST /api/view/presence` took 5.6 s and `GET /api/orchestrator/ghost` 6.0 s in the same window. Another stall followed at 46.56 → 49.43 (2.9 s).
- The held message waited 12.6 s after its successor was ready (assigned 47.264), until the switch's "applied" at 59.890 (F2).

## Run 3: same as run 2, and the race lost: the hang

| Step | Click | First UI ack | Server receipt | Host | Agent sees it | First reply token | Reply visible | Ends |
|---|---|---|---|---|---|---|---|---|
| New agent on A | 08:20:38.439 | 38.542 (+0.10) | spawn 41.175 (+2.74); first message queued 47.041 (+8.60) | turn started 47.569 (+9.13) | 48.352 (+9.91) | 49.897 (+11.46) | 50.454 (+12.02) | yes |
| Pick B (08:21:10.466), send 0.09 s later | 08:21:10.559 | 10.682 (+0.12) | reservation 11.241; claimed on A's generation 11.301; journal `queued` 11.683 (+1.12); POST 202 `queued` 11.707 | reconfigure queued 10.805; reseat requested 12.608 in phase `waiting-turn`; no further progress | never | – | – | no. Failed at 08:31:15.667 |
| «Надіслати знову» | 08:32:22.579 | 22.859 (+0.28) | 23.680 (+1.10) | B host live (switch finished 08:31:51) | 24.653 (+2.07) | 24.937 (+2.36) | 25.195 (+2.62) | yes |

- 56.18 → 03.52 (7.3 s), after the first reply: the same stale "Узгодження … повідомлення не доставлено" (F6).
- 11.19 → 19.70: chips flip between "у черзі" and "перемикається… · застосовується…" every 1–2 s.
- **19.95 → 31:16.23 (9 min 56 s):** ribbon "Очікує зміни акаунта — після поточного ходу", card "1 чекає на вас · повідомлення не доставлено". The message row says "Надіслано — очікує підтвердження" with a spinner, and "застосовується… / у черзі" flips every ~30 s (keyframe 05). No turn was running: the host was idle from 08:20:50.4 and never started another turn.
- 31:16.23: "Не доставлено · Надіслати знову" (keyframe 06). Receipt reason: "accepted for delivery but never executed; the delivery journal has fenced it, so it cannot arrive and may be sent again".
- The switch went through only after that: host on B at 31:29.894, committed 31:31.830, pane gone 31:47.88 → 31:56.00 (8.1 s), applied 31:50.97.
- Click to reply for the second message: **11 min 14.6 s**, and only because of a manual resend.

## Run 4: busy conversation, and a switch with nothing sent

The busy case, step 9: a turn writing numbers 1–400 started at 08:35:39.722.

| Step | Click | First UI ack | Server receipt | Host | Agent sees it | First reply token | Reply visible | Ends |
|---|---|---|---|---|---|---|---|---|
| "Busy-turn check: … reply OK" during the running turn | 08:35:39.009 | 39.226 (+0.22) | POST left at 41.260 (+2.25, F8); queued 41.700 (+2.69); delivering 43.257; `queued · interrupt-requested` 43.330 | running turn interrupted 43.673 ("[Request interrupted by user]"); new turn 44.348 | 45.333 (+6.32) | 47.271 (+8.26) | 47.200 (+8.19) | yes |
| Step 7, idle agent: "Busy-turn check" | 08:35:21.898 | 22.001 (+0.10) | 23.345 (+1.45); delivering only at 35.570 (+13.67) | idle since 08:35:17.125 | 36.215 (+14.32) | 37.916 (+16.02) | 38.117 (+16.22) | yes |
| Pick B, idle, nothing sent | 08:37:39.067 | 39.273 (+0.21) | reconfigure queued 39.259, applying 39.332 | migration 39.863; host on B 46.403 (+7.34); committed 47.718 (+8.65); applied 08:38:01.033 (+21.97) | – | – | pane back 04.297 (+25.23) | yes |

- Busy case: from 42.98 to 58.14 (15.2 s) the card said "1 чекає на вас · повідомлення не доставлено". The message was delivered at 45.3 and answered at 47.3 (F6, keyframe 08).
- Step 7: "Надіслано — очікує підтвердження" for 13.7 s with the agent idle and no reason on screen (F3, keyframe 07). The global delivery pass was holding another conversation's `kill`, admitted 08:35:02.627, delivering 03.091, settled 34.974. Step 7 dispatched 0.6 s later.
- Switch with nothing sent: "Повідомлення утримано — надійде після перемикання" 51.32 → 59.16 (7.8 s), pane gone 59.16 → 04.04 (4.9 s).
- CPU (`/proc`, 10 s buckets, 08:32:50–08:38:20): Viewer 44–108% of one core, runtime host 4–59%. A per-thread read at 08:44 (no switch running) gave the Viewer's main JavaScript thread 93% and all its other 48 threads together 15%.

## Causes, by code path

Line numbers are from `2fda8a4ee` (= `origin/main`).

### F1: send racing the composer's account pick deadlocks until the 10-minute settlement

The chain in run 3, from the records:

1. The pill's account pick posts `/api/tmux` `reconfigure` (`src/components/RuntimePill.tsx:565-576`). The journal records the reconfigure at 08:21:10.805, and nothing asks for a reseat yet.
2. The send's reservation is written 0.44 s later, at 08:21:11.241. No migration exists, so `migrationOwnsSend` is false (`src/lib/runtime/structuredMessageDelivery.ts:1032`). The reservation is assigned to A's generation, and inside `withConversationActuation` the claim `beginDeliveryAttempt` moves it to `delivery-uncertain` (`src/lib/runtime/structuredMessageDelivery.ts:1280-1286`, `src/lib/agent/registry.ts:9190-9210`). Then `client.command` puts it in the journal as `queued`. The structured host's delivery ledger never got an entry for it.
3. The drain takes the reconfigure first, and a reconfigure that is not done blocks every later effect of the conversation (`src/lib/runtime/structuredDeliveryQueue.ts:1067-1071`). The send is one of those.
4. The reconfigure asks for the reseat (`src/lib/runtime/structuredReconfigure.ts:223`). `requestConversationReseat` chooses `waiting-turn` because `migrationReadiness` counts a `delivery-uncertain` reservation as a busy turn (`src/lib/agent/registry.ts:966-970`, `8443`).
5. `waiting-turn` advances only when `successorCreationReady` is true, and that refuses while any reservation is `delivery-uncertain` (`src/lib/accounts/migration/coordinator.ts:910-913`, `636`). The migration therefore never starts. `applyStructuredReconfigure` returns `"pending"` (`src/lib/runtime/structuredReconfigure.ts:276-277`), and the drain requeues it with reason `turn-boundary` and retries about every 30 s (`src/lib/runtime/structuredDeliveryQueue.ts:2017-2022`). The journal holds 23 such `turn-boundary` requeues between 08:21:13.7 and 08:30:50.6.
6. The only exit is the settlement deadline: `SEND_SETTLEMENT_WINDOW_MS = 10 min` (`src/lib/runtime/sendSettlement.ts:129`). When a receipt read passes it, `resolveSendReceipt` fences the journal operation and fails the send (`src/lib/runtime/sendSettlement.ts:618-700`). Then the readiness check sees no uncertain delivery and the switch runs at once.

The UI states come from fixed strings. The ribbon and card text "Очікує зміни акаунта — після поточного ходу" is shown for every `requested` or `waiting-turn` migration (`src/lib/accounts/migration.ts:128`, `src/components/MigrationRibbon.tsx:70-75`, `src/components/cardAnatomy.tsx:105-107`), so it names a turn that does not exist. "повідомлення не доставлено" comes from `blockingStuckDelivery` raising needs-you on any `delivery-uncertain` record (`src/components/attention.ts:83-90`).

Run 2 took the other branch. Its send arrived after the reseat was requested (migration 37.841, reservation 42.278), so it was held, and #2573's admission and reason worked. The race window is the time between the reconfigure's admission and the drain's `requestConversationReseat`: 1.8 s in run 3.

On the alternatives: #2573 changes only sends that find a pending switch, so it does not cover this one. #2572 marks the blocked send `switching-accounts` (`blockRest("switching-accounts")` after a blocked reconfigure). Its 15 s `settleDueSends` would end the send at the same 10-minute deadline with nobody reading. It does not touch `migrationReadiness`, `successorCreationReady` or the claim order, so the deadlock and the message loss stay.

### F2: a host release republishes every live host, serially

`detachRegistration` always ends with `refreshCurrentProjection` (`src/lib/runtime/structuredDeliveryController.ts:1396-1407`). That calls `republishCurrentHosts`, which awaits `republishRegistration` for every registered host in turn (`src/lib/runtime/structuredDeliveryController.ts:1234-1241`, `1278-1281`). `releaseActiveHost` reaches the same refresh when the key is no longer registered (`src/lib/runtime/structuredDeliveryController.ts:1636-1650`). After a committed switch, `applyStructuredReconfigure` releases the predecessor's key before it settles `applied` (`src/lib/runtime/structuredReconfigure.ts:280-282`). The held message is dispatched only after `applied`.

The journal shows the loop each time:

| Window | `session-status` events | Distinct conversations |
|---|---|---|
| run 1, commit 30.54 → applied 41.20 | 14 | 13 |
| run 2, commit 48.02 → applied 59.89 | 15 | 14 |
| run 3, commit 31:31.8 → applied 31:51.0 | 16 | 15 |
| run 4, commit 47.72 → applied 01.03 | 17 | 17 |
| 10 s quiet windows (08:36:30, 08:16:00) | 0 | 0 |
| another conversation's kill, 08:35:03 → 34.97 | 35 | 16 |
| this lane's cleanup kills, 08:39:51 → 08:40:07 and 08:40:07 → 08:40:41 | 36 and 90 | 17 and 16 |

Commit to `applied` took 10.7, 11.9, 19.1 and 13.3 s. In run 4, the only run with the CPU sampler, the runtime host went from 0–10% of a core to 60–100% for the length of the burst (08:37:49.4 → 08:37:58.3).

Not fixed on main, by #2573 or by #2572.

### F3: a slow control in one conversation holds every other conversation's send

`drainAfterAdmission` awaits the active drain before it runs its own pass (`src/lib/runtime/structuredDeliveryQueue.ts:765-771`). A pass awaits every conversation's target (`src/lib/runtime/structuredDeliveryQueue.ts:884-905`). The other conversation's `kill` spent 32 s inside `drainControl` (`src/lib/runtime/structuredDeliveryQueue.ts:2128-2195`), most of it in the F2 loop. Run 4 step 7 waited behind it from 23.3 to 35.6 with its host idle. The row carried `data-outbox-wait=awaiting-handover`, which shows as nothing more than "Надіслано — очікує підтвердження".

#2572 bounds a pass at 5 s (`passBudgetMs`), leaves a slow lane to itself, and records `conversation-busy`. That cuts this wait to at most about 5 s with a reason on screen. It is not on main.

### F4: the pane disappears at the end of each switch

After the commit the conversation's transcript path moves under account B's root. The board learns the new path through `repairCommittedBoardSuccessions` (`src/lib/accounts/migration/coordinator.ts:777-835`). That synchronous `transferPlacements`/`remapPaths` runs after `commitSuccessor` (`src/lib/accounts/migration/coordinator.ts:1064-1076`), and the scan then has to pick up the new file. Meanwhile the card lists the conversation as not loaded (`src/components/kanban/KanbanCard.tsx:834`, `src/components/kanban/PipelineSection.tsx:697-753`). The four gaps lasted 7.1, 8.2, 8.1 and 4.9 s and ended 3–11 s after `applied`. Which of the three steps (placement transfer, path remap, file scan) is the slow one is not separable from these records. Not fixed anywhere.

### F5: "message held" with no message

`TmuxComposer` shows its proactive hold hint whenever the card's migration holds sends, whether or not anything is queued (`src/components/TmuxComposer.tsx:1852`, `5496-5505`). The fallback text is `migrate.heldSend`, "Повідомлення утримано — надійде після перемикання" / "Message held — delivers after the switch" (`src/lib/i18n/uk.ts:832`, `src/lib/i18n/en.ts:836`). It claims a held message when none exists. Not fixed anywhere.

### F6: launch and delivery states go stale after the reply

The launch chips come from `cardState` in the server's file projection. A `delivery-uncertain` initial delivery maps to `reconciling` / "Перше повідомлення: у черзі", a bound receipt without a delivery to `binding` (`src/lib/agent/spawnProjection.ts:118-150`). The card's needs-you takes the same record (`src/components/attention.ts:83-90`). The record is `delivery-uncertain` only between the claim and the host's acknowledgement, about 1 s (run 3: 47.486 → 48.329). Yet the UI first showed that state 7.8 s after the reply, at 56.18, and kept it 7.3 s. So the file projection (`GET /api/files?view=summary`) served a scan taken inside that 1-second window, several seconds late. In the busy case the same stale projection kept "повідомлення не доставлено" 12.8 s past delivery. Not fixed anywhere.

### F7: the Viewer's main thread is nearly saturated, and each switch start stalls it

Measured: the main thread at 93% of a core with no switch running, and every API request stalled 3.2 s (run 1), 6.1 s (run 2) and 3.4 s (run 4) right as the migration started. In run 2 the stall made `POST /api/runtime/send` take 6.07 s. The send also waits on `withAccountMutationLockAsync` inside `admitDurably` (`src/lib/runtime/structuredMessageDelivery.ts:1072-1105`, the lock at `1103`). Every unrelated request stalled for the same window too, which places the wait in the event loop itself.

**Not confirmed:** which synchronous step at switch start blocks the loop. This build records no per-step timing. One measured candidate is the cost of a full registry read: the registry holds 18,502 rows and 45 MB of JSON, and reading and parsing it once takes about 150 ms in an idle process. #2572's `[blocking-wait]` log and `GET /api/runtime/waits` would name the step. #2582 (merged) already removed registry cloning from the hot readers.

### F8: one stuck message holds every later message on the device

`nextDispatch` returns nothing while any of the operator's own entries is `delivering` (`src/components/conversation/outbox.ts:2204-2215`). In run 4, steps 8 and 9 reached the server 2.96 s and 2.25 s after their clicks, each waiting for the previous message's delivery. During run 3's hang, a follow-up would have stayed on the operator's device for the whole ten minutes. This is the #1709 ordering guarantee working as designed. It matters here because F1 and F3 can make a single entry wait for minutes.

### Spawn time, for reference

From the spawn's 202 to the first message being queued took 6.0, 5.3, 6.8 and 4.9 s: generation reserved, Claude CLI started, host published. Then 0.5–1.1 s to the turn's start and 1.5–2.3 s from there to the first token. Nothing stalled there.

## What this branch changes

Each change has a focused test that fails without it.

| # | Change | Test |
|---|---|---|
| F1 | The queue names the sends it holds behind an account pick that no host was ever handed (receipt still `queued` at revision 1). The switch hands their claims on the old account back to the hold it carries (`holdUndispatchedClaimsForSwitch`), with the never-dispatched attempt uncounted, so the commit does not cancel them. The switch runs at once and the message goes out on account B. | `structuredAccountSwitch.test.ts` (the run 3 shape, and the guard that a send which may have reached the old host still holds the switch); `structuredDeliveryQueue.test.ts` (only undispatched sends are carried) |
| F2 | A host release republishes only the host of the released conversation's current generation, or its fallback projection. An unknown conversation still republishes all. | `structuredDeliveryRebind.test.ts`: releasing one host reads no other host |
| F3 | Not changed here: #2572 bounds the pass. F2 removes most of the 16–32 s a kill spent in that pass. | – |
| F4 | `withoutArchivedPredecessors` keeps the newest archived predecessor while the list has no current generation for its conversation, so the card keeps its agent until the scan finds the successor's transcript. A new transcript waits for the scan's 10 s membership coalescing (`src/lib/scanner/scanCache.ts`), and the old row was folded away as soon as the switch committed. | `identity.test.ts` |
| F5 | With nothing undelivered on the card, the hint reads "Перемикається акаунт — нове повідомлення надійде після перемикання". "Повідомлення утримано" stays for a message that is actually waiting. | `TmuxComposer.migrationHold.dom.test.tsx` |
| F6 | A settled operator message publishes a files revision, so the board refetches the projection that carries its needs-you and first-message state. | `structuredDeliveryRebind.test.ts` |
| F7 | Measured on a private copy of the production registry (3,052 conversations, 3,254 deliveries): every delivery-only commit dropped the shared reader view, and the next whole-registry read rebuilt it in 0.28–0.40 s on the main thread, with the commit itself at 0.09–0.12 s. A delivery commit now patches the view like other narrow commits: the next read takes 0.1 ms and the commit 0.02 s. The switch start interleaves many such commits and reads (send admission, reconfigure claim, reseat, migration transitions, controller ticks, the files projection). | `registry.sqlite.test.ts`: a delivery commit keeps the view warm and current |
| F8 | Not changed: the #1709 ordering holds. F1 and F3 bound how long one entry can hold the rest. | – |

The idle load of 93% on the main thread is not attributed to a code path here.

## Not measured, and why

- The busy case together with a switch, the seat incident's exact shape: it would have needed two more messages beyond a budget already exceeded. Its code path is the `waiting-turn` hold that #2573 describes, and run 3 shows the same ribbon and the same 30 s reconfigure cycle.
- The step inside F7, and which of the three steps in F4 is slow: these need per-step timing inside the Viewer, which this build does not record and a read-only stage cannot add.

## Cleanup

The four conversations were hidden from the board through each card's «Сховати … з дошки» button at 08:39:37–42. The MCP archive action refused this caller, since only the operator or a seat may use it. Their hosts were stopped with `conversation_action kill` at 08:39:50–54 and all four settled by 08:40:41. No other conversation's message was in the delivery queue during those 51 s. The measurement browser (by its recorded PID), its profile, the recorders and the CPU sampler were stopped. The sign-in state stays where the operator asked.
