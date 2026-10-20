# Task cards: approximate provider limit spent — research

- Status: research for acceptance item 1 of this lane. No product change; the
  prototype stage renders the three designs in §7.
- Grounded on: `main` at `8ae633052` (2026-10-20). No open pull request touches
  `src/lib/activity/**`, `src/lib/limits*`, `src/lib/accounts/migration/quotaController.ts`,
  `src/components/kanban/KanbanCard.tsx`, `kanbanBoard.css` or
  `src/components/taskAlbum/**` (checked with `gh pr list` over the 7 open pull
  requests), and no open lane on the board names those areas. `origin/main`
  moved two commits to `b7f71349b` by 20:50Z; of the cited files only
  `src/lib/pipelines/types.ts` changed (three lines added at 665, so
  `taskIds` sits at `:1077` there).
- Evidence: measured on this host on 2026-10-20 between 20:25Z and 20:45Z, over
  `VACUUM INTO` copies of the activity store and the state database, copies of
  the limits history and cache, a read-only query of the agent registry, and
  the Codex rollouts read in place. Only counts, sums, percentages and field
  names were extracted. Accounts are named by engine, a letter and their plan
  tier (Claude A, B and C are Max; Codex A is Pro, B Pro Max, C Pro Lite, D
  Pro). Appendix A gives the procedure.
- Prior work: `search_transcripts` (project-scoped: "task card limit spent per
  provider percent of weekly limit") found this lane's brief, the account
  picker lanes (weekly limit left as a chip) and the token-usage lanes.
  `search_memory` found nothing. `docs/design/activity-token-usage.md` §8
  listed "tokens per task, lane and PR" (E4) and "limits beside tokens" (E3)
  as optional extras; neither was built (`src/lib/activity/tokenReport.ts:15`
  has no task or pipeline dimension).

## Originating requirement

Source: the operator, 2026-10-20, in the seat chat, with a screenshot of the
board's in-progress column (private; the pinned specification keeps the words
to agents). Paraphrase: on each board task, show roughly how much of each
provider's usage limit the task's work consumed; compact, good-looking, only
useful information; for now research and a board task with two or three
prototype variants, with no implementation.

§9 checks the result against it.

## Decisions in one screen

| # | Decision | Why |
|---|---|---|
| 1 | A task's tokens come from the #3048 store: `usage_hours` rows whose `pipeline` is one of the task's lanes, plus the rows of its assignment conversations outside any lane. | The `pipeline` column equals the lane's attempts exactly on the measured lane (16 conversations, every account total equal, §1.5); no conversation belongs to two lanes (0 of 6 725). |
| 2 | Limit share is estimated as the task's price-weighted tokens × the account's own rate of percentage points per weighted dollar over the trailing 7 days (method R, §2.4). | Most tasks spend under 1 percentage point of a week (median 0.6), below the 1-point resolution of every reading, so per-task deltas of `used_percent` read 0 or 1. The rate method is accurate to about ±30 % at the median (§3). |
| 3 | The unit on the card is percent of the account's weekly window, summed per provider; the 5-hour Claude window appears only in the popover while the task runs. | Weekly is the one window both providers report (Codex reports no 5-hour window on any of the four accounts here). It matches the sidebar's units. |
| 4 | Each card reads a precomputed per-owner day aggregate through one batched request per board, like the album button. | 100 cards read 0.23 ms from such a table at the store's upper bound; summing `usage_hours` at the same bound takes 60 ms (§4). |
| 5 | Every Codex account gets a limit history by recording the quota controller's observations. | Today only the active Codex account is recorded, and it has a reading in 61 % of its active hours (§1.4). |
| 6 | Three information designs go to the prototype stage: numbers on the task's fact line (recommended), a dot scale on the state line, and per-lane figures on the chain row (§7). | They differ in where the figure sits and what the popover breaks down: accounts, context in the week, or stages. |

## 1. What data exists per task

### 1.1 From a task to its conversations

| Link | Where | Measured |
|---|---|---|
| Lanes | `Pipeline.taskIds` (`src/lib/pipelines/types.ts:1074`); attempts carry `conversationId` (`:420`), `accountId` (`:425`), `startedAt`/`completedAt` (`:518-519`); the engine and model are in `effectiveRole` | 702 of 2 653 tasks have a lane, 285 have two or more, 47 have five or more, one has 38. 26 lanes name more than one task (23 name two, 3 name three); they hold 1.46 B of 78.1 B lane tokens (1.9 %). |
| Assignments | `BoardTask.assignments` (`src/lib/tasks/types.ts:235`), each with `conversationId`, `accountId`, `engine` (`:109-130`) | On the tasks updated since 2026-10-12, 1 303 assignment conversations sit outside every lane, with 14.9 B tokens; 80 of them are orchestrator conversations holding 8.93 B. |
| Registry memberships | the activity resolver takes the newest pipeline membership of the conversation (`src/lib/activity/conversationResolver.ts:58-60`, `:117-118`) | 6 725 conversations have a pipeline membership; none has two distinct pipelines. |

