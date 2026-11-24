# Task spend: tokens, estimated subscription share and API-price equivalent

- Status: design for acceptance item 1 of this lane. Research and design only;
  no product file changed.
- Grounded on: `main` at `03eee9338b` (2026-11-24). Builds on
  `docs/design/task-limit-spend.md` (the October research behind today's card
  marks, shipped in #3151) and `docs/design/activity-token-usage.md` (the token
  store, #3048).
- Evidence: measured on this host on 2026-11-24 between 15:35Z and 15:50Z over a
  `VACUUM INTO` copy of the activity store (`activity/records.sqlite`, opened
  read-only), one `account_limits` read at 15:36Z, the role table, and the
  Claude credential files read for their plan fields only. Only counts, sums,
  rates and field names were extracted. Accounts are named by engine, a letter
  and their plan; their ids appear nowhere. Appendix A gives the procedure.
- Web sources: fetched on 2026-11-24 between 15:20Z and 15:40Z. Each page was
  saved in the stage's scratch directory, stripped of markup and quoted from
  that copy (§2.1).
- Prior work: `search_transcripts` (project-scoped: "per-task token spend card
  quota percent", "usage_limit_rates rate null frozen coverageComplete task
  spend невідомо") found the October research and build lanes and the closed
  investigation showing that the provider reports no per-task usage for Claude
  Cloud tasks. None of them notices that the stored rates are erased (§1.2).
  `search_memory` found nothing. `git log` on `src/lib/activity/limitRates.ts`
  shows no change to the rate logic since #3151 and #3155 (2026-10-21).

## Originating requirement

Source: the operator, 2026-11-24 about 15:30 UTC, by voice in the seat chat,
in Russian. The board task keeps the exact words for agents. Paraphrase:
review how token use is counted per subscription. Research roughly how many
tokens each plan allows on Claude, Codex and the other engines. Then, from the
tokens each task actually used, estimate cheaply, with no heavy new load,
what share of each subscription the task took. Many places now say "unknown"
or show something wrong, and the subscription percentages look incorrect,
while the token counts look right. Converting the tokens into API prices
would also be welcome.

§8 checks the design against it.

## Decisions in one screen

| # | Decision | Why |
|---|---|---|
| 1 | The card says «невідомо» today because of two defects in the existing calibration; the tokens themselves are known. Every stored task row has tokens and a priced weight, yet 96 % of provider marks read «невідомо» and none reads «≈» (§1.1). | D1: a day's rate is erased about two days later, once the 8-day limit history stops covering its 7-day window. D2: every figure is marked as a lower bound because the host-wide "fully read" flag is almost never true while agents write (§1.2). |
| 2 | Plan share = the task's **meter-weighted dollars** ÷ the plan's **weekly budget in the same dollars**. Budgets live in a versioned data file; token ranges are derived from them for a stated mix (§2.6, §3). | Tokens alone cannot carry a budget. 98 % of the tokens here are cache reads, and one weekly budget is 6 B tokens of GPT-6.2 Sol or 76 B of GPT-6 Luna (§3.1). OpenAI's Codex credit card weights every token kind exactly as the API price list does, at 25 credits per API dollar (§2.3). |
| 3 | Basis per hour: the account's own measured rate where that day has one, otherwise the plan budget from the data file. The popover names the basis and always shows the plan range. | The measured rate was accurate to about ±30 % in October; the researched budgets are known only to about ×2. The table is what makes a figure exist for every task, including the 97 % of stored rows whose days lost their rate. |
| 4 | API-price equivalent = the same tokens at the providers' public API prices for the tier actually used, shown per provider and in total. | The prices already sit in `src/lib/activity/tokenPrices.ts:34-77` and match today's pages (§2.2). The figure is a comparison and is never called spending. |
| 5 | "Unknown" appears only where tokens are unknown. Known tokens with no usable share (plan not reported, plan without a fixed limit, model without a price) show tokens and dollars and say in the popover why there is no share. Lower bound («≥») only for work before counting began. | The pinned outcome. |
| 6 | Slice 1 reuses stored rows only. It adds a data file, a pure estimation module and two stored columns (`api_usd`, `plan_tier`). It keeps measured rates from being erased and fixes the floor rule. It reads the Claude rate tier that the quota read already loads, falls back to an account's last recorded plan, and computes the share on the existing batched read. No provider polling, no per-request work beyond arithmetic on rows already read (§5). | Requirement: cheap, no new load. |

## 1. What cards and agent rows show today, and why

### 1.1 Measured state of the stored task figures

The card's marks come from `task_limit_spend`, one row per task and account,
written by the ingest loop (`refreshTaskLimitSpend`, called from
`src/lib/activity/continuous.ts:63`) and read in one batch per board
(`readTaskLimitSpend`, `src/lib/activity/taskLimitSpend.ts:365-404`; client
beat 45 s, `src/components/kanban/taskSpendSummaries.ts:16`).

At 15:35Z on 2026-11-24 the store held 5 634 rows for 3 250 tasks:

| Measure | Claude | Codex |
|---|---|---|
| Rows | 1 439 | 4 195 |
| Rows with tokens > 0 and a priced weight > 0 | 1 439 | 4 195 |
| Rows with no rate (`weekly_pp` null) | 1 402 (97 %) | 4 071 (97 %) |
| Rows marked a lower bound (`floor = 'uncounted'`) | 1 439 (100 %) | 4 195 (100 %) |
| Provider marks reading «невідомо» (`bound = norate`) | 1 014 | 2 874 |
| Provider marks reading «≥…» | 32 | 124 |
| Provider marks reading «≈…» or «<1%» | 0 | 0 |

By the age of the work: all 5 473 rows whose work ended before 2026-11-23 have
no rate. The 92 rows whose work lies wholly on 2026-11-23 or 11-24 are fully
rated, and 69 rows that reach into those days are rated in part. Only one row
holds tokens of a model without a price (52 881 tokens).

So tokens are known for every task that shows marks, and a priced weight
exists for every row, yet 3 888 of 4 044 provider marks (96 %) say
«невідомо», and the other 156 say «≥». This is what the operator saw. The
popover of a «невідомо» provider prints the task's tokens («N токенів,
показано лише токени», `src/components/kanban/TaskSpend.tsx:165-176`), which is
why the token counts looked right while the percentages did not.

### 1.2 Why

**D1: the calibrated rate of a day is erased about two days later.**
`refreshLimitRates` (`src/lib/activity/limitRates.ts:78`) recomputes, every
hour, each day from the oldest retained limit sample to today.

1. A day's rate needs limit samples covering its own day and the 6 days before
   it (`from = start - 6 * DAY`, `limitRates.ts:101`; `covers`, `:18`;
   `historyCovered ? dayRate(...) : null`, `:121`).
2. The limit history keeps 8 days (`RETENTION_S`,
   `src/lib/limitsHistoryStore.ts:37`; the rate job also filters to 8 days,
   `limitRates.ts:88`). So only today, yesterday and part of the day before can
   be covered.
3. A row is frozen only while the host-wide ingest is complete
   (`frozen: coverageComplete && historyCovered && day < today`, `:124`). An
   unfrozen row is recomputed each hour, and once its window leaves retention
   the recomputation stores `rate = null` over the good value.
4. A stored null day stays unknown and borrows no neighbour (`nearestRate`,
   `:45-46`). The changed rate then re-dirties every task that touched that
   day, and the task loses its figure.

The copy shows the result: 754 rate rows, **none frozen**, and 44 weekly rows
older than two days with a rise of 10 points or more and a positive weight, all
with `rate = null` and `source = 'none'`. One Claude account's row for
2026-11-20, for example, has a 91-point rise and $392 of weight and still no
rate. Only 2026-11-23 and 11-24 carry rates (14 rows).

**D2: every figure is a lower bound.** `coverageComplete` is
`usage_meta.complete = 1 and pending_bytes = 0`. The ingest sets `complete` only
when no transcript has unread bytes at the end of a pass
(`src/lib/activity/ingest.ts:323-324`). With 20 to 30 agents writing, that is
almost never true; at 15:35Z `pending_bytes` was 12 128 and `complete` 0. A
row computed then is born `floor = 'uncounted'`
(`taskLimitSpend.ts:99-100`). The read path also marks a provider as a lower
bound when any of its weight is unrated (`:382-384`), and turns `approx` into
`floor` (`:398`). The face then prints «≥» (`TaskSpend.tsx:110`) and the popover
«Нижня межа: частину роботи ще не пораховано» (`:186`).

**D3: the popover's reason is wrong.** For a «невідомо» provider the popover
says «Для X ще немає показів ліміту» (`TaskSpend.tsx:195`,
`src/lib/i18n/uk.ts:7817`). Readings exist; the rate was erased.

**D4: the plan name is ambiguous for Claude.** Every Claude account here
reports `subscriptionType = "max"` with `rateLimitTier =
"default_claude_max_20x"` in its credential file. Today `max` is the $100 plan
at 5× Pro, and the legacy 20× tier is a different allowance (§2.3). The
observation keeps only `subscriptionType` (`src/lib/limits.ts:556`, `:574`), so
a budget looked up by plan name alone would be off by about 2×.

**D5: Codex speed tiers.** The rate weight prices Codex `ultrafast` at the
`fast` API rate (`limitWeight`, `limitRates.ts:21-23`), following one account's
October measurement. OpenAI now publishes the multipliers that apply to
*included plan usage*: Fast 2× (GPT-6.2) and 2.5× (GPT-6.1, GPT-6), Ultrafast
6× (GPT-6.2) and 8× (GPT-6 Astra, GPT-6.1 Sol) (§2.3). The published values
and the October fit disagree. Ultrafast was 1 % of the Codex tokens of the last
7 days, so the choice moves little today; slice 2 rechecks it (§6).

**D6: an account can lose its plan.** One Claude account's observation has
carried no plan since 2026-11-15. The rate job recorded `max` for it from
2026-10-18 to 11-14 (`plan`, written at `limitRates.ts:123`), and `null` after.
Its 86 task rows hold 4.9 B tokens, the last on 2026-11-20. Looked up by the
current observation alone, those tasks would have no plan.

### 1.3 Every place that shows "unknown" or a plan or usage percentage

Scope from the brief: the card spend row, the task view, agent rows and the
account usage windows. "Task view" here is the open desktop card (same state
line and popover) and the phone task screen.

| # | Surface | Code | What it shows | Why / source | This design |
|---|---|---|---|---|---|
| 1 | Card state line, face | `TaskSpend.tsx:108` | «невідомо» per provider | `bound = norate`: no rated row (D1) | Replaced: share from the plan budget; tokens when no share is possible |
| 2 | Card state line, face | `TaskSpend.tsx:110`, `:41-42` | «≥» before the scale | `bound = floor` (D2) | Only for work before counting began |
| 3 | Card state line, face | `TaskSpend.tsx:34-39`, `:111` | 0–4 filled cells: <1 %, 1–4 %, 5–14 %, 15–29 %, ≥30 % of the week | `weeklyPp` summed per provider (`taskLimitSpend.ts:381`) | Kept; fed by the new share |
| 4 | Popover headline | `TaskSpend.tsx:51-57`, `:183` | «Claude ≈3% тижня», «<1%», «≥12%» | same | Kept, with the plan range and the API price |
| 5 | Popover account line (owner only) | `TaskSpend.tsx:121-154` | «задача 2% · тиждень 53%» and a bar | task share and the account's whole week used (`week.usedPercent`, the provider's reading) | Kept; the second figure is renamed so it does not read as the task's |
| 6 | Popover, no-rate provider or account | `TaskSpend.tsx:124-130`, `:165-176` | «ліміт акаунта невідомий», «N токенів, показано лише токени», «ліміт невідомий · N токенів» | D1 | Removed except when no share is possible, with the real reason |
| 7 | Popover note | `TaskSpend.tsx:195` | «Оцінка, ±30%», «Для X ще немає показів ліміту» | D3 | Replaced by a basis line |
| 8 | Popover lower-bound note | `TaskSpend.tsx:186` | «Нижня межа: частину роботи ще не пораховано» | D2 | Removed; the before-counting note stays |
| 9 | Popover 5-hour line | `TaskSpend.tsx:187-191` | «Зараз N% 5-годинного вікна …» | `session_pp`; no Claude account here has had a 5-hour rise since 2026-10-30, and none reports a session window now | Unchanged (slice 3, §6) |
| 10 | Card and phone labels for screen readers | `TaskSpend.tsx:79-88`, `:264-268`; `src/components/mobile/MobileKanban.tsx:551` | «Claude ліміт невідомий» | D1 | Follows #1 |
| 11 | Phone task screen «Ліміти» | `src/components/mobile/MobileTaskScreen.tsx:1384` → `TaskSpend.tsx:271-281` | the popover's lines | same as 4–9 | Same lines as the popover |
| 12 | Card from a linked Viewer | `src/components/kanban/KanbanCard.tsx:722` (`!remote`) | nothing | linked machines send no token rows | Unchanged (deferred) |
| 13 | Agent rows on a card, pane header, switch card | `src/components/PlanChip.tsx:78-109`; used at `src/components/kanban/KanbanReaders.tsx:309`, `src/components/BranchPane.tsx:435`, `src/components/SwitchCard.tsx:154` | «63% ctx 126K / 200K», or «ctx 126K» with «Розмір вікна для цієї моделі невідомий — відсоток не показується» | context-window fullness; unknown when the model's window is not in the registry | Not a plan share; out of scope |
| 14 | Codex goal chip tooltip | `PlanChip.tsx:48-54` | «tokens: N» | the thread goal's own count | Out of scope |
| 15 | Account chip on agent rows and its picker | `src/components/kanban/AccountPicker.tsx:300-307`, `:486-496` | «N% з 5 год», «N% · скидання HH:MM» | the account's 5-hour window as the provider reports it; absent when no 5-hour window is reported (now for every account here) | Correct reading; unchanged |
| 16 | Orchestrator header | `src/components/orchestrator/IncumbentHeader.tsx:261-286` | context %, or «Використання контексту, вікно невідоме» | context window | Out of scope |
| 17 | Accounts panel window lines | `src/components/AccountsPanel.tsx:203-228` (`:220`) | «N%» left per window | provider reading, whole percents | Correct reading; unchanged |
| 18 | Accounts panel, provider (API-key) account | `AccountsPanel.tsx:244` | «Ліміти провайдера невідомі» | a provider account has no plan windows | Correct; unchanged |
| 19 | Sidebar limits footer | `src/components/LimitsFooter.tsx:136-138`, `:182`, `:186`, `:363`, `:368`, `:373` | «тиждень N%», «залишилось N%», «немає даних», «немає тижневого» | provider readings and their absence | Correct; unchanged |
| 20 | Sidebar window line | `src/components/LimitRow.tsx:15-36` | «залишилось N%» | provider reading | Correct; unchanged |
| 21 | Launch form and runtime pill account chips | `src/components/accountWeekly.tsx:27-38`; `src/components/draft/AgentLaunchControls.tsx:427`, `:463`; `src/components/RuntimePill.tsx:1472`, `:1933` | «N% тижневого ліміту залишилось» | provider reading; no bar without a reading | Correct; unchanged |

