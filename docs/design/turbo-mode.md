# Turbo mode: spend a project's Codex limits faster, switched live

Part A of the Turbo lane: research and design. Part B (prototype) and part C
(visual critic, operator review) follow in later stages and read this
document. No product code changes here.

## Originating requirement (dated paraphrase; the source is private)

On 2026-10-21 at about 09:55 UTC the operator dictated a chat message to this
project's orchestrator. The pinned specification marks the verbatim text for
agents only, so this public document paraphrases it:

- **R1.** Add a playful, original, eye-catching Turbo button with its own icon
  to the seat tick settings, next to Full autonomy.
- **R2.** Turning Turbo on needs a confirmation.
- **R3.** Turbo leaves a mark in the seat tick's prompt.
- **R4.** At the same moment, Turbo tells the orchestrator that Turbo is on and
  that the limits of the accounts allowed on this project may now be spent
  faster.
- **R5.** For Codex, Turbo uses ultrafast where the account offers it, and
  priority otherwise. The operator believes Claude Code's fast mode costs
  extra, which would make Turbo Codex-only. Check the vendor's own pages and
  correct that if it is wrong.
- **R6.** Everything running now moves to the new speed automatically: stop
  each one, switch its speed, and resume its work.
- **R7.** It must not lag. Today's switching is slow and could stall
  everything.
- **R8.** The orchestrator looks at which pipelines are worth moving to the
  new speed, for example their next stages.
- **R9.** (Added at about 11:38 UTC the same day, by chat.) Where Turbo uses
  Codex, spending paid credits needs its own approval, because that costs
  money. The orchestrator relayed it as: a separate, explicit approval that
  says the spending is paid and names the accounts that would spend credits;
  without it Turbo uses only what costs no credits.

The pinned specification adds: define what Turbo off does, whether Turbo
expires, and which accounts count as allowed. It also asks that live stage
switches reuse `override-stage` `applyNow`, with an equivalent for spawned
conversations. The seat decides which upcoming stages to switch, and Claude is
included only if its fast mode is part of the plan.

## Decision summary

1. **Turbo is Codex-only.** Anthropic's page says fast mode on subscription
   plans is paid from usage credits only, outside the plan's rate limits
   (§1.1). Turbo leaves Claude alone.
2. **One per-project setting**, stored beside Full autonomy in the seat tick
   settings. Only the operator turns it on or extends it, after a confirmation
   dialog. It ends after a chosen time (default 2 h). The seat may shorten it
   or turn it off, and it gives its reason when it does.
3. **Allowed accounts** are the project's Codex binding. Each conversation
   keeps its own account and gets the fastest tier that account's catalog
   lists for its model: `ultrafast` where listed, otherwise `priority`. Today
   that means account A runs `ultrafast` on gpt-6.1-sol and gpt-6-astra and
   `priority` elsewhere, and accounts B and C run `priority` (§1.3).
4. **The mark (R3)** is a line that every wake carries while Turbo is on,
   built from the stored setting. The operator's instruction text and the
   monitor note are never edited.
5. **The message (R4)** is one notice to the project's current seat through
   the project-addressed orchestrator channel, sent when Turbo turns on and
   again when it turns off.
6. **Live switch (R6) without a process restart (R7).** The installed Codex
   app-server changes a live thread's tier with `thread/settings/update`. The
   change applies from the thread's next turn, needs no restart and needs no
   feature flag (probe, §1.5). For a turn that is running, Delegatus stops it
   at the next step boundary (never in the middle of a running command) and
   continues it with one short message. Pipeline stages go through the
   existing `applyNow` switch record in a new in-place mode. Other
   conversations go through the conversation reconfigure, which gains an
   explicit tier.
7. **Bounded switching (R7).** One durable queue per Turbo episode runs off
   the Viewer and runtime-host loops, with at most 3 switches in flight and at
   least 2 s between starts. Every step is awaited asynchronously and named
   for the loop monitor. Stored switch history shows why the bound is needed
   (§1.6).
8. **Upcoming stages and new launches (R8)** are the seat's decision, made
   with the tools it already has: `override-stage` with `serviceTier` and no
   `applyNow`, and `serviceTier` on `spawn_agent` and `create_pipeline`.
9. **Turbo off** puts every conversation Turbo switched back on its previous
   tier from its next turn, with no cut. Stage definitions Turbo changed get
   their previous tier back. The seat gets an "off" notice.
10. **Paid credits need a separate approval (R9), off by default.** No tier
    is paid by itself: Fast and Ultrafast draw on the plan's included usage
    first, and an account spends purchased credits only after that runs out,
    and only if it holds credits (§1.2). Without the approval, Turbo never
    spends a credit: on an account that holds credits it raises tiers only up
    to 90 % of the session or weekly window and then returns that account's
    conversations to their previous tier. With the approval, a checkbox in its
    own box in the dialog that names the paying accounts and their tiers, those
    accounts keep their Turbo tier after the included usage and pay from their
    balance until the episode ends. The approval covers only this project and
    only this episode, and only the operator can give it (§2.2, §2.3).

## 1. Facts (observed 2026-10-21; times UTC)

### 1.1 Claude Code fast mode: Anthropic's own pages

| page | read at | HTTP | bytes | page date |
|---|---|---|---|---|
| `code.claude.com/docs/en/fast-mode.md` | 09:59:59Z | 200 | 20,736 | `dateModified` 2026-10-19T18:23:11Z (from the HTML page) |
| `claude.com/pricing` | 10:00:17Z | 200 | 1,244,526 | none found |
| `code.claude.com/docs/en/costs.md` | 10:00:17Z | 200 | 44,374 | none found |

Quoted from the fast mode page:

- "Fast mode is supported on Opus 5.5, Opus 5, and Opus 4.8. It is not
  available on Sonnet, Haiku, or other models."
- "For Claude Code users on subscription plans (Pro/Max/Team/Enterprise), fast
  mode is available via usage credits only and not included in the
  subscription rate limits."
- "Fast mode usage draws directly from usage credits, even if you have
  remaining usage on your plan."
- "Fast mode pricing per MTok input/output is \$8/\$40 on Opus 5.5 and
  \$10/\$50 on Opus 5 and Opus 4.8."
- Turning it on: "Run `/fast`, press Space to toggle on or off, then press
  Enter to confirm" or "Set `"fastMode": true` in your user settings file". In
  `-p` mode it works only "in a session launched with fast mode in its
  `--settings` value", from v2.1.205.
- "The first time you enable fast mode in a conversation, you pay the full
  fast mode uncached input token price for the entire conversation context."
- "You can run `/fast` while Claude is working … Claude Code finishes the
  running turn at its original speed".

Quoted from the pricing page: "Get up to 2.5x faster speeds with fast mode for
Opus 5.5 at 2x standard pricing."

**Conclusion.** The operator was right: on this machine's Claude plans
(three accounts, all plan `max`, §1.3) fast mode draws on usage credits even
while plan usage remains. Turbo stays Codex-only. Claude Code 2.1.302 is
installed. No Delegatus source sets `fastMode`, and neither of the two
`settings.json` files checked on this machine does.