So a task's own work is: every lane in `taskIds`, and every assignment
conversation that is in no lane and is not an orchestrator seat. The seat
conversation works for many tasks at once (its role holds 5.31 B of the
46.9 B tokens of the last 8 days, 11 %), and only the card that holds the seat
(`card.holdsSeat`, `src/components/kanban/KanbanCard.tsx:401`) can carry it.

### 1.2 Tokens: the #3048 store

`usage_hours` (`src/lib/activity/tokenStore.ts:37-43`) holds one row per UTC
hour, conversation digest, model, tier and account, with `engine`, `project`,
`role`, `member`, `pipeline` and `stage`, and seven counters (requests, fresh
input, cache read, cache write and its 1-hour part, output, reasoning).

- Writer: `commitUsage` (`tokenStore.ts:117-177`), called inside
  `ActivityStore.commitFile` (`src/lib/activity/store.ts:399`) in the same
  transaction as the transcript cursor. It writes `pipeline` and `stage` from
  the turn owner (`tokenStore.ts:157-159`). Claude responses, Codex
  `token_usage_record`s and legacy Codex `token_count` deltas all pass through
  it; remote pulls send no token rows (rows are `host = ''`).
- Account: the registry generation whose `createdAt` is the latest at or
  before the response, else the store the transcript lives in
  (`src/lib/activity/tokenAttribution.ts:73-95`); stored as `engine:id`
  because both engines name their main account alike
  (`src/lib/activity/tokenUsage.ts:34-35`).
- Retention: 92 days (`tokenStore.ts:8`, pruned in `maintainUsage`,
  `:189`). `usage_days` keeps 25 months and has no `pipeline` or
  conversation column (`:21-27`).
- On this host: 14 233 hour rows from 2026-07-20 to 2026-10-20; 1 403
  distinct lanes; 78.1 B of 104.7 B tokens carry a lane. The last ingest pass
  had read 70 s before the copy, and the newest row was the current hour.
- No index leads with `pipeline`; the primary key starts with `host, hour`.

Cost: `src/lib/activity/tokenPrices.ts` prices each model and tier at the
providers' published API rates (dated table, `:17-21`, `:34-72`,
`tokenCost` at `:96-102`). It is the weight the estimate needs (§2.4).

### 1.3 Per engine and per account

Every `usage_hours` row names one engine and one account, so a task's tokens
split by both without further work. Copilot and OpenClaw usage is not read by
the ingest (`docs/design/activity-token-usage.md` §1.3), so those engines
have no tokens to show.

### 1.4 Account usage windows

| Source | What it holds | Measured |
|---|---|---|
| `limits-history.json` (`src/lib/limitsHistoryStore.ts`) | per engine, account and window, samples of percent left; at most one per 5 minutes (`:17`), 8 days (`:15`), 4 000 points (`:19`) | 7 series: Claude A, B, C (5-hour and weekly) and one Codex weekly. 1 146–1 862 samples each from 2026-10-12T20Z. Every value is a whole percent. |
| Who appends | `remember()` → `recordLimitSample` (`src/lib/limits.ts:269-292`, call at `:286`), reached by `resolveEngineRead` (`:395-412`) | Claude: every account, because the quota controller reads each one through `readClaudeAccountLimits` (`limits.ts:498`, `quotaController.ts:152`). Codex: only the active account through the footer's `readLimits` (`limits.ts:440-458`); the controller reads Codex accounts with `readCodexLimits` directly (`quotaController.ts:57`) and records nothing to the history. |
| Registry observation | the latest observation per account (`src/lib/agent/registry.ts:10226-10231`), what `account_limits` answers | one row per account, no history |
| Codex rollouts | `token_count` events carry `rate_limits.primary.{used_percent, window_minutes, resets_at}` and `plan_type` for the account that ran the response | 246 518 readings from 3 250 rollouts since 2026-10-11T21Z; every value whole; `window_minutes` 10 080 on all four accounts (no 5-hour window) |
| Window shapes | `LimitWindow` (`src/lib/types.ts:661-675`): `usedPercent`, `resetsAt`, `windowMinutes`; Claude also reports a separately metered Fable weekly (`tiers`) | Claude: 5-hour and weekly; Codex: weekly only |

Hour coverage (hours in which the account recorded tokens, and of those the
ones with a reading in the same hour):

