# Activity "у звіті" matches the daily #звіт

Status: diagnosis, and the fix as built. The fix follows the operator's
correction of 2026-09-26 (below), which replaced the first plan's paid-only
count.

## Originating requirement

The pinned specification of this task, as the orchestrator relayed it on
2026-09-26. The operator's words inside it are the orchestrator's English
paraphrase. The two paid client projects are written here as paid project A
(the main one) and paid project B, and the operator's second Delegatus host as
the stage host.

> Operator request (2026-09-26, paraphrased): the per-project time on the
> Activity screen differs from what the operator sends in the daily work-hours
> report (#звіт #cron_work_daily); fix the time collection so they agree.
>
> Ground truth: the 2026-09-24 recount (`audit.md`, `reports.md`). Method as
> written there: Europe/Kyiv; paid projects only; operator human-input records
> from BOTH the workstation and the stage host; agent relays, seat
> notifications, generated role prompts and duplicates (identical within 90 s)
> excluded; each accepted operator message opens a 10-minute window; windows
> merged per clock hour; an hour with 10-39 min = 0.5 h, 40+ min = 1 h; one
> hour goes to one project. Figures: 21.09 6.5 h, 22.09 11.5 h, 23.09 8.5 h.
> Activity today (prod, 7-day view, paid project A "у звіті"): 21.09 6,
> 22.09 11.5, 23.09 5.5, 24.09 3.5, 25.09 8.
>
> Stage "build" implements it with tests that fail on main (the replayed day
> reproduces a known gap) and pass after, and shows the recomputed 19-25.09
> table in the PR body next to #звіт. Also fix #2136 and the #2171 marker
> mismatches if the diagnosis shows they touch these figures. NOT in scope:
> dashboard redesign, agent-hours, the phone layout beyond what #2171 needs.

### Operator correction, 2026-09-26

Paraphrased: there is no paid / not-paid distinction to build. The operator
works on several projects in parallel all the time, usually three at once,
and that is normal. So:

1. **Per project**, each project's hours are counted independently, from that
   project's own operator messages only, with the same 10-minute window and
   hour rounding (10-39 min = 0.5 h, 40+ = 1 h). Projects never compete for a
   clock hour, and one hour can count for several projects.
2. **Total** ("all activity"): the union of every project's message windows,
   clumped together, with the same rounding. The sum of the per-project
   figures is therefore normally larger than the total, which is expected.

The billable `settings.json` path is dropped from this change. The send-route
defect (G2, F2) stays.

## Answer first

Most of the gap has one cause. Activity lets every project compete for a
clock hour: the hour goes to the project with the most of its minutes, and a
project's figure is the hours it won. The #звіт counted the paid project from
its own messages. Counted from its own messages alone, as the operator's
correction asks for every project, paid project A reads **21.09 6.5 h and
23.09 8.5 h, with the same credited clock hours the audit lists**
(`audit.md:22`, `audit.md:24`). The day's total (the union of every project's
windows) does not move.

The rest are input differences, and most of them are the recount's. The
#звіт recount excluded some genuine operator messages by text prefix and by
reading their content, contrary to its own written method, and it missed one
message. On the other side, Activity counts one real defect: agent relays that
a script posted through the stage host's Viewer HTTP send route. That route
recorded every caller as the operator. That defect costs 0.5 h on 22.09 and is
fixed at the send boundary, going forward only.

#2136 and #2171 do not touch these figures.

## What was observed

Every source was read, read-only.

- **The recount's result.** `$HOME/Projects/zvit-catchup/2026-09-24/audit.md`
  and `reports.md`.
- **The sent #звіт.** Read through the Viewer's read-only Telegram connector,
  with nothing sent or edited. The operator posted one catch-up message in the
  client's managers group on 2026-09-24 at 07:46 UTC. It covers 09.09-23.09,
  and its figures are identical to `reports.md` for every day, except that it
  leaves out the 18.09 project-B line (0.5 h). As of 2026-09-26 no #звіт was
  sent for 24.09 or 25.09. The nightly generator
  (`$HOME/.agents/automation/zvit/`) last succeeded for 2026-09-03 and uses the
  older 30-minute-episode rule, so it produced none of these figures.
