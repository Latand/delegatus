Source: requester's pinned board brief, 2026-10-15, follow-up of lane `402ea294` and PR #2448.

> Long Codex history pages incrementally: carry ledger, open execs and pending users across pages instead of re-parsing the window
>
> Outcome: loading an older page of a long Codex conversation parses only that page plus a bounded hand-over, and the rendered feed is identical to a full parse (same items, order, open calls, pending messages, usage). Measure parse time and main-thread long tasks per page before/after on real-size Codex rollouts (synthetic or scrubbed copies committed as fixtures only if they carry no identities or home paths). Equality tests full-parse vs paged across join points that land inside an open exec, a pending user message and a context change.

Operator direction, 2026-10-15 05:06Z, relayed in the pinned specification:

> spend the Codex limits on research, performance and audits with GPT-6 Astra at xhigh, as auditor, builder and reviewer.

# Codex history paging

Design and measurements, 2026-10-15. Code baseline: main `45d25ac796d5824713c9fb57d65f57efea61041b`. All file:line references below refer to that commit. This stage changes only this document. It measures current behavior and defines implementation acceptance; it does not report candidate performance or candidate equality as already achieved.

## Decision and scope

Implement a Codex continuation at the existing feed parser, with a small, typed journal of operations that can read or patch an earlier page. Parse newly received JSONL once, pass the head's state into the retained window, and replay only operations dependent on that state. Keep the `FeedSession.feed` interface and the existing one-shot parser as the differential oracle. Keep the existing quiet join for other formats.

A checkpoint alone is insufficient: the retained suffix was originally interpreted without the older page. Its orphan results, inferred users, token shares and exec ownership can consequently change. Keeping its final rows without replay loses those changes. Replaying only previous successful `setEntry` writes also loses them: an orphan result did not write a call the first time.

The hand-over is **bounded by the live frontier and its dependent effects**, described precisely below. It must not scan or parse unrelated suffix records. There is no constant-size bound on every valid Codex frontier: structured pending users and ledger member lists currently have no fixed cap. An older page can legitimately change many existing rows. Preserve those semantics and make the work output-sensitive; silently dropping state or falling back on every open round would fail the requirement.

No ADR is needed. This is a reversible parser implementation choice with no persistent format or external protocol. No server changes are required. The implementation touches `parse.ts`, `contextTokens.ts` and their focused tests; it may extract the Codex continuation into one private module if that makes its state ownership clearer. Rendering validation extends existing drivers.

Open-work check: the forge listed PRs #2905 and #2902; neither changes the feed parser or context ledger. Lane `2f8d72dc` owns cold board startup and lane `c0f00aba` owns dashboard derivation; both were in audit without a PR when inspected. Server pause attribution, DB locks, heap/GC, runtime snapshots, MCP writers and those board lanes remain outside this design.

### Alternatives considered

| Option | Trade-off and decision |
| --- | --- |
| Add `turnOpen` to the old join signature | Small change; leaves ledger/exec/users blocking. Reject on the measured cause. |
| Serialize the entire active state and search for exact equality | Useful checkpoint primitive, but pending users and represented execs can remain different indefinitely. Does not replay an orphan result or a patch already applied to the suffix. Insufficient alone. |
| Cache JSON objects and run the reducer across the full window | Removes JSON decoding while repeating redaction/reconciliation and history-wide semantic work. Useful as a diagnostic control; fails the bounded hand-over acceptance. |
| Typed frontier plus indexed effects | Adds explicit state ownership and replay code inside the parser. It handles the required open joins and permits direct work-count/equality tests. Selected. |
| Move the existing full-window parse to a worker | Changes scheduling and transport while preserving repeated work. Deferred with asynchronous feed work. |

## Prior evidence and what was rechecked

Read archived lane `402ea294` with `get_pipeline`, including fix attempt 1, the later operator ruling and its final reports. Read PR #2448's merged body and file list. It merged on 2026-10-03 at `4efda9e8c63cb9dd3b14015ecc2e61dba06e877d`. Its body explicitly says Codex still reparses the full window; the earlier permission to ship that limitation does not waive this follow-up.

Project-scoped transcript searches for the whole-window/ledger problem found the original fix conversation. Opening it with `conversation_messages` recovered the 2026-10-02 07:05Z explanation; its local tool records at lines 193–215 recovered the measurement loop and raw counts. The loop repeatedly walked 300-line pages, so its condition counts include the same line more than once. For the 866-line rollout it reported 63/122 ms in one run and 193 ms for the final page in another; these are historical Bun observations, not today's browser baseline. The other sampled lengths were 533, 1,112 and 1,277. The report's conclusion was ledger blocking at least 95%, with exec and pending users accounting for much of the remainder. The later review reported 940 Codex prepends, zero joins and zero equality mismatches.

Further scoped and unscoped memory searches found no relevant implemented hand-over. The source still matches the archived diagnosis. The current measurements below independently check it, including negative source coordinates. No transcript words, source paths, account identities or home paths are copied into this document or fixtures.

## Current parse state, located on main