| Series | Hours with tokens | With a reading | Longest gap |
|---|---|---|---|
| Claude A, B, C history | 152 / 158 / 107 | 100 % / 99 % / 100 % | 1.2 h / 7.6 h / 13.0 h |
| Codex B history (the active account) | 174 | 61 % | 30.3 h |
| Codex A, B, C, D rollouts | 164 / 198 / 74 / 169 | 100 % each | readings arrive with responses |

What the Codex readings showed besides usage:

- Early restarts. Every Codex account's week restarted 3 to 6 times in 8 days.
  All four restarted within half an hour of each other on 2026-10-13 near
  05:00Z and 2026-10-15 near 06:15Z, within seven hours of each other on 2026-10-17/18,
  and the three still active at 06:32Z on 2026-10-20. One account restarted
  twice more, at the times a reset credit was redeemed (2026-10-14 22:47Z and
  10-15 19:33Z in `codex-reset-credits.ndjson`). `resets_at` jumps forward and
  the value falls to 0.
- A fall inside a window. Codex B fell from 100 % to 81 % in the history at
  2026-10-16 18:13Z, and from 99 % to 83 % in its rollouts at 18:25Z with
  `resets_at` unchanged; then it rose again.
- Mixed stores. The rollouts in one store are not all its account's: 163
  readings in the main Codex store came from a Pro-plan account and alternated
  with its own Pro Max readings within seconds (85 % and 96 % on 2026-10-17
  16:04Z). Those 163 come from rollouts with no registry generation. Every
  other reading (246 355 of 246 518) maps to its rollout's generation and that
  generation's account; dropping readings whose plan differs from the
  account's leaves one clean series per account.

### 1.5 One finished task, measured

The lane that built PR #3048 (one task, 7 stages, 16 attempts, 2026-10-18
10:39Z to 16:19Z):

| Stage | Engine · model | Account | Attempts | Tokens | ≈ weekly pp (method R) |
|---|---|---|---|---|---|
| build-data | Codex · gpt-6.1-sol | Codex A | 1 | 38.2 M | 0.90 |
| review-data | Codex · gpt-6.1-sol | Codex B | 3 | 13.8 M | 0.65 |
| fix-data | Codex · gpt-6-luna | Codex A ×2, B ×1 | 3 | 35.2 M | 0.07 |
| build-ui | Claude · Opus 5.5 | Claude A, then B | 2 | 79.6 M | 1.44 |
| review-ui | Claude · Opus 5.5 | Claude A | 2 | 22.0 M | 0.60 |
| fix-ui | Claude · Sonnet 5.5 | Claude A | 4 | 33.6 M | 0.49 |
| visual | Claude · Opus 5.5 | Claude B | 1 | 6.3 M | 0.17 |

- The attempts' 16 conversations, summed from `usage_hours` by conversation
  digest, equal the rows whose `pipeline` is this lane, per account: Claude A
  70.4 M, Claude B 71.1 M, Codex A 66.3 M, Codex B 20.8 M.
- Cache reads are 98 % of those tokens. At the published API prices the lane
  is worth $46.9 of Claude and $24.2 of Codex.
- Method R (§2.4): Claude ≈ 2.7 pp of a week (A 1.5, B 1.2), Codex ≈ 1.6 pp
  (A 1.0, B 0.7); Claude A ≈ 9.8 pp and B ≈ 7.7 pp of a 5-hour window.
- Apportioned deltas (method D): Claude A 0.8, B 0.8; Codex A 0.4, B 0.3.
- Whole deltas over the lane's hours (method W): Claude A 4, B 5; Codex A 2,
  B 2. The lane was 24 %, 18 %, 43 % and 23 % of those accounts' weighted use
  in its own hours, which is why W overstates it 2 to 5 times.

## 2. How a task's share can be estimated

### 2.1 Method T: tokens or API-equivalent dollars only

Show the task's tokens (or the E1 dollar figure) per provider. Exact as far
as the store is (the #3048 coverage rules), cheap, and it never states a
share of a limit, so it does not answer the requirement by itself. It stays as
the fallback when an account has no usable rate.

### 2.2 Method W: the whole change of `used_percent` during the task

Read the account's percent at the task's first and last hour and attribute the
difference to the task. Breaks on every shared account: a lane holds a median
13 % of its account's weighted use in its own hours (20th percentile 5 %;
1 125 of 1 212 lane-account pairs from 736 lanes under half), so W overstates the median
task about 8 times. Restarts inside the span break it outright.

### 2.3 Method D: the change per hour, apportioned by weight

For each hour h of the task on account a: `Δused(a,h) × weight(task,a,h) /
weight(a,h)`. It needs no assumption about how the provider weighs tokens, and
under concurrency it is fair by construction. It breaks where the readings
do:

- Whole-percent readings. A 1-point step lands in one hour and goes to
  whoever ran in it. Of 664 lane-account pairs that method R puts between 0.2
  and 1 pp, D gives 0 to 49 and twice R or more to 46. Most tasks are this
  small (§3.4).
- Missing readings. The active Codex account has a reading in 61 % of its
  active hours and the other three none in the history; Claude gaps reach
  13 hours. A step after a gap lands in the wrong hour.
- Falls and restarts. A restart has to be told apart from a fall inside the
  window and from a stale reading (the rules in Appendix A); a fall inside the
  window (Codex B, −19 pp) has no meaning for any task.
- Use this host cannot see. Claude C rose 14 pp of its 126 pp week in hours
  when neither that hour nor the one before had a token on C here: use from
  another device or the provider's own apps. D hands such rises to whatever
  task ran at that hour.

For lanes of 2 pp or more, D and R agree: D/R has a median of 0.81 (20th
percentile 0.66, 80th 0.93, 118 pairs).

### 2.4 Method R: tokens × the account's calibrated rate (recommended)

Per account a and window w, over the 7 days before each UTC day d:

```
rate(a, w, d) = Σ rises of used_percent(a, w)  /  Σ weight(a)        (pp per weighted dollar)
spend(task, a, w) = Σ_d weight(task, a, d) × rate(a, w, d)
card figure(provider) = Σ over that provider's accounts of spend(task, a, weekly)
```

- `weight` is the E1 dollar figure of the tokens (`tokenCost`,
  `tokenPrices.ts:96`), with one change: Codex `ultrafast` is weighted at the
  `fast` rate, 2× standard, where the published table has 6×. That fits the
  measured meter better (§3.1); the evidence is one account, so the build
  re-checks it.
- Rises follow Appendix A: a fall to 5 % or less followed by low readings is
  a restart and the new value counts; a one-reading dip the next reading undoes
  is ignored; any other fall rebases without counting.
- A day's rate is frozen when the day ends, so a finished task keeps its
  figure.
- An account whose 7 days hold fewer than 10 pp of rise takes the median rate
  of same-engine, same-plan accounts; with none, the card shows tokens only.

Restarts and early resets do not affect R: the rate counts the rise after a
restart from 0, and a task's figure is a size in weekly allowances. A plan
change or a provider change of the allowance moves the rate within days; the
frozen daily rates keep earlier tasks as they were.

Where R breaks:

- Weighting. The meter's weights are unpublished. Weighting by API price
  predicts a Codex day much better than raw tokens (median error 23–39 % vs
  86–95 % on A, C, D), and about equally for Claude, whose use is nearly all
  Opus. A shift in an account's model mix moves its error.
- Use this host cannot see inflates the account's rate and so every task on
  it: at least 11 % on Claude C.
- Accounts used little have few points of rise per week (Codex C was active
  74 hours in 8 days), so their rate is noisier.
- Shared tokens that the store cannot place: the seat's conversations, Claude
  compaction requests (`docs/design/activity-token-usage.md` §4.7), work on a
  linked machine.

### 2.5 Several accounts and several plans per provider

Every row names its account, so a task's tokens split by account exactly, and
R multiplies each part by its own account's rate. The open question is only
the unit of the provider's total. A percentage point of a Pro Lite week and
of a Pro Max week are different amounts: measured, 1 pp of a week is about
$16 of API-equivalent work on Claude Max, $7–8 on Codex Pro, $9 on Codex Pro
Max (with the fast-tier weights) and $1.8 on Codex Pro Lite. All three
Claude accounts here share one plan, so their sum is exact; the four Codex
accounts span three plans. §8 asks the operator which unit to show.

## 3. Accuracy, measured

### 3.1 Calibration per account (weekly window)

Rises from 2026-10-12T20Z to 2026-10-20T20Z (Codex from 10-11T19Z), weights
from `usage_hours` of the same hours. "Day error" is leave-one-day-out: the
rate from the other days predicts the day's rise; the median relative error
over days with at least 5 pp of rise.

| Account | Source | Readings | Restarts | Falls in window | Rise | Weighted $ | pp per $100 | Day error: raw tokens / output / weighted |
|---|---|---|---|---|---|---|---|---|
| Claude A · Max | history | 1 862 | 1 | 0 | 98 pp | 1 496 | 6.55 | 29 % / 26 % / 21 % |
| Claude B · Max | history | 1 836 | 1 | 0 | 114 pp | 2 286 | 4.99 | 22 % / 25 % / 19 % |
| Claude C · Max | history | 1 765 | 1 | 0 | 126 pp | 1 818 | 6.93 | 47 % / 67 % / 48 % |
| Codex A · Pro | rollouts, per-minute median | 7 841 | 4 | 0 | 313 pp | 2 117 | 14.79 | 86 % / 73 % / 27 % |
| Codex B · Pro Max | rollouts | 8 764 | 4 | 1 | 308 pp | 2 770 ¹ | 11.12 ¹ | 55 % / 52 % / 48 % ¹ |
| Codex C · Pro Lite | rollouts | 2 649 | 3 | 0 | 311 pp | 553 | 56.20 | 95 % / 99 % / 39 % |
| Codex D · Pro | rollouts | 8 232 | 6 | 0 | 456 pp | 3 506 | 13.01 | 94 % / 82 % / 23 % |

