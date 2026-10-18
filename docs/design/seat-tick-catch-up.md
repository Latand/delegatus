# Seat recovery and catch-up

A native completed turn is sufficient closing evidence even when a bounded
transcript tail no longer contains its opening prompt. The identity-checked
read in `src/lib/lifecycle/transcript.ts` uses the existing native turn decoder.
An open tail still needs its opening boundary; recovery admission, registry
identity checks and seat-epoch fences remain in the tick controller.

The controller records the first observed unreachable time. The gather also
records a gone seat observed by liveness. Failed delivery preserves this time.
The observation bounds the known outage; it does not claim the host died at
that instant. A landed wake clears it. Once it exceeds the configured wake
interval, a wake becomes a catch-up.

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

`unreachableSince` is optional project state: the controller and gather produce
it; the JSON decoder and SQLite accounting preserve it; epoch replacement
resets it. The decision reads it and the landing clears it. A frozen wake's
optional `catchUp` plan records the outage window, one report key and the
previous owed keys observed at preparation. The decision produces the plan;
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
13-hour outage. At most 128 project rings remain; creation evicts the least
recently modified ring. Each append retains bounded files under the existing
journal transaction. Readers fall back to the legacy global file until a
project has its first new check.

Regression coverage lives in `src/lib/monitor/seatTickController.catchUp.test.ts`
and `src/lib/monitor/journalStore.test.ts`: native truncated completed/open tails
through real tick admission, a settled deploy after host loss, 35 held lane
outcomes, a backlog beyond one event page, refused delivery, later events and
process restart, plus a 13-hour history beside a busy peer.
