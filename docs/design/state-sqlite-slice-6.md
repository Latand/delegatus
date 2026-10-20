# State to SQLite: slice 6 reader inventory

Inventory taken before implementation on 2026-10-20 at `e9e769ac`.
Scope: §2.1 rows 12–15 of `state-sqlite-migration.md`, including the newer
project-remotes ledger required by the grouping invariant. Later slices and
removal of imports and rollback mirrors (#1872, 2026-12-15) remain separate.

## Direct readers and writers before migration

All entries in this table still read JSON at the inventory revision.

| File | Readers | Writers and cascades |
|---|---|---|
| `project-aliases.json` | `projects/aliases.ts` (canonical resolution, collision detection and registration); `reviewHistory/reader.ts` (archive canonicalization); scanner state hashes; files projection, pipeline record, linked task page and role-memory cache guards | `persistProjectAliases`, called by succession and forge rename; recovery demotion projects atomic `worktree_recovery` rows into the file. Empty state is an empty alias graph and display-name map. |
| `project-curation.json` | `projects/curation.ts`; `scanner/describe.ts` uses manual roots to identify Git common directories; files projection invalidation | Crown toggles and manual project creation. Creation validates physical roots, refuses duplicate identities and persists name, root and creation time. Empty state has no crowns or manual projects. |
| `worktree-map.json` | `scanner/describe.ts` (live/deleted checkout grouping); `projects/aliases.ts` (durable succession evidence); `projects/worktreeBackfill.ts` (recovery planning); `scanner/projectDirectories.ts` (launch roots); scanner state hash and files projection | Scanner observation/flush, sweep's `recordWorktreeResolution` before removal, explicit recovery registration, and recovery demotion. Records only add or confirm mappings; competing recovery mappings refuse. Recovery also augments the map from `worktree_recovery` in SQLite. Missing state starts empty; losing a saved deleted checkout's mapping cannot be repaired from disk. |
| `session-titles.json` | `session/titleStore.ts`, through scanner overlays, files enrichment and session title routes | Save, serialized mutation and rename/reset; stable conversation, UUID and path keys, revision tombstones, rejected-record preservation and the 2,000-record ceiling travel together. `scripts/readme-demo-state.ts` seeds a fresh private installation before activation. |
| `project-remotes.json` | `projects/aliases.ts` for forge rename, search scope and linked-project choices; `links/linked.ts` cache guard | `recordProjectRemote` remembers each observed repository key's remote; local identities are excluded. Missing state is an empty ledger. A matching numeric forge repository id is still required to alias a remote rename. |

## API consumers and external boundary

Alias APIs reach scanner catalog/linking, project identity/succession/forge
rename, board/tasks/flow/pipeline/workflow decoding, MCP bindings, links,
memory, monitor, retirement and search. Curation APIs reach project routes,
catalog summaries, known directory discovery and worktree recovery. Title APIs
reach scanner overlays, files enrichment, session routes and rename validation.
These callers use the owners' interfaces; their persistent format is private
to the owners. Recovery's board, mapping, alias and lifecycle event remain one
atomic SQLite commit in `worktreeRecoveryStore.ts`.

Searched tracked sources, including scripts, bin, Python/shell sources and
`vendor/telegram-mcp`, for all five filenames, their path builders and exported
owner interfaces. No Python, shell or vendored MCP reader consumes these five
stores. Vendor `aliases.json` is the Telegram connector's separate store.
`scripts/mcp-state-writer-benchmark.ts` seeds a fresh private alias fixture;
`links/testInstalls.ts` seeds fresh linked-install fixtures. Existing tests seed
legacy files to exercise import; assertions of live JSON move to owner APIs.
No external reader requires a decision before migration.

## Concurrent work and implementation contract

Open PRs at inventory: #3107, #3105, #3095 and #2926. Their scopes concern
pipeline launch/replacement and agent signal confinement; inspect their diffs
before editing shared files. No open PR implements these project stores.

Use the established `smallStore` / `LegacyDocumentStore` import protocol:
startup mutation fence, count/digest verification, kept imported bytes,
tombstone, revision reconciliation, consumed-archive recovery and demotion
mirror. Runtime readers and cache guards switch to SQLite once imported.
Alias decoders must read existing committed state without starting nested
imports. All new admission is nonblocking; asynchronous callers retry through
the shared state-lock admission helper. No performance improvement is claimed.

## Owner API import inventory

The following production and fixture modules import the owner APIs. These
imports read through the owner; the direct JSON readers are listed above.

- `src/app/api/account-project-bindings/route.ts`
- `src/app/api/accounts/route.ts`
- `src/app/api/files/response.ts`
- `src/app/api/projects/create/route.ts`
- `src/app/api/projects/crown/route.ts`
- `src/app/api/projects/settings/route.ts`
- `src/app/api/search/memory/route.ts`
- `src/app/api/session/title/route.ts`
- `src/components/session/sessionTitleApi.ts`
- `src/lib/accounts/conversationProject.ts`
- `src/lib/accounts/projectBindings.ts`
- `src/lib/activity/agentSource.ts`
- `src/lib/activity/report.ts`
- `src/lib/activity/tokenReport.ts`
- `src/lib/agent/spawnAdmission.ts`
- `src/lib/agent/spawnCommand.ts`
- `src/lib/asks/controller.ts`
- `src/lib/bridge/reportLog.ts`
- `src/lib/done/world.ts`
- `src/lib/flows/store.ts`
- `src/lib/forge/resolve.ts`
- `src/lib/links/agentFeed.ts`
- `src/lib/links/fixtures/taskExport.cases.ts`
- `src/lib/links/seatMessages.ts`
- `src/lib/links/state.ts`
- `src/lib/mcp/bindings.ts`
- `src/lib/mcp/boardSelection.ts`
- `src/lib/memory/curation/brief.ts`
- `src/lib/memory/curation/cleanup.ts`
- `src/lib/memory/curation/guard.ts`
- `src/lib/memory/curation/importApply.ts`
- `src/lib/memory/curation/read.ts`
- `src/lib/memory/curation/run.ts`
- `src/lib/memory/curation/store.ts`
- `src/lib/memory/importCuration.ts`
- `src/lib/memory/importHistory.ts`
- `src/lib/memory/importLifecycle.ts`
- `src/lib/memory/importStatus.ts`
- `src/lib/memory/importWork.ts`
- `src/lib/memory/index.ts`
- `src/lib/memory/roleProblems.ts`
- `src/lib/memory/roleSearch.ts`
- `src/lib/memory/roleStore.ts`
- `src/lib/memory/roleViewSource.ts`
- `src/lib/memory/settings.ts`
- `src/lib/monitor/seatTickSources.ts`
- `src/lib/operator/workerLimit.ts`
- `src/lib/operator/workerLimitView.ts`
- `src/lib/orchestrator/seatCommand.ts`
- `src/lib/orchestrator/seats.ts`
- `src/lib/pipelines/store.ts`
- `src/lib/pipelines/worktreeSweep.ts`
- `src/lib/projects/forgeRename.ts`
- `src/lib/projects/nameResolution.ts`
- `src/lib/projects/projectKeyIndex.ts`
- `src/lib/projects/reportDestination.ts`
- `src/lib/projects/settings.ts`
- `src/lib/projects/succession.ts`
- `src/lib/projects/suggestionRoots.ts`
- `src/lib/projects/worktreeBackfill.ts`
- `src/lib/prototypeReview/http.ts`
- `src/lib/prototypeReview/media.ts`
- `src/lib/prototypeReview/read.ts`
- `src/lib/prototypeReview/seatRounds.ts`
- `src/lib/prototypeReview/telegramPostSignals.ts`
- `src/lib/prototypeReview/world.ts`
- `src/lib/runtime/agentMessageAuthor.ts`
- `src/lib/runtime/structuredHostRetirementStatus.ts`
- `src/lib/scanner/describe.ts`
- `src/lib/scanner/projectCatalog.ts`
- `src/lib/search/projectScope.ts`
- `src/lib/session/projectResolution.ts`
- `src/lib/session/renameEligibility.ts`
- `src/lib/session/titleProjection.ts`
- `src/lib/session/titleStore.lockChild.ts`
- `src/lib/state/durability.ts`
- `src/lib/state/historyProjection.ts`
- `src/lib/state/legacyCollections.ts`
- `src/lib/state/slice6.fixture.ts`
- `src/lib/tasks/commands.ts`
- `src/lib/tasks/launchMembership.ts`
- `src/lib/tasks/membership.ts`
- `src/lib/tasks/store.ts`
- `src/lib/tasks/systemRun.ts`
- `src/lib/view/presenceStore.ts`
- `src/lib/voiceCompanion/admission.ts`
- `src/lib/voiceCompanion/boardReads.ts`
- `src/lib/voiceCompanion/deliveryPaths.ts`
- `src/lib/voiceCompanion/readPaths.ts`
- `src/lib/workflows/store.ts`
