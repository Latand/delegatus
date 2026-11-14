# Documents an agent hands over open in Delegatus

Status: design for the builder. Grounded at `origin/main` `4e8bc62d8`. The lane
started from `a8d0fe23e`; the one commit between them changes no file this
design cites except `src/lib/scanner/describe.ts`, and that hunk only adds a
read-only option to transcript description.

## 1. Originating requirement

Source: the operator, on the pinned board task, 2026-11-04. This file is public,
so the words are paraphrased in English; the verbatim text stays in the task's
private record.

- Agents keep giving links that do not open. Check the latest main and whether
  this was closed before, because it was already asked for.
- Then: fix it and merge it.

The pinned acceptance adds the following.

- Normal agent document outputs persist under a trusted registered-project or
  managed deliverable location, and the links agents emit are served by the
  resolver, metadata and content paths for JSON and Markdown. HTML preview stays.
- The two reports from the incident resolve without changing their bytes or the
  original files. Safe copies in a durable location with corrected links are
  acceptable.
- No blanket home or project-parent allow-list, no transcript path as authority,
  no manual permission change or environment toggle as the product fix.
- The unauthorized, personal-file, secret, traversal, symlink and cross-project
  boundaries hold.
- Future stage handoffs never silently emit an inaccessible document link; a
  failed publication surfaces through an existing contract as an actionable
  failure. Suppressing or breaking links, or reporting false success, is refused.

## 2. What the code and the incident show

All of this was observed, with the method named.

| Fact | Evidence |
|---|---|
| The resolver is correct; the refusal is admission. A final-message Markdown link parses to the right file, then `/api/artifact` answers 403 `access-denied`. | `src/lib/artifact/localFile.ts:80` returns null, `src/app/api/artifact/route.ts:103` refuses. The auditor reproduced it on the serving release and on isolated current main. Repeated here at `a8d0fe23e` under isolated state, Bun 1.4.0, in-process against the real `GET`. |
| Admission covers exact project folders and worktrees, manual projects and `statePath("scratch")`. | `localFile.ts:72-75`, from #3207. |
| A state-rooted admitted file serves all three formats. | Same probe, with exact copies of both incident files under an isolated `statePath("scratch")`: JSON and Markdown answer meta 200 and content 200 with equal SHA-256. A single-file HTML report also answers both, and its meta carries `frame`. A symlink there pointing at the original answers 403. The original paths answer 403. |
| **The incident was a real stage handoff, and its report carried no link.** A read-only stage with no declared outputs was briefed to write beside a private proposal outside any project. Its `stage_report` summary names no file. The links appear only in the final assistant message written after that call. | Primary transcript, tool call and final message. |
| Validating `stage_report` text alone would miss the incident. | Same record. For a non-pass verdict `reportedStageVerdict` also drops the final message from the output (`src/lib/pipelines/engine.ts:6328-6331`). |
| `$TMPDIR` is removed at settlement, so a link into it dies right after the handoff. | `src/lib/runtime/structuredSpawn.ts:175-179`, and the stage prompt. |
| Each attempt's scratch is recorded server-side, keyed to its launch. | `AttemptTempStore.register` and `owner` in `src/lib/runtime/attemptTempRetention.ts:52-61`; `structuredSpawn.ts` registers scratch and config roots with the launch. Read-only query for this attempt returned both roots. |
| `$TMPDIR` can be empty inside a live Claude stage. In this architect stage the broker process has `TMPDIR` and the `claude` child and its shell do not, although #3167's test passes. | `/proc/<pid>/environ` key check, and an empty value in a fresh `bash -c`. Cause not established; see Notes. |
| A managed copy is not swept today. | The only state paths the sweeps name are `statePath("scratch")` (`src/lib/tempSweep.ts:864`, `src/lib/state/diskPressure.ts:138`). |
| PR bodies read `report.summary`, falling back to `attempt.output` for read-write attempts. | `src/lib/pipelines/stagePullRequest.ts:25,146`. An absolute home path there reaches the privacy gate. |
| Workspace-scoped reads key on `projectForCwd(dirname(real))`, which gives a state-rooted file an unrelated `dir-` key. | `route.ts:122`, `src/app/api/image/route.ts:76`; probe printed a `dir-` key. Members fail closed there, including members of the project that produced the file. |