### 1.2 Codex speed tiers: OpenAI's own pages

| page | read at | HTTP | bytes | page date |
|---|---|---|---|---|
| `learn.chatgpt.com/docs/agent-configuration/speed.md` | 10:00:50Z | 200 | 3,580 | none found (unknown) |
| `developers.openai.com/codex/pricing` → redirected to `learn.chatgpt.com/docs/pricing` | 10:00:43Z | 200 | 711,265 (HTML), 45,736 (`.md`) | none found (unknown) |

Quoted from the speed page:

- "For supported models, Fast mode uses included subscription limits at 2.5x
  the Standard rate. Purchased credits and Enterprise pay-as-you-go usage are
  billed at 2x the Standard rate."
- "Ultrafast supports GPT-6 Astra and GPT-6.1 Sol."
- "Ultrafast is available in Codex and ChatGPT Work on Pro \$500 and eligible
  Enterprise and Edu plans. On Pro \$500, Ultrafast uses your included usage
  first, then your available credits after that allowance runs out."
- "Ultrafast mode bills purchased credits and Enterprise pay-as-you-go usage
  at 6x the Standard rate. Ultrafast uses included subscription limits at 8x
  the Standard rate."
- The page's own toggle advice uses another word: "persist the default with
  `service_tier = "fast"`". The catalog id Delegatus validates is `priority`,
  whose display name is "Fast" (§1.3).

From the pricing page's table:

| Speed mode | Included subscription usage | Purchased credits and Enterprise pay-as-you-go usage |
|---|---|---|
| Fast | 2.5x | 2x |
| GPT-6 Astra Ultrafast | 8x | 6x |
| GPT-6.1 Sol Ultrafast | 8x | 6x |

The pricing page lists Pro "Plans at \$100, \$200, or \$500 USD per month" and
"Ultrafast mode access on Pro \$500".

### 1.3 This machine: catalogs, plans, binding

Each Codex account's `models_cache.json` was read without writing anything.
Every cache was fetched by client 0.162.1 between 2026-10-20 05:49Z and
2026-10-21 09:57Z. `codex --version` reports `codex-cli 0.162.1`. Plan values
come from `account_limits` (observed 09:48Z). No account's `config.toml` sets
`service_tier`.

| account | plan (as Delegatus records it) | allowed on this project (Codex) | gpt-6.1-sol, gpt-6-astra | gpt-6-sol, gpt-6-luna, gpt-5.6-* | gpt-daybreak-blue-latest |
|---|---|---|---|---|---|
| A | `promax` | yes; bound to this project only | `priority`, `ultrafast` | `priority` | (not listed) |
| B | `pro` | yes; also bound to two other projects | `priority` | `priority` | no tiers |
| C | `prolite` | yes; this project only | `priority` | `priority` | (not listed) |
| D | `pro` | no | `priority` | `priority` | no tiers |

- The catalog's own words: `priority` is named "Fast", described as "2x
  speed, increased usage". `ultrafast` is named "Ultrafast", described as "The
  fastest available responses for latency-sensitive work."
- Matching `promax` to "Pro \$500" is an inference: account A is the only
  catalog that lists `ultrafast`, and OpenAI offers Ultrafast only on Pro \$500.
  No Delegatus source maps plan values to prices.
- Claude: three accounts are allowed on this project, all plan `max`. Turbo
  does not touch them.
- Weekly usage, observed 09:00–09:48Z: A 36 %, B 63 %, C 43 %.
  `account_limits` reported no paid-credit balance for any account. Whether
  any of them holds purchased credits is **unknown**.
- Applied tiers recorded in account A's rollouts (`thread_settings_applied`):
  `ultrafast` once on 10-15 and once on 10-17, and `priority` eight times on
  10-15. So ultrafast threads have run on this machine.

### 1.4 Delegatus today

- **Tier plumbing exists** (`docs/design/codex-service-tier.md`). A
  `serviceTier` field sits on create-pipeline stages
  (`src/lib/mcp/server.ts:3900`), on `spawn_agent` (`server.ts:4019`, next to
  `fast` at `:4021`) and on `override-stage` (`server.ts:4189`). It is
  validated against each account's catalog by `codexModelServiceTiers` and
  `tierOffers` (`src/lib/accounts/codexServiceTiers.ts:10`, `:28`). The host
  checks it again at start (`src/lib/runtime/codexAppServerHost.ts:1584`) and
  passes it only on `thread/resume` and `thread/start` (`:1648`, `:1655`).
- **Live stage switch.** `override-stage` with `applyNow`
  (`src/lib/pipelines/engine.ts:14433`) resolves the tier and the tier-offering
  accounts (`:14578`). It opens a runtime-switch record (`runtimeSwitches`,
  phases requested → cutting → switching → continuing → committed, with a
  10-minute budget at `src/lib/pipelines/runtimeSwitch.ts:40`). The
  conversation reconfigure executor then runs it
  (`src/lib/runtime/structuredReconfigure.ts:156`). That executor **releases
  and terminates the host and recovers it** with the new launch profile, so
  every switch, tier-only ones included, restarts the conversation's Codex
  process (ADR `docs/design/automation-v2/adr/0004-runtime-switches-continue-a-live-attempt.md`:
  "the host is released and restarted through structured recovery").
- **Conversation reconfigure** (the RuntimePill path) carries only `model`,
  `effort` and a boolean `fast` (`src/lib/agent/reconfigure.ts:4`,
  `src/lib/runtime/contracts.ts:480`). It cannot ask for `ultrafast`.
- **Full autonomy** is the pattern to copy: the setting and its authority
  rules (`src/lib/monitor/autonomy.ts:43`), the wake overlay
  (`autonomy.ts:73`, spliced into the wake in `src/lib/monitor/report.ts`), and
  the panel section (`src/components/orchestrator/SeatTickBody.tsx:752`,
  `:811`). Its forbidden list names "accounts/spend", so the seat needs a
  stated permission while Turbo is on.
- **Wake size.** Wakes are capped at 4,000 characters
  (`src/lib/monitor/report.ts:114`). The full autonomy overlay is 1,125
  characters and its later pointer 218, both measured by calling
  `autonomyMandate` from current source. The seat's 09:50Z wake today, which
  carried the full overlay, was between 3,001 and 3,150 characters: read back
  through `conversation_messages`, it was cut at a 3,000-character limit and
  whole at 3,150.
- **Credit guard.** A Codex account with paid credits stops taking work once
  a session or weekly window reaches 99 % (`src/lib/accounts/creditGuard.ts:19`,
  `:26`). So today Delegatus never lets Codex work run on into purchased
  credits on purpose.
- **Paid credits per account.** Delegatus reads each Codex account's paid
  balance from its rate-limit snapshot as `{ hasCredits, balance, unlimited }`
  (`PaidCredits`, `creditGuard.ts:4`, parsed at `:11`); `balance` is the
  provider's string. That is all the dialog needs to name the accounts that
  could spend credits.
- **Seat channel.** `sendMessageToOrchestrator`
  (`src/lib/mcp/bindings.ts:5438`) posts to `/api/orchestrator/message`. That
  route picks the current seat at delivery time
  (`docs/design/seat-single-channel.md`).

