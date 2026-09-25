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
if any. The Viewer posts the Telegram copy itself when the report is stored,
rendered as short Telegram HTML from the same body. Because that chat can be
public, report bodies must never carry local paths, account names, emails,
hosts or secrets, and the Telegram copy is scrubbed of those classes before it
is sent.

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
| 09-19 | 21 | 19 en, 2 ru | 18 | 107 | 4 | – | – | – |
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

Across all projects from 09-19 to 09-25 the manager reports read 133 en,
52 uk, 10 ru, 1 mixed. Project C's seat wrote 11 of 15 reports in Russian on
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

**Where the language comes from.** See section 4.

## 3. Rules

### 3.1 Triggers

| # | When | Class | Enforced by |
|---|---|---|---|
| R1 | Every settled outcome, each once: a merge, a deploy that succeeded or failed, a review verdict, a lane that completed, failed or parked, a release step. Outcomes of one lane or one release may share a report. | `completed`, `failed`, `review_verdict` | Wake lists unreported outcomes (4.2); mandate |
| R2 | The moment the seat needs the operator: a decision, an approval, an access it lacks. One ask per report. | `blocked`, `question` | Mandate; existing attention queue (#1168) |
| R3 | A status digest when the wake says one is due: an interval wake, the board moved since the last report, and no manager report for at least one wake interval. | `status` | Wake line (4.2) |
| R4 | The last open lane settles: the report for it says that nothing is running now. | (part of R1) | Mandate; shape rule 3 |
| R5 | File the report even when the operator is in the chat and got the same news there. The chat is not the log. | – | Mandate |

The operator's AFK case is covered by R1 and R3 together: every outcome
reaches the log in the turn of the wake that announced it, or the next wake
asks again, and anything else that moved reaches it within one wake interval.

### 3.2 Shape

Three lines, at most 600 characters (the store's 2 KB bound stays as the hard
limit):

1. **Headline**: one sentence saying what is now true.
2. **What changed**: one or two sentences on what it means for the operator:
   the effect, the cause of a failure, what state prod is in.
3. **Next**: what happens next, or what is needed. The line starts with the
   word for "Next:" in the report's language, or "Needed from you:" on
   `blocked` and `question`.

Ids: name work by `#PR` (the log links it to GitHub), pipeline id and task id
(the log links them to their cards, `src/lib/bridge/reportCardRefs.ts`), and a
deploy by its 8-character sha. Never full SHAs, deployment ids, report keys,
conversation ids, file paths or raw tool output.

### 3.3 Keys and dedupe

- Grammar: `<kind>:<id>:<state>` for outcomes (`deploy:<sha8>:succeeded`,
  `lane:<pipelineId>:completed`, `pr:<n>:merged`,
  `verdict:<pipelineId>:<stageId>:<round>`), `digest:<YYYY-MM-DDTHH:MM>` for
  a digest, and `ask:<topic>:<YYYY-MM-DD>` for `blocked` and `question`.
- The same key files once; the store already makes a replay a no-op. The build
  scopes the stored id by project (1.9), so the same key from two projects
  gives two rows.
- A digest does not repeat an outcome that already has its own report. It
  covers what moved since the time of the last report.

### 3.4 Quiet periods

- Nothing changed, nothing reported: the tick asks for no digest while the
  board fingerprint equals the one recorded at the last report. Silence in the
  log therefore means "nothing changed since the last entry".
- The **Next** line of the latest report is what the operator relies on while
  away, so it has to stay true. When the seat stops, pauses the tick or waits
  on the operator, the report says so ("the tick is stopped until you
  answer").
- An idle project ends on a report whose Next line says nothing is running.

### 3.5 Language

| Text | Language |
|---|---|
| Bridge reports | The operator's interface language |
| Board task text (`create_task.text`, `update_task.text`, `refine`), all callers | The operator's interface language |
| Viewer-authored task titles (pinned spawn fallback title) | The operator's interface language |
| Chat replies, `suggest_replies` drafts | The language the operator writes in (unchanged) |
| Task `details`, pipeline specs, prompts to agents | Unchanged (agent-facing) |
| GitHub issues, PRs, commits, docs | English (unchanged) |

Quoted UI labels, code and ids inside a report keep their original form.

### 3.6 Destinations

- Every manager report goes to the bridge log. That row is the record, and
  the voice relay and the report log read it as they do today.
- It also goes to the project's Telegram chat when the operator picked one for
  that project. The copy carries the same three lines, formatted for Telegram
  (5.6).
- Reports filed by other sessions (origin `agent`, `gateway`,
  `unidentified`) go to the bridge log only. The public copy speaks for the
  seat and nothing else.
- While the project's Bridge reports setting is off, nothing is stored and
  nothing is posted.
- A failed Telegram post never loses the report. The bridge row stays, and the
  answer says what happened to the copy.

### 3.7 Public-safe content

Every report body may end up in a public group, so these rules apply to every
report, whichever destinations it has:

- No local paths: nothing starting with `/`, `~/`, `$HOME`, a drive letter, or
  naming a worktree, state or config directory.
- No account names: no Claude, Codex or Copilot account id or label, no GitHub
  handle, no OS user name. Say "the second account" or "a Pro account".
- No emails, phone numbers, IP addresses or host names (including tailnet
  names).
- No secrets. The store already redacts known token shapes; the rule still
  applies to anything it cannot recognise.
- No conversation ids, deployment UUIDs or report keys (already in 3.2).
- Names of people, customers and other projects only as the operator uses them
  publicly.

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
  `{ schemaVersion: 1, locale: { value: "en" | "uk", source: "chosen" | "detected", changedAt } }`.
  `operatorLocale(): "en" | "uk" | null` reads it.
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

Consequence: with two devices, the last choice wins on both, and the other
device adopts it on its next load. There is one interface language per
operator, which is what "the language I selected" means.

## 5. Enforcement points

### 5.1 Seat tick

- **State** (`SeatTickProjectState`, `src/lib/monitor/types.ts:949`):
  - `reportOwed: { since: string; outcomes: string[] } | null`: outcomes a
    landed wake announced that no manager report has followed yet. At most 8
    labels, newest kept, plus a count of the rest.
  - `reportSeenAt: string | null` and `reportFingerprint: string | null`: the
    newest manager report the tick has observed, and the board fingerprint at
    that check.
  - All three are project-scoped and survive a rotation: add them to
    `seatTickStateForEpoch` (`src/lib/monitor/seatTickState.ts:315`), so a
    successor inherits what its predecessor left unreported.
- **Input** (`SeatTickCheckInput`): `lastReportAt`, the `at` of the newest
  row with `origin.kind === "manager"` for the project, read once per
  controller pass in `seatTickSources.ts`; `bridgeReports` (the project
  setting); `operatorLocale`.
- **Record** (`seatTickWakeCommit`, `src/lib/monitor/seatTick.ts:1696`): when
  a wake lands carrying a settled outcome (a settled deploy, one of the seat's
  lanes completed, failed, parked or provisioning-failed, or a terminal
  lane-event), append its label to `reportOwed`; `since` keeps the earliest.
  Nothing is recorded while bridge reports are off.
- **Discharge** (`decide`, `src/lib/monitor/seatTick.ts:1049`): a check with
  `lastReportAt >= reportOwed.since` clears `reportOwed`, and moves
  `reportSeenAt` and `reportFingerprint`. Discharge is by time: a report filed
  after the wake counts, whatever key it used. One report covering several
  outcomes clears them all; the rule asks for one per outcome, and the log
  shows the rest.
- **Wake text** (`seatTickWakeMessage`, `src/lib/monitor/report.ts:236`),
  in the reserved tail so the length bound never cuts it:
  - `Report: <n> outcome(s) since HH:MM are not in your report log: <labels>. File a bridge_report for each, in Ukrainian, before this turn ends.`
  - When `interval` is among the reasons, bridge reports are on,
    `lastReportAt` is older than the wake interval (or absent) and the board
    fingerprint differs from `reportFingerprint`:
    `Digest due: no report since HH:MM and the board moved. File one status report (key digest:<YYYY-MM-DDTHH:MM>), in Ukrainian: what moved, what is running, what is next.`
  - No new wake reason: both lines ride wakes the tick sends anyway (option 4
    in section 2 is deferred).
- **Stage events** (1.9): `seatTickSources.ts` calls the lifecycle projection
  with the pipelines before it pages the journal, so review verdicts and stage
  failures reach `lane-event` again.
- **Contract clause**: `ORCHESTRATOR_SEAT_TICK_CONTRACT`
  (`src/lib/orchestrator/prompt.ts:139`) gains one clause: "If the wake lists
  unreported outcomes or says a digest is due, file those bridge reports
  before the turn ends." A seat on an older mandate does not need it: the
  report lines themselves say "before this turn ends".

### 5.2 `bridge_report`

In `bridgeReport` (`src/lib/mcp/bindings.ts:2565`), after the row is stored,
the answer gains `warnings: string[]` (empty when clean). Nothing is refused,
because a report that reached the log beats one bounced back to a seat that
may not retry.

- Language: `proseLanguage(body)` differs from `operatorLocale()` →
  "This report reads as Russian; the operator's interface is Ukrainian. Write
  reports in Ukrainian." `proseLanguage` is a pure server-side module
  (`src/lib/i18n/proseLanguage.ts`; `index.ts` is a client module) using the
  classification in 1.1, and it returns null below 40 letters or on a mixed
  body, in which case nothing is said.
- Length: a body over 600 characters → "Keep reports under 600 characters:
  headline, what changed, next."
- Machine ids: a 40-hex SHA, a UUID, a `conversation_` id or an absolute path
  → "Drop full SHAs, UUIDs, conversation ids and paths; use #PR, pipeline and
  task ids and an 8-character sha."
- Public-safe content (3.7): the scrubber of 5.6 runs on every manager report,
  whether or not the project has a Telegram chat, and each class it finds adds
  a warning naming the class and never the value ("This report names a local
  path and an account; reports can be public. Leave them out."). The bridge row
  keeps the body as the store wrote it.
- Id scoping: the stored id becomes `bridgeReportId(project + "\0" + key)`
  when the project resolves. The verbatim `key` that decision-class rows keep
  for the attention queue is unchanged.
- Tool description (`src/lib/mcp/server.ts:3024` and the schema at `:3677`)
  states the shape, the key grammar and the language in two sentences.

### 5.3a Destinations in the answer

The answer names where the report went:
`destinations: { bridge: { seq }, telegram?: { chat, state, messageIds?, code?, retryable? } }`,
with `state` one of `sent`, `failed`, `uncertain`. 5.6 describes the Telegram
half.

### 5.3 `create_task` and `update_task`

The same `proseLanguage` check on `text` (and `refine.text`), never on
`details`, adds a warning to the answer. The descriptions say that `text` is
written in the operator's interface language.

### 5.4 Mandate (v28 → v29)

Replace the Bridge reports section of `ORCHESTRATOR_SYSTEM_PROMPT` and bump
`ORCHESTRATOR_PROMPT_VERSION` with its fingerprint in `prompt.test.ts`. Draft:

```text
## Bridge reports — the second channel (manager -> gateway)
<the existing paragraph on the Bridge reports setting, unchanged>
On: the report log is where the operator catches up after being away, and they can leave at any moment, so it has to hold every outcome without your chat.
File a report:
- for every settled outcome, once: a merge, a deploy that succeeded or failed, a review verdict, a lane that completed, failed or parked, a release step. Outcomes of one lane or release may share a report.
- the moment you need the operator (blocked or question), one ask per report.
- as a status digest when a wake says one is due: what moved since your last report, what is running, what is next.
- even when you also told the operator in chat. The chat is not the log.
Each wake lists outcomes the log has not received and says when a digest is due; file those before the turn ends.
Shape: at most 600 characters, three lines. 1) One sentence saying what is now true. 2) What changed for the operator, in one or two sentences. 3) "Next: …", or "Needed from you: …" on blocked and question, in the report's language. Name work by #PR, pipeline id and task id (the log links them) and a deploy by its 8-character sha; never full SHAs, deployment ids, keys, paths or tool output.
Keys: <kind>:<id>:<state> (deploy:<sha8>:succeeded, lane:<pipelineId>:completed, pr:<n>:merged, verdict:<pipelineId>:<stageId>:<round>), digest:<YYYY-MM-DDTHH:MM>, ask:<topic>:<YYYY-MM-DD>.
Quiet: say nothing when nothing changed. The Next line of your latest report is what the operator relies on, so keep it true; when you stop, pause or wait on them, say so, and when the last lane settles, say that nothing is running.
Language: reports and board task text use the operator's interface language (operatorLocale in get_orchestrator, named in each wake). Chat replies stay in the language the operator writes to you in; GitHub stays English.
Public: a report can also be posted to a Telegram chat the operator picked for this project (reportTelegram in get_orchestrator), and that chat may be public. Never put local paths, account names or ids, emails, host names, IP addresses or secrets in any report. The Viewer posts the copy itself and scrubs those from it, and a scrubbed word is lost to the readers, so write without them.
Classes, and nothing outside this list:
- status — the digest a wake asks for.
- completed / failed — a merge, deploy, lane or release step settled.
- blocked — you cannot proceed and need a decision.
- review_verdict — an APPROVE or REQUEST_CHANGES with the round and PR.
- question — you need an answer from the user; the gateway will ask them and reply.
```

The mandate is guidance; the wake lines (5.1) and tool warnings (5.2, 5.3)
enforce it. They reach seats on bespoke and older mandates too.

### 5.6 Telegram destination

- **Setting**: `project-settings.json` gains `reportTelegram: { chat, changedAt, changedBy } | absent`
  beside `mergeOnReview` and `bridgeReports`, where `chat` is the bot chat's
  alias. `src/lib/projects/settings.ts` stores only boolean switches today, so
  it gains this one non-boolean entry with its own reader,
  `reportTelegramChat(project): string | null`. `/api/projects/settings`
  accepts `{ project, reportTelegram: { chat } | null }` and refuses a chat
  that `TelegramBotService` does not list as allowlisted and `postAllowed`.
  Only the operator sets it: there is no MCP write, so no agent chooses where
  a public post goes. `get_orchestrator` carries `reportTelegram` (alias or
  null).
- **Picker**: one row in the board's ⋯ menu and the phone's ⋯ sheet, beside
  the Bridge reports switch and built from the same `ProjectSettingRow`:
  "Reports to Telegram: <chat title>" or "Off", opening a list of the
  allowlisted chats that accept posts, plus Off. The row names the project
  label that will head every post, so the operator sees it before choosing.
  The row is hidden while no bot is connected; the report log itself is
  unchanged.
- **Fan-out**: in `bridgeReport` (`src/lib/mcp/bindings.ts:2565`), after the
  row is appended, when the origin is `manager` and the project has a chat:
  1. `publicSafeReport(body, denyList)` (new, pure, `src/lib/bridge/publicSafe.ts`)
     replaces local paths, account names and ids, emails, phone numbers, IP
     addresses, host names, UUIDs and `conversation_` ids with a marker in
     the operator's language (`[приховано]` / `[hidden]`), after the store's
     secret redaction has already run. The deny list is read at call time:
     every account id and label in the account registry, the OS user name,
     the home directory's name and the machine's host name. Entries under 4
     characters and generic words (`main`, `default`, `work`, `pro`, `max`)
     are skipped; tokens match whole and case-insensitively. Hiding a word by
     mistake costs less than posting an account name.
  2. `telegramReportHtml(...)` (new, pure, `src/lib/bridge/telegramReport.ts`)
     renders the copy: HTML-escape the scrubbed body first, then add tags.
     - Header: `<b>{project label} · {class word}</b>`, the class word in the
       operator's language: the report log's existing `reportLog.class.*`
       words from `src/lib/i18n/en.ts` and `uk.ts`, capitalised. Those two
       dictionaries are plain modules, so the server can import them.
     - The headline, then the "what changed" line, each as its own paragraph.
     - The last line's label ("Next:", "Needed from you:", "Далі:",
       "Потрібно від тебе:") in `<b>`.
     - `#123` and `owner/repo#12` become links to GitHub (`/issues/<n>`, which
       GitHub redirects for a PR), through the same
       `githubRepositoryOfRemote` the report log uses; without a GitHub remote
       they stay text. A 7–12 character hex token becomes `<code>`.
     - A 600-character body plus the header stays far below Telegram's 4096;
       a copy over 4096 is cut at the last paragraph that fits, with an
       ellipsis.
  3. Send through the existing agent route (`/api/telegram/bot/agent`,
     `op: "send"`, `format: "html"`) with the seat's capability headers, so the
     post is attributed to the seat conversation, under
     `clientRequestId: "bridge-report:<reportId>"`. `status` digests go with
     `silent: true`; every other class notifies.
  4. Record the outcome on the report row with a new store function,
     `recordBridgeReportTelegram(id, { chat, state, messageIds?, code?, at })`,
     and return it in `destinations.telegram`.
- **Failure and retry**: a refusal never loses the bridge row. A retryable
  code (`rate_limited`, `network_failed`, `timed_out`, `telegram_failed`)
  leaves `state: "failed"`; calling `bridge_report` again with the same key is
  still a replay for the log, and the binding then re-sends the copy under
  `bridge-report:<reportId>:r<n>`. `send_uncertain` is never re-sent: a second
  public post is worse than a missing one. A chat the operator removed from
  the allowlist answers `chat_not_allowed` until the setting is changed.
- **Not posted**: reports from other sessions, anything while Bridge reports
  are off, and the synthetic gap notices the relay drain composes.

### 5.5 Summary

| Rule | Mandate | Seat tick | `bridge_report` | Task tools / MCP instructions |
|---|---|---|---|---|
| R1 every settled outcome | ✓ | lists unreported outcomes until a report lands; survives rotation | | |
| R2 asks | ✓ | | (existing attention queue) | |
| R3 digest | ✓ | asks on an interval wake when the board moved and nothing was reported for an interval | | |
| Shape and length | ✓ | reminder in the report line | warning over 600 characters or with machine ids | |
| Keys and dedupe | ✓ | digest key printed | project-scoped id; replay is a no-op | |
| Language | ✓ | language named in the report lines | warning on mismatch | warning on mismatch; locale in session instructions |
| Telegram destination | ✓ (names `reportTelegram`) | | the Viewer posts the manager's reports to the operator's chosen chat, idempotently | operator-only setting and picker |
| Public-safe content | ✓ | | warning per class on every report; the Telegram copy is scrubbed | |

## 6. Example reports from 2026-09-25

Real events of the day in the target shape. Times are Kyiv.

### 6.1 `completed`, after the 21:45 wake (deploy settled)

Key `deploy:1c41d361:succeeded`.

uk:

```text
Реліз 1.5.0 на проді: деплой 1c41d361 пройшов, прод відповідає 200.
Тег v1.5.0 і реліз на GitHub створено, у CHANGELOG 34 PR після 1.4.0 (#2221). npm поки показує 1.4.0: публікація пройшла, реєстр ще не оновився.
Далі: перевірю npm на наступному пробудженні й змерджу документ RRSI (#2222), коли пройдуть перевірки.
```

en:

```text
Release 1.5.0 is live: deploy 1c41d361 succeeded and prod answers 200.
The v1.5.0 tag and the GitHub release are out; the CHANGELOG covers the 34 PRs since 1.4.0 (#2221). npm still shows 1.4.0: the publish went through and the registry has not caught up.
Next: I check npm on the next wake and merge the RRSI document (#2222) once its checks pass.
```

### 6.2 `blocked`, 18:46

Key `ask:deploy-dns:2026-09-25`.

uk:

```text
Деплой «Спершу оркестратор» (17d92894) зупинено: DNS на машині не знаходить GitHub і Docker Hub приблизно в половині запитів.
Три спроби впали саме на цьому. Прод працює на попередній версії 5064e5ec, лише без цієї зміни. Подробиці в #2220.
Потрібно від тебе: перезапусти tailscale на машині (потрібен sudo), після цього я повторю деплой.
```

en:

```text
The "orchestrator first" deploy (17d92894) is stopped: DNS on the machine fails to resolve GitHub and Docker Hub on about half the lookups.
Three attempts failed on exactly that. Prod runs the previous version 5064e5ec, just without this change. Details in #2220.
Needed from you: restart tailscale on the machine (it needs sudo); then I retry the deploy.
```

### 6.3 `review_verdict`, 17:20 (lane 33efe347, stage slice3-review, round 1)

Key `verdict:33efe347:slice3-review:1`.

uk:

```text
Ревʼю третьої частини «Спершу оркестратор» (#2166) повернуло її на доопрацювання, раунд 1.
Дві знахідки P1: дошка за замовчуванням ламає пʼять тестів панелі оркестратора, а PR конфліктує з main після #2146 і потребує нової версії мандата. Лейн 33efe347.
Далі: збирач виправляє, потім другий раунд ревʼю. Від тебе нічого не потрібно.
```

en:

```text
Review sent part 3 of "orchestrator first" (#2166) back for changes, round 1.
Two P1 findings: opening on the board by default turns five orchestrator dock tests red, and the PR conflicts with main after #2146 and needs a mandate version bump. Lane 33efe347.
Next: the builder fixes both, then review round 2. Nothing needed from you.
```

### 6.4 `status` digest, 15:30 (interval wake; last report 14:20)

Key `digest:2026-09-25T15:30`.

uk:

```text
Зведення: працюють два лейни, від тебе нічого не потрібно.
Запустив лейн швидкості прокрутки дошки (f83a5e38): заміри на даних проду, потім виправлення. Другу частину «Спершу оркестратор» (#2166) розморозив: її збирач годину стояв із позначкою «ліміт провайдера», хоча ліміт ні до чого.
Далі: ревʼю другої частини; шукаю, чому такі ходи зависають, це вже другий випадок за день.
```

en:

```text
Digest: two lanes running, nothing needed from you.
Started the board scroll speed lane (f83a5e38): measure on prod data, then fix. Unstuck part 2 of "orchestrator first" (#2166): its builder sat for an hour marked "provider limit", and the limit had nothing to do with it.
Next: review of part 2; I am finding out why turns hang like this, the second case today.
```

### 6.5 `question`, 22:27

Key `ask:backlog-plan:2026-09-25`.

uk:

```text
План пріоритетів готовий і чекає на тебе: нові хвилі робіт не стартують без відповіді, тик зупинено.
Беклог розібрано: з 357 відкритих issue закрито 74 з коментарями (60 зроблено, 13 застаріли, 1 дубль), решту 283 розкладено приблизно по 94 задачах на дошці.
Потрібно від тебе: відповідь на план (хвилі A, B і C) у чаті оркестратора.
```

en:

```text
The priority plan is ready and waiting on you: no new wave of work starts without your answer, and the tick is stopped.
The backlog is triaged: of 357 open issues, 74 are closed with comments (60 done, 13 obsolete, 1 duplicate), and the other 283 are sorted into about 94 tasks on the board.
Needed from you: your answer on the plan (waves A, B and C) in the orchestrator chat.
```

### 6.6 The Telegram copies

The copy of 6.1, in Ukrainian, as `telegram_bot_send` receives it
(`<owner>/<repo>` stands for the project's GitHub repository):

```html
<b>Delegatus · Завершено</b>
Реліз 1.5.0 на проді: деплой <code>1c41d361</code> пройшов, прод відповідає 200.

Тег v1.5.0 і реліз на GitHub створено, у CHANGELOG 34 PR після 1.4.0 (<a href="https://github.com/<owner>/<repo>/issues/2221">#2221</a>). npm поки показує 1.4.0: публікація пройшла, реєстр ще не оновився.

<b>Далі:</b> перевірю npm на наступному пробудженні й змерджу документ RRSI (<a href="https://github.com/<owner>/<repo>/issues/2222">#2222</a>), коли пройдуть перевірки.
```

The same in English:

```html
<b>Delegatus · Completed</b>
Release 1.5.0 is live: deploy <code>1c41d361</code> succeeded and prod answers 200.

The v1.5.0 tag and the GitHub release are out; the CHANGELOG covers the 34 PRs since 1.4.0 (<a href="https://github.com/<owner>/<repo>/issues/2221">#2221</a>). npm still shows 1.4.0: the publish went through and the registry has not caught up.

<b>Next:</b> I check npm on the next wake and merge the RRSI document (<a href="https://github.com/<owner>/<repo>/issues/2222">#2222</a>) once its checks pass.
```

6.2 (`blocked`) in Ukrainian; it notifies, since it asks for the operator:

```html
<b>Delegatus · Заблоковано</b>
Деплой «Спершу оркестратор» (<code>17d92894</code>) зупинено: DNS на машині не знаходить GitHub і Docker Hub приблизно в половині запитів.

Три спроби впали саме на цьому. Прод працює на попередній версії <code>5064e5ec</code>, лише без цієї зміни. Подробиці в <a href="https://github.com/<owner>/<repo>/issues/2220">#2220</a>.

<b>Потрібно від тебе:</b> перезапусти tailscale на машині (потрібен sudo), після цього я повторю деплой.
```

6.4 (`status`) goes out silently, with the same layout under
`<b>Delegatus · Статус</b>`.

What the scrub does, on an invented body a seat might have written on the same
day (account and path are placeholders):

```text
Body:   Деплой упав: образ не зібрався в /home/<user>/.config/…/deployments, акаунт account-b вичерпав ліміт.
Copy:   Деплой упав: образ не зібрався в [приховано], акаунт [приховано] вичерпав ліміт.
Answer: warnings ["This report names a local path and an account; reports can be public. Leave them out."]
```

The bridge row keeps the first line, the group gets the second, and the seat
learns to write "the second account ran out of its limit".

### 6.7 Volume

Between 10:00 and 22:30 on 09-25 the seat filed 6 reports. Under these rules
the same span asks for one report per outcome wake (15), up to 5 digests on
the interval wakes, and the two asks that stayed in chat (the 1.5.0 tag and
the backlog plan).

## 7. Build

1. Operator locale: the store, the route with its route test, the client
   write and adoption in `src/lib/i18n/index.ts` with a DOM test, and
   `operatorLocale` on `get_orchestrator`.
2. `proseLanguage` with a table test drawn from shapes seen in the log (a
   Ukrainian body quoting an English PR title, an English body quoting a
   Ukrainian UI label, a Russian body, a short body).
3. `bridge_report`: warnings, project-scoped id, description. Tests in
   `src/lib/mcp/bridgeReportOrigin.test.ts` and `src/lib/bridge/store.test.ts`:
   the same key from two projects gives two rows, a replay in one project gives
   one.
4. `create_task` / `update_task` warnings, and the locale sentence in the MCP
   session instructions.
5. Seat tick: state fields and rotation carry, the `lastReportAt` input, record
   at wake commit, discharge, both wake lines, the lifecycle projection before
   the journal read, and no report lines while bridge reports are off. Tests
   in `seatTick.test.ts`, `seatTickState.test.ts` and
   `seatTickSources.test.ts`.
6. Mandate v29 and the contract clause, with `prompt.test.ts` fingerprints.
7. `spawnCommand.ts` fallback title from `operatorLocale()`.
8. Telegram: the `reportTelegram` setting, its route case and its reader;
   `get_orchestrator` carrying it; the picker row in the ⋯ menu and sheet,
   with rendered evidence as new cases in the existing drivers
   (`src/components/kanban/kanbanBoard.browser.test.tsx` and
   `src/components/mobile/issue1671Evidence.browser.test.tsx`, beside the
   #2146 cases) at desktop and 390 px, en and uk.
9. `publicSafeReport` table test: paths of each shape, emails, IPs, a tailnet
   host, account ids and labels from a fixture registry (invented names),
   skipped short and generic entries, and ordinary prose left alone.
10. `telegramReportHtml` test: escaping of `<`, `&` and quotes before tags, PR
    links with and without a GitHub remote, `<code>` for short hex, the label
    of the last line in both languages, and the 4096 bound.
11. Fan-out in `src/lib/mcp/bridgeReportOrigin.test.ts` over the bot service's
    fake transport (`src/lib/telegram/bot/fakeTransport.ts`): a manager report
    posts once and records `sent`; a replay posts nothing; a rate-limited send
    is re-sent on replay under a new request id; `send_uncertain` is never
    re-sent; an agent-origin report and a project with reports off post
    nothing; the bridge row survives every refusal; `status` goes silent.
12. **Before/after replay** in `seatTick.test.ts`: a fixture day shaped after
   09-25 (15 outcome wakes, 5 interval wakes, the 6 real report times of that
   span, a 30-minute interval, no operator strings) run through `decide` and the wake
   commit. It asserts that every outcome wake leaves an ask in the next wake
   until a report follows, and that each interval wake where the board moved
   with nothing reported gets a digest line. Before: 5 of 15 outcome wakes and
   0 of 5 interval wakes produced a report. The replay counts asks; whether
   seats comply shows in the log over the following days, and the Deferred
   section says what would follow if they do not.

Gates: `tsc` clean; the touched test files by path under Bun 1.4.0 with an
isolated `LLV_STATE_DIR`; the privacy gate from the merge base.

## 8. Validation against the requirement

| Operator asked | Design |
|---|---|
| More often | R1 makes every settled outcome a report, and the tick keeps asking until it lands. R3 adds a digest per interval while the board moves. |
| Clear rules: when, what, what shape | 3.1 triggers, 3.2 shape, 3.3 keys, 3.4 quiet periods. |
| Short but substantive | 600-character, three-line shape with a warning; bodies say what the change means and leave machine ids out. |
| Regular, catch up after AFK at any moment | Outcome in the turn of its wake, asked again until filed; digest within one interval when anything moved; silence means nothing changed. Survives rotations. |
| Maybe tie to seat ticks | The tick is the enforcement point (5.1). |
| Reports and task text in the selected interface language | One server-side operator setting written by the toggle; named in wakes, `get_orchestrator` and session instructions; warnings on mismatch. |
| Analyse first | Section 1. |
| Each report also in a Telegram group, same content | Destination list: bridge always, plus the project's chosen chat; the Viewer posts the manager's reports itself from the stored body (3.6, 5.6). |
| Operator picks the chat per project | `reportTelegram` project setting, set only from the operator's ⋯ menu or sheet, limited to allowlisted chats. |
| Telegram formatting: bold header, sections, PR links | `telegramReportHtml`: bold project and class header, one paragraph per line, bold Next label, GitHub links for `#PR` (6.6). |
| Public group: no paths, account names, emails, secrets | Rule 3.7 for every report; warnings on every report; the Telegram copy scrubbed of those classes before it is sent. |
| Not in scope: log UI, voice relay | No UI change; the relay reads the same rows. More reports mean more relay batches, which stay within the existing drain caps (5 per batch, one batch per 30 s). |

## Deferred — not currently justified

- **A `report-owed` wake reason** that resumes a seat only to file a report.
  Worth building only if the live log shows seats ignoring the wake lines.
- **Refusing a report in the wrong language.** The requirement asks for a
  warning, and a refusal risks losing the report.
- **Viewer-rendered report bodies** (option 2 in section 2).
- **A coverage metric surface** (outcomes against reports per day on the
  board). The replay test and the tick state answer the question for now.
- **Translating Viewer-authored system cards** (the seat tick's proposal and
  "wake unresolved" cards) into the operator's language. They are Viewer UI
  copy, and the i18n dictionaries own them.
- **Reading replies from the Telegram group** as answers to a `question` or
  `blocked` report. The ask still goes through the operator's chat and the
  attention queue.
- **More than one Telegram chat per project, forum topics, or per-class
  filters** (for example only outcomes to the group). One chat per project
  covers the request.
- **A "posted to Telegram" mark in the report log.** The answer and the row
  record it; showing it would be a log UI change, which is out of scope.
- **Per-device interface languages.** One operator, one language, until
  someone asks for two.
