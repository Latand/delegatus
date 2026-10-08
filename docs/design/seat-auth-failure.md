# A seat whose turns fail authentication

## The requirement

Source: the operator, in the orchestrator seat's chat, 2026-10-08 about 10:05
Kyiv time, as the pinned specification of this pipeline carries it:

> «И остальные проблемы, смотри, запускай всё, решай. Пайплайнами.»

Standing rule behind it: every manual intervention gets a root-cause lane, and
pipelines run without manual rescue. The pinned outcome, verbatim:

> 1. A seat turn that ends on an authentication failure (the provider's
>    auth-required class Delegatus already classifies for stages) is recognised
>    by the seat tick after the FIRST such turn, not left to repeat.
> 2. The operator is told at once through a channel that does not depend on
>    the failed seat: the project's bridge/Telegram report path posted by
>    Delegatus itself and a board notice on the seat card, naming the engine,
>    the account, what failed and the one action that fixes it (log in again),
>    in the operator's language. Once per incident, not once per wake.
> 3. When another account of the same engine allowed by the project's binding
>    has capacity, the seat is rotated onto it automatically through the same
>    path rotate_orchestrator uses (handoff, predecessor link, fence, monitor
>    note carried), and the notice says so. When none is allowed, the notice
>    says which accounts exist outside the binding and that adding one is the
>    operator's call; nothing is added on its own.
> 4. Stages are not in scope (they already park on auth); the seat is.
>
> Acceptance: a test where the seat's turn fails with the auth class yields
> exactly one operator notice and either one rotation (allowed account with
> capacity) or a parked seat with the notice (none), and later wakes do not
> resend it; existing rotation and seat-tick tests stay green.

## The incident, read from the seat's transcript

From 2026-10-07 21:48Z to 2026-10-08 06:55Z the seat (Claude, account A) took
11 tick wakes. Every one landed, and every turn closed on the same synthetic
record:

```json
{"type":"assistant","error":"authentication_failed","isApiErrorMessage":true,
 "message":{"model":"<synthetic>","content":[{"type":"text",
 "text":"Failed to authenticate: OAuth session expired and could not be refreshed"}]}}
```

Each wake carried "Report owed … lane 567e4300 parked", so the owed report
stayed owed all night. At 06:55Z the operator ran `/login` in the seat, which
was interrupted, and then rotated the seat by hand onto account B. Account B
had been on the machine all along, outside the project's Claude binding.
Prior conversations hold no earlier design for seat authentication; the only
precedents are the stage path (§2) and the seat's MCP-dead fence (§4).

## 1. What exists today

