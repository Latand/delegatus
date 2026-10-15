# Board poll payload audit

Audit date: 2026-10-15 UTC. Source: `45d25ac796d5824713c9fb57d65f57efea61041b`.

The authorized production GET at **05:37:07Z** returned HTTP 200 with
**33,671,784 decoded bytes**, **6,802,172 gzip bytes**, and **473.69 ms** total
time. Pipelines contribute **71.50%** of the decoded bytes. It served a stale
cached projection containing 1,706 tasks, 238 pipelines and 689 conversation
rows. The body is **139,366 bytes larger (+0.416%)** than the earlier stored
33,532,418-byte sample.

On that stored production-size pair, the existing delta is
**76,259 bytes**, or **10,698 bytes with gzip**. Chromium applies that delta
through the current client cache in a median **3.6 ms**, versus **296.4 ms**
for a full replacement. Producing the delta still parses both large bodies
and serializes their rows for comparison.

The continuation explicitly authorized **one bounded authenticated GET**,
including the handler's normal scan/cache/migration side effects. That request
is complete; no second production GET or other mutating route was called.
No restart, deploy, credential output, or runtime code change was performed.
Live transport timing and isolated serialization/allocation measurements are
reported separately. The request had no prior ETag or delta opt-in, so it
measures a full answer; it does not establish the full/delta/304 mix of
already-open tabs.

## Evidence and boundaries

All source locations below refer to the pinned source. The deployed release
was `781ecd4c33482d7486683d19d61a8b0bc8c14d38`: `deployment_status` reported its
successful deployment ending at **00:28:32.843Z**. A read of process cwd and
allowlisted environment fields identified that release's Viewer processes.
Byte comparisons found the deployed and pinned versions of
`operatorProjection.ts`, `response.ts`, `filesDelta.ts`, `filesReadSummary.ts`,
`useFiles.ts`, and `filesResponseWorker.ts` identical. The lockfiles also
match, SHA-256 `22588d87096818a35d0d5367ecf485780bdbb57640dd8c049a1c4e8c90d3136b`.

The investigation read AGENTS.md, CLAUDE.md, CONTRIBUTING.md, README.md,
package.json, the installed NextResponse guide, and the desktop/native memory
indexes. Searches included project-scoped `search_transcripts` queries
`26444680 summary`, `"files" "delta" "payload"`, `"summary" "bytes"`, and
unscoped `board poll payload serialization` and `"26,444,680"`.
`search_memory` queries `files summary payload`, `files delta`, and
`production read only api files` supplied no applicable solution. Unrelated
memory hits were not used as evidence.

The numeric phrase found the original audit. Opening its transcript through
`conversation_messages` resolved the abbreviated conversation reference and
confirmed the **2026-10-12 13:00:12.914–13:00:14.467Z** GET: 26,444,680 bytes,
1,355 tasks, HTTP 200. Its second GET ran **13:02:27.809–13:02:28.296Z**.
That audit's conclusion explicitly lacked the affected browser's store/DOM.
The pinned brief's 14–18-second requests and prolonged stale-tab hypothesis
are historical context; neither was reproduced in this audit.

Commands and observation windows, with private roots represented by variables:

| Evidence | UTC window, 2026-10-15 | Command/query and result boundary |
| --- | --- | --- |
| E1: source and release | 05:17:05–05:20:01 | `git rev-parse HEAD`; `deployment_status({compact:true,limit:2})`; Python reads of `/proc/<pid>/cwd` and only the named environment fields; byte comparisons of the six files above; `sha256sum bun.lock "$RELEASE/bun.lock"`. No environment values containing credentials were output. |
| E2: prior work | 05:17:32–05:26:07 | The searches above; `conversation_messages({transcriptPath:<matched audit transcript>,limit:1,maxChars:7000})`. Private transcript names are intentionally omitted from the public report. |
| E3: stored bodies | 05:19:20.924–05:20:00.211 | `rtk proxy python3 -` read the global summary's worker base, split its first ETag line from its body, copied the body into private scratch, calculated SHA-256, and checked the ETag against SHA-1. Capture details follow. |
| E4: server/client seams | 05:21:17.391–05:21:27.083 | `bun audit-bench.ts` in the scratch export, through the required gate and isolated environment below. Seven measured samples after one warmup per case. |
| E5: allocation instrumentation | 05:25:15.117–05:25:15.437 | `bun audit-alloc-estimate.ts` under the same isolation/gate. Wrapped JSON calls count outputs; Bun's shallow-size estimator accounts for the returned strings. This pass is separate from timing. |
| E6: isolated HTTP/browser | 05:24:04.093–05:24:12.834 | `bun audit-browser.ts` under that isolation/gate. A loopback port-0 server served frozen bodies; an isolated Chromium 156.0.8078.4 context executed the bundled current cache. The server and browser closed in `finally`. |
| E7: contract tests | 05:25:27–05:25:29 | `bun test src/lib/filesDelta.test.ts src/lib/filesReadSummary.test.ts src/hooks/useFiles.delta.test.ts`, through that gate in the scratch export: 13 passed, 47 assertions, 0 failures. |
| E8: code consumers and cadence | 05:19:20–05:26:27 | `rg -n` for `view=summary`, `useFiles`, `POLL_MS`, `hiddenTrafficSuspended`, `prototypeReviewNotices`, `effectiveRole`, `stageReports`, and `__llvFilesDeltaLinks`; `nl -ba <file>` at the locations cited below. |
| E9: authorized live GET | 05:37:07.395774–05:37:07.869468 | `rtk proxy python3 "$AUDIT_ROOT/live-get.py"`: one authenticated `GET /api/files?view=summary` on the production loopback listener, requesting gzip, with a 60-s wall deadline and 128-MiB body cap. No redirects or retries. HTTP 200; detailed results below. |
| E10: fresh body accounting | 05:37:49.932–05:37:50.616 | `bun live-breakdown.ts`, through the same isolated gate: parse B and the saved E9 body, measure UTF-8 serialized field values and row counts. Reserialized sizes equal both original body sizes. No network request. |
| E11: continuation checks | 05:35–05:39 | Project-scoped `search_transcripts` queries `board poll payload 33.53` and `"delta-base" "33,532,418"`, then unscoped `files summary token`; `conversation_messages` opened the prior audit transcript. Project-scoped `search_memory` for `files summary payload` and unscoped `authenticated GET poll` returned no applicable memory. `deployment_status({compact:true,limit:2})` and `/proc` cwd/owner checks still identified the same release. SHA-256 checks matched every prior body, benchmark script and result listed below. Read the heap lane's now-present audit and its delta-scope probe. |

The execution envelope was:

```sh
# AUDIT_ROOT is a private mktemp directory under /var/tmp.
# RELEASE is the installed release directory; no file there is edited.
# Source was exported with git archive HEAD, never checked out over the lane.
cd "$AUDIT_ROOT/source"
env -u LLV_STATE_OWNER \
  HOME="$AUDIT_ROOT/home" XDG_CONFIG_HOME="$AUDIT_ROOT/config" \
  TMPDIR="$AUDIT_ROOT/tmp" LLV_STATE_DIR="$AUDIT_ROOT/state" \
  AUDIT_ROOT="$AUDIT_ROOT" \
  bash "$RELEASE/scripts/gate-slot.sh" "$BUN" audit-bench.ts
# The other measured commands replace only audit-bench.ts above.
```

Bun was **1.4.0 (34cbb9a40)**. Scratch `node_modules` links to the installed
release after the lockfile comparison; nothing was installed into the lane.
The HTTP benchmark recorded its own PID and ephemeral port. Work ran through
the shared CPU gate, one heavy invocation at a time. The work-slice quota read
afterward was 18 CPUs; the enclosing agents slice had a 106.6-GiB memory cap.
Per-invocation throttling deltas were not recorded. These timings describe
this admitted local replay, without a production-load equivalence claim.

Private benchmark source/result SHA-256 identifiers:

| Artifact | SHA-256 |
| --- | --- |
| `audit-bench.ts` | `c5f9a36df0104d16f516cab819f991bb8afb9643f0a4be7bc99bd6b2930d14e0` |
| `bench.jsonl` | `5d6c465601195ac15c8cec73c167cf95acff01b297273f1151042adc609fcaef` |
| `audit-alloc-estimate.ts` | `031c82f2f449fc46340c19c276547bafba99d8a61790605083f4ba2ccd9621bd` |
| `alloc-estimate.jsonl` | `62a205fdd71ffeb7cdd2a529e616be25e4712373848baec25d8751dd223e432f` |
| `audit-browser.ts` | `a2e85d95f70f178302a6057c98667e684f1bce53af192698b34857b4d3243f17` |
| `audit-browser-entry.ts` | `1be4400b4d4affaecd496f995550eab1bf2da1a927104b6df0584337dccef5b6` |
| `browser.jsonl` | `4ebe5ac1dc8b862414e90300d47c99f1dc17a0c2da2b262e977dd753c30a942f` |
| `live-get.py` | `90120e507c7e4ddba2c63803daa547e8443b1790fa5835df94874b11ce6c90e5` |
| `live-get.json` | `e9b609f1bccddaba2207e8593555022babbf504d60a09817b00a4ad59a224f80` |
| `live-breakdown.ts` | `7b2f0d32511547d8f1094e9e0dc4a50ce63155214a247bf1a03932868dd7299c` |
| `live-breakdown.json` | `fb0e615bf725b180d1109063bb0f77df36b30dfc591a176337f18f62c5daa31d` |

The raw bodies and private scripts stay outside the repository. They contain
operator data and are not publication fixtures.

## Single authorized production request

