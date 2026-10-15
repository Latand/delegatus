# ProjectDashboard derivation audit — 2026-10-15

Current main still misses the project-board acceptance criterion. With 357 cards, an open conversation, 40 transcript events/s, CPU ×4 and 30 seconds of scrolling, all three ordinary-source runs contained a clock-triggered long task with more than 50 ms of sampled dashboard/board-model work. Exact callback measurements confirmed cumulative derivation work above 50 ms in all three paired diagnostic runs. The remaining trigger is the board clock and its downstream invalidation chain; text deltas themselves no longer rebuild ProjectDashboard per event.

The individual ProjectDashboard callbacks stayed below 50 ms in the six-CPU-quota measurements. The downstream card-model callback crossed 50 ms once, including a browser garbage collection pause. Two additional ProjectDashboard callback crossings occurred in the earlier three-CPU-quota experiment, also with substantial garbage collection. The report distinguishes those inclusive timings from the repeated cumulative stalls. No product fix was applied.

**Source and prior evidence.** The measured commit is `45d25ac796d5824713c9fb57d65f57efea61041b`. `git ls-remote origin refs/heads/main` returned that commit at 05:12:34Z and again at 05:33:46Z. `git log --first-parent --oneline -80` and `git show --stat 2ab80be01` confirm that #2813 is included. Its `evidence/overview-performance/README.md` measures Overview, with a held display clock. Its shared layout, workflow-projector and card-cache changes are included here.

The requested earlier lane was read through `search_transcripts` with `query="44209be7 357", project="delegatus"`, then `conversation_messages` at the returned transcript paths, requesting assistant messages and tool calls. Searches also used `ProjectDashboard derivation` within the project, and `357 streaming fps` without a project. These reads ran during 05:12–05:14Z. The lane's October 2 review recorded a residual 357-card frame-rate gap and explicitly left the dashboard derivations open. Its final repair report recorded three runs per side and attributed much of the frame-rate problem to glyph animations. Those historical frame rates provide background; the measurements below establish the current baseline. `git show cd02f65a1:scripts/profile-kanban-board.ts` and the current `scripts/profile-kanban-board.ts` supplied the corpus and event-envelope recipe.

`search_memory` for `ProjectDashboard derivation 357` within the project and `kanban streaming performance` globally returned no relevant result. The later fixture-readiness search `conversation fixture hidden ready` returned an offscreen-reader note, opened by its returned memory ID and checked against the current reader implementation. No production service, production database, live runtime, deployment or browser session was accessed.

**Measurement contract.** The executed case is `ProjectDashboard derivation audit > profiles 357 cards during streaming and scrolling with a conversation open`, appended only to a scratch export's existing `src/components/kanban/kanbanBoard.browser.test.tsx`. It uses `serveEvidenceFixture`, `openFixture`, the existing `issue1695Evidence.fixture.tsx`, production React and the production stylesheet. The two bundles differ only by callback timing probes. Each pair runs ordinary source (`raw`) and probed source (`timed`) in fresh browser contexts, with order raw/timed, timed/raw, raw/timed. These are diagnostic pairs, with no candidate implementation or claimed speedup.

The corpus is the prior profiler's 280 historical builders, two historical reviewers per builder, 600 historical tasks (60 placed), plus the existing pipeline scenario. Actual counts were **864 files, 284 flows, 619 tasks, 357 rendered cards**, with six currently live fixture sessions. Events are round-robin across those six sessions at **40 events/s in aggregate**. Each contains the existing `delta` envelope, advancing session revision and sequence, with the same sentence fragment as the earlier profiler. Received revision increments matched emitted events in every run; the open export conversation visibly contained the streamed fragments.

Chromium **156.0.8078.4**, Bun **1.4.0**, 1440 × 900, dark/en, device scale 1, normal motion, desktop scrollbars visible; host CPU **i9-12900K, 24 logical CPUs**. CDP applies `Emulation.setCPUThrottlingRate({rate:4})`. The page warms for three seconds after the conversation becomes visible; the measurement includes a real 30-second board-clock deadline. Wall clocks keep advancing.

The current agent window covers the board. The actual scrolling target is its visible `[data-log-feed-scroller]`; ProjectDashboard and its 357-card board remain mounted underneath. Wheel input is ±100 px, reversing every 30 requests, with a nominal 100 ms wait between requests, for at least 30 seconds. The script awaits every wheel operation. Scroll-event counts and positions prove movement. The first pilot aimed at the covered task column and observed zero movement; it failed its assertion and is excluded. A preceding readiness pilot waited on the dimensionless window layer; the final case waits on `[data-agent-window-frame]`. These measurements cover conversation scrolling with the project board mounted. Actual wheel counts vary with main-thread load, so this audit makes no frame-rate improvement comparison.

All runs used the required installed `gate-slot.sh`, isolated HOME/config/temp/state roots, and `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:9`. The fixture server bound port 0, all application API responses came from the fixture, and owned browser contexts/servers closed in `finally`. Dependencies were borrowed from a checkout with byte-identical package manifest, Bun lock and patches; nothing was installed into the pipeline worktree.