| Responsibility | Source | State or behavior that crosses the seam |
| --- | --- | --- |
| Feed ownership and caller | `src/components/LogFeed.tsx:855`, `:867`, `:881`; `src/components/feed/sessionPool.ts:23` | Synchronous parse inside a memo; session key includes path, engine, format, service visibility, filter and locale. One pane owns a pooled session. |
| Page transport | `src/hooks/useLogTail.ts:18`, `:402`, `:438` | Requests up to 4 MiB, completes JSONL boundaries, prepends strings and subtracts the number of lines from `linesStart`. Coordinates can be negative; they are not physical file line numbers. |
| Feed acceptance/reset | `src/components/feed/parse.ts:4077` | Checks the previous end line, attempts `joinOlder`, otherwise resets and consumes the complete window. Live lines after the old end are consumed after a successful join. |
| Current join | `parse.ts:1527`, `:1538`, `:3713`, `:3738`, `:3773`, `:3837` | `QuietPoint` has a scalar signature and reasoning boundary; `HeadState` carries entries and lookups, but no active ledger, exec, user or turn state. The head must reach an identical quiet signature, after a 24-line seam, with an overlap character budget of at least 512 KiB. `adoptHead` refuses entries patched after the join. |
| Entries and identity | `parse.ts:1648`, `:1742`, `:1754`, `:1781`, `:3971` | `seq` is a mutable implementation index; `bornSrc` sets stable row keys, `src` tracks later echoes/anchors. `setEntry` retires earlier quiet points. Both coordinates and per-source emission order matter. |
| Ledger | `src/components/feed/contextTokens.ts:130`, `:160`, `:167`, `:216`, `:228`, `:269`; `parse.ts:1764` | `round={before,output,members,contaminated,partial}`, ordered `pending`, contamination/hosted flags, `lastTotal`, `fresh`, `currentId`, ordered `sizes`, and `represented`. Size cache cap is 256; membership and represented maps have no equivalent fixed bound. Usage patches existing calls copy-on-write. |
| Exec pairing | `parse.ts:1656`, `:2152`, `:2328`, `:2576`, `:3009` | `execWindow={id,remaining,seen}`, `pendingExecs`, overflow latch and represented wrappers. Pairing is allowed only with one unambiguous wrapper; the existing 16-call and 128-KiB source limits and turn/context reset rules must survive. |
| Calls and late output | `parse.ts:1653`, `:2075`, `:2179`, `:2354`, `:2456` | Call ID → event and row; result preview accumulation, status, stderr, timings, image fallback, session ownership and thread-item upserts. Unknown-call output currently clears quiet points. |
| Pending users | `parse.ts:1582`, `:1712`, `:2869`, `:2877`, `:2926`, `:2967` | Ordered candidates retain text, time, source, row group, structured/echoed flags and delivery identity. Structured users survive finalization. Echoes update text/author metadata, attachments, timestamp and `src`; two distinct delivery IDs prevent folding. |
| Other reconciliation | `parse.ts:1706`, `:1958`, `:2394`, `:2675`, `:2985`, `:3210` | Adjacent assistant mirrors, reasoning IDs/enrichment, agent-call associations and compaction markers also reach across pages. |
| Turn chronology | `parse.ts:1734`, `:1789`, `:1803`, `:1815`, `:1826`, `:3613` | Turn start/time/source, open/failed state, response and failed-response row, latest timestamp. A later close sets response duration; recovery can remove it. |
| Display context and private metadata | `parse.ts:1649`, `:1663`, `:1670`, `:2039`, `:2364`, `:3008` | CWD suppression, image paths, session-owner tokens and WeakMap metadata for native user references, raw text and assistant echo text. Equality cannot be established by JSON alone. |
| Snapshot/eviction | `parse.ts:3855`, `:3861`, `:3883`, `:3902`, `:3939` | Eviction forgets ledger entries and reinstates nested estimates. Snapshots hide represented wrappers, count hidden services, fold command/reasoning groups and preserve live-tail expansion. They currently walk the entries array. |

`ledger.signature()` returns null when pending calls, result sizes, represented execs or round members remain. Copying `turnOpen` into today's signature would leave the dominant refusal intact. Also, a quiet-point hash cannot express the effect of a result whose call was absent when the suffix first parsed.

## Measurements on current main

The five inputs are private, immutable local copies. A–D match the historical sample lengths; B also matches its recorded byte count. The original four-file discovery used filesystem enumeration without a complete identity manifest, so only B is confirmed as the identical historical input. E is an additional longer real rollout. Hashes pin today's exact input bytes. None is committed.

| Input | JSONL lines | File bytes | SHA-256 |
| --- | ---: | ---: | --- |
| A | 533 | 4,946,549 | `3d66c29866a21e6783bba795f3766fadcfad360ed1c945872fb60d93f5076267` |
| B | 866 | 5,125,578 | `b9032d3d836b95e1e49cd5a39b991cca1f86ddf392a58054be83b61dee9bbe1e` |
| C | 1112 | 8,544,007 | `600c92a1f4a6d5e88a198c074865f3ca693ee5d4efdfd958b6e6f1573975f866` |
| D | 1277 | 4,283,323 | `78c9c2e457b6dd570b5401c07a98cf2221a64cda968ffe29f864e3e1b7eda027` |
| E | 3146 | 20,084,198 | `c050eceafb30be44509659dffefe32604342fcb442c8bb5976b8ddab0afcae4c` |

### Browser protocol