### 1.5 Changing a live thread's tier: schema and probe

**Schema.** Generated from the installed CLI 0.162.1 with
`codex app-server generate-json-schema --experimental`, using a scratch
`CODEX_HOME`. The v2 schema's sha256 starts `5c0ee37a723e4672`.

- `thread/settings/update` takes `serviceTier`: "Override the service tier
  for subsequent turns. `null` clears the current service tier; omission
  leaves it unchanged." The server notifies `thread/settings/updated` with the
  resulting `threadSettings`.
- `turn/settings/update` takes `threadId`, `turnId` and `serviceTier`:
  "Experimental settings changes for one running turn, not future turns."
  Its answer `applied` means "Published for subsequent captures … Already
  captured steps are unchanged; a later inference is not guaranteed."
- Both methods exist only in the experimental halves of the pinned protocols
  (`src/lib/accounts/protocol/0.162.1/` and `0.163.0/`). The Delegatus host
  already opts into the experimental API for the native queue and realtime
  (`codexAppServerHost.ts:1552`). The protocol check is global
  (`src/lib/accounts/codexPinnedProtocol.ts:123`, `:129`), so an already
  initialized host may send `thread/settings/update` once its code does.
  Nothing in Delegatus calls either method today.
- `codex features list`: `step_model_switching` is "under development",
  default `false`. `fast_mode` and `ultrafast_mode` are "stable", default
  `true`.

**Probe.** The probe ran in the stage's scratch directory inside an
unprivileged network namespace with only loopback. A port-0 stub served the
Responses API and logged each request's `service_tier`. `codex app-server`
used a scratch `CODEX_HOME` with a custom provider pointed at the stub. For
runs 3–9, that home held one catalog row copied from account A's cache: the
gpt-6.1-sol row listing `priority` and `ultrafast`, with the cache's identity
field removed. Turn 1's first response was held open for 6 s, during which
the driver sent the mid-turn change. It then returned a tool call, so turn 1
made a second request. Turn 2 started after turn 1 completed.

| run | setup | thread/start | mid-turn call | after turn 1 | turn 1 req 1 | turn 1 req 2 | turn 2 |
|---|---|---|---|---|---|---|---|
| 1 | no catalog row | `priority` (echo: null) | `turn/settings/update` → refused: "turn settings updates require the step_model_switching feature" | thread update `flex` | none | none | `flex` |
| 2 | no row, feature on | `flex` | `turn/settings/update` → refused: "the active model has only fallback metadata" | thread update `ultrafast` | `flex` | `flex` | none |
| 4 | row, feature on | `default` | `turn/settings/update` `priority` → `applied` | thread update `ultrafast` (echo: `ultrafast`) | none | **`priority`** | none |
| 5 | row, feature on | `priority` | `turn/settings/update` `flex` → `applied` | thread update `default` | `priority` | **`flex`** | none |
| 7, 8 | row, feature off (7) / on (8) | `default` | `thread/settings/update` `priority` | thread update `default` | none | none | none |
| 9 | row, feature off | `default` | `thread/settings/update` `priority` | (none) | none | **none** | **`priority`** |
| 3, 6 | row, feature on | `priority` | `turn/settings/update` `ultrafast` → `applied` | thread update `priority` / `ultrafast` | `priority` | none | `priority` / none |

What the probe shows:

1. `thread/settings/update` changes the tier of the thread's **next turn** on
   the same process, with no restart and no feature flag (runs 1 and 9). Sent
   during a turn, it **does not reach that turn** (runs 8 and 9, request 2).
2. `turn/settings/update` does reach the running turn's next request (runs 4
   and 5). It needs `features.step_model_switching=true` when the app-server
   starts, and that feature is "under development". A host started without it
   refuses the call (run 1).
3. The app-server dropped tiers without saying so. It dropped `priority` for
   a model without catalog metadata (run 1). It never put `ultrafast` on the
   wire for this API-key style provider (runs 3, 4, 6), even when
   `thread/settings/updated` reported `serviceTier: "ultrafast"` (run 4).
   Whether `ultrafast` reaches the wire under ChatGPT sign-in was **not
   observed** in this stage. Account A's rollouts recording `ultrafast` (§1.3)
   suggest it does.

The probe's scripts stayed in the stage's scratch directory. The build lane
recreates the same cases as a credential-free fixture test (§3).

### 1.6 What a live switch costs today

The pipeline records' runtime-switch history (`runtimeSwitches`) was read
from a `VACUUM INTO` copy of the state database made in scratch. It holds 39
records across 33 pipelines, from 2026-10-10 22:36Z to 2026-10-15 06:29Z:

| when | what | outcome |
|---|---|---|
| 10-10 22:36:44–52 | 7 tier-only switches (`priority` → `ultrafast`), same account and model, requested within 8 s | none committed; all superseded when their pipelines closed about 27 min later |
| 10-13 02:17 | 3 account moves | stranded; documented in `docs/perf/runtime-switch-stranding.md` |
| 10-13 06:02:34–39 | 3 same-account model changes within 5 s | all committed, in 9, 19 and 39 s |
| 10-15 05:07 | 2 switches 12 s apart | committed, in 17 and 21 s |
| 10-15 06:21:37–06:22:21 | 15 switches 2–3 s apart: 9 account moves, 6 same-account model changes | the 6 model changes committed in 153–221 s; of the 9 account moves, 7 rolled back (successor preflight) and 2 were superseded; 6 retries at 06:29 were refused because "another delivery" was in progress |

All 11 committed switches together: median 153 s, max 221 s. These are
observations from different lanes under different load; no controlled
measurement was made. They still point one way: same-account restarts took
9–39 s when three ran together and 153–221 s inside a batch of fifteen, and
no account move in that batch completed. The seat also reported to the
operator on 2026-10-13 that a live "switch everything" had stalled three
lanes. Fixes #2914 and #2935 (2026-10-15) addressed stranding. The current
executor still restarts the host for every switch (§1.4).

### 1.7 Unknown

- Whether `ultrafast` is sent on the wire under ChatGPT sign-in (§1.5).
- Whether a tier change keeps the provider's prompt cache warm.
- Whether any allowed account holds purchased credits (§1.3).
- How long `thread/settings/update` plus a boundary cut takes inside
  Delegatus. The build measures it (§3).

## 2. Design

### 2.1 The setting

Stored per project in the seat tick settings record, beside `autonomy`:

```ts
interface TurboSetting {
  enabled: boolean;
  startedAt: string;            // episode key: turbo:<startedAt>
  until: string | null;         // null = until turned off
  endedAt: string | null;
  endReason: "expired" | "turned-off" | null;
  updatedAt: string;
  setBy: SeatTickSettingsActor;
  why: string | null;
  /** What the confirmation showed: allowed accounts and the tier each model gets. */
  plan: { accountId: string; tiers: Record<string, "ultrafast" | "priority">; hadCredits: boolean }[];
  /** The separate paid-credit approval (§2.2). Off unless the operator ticked it. */
  credits: {
    approved: boolean;
    accounts: string[];         // the accounts the dialog named as paying
    approvedAt: string | null;
    withdrawnAt: string | null; withdrawnBy: SeatTickSettingsActor | null; withdrawnWhy: string | null;
  };
  /** One row per conversation Turbo touched; at most 200, newest kept. */
  switches: TurboSwitch[];
  noticeOn?: { key: string; deliveredAt?: string };
  noticeOff?: { key: string; deliveredAt?: string };
}
interface TurboSwitch {
  conversationId: string;
  stage?: { pipelineId: string; stageId: string; attempt: number };
  accountId: string; model: string;
  from: string | null;          // tier before Turbo, restored on off
  to: "ultrafast" | "priority";
  state: "queued" | "applying" | "armed" | "switched" | "skipped" | "failed" | "reverted";
  reason?: string; at: string;
}
```

- **Authority** copies `changeAutonomy`. Only the operator (gateway actor)
  enables or extends Turbo, and only the operator approves paid credits; the
  seat may withdraw that approval, with a `why`, and never give it. The project's seat may shorten it or turn it off,
  with a `why`. Workers and other projects are refused. Expiry is evaluated on
  every read, so a stopped Viewer cannot keep a past deadline alive.
- **Durations:** 1, 2, 4 or 8 hours, or "until turned off". Default 2 h
  (question 1). With paid credits approved, "until turned off" is not offered
  and an extension asks for the approval again (question 9). Turbo needs no seat wakes: the switch is server-side, and the
  seat notice is a message, which wakes the seat by itself.
- **History:** the last 5 ended episodes are kept for Details.
- **API:** `seat_tick_settings` and the panel's settings route gain
  `turbo: { enabled, hours?, credits?, why? }`. `credits: true` is refused
  unless the request also enables or extends Turbo from the operator. A read
  carries `turbo.preview` for the dialog: allowed accounts, the tier each
  would get, current weekly usage, each account's paid balance, and the
  number of live Codex conversations that would switch. It also
  carries `turbo.progress` while a sweep runs.

### 2.2 Allowed accounts and the tier each gets

- **Allowed** means the project's Codex binding (`account_project_binding`):
  the bound accounts when the engine is restricted, every Codex account when
  it is not. An account whose engine is disconnected or signed out is shown
  as unavailable. An account the credit guard has stopped gets nothing.
- **Tier:** `fastestTier(account, model)` is `ultrafast` if that account's
  catalog lists it for the model, otherwise `priority` if listed, otherwise
  nothing (the conversation is skipped with the reason). It is a small export
  beside `codexModelServiceTiers`, which reads only `service_tiers[].id`.
- **Order** for "already fast enough": `flex` < `default` < `priority` <
  `ultrafast`. Turbo only raises a tier and leaves unknown ids alone.
- **Credit rule (R9).** No tier is paid by itself: OpenAI's pages say Fast
  and Ultrafast draw on included usage first, and on Pro \$500 Ultrafast
  turns to credits "after that allowance runs out" (§1.2). Credits are spent
  only by an account that holds them (`PaidCredits.hasCredits` or
  `unlimited`; an account whose reading is missing or stale counts as holding
  them). So:

  | approval | account holds credits | what Turbo does on it |
  |---|---|---|
  | off (default) | no | fastest tier until the plan's limit; it cannot spend credits |
  | off (default) | yes | fastest tier up to 90 % of the session or weekly window, then its Turbo conversations return to their previous tier from their next turn and it gets no new Turbo tier until the window resets |
  | on | no | as without approval: nothing to pay with |
  | on | yes, and named in the dialog | fastest tier, and after the included usage it keeps that tier and pays from its balance at the vendor's credit rate (Fast 2x, Ultrafast 6x Standard, §1.2), until the episode ends or the approval is withdrawn |

  The 90 % margin exists because at 8x the usage rate one long turn can cross
  the existing guard's last 1 %. With the approval, the credit guard
  (`creditGuard.ts`) stops blocking the named accounts **for this project's
  conversations only** while the episode lasts. Other projects on the same
  account (account B serves two) still stop at 99 %. An account that gains
  credits after the dialog is not covered: the approval names accounts, and
  only those pay.
- **Turbo never moves a conversation to another account** (question 3). It
  changes only the speed on the account the work already runs on. Moving
  work to account A for `ultrafast` would take the account-migration path,
  where none of the 9 account moves in the 10-15 batch completed (§1.6). It
  would also put all Sol and Astra work on one account at 8x the usage rate.

### 2.3 Confirmation dialog

The dialog opens when the operator turns Turbo on. Turning it off needs no
confirmation. Text is Ukrainian in `uk.ts`, with English in `en.ts`:

- Title «Увімкнути турбо?»
- «Агенти Codex цього проєкту працюватимуть на найшвидшій швидкості, яку дає
  їхній акаунт. Ліміти витрачатимуться в кілька разів швидше.»
- **Зараз** (the counts here are an example): «Перейдуть на нову швидкість:
  7 розмов Codex (3 етапи ліній, 4 агенти). Ті, що працюють, завершать
  поточний крок, зупиняться й одразу продовжать швидше.»
- **Далі:** «Які наступні етапи ліній пришвидшити, вирішить оркестратор.»
- **Дозволені акаунти Codex** (one row each): label, plan, the tier in the
  catalog's own words («Ultrafast для GPT-6.1 Sol і GPT-6 Astra, Fast для
  інших»), this week's usage and its reset («тиждень 36 % · скидання 27.10»),
  and what the credit approval means for it as the checkbox stands: «Без
  кредитів: турбо лише до 90 % ліміту», «З кредитами: після ліміту платить
  кредитами з балансу» or «Кредитів немає». An account bound to other
  projects too says «Його також використовують ще 2 проєкти».
- **Платні кредити**, the separate approval (R9), in its own box in the
  warning colour, apart from the buttons: an unticked checkbox «Дозволити
  платні кредити»; «Це платно. Коли включений ліміт скінчиться, турбо
  продовжить за кредити з балансу акаунта, до кінця турбо. Витрачатимуть
  кредити:» and one line per account that holds credits, with the tier it
  would pay for and its balance («Акаунт A · Ultrafast і Fast · баланс 412»);
  then «Без позначки турбо не витрачає жодного кредиту. Інші проєкти на цих
  акаунтах кредитів не отримують.» Ticked, the box turns to the danger colour.
  The main button never ticks it. When no allowed account holds credits, the
  box shows only «Жоден дозволений акаунт не має кредитів» and no checkbox.
- «Claude не змінюється: швидкий режим Claude оплачується окремо, з usage
  credits.»
- «Тривалість»: 1 год / 2 год / 4 год / 8 год / До вимкнення.
- Buttons «Скасувати» (initial focus) and «Увімкнути турбо».
- Layout: on desktop two columns, what changes and the accounts on the left,
  the credit box, the Claude line and the duration on the right, with the
  title and buttons pinned; it fits a 1000×700 window whole. On a phone it is
  one column in a bottom sheet over the seat tick sheet, with the buttons
  pinned below the scrolling body.
- Modal: the background is inert and Escape cancels. Cancelling also clears
  the credit checkbox, so the next opening starts unticked.