| Concern | Where | What it does |
|---|---|---|
| Auth class | `src/lib/pipelines/providerConditions.ts:23` | `authentication_failed`/`unauthorized`, or the "OAuth session expired" text, gives `auth_required` |
| Turn evidence | `src/lib/pipelines/durableEvidence.ts:366` (`durableStageTurnEvidence`), field `terminalProviderMessage` at `:46` | reads a transcript tail; a terminal turn closed by an `isApiErrorMessage` record carries `{text, ts, errorClass}`. Engine-generic, keyed only by transcript path |
| Stage reaction | `src/lib/pipelines/engine.ts:5473-5477`, `:2116-2124`, `:2170-2172` | classifies, asks `resolveProjectSpawn` with the failed account in `unavailableIds`, switches or parks "no other allowed account" |
| Seat read by tick | `src/lib/monitor/seatTickSources.ts:1113` (`seatInput`) | registry turn state plus liveness; **never reads how the seat's last turn ended** |
| Wake landing | `src/lib/monitor/seatTickController.ts:1008` and `:1693` | "landed" commits the wake plan (cursor, shown children, announcements) whatever the seat then did with it |
| Seat fences | `seatTickController.ts:1603-1627` | rotated, update drain (`activeDrain`, `src/lib/selfUpdate/drain.ts:22`), MCP dead, outstanding wake, refusal circuit |
| Seat notices on the board | `seatTickController.ts:232` (`cardText`), `:289` (`ensureSeatTickCard`), `:1474-1486` (MCP card), `src/lib/monitor/types.ts:1334` (`SeatTickCard.kind`) | one Inbox card per `monitor-ref`, receipt per occurrence (`instance`), `open`/`resolved` |
| Tick state | `src/lib/monitor/types.ts:1066`, `src/lib/monitor/seatTickState.ts:225` (`normalizeRow`), `:342` (`seatTickStateForEpoch`) | one JSON row per project in the accounting SQLite |
| Rotation | `src/lib/orchestrator/seatCommand.ts:1395` (`executeOrchestratorRotation`) | handoff header, predecessor read call, compacted mandate, `expectedIncumbentSeatEpoch` fence (`:1544`), `accountId` passthrough (`:1568`); lineage in `src/lib/orchestrator/seats.ts:101`; monitor note lives in project settings, so it survives any rotation (#1280) |
| Agent launch hold | `seatCommand.ts:433` | update drain refuses only `triggeredBy.kind === "agent"` |
| Account choice | `src/lib/accounts/manager.ts:632` (`resolveProjectSpawn`), `src/lib/accounts/projectSelection.ts:186` (`selectProjectAccount`), `src/lib/accounts/projectBindings.ts:414` (`allowedAccountIdsForProject`) | the pool and capacity rule; `unavailableIds` drops an account; an unbound project with an exclusion selects by capacity across every account |
| Seat's account | `manager.ts:668` (`resolveTranscriptOwner`) | the account owning the seat's current transcript |
| Reports | `src/lib/bridge/service.ts:69` (`recordManagerReport`), origin type `src/lib/bridge/types.ts:119`, label `:144` | only the `bridge_report` MCP tool writes today (`src/lib/mcp/bindings.ts:3430`); key-idempotent |
| Telegram | `src/lib/projects/settings.ts:251` (`effectiveReportTelegram`), `src/lib/telegram/bot/service.ts:810` (`send`) | posts only to the chat the operator chose for the project; idempotent per `clientRequestId` |
| Credential files | `src/lib/accounts/claudeCredentials.ts:48` (`.credentials.json`), `src/lib/accounts/codex.ts:346` (`auth.json`) | rewritten by a login |

The gap fits in one sentence. Nothing that runs without the seat's
cooperation looks at how the seat's turn ended, so a seat that cannot reach its
provider looks identical to a seat that answered.

## 2. Detection point

In `check()` (`seatTickController.ts:1362`), after the gather and
`refreshSeatTickEvidence` and before `seatTickDecision` (`:1498`), beside the
MCP health read at `:1474`:

1. Skip when `input.seat` is null or `seatTurnProgressing(input.seat)`.
2. Read the seat's current generation from the registry: engine,
   `generations.at(-1).path`, and its account through
   registry account attribution, with transcript-path ownership as fallback.
   Credential launch eligibility does not participate in this attribution.
3. `durableStageTurnEvidence(engine, path)`, reused as it is. When
   `turn === "terminal"` and `terminalProviderMessage` is present, classify it
   with `classifyProviderCondition(engine, errorClass, text)`.
4. It is an **auth turn** when the class is `auth_required` and
   `terminalProviderMessage.ts` is later than both the seat's `designatedAt`
   and the open incident's `lastFailedTs`, when there is one.

One new port carries steps 2–3: `SeatTickSources.seatTurnOutcome(conversationId)`
returns `{ engine, accountId, path, auth: { ts, text } | null, normalTurnTs }`
(`seatTickSources.ts:463`). The tick checks every five minutes, so the
operator hears within one check of the **first** failed turn. The cost is a
128 KiB tail read per seat per check, which is the read stages already pay.

This covers a turn the operator started too, because the read covers whatever
turn ended last, whoever opened it.

## 3. One notice per incident, and its storage

**Incident identity**: `seat-auth:<project>:<seatEpoch>:<firstFailedTs>`.

**Storage**: one optional field on `SeatTickProjectState`, written through the
accounting row like every other field:

```ts
authIncident?: {
  id: string;                     // the identity above
  seatEpoch: number; conversationId: string;
  engine: "claude" | "codex"; accountId: string | null;
  firstFailedAt: string; lastFailedTs: number;
  credentialStamp: string | null; // repair time and incident-scoped credential fingerprint
  rotation: { state: "pending" | "held" | "rotated" | "none-allowed" | "refused";
              toAccountId?: string; successorConversationId?: string; error?: string };
  notice: { bridgeSeq?: number; telegram?: "sent" | "failed" | "skipped"; card: boolean } | null;
}
```

`normalizeRow` (`seatTickState.ts:225`) reads it, and `seatTickStateForEpoch`
(`:342`) carries it across an epoch change. The check that rotated must still
find its own record after the new epoch is current.

**The rule**:

- An auth turn with no open incident for this `seatEpoch` opens one. A later
  auth turn on the same incident only moves `lastFailedTs`, and nothing is
  sent.
- Credential contents are fingerprinted at launch admission (or readable
  activation for an existing conversation) and at
  each later check. A changed credential newer than the failed turn, before
  its first check, consumes that turn through the persisted
  `authRecoveredThrough` boundary. File timestamps alone cannot consume it.
  It leaves the repaired seat available across restart. A subsequent failure
  after the repair opens its own incident.
- The notice goes out once, after the rotation decision (§4), so it can say
  what happened. Each channel is idempotent under the incident id: the bridge
  key, the Telegram `clientRequestId`, and the card's create receipt
  (`instance` = incident id). A check that sent the notice and then lost its
  state write resends under the same keys, and every channel answers
  "already recorded".
- `notice` is written only after the channels answer, the same rule #1298
  applies to source-gap cards (`seatTickController.ts:1521-1528`).

**The incident closes** (the card is resolved and the field cleared) when any
of these holds:

- another seat becomes readable at a new epoch; a provisional automatic
  successor retains the incident, and restoring the same failed predecessor
  preserves its fence;
- the seat's transcript shows a successful assistant turn newer than
  `lastFailedTs` (`normalTurnTs`), without a terminal provider refusal;
- a readable account credential content fingerprint differs from the one
  retained in `credentialStamp`, meaning
  someone logged in again. Wakes resume. If the next turn fails again, that
  opens a new incident with one new notice, and that is new information: the
  login did not fix it.

Claude credentials follow the existing reader's file or Keychain authority.
File, Keychain and provider stamps retain an incident-scoped HMAC of credential contents;
credential values never enter the incident, notice or logs. Unreadable or
absent credentials do not establish a successful repair.
The metadata-only Keychain query reads the item's modification time to order
unobserved failures around a login, using the format emitted by
[Apple's security tool](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/keychain_utilities.c).
When that date cannot be verified, only the already-observed failure is consumed.
Compatible-provider accounts use the exported revision and modification-time
helpers for their token/runtime/header files. Transcript ownership follows the
registry and path attribution independently of credential launch eligibility,
so unsafe credentials still produce the authentication notice.
An unfinished predecessor notice retains only that predecessor's failures.
After it is delivered, the same check evaluates the successor's own failure;
the predecessor's recovery boundary cannot consume it.
Native account migration can keep both the conversation and the seat epoch.
It clears the old account's wake fence while preserving an unsent notice in
`authNoticesOwed`, under its original incident id. This debt survives restart
and epoch changes independently of the new account's authentication incident.
After the drain releases, its bridge and Telegram report is delivered once;
the board card is created and resolved, with refused channel writes retained
in their existing separate debt fields.

## 4. The automatic rotation rule

Run once per incident, in the check that opened it:

1. **Update drain**: if `activeDrain()` holds, set `rotation.state = "held"`
   and send nothing. Each later check retries step 2. Wakes are held by the
   same drain (`:1605`), so the seat loses nothing while it waits.
2. **Pick**:
   `accountManager.resolveProjectSpawn(engine, { project, model: seat.model, unavailableIds: [accountId] })`.
   This is the exact call stages make (`engine.ts:2118`). A bound project
   picks from its allowed accounts minus the failed one, by capacity. An
   unbound project picks by capacity across every account of the engine.
   Accounts outside the binding are never candidates (operator directive
   2026-09-10, `rotationAccountChoice.test.ts`: "ONLY autonomous selection
   and fallback stay inside the pool").
3. **`available`, a different account**: call `executeOrchestratorRotation`
   in-process with
   `{ project, clientRequestId: <incident id hashed to the 8–128 URL-safe form>, accountId: <picked>, handoffNotes: <one line: automatic rotation after authentication failure on <engine> account <label>> }`
   and `actor: null`, with trusted autonomous launch admission. The guard
   rechecks the current binding, target capacity and drain before helper and
   successor admission. The engine and model are omitted, so they continue the
   incumbent's (`seatCommand.ts:1548-1552`). This is the path
   `rotate_orchestrator` takes. The handoff names the predecessor's read
   call, `predecessorConversationId` records the lineage,
   `expectedIncumbentSeatEpoch` fences a concurrent manual rotation, and the
   monitor note stays on the project row. Passing the picked id explicitly
   matters, because the spawn's own automatic pick would not know the
   incumbent's account had failed. The spawn's health pass
   (`resolveHealthySpawnAccount`) still checks the target's credentials.
   - A successful receipt with the matching activated successor: `rotated`.
     A 202 successor remains provisional until readable. A terminal failure
     receipt does not prove a successful move.
   - 409 on epoch conflict: someone else rotated, so the incident closes and
     no notice is sent. The operator acted, so there is nothing left to tell
     them.
   - A late update drain: `held`, with no notice until release.
   - Any other refusal: `refused` with the error, and the seat is parked.
4. **`exhausted` / `unavailable`**: `none-allowed`. The seat is parked.
   Nothing is bound, and the binding record is never written.

**Parked seat**: while the incident is open with the state `none-allowed`,
`refused` or `held`, a new branch in the fence chain at
`seatTickController.ts:1610` records `delivery.outcome = "seat-auth-failed"`
and sends no wake. A wake into a seat that cannot reach its provider still
"lands" and commits its plan (`:1693`), so children are marked shown and
lanes marked announced for a seat that read none of them. Withholding the
wake keeps those owed for the recovered seat or its successor. The incident
closes on the three conditions in §3.

Rotation was "never automatic" until now (`seatCommand.ts:1392`,
`src/app/api/orchestrator/rotate/route.ts` header,
`ROTATION_NOTE` at `src/app/api/orchestrator/seat/status/incumbent.ts:75`).
Those three statements change to say there is exactly one exception: the seat
tick, after an authentication failure, onto an allowed account. Context
pressure stays advisory.

## 5. What the operator sees, and where

Language: `operatorLocale()`, Ukrainian by default. The words live in a small
`{ uk, en }` table in the new module, the way `reportWords.ts` keeps them.
Labels are account labels (`listClaudeAccounts`/`listCodexAccounts`), never
emails or ids.

**Rotated** (bridge class `status`; Telegram; board card resolved when the
successor is readable):

> Оркестратор проєкту «Delegatus» не зміг автентифікуватися: Claude, акаунт
> «A» — «OAuth session expired and could not be refreshed» (з 21:48).
> Сесію автоматично перенесено на акаунт «B»; новий оркестратор продовжує з
> передачею. Щоб акаунт «A» знову працював — увійдіть у нього ще раз.

**Parked, none allowed** (bridge class `blocked`, which opens the ask; Telegram;
board card left open):

> Оркестратор проєкту «Delegatus» не зміг автентифікуватися: Claude, акаунт
> «A» — «…» (з 21:48). Іншого дозволеного акаунта Claude з вільним лімітом
> немає, тому пробудження оркестратора призупинено. Виправлення: увійдіть в
> акаунт «A» ще раз. Поза прив'язкою проєкту є акаунти: «B», «C». Додати
> один із них до проєкту — ваше рішення; сам Delegatus нічого не додає.

**Refused**: the parked text, with "the move to «B» was refused: <error>".

An accepted successor remains provisional until its transcript is readable. The
authentication incident and open card survive this window. If the ordinary seat
reconciler restores the unrepaired predecessor after a failed launch, recovery
keeps the original incident and notice identity under the restored epoch, shows
the failed move on its card, and holds wakes until login or a newer normal turn.
An account migration can retain the conversation and designation epoch. A verified
change of the transcript's current account ends the old credential scope before
judging the new account's failure, so its first failure has an independent notice.

All credential backends compare an incident-scoped content fingerprint;
metadata availability alone cannot clear the authentication fence. A verified
modification time supplies ordering once the credential itself has changed.

The incident's failed conversation remains authoritative across a lost outcome
write and bounded terminal-history trimming. The ordinary command's terminal
history supplies the refusal detail when it is still available.

Channels, none of which runs through the seat:

- **Bridge**: `recordManagerReport({ key: <incident id>, origin: { kind:
  "agent", role: "seat-tick", conversationId: null }, project,
  targetSeatConversationId, class, body })`. The body is rendered by
  `renderReport` with a summary and one `decision` item, so it is scrubbed
  and bounded like a seat's own. The origin is a non-manager origin, so
  `bridgeReportOriginLabel` frames it as Delegatus speaking (`types.ts:144`),
  and the type needs no change. Reports switched off for the project skip
  the bridge row.
- **Telegram**: when `effectiveReportTelegram(project)` names a chat, post
  `renderTelegram(cut)` through `telegramBotService().send({ conversationId:
  null, clientRequestId: <incident id>, chat, text, format: "html" })`. It is
  sent with sound, since this one asks for action. The outcome is recorded
  with `recordBridgeReportTelegram` (`src/lib/bridge/store.ts:894`).
- **Board**: a seat-tick card, `ref: "seat-auth-failed"`,
  `kind: "auth-failed"`, `instance: <incident id>`, written by
  `ensureSeatTickCard`. It lands where the operator already finds the
  seat's other conditions ("Orchestrator seat cannot use its Viewer MCP",
  no seat, unresolved wake). Its text is the notice above, and it resolves
  when the incident closes.
- **Journal**: the check's run record carries `delivery.outcome` and a
  `detail` naming the incident id and rotation state, so
  `seat_tick_settings verbose` explains the silence.

A repaired incident whose notice is drain-held retains its original identity
and a recovered boundary until reporting completes. It no longer fences
authentication admission or rotates the repaired account. Authentication card
references include a bounded hash of their incident, so an older owed card
can be created and resolved alongside a newer open notice.

Known Telegram refusals before any send are retained independently in the project
state and retried under the original incident key. They survive credential repair,
seat rotation and restart, including when bridge reporting is disabled. Retries
respect the drain and leave successful successors free to work. Uncertain or
partial sends keep their original bot receipts and are never automatically posted
under a new key. Aborted turns and terminal provider refusals cannot substitute
for a successful assistant turn when proving authentication recovery. The
assistant message's own timestamp supplies that proof; a later empty completion
cannot promote an older answer. A refused board creation remains owed independently under its original
incident key until its card exists. Credential repair releases the seat while
the board is full or its writer fails; the eventual notice card is then created and resolved.

## 6. Test plan

All runs use isolated state: `LLV_STATE_DIR`, `HOME`, `XDG_CONFIG_HOME` and
`TMPDIR` under a fresh `mkdtemp` in the OS temp root, and
`LLV_VIEWER_CONTROL_URL` pointed at a closed port. Each file runs by path,
never a directory sweep (AGENTS.md "Never run this repo's suites against the
operator's live state"). Account and project names are invented.

**New `src/lib/monitor/seatAuthIncident.test.ts`**, the pure rule: open,
dedupe a later auth turn, close on epoch, a normal turn or a credential
stamp, and compose the uk/en text for rotated, parked and refused.

**New cases in `src/lib/monitor/seatTickController.test.ts`**, driving the
real `runSeatTickCheck`:

- **Production seams**: the seat transcript is a real JSONL file holding the
  exact incident record above, read by the real `durableStageTurnEvidence`
  and classified by the real `classifyProviderCondition`. Account homes and
  `account-project-bindings.json` live in the sandbox and are read by the
  real `resolveProjectSpawn`, as `rotationAccountChoice.test.ts` does. The
  rotation is the real `executeOrchestratorRotation` against the real seat
  store, with only `spawn` stubbed to an accepted launch, as
  `seatCommand.test.ts` does. The bridge row lands in the real store. The
  Telegram transport and `deliver` are stubs that count calls.
- **A: allowed account with capacity**: the binding allows A and B, and A's
  turn fails. One check gives exactly one rotation: epoch +1, the successor's
  `predecessorConversationId` is the failed seat, the spawn asked for B, the
  monitor note is unchanged. It also gives one bridge row (class `status`),
  one Telegram send and a resolved card. Three more checks, with a further
  auth record appended to the old transcript, add no notice and no rotation.
- **B: none allowed**: the binding allows only A, and B exists unbound. One
  notice (class `blocked`) names B as outside the binding, no rotation, the
  binding file is byte-identical, and the card is open. Three more checks
  send zero wakes (`seat-auth-failed`) and zero notices. Rewriting A's
  credential file lets the next check send a wake. Appending a normal
  assistant turn instead closes the incident and resolves the card.
- **C: no incident**: a terminal usage-limit record, an ordinary answer, and
  an auth record older than `designatedAt` all leave the state untouched and
  send the wake as before.
- **D: update drain**: an active drain lease holds both rotation and notice.
  The first check after the lease ends sends one of each.
- **E: lost write**: `writeState` throws once after the notice. The next
  check replays, and the bridge, Telegram and card each report one record.
- **F: concurrent manual rotation**: the epoch moves between the pick and the
  call. The answer is a 409, the incident closes, and no notice is sent.

**Unchanged and run by path**: `src/lib/monitor/seatTick.test.ts`,
`seatTickController.test.ts`, `seatTickState.test.ts`,
`seatTickAccounting.test.ts`, `src/lib/orchestrator/seatCommand.test.ts`,
`rotationAccountChoice.test.ts`, `rotationSettlement.test.ts`,
`rotationAuthority.test.ts`, `src/lib/pipelines/providerConditions.test.ts`,
`durableEvidence.test.ts`. Run `tsc` and lint on the touched files. The
change touches no UI component, so it needs no rendered evidence. The card
is text on an existing surface.

## 7. Options weighed

- **Detection source.** Option one reads the delivery outcome of the wake.
  It sees nothing here, because all 11 wakes *landed*. Option two reads the
  seat's terminal turn from its transcript, through the reader stages
  already trust. **Chosen: the transcript.**
- **Board surface.** The seat-tick card (chosen) reuses an existing writer,
  receipt and resolve path, and costs no UI. A new `auth_failed` cause in the
  seat panel's rotation advisory (`src/lib/orchestrator/health.ts:356`,
  `src/components/orchestrator/incumbent.ts:33`) would sit closer to the
  words "on the seat card". It would also need panel, phone row and i18n
  work plus rendered evidence, all to repeat what the card and Telegram
  already say. It is deferred below.
- **A parked seat's wakes.** Waking on the normal cadence would probe the
  re-login for free, but each landed wake consumes obligations the seat
  never read. **Chosen: withhold**, and reopen on a credential change, a
  normal turn or a rotation.
- **Number of rotation attempts.** One per incident. Walking further
  candidates after a refusal would mean more seat intents burnt per incident
  for a case (two allowed accounts failing at once) the incident does not
  show.

## Deferred — not currently justified

- Seat panel and phone row cause for an auth failure (see §7).
- A "seat recovered" notice when a parked incident closes. The resolved card
  already says it.
- Trying a second allowed account after the first rotation is refused.
- Rolling back the wake plan that the first failed wake committed. That is
  #1604's question of what "told" means across a rotation, and the successor
  starts from epoch-scoped state anyway.
- Rotating a seat on a usage limit. That is another class with its own
  reset, near #2537's stage work.
- Any automatic edit of the project's account binding. Item 3 forbids it.
- Stages, which already park on auth (item 4).

Fences respected: no change to `src/lib/pipelines` restart paths (#2570),
`src/lib/selfUpdate` (#2555: `activeDrain` is only read), `src/lib/runtime`
delivery (#2572), stage provider recovery (#2537: `classifyProviderCondition`
and `durableStageTurnEvidence` are only imported), or the voice companion
(#2542).
