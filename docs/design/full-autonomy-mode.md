# Full autonomy mode

## Originating requirement

The operator, 2026-10-14 23:45 UTC (02:45 Kyiv, the night into 2026-10-15),
by voice in Russian, in the Delegatus seat's own conversation, verbatim:

> Я думаю, что нам нужен какой-то режим, такой специальный, в котором мы,
> э-э, я включаю режим полной автономии, когда ты вот так... я ухожу спать.
> А ты. Решаешь всё без меня, по максимуму. Все вопросы. То есть, условно,
> это режим, в котором я полностью доверяюсь тебе. Все решения ты
> принимаешь, ты двигаешь работу дальше, ты ищешь сам новые... Проблемы,
> если, ну, я. Нет. Активной работы, то есть ты как бы сам придумываешь
> активную работу. И в тестовом режиме это... Этот режим можно запустить
> максимум на 8 часов потом, э-э, ну, точнее, нет, сделаем так. В тестовом
> режиме мы ставим это дефолтное. Дефолтное значение 8 часов, но можно
> увеличивать, там, я не знаю. По. Ну, пусть даже до бесконечности. Где-то
> это должно в тикере быть. Наверное, в настройках тикера. И при этом. Сама
> вот эта... сам вот этот слайдер, который у нас тикера показывается, там
> где пишется время, на композере, пусть. Как-то, знаешь, типа будет...
> Пусть у него, может, появится какая-то бегущая... бегущий бордер
> постоянно, когда он на полной автономии, то есть там... С какой-то
> периодичностью, чтобы вот была заметная как такая полоска, как змейка,
> которая ползёт. Что это, он работает автономно. Вот это можешь прототип.
> Всё, и продолжай, я ушёл. Теперь точно ушёл.

What the quote asks for, item by item:

| # | Requirement | Where this design answers it |
| --- | --- | --- |
| R1 | A mode the operator switches on when leaving (sleep) | §2 the setting |
| R2 | The seat decides everything, «по максимуму», every question | §4.1 |
| R3 | The seat keeps work moving | §4.2 |
| R4 | With no active work, the seat finds problems and invents work | §4.3, §3.2 |
| R5 | Default 8 hours, extendable, up to unlimited | §2.1 |
| R6 | Lives in the tick settings | §2.3 |
| R7 | The tick slider on the composer, «там где пишется время», shows a running border, a crawling «snake», while the mode is on | §6 |
| R8 | A prototype of that | §6.2 (variants for the prototype stage) |

The pinned specification adds what stays forbidden even in the mode (§5),
what the operator sees on return (§7), and 3–5 decision questions (§9).

## 1. What already exists

Everything below was read at `8a61dabe9` (main at the start of this lane;
`origin/main` had not moved when the design was finished).

**The setting's store.** `src/lib/monitor/seatTickSettings.ts` keeps one
row per project in the `seat_tick_settings` collection of `state.sqlite`
(`settingsStore`, `:309`). The row (`SeatTickSettings`, `:102`) already
carries four independent sub-settings beside the schedule, each with its own
`setBy` and `updatedAt`: `release`, `autoRotate`, `maintenance`, plus the
schedule fields `enabled`, `wakeIntervalMinutes`, `until` and the two
instruction fields `reason` (the panel's operator instructions, ≤ 500
characters) and `monitorPrompt` (the seat's own note). Expiry is evaluated
at read time (`effectiveSeatTickSettings`, `:369`), and the controller
persists a lapse when it sees one (`seatTickController.ts:1705`,
`seatTickSettingsAfterLapse`). Every change passes through the pure
`applySeatTickSettingsChange` (`:448`), which owns every refusal.

**Who writes it.** The browser panel calls `PUT
/api/monitor/seat-tick/settings` (`src/app/api/monitor/seat-tick/settings/route.ts`);
a request with no conversation is the actor kind `gateway` (`route.ts:82`),
a designated seat is `manager`, any other session is `agent`. Agents and the
seat call the MCP tool `seat_tick_settings` (`src/lib/mcp/server.ts:3422`
description, `:4362` schema, `src/lib/mcp/bindings.ts:4440` handler). The
answer both surfaces read is `seatTickSettingsAnswer`
(`src/lib/monitor/seatTickSettingsAnswer.ts:379`). Precedent for a guarded
sub-setting: `autoRotate.why` is required from every non-gateway actor
(`seatTickSettings.ts:543`), and only the seat or the operator may turn
`release.askBeforePublish` off, quoting the operator's request.

**The panel.** `src/components/orchestrator/SeatTickBody.tsx`, reworked in
#2396, is one body for the desktop popover (`SeatTickChip.tsx`, 320 px,
portalled) and the phone sheet (`src/components/mobile/MobileSeatTickSheet.tsx`).
Its order (`SeatTickBody.tsx:17-30`): status lines, «Пробудження
оркестратора» (switch, interval, «Термін» select, instructions), «Обслуговування
дошки», «Автоматична ротація», «Релізи», one Save, Details. The reusable
controls are the local `Toggle` (`:368`), `Select` from
`src/components/ui/Select`, the `UNTIL_CHOICES` expiry pattern with a
`keep` option for a stored expiry (`:50`), and `StatusLine` (`:401`).
Drafts live in `useSeatTickDraft` (`:227`); one save sends one change.