- **The recount's working.** Its scripts were deleted from the catch-up
  folder, but the Codex session that ran it survives (the rollout of
  2026-09-24 09:09 Kyiv under the operator's Codex account store). Line
  numbers below refer to that JSONL.
- **Activity.** Prod `GET /api/activity?range=30d`, unscoped and scoped to each
  paid project. Both hosts read complete for every day 19-26.09. Billable is
  not configured (`billableConfigured: false`).
- **Activity's inputs.** A copy of `activity/records.sqlite` and the request
  ledger, replayed with this repository's own `readHumanInputs` and
  `activityReport` under Bun 1.4.0, with `LLV_STATE_DIR` pointed at the copy.
  The replay reproduces prod exactly: 3 / 2.5 / 6 / 11.5 / 5.5 / 3.5 / 8 for
  19-25.09.
- **The stage host.** Read over ssh with read-only scripts: its transcripts,
  and its Claude delivery ledger (`state/claude-delivery-ledger`), which
  records each delivery's origin and whether the composer captured a selection.

## Day × source table, 19-25.09

Paid project A, in hours. Paid project B has no input in any source on these
days (#звіт 0, Activity 0, replay 0), and its 17.09 and 18.09 figures (0.5 h
each) agree between `reports.md` and Activity.

| Date | #звіт sent | Activity today | Replay, own count (F1) | F1 with relays removed (F1+F2) | F1 − #звіт |
| --- | ---: | ---: | ---: | ---: | ---: |
| 19.09 | 2.5 | 3 | 3 | 3 | +0.5 |
| 20.09 | 3.5 | 2.5 | 4.5 | 4.5 | +1 |
| 21.09 | 6.5 | 6 | 6.5 | 6.5 | 0 |
| 22.09 | 11.5 | 11.5 | 12.5 | 12 | +1 |
| 23.09 | 8.5 | 5.5 | 8.5 | 8.5 | 0 |
| 24.09 | not sent | 3.5 | 7.5 | 7.5 | — |
| 25.09 | not sent | 8 | 11 | 11 | — |

F2 applies only to deliveries after it ships (see F2), so history keeps the F1
column. The F1+F2 column shows what the relays weigh. Paid project B had no
input on these days, so project A's own count here equals the paid-only
count the first plan proposed.

The day's total over every project is 10 / 9.5 / 9 / 14 / 11.5 / 13 / 13 for
19-25.09, before and after F1: the union of every window, weighed per clock
hour, is what the winning projects' weights already added up to. The
projects' own counts add up to 13.5 / 11.5 / 12.5 / 23.5 / 23 / 27.5 / 19.5.

The 22.09 match in "Activity today" is a coincidence. G1 moves that day by
+1 h net: +2 h of hours lost to other projects, −1 h of weights raised by
other projects' minutes. The recount's departures (G3) move it by −1 h. The
two cancel.

## Counting rules compared

| Rule | Activity | #звіт recount | Differs? |
| --- | --- | --- | --- |
| Zone, day and hour buckets | Europe/Kyiv, per input time (`method.ts:92`, `method.ts:376-380`, `method.ts:497-499`) | Europe/Kyiv (`audit.md:3`; rollout line 637) | no |
| Window per message | 10 min, `T = W` (`method.ts:92`, `method.ts:394-421`) | 10 min (`audit.md:13`; rollout line 637, `timedelta(minutes=10)`) | no |
| Merge within the hour | union of windows (`method.ts:497-518`) | union of spans per hour (rollout line 1158) | no |
| Hour weight | <10 → 0, 10-39 → 0.5, 40+ → 1 (`method.ts:482-487`) | the same (`audit.md:13`; rollout line 1158) | no |
| Duplicates | same id, or same content within 90 s (`humanInput.ts:34`, `humanInput.ts:401-441`, `humanInput.ts:443-480`) | same digest within 90 s (rollout line 1158; `worktime_zvit.py:336-349`) | no effect seen |
| Hosts | workstation ingest plus stage pull, both complete (`hostSources.ts:343-373`) | workstation plus stage probe (`audit.md:7`, `audit.md:11`; rollout line 1014) | no |
| **Which projects compete for an hour** | **every project** (`method.ts:526-540` over all segments; `method.ts:976-981`; scoped view `method.ts:1178`, `method.ts:1201`) | **paid projects only** (`paid_recalc.py` keeps only paid inputs, rollout line 637; 22.09 combine keeps only project A, rollout line 1158) | **yes: G1** |
| Minute ownership inside an hour | the most recent input (`method.ts:431-471`) | project B first, then alphabetical (rollout line 293) | no effect: B has no input |
| Which records are operator input | positive signal: marker, delivery provenance, typed flag (`humanInput.ts:262-288`) | marker or Cyrillic text, minus a relay-prefix list, minus manual judgments (rollout lines 637, 1158) | **yes: G2, G3** |
| Project attribution | conversation context (`conversationResolver.ts:21-36`) | working directory, then keywords, then manual moves (rollout lines 637, 1158) | **yes: G3** |
| A window crossing midnight | its minutes land in the next day's 00:00 hour (segments are global, clipped per day, `method.ts:497-499`) | each day counted from that day's messages only (rollout line 1158) | no effect in 19-23.09 (22.09 00:00 is 28.6 min in both) |

## Causes, with evidence

### G1. Every project competes for the hour (Activity) against the project's own messages (#звіт)

`dayReportHours` gives each clock hour to the project with the most of its
minutes, over every project's segments (`method.ts:497-518`, `method.ts:526-540`).
A paid project's "у звіті" figure is its share of that (`method.ts:976-981` for
the row, `method.ts:1178` for the scoped view). The #звіт drops every non-paid
input before counting. The operator said on 2026-09-24 that the #звіт covers
only the two paid projects (rollout line 585). The recount's final script then
kept only paid inputs (rollout line 637), so project A was counted from its
own inputs, with no other project in the hour. Activity never counted a
project that way: even its billable pass (`method.ts:853-859`) lets the
billable projects compete, and prod has no billable tags.