History: #884/#885 bookmarkable preview; #1982 shared resolver with Markdown and
HTML; #2084/#2253 raster evidence only, so this defect's document half was never
closed; #3207 narrowed reads to registered projects, worktrees and stage scratch,
which is the change the incident hit. Updating to current main does not help:
resolver, policy and route hashes match the serving release.

## 3. Decision

Add one managed store, `statePath("deliverables")`, admitted exactly as stage
scratch is admitted. `stage_report` gains `deliverables`, a list of files the
stage owns. The server copies each into the store with verified bytes, proves
the copy passes the same decision the route makes, and returns a link. A failed
publication refuses the call with an actionable code. Links in report text are
checked the same way at the call. Links in the final message, which the server
cannot refuse because it is written later, are checked at settlement and recorded
on the attempt.

The security argument fits in one line: **publication only copies what the
calling attempt already owns, so it extends lifetime and grants no new read.**

## 4. Options

| Option | Result |
|---|---|
| Widen admission to home or a project parent | Refused by the requirement; undoes #3207. |
| Register the report directory as a manual project | Exposes every sibling file, needs an act per directory, and fixes nothing for the next stage. Refused as a permission change. |
| Add documents to the evidence roots or `LLV_EVIDENCE_ROOTS` | `/var/tmp` is shared and #3473 retains its document denial. An environment toggle is refused. |
| Copy into the project checkout (`.artifacts/`) | Writes into checkouts the operator owns, is not ignored in arbitrary repositories, and worktree cleanup may remove it. |
| Treat a transcript link as authority and copy from it | Refused by the requirement; it is a confused deputy (§7). |
| Writable per-attempt `$LLV_DELIVERABLES_DIR` | Needs env and sandbox grants in every host, the files #3473 is rewriting, and offers no validation point or byte proof. Deferred. |
| Dedicated `publish_deliverable` MCP tool | Would also serve seats and spawned agents, at the cost of a new tool, role-fence entries and a second refusal path. Deferred (§11). |
| **Managed store + `stage_report.deliverables` + link checks** | **Chosen.** One root line, one module, one optional report field, no spawn change. |

## 5. Design

### 5.1 Store and admission

Layout: `<state>/deliverables/<projectKey>/<sha256>/<basename>`.

- `projectKey` is `pipeline.project` from the controller's record and must match
  `^[A-Za-z0-9._-]+$`. The caller never supplies it.
- `basename` comes from the resolved source. The caller never supplies a name.
- Content addressing makes copies immutable and repeat publications idempotent.
- `projectRoots()` in `localFile.ts:73` gains `statePath("deliverables")` beside
  `statePath("scratch")`. `admittedAs` then answers `"project"`, so
  `realpathAdmitted`, `openAdmitted` and `classifyArtifact` all apply unchanged.
- Directories are created 0700, files 0600, as scratch does.

### 5.2 One servability decision

`src/lib/artifact/classify.ts` already promises that a link previews if and only
if the server agrees. Handoff validation must ask that same decision, so extract
lines 101-156 of `route.ts` into `src/lib/artifact/servable.ts`:

```ts
openServableArtifact(raw, { allowProject?: (real: string) => boolean }):
  Promise<{ ok: true; handle; stat; head; real; kind; mime; name }
        | { ok: false; code: FailCode | "workspace"; error: string }>
```

The check order stays admission, classification, realpath, re-admission,
workspace, pinned open, regular file, sniff. The route keeps its status table,
headers, range handling and streaming. Its existing tests pass **unmodified**;
that is the proof this is a refactor. The Next route handler shape does not
change (`next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`,
Next 16.4.2). Also correct the route's header comment, which still says reads
are confined to the home directory.

`fileProjectKey(real)` in `src/lib/artifact/deliverables.ts` returns the
`projectKey` segment for a path under the real store root and
`projectForCwd(path.dirname(real))` otherwise. `/api/artifact` and `/api/image`
use it for `canReadFile`. `canReadFile` already resolves aliases, so a project
whose key later moves keeps its deliverables.

### 5.3 Publication through `stage_report`

Input: optional `deliverables: string[]`, at most 8 entries, each 1-4096
characters with no NUL or newline. A relative entry resolves against
`pipeline.worktreeDir`.

Publication runs in `reportStageCompletion` after the attempt is resolved and
`heldWork` passes, and **before** `withPipelineMutation`, so no copying happens
under the pipeline lock. The whole publication has a 20 second deadline.

For each source:

1. `resolveLocal`, then `realpath`.
2. **Ownership fence.** The real path lies under the real `pipeline.worktreeDir`
   with no `.git` segment, or under a root registered to `attempt.launchId`
   through a new one-line `AttemptTempStore.rootsOfLaunch(launchId)`. Nothing else
   qualifies, including other lanes' worktrees, other attempts' scratch, fenced
   stores, and any other path under home. The fence stands even for a path the
   route would admit, because the attempt's authority is the question here.
3. `classifyArtifact` accepts it, then `openAdmitted`, regular file,
   `stat.size <= artifactLimits().maxBytes`, `sniffAgrees`.
4. Copy through the pinned descriptor into `mkdtemp` under `<store>/<projectKey>/`,
   hashing as it reads; `fsyncPath` the file; `rename` into place; `fsyncPath` the
   directory; remove the temp directory in `finally`. An existing target is
   re-hashed: equal is reused, different refuses with `store-conflict`.
5. **Prove it.** `openServableArtifact(target)` must answer ok, and hashing through
   that descriptor must equal the source hash. Otherwise the file counts as
   unpublished. There is no false success.

The accepted answer and `report.deliverables` carry
`{ name, path, link, sha256, bytes }`. `link` is always `#f=<encodeURIComponent(path)>`:
the probe showed a plain path is not percent-decoded, so `#f=` is the one spelling
that works for every name, including spaces.

Refusal: `STAGE_REPORT_DELIVERABLE_UNAVAILABLE`, thrown as `McpUnadmittedRefusal`
so the same `clientRequestId` works after the agent repairs the cause. It records
no report. Details list `problems: [{ source, reason, action }]` and `scratch`, the
attempt's own registered scratch directory. `scratch` is what keeps the instruction
usable where `$TMPDIR` is empty. Reasons: `outside-attempt`, `not-found`,
`not-a-file`, `unsupported`, `mime-mismatch`, `too-large`, `store-conflict`,
`store-unavailable` (carrying the errno), `deadline`.

The stage is never trapped: it can copy the file into `scratch` and retry, or
report without the entry and say why.

A `rewriteOwner` summary rewrite keeps `prior.deliverables`, the way it keeps the
verdict and provenance.

### 5.4 Links in report text

`handoffFileLinks(text, baseDir)` in `src/lib/artifact/linkTarget.ts` is pure. It
strips fenced blocks and code spans, then collects Markdown inline link targets
(allowing one balanced parenthesis level), `<autolinks>`, bare `file://` URLs and
viewer URLs carrying `#f=` or `#a=`. Each goes through `resolveRelative(baseDir, …)`
and `resolveLink`. It keeps `kind: "file"` targets whose path `classifyArtifact`
accepts. Bare path mentions are excluded because the feed does not make them
clickable, and directories and transcripts are out of this contract. That keeps
ordinary citations from blocking a report.

`reportStageCompletion` runs each link in `summary`, `result`, findings text and
`taskSummary` through `openServableArtifact`. A refused link, or a resolved path
under `statePath("scratch")` (reason `removed-at-settlement`), refuses the call with
the same code. Links are checked only when text contains any, so a report without
links does no extra work.

### 5.5 Final-message check at settlement

`ParsedStageVerdict` gains optional `handoffText`, which `reportedStageVerdict` sets
to the final message plus `reportProse`. `settleStageVerdict`, which all five call
sites and the fenced fallback reach, scans `parsed.handoffText ?? parsed.output`
before `attempt.output = parsed.output`, with at most 20 links and a 2 second
deadline.

Each problem is recorded as `attempt.unavailableHandoffLinks: [{ name, reason }]`.
A note is appended to `attempt.output` giving the count, names and reasons with
**basenames only**, plus the corrective action. Basenames matter because
`attempt.output` can reach a PR body. A deadline records `unchecked`, so an
unfinished check never reads as clean. The field is returned by the
`get_pipeline` stage projection (`src/lib/mcp/compactAnswers.ts:256`) and is relayed
to the next stage through the output.

The verdict and routing **do not change**: a broken link never turns a pass into a
fail, and a stage that made one is not re-run. Automatic repair is deferred (§11).

### 5.6 Agent contract

One line in `renderStagePrompt` (`src/lib/pipelines/prompts.ts`, beside the
provenance line at :171), and one sentence in the `stage_report` tool description
and schema, conveying:

- pass the documents meant for a person in `deliverables`, naming a file in the
  worktree or in `$TMPDIR`, copying a file there first if it lives elsewhere;
- write the returned links in the final message;
- keep them out of `summary`, because PR text reads that field.

The line sits apart from the `DELEGATUS_MECHANICS` sentence that #3473 rewrites, so
the two do not collide. Tests check behaviour and do not assert this wording.

### 5.7 The operator's two documents

A release must be serving before any managed link opens, and this lane deploys
nothing. After the merged release is serving, the seat launches one read-only
verifier stage, with the two private source paths in its private brief. That stage:

1. hashes the originals, copies them into its scratch and compares hashes;
2. calls `stage_report` with `deliverables`, the product path, so nothing writes
   the store by hand;
3. requests metadata and content for both returned links through the authenticated
   same-origin Viewer, compares the content hashes with step 1 and re-hashes the
   originals to show they are unchanged;
4. writes both links in its final message.

No file in this repository names those documents.

## 6. Everything that reaches the shared paths

| Path | Producer or consumer | Effect of this change |
|---|---|---|
| `AllowedRoots.projects` | `/api/artifact`, frame route, `/api/image`, `taskAlbum/album.ts` | All see one more root, with no code change except the workspace key below. |
| `prototypeReview/input.ts` | Own home/evidence check | Unchanged. Fenced stores stay fenced. |
| `done/world.ts` | Evidence roots only | Unchanged. |
| Frame route | Scope minted by meta over `dirname(real)` | Scope is one content-addressed directory, so it reaches no sibling. |
| `stage_report` schema | `server.ts`, `schemaParity.test.ts`, `normalizeStageCompletion`, `compactAnswers` | Optional field. The schema's `.passthrough()` means an older server ignores it, so its answer has no `deliverables`. |
| `PipelineStageReport`, `PipelineStageAttempt` | `store.ts` `isStageReport`, attempt validator, `stageProvenanceFence` | Optional fields only; validators accept `undefined`, so persisted lanes still load. `report` is already excluded from the fence. |
| `attempt.output` | Relay, stage pane, PR body fallback | Note carries basenames only. |
| Cloud stages | No local source | Sources refuse `not-found`; the agent reports without them. |
| Fenced JSON fallback | No `stage_report` | Settlement scan still runs on `parsed.output`. |

## 7. Threat cases

Each runs against `/api/artifact`, the frame route, `/api/image` and publication.

| Threat | Server-side check that holds |
|---|---|
| Cross-origin or rebinding page reads the store | `rejectCrossOrigin`, unchanged. |
| Member of project B reads A's deliverable | `canReadFile(fileProjectKey(real))`; key comes from the path, written from the controller record. |
| Confused deputy: a sandboxed agent asks the broader-reading server to copy another project's or a personal file | Ownership fence, step 2. Refused before any open. This is why a transcript path or caller claim carries no authority. |
| Secret or dotfile | `classifyArtifact` refuses `.env`-shaped and unknown types. A secret already inside an owned tree was already readable through its admitted root; publication does not widen that. |
| `..` traversal, including under the store | `resolveLocal` before every check; negative test at each path. |
| Symlink, at the last component, or a parent, or inside the store | `realpath` then re-admission; `O_NOFOLLOW` and descriptor place in `openAdmitted`. |
| Directory swapped between check and open | `descriptorPlace`, unchanged, used by publisher and route alike. |
| FIFO under the name | `O_NONBLOCK` and the `isFile` check. |
| Fenced store as a source | Outside the fence, and `inFencedStore` still refuses it. |
| Executing HTML | Existing sandboxed frame and inert CSP, unchanged. |
| A report from a stale or foreign conversation | Attempt resolved server-side from the caller, as today. |
| A same-uid unrestricted agent writes directly into the store | Same exposure as writing into any worktree it can reach, and it can only place bytes it could already read. Symlinks out are still refused. Recorded as accepted. |

## 8. Exact change surface

Nothing else is edited. In particular: no spawn, sandbox, role-default, gate-script,
runtime-host or settings change.

