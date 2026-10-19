# Codex history paging results

Implementation of [the hand-over design](codex-history-paging.md). The measurement baseline is `5d839f09d30bc9e473bf262b1404f7566fe48526`, after merging main into the delivery branch. The original design and its historical measurements remain unchanged.

## Implementation

`createFeedSession` keeps a source-ordered Codex journal for the loaded window. New lines are decoded once. Each retained operation records the state versions it read, including missing calls, image observations and user candidates. Inserting an older write selects the readers of that version interval. A priority queue reapplies those operations in source order and replaces their previous contributions. Independent closed rounds retain their rows and objects.

The journal indexes calls, reasoning IDs, agent associations, images and represented execs by identity. Pending exec results and children have separate keyed indexes. Pending users have text/time indexes; the original timestamp and delivery predicates decide each match. Candidate lists and ledger membership use shared immutable segments. The ledger retains its ordered 256-entry size cache, representation edges, contamination and partial-window semantics. Its callbacks belong to the current reducer generation.

Stable source emission references address rows across replay. An operation can retract an orphan result or provisional echo, patch an earlier row, and emit attachments in its chronological position. Item equality includes native-user, raw-user, assistant-echo and private session-owner metadata. Equal contributions retain their prior objects. Private session-owner tokens are interned for a reducer generation; an older observation adopts a retained call’s token. The terminal continuation then accepts newly appended lines exactly once.

Every feed verifies the retained raw strings, including interior lines. Rewrites, truncation, gaps, eviction and locale changes start a new generation. A journal invariant failure has an explicit `invariant` rebuild reason. Real source IDs in the legacy generated `plain-<counter>-` namespace use the named `reserved-id` full-parse path, which preserves lookup semantics when a real ID collides with a generated one. Counters report these cases. Ordinary fixture and measurement walks require zero rebuilds.

`codexHistoryStats` separates new raw lines/bytes, reused lines, dependency checks, replayed effects, row writes, live-frontier size, retained versions, serialized frontier bytes and reset reasons. It times decoding/reduction, replay, raw verification and projection separately. Raw verification and flat snapshot projection remain proportional to the loaded window.

### Missing usage and long member lists

Review found a quadratic comparison hidden by the effect-visit counts. With no `token_count`, prepending a call changes every retained pending-member prefix. Generic object equality traversed each prefix's `previous` chain before checking its length. The 1,000-call regression recorded 2,020,978 comparison steps and failed its 100,000-step bound before the fix.

Ledger members and pending user references now use one immutable list type. Equality rejects different lengths immediately, traverses equal-length lists iteratively, and stops at a shared predecessor or a previously compared segment pair. Both equal and unequal segment verdicts are cached until reconciliation finishes. This also bounds replay after an equal-length prefix changes. Comparison uses exact IDs and lengths; it needs no hash. The segment cache is discarded after each settlement.

`comparisonSteps` counts generic equality calls and each persistent-list pair visited. The regression in `codexHistory.parse.test.ts` uses 1,000, 3,000 and 6,000 distinct calls, all timestamped `2026-09-01T10:00:00.000Z`, with arguments `{"cmd":"echo fixture"}` and no usage records. It includes loading `lines.slice(1)` at coordinate 1 followed by `lines` at 0, plus ten-page walks at two scales. Every page requires complete snapshot equality with a fresh parse, incoming-only decoding, zero resets, one replay per affected retained call, and at most 100 comparison steps per incoming record or replayed effect. These explicit-ID calls have no interactive-session ownership; the regression compares snapshots directly to avoid the small-fixture helper's all-pairs ownership matrix.

The journal tests separately cover 30,000-node equal, changed and shared lists, length differences, null boundaries, and a 6,000-effect replay that changes the oldest ID while preserving every prefix length. The latter requires fewer than 20 comparison steps per affected effect.

## Reproduction

The paired numerical case lives in the existing `conversationWindow.browser.test.tsx` driver. It bundles the baseline parser and ledger from the pinned commit, bundles the candidate, and alternates their execution order in Chromium. Both run on identical immutable inputs. Each CPU rate and partition has one warm-up and three measured walks. The timer surrounds `session.feed`; transport, slicing, comparison, React, layout and paint occur outside it. A `PerformanceObserver` records main-thread tasks longer than 50 ms that overlap the synchronous feed call. Blocking time sums `max(0, duration - 50)`.

A separate fresh-page probe loads raw input, collects garbage and records the heap, walks one parser through 300-line pages, retains its session, then collects and measures again. The reported session delta excludes the already loaded raw input. These samples follow the timed walks.