¹ With `ultrafast` at the fast-tier weight. At the published 6× it reads
5.29 pp per $100 and a 71 % day error; B is the only account with much
`ultrafast` work (83 % of its weighted use is on fast tiers).

Same plan, same rate: the three Claude Max accounts read 4.99–6.93 pp per
$100 (±19 % around 6.2), the two Codex Pro accounts 13.0–14.8 (±6 %). That
is what lets an account short of readings borrow its plan's rate.

The 5-hour Claude window reads 43.2, 32.2 and 46.9 pp per $100, with day
errors of 33 %, 13 % and 45 %.

### 3.2 Task-scale check: hours one lane had an account to itself

Where one lane held at least 90 % of an account's weighted use in an hour,
the observed rise in those hours is that lane's, and R's prediction can be
compared with it, summed per lane and account.

| Window | Blocks | Hours | Blocks of 3 pp or more | Their median error | Median relative error | 80th percentile | Median error, all blocks |
|---|---|---|---|---|---|---|---|
| weekly | 75 | 103 | 10 | 1.1 pp | 28 % | 86 % | 0.44 pp |
| Claude 5-hour | 25 | 33 | 13 | 2.7 pp | 46 % | 72 % | 0.71 pp |

The samples are small; they agree with the day-level errors of §3.1.

### 3.3 Expected error of the recommended method

About ±30 % of the figure at the median, up to about twice or half for one
task in five, and never finer than ±0.5 pp because the readings are whole
percents. Accounts with outside use read high. The card therefore prints
whole percents with «≈», «<1%» below one point, and states the error once, in
the popover.

### 3.4 How large task spends are

536 lanes whose hours all fall inside the series (2026-10-12 to 10-20):

| | Lanes | Median | 75th | 90th | Max | Under 0.5 pp | 5 pp or more | 10 pp or more |
|---|---|---|---|---|---|---|---|---|
| Claude weekly | 163 | 0.63 pp | 1.18 | 1.99 | 12.3 | 73 | 4 | 1 |
| Codex weekly | 501 | 0.64 pp | 1.41 | 3.1 | 52.3 | 214 | 39 | 25 |

128 lanes used both providers. Accounts per provider per lane: Claude 1 (138
lanes), 2 (24), 3 (1); Codex 1 (320), 2 (158), 3 (22), 4 (1). A Claude lane
uses a median 3.4 pp of a 5-hour window per account (90th percentile 11.2,
max 79.3). The designs must make «<1%» read well, since it is the most common
figure, and must fit a provider total built from several accounts.

## 4. Cost to compute

The card never opens a transcript and never sums `usage_hours` per render.

### 4.1 Write side

- `commitUsage` folds each piece's responses by hour key already
  (`tokenStore.ts:120-154`). It would also fold them by
  `(owner, engine, account, model, tier, UTC day)`, where the owner is the
  lane id when the conversation is in a lane and the conversation digest
  otherwise, and upsert those rows into a new `usage_owner_days` table in the
  same transaction. Counts per kind are stored, so the price table can change
  without a rebuild. Retention as `usage_days` (25 months), pruned by
  `maintainUsage` in its 10 000-row steps.
- Rates: once per hour the ingest pass computes `rate(a, w, d)` for the
  current day from `limits-history.json` and 7 days of `usage_hours` per
  account and hour, and stores rows in `usage_limit_rates (account, window,
  day, rate, rise, weight, source)`, frozen at day end. Bound: 7 accounts × 2
  windows × 760 days. It runs as its own loop-monitor operation
  (`activity.limit-rates`, beside `activity.ingest` in the `ViewerOperation`
  union, `src/lib/viewerLoopMonitor.ts:21`).
- Codex history: the quota controller appends each Codex observation to the
  history (`quotaController.ts:57`, one call into
  `recordLimitSample`), so every Codex account gets the 5-minute series the
  Claude accounts have. Until a week has accrued, a Codex account borrows its
  plan's rate from an account that has one.

### 4.2 Read side