- **Disabled control**, with the reason as its caption, when no allowed
  account offers a faster tier («Дозволені акаунти Codex не мають швидших
  рівнів») or no Codex account is allowed or connected.

The dialog shows only data Delegatus holds: catalog names and descriptions,
usage, binding. It hard-codes no vendor multiplier (deferred).

While Turbo is on, the caption under the control names the outcome first:
«**Турбо без кредитів:** лише включені ліміти акаунтів.» or «**Турбо з
кредитами:** після ліміту акаунти A і B платять кредитами.» (the head in the
danger colour), then «Вимкнути можна будь-коли, розмови повернуть попередню
швидкість із наступного ходу.» The dock chip's accessible value adds «без
кредитів» or «з кредитами».

After the operator confirms, the control shows the on state at once and the
save runs in the background. A failed save rolls the control back to off and
shows the error in place. Turning off is immediate the same way.

### 2.4 The mark in the seat's prompt (R3)

While Turbo is on, every wake carries a Turbo overlay built from the stored
setting, the way the autonomy overlay is. The operator's instruction lines
and the monitor note are never written to: they have authorship and a
500-character limit, and an overlay disappears by itself when Turbo ends.

- The first wake of an episode (and the first after a change or a seat
  rotation) gets the full text. Drafted and measured with `<until>` as
  written, 534 characters without the credit approval: "Turbo on until
  <until> (operator). Allowed Codex accounts may spend included limits
  faster: each runs its fastest catalog tier (account A: ultrafast on
  gpt-6.1-sol/gpt-6-astra, priority otherwise; accounts B, C: priority). Paid
  credits: not approved; Delegatus ends Turbo on a credit-holding account at
  90 %. Delegatus switches live Codex conversations itself. You decide
  upcoming Codex stages and new Codex launches: set serviceTier
  (override-stage, no applyNow; spawn/create). Accounts, bindings, worker
  limits and Claude unchanged." With the approval, the credit sentence reads
  "Paid credits: approved for accounts A, B on this project until <until>."
  (520 characters in all). In the product the account labels are the real
  ones; this document uses A/B/C.
- Later wakes get a pointer, measured at 133 characters: "Turbo on until
  <until>, no paid credits; fastest tier per allowed Codex account;
  seat_tick_settings turbo has the table and progress." With the approval,
  "paid credits approved (A, B)" replaces "no paid credits" (146).
- **Budget.** The 4,000-character wake, with today's 3,001–3,150 characters
  under a full autonomy overlay (§1.4), has room for the 534. The overlay
  reserves its space ahead of agenda truncation, as autonomy's does. The
  build's report tests compose a wake with both full overlays and a full
  agenda and assert it stays within 4,000 characters, with agenda items cut
  first.
- Under Full autonomy the overlay is the permission that lifts "spend" for
  service tiers on allowed accounts. Account moves, bindings and worker
  limits stay forbidden.

### 2.5 The message to the seat (R4)

When Turbo turns on, the server posts one notice through the
project-addressed channel (`/api/orchestrator/message`, current seat at
delivery). Its idempotency key is `turbo:<startedAt>:on`. It is agent-facing,
in English, and carries the same facts as the full overlay, the credit
approval included, plus the conversation count and "progress: seat_tick_settings → turbo". On off or
expiry a second notice (`…:off`) says Turbo ended and that Delegatus is
returning the conversations it switched. It also asks the seat to put back
any upcoming stages it sped up for Turbo, as listed in its own decisions.
Delivery status is stored on the setting (`noticeOn`, `noticeOff`). The
notice text is redacted like any seat message.

### 2.6 Live switch of running Codex conversations (R6)

**Scope.** Every live, hosted Codex conversation of this project: the
running attempts of pipeline stages, spawned workers and reviewers, and the
seat if it runs on Codex. The candidates are read once per episode change
(on and off), from the registry's live structured-host entries filtered by
project and engine before any record is decoded. They are never read per
tick.

**What happens to each conversation:**

| state of the conversation | action |
|---|---|
| idle (no turn running) | `thread/settings/update` only. Its next turn runs on the new tier. Nothing is cut. |
| turn running, the model generating | set the thread tier, cut the turn at once (`turn/interrupt`), send the continuation. The partial output of that one request is lost. |
| turn running, a command, patch or MCP tool call in progress | set the thread tier and **arm** the cut: the host cuts right after that tool item completes, before the next inference. A tier only affects inference, so waiting costs no speed, and a running test or build is never killed. If the turn ends first, nothing is cut. |
| waiting for an approval or user input, or in a provider usage wait | thread tier only. That turn finishes at its old tier. |
| the seat's own conversation | thread tier only, never cut |
| compaction in flight | waits behind it (the delivery queue already holds reconfigures behind compaction) |
| another runtime switch open on the attempt | skipped, with the reason |
| legacy tmux Codex (`paneId`) | skipped («старий термінальний запуск»): its tier is a launch flag |
| account lacks a faster tier for the model | skipped, with the reason |

**Continuation text** (system-authored, one line): "Delegatus changed this
conversation's speed (Turbo). Continue the task from where you stopped." For
a stage it is the `applyNow` continuation, which already has a delivery key.

**Mechanism.**

1. *Host:* the structured Codex host (`codexAppServerHost.ts`) gains one
   control, `settings`, which takes `{ serviceTier, cut: "now" | "boundary" |
   "none" }`. It re-checks the tier against its live `model/list` catalog
   (`assertCatalogOffersTier`) and sends `thread/settings/update`. It records
   the `threadSettings.serviceTier` that `thread/settings/updated` echoes as
   the applied tier. With `boundary` it watches `item/started` and
   `item/completed` (handled at `:4351`) and sends the existing `turn/interrupt`
   (`:2437`) once no tool item is in progress. It writes
   `launchProfile.serviceTier`, so a later restart or resume keeps the tier.
2. *Pipeline stage:* `override-stage` `applyNow` stays the entry point.
   Turbo issues it for each running stage on the operator's authority, with
   `expectedAttempt` and `expectedConversationId` guards, and the graph edit
   is recorded as Turbo's, with the episode key. When only the tier
   changes (same engine, model, effort and account), the switch record gets a
   new `mode: "in-place"` beside `fork` and `handoff`. The executor uses the
   host `settings` control and skips release and recovery. The record keeps
   its phases, fences and continuation key. The stage definition gets the tier
   as `applyNow` already writes it. Turbo records the old value so that off
   can restore it.
3. *Spawned conversation:* the conversation reconfigure
   (`src/lib/agent/reconfigure.ts`) gains an optional explicit `serviceTier`.
   A tier-only reconfigure takes the same in-place path and, when it cut a
   turn, queues the continuation through the delivery queue the way launcher
   notices travel.
4. *Fallback:* when the host refuses `settings` (an unpinned CLI, a protocol
   error, a catalog that no longer lists the tier), the item is marked
   `failed` with the reason and is **not** retried through the restart path
   automatically (§1.6). It is listed in Details with «Повторити», which
   sends that one conversation through the existing `applyNow` or
   reconfigure.