E9 uses Python `http.client.HTTPConnection` to the literal loopback address
on port 8898. Before connecting, it verifies the known Viewer process's cwd
and owner declaration, reads its existing `LLV_TOKEN` into process memory,
and sends it as a bearer credential in the Authorization header
(`src/proxy.ts:96`, `:113`). The key never appears in command arguments, URLs,
saved response metadata, or output. Only allowlisted response headers and
aggregate measurements are printed. An exclusive local receipt prevents
accidental script reuse from making another request. Raw and decoded bodies
are saved privately with restrictive permissions.

There was one new TCP connection, one GET, no conditional/delta headers, and
no follow-up. Timing begins immediately before connecting and ends after the
complete encoded body is read; local decompression, parsing and field
accounting are outside that interval. Body byte counts exclude HTTP headers
and transfer framing. The response supplied no Content-Length.

| Observation | Result |
| --- | --- |
| UTC start / body complete | 2026-10-15 **05:37:07.395774Z / 05:37:07.869468Z** |
| Status / response kind | **200 / full board-summary**, gzip |
| Connect / response headers | **1.00 ms / 470.47 ms** |
| First body byte / complete body | **470.49 ms / 473.69 ms** |
| Encoded / decoded body | **6,802,172 / 33,671,784 bytes** |
| Decoded SHA-256 | `ad436bc7f84e137c187d2d0a38396941a29cc9367fe14890e03df12684bf7f88` |
| ETag | `ba229508b717b882cc4ce883d9fcbc425357cd42`, matching decoded-body SHA-1 |
| Scan cache / projection cache | `hit` / `stale` |
| Scan generation / target generation | `158` / `158` |
| Built stamp | `mv8svxhc1.158.924` |
| Server-Timing, selected values | `files-scan`: **5,949.3 ms**; `files-worker-build`: **1,450.6 ms**; `files-json`: **119.1 ms** |

The Server-Timing values include earlier scan/build work attached to the
cached representation (`operatorProjection.ts:599`, `:689`). They exceed
the request's observed wall time and **must not be reported as work performed
by this GET**. `files-json` also includes summary preparation and hashing.
The `stale` response permits a background rebuild through `projectionFor`;
the probe did not instrument or wait for that rebuild. This single sample
does not reproduce the historical 14–18-second response or establish a live
percentile, current-tab polling rate, or per-request allocation total.

Compared with stored B, E9 has one additional task, three additional file
rows and eleven additional pipeline attempts; pipeline count stays 238.
Its decoded body grew **139,366 bytes (0.416%)** and its gzip body grew
**37,051 bytes (0.548%)**. E10's same-method field accounting follows:

| Top-level value | Stored B bytes | Live GET bytes | Live share | Change in bytes |
| --- | ---: | ---: | ---: | ---: |
| `pipelines` | 23,943,981 | 24,073,903 | 71.496% | +129,922 |
| `tasks` | 7,071,066 | 7,075,719 | 21.014% | +4,653 |
| `files` | 1,814,603 | 1,818,231 | 5.400% | +3,628 |
| `launchRoutes` | 534,471 | 535,635 | 1.591% | +1,164 |
| `workLinks` | 158,269 | 158,269 | 0.470% | 0 |
| `prototypeReviewNotices` | 5,756 | 5,756 | 0.017% | 0 |
| `projectCatalog` | 1,969 | 1,968 | 0.006% | −1 |
| Remaining values | 2,044 | 2,044 | 0.006% | 0 |
| Top-level keys, separators, braces | 259 | 259 | <0.001% | 0 |
| **Total decoded body** | **33,532,418** | **33,671,784** | **100%** | **+139,366** |

The same nested-field convention used below finds **15,179,277 bytes** in
live `pipelines[].runs` (866 runs, 1,197 attempts), including **6,407,287**
bytes in attempt role scaffolds, **4,579,457** in reports and **2,267,687** in
verdicts. Pipeline stages add **5,100,802** bytes, including **4,506,857** in
stage role scaffolds; `stageReports` add **2,063,665**. Task `details` and
`assignments` account for **2,621,898** and **1,873,173** bytes. These nested
figures overlap their containing totals. The byte-dominance conclusion and
contract recommendation remain the same as for B.

## Production representation and byte accounting

The worker persists an ETag followed by the exact summary JSON at
`state/files-response-results/delta-base-<scope-sha1>.json`
(`src/lib/filesResponse.worker.ts:103`, `:122`). The operator's global scope
is `JSON.stringify([null,"summary"])`; its SHA-1 is
`a0a1c3f9d4cebf648fce837919e8133b6053d791`.

| Capture | Observed file mtime UTC | Captured UTC | JSON bytes | SHA-256 of JSON body |
| --- | --- | --- | ---: | --- |
| A | 05:19:10.023679 | 05:19:20.958955 | 33,529,463 | `3afc901582f898f01013ebd2dd91c0e4caa801de3aa431c9f68811272b997af8` |
| B | 05:19:39.133960 | 05:20:00.210407 | 33,532,418 | `2da069d27d0308250a5402936ab8ad071d38df089acdcc924682f8e024b8aa2e` |