- One batched request per board, `GET /api/task-spend?ids=…`, like the album
  button's `/api/task-album?ids=…` with its 45-second beat
  (`src/components/taskAlbum/albumSummaries.ts:1-11`, `:42-63`). The server
  maps each task to its owners (its lanes from the pipeline records, its
  assignment conversations outside lanes, the seat excluded), reads
  `usage_owner_days` and `usage_limit_rates` for those owners, and answers per
  task and provider. The answer is cached on `usage_meta.version` and the
  rates' version for 60 s, as `tokenReport.ts:58-65` does, with 16 entries.
- Authority: per-account rows are the owner's view, as in the token report
  (`tokenReport.ts:84`); other members see the provider totals.

### 4.3 Measured

Bun 1.4.0 against the scratch copies, 9 runs each (median / max):

| Read | Rows | Time |
|---|---|---|
| 100 lanes summed from `usage_hours` on this host's copy | 14 233 | 4.16 / 4.61 ms |
| the same at the store's bound (2 000 rows a day × 92 days, synthetic) | 184 000 | 60.5 / 64.3 ms |
| the same with a partial index on `pipeline` | 184 000 | 52.9 / 58.9 ms |
| 100 owners from a per-owner day table at that bound | 71 048 | 0.23 / 0.55 ms |
| rate inputs: parse the history and read 8 days of `usage_hours` by account, hour, model and tier | 1 506 | 9.2 / 13.2 ms |

A card's figure is as fresh as the last ingest pass (70 s old when copied)
plus the client beat.

## 5. Recommended method

Method R (§2.4): the task's API-price-weighted tokens per account, times that
account's rate of weekly percentage points per weighted dollar over the
trailing 7 days, frozen per day, summed per provider. Expected error about
±30 % at the median (§3.3). Method D stays as the way the rate is calibrated,
at the account level over a week, where whole-percent steps and concurrency
average out. Method T is the fallback for an account without a rate.

## 6. What each card would show

```ts
interface TaskLimitSpend {
  taskId: string;
  state: "none" | "counting" | "partial" | "ready";   // none: no agent work; counting: work newer than the last pass
  providers: Array<{
    engine: "claude" | "codex";
    weeklyPp: number | null;        // null: no rate for any of its accounts; tokens only
    lowerBound: boolean;            // part of the work is uncounted (before counting began, a linked machine, a lane still being read)
    tokens: number;
    accounts: Array<{ label: string; plan: string | null; weeklyPp: number | null; sessionNowPp?: number }>; // owner only
  }>;
}
```

- Face: per provider that did work, its engine mark and «≈3%», «<1%», «≥2%»
  for a lower bound, «…» while counting, «—» when no rate exists. Nothing at
  all on a task no agent worked on.
- Popover: per provider the weekly figure and its split by account with plan
  tier; for Claude, while the task runs, its share of the current 5-hour
  window; the task's tokens; one accuracy line. Under 6 lines.
- Phone: the card face is one button (`src/components/mobile/MobileKanban.tsx:610-617`),
  so the face's marks are passive and the popover's lines become one row of
  the task screen, as the album does (`PhoneAlbumRow`,
  `src/components/mobile/MobileTaskScreen.tsx:1250`).

## 7. Three information designs for the prototype stage

Common to all three:

- The real card: `.kb .card` and its rows from `src/components/kanban/kanbanBoard.css`
  with `src/styles/tokens.css`, dark theme as in the operator's screenshot,
  Ukrainian copy; desktop board columns (cards about 280 px wide,
  `kanbanBoard.css:1346`) and the 390 px phone. Each frame prints
  «Варіант N з 3».
- The engine is the shared `EngineMark` (`src/components/EngineMark.tsx`) at
  12 px in `--color-claude-mark` / `--color-codex-mark`: Claude's spark and
  Codex's disc differ in shape, so colour never carries the engine alone.
  Amber stays reserved for trust (a lower bound), as on the Activity page.
- Providers keep one fixed order everywhere, Claude then Codex: on the face,
  in the popover and on the phone's task screen. Each mark keeps its slot from
  card to card; ordering by size would swap them within one column.
- The popover opens the way `CardStateDot` does (hover, focus or tap; Escape
  closes; `TooltipBubble`, `src/components/kanban/CardStateLine.tsx:24-65`).
  No pill, no new row type, no glass.
- Six cards per variant, invented titles and accounts:
  1. one provider — Codex A · Pro ≈1%;
  2. two providers — Claude ≈3% (A 2%, B 1%), Codex ≈2% (A 1%, B <1%), the
     measured lane of §1.5 rounded;
  3. several accounts of one provider — Codex ≈7% (A · Pro 4%, B · Pro Max
     2%, D · Pro 1%) and Claude <1%;
  4. tiny spend — Claude <1% (0.3 pp);
  5. large spend — Codex ≈34% (A 21%, D 13%), Claude ≈12%;
  6. data still unknown — a lane started two minutes ago («…»), and a Claude
     account without limit readings («—», tokens in the popover).