G1 makes two opposite errors:

- **An hour lost to a non-paid project.** On 23.09 at 01:00 and 02:00, project
  A's own inputs cover 44 and 45 minutes, and the audit credits both hours at
  1 h (`audit.md:24`). Activity gave both hours to Delegatus, which had more
  of their minutes (50.7 and 59.6 minutes across all projects). The same
  happens at 09:00, 13:00, 17:00 and 18:00 on 23.09, at 15:00 on 21.09, and at
  12:00, 20:00 and 22:00 on 22.09.
- **An hour's weight raised by other projects' minutes.** When project A wins
  an hour, the weight comes from the whole hour's coverage. On 19.09 at 20:00,
  project A had 22.7 minutes and the hour 48.7, so Activity credited 1 h. The
  recount counted 16.6 minutes and 0.5 h (rollout line 1282). The same happens
  on 23.09 at 00:00 and 10:00, and on 22.09 at 00:00 and 23:00.

Counting each project from its own messages fixes both. It moves 21.09 from
6 to 6.5 and 23.09 from 5.5 to 8.5, and on both days the credited hours are
exactly the ones the audit lists.

### G2. Agent relays posted through the stage host's HTTP send route count as operator input (Activity defect)

On 22.09 an agent in a workstation conversation of project A ran scripts on
the stage host over ssh (tool calls at 07:08, 07:36 and 08:32 UTC). The
scripts posted bracketed relay messages ("from the local orchestrator…") to the
stage Viewer's `/api/runtime/send`, using the operator's token.