**The chip on the composer.** The «slider where the time is written» is
`SeatTickSwitch` (`src/components/orchestrator/SeatTickSwitch.tsx`), a pill
with four stops whose thumb carries the schedule word («1 год», «10 хв»),
mounted by `SeatTickChip` in the incumbent row directly above the seat's
composer (`IncumbentHeader.tsx:170`, in both the dock and the kanban seat)
and by the phone's tick row (`MobileSeatTickSheet.tsx:106`). Its styling is
in `src/app/globals.css:195-262`: a colour ramp `--tick-0..3` from the app's
tokens (`src/styles/tokens.css`), the track `.seat-tick-track`, the thumb
`.seat-tick-thumb`, and container queries (`:144-193`) that drop the word
and halve the travel in narrow hosts. Reduced motion already stills the
thumb's spring (`SeatTickSwitch.tsx:66`, `globals.css:258`).

**A running border already exists.** `.pane-attention::before`
(`globals.css:264-306`) draws two soft comets orbiting a card's edge with a
`conic-gradient` on an `@property --pane-angle`, masked to a 2 px ring,
3.4 s per lap, stilled under `prefers-reduced-motion`. It means «waiting for
you» on `BranchPane`. The marching-dash idiom `@keyframes loop-dash`
(`globals.css:663-690`) drives live review loops and pipeline rails. Both are
candidates to reuse; the first one's meaning is the opposite of autonomy,
which matters for §6.

**The seat's mandate.** `src/lib/orchestrator/prompt.ts`,
`ORCHESTRATOR_SYSTEM_PROMPT` (`:425`), version 54 (`:102`). Delivery
(`orchestratorMandateForDelivery`, `:634`) appends required sections to any
mandate. Measured on an export of `8a61dabe9` with Bun: the core is 25 897
bytes, the delivered default 29 379 bytes, and `prompt.test.ts:833` bounds
the delivered default below `MAX_STRUCTURED_TEXT_BYTES - 2 600` = 29 400
bytes. **The headroom is 21 bytes.** Any new mandate section has to be paid
for by cutting other text or by shrinking the rotation history's room (see
§4.5).

**The wake.** `src/lib/monitor/report.ts` composes every wake
(`seatTickWakeMessage`, `:233`) under a 4 000-character bound
(`SEAT_TICK_MESSAGE_LIMIT`, `:111`) split into a dynamic half (the agenda,
which gives way) and a reserved half that is never cut
(`boundedSeatTickMessage`, `:138`): operator instructions, the note, the
worker-limit line (v53 told the seat to obey «the worker limit each wake
names»), the contract pointer. `src/lib/monitor/seatTick.ts` decides whether
to wake (`decide`, `:1120`): only when something is owed; with no open work
(`hasOpenWork`, `:297`) it stays quiet except for the 24-hour **proposal
slot** (`:1593-1604`, `proposalIntervalMs`, `:144`), whose message
(`seatTickProposalMessage`, `report.ts:362`) asks for one ranked list card
in inbox and says «Open no GitHub issue and start no pipeline from this».
Inbox cards alone never wake the seat (`:1604`), because the operator's move
to `assigned` is what starts work.

