# Scanner catalog freshness

Observed against `origin/main` at `bda1137afa4c4e0c889f042fe47ec8670fb1abf0`.
All commands ran by exact test path with isolated state and transcript roots.

The predecessor is [PR #2407](https://github.com/Latand/delegatus/pull/2407),
whose review on 2026-10-01 at 19:06 UTC left the five-minute scan cooldown and
the separate MCP scanner stamp open. Transcript searches for `scanCache
cooldown`, `scannedAt` and task `d3f6d38c` found that review and the builder's
18:58 UTC explanation of the MCP cache; both conversations were opened through
`conversation_messages`. Their claims were checked against current main.

## Reproduction and result

`src/lib/scanner/scanCache.catalogFreshness.test.tsx` initially produced three
red checks on unchanged main:

- An already mounted `useFiles` surface, connected to a healthy runtime bus and
  the real `/api/files` handler, retained only the old transcript after a second
  launch revision inside the cooldown. No registry launch overlay was injected.
- `collectSnapshot`, using the production completed-generation reader, omitted
  a new transcript and returned the same `scanner.scannedAt` after ten seconds.
- The warmed `/api/conversations` handler used by `list_conversations` omitted
  a newly created transcript.

All three now pass. The same mounted surface displayed the new row in 512 ms
after the revision, including the client's existing 400 ms debounce. The MCP
snapshot included the new row and its scan timestamp advanced by the ten-second
fixture interval. The completed-generation selection used by `agent_activity`
also included that row. These are DOM and handler checks with controlled time;
they do not claim a deployed browser or physical-device observation.

Neither pinned hypothesis was dropped: both reproduced. Snapshot recovery,
project grouping and board-layout revision handling were excluded because the
predecessor already covered them and the new reproduction uses a healthy stream.
Registry/reaping and MCP search were left to their parallel lanes.

## Scan rate and bounds

Each fixture ran 600 controlled one-second ticks: 1,200 primary reads through
the browser and MCP cache seams, plus generation-completion waits. Initial
hydration scans are excluded. Counts instrument the production full-catalog
runner; membership probes are checked separately for filesystem work.

| Fixture | Main full scans / 10 min | Fixed full scans / 10 min | Before / after scans per minute |
| --- | ---: | ---: | ---: |
| Idle, unchanged transcript | 2 | 2 | 0.2 / 0.2 |
| Busy, one append and revision per second | 2 | 2 | 0.2 / 0.2 |

The five-minute ordinary/revision cooldown remains. Membership changes share
one pending generation and start at most one membership scan per ten seconds
per process. One hundred concurrent revision requests inside that interval
reserve one target and perform one scan; another hundred revisions after its
completion add none. Explicit fresh requests and private pinned scopes retain
their existing contracts.

The membership probe checks directory identities and reuses unchanged listings.
Across 100 transcript appends it performed zero recursive directory listings
and zero stats of the populated transcript. New and still-empty files are
checked until their first content arrives. Incomplete probes retain the previous
catalog with a bounded diagnostic; recovery is tested. A transcript born while
a full scan is in progress remains detectable on the next read.

## Local checks

- Catalog freshness: 10 passing tests, including storm, empty-file, race and
  unreadable-directory recovery checks.
- Focused files-route refresh/cooldown/pin checks: 9 passing tests.
- Conversation route: 13 passing tests.
- TypeScript, changed-file ESLint and the commit-aware privacy gate pass.
- The complete files-route suite has the same 9 failures on main and head.
  The unchanged real-scan suite has the same 17 failures on both, primarily an
  existing registry handle reopening a deleted test database and stale persisted
  schema fixtures. They were compared by exact path and left outside this fix.

Hosted CI is intentionally not awaited.