- That route stamps `origin: { kind: "operator" }` on every delivery
  (`src/lib/runtime/http.ts:314-316`; the queued variant does the same at
  `src/lib/runtime/nativeQueueHttp.ts:72`).
- Its operator check admits any caller that shows no agent capability
  (`src/lib/agent/operatorAuthority.ts:191-195`, used at `http.ts:262` and
  `http.ts:275`).
- The stage ingest then reads the ledger's origin as provenance
  (`claudeMessageProvenance.ts:76-81`, `conversationResolver.ts:44-49`) and
  counts the record as a message (`humanInput.ts:278`).

The stage delivery ledger tells these apart. Every genuine composer send of
project A on 22.09 (66 of them) carries a composer capture with a device id.
The relays carry `origin: operator` and no capture. Activity holds 13 such
stage inputs over 19-25.09: 10 on 22.09 (the relays, English scripted
instructions, and a generated verifier role prompt), one of Delegatus on 23.09,
and two on 25.09. On 22.09 they add minutes to 00:00, 01:00, 02:00, 10:00,
11:00, 15:00 and 17:00 without changing those weights, and they alone make the
22:00 hour (0.5 h).

This defect belongs to the same family as #2136: an agent-authored delivery
arrives with operator authorship. The path is different, though, and #2136's
fix would not cover it.

### G3. The recount departed from its own written method (the #звіт is off)

These are the residuals in the last column of the table. Activity follows the
written method in each case.

- **Operator turns dropped by a text prefix** (19.09 +0.5 h, 20.09 +0.5 h).
  The recount rejected every record beginning "While you were away the manager
  reported:" (the relay-prefix list, rollout line 637). That text is the
  voice gateway's digest, which Delegatus prepends to the operator's own next
  turn (`src/lib/bridge/service.ts:199-230`, header at line 214). The records
  continue with the operator's own words, as verified on two of them. Activity
  counts them on their operator marker (`humanInput.ts:278`). There are seven
  such inputs, five on 19.09 and two on 20.09. Removing them from the replay
  gives 19.09 exactly 2.5 h and 20.09 4 h.
- **A composer send dropped by reading its content** (20.09 +0.5 h). The stage
  input at 10:00 was typed into the stage Viewer's web composer (its delivery
  carries a composer capture with a device id). Its text is a report addressed
  to the operator, most likely pasted. The recount listed it (rollout line
  1232) and judged it not relevant (`audit.md:15`). Removing it too gives 20.09
  3.5 h, the #звіт figure.
- **Operator messages moved to another project by content** (22.09, the 10:00
  hour). Two operator messages typed at 10:36 and 10:37 in a project A
  conversation were reclassified to Delegatus because of what they asked for
  ("viewer-task", rollout line 1158). The operator's standing rule is to
  attribute projects from the conversation's context, never from words in the
  text. Without these two messages, the hour holds 37.0 minutes, which is the
  recount's figure (rollout line 1160). With them, project A's own count
  gives 40.4 minutes even after F2, so 1 h.
- **An operator message missing from the recount** (22.09, the 01:00 hour).
  The recount credits 39.3 minutes (rollout line 1160). That is exactly
  Activity's 49.3 minutes minus one input: an operator composer message on the
  stage host at 01:12. It is not in any of the recount's rejection lists. The
  intermediate files are gone, so why it was missing cannot be recovered.
- **A message Activity does not hold** (22.09, the 22:00 hour, −0.5 h after
  F2). The recount credits one message and 10 minutes at 22:00. The only
  project A input Activity holds in that hour is the scripted relay of G2,
  which the recount itself rejected (rollout line 1127). The recount's message
  is therefore one Activity never accepted, most likely an unmarked record
  (`humanInput.ts:288`).

Net for 22.09: +0.5 h (01:00) +0.5 h (10:00) = +1 h with F1, and −0.5 h more
with F2 (22:00), giving +0.5 h.

### Checked and ruled out

- **Stage host not read, or read only partly.** Both hosts read complete for
  every day. Project A's stage inputs number 4, 3, 0, 79 and 56 on 19-23.09.