Exported the pinned commit under the stage scratch directory. Borrowed dependencies only after comparing `package.json`, `bun.lock` and all patched dependency inputs byte-for-byte with an installed checkout. No installs, builds or tests wrote to this worktree. All heavy runs used the controller's installed `gate-slot.sh`, serially, with isolated HOME, XDG config, temp and state roots. The test preload also disables machine CPU admission in test children. There were no production writes or restarts.

Machine: Linux x86-64, Core i9-12900K, 24 logical CPUs. Bun 1.4.0 built a production-mode, minified browser bundle of the unchanged parser; Chromium 156.0.8078.4 executed it on its main thread, without React or DOM rendering. The runs used the installed gate's CPU containment (configured per-command quota: 300%). The inspected agent ancestor had a 114,462,744,576-byte memory limit; per-run peak memory was not sampled. Load average at measurement start was 6.71 / 6.59 / 4.09. These are shared-machine observations, not an idle-machine latency guarantee.

For each input and CPU rate (1× and CDP 4×), run one warm-up walk and three measured walks. Start with the final 300 complete lines, prepend 300 at a time, and use the shorter remainder at file start. Pre-slice arrays and transfer corpus data outside the timer. Time `session.feed(window,start,false)` with service rows hidden and no filter. Each timed call runs in a separate browser task; collect `PerformanceObserver` long tasks, allowing a 20-ms task break before and after. Keep locale English and the same immutable data throughout.

The timer includes JSON parsing, source digests, redaction, normalization, reconciliation and `buildSnapshot`. It excludes file reading, browser transport, array slicing, HTTP, React, layout and paint. A second measurement parses only the incoming page with a fresh session. **Page-alone is a cost comparison; it is not an equivalent feed, a proven lower bound or an implemented “after” result.** It omits the retained window and its hand-over effects.

### Every prepend, in chronological loading order

All times are milliseconds, medians of three samples. Each paired cell is **1× / 4×**. Long-task columns give observations among the three calls and the worst task duration. A long task is the browser's >50-ms task entry, not an animation-frame measurement.

| Input | Window / incoming lines | Current `feed` ms, 1× / 4× | Page-alone ms, 1× / 4× | Current LT at 1×: count · max ms | Current LT at 4×: count · max ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 533 / 233 | 148.5 / 680.4 | 102.7 / 419.7 | 3/3 · 153 | 3/3 · 708 |
| B | 600 / 300 | 66.5 / 341.8 | 39.2 / 190.5 | 3/3 · 66 | 3/3 · 354 |
| B | 866 / 266 | 134.0 / 582.2 | 69.5 / 313.0 | 3/3 · 138 | 3/3 · 621 |
| C | 600 / 300 | 51.8 / 191.0 | 32.4 / 125.0 | 2/3 · 53 | 3/3 · 195 |
| C | 900 / 300 | 80.0 / 305.6 | 36.0 / 139.4 | 3/3 · 88 | 3/3 · 326 |
| C | 1112 / 212 | 152.3 / 649.5 | 76.5 / 317.3 | 3/3 · 159 | 3/3 · 678 |
| D | 600 / 300 | 23.3 / 109.3 | 12.6 / 51.5 | 0/3 · 0 | 3/3 · 112 |
| D | 900 / 300 | 34.5 / 158.6 | 11.7 / 55.2 | 0/3 · 0 | 3/3 · 169 |
| D | 1200 / 300 | 79.3 / 309.6 | 35.8 / 159.2 | 3/3 · 84 | 3/3 · 332 |
| D | 1277 / 77 | 91.1 / 421.0 | 20.9 / 94.3 | 3/3 · 96 | 3/3 · 462 |
| E | 600 / 300 | 47.0 / 249.1 | 24.2 / 136.5 | 0/3 · 0 | 3/3 · 297 |
| E | 900 / 300 | 69.0 / 351.8 | 24.0 / 134.0 | 3/3 · 78 | 3/3 · 405 |
| E | 1200 / 300 | 121.6 / 523.8 | 44.4 / 171.3 | 3/3 · 159 | 3/3 · 559 |
| E | 1500 / 300 | 160.5 / 696.1 | 42.1 / 186.0 | 3/3 · 169 | 3/3 · 991 |
| E | 1800 / 300 | 171.1 / 733.3 | 13.9 / 60.8 | 3/3 · 189 | 3/3 · 770 |
| E | 2100 / 300 | 191.8 / 792.8 | 17.3 / 69.9 | 3/3 · 206 | 3/3 · 824 |
| E | 2400 / 300 | 219.3 / 927.5 | 32.6 / 148.9 | 3/3 · 231 | 3/3 · 1083 |
| E | 2700 / 300 | 247.1 / 1062.4 | 24.4 / 87.7 | 3/3 · 274 | 3/3 · 1070 |
| E | 3000 / 300 | 274.3 / 1134.5 | 18.6 / 81.6 | 3/3 · 302 | 3/3 · 1185 |
| E | 3146 / 146 | 322.0 / 1330.5 | 48.2 / 201.2 | 3/3 · 330 | 3/3 · 1419 |