**What the operator does by hand today.** On the night of the quote the
panel's instructions field read, in part: «НІЧ 15.10, оператор спить до
~04:00Z, НЕ турбувати. … Деплоїти main якнайшвидше … Вранці один звіт.»
The mode replaces that ritual: an expiry the instructions field does not
have (instructions survive every expiry by design, `seatTickSettings.ts:422`),
rules the seat does not have to be told each night, a visible state, and the
morning report as an obligation.

**Return surfaces.** «Готово» in «Чекають на вас» (`docs/design/done-section.md`,
`src/components/attention/DoneSection.tsx`) already collects every finished
outcome until acknowledged, including reports marked with `outcome`
(done-section §2.3). On 2026-10-10 (task `a16e413e`) the operator turned down
a «Вирішено без вас» section in that panel (done-section, Originating
requirement). This design adds no new panel section for the same reason.

**Prior work searched.** `search_transcripts` (project-scoped, then
unscoped: «режим полной автономии», «autonomy mode seat decides without
operator overnight», «autonomy audit 63c8e84a») and `search_memory`
(«autonomy overnight seat decides without asking»). Hits: the quote itself;
the after-absence digest lane of 2026-10-09 (task text «After-absence
digest: research what was done overnight»), which became «Готово»; the
2026-10-03 «autonomy audit», which was about lanes recovering after a
restart without a hand and has no bearing on this mode. No memory covered it.
No open pull request touches the tick settings or the switch (checked
against `origin/main` and the lane list at design time).

## 2. The setting

### 2.1 Shape

A per-project sub-setting of the seat tick row, beside `autoRotate`:

- **On / off.** Off by default. Nothing changes for a project that never
  turns it on.
- **Duration.** Chosen when it is turned on: **8 год** (default), 12 год,
  24 год, **Без терміну**. The end is stored as an instant (`until`), or
  null for unlimited. Choices are hours from now, the way «Термін» works for
  the schedule.
- **Extend.** While it is on, the same select offers «До 06:45» (keep, the
  stored end, as `untilKeep` does today) and the choices above, counted from
  now. Picking «Без терміну» extends to unlimited.
- **Expiry.** At `until`, the mode ends by itself, evaluated at read time
  like the schedule's expiry, so a Viewer that was down at the instant still
  reads it as ended. The seat returns to its normal mandate at the next wake,
  and the end triggers the return summary (§7). The schedule, instructions
  and note are untouched.
- **Turning it off early** (operator, panel or voice) ends it the same way,
  with the same summary.

### 2.2 Data model

Next to `AutoRotateSetting` in `seatTickSettings.ts`:

```ts
export interface AutonomySetting {
  enabled: boolean;
  /** When this episode started; the key the return summary is owed under. */
  startedAt: string;
  /** End instant; null = until someone turns it off. */
  until: string | null;
  /** Set when an episode ends: the instant and why. */
  endedAt: string | null;
  endReason: "expired" | "turned-off" | null;
  updatedAt: string;
  setBy: SeatTickSettingsActor;
  /** Required from every actor except the operator's own surfaces. */
  why: string | null;
}
// SeatTickSettings gains:   autonomy?: AutonomySetting | null;
// SeatTickSettingsChange:   autonomy?: { enabled?: boolean; hours?: number | null; why?: string | null };
```

- `normalizeAutonomy` beside `normalizeAutoRotate`; `hours` is clamped to
  1–8 760 (one year, the same ceiling `SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES`
  uses), null meaning unlimited.
- `effectiveSeatTickSettings` adds `autonomy: { active, until, startedAt,
  lapsed }`, with `active = enabled && (until === null || until > now)`.
  `seatTickSettingsAfterLapse` carries the autonomy row through a schedule
  lapse, and a schedule reset («Типові налаштування тікера») leaves it alone:
  the two expiries are independent, as `autoRotate` and `maintenance` already
  are.