### 7.1 Варіант 1 з 3 — числа в рядку фактів (recommended)

- Where: the task's fact line, `card-meta-line`
  (`KanbanCard.tsx:670`, phone `MobileKanban.tsx:575`), which already holds
  the deadline and the images on closed and open cards alike. The figures
  join it at its end: `✳ ≈3%  ◉ ≈2%`, tabular digits, 8 px between pairs. A
  card with no deadline and no images gets the line for these figures only.
- Face: one figure per provider, the sum of its accounts. Large spends are
  only larger numbers; tiny ones read «<1%».
- Popover:
  - «Скільки ліміту витратила задача»
  - «✳ Claude — ≈3% тижня · A 2%, B 1%»
  - «◉ Codex — ≈2% тижня · A 1%, B <1%»
  - while running: «Зараз: 12% поточного 5-годинного вікна Claude A»
  - «229 млн токенів»
  - muted: «Оцінка ±30%: токени задачі × темп акаунта за 7 днів»
  - counting: «Рахується: токени останніх хвилин ще читаються»; no rate: «Ліміт
    акаунта невідомий, показано лише токени»; lower bound: «Частину роботи не
    пораховано, це нижня межа»
- Phone: the same pair of figures, passive, on the face's fact line; the task
  screen gets a «Ліміти» row with the popover's lines.

### 7.2 Варіант 2 з 3 — крапка-шкала на рядку стану

- Where: the end of the card's state line (`CardStateLine`), where the
  priority mark sits, beside the status dot that line already has.
- Face: per provider the engine mark and a 15 × 8 px bar of four cells:
  none filled below 1 %, one from 1 to 4 %, two from 5 to 14 %, three from
  15 to 29 %, four from 30 %. No digits on the face. The steps differ by
  count, so they read without colour, and a bar never reads as the round
  engine mark or the status dot.
- Popover account lines put the task's figure in a fixed slot, its sign (<, ≥)
  right-aligned in a cell of its own, so «задача» and the digits start at one
  x on every line; each provider's block stands apart from the next.
- Popover: the numbers of variant 1, and one thin bar per account in the
  sidebar's window-line style (`src/components/LimitRow.tsx:14-35`): the
  account's week used so far in muted ink, the task's part in the engine's
  colour, «A · Max: задача 2% із 53% цього тижня». The bar answers how big the
  task is against the week it spent from.
- Phone: the marks are passive on the face's state line; the task screen row
  lists the numbers and the bars.

### 7.3 Варіант 3 з 3 — на ланцюжку лейну

- Where: each lane's aside line (`PipelineBlock`'s `pb-aside`,
  `src/components/pipelines/PipelineBlock.tsx:649`, filled by the closed card
  at `KanbanCard.tsx:686-697`, and each lane row of the open card), right
  under the PR link: `✳ ≈3% ◉ ≈2%`. The chain row itself stays as it is
  without figures, so the chain folds no further and PR links keep one right
  edge down a column. A finished card puts its figures at the end of its state
  line. A lane with no figure yet has no aside line. The task total is in the
  popover, and on the open card in the foot only when the card holds two or
  more lanes or agents outside a lane.
- Popover, per lane and provider: the provider's total, then its stages
  ranked by their share of it, at most three and the rest in one line. For the
  lane of §1.5: «✳ Claude ≈3% тижня: build-ui 53%, review-ui 22%, fix-ui 18%,
  ще 1 етап 6%» and «◉ Codex ≈2% тижня: build-data 56%, review-data 40%,
  fix-data 4%»; then the accuracy line. Shares keep the ranking readable where
  each stage alone is under one point, and they claim no more precision than
  the total has. It answers which stage spent the limit.
- Phone: the face's lane block (`PipelineBlock density="card"`) carries the
  same aside line passively; the task screen's «Ліміти» section lists stages
  with their figures.
- Cost: one more row on each running card that has figures. Putting them on
  the chain row instead moved the PR link and folded the chain.

## 8. Questions for the operator (publish stage)

1. Which variant? Options: 1, 2, 3. Recommended: 1, the figure readable at a
   glance on closed and open cards and on the phone, on a row that exists.
2. The unit of a provider's total. Options: (a) percent of each account's
   week, summed per provider; (b) share of the provider's whole weekly
   capacity across all its accounts; (c) the busiest account's percent only.
   Recommended: (a), the unit the sidebar uses; the popover names each
   account's plan.
