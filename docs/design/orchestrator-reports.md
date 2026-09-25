# Orchestrator reports: regular, substantive, in the operator's interface language

## Originating requirement

Operator request, 2026-09-25, dictated to the Delegatus project's orchestrator
seat and pinned to this lane (paraphrased in English):

> The orchestrator's bridge reports, shown in the report log beside its chat
> (#2214), are too rare and chaotic, and they come in mixed languages. They
> should be written more often, under clear rules: at which moments to write,
> what to write, and in what shape. Short, but substantive and regular, so I
> can go AFK at any moment and catch up from the log alone. Maybe reports
> should be tied to the seat ticks. Reports, and at least the task text on the
> board, must be written in the language I selected in the interface. First
> analyse how the orchestrators actually behave, then decide.

Addition by the operator, 2026-09-25, relayed to this lane (paraphrased in
English):

> Each orchestrator report should also go to a Telegram group, with the same
> content as in the bridge log. The group is a bot chat already connected and
> allowlisted in Delegatus. A report has a destination list: the bridge
> always, plus an optional Telegram chat the operator picks per project. The
> Telegram copy is formatted for Telegram: short HTML with a bold header,
> sections and PR links. The group is public, so the rules must forbid local
> paths, account names, emails and secrets in reports.

Second addition, 2026-09-25 (paraphrased in English):

> The orchestrator-first setup guide, the three steps shown on a project
> without an orchestrator, gets an optional step to set up the Telegram bot:
> connect a bot token or reuse the connected bot, pick an allowlisted group,
> and that choice becomes the project's Telegram report destination. From then
> on the orchestrator sends its tidy report to that group and the same report
> to the bridge, exactly like today's manual posts: a bold header
> "Delegatus · <orchestrator report, in the interface language>" with the local
> date and time, emoji sections (on prod, merged, in progress, queued, needs a
> decision), links only to public PRs, the interface language, and no private
> information at all, since the group may be public. Skipping the step leaves
> everything working with bridge-only reports. Reuse the existing bot settings
> UI and `telegram_bot_*` services, with no second path, and name the files to
> touch so that one owner holds them.

Third addition, 2026-09-25 (paraphrased in English):

> Every time a deploy settles, the orchestrator's report also lists the board
> task status changes since the previous deploy: tasks moved to Done, Blocked
> or In progress, and new tasks, by their human titles. This goes to the bridge
> and to the Telegram copy, under the no-private-information rule. Put it in
> the report rules.

Correction by the operator, 2026-09-26, replacing the full sectioned Telegram
post (paraphrased in English):

> The group found the long posts spammy. The Telegram copy must be compact:
> line 1 is a status emoji, a bold "Delegatus · <report kind>" and the local
> date and time; line 2 is one short summary line; and every section (on
> prod, task statuses, in progress, next) goes inside one expandable
> blockquote, so it shows collapsed. No link previews: no link tags and no raw
> URLs in the Telegram copy, PR numbers as plain text ("PR 2233"). Send
> silently. The bridge copy is unchanged.

This correction supersedes the second addition's "links only to public PRs":
the Telegram copy now carries no links at all.

Not in scope: a redesign of the report log UI; voice relay changes beyond
keeping it working.

## Decision in one paragraph

The seats already write a good update on almost every wake; they write it into
their chat and skip the report. More mandate prose would not change that, so
the rules are enforced at the points every seat passes through. The seat tick, which already
delivers every settled deploy and lane to the seat, remembers which of those
outcomes the report log has not received yet and lists them in the next wake
until a report lands; an interval wake asks for one status digest when the
board moved and nothing was reported for a whole interval. `bridge_report`
answers with warnings when a body is in the wrong language, too long, or full
of machine ids. The operator's interface language moves from browser-only
storage to one server-side operator setting that the client writes, and that
`get_orchestrator`, the wake, the MCP session instructions and the tool
answers all read. Every manager report also has a destination list: the
bridge log always, plus the Telegram chat the operator picked for the project,
if any. The seat files a report as a summary line and sections (on prod,
merged, in progress, next, needs a decision). The Viewer cuts it to a
1 900-byte budget by whole items and renders the one cut report twice: plain
text for the bridge log and the voice relay, and a compact Telegram post. The
post is a header line with emoji, name, kind and local time, then the summary,
then every section inside one collapsed quote, with no links, sent silently.
A report on a settled deploy also carries the board's task status changes
since the previous successful deploy, from snapshots the tick takes when each
deploy settles. Because the chat can be public, reports must never carry
private information: items with any are dropped from both copies, and a report
with nothing left is refused and stays owed. The setup guide gains an optional
"Reports to Telegram" step built from the existing bot panel; skipping it
leaves bridge-only reports.

## 1. Evidence

### 1.1 Method

All reads were read-only:

- `bridge_reports` from a copy of `state.sqlite` (taken with `sqlite3 .backup`
  from a `mode=ro` connection into a scratch directory). The log keeps the
  newest 500 rows across all projects; they span 2026-07-28 to 2026-09-25.
- Settled outcomes: squash merges on `origin/main` (first-parent `git log`),
  the seat deployment ledger (`seat-deployments.json`, which starts on
  2026-09-23), and stage attempts and lane closures from the `pipelines` and
  `pipelines_archive` rows of the same copy.
- Seat transcripts through `conversation_messages`: the Delegatus seat of
  2026-09-25 (epoch 211, `577257f2`) and of 2026-09-23/24 (`5f471690`).
- Days are Europe/Kyiv calendar days. Report language was classified from the
  prose after removing code spans, quoted UI labels, links, `#refs` and hex ids
  (Latin share ≥ 60 % → en; Cyrillic ≥ 60 % → uk or ru by the letters only one
  of the two alphabets has, `іїєґ` against `ыэъё`).

### 1.2 The Delegatus seat, per day

"Named" means a report body mentions the PR number or the deployed commit.

| Day | Reports (manager) | Language | Lanes settled | Review/critique attempts | Merges to main | …named in a report | Deploys (distinct commits) | …named in a report |
|---|---|---|---|---|---|---|---|---|
| 09-19 | 25 | 19 en, 6 ru | 18 | 107 | 4 | – | – | – |
| 09-20 | 27 | 14 uk, 12 en, 1 ru | 0 | 89 | 40 | – | – | – |
| 09-21 | 17 | 17 en | 0 | 44 | 18 | – | – | – |
| 09-22 | 44 | 40 en, 4 uk | 6 | 26 | 14 | 14 | (ledger starts 09-23) | – |
| 09-23 | 2 | 2 en | 6 | 31 | 28 | 3 | 6 | 0 |
| 09-24 | 6 | 6 en | 15 | 38 | 28 | 6 | 7 | 3 |
| 09-25 | 7 | 3 uk, 3 ru, 1 en | 31 | 66 | 27 | 9 | 14 | 7 |

Eight different seat conversations filed the 09-22..09-25 reports; the seat is
at epoch 212 with 82 predecessors in its lineage. Whatever discipline one seat
learns in chat leaves with it at the next rotation.

Longest silences between two manager reports of this seat since 09-19:

| From | To | Silence |
|---|---|---|
| 09-23 11:50 | 09-24 16:36 | 28.8 h — 30 merges and 11 deploys in between, none reported |
| 09-23 01:06 | 09-23 11:50 | 10.7 h |
| 09-25 00:23 | 09-25 10:12 | 9.8 h — 14 merges |
| 09-25 14:20 | 09-25 18:46 | 4.4 h — #2216 merged and deployed, #2212 merged, three deploy attempts failed on DNS |
| 09-25 19:21 | still silent at 22:40 | 3.3 h+ — release 1.5.0 on prod, #2224 merged and deployed, #2222 merged, the whole GitHub backlog triaged with a decision pending |

09-22 is the opposite failure: 44 reports, up to 880 characters each, carrying 40-character SHAs, deployment UUIDs and idempotency keys.

### 1.3 Other projects

Names are withheld; B–E are the other repositories with a seat.

| Project | Day | Lanes settled | Review/critique attempts | Manager reports |
|---|---|---|---|---|
| B | 09-23 | 1 | 3 | 13 |
| B | 09-24 | 1 | 12 | 18 |
| B | 09-25 | 2 | 4 | 1 (02:04, then nothing) |
| C | 09-24 | 4 | 7 | 10 |
| C | 09-25 | 1 | 1 | 1 |
| D | 09-22 | 1 | 2 | 1 |
| E | 09-19 | 2 | 0 | 9 |

Across all projects from 09-19 to 09-25 (Kyiv days) the manager reports read
133 en, 52 uk, 14 ru, 1 mixed. Project C's seat wrote 11 of 15 reports in Russian on
09-18 and 10 of 10 in Ukrainian on 09-24.

### 1.4 What happened in the gaps

The transcripts show the same pattern in every silence. The seat answers each
wake in its own chat with exactly the kind of update the operator wants in the
log, and does not call `bridge_report`. On 09-25 (seat `577257f2`, 07:11Z to
19:25Z):

- **15 wakes carried a settled outcome** (a deploy that settled, a lane of the
  seat's own that completed or failed). A report followed **5** of them. The
  other ten got chat answers such as "#2216 merged by itself, deploying main
  5064e5ec", "the deploy and the release lane failed on DNS, both retried",
  "release PR #2221 merged, review found nothing", "release 1.5.0 on prod,
  deploy 1c41d361 passed, prod answers 200".
- **5 wakes were interval wakes** while work was open. None produced a report.
- **Decisions stayed in chat.** At 18:11Z the seat asked "tag 1.5.0?" and
  about the RRSI lessons, and at 19:27Z it said "the backlog is triaged, the
  plan is ready, I stopped the tick and I am waiting for your answer". Neither
  became a `question` report, so an operator reading only the log would not
  know anything was waiting on them.

The 09-23/24 seat (`5f471690`) behaves identically in English: release 1.4.0,
the restart-message fix #2131 and two deploys are narrated in chat, and the
report log stays empty for 28.8 hours.

### 1.5 Why reports are rare

- The mandate tells the seat to be rare: "status — brief progress worth
  surfacing; keep these rare" and "no report at all is the correct amount for
  a poll that found nothing" (`src/lib/orchestrator/prompt.ts:317-323`). It
  says "one report per meaningful outcome" and leaves "meaningful" undefined.
- Nothing checks. The wake (`seatTickWakeMessage`,
  `src/lib/monitor/report.ts:236`) never mentions reports, `bridge_report`
  accepts anything, and no surface counts outcomes against reports.
- A chat answer feels like reporting to the model. It was addressed to the
  operator, so the model treats the obligation as met.
- Seats rotate every few hours, and a correction given to one seat ("report
  more") is gone after the handoff.

### 1.6 Why the language is mixed

- The seat writes reports in the language of the conversation. The operator
  dictates in Russian, types in Ukrainian and sometimes English, and the seat
  follows each message. The same seat on 09-25 wrote reports in Russian at
  10:12, 11:07 and 12:37 and in Ukrainian from 14:20 on.
- Handoff notes written by seats for their successors tell the successor to
  reply to the operator in the operator's language (Russian or Ukrainian) and
  to file bridge reports on real outcomes, which carries the chat-language
  rule over to reports.
- Board task text follows the same drift. Of the 113 tasks created for the
  Delegatus project on 09-25 (most by the backlog triage agents), 101 read as
  Russian, 6 as Ukrainian, 1 as English and 5 could not be classified, while
  the interface was Ukrainian.
- Nothing tells an agent what the interface language is, because the server
  does not know it (next section).

### 1.7 Where the interface language lives today

- `src/lib/i18n/index.ts`: `Locale = "en" | "uk"`, stored in the browser's
  `localStorage` under `llv_lang`. When absent, `navigator.language` decides
  (`uk*` → uk, anything else → en). `LanguageToggle` calls `setLocale`, which
  writes `localStorage` and nothing else. The boot shell
  (`src/components/BootShell.tsx:84`) repeats the same detection inline.
- The server holds no copy. `project-settings.json` has `mergeOnReview` and
  `bridgeReports`; `view-presence.json` sessions carry device, viewport and
  focus but no locale; no route receives the toggle.
- The one server-side language guess is `prefersUkrainian(req)` in
  `src/lib/agent/spawnCommand.ts:77`, which reads the request's
  `Accept-Language` header for a pinned spawn's fallback title. That header is
  the browser's language and ignores the toggle.
- Observed on this machine: the state directory holds no locale anywhere; the
  Chrome and Firefox profiles readable here hold no `llv_lang` for the Viewer
  origin; the operator's active desktop client reports `browser: "other"` in
  presence, so its storage is not readable from the host. The operator's
  screenshots and the seat's own words ("in Ukrainian, the language of your
  interface") show the Ukrainian interface. That the choice can be observed
  only by looking at a screenshot is the finding.

### 1.8 Prior art

`search_transcripts` for the report cadence, `bridge_report` language,
`llv_lang`, and the Ukrainian phrase for "interface language", project-scoped
and unscoped, found no earlier attempt at report cadence or at a server-side
locale. Relevant hits: the seat handoff notes quoted in 1.6; the activity-feed
design of lane `9612c532` proposing an optional `subject` field on
`bridge_report` (superseded by #2214's narrow log and unused here); and #1743's
evidence fixture, which writes `llv_lang` directly, a reminder that fixtures
seed the language through storage and will keep working.

### 1.9 Found along the way

- **Stage events stopped reaching the tick on 2026-09-21.** The lifecycle
  journal's last `stage_*` event is at 21:28Z that day; since then it holds
  only `agent_stalled` and `agent_resumed`. The projection that writes stage,
  delivery and deploy events (`refreshLifecycleJournal`,
  `src/lib/lifecycle/projector.ts:393`) runs only inside the `lifecycle_events`
  and `agent_activity` MCP tools, and nothing has called the first one since.
  The seat tick reads the journal (`seatTickSources.ts`) without refreshing
  it, so its `lane-event` reason, the only path by which a review verdict
  inside a running lane reaches a wake, is blind. The build fixes this as part
  of R1 (3.1), because review verdicts are one of the outcomes the requirement
  names.
- **Report ids are global across projects.** `bridgeReportId(key)`
  (`src/lib/bridge/store.ts:129`) hashes the caller's key alone. Two seats that
  file the same key, e.g. a digest for the same minute (the tick checks every
  project in one pass), would lose the second report as a "replay". The key
  grammar below makes such keys common, so the build scopes the id by project.

### 1.10 The Telegram bot today

- The operator's bot is connected and receiving. `telegram_bot_chats` lists one
  allowlisted chat: a public supergroup in which the bot is an admin and may
  post (`postAllowed: true`). Its name is withheld here.
- `telegram_bot_send` goes through the Viewer route `/api/telegram/bot/agent`
  to `TelegramBotService.send` (`src/lib/telegram/bot/service.ts:590`). It
  refuses a chat outside the allowlist before touching Telegram, attributes the
  post to the calling conversation, and is idempotent per caller and
  `clientRequestId`: a repeat returns the first post's message ids, and a
  repeat of a send that never finished answers `send_uncertain` and posts
  nothing. It takes `format: "html"` (Telegram's subset: `b`, `i`, `u`,
  `s`, `code`, `pre`, `a`, `blockquote`) up to 4096 characters, and `silent`.
- Nothing connects reports to it. A seat that wanted a report in the group
  would have to call `telegram_bot_send` itself, with its own formatting and
  nothing checking what it posts.
- The report log already resolves a project's GitHub repository for bare
  `#123` links (`githubRepositoryOfRemote` in `src/lib/bridge/reportLog.ts:73`),
  so the Telegram copy can link PRs the same way.
- The account registry (the `accounts` collection of `state.sqlite`) holds
  every account id and label the Viewer knows, which is the list a scrubber
  needs for "account names".

### 1.11 Today's manual Telegram posts, the guide, and what the data can give

- Since 22:46 on 09-25 the seat has posted its reports to the group by hand
  through `telegram_bot_send`. The first one is the format the operator
  approved: a bold "Delegatus · звіт оркестратора" header, a line with
  "25.09, 22:47 (Київ)", then bold emoji sections "✅ На проді",
  "🔀 Змерджено, піде з наступним деплоєм", "🛠 В роботі", "⏳ Черга",
  "❓ Чекає рішення", each a bullet list, with `#2222`-style links to the
  public repository. A standing memory note tells seats the same rules until
  the product enforces them, and extends "private" to hosts, ports, domains,
  usage limits, people's names, other projects and clients, and quotes of the
  operator.
- The setup guide (`src/components/onboarding/OnboardingDialog.tsx`, ids in
  `src/lib/onboarding/steps.ts`) has three numbered steps, Engines, Project and
  Orchestrator, and four unnumbered ones under "Later, any time" (Agents,
  Phone, Voice, Check). Every step can be skipped; nothing is gated.
- The bot panel lives in `src/components/TelegramBot.tsx`
  (`TelegramBotSection`, with its token form and per-chat allowlist rows) on
  `src/hooks/useTelegramBot.ts` and the operator-only route
  `src/app/api/telegram/bot/route.ts` (`connect`, `refresh`, `chat`,
  `remove`). It is drawn inside the Telegram panel
  (`src/components/TelegramConnect.tsx`).
- A project's catalog name is its local folder name (for this repository,
  the checkout's directory name), so it cannot head a public post. The
  public repository's name can.
- Board tasks keep no status history: a row has `status`, `createdAt` and
  `updatedAt`, and `state_changes` records only row keys and revisions. "Since
  the previous deploy" therefore needs a snapshot taken at each deploy report.
- Repository visibility is known nowhere in the state. GitHub answers it:
  `GET /repos/<owner>/<repo>` without credentials returns 200 with
  `private: false` for a public repository and 404 otherwise, the same request
  `src/lib/projects/forgeRename.ts:125` already makes.

## 2. Options considered

**Where the obligation lives.**

1. *Mandate text only.* Rewrite the Bridge reports section. Cheapest, and the
   evidence says it is not enough: the current text already says "one report
   per meaningful outcome", seats rotate, and bespoke mandates never receive
   the default text.
2. *The Viewer writes the reports itself* from the lifecycle and deploy
   records. Regular by construction, but the bodies would be templated and
   miss the operator-relevant meaning ("prod runs the old version, only the
   new first-run flow is missing"), which is what the operator asked for, and
   the log would duplicate what the board already shows, the thing #2214's
   correction removed.
3. *The tick tracks unreported outcomes and asks in the wake* (chosen). The
   tick already knows every settled deploy and lane it announced, it survives
   rotations, and a wake is the one message every seat acts on. The seat keeps
   writing the words; the Viewer keeps the ledger.
4. *A dedicated `report-owed` wake reason* that wakes the seat only to file a
   report. Deferred: it costs a resumed host per ask, and the asks already
   ride on the next wake the tick sends for any other reason.

**How a report reaches Telegram.**

5. *The seat posts it* with `telegram_bot_send` after `bridge_report`.
   Rejected: two calls the seat can split, differently worded copies, the
   chat choice left to the model, and nothing between the model and a public
   group.
6. *The Viewer fans the stored report out* (chosen). One call, one content,
   the chat taken from the operator's per-project setting, the formatting and
   the scrub done by code, and the bot service's idempotency keyed on the
   report id, so a replay never posts twice.

**Who lists the task changes on a deploy report.**

7. *The seat* reads the board and writes the list. Rejected: no record says
   what changed since the last deploy, so the seat would guess, and retyping
   dozens of titles is where errors and cost go.
8. *The Viewer* keeps a status snapshot per project, taken when a deploy
   report is filed, and renders the difference into that report (chosen). The
   seat only says which deploy the report is about.

**Where the report's format lives.**

9. *In the mandate*, as today's manual posts do. Rejected: the format is
   exact (header, time, emoji, links), and prose drifts per seat and per
   rotation.
10. *In code*: the seat passes a summary and sections of short items, and the
    Viewer renders the header, the time, the emoji and the task list, and
    applies the size budget (chosen).

**Where the language comes from.** See section 4.

## 3. Rules

### 3.1 Triggers

| # | When | Class | Enforced by |
|---|---|---|---|
| R1 | Every settled outcome, each once: a deploy that succeeded or failed, a lane that completed, failed or parked (a merge lands as its lane completing), a review verdict. One report may cover several outcomes if it names their keys. | `completed`, `failed`, `review_verdict` | The tick keeps each outcome owed, under its own key, until a report with that key or covering it is in the log (§5.1) |
| R2 | The moment the seat needs the operator: a decision, an approval, an access it lacks. | `blocked`, `question` | The tick owes an ask for each reply-suggestion set with no question report newer than it (§5.1); `seat_tick_settings` asks for it when the tick is switched off (§5.4); the attention queue then holds it (#1168) |
| R3 | A status digest when the wake says one is due: an interval wake, the board moved since the last report, and no manager report for at least one wake interval. | `status` | The tick's digest line (§5.1) |
| R4 | The outcome that settles the last open lane: the report says nothing is running. | (part of R1) | The tick's owed line says so (§5.1) |
| R5 | File the report even when the operator is in the chat and got the same news there. The chat is not the log. | – | Mandate (§5.7) |
| R6 | A report on a settled deploy lists the board's task status changes since the previous successful deploy. | (part of R1) | The Viewer adds the list itself (§3.8, §5.2) |

The operator's AFK case is covered by R1 and R3 together: each outcome is
asked for in the turn of the wake that announced it and in every later wake
until it is in the log, and anything else that moved reaches the log within
one wake interval.

### 3.2 Shape: summary and sections

A report is the sectioned report the operator approved in the group (§1.11),
reduced to what the operator asked for on 26.09: one header line, one summary
line, then the sections. The seat passes a summary and short items in fixed
sections; the Viewer renders the header, the date, the emoji and the headings,
so the format cannot drift.

**One model, two renderings.** The renderer builds one cut report, meaning a
header, a summary and the sections after every cut of this section, and renders
it twice: plain text for the bridge log and the voice relay, and compact
Telegram HTML for the group (§5.5). Both carry the same header, summary and
items in the same order. They differ only in form: the Telegram copy puts the
sections in a collapsed quote and writes `#2233` as "PR 2233" with no links.

**Header**, rendered by the Viewer: the class emoji, then `{name} · {kind}`,
then the local date and time in the operator's time zone, formatted by `Intl`
with the short zone name ("25.09, 21:45 GMT+3").

| Class | Emoji | Kind (uk / en) |
|---|---|---|
| `completed` | ✅ | завершено / completed |
| `failed` | ❌ | помилка / failed |
| `blocked` | ⛔ | заблоковано / blocked |
| `question` | ❓ | питання / question |
| `review_verdict` | 🔍 | вердикт ревʼю / review verdict |
| `status` | 🕒 | статус / status |

A deploy report (§3.8) uses "деплой" / "deploy" as its kind, with its class's
emoji. `{name}` is resolved as in §5.6.

**Summary**: one plain line of at most 120 characters, from the new `summary`
argument. On `blocked` and `question` it names the ask, so the ask is visible
while the Telegram quote is collapsed. Without a `summary`, the first item of
the first non-empty section, cut to 120 characters at a word boundary, is used.

**Sections**, always in this order in both copies. Empty sections are left out.

| Section | Emoji | uk heading | en heading | Holds | Items at most |
|---|---|---|---|---|---|
| `prod` | ✅ | На проді | On prod | what reached production | 6 |
| `tasks` | 📋 | Задачі з попереднього деплою | Tasks since the previous deploy | written by the Viewer only (§3.8) | 6 titles per group |
| `merged` | 🔀 | Змерджено, піде з наступним деплоєм | Merged, goes out with the next deploy | merged, waiting for the next deploy | 6 |
| `inProgress` | 🛠 | В роботі | In progress | what is running, a failure being retried included | 6 |
| `queued` | ⏳ | Далі | Next | what starts next | 4 |
| `decision` | ❓ | Чекає рішення | Needs a decision | what the operator has to answer or do | 3 |

- An item is one or two plain sentences, at most 200 characters, saying what
  is now true and what it means ("реліз 1.5.0 на проді, npm теж 1.5.0"). An
  item over 200 characters is dropped whole, with a warning. Items beyond a
  section's limit are dropped whole and replaced by one "і ще N" / "and N more"
  line.
- An outcome report carries only the sections its outcomes touch, plus what
  follows from them. A `status` digest carries the whole state: everything
  running, next and waiting. `blocked` and `question` always have a `decision`
  item.
- The three-line shape of the first revision maps onto this: its headline
  becomes the summary; its "what changed" line becomes an item in `prod`,
  `merged` or `inProgress`; its "Next" line becomes `inProgress` or `queued`;
  its "Needed from you" line becomes `decision`.
- Work is named by its title and its `#PR`. No card ids, pipeline ids, full
  SHAs, deployment ids, report keys or URLs; an 8-character sha only for a
  deploy.

**Byte budget.** The store cuts any body over `BRIDGE_REPORT_BODY_MAX_BYTES`
(2 048 bytes, `src/lib/bridge/types.ts:60`) mid-character with "…", and
Ukrainian text takes about 2 bytes per character. The renderer therefore owns a
budget of **1 900 bytes of UTF-8 for the plain rendering**, so the store never
cuts. While the plain rendering is over budget, it gives way in this order,
one whole item at a time:

1. Task titles, from the largest group of the `tasks` section, down to none;
   the group then shows only its count ("Нові: 105").
2. Items from the end of `queued`, then `inProgress`, then `merged`, then
   `prod`. Each section keeps its first item until every section before
   `decision` is down to one, and then the rest go in the same order.
3. `decision` and the summary are never cut. Three decision items of 200
   characters, the summary and the header come to at most about 1 600 bytes,
   so they always fit.

Every removal is a whole item, counted in that section's "і ще N" line, so no
item is ever cut mid-text. The Telegram copy is rendered from the same cut
report, so it lists exactly the items the bridge copy lists. Its own bound
(4 096 characters for HTML) is never reached from a 1 900-byte report.

### 3.3 Keys and dedupe

- Outcome keys are given by the tick in the wake (§5.1):
  - `deploy:<sha8>:succeeded`: a successful deploy, one per commit;
  - `deploy:<sha8>:failed:<attempt8>`: a failed deploy, one per attempt, where
    `<attempt8>` is the first 8 hex characters of the attempt's deployment id,
    so a fourth failure of a commit after three earlier ones is owed again. The
    id stays in the key and never in the text;
  - `lane:<pipelineId>:<completed|failed|parked|provisioning-failed>`;
  - `verdict:<pipelineId>:<stageId>:<round>`.
- A pure ask uses `ask:<topic>:<YYYY-MM-DD>`, a digest
  `digest:<YYYY-MM-DDTHH:MM>`. An outcome that is also an ask (a failed deploy
  that needs the operator) files under the outcome's key with class `blocked`.
- `covers` lists the keys of further outcomes one report speaks for. The row
  stores them, and each counts as reported.
- The same key files once; the store makes a replay a no-op. Ids are scoped by
  project (§5.2), so two projects' identical keys give two rows.
- A report refused because nothing was left after scrubbing stores nothing, so
  its key stays unused and stays owed (§5.2).
- A digest does not repeat an outcome that already has its own report.

### 3.4 Quiet periods

- The tick asks for no digest while the board fingerprint equals the one
  recorded for the last report (§5.1). Silence in the log means nothing
  changed since the last entry.
- The `inProgress`, `queued` ("next") and `decision` sections of the latest report are
  what the operator relies on while away, so they have to stay true. When the
  seat stops or pauses its tick, or waits on the operator, the report says so;
  `seat_tick_settings` asks for that report when the tick is switched off
  (§5.4).
- When the last open lane settles, that report says nothing is running.

### 3.5 Language

| Text | Language |
|---|---|
| Bridge reports, both copies | The operator's interface language |
| Board task text (`create_task.text`, `update_task.text`, `refine`), all callers | The operator's interface language |
| Viewer-authored task titles (pinned spawn fallback title) | The operator's interface language |
| Chat replies, `suggest_replies` drafts | The language the operator writes in (unchanged) |
| Task `details`, pipeline specs, prompts to agents | Unchanged (agent-facing) |
| GitHub issues, PRs, commits, docs | English (unchanged) |

Section headings, the header and the date follow the interface language
because the Viewer renders them. Task titles in the `tasks` section appear as
they are stored; the task-text rule is what puts them in the right language.

### 3.6 Destinations

- Every manager report goes to the bridge log, which the report log and the
  voice relay read as they do today.
- It also goes to the project's Telegram chat when the operator set one, in
  the optional setup-guide step (§5.6). With no chat set, or the step
  skipped, reports go to the bridge only and everything else works as before.
- Reports from other sessions (origin `agent`, `gateway`, `unidentified`) go
  to the bridge only.
- While the project's Bridge reports setting is off, nothing is stored and
  nothing is posted.
- A failed Telegram post never loses the report: the bridge row stays, and the
  answer says what happened to the copy.

### 3.7 No private information

A report may be read by anyone in a public group, and the bridge copy is the
same text, so no report carries private information of any kind:

- local paths, host names, ports, domains and URLs of any kind;
- IP addresses, emails, phone numbers;
- account names, ids and labels of any engine, GitHub handles, the OS user
  name;
- usage limits, plan tiers, quotas and prices of the operator's accounts;
- people's names, the operator's included, and names of other projects,
  repositories and clients;
- quotes of the operator, or of anyone in the group;
- secrets and anything shaped like a credential;
- conversation, deployment, card and pipeline ids.

Enforcement is in §5.2 and §5.5: the summary, every item and every task title
pass a scrubber, and an item with a hit is dropped from both copies, with a
warning to the seat naming the class and never the value. A report with
nothing left is refused and its outcome stays owed. Quotes, and people's names
outside the known lists, cannot be detected reliably; the mandate carries that
part.

### 3.8 Task changes on deploy reports

- A report whose key or `covers` names a `deploy:` key is a deploy report. The
  Viewer adds the `tasks` section to it; the seat does not write it.
- **Snapshots are taken when the deploy settles.** The first tick
  check that sees a deploy settled (the controller pass, §5.1) records the
  project's task statuses under that deploy's id, whether or not a report ever
  follows. The snapshot lands at most one check interval (5 minutes) after the
  deploy settled. It is stored in a new `task_status_snapshots` collection of
  `state.sqlite`, one row per deploy (`<project>/<deploymentId>`:
  `{ sha8, state, settledAt, takenAt, statuses: { <taskId>: <status> } }`),
  owned by `src/lib/bridge/taskChanges.ts`. The newest 10 per project are kept,
  about 100 KB each at the size of this project's board.
- **The list for deploy D** is the difference between the snapshot of the last
  successful deploy before D and D's own snapshot, whenever D's report is
  filed:
  - **Готово / Done**: status changed to `done`;
  - **Заблоковано / Blocked**: changed to `blocked`;
  - **В роботі / In progress**: changed to `assigned`;
  - **Нові / New**: absent from the earlier snapshot, whatever their status in
    D's.
  Moves back to `inbox`, deleted tasks and tasks hidden from the board are left
  out.
- A report filed hours late lists what changed up to the deploy, since the
  snapshot was taken then. A successful deploy that never got a report still
  has its snapshot, so the next deploy's list starts from it.
- For a failed deploy, the list runs from the last successful deploy to the
  failed one, headed "(ще не на проді)" / "(not on prod yet)". A later
  successful deploy lists the same changes again, as shipped.
- Titles are the first line of each task's current text, at most 90
  characters. Each passes the scrubber; a title with a hit is left out and
  counted ("1 приховано" / "1 hidden"). A group shows at most 6 titles, then
  "і ще N", and the byte budget (§3.2) may cut it further.
- A deploy that settled before the build, or whose snapshot has aged out, has
  no snapshot to diff from: its report shows no `tasks` section, and the
  answer says so.

## 4. Language: one source of truth

### 4.1 Options

| Option | Verdict |
|---|---|
| A. Browser `localStorage` only (today) | Rejected: the server and every agent are blind to it. |
| B. Carry the locale on the presence heartbeat | Rejected: presence exists only while a view is open, and an AFK operator is exactly the case with no view open; two devices can disagree. |
| C. Per-project setting | Rejected: the toggle is installation-wide, and per-project storage would let two projects disagree with the one interface. |
| D. Infer from the operator's chat language | Rejected: that is today's behaviour and the cause of the mix (1.6). |
| **E. One operator setting on the server, written by the client** | **Chosen.** |

### 4.2 The chosen path

- **Store**: `state/operator-settings.json` via a small module beside
  `src/lib/projects/settings.ts` (same shape: mtime-cached read, atomic write):
  `{ schemaVersion: 1, locale: { value: "en" | "uk", source: "chosen" | "detected", changedAt }, timeZone: { value, changedAt } }`.
  `operatorLocale(): "en" | "uk" | null` reads the language. `operatorTimeZone()`
  reads the IANA zone the client reports from
  `Intl.DateTimeFormat().resolvedOptions().timeZone`, which report headers use
  (§3.2); without one they use the host's zone.
- **Route**: `GET` and `PUT /api/operator/settings` behind the same proxy auth
  as `/api/projects/settings`. A `detected` value never overwrites a `chosen`
  one; the server enforces that.
- **Client** (`src/lib/i18n/index.ts`): `setLocale` from the toggle `PUT`s
  `{ locale, source: "chosen" }`. After hydration the client `GET`s once: a
  server value different from the local one is adopted locally, with no PUT;
  no server value means the client `PUT`s what it shows with
  `source: "detected"`. `localStorage` stays as the boot cache, so the first
  paint has no flash and fixtures that seed `llv_lang` keep working.
- **Readers**:
  - `get_orchestrator` carries `operatorLocale` in compact and full answers.
  - The seat tick puts the language name into its report lines ("in
    Ukrainian"), so a seat on any mandate version learns it.
  - The MCP server `instructions` string (`src/lib/mcp/server.ts:3796`) is
    composed at session start and says that task text and bridge reports are
    written in that language. Every spawned agent sees it before its first
    `refine`.
  - `create_task`, `update_task` and `bridge_report` descriptions say to write
    in the operator's interface language, which `get_orchestrator` names.
  - `spawnCommand.ts` uses `operatorLocale()` in place of
    `prefersUkrainian(req)` for the pinned fallback title, falling back to the
    header only while the setting is unset.

- **While unset**: `operatorLocale()` is null from the deploy until a client
  loads and reports its language, which is today's state (§1.7). Meanwhile the
  renderer uses English headings, kind words and dates, the host's time zone
  stands in for the operator's, the wake lines leave out the language clause,
  and no tool gives a language warning. The first page load ends it.

Consequence: with two devices, the last choice wins on both, and the other
device adopts it on its next load. There is one interface language per
operator, which is what "the language I selected" means.

## 5. Enforcement points

### 5.1 Seat tick

- **State** (`SeatTickProjectState`, `src/lib/monitor/types.ts:949`):
  - `reportsOwed: { key: string; label: string; since: string }[]`: each
    settled outcome a landed wake announced, under the key its report must
    carry, at most 16 entries (the oldest beyond that are dropped with a count
    kept in `reportsOwedDropped`).
  - `reportSeenAt: string | null` and `reportFingerprint: string | null`: the
    newest manager report the tick has observed, and the board fingerprint the
    digest compares against.
  - `checkFingerprint: string | null`: the board fingerprint of the previous
    check.
  - All are project-scoped and survive a rotation: add them to
    `seatTickStateForEpoch` (`src/lib/monitor/seatTickState.ts:315`), so a
    successor inherits what its predecessor left unreported. They also survive
    the tick being switched off, so turning it back on resumes the asks.
- **Input** (`SeatTickCheckInput`), read once per controller pass in
  `seatTickSources.ts`:
  - `lastReportAt`, the `at` of the newest manager row for the project;
  - `reportedIds`, the set of project-scoped ids and `covers` ids of the
    project's manager rows;
  - `bridgeReports`, `operatorLocale` and `openLanes` (the count of the
    project's open lanes after this check);
  - `openAsk`, the seat conversation's current reply-suggestion set
    (`readReplySuggestions`, `src/lib/suggestions/store.ts:347`): its `at`, or
    null when there is none. The operator's next message retires the set
    (`retireReplySuggestionsOnOperatorMessage`, same file), so a set that is
    still there is an ask nobody has answered.
- **Deploy snapshots** (§3.8): in the controller pass
  (`src/lib/monitor/seatTickController.ts`), every settled deploy of the
  project that has no snapshot yet gets one, through
  `recordDeploySnapshot(project, deploy, tasks)` in `taskChanges.ts`. The call
  is idempotent by deployment id and independent of whether a wake is sent or
  lands, so a deferred wake or a missing report cannot move the boundary.
- **Record** (`seatTickWakeCommit`, `src/lib/monitor/seatTick.ts:1696`): a wake
  that lands with a settled outcome appends `{ key, label, since }` for it. The
  key follows §3.3 from the item itself: the deploy's sha and, for a failure,
  its deployment id (the item carries it, `src/lib/monitor/types.ts:263`); the
  lane's id and state; the verdict's pipeline, stage and round. Nothing is
  recorded while bridge reports are off.
- **Discharge** (`decide`, `src/lib/monitor/seatTick.ts:1049`): an owed entry
  is removed when `reportedIds` holds `scopedReportId(project, key)`. Reports
  are matched by key, so a report about one outcome, or an unrelated
  `question`, clears nothing else. A report refused because nothing was left
  after scrubbing stored no row (§5.2), so it clears nothing.
- **Digest memory**, on every check, whatever `reportsOwed` holds: when
  `lastReportAt > reportSeenAt`, set `reportSeenAt = lastReportAt` and
  `reportFingerprint = checkFingerprint`, the fingerprint of the check *before*
  the report was observed. A board change between that check and the report
  therefore still counts as unreported, and costs at most one extra digest; no
  change is absorbed. Then set `checkFingerprint` to this check's fingerprint.
- **Wake text** (`seatTickWakeMessage`, `src/lib/monitor/report.ts:236`), in
  the reserved tail so the length bound never cuts it. `in Ukrainian` stands
  for the operator's language; while `operatorLocale` is null the clause is
  left out (§4.2):
  - `Reports owed, in Ukrainian, before this turn ends: deploy 1c41d361 succeeded (key deploy:1c41d361:succeeded); lane 33efe347 completed (key lane:33efe347:completed). One report may cover several: file it under one key and list the others in covers.`
  - When the owed outcomes settled the last open lane (`openLanes` is 0 and
    one of them is a lane): `Nothing is running now: the report says so.`
  - When `openAsk` is older than 10 minutes and no `question` or `blocked`
    manager report is newer than it:
    `Ask owed: you asked the operator at HH:MM and filed no question report. File one (key ask:<topic>:<YYYY-MM-DD>) with the ask in the decision section.`
    Each suggestion set is judged by its own `at`, so after "suggest, report,
    suggest" the second ask is owed until a report newer than the second set
    lands.
  - When `interval` is among the reasons, bridge reports are on,
    `lastReportAt` is older than the wake interval (or absent) and this
    check's fingerprint differs from `reportFingerprint`:
    `Digest due, in Ukrainian: no report since HH:MM and the board moved. File one status report (key digest:<YYYY-MM-DDTHH:MM>) with the whole state: in progress, next, needs a decision.`
  - No new wake reason: these lines ride wakes the tick sends anyway (option 4
    in section 2 is deferred).
- **Stage events** (§1.9): `seatTickSources.ts` runs the lifecycle projection
  with the pipelines before it pages the journal, so review verdicts and stage
  failures reach `lane-event` again.
- **Contract clause**: `ORCHESTRATOR_SEAT_TICK_CONTRACT`
  (`src/lib/orchestrator/prompt.ts:139`) gains: "If the wake lists reports
  owed, an ask owed or a digest due, file those bridge reports under the keys
  it gives before the turn ends." A seat on an older mandate needs no mandate
  change, because the wake lines say it themselves.

### 5.2 `bridge_report`

In `bridgeReport` (`src/lib/mcp/bindings.ts:2565`) and its schema
(`src/lib/mcp/server.ts:3677`, description at `:3024`):

- **Arguments**: `key`, `class` and `clientRequestId` as today; new
  `summary?: string`,
  `sections: { prod?, merged?, inProgress?, queued?, decision?: string[] }`
  and `covers?: string[]`. `body` stays for older callers: a report with no
  `sections` renders its body as one `inProgress` item per line, under the
  same budget, and the answer warns "Use summary and sections."
- **Render** (new `src/lib/bridge/reportRender.ts`, pure): scrub every item
  and the summary (§5.5); drop items over 200 characters; add the `tasks`
  section for a deploy report (§3.8, `src/lib/bridge/taskChanges.ts`); apply
  the section limits and the byte budget of §3.2, whole items only; and return
  the cut report. `renderPlain(cut)` is stored as the row's `body`;
  `renderTelegram(cut)` (§5.5) is the group's copy. The header name, time zone
  and locale come from §5.6 and §4.2; headings and kind words live in the
  renderer's own small en/uk table (`src/lib/bridge/reportWords.ts`), since the
  UI dictionaries are client modules.
- **The one refusal**: when nothing is left after scrubbing, meaning no summary
  and no item in any seat section, the call is refused with
  `code: "report_empty_after_scrub"` and "Nothing is left after removing
  private information; refile without it." No row is stored and nothing is
  posted, so the key is unused and the tick keeps it owed. This is a refusal
  because an empty report would clear an owed outcome with nothing in the log;
  every other problem is a warning.
- **Id scoping**: the stored id becomes `bridgeReportId(project + "\0" + key)`
  when the project resolves; `covers` is stored as scoped ids. The verbatim
  `key` that decision-class rows keep for the attention queue is unchanged. The
  tick computes the same `scopedReportId`.
- **Warnings** in the answer, `warnings: string[]`, empty when clean:
  - language: `proseLanguage(summary and items)` differs from
    `operatorLocale()` → "This report reads as Russian; the operator's
    interface is Ukrainian." (`src/lib/i18n/proseLanguage.ts`, pure, the
    classification of §1.1; null below 40 letters or on a mixed text, which
    says nothing). Skipped while `operatorLocale()` is null;
  - private information: one warning per class the scrubber found, naming the
    class and the number of items dropped, never the value;
  - shape: an item dropped for length, items dropped by a section limit or the
    byte budget (with counts), a `blocked` or `question` without a `decision`
    item, or machine ids in an item.
- **Destinations** in the answer:
  `destinations: { bridge: { seq }, telegram?: { chat, state, messageIds?, code?, retryable? } }`
  (§5.5).

### 5.3 `create_task` and `update_task`

The same `proseLanguage` check on `text` (and `refine.text`), never on
`details`, adds a warning to the answer. The descriptions say that `text` is
written in the operator's interface language.

### 5.4 Asks and stopping: the tick, `suggest_replies` and `seat_tick_settings`

The 19:27 failure (§1.4) is a seat that asked the operator in chat, switched
its tick off and filed nothing.

- **Asks** are enforced by the tick's `Ask owed` line (§5.1), which judges each
  reply-suggestion set on its own time, so no order of asks and reports lets
  one through. `suggest_replies`, the mandate's marker of an ask, adds one line
  to its answer when the caller is a project's designated seat with bridge
  reports on: "If the operator is away, they learn this ask only from a
  question report." Drafts are stored as before.
- **`seat_tick_settings`**: a call that sets `enabled: false`, or raises the
  wake interval, for a project with bridge reports on answers with
  `reportsOwed` (the tick's owed keys), the open ask if there is one, and:
  "Nothing will ask you for reports while the tick is off. File a report now:
  what you are waiting on (a question or blocked report when it is the
  operator), and the owed outcomes above." The setting is applied as asked;
  the owed list stays in the tick state and comes back in the first wake after
  the tick is turned on.

Both answers are tested at the tool; the ask line is tested at the tick.

### 5.5 Telegram destination

- **Scrubber** (new `src/lib/bridge/publicSafe.ts`, pure): finds, in the
  summary, an item or a task title:
  - local paths (`/…`, `~/…`, `$HOME…`, drive letters), URLs and domains,
    host names (the machine's own, tailnet names, `*.local`), ports (`:NNNN`
    after a host, "port NNNN"), IP addresses, emails, phone numbers, UUIDs and
    `conversation_` ids;
  - usage-limit phrases: a percentage or amount next to limit, quota, window
    or usage, in English, Ukrainian and Russian;
  - names from a deny list read at call time:
    - every account id and label in the account registry, the OS user name,
      the home directory's name, and the display names and handles of people
      the bot has seen in the chat (the `telegram_bot_messages` store), each
      matched as a whole word, case-insensitively, skipping entries under 4
      characters and a short list of generic words (`main`, `default`, `work`,
      `personal`, `team`, `pro`, `max`, `plus`);
    - other projects, matched only in repository form, because a project named
      with an ordinary word would otherwise drop ordinary prose: their
      `owner/repo` and GitHub URL, and their repository or folder name only
      when it contains `-`, `_`, `.` or a digit (`bonavita-odoo-dev`, never
      `tools`).
  An item or title with any hit is dropped whole, as in §3.7. A summary with a
  hit is replaced by the fallback summary of §3.2, drawn from the remaining
  items. Hiding an item by mistake costs less than posting a private one.
- **Telegram HTML** (new `src/lib/bridge/telegramReport.ts`, pure), from the
  same cut report as the bridge copy (§3.2), in the compact form the operator
  asked for on 26.09:
  - line 1: the class emoji, then `<b>{name} · {kind}</b>`, then " · " and the
    date and time;
  - line 2: the summary, as plain text;
  - then every non-empty section, in the order of §3.2, inside one
    `<blockquote expandable>`, which Telegram shows collapsed: each section is
    `{emoji} <b>{heading}</b>` and its `• item` lines, sections separated by a
    blank line.
  - Every item and the summary is HTML-escaped before any tag is added.
  - No links and no URLs, because GitHub link previews were what made the long
    posts spammy: no `<a>` tag is ever emitted, the scrubber has already
    removed URLs and domains, and a number the forge cache knows as one of
    this project's pull requests (`ForgeCacheView`,
    `src/lib/forge/workLinks.ts:92`) is written as "PR 2233" in place of
    `#2233`. Any other `#N` (an issue, or a PR the cache has not seen) stays
    `#N` as plain text; Telegram gives it no preview either. With no link or
    URL in the text, Telegram shows no preview.
  - `<blockquote expandable>` is in the Bot API's HTML formatting list, and
    `TelegramBotService.send` passes HTML through to Telegram with no local tag
    list, so the existing service carries it unchanged.
- **Send**: after the row is appended, when the origin is `manager` and the
  project has a chat, the binding posts through the existing agent route
  (`/api/telegram/bot/agent`, `op: "send"`, `format: "html"`, `silent: true`)
  with the seat's capability headers, so `TelegramBotService.send` checks the
  allowlist, attributes the post to the seat and keeps it idempotent, under
  `clientRequestId: "bridge-report:<reportId>"`. Every report is sent
  silently. The outcome is recorded on the row with a new store function,
  `recordBridgeReportTelegram(id, { chat, state, messageIds?, code?, at })`.
- **Failure and retry**: a retryable code (`rate_limited`, `network_failed`,
  `timed_out`, `telegram_failed`) leaves `state: "failed"`, and calling
  `bridge_report` again with the same key, still a replay for the log, re-sends
  the copy under `bridge-report:<reportId>:r<n>`. `send_uncertain` is never
  re-sent: a second public post is worse than a missing one. A chat removed
  from the allowlist answers `chat_not_allowed` until the operator changes the
  project's setting.
- **Not posted**: reports from other sessions, anything while Bridge reports
  are off, and the synthetic gap notices the relay drain composes.

### 5.6 The setup guide's optional Telegram step

- **Setting**: `project-settings.json` gains
  `reportTelegram: { chat, name, changedAt, changedBy }` beside `mergeOnReview`
  and `bridgeReports`; `chat` is the bot chat's alias and `name` the project's
  name in report headers. `src/lib/projects/settings.ts` stores only boolean
  switches today, so it gains this one entry with its own reader,
  `reportTelegram(project)`. `/api/projects/settings`
  (`src/app/api/projects/settings/route.ts`) accepts
  `{ project, reportTelegram: { chat, name } | null }`, only from the operator
  (`requireOperatorAuthority`, as the bot route does), and refuses a chat that
  `TelegramBotService` does not list with `postAllowed`. There is no MCP write,
  so no agent chooses where a public post goes. `get_orchestrator` carries
  `reportTelegram` (alias and name, or null).
- **Header name**, used by both copies and resolved by
  `reportHeaderName(project)` in `src/lib/projects/settings.ts`:
  `reportTelegram.name` when the operator set one; else the project's GitHub
  repository name capitalised, when it has a GitHub remote; else the project's
  display name from the catalog. A project that skipped the step, like
  projects B–E today, therefore gets its repository or display name in its
  bridge-only reports. The display name can be a local folder name, which is
  acceptable only because such a report never leaves the bridge: choosing a
  Telegram chat requires a name (below).
- **Where**: the guide becomes Engines, Project, **Reports to Telegram
  (optional)**, Orchestrator. The step sits before Orchestrator because Create
  ends the guide on the new seat, and the seat's first report should already
  know its destination. The step's ids go into `src/lib/onboarding/steps.ts`
  as a separate `ONBOARDING_OPTIONAL_STEP_IDS = ["telegram"]`, numbered in the
  guide's order; `firstOpenStep` counts `skipped` as settled for an optional
  step, so a skipped step never reopens the guide on itself. Its marker state
  is stored by `src/lib/onboarding/marker.ts` like any other step.
- **What it shows** (new `src/components/onboarding/TelegramReportsStep.tsx`),
  built from the existing bot panel pieces and state, with no second path to
  the bot:
  - no bot connected: the panel's token form (`TokenForm` in
    `src/components/TelegramBot.tsx`, exported for this) on
    `useTelegramBot` (`src/hooks/useTelegramBot.ts`), which calls the same
    operator-only `connect` action;
  - a bot connected: its name, and the chats `useTelegramBot` lists. Chats
    that accept posts are choices; chats the bot is in but not allowlisted
    show the panel's own `ChatRow` switch, so allowing one is the same one tap
    as in the panel; "Log only, no Telegram" is always a choice;
  - "Name in reports", prefilled with the project's GitHub repository name
    capitalised ("Delegatus") when it has a GitHub remote, else empty and
    required once a chat is chosen, since the folder name is local; it becomes
    `reportTelegram.name`;
  - the rule in one sentence: the group may be public, so reports carry no
    private information, and they are posted silently, with no links;
  - Skip, as prominent as Continue. Skip writes nothing and leaves the step
    `skipped`; reports stay bridge-only.
- **Later changes**: the same step, reopened from the setup guide's menu entry
  (`src/components/onboarding/menuEntries.tsx`) or from the guide's step list.
  The report log and the ⋯ menus are unchanged.
- **Rendered evidence**: new cases in the existing drivers
  (`src/components/kanban/kanbanBoard.browser.test.tsx` and
  `src/components/mobile/issue1671Evidence.browser.test.tsx`) for the step with
  no bot, with a bot and chats, and with a chat chosen, at desktop and 390 px,
  en and uk.

### 5.7 Mandate (v28 → v29)

Replace the Bridge reports section of `ORCHESTRATOR_SYSTEM_PROMPT` and bump
`ORCHESTRATOR_PROMPT_VERSION` with its fingerprint in `prompt.test.ts`. Draft:

```text
## Bridge reports — the second channel (manager -> gateway)
<the existing paragraph on the Bridge reports setting, unchanged>
On: the report log is where the operator catches up after being away, and they can leave at any moment, so it has to hold every outcome without your chat. When the project has a Telegram chat (reportTelegram in get_orchestrator), the Viewer posts the same report there too.
File a report:
- for every settled outcome, under the key the wake gives: a deploy, a lane that completed, failed or parked, a review verdict. One report may cover several; list the other keys in covers.
- the moment you need the operator: question or blocked, with the ask in the decision section.
- as a status digest when a wake says one is due, with the whole state.
- even when you also told the operator in chat. The chat is not the log.
Shape: pass a summary and sections, never a free body. summary: one line, at most 120 characters, saying what is now true, or the ask on blocked and question. Sections: prod (on production), merged (merged and waiting for the next deploy), inProgress, queued (what comes next), decision (what the operator must answer or do; at most 3). Each item is one or two plain sentences, at most 200 characters, saying what is now true and what it means; name work by its title and #PR, a deploy by its 8-character sha; no URLs. The Viewer adds the header, the time, the emoji and, on a deploy report, the task changes since the previous deploy, and cuts whole items when a report is too long.
Quiet: say nothing when nothing changed. Your latest report's inProgress, queued and decision items are what the operator relies on, so keep them true; when you stop the tick, pause or wait on the operator, say so, and when the last lane settles, say that nothing is running.
Language: reports and board task text use the operator's interface language (operatorLocale in get_orchestrator, named in each wake). Chat replies stay in the language the operator writes to you in; GitHub stays English.
Private: a report may be read in a public group. Never write local paths, hosts, ports, domains, URLs, IPs, emails, account names or ids, usage limits or plans, people's names, other projects or clients, quotes of the operator or anyone else, secrets, or card, conversation and deployment ids. The Viewer drops an item that carries one, and refuses a report with nothing left, which stays owed.
Classes, and nothing outside this list:
- status — the digest a wake asks for.
- completed / failed — a deploy, lane or verdict settled.
- blocked — you cannot proceed and need a decision.
- review_verdict — an APPROVE or REQUEST_CHANGES with the round and PR.
- question — you need an answer from the user; the gateway will ask them and reply.
```

The mandate is guidance. The tick (§5.1), the tool answers (§5.2–§5.4) and the
renderer (§5.5) enforce it, including for seats on bespoke and older
mandates.

### 5.8 Summary

| Rule | Mandate | Seat tick | Tool answers | Viewer rendering |
|---|---|---|---|---|
| R1 every settled outcome, once | ✓ | owed per key until that key or a `covers` entry is in the log; survives rotation and tick-off | | |
| R2 asks | ✓ | ask owed per reply-suggestion set until a question report newer than it lands | `suggest_replies` reminder; `seat_tick_settings` lists owed reports and the open ask | attention queue (existing) |
| R3 digest | ✓ | asked on an interval wake when the board moved and nothing was reported for an interval | | |
| R4 nothing running | ✓ | owed line says so when the last lane settled | | |
| R6 task changes on deploy reports | ✓ | snapshot per settled deploy in the controller pass; deploy key given in the wake | | `tasks` section from the deploy snapshots |
| Shape and size | ✓ | | warnings on cuts and missing `decision` | summary, sections, header, time and emoji rendered by code; 1 900-byte budget, whole-item cuts, identical items in both copies |
| Keys and dedupe | ✓ | keys printed per outcome | project-scoped ids; replay is a no-op | |
| Language | ✓ | named in the wake lines | warning on mismatch (reports and task text) | headings in the interface language |
| No private information | ✓ | a refused empty report leaves its key owed | warning per class; refusal when nothing is left | items with a hit dropped from both copies |
| Telegram destination | ✓ | | destinations in the answer | posted by the Viewer to the operator's chosen chat, idempotently and silently, in the compact form |
| No link previews | ✓ | | | no `<a>`, no URLs; known PRs as "PR N" |
| Skipped step | | | | bridge-only, header name from the fallback |

### 5.9 Files, one owner

One build lane owns every file below. They are grouped by concern and no file
appears in two groups, so the lane can also be split along these lines without
two owners sharing a file.

| Concern | Files |
|---|---|
| Operator language and time zone | new `src/lib/operator/settings.ts`, new `src/app/api/operator/settings/route.ts` (+ test), `src/lib/i18n/index.ts`, new `src/lib/i18n/proseLanguage.ts` (+ test), `src/lib/agent/spawnCommand.ts` |
| Report model and rendering | `src/lib/bridge/types.ts`, `src/lib/bridge/store.ts` (+ tests), new `src/lib/bridge/reportRender.ts`, new `src/lib/bridge/reportWords.ts`, new `src/lib/bridge/taskChanges.ts`, new `src/lib/bridge/publicSafe.ts`, new `src/lib/bridge/telegramReport.ts` (each + test); the new `task_status_snapshots` collection, written only through `taskChanges.ts` |
| Tools | `src/lib/mcp/bindings.ts` (`bridge_report`, `create_task`, `update_task`, `suggest_replies`, `seat_tick_settings`, `get_orchestrator`), `src/lib/mcp/server.ts` (schemas, descriptions, session instructions), `src/lib/mcp/bridgeReportOrigin.test.ts`, `src/lib/mcp/orchestratorTools.test.ts` |
| Project report settings | `src/lib/projects/settings.ts`, `src/app/api/projects/settings/route.ts` (+ test) |
| Seat tick and mandate | `src/lib/monitor/types.ts`, `src/lib/monitor/seatTick.ts`, `src/lib/monitor/seatTickState.ts`, `src/lib/monitor/seatTickSources.ts`, `src/lib/monitor/seatTickController.ts`, `src/lib/monitor/report.ts`, `src/lib/orchestrator/prompt.ts` (each + test) |
| Setup guide step | `src/lib/onboarding/steps.ts`, `src/lib/onboarding/marker.ts`, `src/components/onboarding/OnboardingDialog.tsx` (+ dom test), new `src/components/onboarding/TelegramReportsStep.tsx` (+ dom test), `src/components/onboarding/menuEntries.tsx`, `src/components/TelegramBot.tsx` (exports only), `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts`, the two browser drivers named in §5.6 and their fixtures |

`src/hooks/useTelegramBot.ts`, `src/app/api/telegram/bot/route.ts`,
`src/app/api/telegram/bot/agent`, `src/lib/telegram/bot/service.ts`,
`src/lib/suggestions/store.ts` and `src/lib/forge/workLinks.ts` are reused
unchanged.

## 6. Example reports from 2026-09-25

Real events of the day, in the target shape. The plain text is the bridge copy
exactly as the Viewer would store it; §6.6 shows the Telegram copy of two of
them. Times are Kyiv. The header name is "Delegatus" as set in the setup step.
Task titles in 6.1 are shown in Ukrainian, as the task-text rule would have
written them; the stored titles were Russian (§1.6). Every example is within
the 1 900-byte budget; the largest, 6.1 in Ukrainian, is under 1 200 bytes.

### 6.1 `completed`, deploy of release 1.5.0 (21:45)

Key `deploy:1c41d361:succeeded`.

```text
✅ Delegatus · деплой · 25.09, 21:45 GMT+3
Реліз 1.5.0 на проді; npm ще оновлює версію.

✅ На проді
• реліз 1.5.0: тег v1.5.0 і реліз на GitHub, у CHANGELOG 34 PR після 1.4.0 (#2221); прод відповідає 200

📋 Задачі з попереднього деплою
• Готово: Прокрутка великої дошки гальмує: знайти причину на справжній дошці; Перший запуск на десктопі веде до оркестратора
• Нові: «Активність» відкривається й працює на телефоні; Обслуговування: issue з GitHub на дошку, розбір старих задач, план пріоритетів

🛠 В роботі
• npm ще показує 1.4.0: публікація пройшла, реєстр не оновився; перевірю на наступному пробудженні
• документ RRSI (#2222): змерджу, коли пройдуть перевірки
```

```text
✅ Delegatus · deploy · 25/09, 21:45 EEST
Release 1.5.0 is on prod; npm is still catching up.

✅ On prod
• release 1.5.0: the v1.5.0 tag and the GitHub release; the CHANGELOG covers the 34 PRs since 1.4.0 (#2221); prod answers 200

📋 Tasks since the previous deploy
• Done: The large board scrolls slowly: find the cause on the real board; Desktop first run leads with the orchestrator
• New: "Activity" opens and works on the phone; Maintenance: GitHub issues onto the board, old tasks sorted, a priority plan

🛠 In progress
• npm still shows 1.4.0: the publish went through and the registry has not caught up; I check again on the next wake
• the RRSI document (#2222): I merge it once its checks pass
```

The task list is reconstructed from the tasks' timestamps and the seat's own
words: it closed the scroll and first-run tasks after the 19:20 deploy, and
launched the phone and backlog work at 21:38 and 21:44. The build takes it
from the deploy snapshots of §3.8.

### 6.2 `blocked`, the failed deploy (18:46)

Key `deploy:17d92894:failed:<attempt8>`: the failed deploy is the outcome and
the ask at once. Its task list, headed "(ще не на проді)", is left out here,
since no snapshot existed on 09-25 to take it from.

```text
⛔ Delegatus · деплой · 25.09, 18:46 GMT+3
Деплой «Спершу оркестратор» зупинився на DNS: потрібен перезапуск tailscale.

✅ На проді
• попередня версія 5064e5ec, лише без «Спершу оркестратор»

❓ Чекає рішення
• DNS на машині не знаходить GitHub і Docker Hub приблизно в половині запитів, три спроби деплою 17d92894 впали (#2220)
• потрібно перезапустити tailscale на машині (sudo), потім я повторю деплой
```

```text
⛔ Delegatus · deploy · 25/09, 18:46 EEST
The "orchestrator first" deploy stopped on DNS: tailscale needs a restart.

✅ On prod
• the previous version 5064e5ec, just without "orchestrator first"

❓ Needs a decision
• DNS on the machine fails to resolve GitHub and Docker Hub on about half the lookups, and three attempts to deploy 17d92894 failed (#2220)
• restart tailscale on the machine (needs sudo), then I retry the deploy
```

### 6.3 `review_verdict`, round 1 of part 3 of "orchestrator first" (17:20)

Key `verdict:33efe347:slice3-review:1`.

```text
🔍 Delegatus · вердикт ревʼю · 25.09, 17:20 GMT+3
Третя частина «Спершу оркестратор» (#2166) повернулася на доопрацювання.

🛠 В роботі
• «Спершу оркестратор» (#2166), третя частина: ревʼю, раунд 1, знайшло дві проблеми
• дошка за замовчуванням ламає пʼять тестів панелі оркестратора, а PR конфліктує з main після #2146; збирач виправляє, далі раунд 2
```

```text
🔍 Delegatus · review verdict · 25/09, 17:20 EEST
Part 3 of "orchestrator first" (#2166) went back for changes.

🛠 In progress
• "orchestrator first" (#2166), part 3: review round 1 found two problems
• opening on the board by default breaks five orchestrator dock tests, and the PR conflicts with main after #2146; the builder is fixing both, then round 2
```

### 6.4 `status` digest (15:30, interval wake; last report 14:20)

Key `digest:2026-09-25T15:30`.

```text
🕒 Delegatus · статус · 25.09, 15:30 GMT+3
Працюють два лейни, від тебе нічого не потрібно.

🛠 В роботі
• швидкість прокрутки великої дошки: заміри на даних проду, потім виправлення
• «Спершу оркестратор» (#2166), друга частина з трьох: збирач годину стояв із позначкою «ліміт провайдера», хоча ліміт ні до чого; розморозив, збірка йде

⏳ Далі
• з'ясувати, чому ходи агентів так зависають: сьогодні це вже другий випадок
```

```text
🕒 Delegatus · status · 25/09, 15:30 EEST
Two lanes running, nothing needed from you.

🛠 In progress
• the large board's scroll speed: measuring on prod data, then the fix
• "orchestrator first" (#2166), part 2 of 3: its builder sat for an hour marked "provider limit", and the limit had nothing to do with it; unstuck, the build is running

⏳ Next
• find out why agent turns hang like this: the second case today
```

### 6.5 `question`, the next wave (22:27)

Key `ask:next-wave-plan:2026-09-25`.

```text
❓ Delegatus · питання · 25.09, 22:27 GMT+3
Потрібна відповідь на план наступної хвилі; до того нові роботи не стартують.

❓ Чекає рішення
• план наступної хвилі: надійність конвеєра, безпека проду, пам'ять. Без відповіді нові хвилі не стартують, тик зупинено
• беклог розібрано: з 357 відкритих issue 74 закрито з коментарями, решту 283 розкладено приблизно по 94 задачах на дошці
```

```text
❓ Delegatus · question · 25/09, 22:27 EEST
Your answer on the next-wave plan is needed; no new work starts before it.

❓ Needs a decision
• the plan for the next wave: pipeline reliability, prod safety, memory. No new wave starts without your answer, and the tick is stopped
• the backlog is triaged: of 357 open issues, 74 are closed with comments and the other 283 are sorted into about 94 board tasks
```

### 6.6 The Telegram copy

6.1 as `telegram_bot_send` receives it: the same header, summary and items,
with the sections collapsed, no links, the known PRs written as "PR 2221" and
"PR 2222", sent silently.

```html
✅ <b>Delegatus · деплой</b> · 25.09, 21:45 GMT+3
Реліз 1.5.0 на проді; npm ще оновлює версію.
<blockquote expandable>✅ <b>На проді</b>
• реліз 1.5.0: тег v1.5.0 і реліз на GitHub, у CHANGELOG 34 PR після 1.4.0 (PR 2221); прод відповідає 200

📋 <b>Задачі з попереднього деплою</b>
• Готово: Прокрутка великої дошки гальмує: знайти причину на справжній дошці; Перший запуск на десктопі веде до оркестратора
• Нові: «Активність» відкривається й працює на телефоні; Обслуговування: issue з GitHub на дошку, розбір старих задач, план пріоритетів

🛠 <b>В роботі</b>
• npm ще показує 1.4.0: публікація пройшла, реєстр не оновився; перевірю на наступному пробудженні
• документ RRSI (PR 2222): змерджу, коли пройдуть перевірки</blockquote>
```

Collapsed in the group, it reads as two lines: the header and "Реліз 1.5.0 на
проді; npm ще оновлює версію."

6.2 in the group; #2220 is an issue, so it stays `#2220`:

```html
⛔ <b>Delegatus · деплой</b> · 25.09, 18:46 GMT+3
Деплой «Спершу оркестратор» зупинився на DNS: потрібен перезапуск tailscale.
<blockquote expandable>✅ <b>На проді</b>
• попередня версія 5064e5ec, лише без «Спершу оркестратор»

❓ <b>Чекає рішення</b>
• DNS на машині не знаходить GitHub і Docker Hub приблизно в половині запитів, три спроби деплою 17d92894 впали (#2220)
• потрібно перезапустити tailscale на машині (sudo), потім я повторю деплой</blockquote>
```

What the scrubber does, on invented items a seat might have written that day
(the account is a placeholder):

```text
Item:    деплой упав, бо акаунт account-b вичерпав 100% тижневого ліміту
Result:  the item is dropped from both copies; the rest of the report is filed
Answer:  warnings ["1 item dropped: it named an account and a usage limit. Reports can be public; leave them out."]

A report whose only item was that one:
Answer:  refused, code report_empty_after_scrub; nothing stored, nothing posted, the key stays owed
```

### 6.7 Volume

Between 10:00 and 22:30 on 09-25 the seat filed 6 reports. Under these rules
the same span asks for one report per owed outcome key (15 outcome wakes,
some carrying two outcomes, which a report may cover together), up to 5
digests on the interval wakes, and the two asks that stayed in chat (the 1.5.0
tag and the next-wave plan). In the group each of them is two visible lines.

## 7. Build

1. Operator settings: `locale` and `timeZone` in the store and route, the
   client write and adoption, `operatorLocale` on `get_orchestrator`;
   `proseLanguage` with a table test drawn from shapes seen in the log.
2. **Report rendering** (`reportRender`, `reportWords`), with tests for:
   - the section order, the kind words, the class emoji and the summary
     fallback, in both languages;
   - a report for a project with no report settings, whose header takes the
     repository name, and one with no GitHub remote, which takes the display
     name;
   - `operatorLocale` null: English headings and kind words, the host's time
     zone when none is known;
   - **a Ukrainian deploy report with 3 `inProgress` items and 8 Done plus 8
     New task titles of about 60 characters: the plain rendering is at most
     1 900 bytes, the store keeps it without "…", no item is cut mid-text, the
     task groups shrink first, and the Telegram rendering lists exactly the
     same items**;
   - `decision` and the summary surviving the tightest cut.
3. `publicSafe`: each class of §5.5; deny-list sources from fixture
   registries (invented names); skipped short and generic entries; another
   project called `tools` leaving the word "tools" alone while
   `owner/tools-repo` and `tools-repo` are caught; ordinary prose left alone;
   an item dropped whole; a summary replaced by the fallback.
4. `taskChanges`, with tests for:
   - a snapshot per settled deploy, idempotent by deployment id, and the
     newest 10 kept;
   - Done, Blocked, In progress and New; hidden and deleted tasks left out; a
     scrubbed title counted; the 6-title cut;
   - **late filing: snapshot at deploy D1; D2 succeeds at 10:00; a task moves
     to Done at 11:00; D2's report is filed at 12:00 and does not list it, and
     D3's does**;
   - a successful deploy with no report, whose snapshot is still the next
     list's starting point;
   - a failed deploy listed from the last successful one and marked "not on
     prod yet";
   - a deploy with no snapshot, which shows no `tasks` section.
5. `telegramReport`: the compact layout (header line, summary line, one
   `<blockquote expandable>` holding every section); escaping before tags; no
   `<a>` and no URL in any output; a known PR as "PR N" and an issue kept as
   `#N`; the same items as the plain rendering.
6. `bridge_report`, with tests for:
   - `summary`, `sections` and the legacy `body`; `covers`; project-scoped
     ids (two projects, one key, two rows); warnings, and none about language
     while `operatorLocale` is null;
   - the deploy report's `tasks` section;
   - **a report with nothing left after scrubbing, refused with
     `report_empty_after_scrub`, storing and posting nothing**;
   - the Telegram fan-out over the bot service's fake transport
     (`src/lib/telegram/bot/fakeTransport.ts`): a manager report posts once,
     silently and as HTML; a replay posts nothing; a rate-limited send is
     re-sent on replay under a new request id; `send_uncertain` is never
     re-sent; an agent-origin report, a project with no chat and a project
     with reports off post nothing.
7. `create_task` / `update_task` language warnings (none while the locale is
   null) and the locale sentence in the MCP session instructions.
8. `suggest_replies` reminder line; `seat_tick_settings` answer when the tick
   is switched off or slowed, with the owed keys and the open ask.
9. Seat tick, in `seatTick.test.ts`, `seatTickState.test.ts`,
   `seatTickSources.test.ts` and `seatTickController.test.ts`:
   - owed entries recorded per key at wake commit, and kept across a rotation
     and a tick switched off;
   - a report for `deploy:aaaaaaaa:succeeded` after a wake that announced that
     deploy and lane `L` completing clears the deploy only, and the next wake
     still asks for `lane:L:completed`; a report listing it in `covers` clears
     it;
   - **a report for that deploy key whose only item named `/home/x` is refused,
     and the next wake still lists the key**;
   - two failures of the same commit owe two keys, and a later failure after
     them owes a third;
   - "Nothing is running now" when the owed lane was the last open one;
   - **the ask line after "suggest, report, suggest": the second set is owed
     until a question report newer than it lands**, and an answered ask (set
     retired by the operator's message) is not;
   - no digest line on an unchanged board after a digest filed with nothing
     owed, and a digest line when the board moved between the previous check
     and the report;
   - a deploy snapshot recorded in the controller pass when a deploy settles,
     whether or not a wake is sent;
   - no language clause while `operatorLocale` is null;
   - the lifecycle projection running before the journal read;
   - no report lines while bridge reports are off.
10. Mandate v29 and the contract clause, with `prompt.test.ts` fingerprints.
11. `spawnCommand.ts` fallback title from `operatorLocale()`.
12. Project report settings (`reportTelegram`, `reportHeaderName`) and the
    setup guide step (§5.6), with DOM tests for connect, choose, allow in
    place, name required with a chat, skip, and a skipped step that leaves
    reports bridge-only and never reopens the guide. Rendered evidence goes
    in the two existing drivers.
13. **Before/after replay** in `seatTick.test.ts`: a fixture day shaped after
    09-25 (15 outcome wakes, 5 interval wakes, the 6 real report times of that
    span, a 30-minute interval, invented titles). Before: 5 of 15 outcome
    wakes and 0 of 5 interval wakes were followed by a report. The test
    asserts that every owed key is asked for in each later wake until a report
    carrying it lands, and that each interval wake on a moved board with
    nothing reported gets a digest line. It counts asks; whether seats comply
    shows in the log afterwards.

Gates: `tsc` clean; the touched test files by path under Bun 1.4.0 with an
isolated `LLV_STATE_DIR`; the privacy gate from the merge base.

## 8. Validation against the requirement

| Operator asked | Design |
|---|---|
| More often | R1 makes every settled outcome a report, asked per key until it lands; R3 adds a digest per interval while the board moves. |
| Clear rules: when, what, what shape | §3.1 triggers, §3.2 summary and sections, §3.3 keys, §3.4 quiet periods. |
| Short but substantive | A summary line of at most 120 characters; items of at most 200 characters saying what is now true and what it means; per-section limits and a byte budget. |
| Regular, catch up after AFK at any moment | Every outcome asked for until reported; digest within one interval when anything moved; silence means nothing changed; asks and a stopped tick produce a report (§5.1, §5.4). Survives rotations. |
| Maybe tie to seat ticks | The tick is the main enforcement point (§5.1). |
| Reports and task text in the interface language | One server-side operator setting; named in wakes, `get_orchestrator` and session instructions; warnings on mismatch; headings rendered in it; English until a client has reported it. |
| Analyse first | Section 1. |
| Also to a Telegram group, same content | Bridge always, plus the project's chosen chat; both rendered from one cut report, so the items are identical; posted by the Viewer, idempotently (§3.2, §3.6, §5.5). |
| Operator picks the chat per project | The optional setup-guide step, operator-only, allowlisted chats only (§5.6). |
| Optional step in the setup guide, reusing the bot UI and services | "Reports to Telegram (optional)" before Orchestrator, built from `TokenForm`, `ChatRow` and `useTelegramBot` over the existing routes (§5.6). |
| Skipping it keeps bridge-only reports working | Skip writes nothing; with no chat nothing is posted; the header name falls back to the repository or display name (§3.6, §5.6). |
| Compact Telegram post (26.09): emoji, bold "Delegatus · kind", date and time, one summary line, sections in one expandable quote | `telegramReport` (§5.5), shown in §6.6. |
| No link previews: no links or URLs, PR numbers as text | No `<a>` is emitted, URLs and domains are scrubbed, known PRs read "PR N" (§5.5). |
| Sent silently | `silent: true` on every post (§5.5). |
| No private information, the group may be public | §3.7 for every report; items with a hit dropped from both copies; a report left empty is refused and stays owed; warnings; mandate for what cannot be detected. |
| Deploy reports list task status changes since the previous deploy | `tasks` section from snapshots taken when each deploy settles; Done, Blocked, In progress and New, by title, scrubbed (§3.8). |
| Name the files so one owner holds them | §5.9. |
| Not in scope: log UI, voice relay | No report log change; the relay reads the same rows, whose text is now the sectioned plain rendering. More reports mean more relay batches, within the existing drain caps (5 per batch, one batch per 30 s). |

## Deferred — not currently justified

- **A `report-owed` wake reason** that resumes a seat only to file a report.
  Worth building only if the log shows seats ignoring the wake lines.
- **Refusing a report in the wrong language.** The requirement asks for a
  warning, and a refusal risks losing the report.
- **Viewer-written report text** beyond the header, the headings and the task
  list (option 2 in section 2).
- **A coverage metric surface** (outcomes against reports per day on the
  board). The replay test and the tick state answer the question for now.
- **Translating Viewer-authored system cards** into the operator's language.
  They are Viewer UI copy, and the i18n dictionaries own them.
- **Reading replies from the Telegram group** as answers to a question. The
  ask still goes through the operator's chat and the attention queue.
- **An explicit `link_preview_options` in the bot service.** The Telegram copy
  carries no link or URL, so Telegram has nothing to preview.
- **Raising `BRIDGE_REPORT_BODY_MAX_BYTES`.** The 1 900-byte budget holds a
  full report; a larger cap would only allow longer reports than the operator
  asked for.
- **More than one chat per project, forum topics, per-class filters, a test
  post from the step, or a "posted to Telegram" mark in the report log.**
- **A time zone picker.** The client reports its zone; nobody has asked to
  choose another.
- **Per-device interface languages.** One operator, one language, until
  someone asks for two.
