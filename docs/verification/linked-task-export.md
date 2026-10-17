# Linked task export verification

The linked-board scan, log and pending-push readers build their export pages in one leased worker. The Viewer passes the caller clock and decision observations, then rechecks sharing and privacy authority after the await. A privacy revision travels through object spreads as a symbol and is checked again at both final JSON serializers. It adds no wire field.

The matcher checks the store revision and file identity before cloning role memory. The worker caches the encoded page by cursor, scope, wire capabilities and the task, tombstone, omission, pipeline, seat, scanner and privacy inputs. Done-task expiry and a backwards clock invalidate a held page. Identical scanner observations keep the page reusable. The LRU holds at most 16 pages and 8 MiB of accounted storage (JSON bytes counted twice for the object and encoded representations). There is one worker across route bundles, at most 16 queued jobs, a 60-second job deadline and retirement after ten idle minutes. The existing helper lease owns its lifetime. A failed filter refuses the page without an inline fallback.

The one-time linked-arrival repair and omission bookkeeping run in that worker too. Inbound task application retains its existing store path. The peer protocol, client exchange and scheduler await page construction; sharing and grant checks cover that new wait. Peer failures log a bounded error class without addresses, credentials or remote text.

Measured on 2026-10-17, starting from `afafbfba9bcdb68f4d7f41bfaefef6eb9163488a`, under Bun 1.4.0. The same frozen input contained 2,014 tasks, 3,507 role-memory rows and 302 pipelines. Every attempt reached an owned port-0 stub returning `400/malformed`, with the same 492,598-byte request and byte-identical task payload. The implementation-side worker was the production build's `.next/server/task-page-worker.js`. Full counters and the measured source digest are in [the evidence record](../../evidence/linked-task-export.json).

| Attempt | Base elapsed | Compiled worker elapsed | Base Viewer memory clones | New Viewer memory clones | New max main CPU window | New worker page builds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 26300.52 ms | 12940.20 ms | 704,907 | 0 | 20 ms | 1 |
| 2 | 22240.23 ms | 20.90 ms | 704,907 | 0 | 10 ms | 1 |
| 3 | 23320.51 ms | 19.11 ms | 704,907 | 0 | 10 ms | 1 |

The largest observed main-thread CPU window was 20 ms. Linux reports CPU in 10 ms ticks here; adding one tick gives a conservative 30 ms bound. The largest new 5 ms timer lateness was 20.13 ms. Cached retries used 15.361 and 10.868 ms of Viewer plus worker-build CPU; the worker lookups themselves used 0.249 and 0.164 ms. The cold build still spends CPU filtering in the worker. Elapsed measurements include a ten-millisecond observer drain; process CPU includes the local stub and sampling. Worker-build CPU excludes process startup. These are offline measurements, not a deployment observation.

To repeat, export the base with `git archive` into stage scratch. Use read-only SQLite connections and `VACUUM INTO` to freeze `state.sqlite` and `agent-registry.sqlite`. Copy `links/shared.json`, `links/peers.json`, `links/self.json`, `project-remotes.json`, `project-aliases.json`, `orchestrator-seats.json`, `files-scan-snapshot.json` and `forge-links.json` when present. Restore WAL journal mode after VACUUM in both copies. Duplicate that frozen input into separate base and candidate run directories, then create `.task-export-copy` inside each copied state directory. Use private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR for every command; keep both control URLs on a closed loopback port.

Run the same driver from each revision's source directory, with the driver path pointing to the candidate and the gate wrapper resolved for the current stage:

```sh
LLV_TASK_EXPORT_MEASURE_NOW=1792218160000 NODE_ENV=test \
  bash "$GATE_SLOT" bun "$EXPORT_MEASURE_DRIVER"
```

The driver refuses an unmarked directory, rewrites only the copied peers to its port-0 stub, runs three attempts and awaits its worker's shutdown. Keep its detailed output private. Build the candidate through the same isolated gate before measuring it so the launcher selects the compiled worker. The initial diagnosis was also rebuilt and measured three times before implementation; two base regression cases were red: repeated page snapshots (40 on retry) and matcher snapshots (10 for ten calls). Byte identity and fail-closed corruption controls already passed on the base.

Checks use explicit paths under isolated state: `src/lib/links/taskExport.test.ts` (real child processes, including worker restart and failure, scan/log parity, cache invalidation, same-size/same-mtime database replacement, expiry, LRU eviction and final privacy refusal), `src/lib/links/taskSync.test.ts`, `src/lib/links/schedule.test.ts`, `src/lib/memory/roleEgress.test.ts`, `src/lib/memory/roleStore.test.ts`, and the worker-entry case in `next.config.test.ts`. Five real HTTP cases in `src/lib/links/boardSync.test.ts` cover done expiry, full task changes, 201-row paging, title recovery and failure recovery. The compiled-worker case runs with `LLV_TASK_PAGE_BUILT_TEST=1`. Typecheck, production/MCP build, changed-file ESLint and the publication privacy gate are required before handoff.

An additional `roleEgressUnreadable.test.ts` check has one pre-existing failure: its empty-store bridge report returns “bridge report log is busy”. The unmodified base fails the same assertion under the same isolation. Its corrupt-store case passes, and the new export suite verifies unreadable privacy input on both scan and log paths. Two optional older idle-performance cases in `boardSync.test.ts` also fail on the unmodified base under the same isolation: the 1,000-call CPU assertion (base 5,144 ms against its 2,000 ms cap) and the initial link in the 2,000-omission setup (unreachable before its assertions). The candidate shows the same failures. The targeted omission-progress regression covers the cache's bounded sweep independently. A full optional transport sweep exceeded the five-minute file budget and was stopped; the final focused transport selection excludes the six large stress/performance cases and passes 44 cases. Hosted checks follow seat publication.

The final export suite passes 14 cases with the compiled worker enabled. The replacement regression first exposed stale filtering when a database was replaced with identical size and mtime; the cache now observes device, inode and change time before reuse. Final typecheck, production/MCP build and changed-file ESLint passed (one existing warning on an unchanged line). Publication privacy passed; hosted checks remain for seat publication.