The in-turn update (`turn/settings/update`, no cut at all) is deferred. It
needs every app-server started with a feature Codex calls "under
development" (§1.5). When that feature becomes stable, the host can try it
first and fall back to the boundary cut.

### 2.7 No lag: the switch queue (R7)

- **One durable work list per episode**: the `switches` rows. The settings
  write stores the setting and the `queued` rows in one transaction and
  answers right away. A Viewer restart picks up the `queued` and `applying`
  rows again.
- **Runs off the request path and off both loops.** A background task in the
  Viewer drains the list. Every step is awaited, state writes use the async
  state-lock admission, and nothing waits synchronously on the Viewer or the
  runtime host. The task registers with the loop monitor as `turbo.sweep`,
  with phases `read`, `apply` and `settle`, so a long gap names it.
- **Bounds:** at most **3** switches in flight per machine, at least **2 s**
  between starts, and 120 s per item to reach `switched` or `armed`, else
  `failed` "timed out". An `armed` item frees its slot: the host holds the
  cut. These bounds come from §1.6: same-account restarts took 9–39 s three
  at a time and 153–221 s in a batch of fifteen. The build measures
  the in-place path with the same fixture before and after, and changes the
  numbers only with that measurement.
- **Order:** idle conversations first (one call each, nothing cut), then
  running turns.
- **Progress** for the panel: `{ total, switched, armed, skipped, failed }`,
  read with the settings, which the panel already re-reads while open.

### 2.8 Upcoming stages and new launches (R8)

The seat decides, with tools it already has. The overlay and the notice say
how: `pipeline_action override-stage` with `serviceTier` and no `applyNow`
for the next stages it judges worth speeding up, and `serviceTier` on new
`spawn_agent` and `create_pipeline` stages while Turbo is on. It records each
choice as it records any decision, so the off notice can point back to them.
Delegatus adds no launch-time default (question 4).

### 2.9 Turbo off and expiry

- **Off** comes from the operator's toggle, the seat (with its reason) or the
  expiry. For every row in state `switched` or `armed` whose conversation is
  still live and still on the tier Turbo set, the queue sends `settings
  { serviceTier: from, cut: "none" }` (a `null` `from` clears the tier, as
  the schema allows). The conversation returns to its previous tier from its
  next turn, and its current turn finishes fast (question 2). An `armed` cut
  that has not happened is cancelled.
- Stage definitions Turbo changed get `from` back through `override-stage`
  (no `applyNow`), guarded by the stage digest. A stage the seat changed
  again meanwhile keeps the seat's value.
- The credit approval ends with the episode: the guard blocks the named
  accounts again from that moment. A withdrawn approval (operator or seat)
  ends it the same way while Turbo stays on, and the accounts fall back to the
  no-credit row of §2.2.
- The overlay stops on the next wake, the `…:off` notice is sent, and the
  episode moves to history.

### 2.10 Interactions

- **Full autonomy:** the two are independent. Each has its own switch,
  status line and overlay. Turbo grants only the tier permission (§2.4).
- **Credit guard:** unchanged at 99 % for everything except the accounts a
  credit approval names, and for those only for this project's conversations
  during the episode (§2.2). Without an approval, Turbo adds its own 90 %
  margin on credit-holding accounts, below the guard.
- **Role-default and explicit tiers:** Turbo raises them while it is on and
  restores `from` afterwards. `fast` and `serviceTier` validation is
  unchanged.
- **Account migration and rate-limit switching:** unchanged. A conversation
  that migrates during Turbo keeps its `launchProfile.serviceTier`. The
  existing host-start check refuses a tier the target lacks, and the
  migration says so.
- **Other projects:** Turbo is per project. Account B also serves two other
  projects, and the dialog says so (§2.3). A credit approval on this project
  never lets another project's work spend credits.

### 2.11 Claude

Claude conversations are not touched. Turbo writes no `fastMode`. The
dialog says why in one line (§2.3).

### 2.12 What Turbo never does

It never changes bindings, accounts, worker limits or role mappings, and it
never spends a paid credit without the separate approval. It
never writes any `config.toml`, never moves a conversation to another
account, never kills a running command, never cuts the seat's turn, and
never sends a switch through the restart path without a person asking.

## 3. Build notes: files, checks, evidence, risk

| area | files (current main) |
|---|---|
| setting, authority, overlay | `src/lib/monitor/turbo.ts` (new, beside `autonomy.ts`), `seatTickSettings.ts`, `report.ts`, `seatTickSettingsAnswer.ts`, the `seat_tick_settings` schema in `src/lib/mcp/server.ts` |
| tier choice | `src/lib/accounts/codexServiceTiers.ts` (`fastestTier`) |
| host control | `src/lib/runtime/codexAppServerHost.ts`, `src/lib/runtime/contracts.ts`, `structuredDeliveryQueue.ts`, `structuredReconfigure.ts` |
| stage switch | `src/lib/pipelines/runtimeSwitch.ts`, `engine.ts` (`mode: "in-place"`) |
| conversation reconfigure | `src/lib/agent/reconfigure.ts` and its route handler |
| queue | a small module beside `turbo.ts`; loop-monitor label `turbo.sweep` |
| seat notice | `/api/orchestrator/message` |
| panel | `src/components/orchestrator/SeatTickBody.tsx`, `SeatTickSwitch.tsx` (chip mark), `src/lib/i18n/uk.ts`, `en.ts` |

Tests, each file run by path under an isolated HOME, XDG_CONFIG_HOME,
TMPDIR and `LLV_STATE_DIR`, with the control URL on a closed port:

- `turbo.test.ts`: the operator enables and extends; the seat only shortens or
  turns off, with `why`; others refused; expiry on read; history bounded.
- `report.test.ts`: full overlay and pointer; a composed wake with both full
  overlays stays within 4,000 characters.
- `codexServiceTiers.test.ts`: `fastestTier` for the A/B/C catalog shapes.
- credit rule tests: without approval a credit-holding account stops being
  raised at 90 % and its conversations are queued back; an account with a
  missing or stale credit reading counts as holding credits; with approval the
  guard admits only the named accounts and only this project's conversations,
  another project on the same account still stops at 99 %; the approval ends
  with the episode and on withdrawal; `credits: true` from the seat, or
  without an enable or extend, is refused; "until turned off" is refused with
  credits.
- `codexAppServerHost.test.ts`, using the fixture app-server:
  `thread/settings/update` is sent with the tier; `boundary` waits for an
  in-progress `commandExecution` item to complete, then interrupts; `none`
  never interrupts; a tier missing from the live catalog is refused before
  any call; the echoed tier is recorded.
- pipeline engine and `runtimeSwitch` tests: a tier-only `applyNow` picks
  `in-place`, commits, and keeps its continuation key; any other change keeps
  `fork` or `handoff`.
- queue tests: never more than 3 in flight, 2 s spacing, the 120 s deadline,
  resume after restart from stored rows, every skip class in §2.6, revert on
  off.
- `SeatTickBody` DOM test: dialog content, the credit checkbox unticked on
  every opening and untouched by the confirm button, the paying accounts
  listed, the on caption's «без кредитів» / «з кредитами», optimistic on with
  rollback, immediate off, the disabled reason.