- **Timezone boundaries, window, rounding, dedupe.** Identical, as the table of
  rules shows. The one structural difference, the midnight spill, moves no
  figure in 19-23.09.
- **#2136 (mandate deliveries on Codex seats marked as operator input).** None
  of project A's accepted inputs on 19-25.09 is a seat mandate. Every accepted
  input was checked against the recount's relay and role-prompt prefixes, and
  none begins as a mandate. This issue does not touch these figures.
- **#2171 (lower-bound and unknown marks).** It changes marks, never figures,
  and every day here reads complete. It does not touch these figures.
- **A generated role prompt counted as an operator spawn.** The stage input at
  08:47 on 23.09 is a generated research prompt, the first message of a
  conversation the stage registry records as launched by the operator
  (`humanInput.ts:278-284`). Its hour weighs 0.5 h either way, so no figure
  moves. See Deferred.

## Fix plan

### F1. Each project counts its own hours; the total counts the union

This fixes G1 and carries nearly all of the gap.

- `src/lib/activity/method.ts`: `intervalReportHours(intervals, day,
  rounding)` weighs one union of time over a day (clock-hour weights per clock
  hour, or the half-hour rounding of the day). In `activityReport`, each
  project's row and its `days[].projects[]` entry take it over the project's
  own episodes, and the day's `humanHours` takes it over every project's time
  together. In `projectView`, the project's `humanHours` and its hour cells'
  weights come from its own episodes, so the cells still add up to the day's
  figure.
- Minutes are unchanged: the by-the-minute figures still count one minute
  once, so a project's minutes and its hours are counted differently, as the
  hours were before. The unscoped hour cells keep their colour (the project
  with the most of the hour's minutes); the billable figure keeps its own
  count.
- The note explaining the figure says each project counts on its own and the
  total counts the windows together, and one line says the projects' hours
  usually add up to more than the total: `activity.counted.clockHour`,
  `activity.counted.halfHour`, the new `activity.counted.parallel`, and
  `activity.drawer.m2` / `m2Half`, in `src/lib/i18n/uk.ts` and `en.ts`.
- No settings file and no deploy step: the rule applies to every project.

### F2. The HTTP send route attributes by evidence, not by assumption

This fixes G2, going forward only.

- `src/lib/runtime/http.ts:316` and `src/lib/runtime/nativeQueueHttp.ts:72`
  stamp `origin: { kind: "operator" }` only when the request comes from a
  browser: no agent capability, and fetch metadata present
  (`sec-fetch-site: same-origin`, which `src/lib/sameOrigin.ts:69` already
  reads). Any other caller is delivered as before, attributed
  `{ kind: "agent", role: "api-client" }`, and writes no request-ledger row
  (`http.ts:275-281`). Nothing is refused; the delivery is only attributed
  honestly. The first-party callers are browser components
  (`src/hooks/useRuntime.ts`, `src/components/TmuxComposer.tsx`,
  `src/hooks/useNativeQueue.ts`). The check is `operatorBrowserRequest` in
  `src/lib/agent/operatorAuthority.ts`; the operator's WakaTime activity and
  the retirement of reply drafts, which read the same flag, follow it. The
  task send route (`src/app/api/tasks/[id]/send/route.ts`) stamps its own
  operator origin and is unchanged, and no server-side caller posts to either
  route (the forwarders that set the header, such as
  `src/lib/pipelines/controllerSignal.ts:32`, target other routes).
- The ingest needs no new rule. An agent-origin delivery is already excluded
  as `agent-message` (`humanInput.ts:274`).
- **Why forward only.** The stored history has no reliable way to tell a
  scripted send from the operator. On the workstation, operator-origin Claude
  deliveries without a composer capture include genuine operator messages
  (voice, answers, task sends) next to orchestrator notes. So "no capture" is
  not a safe retroactive rule, and excluding by text prefix is what went wrong
  in G3.
- **Where it takes effect.** The stage host classifies its own records with
  its own install and the pull only copies the result rows
  (`src/lib/activity/pull.ts:36-40`). F2 therefore reaches the stage host only
  when its install is upgraded. That is a separate, operator-gated deploy,
  because restarting that host's Viewer affects the agents running there.

### Tests

Each test runs by path under Bun 1.4.0 with an isolated config root, and each
fails on main.

1. **Replay of a sanitized fixture day** (`src/lib/activity/method.test.ts`
   over `src/lib/activity/replayDay.fixture.ts`). The 23.09 inputs, replayed
   through `readHumanInputs` over a copy of `records.sqlite`, keep only each
   input's offset in seconds from local midnight, its kind and surface, the
   project renamed `paid-a` / `other-N` and the host `host-a` / `host-b`. No
   id, hash or text. Project A's row, day entry and view read 8.5 h, with
   01:00 and 02:00 at 1 h (main: 5.5 h); the day's total reads 11.5 h and the
   projects add up to more.
2. **Parallel projects** (`method.test.ts`): three interleaved projects each
   take the hour; the total takes it once; another project's minutes neither
   take a project's hour nor raise its weight.
3. **Scoped response** (`src/lib/activity/report.test.ts`): two projects
   sharing an hour each read 1 h on their row and their own page; the page's
   total reads 1 h.
4. **Send attribution** (`src/lib/runtime/http.activityLedger.test.ts`,
   `src/lib/runtime/nativeQueueRuntime.test.ts`): a request without fetch
   metadata is admitted with the `api-client` agent origin and writes no ledger
   row; a same-origin page request keeps the operator origin and its row.

### PR body table

History, recomputed with F1, project A: 19-25.09 = 3 / 4.5 / 6.5 / 12.5 /
8.5 / 7.5 / 11, next to the #звіт (2.5 / 3.5 / 6.5 / 11.5 / 8.5 / not sent /
not sent) with the G3 line for each residual day, and the total.