The driver accepts `LLV_HISTORY_BASE` and an optional `LLV_CODEX_HISTORY_MANIFEST`. A private manifest contains labels, input paths and hashes. The evidence contains only labels, hashes, counts and timings. Its default corpus uses invented records at the same five line counts. Both 300-line and 4-MiB partitions include complete records; an oversized individual record occupies its own page.

```sh
LLV_CONVERSATION_BROWSER_TEST=1 CHROME_BIN=path/to/chromium \
LLV_HISTORY_BASE=5d839f09d30bc9e473bf262b1404f7566fe48526 \
bash scripts/gate-slot.sh bun test \
  src/components/conversation/conversationWindow.browser.test.tsx \
  -t 'Codex history paging'
```

Rendered parity uses the production feed through that same driver at 1440×900 and 390×844, in English and Ukrainian. It compares all rendered row keys, kinds and text after paging with a full load, checks the open-call DOM node and scroll anchor, and expands output at the exec/user/context seam. Frames are under `.artifacts/codex-history/rendered/`.

The immutable one-shot oracle records its timezone as UTC. Its focused test runs in a separate process with that timezone, preserving the complete display fields in the comparison.

## Paired results

Parser revision `c828a730c527f5f97c97b7883c4ed4c53696ac32`; Chromium `156.0.8078.4`. Source hashes in the evidence also pin the measurement driver. Inputs A–E match the hashes in the design. All 60 measured walks passed, with 174 page comparisons (232 including warm-ups), zero raw suffix consumes and zero fallback/reset reasons. The table excludes the initial tail load. Each value is the median of three measured walks; arrows show baseline → candidate. CPU throttling is 1× or 4×. Times are milliseconds.

### 300-lines walk totals

| Input | Lines | Feed ms 1× | Feed ms 4× | Blocking ms 1× | Blocking ms 4× |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 533 | 200.7 → 138.1 | 819.6 → 764.3 | 150.0 → 88.0 | 769.0 → 715.0 |
| B | 866 | 301.7 → 206.2 | 1121.1 → 868.0 | 201.0 → 106.0 | 1021.0 → 768.0 |
| C | 1112 | 357.9 → 303.9 | 2082.1 → 1425.2 | 207.0 → 153.0 | 1932.0 → 1274.0 |
| D | 1277 | 310.5 → 188.8 | 1787.6 → 983.6 | 124.0 → 13.0 | 1587.0 → 785.0 |
| E | 3146 | 2640.5 → 795.4 | 10000.2 → 2972.1 | 2138.0 → 295.0 | 9500.0 → 2470.0 |

### 4-MiB walk totals

| Input | Lines | Feed ms 1× | Feed ms 4× | Blocking ms 1× | Blocking ms 4× |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 533 | 163.2 → 88.3 | 771.9 → 388.6 | 113.0 → 38.0 | 722.0 → 339.0 |
| B | 866 | 161.2 → 55.6 | 1000.6 → 277.9 | 111.0 → 5.0 | 950.0 → 228.0 |
| C | 1112 | 377.6 → 204.5 | 1923.8 → 1073.1 | 277.0 → 104.0 | 1824.0 → 973.0 |
| D | 1277 | 140.7 → 4.7 | 637.6 → 17.3 | 90.0 → 0.0 | 587.0 → 0.0 |
| E | 3146 | 1083.6 → 629.0 | 4592.5 → 2868.7 | 882.0 → 428.0 | 4393.0 → 2669.0 |


All walk totals improve. At C / 600 lines / 1×, independent page medians are 68.3 → 78.8 ms. The paired changes are −5.5, −14.1 and +21.8 ms (median −5.5 ms); the candidate is faster in two of three pairs and all three 4× pairs. The apparent regression comes from summarizing different samples: the middle baseline and candidate readings belong to different repetitions. That page decodes 1.98 MB once and reapplies 87 ledger/call effects, with no suffix decoding. Native decode/reduction ranges from 50.0 to 77.3 ms; replay is 3.0–6.4 ms. The paired result and complete C walk improve. These shared-machine readings establish observed costs, with no guarantee for a single future page.

### Every prepend

LT counts sum the three samples. Blocking columns are medians. The raw evidence retains individual samples, phase timings, bytes, work counts and frontier state for both partitions.

#### 300-lines