- **Rendered evidence** through the existing kanban board driver
  (`src/components/kanban/kanbanBoard.browser.test.tsx`), as the
  full-autonomy case did: board header popover and `OrchestratorDock`
  (440 and 360 px) at 1440 px, the phone at 390 px, light and dark, en and
  uk, in the states off, dialog, switching, on, ending soon and disabled, with
  the credit approval off and on. No
  new driver.
- The probe in §1.5 becomes a credential-free fixture case in the host test.
  The fixture checks the requests the app-server sends and needs no network.

**Risk.** The change alters live-host behaviour: it interrupts turns and adds
a control to the structured Codex host. It gets three review rounds, the
same as the runtime host. Open PR #2926 also edits
`codexAppServerHost.ts`; the build rebases on whichever merges first. No Bun
pin and no `src/runtime-host/**` change is planned, so the runtime-host
rehearsal is not triggered. If the build touches either, it runs the
rehearsal.

## 4. Validation against the requirement

| | requirement | where it is met |
|---|---|---|
| R1 | playful Turbo button with an icon, next to Full autonomy | §6 (three concepts for the prototype) |
| R2 | confirmation | §2.3 |
| R3 | mark in the seat tick prompt | §2.4 (wake overlay) |
| R4 | message to the orchestrator: limits may be spent faster | §2.5 |
| R5 | Codex ultrafast where offered, else priority; Claude checked | §2.2, §1.1 → Codex only |
| R6 | running work stops, switches, resumes automatically | §2.6 |
| R7 | no lag | §2.7, and no process restarts (§1.5, §1.6) |
| R8 | the orchestrator picks the next stages worth switching | §2.8 |
| R9 | separate approval for paid credits, naming the paying accounts | §2.2 (credit rule), §2.3 (the box), question 9 |
| pinned | off behaviour, expiry, allowed accounts | §2.9, §2.1, §2.2 |

## 5. Deferred — not currently justified

- **Claude fast mode in Turbo.** It draws on usage credits even while plan
  usage remains, and turning it on mid-conversation also pays the whole
  context at the fast uncached price (§1.1).
- **In-turn switching with no cut** (`turn/settings/update`). It depends on
  `step_model_switching`, which is "under development" and must be on when
  each app-server starts (§1.5).
- **Moving conversations to the account that offers `ultrafast`** (§2.2,
  question 3).
- **A Turbo launch default** that gives every new Codex launch the fastest
  tier (question 4).
- **Vendor usage multipliers in the dialog** (2.5x, 8x). Showing them needs a
  table someone keeps current against OpenAI's pages.
- **An expiry "until the limits reset".**
- **Turbo for legacy tmux Codex conversations**, whose tier is fixed at
  launch.
- **An `ultrafast` choice in the conversation's RuntimePill speed menu**
  (already deferred in `codex-service-tier.md`).
- **Machine-wide Turbo** across projects.

## 6. Button concepts for the prototype stage

All three sit in the Full autonomy section of the seat tick body
(`SeatTickBody.tsx`, `SeatTickAutonomy`) in the desktop popover, the dock and
the phone sheet. That section moves up to sit right under the status block,
above the wakes section: the desktop popover is capped at 70vh
(`SeatTickChip.tsx`), and under the wakes the Turbo row and its caption fell
past that edge at 1280×800 and wholly out of view at 1000×700 (question 8).
They use the product's tokens: `--color-codex` (Turbo is
Codex-only), `--color-warning` and `--color-danger` for heat, and `--tick-3`
stays autonomy's violet. Each concept has off, hover/focus, dialog,
switching (progress), on, ending soon (under 10 minutes left) and disabled
states, plus a reduced-motion version. Disabled is greyed out, with its
reason as a caption (§2.3). Every frame prints its variant number
(«Варіант 1», «Варіант 2», «Варіант 3»). Ukrainian copy as in §2.3. When on,
the status block gets one line that states each fact once: «Турбо до 14:00»;
while the sweep runs, «Турбо до 14:00 · перемикаю розмови: 2 з 7»; in the last
10 minutes, «Турбо до 14:00 · лишилось 8 хв». The count disappears once every
conversation is switched. The board's seat tick chip gets a small mark in the
concept's icon.

**Варіант 1 «Форсаж»: a switch with an afterburner.** A wide switch, 64×28
on desktop and 72×44 tap height on the phone, placed on the Full autonomy
row to the right of its toggle behind a 1 px divider. On the phone it moves
to its own row under the autonomy header, with «Турбо» on the left. Off: the
thumb carries a jet-nozzle glyph (three nested rings in inline SVG) on a
neutral track. Hover: the nozzle glows faintly. Confirming: the thumb slides
right, a flame trail grows behind it across the track (a gradient from
`--color-codex` at the core through `--color-warning` to `--color-danger` at
the tip), and three sparks pop from the nozzle once. On: the flame flickers
gently, with the gradient moving in a 1.2 s loop. Ending soon: the flame
shortens in step with the time left. Switching: the sparks repeat once per
switched conversation. Reduced motion: a static gradient and no sparks.
`role="switch"` with `aria-checked`.

**Варіант 2 «Тахометр»: a rev-counter chip.** A chip with a semicircular
gauge icon (ticks, a red sector, a needle) and the label «Турбо», 32 px high
on desktop and 44 px on the phone, to the right of the Full autonomy toggle.
On the phone it moves to its own row. Off: the needle rests at idle. Hover:
the needle revs to mid-scale in `--color-codex` and holds there, with the
first four ticks lit, for as long as the pointer stays. Confirming: the needle sweeps into
the red with an overshoot (600 ms) and the chip shakes twice by 2 px. On: the
chip runs hot, a solid `--color-danger` face with a glow and the label in
capitals, the dial drawn in the face's ink, the needle pinned in the red and
the sector pulsing slowly (2.4 s), so off (an outlined chip) and on differ in
fill and shape at a glance; the time left stays in the status line only. On
the phone the row carries «Турбо» at its left like every other row, and the
chip shows the gauge alone. Switching: tick marks light up one per
switched conversation. Ending soon: the needle drifts back toward the middle
of the scale. Reduced motion: the needle is placed without a sweep and nothing
shakes. A button with `aria-pressed`, and `aria-haspopup="dialog"` while off.

**Варіант 3 «Червона кнопка»: a launch button under a safety cover.** A
28 px round red button (`--color-danger`, 44 px target on the phone) under a
translucent hinged cover with yellow-black hazard stripes
(`--color-warning`), captioned «ТУРБО». It sits to the right of the Full
autonomy toggle; on the phone it gets its own row. The cover is the
confirmation step made visible. Off: the cover is closed. Hover: the cover
lifts about 10° on its hinge. Click: the cover flips open (rotateX, 300 ms)
and the dialog opens; «Скасувати» closes the cover again. Confirming: the
button presses in (scale 0.92 → 1) and lights up with a soft glow, and the
hazard stripes start to crawl (a 3 s marquee). On: the cover stays open and
the button stays lit; pressing the lit button turns Turbo off and closes the
cover. Ending soon: the cover starts to come down, half over the
dome, and the button cools to an unlit red with no glow; the stripes stop.
The dock mark is the button seen from the side, a red half-dome on a striped
base, so it never reads as a status light beside the health dot. Reduced motion: the cover
is shown open or closed without rotation, and the glow and stripes are
static. A button with `aria-pressed`.

