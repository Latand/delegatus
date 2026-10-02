# Conversation feed continuity

Initial reproduction base: `1d0eda9302bfa5c1df7e392f6002091ab0c7c7e9`.
Continuation base: `28a9cd01ee0d3f747a7e59c42fbc47912b9235e0` (fetched main).
All probes use invented transcripts and explicit isolated `LLV_STATE_DIR`.

| Symptom | Base observation | Repair |
| --- | --- | --- |
| #682: completed answer vanishes before its own echo | Completed live item at T, later tool at T+5, no matching source id: zero live rows for running, idle and reconnecting turns. The DOM row disappears on completion. | Keep pane-owned answers through missing runtime snapshots; splice them into the common keyed row list at their original instant. Their own canonical echoes take the same node and position. Identity claims and idless stream retirement prevent resurrection after eviction. |
| #675: processing failure reads as malformed JSON | Valid tool-use record fails under a window-only DOM. A forced tool-card exception produces `malformed_record` with no diagnostic. | Separate JSON parsing from record processing; retain a bounded, redacted diagnostic with record type and source line. Show an en/uk alert in the conversation. Guard optional DOM locale globals. |
| #641: compacted/reseeded launch consumes its delayed echo twice | Tombstone claims the launch echo while its recreated queue entry remains visible. Main already preserves delivered state and its TTL; the indefinitely-delivering part is already repaired. | One submission id owns one occurrence across tombstone and queue. Canonical text upgrades and distinct same-text successors retain their own semantics. |

The continuation regressions on the fetched base return 120 pass / 4 fail
across outbox, handoff and processing-error files, plus the dedicated DOM
continuity regression fails because its live node disappears. The #641 failure
is the missing retirement assertion. Processing tests fail on the DOM-only case
and swallowed error. Handoff fails on absent reply. No symptom was dropped
except the already-repaired delivered-TTL part of #641.

Head verification uses exact paths. The six unit suites cover outbox,
assistant-row projection, live handoff, processing errors, parser and transcript
ordering. The DOM live-tool suite covers tool/prose interleaving, same-node
completion/reconnect/echo, composer follow-up ordering and omission labels.
Additional regressions prove single-occurrence matching of idless replies,
retirement after eviction, and source order for multi-row canonical echoes.

Rendered evidence uses the existing `kanbanBoard.browser.test.tsx` driver and
`issue1695Evidence.fixture.tsx`, cases `conversation feed delayed launch echo`
and `conversation feed continuity and errors`. The JSON records cover English
and Ukrainian at 1440 and 390 px. Frames are written beneath
`.artifacts/conversation-feed/` for visual inspection. Failure evidence exercises
the real parser, turn-error card and failed-delivery row; a fixture-only throwing
tool argument drives the processing exception without changing production code.

No history-loading behavior changes. Compatibility with the current #2448 head
is rehearsed separately in a scratch merge; its results are recorded in
`compatibility.json` and the pull request description.