Both are `readProjection: "board-summary"`. File timestamps identify stored
build artifacts; they do not prove that a particular tab received them.
Capture B has 31,019,709 JavaScript string code units. Values below use UTF-8
`Buffer.byteLength(JSON.stringify(value))`, never code-unit length (E3/E4).

| Top-level value | Bytes | Share |
| --- | ---: | ---: |
| `pipelines` | 23,943,981 | 71.405% |
| `tasks` | 7,071,066 | 21.087% |
| `files` | 1,814,603 | 5.411% |
| `launchRoutes` | 534,471 | 1.594% |
| `workLinks` | 158,269 | 0.472% |
| `prototypeReviewNotices` | 5,756 | 0.017% |
| `projectCatalog` | 1,969 | 0.006% |
| `projectCwds` | 625 | 0.002% |
| `projectDisplayNames` | 581 | 0.002% |
| `systemHealth` | 310 | 0.001% |
| `projectAliases` | 306 | 0.001% |
| `crownedProjects` | 201 | 0.001% |
| `readProjection`, `flows`, `workflows`, `conversationAliases` | 21 | <0.001% |

The remaining 259 bytes are top-level keys, separators and braces. There are
10 project catalog entries, 10 prototype notices, and no flows or workflows
in this capture. Empty collections still need coverage in acceptance tests.

For nested fields, the figures sum serialized values plus the property name
and colon over all rows. They exclude row commas/braces. Nested rows below
overlap their parent totals and must not be added twice.

| Nested field | Bytes |
| --- | ---: |
| `pipelines[].runs` (866 runs, 1,186 attempts) | 15,084,138 |
| `runs[].attempts[].effectiveRole` | 6,499,610 |
| of which `effectiveRole.promptScaffold` | 6,362,568 |
| `runs[].attempts[].report` | 4,551,500 |
| `runs[].attempts[].verdict` | 2,261,669 |
| `runs[].attempts[].definition` | 786,806 |
| `pipelines[].stages` (866 stages) | 5,100,822 |
| of which `stages[].effectiveRole.promptScaffold` | 4,506,857 |
| `pipelines[].stageReports` | 2,044,488 |
| `pipelines[].spec` | 622,666 |
| `pipelines[].delivery` | 388,455 |
| `tasks[].details` | 2,620,775 |
| `tasks[].assignments` | 1,869,519 |
| `tasks[].text` | 731,380 |
| `tasks[].doneAdmissions` | 699,144 |
| `tasks[].note` | 187,207 |
| `tasks[].prototypeReview` | 55,021 |
| `files[].spawn` | 344,119 |
| `files[].durableLineage` | 155,855 |
| `files[].agentActivity` | 110,961 |

`filesReadSummary` only removes flow specs and nulls pipeline cursor/attempt
input and attempt output (`src/lib/filesReadSummary.ts:8`). Tasks only lose
full prototype histories in favor of summaries
(`src/lib/prototypeReview/read.ts:14`). Scaffolds and historical findings
therefore survive the summary transformation. Dropping task details alone
would produce only about a 1.08× reduction; dropping the two scaffold groups
would produce about 1.48×. Neither reaches the 10× target. Compression of the
whole body gives 4.96× here.

## What a poll does today

