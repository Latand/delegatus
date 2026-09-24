# Open PRs and unfinished backlog: verdict and next step for each (2026-09-24)

## Originating requirement

Pipeline `bd0125fc`, audit stage, assigned by the orchestrator on 2026-09-24. Quoted verbatim; it carries no credentials or personal data.

> Do Audit: every open PR and every unfinished backlog card, verdict and next step for each exactly as the spec says. Use gh (pr view, pr diff, issue view) and git on a fresh fetch of origin/main. Verify claims against code; never mark something fixed without naming the PR or the file:line that fixes it. Tables first, prose short.
>
> Deliverable: docs/design/pr-and-backlog-audit-2026-09-24.md. Read-only: close, comment on or push to nothing; the orchestrator acts on the verdicts.
>
> PART A — open PRs (skip #2109, its lane is in review): #2099 self-update after the remote moved; #2000 dependabot npm group; #1847 design doc for task states and reasons (#1844); #1714 kanban K7a operations feed; #1713 K6c follow-up section ownership; #1579 delivery canonical receipts (#1576); #1571 seat ticks only at an idle turn boundary (#1569); #1323 scope the deploy tool to the Viewer project (#1321, closed); #1250 Grok as a first-class engine. For each: what it does, how far main has moved past it (conflicts, superseded code, whether main already contains the behaviour; compare blobs, a squash may hide it), whether its linked issue is still real on current main, and a verdict: MERGE as is (after rebase), REWORK (the part still worth having and how big a lane it is), or CLOSE (with the one-line reason to post on the PR). For dependabot: which bumps are safe and whether anything pinned blocks it.
>
> PART B — unfinished backlog on the board (the orchestrator will launch lanes from this): SQLite state migration slices 5b-10 and #1872 (docs/design/state-sqlite-migration.md); retire flows S5-S9 (docs/design/retire-flows.md); finished agents free memory (#1805, #1728, #1816, #1817, #1818, #1808); first message flashes red JSON (#2006) and end-to-end send measurement; agents resume by themselves after a deploy (#1835); commands never answer busy (docs/design/command-intents.md); spend quota before its window resets (#2018); runtime-host stalls, six measured causes (docs/design/runtime-host-stall-profile-2026-09.md; PR #1968 shipped cause 1); slow work under the account lock (#1935); role-prompt evaluations (#1917, PR #1918 merged, pilot not run); board states and reasons (#1844, PR #1847); MCP instead of curl slice 2 (#1845); kanban undo/redo (#1856); CI audit leftovers (#1761); review lanes leave GB exports in /tmp (#1957); resources serves a stale session table (#2110); plus these open issues: #2088, #2108, #2015, #2009, #1870, #1446, #1546, #631, #1497, #1526, #1525, #1527, #1537, #872, #757, #749, #746, #717, #723, #725, #641, #636, #634, #628, #1569, #1576, #1695, #1709. Needs-attention (#1696) already has its own lane; skip it. For each: still real on current main (cite file:line or a quick repro), already fixed (by which PR), or obsolete (why). For the real ones: size (S/M/L), dependencies, and a ranked order of the next 8 lanes with a one-paragraph brief each. Issues that are fixed or obsolete get the exact closing comment to post.

## Basis

- `origin/main` = `f18a95a01` (#2107), fetched at the start of this stage. The worktree HEAD equals it. Every `file:line` below is on that commit.
- Each PR head was fetched as `pull/<n>/head`. Drift is `git rev-list --count <merge-base>..origin/main`. Conflicts are the files `git merge-tree --write-tree origin/main <pr>` reports. Behaviour on main was checked by reading the code at the named lines, because squash merges hide ancestry.
- "Fixed by" names a merged PR, and the merge commit that brought it to main when the commit subject does not say so.
- Prior work consulted: the backlog audit of 2026-09-18 (#1738), found through `search_transcripts`. Its verdicts on #1323, #1571, #1579, #1713 and #1250 were re-checked against today's main below. #1323 and #1250 now read differently: #1321 was fixed by #1748, and main gained a third engine. A transcript search for the K7b arrows found no operator direction after 2026-09-15.
- One live read-only check: the `resources` MCP tool, for #2110.
- In flight and out of scope: #2109 (phone Back, in review), the needs-attention lane `1a2b9823` (#1696, design), and retiring the systemd install path (`0dcea54e`, build).

---

## Part A — open pull requests

| PR | What it does | Behind main · conflicts | Already on main? | Linked issue on main | Verdict |
|---|---|---|---|---|---|
| **#2099** self-update after the remote moved | The failed Update card offers **Check again** after a `remote-moved` fetch failure, then **Update to checked `<sha>`** next to the changelog. Other failed steps keep Retry and gain the same update button. en + uk copy, a DOM test and a route test. | 20 · **0**; all CI checks green | No. On main the failed card offers only "Retry from Fetch" (`src/components/selfUpdate/SelfUpdateView.tsx:341-351`), which repeats the same stale target. Recovery works only through the header's **Check now** (`:195-202`), after which the fresh-target rule at `:275` replaces the failed card. | No issue | **MERGE** after rebase |
| **#2000** dependabot npm group (7 bumps) | next 16.3.3→16.3.5, react and react-dom 19.2.8→19.3.0, zod 4.4.3→4.6.5, eslint-config-next 16.3.2→16.3.5, playwright-core 1.62.1→1.63.0, typescript ^5→**^7** | 320 · **0**; **no CI check ran on the branch** (`gh pr checks`: none reported) | — | — | **CLOSE**, then one hand-made bump lane (S) |
| **#1847** design: task states and reasons | Design doc only (`docs/design/task-states-and-reasons.md`): one derived `taskMotion` function, a structured reason on every held card, partial-progress checklist, four open choices for the operator | 764 · **0**; CI green | No. There is no `taskMotion` or reason field in `src/`. `cardHasLiveWork` is still the only derived predicate (`src/components/OverviewKanban.tsx:16`). Every `src/` path the doc cites still exists. | #1844 real | **MERGE** as is after rebase |
| **#1714** kanban K7a operations feed | `GET /api/mcp/operations`: a read-only feed of `create_pipeline`/`update_task` receipts and a creation cursor, for the K7b arrows and creation animation | 815 · **4** (`src/lib/mcp/bindings.ts`, `src/lib/mcp/server.ts`, `src/lib/pipelines/engine.ts`, `src/lib/pipelines/store.ts`) | No. Nothing on main or in any open lane would read it: K7b never started, and the parity ledger still says "Not built" (`evidence/issue-1695/parity-ledger.md:25`). | #1695 (umbrella) | **CLOSE** |
| **#1713** K6c follow-up | The whole of K6c (it contains the closed #1711): an account switch carries the messages sent for it, in order. Adds an explicit per-conversation actuation section with a lease argument (`src/lib/deliveryActuation.ts`), drains `failed-recoverable` switches, plus a 634-line commit-message test | 816 · **3**: `src/lib/accounts/migration/coordinator.ts` (1 hunk, against #1983's inventory gate), `src/lib/pipelines/engine.test.ts` (1 hunk), `src/components/kanban/issue1695Accounts.browser.test.tsx` (deleted on main by #1780). `registry.ts` merges cleanly. **Its base is the branch of the closed #1711.** | No. `src/lib/deliveryActuation.ts` is absent on main. | **#1709 real**: `commitSuccessor` terminalizes every pending delivery (`src/lib/agent/registry.ts:8026`), and `terminalizeHeldDelivery` empties its text (`:1353-1354`). The P2 stranding is real too: main's coordinator returns early for a `failed-recoverable` switch without uncertain deliveries (the main side of the conflict hunk). | **REWORK**, M |
| **#1579** delivery canonical receipts | Reconciles an original delivery proven by the canonical transcript, fixes the UTF-8 chunk split, and adds a `reconcile-delivery` operator route | 857 · **5** (`runtime/client.ts`, `codexAppServerHost.ts` and its test, `runtime/contracts.ts`, `runtime-host/journal.ts`) | The cause is on main: stdout is decoded through a `StringDecoder` (`src/lib/runtime/codexAppServerHost.ts:1289`, used at `:1363`), from #1636. The raw-Responses scan arm landed through #1560 (per #1738). The recovery route is not on main (`grep reconcile-delivery src` finds nothing). | #1576's cause is fixed by #1636 | **CLOSE** (and close #1576) |
| **#1571** seat ticks only at an idle turn boundary | A 32-file rewrite of seat-tick admission. It stalled on REQUEST_CHANGES with two unfixed findings: P1, a proven-unsent retry can send cancelled work; P2, stale settlement evidence can cause an early wake. | 857 · **19** | No | **#1569 real, narrow**: after the verdict the controller re-reads seat authority and never checks idleness again before `deliver` (`src/lib/monitor/seatTickController.ts:1463-1481`). The check-time `seat-busy` fence exists (`src/lib/monitor/seatTick.ts:1036`). | **CLOSE**; fresh S lane (Part B) |
| **#1323** scope the deploy tool to the Viewer project | Refuses `deploy_exact_sha` from any other project's seat, and adds `projectIdentityFromRemote` for packaged releases | 967 · **7** | **Yes, by #1748**: `deploy_foreign_project` (`src/lib/mcp/bindings.ts:2419-2423`) and `projectIdentityFromRemote` (`src/lib/projects/identity.ts:182`) | #1321 closed, fixed by #1748 | **CLOSE** |
| **#1250** Grok as a first-class engine (outside contribution) | Adds a `grok` engine to spawn, scanner, accounts, efforts, models and the timeline; spawns Grok through **tmux** (`transport = engine === "grok" ? "tmux" : spawnTransport()`) | 993 · **35 files**; `privacy-publication` FAILURE | No `grok` anywhere in `src/`. Main has since added a third engine, Copilot, through a structured host (#2049 and follow-ups; `Engine` in `src/lib/types.ts:15`). Production spawns structured, and tmux is legacy (`src/lib/runtime/spawnTransport.ts:32-34`). | — | **CLOSE** with thanks |

### Closing lines to post

| PR | Comment |
|---|---|
| #2000 | Closing: the group moves `next` without renaming the `next@16.3.3` patch (16.3.5 still ships the unpatched line) and takes TypeScript 5→7 without a build; a hand-made bump carries the safe updates. |
| #1714 | Closing: the operations feed has no reader (K7b never started) and conflicts in four files; it comes back as the first commit of K7b if the arrows are scheduled. |
| #1579 | Closing: the cause of #1576, a UTF-8 character split across stdout chunks, is fixed on main by #1636 (`StringDecoder` in `codexAppServerHost.ts`); the remaining recovery route served only operations stranded before that fix. |
| #1571 | Closing: 19 of 32 files conflict and two review findings were never fixed; #1569's missing piece (an idle re-check between the tick verdict and delivery) goes to a fresh small PR. |
| #1323 | Closing: superseded by #1748, which refuses `deploy_exact_sha` for every project but the Viewer's own (`deploy_foreign_project`) and adds `projectIdentityFromRemote`. |
| #1250 | Closing with thanks: the branch is 993 commits behind with 35 conflicting files, and the engine seam has moved. Main now spawns agents only through structured hosts, and Copilot was added that way. A Grok engine would start fresh on that pattern. |

### Next steps for the PRs kept

- **#2099**: rebase onto main (no conflicts), wait for CI, merge. No review round needed: the diff is 5 files, and the view test covers both new buttons.
- **#1847**: rebase and merge the doc. Its slice 1 waits for two things: the operator's answers to its four open choices (column names, where queued cards sit, the 65 old cards, step count on collapsed cards), and the needs-attention lane's design, which also defines "needs you".
- **#1713**: lane M. Retarget the base to `main`. Rebase and resolve the coordinator hunk by keeping main's #1983 inventory gate (`hasDelivery`) and adding the `failed-recoverable` drain on top of it. Drop the deleted browser test and move its assertion into the `kanbanBoard.browser.test.tsx` describe block. Then run a fresh exact-head review against #1709's three findings. Close #1711's leftover lane if one is still open.

### #2000 per bump

| Bump | Verdict | Reason |
|---|---|---|
| react, react-dom 19.2.8→19.3.0 | Safe to try | Minor. Needs `bun run build` plus the `bun-runtime` job (the Viewer half loads every compiled server runtime). No check ran on this branch. |
| zod 4.4.3→4.6.5 | Safe to try | Minor. MCP schemas use zod (`src/lib/mcp/server.ts`); run `schemaParity.test.ts` and the MCP binding tests by path. |
| eslint-config-next 16.3.2→16.3.5 | Safe | Patch. CI does not lint. |
| playwright-core 1.62.1→1.63.0 | Safe to try | Minor. Used only by the browser evidence drivers, which CI does not run; run one kanban driver case locally. |
| next 16.3.3→16.3.5 | **Blocked by the pin** | `patchedDependencies` keys the patch to `next@16.3.3` (`package.json:95-96`), and the PR leaves that line alone. The published 16.3.5 tarball still carries the patched-away line (`dist/build/webpack/plugins/flight-manifest-plugin.js:356`, `if (concatenatedModId)`), so the patch is still needed. Rename it to `patches/next-16.3.5.patch` and re-key it in the same change. |
| typescript ^5→^7 | **Drop** | A major version. The build's own type check runs through Next's TypeScript integration, which is stricter than `tsc`. Next 16.3.4's notes fix a build error when `typescript` is aliased to `@typescript/typescript6`, which says 7 is not a drop-in. Add a Dependabot `ignore` for typescript major versions. |

---

## Part B — unfinished backlog

### B1. Programs with a design document

| Program | Shipped on main | Still to do (evidence on main) | Size | Depends on |
|---|---|---|---|---|
| **SQLite state, #1870** | Slice 1 tasks (#1877), 2 registry SQLite-only (#1894), 3 board (#1901), 4 bridge reports and channels (#2008), 5 attention, reply suggestions, seat-tick settings (#2013), 7 accounts (#1902), 10 durability (#1893). Registered collections: `src/lib/state/legacyCollections.ts:25-72`. | **4b seats**: `src/lib/orchestrator/seats.ts` still writes its own JSON with no state-store reference. **5b**: `push.ts`, `roles/store.ts`, `agent/nestingPolicy.ts`, `root/store.ts`, and the Telegram report and registration stores. **6 projects**: `projects/curation.ts`, `session/titleStore.ts` and the worktree map in `scanner/describe.ts`. The map is written in place and cannot be rebuilt once a checkout is gone (design §2.1 row 14). **8 histories and journals**: `limitsHistoryStore.ts`, `wakatime/sync.ts`, `reaperRuntime.ts`, `handoffLineage.ts`, `lifecycle/journal.ts:100` (`lifecycle-journal.json`), `monitor/journalStore.ts`, `accounts/resetCreditJournal.ts`. **9 Claude delivery ledger**: still per-session `.jsonl` (`src/lib/runtime/claudeStreamBrokerHost.ts:101,188`). | 4b M · 5b M · 6 M · 8 L (split 8a reaper, handoff lineage, limits; 8b WakaTime, lifecycle, seat-tick runs, reset credits) · 9 M | Slice 1's helper has shipped, so 4b–9 run in parallel (design §8), one lane each |
| **#1872** remove legacy import paths | — | Date-gated: due 2026-12-15, and not before two releases after the last #1870 slice. | M | All of #1870 |
| **Retire flows** | S1 (#1945), S2 (#1949, #1962), S3a (#1952), S3b (#2010), S4 (#2014) | **S5 has not started**: `POST /api/flows` still creates flows (`src/app/api/flows/route.ts:32`), and `create_pipeline` still accepts `review-loop` (`src/lib/mcp/server.ts:3080`). S6 UI, S7 teaching and docs, S8 engine deletion, S9 compatibility window. | S5 L · S6 L · S7 M · S8 L · S9 S | S5 needs a read-only preflight first (design §S5), and the conveyor must create run-stage reviewer graphs before review-loop is frozen. S6 ∥ S7 after S5; S8 after both; S9 after the window. |
| **Commands never answer busy** (`command-intents.md`) | Slice 1: pipeline spawn off the lease (#1948). A busy refusal keeps its request id (#1788). | Commands still answer busy: `busyMessage: "pipeline state is busy"` (`src/lib/pipelines/store.ts:967`). The `src/lib/commands/` custody module (slice 3) does not exist. Slices 1a, 2 and 4–7 remain. | 1a M · 2 S · 3 M · 4 L · 5 L · 6 L · 7 M | 3 before 4; 4 before 5–6; 7's lock holders overlap #1935 |
| **Runtime-host stalls** (six measured causes) | Rank 1, async provisioning (#1968). Rank 3, keyed admission (#1963). Rank 4, linear response framing (#1987: `src/lib/runtime/client.ts:312-318`). | **Rank 2**: the checkpoint anti-join is still `DELETE … WHERE NOT EXISTS` (`src/runtime-host/journal.ts:1657`). **Rank 6**: synchronous `PRAGMA incremental_vacuum(2048)` still runs on the receipt tick (`journal.ts:1753`). **Rank 5**: no session projection cache; measure again after 2 and 6 first (design says so). | 2+6 one lane M · 5 M | `journal.ts` contains NUL bytes: read it with `grep -a`, and edit it by script rather than the Edit tool |
| **Send latency and end-to-end measurement** | Slice 1, output publication (design §10). Slice 2, keyed admission (#1963). Slice 3, one message one row (#1950). | **Slice 0 (the measurement) has not started**: there are no timing hooks at submit, admission, engine, SSE or paint. `conversationWindow.browser.test.tsx` has a `#1793 launch-prompt bubble` case (`:32`) and nothing timed. | M | Pairs with #2006 in one lane (same driver and fixture) |

### B2. Issues

**Still real**

| Issue | Evidence on main | Size | Depends on / note |
|---|---|---|---|
| #1709 switch empties held messages | `registry.ts:8026`, `:1353-1354` (see #1713) | M | PR #1713 rework |
| #1695 kanban umbrella | Open rows in `evidence/issue-1695/parity-ledger.md` (K6c, K9a/b, F3 seat-tick controls, F4 arrows) | — | Keep open as the umbrella. Close it once K6c lands and the remaining ledger rows have their own issues. |
| #1728 final stage host never reaped | The terminal reap runs before `tickPipeline` (`src/lib/pipelines/engine.ts:5113` vs `:5117`), so a clean round sets `settledAt` (`:4966-4968`) while the last stage still runs. Once the pipeline completes, `pipelineControllerActive` stops ticking it (`src/lib/pipelines/store.ts:933-934`), so the final host is never probed. | S | Touches `engine.ts`, like #1835; merge one after the other |
| #1816 per-agent MCP server holds payloads | `board_snapshot`, `operator_snapshot` and `resources` still run in-process in each agent's MCP server (`src/lib/mcp/bindings.ts:5179,5186,5188`). Only `search_transcripts` goes through the Viewer (`:5173`). | M | After the #2110/#1817 lane (same `resources` binding) |
| #1817 resources hides the Viewer's own memory | `ResourcesPayload` is `{ system, sessions }` only (`src/lib/types.ts:818-821`) | S | Same lane as #2110 |
| #1818 a sweep that retires nothing is invisible | The signal fires only on `failed` or `undetermined` (`src/lib/monitor/seatTickSources.ts:913-916`) | S | Same lane as #1728 |
| #1808 restart re-reads the Claude corpus tail | The priming fence is unchanged (`src/lib/scanner/activity.ts:247`) | S | Persist the evidence that closed the turn next to the projected turn |
| #2110 resources serves a stale session table | **Reproduced 2026-09-24 06:07Z**: `freshness.cache: "durable"`, `reason: "collector-crash"`, while every `sessions[].lastActiveAt` is from 2026-09-20 and `capturedAt` is today. `freshness` dates only the system block (`capturedAtScope: "system"`, `src/lib/mcp/bindings.ts:3827-3834`). One crash cause the code can raise: an observation over the durable size limit (`src/lib/resources.ts:1271-1278`). | S–M | — |
| #1835 deploys cut builders (slices 2–3) | Slice 1 shipped (#1863). A host that stays unavailable past its grace window still settles the attempt as failed with `HISTORICAL_MISSING_STAGE_VERDICT` (`engine.ts:3498-3524`). A later `stage_report` gets `STAGE_REPORT_SETTLED` (`engine.ts:7754-7761`). Reopening covers only delivery-unverified attempts (`deliveredAttemptPath`). A cut read-only stage fires its fail edge. | M | `engine.ts`, shared with #1728 |
| #2006 first message flashes red JSON | No fix landed. Likely path: until the engine format is known, a record is parsed as plain text, and any line matching `/error|failed/` is styled `text-danger` (`src/components/feed/parse.ts:3276,3335` → `FeedItem.tsx:383`). A launch envelope with an `"error"` key matches. The lane must confirm this with the driver before changing anything. | S–M | Lane with send slice 0 |
| #2018 spend quota before reset | Ranking is by remaining headroom only (`src/lib/accounts/headlessSelection.ts:92`); reset times are not read. Claude usage is already probed live (`src/lib/limits.ts:27`, OAuth usage), so the lane is mostly policy plus visibility. | M | — |
| #1935 slow work under the account lock (item 3) | Items 1–2 fixed by #1944. Still held: the Claude and Codex registry-lock spin, with `sleep(10)` inside `withAccountMutationLock` (`src/lib/accounts/claude.ts:158-173`; `codex.ts:297`), the seat rollback (`src/lib/orchestrator/seatCommand.ts:441,482`), identity-wave startup, and bindings readback. Since slice 7 the account rows live in SQLite, so the file registry lock may be removable outright. | M | Command-intents slice 7 lists the same holders |
| #1917 role-prompt pilot | Harness merged (#1918). `evals/roles/pilot-status.json:3` is `"pending-root-trials"`, with 0 of 9 candidate trials. | M (~50 worker requests) | Needs the operator's go-ahead to spend quota |
| #1844 board states and reasons | Nothing derived yet (see #1847) | Slice 1 M | #1847 merged, the operator's four choices, and the needs-attention design |
| #1845 MCP instead of curl, slice 2 | Done: the `update_task` acknowledgement and compact `list_tasks` (current tool schemas). Still missing: **defect A**, `GET /api/tasks` ignores every query parameter (`src/app/api/tasks/route.ts:17-23`), and `update_task` `replaceLine` for card text (only `seat_tick_settings` has it, `src/lib/mcp/server.ts:3667`). | S | — |
| #1856 kanban undo/redo | Step 1 done (header controls removed, #1855). Moves and hides already have revision-guarded Undo receipts (`src/components/kanban/KanbanBoard.tsx:642,931`), and `U` runs the latest (`:1492-1500`). **Still missing**: undo of a text edit, redo, and Ctrl+Z. | S | — |
| #1761 CI audit leftovers | Cut steps 1–6, 8 and 9 shipped (#1772–#1780). Still open: step 7 (the other 33 wall-clock test files), step 10 (no workflow has a `paths:` filter), step 11 (merge queue, a repository setting). | S | Step 11 waits for a green week after step 5 |
| #1957 review exports fill /tmp | Restricted stages already get a disk-backed scratch `TMPDIR`, removed when the host releases (`src/lib/runtime/structuredSpawn.ts:157-181`, #1095). Unrestricted stages get none. **Seen today**: two review exports of 1.1 GB each left in `/tmp` (`registry-review-build-*`, `s6-gates-*`), and there is no temp-usage signal in `src/lib/monitor/`. | S | — |
| #1569 seat tick into a starting turn | `seatTickController.ts:1463-1481` (see #1571) | S | — |
| #2088 skip-stage strands the next review-loop | `latestPassedRun` accepts only a `passed` run attempt (`engine.ts:3727-3730`, the helper at `latestPassedRun`), so a run stage skipped with `acceptedSha` leaves the review-loop parked | S | Goes away with retire-flows S5 (no new review-loop stages). Patch it only if S5 is more than two weeks out. |
| #2015 review fence races the implementer | The dirty-tree park (`src/lib/pipelines/git.ts:334`) and the pre-launch head check (`src/lib/flows/engine.ts:284`) are both review-loop and flow paths | S | Same as #2088: retire-flows removes both paths |
| #1525 deploy signal goes to every project | `signals(project, …)` adds the failed-deploy signal without using `project` (`src/lib/monitor/seatTickSources.ts:907-911`) | S | — |
| #1537 provenance retry dies on a failed read | `if (!res.ok) return;` (`src/components/feed/messageProvenance.tsx:445`) and the `catch` at `:463` both skip rescheduling | S | — |
| #1497 sign-in and per-message authorship | No member model or author field in the delivery path | L | First slice of #634 |
| #634 shared workspace epic | Epic; #1497 is its first slice | L | Product decision |
| #746 automatic analysis | Phase A (the manual experiment) was never run | M (Phase A) | Product decision |
| #725 rotate long Live Mode sessions | Not built | L | — |
| #717 ambient audio stops on iPhone lock | Still an `AudioBufferSourceNode` loop in a Web Audio context (`src/lib/audio/webAudioTransport.ts:215`) | S–M | Needs an iPhone for acceptance |
| #636 private HTTPS remotes in the container | Pipeline git fails fast now (`GIT_TERMINAL_PROMPT=0`, `src/lib/pipelines/git.ts:123`), but it still cannot reach a keyring-backed credential. The affected repository was moved to SSH by hand (issue comment). | M | Run pipeline fetch through the host shim the agent CLIs already use |

**Unconfirmed: one cheap check decides**

| Issue | Why it is unconfirmed | The check |
|---|---|---|
| #2108 stage parked before launch cannot restart | The refusal text is raised only when `stageId` is sent without `launchId` (`engine.ts:7283-7285`). A bare `retry-stage` takes the reset path with `launchId: null` (`:7286-7290`). Whether that path reaches a fresh attempt for a capacity-parked stage was not run. | Isolated-state engine test: park a stage on no capacity, then send `retry-stage` with no ids. If it spawns, document it and close; if not, it is an S fix. |
| #1526 parked items crowd the wake agenda | The agenda has been reworked since the 2026-09-05 audit (#1737 controls, #1746 fences, #2063 deploy wakes) | Run the issue's own acceptance fixture against main (S) |
| #641 recreated launch stays "delivering" | The pieces it names still exist (`OUTBOX_LIMIT = 32`, `OUTBOX_DELIVERED_TTL_MS`, occurrence tombstones: `src/components/conversation/outbox.ts:530,539,668`). #1800 and #1950 rewrote the neighbouring code. | Its five-step reproduction as a DOM test (S) |
| #749 stale transcript blocks after compaction in voice | This repository only parses `<transcript_delta>` (`src/components/feed/parse.ts:197`). The window it describes belongs to the Codex realtime session. | One live voice call through a compaction. If it reproduces, report it upstream. |

**Fixed or obsolete: closing comment to post**

| Issue | Verdict | Exact closing comment |
|---|---|---|
| #1805 | Fixed, except work that has its own issues | Closing: the diagnosis's defects are fixed on main. A finished Claude turn settles on its stop reason (#1803, `turnState.ts:267-287`). Liveness reads the last transcript event in place of the file mtime, and boot adoption refuses stale turn claims (#1827, `liveness.ts:466`, `startup.ts:1043-1049`). `conversation_action kill` goes through the Viewer's controls, which hold the runtime socket (#1829). What remains is tracked separately: #1728 (final stage host), #1816 (MCP server memory), #1817 (the Viewer's own memory in resources), #1818 (a sweep that retires nothing), #1808 (restart priming). |
| #1576 | Fixed | Closing: the cause, a two-byte character split across Codex stdout chunks, is fixed by #1636, which decodes stdout through a `StringDecoder` (`src/lib/runtime/codexAppServerHost.ts:1289,1363`). PR #1579 is closed with it. Reopen with a fresh capture if a delivered message is ever left uncertain again. |
| #2009 | Fixed by #2061 (commit 55e8a21c0) | Closing: fixed on main by 55e8a21c0, merged with #2061. The fixture is built in its own process by `src/components/kanban/buildEvidenceFixture.ts`, which replaces each `"use server"` module with async stubs the way Next does (`:21`), so the browser build no longer reaches `node:os`. |
| #1527 | Fixed by #1850 and #1941 | Closing: the ledger read orders newest-first before `LIMIT` (`NEWEST_DEPLOYMENT_FIRST`, `src/lib/runtime/deploymentLedger.ts:86,120`, #1850). The runtime host's list uses a recency index with offset-aware ordering (#1941, `src/runtime-host/deploymentList.test.ts`). HTTP and MCP both read these. |
| #631 | Fixed by #1545 | Closing: `create_task` and `update_task` accept `pos: { x, y }` with `placement: "pinned"`, fenced by `expectedProject` and `expectedRevision` (#1545). Since the kanban flip, status is the column, so no column or rank tool is needed. |
| #1446 | Design delivered | Closing: the design and ADRs landed in #1449. Execution happened in the graph slices (#1727, #1736, #1778: editing a started pipeline, stage reports, runtime per stage) and continues as retire-flows S5–S9 (`docs/design/retire-flows.md`). |
| #1546 | Obsolete | Closing as obsolete: the desktop Scheme board was retired when the kanban became the desktop board (#1712). The populated-board work moved to the kanban and landed in #1718, #1721 and #1729. |
| #628 | Obsolete | Closing as obsolete: the desktop Scheme board these controls would surround was retired with the kanban flip (#1712). The desktop now has Board and Conversations, and neither has a selected pane to navigate around. |
| #757 | Obsolete | Closing as obsolete: board cards are tasks since the kanban flip (#1712). The task that holds the orchestrator seat cannot be hidden (`TASK_HIDE_PROTECTED`, `src/lib/tasks/commands.ts:497`). A hidden group comes back when something new needs the operator. Conversations lists every conversation of the project with no cap (`evidence/issue-1695/parity-ledger.md`, accepted corrections), so nothing the operator wrote to can become unreachable. |
| #723 | Superseded | Closing: step 1, answering from the last completed scan index, exists as the persisted scan snapshot (`src/lib/scanner/scanCache.ts:104`, read by `src/app/api/files/route.ts:350`). The remaining restart cost is measured and tracked in #1808. |
| #872 | Obsolete | Closing as obsolete: the free-standing conversation cards this cascade would close belonged to the Scheme board, which was retired with the kanban flip (#1712). On the kanban every conversation is drawn inside the card of the task it belongs to (`src/components/kanban/kanbanModel.ts:25-31`), and that card moves and hides as one group, so a closed pipeline leaves no loose cards behind. |

---

## Ranked: the next 8 lanes

Launch at most three or four at once. #1805's out-of-memory freeze came from lanes, their MCP servers and a desktop indexer together, and a rendered-evidence driver is the heaviest step in any lane.

| Rank | Lane | Issues | Size | Depends on |
|---|---|---|---|---|
| 1 | K6c: messages survive an account switch | #1709, PR #1713 | M | — |
| 2 | A deploy cut costs nothing (slices 2–3) | #1835 | M | Serialize with lane 3; both edit `engine.ts` |
| 3 | Hosts never outlive their work, and say so when they do | #1728, #1818 | S | `engine.ts` terminal reap |
| 4 | Resources tell the truth | #2110, #1817 | S–M | Before #6 |
| 5 | SQLite slice 6: projects | #1870 slice 6 | M | — |
| 6 | The agent's MCP server stops holding whole payloads | #1816 | M | After #4 |
| 7 | Runtime-host stalls, ranks 2 and 6 | stall profile | M | — |
| 8 | Unattended work spends the quota that resets first | #2018 | M | — |

**1. K6c: messages survive an account switch (#1709, PR #1713).** Today a completed switch fails every pending delivery of the conversation and empties its text (`registry.ts:8026`, `:1353-1354`). The picker promises the opposite, so the operator loses exactly what they typed while the switch waited. PR #1713 already carries the fix and the three follow-ups the #1711 review reproduced. The lane retargets it to `main` and rebases. It resolves the one coordinator hunk by keeping #1983's `hasDelivery` inventory gate and adding the `failed-recoverable` drain. It moves the deleted `issue1695Accounts` browser assertion into the kanban driver's describe block, then runs the named tests by path in an isolated state directory and gets a fresh exact-head review against #1709's findings. Close #1711's lane if one is left. Done when a message sent during a waiting switch is delivered after it, in order, and #1695's ledger row for K6c moves to "Closed on main".

**2. A deploy cut costs nothing (#1835 slices 2–3).** Slice 1 (#1863) sends one continuation to each cut conversation, and it worked live. Cut attempts are still retired: a host unavailable past its grace window settles the attempt failed (`engine.ts:3498-3524`). The builder's later `stage_report` is then refused as settled (`:7754-7761`), and a cut read-only stage fires its fail edge with no findings. Scope: mark an attempt whose turn was cut by the deploy handover as interrupted and keep it open. Accept `stage_report` from the conversation that owns the latest attempt when only the cut settled it. Re-run a cut read-only stage without taking the fail edge. Report a builder that cannot be re-hosted with its worktree state (dirty files, commits ahead). The seat's own resume after a deploy is the last item and needs a live deploy to prove it. Tests run the engine in isolated state; one `deploy_exact_sha` rehearsal on staging closes it. `engine.ts` is shared with lane 3, so merge one after the other.

**3. Hosts never outlive their work, and say so when they do (#1728, #1818).** A completed pipeline keeps its final stage host: the terminal reap runs before `tickPipeline` (`engine.ts:5113` vs `:5117`), a clean round sets `settledAt` while the last stage still runs, and then `pipelineControllerActive` stops ticking the completed pipeline (`store.ts:933-934`). Fix: never settle the reap while any launched attempt is still unsettled, or run the reap again after `tickPipeline` completes the pipeline. The regression test is the issue's two-stage repro in isolated state. In the same lane, the seat-tick signal (`seatTickSources.ts:913-916`) also fires when a sweep window retires nothing while one clause refuses more than a threshold, and names that clause. Both are small, and together they close the part of #1805 still open.

**4. Resources tell the truth (#2110, #1817).** Reproduced today: `resources` served sessions last active on 2026-09-20 under `cache: durable`, `reason: collector-crash`. `freshness` dates only the system block (`bindings.ts:3827-3834`), so a seat reads days-old rows as current. Scope: stamp the session table with its own capture time and `stale: true` on a fallback, or drop it. Log the collector crash with its cause; the durable size limit at `resources.ts:1271-1278` is one candidate the code can raise. Make `fresh: true` report `refreshSucceeded`. Add a `viewer` section attributing the release's own process tree (next start, runtime host, workers), marked non-actionable, returned by the MCP tool and shown in the footer (`types.ts:818-821`). Footer changes need desktop and phone renders through the existing drivers.

**5. SQLite slice 6: projects.** The worktree map is the one remaining store written in place that cannot be rebuilt: when a sibling worktree is deleted, only this map regroups its sessions (AGENTS.md recognizer #6). Aliases, curation and session titles move with it (design §8 row 6: `projects/aliases.ts`, `curation.ts`, `scanner/describe.ts`, `session/titleStore.ts`). The lane reuses the slice-1 import helper and registers the collections in `legacyCollections.ts`. It must add the AGENTS.md case "deleted worktree still groups under its parent repo" through the SQLite map after import. Tests by path in mkdtemp state; never the live directory (#1905).

**6. The agent's MCP server stops holding whole payloads (#1816).** Every agent runs its own stdio MCP server, measured at up to 1.1 GB, because `board_snapshot`, `operator_snapshot` and `resources` build their answers in that process (`bindings.ts:5179,5186,5188`). `search_transcripts` already goes through the Viewer's control endpoint (`:5173`), and that is the pattern to follow. Move the three reads behind `viewerControl` routes that answer the bounded payload, so the MCP process parses only what it returns. Measure MCP RSS before and after with the same call mix on an isolated Viewer. Run it after lane 4, because both edit the `resources` binding.

**7. Runtime-host stalls, ranks 2 and 6.** Two measured stalls are still on main. The compaction checkpoint sweep is an anti-join over the whole table on every append (`journal.ts:1657`; 9–14 ms per append, 0.27–0.42 s of loop per second at 30 appends/s). The receipt tick runs a synchronous `incremental_vacuum(2048)` on the host connection (`journal.ts:1753`; 416 ms observed). Delete checkpoints by the retiring event range inside the same transaction, keep a bounded orphan cleanup, and move reclamation to the existing maintenance path in small steps. The lane must prove the surviving rows are identical at each boundary on a copied journal at its retention limit. `journal.ts` contains NUL bytes: read it with `grep -a` and edit it by script. Rank 5 (the projection cache) waits for a new measurement after this lane.

**8. Unattended work spends the quota that resets first (#2018).** `selectHeadlessAccount` sorts by remaining headroom only (`headlessSelection.ts:92`), so an account about to lose most of its weekly window is picked last. Among accounts with confirmed headroom, prefer the one whose binding window resets soonest and still has enough headroom. Fall back to today's order when reset times are unknown or equal. Claude usage is already read live (`limits.ts:27`). The lane confirms that Claude observations reach the selector as fresh, and fixes the path if they do not. Show each window's reset and the next-chosen account in `account_limits` and in the accounts panel (en and uk). Unit tests cover the three cases the issue names.

**After the eight, in order:** #1569's dispatch-time idle re-check (S). #2006 plus send-latency slice 0 in the conversation driver (M). #1845 slice 2 remainder: defect A and `update_task` `replaceLine` (S). #1935 item 3 (M). SQLite 4b seats (M), 5b (M), 8a/8b, 9. Retire-flows S5 (L), once the conveyor creates run-stage reviewers; it also retires #2088 and #2015. #1957 (S). #1525 and #1537 (S each). The four unconfirmed checks (S each). #1761 steps 7 and 10 (S). #1856 remainder (S). Command-intents slices 1a and 3 onward (a program). #1917's pilot, when the operator approves the spend.

---

## Deferred — not currently justified

- **K7a/K7b manager arrows** (#1714, part of #1695): no operator direction since 2026-09-15, and nothing on the board reads the feed. Rebuild the feed as K7b's first commit if the arrows are ever scheduled.
- **Grok engine** (#1250): no requirement names it. If one appears, it is an L lane on the Copilot structured-host pattern.
- **Runtime-host stall rank 5** (the projection cache): the design itself says to measure again after ranks 2–4 first. Ranks 3 and 4 have shipped; lane 7 ships 2.
- **#1497 and #634** (sign-in, shared workspace), **#746** (automatic analysis), **#725** (Live Mode rotation), **#717** (iPhone ambient audio), **#636** (HTTPS credentials in the container): real, but no current requirement ranks them above the eight lanes. #636 has a working per-repository fallback (SSH remote).
- **#1917 pilot**: the harness is ready. Running it spends about 50 worker requests of quota, and the operator has not asked for it since 2026-09-20.
- **#1872**: gated by date (2026-12-15).
- **Merge queue** (#1761 step 11): a repository setting, after a green week.
- **Patching #2088 and #2015 inside review-loop**: retire-flows S5 removes the stage kind both live in. A patch is worth it only if S5 slips past two weeks.

## Check against the originating requirement

| Requirement | Where |
|---|---|
| Every PR in Part A except #2109: what it does, drift, conflicts, superseded code, behaviour on main, linked issue, verdict | Part A table, all nine rows |
| One-line closing reason for each CLOSE | "Closing lines to post" |
| Dependabot: safe bumps, pin blockers | "#2000 per bump": the `next@16.3.3` patch key, TypeScript major |
| Every Part B item: real, fixed (by which PR) or obsolete (why), with file:line or a repro | B1 programs; B2 real, unconfirmed, fixed or obsolete; #2110 reproduced live |
| Size and dependencies for real items | B1 and B2 size and dependency columns |
| A ranked order of the next 8 lanes with a one-paragraph brief each | "Ranked: the next 8 lanes" |
| Exact closing comment for fixed or obsolete issues | "Fixed or obsolete" table |
| Nothing marked fixed without a PR or file:line | Each fixed row names its PR and a line; four items with no decisive evidence are listed as unconfirmed with the check that decides them |
| Read-only | Only this file was written; no comment, close or push was made |