3. The 5-hour Claude window. Options: (a) in the popover while the task
   runs; (b) also on the face; (c) not shown. Recommended: (a).
4. The API-equivalent dollar figure. Options: (a) leave it out; (b) one line
   in the popover, marked as a comparison. Recommended: (a), since the
   requirement asks for the limit.

## 9. Check against the requirement

| Requirement | Where |
|---|---|
| On each task | per task, from its lanes and its own agents (§1.1, §6) |
| Roughly how much of each provider's limit | method R, weekly percent per provider, ±30 % stated (§2.4, §3.3) |
| Compact and good-looking | one row reused per variant, engine marks and digits only (§7) |
| Only useful information | provider totals on the face; accounts, the running 5-hour share and tokens behind the popover (§6) |
| Research, a board task, 2–3 prototypes, no implementation | this report; §7 for the prototype stage |

## Deferred — not currently justified

- Building any of it: this lane delivers research and prototypes only.
- Showing per-task spend from the provider's own records: Claude transcripts
  carry no limit field (none in 30 Claude transcripts modified on 2026-10-20
  after 15:00Z), and Codex's per-response readings are whole
  percents (§2.3).
- Attributing the seat's tokens to the tasks it worked on by topic or by
  message.
- Copilot's premium-request quota and OpenClaw per task: the ingest reads no
  usage for them.
- Work on linked machines: no token rows cross (`host = ''`).
- The separately metered Fable weekly window on the card.
- Budgets or alerts per task, and updates faster than the 45-second beat.
- Tasks older than the token store's first counted response (2026-07-20 on
  this host); they show the lower-bound mark.

## Found while reading (outside this lane)

- The Codex burndown backfill reads every rollout in the active account's
  store (`collectCodexRateLimitSeries`, `src/lib/limits.ts:1214`, from
  `readCodexTranscriptLimits`, `:897`), and a store can hold another
  account's rollouts: the main Codex store held 163 Pro-plan readings that
  alternated with its own Pro Max readings within seconds on 2026-10-13 and
  10-17. The burndown curve for that account would zigzag there (inferred;
  not rendered).
- The limits history keeps Codex samples for the active account only
  (§1.4), and its Codex series has one reading of 44 % between readings of
  88 % (2026-10-16 23:38Z). The transcript fallback that `remember()` also
  records (`limits.ts:286`) reads the newest rollouts of the same store, which
  would explain it (inferred).

## Appendix A: how the measurements were made

All on 2026-10-20 between 20:25Z and 20:45Z, from scratch scripts in the
stage's temporary directory (removed with it); `python3 -I` for the
analysis, Bun 1.4.0 for the SQLite timings.

- Stores: `activity/records.sqlite` and `state.sqlite` copied with `VACUUM
  INTO` (30.1 MB and 257.8 MB copies); `limits-history.json` and
  `limits-cache.json` copied; the agent registry queried read-only
  (`mode=ro`) for the rollout path to account map of its generations and for
  pipeline memberships. `account_limits` read once for plans.
- Codex readings: every rollout modified since 2026-10-11T21:00Z in
  `$HOME/.codex/sessions` and in each Codex account's `sessions` directory
  under the state root (3 250 files, 9.3 GB), filtered to lines containing
  `"rate_limits"`; per line the timestamp, `primary.used_percent`,
  `window_minutes`, `resets_at` and `plan_type`; one reading per file and
  timestamp; the account from the registry generation of that file, else the
  store; readings whose plan differs from the account's majority plan
  dropped; then one value per minute, the median of that minute's readings.
- Rises: readings in time order; a value more than 2 pp under the running
  level is a restart when it is at most 5 % and the next reading stays at
  most 8 % (the new value counts as rise), a dip when the next reading
  returns within 1 pp of the level (ignored), otherwise a fall (the level
  rebases, nothing counts); a rise above the level counts in the hour of the
  reading.
- Weights: `usage_hours` per account, hour, model and tier, priced with a
  copy of the `tokenPrices.ts` rates; Codex `priority` and `ultrafast` at 2×
  the standard rate where §3.1 says so.
- Lane joins: attempt conversation ids from the pipeline records digested as
  `conversationDigest` does (`src/lib/activity/store.ts:199-201`) and matched
  to `usage_hours.conversation`.
- Leave-one-day-out: UTC days with at least 5 pp of rise; each day predicted
  from the rate of the others.
- Solo blocks: hours in which one lane held at least 90 % of the account's
  weight; predicted and observed rises summed per lane and account.
- Spend distribution: lanes whose every hour on an account lies inside that
  account's series.
- Timings: 100 most recent lanes; the synthetic bound repeats this host's
  hour rows with shifted hours and suffixed conversation and lane ids until it
  holds 184 000 rows, in memory; each query 9 times.