Across 120 measured prepends: **zero joins, 120 rebuilds**. At 1×, 50/60 calls produced long tasks, worst 330 ms; at 4×, 60/60 did, worst 1,419 ms. Page-alone produced 9/60 and 60/60 respectively. E's ten-prepend walk spent a median 1,819.8 ms in current `feed` at 1× and 7,865.1 ms at 4×, excluding initial tail loading. Its last 146-line page costs 322.0 / 1,330.5 ms today, compared with 48.2 / 201.2 ms page-alone. Removing repeated history parsing has substantial room to help; it cannot promise that every large incoming page finishes below 50 ms.

The 300-line partition deliberately reproduces the archived investigation. Actual network pages are byte-bounded and may contain more or fewer lines. E includes a 300-line page exceeding 4 MiB in characters; do not present this experiment as an exact network trace. Implementation validation must additionally replay the real byte-page partition, including oversized individual records.

### Current state occupancy and backward mutations

A separate untimed instrumentation build counted each source line once during a fresh full parse. Flags overlap; they are not an exclusive breakdown. “Exec” means an active window or pending exec; “turn only” excludes ledger, exec, user, assistant and compaction guards. Patches count calls to `setEntry` targeting a prior source line; this does not count every direct write or discarded orphan effect.

| Input | Ledger blocking / lines | Exec lines | Pending-user lines | Turn only | Prior-row patches / largest distance in lines |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 513/533 (96.2%) | 150 | 527 | 2 | 281 / 24 |
| B | 854/866 (98.6%) | 355 | 859 | 2 | 530 / 18 |
| C | 1098/1112 (98.7%) | 485 | 1105 | 2 | 725 / 18 |
| D | 1263/1277 (98.9%) | 528 | 1270 | 2 | 756 / 61 |
| E | 3134/3146 (99.6%) | 1051 | 3141 | 2 | 1875 / 41 |

The observed largest backward patch distance is 61 lines. A replay horizon of 24 lines would miss observed backward writes. It does not establish 61 as a safe new constant. The sampled maximum pending-user count was two and pending-exec count one; these observations do not impose semantic caps. Retained call maps reached 109, 283, 351, 370 and 718 entries respectively.

A current-main differential walk compared paged results with fresh whole-window results at every 300-line prepend, for service rows shown/hidden and both positive and negative coordinates: **80 comparisons, zero mismatches, zero joins**. Comparison included keys, anchors, items, duration, submission identity and exposed native/raw/assistant-text metadata; only reset-generated `plain-<counter>-` IDs were normalized, as in the existing oracle. This verifies the current fallback baseline, not the proposed algorithm.

## Hand-over contract

### One session, one source of truth

Keep normalization and semantic reduction separate inside the Codex path. A normalized record contains the already-decoded facts used by today's renderer and source identity; full parsing and page loading use the same reducer. The one-shot path disables reuse and applies all records in order, so tests can compare independent execution paths without maintaining a second semantics implementation. Keep an immutable main baseline for unchanged one-shot behavior as well, so a shared reducer regression cannot make both sides agree incorrectly.

At each retained page boundary, record the continuation and a typed effect index. Store shared references to immutable payloads and row slots; do not deep-copy all rows or all maps at every line. Full historical lookups live once in source-ordered per-ID indexes; a boundary holds references into them. Copy only the bounded ledger size cache and small scalar frontier; use immutable list segments for potentially growing pending/member lists. Do not clone the complete call or represented-exec map at each boundary. Keep this in the existing in-memory session lifetime. No disk cache, server parser, new wire format or generic incremental-computation library.

The continuation must include:

1. **Ledger:** every field listed in the state map, including insertion order of `sizes` (eviction depends on it), member order (rounding depends on it), `fresh` and `partial`, `lastTotal` including undefined, representation edges and original result character/raster counts. `ContextLedger` should own internal checkpoint/fork/adopt operations; callbacks must rebind to the receiving row store. A shallow alias to mutable arrays or a callback closed over the discarded head is invalid.
2. **Exec:** the wrapper row reference, ordered remaining methods, seen child IDs, pending owners, overflow latch and represented-wrapper set. These feed both row visibility and ledger weighting. Do not union independently inferred ownership from two parses.
3. **Users:** ordered pending candidates, timestamps and normalized matching text, original delivery ID, echoed/structured flags, last source and all emitted row references. Preserve attachment-only groups and private provenance. Index candidate text buckets for lookup while preserving first-match order and the exact existing time/delivery predicates.
4. **Other active state:** turn chronology; assistant adjacency candidate; reasoning IDs and boundary identity; compaction marker; CWD; image paths; agent associations; hidden-service contributions; call lookup; private session-owner equivalence. Also retain last consumed coordinate/line and config identity for append/reset behavior.

Use row references internally in the continuation/effects instead of copying `seq` values from a different session. Resolve references to the receiving entry store at application time. The current `entryIndex(seq)` arithmetic and head's uniform sequence shift assume a fixed contiguous layout; echo suppression and newly attached output can change that layout. Preserve `bornSrc`, last `src`, per-record emission ordinal and chronological insertion positions explicitly. Keep external row keys and anchors following their existing rules. Generated fallback call IDs need an explicit rebinding table; never match them by display text.

`reset(start > 0)` currently sets ledger partialness from parser coordinates, although real prepends can be negative. Preserve this exact oracle behavior here. Inferring actual file completeness or changing partial attribution is separate work.

### What the suffix records

A page retains ordered, typed operations for cross-page reads, including failed lookups. The minimum families are:

| Operation family | Operand retained once | Why it must replay |
| --- | --- | --- |
| Call creation/upsert/output and image-path observation | Call ID plus occurrence/order, normalized tool/result facts, timestamps, measure sizes and immutable block references | An older call can replace an orphan service row or change a completion's target. Repeated results append preview text but replace ledger size unless `quiet`. Image paths can enrich an already-settled result. |
| Exec pairing and terminal result | Wrapper/child IDs, methods, reset/overflow facts and result outcome | A formerly ownerless child may represent an older wrapper, changing visibility and shared tokens. |
| Ledger member/result/contamination/usage/representation | Ordered facts, exact numeric usage and original output sizes | The first usage closes an incoming round and opens the pending round; a later distinct usage can settle that round. Repeated totals must remain no-ops. |
| User echo/finalization | Decoded content, delivery identity, time, source and attachment references | A row emitted on initial suffix parsing can become an echo of an older row; harness classification can change. |
| Assistant/reasoning/compaction reconciliation | Source IDs, adjacency, comparison text and emission slots | Later mirrors or enrichment can replace rows before the seam. |
| Turn/context and agent association | Start/close/failure/recovery facts, CWD changes, timestamps and named references | Response duration, shell CWD suppression, grouping and spawned-agent status depend on earlier state. |

Capture these operations **before** checking whether a target exists. For instance, retain an `addOutput` operand when `calls.get(id)` misses and retain an image-path observation when its call is absent. Store the produced orphan/fallback row and hidden-service contribution so replay can retract it. Blindly storing only the previous patched row or only its final `contextTokens` is insufficient.

Normalize expensive output work once. Preserve the original character/raster counts for accounting and derive terminal code, wall time, session identity, empty-output status, bounded MCP fields, redacted previews and shell/non-shell stderr interpretations while the record is available. Reapplication uses these facts plus the target call's prior state. The existing success/error caps, suffix truncation and image block order must be identical. If a branch needs more source data to decide, retain an immutable reference for that branch and count any repeated decoding explicitly; do not assume capped display text is enough to reproduce accounting or classification.

### Prepend and post-join replay

For a new older page `P` and retained suffix `S`:

1. Verify the same configuration and retained suffix. Validate old suffix strings/ranges, including interior changes, before reusing effects. The existing last-line check is only a cheap rejection witness. A straightforward reference/string comparison pass is acceptable initially and counted separately; rehashing or JSON-parsing every suffix line is not. Rewritten, truncated, discontinuous or configuration-changed input takes the existing full-reset path with a named reason.
2. Parse `P` from its new start with the same initial conditions as the one-shot oracle. Stop exactly at `S`'s first line. Its active continuation is a valid join state even inside an exec, user echo interval or context round. No quiet-point search or speculative raw overlap scan is necessary.
3. Compare the new incoming continuation with the recorded input of `S`. Follow only changed dependencies through the suffix's typed indexes. Apply effects in source order and sub-operation order. Reconstruct affected row projections from their pre-effect state, then replay; do not append the same output twice to an already-patched row. Remove obsolete orphan rows and subtract their service contributions before producing replacements.
4. Install the corrected head and patched suffix together. Keep unaffected item objects and group objects where membership, active state and values are unchanged. Recompute groups crossing the seam or containing changed members; preserve relative order when an echo folds into an older row or adds an attachment at a later source.
5. Adopt the **terminal** continuation obtained after suffix replay. The head continuation at the seam cannot replace it: a subsequent live result must see the final pending calls/users/ledger. Consume any concurrently appended raw lines exactly once after the old consumed end. Publish one coherent snapshot; repeated feeding of unchanged input changes no row or effect version.

A replay is scoped by the tuple `(session generation, source coordinate, operation ordinal, input revision)`. Replace the previous derived contribution for that operation. This provides idempotence without a durable receipt system. If adoption fails an internal invariant, discard the speculative result, rebuild from the raw window and record the reason; such fallbacks fail performance acceptance on the supported ordinary fixtures.

### Three concrete seam examples

| Older page `P` | Already parsed suffix `S` | Replay required after the hand-over |
| --- | --- | --- |
| A call `call-a` is opened; its ledger membership is pending | Output for `call-a`, usage U1, then distinct usage U2 | Attach the formerly orphan output to the older call, remove only the fallback contribution actually emitted, feed its original size to the ledger, then reduce U1/U2 in order. Recompute the round's complete membership and shared values. Reusing S's old numerical token label is invalid. |
| Exec wrapper expects a shell operation and remains open | Concrete `exec-a`, its output, successful outer result | Replay ownership from the new pending-owner set. Hide the wrapper only when the expected operations are all accounted for and the original success rules allow representation; route token weight to the correct child. A second pending wrapper keeps pairing ambiguous. |
| Structured user candidate already emitted a bubble and image, carrying delivery `delivery-a` | Matching legacy/thread echo was initially rendered as a standalone user | Re-evaluate the exact text/time/delivery predicate. Fold into the older row group, retain its birth key and native provenance, take the proper echo timestamp/source, add only missing attachments, and retract S's provisional duplicate. Then install the resulting pending-user state for further echoes. |

These examples must be tests where naive concatenation and cached final-patch replay each go red. Include later live continuations to prove the installed terminal state is usable.

### Keeping replay bounded

Use typed indexes to select the affected operations:

- Calls, result fragments, image paths, reasoning IDs and agent associations: index by semantic ID with source-ordered occurrences. A newly found older call changes only uses before the next definition of the same ID. Duplicate IDs must retain today's last-definition-at-that-position semantics.
- Users: index exact normalized-text candidate buckets with ordered timestamps and delivery predicates. Adding a pending candidate revisits matching echo candidates and the relevant finalization point; structured candidates may remain live across many pages. Do not expire them at a fixed line distance.
- Exec pairing: index wrapper openings, concrete operations and reset events. Re-evaluate the affected ownership interval until the exact owner/pending/overflow state agrees. Overflow can survive until a real turn/context reset; a successful child match alone cannot clear it.
- Ledger: retain ordered round segments and keyed result/representation dependencies. Re-evaluate the incoming open round and pending segment through distinct usage records until both the outgoing ledger state and all affected row values agree. The first two distinct usage records often remove ingress dependence, but are not a guaranteed limit: duplicate totals, missing usage, representation edges and the 256-entry size cache can extend it. Skip independent closed rounds; retained represented results and size insertion order remain dependencies.
- Context, compaction and turns: direct indexes name rows that depend on an incoming CWD, a pending marker or an open turn, up to the next actual overwrite/reset. Reasoning-boundary renumbering is a constant page offset; group membership still needs an exact seam check. A long open turn can update its response target directly without walking all intervening tool rows.

A dependency is closed only when its outgoing state and derived contributions equal the cached ones. Mere equality of visible rows, a hash match alone, or reaching a usage record is insufficient. Keep assertions against a full normalized replay in tests while implementing each family.

Let `P` be new raw bytes, `F` changed frontier entries, `D` dependent normalized operations and `R` changed row contributions. Required parse/reconciliation cost is `O(P + F + D + R)` plus indexed lookup costs. Retained payloads/indexes are linear in retained history, with shared payload references and no whole-state snapshot per source line. A page with fixed frontier/effects must have unchanged raw parse and effect-visit counts when thousands of independent suffix records are added. Every replayed operation must name the changed dependency that selected it.

This is a bound on parsing/reconciliation. The present API still constructs a flat item array and `buildSnapshot` scans entries; suffix verification and flat projection may remain `O(window rows/lines)`. Measure them separately so those scans cannot hide as “handover”. Optimizing them is justified only if the paired measurements show they dominate after raw reparsing is removed. For adversarial data where an older context changes every suffix call's displayed CWD, `R` itself is proportional to the window; exact equality requires those updates. Never claim constant total page latency for that case.

## How equality is proven

Define `Full(W,start,config,live)` as a new session reducing the entire current window, and `Paged` as the session after any valid sequence of prepends/appends/evictions. Compare at every operation, not just when file start is reached. Equality is relative to the same loaded window and starting conditions; it does not assume unseen history exists in either side.

The proof obligations are:

1. Every cross-line state read appears in the continuation or a typed dependency index, including an absent-target read. Audit the complete `renderCodex` and thread-item paths, ledger callbacks and direct entry writes; `setEntry` is only one mutation funnel.
2. With identical normalized input and identical incoming state, a reducer emits identical row contributions and outgoing state. Test ledger checkpoint/fork/adopt separately, including insertion order and callback ownership.
3. Replacing a boundary state and replaying its dependent operations yields the same result as replaying all normalized operations. An unvisited operation must have unchanged dependencies. This establishes suffix reuse by induction in source order.
4. Projection preserves exact public fields, ordering, folded membership, hidden-service totals and source identities. Compare continuation snapshots as well as rendered rows, then append a discriminating continuation to expose stale hidden state.

The existing `prependJoin.parse.test.ts:122` oracle normalizes synthetic counter IDs. Strengthen its serializer for this work: preserve every real call/record/delivery ID and every field. For unavoidable internal synthetic renaming, use a one-to-one mapping and verify all references through it; stripping all generated IDs to one value can hide collisions. Compare `nativeUserRefFor`, `rawUserTextFor`, `assistantEchoText` and session-owner equivalence classes separately; WeakMaps do not appear in JSON. Compare owner equivalence across all visible/grouped calls rather than object identity across independent sessions.

Identity is an additional assertion: unaffected item references and keys remain identical within the incremental session; affected rows change copy-on-write; previous snapshots stay unchanged. After each join, feed a result, a distinct usage record, an echo and a turn close in separate tests. Equal snapshots before these arrivals do not prove equal continuation state.

## Test matrix and implementation sequence