- The controller persists an autonomy lapse (`enabled: false`, `endedAt`,
  `endReason: "expired"`) the way it persists a schedule lapse
  (`seatTickController.ts:1705`).
- Per-seat bookkeeping in `SeatTickProjectState` (`src/lib/monitor/types.ts`,
  next to `noteShown`): `autonomyShown` (the episode `startedAt` whose full
  rules a landed wake already showed this seat epoch) and `autonomySummaryFor`
  (the episode whose summary wake was delivered), so each is delivered once.
- No new collection, no migration: an absent field reads as off, and an
  older release rolling back ignores the field (`normalizeRow` drops unknown
  keys).

**Coupling with wakes.** The mode works through wakes, so
`applySeatTickSettingsChange` refuses `autonomy.enabled: true` while
`enabled` is false, and turning wakes off while the mode is on ends the
episode (`endReason: "turned-off"`). The panel shows both moves in the draft
before Save: switching autonomy on also flips «Пробудження оркестратора» on,
and only then, while the stored wakes are off, the section says so under the
duration («Разом з нею вмикаються пробудження оркестратора.»).

**Who may change it.**

| Actor | Turn on / extend | Shorten / turn off |
| --- | --- | --- |
| Operator (panel, `gateway`) | yes | yes |
| The project's seat (`manager`) | only with `why` quoting the operator's request (precedent: `askBeforePublish`) | yes, `why` required |
| Any other agent, unidentified | refused | refused |

A seat granting itself autonomy unasked is the one failure this table
exists to stop. Attribution follows the existing rule: the record, the
board card and the journal name who changed it.

### 2.3 Its place in the panel

A section **«Повна автономія»** directly under «Пробудження оркестратора»,
built only from what the panel already uses:

- the head row: label in the section-head style plus `Toggle`
  (`data-seat-tick-autonomy-enabled`);
- one line of `text-caption text-secondary` about what it does: «Оркестратор
  вирішує сам, рухає роботу й шукає нову. Заборонене лишається забороненим.»;
- while the draft is on: the «Тривалість» `Select` (8 год · 12 год · 24 год ·
  Без терміну; «До 06:45» while an episode stands);
- the shared Save; nothing else.

The status block gets one more `StatusLine` while an episode stands:
«Повна автономія · до 06:45 · лишилось 5 год 12 хв» (unlimited: «Повна
автономія · без терміну · з 22:45»). Its dot wears the ring's colour
(`--tick-3`), so the line and the chip read as the same mode; green stays the
health dot's. Details gains «Повну автономію увімкнув оператор 14 жовт.,
22:45»; the status block shows nothing more for the mode. The phone sheet gets the same section from the same body, with its
44 px targets.

Placing it under the wakes keeps the order
#2396 settled (status, then the switch that everything rides on) and
puts the coupling from §2.2 next to the switch it couples with.

## 3. What the tick does differently while the mode is on

### 3.1 The autonomy block in every wake

`seatTickWakeMessage` adds a reserved section (never cut by the agenda):

- On the first landed wake of an episode in each seat epoch, and after the
  episode changes (extended, shortened): the **full rules** from §4.4,
  at most 1 200 characters.
- On every later wake: one line, «Full autonomy: on until 06:45Z (5 h 12 min
  left); the rules from the wake at 22:45Z govern this turn.»

This is the #2030 pattern the note already uses (`seatTickPromptSection`,
`report.ts:192`): full once, a pointer after. A rotation starts a new seat
epoch, so a successor gets the full rules on its first wake.

### 3.2 Idle wakes that look for work

Today a board with no open work stays quiet for up to 24 hours (the
proposal slot). While the mode is on:

- **Inbox cards count as open work** and are named like `unstarted-task`
  items: under autonomy the seat starts them itself, without the
  operator's move to `assigned` (`seatTick.ts:270`, `isUnstarted`, and the
  `:1604` exclusion).