| Input / window / incoming | Feed ms 1× | Feed ms 4× | LT count 1× | LT count 4× | Blocking ms 1× | Blocking ms 4× |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A / 533 / 233 | 200.7 → 138.1 | 819.6 → 764.3 | 3 → 3 | 3 → 3 | 150.0 → 88.0 | 769.0 → 715.0 |
| B / 600 / 300 | 82.7 → 64.7 | 383.1 → 323.1 | 3 → 3 | 3 → 3 | 32.0 → 14.0 | 333.0 → 273.0 |
| B / 866 / 266 | 173.5 → 138.8 | 738.0 → 544.9 | 3 → 3 | 3 → 3 | 123.0 → 89.0 | 688.0 → 495.0 |
| C / 600 / 300 | 68.3 → 78.8 | 403.2 → 361.9 | 3 → 3 | 3 → 3 | 18.0 → 28.0 | 353.0 → 312.0 |
| C / 900 / 300 | 91.0 → 74.5 | 620.9 → 466.2 | 3 → 3 | 3 → 3 | 41.0 → 24.0 | 571.0 → 416.0 |
| C / 1112 / 212 | 198.6 → 157.4 | 963.7 → 599.7 | 3 → 3 | 3 → 3 | 148.0 → 107.0 | 914.0 → 549.0 |
| D / 600 / 300 | 27.7 → 23.0 | 147.6 → 139.4 | 0 → 0 | 3 → 3 | 0.0 → 0.0 | 97.0 → 90.0 |
| D / 900 / 300 | 57.0 → 25.8 | 226.8 → 178.0 | 2 → 0 | 3 → 3 | 7.0 → 0.0 | 177.0 → 128.0 |
| D / 1200 / 300 | 98.6 → 62.1 | 550.1 → 318.2 | 3 → 3 | 3 → 3 | 48.0 → 12.0 | 500.0 → 268.0 |
| D / 1277 / 77 | 119.1 → 52.3 | 724.4 → 259.4 | 3 → 3 | 3 → 3 | 69.0 → 2.0 | 674.0 → 209.0 |
| E / 600 / 300 | 67.1 → 63.7 | 355.6 → 307.7 | 3 → 2 | 3 → 3 | 17.0 → 13.0 | 305.0 → 258.0 |
| E / 900 / 300 | 113.9 → 48.7 | 411.1 → 209.1 | 3 → 1 | 3 → 3 | 63.0 → 0.0 | 361.0 → 159.0 |
| E / 1200 / 300 | 167.8 → 100.8 | 634.1 → 365.0 | 3 → 3 | 3 → 3 | 118.0 → 50.0 | 584.0 → 315.0 |
| E / 1500 / 300 | 199.4 → 97.5 | 820.9 → 405.2 | 3 → 3 | 3 → 3 | 149.0 → 47.0 | 771.0 → 355.0 |
| E / 1800 / 300 | 242.5 → 49.1 | 1026.1 → 250.1 | 3 → 1 | 3 → 3 | 192.0 → 0.0 | 976.0 → 200.0 |
| E / 2100 / 300 | 233.1 → 56.7 | 888.5 → 246.4 | 3 → 3 | 3 → 3 | 183.0 → 6.0 | 839.0 → 196.0 |
| E / 2400 / 300 | 329.2 → 89.3 | 1457.9 → 306.3 | 3 → 3 | 3 → 3 | 279.0 → 39.0 | 1408.0 → 256.0 |
| E / 2700 / 300 | 375.2 → 64.5 | 1491.5 → 264.7 | 3 → 3 | 3 → 3 | 325.0 → 14.0 | 1441.0 → 215.0 |
| E / 3000 / 300 | 348.5 → 77.4 | 1293.5 → 213.2 | 3 → 3 | 3 → 3 | 298.0 → 27.0 | 1243.0 → 163.0 |
| E / 3146 / 146 | 420.9 → 118.1 | 1895.1 → 371.5 | 3 → 3 | 3 → 3 | 371.0 → 68.0 | 1845.0 → 321.0 |

#### 4-MiB

