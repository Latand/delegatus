> `list_tasks` and `list_pipelines` resolve `project` through the same named-project resolver as `get_orchestrator`: a key, display name or repository folder (any letter case) maps to the canonical key before the seat fence compares it. A name that matches nothing or several projects is refused with the closest matches or the candidates, as the guide describes, and never answers an empty list. `cross_project_refused` appears only when the resolved project differs from the seat's own.

Source: [issue #3720](https://github.com/Latand/delegatus/issues/3720), opened and last updated 2026-11-06 at 13:51:35 UTC. The complete issue and paginated comments were read in the first attempt and again in the continuation; every read returned zero comments. Its final investigation item also requests agreement between top-level and nested `retryable`.

# Board project reads: implementation plan

## Approved implementation decision

Implement the complete two-tool contract. The named scope amendment approved on 2026-11-06 includes the smallest `list_tasks` / `list_pipelines` changes in `server.ts` for response authority, replay and retryability, and in `workspaceFence.ts` for canonical project arguments, with their direct tests. The earlier binding-only alternative is superseded. No further scope approval is needed for these named changes.

Keep the same task, implementation lane, owner and configured model, with the existing three-round review budget and terminal recheck. This architecture stage changes only this document. The builder continues in the assigned checkout after the actual function-level sequencing below; this approval does not authorize importing a held launch-recovery branch, changing another lane or deploying.

## Evidence and its limits

Source and forge main were both `423bf964ed98d9dde744ad0f2c4f2dbf92ae146b`. The earlier intake at `b728d185`, `docs/audits/recent-issue-intake-2026-11-06.md`, and the primary followthrough matrix dated 2026-11-06 20:32:26.657 UTC were read. Their binding-level diagnosis holds. Their matrix did not establish the response/replay or workspace cases below. The continuation reopened the primary matrix message and verified every SHA-256 entry in the retained observation manifest: all matched. Assigned HEAD and local main remain at this revision; a final forge read confirmed the same main revision and unchanged issue with zero comments.

Scratch exports ran the installed Bun 1.4.0 through the assigned owned gate, one explicit test file per command. Every run used `checkEnvironment` and `isolatedEnvironment`, private HOME/config/state/TMPDIR, and a closed control endpoint. SDK `Client` used `InMemoryTransport` against the actual `createViewerMcpServer`, `createMcpToolService`, bindings and SQLite receipts. Tasks used the real task store and pipelines used `buildPipeline`. External control calls were forbidden by the fixture.

| Observation | Actual result at the source revision |
| --- | --- |
| Both tools, designated seat, key / recorded alias / omitted project | Success, one own row |
| Both tools, seat, display name / folder / unknown name | `cross_project_refused`; top-level `retryable: true`, nested `false` |
| Both tools, ordinary reader, key / alias | One row |
| Both tools, ordinary reader, display / folder / unknown name | Successful empty list |
| `list_tasks`, same explicit request key after seat project changes | Replayed the previous project's row |
| `list_pipelines`, designation changes during the real asynchronous page path over 251 rows | Returned a row and continuation from the previous project |
| Supplied caller assertion on the direct pipeline service call | Invoked zero times |
| SDK plus actual `withWorkspaceMcpFence`, workspace member | Own key returned one row; own display name returned `workspace_forbidden` for both tools |

The name probe exited 0 with 1 test and 42 assertions; its expanded observation run also exited 0 with 1 test and 42 assertions. The workspace probe exited 0 with 1 test, 4 assertions and 46 unrelated tests filtered out. These assertions verify current symptoms. The race/replay results were inspected from structured SDK output; they are observations, not future green acceptance tests.

Private evidence is retained under `$LLV_EVIDENCE_DIR/board-project-observation/`: source harnesses, logs, actual exit records and `manifest.json` with hashes. No source fix, full suite, typecheck, build, live reproduction or installed acceptance was performed. In-memory SDK transport establishes the actual tool/schema/service behavior; it does not establish HTTP authentication or installed engine identity.

## Current mechanism and boundaries

- `bindings.ts:6304`, `boardReadProject`, canonicalizes recorded aliases and compares the seat designation. It never resolves names. `listTasks` and `listPipelines` use it before selecting rows; `viewerReadTools` exposes these readers to both MCP and voice.
- `projects/nameResolution.ts` already owns retained names, case folding, canonical aliases, folder roots, short-key collisions, candidate lists and close matches. Its inputs include the completed catalog, project key index, aliases, presentation/curation, remotes, caller project and seats. No additional identity producer is necessary.
- The resolver is synchronous. `resolveOrchestratorToolProject` also calls `recordSeatProjectSuccessions`, which can record aliases and reconcile seats. Reusing that whole wrapper would add migration work to a read. Reuse its underlying directory/resolver functions with active-seat requirement disabled; preserve the wrapper's existing callers.
- `server.ts:2847` already expands short project keys before dispatch. Unkeyed reads at 2859–2880 force retryable errors. Keyed reads pass authorization at 2910, then receipt lookup/joins and awaited completion; the board bindings currently provide no receipt authorization. Fixing only the reader cannot protect a replay that skips it.
- `listPipelines` awaits `listPageAsync`; its checkpoints only test cancellation/deadline. Caller attribution is memoized by `resolveMcpCallerValue`. Repeating that memoized value alone cannot prove current designation or generation.
- `workspaceFence.ts:82–87,124` checks project arguments before core bindings. It expands permitted key prefixes, then compares aliases; a display name is refused before the proposed binding resolver could run. Production service construction at `server.ts:5324` installs this wrapper. Its output checks and workspace membership checks remain authoritative.

No HTTP route needs changing for the proposed behavior. If implementation changes a route or transport, its acceptance must also drive the exported route through an authenticated loopback listener on port 0.

## Smallest mechanism

1. Introduce one small synchronous board-project resolution helper alongside `boardReadProject`. Accept the existing optional string, trim it, preserve omission/blank behavior, and resolve explicit values using `resolveNamedProject(value, namedProjectDirectory(dependencies), false)`. Translate `ProjectNameRefusal` without losing code, candidates, close matches or retryability. Do not manufacture a match from an unknown key or fall back to an empty/global selection. Missing catalog alone is valid when other retained evidence resolves the name; unavailable required state must refuse.
2. Apply that result before the existing seat comparison and row filter for both tools. Use the same canonical identity for selection and continuation scope. Preserve the resolver's existing identity-collision and active-seat preference rules; two genuinely competing candidates remain ambiguous. Reading a known project without an active seat stays available to callers already permitted to read it.
3. Capture the canonical target once per invocation, before the first asynchronous normalization or authorization boundary for these tools. A fresh authorization check must compare the original target and original caller to current designation/generation; it must never redirect an in-flight request to a newly named board. Check before any row or receipt read, at asynchronous page checkpoints, and immediately before a successful response escapes the service/SDK boundary. Preserve `context.assertCaller`, cancellation and deadline checks. A removed designation cannot silently convert a former seat into an unrestricted worker.
4. Use the existing `receiptScope` and canonical-argument hooks for new keyed board reads. Scope includes the authenticated caller, original canonical selection and current authority fingerprint; canonical arguments retain every filter and pagination input. Equivalent project spellings with the same request key may replay only the same scope and arguments. Reauthorize before claim/in-flight join and after their awaits and receipt completion. Preserve the existing bounded retention and conflict rules. Legacy unscoped receipt rows lack this proof: never select them as a fallback or copy them into the new scope. Leave their stored bytes, timestamps and UNKNOWN states untouched; a currently authorized fresh board observation can use the new scope. Refuse a currently unauthorized request before retrieving its old payload. No store/schema migration, old receipt settlement, cleanup, retry or recovery is introduced.
5. Perform the same two-tool resolution before the workspace argument comparison, retaining membership and final result checks. Use the existing directory and resolver in both entry paths; do not duplicate matching logic or filter away a competing identity to manufacture a unique match. Keep default workspace scoping for omitted project. A resolved foreign target receives `workspace_forbidden`. For resolver refusals, rebuild the error message and structured details from permitted candidates/close matches; never forward the original message containing foreign labels; if an ambiguity includes a forbidden candidate, return the generic workspace refusal without its name, key, path or count. Unknown and wholly permitted ambiguous inputs retain `unknown_project` and `ambiguous_project`. Preserve the original caller/project/workspace principal in the final closure; re-read membership and the caller's current project rather than checking only a captured project string. Non-workspace seat calls retain `cross_project_refused` for a resolved foreign project.
6. Honor typed refusal retryability in the board read response paths and add final response checks across the core/SDK awaits. Keep the change limited to these tools. Use the named response-authority seams compared below; preserve #3710’s launch tool set and recovery behavior. Register checks for both keyed and unkeyed board paths. Adding two names to a launch-only set is insufficient because its keyed path attaches authority inside recoverable launch execution, which board reads never enter. Ensure keyed and unkeyed results carry the same terminal reason and no private rows/cursor on refusal.
7. Describe accepted project forms and omission in both `project` schemas and tool descriptions. Do not change the input type or require a key. Verify published schemas through SDK `listTools` and then exercise the accepted arguments. Do not add phrase-presence tests.

## Exact file and function scope

Line anchors refer to `423bf964`; locate the symbols again before editing. The complete product-source edit allowance is three files. Test additions stay in the direct files named below.

| File / hunk | Allowed edit and required preservation |
| --- | --- |
| `src/lib/mcp/bindings.ts:6304–6317`, `boardReadProject` | Resolve explicit inputs with the existing directory/resolver before the retained seat fence; add a small board-only captured-scope/authority closure. Keep launch resolution and succession wrappers untouched. |
| Same file, `listPipelines` at 6352–6410 and `listTasks` at 6452–6486 | Use the pinned canonical scope; assert authority before row access, at actual async page checkpoints and before returning. Preserve projection, filters, sorting, links and selection indexes. |
| Same file, `viewerReadTools` at 8617/8619 and MCP registrations at 8783/8784 | Attach board-only receipt authorization/scope and read authority. Direct/voice reads receive the same resolver and checks. Do not change `pipeline_action` or adjacent launch registrations. |
| `src/lib/mcp/server.ts`, `McpToolCallContext` / binding metadata and `createMcpToolService` | Only the minimum call-local board authority plumbing, early capture before normalization awaits, keyed/unkeyed read checks, typed board refusal mapping and final return. Reuse compatible response-authority symbols already introduced by #3710 when present; no generalized framework or recovery changes. |
| Same file, outer page-service return and `createViewerMcpServer` registered handler | Carry the original board closure across `withMcpPageCursors` and the final SDK await, then synchronously check before `response(...)`. Cover every board return, including replay, in-flight duplicate and failure payload. |
| Same file, `TOOL_DESCRIPTIONS.list_tasks/list_pipelines` and `TOOL_INPUT_SCHEMAS` entries at 4626/4694 | Describe key/name/folder forms and defaults; keep optional string types, limits and all other schemas. |
| `src/lib/mcp/workspaceFence.ts`, `withWorkspaceMcpFence` project argument block at 82–87, argument check near 124, captured `assert` and service return | Two-tool canonicalization and privacy-safe resolver refusal mapping; retain fresh workspace assertion through the same final response boundary. Keep membership policy, task/pipeline ID checks, result checks and every other tool unchanged. |
| `src/lib/mcp/boardProjectReads.integration.test.ts` | New reusable SDK/service/SQLite regression suite for this domain. No issue-number capture driver. |
| `src/lib/mcp/server.test.ts`, `src/lib/mcp/workspaceFence.test.ts` | Direct response/replay/retryability barriers and workspace cases; retain neighboring launch/native tests. |
| `src/lib/mcp/projectResolution.test.ts`, `src/lib/mcp/crossProject.test.ts`, `src/lib/mcp/pageCursors.integration.test.ts` | Extend only where the existing fixture is the direct consumer needed for resolver, policy or continuation behavior; otherwise run unchanged. |

### Current overlap and sequencing

The continuation compared all 25 currently open PR heads against the assigned base on these source/direct-test files, and inspected current working diffs across registered checkouts. Snapshot: **2026-11-06 21:04:00 UTC**, with full private diffs retained in `plan2-overlap.json` beside the primary evidence. The following are source observations, not approval of another lane.

| Owner / observed state | Actual hunk and consequence |
| --- | --- |
| Original #3710 / lane `83306a33`, published and locally clean at `edb2bf0664e74444627a40418581db77d9e80109` | Binding edits cover launch admission, `recoveryCaller`, recovery tools and `list_unknown_launch_claims` immediately before board registration. No board-list body changes. Its `server.ts` adds `McpResponseAuthority`, `responseAuthorityResult`, `retainResponseAuthority`, `readAuthority`, `LAUNCH_AUTHORITY_TOOLS`, unkeyed read assertions, the service wrapper and final SDK handler checks. These response functions are a semantic overlap. Its workspace hunk adds launch tool sets and retains `assert` at the shared final boundary. Its direct tests append native-session response switches. |
| #3698 / lane `6cc157f6`, published PR #3728 at `5f42c2fb` | Published tree contains its design only. At 21:04 the actual unpublished diff adds `pipelineSourceRequest`, `pipelineSourceAuthority`, context forwarding and `set-src` handling in `pipelineAction`, a `pipeline_action.authorizeReceipt` arm, and `src`/`overwrite` schema fields. These are disjoint from the board functions and descriptions. Preserve every action-specific hunk; no resolver reuse dependency exists. |
| Published #3585 at `d58c4c0a` | `TOOL_DESCRIPTIONS.telegram_bot_send_document` only; preserve it. |
| Retained refresh checkout for #3637 | Unpublished account-limit source, creation/draft schema and prototype description hunks; none changes board resolution or response authority. Preserve them; do not import the checkout. |
| Retained old checkout with source deletions | Whole-file deletions are observed local state, with no evidence of intentional board ownership. Do not restore, clean or import it. |

A final paginated open-lane read and local branch-head comparison found only #3710 with committed MCP changes on the named files; its actual hunks remain as described. The primary intake's three unavailable historical worktrees remain an uncertified uncommitted inventory; no complete all-machine claim is made. The named current owners have readable actual source. #3715 publication/engine work remains outside this plan.

**Integration order:** preserve #3710's existing response primitives as the shared contract, then layer board-only capture and checks onto those exact functions. Keep the launch set and all launch behavior unchanged. The semantic conflict is in the unkeyed read try/catch, the outer service return, SDK `registerTool` handler and workspace final `assert` retention; serialize those edits with the original owner through the controller. Do not merge the held #3710 branch or advance its review/paused state. The builder can implement the disjoint board resolver and tests immediately. Before integrating the shared response hunks, record the exact owner/base/blob comparison and named-hunk agreement. If #3710 has not landed, implement only the minimal compatible board-scoped response plumbing on this lane and provide that precise diff for owner reconciliation; do not copy its receipt stores, launch admission or recovery subsystem. If both owners are changing the same semantic function, one accepted patch must precede the other's integration; never resolve by replacing either function wholesale.

#3698's current action-specific changes can proceed independently. At integration preserve its schema and `pipelineAction` hunks and re-read its latest source. Do not require its `pipelineSourceAuthority` or ask it to adopt a new shared helper. An actual later semantic conflict triggers named-function sequencing at that time.

Rehearse the actual implementation with scratch `git merge-file` base/ours/theirs and test the combined direct consumers. A conflict-free textual merge alone does not prove both authority paths survived. No merge of hypothetical code is claimed by this plan. Keep the original #3710 launch, receipts, pause and review budget, and this task's three-round budget unchanged.

## Authority data and refusal contract

| Producer / boundary | Consumer and required treatment |
| --- | --- |
| SDK optional `project`; voice/direct read arguments; workspace default injection | Resolve one explicit spelling or retain the existing omitted/blank default. Never acquire identity from argument fields. Capture before the first await, including short-ID normalization. |
| Completed catalog, project-key index, recorded aliases, presentation/curation, retained remotes, current caller and authorized seats | Existing `namedProjectDirectory` and `resolveNamedProject(..., false)` supply identity, collision precedence and suggestions. No new store, scanner, migration or succession call. Construct the directory once per invocation; recheck captured aliases and authority through existing narrow reads, without rebuilding the directory or traversing registry history at every barrier. Preserve the resolver's unique-active-seat precedence; genuinely competing candidates refuse. |
| Current `attentionAuthority()`, read-only registry lookup, latest generation, designation and workspace principal | Board closure pins authenticated kind/conversation, native proof when present, generation id/path and archive/supersession state, project ownership, designation identity/epoch and permitted workspace. Revalidate from fresh sources; memoized `authorityOf`/attribution alone is insufficient. Recheck the existing revoked-seat authority source as well as current designation: a revoked former seat must not become an unrestricted reader, including on a new invocation after restart. Keep existing permitted ordinary/root caller forms. |
| Project spelling and recorded alias at admission | Store the resolved target in call-local state. An alias redirect/revocation or changed ownership during an await refuses; never reselect a different project. A harmless presentation label change cannot change the original target. |
| Existing bounded receipt key/digest and in-flight map | New board scope includes caller/authority/selection; replay is authorized anew. Preserve old bytes and expiry policy. Check after `claim`, duplicate result, binding, `complete`, outer page wrapper and final SDK await. No second dispatch or UNKNOWN adoption is added. |
| Workspace `assert`, `assertCaller`, `assertResult`, cancellation and deadline | Compose and preserve each check; reject before any rows, IDs, candidate names or cursors reach serialized output. The workspace assertion must survive the final SDK await as well as its own service await. |

Typed `unknown_project`, `ambiguous_project`, `cross_project_refused`, `project_scope_refused`, workspace and caller-revocation refusals are terminal for the same request and carry consistent top-level/nested retryability where details exist. Preserve existing authority refusal codes where available. A required directory read failure remains an explicit failure with its actual transient classification; do not turn it into unknown-project or a successful empty list. For these two tools, use the same typed-refusal mapping in normalization/capture, unkeyed execution, keyed authorization/scope, binding and final-response exits. Do not rewrite unrelated tools' error handling.

## Keep-list and deferred scope

Keep `src/lib/projects/nameResolution.ts`, `aliases.ts`, project identity and alias stores, name precedence, designation policy, workspace permissions, capability/native identity sources, existing task/pipeline storage, pagination limits and cursor caller binding. Keep list sorting, all filters, compact/full projections, hidden/closed handling, task-to-pipeline links and prototype-field exclusion. Unrestricted readers retain their existing omitted-project behavior; seats retain own-board defaulting. Voice readers continue using the same underlying list functions.

### Deferred — not currently justified

- Auditing or changing other project-taking tools, launch/source-lineage work from #3698, and #3710 launch recovery.
- New identity registries, permission rules, caches, migration passes or broad MCP framework refactoring. Receipt classes, persisted schemas, retention constants, lifecycle/recovery code, native authentication, pipeline engine/types, route implementation and other tools are excluded from edits.
- UI changes, captures, permanent issue-specific drivers, performance claims, deployment and installed acceptance.
- Runtime/process recovery, old receipt adoption, restarting or unpausing any lane.

## Real acceptance and per-file checks

Use fixture producers for task rows, pipeline rows, registry generations, seats and workspace membership. Seed an own project with different key, display name and folder, a foreign project, aliases and collision cases. For each tool, run both omitted and explicit request keys, a seat/deputy, an ordinary reader and a workspace-bound caller. Inspect structured SDK results, counters and receipt records.

| Case | Required assertion |
| --- | --- |
| Key, case-varied name, folder basename/root and canonical alias | Same IDs, totals, filtering and page contents on the same permitted board |
| Unknown / ambiguous / identity-name collision | Existing resolution code and bounded appropriate suggestions; no successful empty list, row access, claim or private payload |
| Foreign target and absent designation | Existing boundary-specific refusal; no rows, linked IDs or cursor; no authority widening |
| Missing catalog / unavailable directory | Other retained evidence can resolve; genuine absence or read failure refuses without global fallback |
| Omitted / blank project | Existing seat, ordinary-reader and workspace defaults remain intact |
| Cold/retained selection source and async fallback | Same results; no full scan/control request introduced by resolution |
| Seat/project/generation change during a wait | Original scope remains fixed and response is refused; restoring authority permits a fresh request |
| Keyed lookup, pending join, completion and final SDK await | Swap authority at each barrier; neither cached nor fresh prior-project data escapes |
| Continuation and alias change | Same authorized scope continues; alias redirect/revocation and changed authority refuse before disclosure. A normal expired cursor may use the existing reset contract only under unchanged authority. |
| Forged caller canaries | Fixture-only foreign task/pipeline labels never occur in text or structured results, errors, candidates, linked IDs or cursors. Forged conversation/project/workspace/generation fields and native proof cannot replace the server caller. An invalid proof refuses; otherwise inert extra hints cannot widen access. |
| Past receipts | Seed old unscoped successful and UNKNOWN receipts, record their serialized bytes, revoke authority and call each tool. Refusal exposes no canary; receipt rows remain byte-identical. Reopen the actual SQLite receipt store to prove the same behavior across service restart. |
| Retryability | Keyed/unkeyed typed terminal refusals agree at top level and details; genuine transient failures preserve their classification |
| Workspace membership/project move | Names do not bypass membership; candidates and linked data stay within the permitted workspace |

For both tools, add deterministic barriers at short-ID normalization, authorization/scope, receipt claim, in-flight join, binding completion, receipt completion, outer service return and final SDK await. Exercise caller replacement, generation replacement, seat removal/epoch change, project/alias change, workspace membership revocation and caller workspace movement separately. For race tests, pause the actual await with a deterministic barrier, mutate the real isolated designation/principal or injected authoritative source, then release. Test 251 rows to reach the existing page yield. Remove the final check in a scratch negative control and require the corresponding disclosure test to fail. A unit test calling only the resolver cannot satisfy these criteria.

Run every selected file separately in a scratch export, with fresh `HOME`, `XDG_CONFIG_HOME`, `LLV_STATE_DIR` and `TMPDIR`, a closed Viewer control endpoint, a fresh log and actual terminal exit. Use the existing `checkEnvironment` / `isolatedEnvironment` construction, remove test Git shims as it prescribes, and keep all fixture stores and process observations private. Use the assigned gate directly:

```sh
bash "$GATE" bun run test src/lib/mcp/boardProjectReads.integration.test.ts
bash "$GATE" bun run test src/lib/mcp/projectResolution.test.ts
bash "$GATE" bun run test src/lib/mcp/crossProject.test.ts
bash "$GATE" bun run test src/lib/mcp/pageCursors.integration.test.ts
bash "$GATE" bun run test src/lib/mcp/workspaceFence.test.ts
bash "$GATE" bun run test src/lib/mcp/server.test.ts
```

`$GATE` is the stage-supplied owned runner. The first file covers new board behavior. The existing project-resolution file protects name semantics; cross-project protects the retained seat policy; cursor integration protects continuation ownership. The workspace file covers argument and membership fences; the server file covers response/replay classification and retains #3710 native response checks on the actual combined tree. Each touched test file runs complete; filtered characterization runs are not the final gate. Directly call `viewerReadTools` in the board integration file to protect voice use without a voice-provider run. If a route or transport is edited, drive its exported real route through an authenticated loopback listener on port 0; such an edit is outside the current three-file source allowance and requires an explicit scope decision. No broad directory selection, typecheck or build is authorized by this architecture stage. Publication keeps its normal hooks and CI. Use no `--record`, native wait, custody handoff or UNKNOWN adoption. Record the direct process exit and preserve source/runtime/fixture/log hashes; an unfinished command proves no pass.

Before calling implementation complete, run the new expected-success/refusal assertions against the unchanged base and the final implementation, documenting the required base-red/head-green differences. Review the final exact head independently through the fixed three-round review/fix flow, retaining the terminal recheck. Re-read current issue/comments, main and overlap hunks after the last change. Source merge readiness and later installed acceptance remain separate; the task must not be marked finished by this source-only lane.

The red/green evidence table must name the file, exact case, input, expected and actual code/rows/retryability, source revision, log and exit. Require base-red/head-green for own name/folder equivalence, unknown/ambiguous refusal, workspace equivalence, stale replay, after-await disclosure and retryability. Existing policy/foreign/forgery controls must pass on both. Removing each final check in a disposable export must make its own canary disclosure test fail. Base and final candidate use the same assertions and fixture inputs. Do not call passing characterization assertions a fixed-contract pass.

This continuation performs document privacy/whitespace checks and validates the retained reproduction manifest. It makes no product acceptance claim and needs no additional test of unchanged source. Three independent review rounds and the terminal recheck remain required before source merge readiness. Installed acceptance stays open.

## Risks

The primary risk is an apparently correct name fix that still fails before binding or returns a stale authorized response. Other risks are importing succession writes into reads, requiring an active seat for every reader, silently choosing a collision, disclosing foreign workspace suggestions, or widening shared service behavior while #3710 is held. The approved two-tool extension and tests above address those risks without inventing a new permission policy. There is no measured performance improvement claim.
