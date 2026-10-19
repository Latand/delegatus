# Seat recovery and catch-up

A native completed turn is sufficient closing evidence even when a bounded
transcript tail no longer contains its opening prompt. The identity-checked
read in `src/lib/lifecycle/transcript.ts` uses the existing native turn decoder.
An open tail still needs its opening boundary; recovery admission, registry
identity checks and seat-epoch fences remain in the tick controller.

The controller records `unreachableSince` only after a bounded liveness probe
confirms a gone host with a settled or open turn for the designated conversation.
It checks the seat epoch and registry ownership identity again after the probe.
Recovery admission shares that check's observation and rechecks its identity
before dispatch; a replacement seen during the probe waits for fresh evidence
on the next check. After an attempted revival fails, fallback rotation probes
its resulting host again under the existing identity guard.
Missing, unreadable, foreign or unverified evidence leaves reachability unknown.
MCP failure keeps its own diagnosis; queued, busy, outstanding and refused
deliveries keep their normal delivery fences without opening an outage.

`unreachableSince` records when host loss was observed. A separate
`unreachableBacklogSince` freezes the last confirmed wake as the backlog
watermark. The manifest calls its bounds a backlog window. Legacy outage rows
without the watermark retain their existing bound. A catch-up landing clears
both fields. A normal landing clears them only within the interval frozen in
its plan, measured from the backlog watermark. An older already-admitted wake
keeps its immutable payload and preserves a long gap for the next fresh
catch-up. A gap exceeding the configured wake interval becomes a catch-up.

The catch-up gathers all retained, actionable held outcomes through its snapshot:
own lanes, deployments, maintenance, lifecycle events and ready child outcomes.
The ordinary 20-lane, five-deploy, three-maintenance, event-page and agenda limits
continue to apply to ordinary wakes. Catch-up ready tickets are read in pages
of 64, yielding between pages and stopping at the captured ticket sequence.
Unfinished child discovery or ledger reads continue on subsequent checks before
the catch-up is sent. An unreadable source is named as a gap; no outcome is
invented for it. Historical routine events retain the existing eligibility rules.

Each catch-up item includes its source time, or explicitly says the time is
unavailable. Child transcript bodies are omitted. The catch-up carries its
complete compact agenda in one delivery; the ordinary 4,000-character renderer
limit applies to ordinary wakes. Catch-up size scales with held changed work.
This change claims no performance improvement.

The two optional reachability fields are produced only by the controller;
the JSON decoder and SQLite accounting preserve them; epoch replacement
resets them. The decision reads them and the landing clears them. A frozen wake's
optional `catchUp` plan records the backlog window, one report key and the
previous owed keys observed at preparation. The plan also retains the configured wake interval for delayed settlement.
The decision produces the plan;
the controller freezes its text; the legacy decoder and accounting retain it;
the landing verifies complete visible bullets before granting credit. Only
confirmed delivery announces the represented versions. A refused or held send
leaves them owed. Later versions and events remain eligible.

With bridge reports enabled, delivery folds the observed previous debts and
represented outcomes into one catch-up report key. Other debts that appeared
after preparation remain owed. The existing bridge report log discharges the
key through its normal report or `coversOwed` evidence.

The audit keeps its global 500-row ring plus independent 500-row project rings.
The two diagnostic readers select a project before applying their row limit.
At the normal five-minute cadence a project retains over 41 hours, covering a
13-hour outage. Each project retains at most 500 rows regardless of the number
of peer projects. Each append touches its project ring and the global ring
under the existing journal transaction. The first append seeds the project
ring from the matching rows in the bounded legacy global file. Readers use
that global file until the project's first new check.

Regression coverage lives in `src/lib/monitor/seatTickController.catchUp.test.ts`
and `src/lib/monitor/journalStore.test.ts`: native truncated completed/open tails
through real tick admission, a settled deploy after host loss, 35 held lane
outcomes, a backlog beyond one event page, refused delivery, later events and
process restart, plus a 13-hour history beside a busy peer.
