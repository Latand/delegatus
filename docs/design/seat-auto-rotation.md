# The seat rotates itself at a context threshold

Issue #2577. Design only; no product code changes in this step.

## The requirement

Operator, 2026-10-09 about 02:00 Kyiv, in the orchestrator seat's chat, as the
pinned specification carries it:

> «Разбери ишью, которые недавно накидали в Delegatus… новые проблемы.»

The issue it points at, #2577 (external reporter, 2026-10-06), acceptance
verbatim:

> - With the setting off, behaviour is unchanged (advisory only).
> - With it on, a seat crossing the threshold while idle rotates within one
>   tick. A seat that is mid-turn rotates only after the turn ends, and a
>   running turn is never killed.
> - At most one rotation per cooldown window per project. A failed rotation
>   leaves the old seat in charge and reports once.
> - The setting survives restarts and rotations; the new seat inherits it.
> - Tests cover idle vs busy seats, estimated vs reported usage, cooldown,
>   failure and the off-by-default path.

The pinned specification adds: the setting is `autoRotate {enabled,
thresholdPercent}`, off by default, set from the orchestrator panel and through
the seat-tick settings tool with who and why recorded. The tick rotates only at
a safe point (seat turn idle, no rotation pending, outside a cooldown). A busy
seat that stays over the threshold is woken once to finish and hand off. The
rotation is exactly the `rotate_orchestrator` path. The board card and the
bridge log record each automatic rotation, with the reason, the usage at the
trigger, and the old and new seat. A failed attempt is reported once and retried
after the cooldown. Estimated usage gets a safety margin or waits for a
provider-reported figure. The panel control reuses the existing seat-tick panel
controls, in English and Ukrainian.

Live evidence: on 2026-10-08 this project's seat sat at 72% of its 1M window
with `STRONGLY_RECOMMEND_ROTATION` for hours while the operator was away. A
`get_orchestrator` read during this design (2026-10-09) showed the same seat
at 86% (863,753 provider-reported tokens of 1,000,000), still unrotated.

### Prior decisions found

- `search_transcripts` for "auto rotation orchestrator context threshold",
  "STRONGLY_RECOMMEND_ROTATION", "seat tick settings rotation decision" and
  «ротація оркестратора автоматично», plus `search_memory` for "orchestrator
  rotation threshold seat tick" and "rotate orchestrator context window usage".
  Memory has nothing on the topic.
- The advisory itself (commit `1179aec8b`, 2026-07-29) was an operator decision
  to make context pressure **words only**: the payload says
  `strongly_recommend` and nothing acts on it. This design keeps that as the
  behaviour whenever the new switch is off.
