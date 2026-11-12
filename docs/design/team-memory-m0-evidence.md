# M0 selection profile

Run `scripts/profile-role-selection.ts --seed`, then the same script without
`--seed` under `bun --cpu-prof`, in a scratch export. Supply a private HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR beneath TMPDIR, and set
LLV_VIEWER_CONTROL_URL to a closed loopback port. Never use an installed store.
Keep the seeded store between the before and after runs.

## Before changing the implementation

The initial profile was recorded before any implementation edit, on
2026-11-11 against main `4cfb3730da`, after #3834, #3841 and #3857. It used
251,550,316 bytes of history: snapshot reads took 150.7 to 215.3 ms and the
largest heartbeat intervals were 1,341.1 to 1,594.3 ms. Those raw logs remain
with the stage evidence.

The tables below are the final paired reproduction, after the fixture's undo
metadata was made type-correct. The payload shape and load are the same on both
revisions; this final store has slightly more metadata than the initial one.
The synthetic store has 178 scope rows, 253,873,356 bytes of inline history,
1,097 active rules and a 193-rule launch pool, with 40 curator entries per
scope. The largest history is 50 MB;
the next five are 12 MB each. The history drain is off. The load is five
rounds of eight concurrent first selections with no provider key, under the
`memory.select` operation label, with a 5 ms loop heartbeat. Seeding is outside
the timed and CPU-profiled run.

| Round | Eight starts, ms | Largest heartbeat interval, ms | Thread read bytes |
| --- | ---: | ---: | ---: |
| 1 | 2568.4 | 2547.0 | 2,033,337,628 |
| 2 | 1875.1 | 1818.1 | 2,031,584,382 |
| 3 | 2100.8 | 2069.0 | 2,031,584,306 |
| 4 | 2038.5 | 2004.7 | 2,031,584,345 |
| 5 | 2228.0 | 2199.1 | 2,031,584,421 |

Individual snapshot reads in the final base reproduction take 200.6 to 746.3 ms. No selector timed out in this
load. Installed traffic needs its separate check after deploy.
The CPU profile puts most samples in SQLite `all` under the scope-membership
projection: it still parses every scope's inline history to extract membership.
#3857 already removed the full decoded collection copy; #3841 provides separate
history rows but ships its drain off. The remaining own-scope SQL parsing is
outside the selector clock and cannot be made cooperative by its loop budget.

Before touching the selector, the corpus in
`src/lib/memory/roleSelectionCorpus.fixture.ts` was run against this base.
`roleSelectionCorpus.expected.json` pins the selected ids, order, rounded scores,
rendered UTF-8 byte length and SHA-256 for 100, 250 and 650 rules, plus a
four-byte-text case reaching the byte ceiling. All data is synthetic.

## What each part needed

| Part | State |
| --- | --- |
| 1. Profile | Built here: the repeatable isolated driver above, CPU samples, thread read bytes, heap size, RSS, heartbeat and phase times. Raw private profiles remain with the stage evidence; aggregate results are in `evidence/role-selection-profile.json`. |
| 2. Start's read | #3857 already removed the whole collection copy and fetched active rules by key. Built here: scope membership is also fetched by key, including project alias predecessors, in original stored order. #3841's history-row format remains unchanged. |
| 3. Score and pack | Built here: one shared 32 ms elapsed-work slice across both local phases, with cancellation and deadline checks. It enters the existing cooperative queue only when that slice expires. |
| 4. Pack bytes | Built here: one initial render and a running UTF-8 count, including empty placeholders, scope counts, protected rules and repeated ids. |

The scope projection's sole consumer is `learnedRulesSnapshot`, used by launch
preparation, delivery revalidation and role block reads. Scope keys come from
`readableScopes` and the existing durable project-alias lookup. Scope and rule
writers, history drain, import and succession keep their existing format.
`packRoleSelection` also serves the evaluation script; its extra checkpoint is
optional. Selected delivery and frozen-block replay keep their renderer and
byte ceiling. No new persistent cache is introduced.

## After, same store and load

| Round | Eight starts, ms | Largest heartbeat interval, ms | Thread read bytes |
| --- | ---: | ---: | ---: |
| 1 | 834.5 | 833.1 | 689,664,135 |
| 2 | 759.1 | 754.6 | 689,344,320 |
| 3 | 892.2 | 892.0 | 689,344,397 |
| 4 | 741.5 | 745.1 | 689,344,321 |
| 5 | 816.9 | 812.0 | 689,344,321 |

Snapshot reads now take 65.1 to 147.1 ms. CPU samples still identify the
membership projection as the dominant blocker (3,179 samples, versus 8,983
before). Reading the four own scopes still makes SQLite parse their about 86 MB of
inline history. This is outside the selector's clock. A follow-up must measure
those reads after the separately approved #3841 drain; M0 neither enables that
drain nor changes its write path. This remaining storage blocker is handed to
the project's seat for its own follow-up.

The same driver with `--selector-only` loads the snapshot before timing. Both
versions use the same 193 rules, five rounds and eight concurrent selections.
The local scoring-plus-packing phase p50/p90 falls from 32.39/51.64 ms to
13.35/20.40 ms. Largest heartbeat intervals range from 12.80 to 28.40 ms before
and 22.60 to 38.90 ms after: completing in one turn spends more of that turn.
The full-start phase p90 is still 648.27 ms (1,717.71 ms before), because its
asynchronous continuations wait behind other starts' synchronous scope reads.
Neither profile proves the installed weekly criteria. Heap and RSS observations
are retained in the JSON without a memory-reduction claim. Heartbeat intervals
include the observer's heap sampling immediately before each timed round.

## Verification and installed follow-up

Run each test file separately through `scripts/gate-slot.sh` with fresh private
HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, a closed control URL, and a
separate output log and exit-status file. The focused files are
`roleSelectionM0.test.ts`, `roleSelect.test.ts`, `roleSelection.test.ts`,
`roleRuleReads.test.ts`, `roleStore.test.ts` under `src/lib/memory`, plus
`src/lib/cooperative.test.ts`. Run `bunx tsc --noEmit` and the publication privacy
gate against the merge base in the same isolation. The new tests also run on
the base to demonstrate the old loop turns and collection-wide scope reads.

Final results: 104 tests pass across those six files (12, 47, 17, 4, 14 and
10 respectively), with no failures. The final M0 file on the base has 11
expected failures and one passing alias-compatibility test. Type checking and
the full-file publication privacy gate against the merge base pass. Every run
has its own log and actual exit status in retained stage evidence.

One week after the actual deploy time, read copies of the delivery ledger and
state database made with `VACUUM INTO`, and the installed loop monitor's gap
records for that seven-day window. Count first selections only (exclude frozen
replays and starts without a selector), report the sample count, and require:

- `selector-timeout` below 1% of first selections (design baseline: 49%).
- The sum of `bm25` and `pack-bm25` evidence timings below 50 ms at p90.
- No new loop-gap record under `memory.select`.

Missing window coverage or timing evidence leaves this check unknown. These
are installed follow-up criteria, owed after deploy. M1's 16,000-character
budget and paid-selector setting, M2 to M4, team/workspace work, the curator,
runtime host and Bun pin remain deferred.