The provider-reported percentages (15, 17–21) are readings.
They are whole percents as the provider sends them, dated by their
observation, and they need no change. The estimates that are wrong are 1–11.
Item 5 places the account's whole week beside the task's share on one line
(«задача 2% · тиждень 53%»), and the second figure can read as the task's.
§7 renames it.

## 2. Research

### 2.1 Sources

Each page was fetched with a browser user agent and saved, its markup was
stripped, and the passages quoted below come from that text. Where the page
shows no date, the retrieval date is the only date.

| Key | URL | HTTP, bytes | Page date |
|---|---|---|---|
| anthropic-api | https://platform.claude.com/docs/en/about-claude/pricing | 200, 809 700 | none shown |
| openai-api | https://developers.openai.com/api/docs/pricing | 200, 639 780 | none shown; dated promotions inside |
| codex-pricing | https://learn.chatgpt.com/docs/pricing (`developers.openai.com/codex/pricing` answers 308 to it) | 200, 754 209 | none shown; dated promotions inside |
| claude-plans | https://claude.com/pricing | 200, 1 448 601 | none shown |
| claude-max | https://support.claude.com/en/articles/11049741 ("What is the Max plan?") | 200, 218 829 | "Updated over 3 weeks ago" |
| claude-code-plans | https://support.claude.com/en/articles/11145838 ("Use Claude Code with your Pro, Max, or Ultra plan") | 200, 240 358 | "Updated over 3 weeks ago" |
| chatgpt-pro | https://help.openai.com/en/articles/9793128-what-is-chatgpt-pro | 200, 81 293 | "Updated: 21 hours ago" (about 2026-11-23) |
| botfarm-2026-03 | https://buttondown.com/botfarm/archive/what-a-claude-max-weekly-limit-is-actually-worth/ | 200, 19 518 | published 2026-03-20 |
| nerftrack-2026-08 | https://xenospectrum.com/en/codex-weekly-limit-nerftrack/ | 403 to the scripted fetch; read through the fetch tool | published 2026-08-20 |
| venturebeat-2026-04 | https://venturebeat.com/orchestration/openai-introduces-chatgpt-pro-usd100-tier-with-5x-usage-limits-for-codex | 429 to the scripted fetch; read through the fetch tool | published 2026-04-09, updated 04-10 |

