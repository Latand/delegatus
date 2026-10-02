# Conversation feed continuity

Base: `origin/main` at `1d0eda9302bfa5c1df7e392f6002091ab0c7c7e9`.
All probes used fixture transcripts and an explicit isolated `LLV_STATE_DIR`.

| Symptom | Base observation | Scope in this change |
| --- | --- | --- |
| #682: completed assistant answer disappears before its echo | A completed live item at T, a parsed tool record at T+5 seconds, and no matching response id produce zero visible live rows while the turn is running. | Reproduced; handoff and feed integration remain pending coordination with #2448. |
| #675: rendering failure becomes malformed JSON | A valid Claude `assistant` / `tool_use` record parses as a tool without DOM globals. Installing a happy-dom `window` alone and resetting locale hydration produces `malformed_record`. Locale hydration accesses the absent global `document`; the parser catches that exception without exposing it. | Reproduced; distinguishing processing failures from JSON errors requires the protected `parse.ts` integration. |
| #641: compacted launch consumes its own delayed echo twice | Seed a launch, mark delivered, enqueue 32 later settled rows, refresh and reseed, then publish the launch echo. The queue entry lacks retirement and remains visible. Current main already preserves `delivered` state and its TTL, so the original indefinitely-delivering variant is partly repaired. | Fixed: one submission id owns one echo across its tombstone and queue representations. |

The #641 regression failed first at the missing `retiredEchoId` assertion. The
fix also preserves an updated canonical `echoText`, checked with a distinct
same-text successor and both ordinary and unresolved-submission observations.
The exact-path outbox suite passes 114 tests, including delivered TTL and
response-started terminal paths, refresh, identity adoption, transcript
generation changes, bounded queue compaction and 520 unrelated echo records.

Rendered evidence uses the existing `kanbanBoard.browser.test.tsx` driver and
`issue1695Evidence.fixture.tsx`, case `conversation feed delayed launch echo`.
`delayed-launch.json` records English and Ukrainian at 1440 and 390 px: one
message after the delayed echo, durable retirement, no horizontal overflow,
and no page errors. Frames are generated under
`.artifacts/conversation-feed/rendered/` and were visually inspected.

The full conversation-feed acceptance is pending: this change does not claim
assistant handoff continuity or improved turn/parser error visibility. The
history-loading lane #2448 also edits `parse.ts`, `LogFeed.tsx` and
`FeedItem.tsx`; those files remain unchanged here.