- `docs/design/seat-auth-failure.md` (2026-10-08, built as #2617) is the one
  precedent for the tick rotating a seat by itself. It calls
  `executeOrchestratorRotation` in-process from the tick, keys the attempt by a
  hashed incident id, persists before any external effect, and tells the
  operator through a bridge row and a seat-tick card. Its own words were
  "Context pressure stays advisory"; this design narrows that to "advisory
  unless the project turned auto-rotation on". Its machinery
  (`src/lib/monitor/seatAuthRecovery.ts`, 361 lines) is heavier than this
  problem needs, because credential repair, Telegram debt and account
  migration have no counterpart here. This design reuses its seams and its
  rotation call and drops the rest.

## 1. What exists today

| Concern | Where | What it does |
|---|---|---|
| Window policy | `src/lib/orchestrator/contextPolicy.ts:18`, `:37-52` | `ROTATION_THRESHOLD_FRACTION = 0.5`; a window comes from the model registry, **Claude only** (`:38` returns null for any other engine) |
| Usage reading | `src/lib/orchestrator/health.ts:69-92` (`readOrchestratorTranscriptFacts`), `:103` (`lastReportedContextTokens`, bounded tail scan), `:231` (`estimatedContextTokens`, incremental and cached), `:287-327` (`contextReading`) | provider-reported tokens beat any estimate; an estimate is labelled `estimated: true` |
| Advice | `health.ts:376-433` (`rotationRecommendation`) | `strongly_recommend` only for a reported count over the threshold; an estimate over it is a plain `recommend` (`:387`) |
| Advice readers | `src/lib/mcp/bindings.ts:4002-4004`, `:4056-4069` (`get_orchestrator`); `src/app/api/orchestrator/seat/status/incumbent.ts:157-160`, `:192-200` (panel) | the same composition twice; notes at `bindings.ts:4068` ("rotation never happens automatically") and `incumbent.ts:75` (`ROTATION_NOTE`, which already names the auth exception) disagree |
| Panel advisory | `src/components/orchestrator/OrchestratorPanel.tsx:1366-1392` (`RotationBanner`), `src/components/mobile/MobileOrchestratorSheet.tsx:1161-1240` | words, and the Rotate button acts only when pressed |
| Rotation | `src/lib/orchestrator/seatCommand.ts:1411-1426` (`executeOrchestratorRotation`), `:1477-1480` (`expectedIncumbentSeatEpoch` fence), `:1483` (update-drain hold for autonomous callers), `:1494` (`handoffNotes`), `:1515-1534` (mandate preserved, handoff compacted, digest summarizer), `:1556-1591` (successor request, `replaceIncumbent`, engine/model/cwd continue the incumbent) | predecessor keeps its session and host and loses manager authority only (`:1397-1400`) |
| Tick settings | `src/lib/monitor/seatTickSettings.ts:92-114` (row), `:167` (default), `:397-404` (`seatTickSettingsAfterLapse`), `:420-529` (`applySeatTickSettingsChange`), `:281-297` (SQLite `seat_tick_settings` collection) | one row per **project**; the nested `maintenance` object (`:86-91`, `:488-507`) carries its own `updatedAt`/`setBy` and needs no reason |
| Settings writers | tool `bindings.ts:4112-4258`, schema `src/lib/mcp/server.ts:4134-4135`; route `src/app/api/monitor/seat-tick/settings/route.ts:101-150` | both apply through `applySeatTickSettingsChange`; the actor is server-derived (`route.ts:79-87`, `bindings.ts:4162-4168`) |
| Tick state | `src/lib/monitor/types.ts:1068` (`SeatTickProjectState`), `src/lib/monitor/seatTickState.ts:225-250` (`normalizeRow`), `:358-387` (`seatTickStateForEpoch`, carries fields across a rotation) | SQLite accounting row per project; survives restart |
| Tick check | `src/lib/monitor/seatTickController.ts:1372` (`check`), `:1486` (`recoverSeatAuthentication`), `:1516` (decision), `:1589-1592` (re-read before send: a rotated seat is never woken), `:1702-1703` (wakes use `policy: "queue"`), `:1765` (journal `detail`) | runs every 5 min (`src/lib/monitor/seatTick.ts:141`), **also while wakes are off** (`seatTick.ts:1236-1255`) |
| Busy seat | `src/lib/monitor/seatTick.ts:366-378` (`seatTurnProgressing`); `src/lib/monitor/seatTickSources.ts:1121-1151` (`seatInput`) | `turn` from the registry, `activity` from liveness only when busy |
| Steering | `src/lib/delivery.ts:700-707` (`policy?: "queue" \| "steer-or-queue"`), `src/lib/runtime/structuredDeliveryQueue.ts:1228-1250`; `claudeStreamBrokerHost.ts:617` `supportsSteer = false`, `codexAppServerHost.ts:1311` `true` | `steer-or-queue` enters a running Codex turn and queues behind a running Claude turn |
| Seat-tick cards | `seatTickController.ts:236-270` (`cardText`), `:294-297` (`ensureSeatTickCard`, per-instance ref for `auth-failed`), `types.ts:1345-1347` (`SeatTickCard.kind`) | one Inbox card per `monitor-ref`, `open`/`resolved` |
| Bridge row from the tick | `seatAuthRecovery.ts:84-96` | `recordManagerReport` keyed by an incident id, origin `{kind:"agent", role:"seat-tick"}`, rendered by `renderReport`/`renderPlain` |
| Panel tick controls | `src/components/orchestrator/SeatTickBody.tsx:117-150` (maintenance draft), `:314-343` (`Toggle`), `:602-613` and `:628-746` (maintenance section: head, switch, hours input), `:833-913` (Details) | same body on desktop popover and phone sheet (`MobileSeatTickSheet.tsx`); one Save for everything (`:222-235`) |

The gap: the tick already reads the seat every five minutes and already knows
how to rotate it in-process, and nothing connects the context reading to that
call.

## 2. The setting: where it lives and how it survives

**On the project's seat-tick settings row**, beside `maintenance`, with the
same shape and rules:

```ts
// src/lib/monitor/seatTickSettings.ts, beside BoardMaintenanceSetting (:86)
export interface AutoRotateSetting {
  enabled: boolean;
  thresholdPercent: number;        // integer 50..90, default 50
  updatedAt: string;
  setBy: SeatTickSettingsActor;    // who (server-derived, as for every field)
  why: string | null;              // why, redacted, at most 200 characters
}
export interface SeatTickSettings { /* … */ autoRotate?: AutoRotateSetting | null; }
export interface SeatTickSettingsChange { /* … */
  autoRotate?: { enabled?: boolean; thresholdPercent?: number | string | null; why?: string | null };
}
export const AUTO_ROTATE_DEFAULT_PERCENT = Math.round(ROTATION_THRESHOLD_FRACTION * 100); // 50
```

Rules in `applySeatTickSettingsChange` (`:420`), mirroring `maintenance`
(`:488-507`):

- `"autoRotate"` joins the `touched` list (`:425`); the object is rebuilt with
  `updatedAt: context.at, setBy: context.actor`.
- `thresholdPercent`: `null` restores 50; a number is rounded and clamped to
  50..90 with a note (`autoRotate.thresholdPercent normalized to 90`), exactly
  as `intervalHours` is (`:496-505`); a non-number keeps the stored value with a
  note. The bounds are the issue's ("for example 50–90"); 50 is the advisory
  threshold, so the default rotates where the advice already turns strong.
- **Who and why.** `setBy` is the server-derived actor. `why` is required for
  every caller whose actor is not `gateway`: a seat or an agent arming the
  rotation must say on whose request («operator asked in the seat chat,
  2026-10-09»). The refusal reads `autoRotate.why is required: say why
  automatic rotation is being changed and on whose request`. The browser's
  actor is `gateway` (the operator's own session, `route.ts:81`), so the panel
  needs no reason field; the operator's own click is the why.
- It never affects `seatTickSettingsAreDefault` (`:178`): auto-rotation is no
  schedule, so it raises no tick-settings card and needs no `reason`.
- `normalizeRow` (`:218`) parses it with a `normalizeAutoRotate` beside
  `normalizeMaintenance` (`:210`); an invalid stored object reads as absent.

**How it survives.**

- *Rotations*: the row is keyed by project, never by seat, so every successor
  reads it. That is how the monitor note already survives rotation (#1280,
  `seatTickController.ts:1580-1588`). Nothing is copied at rotation time.
- *Restarts*: the row is in `state.sqlite` (`seatTickSettings.ts:281`).
- *A cadence expiry*: `seatTickSettingsAfterLapse` (`:397-404`) rebuilds the
  row from the default and today keeps only `reason`, `monitorPrompt` and
  `maintenance`. It must carry `autoRotate` too, or a one-hour "slow the tick"
  setting would silently disarm auto-rotation when it lapses. Same for the
  explicit `next` object in `applySeatTickSettingsChange` (`:508-518`).
- *Off*: `enabled: false` keeps the threshold so the next "on" restores it.

**Writers.**

- Tool: `seat_tick_settings` gains `autoRotate: { enabled?, thresholdPercent?,
  why? }` in `server.ts:4134` (zod, same style as `maintenance`) and one line in
  `bindings.ts:4131`. A compact read carries
  `autoRotate: { enabled, thresholdPercent }`, plus `lastAttempt` only when the
  last attempt failed; `setBy`, `updatedAt` and `why` are in the verbose read.
  This keeps the answer inside the 1800-byte budget
  (`src/lib/mcp/answerSizes.test.ts:119`).
- Route: one line in `route.ts:119`.
- `seatTickSettingsAnswer` (`src/lib/monitor/seatTickSettingsAnswer.ts:82`,
  built at `:248`) gains an `autoRotate` block for the panel:
  `{ enabled, thresholdPercent, defaultPercent: 50, minPercent: 50,
  maxPercent: 90, windowKnown: boolean | null, lastAttempt, setBy, updatedAt,
  why }`. `windowKnown` is `contextWindowPolicyFor(engine, model) !== null` for
  the active seat (registry read, no transcript read); null when there is no
  seat.

## 3. The trigger: the safe-point rule and the cooldown

One new module, `src/lib/monitor/seatAutoRotation.ts`, with a **pure** decision
and a thin effectful runner, called once from `check()` right after
`recoverSeatAuthentication` (`seatTickController.ts:1486`):

```ts
const autoRotateDetail = await runSeatAutoRotation(input, sources, readState, writeState, ensureCard, deliver, dependencies.seatAutoRotation ?? {});
```

Its detail joins the journal line at `:1765`. If it rotated, nothing else in
the check changes: the re-read before the send (`:1589-1592`) already sees the
new epoch and records `seat-rotated`, so the predecessor is not woken, and the
successor's first wake follows the ordinary bounds carried across the epoch
(`seatTickState.ts:370-371`).

### 3.1 Reading usage

A new optional port beside `seatTurnOutcome` (`seatTickSources.ts:465`):

```ts
seatContextUsage?: (conversationId: string) => {
  engine: "claude" | "codex"; model: string | null;
  tokens: number | null; windowTokens: number | null; estimated: boolean;
} | null;
```

The default (`seatTickSources.ts:632`) resolves engine, `generations.at(-1).path`
and `launchProfile.model` from the registry exactly as `seatTurnOutcome` does,
then composes the existing readers unchanged:
`contextReading({ policy: contextWindowPolicyFor(engine, model),
facts: readOrchestratorTranscriptFacts(path, null) })`. Passing `null` for the
session counts skips `readSession`, the one expensive read (`incumbent.ts:82`
says so). The tail scan reads one 256 KiB chunk in the normal case
(`health.ts:24`). The byte estimate is read only when no usage row is found and
is cached by inode (`health.ts:219-277`). That is cheap enough every five
minutes for an opted-in project. The port is only called when the setting is on.

### 3.2 Decision, in order

`autoRotationStep({ settings, seat, pendingSeat, state, usage, now, drainHeld,
authIncidentOpen })` returns `none | wait(detail) | nudge | rotate`, plus the
next `autoRotation` state:

1. **Off** (`settings.autoRotate?.enabled !== true`): `none`. Today's
   behaviour, byte for byte, apart from closing a still-open failure card (§6).
   The usage port is not called.
2. **No seat, a provisional seat** (`active.path === null`) or **a pending seat
   intent** (`sources.seatFor(project).pending`, `seats.ts:546-548`): `wait`
   ("a rotation is already pending").
3. **Authentication incident open** (`state.authIncident` with
   `recoveredThrough === undefined`): `wait`. The auth path owns that seat's
   rotation (`seat-auth-failure.md` §4).
4. **No window known** (`usage.windowTokens === null`, every Codex seat today):
   `none`, detail "no context window is known for <engine> <model>".
5. **Estimated** (`usage.estimated`): `wait`, detail "usage is an estimate;
   waiting for a provider-reported figure" (§5).
6. **Below threshold** (`tokens < windowTokens × thresholdPercent / 100`):
   `none`; clear `overSince` and `nudged` for this epoch. A compaction that
   brings usage back under the line ends the episode.
7. **Over threshold**: record `overSince = { seatEpoch, at }` if absent.
8. **Cooldown**: if `lastAttempt.startedAt + AUTO_ROTATE_COOLDOWN_MS > now`:
   `wait`, detail "cooldown until <time>".
9. **Update drain** (`activeDrain()`): `wait`, detail "held for the
   automatic update". No attempt is created, so the drain consumes no cooldown.
10. **Safe point?** The seat is at a safe point when no turn is running and
    the turn state is known:
    `seat.turn === "idle" || seat.turn === "terminal"
     || (seat.turn === "busy" && seat.activity !== null && !seatTurnProgressing(seat))`
    (the last clause is the stale "busy" record of a settled turn, #1262), and
    no wake is in flight to it
    (`state.outstandingWake?.conversationId !== seat.conversationId`). A wake
    still in the host's queue would otherwise start a turn on the revoked
    predecessor.
    - Safe: `rotate`.
    - Not safe, and `seatTurnProgressing(seat)`: `nudge` when §4 allows,
      else `wait` ("seat is mid-turn").
    - Not safe for any other reason (liveness unknown, wake in flight): `wait`.

**The safe-point rule in one sentence:** the tick rotates only a seat whose
turn has ended, with no wake queued to it, no other seat intent in flight, no
authentication incident, no update drain and no attempt inside the cooldown.
`executeOrchestratorRotation` never stops the predecessor's host
(`seatCommand.ts:1397-1400`), so even the rotation itself kills nothing; the
rule exists so the predecessor never loses its authority partway through work.

An idle seat that crosses the threshold rotates at the first check after the
crossing, within five minutes (`checkIntervalMs`), which is "within one tick".

**Wakes off.** Checks run while the tick's wakes are switched off
(`seatTick.ts:1236-1255`). Auto-rotation follows its own switch and still
rotates an idle seat then, because rotating sends the old seat nothing. Only the
nudge (§4) is withheld while wakes are off, since a message to the seat is
exactly what "off" forbids.

### 3.3 Cooldown

`AUTO_ROTATE_COOLDOWN_MS = 60 * 60_000`, a constant beside the policy in
`seatTick.ts`. It is measured from the start of the last attempt, whatever that
attempt's outcome. That gives at most one automatic rotation per hour per
project, and the same bound spaces retries after a failure. An hour is
far longer than a fresh successor needs to settle, and far shorter than it
takes to fill half of a 1M window (the live seat took about a day to reach
72%). Stored in tick state (§3.4), so a restart cannot reset it.

### 3.4 Tick state

One optional field on `SeatTickProjectState` (`types.ts:1068`), normalized in
`seatTickState.ts:225` and carried across epochs by `seatTickStateForEpoch`
(`:358-387`). The cooldown, and the attempt whose successor the next check
must confirm, both have to outlive the epoch change the rotation itself
causes.

```ts
autoRotation?: {
  overSince?: { seatEpoch: number; at: string };
  nudged?: { seatEpoch: number; at: string };
  lastAttempt?: {
    id: string;                     // `seat-autorotate:<project>:<seatEpoch>:<startedAt>`
    seatEpoch: number; conversationId: string; startedAt: string;
    tokens: number; windowTokens: number; thresholdPercent: number;
    state: "pending" | "rotated" | "failed" | "superseded";
    successorConversationId?: string; error?: string;
    told: { report: boolean; card: boolean };
  };
  failureTold?: { seatEpoch: number; id: string; resolved: boolean };
};
```

## 4. The busy-seat nudge

When the decision reaches step 10 with a seat whose turn is progressing, it
sends **one** message per seat epoch, and only if all of these hold:
`settings.enabled` (wakes on), `nudged?.seatEpoch !== seat.seatEpoch`, and
`now - overSince.at >= AUTO_ROTATE_NUDGE_AFTER_MS` (15 minutes, three
checks). The bounded time keeps a seat that is about to finish anyway from
being messaged.

Transport: the controller's own `deliver` (`seatTickController.ts:1381`) with
`policy: "steer-or-queue"`, `origin: delegatusMessageOrigin("seat-tick",
project)` and `clientMessageId: seat-autorotate-nudge-<sha256(project:seatEpoch)>`.
It does not go through the wake accounting (`prepare`/`beginDispatch`, `:1661`,
`:1695`): it carries no wake plan and commits no cursor, so it cannot fence or
settle a wake. `nudged` is written before the send. A crash between the two
loses at most the nudge, never doubles it, and the rotation still happens at the
safe point.

What it does per engine, read from the code:

- **Codex** (`supportsSteer = true`): the text enters the running turn at its
  next model request. Codex seats have no window policy yet (§3.2 step 4), so
  this path waits on the deferred Codex window work.
- **Claude** (`supportsSteer = false`): the message queues behind the running
  turn and starts one short turn when it ends. The rotation then happens at the
  next check after that short turn. The cost is one extra turn on a large
  context. In return the seat writes its own handoff before the tick rotates it.

Text (agent-facing, English like every wake):

> Delegatus auto-rotation: your context is at 86% of the window
> (provider-reported), over this project's auto-rotation threshold of 60%.
> Delegatus rotates this seat through the normal rotation at your next idle
> point. Finish or park the current step, record what your successor must know
> in your monitor note (`seat_tick_settings` `appendLine`), and end your turn.
> If you prefer to write the handoff yourself, call `rotate_orchestrator` with
> `handoffNotes` as your last action. Start no new long work.

A seat that rotates itself in answer is fine: the epoch moves, and the tick's
next check sees a fresh successor below the threshold.

## 5. Estimated usage

**Chosen: an estimate never triggers a rotation; the tick waits for a
provider-reported figure.** The margin option was weighed and rejected,
because the estimate is wrong in the direction that rotates. It is transcript
text bytes / 4 (`health.ts:311`), and a transcript keeps every byte across
compactions, tool output and record metadata, so it can read well over 100%
for a seat whose real context is small. No fixed margin bounds an error that
grows with the transcript. Waiting costs almost nothing for Claude seats,
because every assistant record carries `message.usage` (`health.ts:185-189`).
The estimate only appears on a transcript with no usage row in its last 4 MiB
(`health.ts:25`), and the next assistant turn ends that. The same line is
already drawn by the advice: an estimate never makes it `strongly_recommend`
(`health.ts:387`).

## 6. The rotation, failure handling and reporting

### 6.1 The call

`rotate` persists `lastAttempt` (state `pending`) **before** any external effect,
like `seatAuthRecovery.ts:288-290`, then:

```ts
const rotate = ports.rotate ?? (await import("@/lib/orchestrator/seatCommand")).executeOrchestratorRotation;
const result = await rotate({
  project, clientRequestId: `seat-autorotate-${sha256(attempt.id)}`,   // 80 chars, inside 8–128
  expectedIncumbentSeatEpoch: seat.seatEpoch,
  handoffNotes: `Automatic rotation at the context threshold: ${tokens} of ${windowTokens} tokens (${percent}%, provider-reported); threshold ${thresholdPercent}%.`,
}, undefined, null, { autonomous: true });
```

That is the path `rotate_orchestrator` reaches, unchanged: the same compacted
mandate and handoff digest (`seatCommand.ts:1515-1534`), the predecessor read
call in the header (`:1495-1510`), `replaceIncumbent` with the epoch fence
(`:1562-1566`), revoked manager authority, lineage
(`predecessorConversationId`), and engine, model and cwd continuing the
incumbent (`:1570-1589`). No mandate and no account are passed, so the mandate
is preserved and the spawn picks an account by capacity inside the project's
binding as for any rotation. `actor: null` records no human trigger, and the
`seat-autorotate-` prefix on the seat's `intent.clientRequestId` is what marks
the rotation as automatic in the seat history, which is how auth recovery
recognises its own (`seatAuthRecovery.ts:225`).

### 6.2 Outcomes

| Answer | Attempt state | Effect |
|---|---|---|
| 2xx, `ok !== false`, and `seatFor(project).active.intent.clientRequestId` is our key at a new epoch (same proof as `seatAuthRecovery.ts:339-340`) | `rotated` | tell (§6.3); a 202 provisional successor counts, and the next checks confirm it |
| 409 `incumbent_changed`, or the epoch moved | `superseded` | someone else rotated; nothing is told |
| `launch_held_for_update` / `AUTO_UPDATE_DRAIN` | stays `pending` | retried at the next check under the same key, outside the cooldown |
| anything else (413 handoff too large, a spawn refusal, a throw) | `failed`, `error` = the answer's `error` | old seat stays in charge (the seat store only switches on a successful activation); tell once (§6.3) |

A lost state write after the call is harmless. The next check finds the attempt
still `pending`, sees its key on the active seat and marks it `rotated`, or
replays the call with the same key. `guardedSeatTransition` replays an accepted
key (`seatCommand.ts:1421-1425`).

A successor whose launch dies after acceptance is rolled back to the
predecessor by the ordinary reconcile (`reconcileProvisionalSeat`,
`seatTickController.ts:1396`). The next check sees the active conversation equal
to `lastAttempt.conversationId` at a different epoch and turns `rotated` into
`failed`, with the seat history's `terminal_error` as the error when it is
still there. That failure is told like any other.

### 6.3 Telling: board card and bridge log

Both are written by the runner, in the operator's locale
(`operatorLocale()`), from a small `{ uk, en }` word table in the module, the
way `seatAuthIncident.ts` keeps its words.

- **Board card**: a seat-tick card, `ref: "seat-auto-rotation"`,
  `kind: "auto-rotation"` (new member of the union at `types.ts:1347`),
  `instance: attempt.id`. `ensureSeatTickCard` gives it a per-instance ref as
  it does for `auth-failed` (`seatTickController.ts:297`), and `cardText`
  (`:236-237`) gets the same one-line branch. Every rotation is an occurrence,
  and two rotations must be two cards.
  - Rotated: created and immediately resolved, so it lands in done as the
    record:
    > Оркестратора проєкту «Delegatus» автоматично ротовано: контекст 86%
    > (863 753 з 1 000 000 токенів, за даними провайдера), поріг 60%.
    > Попередній: conversation_…. Новий: conversation_….
  - Failed: created **open**:
    > Автоматична ротація оркестратора проєкту «Delegatus» не вдалася:
    > <error>. Контекст 86% (поріг 60%). Поточний оркестратор лишається на
    > місці. Наступна спроба після 04:10.
- **Bridge log**: `recordManagerReport({ key: attempt.id, origin: { kind:
  "agent", role: "seat-tick", conversationId: null }, project,
  targetSeatConversationId: <old seat>, class: "status" | "failed", at, body })`.
  The body comes from `renderReport`/`renderPlain` as in
  `seatAuthRecovery.ts:84-96`, with the same sentence as the card. The non-manager
  origin makes it read as Delegatus speaking (`src/lib/bridge/types.ts:144`).
  Skipped when `bridgeReportsEnabled(project)` is false.

**Once per failure.** `failureTold` is keyed by the incumbent's epoch. The first
failed attempt against an epoch writes the open card and a `failed` bridge row.
Later failed attempts against the same epoch, one per cooldown, write only
their journal line, which names the attempt and its error. The card and the log
carry no repeats.
The failure card is resolved when an attempt succeeds, when the epoch changes
by any other means (a manual rotation), or when the setting is turned off.

**Told only after the write.** `told.report` and `told.card` are set only
after the store answers. An unfinished telling is retried at each check while
that attempt is still the newest. Both keys are idempotent (`key` and the card's
create receipt), so a replay finds "already recorded". This is the #1298 rule
the controller already follows (`seatTickController.ts:1539-1548`).

**Journal**: each check's record `detail` carries
`auto-rotation: <decision detail>`, for example "auto-rotation: waiting, seat
is mid-turn (86% ≥ 60%)", "auto-rotation: rotated
seat-autorotate:…:20:… → epoch 21", "auto-rotation: failed again (told at
03:10)". That is what `seat_tick_settings verbose` and the panel's Details
"last check" line show.

### 6.4 Words that change

These sentences say rotation is never automatic, or only after an
authentication failure. Each gains the second exception and keeps everything
else:

- `src/lib/orchestrator/seatCommand.ts:1407-1409`
- `src/app/api/orchestrator/rotate/route.ts:9-13`
- `src/app/api/orchestrator/seat/status/incumbent.ts:30-33` and `ROTATION_NOTE`
  at `:75`: "…the seat tick rotates automatically after an authentication
  failure, and at the project's auto-rotation threshold when that is on"
- `src/lib/mcp/bindings.ts:4057-4061`, and the note at `:4068`, which becomes
  `ROTATION_NOTE` so the two readers stop disagreeing
- `src/lib/orchestrator/health.ts:5-16`, `:335`, `:366-375` and
  `contextPolicy.ts:12-13`: the recommendation stays words; the tick reads the
  same reading under an explicit per-project opt-in
- `src/components/orchestrator/incumbent.ts:10-11`, `OrchestratorPanel.tsx:1366-1371`

## 7. The panel control

**No new surface.** The control is a third section in the seat-tick body the
operator already opens from the panel's tick switch (`SeatTickBody.tsx`). It is
the same body in the desktop popover and the phone sheet. It reuses the
maintenance section's parts one for one: the section head and `Toggle`
(`:644-654`), the right-aligned number input row (`:676-693`), the one Save
(`SeatTickActions`, `:271`), and the refusal shown verbatim beside Save. No
paragraph of explanation. Because the surface is fixed by the existing
body and the pinned rule against new chrome, there is no layout choice to offer
as prototype variants. The rendered evidence in §9 covers the result.

```
 BOARD MAINTENANCE                    (  ○]
 …
 ─────────────────────────────────────────
 AUTO-ROTATION                        [●  ]
 At % of the context window          [ 60 ]
 ⚠ Last attempt failed 03:10: <error>. Next try after 04:10.   ← only after a failure
 ⚠ This orchestrator's model has no known context window…      ← only when windowKnown === false
 ─────────────────────────────────────────
 [ Save ]
 Details ▸   …  Auto-rotation set by the orchestrator 02:14: «operator asked in chat»
```

- Draft: `AutoRotateDraft { enabled; percent: string }` with
  `autoRotateDraftOf`, a signature on `[project, enabled, thresholdPercent,
  updatedAt]` and `autoRotateChangeOf`. It is a copy of the maintenance trio at
  `SeatTickBody.tsx:117-150`, with the same "send as typed, the server judges"
  rule. `useSeatTickDraft` (`:186`) merges it into the one `change`, so one
  Save writes tick, maintenance and auto-rotation together.
- The number row shows only while the switch is on, like the maintenance
  hours (`:676`), with `min=50 max=90` read from the answer.
- `SeatTickChange` (`useSeatTickSettings.ts:28-47`) gains
  `autoRotate?: { enabled?: boolean; thresholdPercent?: number | string | null }`;
  the optimistic overlay (`:149-175`) applies it as it applies `maintenance`.
  An auto-rotation-only refusal is scoped like a maintenance-only one (`:246`).
- Details (`:833-913`) gains one line from `autoRotate.setBy/updatedAt/why`,
  under the existing "set by" line, using the same `ACTORS` labels (`:826`).
- No change to the four-stop switch (`SeatTickSwitch.tsx`), the chip, the
  incumbent header or the rotation banner.

Strings, en / uk (`src/lib/i18n/en.ts`, `uk.ts`, beside `seatTick.maintenance.*`):

| Key | en | uk |
|---|---|---|
| `seatTick.autoRotate.head` | Auto-rotation | Автоматична ротація |
| `seatTick.autoRotate.enableAria` | Turn auto-rotation on | Увімкнути автоматичну ротацію |
| `seatTick.autoRotate.disableAria` | Turn auto-rotation off | Вимкнути автоматичну ротацію |
| `seatTick.autoRotate.thresholdLabel` | At % of the context window | При % контекстного вікна |
| `seatTick.autoRotate.thresholdPlaceholder` | {percent} | {percent} |
| `seatTick.autoRotate.lastFailed` | Last attempt failed {time}: {error}. Next try after {next}. | Остання спроба не вдалася {time}: {error}. Наступна — після {next}. |
| `seatTick.autoRotate.windowUnknown` | This orchestrator's model has no known context window, so it cannot rotate automatically. | Для моделі цього оркестратора розмір контекстного вікна невідомий, тому автоматична ротація для нього не спрацює. |
| `seatTick.autoRotate.setBy` | Auto-rotation set by {who} {at}{why} | Автоматичну ротацію налаштував {who} {at}{why} |

## 8. Seams touched (for the PR body)

The #2346 lane is changing idle-seat wake delivery in the same controller.
This change stays out of the wake path. Its seams in shared files are:

- `seatTickController.ts`: one call after `:1486`, one entry in the `detail`
  join at `:1765`, one optional port on `SeatTickControllerDependencies`
  (`:118-121`), the `auto-rotation` branch in `cardText` (`:236-237`) and the
  per-instance ref in `ensureSeatTickCard` (`:297`). There are no edits to
  `reconcileOutstandingWake`, the fence chain (`:1621-1648`) or dispatch
  (`:1649-1738`).
- `seatTickSources.ts`: the optional `seatContextUsage` port and its default.
- `types.ts`: `autoRotation` on `SeatTickProjectState`; the card kind.
- `seatTickState.ts`: `normalizeRow` and `seatTickStateForEpoch`.
- `seatTickSettings.ts`, `seatTickSettingsAnswer.ts`, `bindings.ts`
  (`seat_tick_settings` and the `get_orchestrator` note), `server.ts`, the
  settings route, `SeatTickBody.tsx`, `useSeatTickSettings.ts`, i18n.
- The comment and note sentences in §6.4.

`src/lib/pipelines/engine.ts` (#2537) is not touched.

After the PR opens, comment on #2577 with its link, in plain public wording
with no account names, paths or ids.

## 9. Test plan

All runs use isolated state: `LLV_STATE_DIR`, `HOME`, `XDG_CONFIG_HOME` and
`TMPDIR` under a fresh `mkdtemp` in the OS temp root, and
`LLV_VIEWER_CONTROL_URL` on a closed port. Each file runs by path, never as a
directory sweep (AGENTS.md). Heavy drivers go through
`scripts/gate-slot.sh`.

**New `src/lib/monitor/seatAutoRotation.test.ts`**, the pure `autoRotationStep`,
table-driven:

- **off by default**: no `autoRotate` on the row, seat idle at 86% reported:
  `none`, the usage port is never called, and the state is unchanged.
- **idle vs busy**: idle at 61% with threshold 60 gives `rotate`. `turn: "busy"`
  with `activity.lifecycle: "running"` gives `wait`. Busy with `activity: null`
  gives `wait`. A stale busy record (`waiting` with `turnState: "idle"`) gives
  `rotate`. A wake in flight to the seat gives `wait`.
- **nudge**: busy and over for 14 min gives `wait`. At 15 min it gives `nudge`
  once. The next check gives `wait`. With wakes off it gives `wait` with no nudge.
  A new epoch nudges again.
- **estimated vs reported**: estimated at 150% gives `wait`. Reported at 59% with
  threshold 60 gives `none` and clears `overSince`. Reported at 60% gives `rotate`.
- **cooldown**: an attempt 59 min ago gives `wait`, and at 60 min `rotate`, for
  each of `rotated`/`failed`/`superseded`.
- **fences**: pending seat intent, provisional seat, open auth incident, drain:
  `wait`, and no attempt is created.
- **no window**: a Codex seat or an unregistered model gives `none` with the
  detail.

**`src/lib/monitor/seatTickSettings.test.ts`** (and the `.sqlite` sibling for
the round trip): the default row has no `autoRotate`. A gateway enable needs no
why. A manager enable without `why` is refused and stores nothing. With `why` it
records `setBy` and `why`. 95 clamps to 90 with a note, and `null` restores 50.
`seatTickSettingsAfterLapse` and a schedule restore keep `autoRotate`. A row
written before the field reads as off.

**New describe in `src/lib/monitor/seatTickController.test.ts`**, "seat
auto-rotation through production seams", placed after the authentication
describe (`:7268`) and built the same way: a real Claude transcript whose
newest assistant row carries `message.usage` summing to the target tokens with
model `opus` (1M window), the real registry and seat store, the real
`executeOrchestratorRotation` with only `spawn` stubbed (as at `:7361-7375`),
the real bridge store and board, and `runSeatTickCheck`:

- **A, idle, reported 72%, threshold 60**: one check gives exactly one rotation.
  The epoch goes up by one, the successor's `predecessorConversationId` is the
  old seat, its `intent.clientRequestId` starts with `seat-autorotate-`, the
  mandate core is preserved, the handoff names the predecessor read call, and
  the monitor note and the `autoRotate` row are byte-identical (the successor
  inherits them). There is one resolved `auto-rotation` card and one `status`
  bridge row naming 72%, the threshold and both conversations. Three more
  checks on the fresh successor rotate nothing and tell nothing.
- **B, busy**: three checks with liveness `running` rotate nothing. At +15 min
  `deliver` is called once with `policy: "steer-or-queue"`, and later busy checks
  do not call it again. The turn then goes idle and that check rotates.
- **C, estimated**: a transcript with no usage rows and 6 MiB of text rotates
  nothing across three checks. The journal says "waiting for a
  provider-reported figure". Appending one usage row over the threshold rotates
  at the next check.
- **D, failure and cooldown**: `spawn` answers 500. The old seat stays active.
  One open card and one `failed` bridge row. Checks inside 60 min make no
  attempt. At +60 min a second failure adds no card and no row, only a journal
  line. At +120 min `spawn` succeeds: the failure card is resolved, and one
  success card and one `status` row are added.
- **E, off by default**: the same 86% idle seat with no `autoRotate` row: no
  rotation, no `deliver` beyond the ordinary wake, no card, no bridge row, and
  a journal `detail` identical to a run with the module stubbed out.
- **F, concurrent manual rotation**: the epoch moves between the decision and
  the call. The answer is 409, the attempt is `superseded`, and nothing is told.
- **G, restart**: after a failed attempt, a fresh controller over the same
  SQLite state still honours the cooldown and reads the setting.

**Tool and route**: `src/lib/mcp/bindings.test.ts`, where `seat_tick_settings`
with `autoRotate` answers `changedFields: ["autoRotate"]` and records the seat as
`manager` with its epoch and `why`; `src/lib/mcp/answerSizes.test.ts`, where the
read stays inside its budget; `src/app/api/monitor/seat-tick/settings/route.test.ts`,
where a browser PUT records `gateway` without `why`; `src/lib/mcp/orchestratorTools.test.ts`,
where `get_orchestrator`'s note equals `ROTATION_NOTE`.

**UI**: `SeatTickChip.dom.test.tsx` and `MobileSeatTickSheet.dom.test.tsx`
cover: switch on, type 60, Save sends
`{ autoRotate: { enabled: true, thresholdPercent: 60 } }`, the read-back
adopts, a refusal shows beside Save, and the window-unknown and last-failed
captions appear only in their states. Rendered evidence comes from the existing
driver, `src/components/orchestrator/issue1681Evidence.browser.test.tsx`
(`LLV_SEAT_TICK_BROWSER_TEST=1`, fixture `issue1681Evidence.fixture.tsx`), with
one added case. The section is shown on, with the failure caption, in en and uk:
the desktop popover at 1280 px with the 440 px dock and at 640 px with the
360 px dock, and the phone tick sheet at 390 px. The case asserts no
horizontal overflow, no clipped control, and Save reachable under the
popover's scroll cap. No new driver file.

**Unchanged, run by path**: `seatTick.test.ts`, `seatTickState.test.ts`,
`seatTickAccounting.test.ts`, `seatAuthIncident.test.ts`,
`src/lib/orchestrator/seatCommand.test.ts`, `rotationAccountChoice.test.ts`,
`rotationSettlement.test.ts`, `rotationAuthority.test.ts`,
`src/lib/orchestrator/health.test.ts`, `incumbent` and panel tests. `tsc` and
lint on the touched files.

## 10. Options weighed

- **Where the setting lives.** (a) The seat-tick settings row (**chosen**): it
  is project-keyed, so rotation-proof by construction. It already has the tool,
  the route, the panel, actor attribution and a nested-setting precedent
  (`maintenance`). (b) Project settings (`src/lib/projects/settings.ts`, home of
  `bridgeReports`/`mergeOnReview`): equally durable, but no tool writes it with
  attribution and no panel section shows it, so both would be new. (c) The seat
  record: dies with the seat it would have to survive.
- **Where the trigger runs.** In the existing check (**chosen**), after
  authentication recovery, so the two automatic rotations cannot race and the
  re-read before the send keeps the old seat unwoken. A separate timer would
  duplicate the seat read, the drain check and the epoch fence.
- **Estimate handling.** Wait for a reported figure (**chosen**, §5) over a
  margin.
- **Nudge transport.** A direct `steer-or-queue` delivery outside the wake
  accounting (**chosen**). Routing it through the wake would mean waking a busy
  seat, which the wake path exists to avoid (`seatTick.ts:366-378`). Leaving it
  out would fail the acceptance.
- **Cooldown.** A fixed hour (**chosen**). A setting would be one more number
  the operator has to understand, for a bound nobody has asked to tune.

## Deferred — not currently justified

- **Codex seats.** `contextWindowPolicyFor` returns null for every non-Claude
  engine (`contextPolicy.ts:38`), so a Codex seat never reaches step 5. Adding
  Codex windows changes the advisory too and belongs to its own issue. The
  panel says so with `windowUnknown`.
- **A configurable cooldown or nudge delay**: constants until someone needs
  another value.
- **A Telegram post per automatic rotation.** The requirement names the board
  card and the bridge log. Auth recovery's Telegram path carries its own retry
  debt (`seatAuthRecovery.ts:97-120`, `:145-172`), which a status event does
  not need.
- **A line in the rotation banner** ("rotates automatically at 60% when idle")
  and an `autoRotate` field in `get_orchestrator`. Useful, but each needs the
  incumbent read to join the tick settings, and the seat-tick body already
  shows the setting.
- **Rotating on the other advisory causes** (compactions, transcript size,
  host gone). The requirement is context usage only.
- **A safety margin on estimates**: rejected in §5, kept here as the
  alternative the issue offered.
- **Prototype variants**: no layout choice exists inside the reused section;
  revisit if the operator asks for the control anywhere else.

## Validation against the requirement

- *Off = advisory only*: step 1 returns before any read; test E.
- *Idle rotates within one tick; mid-turn waits; nothing killed*: §3.2 step 10,
  checks every 5 min; rotation never stops a host; tests A, B.
- *One rotation per cooldown; failure leaves the old seat and reports once*:
  §3.3, §6.2, §6.3; tests D, G.
- *Survives restarts and rotations; successor inherits*: §2; tests A, G and the
  lapse test.
- *Same path as `rotate_orchestrator`*: §6.1; test A asserts lineage, handoff
  and mandate.
- *Card and bridge log with reason, usage, old and new seat*: §6.3; tests A, D.
- *Estimated usage*: §5; test C.
- *Panel and tool, who and why, en/uk, existing controls*: §2, §7.
- *Tests for idle/busy, estimated/reported, cooldown, failure, off*: §9.

## Notes

- The live seat was at 86% during this design. Turning the setting on at 50%
  rotates it at its next idle point. That is the intended effect, and the
  operator may want to be present for that first rotation.
- `bindings.ts:4068` and `ROTATION_NOTE` already disagree on main (one says
  rotation never happens automatically, the other names the auth exception).
  §6.4 fixes that whatever else ships.