All retrieved 2026-11-24. Two URLs answered 404: the Claude Pro usage article
`support.claude.com/en/articles/8324991` and `.../11014257`. Community forum
figures that appeared only in search summaries were not fetched and are not
used.

### 2.2 API prices, USD per million tokens (anthropic-api, openai-api; 2026-11-24)

Models in the role table are marked ★. Short-context rates (Haiku 5.5 up to
100 000 prompt tokens, OpenAI up to 272 000 input tokens).

| Model | Tier | Input | Cached input (read) | Cache write 5 min / 1 h | Output |
|---|---|---|---|---|---|
| ★ Claude Opus 5.5 | standard | 4 | 0.20 (0.05×) | 5 / 8 | 20 |
| Claude Opus 5.5 | fast | 8 | 0.40 | 10 / 16 | 40 |
| ★ Claude Sonnet 5.5 | standard | 2 | 0.10 (0.05×) | 2.50 / 4 | 10 |
| Claude Fable 5.2 | standard | 8 | 0.20 (0.025×) | 10 / 16 | 40 |
| Claude Fable 5.2 | fast | 16 | 0.40 | 20 / 32 | 80 |
| Claude Haiku 5.5 | standard | 0.10 | 0.01 | 0.125 / 0.20 | 0.50 |
| ★ GPT-6.2 Sol | standard | 2 | 0.10 | none published | 10 |
| GPT-6.2 Sol | fast | 4 | 0.20 | — | 20 |
| GPT-6.2 Sol | ultrafast (promotion to 2027-02-28; list 12 / 0.60 / 60) | 6 | 0.30 | — | 30 |
| GPT-6.2 Astra | standard | 8 | 0.40 | — | 40 |
| GPT-6.1 Sol | standard / fast / ultrafast | 2 / 4 / 12 | 0.10 / 0.20 / 0.60 | — | 10 / 20 / 60 |
| GPT-6.1 Terra | standard | 1 | 0.05 | — | 5 |
| ★ GPT-6 Luna | standard / fast | 0.10 / 0.20 | 0.01 / 0.02 | — | 0.50 / 1 |

The table in `tokenPrices.ts:34-77` (dated 2026-11-17, `:17`) matches every
row above that it has. It lacks GPT-6.1 Terra. The role table names Opus
(the `opus` alias), Sonnet 5.5, GPT-6.2 Sol and GPT-6 Luna; Fable 5.2,
GPT-6.2 Astra and GPT-6.1 Sol also appear in this host's last 14 days of
tokens.

