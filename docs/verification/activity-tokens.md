# Activity token store and API

This implements the activity token design (PR #3026): slices 1 and 2 (the
store and the API, plus the Time API's free date range) and slices 3 and 4
(variant 1's Tokens tab, the drawer's tokens section, the chosen extras and
one free range for the whole page). The interface is described under
[Interface](#interface).

## Data and write path

`src/lib/activity/transcriptExport.ts` extracts usage in the existing line
reader. Its persisted state includes the Codex thread, model and preference
for response records. Claude blocks fold by message id and maximum counters.
Codex response records use their own usage; older cumulative events use
per-kind deltas after subtracting the initial inherited baseline.

`src/lib/activity/store.ts` commits token aggregates, dedupe marks and both
cursors together. Existing activity schema version 3 stays readable. Older
cursor writers preserve the new columns, and new cursor rows default to a
token offset of zero. The ingest backfills that gap before reading appended
bytes. Backfill shares the existing byte budget, processes newest files first,
keeps the normal input/turn cursor intact, and yields between 64 KiB chunks.
A line spanning a piece leaves a durable larger-read hint; the next read is
still capped by the remaining pass budget. A partial line never advances the
committed cursor.

The persisted aggregates are UTC conversation-hours (92 days) and local days
(760 days). Claude has a 64-bit response-id set; Codex has a thread watermark.
Pruning removes at most 10,000 rows from each table per pass. Zone changes
persist a bounded phase and key cursor. Preparation and cleanup delete at most
10,000 shadow rows per pass. Hourly scans read at most 500 source rows;
detailed-day and summary copies each read at most 5,000. History pruning is
capped at 10,000 rows per pass.
Ingest updates already scanned rows during scanning, then dual-writes candidate
and active zones during copy. A constant-size metadata update activates the
fully copied generation; readers suppress the candidate while it is partial and
select only the new zone for dates from `zone_since`. Older days retain their
zone. The two shadow-table cleanups resume after restart and keep each pass
bounded. A deleted source loses its cursor while its aggregates remain.

The day table additionally stores its Monday week and a numeric identity for
the model/tier/engine combination. Its key starts with host, zone, day and
that identity. This lets the cost read aggregate adjacent rows before its
final grouping, and avoids computing week boundaries for every retained row.
These are derived fields maintained by the same transaction.

The capacity rehearsal also required a compact daily summary per dimension
and per price combination. `usage_summaries` is updated by each accepted
hour delta in that transaction, retained for 760 days, and pruned at 10,000
rows per pass. Its companion shadow table follows the same zone rebuild and
dual-write rules. Unfiltered reads use these summaries; selected project,
member, account, role, model or engine filters use the detailed day table.
This implementation extension keeps the measured budgets without changing
the transcript pass or adding a request-time scan.

Attribution follows the existing project/role/pipeline resolution. The member
resolver checks launch audit, spawn authorship, parent/launcher, pipeline
creator and task creator, then majority authorship. It reads at most eight
conversations and caches within a pass. Accounts follow the generation at the
response's time, then proven path ownership. An unproved shared-store account
stays unknown.

Writer admission uses `waitForStateLock`; SQLite has no synchronous busy wait.
Both continuous writer entry points use that admission, and opening a writer
requires the startup mutation owner for an operator directory.
The existing ingest operation and the new `activity.usage-backfill`,
`activity.tokens.read` and `activity.time.read` labels identify the work. The
activity-local operation adapter leaves the separately owned central monitor
declaration untouched.

## API contract

`GET /api/activity/tokens` accepts `range=today|7d|30d|90d|365d`, or local
`from`/`to` dates, plus `tz`, `project`, `member`, `role`, `model`, `account`,
`engine`, `stack`, `list` and optional `compare=previous`. The default is seven
days. Future endpoints clamp to today, reversed endpoints swap, and a range
over 366 days moves its start forward. Invalid calendar dates use the preset.

Buckets are hours through two days, days through 92 days, then Monday weeks.
There are at most twelve named chart/list entries and a remainder. Empty
buckets remain present, with coverage identifying dates before recording.
Project aliases fold in filters, lists and chart parts.

The response contains all seven counters: input, cache read, cache write,
one-hour cache write, output, reasoning and requests. One-hour writes and
reasoning are subsets. `costBasis` preserves every model, tier, engine and
kind for the global API price estimate, including unknown models. Cache share
is cache reads divided by all input; reasoning share is reasoning divided by
output. The next stage handles zero denominators and missing prices.

Host totals are available under the existing Activity authority. Every explicit
member/account filter and either private dimension requires owner/solo
authority, checked before opening the store or consulting the cache. A regular
member gets no roster, account ids or account labels in the public dimensions.
The response contains no transcript paths, titles, message bodies or response
ids. HTTP responses use `Cache-Control: no-store`.

The read holds one WAL snapshot over metadata and at most four indexed
aggregate queries. It never opens a transcript or awaits ingest. The report
owns one shared `globalThis` LRU of sixteen entries, keyed by store identity,
usage metadata, complete query, aliases and viewer authority. Entries expire
after a minute; a token commit changes the key immediately. Returned objects
are copied so one caller cannot change a cached answer.

`GET /api/activity` accepts the same date range and presets. Its response
identifies a free range with `range.key = "custom"`. The agent source cache
key includes both endpoints. Daily agent bucketing and daily hour inputs keep
the year-long method from revisiting every retained turn for every hour.

## Verification and measurements

The aggregate-only record is `evidence/activity-tokens/data-api.json`. It
retains raw samples, query plans, dataset shape and hashes of measured source
files. Private snapshots and transcript copies stay in stage scratch.

The ingest comparison uses a `VACUUM INTO` snapshot and scratch copies of all
available Claude/Codex transcripts whose cursor modification time was in
2026-10-17 UTC: 332 files, 909,258,738 bytes. Each sample starts from a fresh
copy of the same store and uses the same inventory and fixed clock. The base
is `b605986a7`. The after pass also records tokens; the usage-only run starts
with old writer cursors at EOF. No source file or live store is changed.
Attribution is fixed in this benchmark to isolate reader/store work. The
launch-chain and generation resolution are checked separately by the tests.

| Ingest, three samples | Median | Maximum |
|---|---:|---:|
| Base | 1,816.7 ms | 1,858.3 ms |
| Tokens and daily summaries | 1,287.2 ms | 1,414.7 ms |
| Usage-only backfill | 1,312.6 ms | 1,341.1 ms |

Every pass reads 909,258,738 bytes, finishes without deferred files, and keeps
the same input/turn result. Both token paths count 24,924 responses into 474
hour rows. The largest after/backfill loop delay is 149.6 ms, below the loop
monitor's 500 ms threshold. The ingest timings establish the added work's
observed cost; no ingest speed improvement is claimed.

Read samples cover 7, 30, 92 and 366 days, seven runs each, on the backfilled
copy and a synthetic capacity copy with 200 daily combinations over 760 days.
The capacity matrix exercises every stack/list dimension. Each query records
wall time, CPU time, involuntary context switches and its real query plan.
The design targets are 7.3 ms per query at 92 days and 33 ms at 366 days.

| Range | Default answer median / max | Any unfiltered query max | Project/member filtered query max |
|---|---:|---:|---:|
| 7 days | 1.01 / 11.27 ms | 0.14 ms | 0.40 ms |
| 30 days | 1.25 / 1.40 ms | 0.31 ms | 1.45 ms |
| 92 days | 2.11 / 2.16 ms | 0.83 ms | 5.29 ms |
| 366 days | 6.06 / 7.77 ms | 1.67 ms | 17.14 ms |

The capacity copy has 152,000 detailed rows and 23,560 summary rows. Its entire
file, including the original activity data, is 43,094,016 bytes. The largest
response in the full dimension matrix is 143,135 bytes. The design's roughly
60 KB estimate was low for seven named counters on every part; the measured
shape remains bounded to 92 day buckets or 54 ISO-week buckets and thirteen
parts. A 366-day range starting on Sunday can intersect 54 weeks; every
requested day stays in the answer.

The Time comparison uses the same populated activity copy, fixed clock and
366-day window. Its complete serialized response has the same SHA-256 before
and after daily bucketing; the record includes the byte count and timings.
The controlled Time rehearsal measures 394.1 ms median / 489.5 ms maximum
before daily bucketing and 51.2 / 172.1 ms after it. Its uncompressed response
is 1,678,287 bytes. These timings cover the read and method; serialization is
excluded from both measurements.

Reproduce from scratch exports with private `HOME`, `XDG_CONFIG_HOME`,
`TMPDIR`, `LLV_STATE_DIR`, and `LLV_VIEWER_CONTROL_URL` on a closed port. Run
each command through `scripts/gate-slot.sh`. An inventory uses the existing
`IngestSource` shape and points only to scratch transcript copies:

```sh
bun scripts/measure-activity-tokens.ts --mode ingest --inventory "$MEASURE_ROOT/inventory.json" --seed "$MEASURE_ROOT/original.sqlite" --output "$MEASURE_ROOT/after/result.json" --samples 3
bun scripts/measure-activity-tokens.ts --mode backfill --inventory "$MEASURE_ROOT/inventory.json" --seed "$MEASURE_ROOT/original.sqlite" --output "$MEASURE_ROOT/backfill/result.json" --samples 3
bun scripts/measure-activity-tokens.ts --mode capacity --seed "$MEASURE_ROOT/capacity.sqlite" --output "$MEASURE_ROOT/capacity-seed.json"
bun scripts/measure-activity-tokens.ts --mode read --seed "$MEASURE_ROOT/capacity.sqlite" --output "$MEASURE_ROOT/reads.json" --samples 7 --matrix true
```

For `capacity`, first copy the original snapshot to the supplied seed path.
For Time timings, place the populated activity copy at the isolated
`LLV_STATE_DIR/activity/records.sqlite`. The ingest benchmark script also runs
on the base when copied into that export; its token imports are deferred.

Regression files cover extraction, both copy orders, forks, subagents, legacy
fallback, record transitions, truncation, held attribution, migration,
rollback, actual process restarts, byte limits, retention, a real peer writer
lock, a zone rebuild with a concurrent update, range boundaries, DST,
authority, alias folding, remainders and cache invalidation/eviction. Existing
Time, ingest, export and pull tests cover their compatibility paths.

Required hosted privacy-tracker and runtime checks run after pipeline
publication.

## Interface

The choices made on the prototype review (2026-10-18) were variant 1, the
cache and reasoning shares plus an estimate at API prices as the optional
extras, seven days by default, members and accounts as separate breakdowns,
and one free range for the whole page, the Time tab included. The last one
replaces §9.2's "the custom range belongs to «Токени» only".

- `src/components/activity/ActivityTokens.tsx` reads
  `GET /api/activity/tokens` while the tab is shown, once a minute while the
  page is visible, and draws the total with its coverage dot, the kind meter,
  one stacked column chart and «Розбити за». The chart stacks by the list's
  choice; «Тип» stacks by kind. The seven largest entries take a colour and
  the rest fold into «Інші», so a list row and its column share one colour.
  On the phone a range over 31 days draws Monday weeks.
- A row filters the page: a project scopes both tabs, a member sets the
  page's member, and a role, model or account adds a chip that clears it.
  Member and account breakdowns are offered only when the answer says
  `canChoose`; the route refuses them otherwise, and a refused link drops the
  member, the breakdown and the account filter.
- The project picker's rows come from one `list=project&top=all` read when it
  opens. `top=all` raises the list's bound from 12 to 500 named rows; the
  answer still holds one row of the rest beyond it.
- `src/lib/activity/tokenPrices.ts` is the dated price table (read
  2026-10-18 from the providers' pricing pages), per model and tier, with
  five-minute and one-hour cache writes priced apart. A model or tier with no
  published price reads «—» and stays out of the sum; the estimate's tooltip
  and the drawer name those models. The figure is labelled an estimate at API
  prices and never called spending.
- `src/components/activity/ActivityRangeControl.tsx` is the page's one range
  control: Today, 7, 30 and 90 days and «Період…», two native date fields
  that apply once both are valid and keep at most 366 days. The address
  carries `range` or `from`/`to`, `view` and the breakdown. The Time tab
  reads the same range; past 92 days its chart draws one pair per Monday week,
  and a range of one date draws hours.
- The drawer opened from the Tokens tab holds the tokens section: coverage,
  what one count is, which engines report, the zone notes, and the price
  table's date and sources.

Rendered evidence comes from the board-geometry driver's `activity-tokens`
case over `src/lib/activity/tokenEvidence.fixture.ts` (invented history
written through the ingest's own commit) and is recorded in
`evidence/activity-tokens/ui.json`: fourteen states (seven days, the free range
open and applied, one project, by member, by account, by kind, the coverage
popover, the drawer, a range wholly before counting, loading, a failed read,
nothing counted yet, and the Time tab on the free range) at 1440, 1024 and
390 px, light and dark, Ukrainian and English, 168 frames with no failed check,
made from the commit the record names. A range that starts before the first
counted moment reads as a lower bound (amber dot, a leading ≥), and one wholly
before it says it is not counted. The frames stay outside the repository.

The Time tab over 366 days, measured in the same run on that revision
(production build, one Chromium, through `scripts/gate-slot.sh`) over a store
with 142 workdays of human input and agent runs: five reads of
`GET /api/activity` took 106.2 to 131.1 ms over HTTP for a 1,718,684-byte
answer, and the page drew 53 week columns, 12,199 elements and two long tasks
(102 and 91 ms), loaded 597 ms after navigation. The weeks before the ledger's
retained 90 days draw as not read. The populated read in isolation is the
controlled rehearsal above (51.2 ms median, 172.1 ms maximum).
