# Project board startup

The Viewer reads a display-only first screen from the existing `delegatus-boot` database once the server has confirmed this browser's installation and access. The project screen holds up to eight titles per column, the selected column, the confirmed layout revision, and the seat name. The desktop, phone and seat parts expire independently after seven days. The file catalog and layout must revalidate before the project board mounts its edit, assignment or movement controls.

## The access check never gates a read

`GET /api/team?view=board-access` names the scope this browser may show saved data for. The Viewer's own reads (catalog, layout, seat, runtime) authorize themselves on the server and start at once, in parallel with that check. Only saved data waits for the answer:

- The saved catalog is read from IndexedDB when the bundle loads, so the first catalog request can still ask conditionally. It stays out of every display until the check names the scope it was saved under, is shown then, and is dropped under any other scope. A 304 from the server certifies the same rows for the requester either way.
- The saved project screen, the saved layout (`llvBoards`) and the remembered project name are read only under a confirmed scope. A document with no answer yet writes none of them.
- A failed check (network error, 5xx, timeout) shows nothing saved and asks again after 1, 2, 4 and then every 8 seconds. The live board, the catalog failure notice and the seat are not affected.
- A member's tab asks again when it becomes visible and every 15 seconds. A hidden tab keeps its board; only a refusal (401/403) or a different scope ends the document, which then shows the neutral shell and clears what was saved. Account switches in another tab arrive through the sign-in and sign-out storage events, revocation through the 401/403 of the reads themselves.
- Board readiness is unchanged from before this lane: fresh catalog and a finished layout read. A layout read that fails still finishes it, so the cards and the seat render and the board stays `unavailable` until the poll recovers.

## Measurement

The production builds used the same fictional transcripts, tasks and seat and a 787,764-byte layout fixture. The browser driver ran against a disposable loopback Viewer with private state and account directories. Each wave ran up to eight browser contexts. Desktop used 1440 × 900. The 4G profile used 390 × 844, 200,000 bytes/s in each direction and 150 ms of emulated latency. Cold runs started in new browser contexts. Reloads retained browser storage and the HTTP cache. Sleep runs froze a live page for 15 or 120 seconds and used the document's visibility event as the time origin when it returned.

First card means a visible nonempty title on a project card. Current board means the interactive board is present after successful files and layout reads. Seat input means an enabled writable textarea is visible. The phone test opens the seat conversation from its live seat card. CDP bytes include completed transfers and encoded chunks reported before the first card. Timing values are in milliseconds. Timing and byte values are p50/p95, rounded to the nearest integer.

Baseline `bcf9a373abbe` and candidate `bbfdcfc08` each produced 20 readings per profile and scenario. The matrix uses the second baseline capture, which corrected the phone's seat-opening interaction. Both sides used production builds and identical timing code.

**The candidate column is the revision before the access check stopped gating reads.** In `bbfdcfc08` the Viewer mounted only after `/api/team?view=board-access` answered, so every catalog, layout and seat read started one round trip later. The 4G and desktop reload rows below show that cost (4G current board +417 ms, 4G seat input +355 ms, desktop seat input +243 ms). The revision that starts those reads with the page has not been timed (see Unknowns), so the table makes no claim about it beyond the first-card gain, which does not depend on the gate. The acceptance for that rerun is current board and seat input p50 within 5% of the baseline on 4G and desktop reloads, with the first-card gain kept.

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

Median reload time to the first card fell by 1.28 s on desktop and 0.37 s on 4G. Median bytes to the card fell from 26,797 to 2,603 on desktop and from 35,342 to 2,603 on 4G. On 4G reloads, the median time to the current board rose by 417 ms and the median time to input rose by 355 ms; that rise came from the gate described above. Desktop cold median time to the first card rose by 1.06 s. Both sleep durations continued to show the first card within one frame in a typical run, on the solo fixture.

## Safety and verification