The default gate quota of three CPUs produced measurable throttling. The confirmation and stream-only runs used the same gate with `DELEGATUS_WORK_SCOPE_CPU_QUOTA=600`: six CPUs, an eight-GiB gate memory limit, and an eighteen-CPU ancestor budget. The catalog confirmation incurred 5.2–43.5 ms of kernel-reported throttled time per window; the stream-only runs incurred 35.4–146.5 ms. The ancestor recorded zero throttling. These measurements used bounded CPU resources on a shared machine with light residual throttling. All timestamps below are UTC on 2026-10-15.

**Three paired stream-only runs.** `PD_POLL_MS=0`; only runtime text events and the product's ordinary timers run. “LT” counts `ThreadControllerImpl::RunTask` events above 50 ms on the page's main thread, whose starts fall inside the marked window. The maximum is a whole browser task, containing work beyond dashboard derivation.

| Pair / variant | UTC bounds | Window s | Events sent = received | Actual scroll events | All LT | Largest task ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 / raw | 05:28:40.660Z–05:29:11.001Z | 30.100 | 1203 | 163 | 89 | 198.2 |
| 1 / timed | 05:29:21.738Z–05:29:52.198Z | 30.199 | 1206 | 147 | 159 | 300.9 |
| 2 / raw | 05:30:44.650Z–05:31:14.964Z | 30.068 | 1198 | 129 | 190 | 219.2 |
| 2 / timed | 05:30:02.839Z–05:30:33.187Z | 30.134 | 1205 | 166 | 43 | 218.5 |
| 3 / raw | 05:31:26.951Z–05:31:57.498Z | 30.259 | 1210 | 120 | 217 | 256.8 |
| 3 / timed | 05:32:10.945Z–05:32:41.408Z | 30.176 | 1206 | 114 | 253 | 298.1 |

| Pair | Raw sampled dashboard + board render maximum within one LT, ms | Timed ProjectDashboard render maximum, ms | Timed card-model callback maximum, ms | Tasks whose memo callbacks alone exceed 50 ms | Maximum non-overlapping memo time in one task, ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 56.6 | 23.6 | 85.5 | 2 | 110.1 |
| 2 | 64.1 | 24.9 | 33.4 | 1 | 61.3 |
| 3 | 87.0 | 27.4 | 36.4 | 2 | 58.6 |

There were exactly two ProjectDashboard renders and two KanbanBoard renders in each timed stream-only window, despite about 1,200 received text events. The two renders follow the seconds and milliseconds clock updates. In pair 2, the first render started 21,821.6 ms into the measured window: `pipelineLayout` observed `layoutGroups, layoutManual, nowSeconds`, and the card model observed `bands, modelNow`. About 294 ms later, `directReviewGroups` and `launchHistory` observed `nowMs`; another layout and card model followed with `bands` as the only changed card-model dependency. The first task contained **61.3 ms of non-overlapping memo callback work**, although its largest individual callback was 33.4 ms.

Ordinary-source CPU samples corroborate the attribution. In pair 3, the clock task lasted **256.8 ms** with **256.1 ms** of trace thread time. Samples inside it attribute **13.2 ms** to `buildSchemeLayout`, **36.2 ms** to `deriveKanbanModel`, and **20.2 ms** to `reuseKanbanModel`; the latter two alone total about **56.5 ms**. The sampled figures estimate inclusive execution time. The directly measured diagnostic callbacks supply the independent cumulative timing evidence. Other long tasks in the table include feed rendering, geometry reads, React work and browser GC. Attribution below counts only correlated derivation work.

**Catalog-refresh stress and CPU-quota check.** A separate three-pair experiment adds the older profiler's `profileUpdate()` every 500 ms: replace `files[0]` (the historical search implementer) with `mtime + 1` and `size + 1`, then dispatch `llv:files-changed`. This supplies a changing `/api/files` answer while text events and scrolling continue. It is an explicit stress input; current runtime text deltas do not imply a 500 ms catalog refresh in production. The same experiment was first run with the default three-CPU quota, then repeated with six CPUs to check the scheduling effect.

| Pair | Six-CPU raw UTC | Raw LT / maximum ms | Six-CPU timed UTC | Timed LT / maximum ms | Timed tasks with >50 ms memo work / maximum memo ms |
| --- | --- | ---: | --- | ---: | ---: |
| 1 | 05:23:48.467Z–05:24:19.009Z | 109 / 264.1 | 05:24:29.108Z–05:25:00.172Z | 60 / 221.9 | 10 / 68.6 |
| 2 | 05:25:50.775Z–05:26:21.587Z | 85 / 247.6 | 05:25:10.160Z–05:25:41.119Z | 80 / 267.2 | 20 / 79.0 |
| 3 | 05:26:31.325Z–05:27:01.627Z | 81 / 271.0 | 05:27:11.122Z–05:27:41.985Z | 66 / 199.1 | 13 / 64.5 |

The confirmation delivered 1,200–1,215 events and 59–60 catalog updates per window. Raw-source sampling also showed more than 50 ms of dashboard/board render work in 22, 12 and 12 tasks. The repeated catalog result survives the larger CPU quota. The default-quota results remain in the evidence rather than being discarded:

| Pair | Three-CPU raw UTC | Raw LT / maximum ms | Three-CPU timed UTC | Timed LT / maximum ms | Timed tasks with >50 ms memo work |
| --- | --- | ---: | --- | ---: | ---: |
| 1 | 05:19:13.882Z–05:19:44.789Z | 86 / 316.0 | 05:19:55.368Z–05:20:26.127Z | 98 / 266.3 | 26 |
| 2 | 05:21:19.431Z–05:21:50.239Z | 130 / 422.9 | 05:20:36.400Z–05:21:07.817Z | 120 / 311.7 | 30 |
| 3 | 05:22:00.818Z–05:22:31.228Z | 65 / 217.7 | 05:22:41.491Z–05:23:12.559Z | 105 / 314.4 | 29 |

**Exhaustive observed individual callback crossings.** Probes covered all 69 `useMemo` sites in ProjectDashboard, 38 in KanbanBoard and 9 in `useBands`, plus the three enclosing function bodies. The following are every memo callback observed above 50 ms across the completed experiments. Times include pauses occurring while the callback is on the stack.

| Callback and implementation | Observed maximum | Changing input at that call | Attribution limit |
| --- | ---: | --- | --- |
| `src/components/kanban/KanbanBoard.tsx:507` — `model`, calls `deriveKanbanModel` through the cached builder (`kanbanModel.ts:493,507`) and `reuseKanbanModel` (`reuseKanbanModel.ts:76`) | 85.5 ms, stream-only pair 1 | `bands`; immediately follows the `nowMs`-driven second dashboard derivation | CPU samples contain 43.6 ms of browser GC. The GC allocation owner is unproven. The ordinary-source pair 3 separately samples 56.5 ms in model derivation plus reconciliation at the clock boundary. |
| `src/components/ProjectDashboard.tsx:1723` — `pipelineLayout`, calls `src/components/scheme/layout.ts:347` `buildSchemeLayout` | 87.3 ms, default-quota catalog pair 2 | `files`, `layoutGroups`, `layoutManual`, `activePipelines`, `isolatedCompactHistoryPaths` | Samples contain 64.9 ms of GC; normal six-CPU catalog maxima are 14.3 / 22.6 / 13.0 ms. This observation does not establish an 87 ms algorithmic self cost. |
| `src/components/ProjectDashboard.tsx:858` — `baseGroups`, calls `src/components/projectModel.ts:656` `buildBranchGroups` | 64.5 ms, default-quota catalog pair 2 | `sceneFiles`, `expandedConversations`, `keepExpandedPaths` | Samples contain 62.1 ms of GC; six-CPU catalog maxima are 5.1 / 6.3 / 4.4 ms. |

Enclosing render bodies also crossed 50 ms: `ProjectDashboardView` (`ProjectDashboard.tsx:330`) reached 104.9 ms in the default-quota experiment; `KanbanBoard` (`KanbanBoard.tsx:322`) reached 92.3 ms in stream-only pair 1. These are inclusive containers; counting them together with their child memo callbacks would double-count work. `useBands` itself never crossed 50 ms.

The earlier suspects `collectDescendants` (`src/components/projectModel.ts:847`, calls at `scheme/layout.ts:439,1012`) and `groupDirectReviewers` (`src/lib/review/directReviewGrouping.ts:100`, reached via `flows/directReviewGroups.ts:86`) were not independently established as >50 ms derivations. Descendant traversal is included in layout; direct grouping is included in `directReviewGroups`, whose largest six-CPU catalog measurement was 7.5 ms. An old suspect list cannot substitute for the current trace.

**The repeatable cumulative cost and changing inputs.** The exact criterion concerns a browser task. A chain of sub-50 ms callbacks can exceed it. These are the principal measured contributors, with original-main source lines:

| Derivation | Input that actually invalidates it | Maximum callback ms across the three six-CPU catalog runs |
| --- | --- | ---: |
| `ProjectDashboard.tsx:589` `protectedCollapsePaths` | `files` after the synthetic catalog update; reading paths when a reader opens | 3.2 |
| `ProjectDashboard.tsx:712` `directReviewGroups` | `files`, fresh `pinnedPaths`/`protectedCollapsePaths`; separately `nowMs` | 7.5 |
| `ProjectDashboard.tsx:790` `groupFiles` | `files`, flow/protected-stage ownership; retries can execute again with identical observed inputs | 6.4 |
| `ProjectDashboard.tsx:803` `outcomePaths` | `files` and lane/flow outcome inputs | 6.0 |
| `ProjectDashboard.tsx:812` `collapsibleWorkers` | `files` and newly derived pinned/protected/outcome sets | 7.1 |
| `ProjectDashboard.tsx:858` `baseGroups` | `sceneFiles`, expanded and retained paths; `nowSeconds` at the board tick | 6.3 |
| `ProjectDashboard.tsx:1723` `pipelineLayout` | new group/manual collections, `files`, active pipeline/history inputs, `nowSeconds` | 22.6 |
| `kanban/useBands.ts:88` `projection` | `files`, even when the stored tasks/pipelines/flows are unchanged | 18.6 |
| `kanban/useBands.ts:92` `bands` | fresh `layout`, and `projection` after a catalog update | 28.5 |
| `kanban/KanbanBoard.tsx:507` `model` | `bands`, `projection`, `files`; `modelNow` at a clock tick | 31.2 |

All paths in this table are under `src/components/`. These maxima come from separate calls and must not be added as though they occurred in one task. The non-overlapping union figures above use the actual intervals inside each task. Probe records with an empty changed-input list represent repeated render attempts against the same immediately observed inputs; they are not evidence of a new event or a new input.