| File | Change |
|---|---|
| `src/lib/artifact/localFile.ts` | Add the root at :73. |
| `src/lib/artifact/servable.ts` (new) | §5.2 extraction. |
| `src/lib/artifact/deliverables.ts` (new), `.test.ts` | `publishDeliverables`, `unavailableHandoffLinks`, `fileProjectKey`. |
| `src/lib/artifact/linkTarget.ts`, `.test.ts` | `handoffFileLinks`. |
| `src/app/api/artifact/route.ts`, `route.test.ts` | Use `servable`, use the key, correct the comment; add §9 cases. |
| `src/app/api/image/route.ts`, `route.test.ts` | Use the key. |
| `src/lib/runtime/attemptTempRetention.ts` | `rootsOfLaunch`. |
| `src/lib/pipelines/types.ts`, `store.ts` | Optional fields, tolerant validators. |
| `src/lib/pipelines/verdict.ts` | `handoffText`; normalize `deliverables`. |
| `src/lib/pipelines/engine.ts` | `reportStageCompletion`, `reportedStageVerdict`, `settleStageVerdict` only. |
| `src/lib/pipelines/prompts.ts` | One line. |
| `src/lib/mcp/server.ts`, `bindings.ts`, `compactAnswers.ts` | Schema, description, refusal type, acknowledgement, stage projection. |
| `src/lib/mcp/stageReportDeliverables.integration.test.ts` (new) | Beside `stageReportRecordedChecks.integration.test.ts`. |
| `src/components/conversation/conversationWindow.browser.test.tsx` and its fixture | One `describe`. |
| `evidence/agent-document-handoff.json` (new) | The rendered-evidence record. |

## 9. Acceptance and test plan

Run every test by path, on the pinned Bun, with isolated `HOME`, `XDG_CONFIG_HOME`,
`TMPDIR` and `LLV_STATE_DIR`, through the project's `gate-slot.sh`. Write each new
test first and show it red against the merge base. Fixtures are synthetic: no
private file, path or quote enters the repository.

**A1. Admission, `localFile.test.ts`.** The store admits. A sibling named
`deliverables-x` does not. Home, a project parent, and an unregistered folder under
home stay null. An evidence root still refuses documents and serves rasters. Fenced
stores stay refused.

**A2. Publisher, `deliverables.test.ts`.**
- Positive: JSON, Markdown and single-file HTML, from a worktree and from registered
  scratch. Bytes are equal by hash, a name with a space works, and a repeat is
  idempotent.
- Negative, each with **no store entry left behind**: a path outside the attempt; an
  unrelated file under home; another lane's worktree; another attempt's scratch; a
  last-component symlink; a parent symlink; a parent swapped during the check; a
  FIFO; a directory; a dotfile; `.jsonl`; a `.md` containing NUL bytes; over the size
  limit; a ninth entry; `..` traversal; a fenced-store source; a tampered existing
  target; a read-only store, which must report `store-unavailable` with its errno.

**A3. Link extraction, `linkTarget.test.ts`.** Finds a Markdown absolute link, a
relative link with its base, `file://`, `#f=`, a loopback viewer URL, `~/` and a
`:line` suffix. Ignores a code span, a fenced block, `https`, a `.jsonl` path, a
directory and a bare mention.

**A4. Full path, `route.test.ts`.** Written around the production functions: a
final-message string goes through `handoffFileLinks`, `resolveLink` and the real
`GET` for meta and for content.
- Published JSON, Markdown and HTML return 200, content hash equals source, HTML meta
  carries `frame`, and the frame route serves the copy.
- Negative: an incident-shaped unregistered path stays 403 `access-denied`; a symlink
  in the store pointing out is 403; traversal is 403; cross-origin is rejected.
- Workspace: a member of A gets 200 on A's deliverable, a member of B gets
  `workspace_forbidden`, and an unauthenticated member request is refused.
- Every existing case in this file passes unmodified.

**A5. Tool contract, MCP integration test.** Uses the in-memory client and the real
`reportStageCompletion`.
- `deliverables` returns entries whose `link` passes A4, stored and returned by
  `get_pipeline`.
- A refusal records no report and returns `problems` and `scratch`. The **same**
  `clientRequestId` succeeds after the cause is repaired.
- A summary with a dead link or a scratch link refuses. A summary with only a bare
  mention or a code span is accepted.
- A pipeline mutation is not held during the copy.

**A6. Settlement, engine test, incident-shaped.** A read-only stage with no outputs
reports `fail`, with no links in the report and an outside link in the final message.
- The verdict and routing are unchanged, `unavailableHandoffLinks` is set, and the
  output note holds the basename and no directory.
- Same for `pass`, for the fenced fallback, and for a link to scratch.
- A clean final message records nothing. A forced deadline records `unchecked`.
- A persisted lane without the new fields still loads.