- `src/lib/client/projectFirstScreen.test.ts` covers title and card bounds, schema, age, scope and project rejection, independent part expiry and ordered updates.
- `src/app/api/team/workspaces.routes.test.ts` exercises the server identity response for a signed-in operator, an anonymous request, a forged project, a foreign origin, a different session, changed workspace membership and role, revoked membership, a changed installation and sign-out.
- `src/hooks/useFiles.snapshot.dom.test.tsx` covers the catalog's own restore and revalidation paths, including a change of authority during an in-flight answer, a saved catalog that is held until the access answer and then shown or dropped, and a held record that still makes the first request conditional. `src/components/BootShell.dom.test.tsx` checks that remembered project names stay out of the neutral shell.
- `src/components/Viewer.bootAccess.dom.test.tsx` mounts the real Viewer with a 64-hex scope, which the other Viewer tests (they answer `scope: null`) do not. It covers a failed access check with a failing catalog (the failure notice shows and `/api/files` was requested), reads that start while the check is held, the retry backoff, a failed layout read (cards and seat render, the board reports `unavailable`), a team tab that hides and returns while the check fails (the board stays), and a changed or refused identity (the document ends and clears what was saved).
- `src/hooks/useBoardState.persisted.dom.test.ts` checks that a saved layout is neither read nor written before the server names the scope, and never under another one. `src/components/ProjectDashboard.loadingStates.dom.test.tsx` runs under a confirmed scope and checks that a saved answer holds the skeleton, says it is updating, and acts on nothing until the network certifies it. `src/components/skeletons.dom.test.tsx` checks that the tab-mode board (about 900 px) draws the saved active column with its titles and an inert strip, in both languages.
- `scripts/capture-board-geometry.ts` contains the production browser cases. It holds the layout, catalog and seat requests during reload to observe the saved screen, verifies the transition to the current board, injects storage failures, and exercises session changes in an isolated team. The first-screen matrix covers 1440, 900 and 390 px in English and Ukrainian, light and dark. At 900 px the board is in tab mode, and the case requires the saved active column to be drawn, its titles to stay inside the column and clear of the seat, measured from text ranges.

The board and task routes enforce access through the workspace authorization wrapper. The saved screen renders text and column placement. Editing, assignment, drop targets and seat input come from the network-backed components after their respective reads.

The browser safety run passed on desktop and phone in English and Ukrainian, in light and dark themes. It verified that the seat name and at least one readable card rendered before any held data request completed. The network board then replaced the saved screen. Blocked IndexedDB, an open error and quota exhaustion each recovered through the network board.

On the same browser profile, a second signed-in member with access to the same project missed the first member's disk record. The workspace role change invalidated the record. Revocation redirected the member to the team page. Signing out cleared the disk record and returned the other open tab to the neutral shell.

The browser safety run above was made on `38d9782f5`, before the access check stopped gating reads and before the 900 px case existed. It has not been repeated on the revision that removes the gate (see Unknowns). The targeted DOM tests listed above were rerun on that revision, one file at a time in isolated state.

## Unknowns

- The two desktop reloads that drew the network board first might have had a missing or late disk record. The driver identified the winning surface and its network timings.
- Timings of the revision that starts the reads before the access answer are unknown. The review that asked for them also asked for a 20-run rerun on the same fixture. The machine that fixed the findings had about 3 GB of free memory and its instructions excluded a production build and a browser campaign, so nothing here was timed. The numbers in the table are the revision before the fix.
- Timings for signed-in teams are unknown for the same reason. The driver has the case (`BOARD_STARTUP_TEAM=1`: a member of a team-owned fixture, 15 s and 120 s of sleep, the access check held and then failed, with the cards and boot shell counted 600 ms later). Its first card within one frame while the check is held, and previous cards visible when it fails, are covered by `Viewer.bootAccess.dom.test.tsx` and not yet measured.
- The 900 px frames and geometry JSON in English and Ukrainian, light and dark, are unknown for the same reason. `skeletons.dom.test.tsx` covers the saved active column's content in tab mode; the clipping and overlap checks need the browser run.
- Real phone hardware, mobile radio changes, browsers other than Chromium, OS tab discard and production data remain unknown. The timing run used a solo fixture and Chromium's controlled network and tab lifecycle. Team access and storage failure paths have separate correctness cases.
- The measurements cover browser cold starts against a running Viewer. Cold server startup and production server queueing remain unknown.

## Reproduction

Run `BOARD_CAPTURE_CASE=board-startup BOARD_STARTUP_REPEATS=20 CHROME_BIN="$(command -v google-chrome-stable)" bun scripts/capture-board-geometry.ts` in a production build export with an isolated temporary root. The driver starts and stops the disposable Viewer and Chromium. Set `BOARD_STARTUP_SAFETY_ONLY=1` to run the correctness cases on the candidate, and `BOARD_STARTUP_TEAM=1` (its own run: the team claim cannot be undone) to time a signed-in member. The run writes `p50`/`p95` per profile and scenario into `board-startup.json` beside the rows. The retained raw files are `board-baseline-confirmed-seat.json` and `board-candidate.json`.