The source explains the measured trigger:

- `ProjectDashboard.tsx:599` subscribes to `useNowSeconds(BOARD_CLOCK_MS)`. `src/hooks/useNowSeconds.ts:15,49` defines and schedules its 30-second clock. `ProjectDashboard.tsx:612` separately schedules `setNowMs(Date.now())` on a 30-second interval. The two clocks can cause two complete derivation attempts.
- The seconds update rebuilds flow expansion, branch groups and `pipelineLayout`. The milliseconds update rebuilds direct-review and launch-history projections; fresh collections can propagate through `sceneFiles` even with unchanged membership.
- `ProjectDashboard.tsx:2477` hands that layout to KanbanBoard. `useBands.ts:72` reconciles node identity, then `:92` rebuilds bands. `reconcileLayoutNodes` preserves equal nodes but returns a new layout wrapper (`scheme/layoutIdentity.ts:54`), so reconciliation alone does not eliminate the derivation work.
- `kanbanModel.ts:588` includes `now` in every cached task-card's dependencies. A new model clock intentionally invalidates the cards to maintain time-based semantics. `reuseKanbanModel` then walks rebuilt output to retain equal card/list identity. The existing identity fix preserves rendering correctness while that derivation and comparison work still costs time.
- Runtime text deltas already avoid whole-board status invalidation: `src/lib/client/runtimeFilesStatus.ts:20` documents the projection and `src/hooks/useFiles.ts:1495` gates publication on a changed runtime status signature. The stream-only callback counts confirm that behavior.

These code reads were performed during 05:14–05:33Z, including `sed -n '550,621p' src/components/ProjectDashboard.tsx`, `sed -n '560,630p' src/components/kanban/kanbanModel.ts`, `sed -n '1,155p' src/components/scheme/layoutIdentity.ts`, and the shared-hook/clock reads named above.

**Fix design.** Start with the clock invalidation chain, then reduce catalog-update work using the same project-owned derived state. This audit supplies the design; it does not validate an implementation.

1. Use one authoritative board-clock snapshot for both epoch seconds and epoch milliseconds. Preserve hydration's zero/unknown-time behavior and the existing units. A deadline should schedule one coherent projection update. Keep the full clock-dependent result correct when the tab resumes, an acknowledgement changes, or a retained conversation crosses an age boundary.
2. Give the project derivation a bounded, per-mounted-project projector. Preserve the identity of equal memberships, empty arrays/sets, branch groups and layout inputs. An unchanged direct-review or launch-history result must not start a new hierarchy/layout pass. Separate changes to conversation topology/ownership from changes to a file's payload or freshness, using explicit dependencies rather than omitting the `files` dependency.
3. Share the immutable lookup context within a derivation: current conversation generations, paths, children and transcript claims. `collectDescendants` currently builds a children index (`projectModel.ts:853`) although layout already has one (`scheme/layout.ts:384`). Reuse such an index within the pass while preserving traversal order, cycle handling, project boundaries and folded/protected reviewer ownership. This is an optimization opportunity; it was not the standalone >50 ms culprit measured here.
4. Preserve equal band output and update only the affected card model. Clock reuse must depend on every time-derived semantic input: working/stalled state, attention/wait state, card order, retention and collapse eligibility. Introduce explicit next-change boundaries only after enumerating those dependencies. Removing `now` from the card cache key would invalidate the current correctness contract. Keep `reuseKanbanModel` as a correctness/identity backstop while shrinking the set that needs rebuilding and comparing.
5. For catalog changes, retain the shared #2813 workflow/card projector benefits. Update relationships and the affected branch/task while retaining equal derived collections. A size-only change can preserve topology; an `mtime`, activity, lineage, generation, task, pipeline or review change must still update all output it affects. Bound caches to current inputs and retire removed rows. The first optimization should have a differential full-derivation oracle, including removal and clock-only transitions.

The implementation stays client-side. It requires no state database, runtime-host snapshot, MCP writer, Viewer-heap, cold-server-start or pipeline-evidence change. Hiding the board's data updates while its reader is open would weaken correctness. The current card identity, time/deadline behavior and existing browser baselines remain requirements.

**Acceptance measurement method.** Add the retained case to the same shared driver when an implementation is authorized; this read-only stage records it below. Keep the current corpus, six sessions, aggregate 40 events/s, CPU ×4, reader open, normal motion and at least 30 seconds of actual scrolling. Each of three before/after pairs must use the same browser, CPU admission/quota, dataset and event schedule, with fresh contexts and alternating order. For a performance-improvement comparison, replay a fixed signed gesture schedule and report any missed deadlines; the audit's awaited nominal-rate wheel loop is sufficient for finding an absolute stall but does not establish a relative frame-rate improvement.

Run both stream-only and the separately labelled 500 ms catalog-refresh case. Begin after readiness and ensure the capture crosses the real board-clock boundary; a frozen clock must never establish the performance verdict. Keep `PerformanceObserver` entries, a main-thread trace and a raw-source CPU profile. In the diagnostic twin, time each memo callback and the enclosing render, record changed dependency names, and align those intervals to the same thread's `RunTask` events using user-timing marks. Sum only non-overlapping derivation spans within each task. Record GC and thread scheduling alongside elapsed time, and retain failed or partial runs.