## Options considered for F1

- **Chosen: each project from its own messages, the total from the union.**
  The operator's rule of 2026-09-26. It needs no configuration, and it matches
  the #звіт for project A wherever the recount followed its method.
- **Paid projects only compete for an hour** (the first plan: tag the paid
  projects in `settings.json` and read the billable pass). It gives the same
  project A figures here only because project B had no input, it needs a
  settings file, and it still makes parallel projects compete. Withdrawn by
  the operator.
- **Reproduce the recount's content judgments.** A prefix list and a person's
  reading of the text cannot be automated faithfully, and doing it contradicts
  the context-attribution rule. Rejected. The residuals are documented
  instead.

## Deferred — not currently justified

- **Retroactive exclusion of the historical scripted relays.** No reliable
  signal exists (see F2), and text heuristics are what produced G3.
- **Spawn attribution at the HTTP spawn route** (the 23.09 08:47 generated
  prompt). It is the same boundary as F2 (`src/lib/agent/spawnCommand.ts:649`,
  `:907`), but it moves no figure here.
- **Stage home-directory sessions counted as project A.** The stage host has an
  unnamed project for its home directory (1.7 h over 30 days, mostly 19.09 and
  22.09). Context attributes these sessions to the home directory, and the
  recount did not count them either.
- **The midnight-spill difference.** No effect in the observed days, and
  Activity's handling is what the written method says.
- **#2136 and #2171.** Neither touches these figures. They stay their own
  issues.

## Validation against the requirement

After F1, the "у звіті" figure of each project is its own messages' windows,
weighed per clock hour, from both hosts, and the total is every project's
windows together. For project A it matches the sent #звіт wherever the
recount applied its method (21.09, 23.09). Where it differs (19.09, 20.09 and
22.09, by 0.5-1 h), each hour of difference is traced to a named recount
departure, or to the relays that F2 stops going forward. Agreement on those
days would need Activity to repeat the recount's manual judgments, which the
requirement's own method excludes. The operator should know that the sent
#звіт for those three days is off by those amounts.