| Input / window / incoming | Feed ms 1× | Feed ms 4× | LT count 1× | LT count 4× | Blocking ms 1× | Blocking ms 4× |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A / 533 / 44 | 163.2 → 88.3 | 771.9 → 388.6 | 3 → 3 | 3 → 3 | 113.0 → 38.0 | 722.0 → 339.0 |
| B / 866 / 44 | 161.2 → 55.6 | 1000.6 → 277.9 | 3 → 3 | 3 → 3 | 111.0 → 5.0 | 950.0 → 228.0 |
| C / 1028 / 283 | 172.9 → 118.9 | 1010.5 → 735.2 | 3 → 3 | 3 → 3 | 123.0 → 69.0 | 960.0 → 685.0 |
| C / 1112 / 84 | 213.8 → 88.3 | 1080.5 → 337.9 | 3 → 3 | 3 → 3 | 163.0 → 38.0 | 1031.0 → 288.0 |
| D / 1277 / 7 | 140.7 → 4.7 | 637.6 → 17.3 | 3 → 0 | 3 → 0 | 90.0 → 0.0 | 587.0 → 0.0 |
| E / 1159 / 364 | 153.4 → 120.7 | 678.4 → 524.5 | 3 → 3 | 3 → 3 | 103.0 → 71.0 | 629.0 → 475.0 |
| E / 1363 / 204 | 188.9 → 103.3 | 832.9 → 343.7 | 3 → 3 | 3 → 3 | 139.0 → 53.0 | 783.0 → 294.0 |
| E / 2295 / 932 | 279.3 → 156.5 | 1230.8 → 800.7 | 3 → 3 | 3 → 3 | 229.0 → 106.0 | 1181.0 → 751.0 |
| E / 3146 / 851 | 424.8 → 214.7 | 1766.6 → 1360.1 | 3 → 3 | 3 → 3 | 375.0 → 165.0 | 1717.0 → 1311.0 |

### Candidate phases and retained state

These are 1× medians of summed phase timings for the 300-line walk. Decode/reduction includes new JSON, normalization and journal insertion. Replay uses cached operands. Verification compares retained raw strings; projection builds the flat snapshot. The latter two remain proportional to the loaded window. Small rounding/timer overhead separates their sum from the enclosing feed span.

| Input | Decode/reduce ms | Replay ms | Verify ms | Project ms | Maximum replayed effects per page | Maximum checked effects per page | Maximum row writes per page |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 123.6 | 13.4 | 0.1 | 0.6 | 67 | 84 | 220 |
| B | 183.4 | 25.5 | 0.0 | 2.0 | 213 | 284 | 326 |
| C | 254.8 | 32.8 | 0.0 | 3.1 | 301 | 418 | 320 |
| D | 139.7 | 43.8 | 0.4 | 4.6 | 352 | 514 | 308 |
| E | 551.1 | 212.3 | 0.7 | 27.3 | 538 | 623 | 306 |

Across both partitions and rates, the largest changed dependency interval reapplies 538 effects, checks 623 and writes 879 row contributions. Each is selected by a named dependency family in `replayByDependency`. No unrelated suffix raw record is decoded. The complexity tests hold the page/frontier fixed while adding 10× independent rounds or pending-user buckets; the replay counts remain equal.

The separate heap samples below retain the completed session after garbage collection. Session delta is relative to a fresh page with raw input already loaded; it includes retained normalized operands, rows and indexes. This is one sample per implementation/input. The journal adds linear retention, visible here as roughly 3–7 MB. It is discarded on a new generation or when the session is released. The active ledger size cache remains capped at 256; pending users and dependent rounds keep their existing semantic bounds.

| Input | Retained session delta MiB, before → after | Effects | Slots | Versions | Terminal frontier bytes | Pending users / execs / ledger members |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 4.1 → 9.5 | 533 | 1171 | 4907 | 18218 | 1 / 0 / 0 |
| B | 5.4 → 11.7 | 866 | 2341 | 9475 | 18603 | 1 / 0 / 0 |
| C | 8.0 → 11.4 | 1112 | 2967 | 12402 | 22464 | 1 / 0 / 0 |
| D | 4.4 → 10.9 | 1277 | 3339 | 14006 | 21401 | 2 / 0 / 0 |
| E | 16.1 → 18.8 | 3146 | 7232 | 30506 | 35419 | 1 / 0 / 0 |

## Verification

The final focused run passed 27 tests across the parser and existing conversation browser driver. It includes a frozen baseline oracle, full-vs-paged comparisons at every small-fixture split, open exec/user/context seams, private metadata and ownership classes, negative coordinates, live continuations, duplicate IDs, overflow, oversized results, mutation/reset paths and fixed-frontier complexity controls.

Rendered comparisons match all 644 rows at 1440×900 and 390×844 in English and Ukrainian. The open-call DOM node survives all prepends, anchor drift is at most 0.25 px, pending-user text appears once, and expanded seam output remains available. The start, tail and expanded-output frames were inspected at their captured viewport sizes.

Evidence: [all paired parser readings](../../evidence/codex-history/parser.json), [retained heap samples](../../evidence/codex-history/memory.json), [rendered row/anchor checks](../../evidence/codex-history/rendered.json). Private rollout files remain outside publication; committed fixtures contain invented records.