The acceptance result is zero >50 ms tasks attributable to the project derivation in **every** measured window, including cumulative derivation cost and clock expiry. A low mean, a passing individual callback maximum, or an FPS target cannot replace that result. Other long tasks need separate attribution. Confirm the timing probes do not create the conclusion using the ordinary-source profile. Fail the case when cards are missing, stream revisions lag emitted envelopes, the conversation is not visible, scrolling never moves, the window is incomplete, or browser errors occur.

For output equivalence, compare complete derived card IDs, column/order, grouping, members, mirrors, badges, counts, reason/wait/working state, hidden/retained rows and geometry at the same logical input/time. Pair that with reference-identity assertions for unchanged cards and changed-card assertions for genuine updates. Run a separate deterministic-clock correctness pass at each deadline's before/at/after boundary; preserve the existing retention test near `kanbanModel.test.ts:1315`, the clock invalidation case at `overviewBands.test.ts:117`, `reuseKanbanModel.test.ts`, and relevant worker-collapse/project-model tests. The performance pass keeps a real advancing clock.

In this audit, all 357 rendered card IDs, order and column assignments matched between the raw and timed variant before and after each window. Displayed text also matched after normalizing only age strings and standalone clock/date labels. Those labels legitimately differed because the paired contexts started at different wall times. This proves the observed rendering parity of the probes; a future optimized model still needs the complete output-equivalence checks above. The application source was unchanged.

**Commands, artifacts and verification.** All heavy browser execution was sequential. The command below is the actual invocation with machine-specific executable locations represented by variables; `GATE` is the installed wrapper named by the stage and `CHROME_BIN` is the existing headless-shell executable. `AUDIT` is the private scratch root `/var/tmp/pd-audit-h48um9f1`. The selected gate never accesses the live Viewer at the closed control URL.

```bash
cd "$AUDIT/checkout"
rtk proxy env   HOME="$AUDIT/home" XDG_CONFIG_HOME="$AUDIT/config"   TMPDIR="$AUDIT/tmp" LLV_STATE_DIR="$AUDIT/state"   LLV_VIEWER_CONTROL_URL=http://127.0.0.1:9   LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN="$CHROME_BIN"   PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH"   PD_OUT=.artifacts/project-dashboard-stream   PD_PAIRS=3 PD_SECONDS=30 PD_POLL_MS=0   DELEGATUS_WORK_SCOPE_CPU_QUOTA=600   bash "$GATE" bun test src/components/kanban/kanbanBoard.browser.test.tsx   --test-name-pattern 'ProjectDashboard derivation audit'
```

For the catalog confirmation, use `PD_OUT=.artifacts/project-dashboard-quota6` and `PD_POLL_MS=500` (the default); for the initial quota check, use `PD_OUT=.artifacts/project-dashboard-derivation` and the gate's default quota. Restore the scratch fixture from the measured commit before each invocation because the case adds the historical corpus. Do not run these edits in the pipeline worktree. All three complete invocations passed their 30 assertions with 200 unrelated browser cases filtered out. Their wall execution times were 251.43 s, 248.17 s and 253.17 s respectively. The pilots' parse, readiness and zero-scroll failures were corrected before the complete measurements and are not passing evidence.

Artifacts are retained privately under `$AUDIT/checkout/.artifacts/` in the three directories above: each `N-raw`/`N-timed` has JSON readings, a Chromium trace, CPU profile and screenshot. `analysis.json` contains summaries of the executed sites among the 116 probes, dependency changes, timing attribution and cgroup readings; `cpu-analysis.json` contains per-long-task sampled attribution. `case.txt`, `instrument.cjs`, `analyze.py` and `cpu_tasks.py` are outside the exported repository at `$AUDIT`. The raw artifacts are approximately 698 MB and remain private scratch evidence. The declared Markdown output contains the bounded findings and replay code.

Artifact manifest SHA-256: `9781322023949363d8fd2c9b5c3b252f0d8298fb0418e3ac0a8f74350d8a3852` (`$AUDIT/artifact-manifest.json`, 85 records). Shared-driver addition SHA-256: `382c190e1560638eab76ddfea3669d2d92153294f54ac08e8688c1c384c082fa`. Probe preparation SHA-256: `80d9455debbdc7b31e75b2e86a9305323baf4154c11fda4d6d1740d75b7195bd`. The six-CPU catalog raw/timed bundle hashes are `514c38e185f4a776c08d0cd0385bf25de19cb2bf273e01f9d49db9d37084c985` and `8ef4f38deb34233a4c71c0ffd27e31d896f8508e821d224b3f770a4d002e5abe`.

The read-only scope permits only this document in the worktree. No source/test change, staging, commit, push, deployment or production mutation was made. The browser case is a harness-validity check; its successful execution does not mean the measured performance criterion passed. Publication privacy and final worktree checks are recorded after the replay appendix.

**Replay appendix.** Export the measured commit to scratch, attach only dependencies with identical manifest/lock/patch inputs, and create the isolated directories named in the command. Save the following preparation helper as `instrument.cjs` beside `checkout`, then run it there for `src/components/ProjectDashboard.tsx`, `src/components/kanban/KanbanBoard.tsx`, and `src/components/kanban/useBands.ts`. It uses TypeScript's AST to preserve source lines and wrap existing factories without changing their return values. The main driver case reads the resulting three `.timed` files. No new browser driver is created.