**A7. Rendered proof at the built revision.** No new driver: one `describe` in the
conversation-window driver, gated as that file is.
- Run a production build from a scratch export of the final head, served by the pinned
  Bun with isolated state and the control URL on a closed port.
- Seed a transcript whose final message links a published JSON, Markdown and HTML file
  plus one unregistered path. Click each with real input.
- Frames: each link state at 1440x900 and 390x844, in en+light and uk+dark. HTML
  renders in its frame and the refused link shows its existing error.
- Assert from text ranges that the content is visible on the first screen, and record
  meta and content statuses.
- This design adds no string or style, so these frames show that existing surfaces
  work on the new path. The evidence names the revision and command.

**A8. Project checks on the final head.** Touched test files; `bunx tsc` through
`gate-slot.sh`; hooks with no bypass; then CI's `privacy-publication`,
`privacy-tracker-audit`, `runtime-gate` and the typecheck context. The lane has three
review rounds. Merge belongs to the seat or merger after a final-head pass.

**A9. Operator resolution.** §5.7 runs after the release serves and reports both links.
Until then this item is open by design; the lane must say so plainly in its report.

## 10. Parallel work and base

Checked by actual diff at this design's base. Re-run before finishing the build, since
hunk headers show the enclosing function only and are weak evidence.

| Change | Overlap | Handling |
|---|---|---|
| #3473, head `765642f84` | `localFile.ts` (evidence-root hunk), `prompts.ts` (prototype line), `roles/defaults.ts`, `server.ts` (prototype description), attempt-temp files, retention. It keeps documents denied from evidence roots and adds `statePath("evidence")`. | Different hunks; `owner()` survives there at a moved line, so `rootsOfLaunch` sits beside it. If it lands first, re-verify the store sits outside its new sweeps and that `$LLV_EVIDENCE_DIR` stays raster-only. Do not use its evidence folder for documents. |
| #3638, #3613, #3561, #3557, #3263 | `engine.ts`, some `types.ts` | No hunk header names the three functions in §8. |
| #3573 | `engine.ts`, `prompts.ts` (`role.access` line) | Different lines. |
| #3585, #3263 | `server.ts` | No `stage_report` hunk. |
| Issue #3640 and its orchestration lane | None | Left intact. Its critique and source documents are untouched here. |

## 11. Deferred — not currently justified

- **Repair turn at settlement.** `publicationTextRepair` shows the shape: durable state
  and a resume. Heavy for engine code several PRs are touching. Add only if the
  settlement note fires in real use.
- **`publish_deliverable` tool and non-stage agents.** Seats and spawned agents have no
  report call. The pinned minimum names stage handoffs, and their link to a published
  deliverable opens anywhere.
- **Automatic publication of declared outputs.** They are committed to the branch, and a
  stage can list one in `deliverables` when it wants a durable link.
- **Multi-file HTML reports.** A copy holds one file, so relative assets do not resolve.
  Such a report stays in an admitted project and is linked there.
- **Store retention or a total cap.** Per-report bounds apply and the incident's documents
  total 42 KiB. Add a cap when measured growth asks for one.
- **Clearer operator text on a refused preview.** The existing error remains accurate.
- **Durability of worktree links.** They pass today's check and die with the worktree; the
  prompt line steers documents meant for a person to `deliverables`.

## 12. Validation against the requirement

| Requirement | Met by |
|---|---|
| Links open for JSON and Markdown, HTML kept | §5.1-5.3, A4, A7 |
| Persisted in a trusted managed location | §5.1 |
| The two reports resolved, bytes and originals untouched | §5.7, A9 |
| No blanket allow-list, transcript authority or toggle | §3-4, A1, ownership fence |
| Boundaries preserved | §7, A2, A4 |
| No silent inaccessible link; actionable failure | §5.3-5.5, A5, A6 |
| Links neither suppressed nor falsely reported good | Proof step in §5.3; verdict and text left intact in §5.5 |

## Notes

- `$TMPDIR` empty in a live Claude stage contradicts the stage prompt and #3167's test.
  The design survives it through `scratch` in the refusal. The cause deserves its own
  issue, which this read-only stage did not file.
- `stage_report` is served by the MCP binding. The design relies on the same-path home
  mount that `structuredSpawn.ts` documents, so the store path resolves identically for
  the publisher and the Viewer. A7 and §5.7 observe this end to end.