### 2.3 What the providers publish about plan usage

**Anthropic (claude-plans, claude-max, claude-code-plans).** No token,
message or dollar figure for any plan. Published relations only:

- Pro, $20 a month: the base unit; "More usage than Free".
- Max, $100: "5x Pro usage every 5 hours and every week"; "Fable included, up
  to half your weekly limit".
- Ultra, $200: "No 5-hour limit" (for verified accounts) and "10x Pro usage
  every week"; Fable at half the weekly limit.
- Team premium seat: "5x more usage than standard seats". Enterprise: "Seat
  price + usage at API rates", so a plan share does not apply.
- Usage is shared across Claude and Claude Code, and "how fast you reach a
  limit depends on the model you use, how long your chats are, and how large
  your files are". Pro and Max have a five-hour and a weekly limit; Max and
  Ultra also have "a separate weekly limit for Fable".
- How cached tokens or model choice count against a plan is not published.

**OpenAI (codex-pricing, chatgpt-pro).**

- Plans: Free, Go ($8), Plus ($20), Pro ("Plans at $100, $200, or $500 USD
  per month", named Pro 100, Pro 200, Pro 500), Business ($20–25 a seat),
  Enterprise and Edu.
- Plus and Standard Business, local messages per five hours, by model:
  GPT-6.2 Astra 6–50, GPT-6.2 Sol 17–180, GPT-6 Astra 5–45, GPT-6.1 Sol
  15–160, GPT-6.1 Terra 35–285, GPT-6 Sol 15–150, GPT-6 Luna 350–3 000.
- "Pro plans currently have no five-hour limit." "Weekly limits may also
  apply." No weekly figure for any plan. Enterprise and Edu with flexible
  pricing "have no fixed rate limits".
- Pro 100 and Pro 500 "now include twice their previous Work and Codex
  allowance"; "Pro 200 includes more usage than Pro 100". Ultrafast: not on
  Pro 100, "GPT-6.2 Sol in Codex only" on Pro 200, included on Pro 500, which
  adds GPT-6 Astra and GPT-6.1 Sol Ultrafast.
- Credit rate card, credits per million tokens at Standard speed (input /
  cached input / output). GPT-6.2 Sol is 50 / 2.5 / 250, GPT-6.2 Astra
  200 / 10 / 1 000 and GPT-6 Luna 2.5 / 0.25 / 12.5. For all ten models listed
  with API prices, that is exactly **25 credits per API dollar** for every
  token kind. "Codex credit billing has no separate cache-write charge." The
  dollar price of a credit is not published ("depends on your plan or
  agreement").
- Speed multipliers for *included usage*: Fast 2× (GPT-6.2 Astra and Sol),
  2.5× (GPT-6.1 Sol and Terra, GPT-6 Astra, Sol and Luna); Ultrafast 6×
  (GPT-6.2 Astra and Sol), 8× (GPT-6 Astra, GPT-6.1 Sol). Credits and
  pay-as-you-go use 2× and 6× (3× for GPT-6.2 until 2027-02-28).
- "Model choice, context, reasoning, tool use, retrieval, and caching all
  affect usage."

Inference: the page publishes speed multipliers for included usage next to
the credit card, and says Codex and ChatGPT Work "share pricing, credits, and
usage limits". So the included allowance is very likely metered with the same
per-token weights, that is, API dollars at Standard speed times the speed
multiplier. The page does not say so in those words.

### 2.4 Third-party measurements

- botfarm-2026-03 (published 2026-03-20): 80 autonomous coding tasks at 23 %
  of a weekly limit. "The $100 plan's weekly limit is worth ~$523 in API
  pricing"; "The $200 plan: ~$1,100". The models and the cache pricing used
  are not stated. In March the $100 plan was the 5× tier and the $200 plan
  the 20× tier, and the API prices of that time were higher than today's
  (Opus 4.6: $5 / $25, cache reads $0.50).
- nerftrack-2026-08 (published 2026-08-20): describes a community tool that
  prices local Codex logs at API rates and divides the dollar change by the
  change of the weekly percent, the same method as Delegatus's method R. It
  warns that a shift in cache hits or model mix moves the dollar figure with
  no change to the cap. It publishes no per-plan figure that could be checked.

### 2.5 This host's own measurement

The rate job stores, per account and day, the rise of the weekly percent and
the weight (API-priced dollars, Codex ultrafast at the fast rate) over the
7 days ending that day. A full week then equals `100 / rate` dollars. With
the rates erased (D1), only 2026-11-23 and 11-24 remain. October comes from
`docs/design/task-limit-spend.md` §3.1 (2026-10-12 to 10-20).

| Plan as reported | Accounts | One week in API-priced dollars, 2026-11-23/24 | October 2026 |
|---|---|---|---|
| Claude `max`, rate tier `default_claude_max_20x` | 3 (2 with their own rate) | 881, 1 126, 2 037, 2 212 | 1 527, 2 004, 1 443 |
| Codex `pro` | 2 | 812, 826, 985, 1 079 | 676, 769 |
| Codex `promax` | 1 | 2 732, 2 740 | 899 (most of its work then was Ultrafast, weighted at 2×) |
| Codex `prolite` | 1 | no rate (used little) | 178 |

Which Pro plan each Codex plan string names is an inference. `promax` is
Pro 500: that account ran 21.9 B tokens of GPT-6.1 Sol Ultrafast and 0.4 B of
GPT-6 Astra Ultrafast, which only Pro 500 includes. `prolite` is Pro 100:
it has the smallest budget, and it is the remaining name.

The Claude accounts recorded no 5-hour rise after 2026-10-30. At 15:36Z none
reports a session window, though all are in use (`account_limits`). That
matches Ultra's "No 5-hour limit", and suggests the legacy 20× tier is now
served like Ultra; this is an inference.

### 2.6 Budgets per plan and window

Unit: **meter dollars**, the tokens priced at the Standard-speed API rate of
their model, times the plan's published speed multiplier (§3.2). For Codex
this is credits ÷ 25 by the published card. For Claude it is an inference.
Grades: *measured* = this host, several account-days, about ±30 %;
*measured, thin* = one account; *inferred* = from published ratios and at most
one outside point, about ×2.

| Engine | Plan string (and tier) | Window | Low – mid – high | Grade | Derivation |
|---|---|---|---|---|---|
| Claude | `pro` | weekly | 60 – 120 – 250 | inferred | Max ÷ 5 (published ratio) |
| Claude | `max` + the 5× tier (tier string presumably `default_claude_max_5x`; not observed here) | weekly | 300 – 550 – 1 100 | inferred | botfarm $523 for the then 5× plan, at higher March prices; Ultra ÷ 2 (published 5× vs 10×) |
| Claude | `max` + `default_claude_max_20x` | weekly | 900 – 1 600 – 2 300 | measured | §2.5: three accounts in October, two in November; botfarm $1 100 for the then 20× plan |
| Claude | `max` with the tier not known (an older observation) | weekly | 300 – 1 000 – 2 300 | inferred | spans the two rows above |
| Claude | `ultra` | weekly | 900 – 1 600 – 2 300 | inferred | Max × 2 (published); agrees with the measured legacy 20× tier |
| Claude | `max`, `ultra`: Fable tokens | weekly (Fable) | half of the plan's weekly row | published ratio | "up to half your weekly limit"; on Pro, Fable is paid with usage credits |
| Claude | `pro`, `max` (5×) | 5 hours | weekly ÷ 6.6 | inferred | October measurement on the 20× tier: weekly / 5-hour ratio 6.5–6.8 (`task-limit-spend.md` §3.1) |
| Codex | `plus` (and Business standard seats) | weekly | 25 – 45 – 90 | inferred | Pro 200 ÷ 20 (venturebeat-2026-04: Pro 200 was sold as "Pro 20x") |
| Codex | `prolite` (Pro 100) | weekly | 180 – 360 – 700 | inferred | October $178 on one account, × 2 for the published doubling. Cross-check: October's $178 against Pro 200's $676–769 is 1 : 4, the launch ratio of 5× and 20× Plus (venturebeat-2026-04) |
| Codex | `pro` (Pro 200) | weekly | 650 – 900 – 1 200 | measured | §2.5, two accounts, October and November |
| Codex | `promax` (Pro 500) | weekly | 1 800 – 2 700 – 3 600 | measured, thin | §2.5, one account, after the doubling |
| Codex | Enterprise/Edu with flexible pricing; Claude Enterprise | — | no budget | published | no fixed limit, or usage at API rates |

**The same budgets as tokens.** Token ranges only mean something for a stated
mix. Below, mixes measured on this host over the 14 days to 2026-11-24 (98 %
of tokens are cache reads, 0.2–0.4 % output). The last column shows what the
cache does: the same Opus budget if nothing were cached (90 % fresh input,
10 % output).

| Budget (weekly) | Opus 5.5 mix, 2.48 M tokens / $ | Sonnet 5.5 mix, 4.72 M / $ | GPT-6.2 Sol mix, 6.81 M / $ | GPT-6 Luna mix, 84.9 M / $ | Opus with no cache, 0.18 M / $ |
|---|---|---|---|---|---|
| Claude Pro, $60–120–250 | 0.15–0.30–0.62 B | 0.28–0.57–1.2 B | — | — | 11–21–45 M |
| Claude Max 5×, $300–550–1 100 | 0.74–1.4–2.7 B | 1.4–2.6–5.2 B | — | — | 54–98–196 M |
| Claude 20× tier / Ultra, $900–1 600–2 300 | 2.2–4.0–5.7 B | 4.2–7.6–11 B | — | — | 0.16–0.29–0.41 B |
| Codex Plus, $25–45–90 | — | — | 0.17–0.31–0.61 B | 2.1–3.8–7.6 B | — |
| Codex Pro 100, $180–360–700 | — | — | 1.2–2.5–4.8 B | 15–31–59 B | — |
| Codex Pro 200, $650–900–1 200 | — | — | 4.4–6.1–8.2 B | 55–76–102 B | — |
| Codex Pro 500, $1 800–2 700–3 600 | — | — | 12–18–25 B | 153–229–306 B | — |

What is uncertain, and why:

- No provider publishes a weekly figure. Anthropic publishes nothing but
  ratios. Every absolute number here comes from this host or one outside
  measurement.
- The budgets are tied to the price table. When a price changes and the
  provider's meter does not, the same allowance reads as a different number
  of dollars. Opus 5.5 is 20 % cheaper than Opus 4.x for fresh tokens and
  60 % cheaper for cache reads. The rows are dated, and the measured basis
  (§3.3) absorbs such changes for accounts that have readings.
- Allowances move. Pro 100 and Pro 500 doubled about 2026-11-23
  (chatgpt-pro). Claude's $200 plan is now Ultra at 10× Pro weekly, where in
  March it was the 20× tier (claude-plans, botfarm-2026-03). Pro 100 carried
  a temporary 2× boost until 2026-05-31 (venturebeat-2026-04).
- Whether Anthropic counts cache reads at their API ratio (0.05× for Opus 5.5)
  is not published. October's leave-one-day-out errors for the Claude accounts
  were about the same with raw tokens and with price weighting (21–48 %), so
  the data neither confirms nor refutes the ratio for Claude
  (`task-limit-spend.md` §3.1).

## 3. Estimation model

### 3.1 Unit: meter dollars

A task's tokens on this host are about 98 % cache reads. One Codex budget is
76 B tokens of Luna or 6 B of GPT-6.2 Sol. A fresh Opus token costs 20 times
a cached one. A token budget without its mix is wrong by an order of
magnitude, so the estimate prices tokens first and divides dollars by
dollars. The token ranges of §2.6 help a reader picture a budget; the
computation never uses them.

### 3.2 Weighting

For each stored hour row (model *m*, tier *t*, engine *e*, counts *c*):

```
api_usd(row)   = c.input·P(m,t).input + c.cacheRead·P(m,t).cachedInput
               + c.cacheWrite5m·P(m,t).cacheWrite5m + c.cacheWrite1h·P(m,t).cacheWrite1h
               + c.output·P(m,t).output                                   (÷ 1e6)
meter_usd(row) = cost of c at P(m,"standard") × M(e,m,t)
```

- **Cached input** counts at its own published cached price.
  For Codex this is published: credits are 25 per API dollar for every kind,
  and cache writes have no separate charge, so written tokens count as input
  (`tokenPrices.ts:32` already does this). For Claude it is inferred.
- **Reasoning tokens** are inside output on both providers and are not added
  twice: `reasoning` is stored as a part of `output`, and a record where it is
  larger is refused (`src/lib/activity/tokenUsage.ts:84-86`, `:102-103`).
- **Model mix** needs no separate rule. Each hour row is priced at its own
  model, so a task that mixes Opus and Sonnet, or GPT-6.2 Sol and Luna, sums
  correctly weighted parts. A model without a price contributes tokens but no
  dollars (`estimateCost`, `tokenPrices.ts:118-129`).
- **Speed** `M(e,m,t)`: Codex uses the published included-usage multipliers
  (§2.3). Claude fast uses 2×, the API price ratio; this is inferred, and no
  Claude fast tokens were recorded here in the last 14 days. Standard is 1.
  Where the data file has no multiplier, the API price ratio applies.
- **Long context**: prices are the short-context ones. The store sums per
  hour, so prompts above the thresholds are priced at the lower rate. The
  estimate can only fall short there (as today, `tokenPrices.ts:10-14`).

### 3.3 Share of a plan

Per task and account *a*, in the account's weekly window:

```
measured_pp(a) = Σ over hours whose UTC day has a measured rate r(a,day) of  meter_usd × r   (stored today as weekly_pp)
plan_pp(a)     = (meter_usd(a) − rated_meter_usd(a)) / B_mid(plan(a)) × 100
share(a)       = measured_pp(a) + plan_pp(a)
range(a)       = [0.7·measured_pp + (…)/B_high·100 ,  1.3·measured_pp + (…)/B_low·100]
basis(a)       = measured if rated ≥ 90 % of meter_usd; plan if ≤ 10 %; mixed otherwise
provider share = Σ over the provider's accounts of share(a)       (percent of each account's week)
```

- `B` comes from the data file. Lookup order: (engine, plan, plan tier), then
  (engine, plan). The tier is needed for Claude (D4). The plan and tier are
  the account's current observation, or, when that has none, the latest the
  rate job recorded for the account (D6).
- Basis choice: measured first. Where an account has its own rate, it was
  accurate to about ±30 % at the median and it follows allowance changes by
  itself. Where it has none, the plan budget gives a figure: old days, an
  account used too little to calibrate, a new account. The popover always
  shows the plan range. When the measured share lies outside it, the basis
  line says so and nothing is clamped.
- `plan_pp` is linear in the dollars, so it is computed on the read path from
  stored sums. Editing a budget changes figures on the next board beat, with
  no recomputation.
- The unit stays the one the card already uses (percent of each account's
  week, summed per provider); see `task-limit-spend.md` §2.5 and §8 Q2.

### 3.4 API-price equivalent

`api_usd` summed per account, per provider and per task, at the tier each hour
ran on (Codex Ultrafast at its published API rate; the meter multiplier
plays no part here). It is printed as "≈ $32 at API prices", a comparison
and never spending.

### 3.5 Unknown, unknown plan, unknown model, lower bound

| Case | Tokens | API $ | Share | Face |
|---|---|---|---|---|
| Tokens known, plan known | yes | yes | measured, mixed or plan | scale |
| Tokens known, plan not reported, no measured rate | yes | yes | none; popover: «план акаунта невідомий, частку не оцінено» | engine mark and compact tokens («229M») |
| Tokens known, plan without a fixed limit (Enterprise flexible, Claude Enterprise) | yes | yes | none; popover says the plan has no fixed limit | as above |
| Only models without a price | yes | none | none; popover names the model | as above |
| Some models without a price | yes | priced part | priced part; popover: «N токенів моделі X без ціни не враховано» | scale |
| Task created before counting began | yes (counted part) | counted part | counted part, «≥» | scale with «≥» |
| Tokens unknown (no counted row) | no | no | no | nothing, as today |

"Unknown" is never printed for a provider whose tokens are known. A running
task shows its spend so far without «≥»; the 45-second beat updates it. The
host-wide `complete` flag no longer reaches the card.

### 3.6 Worked example (synthetic)

One task: Claude Opus 5.5, 70.0 M tokens (0.3 M input, 68.6 M cache reads,
0.9 M five-minute cache writes, 0.2 M output). Codex GPT-6.2 Sol Standard,
40.0 M (0.5 M input, 39.3 M cached, 0.2 M output). GPT-6.1 Sol Fast, 5.0 M
(0.05 M input, 4.93 M cached, 0.02 M output).

- Claude API $ = 0.3·4 + 68.6·0.2 + 0.9·5 + 0.2·20 = 1.20 + 13.72 + 4.50 + 4.00 = **$23.42**; meter $ the same.
- Codex Standard: 0.5·2 + 39.3·0.1 + 0.2·10 = **$6.93** (API and meter).
- Codex Fast on GPT-6.1 Sol: Standard cost 0.05·2 + 4.93·0.1 + 0.02·10 = $0.793. The API price is 2× → **$1.59**; the meter is 2.5× → **$1.98**.
- Claude account on the 20× tier with no measured rate: share = 23.42 / 1 600 = **1.5 %**, range 23.42/2 300 to 23.42/900 = 1.0–2.6 %; the face fills one cell.
- Codex Pro 200 account, no measured rate: meter $8.91 → 8.91 / 900 = **1.0 %**, range 0.7–1.4 %.
- Card: tokens 115 M; API equivalent ≈ **$32** (23.42 + 6.93 + 1.59).

### 3.7 Accuracy

- Measured basis: about ±30 % at the median, one task in five off by up to
  2× (October, `task-limit-spend.md` §3.3). Accounts also used outside this
  host read high.
- Plan basis: the grade of the budget row, ±30 % (measured) to ×2 (inferred).
- API price: exact for the counted tokens at the dated prices, low for
  long-context prompts.

## 4. The data file

One file, `src/lib/activity/usageEstimates.json`, importable by the server and
by the client components that price tokens today (`ActivityTokens.tsx`,
`ActivityCountingDrawer.tsx`, `OrchestratorStep.tsx`; `resolveJsonModule` is
on, `tsconfig.json:16`). It replaces the hard-coded table in
`tokenPrices.ts:17-77`. `tokenPrices.ts` keeps its exported functions and
reads the file. One row per line, so a price change is a one-line diff.

```json
{
  "version": "2026-11-24.1",
  "sources": {
    "anthropic-api": { "url": "https://platform.claude.com/docs/en/about-claude/pricing", "retrieved": "2026-11-24" },
    "openai-api": { "url": "https://developers.openai.com/api/docs/pricing", "retrieved": "2026-11-24" },
    "codex-pricing": { "url": "https://learn.chatgpt.com/docs/pricing", "retrieved": "2026-11-24" },
    "claude-plans": { "url": "https://claude.com/pricing", "retrieved": "2026-11-24" },
    "botfarm-2026-03": { "url": "https://buttondown.com/botfarm/archive/what-a-claude-max-weekly-limit-is-actually-worth/", "published": "2026-03-20", "retrieved": "2026-11-24" },
    "measured": { "doc": "docs/design/subscription-usage-estimate.md#25-this-hosts-own-measurement", "measured": "2026-11-24" }
  },
  "prices": [
    { "model": "claude-opus-5-5", "tier": "standard", "input": 4, "cachedInput": 0.2, "cacheWrite5m": 5, "cacheWrite1h": 8, "output": 20, "source": "anthropic-api", "date": "2026-11-24" },
    { "model": "gpt-6.2-sol", "tier": "ultrafast", "input": 6, "cachedInput": 0.3, "output": 30, "until": "2027-02-28", "source": "openai-api", "date": "2026-11-24" }
  ],
  "meter": [
    { "engine": "codex", "model": "gpt-6.1-sol", "tier": "fast", "times": 2.5, "source": "codex-pricing", "date": "2026-11-24" },
    { "engine": "codex", "model": "gpt-6.1-sol", "tier": "ultrafast", "times": 8, "source": "codex-pricing", "date": "2026-11-24" }
  ],
  "budgets": [
    { "engine": "claude", "plan": "max", "planTier": "default_claude_max_20x", "window": "weekly", "low": 900, "mid": 1600, "high": 2300, "grade": "measured", "source": "measured", "date": "2026-11-24" },
    { "engine": "codex", "plan": "pro", "window": "weekly", "low": 650, "mid": 900, "high": 1200, "grade": "measured", "source": "measured", "date": "2026-11-24" }
  ]
}
```

Rules, enforced by a test of the file itself:

- Every row names a key present in `sources` and an ISO `date`. `version`
  changes with any row (a date plus a counter).
- `prices`: one row per model and tier. An OpenAI row has no cache-write
  fields, and writes price as input. A Claude row may omit the writes: 1.25×
  and 2× input then apply. Dollars per million tokens. `until` marks a dated
  promotion; past that date the row stays in use until edited, and the test
  fails, which prompts the edit.
- `meter`: optional multiplier per engine, model and speed tier, relative to
  Standard. A missing row means the API price ratio of that tier.
- `budgets`: meter dollars per window; `low ≤ mid ≤ high`; `grade` is
  `measured`, `measured-thin`, `inferred` or `published`. A plan without a
  fixed limit has no row.
- No account ids, labels or e-mail addresses: rows name plans, never
  accounts.

## 5. First implementation slice (stored records only)

Goal: on the final state of slice 1, every card whose task has counted tokens
shows tokens, an estimated share with its basis and an API-price equivalent,
and never «невідомо».

| # | Change | Where | Why |
|---|---|---|---|
| 1 | Add the data file; `tokenPrices.ts` reads prices from it (same exports; `PRICE_TABLE_DATE` and `PRICE_SOURCES` come from it) | new `src/lib/activity/usageEstimates.json`; `tokenPrices.ts:17-77` | acceptance 2 |
| 2 | Pure module: `meterCost`, `apiCost`, `planBudget`, `estimateShare` | new `src/lib/activity/subscriptionEstimate.ts` | one place for the math, tested alone |
| 3 | The rate weight uses `meterCost` | `limitRates.ts:21-23` | rate and task weight in one unit |
| 4 | `task_limit_spend` gains `api_usd REAL`, summed in `computeTaskRows` beside `weight` (same loop, no extra read). `limit_spend_meta` gains `estimate_version`. When the data file's `version` differs, tasks are re-dirtied in pages of 200, as the `aggregate_schema` migration does | `taskLimitSpend.ts:103-106`, `:159-166`; schema at `tokenStore.ts:58` | a price edit reprices stored figures; bounded by the existing per-pass limits (100 tasks, 2 000 owner pages, 50 000 hour rows, `taskLimitSpend.ts:146-147`) |
| 5 | Keep a stored non-null rate when its 7-day history is no longer covered: such a day is skipped and its stored rate stays | `limitRates.ts:117-124` | D1 |
| 6 | A row is a lower bound only for work before counting began; drop `uncounted` from coverage and from unrated weight | `taskLimitSpend.ts:99-100`, `:382-384`, `:398` | D2 |
| 7 | The Claude observation carries `planTier` from `claudeAiOauth.rateLimitTier`, read where `subscriptionType` is read now | `src/lib/limits.ts:556`, `:574`; optional field on `EngineLimits`, `src/lib/types.ts:707-721` | D4; no new read, the credential document is already loaded. Check that the registry's normaliser keeps the field (`src/lib/agent/registry.ts:5200`) |
| 8 | `usage_limit_rates` gains `plan_tier`, written beside `plan` from the observation | `limitRates.ts:123` | D6: the last known plan and tier survive a lost observation |
| 9 | `readTaskLimitSpend` computes per account and provider `share`, `range`, `basis`, `apiUsd`, `budget`, and states `tokens` for the no-share cases of §3.5. The plan comes from the observation, else from one indexed read of the account's latest non-null `plan` row (once per account per request; the accounts number under ten) | `taskLimitSpend.ts:365-404`; types in `taskLimitSpendTypes.ts` | arithmetic on the rows of the existing primary-key read (`:374`), plus at most one small read per account |
| 10 | Card: the face never prints «невідомо» for counted tokens; the popover adds the API price, the tokens and a basis line; the account line's second figure becomes the account's week; en and uk | `TaskSpend.tsx`, `src/lib/i18n/en.ts:7889-7908`, `uk.ts:7798-7817` | acceptance 3 |

Tests (acceptance 4), each by path with isolated `HOME`, `XDG_CONFIG_HOME`,
`TMPDIR` and `LLV_STATE_DIR`:

- new `src/lib/activity/subscriptionEstimate.test.ts`: mixed models (Opus and
  Sonnet hours, GPT-6.2 Sol and Luna hours), cached tokens (cache reads at the
  read price, OpenAI writes as input, Claude 5-minute and 1-hour writes),
  Codex Fast and Ultrafast meter versus API price, unknown model, unknown
  plan, a plan without a fixed limit, measured and plan basis mixed, the
  range, and the rule that a provider with tokens is never unknown;
- a test of the data file: sources, dates, versions, no duplicate keys, no
  expired `until`;
- `limitRates.test.ts`: a day's rate survives its history leaving retention;
  the plan and tier are recorded;
- `taskLimitSpend.test.ts`: no `uncounted` floor while transcripts are being
  written; the version change re-dirties and reprices;
- `TaskSpend.dom.test.tsx`: face and popover for each row of §3.5;
- `tokenPrices.test.ts` keeps passing unchanged (same prices).

Rendered evidence: a `describe` block in
`src/components/kanban/kanbanBoard.browser.test.tsx` over the existing
fixture, in en and uk, light and dark, desktop column width and the 390 px
phone, including the popover and the phone task screen.

Load: no new provider call and no new loop. The read adds arithmetic per row
already read, and at most one primary-key-ordered read per account whose
observation has no plan. The one-time repricing runs inside the
existing bounded pass. No speed gain is claimed.

What slice 1 does not do: change the account panels (they show readings),
show Fable's separate window, show the 5-hour share from the table, change
the agent rows.

## 6. Later slices

- **Slice 2, check the meter.** Over two weeks of kept rates, compare the
  leave-one-day-out error with Codex Fast and Ultrafast at the published
  included-usage multipliers and at the API ratios (D5). The same check tests
  the Claude cache ratio. Write the winner into `meter`, with the measurement
  as its source. Also refresh `measured` budget rows from the kept rates.
- **Slice 3, only if asked.** The Fable weekly window as one popover line
  needs a per-model weight in the task row. A 5-hour share for Pro and Max
  accounts from the table applies only to accounts that report the window.

## 7. Card and task view (for the build and its visual review)

- The face stays as approved in October (variant 2): per provider the engine
  mark and the four-cell scale, Claude then Codex; no pill, no new row, no
  digits beyond what is there. The only new face text is the compact token
  count, in the rare no-share cases of §3.5.
- Popover (desktop card, open or closed, and the phone task screen's «Ліміти»
  section), at most six lines:
  1. «Витрата задачі»
  2. per provider: «✳ Claude ≈1% тижня (1–3%) · ≈ $23»
  3. per account, owner only: «A · Max 20×: задача 1% · акаунт за тиждень 80%»
  4. «115 млн токенів · ≈ $32 за цінами API»
  5. basis, muted: «Частка — оцінка: темп акаунта за 7 днів» or «… бюджет
     плану з відкритих джерел ($900–2 300 за тиждень)»
  6. only when it applies: the before-counting or no-price note.
- Whether the API price should also sit on the face is a choice for the
  visual stage. The recommended default is no: the state line has no room
  for another element, and the popover already answers the request for
  prices.

## 8. Check against the requirement

| Requirement | Where |
|---|---|
| Look at how tokens are counted per subscription | §1.1–1.2: tokens are counted for every task; the figures fail in the rate job and the floor rule |
| Research roughly how many tokens each plan allows, per plan, Claude, Codex and others | §2.3–2.6, budgets with derivation and grade, token ranges per mix; the role table names only Claude and Codex |
| Estimate each task's share from its own tokens | §3.3 |
| Cheaply, no heavy new load | §5: stored rows, no polling, arithmetic on the existing read, bounded one-time repricing |
| Fewer "unknown" and wrong displays; percentages that look incorrect | D1–D4 and D6 fixed, D5 rechecked in slice 2; «невідомо» only without tokens; «≥» only before counting; the audit in §1.3 |
| API prices | §3.4, §7 |

## Decisions taken under full autonomy

The lane runs under full autonomy, so these were settled on the
recommendation and are recorded here for the operator to revisit:

1. **Basis of the share.** Options: (a) the plan budget alone; (b) the
   measured account rate where present and the plan budget otherwise; (c) the
   measured rate alone. Chosen: (b). (a) is simpler but goes stale silently
   when allowances move, as they did this autumn (§2.6). (c) is today's
   design and leaves old work unrated.
2. **Unit.** Percent of each account's week, summed per provider, unchanged
   from October.
3. **API price placement.** Popover and phone task screen; the face is
   unchanged. The visual stage may try a face variant.
4. **Codex speed multipliers.** Published included-usage values, with the
   October fit recorded against them (D5) and rechecked in slice 2.
5. **Unknown plan.** Tokens and API dollars, no share, and the reason in the
   popover.

## Deferred — not currently justified

- Copilot and other engines: the ingest reads no tokens for them, and the role
  table names none (`docs/design/activity-token-usage.md` §1.3).
- Claude Cloud tasks: the provider reports no per-task usage (the closed
  investigation in this project's board).
- Work on linked machines: no token rows cross (`host = ''`), and linked cards
  draw no spend (`KanbanCard.tsx:722`).
- Fetching prices or budgets from the web automatically: new outside polling
  of pages that change their wording; a dated one-line edit is enough.
- Per-agent spend on agent rows.
- A share for plans with no fixed limit.
- Per-day plan history: a plan change relabels earlier work with the current
  plan.
- Retiring the measured rate (method R): it supplies the better basis.
- Attributing the seat's tokens to the tasks it worked on.
- Long-context price tiers per request: the store sums per hour.

## Found while reading (outside this lane)

- `tokenPrices.ts` lacks GPT-6.1 Terra ($1 / $0.05 / $5), which the API page
  and the Codex page list.
- The API page's note on GPT-5.6 Sol says its promotional pricing is
  "available until November 30, 2026"; the Codex page says "at least through
  November 21, 2026". The sources disagree.
- No Claude account has recorded a 5-hour rise since 2026-10-30, yet the rate
  job still computes a session row for every account and day: 377 rows, all
  without a rate.
- `usage_meta.complete` is 0 whenever any transcript has unread bytes at the
  end of a pass, so it reads false on a busy host. Any other consumer that
  reads it as "this host is fully read" (the token report's coverage,
  `src/lib/activity/tokenReport.ts:28`) is likely to see false nearly always.
  This is inferred and was not rendered.

## Appendix A: procedure

All on 2026-11-24, from scratch scripts in the stage's temporary directory,
removed with it; `python3 -I`.

- Store: `activity/records.sqlite` opened with `mode=ro` and copied with
  `VACUUM INTO` at 15:35Z (88.8 MB copy). Queries: counts and sums of
  `task_limit_spend` by engine, `weekly_pp IS NULL`, `floor`, `rated_weight <
  weight`, `unpriced_tokens > 0`. The provider state of each task was
  recomputed exactly as `readTaskLimitSpend` (`taskLimitSpend.ts:375-398`)
  does. `usage_limit_rates` by window, source and day. `usage_meta` and
  `limit_spend_meta` as stored.
- Budgets: `100 / rate` from `usage_limit_rates` rows with `source = 'own'`
  (weekly) on 2026-11-23 and 11-24. Plans from the same rows and from
  `account_limits` at 15:36Z.
- Mixes: `usage_hours` with `host = ''` for the 14 days to 15:35Z, summed by
  engine, model and tier, priced with the rates of §2.2 (Codex `priority` as
  Fast, `default` as Standard).
- Claude plan tier: the `claudeAiOauth.subscriptionType` and `.rateLimitTier`
  fields of each Claude credential file. No other field was printed.
- Sources: each URL fetched with `curl -sL` and a browser user agent; HTTP
  status and byte count recorded (§2.1); markup stripped; quoted passages
  located in the stripped text. Pages that refused the scripted fetch were
  read through the fetch tool, and are marked as such.

Verdict: pass. The document is complete for acceptance item 1. Slice 1 is
specified and needs no operator decision.