```js
const fs=require('fs'); const ts=require('./checkout/node_modules/typescript');
const file=process.argv[2]||'src/components/ProjectDashboard.tsx',source=fs.readFileSync('./checkout/'+file,'utf8');
const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const edits=[];const sites=[];
function walk(n){
 if(ts.isVariableDeclaration(n)&&n.initializer&&ts.isCallExpression(n.initializer)&&n.initializer.expression.getText(ast)==='useMemo'){
 const call=n.initializer, cb=call.arguments[0], deps=call.arguments[1];if(cb&&deps&&ts.isArrayLiteralExpression(deps)){
 const line=ast.getLineAndCharacterOfPosition(n.getStart(ast)).line+1;
 const name=n.name.getText(ast), labels=deps.elements.map(e=>e.getText(ast));
 edits.push([cb.getStart(ast),cb.end,'__pdFactory('+JSON.stringify(file+':'+line+':'+name)+','+cb.getText(ast)+','+deps.getText(ast)+','+JSON.stringify(labels)+')']);sites.push({name,line,labels});
 }}
 if(ts.isFunctionDeclaration(n)&&['ProjectDashboardView','KanbanBoard','useBands'].includes(n.name?.text)){
 edits.push([n.body.getStart(ast)+1,n.body.getStart(ast)+1,'const __pdStart=performance.now(); try {']);
 edits.push([n.body.end-1,n.body.end-1,'} finally { __pdRecord('+JSON.stringify(file+':'+n.name.text)+',__pdStart,[]); }']);
 }
 ts.forEachChild(n,walk);
}walk(ast);
let result=source;for(const [a,b,t] of edits.sort((x,y)=>y[0]-x[0]))result=result.slice(0,a)+t+result.slice(b);
result+=`
const __pdPrevious = new Map<string, readonly unknown[]>();
function __pdRecord(name: string, start: number, changed: string[]) {
 const w = globalThis as any; if(!w.__pdRecording) return;
 const end=performance.now(); w.__pdRows.push({name,start,end,ms:end-start,changed});
 performance.measure('pd:'+name,{start,end});
}
function __pdFactory<T>(name:string, factory:()=>T,deps: readonly unknown[], labels:string[]):()=>T {
 return ()=>{ const previous=__pdPrevious.get(name); __pdPrevious.set(name,deps);
 const changed=labels.filter((_,i)=>!previous || !Object.is(previous[i],deps[i]));
 const start=performance.now(); try {return factory();} finally {__pdRecord(name,start,changed);}
 };
}
`;
fs.writeFileSync(file.split('/').pop()+'.timed',result);fs.writeFileSync(file.split('/').pop()+'.sites.json',JSON.stringify(sites,null,2));
```

Append the following case to the scratch copy of `src/components/kanban/kanbanBoard.browser.test.tsx`. Its imports and helpers already exist in that driver. The original fixture and source modules must be restored from the measured commit before preparing a fresh experiment.