Delta support already landed in first-parent merge `8bf1bea7d` on
2026-09-21 23:59:23Z (#1996). Evidence command:
`git log --first-parent -7 --format='%h %cI %s' -- src/lib/filesDelta.ts src/lib/filesReadSummary.ts`
(05:26Z). The current path has four materially different costs:

1. A matching projection key reuses its serialized body
   (`operatorProjection.ts:449`). A matching ETag returns bodyless 304
   (`:688`, `:723`). It does not stringify the complete board again.
2. A changed projection is built once per in-flight scope, through a shared
   worker queue (`:451`, `:488`). It still assembles and stringifies a complete
   response (`response.ts:1003`), hashes it (`:1037`), and writes result files
   (`filesResponse.worker.ts:80`). Worker health extraction parses the full
   body again (`:83`). The parent writes its certified previous full body
   before worker execution (`filesResponseWorker.ts:461`).
3. The worker creates a delta by parsing both full strings, then comparing
   serialized old/new rows and record values (`filesDelta.ts:90`, `:116`,
   `:160`). One changed pipeline resends the entire pipeline row. Main-thread
   fallback diffing exists at `operatorProjection.ts:538` and `:684`.
4. A client holding a certified ETag/raw representation opts in with the
   delta header (`useFiles.ts:678`). The server serves a chain only if it
   reaches that base, uses at most 16 links, and totals at most one quarter of
   the full body's **code-unit** length (`operatorProjection.ts:142`). Each
   scope retains 32 links. Otherwise the answer is full. Full gzip is cached
   per representation (`:168`); delta gzip runs per answer (`:718`).

The captured A→B delta changes 24 conversation rows, one project catalog row,
their order, and system health. The real diff/apply round trip reproduced B
exactly. It is a direct pair comparison; it does **not** establish whether a
live tab's retained chain would have contained both endpoints.

The outer delta-history map is unbounded by scope
(`operatorProjection.ts:117`). Evicting a response at `:352` does not remove
that scope's history. This source-backed retention risk was independently
identified by the heap lane and confirmed here at 05:26:27Z. Its live size
was not measured. Any new cursor cache needs byte, scope, and age limits.

## Per-tab cadence and consumers

There is one `useFiles` call, at `src/components/Viewer.tsx:259`. Its cache is
module-local to each document (`src/hooks/useFiles.ts:1118`); different tabs
retain their own representation and make their own requests. Selecting a
project does not filter the GET. The only normal scope change is a deep-link
`path` parameter (`useFiles.ts:105`). These are source-derived cadences (E8),
not observations of the operator's current tab count or Network panel.

| Tab state | Catalog GET behavior |
| --- | --- |
| Visible, runtime live | No recurring catalog timer. `files.revision` events debounce for 400 ms; a pending later revision is hydrated after the current read settles. Health GET runs every 10 s. |
| Visible, reconnecting/degraded/offline or runtime UI disabled | Catalog fallback every 10 s; local changes can request additional reads. Requests queue rather than execute concurrently within the hook/cache. |
| Hidden desktop, runtime live | Revision reads coalesce with a 10-s timer. Chimes and title counts continue receiving data. |
| Hidden desktop, fallback mode | Catalog timer permits a read every 30 s. |
| Hidden phone | Traffic is suspended and in-flight catalog reads are aborted; completion retries park. Becoming visible hydrates owed work. |
| Initial failure | Retry delays 1, 2, 4, 8, 16, then 30 s, capped at 30 s. |
| Incomplete scan/projection generation | Completion retry starts at 25 ms and doubles to a 1-s cap. This is additional traffic even while the ordinary catalog timer is absent. |

References: `useFiles.ts:30`, `:1357`, `:1404`, `:1418`, `:1432`, `:1479`,
`:1503`, `:1515`, `:891`; phone classification and suspension in
`src/lib/client/hiddenTraffic.ts:18`. Flow, pipeline, workflow, task, title,
and explicit files change events refresh at `useFiles.ts:1466`. Each visible
project also sends a cheap presence **HEAD** every 15 s (`:1294`); the HEAD
does not return the catalog. An open prototype detail dialog has its own
2-s detail read (`src/hooks/usePrototypeReview.ts:62`), independent of this
summary contract.

At an assumed six full uncompressed responses/minute, one tab would transfer
201.2 MB/minute; six copies of this particular delta would transfer 457.6 KB,
or 64.2 KB compressed. This is arithmetic, not a measured request rate.

Consumer map, including fields whose removal would change the rendered board:

| Fields / behavior | Client consumers (file:line) |
| --- | --- |
| Full answer, delta certification, ordering and reference preservation | `src/hooks/useFiles.ts:217` normalizes; `:246` reconciles; `:754` parses; `:792` applies; `:1230` validates delta chain; `src/lib/filesDelta.ts:218` applies v1. |
| Files, projects, names, aliases, cwd, crowned state | `src/components/Viewer.tsx:259`, `:440`, `:451`, `:544`, `:1028`, `:1730`; rail, project selection and counts. |
| Conversation aliases and launch routes | `src/components/Viewer.tsx:900`, `:1184`; deep links and pending launch resolution. |
| Pipelines, flows, workflows and task membership | `src/components/Viewer.tsx:435`, `:1846`, `:1862`; `src/components/tasks/taskWorkflowModel.ts:143`; `src/components/kanban/kanbanModel.ts:793`; board membership, status, retention and counts. |
| Task text, details, status, membership, notes, steps, holds | `src/components/kanban/kanbanModel.ts:799`, `:805`, `:842`, `:855`; `src/components/kanban/KanbanCard.tsx:743`; `src/components/kanban/useTaskMutations.ts:139`; `src/components/kanban/KanbanBoard.tsx:1010`. Details are expandable/editable; omitting them requires a complete detail-loading contract. |
| Done admissions and hidden groups | `src/lib/tasks/boardVisibility.ts:64`; removing them can change which cards return after retention. |
| Stage state, navigable history, parked question | `src/components/pipelines/pipelineModel.ts:581`, `:588`; `report.summary` supplies the needs-decision question. |
| Verdict/error/reason, role engine/model/effort/access | `src/components/pipelines/pipelineModel.ts:525`, `:920`; `src/components/pipelines/VerdictPopover.tsx:114`; `src/components/pipelines/StageCompletedCard.tsx:52`. |
| Stage prompt/scaffold/spec | `src/components/pipelines/StageCompletedCard.tsx:59`, `src/components/pipelines/StagePlaceholderPane.tsx:240`, `src/components/pipelines/PipelineEditor.tsx:42`; `src/lib/pipelines/prompts.ts:46` uses the scaffold. Existing previews/editors need complete values. |
| Prototype waiting rounds, dismissal, delivery phase, seat decisions | `src/components/Viewer.tsx:265`, `:1015`, `:1911`; `src/hooks/usePrototypeReview.ts:26`, `:30`; `src/components/prototypeReview/PrototypeReviewHost.tsx:23`; `src/components/kanban/cardState.ts:116`; `src/components/attention/attentionQueue.ts:70`. |
| Top-level `prototypeReviewNotices` | Present on the wire; `parsedFilesData` at `src/hooks/useFiles.ts:217` does not retain it. Current UI re-derives notices from task summaries and seat decisions. Its 5.8 KB is negligible; preserving only this field while dropping task summaries breaks the UI. |
| Work links and health/errors | `src/components/Viewer.tsx:2000`, `:1897`, `:1864`; preserve links and degraded/failure notices. |
| Reload snapshot | `src/hooks/useFiles.ts:1122` stringifies the whole raw answer, then checks its length against `FILES_SNAPSHOT_MAX_BYTES` at `src/lib/client/filesSnapshotStore.ts:22`. B's 31,019,709 code units exceed the 25,165,824 limit, so this representation is refused for persistence after paying stringify cost. Coordinate with the cold-start lane. |

## Isolated time, transfer and allocation

E4 measured the exact JSON/crypto/delta helpers against A and B. Input reads,
initial parsing, and explicit pre-sample GC are outside the timed interval.
The first run warms each case; the table reports the next seven. No store
read, scanner, registry enrichment, worker queue, or React rendering is
included. `files-json` on a live response is also not pure stringify time:
its source interval includes summary preparation and SHA-1, and cached
responses can carry the original build's timing.

| Operation | Median ms | Min–max ms |
| --- | ---: | ---: |
| Server `JSON.stringify(B)` plus SHA-1 | 157.63 | 110.13–164.19 |
| `diffFilesBodies(A,B,etagA,etagB)` | 172.11 | 137.01–223.00 |
| Full gzip, current async zlib level 6 | 240.61 | 214.22–255.01 |
| Delta gzip, same helper | 0.93 | 0.82–0.99 |
| Bun client JSON parse only, full | 32.56 | 29.93–44.33 |
| Bun parse/apply delta only | 0.47 | 0.42–0.62 |
| Bun real client cache, second full answer | 106.39 | 101.37–119.29 |
| Bun real client cache, second delta answer | 2.26 | 2.10–3.05 |
| Bun real client cache, 304 | 0.07 | 0.06–0.13 |
| Chromium real client cache, second full answer | 296.40 | 280.00–304.60 |
| Chromium real client cache, second delta answer | 3.60 | 3.00–4.20 |
| Chromium real client cache, 304 | 0.10 | 0.00–0.20 |

The browser timed `await cache.revalidate()` using scripted native Responses
after hydrating A, through the current `createFilesClientCache`. This includes
body consumption, parse, patch and cache publication; it excludes HTTP, React
commit, layout and paint. Browser samples used one warmup and seven retained
runs with GC before each measured second answer. Zero is timer resolution.

E6's separate loopback HTTP instance served already-built bodies, one caller
at a time. It used Bun's HTTP transport, not Next's complete files route.
Raw `node:http` counted compressed bytes without automatic decompression.

| Frozen response | Body bytes | Median TTFB ms | Median complete ms |
| --- | ---: | ---: | ---: |
| Full identity | 33,532,418 | 4.84 | 23.49 |
| Full gzip | 6,765,121 | 1.91 | 4.36 |
| Delta identity | 76,259 | 0.14 | 0.20 |
| Delta gzip | 10,698 | 0.08 | 0.10 |
| 304 | 0 | 0.16 | 0.20 |

The delta is **439.7×** smaller uncompressed, **632.4×** smaller compressed.
This proves the existing representation can encode this observed change
compactly. It does not establish the full-response fallback rate in production.

Allocation evidence is deliberately separated from endpoint RSS:

| Work per representation build | Measured materialization |
| --- | --- |
| Full stringify | One 31,019,709-code-unit string; Bun `estimateShallowMemoryUsageOf` reports **62,039,434 bytes** (59.17 MiB) for that returned string. UTF-8 encoding is 33,532,418 bytes when materialized. |
| Existing A→B diff | Two parses consume **67,061,881 UTF-8 bytes**. **16,357 stringify calls** return strings totaling **66,620,237 UTF-8 bytes**, with **122,986,102 bytes** (117.29 MiB) of cumulative shallow string-size estimates. Parsed object graphs and comparison maps are additional. |
| Full gzip on cache miss | Median observed external-memory endpoint increase 38.47 MiB in E4. Gzip is reused for later full reads of that representation. |
| Delta gzip | Median observed external-memory endpoint increase 0.09 MiB. The encoded result is 10,698 bytes. |
| Hot 304 | Complete-body serialization/diff/compression is avoided when the projection key remains valid. A stale 304 may still accompany a background rebuild. |

E5 temporarily wrapped `JSON.stringify` and `JSON.parse` in the isolated
process, counted calls/lengths, and summed
`estimateShallowMemoryUsageOf(result)` for stringify results. The diff probe
used short ETag labels for allocation accounting; its string count/total
therefore differs slightly from the real wire envelope. The size estimates
measure string results, not total allocator traffic or simultaneously live
heap. String storage may be shared. E5 endpoint RSS rose about 93.6 MiB during
serialize/hash and 180.0 MiB during diff; these are noisy net footprint changes.
Early `heapStats` endpoint counters reported zero changes for some parse/diff
operations despite the counted work. Those counters cannot establish zero
allocation. No total native allocation or production GC attribution is claimed.

A changed-scope build can therefore materialize roughly **176.45 MiB of
string results** across full serialization and comparison before the client
receives even a small delta. Builds are shared within a scope; multiplying
that number by tab count unconditionally would be incorrect. Separate scope
builds, per-answer delta compression, and each tab's parse/apply add their own
work. Identical-body polls can avoid most of this cost.

## Proposed contract

Prefer a **versioned incremental board feed** that preserves the complete
client-visible model. First load can remain full. A slim projection is a
possible later optimization, after every editor/preview has explicit detail
hydration. Simply deleting report, scaffold, details, assignments or waiting
fields from today's response changes existing consumers.

1. Keep existing `view=summary`, delta v1, and full response behavior intact.
   A new client requests an explicit protocol, for example
   `view=summary&schema=2`, and recognizes an explicit `boardProtocol: 2`
   marker. An old server may ignore the extra parameter and return v1; the
   client accepts that full answer, then uses its existing v1 behavior.
   Unknown protocol versions trigger a bounded legacy refetch and preserve
   the last good board until it succeeds.
2. A v2 cursor identifies `{epoch, scope, sequence}`. Scope includes schema,
   operator/agent visibility, and pin; selected-project filtering remains
   unchanged. Epoch changes on restart/release. A response names its base
   and target cursor plus the scan-built stamp. Never use a process-local
   sequence alone across a release. Reject a wrong scope, missing base,
   expired history, unsupported version or broken chain with a full reset
   response. Preserve forward-only behavior, pin overlays, auth refusal,
   optimistic overlays and failure counters from `useFiles`.
3. Keep projected records and their revisions/digests as structured values.
   For an unchanged scope return 304 without body serialization. On changes,
   serialize changed records once and share that immutable result across
   waiting tabs. Avoid `JSON.parse(oldBody/newBody)` plus whole-catalog row
   stringify. A collection revision is a wakeup signal; cache identity must
   reflect the actual projected content, including derived health, time-based
   attention, dismissals, role changes, work links, aliases and pin overlays.
   Explicitly account for external writers and deleted records.
4. Use stable keys (`path`, project key, task/pipeline/workflow/flow id),
   explicit removals and order updates. For pipelines, provide patches at
   stage/attempt/field granularity so one status change does not resend its
   role scaffold and all previous findings. Address an attempt by stable
   stage identity plus attempt identity, validated against its base; a graph
   edit or ambiguous identity can replace the containing row. Apply the
   envelope atomically, retain unchanged object references, and use own data
   properties for arbitrary record keys. Preserve null, absence, empty arrays
   and deletions distinctly. Keep current text and histories exactly available
   in the reconstructed model.
5. Cache serialized/compressed delta envelopes by scope/base/target/encoding.
   Bound retained cursors by **UTF-8 bytes**, scopes, links and age; evict a
   scope's delta history with its response cache. Coalesce changes into a
   target patch when possible, avoiding repeated row bodies across a long
   chain. Record full-fallback reasons (`cold`, `epoch`, `expired`, `scope`,
   `unsupported`, `delta-too-large`) and measured byte totals without payload
   text or identities. Do not retain multiple full strings per cursor.
6. Advertise version support explicitly. Old tabs receive their existing
   full/v1 payload from the new server. New tabs tolerate a previous server
   after rollback. Persist client snapshot schema and server scope together;
   a stale local cache never certifies a cursor for a new protocol. Gzip and
   conditional responses remain supported with appropriate Vary metadata.

The current B-size 10× full-summary threshold is **3,353,241 bytes**. The
delta option can satisfy steady-state transfer while retaining a full first
load. Acceptance must measure normal updates, largest-row updates, additions,
removals, reorder, dismissals and release reset; a small conversation-only
delta alone does not demonstrate the whole outcome.

## Before/after method and handoff

Use the same frozen input pair and runtime for baseline and candidate. The
payload seam above is reproducible with `JSON.stringify`/SHA-1,
`diffFilesBodies`, `applyFilesDelta`, `gzipBody`, and
`createFilesClientCache`. Warm each once, retain at least seven paired samples,
and assert reconstructed model equality before interpreting speed. Include
identity, gzip and 304 paths; include a changed pipeline with its largest
report and a changed task with its largest details. Record raw samples,
min/median/max, UTF-8 bytes, code units, output string estimates and process
memory separately. Run the same cases in Chromium through the real cache.

For full route acceptance, create one read-only database backup and copy its
associated scan/state inputs to isolated roots. Never start an ordinary
Viewer against live registry paths. Disable lifecycle activation and restrict
the replay's filesystem/network so it cannot adopt, signal, launch or contact
live workers. Replay old/current code on identical data and boundaries; wait
for deferred initialization before calling a run steady-state. Record cold
restart separately with the cold-start lane. Instrument projection assembly,
store/decoder reads, JSON encoding, hashing, diffing, file transport,
compression, HTTP completion and browser apply independently. Emit current
per-request timings rather than interpreting a cached build timing as a
fresh request duration.

Exercise 1, 4 and 8 visible tabs and hidden desktop/phone cases with the same
revision script. Include quiet polls, sustained updates, slow/missing
responses, malformed/unknown deltas, missed history, pin changes, auth
refusal, server restart, handover and rollback. Record response kind and
fallback reason per poll; count full payloads, transferred bytes/minute,
projection builds/scope, serialization/allocation per build and per answer,
main-thread apply time, and p95/max loop delay. Compare cumulative allocation
using a suitable runtime profiler separately from RSS/HWM. Do not infer a
GC cause from response latency alone.

Rendered equivalence belongs in the existing
`src/components/kanban/kanbanBoard.browser.test.tsx` driver over its shared
fixture, plus the existing phone driver where relevant. Assert identical
card identity/order/text, memberships, notices, waiting rounds, delivery and
dismissal state, counts, stage errors, links, retained history, expanded
details and editable drafts at the same clock. Cover nonempty flows,
workflows and seat decisions because this production sample has none.
Inspect fresh driver frames; the cache microbenchmark above supplies no
rendered-equivalence evidence.

Coordinate implementation boundaries:

- Heap/GC lane `eab4fd13`: measurements and the delta-history retention risk
  were exchanged through its existing conversation. Its
  [heap/GC audit](viewer-heap-gc.md), available on continuation and read at
  05:36–05:38Z, confirms that 80 synthetic scopes leave 80 delta histories
  after the body cache falls to 32; the retained delta payload is 13,271,480
  UTF-8 bytes. That audit's production scope occupancy remains unmeasured.
  Its statement that this lane made no live GET describes the earlier attempt;
  E9 above records the subsequently authorized request. This lane owns poll contract,
  serialization and delta cache changes; the heap lane owns broader heap
  attribution. Its live pause observations are not reused as this audit's
  measurements.
- Runtime snapshots `926031f3`: separate protocol and transport, no edits.
- Cold board start `2f8d72dc`: notify it of the snapshot length cap and
  protocol reset behavior; keep cold-start measurements separate.
- Dashboard derivation `c0f00aba`: preserve reconstructed data and reference
  identity; React derivation/commit belongs to that lane's measurements.
- #2905, state-DB lock, and MCP writers: no changes or probes that acquire
  mutation authority. Revision observation must retain their existing fences.

Validation so far: the three explicit contract files passed (E7); the
production-sized delta round trip matched B exactly; Chromium cache and
loopback HTTP replay completed. This audit changes only this Markdown file.
At 05:28:31Z, the local privacy gate passed with committed fingerprints and
`--require-known-values --repository "$WORKTREE" --paths docs/perf/board-poll-payload.md`;
`git diff --check` also passed. The continuation's same path-scoped privacy
command passed during **05:41:09–05:41:59Z**, using the scratch copy of
`scripts/privacy-publication-gate.ts` through the isolated gate. At
**05:41:58.934Z**, Python checks against `live-get.json` and
`live-breakdown.json` verified aggregate arithmetic, body hashes, one request
receipt, Markdown whitespace and unchanged HEAD. `git status --short
--untracked-files=all --ignored` showed only this declared Markdown output.
The earlier 13 contract tests remain valid for unchanged runtime source; no
new runtime tests were needed for this documentation continuation.
CI publication/runtime checks remain requirements for the later code change;
this stage neither publishes nor claims those checks.

The authorization gap is closed by E9. The audit is ready for implementation:
the live payload, stored production-size replay, client consumers/cadence,
version-tolerant contract and before/after method are recorded. The actual
browser response mix, full-route allocation profile and rendered equivalence
remain implementation-validation work; they are not inferred from this
single request or the isolated cache benchmark.