| Case | Splits and actions | Required assertion |
| --- | --- | --- |
| Context ledger | Before/after member, output, first and second usage; repeated totals; zero/negative growth; missing calls/results; hosted search; user/developer contamination | Exact values, basis, round totals/call count and estimates; changed older-call eligibility updates all affected siblings. |
| Ledger capacity and ordering | 255/256/257 sizes, repeated result replacement, quiet accumulation, shared rounding ties, representation retained beyond a round | Same eviction order, weights, integer shares and final checkpoint. |
| Open exec | Wrapper in `P`, children/results in `S`; split after a child; reverse nesting; ambiguous parallel wrappers; 16/17 wrappers; source-limit edge; error/running output; late final success | Correct owner, visible wrapper/children, pending/open status, image handling and token sharing. Overflow resets only at the existing reset events. |
| Pending user | Split before legacy echo or `item_completed UserMessage`; several echoes; same text/time with different delivery IDs; structured user without echo; attachment-only and relay-origin messages | One logical row group when appropriate; correct author, source, timestamp, dedup, native/raw metadata and attachment ordering. |
| Context and turn | `session_meta`/`turn_context` at a seam; CWD change; one long open turn; failure then recovery; close after paging | Correct suppressed/visible CWD, reasoning grouping and response duration. Test both positive and negative `start`. |
| Other backward updates | Assistant mirrors with citations/blob; reasoning enrichment; compacted/context-compaction pairs; agent activity; output/image observation without a known call | Same rows as full parse; previously discarded observations are replayable. |
| Post-join ordering | Result/usage/echo before and far after a page boundary; distances 24, 25, 61, 62 and several pages | No distance cutoff, no lost patch, no double preview append, no stale usage or duplicate service row. |
| Page and tail lifecycle | Page plus new tail in one feed; repeat feed; reopen pooled session; live/settled flips; cap eviction and later reload | Same terminal state, retained identities and snapshot; no retained references to evicted records. |
| Invalid reuse | Interior rewrite with unchanged last line, changed last line, truncation, gap, filter/service/locale change | Deterministic full reset with reason; no stale suffix reuse. |
| Exhaustive small histories | Every split in short invented histories; page sizes 1/2/7/24/25/137/300; randomized multi-page partitions; live and service modes; nonempty matching and nonmatching filters | Full versus paged equality after every operation, exact metadata comparison and continuation challenges. |
| Complexity | Hold `P`, frontier and dependent operations fixed; pad suffix by 10× with independent completed rounds | Raw suffix consumes = 0; unchanged dependent-effect visit count; snapshot/verification cost reported separately. A fallback must fail this case. |
| Adversarial reach | Many pending structured users, missing usage over many pages, duplicate IDs, an incoming CWD that affects all retained calls | Full equality; output-sensitive cost named and counted; no silent caps or arbitrary loss of pairing/usage. |
| Real-size performance | Frozen A–E privately, plus invented public corpus of comparable record shapes/bytes; 300-line and actual 4-MiB partitions | Before/after medians, each page's long tasks, stage timings, raw lines/bytes, effects/patches, fallback reasons and retained memory. |
| Rendered parity | Existing `conversationWindow.browser.test.tsx` and `issue1671Evidence.browser.test.tsx`; desktop 1440×900 and phone 390×844; English/Ukrainian | Same visible rows, pending users, open tools, expanded output and usage; scroll anchor retained, no duplicate/missing order; capture through existing drivers only. |

Implementation order:

1. Add the differential serializer and adversarial split fixtures to the existing parse tests. Demonstrate the performance counter test fails on main. Keep the full-parse oracle available independently of joins.
2. Give the ledger its owned continuation and isolate normalized result facts. Verify checkpoint and reducer equivalence before changing paging. Inventory every Codex cross-line read/write from the map above.
3. Add page continuation, row rebinding and typed suffix indexes. Wire prepend admission/replay/adoption atomically, then test live append, cap eviction and pool reuse. Keep other formats on their existing join.
4. Measure and render through existing drivers, run focused checks, and only then claim the feature's acceptance. Include all fallback reasons and largest dependent interval in the implementation report.

Public fixtures should be invented records with neutral IDs and project-relative paths. Use a deterministic generator in the existing fixture/test module to reproduce sizes and state patterns, including multi-megabyte tool results. Do not publish a lightly anonymized production rollout or a names-based scrub list. Private A–E stay outside the repository; their hashes and aggregate readings above are sufficient for this design's evidence.

## Before/after acceptance for the builder

Add diagnostics beside `feedJoinStats` for new raw lines/bytes, reused lines, normalized effect visits, row patches, frontier sizes, checkpoint bytes, and explicit reset/fallback reasons. Measure decode/reduction, replay, suffix verification and snapshot projection separately. Keep diagnostics out of product UI.

Re-run the browser protocol below on the exact base and candidate, alternating order on the same machine and immutable inputs. Keep one warm-up and at least three measured walks per rate. Report each page and the walk total; do not turn a quiet run into a general latency guarantee. All ordinary Codex page-boundary fixtures must join with zero raw suffix consumes, including open exec/user/context seams. Complexity padding must leave parsing/replay work unchanged. Candidate `feed` medians and long-task blocking totals must improve on long-window samples; any regression needs an attributed explanation and resolution before acceptance. There is no inherited <3-second scroll or <600-ms phone-open target in this task.

Use the existing conversation/phone browser drivers for a separate whole-feed observation. Measure parse spans separately from React commits and frames; do not attribute all MainThread work to parsing. Current page-alone long tasks demonstrate why “zero long tasks” cannot be asserted from this hand-over alone.

The candidate's “after” measurements, zero-fallback differential checks and rendered evidence are mandatory implementation outputs. They are not accessible measurements this read-only design stage can honestly provide before implementation; there is no missing external permission or operator decision.

## Checks performed for this design

