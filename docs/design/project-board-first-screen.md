# Project board startup

The Viewer reads a display-only first screen from the existing `delegatus-boot` database after the server confirms this browser's installation and access. The project screen holds up to eight titles per column, the selected column, the confirmed layout revision, and the seat name. The desktop, phone and seat parts expire independently after seven days. The file catalog and layout must revalidate before the project board mounts its edit, assignment or movement controls.

## Measurement

The production builds used the same fictional transcripts, tasks and seat and a 787,764-byte layout fixture. The browser driver ran against a disposable loopback Viewer with private state and account directories. Each wave ran up to eight browser contexts. Desktop used 1440 × 900. The 4G profile used 390 × 844, 200,000 bytes/s in each direction and 150 ms of emulated latency. Cold runs started in new browser contexts. Reloads retained browser storage and the HTTP cache. Sleep runs froze a live page for 15 or 120 seconds and used the document's visibility event as the time origin when it returned.

First card means a visible nonempty title on a project card. Current board means the interactive board is present after successful files and layout reads. Seat input means an enabled writable textarea is visible. The phone test opens the seat conversation from its live seat card. CDP bytes include completed transfers and encoded chunks reported before the first card. Timing values are in milliseconds. Timing and byte values are p50/p95, rounded to the nearest integer.

Baseline `bcf9a373abbe` and candidate `bbfdcfc08` each produced 20 readings per profile and scenario. The matrix uses the second baseline capture, which corrected the phone's seat-opening interaction. Both sides used production builds and identical timing code.

| Profile / scenario | n before → after | First card | Current board | Seat input | Bytes to card |
|---|---:|---|---|---|---|
| desktop / cold | 20 → 20 | 9019/17300 → 10080/14579 | 8962/17206 → 9964/14545 | 10118/18161 → 11578/16421 | 1722534/1740122 → 1726065/1728798 |
| desktop / reload | 20 → 20 | 3237/5798 → 1954/4897 | 4803/5759 → 4142/5574 | 3899/6538 → 4142/5585 | 26797/63566 → 2603/29968 |
| desktop / sleep-15 | 20 → 20 | 6/17 → 8/16 | 1208/9758 → 2073/2499 | 6/17 → 8/16 | 0/0 → 0/0 |
| desktop / sleep-120 | 20 → 20 | 7/17 → 8/16 | 10001/10073 → 9999/10378 | 8/17 → 8/16 | 0/0 → 0/0 |
| 4g / cold | 20 → 20 | 17142/19191 → 15374/20063 | 17142/19191 → 15375/20063 | 18317/22001 → 16945/20715 | 1695482/1695970 → 1699164/1700253 |
| 4g / reload | 20 → 20 | 1646/4058 → 1280/2115 | 1662/4058 → 2079/4284 | 2264/5639 → 2619/5173 | 35342/36996 → 2603/2603 |
| 4g / sleep-15 | 20 → 20 | 10/19 → 9/16 | 659/1078 → 722/1083 | 138/274 → 139/268 | 0/0 → 0/0 |
| 4g / sleep-120 | 20 → 20 | 14/17 → 12/22 | 759/1171 → 846/1563 | 155/195 → 192/418 | 0/0 → 0/0 |

Both cold runs started without a browser record and drew their first card after the layout response. On the base, all reloads waited for the layout response because the fixture exceeded the 65,536-character localStorage budget. The candidate drew its saved screen first in 18 of 20 desktop reloads and all 20 phone reloads. Every one of these 38 first cards preceded both the catalog and layout responses. The other two desktop reloads drew the network board first. Both sleep durations drew the first card from the live tab in every run.

Median reload time to the first card fell by 1.28 s on desktop and 0.37 s on 4G. Median bytes to the card fell from 26,797 to 2,603 on desktop and from 35,342 to 2,603 on 4G. On 4G reloads, the median time to the current board rose by 417 ms and the median time to input rose by 355 ms. Desktop cold median time to the first card rose by 1.06 s. Both sleep durations continued to show the first card within one frame in a typical run.

## Safety and verification

- `src/lib/client/projectFirstScreen.test.ts` covers title and card bounds, schema, age, scope and project rejection, independent part expiry and ordered updates.
- `src/app/api/team/workspaces.routes.test.ts` exercises the server identity response for a signed-in operator, an anonymous request, a forged project, a foreign origin, a different session, changed workspace membership and role, revoked membership, a changed installation and sign-out.
- `src/hooks/useFiles.snapshot.dom.test.tsx` covers the catalog's own restore and revalidation paths, including a change of authority during an in-flight answer. `src/components/BootShell.dom.test.tsx` checks that remembered project names stay out of the neutral shell.
- `scripts/capture-board-geometry.ts` contains the production browser cases. It holds the layout, catalog and seat requests during reload to observe the saved screen, verifies the transition to the current board, injects storage failures, and exercises session changes in an isolated team.

The board and task routes enforce access through the workspace authorization wrapper. The saved screen renders text and column placement. Editing, assignment, drop targets and seat input come from the network-backed components after their respective reads.

The browser safety run passed on desktop and phone in English and Ukrainian, in light and dark themes. It verified that the seat name and at least one readable card rendered before any held data request completed. The network board then replaced the saved screen. Blocked IndexedDB, an open error and quota exhaustion each recovered through the network board.

On the same browser profile, a second signed-in member with access to the same project missed the first member's disk record. The workspace role change invalidated the record. Revocation redirected the member to the team page. Signing out cleared the disk record and returned the other open tab to the neutral shell.

The production build, 160 targeted tests across 14 test files, pre-commit checks and publication privacy audit passed. The visual and access results are retained in `board-startup-safety.json` and its accompanying frames and geometry records.

## Unknowns

- The two desktop reloads that drew the network board first might have had a missing or late disk record. The driver identified the winning surface and its network timings.
- Timings for signed-in teams, real phone hardware, mobile radio changes, browsers other than Chromium, OS tab discard and production data remain unknown. The timing run used a solo fixture and Chromium's controlled network and tab lifecycle. Team access and storage failure paths have separate correctness cases.
- The measurements cover browser cold starts against a running Viewer. Cold server startup and production server queueing remain unknown.

## Reproduction

Run `BOARD_CAPTURE_CASE=board-startup BOARD_STARTUP_REPEATS=20 CHROME_BIN="$(command -v google-chrome-stable)" bun scripts/capture-board-geometry.ts` in a production build export with an isolated temporary root. The driver starts and stops the disposable Viewer and Chromium. Set `BOARD_STARTUP_SAFETY_ONLY=1` to run the correctness cases on the candidate. The retained raw files are `board-baseline-confirmed-seat.json` and `board-candidate.json`.