The confirmation dialog (§2.3) is shared; each variant puts its own icon in
the dialog title. Its credit box and the on-state caption («Турбо без
кредитів» / «Турбо з кредитами») are the same in all three variants; the
prototype's `credits=off|on` parameter shows either.

## 7. Open questions, with recommended answers

1. **How long should Turbo last by default?** Recommended: **2 hours**, with
   1, 2, 4 and 8 hours and «До вимкнення» on offer. At 8x the usage rate a
   forgotten Turbo is expensive, and the seat can end it early. Alternative:
   8 hours, matching Full autonomy.
2. **What does turning Turbo off do to conversations it sped up?**
   Recommended: **they return to their previous speed from their next turn,
   with nothing cut**, and their current turn finishes fast. Alternatives:
   leave them fast until they finish; or cut them and return them at once,
   which costs a second wave of stops.
3. **Should Turbo move work to the account that offers `ultrafast`?**
   Recommended: **no**. Each conversation stays on its account and takes the
   fastest tier that account offers, so today only account A's Sol and Astra
   work runs `ultrafast`. Alternative: move Sol and Astra work to account A,
   at the cost of account migrations (none of 9 completed in the 2026-10-15
   batch) and one account carrying 8x the usage.
4. **Should new Codex launches during Turbo get the fast tier automatically?**
   Recommended: **no; the orchestrator decides** per stage and per launch with
   the existing `serviceTier`, as asked. Alternative: Delegatus gives every new
   Codex launch the fastest tier while Turbo is on, and the orchestrator opts
   stages out.
5. **Without the credit approval, where should Turbo stop on an account
   that holds credits?** Recommended: **at 90 %** of the session or weekly
   window: Turbo stops raising tiers there and returns that account's Turbo
   conversations to their previous tier from their next turn; the existing
   99 % guard stays. At 8x the usage rate one long turn can cross the last
   1 %, and that 1 % is where credits begin. Alternative: rely on the 99 %
   guard alone.
6. **Is Turbo Codex-only?** Recommended: **yes**. On your plans, Claude
   Code's fast mode draws on usage credits even while plan usage remains
   (Anthropic's fast mode page, read 2026-10-21). Alternative: a separate Claude fast mode
   switch with its own paid-spend confirmation.
7. **How should it be built?** Recommended: **one build lane** covering the
   setting, the dialog, the seat notice and overlay, and the in-place switch
   with the bounded queue, with three review rounds because it changes how
   live Codex hosts are interrupted. Alternative: two slices, with the
   setting, dialog and notice first using today's restart switch at one at a
   time, and the in-place switch second. The first slice would bring back the
   slow, restart-based switching the requirement warns about.
8. **Where in the seat tick panel should Full autonomy and Turbo sit?**
   Recommended: **right under the status block**, above the wakes section, as
   the prototype shows. The desktop popover is capped at 70 % of the window
   height, and below the wakes section the Turbo row falls past that edge on
   a laptop screen. Alternative: keep the section under the wakes, where it
   is today, and Turbo is reached by scrolling the panel.
9. **How far does an approval to spend paid credits reach?** Recommended:
   **the accounts the dialog named, this project's conversations only, this
   episode only, and a finite duration** (1–8 h; «До вимкнення» is not
   offered with credits). Extending Turbo asks again; the seat may withdraw
   the approval and never give it. The amount is bounded by time, because the
   balance Delegatus reads is the provider's own string and no per-account
   spend counter exists yet. Alternatives: a credit cap per account (needs a
   reliable balance reading and a spend counter, deferred); or let the
   approval last as long as Turbo, «До вимкнення» included.

## 8. As built

The build follows sections 2 and 6 with the operator's decisions of
2026-10-21 (variant 1 «Форсаж», Codex only, 2 h default with 1, 2, 4, 8 h and
«until off», paid credits 1–8 h only). Where it differs from the text above:

- **The in-place stage switch is a flag on a fork record.** A tier-only
  `applyNow` on a running Codex stage writes `mode: "fork"` with
  `inPlace: true`, `cut` and `tierCut` (`src/lib/pipelines/types.ts`), and
  never a new `mode` value. A release that predates Turbo still validates the
  pipeline record and finishes an open switch through its own restart path, so
  a rollback cannot make the pipeline registry unreadable.
- **The live switch** is `CodexAppServerHost.setTier`
  (`src/lib/runtime/codexAppServerHost.ts`), reached through
  `src/lib/runtime/tierSwitch.ts`, which also records the tier on the
  conversation's launch profile so a resume keeps it. `applyNowCut: "none"` is
  how Turbo's revert asks a stage for no cut.
- **Spawned conversations** are switched by the sweep on the host directly,
  and a cut one gets one queued continuation under the key
  `turbo:<startedAt>:<conversation>:continue`. An explicit tier on the
  conversation reconfigure and the «Повторити» row in Details are deferred: a
  failed row keeps its reason and is not retried through the restart path.
- **Paid credits are approved only from the operator's own browser.** The
  settings route refuses `credits: true` from anything else, and the
  `seat_tick_settings` tool refuses it outright; the seat may still withdraw an
  approval with a why.
- **Withdrawal and off do not need account discovery.** An unreadable binding
  can prevent a new approval, while the existing approval can still be revoked.
- **The switch queue retains every unfinished row.** The 200-row cap applies
  only to completed history; larger runs keep every previous tier until its
  return finishes, including through settings normalization after restart.
- **A change the seat makes through the tool** reaches the sweep at the
  Viewer's next seat tick pass (at most five minutes); the panel's own changes
  start it at once.
- **The sweep runs only in the release that owns Viewer traffic**, because
  only that release holds the hosts.
- **Restoration keeps its durable work until it succeeds.** A lost switch
  acknowledgement is reconciled against the recorded live tier, and a refused
  return stays pending across restart. The native tier echo is retained when it
  differs from the requested tier. Queued switches check the credit margin
  again after waiting; armed cuts recheck the episode before interrupting.
  The native turn identity is durable before a cut is sent; recovery reads
  the restored turn history to continue an interrupted turn under the same
  delivery key. A return also restores a saved profile when its native host
  has not been reattached yet, so its next resume uses the previous tier.
- **Recurring state work reads and patches one project's row**, using the
  existing bounded store interface and asynchronous lock admission. A missing
  or stale usage reading holds acceleration without paid-credit approval.
  The settings store is constructed on first access, so a fresh controller's
  account-selection imports can finish before it instantiates the store.
- **A Turbo stage switch pins its selection to the conversation's current
  account**, while preserving the stage's account-pin setting. A return can
  clear the native tier even when the role's default has changed meanwhile.
- **Notices** are tried at most 20 times each; an episode with no seat to tell
  is still returned and closed.
- **Known limit:** an older release normalizes the settings row without the
  `turbo` field. Rolling back while Turbo is on drops the episode record, and
  the conversations it sped up keep their tier until they are switched again.