- Archived lane, fix transcript measurements, merged PR and open overlapping work read and checked against main.
- Chromium numeric baseline: 120 measured prepends across five real inputs and two CPU rates; 20 distinct page boundaries; full state occupancy counted separately.
- Real-rollout baseline differential check: 80/80 equal, all rebuilds.
- Focused existing tests: **103 pass, 0 fail**, 2,506 assertions, 4.27 seconds: `prependJoin.parse.test.ts`, `contextTokens.parse.test.ts`, `contextTokens.test.ts`. Executed from the scratch export as `bash "$INSTALLED_GATE" bash run-isolated.sh bun test src/components/feed/prependJoin.parse.test.ts src/components/feed/contextTokens.parse.test.ts src/components/feed/contextTokens.test.ts`; the wrapper created fresh HOME/config/temp/state roots before invoking Bun. No test files are changed by this document-only stage.
- Local publication privacy: **PASS**, using the committed fingerprints, `--require-known-values --paths docs/perf/codex-history-paging.md` against the pinned base. `git diff --check` and an explicit trailing-whitespace scan of the new, untracked document pass. CI is not run in this no-commit stage; the implementation must run the project's touched-file checks and required `privacy-publication`, `privacy-tracker-audit` and `runtime-gate` contexts.
- Remote main rechecked with `git ls-remote origin refs/heads/main` after the measurements: unchanged at the pinned commit above.

The only repository output is this document. No product-source edits, commits, staging, pushes or service actions were performed. There is no new rendered surface in this stage, so its browser work is a numerical parser probe, not rendered UI evidence.

## Deferred — not currently justified

- Worker migration, async feed scheduling and page-commit slicing. Page-alone costs show possible future value, but they change the caller lifecycle and require their own measured design.
- Full feed virtualization, different reveal/page sizes, phone content-visibility, scroll acceleration and jump-to-start controls.
- Server parsing, persistent parsed-history caches and new log API metadata.
- A general event-sourcing/dependency-graph library, per-line deep snapshots or cryptographic state equality.
- Changing context-token calibration, fixing coordinate-derived partialness, narrowing user echo semantics or capping pending users to make the optimization easier.
- Snapshot-array/whole-group optimization beyond the necessary seam corrections unless post-change attribution identifies it as the remaining cost.
- The explicitly fenced server pause, DB-lock, heap/GC, runtime-snapshot, MCP-writer, cold-board and dashboard-derivation work.

## Reproduction capsule

The following numerical probe can be created **in a scratch export**, with `CORPUS_DIR` containing private `A.jsonl` through `E.jsonl` and `CHROME_BIN` naming an installed Chromium. It exports no text or images from the inputs. Run it through the installed gate and an isolation wrapper; use the same dependency-input comparison as `scripts/review-export.ts`. The browser bundle entry is:

```ts
import { createFeedSession, feedJoinStats } from "./src/components/feed/parse";
Object.assign(globalThis, { createFeedSession, feedJoinStats });
```

Bundle with `Bun.build({entrypoints:[entry], target:"browser", format:"iife", minify:true, define:{"process.env.NODE_ENV":JSON.stringify("production")}})`. Launch one Playwright Chromium, add that bundle with `page.addScriptTag`, and load one input's `trimEnd().split("\n")` into `globalThis.benchLines` outside the timer. For rates 1 and 4, use `Emulation.setCPUThrottlingRate`, then run the following once for warm-up and three times for the retained readings. Write only the returned numeric records. This is the measurement body used above:

```ts
const g = globalThis as any;
const lines: string[] = g.benchLines;
const config = { engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" };
const session = g.createFeedSession(config);
let start = Math.max(0, lines.length - 300);
session.feed(lines.slice(start), start, false);
const wait = () => new Promise(resolve => setTimeout(resolve, 20));
const tasks: { start: number; duration: number }[] = [];
const observer = new PerformanceObserver(list => {
  tasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })));
});
observer.observe({ type: "longtask" });
const rows = [];
while (start > 0) {
  const old = start;
  start = Math.max(0, start - 300);
  const window = lines.slice(start);
  const page = lines.slice(start, old);
  await wait();
  const t = performance.now();
  const snapshot = session.feed(window, start, false);
  const end = performance.now();
  await wait();
  const longTasks = tasks.filter(e => e.start >= t - 1 && e.start < end + 1)
    .map(e => e.duration);
  const baseline = { ms: end - t, longTasks, items: snapshot.items.length,
    ...g.feedJoinStats(session) };
  await wait();
  const p = performance.now();
  g.createFeedSession(config).feed(page, start, false);
  const pend = performance.now();
  await wait();
  rows.push({ start, newLines: page.length, windowLines: window.length,
    newChars: page.reduce((n, s) => n + s.length, 0),
    windowChars: window.reduce((n, s) => n + s.length, 0), ...baseline,
    pageAloneMs: pend - p,
    pageAloneLongTasks: tasks.filter(e => e.start >= p - 1 && e.start < pend + 1)
      .map(e => e.duration) });
}
observer.disconnect();
return rows;
```

For the state audit, increment a counter at the start of `quietSignature` before its guards, evaluating each guard independently, and count `setEntry` calls where `curSrc > entries[idx].bornSrc`. Run each input once from start 0 with no filter and service rows hidden. This instrumentation was injected into an in-memory build; no product file was edited. For baseline equality, use the same page walk with the existing shape serializer plus exposed WeakMap metadata, service visibility true/false and coordinate offsets 0/negative-input-length. That procedure reproduces the denominators above without publishing any transcript content.