- **A new reason, `autonomy-idle`**, replaces the proposal slot: with no
  open work and the schedule's wake interval elapsed (default 60 min), the
  seat is woken with the open issues and signals the proposal message
  already gathers (`openIssuesForProposal`) and told to start the best one
  (§4.3) as a pipeline.
- **The existing retry guard bounds it** (`guardCount`, `retryGuard: 2`):
  two idle wakes that change nothing on the board or the pull requests hold
  the reason until something moves. A night with nothing worth doing costs
  two turns.
- **`autonomy-ended`**, once per episode (`autonomySummaryFor`), carries
  the summary order (§7). It is due at the next check after the end even with
  nothing else owed.
- The `worker-ask` reason's text (`seatTick.ts:1343`, the candidate that says
  «or ask the operator in a decision form») says «answer it yourself» while
  the mode is on.

The worker limit, the account bindings, the credit guard, the release gates
and the merge setting are read exactly as now. The mode adds turns; it moves
no limit.

## 4. What the seat does differently

### 4.1 Decides on its own

- A stage parked on `needs_decision`: the seat answers with the option it
  would recommend, through `pipeline_action resolve-decision`, and writes on
  the task: «Вирішено автономно: X, бо Y. Як повернути: Z.»
- Its own two-way choices: decides, prefers the cheaper and reversible
  option, records the same line, publishes **no** decision form.