```tsx
describe("ProjectDashboard derivation audit", () => {
  browserTest("profiles 357 cards during streaming and scrolling with a conversation open", async () => {
    const out = path.resolve(process.env.PD_OUT??".artifacts/project-dashboard-derivation"); fs.mkdirSync(out,{recursive:true});
    let fixture=fs.readFileSync("src/components/kanban/issue1695Evidence.fixture.tsx","utf8");
fixture = fixture.replace('const PIPELINES = SCENARIO === "pipelines" || STAGES;', "const PIPELINES = true;");
fixture = fixture.replace("let revision = 1;", `
for (let i = 0; i < 280; i++) {
  const builder = add(conversation('history-builder-' + i, 'Historical work ' + i));
  const reviewers = [0, 1].map(j => add(conversation('history-review-' + i + '-' + j, 'Historical review ' + i)));
  const flow = reviewFlow('history-flow-' + i, builder, reviewers[1], ['REQUEST_CHANGES', 'REQUEST_CHANGES', 'REQUEST_CHANGES', 'APPROVE'], 100000);
  flow.state = 'closed';
  flows.push(flow);
}
let revision = 1;`);
fixture = fixture.replace("if (EDITING) {\n  const at", `
for (let i = 0; i < 600; i++) tasks.push(task('history-task-' + i, 'done', 'Historical task ' + i, 'Synthetic acceptance notes. '.repeat(12), 100000, i < 60 ? [files.find(f => f.name === 'history-builder-' + i + '.jsonl')] : [], i < 60 ? {} : { board: 'hidden' }));
if (EDITING) {\n  const at`);
/* The driver's handles: corpus size, one catalog update, and React commits. */
fixture = fixture.replace("Object.assign(window, { evidence });", `Object.assign(window, { evidence,
  profileCorpus: { files: files.length, flows: flows.length, tasks: tasks.length, liveIds: files.filter(f => f.activity === 'live').map(f => f.conversationId) },
  profileUpdate: () => { files[0] = { ...files[0], mtime: files[0].mtime + 1, size: files[0].size + 1 }; window.dispatchEvent(new Event('llv:files-changed')); },
});`);


    fixture=fixture.replace("Object.assign(window, { evidence,", `Object.assign(window, { evidence,
      profileSessionStats: () => Object.values(getRuntimeBus().getState().store.sessions).map((s:any)=>({id:s.conversationId,rev:s.revision,text:s.liveTurn?.text?.length??0})),`);
    fs.writeFileSync("src/components/kanban/issue1695Evidence.fixture.tsx",fixture);
    const sources=["src/components/ProjectDashboard.tsx","src/components/kanban/KanbanBoard.tsx","src/components/kanban/useBands.ts"];
    const originals=sources.map(file=>fs.readFileSync(file,"utf8"));
    const raw=await serveEvidenceFixture(path.join(out,"raw"));
    for(const file of sources)fs.writeFileSync(file,fs.readFileSync("../"+path.basename(file)+".timed","utf8"));
    const timed=await serveEvidenceFixture(path.join(out,"timed"));
    sources.forEach((file,i)=>fs.writeFileSync(file,originals[i]));
    const browser=await chromium.launch({...LAUNCH, ignoreDefaultArgs:["--hide-scrollbars"]});
    const hostSample=()=>{let group=fs.readFileSync("/proc/self/cgroup","utf8").trim().split("::")[1];const groups=[];while(true){const dir="/sys/fs/cgroup"+group;const row:any={group};for(const f of ["cpu.max","cpu.stat","memory.max","memory.events"]){try{row[f]=fs.readFileSync(path.join(dir,f),"utf8");}catch{}}groups.push(row);if(group==="/")break;group=path.dirname(group);}return {at:new Date().toISOString(),load:os.loadavg(),groups};};
    const results:any[]=[];
    try {
      for(let pair=1;pair<=Number(process.env.PD_PAIRS??3);pair++) {
        for(const variant of process.env.PD_VARIANT ? [process.env.PD_VARIANT] : pair%2 ? ["raw","timed"] : ["timed","raw"]) {
          const tag=`${pair}-${variant}`; console.log("PD_START",tag,new Date().toISOString());
          const {context,page,pageErrors}=await openFixture(browser,"about:blank",VIEWPORT,"dark","en","no-preference");
          try {
            await page.addInitScript(()=>{
              const w=window as any;w.__pdRows=[];w.__pdLong=[];w.__pdFrames=[];w.__pdRecording=false;
              new PerformanceObserver(list=>{for(const e of list.getEntries())if(w.__pdRecording)w.__pdLong.push({start:e.startTime,ms:e.duration});}).observe({type:"longtask",buffered:true});
              let prev=0;const tick=(now:number)=>{if(w.__pdRecording&&prev)w.__pdFrames.push(now-prev);prev=now;requestAnimationFrame(tick);};requestAnimationFrame(tick);
            });
            const cdp=await context.newCDPSession(page);
            await cdp.send("Emulation.setCPUThrottlingRate",{rate:4});
            await page.goto(`${(variant==="raw"?raw:timed).base}?scenario=pipelines&streaming=1`);
            await page.locator(card("t-export")).waitFor({timeout:30000});
            await page.locator(`${card("t-export")} .tile[data-member="/repo/export-impl.jsonl"]`).click();
            await page.locator("[data-agent-window-frame]").waitFor();
            await page.waitForTimeout(3000);
            const before=await page.evaluate(()=>({corpus:(window as any).profileCorpus,cards:document.querySelectorAll("[data-kanban-board] .card[data-id]").length,window:!!document.querySelector("[data-agent-window]"),sessions:(window as any).profileSessionStats(),columns:[...document.querySelectorAll<HTMLElement>(".column .col-body")].map(e=>({column:e.closest<HTMLElement>(".column")!.dataset.status,client:e.clientHeight,scroll:e.scrollHeight}))}));
            console.log("PD_CORPUS",tag,JSON.stringify(before));
            const initialOutput=await page.locator("[data-kanban-board]").evaluate(board=>[...board.querySelectorAll<HTMLElement>(".card[data-id]")].map(e=>({id:e.dataset.id,column:e.closest<HTMLElement>(".column")?.dataset.status,text:e.innerText})));
            const scroll=page.locator('[data-agent-window] [data-log-feed-scroller]').first();
            const box=await scroll.boundingBox();if(!box)throw Error("no scroll target");
            await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
            const trace:any[]=[];cdp.on("Tracing.dataCollected",e=>trace.push(...e.value));
            await cdp.send("Profiler.enable");await cdp.send("Profiler.setSamplingInterval",{interval:1000});await cdp.send("Profiler.start");
            await cdp.send("Tracing.start",{categories:"toplevel,devtools.timeline,blink.user_timing,v8",transferMode:"ReportEvents"});
            const hostBefore=hostSample();const utcStart=new Date().toISOString();const seconds=Number(process.env.PD_SECONDS??30);
            await page.evaluate((pollMs)=>{
              const w=window as any;w.__pdRecording=true;w.__pdRows=[];w.__pdLong=[];w.__pdFrames=[];w.__pdStart=performance.now();w.__pdCount=0;w.__pdPolls=0;w.__pdSeq=1000;w.__pdHeads={};w.__pdScroll=[];
              performance.mark("pd-window-start");
              const ids=w.profileCorpus.liveIds;
              w.__pdTimer=setInterval(()=>{
                const due=Math.floor((performance.now()-w.__pdStart)*40/1000);
                while(w.__pdCount<due){const id=ids[w.__pdCount%ids.length];const revision=(w.__pdHeads[id]??1)+1;w.__pdHeads[id]=revision;
                  w.runtimeEmit({schemaVersion:1,seq:++w.__pdSeq,eventId:`profile-${w.__pdSeq}`,scope:{type:"session",id},revision,kind:"delta",occurredAt:new Date().toISOString(),payload:{conversationId:id,turnId:"turn-1",text:`streamed fragment ${w.__pdCount} of the reply, a sentence long enough to count `.repeat(2)}});w.__pdCount++;
                }
              },4);
              // Catalog refresh is the recorded earlier corpus's 500 ms mtime/size update.
              w.__pdPollTimer=pollMs>0?setInterval(()=>{w.profileUpdate();w.__pdPolls++;},pollMs):0;
              const el=document.querySelector<HTMLElement>('[data-agent-window] [data-log-feed-scroller]')!;
              el.addEventListener("scroll",()=>w.__pdScroll.push({at:performance.now(),top:el.scrollTop}),{passive:true});
            },Number(process.env.PD_POLL_MS??500));
            const started=Date.now();let wheel=0;
            while(Date.now()-started<seconds*1000){await page.mouse.wheel(0,Math.floor(wheel/30)%2 ? -100 :100);wheel++;await page.waitForTimeout(100);}
            await page.evaluate(()=>{const w=window as any;clearInterval(w.__pdTimer);clearInterval(w.__pdPollTimer);w.__pdEnd=performance.now();performance.mark("pd-window-end");});
            await page.waitForTimeout(150);
            const sample=await page.evaluate(()=>{
              const w=window as any;w.__pdRecording=false;
              return {start:w.__pdStart,end:w.__pdEnd,events:w.__pdCount,polls:w.__pdPolls,rows:w.__pdRows,longTasks:w.__pdLong.filter((t:any)=>t.start<w.__pdEnd),frames:w.__pdFrames,scroll:w.__pdScroll,sessions:w.profileSessionStats(),windowText:document.querySelector("[data-agent-window]")?.textContent?.slice(-1000),output:[...document.querySelectorAll<HTMLElement>("[data-kanban-board] .card[data-id]")].map(e=>({id:e.dataset.id,column:e.closest<HTMLElement>(".column")?.dataset.status,text:e.innerText}))};
            });
            const utcEnd=new Date().toISOString();const {profile}=await cdp.send("Profiler.stop");
            const done=new Promise<void>(resolve=>cdp.once("Tracing.tracingComplete",()=>resolve()));await cdp.send("Tracing.end");await done;
            fs.writeFileSync(path.join(out,`${tag}.cpuprofile`),JSON.stringify(profile));fs.writeFileSync(path.join(out,`${tag}-trace.json`),JSON.stringify(trace));
            await page.screenshot({path:path.join(out,`${tag}.png`)});
            const result={tag,utcStart,utcEnd,initialOutput,hostBefore,hostAfter:hostSample(),browser:browser.version(),before,wheel,pageErrors,...sample};
            fs.writeFileSync(path.join(out,`${tag}.json`),JSON.stringify(result,null,2));results.push(result);
            console.log("PD_RESULT",JSON.stringify({tag,events:sample.events,polls:sample.polls,wheel,scroll:sample.scroll.length,longTasks:sample.longTasks.length,max:Math.max(0,...sample.longTasks.map((t:any)=>t.ms)),slow:sample.rows.filter((r:any)=>r.ms>50).map((r:any)=>({name:r.name,ms:r.ms,changed:r.changed})).slice(0,12),pageErrors}));
            expect(before.cards).toBe(357);expect(sample.events).toBeGreaterThan(seconds*35);expect(sample.scroll.length).toBeGreaterThan(5);expect(sample.windowText).toContain("streamed fragment");expect(pageErrors).toEqual([]);
          } catch(error) { await page.screenshot({path:path.join(out,`${tag}-failed.png`)}).catch(()=>{}); console.log("PD_ERROR",pageErrors,await page.locator("body").innerText().then(t=>t.slice(-1800)).catch(()=>""));throw error;} finally {await context.close();}
        }
      }
      fs.writeFileSync(path.join(out,"results.json"),JSON.stringify(results,null,2));
    } finally {await browser.close();raw.stop();timed.stop();}
  },600_000);
});
```

**Final validation.** The local privacy gate returned `PRIVACY GATE: PASS` for this document with the committed fingerprints and `--require-known-values`. It ran from the scratch export with isolated roots, using:

```bash
rtk proxy env HOME="$AUDIT/home" XDG_CONFIG_HOME="$AUDIT/config" \
  TMPDIR="$AUDIT/tmp" LLV_STATE_DIR="$AUDIT/state" \
  LLV_VIEWER_CONTROL_URL=http://127.0.0.1:9 \
  LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE="$AUDIT/checkout/scripts/privacy-known-value-fingerprints.json" \
  bun scripts/privacy-publication-gate.ts --repository "$WORKTREE" \
  --require-known-values --paths docs/perf/project-dashboard-derivation.md
```

`git status --short --ignored`, `git diff --cached --stat` and whitespace inspection confirmed that only the declared Markdown output exists as a worktree change and the index is untouched. The document-only output has no touched application tests; the scratch shared-browser case supplied the behavioral measurements. No CI run was dispatched, and no application build, runtime gate or deployment is claimed. The final privacy/worktree checks ran during 05:35–05:40Z.
