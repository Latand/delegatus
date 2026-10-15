# Full autonomy mode

## 1. Accepted design and provenance

The unmerged prototype at `226235e2e47c2782ea345a00c29ef4367aab7e95`
explored three chip borders and the timed switch. The operator's answers on
2026-10-15 at 05:47Z select variant 1, «Змійка», all decisions outside §5,
Inbox → issues → maintenance → own findings, and one report at the episode's
end. Releases may skip `askBeforePublish` while autonomy remains active;
the other release gates still apply. These answers supersede the prototype's
proposed release prohibition and its unanswered questions.

This implementation uses current main's settings store, wake accounting,
form delivery and Done projection. Native caller association still requires
an authenticated operator. The prototype's local browser state is replaced
by the project's persisted setting.

## 2. Per-project setting

### 2.1 Duration and persistence

Autonomy is off by default. Enabling it starts an episode with an eight-hour
deadline. The duration choices are 8, 12, 24 hours and unlimited. A duration
change measures from the time it is saved, retaining the episode's start and
its decisions. The API accepts 1–8760 hours, or `null` for unlimited; values
outside that range are clamped to the nearest bound. Expiry is evaluated on
reads, so a stopped Viewer cannot keep a past deadline active after restart.

The row keeps the start, deadline, end reason, actor, timestamps, decisions
and report acknowledgement. Starting another episode retains the ended one
in history. A report remains owed until it has been stored. Changing the wake
schedule or letting that schedule expire preserves the episode.

### 2.2 Authority and wakes

Only the operator enables or extends autonomy. The designated seat in the
same project may shorten it or turn it off with a reason. Quoting an operator
request gives the seat no extension permission. Workers and other projects
cannot change it. The actor comes from the existing caller authority.

Enabling autonomy requires wakes to be enabled. The panel enables both in
one draft and saves them together. Turning wakes off ends the episode. Its
end report is still owed; that reporting exception carries no work agenda.

### 2.3 Panel

The section sits below the wakes switch in the shared desktop and phone
body. It uses the panel's existing Save action. The status shows the deadline
and time left, or unlimited duration. Details show attribution and the
decision log with each undo path. A new log entry preserves an unsaved
duration draft. The UI uses the application's Ukrainian and English locale
catalogues; Russian is not currently an application locale.

## 3. Wakes

Every active wake carries the autonomy overlay. The first landed wake in an
episode, after a duration change and after a seat rotation carries the full
rules. Later wakes carry a pointer to that episode and the current deadline.
The overlay reserves its space ahead of agenda truncation. Off and expired
episodes carry no autonomy authority. The seat rechecks the setting before
acting; an earlier delivered wake cannot extend the episode.

Inbox cards become eligible work. With no active work, `autonomy-idle`
replaces the ordinary proposal wake and includes the existing issue and
signal sources. The schedule and worker limits still apply. Two unchanged
landed idle wakes exhaust the existing retry guard until evidence changes.

`autonomy-ended` is due on the next check after expiry or switch-off. The
landed request is recorded per episode. A report still owed is reminded at
the configured wake interval. Busy-seat delivery and the existing accounting
fence still govern delivery.

## 4. Decisions and work

The overlay suspends the standing mandate's asking and unsolicited-work
rules for decisions outside §5. The seat resolves parked stages, chooses
variants and answers open forms. It records each decision through
`seat_tick_settings.autonomyDecision`, with an episode start, stable id,
what it chose, why, and how the operator can undo it. A repeated id accepts
the same content; conflicting content is refused.

The optional `review` payload settles a saved form through its existing
validation and delivery path. The choice is attributed to the seat and the
operator can amend it. The log retains pending, saved and refused form
settlements so a failed application is visible and can be retried. Native
caller association is excluded. A second settings read inside form mutation
refuses a choice whose episode has ended.

Within free worker slots, source new work in this order:

1. Inbox cards, prioritizing work marked autonomous.
2. The project's open GitHub issues.
3. Board-maintenance suggestions.
4. The seat's own findings.

Mark new work autonomous. Prefer small, reversible work with verification
and review. Keep accepted work moving under the existing merge, credit and
deploy rules. Decisions covered by §5 wait as ordinary forms.

## 5. Forbidden actions

1. Publication outside the release flow. Within that flow only an active
   episode may skip `askBeforePublish`, while enabled, gap, change count and
   hold gates remain satisfied. Expiry or switch-off restores the stored
   approval requirement. No hand tags or package publication outside it.
2. Changes to other projects. A handoff to their seat keeps its existing
   permission; that seat acts under its own setting.
3. Account, spending, binding, migration, worker-limit and role-mapping
   changes, including paid generation. The credit guard remains in force.
4. Operator-owned settings and sessions. This includes merge, release,
   auto-rotation and bridge settings. The seat may only shorten autonomy.
5. Destructive actions: history rewrites, default-branch force pushes,
   deletion or closure of others' work, user-data or state deletion, and
   restarts beyond the project's standing deploy permission.
6. Outward messages: public issues, comments on others' work, bug reports,
   Telegram messages and posts. Normal project PRs remain lane output.
7. Other machines and SSH outside this project's own deploy path.

The mode is a time-bounded seat mandate. It preserves the existing execution
and authentication gates; it does not grant new account or operator authority.

## 6. Composer chip

Variant 1, «Змійка», is a violet segment with a smooth tail travelling along
the chip's rounded outline at constant speed, one lap every four seconds.
SVG path-length animation keeps speed even around the ends. The thumb still
shows cadence and the health dot still shows health. The accessible value
and title name autonomy and its deadline or unlimited duration.

The ring mounts with the switch in desktop and phone hosts. Light and dark
use the existing violet token. Reduced motion draws a solid static outline.
The phone board badge and a countdown inside the thumb remain deferred.

## 7. End report

The seat files one `bridge_report`, class `status`, outcome `autonomy`, with
key `autonomy:<episode start>`. It covers completed work with links, every
decision and undo path, newly started tasks and their state, forbidden
choices waiting for the operator, and problems. It appears in Done through
the existing report projection. This local report is recorded even when
bridge reports are disabled; that case sends no Telegram copy.

The tool returns the stored `chatText` and the wake instructs the seat to
repeat it exactly in its conversation. Replays return that same text and
retain one stored report. A report acknowledgement merges into the latest
settings row, preserving a concurrently started episode or duration edit.

## 8. Verification and evidence

Tests cover the setting and HTTP/MCP lifecycle, caller refusals, exact expiry,
independent schedule expiry, decision replay, form attribution and native
association refusal, the overlay's delivery accounting, idle guard, report
idempotency and Done projection, and the current release approval setting.
They run by explicit path with isolated state through the project gate.

The existing `kanbanBoard.browser.test.tsx` driver owns the full-autonomy
case: 1440 and 390 pixels, light and dark, both application locales, saved
settings, undo log, exact sought motion phases and reduced motion. The desktop
matrix includes the board header and the production `OrchestratorDock` at
440 and 360 pixels wide, mounted through the shared fixture's `dockWidth`
parameter. Every host records visibility, ancestor clipping, obstruction and
ring/track position and size in off, active, reduced-motion and ended states.
The dock also has full-host frames for off, active and reduced motion.
`evidence/full-autonomy.json` records the measurements and frame names.
Frames stay outside tracked files and are referenced in the PR. No new capture
driver or global mandate version is introduced.