- Forms already open (its own and its lanes'): settled with the recommended
  option and hidden with `dismiss_attention` and that reason; history keeps
  the undo. Scope is question Q2 (§9).
- A decision on the §5 list is the one exception: it stays a normal form
  and waits for the operator in «Чекають на вас».
- No question bridge reports, no `suggest_replies`, no `request_attention`
  (nobody is at the desk).

### 4.2 Keeps accepted work moving

Unchanged in kind: lanes to their merge bar, fixes, merges under the
project's merge setting, owed reports. What changes is that nothing waits
on the operator unless it is on the §5 list.

### 4.3 Creates work when idle

Within free worker slots, in this order, each as a board task marked
«автономно» with a pipeline on it:

1. inbox cards, by priority, oldest first;
2. open issues of the project (the proposal list), prefer labelled bugs and
   small items that finish something;
3. suggestions from the board maintenance report («Offer its suggested
   issues … and start none unasked» is lifted);
4. its own findings: a failing check on main, a stalled lane's root cause,
   a recurring manual intervention (the operator's standing rule that a
   workaround gets a root-cause lane).

Preferred: small, reversible, verifiable work with a review stage. Large
redesigns, UI that needs the operator's taste, and anything on §5 become
inbox cards for the morning instead. Sources are question Q4 (§9).

### 4.4 The rules the wake carries (draft, English, ≤ 1 200 characters)

> Full autonomy: on until 06:45Z, set by the operator, who is away and
> trusts you with every decision. Until it ends these replace the mandate's
> asking rules: decide yourself — answer parked stage questions with
> pipeline_action resolve-decision and your own choices with the option you
> would recommend; publish no decision form, question report, reply drafts or
> attention moves; write «Вирішено автономно: what, why, how to reverse» on
> the task. Keep accepted work moving to its merge bar. With free worker
> slots, start new work as tasks marked «автономно»: inbox cards, open
> issues, board-maintenance suggestions, then your own findings; prefer
> small, reversible, reviewed work. Still forbidden: [the §5 list, one line
> each]. Those wait as normal forms. The operator's instructions above win
> where they differ. When the mode ends you will be told to file one summary.

### 4.5 How the rules reach the seat: options

| Option | What it is | Cost | Verdict |
| --- | --- | --- | --- |
| **A. Wake block** (§3.1) | Full rules in the first wake of an episode per seat epoch, one line after | ~1 200 characters once a night, ~90 per later wake; no mandate change, no version bump; reaches bespoke and older mandates alike | **Recommended** |
| B. Mandate section, v55 | A «## Full autonomy» section, active when the wake says so, delivered like the other `DELIVERED_DIRECTIVES` | ~1 100 bytes on every seat, every rotation, forever; the delivered default has 21 bytes of headroom (§1), so it means cutting 1 100 bytes elsewhere or lowering the rotation history's room under `prompt.test.ts:833` | Rejected |
| C. Instructions field only | What the operator types tonight | 500 characters, survives every expiry, no state, no chip, no summary trigger | Rejected; it is the ritual the mode replaces |

Which mandate sentences the block suspends while it stands (quoted from
`prompt.ts`, all left in the mandate):

1. Personality (`:409`): «Its boundary: never start work nobody asked
   for» — suspended. The rest of that sentence («or change what the operator
   owns (settings, branches, checkouts, accounts, their own agents) without
   asking») stays; §5 restates it.
2. Start-by-default (`:499`): «new work you see is a proposal, started when
   the operator says so» — suspended.
3. Board report (`:260`): «Offer its suggested issues with suggest_replies
   and start none unasked» — suspended; «a card marked "ask first" only when
   the operator agrees» stays.
4. Prototype directive (`:415`): «every operator decision is a form» and
   «Before non-trivial or two-way work, or on request, use a form» —
   suspended except for §5 decisions.
5. Human in the loop (`:461-464`): «When a stage parks on such a question,
   ask the operator at once in a form» — replaced by resolve-decision.
6. The proposal wake's «Open no GitHub issue and start no pipeline from
   this» (`report.ts:406`) — not sent while the mode is on (`autonomy-idle`
   replaces the proposal).

The clock section, the tick contract, the fences, the merge bar, the
release rule and the cross-project rule stay in force as written.

## 5. What stays forbidden even in full autonomy (proposal)

The mode widens what the seat starts and decides inside its own project.
It grants no new permission outside it. Each item below waits as a normal
form, or as an inbox card for the morning:

1. **Releases and publication beyond the release setting.** Releases run
   only as `seat_tick_settings.release` already allows; `askBeforePublish`
   is not skipped; no package publish, no tag by hand.
2. **Other projects.** No tasks, pipelines, settings or merges in another
   project. The existing hand-off message to that project's seat stays
   allowed; that seat acts under its own mode.
3. **Accounts and spend.** No login, logout, binding change, account
   migration, new account, worker-limit change, role-mapping change, or paid
   generation; the credit guard stands.
4. **Operator-owned settings.** No change to the merge setting, release
   setting, auto-rotation, bridge reports, or the mode itself beyond
   shortening it; the operator's own agents and sessions are not stopped,
   messaged as the operator, or taken over.
5. **Destructive actions.** No force-push to the default branch, no
   history rewrite, no branch, pull request, issue or task deletion or
   closing of something the seat did not create, no deletion of user data
   or state, no restart beyond the standing deploy permission the project
   already grants.
6. **Outward words.** No new public issue, comment on another person's
   issue or pull request, Delegatus bug report (#2518 keeps its two operator
   steps), Telegram message to anyone, or post anywhere. Pull requests the
   lanes open on the project's own repository are normal lane output.
7. **Production of other machines** and anything reached over SSH that is
   not this project's own deploy path.

Question Q3 (§9) asks the operator to confirm the list or move a line.

## 6. The composer chip

### 6.1 State

`SeatTickSwitch` gets `data-seat-tick-autonomy="on|off"` from the answer's
`autonomy` block (via `seatTickReading`, `seatTickView.ts`), and:

- a ring element inside `.seat-tick-track` (an `aria-hidden` span or SVG,
  `pointer-events: none`), so it travels with the track in every host and
  survives the narrow forms where the word and half the travel are dropped
  (`globals.css:144-193`);
- the closed summary, `title` and value text gain «Повна автономія до
  06:45» (unlimited: «без терміну»), so a screen reader and a hover say what
  the motion says;
- the thumb word stays the schedule word: the ring carries the mode, the
  thumb keeps meaning cadence, and the 6 px health dot keeps meaning health.

**Reduced motion.** Under `prefers-reduced-motion: reduce` the ring is drawn
whole and still (2 px in the autonomy colour); the words above still carry
the end time.

**Colour.** One colour from the existing tokens, distinct from the health
dot's green and amber and from the attention border's state colour; the
prototype tries the accent (`--color-accent`) and the ramp's violet
(`--tick-3`, `globals.css:215`). Light and dark follow the tokens; mixes over
grey use oklab, as `globals.css:207` explains.

### 6.2 Variants for the prototype stage

Rendered at 1440 px and 390 px, light and dark, Ukrainian, on the incumbent
row above the seat composer (dock and kanban seat) and on the phone's tick
row; motion shown as frame sequences or short clips; each with its
reduced-motion still.

1. **«Змійка»** — one short segment, about a quarter of the outline, crawls
   around the pill at constant speed, about 4 s a lap, continuously. It fades
   evenly from a full-opacity head to a transparent tail, 2 px wide
   throughout, the way the attention comets fade. Drawn as
   an SVG rounded rect with `pathLength="100"` and an animated
   `stroke-dashoffset` (the `loop-dash` idiom), so its speed is even along
   the straight sides and the ends. A conic gradient from the centre (the
   `.pane-attention` technique) races at the ends of a pill this wide, which
   is why it is not the default here.
2. **«Біжучий пунктир»** — the whole outline is a fine dashed line whose
   dashes march slowly in one direction (`loop-dash`, a slower period than
   the pipeline rail's 0.7 s). Reads as «running» without a moving head;
   the calmest of the three.
3. **«Змійка раз на 10 с»** — the outline is a faint still ring; once
   every 10 s the variant-1 snake makes a single lap and fades. Answers
   «с какой-то периодичностью» literally; quietest between laps.

Not proposed: reusing `.pane-attention`'s two comets as is. That motion
already means «waiting for you» on the board's panes, the opposite message.

### 6.3 Where it appears

The ring is on the switch itself, so it appears wherever the switch is
mounted: the incumbent row in the dock and in the kanban seat (desktop) and
the tick row in the phone's seat sheet. The phone's seat card on the board
shows a badge only; giving it a ring is deferred (§10).

## 7. What the operator sees on return

One summary, due once per episode at its end (`autonomy-ended`, §3.2),
written by the seat in the operator's language:

- **one bridge report** (class `status`, marked with `outcome` as
  done-section §2.3 defines, so it waits in «Готово» as one item until
  acknowledged, and reaches Telegram as reports already do) with sections:
  1. зроблено (merged, deployed, closed), with links;
  2. вирішено за вас — every autonomous decision with how to reverse it;
  3. розпочато нове — tasks marked «автономно», their state;
  4. чекає на вас — the §5 decisions held as forms, and anything blocked;
  5. проблеми — incidents, failures, what the seat could not finish;
- the **same text in the seat's own conversation**, which is the only
  channel when the project's bridge reports are off.

Individual merges and deploys still land in «Готово» one by one as they do
today; the summary is the night's narrative on top. No new panel section
(the operator declined «Вирішено без вас» on 2026-10-10). Timing is question
Q5 (§9).

## 8. Files the build changes

| Area | File | Change |
| --- | --- | --- |
| Model | `src/lib/monitor/seatTickSettings.ts` | `AutonomySetting`, normalize, change, effective, lapse carry, wakes coupling, actor rule |
| Answer | `src/lib/monitor/seatTickSettingsAnswer.ts` | `autonomy` block: active, until, startedAt, remaining, setBy, why, endedAt, endReason |
| Route | `src/app/api/monitor/seat-tick/settings/route.ts` | accept `autonomy: { enabled, hours }` |
| Tool | `src/lib/mcp/server.ts` (`:3422`, `:4362`), `src/lib/mcp/bindings.ts` (`:4440`) | schema field, one description sentence, `why` rule |
| Tick | `src/lib/monitor/seatTick.ts`, `src/lib/monitor/types.ts` | `autonomy-idle`, `autonomy-ended`, inbox eligibility, worker-ask text, `autonomyShown`, `autonomySummaryFor` |
| Wake | `src/lib/monitor/report.ts` | reserved autonomy block, pointer line, idle and ended messages |
| Controller | `src/lib/monitor/seatTickController.ts` | persist the lapse, pass autonomy, record shown/summary |
| Panel | `src/components/orchestrator/SeatTickBody.tsx`, `useSeatTickSettings.ts`, `seatTickView.ts` | section, draft, status line, details |
| Chip | `src/components/orchestrator/SeatTickSwitch.tsx`, `src/app/globals.css` | ring, attribute, words, reduced motion |
| Words | `src/lib/i18n/uk.ts`, `src/lib/i18n/en.ts` | «Повна автономія», durations, status lines |
| Mandate | `src/lib/orchestrator/prompt.ts` | **none** under option A |

Checks the build owes: unit tests beside `seatTickSettings.sqlite.test.ts`
(lapse, coupling, actor refusals, unlimited), `seatTick.test.ts` (idle wake
under the guard, inbox eligibility, ended once per episode, nothing new when
off), `report.test.ts` (block full once per epoch, reserved under a full
agenda, ≤ 1 200 characters), `SeatTickChip.dom.test.tsx` and
`SeatTickSwitch.dom.test.tsx` (attribute, words, reduced motion). Rendered
evidence goes through the existing drivers named in AGENTS.md (the
`issue1681Evidence` fixture already renders the incumbent row and the
switch), never a new one-off script.

## 9. Questions for the operator

Each with options; the first option is the recommendation.

**Q1. Which running border on the chip?**
- **1 «Змійка» — one segment crawls the outline continuously (recommended):** the
  picture the quote draws («как змейка, которая ползёт», «постоянно»), even
  speed, noticeable and calm.
- 2 «Біжучий пунктир» — dashes march along the whole outline.
- 3 «Змійка раз на 10 с» — one lap every 10 s, a still ring between.

**Q2. Which decisions does the seat take on its own?**
- **Everything outside the §5 list, including forms already open and design
  variant picks; each is recorded with how to reverse it (recommended):**
  «Все решения ты принимаешь … по максимуму».
- Only decisions that come up during the episode; forms open before it wait.
- Only technical decisions; product and design choices wait as forms.

**Q3. The forbidden list (§5).**
- **As proposed: releases beyond the release setting, other projects,
  accounts and spend, operator-owned settings, destructive actions, outward
  words, other machines (recommended).**
- Stricter: also no merges and no deploys during the mode; they wait for
  the morning.
- Looser: also allow releases without the «ask before publish» step.

**Q4. When there is no active work, where does new work come from?**
- **Inbox cards, then the project's open issues, then board-maintenance
  suggestions, then the seat's own findings; started as tasks marked
  «автономно», checked every wake interval (recommended).**
- Only inbox cards and open issues; nothing the seat invents.
- Nothing is started: the seat writes ranked proposal cards for the
  morning, as the 24-hour proposal does today, only hourly.

**Q5. The return summary.**
- **One report when the mode ends (expiry or switch-off), waiting in
  «Готово», with the same text in the seat's chat (recommended).**
- Only a message in the seat's chat.
- Held until the operator's first message after the mode ends.

Decided in this design without a question, because the code or the quote
settles them: per-project scope (the tick settings are per project), the
duration choices (8 h default, 12 h, 24 h, unlimited), the wake block over a
mandate section (21 bytes of headroom), the actor table in §2.2, and the
placement under the wakes switch.

## 10. Deferred — not currently justified

- **A machine-wide switch for every project at once.** The quote names the
  tick settings, which are per project; one seat was running that night.
- **A ring on the phone's seat card badge.** The quote names the chip on the
  composer; the phone's tick row already carries the switch.
- **A countdown in the thumb.** The thumb means cadence; the end time is in
  the title, the value text and the panel's status line.
- **Presence detection** (ending the mode when the operator comes back).
  The operator turns it off or lets it expire; a guess at presence would end
  a night early on a stray tap.
- **A «Вирішено без вас» section.** Declined on 2026-10-10.
- **Separate budgets for autonomous work** (a cap on new lanes per night,
  a token budget). The worker limit, the credit guard and the retry guard
  already bound it; revisit if a night shows runaway starts.
- **Telegram notifications per autonomous decision.** The summary carries
  them; done-section settled «Telegram: nothing new».
